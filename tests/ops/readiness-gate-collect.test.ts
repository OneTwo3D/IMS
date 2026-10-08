import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'

import { chmodSync } from 'node:fs'
import { verifyPublishedReport } from '../../lib/ops/published-report.ts'
import {
  assessCheckConstraints,
  CHILD_ENV_FIXED,
  CHILD_ENV_WHITELIST,
  assessReconciliationReadiness,
  buildChildEnv,
  collectGateResults,
  type ConstraintRow,
  readNewestRehearsal,
  type ChildSpec,
  type GateDeps,
} from '../../lib/ops/readiness-gate-collect.ts'
import { FORBIDDEN_ENV_PATTERNS } from '../../lib/ops/first-install-rehearsal.ts'
import { normaliseConstraintDefinition, READ_SYNC_STATUS_SCRIPT, REQUIRED_CHECK_CONSTRAINTS, REQUIRED_READ_SYNC_STREAMS, SCHEMA_STATE_SCRIPTS } from '../../lib/ops/readiness-gate-constants.ts'
import { decideVerdict } from '../../lib/ops/readiness-gate.ts'
import type { AccountingReconciliationReadiness } from '../../lib/ops/rollout-readiness.ts'
import { ALL_CONSTRAINTS, DAY, PG_RENDERED, constraintRows, GATE_BUILD, NOW, NO_ACCEPTANCES, cleanInvariant, cleanOutbound, greenRehearsal } from '../helpers/readiness-gate-fixtures.ts'

/**
 * COLLECTION: every dependency failing is `unreadable`, never silence; the child environment is a
 * whitelist; the newest rehearsal is judged on its own; and no code path of the gate writes to the database.
 */

const ROOT = process.cwd()

// Rehearsal report locations must pass the gate's trust policy, and the unit runner's private TMPDIR is
// group/other-writable, so these live under /var/tmp (root-owned, sticky, on disk) and are removed afterwards.
const bases: string[] = []
function scratchBase(prefix: string): string {
  const dir = mkdtempSync(path.join('/var/tmp', prefix))
  bases.push(dir)
  return dir
}
after(() => { for (const dir of bases) rmSync(dir, { recursive: true, force: true }) })

function goodReconciliation(overrides: Partial<AccountingReconciliationReadiness> = {}): AccountingReconciliationReadiness {
  return {
    latest: { id: 'run-1', status: 'COMPLETED', totalCount: 0, warningCount: 0, criticalCount: 0, createdAt: NOW.toISOString() },
    proof: { state: 'proven' },
    blockers: [],
    warnings: [],
    ...overrides,
  }
}

