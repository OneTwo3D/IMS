import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { verifyPublishedReport } from '../../lib/ops/published-report.ts'
import {
  CHILD_ENV_FIXED,
  CHILD_ENV_WHITELIST,
  assessReconciliationReadiness,
  buildChildEnv,
  collectGateResults,
  readNewestRehearsal,
  type ChildSpec,
  type GateDeps,
} from '../../lib/ops/readiness-gate-collect.ts'
import { FORBIDDEN_ENV_PATTERNS } from '../../lib/ops/first-install-rehearsal.ts'
import { READ_SYNC_STATUS_SCRIPT } from '../../lib/ops/readiness-gate-constants.ts'
import { decideVerdict } from '../../lib/ops/readiness-gate.ts'
import type { AccountingReconciliationReadiness } from '../../lib/ops/rollout-readiness.ts'
import { DAY, NOW, NO_ACCEPTANCES, cleanInvariant, cleanOutbound, greenRehearsal } from '../helpers/readiness-gate-fixtures.ts'

/**
 * COLLECTION: every dependency failing is `unreadable`, never silence; the child environment is a
 * whitelist; the newest rehearsal is judged on its own; and no code path of the gate writes to the database.
 */

const ROOT = process.cwd()

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
  assert.equal(d.spawned.length, 1, 'only validate:db is spawned when there is no read-sync script')
  assert.equal(d.spawned[0]!.script, 'validate:db')
  assert.equal(Object.keys(results).length, 21)
})

test('every dependency that throws, rejects or returns garbage becomes NO-GO, never a pass [mutation: unreadable treated as empty]', async () => {
  const boom = async () => { throw new Error('connection refused') }
  const cases: Array<[string, Partial<GateDeps>, string]> = [
    ['invariant throws', { runInvariant: boom }, 'invariant-preflight'],
    ['outbound throws', { readOutbound: boom }, 'outbound-status'],
    ['reconciliation throws', { readReconciliation: boom }, 'reconciliation-completeness'],
    ['validate:db cannot start', { runScript: async () => ({ exitCode: null, stdout: '', stderr: 'ENOENT', timedOut: false }) }, 'validate-db'],
    ['validate:db times out', { runScript: async () => ({ exitCode: null, stdout: '', stderr: '', timedOut: true }) }, 'validate-db'],
    ['validate:db exits 1', { runScript: async () => ({ exitCode: 1, stdout: 'drift', stderr: '', timedOut: false }) }, 'validate-db'],
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
  const stdout = JSON.stringify({ streams: [{ stream: 'wc', state: 'fresh', lastSuccessAt: '2026-10-08T11:00:00Z' }] })
  const present = deps({}, { [READ_SYNC_STATUS_SCRIPT]: 'tsx scripts/read-sync-status.ts' })
  present.runScript = async (spec) => { present.spawned.push(spec); return { exitCode: 0, stdout: spec.script === READ_SYNC_STATUS_SCRIPT ? stdout : '', stderr: '', timedOut: false } }
  assert.equal((await collectGateResults(OPTIONS, present)).results['read-sync-liveness']!.kind, 'pass')
  const stale = deps({ runScript: async (spec) => ({ exitCode: 0, stdout: spec.script === READ_SYNC_STATUS_SCRIPT ? JSON.stringify({ streams: [{ stream: 'wc', state: 'stale' }] }) : '', stderr: '', timedOut: false }) }, { [READ_SYNC_STATUS_SCRIPT]: 'x' })
  assert.equal((await collectGateResults(OPTIONS, stale)).results['read-sync-liveness']!.kind, 'fail')
  const spawnedPresent = present.spawned.map((spec) => `${spec.script}:${spec.silent}`)
  assert.deepEqual(spawnedPresent, ['validate:db:false', `${READ_SYNC_STATUS_SCRIPT}:true`])
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
  assert.deepEqual(Object.keys(d.spawned[0]!).sort(), ['cwd', 'env', 'script', 'silent', 'timeoutMs'])
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
  const dir = mkdtempSync(path.join(tmpdir(), 'ims-gate-reh-'))
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
  const dir = mkdtempSync(path.join(tmpdir(), 'ims-gate-reh-'))
  try {
    assert.deepEqual(readNewestRehearsal(path.join(dir, 'nope'), verifyPublishedReport), { none: `the rehearsal report directory ${path.join(dir, 'nope')} does not exist` })
    assert.ok('none' in readNewestRehearsal(dir, verifyPublishedReport), 'empty directory')
    mkdirSync(path.join(dir, 'crashed'))
    writeFileSync(path.join(dir, 'crashed', '.readiness-report.json.abc.tmp'), 'x')
    writeFileSync(path.join(dir, 'stray-file'), 'x')
    assert.ok('none' in readNewestRehearsal(dir, verifyPublishedReport), 'a crashed publication and a stray file are not reports')
    const outside = mkdtempSync(path.join(tmpdir(), 'ims-gate-out-'))
    publish(outside, 'elsewhere', greenRehearsal())
    symlinkSync(path.join(outside, 'elsewhere'), path.join(dir, 'link'))
    assert.ok('none' in readNewestRehearsal(dir, verifyPublishedReport), 'a symlinked report directory is ignored, not followed')
    rmSync(outside, { recursive: true, force: true })
    publish(dir, 'real', greenRehearsal())
    const found = readNewestRehearsal(dir, verifyPublishedReport)
    assert.ok('digest' in found && found.digest.ok)
    assert.deepEqual(readdirSync(dir).sort(), ['crashed', 'link', 'real', 'stray-file'])
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
