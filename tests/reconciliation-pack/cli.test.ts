import assert from 'node:assert/strict'
import { chmodSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import test, { afterEach } from 'node:test'

import { runPackCli, type PackCliDeps } from '../../scripts/reconciliation-pack.ts'
import { KEPT_ENV, accountAllowed, buildPackEnv, defaultAsOf, isCalendarDate, parsePackArgs } from '../../lib/reconciliation-pack/cli.ts'
import { PACK_CLI_CODES, PACK_CLI_FLAGS, PACK_EXIT_CODES, PACK_ITEM_IDS } from '../../lib/reconciliation-pack/constants.ts'
import type { ImsQueryClient } from '../../lib/reconciliation-pack/ims-readers.ts'
import { readPackChain } from '../../lib/reconciliation-pack/trend.ts'
import { NOW, cleanup, realEvidence, scratchDir } from './helpers.ts'
import { REF_ABSENT, CODES, D, fakeBasisPort, goodState, healthyLiveness } from './basis-fixtures.ts'
import { reduceStatusReport } from '../../lib/reconciliation-pack/liveness.ts'
import { goodReport, makeStale } from './liveness-fixtures.ts'

const bases: string[] = []
afterEach(() => cleanup(bases))

const SID = '7000000000000000001'
const clean = realEvidence()

type Rig = { sent: string[]; opened: number; invariantRuns: number; out: string[]; err: string[]; deps: Partial<PackCliDeps> }
function rig(over: { sid?: string | null; evidence?: unknown; openFails?: boolean } = {}): Rig {
  const r: Rig = { sent: [], opened: 0, invariantRuns: 0, out: [], err: [], deps: {} }
  const client: ImsQueryClient = {
    async query(sql) {
      r.sent.push(sql)
      if (/pg_current_snapshot/.test(sql)) return { rows: [{ snapshot: '10:20:', read_only: 'on', isolation: 'repeatable read' }] }
      if (/pg_control_system/.test(sql)) return { rows: over.sid === null ? [] : [{ sid: over.sid ?? SID, db: 'ims' }] }
      return { rows: [] }
    },
  }
  r.deps = {
    now: () => NOW,
    openIms: async () => { r.opened += 1; if (over.openFails) throw new Error('refused'); return { client, close: async () => undefined } },
    runInvariant: async () => { r.invariantRuns += 1; return 'evidence' in over ? over.evidence : clean },
    disconnect: async () => undefined,
    // The real ports would start a child process and open a client of their own: a test always hands doubles.
    liveness: healthyLiveness(),
    basis: fakeBasisPort(goodState()),
  }
  return r
}
function run(r: Rig, argv: string[], extra: Partial<Parameters<typeof runPackCli>[0]> = {}): Promise<number> {
  return runPackCli({
    argv, env: { DATABASE_URL: 'postgresql://ims@127.0.0.1:1/x' }, uid: 1000, checkoutOwnerUid: 1000, repoRoot: '/var/tmp', deps: r.deps,
    stdout: (t) => r.out.push(t), stderr: (t) => r.err.push(t), ...extra,
  })
}
const base = (dir: string, ...more: string[]) => ['--phase', 'P0', '--report-dir', dir, ...more]
const text = (r: Rig) => [...r.out, ...r.err].join('\n')

// ---- arguments ----------------------------------------------------------------------------------

test('arguments: every refusal is a closed code, and a good line parses to exactly what it says', () => {
  const ok = parsePackArgs(['--phase', 'P1', '--as-of', '2026-10-19', '--items', 'R3,R15', '--report-dir', '/var/tmp/x', '--acceptances', '/var/tmp/a.json'], NOW)
  assert.deepEqual(ok, { phase: 'P1', asOf: '2026-10-19', items: ['R3', 'R15'], acceptances: '/var/tmp/a.json', reportDir: '/var/tmp/x', basisOnly: false, vendorReadsOnly: false, help: false })
  assert.equal((parsePackArgs(['--phase', 'P2'], NOW) as { asOf: string }).asOf, '2026-10-19', 'default is yesterday UTC')
  const bad: Array<[string, string[]]> = [
    ['no phase', []], ['unknown phase', ['--phase', 'P3']], ['lower-case phase', ['--phase', 'p1']], ['unknown flag', ['--phase', 'P1', '--force']],
    ['repeated value flag', ['--phase', 'P1', '--phase', 'P2']], ['repeated boolean', ['--phase', 'P1', '--basis-only', '--basis-only']],
    ['value missing', ['--phase']], ['value is a flag', ['--phase', '--as-of']], ['empty value', ['--phase', 'P1', '--report-dir', '']],
    ['as-of not a date', ['--phase', 'P1', '--as-of', '2026-13-01']], ['as-of 30 Feb', ['--phase', 'P1', '--as-of', '2026-02-30']], ['as-of today', ['--phase', 'P1', '--as-of', '2026-10-20']],
    ['as-of future', ['--phase', 'P1', '--as-of', '2027-01-01']], ['as-of with time', ['--phase', 'P1', '--as-of', '2026-10-19T00:00:00Z']],
    ['unknown item', ['--phase', 'P1', '--items', 'R16']], ['repeated item', ['--phase', 'P1', '--items', 'R3,R3']], ['empty item', ['--phase', 'P1', '--items', 'R3,']], ['lower-case item', ['--phase', 'P1', '--items', 'r3']],
    ['basis-only with items', ['--phase', 'P1', '--basis-only', '--items', 'R3']], ['control character', ['--phase', 'P1', '--report-dir', '/var/tmp/a\nb']],
    ['positional argument', ['--phase', 'P1', 'R3']],
  ]
  for (const [name, argv] of bad) assert.deepEqual(parsePackArgs(argv, NOW), { code: 'BAD_ARGUMENTS' }, name)
  assert.deepEqual(parsePackArgs(['--help'], NOW), { phase: 'P0', asOf: null, items: null, acceptances: null, reportDir: '/var/tmp/ims-reconciliation-pack-reports', basisOnly: false, vendorReadsOnly: false, help: true })
  assert.ok(isCalendarDate('2024-02-29') && !isCalendarDate('2026-02-29'))
  assert.equal(defaultAsOf(new Date('2026-03-01T00:00:00Z')), '2026-02-28')
})

test('a credential-shaped argument is refused with its own code before anything else, whether a value or a stray argument; the argument is never echoed', async () => {
  // Assembled at run time so this file holds no credential-shaped literal.
  const url = ['post', 'gres://ims:hunter2', '@db.example/ims'].join('')
  const shapes = [url, `${'pass'}${'word'}=hunter2`, `${'tok'}${'en'}:abc`, ['http', 's://x.example/?', 'key=abc'].join('')]
  for (const shape of shapes) {
    for (const argv of [['--phase', 'P1', '--report-dir', shape], ['--phase', 'P1', '--acceptances', shape], ['--phase', 'P1', shape]]) {
      assert.deepEqual(parsePackArgs(argv, NOW), { code: 'CREDENTIAL_ARGUMENT' }, shape)
      const r = rig()
      assert.equal(await run(r, argv), 2)
      assert.ok(text(r).includes('CREDENTIAL_ARGUMENT') && !text(r).includes('hunter2') && !text(r).includes('abc'))
      assert.equal(r.opened + r.invariantRuns, 0)
    }
  }
})

test('--help prints every flag, the exit-code table and the CLI codes, exits 0 and touches nothing', async () => {
  const r = rig()
  assert.equal(await run(r, ['--help']), 0)
  const help = r.out.join('\n')
  for (const f of PACK_CLI_FLAGS) assert.ok(help.includes(f.flag), f.flag)
  for (const row of PACK_EXIT_CODES) assert.ok(help.includes(`| ${row.code} | ${row.name} |`), row.name)
  for (const code of Object.keys(PACK_CLI_CODES)) assert.ok(help.includes(code), code)
  assert.equal(r.opened + r.invariantRuns, 0)
})

// ---- who may run it, what is reserved -----------------------------------------------------------

test('the account is decided by uid: root or the checkout owner; anyone else, or an unknown uid or owner, is refused and nothing runs', async () => {
  assert.deepEqual([accountAllowed(0, 1000), accountAllowed(1000, 1000), accountAllowed(1001, 1000), accountAllowed(null, 1000), accountAllowed(1000, null), accountAllowed(null, null), accountAllowed(0, null)], [true, true, false, false, false, false, false])
  const dir = scratchDir(bases)
  for (const [uid, owner] of [[1001, 1000], [null, 1000], [1000, null]] as const) {
    const r = rig()
    assert.equal(await run(r, base(dir), { uid, checkoutOwnerUid: owner }), 2)
    assert.ok(text(r).includes('ACCOUNT_NOT_ALLOWED'))
    assert.equal(r.opened + r.invariantRuns, 0)
  }
  const r = rig()
  assert.equal(await run(r, base(dir), { uid: 0, checkoutOwnerUid: 1000 }), 0)
})

test('--basis-only makes the same bracket a run makes (liveness, basis read, liveness, settle), prints a closed code, runs no item and writes nothing', async () => {
  const dir = scratchDir(bases)
  const cases: Array<[string, (r: Rig) => void, number, RegExp]> = [
    ['ready', () => undefined, 0, /^Basis for 2026-10-19: ready$/],
    ['no subledger run row', (r) => { r.deps.basis = fakeBasisPort(goodState({ run: null })) }, 5, /not ready \(no_subledger_snapshot\)/],
    ['the stream is stale', (r) => { r.deps.liveness = { read: async () => reduceStatusReport(makeStale(goodReport(), 'xero-balance-snapshots')) } }, 5, /not ready \(stream_not_fresh\)/],
    ['the status report cannot be read', (r) => { r.deps.liveness = { read: async () => { throw new Error('boom') } } }, 5, /not ready \(stream_not_fresh\)/],
    ['an inventory leg the trial balance omitted', (r) => {
      const state = goodState()
      state.gl = state.gl.map((row) => (row.accountCode === CODES.allocated && row.balanceDate.getTime() === new Date(`${D}T00:00:00.000Z`).getTime() ? { ...row, amountBase: '0', sourcePayloadRef: REF_ABSENT(D) } : row))
      r.deps.basis = fakeBasisPort(state)
    }, 5, /not ready \(inventory comparison withheld: absent-from-tb/],
    ['the transit leg alone is unusable: still ready, and it says so', (r) => { const state = goodState(); state.settings.delete('transit_ledger_coverage_start_date'); r.deps.basis = fakeBasisPort(state) }, 0, /ready \(transit leg: transit_ledger_not_covering\)/],
  ]
  for (const [name, change, expected, pattern] of cases) {
    const r = rig()
    change(r)
    let reads = 0
    const inner = r.deps.liveness!
    r.deps.liveness = { read: async () => { reads += 1; return inner.read() } }
    assert.equal(await run(r, base(dir, '--basis-only')), expected, name)
    assert.match(text(r), pattern, name)
    assert.equal(reads, 2, `${name}: the status report is read at the start and the end`)
    assert.equal(r.opened + r.invariantRuns, 0, `${name}: no item and no IMS section was run`)
  }
  assert.deepEqual(readdirSync(dir), [], 'nothing was written')
  // A basis port that throws is an internal failure (4), and nothing about the cause is printed.
  const throws = rig(); throws.deps.basis = { read: async () => { throw new Error('boom') }, settle: async () => { throw new Error('boom') } }
  assert.equal(await run(throws, base(dir, '--basis-only')), 4)
  assert.ok(!text(throws).includes('boom'))
  // The same environment rules as a run.
  const noEnv = rig()
  assert.equal(await run(noEnv, base(dir, '--basis-only'), { env: {} }), 2)
  assert.ok(text(noEnv).includes('DATABASE_URL_MISSING'))
})

test('DATABASE_URL must be in the environment', async () => {
  const dir = scratchDir(bases)
  const r = rig()
  assert.equal(await run(r, base(dir), { env: {} }), 2)
  assert.ok(text(r).includes('DATABASE_URL_MISSING'))
  assert.equal(r.opened, 0)
})

test('the environment is REPLACED by a whitelist before the database client could load', async () => {
  const keys = ['PGHOST', 'PGPASSWORD', 'NODE_OPTIONS', 'LD_PRELOAD', 'BASH_ENV', 'SOME_API_KEY', 'MINTSOFT_WRITE_GRANT', 'XERO_WRITE_GRANT']
  const saved = { ...process.env }
  let seen: string[] = []
  try {
    for (const key of keys) process.env[key] = 'x'
    process.env.DATABASE_URL = 'postgresql://ims@127.0.0.1:1/x'
    const r = rig()
    r.deps.openIms = async () => { seen = Object.keys(process.env); throw new Error('stop here') }
    const dir = scratchDir(bases)
    const code = await runPackCli({ argv: base(dir), uid: 1000, checkoutOwnerUid: 1000, repoRoot: '/var/tmp', deps: r.deps, stdout: () => undefined, stderr: () => undefined })
    assert.equal(code, 4)
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, saved)
  }
  assert.ok(seen.length > 0 && seen.every((k) => (['HOME', ...KEPT_ENV] as string[]).includes(k)), seen.join(','))
  assert.deepEqual(buildPackEnv({ PGHOST: 'h', DATABASE_URL: 'u', PATH: '/bin', X: '1', LANG: '' }, '/h'), { HOME: '/h', DATABASE_URL: 'u', PATH: '/bin' })
})

// ---- a run --------------------------------------------------------------------------------------

test('P0 with a clean report: R3, R4 and R15 pass, exit 0, one report published and readable, only read-only statements sent, no network', async () => {
  const dir = scratchDir(bases)
  const connects: unknown[] = []
  const original = net.Socket.prototype.connect
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) { connects.push(args); return (original as (...a: unknown[]) => unknown).apply(this, args) } as typeof original
  const r = rig()
  let code: number
  try { code = await run(r, base(dir)) } finally { net.Socket.prototype.connect = original }
  assert.equal(code, 0, text(r))
  assert.equal(connects.length, 0, 'no socket was opened')
  const chain = readPackChain(dir)
  assert.ok(chain.ok && chain.reports.length === 1)
  if (chain.ok) {
    assert.equal(chain.head!.record.systemIdentifier, SID)
    assert.deepEqual(chain.head!.record.items.filter((i) => i.outcome === 'pass').map((i) => i.id), ['R3', 'R4', 'R15'])
    assert.equal(chain.head!.record.exitCode, 0)
  }
  assert.equal(r.out.length, PACK_ITEM_IDS.length + 1)
  assert.equal(r.invariantRuns, 1)
  assert.equal(r.sent[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  assert.equal(r.sent.at(-1), 'ROLLBACK')
  assert.ok(r.sent.every((s) => /^(BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY|ROLLBACK|SELECT|SET LOCAL)/.test(s)))
})

test('P1 exits 5 (items without a runner), and a failing invariant report exits 1 with the report published', async () => {
  const dir = scratchDir(bases)
  const a = rig()
  assert.equal(await run(a, ['--phase', 'P1', '--report-dir', dir]), 5)
  const b = rig({ evidence: realEvidence([{ severity: 'warning', code: 'stock_cost_layer_quantity_mismatch', productId: 'cproduct0000000000000001a', warehouseId: 'cwarehouse000000000000001', message: 'm', details: { quantity: 5, remainingCostLayerQty: 3 } }]) })
  assert.equal(await run(b, ['--phase', 'P0', '--report-dir', dir]), 1)
  assert.equal(readdirSync(dir).filter((n) => /^\d{8}T/.test(n)).length, 2)
  const chain = readPackChain(dir)
  assert.ok(chain.ok && chain.head!.sequence === 2)
})

// [mutation: the injected ledger runners not passed to the run]
test('injected item runners and ledger runners reach the run (the seam later items use); the built-in ledger runners run on the settled basis otherwise', async () => {
  const dir = scratchDir(bases)
  const custom = rig()
  custom.deps.ledgerRunners = { R6: async () => ({ id: 'R6', outcome: 'inconclusive', reasons: ['READ_INCOMPLETE'] }) }
  custom.deps.runners = { R1: async () => ({ id: 'R1', outcome: 'inconclusive', reasons: ['READ_INCOMPLETE'] }) }
  // R1's stand-in is a vendor item, so it runs only on a run that opted in (a vendor item without the flag is VENDOR_READS_OFF).
  assert.equal(await run(custom, ['--phase', 'P1', '--as-of', D, '--report-dir', dir, '--vendor-reads-only']), 5)
  assert.ok(custom.out.includes('R6 inconclusive READ_INCOMPLETE') && custom.out.includes('R1 inconclusive READ_INCOMPLETE'), custom.out.join('\n'))
  const builtIn = rig()
  assert.equal(await run(builtIn, ['--phase', 'P1', '--as-of', D, '--items', 'R6', '--report-dir', scratchDir(bases)]), 5)
  assert.ok(builtIn.out.includes('R6 pass -'), builtIn.out.join('\n'))
})

test('an invariant run that throws, or reports something unreadable, never exits 0', async () => {
  for (const evidence of [null, undefined, 'x', {}, { ok: true }]) {
    const dir = scratchDir(bases)
    const r = rig({ evidence })
    assert.notEqual(await run(r, base(dir)), 0)
    const chain = readPackChain(dir)
    assert.ok(chain.ok && chain.head!.record.items.every((i) => i.outcome !== 'pass'))
  }
  const dir = scratchDir(bases)
  const r = rig(); r.deps.runInvariant = async () => { throw new Error('db down') }
  assert.equal(await run(r, base(dir)), 5)
})

test('the database cannot be read, or names no valid cluster: DATABASE_UNREADABLE, exit 4, nothing published, no item run', async () => {
  for (const over of [{ openFails: true }, { sid: null }, { sid: 'abc' }, { sid: '123' }]) {
    const dir = scratchDir(bases)
    const r = rig(over)
    assert.equal(await run(r, base(dir)), 4, JSON.stringify(over))
    assert.ok(text(r).includes('DATABASE_UNREADABLE'))
    assert.equal(r.invariantRuns, 0)
    assert.deepEqual(readdirSync(dir), [])
  }
})

test('an unsafe report directory and a broken chain are refusals (2) before any item runs', async () => {
  const unsafe = scratchDir(bases)
  chmodSync(unsafe, 0o777)
  const a = rig()
  assert.equal(await run(a, base(unsafe)), 2)
  assert.ok(text(a).includes('DIR_UNTRUSTED'))
  assert.equal(a.opened + a.invariantRuns, 0)

  const broken = scratchDir(bases)
  const seed = rig()
  assert.equal(await run(seed, base(broken)), 0)
  const runDir = readdirSync(broken).find((n) => /^\d{8}T/.test(n))!
  writeFileSync(path.join(broken, runDir, 'evidence.jsonl'), 'tampered\n')
  const b = rig()
  assert.equal(await run(b, base(broken)), 2)
  assert.ok(text(b).includes('PAIR_INVALID'))
  assert.equal(b.opened + b.invariantRuns, 0)
})

test('exit 3: a report that cannot be durably published is not an outcome, whatever the items were', async () => {
  const dir = scratchDir(bases)
  const r = rig()
  assert.equal(await run(r, base(dir), { publishHooks: { writeFile: () => { throw new Error('disk full') } } }), 3)
  assert.ok(text(r).includes('WRITE_FAILED'))
  assert.equal(readdirSync(dir).filter((n) => /^\d{8}T/.test(n)).length, 0)
})

test('the acceptance file: a named file that cannot be read is a refusal; a trusted file accepts a warning; an untrusted one accepts nothing', async () => {
  const dir = scratchDir(bases)
  const missing = rig()
  assert.equal(await run(missing, base(dir, '--acceptances', path.join(dir, 'nope.json'))), 2)
  assert.ok(text(missing).includes('ACCEPTANCE_FILE_UNREADABLE'))
  assert.equal(missing.opened + missing.invariantRuns, 0)

  const warning = { severity: 'warning', code: 'some_warning', productId: 'cproduct0000000000000001a', warehouseId: 'cwarehouse000000000000001', message: 'm', details: {} }
  const evidence = realEvidence([warning])
  const file = path.join(scratchDir(bases), 'accept.json')
  const { now } = { now: NOW }
  const entry = { warningId: 'invariant:inventory:some_warning:product=cproduct0000000000000001a,warehouse=cwarehouse000000000000001', acceptedBy: 'A Person', acceptedAt: new Date(now.getTime() - 3600_000).toISOString(), reason: 'Read it and agreed by hand', expiresAt: new Date(now.getTime() + 86400_000 * 30).toISOString(), phases: ['P0'] }
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, acceptances: [entry] }), { mode: 0o600 })
  const trusted = rig({ evidence })
  assert.equal(await run(trusted, base(scratchDir(bases), '--acceptances', file)), 0, text(trusted))
  chmodSync(file, 0o666)
  const untrusted = rig({ evidence })
  assert.equal(await run(untrusted, base(scratchDir(bases), '--acceptances', file)), 1, 'a file others can write accepts nothing')
})

test('nothing from the database URL, the evidence ids or an exception reaches the output', async () => {
  const dir = scratchDir(bases)
  const secret = ['hun', 'ter2-canary'].join('')
  const r = rig({ evidence: realEvidence([{ severity: 'warning', code: 'stock_cost_layer_quantity_mismatch', productId: secret, warehouseId: 'cwarehouse000000000000001', message: secret, details: { quantity: 5, remainingCostLayerQty: 3 } }]) })
  r.deps.disconnect = async () => { throw new Error(secret) }
  await run(r, base(dir), { env: { DATABASE_URL: `postgresql://ims:${secret}@127.0.0.1:1/x` } })
  assert.ok(!text(r).includes(secret))
  for (const name of readdirSync(dir)) if (/^\d{8}T/.test(name)) for (const f of readdirSync(path.join(dir, name))) assert.ok(!readFileSync(path.join(dir, name, f), 'utf8').includes(secret), f)
})
