import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, renameSync, writeFileSync, chmodSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { type TestContext, test } from 'node:test'
import { pgBinDir, startCluster } from './real-postgres-cluster.ts'

import {
  REHEARSAL_EXIT,
  RehearsalGuardError,
  STEP_CATALOGUE,
  type StepId,
  type StepResult,
  type TableFingerprint,
  type TeardownResult,
  assertNoConnectorEnv,
  assertThrowawayDatabaseUrl,
  assessOutboundStatus,
  assessBaseCurrencyLock,
  assessParity,
  assessSeededRows,
  compareParity,
  isRed,
  outboundStatusScriptPresent,
  redactSecrets,
  rehearsalExitCode,
  type SeededRowFacts,
} from '@/lib/ops/first-install-rehearsal'
import { ancestorProblem, capturePostmaster, inheritedEnv, verifyPublishedReport, writeExclusive, postmasterIsStillOurs, processStartEpochSeconds, parseArgs, processIsAlive, processesNaming, runRehearsal, shredFile, type RehearsalHooks } from '@/scripts/rehearse-first-install'

const REPO = process.cwd()
const SCRATCH_PARENT = '/var/tmp'
const TIMEOUT = 15 * 60 * 1000

// ---------------------------------------------------------------------------------------------
// Pure rules.
// ---------------------------------------------------------------------------------------------

