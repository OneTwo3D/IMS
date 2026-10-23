import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_PACK_REPORT_DIR, PACK_REPORT_JSON, PACK_REPORT_MARKDOWN } from '../../lib/reconciliation-pack/constants'
import {
  PACK_SCHEDULE_ENABLED_SETTING, PACK_SCHEDULE_PHASE_SETTING, PACK_SCHEDULE_RECORD_ACTION, PACK_SCHEDULE_VENDOR_READS_SETTING,
} from '../../lib/reconciliation-pack/schedule-constants'
import { runScheduledReconciliationPack, scheduledChildEnv, type ScheduledPackDeps } from '../../lib/ops/reconciliation-pack-schedule'
import { startNpmScript, type ChildResult, type ChildSpec, type StartedScript } from '../../lib/ops/readiness-gate-collect'
import { assertClosedRecord } from '../reconciliation-pack/schedule-helpers'

const RUN_ID = '20261023T030000Z-0123456789ab'
const dir = `${DEFAULT_PACK_REPORT_DIR}/${RUN_ID}`
const PUBLISHED_STDERR = `Report: ${dir}/${PACK_REPORT_JSON}\nReport: ${dir}/${PACK_REPORT_MARKDOWN}\n`
const SCHEDULE_RUN_ID = '11111111-2222-4333-8444-555555555555'

/** A fence double: runs `fn` with the given rows. */
function fencedFrom(map: Record<string, string | undefined>): NonNullable<ScheduledPackDeps['fenced']> {
  return async (_keys, fn) => fn(new Map(Object.entries(map).filter((entry): entry is [string, string] => entry[1] !== undefined)))
}

type Logged = { action: string; level?: string; description: string; metadata: Record<string, unknown>; entityType: string; tag: string }

