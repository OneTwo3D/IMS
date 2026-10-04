import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { type TestContext, test } from 'node:test'

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
  assessParity,
  assessSeededRows,
  compareParity,
  isRed,
  outboundStatusScriptPresent,
  redactSecrets,
  rehearsalExitCode,
  type SeededRowFacts,
} from '@/lib/ops/first-install-rehearsal'
import { parseArgs, processIsAlive, processesNaming, runRehearsal, shredFile, type RehearsalHooks } from '@/scripts/rehearse-first-install'

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

  assert.equal(assessOutboundStatus({ exitCode: 0, stdout: 'woocommerce: held\nmintsoft: held\nxero: held\n' }).ok, true)
  assert.equal(assessOutboundStatus({ exitCode: 1, stdout: 'woocommerce: held\n' }).ok, false, 'a non-zero exit is red')
  assert.equal(assessOutboundStatus({ exitCode: 0, stdout: 'nothing to report\n' }).ok, false, 'no `held` anywhere is red')
  const open = assessOutboundStatus({ exitCode: 0, stdout: 'woocommerce: held\nmintsoft: granted\n' })
  assert.equal(open.ok, false, 'a connector reporting itself granted is red')
  assert.match(open.failures.join(' '), /mintsoft: granted/)
  assert.equal(assessOutboundStatus({ exitCode: 0, stdout: 'woocommerce: held\nxero: not granted\n' }).ok, true, '"not granted" is held')
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
  assert.equal(existsSync(file), true, 'precondition: the file exists before the shred')
  assert.equal(shredFile(file), true)
  assert.equal(existsSync(file), false)
  assert.equal(shredFile(file), true, 'a second shred of a missing file is a success, not an error')
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

test('FULL REHEARSAL: every step passes on a fresh cluster, secrets never reach argv, the report is written and the teardown is clean', { timeout: TIMEOUT }, async (t) => {
  const seen: { mode?: number; passwordInArgv?: number; scanned?: number; control?: number; skipEnvFile?: string; tmpdir?: string } = {}
  const parent = scratchParent(t)
  const hooks: RehearsalHooks = {
    beforeStep: (id) => {
      if (id !== 'validate-db') return
      const envFiles = readdirSync(parent).filter((n) => n.startsWith('ims-rehearsal-')).map((n) => join(parent, n, 'rehearsal.env')).filter((file) => existsSync(file))
      assert.ok(envFiles.length >= 1, 'precondition: the env file exists mid-run')
      assert.equal(envFiles.length, 1)
      const file = envFiles[0]!
      seen.mode = statSync(file).mode & 0o777
      const env = Object.fromEntries(readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]))
      seen.skipEnvFile = env.IMS_SKIP_ENV_FILE
      seen.tmpdir = env.TMPDIR
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
  const outcome = await runRehearsal({ parentDir: parent, reportDir: join(parent, 'reports'), log: () => undefined, hooks })
  assert.ok(outcome.report, `the rehearsal produced a report (refusal: ${outcome.refusal})`)
  const report = outcome.report
  console.log(`# env file mode ${seen.mode?.toString(8)}; scanned ${seen.scanned} command lines, secrets found in argv: ${seen.passwordInArgv}; positive control found: ${seen.control}`)
  assert.equal(seen.mode, 0o600)
  assert.equal(seen.skipEnvFile, '1', 'the children are told not to source a checkout .env over the rehearsal DATABASE_URL')
  assert.ok(seen.tmpdir?.startsWith(parent), 'the children scratch space is inside the run directory, not the caller tmpfs')
  assert.ok((seen.scanned ?? 0) > 10)
  assert.ok((seen.control ?? 0) >= 1, 'the scan can find a secret that is on argv')
  assert.equal(seen.passwordInArgv, 0)

  const failed = report.steps.filter((candidate) => candidate.required && candidate.status !== 'passed')
  assert.deepEqual(failed.map((s) => `${s.id}: ${s.reason}`), [])
  assert.equal(report.verdict, 'GREEN')
  assert.equal(outcome.exitCode, REHEARSAL_EXIT.OK)
  assert.deepEqual(report.steps.map((s) => s.id), STEP_CATALOGUE.map((s) => s.id), 'every catalogued step is in the report, in order')

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