function deps(overrides: Partial<GateDeps> = {}, scripts: Record<string, string> = {}): GateDeps & { spawned: ChildSpec[] } {
  const spawned: ChildSpec[] = []
  return {
    spawned,
    now: () => NOW,
    runInvariant: async () => cleanInvariant(),
    readOutbound: async () => cleanOutbound(),
    readReconciliation: async () => goodReconciliation(),
    runScript: async (spec) => { spawned.push(spec); return { exitCode: 0, stdout: 'SKIPPED: npm run test:concurrency', stderr: '', timedOut: false } },
    readPackageScripts: () => scripts,
    readBuildIdentity: () => GATE_BUILD,
    readInstalledConstraints: ALL_CONSTRAINTS,
    readNewestRehearsal: () => ({ digest: { ok: true }, parsed: greenRehearsal(), location: '/r/readiness-report.json' }),
    env: { PATH: '/usr/bin', HOME: '/home/x', DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/db', SMTP_PASSWORD: 'secret', WC_WRITEBACK_ALLOWED_ORIGIN: 'https://shop.example', MINTSOFT_API_KEY: 'k', NODE_OPTIONS: '--require /evil.js', IMS_CONCURRENCY_SCRATCH_DB: 'x' },
    repoRoot: ROOT,
    ...overrides,
  }
}

const OPTIONS = { phase: 'P0' as const, expectGranted: null, rehearsalDir: '/r' }

test('with healthy dependencies the collection yields a GO on this tree (the control for the arms below)', async () => {
  const d = deps()
  const { results } = await collectGateResults(OPTIONS, d)
  const verdict = decideVerdict({ phase: 'P0', results, acceptances: NO_ACCEPTANCES, now: NOW })
  assert.equal(verdict.verdict, 'GO', verdict.blockingReasons.join('; '))
  assert.deepEqual(d.spawned.map((spec) => spec.script), [...SCHEMA_STATE_SCRIPTS], 'only the read-only schema scripts are spawned when there is no read-sync script')
  assert.equal(d.spawned.some((spec) => spec.script === 'validate:db' || /generate/.test(spec.script)), false, 'validate:db and any generate script are never run')
  assert.equal(Object.keys(results).length, 21)
})

test('every dependency that throws, rejects or returns garbage becomes NO-GO, never a pass [mutation: unreadable treated as empty]', async () => {
  const boom = async () => { throw new Error('connection refused') }
  const cases: Array<[string, Partial<GateDeps>, string]> = [
    ['invariant throws', { runInvariant: boom }, 'invariant-preflight'],
    ['outbound throws', { readOutbound: boom }, 'outbound-status'],
    ['reconciliation throws', { readReconciliation: boom }, 'reconciliation-completeness'],
    ['a schema script cannot start', { runScript: async () => ({ exitCode: null, stdout: '', stderr: 'ENOENT', timedOut: false }) }, 'schema-state'],
    ['a schema script times out', { runScript: async () => ({ exitCode: null, stdout: '', stderr: '', timedOut: true }) }, 'schema-state'],
    ['a schema script reports drift (exit 1)', { runScript: async () => ({ exitCode: 1, stdout: 'drift', stderr: '', timedOut: false }) }, 'schema-state'],
    ['a CHECK constraint is not installed', { readInstalledConstraints: async () => constraintRows().slice(1) }, 'schema-state'],
    ['the constraint catalogue cannot be read', { readInstalledConstraints: async () => { throw new Error('permission denied') } }, 'schema-state'],
    ['rehearsal dir unreadable', { readNewestRehearsal: () => { throw new Error('EACCES') } }, 'first-install-rehearsal'],
    ['no rehearsal', { readNewestRehearsal: () => ({ none: 'no rehearsal report was found' }) }, 'first-install-rehearsal'],
    ['package.json unreadable', { readPackageScripts: () => { throw new Error('ENOENT') } }, 'read-sync-liveness'],
    ['outbound activity log unreadable', { readOutbound: async () => cleanOutbound({ countsAvailable: false }) }, 'outbound-status'],
  ]
  for (const [label, override, id] of cases) {
    const { results } = await collectGateResults(OPTIONS, deps(override))
    const verdict = decideVerdict({ phase: 'P0', results, acceptances: NO_ACCEPTANCES, now: NOW })
    assert.equal(verdict.verdict, 'NO-GO', label)
    assert.ok(verdict.blockingReasons.some((reason) => reason.startsWith(`${id}:`)), `${label}: blocked by ${id}`)
    assert.notEqual(results[id]!.kind, 'pass', label)
  }
  console.log(`precondition: ${cases.length} failing dependencies examined`)
})

test('an unreadable invariant report also makes R3, R4 and R15 unreadable (they are read from it)', async () => {
  const { results } = await collectGateResults(OPTIONS, deps({ runInvariant: async () => { throw new Error('x') } }))
  for (const id of ['pack-R3', 'pack-R4', 'pack-R15']) assert.equal(results[id]!.kind, 'unreadable', id)
})

test('read-sync liveness is optional until the script exists, then required and strictly read', async () => {
  const absent = deps()
  assert.equal((await collectGateResults(OPTIONS, absent)).results['read-sync-liveness']!.kind, 'not-available')
  const entry = (stream: string, over: object = {}) => ({ stream, instance: null, state: 'fresh', lastSuccessAt: '2026-10-08T11:00:00.000Z', ageMs: 3600000, maxAgeMs: 259200000, futureTimestamp: false, ...over })
  const stdout = JSON.stringify({ schemaVersion: 1, generatedAt: NOW.toISOString(), counts: { fresh: 6, stale: 0, never: 0, off: 0 }, entries: REQUIRED_READ_SYNC_STREAMS.map((name) => entry(name)), scheduler: { examined: true, unreadable: null, blockProblem: null, unscheduled: [], disabled: [] } })
  const present = deps({}, { [READ_SYNC_STATUS_SCRIPT]: 'tsx scripts/read-sync-status.ts' })
  present.runScript = async (spec) => { present.spawned.push(spec); return { exitCode: 0, stdout: spec.script === READ_SYNC_STATUS_SCRIPT ? stdout : '', stderr: '', timedOut: false } }
  assert.equal((await collectGateResults(OPTIONS, present)).results['read-sync-liveness']!.kind, 'pass')
  const stale = deps({ runScript: async (spec) => ({ exitCode: 0, stdout: spec.script === READ_SYNC_STATUS_SCRIPT ? JSON.stringify({ schemaVersion: 1, generatedAt: NOW.toISOString(), counts: { fresh: 0, stale: 6, never: 0, off: 0 }, entries: REQUIRED_READ_SYNC_STREAMS.map((name) => entry(name, { state: 'stale' })), scheduler: { examined: true, unreadable: null, blockProblem: null, unscheduled: [], disabled: [] } }) : '', stderr: '', timedOut: false }) }, { [READ_SYNC_STATUS_SCRIPT]: 'x' })
  assert.equal((await collectGateResults(OPTIONS, stale)).results['read-sync-liveness']!.kind, 'fail')
  const spawnedPresent = present.spawned.map((spec) => `${spec.script}:${spec.silent}`)
  assert.deepEqual(spawnedPresent, [...SCHEMA_STATE_SCRIPTS.map((name) => `${name}:false`), `${READ_SYNC_STATUS_SCRIPT}:true`])
  assert.deepEqual(present.spawned[3]!.args, ['--json'], 'the status script is asked for its JSON form')
})

test('children get a whitelisted environment: no credential, no grant, no SMTP, no NODE_OPTIONS, no scratch-DB switch', async () => {
  const d = deps()
  await collectGateResults(OPTIONS, d)
  const env = d.spawned[0]!.env
  assert.deepEqual(Object.keys(env).sort(), [...new Set(['DATABASE_URL', 'HOME', 'PATH', ...Object.keys(CHILD_ENV_FIXED)])].sort())
  assert.equal(env.DATABASE_URL, 'postgresql://u:p@127.0.0.1:5432/db')
  assert.equal(env.IMS_SKIP_ENV_FILE, '1')
  for (const name of Object.keys(env)) assert.ok(!FORBIDDEN_ENV_PATTERNS.some((pattern) => pattern.test(name)), `${name} is a forbidden child env name`)
  for (const absent of ['SMTP_PASSWORD', 'WC_WRITEBACK_ALLOWED_ORIGIN', 'MINTSOFT_API_KEY', 'NODE_OPTIONS', 'IMS_CONCURRENCY_SCRATCH_DB']) assert.equal(absent in env, false, absent)
  // The whitelist itself carries no forbidden name (universal over the list).
  for (const name of CHILD_ENV_WHITELIST) assert.ok(!FORBIDDEN_ENV_PATTERNS.some((pattern) => pattern.test(name)) || name === 'DATABASE_URL', name)
  assert.equal(Object.keys(buildChildEnv({ PATH: '', HOME: undefined })).includes('PATH'), false, 'an empty value is not passed on')
  // No secret on a command line: the spec carries only a fixed script name.
  assert.deepEqual(Object.keys(d.spawned[0]!).sort(), ['cwd', 'env', 'script', 'silent', 'timeoutMs'], 'no argument carries anything but fixed words')
  assert.equal(/postgres/.test(d.spawned[0]!.script), false)
})

// ---------------------------------------------------------------------------------------------
// Reconciliation completeness.
// ---------------------------------------------------------------------------------------------

test('reconciliation: proven passes; every unproven or unreadable shape fails; "no run" is never empty-and-fine [mutation: no run treated as clean]', () => {
  assert.equal(assessReconciliationReadiness(goodReconciliation()).kind, 'pass')
  const unresolved = { runId: 'old', createdAt: '', fromDate: null, toDate: null, code: 'reconciliation_row_cap_reached' }
  const cases: Array<[string, AccountingReconciliationReadiness]> = [
    ['no run at all', goodReconciliation({ latest: null, proof: null, warnings: [{ id: 'accounting-reconciliation:missing', severity: 'warning', source: 's', message: 'No accounting reconciliation run found.' }] })],
    ['no run and the missing warning absent', goodReconciliation({ latest: null, proof: null })],
    ['latest read failed', goodReconciliation({ latest: null, proof: null, blockers: [{ id: 'readiness-adapter:accounting-reconciliation', severity: 'blocker', source: 's', message: 'failed' }] })],
    ['proof not evaluated', goodReconciliation({ proof: null })],
    ['partial run', goodReconciliation({ warnings: [{ id: 'accounting-reconciliation:partial', severity: 'warning', source: 's', message: 'partial' }] })],
    ['unresolved truncation (blocker raised)', goodReconciliation({ proof: { state: 'not-proven', unresolved: [unresolved], overflow: false, newest: 'complete', notRecordedAfterRecording: false }, blockers: [{ id: 'accounting-reconciliation:truncation-unresolved', severity: 'blocker', source: 's', message: 'x' }] })],
    ['unresolved truncation (NO blocker raised: the proof alone must stop it)', goodReconciliation({ proof: { state: 'not-proven', unresolved: [unresolved], overflow: false, newest: 'complete', notRecordedAfterRecording: false } })],
    ['newest run truncated', goodReconciliation({ proof: { state: 'not-proven', unresolved: [], overflow: false, newest: 'truncated', notRecordedAfterRecording: false } })],
    ['newest run unreadable', goodReconciliation({ proof: { state: 'not-proven', unresolved: [], overflow: false, newest: 'unreadable', notRecordedAfterRecording: false } })],
    ['history overflow', goodReconciliation({ proof: { state: 'not-proven', unresolved: [], overflow: true, newest: 'complete', notRecordedAfterRecording: false } })],
    ['not recorded after recording began', goodReconciliation({ proof: { state: 'not-proven', unresolved: [], overflow: false, newest: 'not-recorded', notRecordedAfterRecording: true } })],
    ['failed run', goodReconciliation({ blockers: [{ id: 'accounting-reconciliation:failed', severity: 'blocker', source: 's', message: 'failed' }] })],
  ]
  for (const [label, readiness] of cases) assert.equal(assessReconciliationReadiness(readiness).kind, 'fail', label)
  console.log(`precondition: ${cases.length} unproven shapes examined`)
})

test('reconciliation: the newest run predating completeness recording is a WARNING (not a failure) that needs written acceptance', () => {
  const readiness = goodReconciliation({
    proof: { state: 'not-proven', unresolved: [], overflow: false, newest: 'not-recorded', notRecordedAfterRecording: false },
    warnings: [{ id: 'accounting-reconciliation:completeness-not-recorded', severity: 'warning', source: 's', message: 'predates recording' }],
  })
  const result = assessReconciliationReadiness(readiness)
  assert.equal(result.kind, 'pass')
  assert.deepEqual(result.kind === 'pass' ? result.warnings?.map((w) => w.id) : null, ['accounting-reconciliation:completeness-not-recorded'])
  const verdict = decideVerdict({ phase: 'P0', results: { ...{}, 'reconciliation-completeness': result }, acceptances: NO_ACCEPTANCES, now: NOW })
  assert.equal(verdict.rows.find((row) => row.id === 'reconciliation-completeness')!.status, 'PASS')
  assert.equal(verdict.warnings.length, 1)
  assert.equal(verdict.warnings[0]!.disposition.accepted, false)
})

// ---------------------------------------------------------------------------------------------
// The newest rehearsal on disk.
// ---------------------------------------------------------------------------------------------

function publish(dir: string, name: string, report: object, mtimeSeconds?: number, markdown = '# report\n'): string {
  const sub = path.join(dir, name)
  mkdirSync(sub, { recursive: true })
  writeFileSync(path.join(sub, 'readiness-report.md'), markdown)
  const json = path.join(sub, 'readiness-report.json')
  writeFileSync(json, JSON.stringify({ ...report, companionMarkdownSha256: createHash('sha256').update(markdown).digest('hex') }))
  if (mtimeSeconds !== undefined) utimesSync(json, mtimeSeconds, mtimeSeconds)
  return json
}

test('the NEWEST rehearsal decides: a newer RED, corrupt or digest-failing report is never replaced by an older GREEN one', () => {
  const dir = scratchBase('ims-gate-reh-')
  try {
    const old = greenRehearsal({ runId: 'old', finishedAt: new Date(NOW.getTime() - 5 * DAY).toISOString() })
    const newer = (extra: object) => ({ ...greenRehearsal({ runId: 'new', finishedAt: new Date(NOW.getTime() - DAY).toISOString() }), ...extra })

    publish(dir, 'a-old', old)
    publish(dir, 'b-new', newer({ verdict: 'RED', exitCode: 1 }))
    const red = readNewestRehearsal(dir, verifyPublishedReport)
    assert.ok('parsed' in red)
    assert.equal((red as { parsed: { runId: string } }).parsed.runId, 'new', 'the newer report is the one judged')
    console.log('precondition: two reports on disk; the newer (RED) one was selected')

    // Digest failure on the newer one.
    publish(dir, 'b-new', newer({}), undefined, '# tampered\n')
    writeFileSync(path.join(dir, 'b-new', 'readiness-report.md'), '# something else\n')
    const tampered = readNewestRehearsal(dir, verifyPublishedReport)
    assert.ok('digest' in tampered && tampered.digest.ok === false)

    // Corrupt JSON on the newer one: selected by mtime, parsed null.
    const jsonPath = path.join(dir, 'b-new', 'readiness-report.json')
    writeFileSync(jsonPath, '{not json')
    const future = Date.now() / 1000 + 100
    utimesSync(jsonPath, future, future)
    const corrupt = readNewestRehearsal(dir, verifyPublishedReport)
    assert.ok('parsed' in corrupt && corrupt.parsed === null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rehearsal directory: missing, empty, symlinked entries, report-less directories and non-directories', () => {
  const dir = scratchBase('ims-gate-reh-')
  try {
    assert.deepEqual(readNewestRehearsal(path.join(dir, 'nope'), verifyPublishedReport), { none: `the rehearsal report directory ${path.join(dir, 'nope')} does not exist` })
    assert.ok('none' in readNewestRehearsal(dir, verifyPublishedReport), 'empty directory')
    mkdirSync(path.join(dir, 'crashed'))
    writeFileSync(path.join(dir, 'crashed', '.readiness-report.json.abc.tmp'), 'x')
    writeFileSync(path.join(dir, 'stray-file'), 'x')
    assert.ok('none' in readNewestRehearsal(dir, verifyPublishedReport), 'a crashed publication and a stray file are not reports')
    const outside = scratchBase('ims-gate-out-')
    publish(outside, 'elsewhere', greenRehearsal())
    symlinkSync(path.join(outside, 'elsewhere'), path.join(dir, 'link'))
    const linked = readNewestRehearsal(dir, verifyPublishedReport)
    assert.ok('untrusted' in linked && /is a symlink/.test(linked.untrusted), 'a symlinked run directory is refused, never followed')
    rmSync(path.join(dir, 'link'))
    rmSync(outside, { recursive: true, force: true })
    publish(dir, 'real', greenRehearsal())
    const found = readNewestRehearsal(dir, verifyPublishedReport)
    assert.ok('digest' in found && found.digest.ok)
    assert.deepEqual(readdirSync(dir).sort(), ['crashed', 'real', 'stray-file'])
    assert.equal(statSync(path.join(dir, 'real')).isDirectory(), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------------------------
// READ-ONLY: a universal absence check over every file the gate is made of.
// ---------------------------------------------------------------------------------------------

const GATE_SOURCES = [
  'lib/ops/readiness-gate.ts',
  'lib/ops/readiness-gate-constants.ts',
  'lib/ops/readiness-gate-collect.ts',
  'lib/ops/readiness-gate-publish.ts',
  'scripts/readiness-gate.ts',
]

test('absence: no gate source contains a database write, an activity-log write, a vendor module or a network call [mutation: add db.activityLog.create]', () => {
  const forbidden: Array<[string, RegExp]> = [
    ['prisma write', /\b(db|tx|prisma|client)\.\w+\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/],
    ['raw write', /\$executeRaw/],
    ['activity log', /logActivity|activityLog\.(create|update)/],
    ['setting write', /setSetting|setting\.(upsert|update|create)/],
    ['vendor connector import', /lib\/connectors\//],
    ['connector fetch', /connectorFetch|connector-fetch/],
    ['network call', /\bfetch\s*\(|node:https?|node:net|node:dgram|undici|axios/],
    ['shell', /\bshell\s*:\s*true|child_process['"]\s*\)?[^;]*\bexec\(|\bexecSync\b/],
    ['argv credential', /DATABASE_URL[^\n]*(args|argv)|(args|argv)[^\n]*DATABASE_URL/],
  ]
  let scanned = 0
  for (const file of GATE_SOURCES) {
    const text = readFileSync(path.join(ROOT, file), 'utf8')
    // Comments are prose, not code: strip them so a sentence about a write is not read as one.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    scanned += 1
    for (const [label, pattern] of forbidden) assert.doesNotMatch(code, pattern, `${file}: ${label}`)
  }
  console.log(`precondition: ${scanned} gate source files scanned for ${forbidden.length} forbidden shapes`)
  assert.equal(scanned, GATE_SOURCES.length)
  // Control: the scanner can fail. A write-shaped line IS found by the same patterns.
  assert.match('await db.activityLog.create({ data })', forbidden[0]![1])
  assert.match('logActivity({})', forbidden[2]![1])
})

test('the only program the gate runs is npm run <script>, with no shell', () => {
  const text = readFileSync(path.join(ROOT, 'lib/ops/readiness-gate-collect.ts'), 'utf8')
  const spawns = [...text.matchAll(/\bspawn\(([^)]*)\)/g)].map((match) => match[1]!)
  console.log(`precondition: ${spawns.length} spawn call(s) found`)
  assert.equal(spawns.length, 1)
  assert.match(spawns[0]!, /^'npm', args/)
  assert.match(text, /shell: false/)
})

test('a rehearsal location another account could have written is NOT read, anywhere in it [mutation: trust check removed]', () => {
  const plant = (label: string, prepare: (dir: string) => void): ReturnType<typeof readNewestRehearsal> => {
    const dir = scratchBase('ims-gate-trustreh-')
    publish(dir, 'run-good', greenRehearsal({ runId: 'good' }))
    publish(dir, 'run-other', greenRehearsal({ runId: 'other', finishedAt: new Date(NOW.getTime() - 3 * DAY).toISOString() }))
    prepare(dir)
    void label
    return readNewestRehearsal(dir, verifyPublishedReport)
  }
  const control = plant('control', () => undefined)
  assert.ok('digest' in control && control.digest.ok, 'control: an untouched location is read')
  console.log('precondition: the control location was read; now planting writable shapes')
  const shapes: Array<[string, (dir: string) => void, RegExp]> = [
    ['report directory group-writable', (d) => chmodSync(d, 0o770), /rehearsal report directory/],
    ['report directory world-writable', (d) => chmodSync(d, 0o777), /rehearsal report directory/],
    ['the OLDER run directory world-writable (not the newest)', (d) => chmodSync(path.join(d, 'run-other'), 0o777), /run directory/],
    ['the newest run directory group-writable', (d) => chmodSync(path.join(d, 'run-good'), 0o770), /run directory/],
    ['report JSON group-writable', (d) => chmodSync(path.join(d, 'run-good', 'readiness-report.json'), 0o664), /writable by group or others/],
    ['report Markdown world-writable', (d) => chmodSync(path.join(d, 'run-good', 'readiness-report.md'), 0o666), /writable by group or others/],
    ['the older report JSON world-writable', (d) => chmodSync(path.join(d, 'run-other', 'readiness-report.json'), 0o666), /writable by group or others/],
    ['report Markdown is a symlink', (d) => { const md = path.join(d, 'run-good', 'readiness-report.md'); rmSync(md); symlinkSync(path.join(d, 'run-other', 'readiness-report.md'), md) }, /symlink/],
    ['report JSON is a symlink', (d) => { const js = path.join(d, 'run-good', 'readiness-report.json'); rmSync(js); symlinkSync(path.join(d, 'run-other', 'readiness-report.json'), js) }, /symlink/],
  ]
  for (const [label, prepare, message] of shapes) {
    const found = plant(label, prepare)
    assert.ok('untrusted' in found, `${label}: refused`)
    assert.match(found.untrusted, message, label)
    assert.match(found.untrusted, /proves nothing, so it was not read/, label)
  }
  // The refusal reaches the verdict as a failure of the rehearsal check.
  console.log(`precondition: ${shapes.length} untrusted shapes refused`)
})

test('the default rehearsal location is refused too when it fails the checks (same policy, no special case)', async () => {
  const dir = scratchBase('ims-gate-trustdefault-')
  publish(dir, 'run', greenRehearsal())
  chmodSync(dir, 0o777)
  const { results } = await collectGateResults({ phase: 'P0', expectGranted: null, rehearsalDir: dir }, { ...deps(), readNewestRehearsal: (d) => readNewestRehearsal(d, verifyPublishedReport) })
  assert.equal(results['first-install-rehearsal']!.kind, 'fail')
  assert.match(JSON.stringify(results['first-install-rehearsal']), /not trusted/)
})

test('absence: the code that RUNS things never names validate:db or a generate script (the gate writes nothing to the checkout)', () => {
  const files = ['lib/ops/readiness-gate-collect.ts', 'scripts/readiness-gate.ts', 'lib/ops/readiness-gate-publish.ts']
  const pattern = /validate:db|db:generate|prisma generate|prisma migrate (deploy|dev|reset)|db push/
  let scanned = 0
  for (const file of files) {
    const text = readFileSync(path.join(ROOT, file), 'utf8')
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    scanned += 1
    assert.doesNotMatch(code, pattern, file)
  }
  console.log(`precondition: ${scanned} files scanned`)
  assert.match("npm run validate:db", pattern, 'control: the pattern finds the forbidden call')
  assert.deepEqual([...SCHEMA_STATE_SCRIPTS], ['db:migrate:status', 'db:schema:diff', 'db:schema:drift'])
})

test('PRISMA_DEV_DB_CONFIRM is passed to the children only if the operator set it (the gate never sets it)', async () => {
  const without = deps()
  await collectGateResults(OPTIONS, without)
  assert.equal('PRISMA_DEV_DB_CONFIRM' in without.spawned[0]!.env, false)
  const withIt = deps({ env: { ...deps().env, PRISMA_DEV_DB_CONFIRM: '1' } })
  await collectGateResults(OPTIONS, withIt)
  assert.equal(withIt.spawned[0]!.env.PRISMA_DEV_DB_CONFIRM, '1')
})

test('CHECK constraints are verified by NAME + TABLE + SCHEMA + VALIDATED + DEFINITION; a same-named constraint elsewhere is not evidence [mutation: match by name only]', () => {
  const good = constraintRows()
  assert.deepEqual(assessCheckConstraints(good), [], 'control: PostgreSQL\'s own renderings of all required constraints satisfy the check')
  console.log(`precondition: ${good.length} required constraints, control passes`)
  const without = (name: string) => good.filter((row) => row.name !== name)
  const mutate = (name: string, change: Partial<ConstraintRow>) => good.map((row) => (row.name === name ? { ...row, ...change } : row))
  const cases: Array<[string, ConstraintRow[], RegExp]> = [
    ['missing', without('stock_levels_quantity_nonnegative'), /stock_levels_quantity_nonnegative is not installed on stock_levels/],
    ['same name on a DIFFERENT table (the original is gone)', mutate('cost_layers_received_nonnegative', { table: 'purchase_orders' }), /exists elsewhere: public\.purchase_orders, which does not count/],
    ['same name in a DIFFERENT schema', mutate('stock_movements_qty_nonnegative', { schema: 'tenant_b' }), /exists elsewhere: tenant_b\.stock_movements/],
    ['present but NOT VALID', mutate('stock_levels_reserved_nonnegative', { validated: false }), /is not validated/],
    ['wrong definition', mutate('cost_layers_remaining_qty_non_negative', { definition: 'CHECK (("remainingQty" >= (-1)::numeric))' }), /has the definition/],
    ['a weaker definition under the right name', mutate('stock_levels_reserved_qty_lte_quantity', { definition: 'CHECK (true)' }), /has the definition CHECK \(true\)/],
    ['the right one twice', [...good, good[0]!], /appears 2 times/],
  ]
  for (const [label, rows, message] of cases) {
    const problems = assessCheckConstraints(rows)
    assert.ok(problems.length > 0, `${label}: must be a problem`)
    assert.match(problems.join(' | '), message, label)
  }
  // The decoy alongside the real one changes nothing; the real one still counts.
  assert.deepEqual(assessCheckConstraints([...good, { ...good[0]!, table: 'decoy_table' }, { ...good[1]!, schema: 'other' }]), [])
  // Reaches the verdict as a failed schema-state check.
  console.log(`precondition: ${cases.length} constraint problems detected`)
})

test('the expected CHECK constraints are exactly the migrations\' (name, table and definition appear in a migration), and cover the validate:db probe list', () => {
  const migrations = path.join(ROOT, 'prisma/migrations')
  const sql = readdirSync(migrations).flatMap((dir) => {
    try { return [readFileSync(path.join(migrations, dir, 'migration.sql'), 'utf8')] } catch { return [] }
  }).join('\n')
  let checked = 0
  for (const entry of REQUIRED_CHECK_CONSTRAINTS) {
    const at = sql.indexOf(`ADD CONSTRAINT "${entry.name}"`)
    assert.notEqual(at, -1, `${entry.name} is added by a migration`)
    const statement = sql.slice(at, sql.indexOf(';', at) === -1 ? at + 400 : at + 400)
    assert.ok(normaliseConstraintDefinition(statement).includes(normaliseConstraintDefinition(entry.definition)), `${entry.name}: the migration's definition is ${entry.definition}`)
    // And the ALTER TABLE naming the expected table precedes it.
    const alter = sql.lastIndexOf('ALTER TABLE', at)
    assert.ok(sql.slice(alter, at).includes(`"${entry.table}"`), `${entry.name} is added to ${entry.table}`)
    checked += 1
  }
  console.log(`precondition: ${checked} constraints matched to their migration statements`)
  const probe = readFileSync(path.join(ROOT, 'scripts/check-stock-quantity-constraints.mjs'), 'utf8')
  const probed = [...probe.matchAll(/constraint: '([a-z_]+)'/g)].map((match) => match[1]!)
  assert.equal(probed.length, 6)
  for (const name of probed) assert.ok(REQUIRED_CHECK_CONSTRAINTS.some((entry) => entry.name === name), `${name} (made to fire by validate:db) is required by the gate`)
  assert.deepEqual(Object.keys(PG_RENDERED).sort(), REQUIRED_CHECK_CONSTRAINTS.map((entry) => entry.name).sort())
})