/** A harness that records every call; nothing here touches a database, a vendor, a crontab or the network. */
function harness(settings: Record<string, string | undefined>, overrides: Partial<ScheduledPackDeps> = {}, ended: Partial<ChildResult> = { exitCode: 0, stderr: PUBLISHED_STDERR }) {
  const logged: Logged[] = []
  const children: ChildSpec[] = []
  const events: string[] = []
  const consoleLines: string[] = []
  const deps: ScheduledPackDeps = {
    now: () => 1_000,
    readSettings: async () => new Map(Object.entries(settings).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    fenced: fencedFrom(settings),
    acquireLock: async () => { events.push('lock'); return { release: async () => { events.push('release') } } },
    vendorGate: async () => true,
    runChild: async (spec) => { events.push('child'); children.push(spec); return { exitCode: 0, stdout: '', stderr: '', timedOut: false, ...ended } },
    verifyReport: () => ({ sequence: 4 }),
    env: { PATH: '/usr/bin', HOME: '/home/ims', DATABASE_URL: 'postgresql://x@127.0.0.1/db', SETTINGS_ENCRYPTION_KEY: 'k'.repeat(32), ENCRYPTION_KEY: 'e'.repeat(32), PGPASSWORD: 'pw', NODE_OPTIONS: '--require /evil.js', LD_PRELOAD: '/evil.so' },
    cwd: '/srv/ims',
    log: (async (params: Logged) => { events.push('log'); logged.push(params); return true }) as never,
    consoleError: (line) => { consoleLines.push(line) },
    ...overrides,
  }
  return { deps, logged, children, events, consoleLines }
}

const ON = { [PACK_SCHEDULE_ENABLED_SETTING]: 'true' }
const ON_P1 = { ...ON, [PACK_SCHEDULE_PHASE_SETTING]: 'P1' }

function assertOneClosedRecord(h: ReturnType<typeof harness>, code: string, outcome: string) {
  assert.equal(h.logged.length, 1, 'exactly one activity-log record per start')
  const entry = h.logged[0]!
  assert.equal(entry.action, PACK_SCHEDULE_RECORD_ACTION)
  assert.equal(entry.entityType, 'SYSTEM')
  assertClosedRecord(entry.metadata as never)
  assert.equal(entry.metadata.code, code)
  assert.equal(entry.metadata.outcome, outcome)
  assert.equal(entry.metadata.scheduleRunId, SCHEDULE_RUN_ID)
  const text = JSON.stringify(entry)
  for (const secret of ['postgresql://', 'k'.repeat(32), 'e'.repeat(32), 'pw', '/evil', '/home/ims', 'SETTINGS_ENCRYPTION_KEY']) assert.ok(!text.includes(secret), `${secret} reached the record`)
}

test('a fresh install runs nothing: no setting, or the switch off, is a recorded refusal and no child starts', async () => {
  for (const settings of [{}, { [PACK_SCHEDULE_ENABLED_SETTING]: 'false' }, { [PACK_SCHEDULE_ENABLED_SETTING]: '' , [PACK_SCHEDULE_PHASE_SETTING]: 'P1' }, { [PACK_SCHEDULE_ENABLED_SETTING]: 'TRUE', [PACK_SCHEDULE_PHASE_SETTING]: 'P1' }, { [PACK_SCHEDULE_PHASE_SETTING]: 'P1', [PACK_SCHEDULE_VENDOR_READS_SETTING]: 'true' }]) {
    const h = harness(settings)
    const outcome = await runScheduledReconciliationPack(SCHEDULE_RUN_ID, h.deps)
    assert.equal(h.children.length, 0, JSON.stringify(settings))
    assert.ok(!h.events.includes('lock'), 'not even the lock is taken')
    assertOneClosedRecord(h, 'SCHEDULE_DISABLED', 'refused')
    assert.equal(outcome.status, 'skipped')
    assert.equal(outcome.recorded, true)
  }
})

test('enabled with no phase: refused and recorded, no run (there is no default phase)', async () => {
  for (const [phase, code] of [[undefined, 'PHASE_NOT_SET'], ['', 'PHASE_NOT_SET'], ['p1', 'PHASE_INVALID'], ['P3', 'PHASE_INVALID']] as const) {
    const h = harness({ ...ON, ...(phase === undefined ? {} : { [PACK_SCHEDULE_PHASE_SETTING]: phase }) })
    const outcome = await runScheduledReconciliationPack(SCHEDULE_RUN_ID, h.deps)
    assert.equal(h.children.length, 0)
    assert.ok(!h.events.includes('lock'))
    assertOneClosedRecord(h, code, 'refused')
    assert.equal(h.logged[0]!.metadata.phase, null)
    assert.equal(outcome.status, 'failed', 'a misconfigured job is red so that it is noticed')
  }
})

test('unreadable settings are a refusal, never the defaults', async () => {
  const h = harness({}, { readSettings: async () => { throw new Error('connection refused: postgresql://u:p@h/db') } })
  const outcome = await runScheduledReconciliationPack(SCHEDULE_RUN_ID, h.deps)
  assert.equal(h.children.length, 0)
  assertOneClosedRecord(h, 'SETTINGS_UNREADABLE', 'refused')
  assert.equal(outcome.status, 'failed')
})

test('enabled with a phase: the operator\'s command runs once, with the phase alone; vendor reads stay OFF and no credential key is passed', async () => {
  const h = harness(ON_P1)
  const outcome = await runScheduledReconciliationPack(SCHEDULE_RUN_ID, h.deps)
  assert.equal(h.children.length, 1)
  const spec = h.children[0]!
  assert.deepEqual([spec.script, spec.silent, spec.args, spec.cwd], ['reconcile:pack', true, ['--phase', 'P1'], '/srv/ims'])
  assert.ok(!spec.args!.includes('--vendor-reads-only'))
  assert.ok(spec.timeoutMs > 0 && spec.timeoutMs <= 60 * 60 * 1000)
  // the environment: the gate commands' whitelist, no vendor key, nothing that loads code, no PG variable
  assert.equal(spec.env.DATABASE_URL, 'postgresql://x@127.0.0.1/db')
  for (const name of ['SETTINGS_ENCRYPTION_KEY', 'ENCRYPTION_KEY', 'PGPASSWORD', 'NODE_OPTIONS', 'LD_PRELOAD']) assert.ok(!(name in spec.env), name)
  assertOneClosedRecord(h, 'all-pass', 'published')
  const metadata = h.logged[0]!.metadata
  assert.deepEqual([metadata.phase, metadata.vendorReads, metadata.exitCode, metadata.runId, metadata.sequence, metadata.reportJson], ['P1', false, 0, RUN_ID, 4, `${dir}/${PACK_REPORT_JSON}`])
  assert.equal(h.logged[0]!.level, 'INFO')
  assert.deepEqual([outcome.status, outcome.recorded], ['completed', true])
  assert.deepEqual(h.events, ['lock', 'child', 'log', 'release'], 'the lock is held until the record is written')
})

test('vendor reads: only on the exact stored word true; then the flag and the two key names (and nothing else) reach the child', async () => {
  for (const off of [undefined, 'false', 'TRUE', '1', 'yes']) {
    const h = harness({ ...ON_P1, ...(off === undefined ? {} : { [PACK_SCHEDULE_VENDOR_READS_SETTING]: off }) })
    await runScheduledReconciliationPack(SCHEDULE_RUN_ID, h.deps)
    assert.deepEqual(h.children[0]!.args, ['--phase', 'P1'], String(off))
    assert.ok(!('SETTINGS_ENCRYPTION_KEY' in h.children[0]!.env))
  }
  const h = harness({ ...ON_P1, [PACK_SCHEDULE_VENDOR_READS_SETTING]: 'true' })
  await runScheduledReconciliationPack(SCHEDULE_RUN_ID, h.deps)
  assert.deepEqual(h.children[0]!.args, ['--phase', 'P1', '--vendor-reads-only'])
  assert.deepEqual(Object.keys(h.children[0]!.env).filter((name) => /ENCRYPTION/.test(name)).sort(), ['ENCRYPTION_KEY', 'SETTINGS_ENCRYPTION_KEY'])
  for (const name of ['PGPASSWORD', 'NODE_OPTIONS', 'LD_PRELOAD']) assert.ok(!(name in h.children[0]!.env), name)
  assert.equal(h.logged[0]!.metadata.vendorReads, true)
  // the spacing: a second vendor-reads start inside the window is refused and recorded, no child
  const spaced = harness({ ...ON_P1, [PACK_SCHEDULE_VENDOR_READS_SETTING]: 'true' }, { vendorGate: async () => false })
  const outcome = await runScheduledReconciliationPack(SCHEDULE_RUN_ID, spaced.deps)
  assert.equal(spaced.children.length, 0)
  assertOneClosedRecord(spaced, 'VENDOR_READS_TOO_SOON', 'refused')
  assert.equal(outcome.status, 'skipped')
  assert.deepEqual(spaced.events, ['lock', 'log', 'release'], 'the lock is released after a refusal too')
  // the gate is consulted only for a run that reads a vendor
  let asked = 0
  const noVendor = harness(ON_P1, { vendorGate: async () => { asked += 1; return false } })
  await runScheduledReconciliationPack(SCHEDULE_RUN_ID, noVendor.deps)
  assert.equal(asked, 0)
  assert.equal(noVendor.children.length, 1)
  // a gate that throws refuses (fail closed)
  const broken = harness({ ...ON_P1, [PACK_SCHEDULE_VENDOR_READS_SETTING]: 'true' }, { vendorGate: async () => { throw new Error('x') } })
  await runScheduledReconciliationPack(SCHEDULE_RUN_ID, broken.deps)
  assert.equal(broken.children.length, 0)
  assertOneClosedRecord(broken, 'VENDOR_READS_TOO_SOON', 'refused')
})

test('the child environment is a whitelist: the credential key names are added only for a vendor-reads run', () => {
  const parent = { PATH: '/bin', HOME: '/h', LANG: 'C', DATABASE_URL: 'u', SETTINGS_ENCRYPTION_KEY: 's', ENCRYPTION_KEY: 'e', PGHOST: 'evil', NODE_OPTIONS: 'x', LD_LIBRARY_PATH: 'y', WC_CONSUMER_SECRET: 'z', CRON_SECRET: 'c', XERO_CLIENT_SECRET: 'x' }
  const off = scheduledChildEnv(parent, false)
  const on = scheduledChildEnv(parent, true)
  for (const env of [off, on]) for (const name of ['PGHOST', 'NODE_OPTIONS', 'LD_LIBRARY_PATH', 'WC_CONSUMER_SECRET', 'CRON_SECRET', 'XERO_CLIENT_SECRET']) assert.ok(!(name in env), name)
  assert.ok(!('SETTINGS_ENCRYPTION_KEY' in off) && !('ENCRYPTION_KEY' in off))
  assert.deepEqual([on.SETTINGS_ENCRYPTION_KEY, on.ENCRYPTION_KEY, on.DATABASE_URL], ['s', 'e', 'u'])
})

test('OVERLAP: a second scheduled start while one runs does not run; it is recorded; the first completes; the lock is then free again', async () => {
  let held = false
  const events: string[] = []
  const acquire = async () => { if (held) return null; held = true; return { release: async () => { held = false; events.push('release') } } }
  let finishFirst!: () => void
  const gate = new Promise<void>((resolve) => { finishFirst = resolve })
  const first = harness(ON_P1, { acquireLock: acquire, runChild: async (spec) => { first.children.push(spec); events.push('first-running'); await gate; return { exitCode: 1, stdout: '', stderr: PUBLISHED_STDERR, timedOut: false } } })
  const second = harness(ON_P1, { acquireLock: acquire })
  const running = runScheduledReconciliationPack(SCHEDULE_RUN_ID, first.deps)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(events, ['first-running'])
  const refused = await runScheduledReconciliationPack(SCHEDULE_RUN_ID, second.deps)
  assert.equal(second.children.length, 0, 'the second start did not run the pack')
  assertOneClosedRecord(second, 'ALREADY_RUNNING', 'refused')
  assert.equal(refused.status, 'skipped')
  assert.equal(held, true, 'the first run still holds it')
  finishFirst()
  const done = await running
  assertOneClosedRecord(first, 'fail', 'published')
  assert.equal(first.logged[0]!.level, 'WARNING')
  assert.equal(done.status, 'completed')
  assert.equal(held, false)
  // and a third start runs
  const third = harness(ON_P1, { acquireLock: acquire })
  await runScheduledReconciliationPack(SCHEDULE_RUN_ID, third.deps)
  assert.equal(third.children.length, 1)
})

test('the lock is released when the child throws, and a lock that cannot be taken is a recorded refusal', async () => {
  const thrown = harness(ON_P1, { runChild: async () => { throw new Error('spawn ENOENT postgresql://u:p@h/db') } })
  const outcome = await runScheduledReconciliationPack(SCHEDULE_RUN_ID, thrown.deps)
  assertOneClosedRecord(thrown, 'CHILD_NOT_STARTED', 'failed')
  assert.deepEqual(thrown.events, ['lock', 'log', 'release'])
  assert.equal(outcome.status, 'failed')
  const noLock = harness(ON_P1, { acquireLock: async () => { throw new Error('db down') } })
  await runScheduledReconciliationPack(SCHEDULE_RUN_ID, noLock.deps)
  assert.equal(noLock.children.length, 0)
  assertOneClosedRecord(noLock, 'LOCK_UNAVAILABLE', 'refused')
  // a release that throws does not change the outcome
  const badRelease = harness(ON_P1, { acquireLock: async () => ({ release: async () => { throw new Error('x') } }) })
  const ok = await runScheduledReconciliationPack(SCHEDULE_RUN_ID, badRelease.deps)
  assert.equal(ok.status, 'completed')
})

test('the pack\'s own run lock refusing a start (the other half of overlap) is recorded with its code', async () => {
  const h = harness(ON_P1, {}, { exitCode: 2, stderr: 'Refused: LOCK_HELD\nanother run holds the run lock\n' })
  const outcome = await runScheduledReconciliationPack(SCHEDULE_RUN_ID, h.deps)
  assertOneClosedRecord(h, 'LOCK_HELD', 'refused')
  assert.deepEqual([h.logged[0]!.metadata.exitCode, outcome.status], [2, 'skipped'])
})

test('a failing run: the exit code and its closed meaning are recorded, the level is ERROR, the framework run is failed', async () => {
  const cases: Array<[Partial<ChildResult>, string, string, number | null]> = [
    [{ exitCode: 4, stderr: 'The reconciliation pack failed before it reached an outcome (treat as inconclusive): INTERNAL\n' }, 'INTERNAL', 'failed', 4],
    [{ exitCode: 3, stderr: 'Not published: WRITE_FAILED\n' }, 'WRITE_FAILED', 'failed', 3],
    [{ exitCode: 2, stderr: 'Refused: ACCOUNT_NOT_ALLOWED\n' }, 'ACCOUNT_NOT_ALLOWED', 'refused', 2],
    [{ exitCode: 1, stderr: 'Error: Cannot find module tsx\n' }, 'EXIT_WITHOUT_REPORT', 'failed', 1],
    [{ exitCode: null, timedOut: true, stderr: '' }, 'CHILD_TIMED_OUT', 'failed', null],
  ]
  for (const [ended, code, outcomeName, exit] of cases) {
    const h = harness(ON_P1, {}, ended)
    const outcome = await runScheduledReconciliationPack(SCHEDULE_RUN_ID, h.deps)
    assertOneClosedRecord(h, code, outcomeName)
    assert.equal(h.logged[0]!.metadata.exitCode, exit)
    assert.equal(h.logged[0]!.level, 'ERROR', code)
    assert.equal(outcome.status, 'failed', code)
    if (exit !== null && exit !== 1) assert.equal(typeof h.logged[0]!.metadata.exitMeaning, 'string')
  }
  const inconclusive = harness(ON_P1, {}, { exitCode: 5, stderr: PUBLISHED_STDERR })
  await runScheduledReconciliationPack(SCHEDULE_RUN_ID, inconclusive.deps)
  assertOneClosedRecord(inconclusive, 'inconclusive', 'published')
  assert.equal(inconclusive.logged[0]!.level, 'WARNING')
})

test('a record that cannot be written does not hide the outcome', async () => {
  for (const log of [async () => false, async () => { throw new Error('write failed: postgresql://u:p@h/db') }]) {
    const h = harness(ON_P1, { log: log as never }, { exitCode: 1, stderr: PUBLISHED_STDERR })
    const outcome = await runScheduledReconciliationPack(SCHEDULE_RUN_ID, h.deps)
    assert.equal(outcome.recorded, false)
    assert.deepEqual([outcome.record.outcome, outcome.record.code, outcome.record.exitCode, outcome.record.sequence, outcome.status], ['published', 'fail', 1, 4, 'completed'])
    assert.equal(h.consoleLines.length, 1)
    assert.equal(h.consoleLines[0], '[reconciliation-pack-schedule] record not written: outcome=published code=fail exit=1')
    assert.deepEqual(h.events, ['lock', 'child', 'release'])
  }
  const refusal = harness({}, { log: (async () => false) as never })
  const outcome = await runScheduledReconciliationPack(SCHEDULE_RUN_ID, refusal.deps)
  assert.equal(outcome.recorded, false)
  assert.equal(refusal.consoleLines[0], '[reconciliation-pack-schedule] record not written: outcome=refused code=SCHEDULE_DISABLED exit=none')
})

test('no network and no real process: the harness never reached a socket or the crontab', async () => {
  const net = await import('node:net')
  const original = net.Socket.prototype.connect
  let connects = 0
  net.Socket.prototype.connect = function (this: unknown, ...args: unknown[]) { connects += 1; return (original as (...a: unknown[]) => unknown).apply(this, args) as never } as never
  try {
    const h = harness({ ...ON_P1, [PACK_SCHEDULE_VENDOR_READS_SETTING]: 'true' })
    await runScheduledReconciliationPack(SCHEDULE_RUN_ID, h.deps)
  } finally { net.Socket.prototype.connect = original }
  assert.equal(connects, 0)
})

test('THE FINAL READ: a disable or a vendor-off saved while the run waited on the lock or the rate gate is honoured; the child starts with the re-read values only', async () => {
  const stored: Record<string, string | undefined> = { ...ON_P1, [PACK_SCHEDULE_VENDOR_READS_SETTING]: 'true' }
  const reads = fencedFrom
  // disabled while the gate waited
  const disabled = harness(stored, { fenced: reads({ ...stored, [PACK_SCHEDULE_ENABLED_SETTING]: 'false' }) })
  const out = await runScheduledReconciliationPack(SCHEDULE_RUN_ID, disabled.deps)
  assert.equal(disabled.children.length, 0)
  assertOneClosedRecord(disabled, 'SCHEDULE_DISABLED', 'refused')
  assert.equal(out.status, 'skipped')
  assert.deepEqual(disabled.events, ['lock', 'log', 'release'])
  // vendor reads turned off while it waited: the pack runs WITHOUT the flag and without the keys (the conservative choice)
  const off = harness(stored, { fenced: reads({ ...stored, [PACK_SCHEDULE_VENDOR_READS_SETTING]: 'false' }) })
  await runScheduledReconciliationPack(SCHEDULE_RUN_ID, off.deps)
  assert.deepEqual(off.children[0]!.args, ['--phase', 'P1'])
  assert.ok(!('SETTINGS_ENCRYPTION_KEY' in off.children[0]!.env) && !('ENCRYPTION_KEY' in off.children[0]!.env))
  assert.equal(off.logged[0]!.metadata.vendorReads, false, 'the record states what actually ran')
  // vendor reads turned ON while it waited: not honoured for this start (the rate gate was not consulted for it)
  const on = harness(ON_P1, { fenced: reads({ ...ON_P1, [PACK_SCHEDULE_VENDOR_READS_SETTING]: 'true' }) })
  await runScheduledReconciliationPack(SCHEDULE_RUN_ID, on.deps)
  assert.deepEqual(on.children[0]!.args, ['--phase', 'P1'])
  // the phase changed or was cleared while it waited: exactly the re-read phase
  const moved = harness(ON_P1, { fenced: reads({ ...ON, [PACK_SCHEDULE_PHASE_SETTING]: 'P2' }) })
  await runScheduledReconciliationPack(SCHEDULE_RUN_ID, moved.deps)
  assert.deepEqual(moved.children[0]!.args, ['--phase', 'P2'])
  const cleared = harness(ON_P1, { fenced: reads(ON) })
  await runScheduledReconciliationPack(SCHEDULE_RUN_ID, cleared.deps)
  assert.equal(cleared.children.length, 0)
  assertOneClosedRecord(cleared, 'PHASE_NOT_SET', 'refused')
  // an unreadable final read starts nothing
  const broken = harness(ON_P1, { fenced: async () => { throw new Error('x') } })
  await runScheduledReconciliationPack(SCHEDULE_RUN_ID, broken.deps)
  assert.equal(broken.children.length, 0)
  assertOneClosedRecord(broken, 'SETTINGS_UNREADABLE', 'refused')
})

test('the final read comes AFTER the lock and the rate gate and BEFORE the child', async () => {
  const events: string[] = []
  const h = harness({ ...ON_P1, [PACK_SCHEDULE_VENDOR_READS_SETTING]: 'true' }, {
    acquireLock: async () => { events.push('lock'); return { release: async () => { events.push('release') } } },
    vendorGate: async () => { events.push('gate'); return true },
    fenced: async (_keys, fn) => { events.push('final-read'); return fn(new Map<string, string>([[PACK_SCHEDULE_ENABLED_SETTING, 'true'], [PACK_SCHEDULE_PHASE_SETTING, 'P1'], [PACK_SCHEDULE_VENDOR_READS_SETTING, 'true']])) },
    runChild: async () => { events.push('child'); return { exitCode: 0, stdout: '', stderr: PUBLISHED_STDERR, timedOut: false } },
  })
  await runScheduledReconciliationPack(SCHEDULE_RUN_ID, h.deps)
  assert.deepEqual(events, ['lock', 'gate', 'final-read', 'child', 'release'])
})

test('an exit that looks published but whose report does not verify is a failed run at ERROR level', async () => {
  const h = harness(ON_P1, { verifyReport: () => null })
  const out = await runScheduledReconciliationPack(SCHEDULE_RUN_ID, h.deps)
  assertOneClosedRecord(h, 'REPORT_UNVERIFIED', 'failed')
  assert.equal(h.logged[0]!.level, 'ERROR')
  assert.equal(out.status, 'failed')
  assert.equal(h.logged[0]!.metadata.sequence, null)
})

// --- THE SPAWN INSIDE THE FENCE ---
/** A controllable child: `spawned` and `done` are settled by the test. */
function controlledChild() {
  let spawn!: () => void
  let failSpawn!: (error: Error) => void
  let finish!: (result: ChildResult) => void
  const killed: number[] = []
  const started: StartedScript = {
    spawned: new Promise<void>((resolve, reject) => { spawn = resolve; failSpawn = reject }),
    done: new Promise<ChildResult>((resolve) => { finish = resolve }),
    kill: () => { killed.push(1) },
  }
  return { started, spawn, failSpawn, finish, killed }
}

test('the fence is held until the child has SPAWNED and released then; the child\'s life is outside it', async () => {
  const events: string[] = []
  const child = controlledChild()
  const h = harness(ON_P1, {
    fenced: async (_keys, fn) => { events.push('fence-start'); const out = await fn(new Map([[PACK_SCHEDULE_ENABLED_SETTING, 'true'], [PACK_SCHEDULE_PHASE_SETTING, 'P1']])); events.push('fence-end'); return out },
    startChild: () => { events.push('start'); return child.started },
  })
  const run = runScheduledReconciliationPack(SCHEDULE_RUN_ID, h.deps)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(events, ['fence-start', 'start'], 'started inside the fence, which is still held: the child has not spawned')
  child.spawn()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(events, ['fence-start', 'start', 'fence-end'], 'released as soon as it spawned, while the child still runs')
  child.finish({ exitCode: 0, stdout: '', stderr: PUBLISHED_STDERR, timedOut: false })
  assert.equal((await run).record.outcome, 'published')
})

test('a spawn that fails or times out releases the fence, kills what it started and is a recorded CHILD_NOT_STARTED', async () => {
  for (const mode of ['error', 'timeout', 'throws'] as const) {
    const events: string[] = []
    const child = controlledChild()
    const h = harness(ON_P1, {
      fenced: async (_keys, fn) => { events.push('fence-start'); try { return await fn(new Map([[PACK_SCHEDULE_ENABLED_SETTING, 'true'], [PACK_SCHEDULE_PHASE_SETTING, 'P1']])) } finally { events.push('fence-end') } },
      startChild: () => { if (mode === 'throws') throw new Error('spawn exploded'); if (mode === 'error') child.failSpawn(new Error('ENOENT')); return child.started },
      spawnTimeoutMs: 50,
    })
    const outcome = await runScheduledReconciliationPack(SCHEDULE_RUN_ID, h.deps)
    assertOneClosedRecord(h, 'CHILD_NOT_STARTED', 'failed')
    assert.equal(outcome.status, 'failed', mode)
    assert.deepEqual(events, ['fence-start', 'fence-end'], mode)
    assert.deepEqual(h.events.filter((e) => e === 'release'), ['release'], `${mode}: the session lock is released too`)
    if (mode !== 'throws') assert.equal(child.killed.length, 1, `${mode}: the child is killed`)
  }
})

test('a fence that fails after the child spawned does not orphan it: the run is still waited for and recorded', async () => {
  const child = controlledChild()
  const h = harness(ON_P1, {
    fenced: async (_keys, fn) => { await fn(new Map([[PACK_SCHEDULE_ENABLED_SETTING, 'true'], [PACK_SCHEDULE_PHASE_SETTING, 'P1']])); throw new Error('commit failed') },
    startChild: () => child.started,
  })
  const run = runScheduledReconciliationPack(SCHEDULE_RUN_ID, h.deps)
  child.spawn()
  child.finish({ exitCode: 0, stdout: '', stderr: PUBLISHED_STDERR, timedOut: false })
  const outcome = await run
  assert.equal(outcome.record.outcome, 'published')
  assertOneClosedRecord(h, 'all-pass', 'published')
})

test('startNpmScript: a process that cannot be started rejects `spawned` and resolves `done` with no exit code', async () => {
  const started = startNpmScript({ script: 'x', silent: true, env: { PATH: '/nonexistent' }, cwd: '/nonexistent-dir-for-test', timeoutMs: 5000 })
  await assert.rejects(started.spawned)
  const result = await started.done
  assert.equal(result.exitCode, null)
})
