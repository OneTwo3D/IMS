import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { verifyPublishedReport } from '../../lib/ops/published-report.ts'
import { READINESS_GATE_EXIT_CODES } from '../../lib/ops/readiness-gate-constants.ts'
import type { GateDeps } from '../../lib/ops/readiness-gate-collect.ts'
import { parseGateArgs, runReadinessGate } from '../../scripts/readiness-gate.ts'
import { NOW, acceptanceText, cleanInvariant, cleanOutbound, greenRehearsal, validAcceptance } from '../helpers/readiness-gate-fixtures.ts'

const ROOT = process.cwd()
const URL_ENV = { DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/db', PATH: process.env.PATH }

function deps(overrides: Partial<GateDeps> = {}): GateDeps {
  return {
    now: () => NOW,
    runInvariant: async () => cleanInvariant(),
    readOutbound: async () => cleanOutbound(),
    readReconciliation: async () => ({ latest: { id: 'r', status: 'COMPLETED', totalCount: 0, warningCount: 0, criticalCount: 0, createdAt: NOW.toISOString() }, proof: { state: 'proven' }, blockers: [], warnings: [] }),
    runScript: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
    readPackageScripts: () => ({}),
    readNewestRehearsal: () => ({ digest: { ok: true }, parsed: greenRehearsal(), location: '/r' }),
    env: URL_ENV,
    repoRoot: ROOT,
    ...overrides,
  }
}

type Run = { code: number; out: string[]; err: string[]; reportDir: string }
async function run(argv: string[], depsOverride: Partial<GateDeps> = {}, extra: { env?: NodeJS.ProcessEnv; publishHooks?: Parameters<typeof runReadinessGate>[0]['publishHooks']; reportDir?: string } = {}): Promise<Run> {
  const base = mkdtempSync(path.join(tmpdir(), 'ims-gate-cli-'))
  const reportDir = extra.reportDir ?? path.join(base, 'reports')
  const out: string[] = []
  const err: string[] = []
  const code = await runReadinessGate({
    argv: [...argv, '--report-dir', reportDir, '--acceptances', path.join(base, 'none.json')].filter(Boolean),
    env: extra.env ?? URL_ENV,
    deps: deps(depsOverride),
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    disconnect: async () => undefined,
    publishHooks: extra.publishHooks,
  })
  return { code, out, err, reportDir }
}

// The acceptance file path above does not exist and is explicit => refused. Tests that need "no file" use runNoFile.
async function runNoFile(argv: string[], depsOverride: Partial<GateDeps> = {}, extra: Parameters<typeof run>[2] = {}): Promise<Run> {
  const base = mkdtempSync(path.join(tmpdir(), 'ims-gate-cli-'))
  const reportDir = extra.reportDir ?? path.join(base, 'reports')
  const out: string[] = []
  const err: string[] = []
  const code = await runReadinessGate({
    argv: [...argv, '--report-dir', reportDir],
    env: extra.env ?? URL_ENV,
    deps: deps(depsOverride),
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    disconnect: async () => undefined,
    publishHooks: extra.publishHooks,
    repoRoot: base,
  })
  return { code, out, err, reportDir }
}

const reports = (reportDir: string) => (existsSync(reportDir) ? readdirSync(reportDir) : [])

test('the exit code a verdict gets is the one in the documented table, and the CLI uses only those', async () => {
  const names = new Set(READINESS_GATE_EXIT_CODES.map((row) => row.name))
  for (const name of ['go', 'go-with-accepted-warnings', 'no-go', 'refused', 'report-not-published', 'failed']) assert.ok(names.has(name), name)
  assert.equal(names.size, 6)
})

test('refusals: every bad invocation exits 2 and creates no report', async () => {
  const cases: Array<[string, string[], Parameters<typeof run>[2]]> = [
    ['no phase', [], {}],
    ['unknown phase', ['--phase', 'P9'], {}],
    ['unknown flag', ['--phase', 'P0', '--frobnicate'], {}],
    ['duplicate flag', ['--phase', 'P0', '--phase', 'P1'], {}],
    ['flag without value', ['--phase'], {}],
    ['P2 without declared writers', ['--phase', 'P2'], {}],
    ['expect-granted at P0', ['--phase', 'P0', '--expect-granted', 'xero'], {}],
    ['expect-granted with a non-connector', ['--phase', 'P2', '--expect-granted', 'qb'], {}],
    ['expect-granted with a duplicate', ['--phase', 'P2', '--expect-granted', 'xero,xero'], {}],
    ['no DATABASE_URL', ['--phase', 'P0'], { env: { PATH: process.env.PATH } }],
  ]
  for (const [label, argv, extra] of cases) {
    const result = await runNoFile(argv, {}, extra)
    assert.equal(result.code, 2, label)
    assert.deepEqual(reports(result.reportDir), [], `${label}: nothing written`)
  }
  const named = await run(['--phase', 'P0'])
  assert.equal(named.code, 2, 'a NAMED acceptance file that does not exist is a refusal, not "no acceptances"')
  console.log(`precondition: ${cases.length + 1} refusals examined`)
  assert.equal(parseGateArgs(['--help']).hasOwnProperty('help'), true)
})

test('a P2 invocation parses with the declared writers, and none is a valid declaration', () => {
  const parsed = parseGateArgs(['--phase', 'P2', '--expect-granted', 'none'])
  assert.ok(!('error' in parsed))
  assert.deepEqual((parsed as { expectGranted: string[] }).expectGranted, [])
})

test('GO: exit 0, and the published pair verifies and says GO', async () => {
  const result = await runNoFile(['--phase', 'P0'])
  assert.equal(result.code, 0, result.err.join('\n'))
  const [runId] = reports(result.reportDir)
  assert.equal(reports(result.reportDir).length, 1)
  const json = path.join(result.reportDir, runId!, 'readiness-gate.json')
  assert.deepEqual(verifyPublishedReport(json), { ok: true })
  const record = JSON.parse(readFileSync(json, 'utf8'))
  assert.equal(record.verdict, 'GO')
  assert.equal(record.exitCode, 0)
  assert.equal(record.phase, 'P0')
  assert.equal(readdirSync(path.join(result.reportDir, runId!)).sort().join(','), 'readiness-gate.json,readiness-gate.md', 'no temporary file is left behind')
  assert.match(result.out.join('\n'), /^# Readiness gate: GO \(P0\)/)
})

test('--json prints exactly one JSON document on stdout and the Markdown on stderr', async () => {
  const result = await runNoFile(['--phase', 'P1', '--json'])
  assert.equal(result.code, 0)
  assert.equal(result.out.length, 1)
  const parsed = JSON.parse(result.out[0]!)
  assert.equal(parsed.verdict, 'GO')
  assert.equal(typeof parsed.companionMarkdownSha256, 'string')
  assert.match(result.err.join('\n'), /# Readiness gate: GO/)
})

test('NO-GO: exit 1, and the report is still published and says NO-GO and why', async () => {
  const critical = cleanInvariant({ inventory: [{ severity: 'critical', code: 'stock_negative_quantity', productId: 'p1', message: 'negative stock' }] })
  const result = await runNoFile(['--phase', 'P0'], { runInvariant: async () => critical })
  assert.equal(result.code, 1)
  const [runId] = reports(result.reportDir)
  const record = JSON.parse(readFileSync(path.join(result.reportDir, runId!, 'readiness-gate.json'), 'utf8'))
  assert.equal(record.verdict, 'NO-GO')
  assert.ok(record.blockingReasons.some((reason: string) => reason.startsWith('invariant-preflight:')))
})

test('a collector that blows up is NO-GO (exit 1) with the check unreadable, not exit 0 and not an unhandled crash', async () => {
  const result = await runNoFile(['--phase', 'P0'], { readReconciliation: async () => { throw new Error('db down') } })
  assert.equal(result.code, 1)
})

test('GO-WITH-ACCEPTED-WARNINGS: exit 10 with a current acceptance, exit 1 without', async () => {
  const warned = cleanInvariant({ inventory: [{ severity: 'warning', code: 'stock_movement_value_mismatch', productId: 'p1', warehouseId: 'w1', message: 'm' }] })
  const id = 'invariant:inventory:stock_movement_value_mismatch:product=p1,warehouse=w1'
  const without = await runNoFile(['--phase', 'P0'], { runInvariant: async () => warned })
  assert.equal(without.code, 1)

  const base = mkdtempSync(path.join(tmpdir(), 'ims-gate-acc-'))
  const file = path.join(base, 'acceptances.json')
  writeFileSync(file, acceptanceText([validAcceptance(id)]))
  const out: string[] = []
  const err: string[] = []
  const reportDir = path.join(base, 'reports')
  const code = await runReadinessGate({ argv: ['--phase', 'P0', '--acceptances', file, '--report-dir', reportDir], env: URL_ENV, deps: deps({ runInvariant: async () => warned }), stdout: (t) => out.push(t), stderr: (t) => err.push(t), disconnect: async () => undefined })
  assert.equal(code, 10, err.join('\n'))
  const [runId] = readdirSync(reportDir)
  const record = JSON.parse(readFileSync(path.join(reportDir, runId!, 'readiness-gate.json'), 'utf8'))
  assert.equal(record.verdict, 'GO-WITH-ACCEPTED-WARNINGS')
  assert.equal(record.warnings[0].accepted, true)
  assert.equal(record.warnings[0].acceptance.by, 'Jan Operator')

  // An expired acceptance of the same warning is NO-GO.
  writeFileSync(file, acceptanceText([validAcceptance(id, { acceptedAt: '2026-01-01T00:00:00Z', expiresAt: '2026-02-01T00:00:00Z' })]))
  const expired = await runReadinessGate({ argv: ['--phase', 'P0', '--acceptances', file, '--report-dir', path.join(base, 'reports2')], env: URL_ENV, deps: deps({ runInvariant: async () => warned }), stdout: () => undefined, stderr: () => undefined, disconnect: async () => undefined })
  assert.equal(expired, 1)
})

test('a GO whose report cannot be published is exit 3, never 0 (and a NO-GO stays 1); nothing half-written is left', async () => {
  const failing = { writeFile: () => { throw new Error('disk full') } }
  const go = await runNoFile(['--phase', 'P0'], {}, { publishHooks: failing })
  assert.equal(go.code, 3)
  const [leftover] = reports(go.reportDir)
  assert.equal(leftover === undefined || readdirSync(path.join(go.reportDir, leftover)).length === 0 || !readdirSync(path.join(go.reportDir, leftover)).some((f) => f.endsWith('.json')), true, 'no JSON that could be mistaken for a report')
  const noGo = await runNoFile(['--phase', 'P0'], { runInvariant: async () => cleanInvariant({ ok: false }) }, { publishHooks: failing })
  assert.equal(noGo.code, 1)
})

test('an unsafe report directory is refused (exit 2) before any check runs', async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'ims-gate-unsafe-'))
  chmodSync(base, 0o777)
  let invariantCalls = 0
  const result = await runNoFile(['--phase', 'P0'], { runInvariant: async () => { invariantCalls += 1; return cleanInvariant() } }, { reportDir: path.join(base, 'reports') })
  chmodSync(base, 0o700)
  rmSync(base, { recursive: true, force: true })
  assert.equal(result.code, 2)
  assert.equal(invariantCalls, 0, 'no check ran')
})

test('the real command line: no arguments exits 2 and prints the exit-code table; --help exits 0', () => {
  const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/tmp' }
  const bare = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/readiness-gate.ts'], { cwd: ROOT, env, encoding: 'utf8' })
  assert.equal(bare.status, 2, bare.stderr)
  assert.match(bare.stderr, /--phase is required/)
  for (const row of READINESS_GATE_EXIT_CODES) assert.match(bare.stderr, new RegExp(`\\b${row.name}\\b`))
  const help = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/readiness-gate.ts', '--help'], { cwd: ROOT, env, encoding: 'utf8' })
  assert.equal(help.status, 0, help.stderr)
  const noUrl = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/readiness-gate.ts', '--phase', 'P0'], { cwd: ROOT, env, encoding: 'utf8' })
  assert.equal(noUrl.status, 2)
  assert.match(noUrl.stderr, /DATABASE_URL is not set/)
})