test('the exit-code table in docs/installation.md is exactly REHEARSAL_EXIT (universal, both directions)', () => {
  const docs = readFileSync(join(REPO, 'docs/installation.md'), 'utf8')
  const start = docs.indexOf('### Exit codes\n\nThis table is the only place the codes are documented')
  assert.notEqual(start, -1, 'precondition: the rehearsal section documents its exit codes under "### Exit codes"')
  const rest = docs.slice(start + 5)
  const end = rest.search(/\n#{2,3} /)
  const section = rest.slice(0, end === -1 ? undefined : end)
  const documented = [...section.matchAll(/^\| (\d+) \|/gm)].map((m) => Number(m[1])).sort()
  const defined = Object.values(REHEARSAL_EXIT).sort()
  console.log(`# exit codes documented=${JSON.stringify(documented)} defined=${JSON.stringify(defined)}`)
  assert.ok(documented.length > 0, 'precondition: at least one documented code was matched')
  assert.deepEqual(documented, defined)
  // The script must not restate the table: the only `0`-`3` meanings live in lib/ops.
  const script = readFileSync(join(REPO, 'scripts/rehearse-first-install.ts'), 'utf8')
  assert.equal(/\bexitCode = [0-3]\b/.test(script), false, 'the script uses REHEARSAL_EXIT, never a bare number')
})

const GOOD_FACTS: SeededRowFacts = {
  organisations: [{ id: 'default', baseCurrency: 'GBP', country: 'GB' }],
  warehouses: [{ code: 'DEFAULT', isDefault: true }],
  taxRates: [
    { name: 'UK Standard Rate (20%)', rate: '0.2000', isDefault: true },
    { name: 'UK Reduced Rate (5%)', rate: '0.0500', isDefault: false },
    { name: 'Zero Rated (0%)', rate: '0.0000', isDefault: false },
    { name: 'EU Standard Rate (20%)', rate: '0.2000', isDefault: false },
  ],
  currencies: ['CAD', 'EUR', 'GBP', 'NOK', 'SEK', 'USD'],
  adminUsers: 1,
  smtpSettingKeys: [],
}

test('assessSeededRows: the fresh-install facts pass, and each broken fact fails on its own', () => {
  assert.deepEqual(assessSeededRows(GOOD_FACTS), { ok: true, failures: [] })
  const cases: Array<[string, SeededRowFacts, RegExp]> = [
    ['non-GBP base currency', { ...GOOD_FACTS, organisations: [{ id: 'default', baseCurrency: 'EUR', country: 'GB' }] }, /baseCurrency is EUR/],
    ['no organisation', { ...GOOD_FACTS, organisations: [] }, /exactly one Organisation/],
    ['no default warehouse', { ...GOOD_FACTS, warehouses: [] }, /DEFAULT warehouse is missing/],
    ['too few tax rates', { ...GOOD_FACTS, taxRates: GOOD_FACTS.taxRates.slice(0, 2) }, /at least 4/],
    ['missing currency', { ...GOOD_FACTS, currencies: ['GBP'] }, /currencies missing/],
    ['no admin', { ...GOOD_FACTS, adminUsers: 0 }, /exactly one admin/],
    ['SMTP stored', { ...GOOD_FACTS, smtpSettingKeys: ['email_smtp_host'] }, /SMTP settings were stored/],
  ]
  for (const [name, facts, pattern] of cases) {
    const result = assessSeededRows(facts)
    assert.equal(result.ok, false, name)
    assert.ok(result.failures.some((failure) => pattern.test(failure)), `${name}: ${result.failures.join(' | ')}`)
  }
})

function fingerprints(entries: Record<string, [number, string]>): Map<string, TableFingerprint> {
  return new Map(Object.entries(entries).map(([table, [rows, md5]]) => [table, { rows, md5 }]))
}

test('compareParity: identical is ok; a changed row, a lost row, a missing and an invented table are each a mismatch', () => {
  const source = fingerprints({ organisations: [1, 'a'], settings: [3, 'b'], tax_rates: [4, 'c'], empty_table: [0, ''] })
  const same = compareParity(source, fingerprints({ organisations: [1, 'a'], settings: [3, 'b'], tax_rates: [4, 'c'], empty_table: [0, ''] }))
  console.log(`# parity precondition: tablesCompared=${same.tablesCompared} tablesWithRows=${same.tablesWithRows} totalRows=${same.totalRows}`)
  assert.equal(same.ok, true)
  assert.equal(same.tablesCompared, 4)
  assert.equal(same.tablesWithRows, 3)
  assert.equal(same.totalRows, 8)

  const md5 = compareParity(source, fingerprints({ organisations: [1, 'a'], settings: [3, 'TAMPERED'], tax_rates: [4, 'c'], empty_table: [0, ''] }))
  assert.deepEqual(md5.mismatches.map((m) => [m.table, m.kind]), [['settings', 'md5']])
  const count = compareParity(source, fingerprints({ organisations: [1, 'a'], settings: [3, 'b'], tax_rates: [3, 'c'], empty_table: [0, ''] }))
  assert.deepEqual(count.mismatches.map((m) => [m.table, m.kind]), [['tax_rates', 'row-count']])
  const missing = compareParity(source, fingerprints({ organisations: [1, 'a'], settings: [3, 'b'], empty_table: [0, ''] }))
  assert.deepEqual(missing.mismatches.map((m) => [m.table, m.kind]), [['tax_rates', 'missing-in-restore']])
  const invented = compareParity(source, fingerprints({ organisations: [1, 'a'], settings: [3, 'b'], tax_rates: [4, 'c'], empty_table: [0, ''], extra: [1, 'z'] }))
  assert.deepEqual(invented.mismatches.map((m) => [m.table, m.kind]), [['extra', 'unexpected-in-restore']])
})

test('assessParity: a comparison over nothing, or over only empty tables, is vacuous and fails', () => {
  assert.equal(assessParity(compareParity(new Map(), new Map())).ok, false)
  const onlyEmpty = fingerprints({ a: [0, ''], b: [0, ''] })
  const result = assessParity(compareParity(onlyEmpty, onlyEmpty))
  assert.equal(result.ok, false)
  assert.match(result.failures.join(' '), /every compared table was empty/)
})

test('assertThrowawayDatabaseUrl accepts only the rehearsal cluster and names what is wrong otherwise', () => {
  const target = { host: '127.0.0.1', port: 41587, user: 'rehearsal_ab12', databases: ['ims_rehearsal', 'ims_rehearsal_restore'] } as const
  const ok = 'postgresql://rehearsal_ab12:secret@127.0.0.1:41587/ims_rehearsal'
  assert.doesNotThrow(() => assertThrowawayDatabaseUrl(ok, target))
  assert.doesNotThrow(() => assertThrowawayDatabaseUrl('postgresql://rehearsal_ab12:secret@127.0.0.1:41587/ims_rehearsal_restore', target))
  const refused: Array<[string, string | undefined, RegExp]> = [
    ['no URL at all', undefined, /no DATABASE_URL/],
    ['the shared dev database', 'postgresql://imsdev:pw@127.0.0.1:5432/onetwo3d_ims_dev', /port 5432 is not the throwaway cluster's 41587.*role is not the rehearsal role.*database onetwo3d_ims_dev/],
    ['same cluster, a foreign database', 'postgresql://rehearsal_ab12:secret@127.0.0.1:41587/postgres', /database postgres is not one of/],
    ['another host', 'postgresql://rehearsal_ab12:secret@10.0.0.9:41587/ims_rehearsal', /host 10.0.0.9/],
    ['another port', 'postgresql://rehearsal_ab12:secret@127.0.0.1:5432/ims_rehearsal', /port 5432/],
    ['another role', 'postgresql://postgres:secret@127.0.0.1:41587/ims_rehearsal', /role is not the rehearsal role/],
    ['no password', 'postgresql://rehearsal_ab12@127.0.0.1:41587/ims_rehearsal', /no password/],
    ['a query string that could redirect it', `${ok}?host=/var/run/postgresql`, /query string/],
    ['not a URL', 'not a url', /not a URL/],
  ]
  for (const [name, url, pattern] of refused) {
    assert.throws(() => assertThrowawayDatabaseUrl(url, target), (error: unknown) => error instanceof RehearsalGuardError && pattern.test(error.message), name)
  }
})

test('assertNoConnectorEnv refuses SMTP, connector credentials, grants and libpq overrides, and allows a clean environment', () => {
  assert.doesNotThrow(() => assertNoConnectorEnv({ PATH: '/usr/bin', DATABASE_URL: 'x', NODE_ENV: 'production', AUTH_SECRET: 'y' }))
  for (const name of ['SMTP_HOST', 'SMTP_PASS', 'WC_CONSUMER_KEY', 'WC_WRITEBACK_ALLOWED_ORIGIN', 'MINTSOFT_API_KEY', 'MINTSOFT_WRITE_ALLOWED', 'XERO_CLIENT_SECRET', 'XERO_WRITE_ALLOWED_TENANT', 'NOTIFICATION_EMAIL', 'PGHOST', 'PGPASSWORD', 'SHADOW_DATABASE_URL']) {
    assert.throws(() => assertNoConnectorEnv({ PATH: '/usr/bin', [name]: 'x' }), (error: unknown) => error instanceof RehearsalGuardError && error.message.includes(name), name)
  }
  // An unset (undefined) entry carries nothing.
  assert.doesNotThrow(() => assertNoConnectorEnv({ SMTP_HOST: undefined }))
})

test('the outbound:status step is optional while the script is absent and required once it exists', () => {
  assert.equal(outboundStatusScriptPresent(undefined), false)
  assert.equal(outboundStatusScriptPresent({ build: 'next build' }), false)
  assert.equal(outboundStatusScriptPresent({ 'outbound:status': '  ' }), false)
  assert.equal(outboundStatusScriptPresent({ 'outbound:status': 'tsx scripts/outbound-status.ts' }), true)

  const report = (states: Record<string, string>, extra: Record<string, unknown> = {}) => `> onetwoinventory@2.0.0 outbound:status\n> tsx scripts/outbound-status.ts --json --expect-held\n\n${JSON.stringify({
    generatedAt: '2026-10-04T00:00:00.000Z', windowHours: 24, anyGranted: false, anyUnreadable: false, countsAvailable: true, exitCode: 0,
    connectors: Object.entries(states).map(([connector, state]) => ({ connector, label: connector, state })), ...extra,
  }, null, 2)}\nExit code 0.\n`
  const allHeld = { woocommerce: 'held', mintsoft: 'held', xero: 'held' }
  const ok = assessOutboundStatus({ exitCode: 0, stdout: report(allHeld) })
  console.log(`# all-held report accepted: ${ok.ok}`)
  assert.equal(ok.ok, true, 'precondition: the real shape (npm banner, JSON, trailing line) with every connector held passes')
  const bad: Array<[string, string, RegExp]> = [
    ['a connector whose state is "not held"', report({ ...allHeld, woocommerce: 'not held' }), /woocommerce.*"not held"/],
    ['a granted connector', report({ ...allHeld, xero: 'granted' }, { anyGranted: true }), /xero.*"granted"/],
    ['an unreadable grant', report({ ...allHeld, mintsoft: 'unreadable' }, { anyUnreadable: true }), /mintsoft.*"unreadable"/],
    ['a missing connector', report({ woocommerce: 'held', mintsoft: 'held' }), /no entry for xero/],
    ['a duplicated connector', report(allHeld).replace('"connector": "xero"', '"connector": "mintsoft"'), /mintsoft.*more than once/],
    ['an unknown connector', report({ ...allHeld, acme: 'held' }), /unknown connector acme/],
    ['mixed states on one connector line of a text report', 'woocommerce: held, not granted, open\nmintsoft: held\nxero: held\n', /exactly one JSON report, found 0/],
    ['anyGranted true although every state says held', report(allHeld, { anyGranted: true }), /anyGranted/],
    ['a non-zero exit', report(allHeld).replace('Exit code 0', 'Exit code 3'), /exited 3/],
    ['a stale all-held block followed by the real report showing a grant', `${report(allHeld)}\n${report({ ...allHeld, xero: 'granted' }, { anyGranted: true })}`, /exactly one JSON report/],
    ['the real report showing a grant followed by a stale all-held block', `${report({ ...allHeld, xero: 'granted' }, { anyGranted: true })}\n${report(allHeld)}`, /exactly one JSON report/],
    ['diagnostic text before the report', `warning: using a cached status\n${report(allHeld)}`, /unexpected text/],
    ['diagnostic text after the report', `${report(allHeld)}\neverything is fine, trust me\n`, /unexpected text/],
  ]
  for (const [name, stdout, pattern] of bad) {
    const result = assessOutboundStatus({ exitCode: name === 'a non-zero exit' ? 3 : 0, stdout })
    assert.equal(result.ok, false, name)
    assert.match(result.failures.join(' | '), pattern, name)
  }
})

function step(id: StepId, status: StepResult['status'], required = true): StepResult {
  const def = STEP_CATALOGUE.find((candidate) => candidate.id === id)!
  return { id, item: def.item, title: def.title, required, status, detail: {}, durationMs: 0 }
}

const CLEAN_TEARDOWN: TeardownResult = { clusterStopped: true, postmasterPid: 1, envFileShredded: true, rootRemoved: true, orphanPids: [], errors: [] }

test('the verdict: a required step that did not pass is red, an optional skipped one is not, teardown trouble is exit 3', () => {
  assert.equal(isRed([step('seed', 'passed')]), false)
  assert.equal(isRed([step('seed', 'failed')]), true)
  assert.equal(isRed([step('seed', 'skipped')]), true, 'a required step that was skipped is red')
  assert.equal(isRed([step('seed', 'passed'), step('outbound-status', 'skipped', false)]), false)
  assert.equal(rehearsalExitCode([step('seed', 'passed')], CLEAN_TEARDOWN), REHEARSAL_EXIT.OK)
  assert.equal(rehearsalExitCode([step('seed', 'failed')], CLEAN_TEARDOWN), REHEARSAL_EXIT.RED)
  assert.equal(rehearsalExitCode([step('seed', 'passed')], { ...CLEAN_TEARDOWN, orphanPids: [4242] }), REHEARSAL_EXIT.TEARDOWN_INCOMPLETE)
  assert.equal(rehearsalExitCode([step('seed', 'passed')], { ...CLEAN_TEARDOWN, envFileShredded: false }), REHEARSAL_EXIT.TEARDOWN_INCOMPLETE)
  assert.equal(rehearsalExitCode([step('seed', 'failed')], { ...CLEAN_TEARDOWN, rootRemoved: false }), REHEARSAL_EXIT.TEARDOWN_INCOMPLETE, 'teardown outranks red')
  assert.equal(rehearsalExitCode([step('seed', 'passed')], null), REHEARSAL_EXIT.TEARDOWN_INCOMPLETE)
})

test('redactSecrets removes every occurrence, longest first, including the URL-encoded form', () => {
  const out = redactSecrets('pw=abcdef123456 and abcdef; url=a%2Fb%2Fcdefgh x', ['abcdef', 'abcdef123456', 'a/b/cdefgh', 'short'])
  assert.equal(out, 'pw=*** and ***; url=*** x')
})

test('parseArgs', () => {
  assert.deepEqual(parseArgs([]), { help: false })
  assert.deepEqual(parseArgs(['--root', '/var/tmp/x', '--report-dir', '/var/tmp/r']), { help: false, root: '/var/tmp/x', reportDir: '/var/tmp/r' })
  assert.deepEqual(parseArgs(['--help']), { help: true })
  assert.ok('error' in parseArgs(['--root']))
  assert.ok('error' in parseArgs(['--nonsense']))
})

test('processesNaming finds a live process by what its command line names, and only a live one (the orphan detector can see)', async () => {
  const marker = `/var/tmp/ims-rehearsal-orphan-probe-${process.pid}-${Date.now()}`
  assert.deepEqual(processesNaming(marker), [], 'precondition: nothing names the marker yet')
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', marker], { stdio: 'ignore' })
  const pid = child.pid as number
  try {
    await new Promise((resolve) => setTimeout(resolve, 300))
    const found = processesNaming(marker)
    console.log(`# orphan detector control: marker held by pid ${pid}, detector returned ${JSON.stringify(found)}`)
    assert.deepEqual(found, [pid])
  } finally {
    child.kill('SIGKILL') // the child THIS test spawned, by its captured handle
    await new Promise((resolve) => child.once('exit', resolve))
  }
  assert.deepEqual(processesNaming(marker), [])
})

test('IMS_SKIP_ENV_FILE=1 keeps scripts/prisma-dev-db.sh from sourcing .env over the caller DATABASE_URL (and without it, it does)', (t) => {
  const dir = mkdtempSync(join(SCRATCH_PARENT, 'ims-rehearsal-test-envfile-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'scripts'))
  mkdirSync(join(dir, 'fakebin'))
  copyFileSync(join(REPO, 'scripts/prisma-dev-db.sh'), join(dir, 'scripts/prisma-dev-db.sh'))
  writeFileSync(join(dir, '.env'), 'DATABASE_URL=postgresql://env:file@127.0.0.1:1/from_dot_env\n')
  writeFileSync(join(dir, 'fakebin/npx'), '#!/bin/sh\necho "DATABASE_URL=$DATABASE_URL"\n')
  chmodSync(join(dir, 'fakebin/npx'), 0o755)
  const callerUrl = 'postgresql://caller:pw@127.0.0.1:1/from_caller'
  const run = (skip: boolean) => execFileSync('bash', [join(dir, 'scripts/prisma-dev-db.sh'), 'status'], {
    encoding: 'utf8',
    env: { PATH: `${join(dir, 'fakebin')}:${process.env.PATH}`, DATABASE_URL: callerUrl, ...(skip ? { IMS_SKIP_ENV_FILE: '1' } : {}) } as unknown as NodeJS.ProcessEnv,
  }).trim()
  const without = run(false)
  const withSkip = run(true)
  console.log(`# without the flag: ${without}; with the flag: ${withSkip}`)
  assert.equal(without, 'DATABASE_URL=postgresql://env:file@127.0.0.1:1/from_dot_env', 'precondition: the script DOES source .env when not told otherwise')
  assert.equal(withSkip, `DATABASE_URL=${callerUrl}`)
})

test('shredFile removes a mode-600 file that holds a secret, and reports a file that is already gone as gone', (t) => {
  const dir = mkdtempSync(join(SCRATCH_PARENT, 'ims-rehearsal-test-shred-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'rehearsal.env')
  writeFileSync(file, 'DATABASE_URL=postgresql://role:secret@127.0.0.1:1/x\n', { mode: 0o600 })
  const info = statSync(file)
  assert.equal(existsSync(file), true, 'precondition: the file exists before the shred')
  assert.deepEqual(shredFile(file, { dev: info.dev, ino: info.ino }), { ok: true })
  assert.equal(existsSync(file), false)
  assert.deepEqual(shredFile(file, { dev: info.dev, ino: info.ino }), { ok: true }, 'a second shred of a missing file is a success, not an error')
})

test('shredFile refuses a symlink, a different regular file and a FIFO at the name, writes nothing, and never hangs', (t) => {
  const dir = mkdtempSync(join(SCRATCH_PARENT, 'ims-rehearsal-test-shred2-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const mine = join(dir, 'mine')
  writeFileSync(mine, 'created by the run')
  const id = { dev: statSync(mine).dev, ino: statSync(mine).ino }
  const victim = join(dir, 'victim')
  writeFileSync(victim, 'precious')
  symlinkSync(victim, join(dir, 'link'))
  assert.equal(shredFile(join(dir, 'link'), id).ok, false)
  assert.equal(shredFile(victim, id).ok, false, 'a regular file with another inode is not ours')
  execFileSync('mkfifo', [join(dir, 'fifo')])
  assert.equal(shredFile(join(dir, 'fifo'), id).ok, false, 'a FIFO is refused without blocking')
  assert.equal(shredFile(mine, null).ok, false, 'no recorded identity means nothing may be overwritten')
  console.log(`# victim after four refusals: ${JSON.stringify(readFileSync(victim, 'utf8'))}; mine: ${JSON.stringify(readFileSync(mine, 'utf8'))}`)
  assert.equal(readFileSync(victim, 'utf8'), 'precious')
  assert.equal(readFileSync(mine, 'utf8'), 'created by the run')
})

test('a RAM-backed --root is refused before anything is created', () => {
  const type = execFileSync('stat', ['-f', '-c', '%T', '/dev/shm'], { encoding: 'utf8' }).trim()
  assert.equal(type, 'tmpfs', 'precondition: /dev/shm is tmpfs on this host')
  const before = readdirSync('/dev/shm').filter((name) => name.startsWith('ims-rehearsal-'))
  return runRehearsal({ parentDir: '/dev/shm', log: () => undefined }).then((outcome) => {
    assert.equal(outcome.exitCode, REHEARSAL_EXIT.REFUSED)
    assert.equal(outcome.report, null)
    assert.match(outcome.refusal ?? '', /tmpfs/)
    assert.deepEqual(readdirSync('/dev/shm').filter((name) => name.startsWith('ims-rehearsal-')), before)
  })
})

test('an unwritable --report-dir is refused before a cluster is created', async (t) => {
  const dir = mkdtempSync(join(SCRATCH_PARENT, 'ims-rehearsal-test-reportdir-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const blocker = join(dir, 'a-file')
  writeFileSync(blocker, 'not a directory')
  const outcome = await runRehearsal({ parentDir: dir, reportDir: join(blocker, 'reports'), log: () => undefined })
  assert.equal(outcome.exitCode, REHEARSAL_EXIT.REFUSED)
  assert.match(outcome.refusal ?? '', /--report-dir .* cannot be created or written/)
  assert.deepEqual(readdirSync(dir).filter((name) => name.startsWith('ims-rehearsal-')), [], 'no run directory was created')
})

// ---------------------------------------------------------------------------------------------
// Real clusters. Each of these brings one up, runs the installer steps against it, and tears it down.
// ---------------------------------------------------------------------------------------------

const LIGHT: ReadonlySet<StepId> = new Set<StepId>(['migrate-deploy', 'seed', 'provision', 'seeded-rows', 'base-currency-unlocked', 'system-identifier', 'restore-parity'])

function scratchParent(t: TestContext): string {
  const parent = mkdtempSync(join(SCRATCH_PARENT, 'ims-rehearsal-test-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  return parent
}

function runDirsIn(parent: string): string[] {
  return readdirSync(parent).filter((name) => name.startsWith('ims-rehearsal-'))
}

function byId(steps: readonly StepResult[], id: StepId): StepResult {
  const found = steps.find((candidate) => candidate.id === id)
  assert.ok(found, `step ${id} is in the report`)
  return found
}

async function rehearse(t: TestContext, options: { only?: ReadonlySet<StepId>; hooks?: RehearsalHooks } = {}) {
  const parent = scratchParent(t)
  const outcome = await runRehearsal({ parentDir: parent, reportDir: join(parent, 'reports'), log: () => undefined, ...options })
  assert.ok(outcome.report, `the rehearsal produced a report (refusal: ${outcome.refusal})`)
  return { parent, outcome, report: outcome.report }
}

/** The teardown promises the same things after every run, green or red; asserted after every run. */
function assertTornDown(parent: string, outcome: Awaited<ReturnType<typeof rehearse>>['outcome']): void {
  assert.deepEqual(runDirsIn(parent), [], 'the run directory (cluster, dump, env file) is gone')
  assert.ok(outcome.runRoot && !existsSync(outcome.runRoot))
  assert.deepEqual(outcome.report!.teardown, { ...outcome.report!.teardown!, clusterStopped: true, envFileShredded: true, rootRemoved: true, orphanPids: [], errors: [] })
  assert.deepEqual(processesNaming(outcome.runRoot!), [], 'no process still names the run directory')
  const pid = outcome.report!.teardown!.postmasterPid as number
  assert.equal(processIsAlive(pid), false, 'the postmaster this run started is not running')
}

/**
 * EVERY STEP BUT validate-db. `npm run validate:db` ends in `prisma generate`, which rewrites the
 * generated client under app/generated in the SHARED tree while sibling test files of the same
 * `test:unit` run are importing it; inside a test that is a flake waiting for a bad moment. The step
 * stays in the catalogue and in every real run (the report sample in the PR comes from one), and the
 * property that matters about it here, that it is told not to source a checkout .env, is asserted
 * below through the env file and the prisma-dev-db.sh test above.
 */
const ALL_BUT_VALIDATE_DB: ReadonlySet<StepId> = new Set(STEP_CATALOGUE.map((s) => s.id).filter((id) => id !== 'validate-db'))

test('EVERY STEP BUT validate-db: all pass on a fresh cluster, secrets never reach argv, the report is written and the teardown is clean', { timeout: TIMEOUT }, async (t) => {
  const seen: { mode?: number; passwordInArgv?: number; scanned?: number; control?: number; skipEnvFile?: string; tmpdir?: string; dotenvPath?: string; dotenvBytes?: number } = {}
  const parent = scratchParent(t)
  const hooks: RehearsalHooks = {
    beforeStep: (id) => {
      if (id !== 'preflight-production') return
      const envFiles = readdirSync(parent).filter((n) => n.startsWith('ims-rehearsal-')).map((n) => join(parent, n, 'rehearsal.env')).filter((file) => existsSync(file))
      assert.ok(envFiles.length >= 1, 'precondition: the env file exists mid-run')
      assert.equal(envFiles.length, 1)
      const file = envFiles[0]!
      seen.mode = statSync(file).mode & 0o777
      const env = Object.fromEntries(readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]))
      seen.skipEnvFile = env.IMS_SKIP_ENV_FILE
      seen.tmpdir = env.TMPDIR
      seen.dotenvPath = env.DOTENV_CONFIG_PATH
      seen.dotenvBytes = statSync(env.DOTENV_CONFIG_PATH!).size
      const password = new URL(env.DATABASE_URL!).password
      assert.ok(password.length >= 32)
      const secrets = [password, env.AUTH_SECRET!, env.CRON_SECRET!, env.SETTINGS_ENCRYPTION_KEY!, env.DEFAULT_ADMIN_PASSWORD!]
      let scanned = 0
      let hits = 0
      for (const pid of readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
        try {
          const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
          scanned += 1
          if (secrets.some((secret) => cmdline.includes(secret))) hits += 1
        } catch { /* exited */ }
      }
      seen.scanned = scanned
      seen.passwordInArgv = hits
      // Positive control: the same scan DOES find a secret that is on a command line.
      const control = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)', password], { stdio: 'ignore' })
      let controlHits = 0
      try {
        execFileSync('sleep', ['0.3'])
        for (const pid of readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
          try { if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(password)) controlHits += 1 } catch { /* exited */ }
        }
      } finally {
        control.kill('SIGKILL')
      }
      seen.control = controlHits
    },
  }
  const outcome = await runRehearsal({ parentDir: parent, reportDir: join(parent, 'reports'), log: () => undefined, hooks, only: ALL_BUT_VALIDATE_DB })
  assert.ok(outcome.report, `the rehearsal produced a report (refusal: ${outcome.refusal})`)
  const report = outcome.report
  console.log(`# env file mode ${seen.mode?.toString(8)}; scanned ${seen.scanned} command lines, secrets found in argv: ${seen.passwordInArgv}; positive control found: ${seen.control}`)
  assert.equal(seen.mode, 0o600)
  assert.equal(seen.skipEnvFile, '1', 'the children are told not to source a checkout .env over the rehearsal DATABASE_URL')
  assert.ok(seen.dotenvPath?.startsWith(parent) && seen.dotenvBytes === 0, 'dotenv is pointed at an empty file inside the run directory, so a checkout .env cannot add variables')
  assert.ok(seen.tmpdir?.startsWith(parent), 'the children scratch space is inside the run directory, not the caller tmpfs')
  assert.ok((seen.scanned ?? 0) > 10)
  assert.ok((seen.control ?? 0) >= 1, 'the scan can find a secret that is on argv')
  assert.equal(seen.passwordInArgv, 0)

  const failed = report.steps.filter((candidate) => candidate.required && candidate.status !== 'passed')
  assert.deepEqual(failed.map((s) => `${s.id}: ${s.reason}`), [])
  assert.equal(report.verdict, 'GREEN')
  assert.equal(outcome.exitCode, REHEARSAL_EXIT.OK)
  assert.deepEqual(report.steps.map((s) => s.id), [...ALL_BUT_VALIDATE_DB], 'every selected catalogued step is in the report, in order')

  const deploy = byId(report.steps, 'migrate-deploy').detail as { migrationsOnDisk: number; migrationsApplied: number }
  const onDisk = readdirSync(join(REPO, 'prisma/migrations')).filter((n) => existsSync(join(REPO, 'prisma/migrations', n, 'migration.sql'))).length
  console.log(`# migrations on disk ${onDisk}, applied ${deploy.migrationsApplied}`)
  assert.ok(onDisk > 100)
  assert.equal(deploy.migrationsApplied, onDisk)
  const parity = byId(report.steps, 'restore-parity').detail as { tablesCompared: number; tablesWithRows: number; mismatches: number }
  console.log(`# parity: ${parity.tablesCompared} tables compared, ${parity.tablesWithRows} with rows, ${parity.mismatches} mismatches`)
  assert.ok(parity.tablesCompared > 50 && parity.tablesWithRows >= 5 && parity.mismatches === 0)
  const identifier = (byId(report.steps, 'system-identifier').detail as { systemIdentifier: string }).systemIdentifier
  assert.match(identifier, /^\d{10,}$/)
  assert.equal(report.cluster.scramVerified, true)

  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
  const outbound = byId(report.steps, 'outbound-status')
  if (outboundStatusScriptPresent(pkg.scripts)) {
    assert.equal(outbound.required, true)
    assert.equal(outbound.status, 'passed')
  } else {
    assert.equal(outbound.required, false)
    assert.equal(outbound.status, 'skipped')
    assert.match(outbound.reason ?? '', /no outbound:status script/)
  }

  const json = JSON.parse(readFileSync(outcome.reportPaths!.json, 'utf8')) as { verdict: string; exitCode: number }
  const markdown = readFileSync(outcome.reportPaths!.markdown, 'utf8')
  assert.equal(json.verdict, 'GREEN')
  assert.match(markdown, /^# Fresh-install rehearsal: GREEN/)
  for (const text of [markdown, readFileSync(outcome.reportPaths!.json, 'utf8')]) {
    assert.equal(/postgres(ql)?:\/\//.test(text), false, 'no connection URL in the report')
    assert.equal(/PGPASSWORD|AUTH_SECRET=|SETTINGS_ENCRYPTION_KEY=/.test(text), false)
  }
  assertTornDown(parent, outcome)
})

test('IDEMPOTENT RE-RUN: a second run uses a fresh cluster directory, ignores an inherited DATABASE_URL and is green again', { timeout: TIMEOUT }, async (t) => {
  const parent = scratchParent(t)
  const inherited = 'postgresql://imsdev:not-a-real-password@127.0.0.1:1/onetwo3d_ims_dev'
  const previous = process.env.DATABASE_URL
  process.env.DATABASE_URL = inherited
  try {
    const first = await runRehearsal({ parentDir: parent, reportDir: join(parent, 'reports'), only: LIGHT, log: () => undefined })
    const second = await runRehearsal({ parentDir: parent, reportDir: join(parent, 'reports'), only: LIGHT, log: () => undefined })
    for (const outcome of [first, second]) {
      assert.deepEqual(outcome.report!.steps.filter((s) => s.status !== 'passed').map((s) => `${s.id}: ${s.reason}`), [])
      assert.equal(outcome.exitCode, REHEARSAL_EXIT.OK)
      assert.ok(outcome.report!.notes.some((note) => /inherited DATABASE_URL was present and was IGNORED/.test(note)))
    }
    console.log(`# runs: ${first.report!.runId} then ${second.report!.runId}`)
    assert.notEqual(first.runRoot, second.runRoot)
    assert.notEqual(first.report!.runId, second.report!.runId)
    assert.deepEqual(runDirsIn(parent), [])
    assertTornDown(parent, second)
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previous
  }
})

test('ARM (a): a seeded non-GBP base currency makes the report RED, and only seeded-rows says so', { timeout: TIMEOUT }, async (t) => {
  const { parent, outcome, report } = await rehearse(t, {
    only: LIGHT,
    hooks: {
      afterProvision: async (client) => {
        const updated = await client.query(`update organisations set "baseCurrency" = 'EUR' where id = 'default'`)
        assert.equal(updated.rowCount, 1, 'precondition: the fault was seeded into exactly one Organisation row')
      },
    },
  })
  const seeded = byId(report.steps, 'seeded-rows')
  console.log(`# seeded-rows: ${seeded.status}: ${seeded.reason}`)
  assert.equal(seeded.status, 'failed')
  assert.match(seeded.reason ?? '', /baseCurrency is EUR, expected GBP/)
  assert.equal(report.verdict, 'RED')
  assert.equal(outcome.exitCode, REHEARSAL_EXIT.RED)
  assert.deepEqual(report.steps.filter((s) => s.status !== 'passed').map((s) => s.id), ['seeded-rows'], 'nothing else turned red: the one GBP assertion carries the arm')
  assertTornDown(parent, outcome)
})

test('ARM: master data (or the lock setting) written before the probe reads it makes isBaseCurrencyLocked() true and the report RED', { timeout: TIMEOUT }, async (t) => {
  const { parent, outcome, report } = await rehearse(t, {
    only: LIGHT,
    hooks: {
      afterProvision: async (client) => {
        await client.query(`insert into settings (key, value, "updatedAt") values ('base_currency_locked', 'true', now())`)
      },
    },
  })
  const probe = byId(report.steps, 'base-currency-unlocked')
  assert.equal(probe.status, 'failed')
  assert.equal((probe.detail as { isBaseCurrencyLocked: boolean }).isBaseCurrencyLocked, true)
  assert.equal(report.verdict, 'RED')
  assert.equal(outcome.exitCode, REHEARSAL_EXIT.RED)
  assertTornDown(parent, outcome)
})

test('ARM (b): a restore-parity mismatch (one changed row, one lost row) is detected and names both tables', { timeout: TIMEOUT }, async (t) => {
  const { parent, outcome, report } = await rehearse(t, {
    only: LIGHT,
    hooks: {
      afterRestore: async (client) => {
        const changed = await client.query(`update settings set value = 'tampered-after-restore' where key = 'public_app_url'`)
        const lost = await client.query(`delete from tax_rates where name = 'Zero Rated (0%)'`)
        assert.equal(changed.rowCount, 1, 'precondition: one settings row was changed in the restored copy')
        assert.equal(lost.rowCount, 1, 'precondition: one tax_rates row was removed from the restored copy')
      },
    },
  })
  const parity = byId(report.steps, 'restore-parity')
  console.log(`# restore-parity: ${parity.status}: ${parity.reason}`)
  assert.equal(parity.status, 'failed')
  assert.match(parity.reason ?? '', /settings: md5/)
  assert.match(parity.reason ?? '', /tax_rates: row-count/)
  assert.equal((parity.detail as { mismatches: number }).mismatches, 2)
  assert.equal(report.verdict, 'RED')
  assert.equal(outcome.exitCode, REHEARSAL_EXIT.RED)
  assertTornDown(parent, outcome)
})

test('ARM (d): a DATABASE_URL that is not the throwaway cluster, and a connector variable, are refused before a process is spawned', { timeout: TIMEOUT }, async (t) => {
  const { parent, outcome, report } = await rehearse(t, {
    only: new Set<StepId>(['migrate-deploy', 'seed', 'provision', 'preflight-production', 'invariant-preflight']),
    hooks: {
      tamperStepEnv: (id, env) => {
        if (id === 'preflight-production') env.DATABASE_URL = 'postgresql://imsdev:not-a-real-password@127.0.0.1:1/onetwo3d_ims_dev'
        if (id === 'invariant-preflight') env.SMTP_HOST = 'smtp.invalid'
      },
    },
  })
  const url = byId(report.steps, 'preflight-production')
  const smtp = byId(report.steps, 'invariant-preflight')
  console.log(`# preflight: ${url.reason}\n# invariant: ${smtp.reason}`)
  assert.equal(url.status, 'failed')
  assert.match(url.reason ?? '', /^GUARD: refusing to run against a DATABASE_URL that is not the throwaway cluster/)
  assert.equal(smtp.status, 'failed')
  assert.match(smtp.reason ?? '', /^GUARD: refusing to spawn: the environment carries SMTP_HOST/)
  // The control: the untampered steps of the same run were not refused.
  for (const id of ['migrate-deploy', 'seed', 'provision'] as StepId[]) assert.equal(byId(report.steps, id).status, 'passed')
  assert.equal(outcome.exitCode, REHEARSAL_EXIT.RED)
  assertTornDown(parent, outcome)
})

test('the captured identity is a PostgreSQL postmaster of THIS directory with the pid file\'s start time: an unrelated process that merely names the directory is not captured', async (t) => {
  const dir = mkdtempSync(join(SCRATCH_PARENT, 'ims-rehearsal-test-identity-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const dataDir = join(dir, 'data')
  mkdirSync(dataDir)
  const spawnIt = (argv0: string | undefined, args: string[]) => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', '--', ...args], { stdio: 'ignore', ...(argv0 ? { argv0 } : {}) })
  const lookalike = spawnIt('postgres', ['-D', dataDir])
  const unrelated = spawnIt(undefined, [dataDir])
  const pids = [lookalike.pid as number, unrelated.pid as number]
  try {
    await new Promise((resolve) => setTimeout(resolve, 400))
    const pidFile = (pid: number, startEpoch: number) => writeFileSync(join(dataDir, 'postmaster.pid'), `${pid}\n${dataDir}\n${startEpoch}\n5432\n`)
    const epoch = processStartEpochSeconds(pids[0]!)
    assert.ok(epoch !== null, 'precondition: the start time of a live process can be read')
    pidFile(pids[0]!, epoch)
    const identity = capturePostmaster(dataDir)
    console.log(`# postgres-named process with -D <dir> and the matching start record: ${JSON.stringify(identity)}`)
    assert.ok(identity, 'a process named postgres, started with -D <dir>, whose start time matches the pid file, is captured')
    assert.equal(postmasterIsStillOurs(identity), true)
    assert.equal(postmasterIsStillOurs({ ...identity, startTicks: `${identity.startTicks}0` }), false, 'a reused pid has another start time')
    assert.equal(postmasterIsStillOurs({ ...identity, dataDir: join(dir, 'elsewhere') }), false)
    pidFile(pids[0]!, epoch + 3600)
    assert.equal(capturePostmaster(dataDir), null, 'a pid file whose start record disagrees with the process captures nothing')
    pidFile(pids[1]!, processStartEpochSeconds(pids[1]!) as number)
    assert.equal(capturePostmaster(dataDir), null, 'a process that only names the directory (not postgres -D <dir>) captures nothing, even with a matching start record')
    writeFileSync(join(dataDir, 'postmaster.pid'), `${pids[0]}\n${join(dir, 'other')}\n${epoch}\n`)
    assert.equal(capturePostmaster(dataDir), null, 'a pid file that names another directory captures nothing')
  } finally {
    for (const child of [lookalike, unrelated]) {
      child.kill('SIGKILL')
      if (child.exitCode === null && child.signalCode === null) await new Promise((resolve) => child.once('exit', resolve))
    }
  }
})

test('ISOLATION: a caller NODE_OPTIONS / NODE_PATH / loader / proxy variable never reaches a child (unit)', () => {
  const planted = { NODE_OPTIONS: '--require /nonexistent/canary.cjs', NODE_PATH: '/nonexistent', HTTPS_PROXY: 'http://127.0.0.1:1', HTTP_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'x', LD_PRELOAD: '/nonexistent.so', LD_LIBRARY_PATH: '/nonexistent', DYLD_INSERT_LIBRARIES: 'x', npm_config_userconfig: '/nonexistent', npm_config_registry: 'http://127.0.0.1:1', BASH_ENV: '/nonexistent', DATABASE_URL: 'postgresql://x:y@127.0.0.1:1/z' }
  const previous = Object.fromEntries(Object.keys(planted).map((k) => [k, process.env[k]]))
  Object.assign(process.env, planted)
  try {
    const env = inheritedEnv('/var/tmp/ims-rehearsal-x')
    console.log(`# inherited keys with ${Object.keys(planted).length} hostile variables planted: ${Object.keys(env).sort().join(',')}`)
    assert.ok(env.PATH, 'precondition: the whitelist still carries PATH')
    assert.equal(env.HOME, '/var/tmp/ims-rehearsal-x/home', 'HOME is the run directory\'s, not the caller\'s')
    for (const key of Object.keys(planted)) assert.equal(key in env && key !== 'NODE_OPTIONS', false, key)
    assert.equal(env.NODE_OPTIONS, '--max-old-space-size=3072', 'the only NODE_OPTIONS a child gets is the rehearsal\'s own')
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
})

test('ISOLATION ARM: a canary --require in the caller NODE_OPTIONS is never executed by any rehearsal child', { timeout: TIMEOUT }, async (t) => {
  const parent = scratchParent(t)
  const marker = join(parent, 'canary-ran')
  const canary = join(parent, 'canary.cjs')
  writeFileSync(canary, `require('node:fs').appendFileSync(${JSON.stringify(marker)}, process.argv.slice(1).join(' ') + '\\n')\n`)
  const previous = process.env.NODE_OPTIONS
  process.env.NODE_OPTIONS = `--require ${canary}`
  try {
    // Positive control: the canary DOES run in a child that inherits this environment.
    execFileSync(process.execPath, ['-e', '0'], { env: process.env })
    assert.equal(existsSync(marker), true, 'precondition: the canary fires in a child that inherits NODE_OPTIONS')
    rmSync(marker)
    const outcome = await runRehearsal({ parentDir: parent, reportDir: join(parent, 'reports'), log: () => undefined, only: new Set<StepId>(['migrate-deploy', 'seed', 'provision', 'seeded-rows']) })
    assert.ok(outcome.report)
    assert.deepEqual(outcome.report.steps.filter((s) => s.status !== 'passed').map((s) => `${s.id}: ${s.reason}`), [], 'precondition: every node child (prisma, tsx, provision) ran')
    console.log(`# canary marker present after the run: ${existsSync(marker)}`)
    assert.equal(existsSync(marker), false, 'no rehearsal child executed the caller preload')
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS
    else process.env.NODE_OPTIONS = previous
  }
})

test('TEARDOWN: a cluster start that throws AFTER the postmaster forked is still stopped, by the PID read from its own data directory', { timeout: TIMEOUT }, async (t) => {
  let forkedPid = 0
  const { parent, outcome, report } = await rehearse(t, {
    only: new Set<StepId>(['system-identifier']),
    hooks: {
      clusterStarter: (root, name, port, listen) => {
        const cluster = startCluster(root, name, port, listen)
        forkedPid = Number(readFileSync(join(cluster.data, 'postmaster.pid'), 'utf8').split('\n')[0])
        throw new Error('injected: pg_ctl reported failure after the postmaster forked')
      },
    },
  })
  try {
    console.log(`# postmaster ${forkedPid} existed when the start threw; alive after the run: ${processIsAlive(forkedPid)}`)
    assert.ok(forkedPid > 0, 'precondition: the postmaster forked before the failure')
    assert.equal(processIsAlive(forkedPid), false, 'the postmaster the failed start left behind was stopped')
    assert.equal(report.teardown?.postmasterPid, forkedPid, 'the teardown knew the PID')
    assert.equal(outcome.exitCode, REHEARSAL_EXIT.RED)
    assert.deepEqual(runDirsIn(parent), [])
  } finally {
    if (forkedPid > 0 && processIsAlive(forkedPid)) process.kill(forkedPid, 'SIGKILL') // the one this test's own hook started
  }
})

test('TEARDOWN: a replacement postmaster that took over the data directory is NOT stopped, and the directory is not removed under it', { timeout: TIMEOUT }, async (t) => {
  const parent = scratchParent(t)
  const bin = pgBinDir()
  let originalPid = 0
  let replacementPid = 0
  let dataDir = ''
  const hooks: RehearsalHooks = {
    afterClusterStart: () => {
      const run = readdirSync(parent).find((name) => name.startsWith('ims-rehearsal-') && name !== 'reports')!
      dataDir = join(parent, run, 'pg', 'data')
      const lines = readFileSync(join(dataDir, 'postmaster.pid'), 'utf8').split('\n')
      originalPid = Number(lines[0])
      const port = lines[3]!
      execFileSync(join(bin, 'pg_ctl'), ['-D', dataDir, '-m', 'fast', '-w', 'stop'], { stdio: 'pipe' })
      execFileSync(join(bin, 'pg_ctl'), ['-D', dataDir, '-l', join(parent, run, 'pg2.log'), '-o', `-p ${port} -k ${join(parent, run, 'pg', 'sock')} -c listen_addresses=127.0.0.1`, '-w', 'start'], { stdio: 'pipe' })
      replacementPid = Number(readFileSync(join(dataDir, 'postmaster.pid'), 'utf8').split('\n')[0])
    },
  }
  const outcome = await runRehearsal({ parentDir: parent, reportDir: join(parent, 'reports'), log: () => undefined, hooks, only: new Set<StepId>(['system-identifier']) })
  try {
    console.log(`# original postmaster ${originalPid} replaced by ${replacementPid}; replacement alive after the run: ${processIsAlive(replacementPid)}`)
    assert.ok(originalPid > 0 && replacementPid > 0 && originalPid !== replacementPid, 'precondition: a different postmaster owns the directory')
    assert.equal(processIsAlive(replacementPid), true, 'the replacement the rehearsal did not start was left running')
    assert.equal(outcome.exitCode, REHEARSAL_EXIT.TEARDOWN_INCOMPLETE)
    assert.equal(existsSync(dataDir), true, 'the directory was not removed under a live process')
  } finally {
    if (replacementPid > 0 && processIsAlive(replacementPid)) process.kill(replacementPid, 'SIGKILL') // started by this test's own hook
  }
})

test('TEARDOWN: a postmaster replaced AFTER the first identity check and BEFORE the stop is caught by the pid-file re-check (the residual window is the few microseconds after it)', { timeout: TIMEOUT }, async (t) => {
  const parent = scratchParent(t)
  const bin = pgBinDir()
  let originalPid = 0
  let replacementPid = 0
  let dataDir = ''
  const hooks: RehearsalHooks = {
    betweenIdentityAndStop: () => {
      const run = readdirSync(parent).find((name) => name.startsWith('ims-rehearsal-') && name !== 'reports')!
      dataDir = join(parent, run, 'pg', 'data')
      const lines = readFileSync(join(dataDir, 'postmaster.pid'), 'utf8').split('\n')
      originalPid = Number(lines[0])
      execFileSync(join(bin, 'pg_ctl'), ['-D', dataDir, '-m', 'fast', '-w', 'stop'], { stdio: 'pipe' })
      execFileSync(join(bin, 'pg_ctl'), ['-D', dataDir, '-l', join(parent, run, 'pg2.log'), '-o', `-p ${lines[3]} -k ${join(parent, run, 'pg', 'sock')} -c listen_addresses=127.0.0.1`, '-w', 'start'], { stdio: 'pipe' })
      replacementPid = Number(readFileSync(join(dataDir, 'postmaster.pid'), 'utf8').split('\n')[0])
    },
  }
  const outcome = await runRehearsal({ parentDir: parent, reportDir: join(parent, 'reports'), log: () => undefined, hooks, only: new Set<StepId>(['system-identifier']) })
  try {
    console.log(`# postmaster ${originalPid} replaced by ${replacementPid} between the identity check and the stop; replacement alive after the run: ${processIsAlive(replacementPid)}`)
    assert.ok(originalPid > 0 && replacementPid > 0 && originalPid !== replacementPid, 'precondition: the replacement happened in the gap')
    assert.equal(processIsAlive(replacementPid), true, 'the replacement was not stopped')
    assert.equal(outcome.exitCode, REHEARSAL_EXIT.TEARDOWN_INCOMPLETE)
  } finally {
    if (replacementPid > 0 && processIsAlive(replacementPid)) process.kill(replacementPid, 'SIGKILL') // started by this test's own hook
  }
})

test('REPORT PUBLICATION: if the Markdown cannot be written, no artefact on disk says GREEN and every one that exists says RED', { timeout: TIMEOUT }, async (t) => {
  const parent = scratchParent(t)
  let mdAttempts = 0
  const outcome = await runRehearsal({
    parentDir: parent, reportDir: join(parent, 'reports'), log: () => undefined, only: new Set<StepId>(['system-identifier']),
    hooks: {
      writeReportFile: (file, data) => {
        if (file.includes('readiness-report.md')) {
          mdAttempts += 1
          if (mdAttempts === 1) throw new Error('injected: disk full while writing the Markdown report')
        }
        writeFileSync(file, data)
      },
    },
  })
  assert.ok(outcome.report)
  const dirs = existsSync(join(parent, 'reports')) ? readdirSync(join(parent, 'reports')) : []
  const files = dirs.flatMap((d) => readdirSync(join(parent, 'reports', d)).map((f) => join(parent, 'reports', d, f)))
  const verdicts = files.map((f) => `${f.split('/').pop()}: ${f.endsWith('.json') ? (JSON.parse(readFileSync(f, 'utf8')) as { verdict: string }).verdict : (/^# Fresh-install rehearsal: (\w+)/.exec(readFileSync(f, 'utf8'))?.[1] ?? '?')}`)
  console.log(`# every step passed: ${outcome.report.steps.every((x) => x.status === 'passed')}; artefacts on disk after the Markdown failure: ${JSON.stringify(verdicts)}; exit ${outcome.exitCode}`)
  assert.ok(outcome.report.steps.every((x) => x.status === 'passed'), 'precondition: the run itself was clean')
  assert.ok(mdAttempts >= 1, 'precondition: the Markdown write failed once')
  assert.equal(outcome.exitCode, REHEARSAL_EXIT.RED)
  assert.equal(outcome.report.verdict, 'RED')
  assert.equal(verdicts.some((v) => /GREEN/.test(v)), false, 'no artefact on disk says GREEN')
  assert.equal(files.some((f) => f.endsWith('.tmp')), false, 'no temporary file is left behind')
  if (verdicts.length > 0) assert.ok(verdicts.every((v) => /RED/.test(v)), 'every artefact that exists says RED')
})

test('REPORT PUBLICATION (isolating arm): when the Markdown can NEVER be written, the amended retry cannot save the day, and still no GREEN file is left behind', { timeout: TIMEOUT }, async (t) => {
  const parent = scratchParent(t)
  const outcome = await runRehearsal({
    parentDir: parent, reportDir: join(parent, 'reports'), log: () => undefined, only: new Set<StepId>(['system-identifier']),
    hooks: {
      writeReportFile: (file, data) => {
        if (file.includes('readiness-report.md')) throw new Error('injected: the Markdown can never be written')
        writeFileSync(file, data)
      },
    },
  })
  assert.ok(outcome.report)
  const dirs = existsSync(join(parent, 'reports')) ? readdirSync(join(parent, 'reports')) : []
  const files = dirs.flatMap((d) => readdirSync(join(parent, 'reports', d)))
  console.log(`# every step passed: ${outcome.report.steps.every((x) => x.status === 'passed')}; files left on disk: ${JSON.stringify(files)}; reportPaths: ${JSON.stringify(outcome.reportPaths ?? null)}; exit ${outcome.exitCode}`)
  assert.ok(outcome.report.steps.every((x) => x.status === 'passed'), 'precondition: the run itself was clean')
  assert.deepEqual(files, [], 'nothing is left on disk: neither a GREEN JSON nor a temporary file')
  assert.equal(outcome.reportPaths, undefined)
  assert.equal(outcome.exitCode, REHEARSAL_EXIT.RED)
  assert.equal(outcome.report.verdict, 'RED')
})

test('RECORDED PRECONDITIONS COUNT: every fact the base-currency check records can turn it RED on its own (table-driven)', () => {
  const clean = { isBaseCurrencyLocked: false, tableCounts: { products: 0, suppliers: 0, customers: 0, purchase_orders: 0, sales_orders: 0, stock_movements: 0 }, lockSettingRows: 0 }
  assert.deepEqual(assessBaseCurrencyLock(clean), { ok: true, failures: [] })
  const cases: Array<[string, typeof clean, RegExp]> = [
    ['the application says locked', { ...clean, isBaseCurrencyLocked: true }, /isBaseCurrencyLocked\(\) returned true/],
    ['a lock setting row exists although its value is false', { ...clean, lockSettingRows: 1 }, /base_currency_locked setting row/],
    ...Object.keys(clean.tableCounts).map((table): [string, typeof clean, RegExp] => [`${table} is not empty although the lock check says false`, { ...clean, tableCounts: { ...clean.tableCounts, [table]: 3 } }, new RegExp(`${table} holds 3 row`)]),
  ]
  for (const [name, facts, pattern] of cases) {
    const result = assessBaseCurrencyLock(facts)
    assert.equal(result.ok, false, name)
    assert.match(result.failures.join(' | '), pattern, name)
  }
  console.log(`# ${cases.length} single-fact failures each turned the check red`)
})

test('ARM: a lock setting row whose value is FALSE still fails the precondition, although the application says unlocked', { timeout: TIMEOUT }, async (t) => {
  const { parent, outcome, report } = await rehearse(t, {
    only: LIGHT,
    hooks: { afterProvision: async (client) => { await client.query(`insert into settings (key, value, "updatedAt") values ('base_currency_locked', 'false', now())`) } },
  })
  const probe = byId(report.steps, 'base-currency-unlocked')
  console.log(`# probe says locked=${(probe.detail as { isBaseCurrencyLocked: boolean }).isBaseCurrencyLocked}; step ${probe.status}: ${probe.reason}`)
  assert.equal((probe.detail as { isBaseCurrencyLocked: boolean }).isBaseCurrencyLocked, false, 'precondition: the application itself says unlocked')
  assert.equal(probe.status, 'failed')
  assert.equal(report.verdict, 'RED')
  assert.equal(outcome.exitCode, REHEARSAL_EXIT.RED)
  assertTornDown(parent, outcome)
})

test('REPORT FILES never follow a planted symlink: the run directory is created exclusively and temporary files are opened O_EXCL|O_NOFOLLOW', { timeout: TIMEOUT }, async (t) => {
  const parent = scratchParent(t)
  const victim = join(parent, 'victim.txt')
  writeFileSync(victim, 'precious')
  const planted: string[] = []
  const outcome = await runRehearsal({
    parentDir: parent, reportDir: join(parent, 'reports'), log: () => undefined, only: new Set<StepId>(['system-identifier']),
    hooks: {
      beforePublish: (outDir) => {
        // What an attacker who can see the run id and write to the report directory could do.
        mkdirSync(outDir, { recursive: true })
        for (const name of ['readiness-report.json.tmp', 'readiness-report.md.tmp', 'readiness-report.json', 'readiness-report.md']) {
          symlinkSync(victim, join(outDir, name))
          planted.push(name)
        }
      },
    },
  })
  assert.ok(outcome.report)
  console.log(`# planted ${planted.length} symlinks at predictable names; victim now: ${JSON.stringify(readFileSync(victim, 'utf8'))}; write error: ${outcome.reportWriteError}`)
  assert.equal(planted.length, 4, 'precondition: the symlinks were planted')
  assert.equal(readFileSync(victim, 'utf8'), 'precious', 'the file the symlinks pointed at was not written through')
  assert.equal(outcome.exitCode, REHEARSAL_EXIT.RED)
  assert.ok(outcome.reportWriteError)
})

test('writeExclusive refuses an existing file and a symlink, and creates mode 600', (t) => {
  const dir = mkdtempSync(join(SCRATCH_PARENT, 'ims-rehearsal-test-excl-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const victim = join(dir, 'victim')
  writeFileSync(victim, 'precious')
  symlinkSync(victim, join(dir, 'link'))
  assert.throws(() => writeExclusive(join(dir, 'link'), 'x'), /EEXIST|ELOOP/)
  assert.throws(() => writeExclusive(victim, 'x'), /EEXIST/)
  assert.equal(readFileSync(victim, 'utf8'), 'precious')
  writeExclusive(join(dir, 'new'), 'data')
  assert.equal(statSync(join(dir, 'new')).mode & 0o777, 0o600)
  assert.equal(readFileSync(join(dir, 'new'), 'utf8'), 'data')
})

test('REPORT PAIR: the JSON is the commit record and names its companion Markdown by sha256, so a missing or altered .md is detectable', { timeout: TIMEOUT }, async (t) => {
  const { outcome } = await rehearse(t, { only: new Set<StepId>(['system-identifier']) })
  const paths = outcome.reportPaths!
  const sound = verifyPublishedReport(paths.json)
  console.log(`# companion check on an untouched pair: ${JSON.stringify(sound)}`)
  assert.deepEqual(sound, { ok: true })
  assert.match((JSON.parse(readFileSync(paths.json, 'utf8')) as { companionMarkdownSha256: string }).companionMarkdownSha256, /^[0-9a-f]{64}$/)
  writeFileSync(paths.markdown, `${readFileSync(paths.markdown, 'utf8')}\ntampered\n`)
  assert.equal(verifyPublishedReport(paths.json).ok, false, 'an altered Markdown is detected')
  rmSync(paths.markdown)
  assert.equal(verifyPublishedReport(paths.json).ok, false, 'a missing Markdown is detected')
})

test('RECORDED BUT NOT COUNTED: the docs name exactly the detail fields that are informational, and each exists in the script', () => {
  const docs = readFileSync(join(REPO, 'docs/installation.md'), 'utf8')
  const script = readFileSync(join(REPO, 'scripts/rehearse-first-install.ts'), 'utf8')
  const informational = ['warnings', 'concurrencyTierSkippedInsideValidateDb', 'summary', 'tablesChangedSinceProvisioning']
  const sentence = /with four deliberate exceptions recorded for information only[^\n]*/.exec(docs)?.[0] ?? ''
  console.log(`# informational fields documented: ${informational.filter((k) => sentence.includes(k)).length} of ${informational.length}; in script: ${informational.filter((k) => new RegExp(`\\b${k}\\b`).test(script)).length}`)
  assert.ok(sentence.length > 0, 'precondition: the exceptions sentence exists')
  for (const key of informational) {
    assert.ok(sentence.includes(key), `${key} is documented as informational`)
    assert.ok(new RegExp(`\\b${key}\\b`).test(script), `${key} is a real detail field`)
  }
})

test('ancestorProblem: the pure predicate (root-owned sticky accepted; every other writable shape refused)', () => {
  const dir = (uid: number, mode: number, extra: Partial<{ isSymlink: boolean; isDirectory: boolean }> = {}) => ancestorProblem({ isDirectory: true, isSymlink: false, uid, mode, ...extra }, 1000)
  assert.equal(dir(0, 0o41777), null, 'a root-owned sticky 1777 directory (/tmp, /var/tmp) is accepted')
  assert.equal(dir(0, 0o40755), null)
  assert.equal(dir(1000, 0o40700), null, 'owned by the running account, not writable by others')
  assert.equal(dir(1000, 0o40775) !== null, true, 'group-writable, not sticky')
  assert.equal(dir(1000, 0o40757) !== null, true, 'other-writable, not sticky')
  assert.equal(dir(1000, 0o41777) !== null, true, 'sticky but NOT root-owned')
  assert.equal(dir(0, 0o40777) !== null, true, 'root-owned, world-writable, not sticky')
  assert.equal(dir(1234, 0o40755) !== null, true, 'owned by another account')
  assert.equal(dir(0, 0o40755, { isSymlink: true }) !== null, true, 'a symlink')
  assert.equal(dir(0, 0o100644, { isDirectory: false }) !== null, true, 'not a directory')
})

test('ANCESTORS: a group-writable, non-sticky ancestor of --root is refused with exit 2 before anything is created', { timeout: TIMEOUT }, async (t) => {
  const outer = mkdtempSync(join(SCRATCH_PARENT, 'ims-rehearsal-test-anc-'))
  t.after(() => rmSync(outer, { recursive: true, force: true }))
  chmodSync(outer, 0o775)
  const root = join(outer, 'work')
  mkdirSync(root, { mode: 0o700 })
  const reports = mkdtempSync(join(SCRATCH_PARENT, 'ims-rehearsal-test-rep-'))
  t.after(() => rmSync(reports, { recursive: true, force: true }))
  const outcome = await runRehearsal({ parentDir: root, reportDir: reports, log: () => undefined, only: new Set<StepId>() })
  console.log(`# --root under a 0775 ancestor: exit ${outcome.exitCode}; refusal: ${outcome.refusal}; run dirs created: ${JSON.stringify(readdirSync(root))}`)
  assert.equal(outcome.exitCode, REHEARSAL_EXIT.REFUSED)
  assert.match(outcome.refusal ?? '', /--root .*writable by group or others/)
  assert.deepEqual(readdirSync(root), [])
})

test('ANCESTORS: a group-writable, non-sticky ancestor of --report-dir is refused with exit 2 before anything is created', { timeout: TIMEOUT }, async (t) => {
  const outer = mkdtempSync(join(SCRATCH_PARENT, 'ims-rehearsal-test-anc-'))
  t.after(() => rmSync(outer, { recursive: true, force: true }))
  chmodSync(outer, 0o775)
  const root = mkdtempSync(join(SCRATCH_PARENT, 'ims-rehearsal-test-work-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const outcome = await runRehearsal({ parentDir: root, reportDir: join(outer, 'reports'), log: () => undefined, only: new Set<StepId>() })
  console.log(`# --report-dir under a 0775 ancestor: exit ${outcome.exitCode}; refusal: ${outcome.refusal}; run dirs created: ${JSON.stringify(readdirSync(root))}`)
  assert.equal(outcome.exitCode, REHEARSAL_EXIT.REFUSED)
  assert.match(outcome.refusal ?? '', /--report-dir .*writable by group or others/)
  assert.deepEqual(readdirSync(root), [])
})

for (const mode of ['symlink', 'different file'] as const) {
  test(`SHRED never follows a path blindly: the env file replaced by a ${mode} before the teardown is not overwritten, and the teardown says so (exit 3)`, { timeout: TIMEOUT }, async (t) => {
    const parent = scratchParent(t)
    const victim = join(parent, 'victim.txt')
    writeFileSync(victim, 'precious')
    let envFile = ''
    const outcome = await runRehearsal({
      parentDir: parent, reportDir: join(parent, 'reports'), log: () => undefined, only: new Set<StepId>(['system-identifier']),
      hooks: {
        betweenIdentityAndStop: () => {
          const run = readdirSync(parent).find((name) => name.startsWith('ims-rehearsal-') && name !== 'reports')!
          envFile = join(parent, run, 'rehearsal.env')
          rmSync(envFile)
          if (mode === 'symlink') symlinkSync(victim, envFile)
          else writeFileSync(envFile, 'decoy contents')
        },
      },
    })
    assert.ok(outcome.report)
    const decoy = mode === 'symlink' ? readFileSync(victim, 'utf8') : (existsSync(envFile) ? readFileSync(envFile, 'utf8') : '(removed with the run directory)')
    console.log(`# env file replaced by a ${mode}; victim now ${JSON.stringify(readFileSync(victim, 'utf8'))}; decoy now ${JSON.stringify(decoy)}; envFileShredded=${outcome.report.teardown?.envFileShredded}; exit ${outcome.exitCode}; errors ${JSON.stringify(outcome.report.teardown?.errors)}`)
    assert.ok(envFile.length > 0, 'precondition: the replacement happened')
    assert.equal(readFileSync(victim, 'utf8'), 'precious', 'the symlink target was not overwritten')
    if (mode === 'different file') assert.equal(decoy, 'decoy contents', 'the decoy was not truncated or overwritten with random bytes')
    assert.equal(outcome.report.teardown?.envFileShredded, false)
    assert.match((outcome.report.teardown?.errors ?? []).join(' '), /env file/)
    assert.equal(outcome.exitCode, REHEARSAL_EXIT.TEARDOWN_INCOMPLETE)
  })
}

test('REPORT DIRECTORY identity: swapping the validated --report-dir for another directory is detected, nothing is published into it, and the run is RED', { timeout: TIMEOUT }, async (t) => {
  const parent = scratchParent(t)
  const reportDir = join(parent, 'reports')
  let swappedInto = ''
  const outcome = await runRehearsal({
    parentDir: parent, reportDir, log: () => undefined, only: new Set<StepId>(['system-identifier']),
    hooks: {
      beforePublish: () => {
        renameSync(reportDir, join(parent, 'reports-moved'))
        mkdirSync(reportDir, { mode: 0o700 })
        swappedInto = reportDir
      },
    },
  })
  assert.ok(outcome.report)
  const inSwapped = readdirSync(swappedInto).flatMap((d) => readdirSync(join(swappedInto, d)))
  console.log(`# every step passed: ${outcome.report.steps.every((x) => x.status === 'passed')}; files published into the swapped directory: ${JSON.stringify(inSwapped)}; paths returned: ${JSON.stringify(outcome.reportPaths ?? null)}; exit ${outcome.exitCode}; error: ${outcome.reportWriteError}`)
  assert.ok(outcome.report.steps.every((x) => x.status === 'passed'), 'precondition: the run itself was clean')
  assert.ok(swappedInto.length > 0, 'precondition: the directory was swapped')
  assert.deepEqual(inSwapped, [], 'nothing was published into the swapped directory')
  assert.equal(outcome.reportPaths, undefined)
  assert.equal(outcome.exitCode, REHEARSAL_EXIT.RED)
  assert.equal(outcome.report.verdict, 'RED')
})

test('INTERRUPTION during the last, asynchronous step (no child to kill) still makes the report RED', { timeout: TIMEOUT }, async (t) => {
  const before = new Set(process.listeners('SIGTERM'))
  const outcome = await rehearse(t, {
    only: LIGHT,
    hooks: {
      afterRestore: async () => {
        const mine = process.listeners('SIGTERM').filter((l) => !before.has(l))
        assert.equal(mine.length, 1, 'precondition: the rehearsal installed exactly one SIGTERM handler')
        ;(mine[0] as (signal: string) => void)('SIGTERM')
      },
    },
  })
  const { report } = outcome
  console.log(`# every step passed: ${report.steps.every((x) => x.status === 'passed')}; notes: ${JSON.stringify(report.notes)}; verdict ${report.verdict}; exit ${outcome.outcome.exitCode}`)
  assert.ok(report.steps.every((x) => x.status === 'passed'), 'precondition: the final step completed although the signal arrived during it')
  assert.ok(report.notes.some((note) => /interrupted by SIGTERM/.test(note)))
  assert.equal(report.verdict, 'RED')
  assert.equal(outcome.outcome.exitCode, REHEARSAL_EXIT.RED)
  assert.equal(report.exitCode, REHEARSAL_EXIT.RED)
})

test('ISOLATION ARM: a hostile user npm configuration in the caller HOME is never read by a rehearsal child', { timeout: TIMEOUT }, async (t) => {
  const parent = scratchParent(t)
  const marker = join(parent, 'script-shell-ran')
  const shell = join(parent, 'canary-shell.sh')
  writeFileSync(shell, `#!/bin/sh\necho ran >> ${marker}\nexec /bin/sh "$@"\n`)
  chmodSync(shell, 0o755)
  const hostileHome = join(parent, 'hostile-home')
  mkdirSync(hostileHome)
  writeFileSync(join(hostileHome, '.npmrc'), `script-shell=${shell}\n`)
  const previous = process.env.HOME
  process.env.HOME = hostileHome
  try {
    const probe = join(parent, 'probe')
    mkdirSync(probe)
    writeFileSync(join(probe, 'package.json'), JSON.stringify({ name: 'probe', version: '1.0.0', scripts: { x: 'true' } }))
    execFileSync('npm', ['run', 'x'], { cwd: probe, env: { PATH: process.env.PATH, HOME: hostileHome } as unknown as NodeJS.ProcessEnv, stdio: 'pipe' })
    assert.equal(existsSync(marker), true, 'precondition: the hostile .npmrc DOES make npm run the canary shell when HOME is inherited')
    rmSync(marker)
    const outcome = await runRehearsal({ parentDir: parent, reportDir: join(parent, 'reports'), log: () => undefined, only: new Set<StepId>(['migrate-deploy', 'seed', 'provision', 'invariant-preflight']) })
    assert.ok(outcome.report)
    assert.deepEqual(outcome.report.steps.filter((x) => x.status !== 'passed').map((x) => `${x.id}: ${x.reason}`), [], 'precondition: the `npm run` step ran')
    console.log(`# canary shell marker present after the run: ${existsSync(marker)}`)
    assert.equal(existsSync(marker), false)
  } finally {
    if (previous === undefined) delete process.env.HOME
    else process.env.HOME = previous
  }
})

test('INTERRUPTION: SIGTERM mid-run still produces a RED report with a teardown record and exit 1', { timeout: TIMEOUT }, async (t) => {
  const parent = scratchParent(t)
  // `node --import tsx`, not the `tsx` launcher: the launcher is a second process that relays signals
  // and can exit before the script has finished its teardown, which would make this a race.
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/rehearse-first-install.ts', '--root', parent, '--report-dir', join(parent, 'reports')], {
    cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: process.env.HOME } as unknown as NodeJS.ProcessEnv,
  })
  let stderr = ''
  let stdout = ''
  child.stderr!.on('data', (c: Buffer) => { stderr += c.toString() })
  child.stdout!.on('data', (c: Buffer) => { stdout += c.toString() })
  const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)))
  try {
    const began = Date.now()
    while (!stderr.includes('cluster up') && Date.now() - began < 120_000) await new Promise((resolve) => setTimeout(resolve, 100))
    assert.ok(stderr.includes('cluster up'), 'precondition: the run was in flight (cluster up) when the signal was sent')
    await new Promise((resolve) => setTimeout(resolve, 1500))
    process.kill(child.pid as number, 'SIGTERM')
    const code = await exited
    console.log(`# exit code after SIGTERM: ${code}`)
    const dirs = readdirSync(join(parent, 'reports'))
    assert.equal(dirs.length, 1, 'a report was written')
    const report = JSON.parse(readFileSync(join(parent, 'reports', dirs[0]!, 'readiness-report.json'), 'utf8')) as { verdict: string; exitCode: number; notes: string[]; teardown: { rootRemoved: boolean; orphanPids: number[] } }
    assert.equal(code, REHEARSAL_EXIT.RED)
    assert.equal(report.verdict, 'RED')
    assert.equal(report.exitCode, REHEARSAL_EXIT.RED)
    assert.ok(report.notes.some((note) => /interrupted by SIGTERM/.test(note)))
    assert.equal(report.teardown.rootRemoved, true)
    assert.deepEqual(report.teardown.orphanPids, [])
    assert.deepEqual(runDirsIn(parent), [])
    assert.match(stdout, /Fresh-install rehearsal: RED/)
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') // the process this test spawned
  }
})

test('REPORT WRITE FAILURE: the report that is printed and returned says RED, with the real exit code and the write error', { timeout: TIMEOUT }, async (t) => {
  const parent = scratchParent(t)
  const reportDir = join(parent, 'reports')
  const outcome = await runRehearsal({
    parentDir: parent, reportDir, log: () => undefined, only: new Set<StepId>(['system-identifier']),
    hooks: { afterClusterStart: () => chmodSync(reportDir, 0o500) },
  })
  t.after(() => { try { chmodSync(reportDir, 0o700) } catch { /* already removed with the parent */ } })
  assert.ok(outcome.report)
  console.log(`# every step passed: ${outcome.report.steps.every((x) => x.status === 'passed')}; write error: ${outcome.reportWriteError}; report verdict: ${outcome.report.verdict}; outcome exit ${outcome.exitCode}`)
  assert.ok(outcome.report.steps.every((x) => x.status === 'passed'), 'precondition: the run itself was clean')
  assert.ok(outcome.reportWriteError, 'precondition: the report write failed')
  assert.equal(outcome.exitCode, REHEARSAL_EXIT.RED)
  assert.equal(outcome.report.verdict, 'RED')
  assert.equal(outcome.report.exitCode, outcome.exitCode)
  assert.ok(outcome.report.notes.some((note) => /report could not be written/.test(note)))
})

test('ARM (e): a step that throws is a failed step, later steps still run, and the teardown still happens', { timeout: TIMEOUT }, async (t) => {
  const { parent, outcome, report } = await rehearse(t, {
    only: LIGHT,
    hooks: {
      beforeStep: (id) => {
        if (id === 'system-identifier') throw new Error('injected failure in a step')
      },
    },
  })
  const thrown = byId(report.steps, 'system-identifier')
  assert.equal(thrown.status, 'failed')
  assert.match(thrown.reason ?? '', /^threw: injected failure in a step/)
  assert.equal(byId(report.steps, 'restore-parity').status, 'passed', 'a later, independent step still ran')
  assert.equal(outcome.exitCode, REHEARSAL_EXIT.RED)
  assertTornDown(parent, outcome)
})

test('ARM (e): an abort before any step is RED (not green), every step is reported as not run, and the teardown still happens', { timeout: TIMEOUT }, async (t) => {
  const { parent, outcome, report } = await rehearse(t, {
    hooks: {
      afterClusterStart: () => {
        throw new Error('injected abort after the cluster started')
      },
    },
  })
  assert.equal(report.verdict, 'RED')
  assert.equal(outcome.exitCode, REHEARSAL_EXIT.RED)
  assert.deepEqual(report.steps.map((s) => s.id), STEP_CATALOGUE.map((s) => s.id))
  assert.ok(report.steps.every((s) => s.status === 'skipped' && /injected abort/.test(s.reason ?? '')))
  assert.ok(report.notes.some((note) => /aborted/.test(note)))
  assertTornDown(parent, outcome)
})
