import assert from 'node:assert/strict'
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { runChild } from '../../scripts/rehearse-first-install'
import { verifyPublishedReport } from '../../lib/ops/published-report'
import { REHEARSAL_RECORD_FORMAT_VERSION } from '../../lib/first-load/apply/constants'
import { rehearse } from '../../scripts/lib/first-load-rehearse'
import { lastMigrationName } from '../../lib/first-load/apply/db/migrations'
import { manifestText, prepareSynthetic, preparedFiles } from './apply-helpers'
import { startScratch, type Scratch } from './apply-scratch'
import { precondition } from './helpers'

/**
 * THE COMMAND, AS A PROCESS, against a real throwaway cluster: arguments, the target confirmation, the plan, the refusals that must write nothing, a REAL rehearsal (a second cluster, a
 * restored dump, a child that loads and verifies, a teardown, the target proved unchanged), and an apply that takes a restore point and ends VERIFIED.
 *
 * The test process disconnects its own database client before each run: the quiesce rail refuses a database any other session is connected to, and this process is another session.
 * Each arm names, in a comment, the change to the subject that makes it green again.
 */

const REPO = process.cwd()
const TSX = join(REPO, 'node_modules/.bin/tsx')
const CHILD_TIMEOUT_MS = 20 * 60 * 1000
let s: Scratch
let dir: string
let envFile: string
let manifest: string
let reportDir: string
let restoreDir: string
let rehearsalRoot: string
let systemId = ''
const outputs: string[] = []
const secrets: string[] = []

const RUN = (extra: string[], over: { env?: Record<string, string>; expectDb?: string; expectSid?: string; envFile?: string; reportDir?: string } = {}) =>
  async () => {
    await s.db.$disconnect()
    // The caller's environment is hostile on purpose: an inherited database and PG variables that point somewhere else.
    const env: Record<string, string> = { PATH: process.env.PATH ?? '', LANG: 'C', HOME: join(s.root, 'home'), DATABASE_URL: 'postgresql://decoy:decoy@127.0.0.1:1/decoy', PGHOST: '127.0.0.1', PGPORT: '1', MINTSOFT_WRITE_ALLOWED: 'https://api.example.test|89', ...over.env }
    const result = await runChild({
      cmd: TSX,
      args: ['scripts/first-load-apply.ts', '--manifest', manifest, '--env-file', over.envFile ?? envFile, '--expect-db', over.expectDb ?? s.database, '--expect-system-id', over.expectSid ?? systemId, '--report-dir', over.reportDir ?? reportDir, ...extra],
      env,
      cwd: REPO,
      timeoutMs: CHILD_TIMEOUT_MS,
    })
    outputs.push(result.stdout, result.stderr)
    return result
  }

const runs = async (text: string, params: unknown[] = []) => s.sql(text, params)
const runRecords = () => runs('select count(*)::int as n from first_load_apply_runs').then((r) => (r[0] as { n: number }).n)
const tableCounts = async (): Promise<string> => {
  const names = (await runs(`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`)).map((r) => (r as { table_name: string }).table_name)
  const rows = await runs(names.map((n) => `select '${n}' as t, count(*)::text as n from "${n}"`).join(' union all '))
  return JSON.stringify(Object.fromEntries(rows.map((r) => [(r as { t: string }).t, (r as { n: string }).n]).sort()))
}
const reportsIn = () => readdirSync(reportDir).sort()
const jsonOf = (file: string) => JSON.parse(readFileSync(join(reportDir, file), 'utf8')) as Record<string, unknown>

describe('the first-load apply command, end to end', { timeout: 60 * 60 * 1000 }, () => {
  before(async () => {
    // The directory name starts with the rehearsal prefix on purpose: the child's directory proof then passes, and only its name proof can refuse the arm that uses this directory.
    s = await startScratch('ims-rehearsal-apply-cli')
    dir = join(s.root, 'run')
    mkdirSync(dir)
    const prepared = join(dir, 'prepared')
    mkdirSync(prepared)
    for (const [name, bytes] of preparedFiles(prepareSynthetic())) writeFileSync(join(prepared, name), bytes)
    restoreDir = join(dir, 'restore')
    mkdirSync(restoreDir, { mode: 0o700 })
    chmodSync(restoreDir, 0o700)
    reportDir = join(dir, 'reports')
    rehearsalRoot = join(s.root, 'rehearsals')
    mkdirSync(rehearsalRoot, { mode: 0o700 })
    manifest = join(dir, 'apply-manifest.json')
    writeFileSync(manifest, manifestText({ preparedDir: prepared, restorePointDir: restoreDir, runId: 'cli-e2e' }))
    envFile = join(dir, 'installation.env')
    const keep = ['DATABASE_URL', 'AUTH_SECRET', 'CRON_SECRET', 'SETTINGS_ENCRYPTION_KEY', 'NEXT_PUBLIC_APP_URL', 'AUTH_URL', 'PUBLIC_APP_URL', 'IMS_SKIP_ENV_FILE', 'DOTENV_CONFIG_PATH', 'DOTENV_CONFIG_QUIET', 'PRISMA_HIDE_UPDATE_MESSAGE', 'CHECKPOINT_DISABLE', 'FILE_SCAN_MODE', 'E2E_TEST_MODE']
    writeFileSync(envFile, `${keep.map((k) => `${k}=${s.childEnv[k]}`).join('\n')}\n`, { mode: 0o600 })
    chmodSync(envFile, 0o600)
    systemId = ((await s.sql<{ id: string }>('select system_identifier::text as id from pg_control_system()'))[0]!).id
    secrets.push(s.password, s.childEnv.AUTH_SECRET!, s.childEnv.CRON_SECRET!)
    await s.db.$disconnect()
  })
  after(async () => { await s?.stop() })

  describe('refusals that must write nothing', () => {
    it('--help prints the exit table and exits 0; a usage error exits 2', async () => {
      const help = await runChild({ cmd: TSX, args: ['scripts/first-load-apply.ts', '--help'], env: { PATH: process.env.PATH ?? '', HOME: join(s.root, 'home') }, cwd: REPO, timeoutMs: CHILD_TIMEOUT_MS })
      assert.equal(help.exitCode, 0)
      assert.match(help.stdout, /REHEARSAL_TEARDOWN_INCOMPLETE/)
      const usage = await runChild({ cmd: TSX, args: ['scripts/first-load-apply.ts', '--plan'], env: { PATH: process.env.PATH ?? '', HOME: join(s.root, 'home') }, cwd: REPO, timeoutMs: CHILD_TIMEOUT_MS })
      assert.equal(usage.exitCode, 2)
      assert.match(usage.stderr, /--manifest is required/)
      outputs.push(help.stdout, help.stderr, usage.stdout, usage.stderr)
    })

    it('the target is confirmed by what the server says: the wrong database name or the wrong system id is refused (exit 3) before anything is read or written', async (t) => {
      // Mutation: skip either comparison in runCli and the matching arm exits 0 or 4.
      const before = await tableCounts()
      const wrongDb = await RUN(['--plan'], { expectDb: 'some_other_db' })()
      assert.equal(wrongDb.exitCode, 3, wrongDb.stderr)
      assert.match(wrongDb.stderr, /--expect-db does not equal/)
      const wrongSid = await RUN(['--plan'], { expectSid: '1' })()
      assert.equal(wrongSid.exitCode, 3, wrongSid.stderr)
      assert.match(wrongSid.stderr, /--expect-system-id does not equal/)
      assert.equal(await tableCounts(), before, 'no table changed')
      precondition(t, 'confirmation arms', 2)
    })

    it('an env file that is readable by others, or that sets a PG variable, is refused (exit 2)', async () => {
      const loose = join(dir, 'loose.env')
      writeFileSync(loose, readFileSync(envFile), { mode: 0o644 })
      chmodSync(loose, 0o644)
      const a = await RUN(['--plan'], { envFile: loose })()
      assert.equal(a.exitCode, 2, a.stderr)
      assert.match(a.stderr, /mode 600/)
      const redirect = join(dir, 'redirect.env')
      writeFileSync(redirect, `${readFileSync(envFile, 'utf8')}PGHOST=elsewhere\n`, { mode: 0o600 })
      chmodSync(redirect, 0o600)
      const b = await RUN(['--plan'], { envFile: redirect })()
      assert.equal(b.exitCode, 2, b.stderr)
      assert.match(b.stderr, /sets PGHOST/)
    })

    it('a rehearsal child may run only on the throwaway database its rehearsal made: a database with another name is refused (exit 3) and nothing is written, even inside a directory that passes the directory proof', async () => {
      // Mutation: drop the REHEARSAL_DATABASE name proof and this child applies the load to the scratch database without any record.
      const before = await tableCounts()
      const r = await RUN(['--apply', '--rehearsal-child-dir', s.root, '--report-stem', 'child-misuse'])()
      assert.equal(r.exitCode, 3, r.stderr)
      assert.match(r.stderr, /only on the throwaway database/)
      assert.equal(await tableCounts(), before)
      assert.equal(await runRecords(), 0)
    })
  })

  describe('the rehearsal waiver needs BOTH proofs', () => {
    it('a database with the throwaway name but a data directory outside the run directory is refused too (the name proof alone passes)', async () => {
      // Mutation: drop the insideRunDir proof and this child loads with no record (the name proof alone passes here).
      await s.db.$disconnect()
      await runs('create database ims_firstload_rehearsal template ims_scratch')
      try {
        const env = join(dir, 'lookalike.env')
        writeFileSync(env, readFileSync(envFile, 'utf8').replace(/^DATABASE_URL=.*$/m, `DATABASE_URL=${s.url.replace(/\/ims_scratch$/, '/ims_firstload_rehearsal')}`), { mode: 0o600 })
        chmodSync(env, 0o600)
        const before = await tableCounts()
        const r = await RUN(['--apply', '--rehearsal-child-dir', dir, '--report-stem', 'lookalike'], { envFile: env, expectDb: 'ims_firstload_rehearsal' })()
        assert.equal(r.exitCode, 3, r.stderr)
        assert.match(r.stderr, /only on the throwaway database/)
        assert.equal(await tableCounts(), before)
      } finally {
        await runs('drop database ims_firstload_rehearsal')
      }
    })
  })

  describe('plan', () => {
    it('reads the target and writes only its report: exit 0, a published pair, no run record, no table changed', async () => {
      const before = await tableCounts()
      const r = await RUN(['--plan'])()
      assert.equal(r.exitCode, 0, r.stderr + r.stdout)
      assert.equal(await tableCounts(), before)
      const files = reportsIn().filter((f) => f.includes('-plan-'))
      assert.equal(files.length, 2, JSON.stringify(reportsIn()))
      const json = files.find((f) => f.endsWith('.json'))!
      assert.equal(verifyPublishedReport(join(reportDir, json)).ok, true, 'the JSON names its Markdown by SHA-256 and it matches')
      assert.equal(lstatSync(join(reportDir, json)).mode & 0o777, 0o600)
      const report = jsonOf(json) as { mode: string; target: { database: string; systemId: string }; exit: { name: string } }
      assert.deepEqual({ mode: report.mode, db: report.target.database, sid: report.target.systemId, exit: report.exit.name }, { mode: 'plan', db: s.database, sid: systemId, exit: 'OK' })
    })
  })

  describe('apply is refused, and writes nothing, without a rehearsal of this exact load', () => {
    it('no record file, a record of another digest, another target, an old one and one whose verdict is not OK: each exits 3 with no restore point and no run record', async (t) => {
      // Mutation: skip the gate before the restore point (or the core's gate) and the matching arm takes a dump or loads.
      const good = { formatVersion: REHEARSAL_RECORD_FORMAT_VERSION, manifestDigest: 'x', verdict: 'OK', systemId, schemaHead: lastMigrationName(REPO), finishedAt: new Date().toISOString() }
      const prepared = JSON.parse(readFileSync(join(reportDir, reportsIn().find((f) => f.includes('-plan-') && f.endsWith('.json'))!), 'utf8')) as { manifestDigest: string }
      const digest = prepared.manifestDigest
      const arms: Array<[string, Record<string, unknown>]> = [
        ['another digest', { ...good, manifestDigest: 'f'.repeat(64) }],
        ['another target', { ...good, manifestDigest: digest, systemId: '1' }],
        ['older than 24 hours', { ...good, manifestDigest: digest, finishedAt: new Date(Date.now() - 25 * 3_600_000).toISOString() }],
        ['verdict not OK', { ...good, manifestDigest: digest, verdict: 'VERIFY_FAILED' }],
        ['another schema', { ...good, manifestDigest: digest, schemaHead: '20200101000000_old' }],
        ['claims the future', { ...good, manifestDigest: digest, finishedAt: new Date(Date.now() + 3_600_000).toISOString() }],
      ]
      for (const [label, record] of arms) {
        const file = join(dir, `record-${label.replace(/\W+/g, '-')}.json`)
        writeFileSync(file, JSON.stringify(record), { mode: 0o600 })
        const r = await RUN(['--apply', '--rehearsal-record', file])()
        assert.equal(r.exitCode, 3, `${label}: ${r.stderr}`)
        assert.equal(await runRecords(), 0, label)
        assert.deepEqual(readdirSync(restoreDir), [], `${label}: no restore point was taken`)
      }
      const missing = await RUN(['--apply', '--rehearsal-record', join(dir, 'nope.json')])()
      assert.equal(missing.exitCode, 2, missing.stderr)
      precondition(t, 'gate arms', arms.length + 1)
    })
  })

  describe('rehearse, then apply', () => {
    let recordFile = ''
    let before = ''

    it('a real rehearsal: a copy in a cluster of its own, the whole load and verification there, the target proved unchanged, the cluster gone', async () => {
      before = await tableCounts()
      const r = await RUN(['--rehearse', '--root', rehearsalRoot])()
      assert.equal(r.exitCode, 0, `${r.stderr}\n${r.stdout}`)
      assert.equal(await tableCounts(), before, 'the target is byte-for-byte the same in every table count')
      assert.equal(await runRecords(), 0, 'no run record in the target')
      assert.deepEqual(readdirSync(rehearsalRoot), [], 'the throwaway directory (cluster, dump, env file) is gone')
      const record = reportsIn().find((f) => f.startsWith('first-load-rehearsal-record-'))!
      recordFile = join(reportDir, record)
      const rec = JSON.parse(readFileSync(recordFile, 'utf8')) as Record<string, unknown>
      assert.equal(rec.verdict, 'OK')
      assert.equal(rec.systemId, systemId, "the TARGET's system identifier, not the copy's")
      assert.deepEqual({ loadExit: rec.loadExit, targetUnchanged: rec.targetUnchanged, teardownComplete: rec.teardownComplete }, { loadExit: 'OK', targetUnchanged: true, teardownComplete: true })
      const childReport = reportsIn().find((f) => f.includes('-rehearse-') && f.endsWith('.json'))!
      assert.equal(verifyPublishedReport(join(reportDir, childReport)).ok, true)
      const report = jsonOf(childReport) as { exit: { name: string }; verification: Array<{ result: string }>; target: { database: string } }
      assert.equal(report.exit.name, 'OK')
      assert.equal(report.target.database, 'ims_firstload_rehearsal')
      assert.ok(report.verification.length > 0 && report.verification.every((v) => v.result === 'pass'))
    })

    it('an apply with that record takes a restore point (mode 600, readable by pg_restore), loads, verifies, and ends VERIFIED', async () => {
      const r = await RUN(['--apply', '--rehearsal-record', recordFile, '--operator', 'E2E Operator'])()
      assert.equal(r.exitCode, 0, `${r.stderr}\n${r.stdout}`)
      const dumps = readdirSync(restoreDir)
      assert.deepEqual(dumps, ['first-load-cli-e2e.dump'])
      assert.equal(lstatSync(join(restoreDir, dumps[0]!)).mode & 0o777, 0o600)
      const row = (await runs('select status, facts from first_load_apply_runs'))[0] as { status: string; facts: { restorePoint?: { sha256: string; bytes: number }; baseline?: unknown } }
      assert.equal(row.status, 'VERIFIED')
      assert.ok(row.facts.restorePoint && row.facts.baseline, 'the restore point and the census baseline are on the run record')
      const report = jsonOf(reportsIn().find((f) => f.includes('-apply-') && f.endsWith('.json'))!) as { restorePoint: { sha256: string; listed: boolean }; exit: { name: string } }
      assert.equal(report.restorePoint.sha256, row.facts.restorePoint!.sha256)
      assert.equal(report.restorePoint.listed, true)
      assert.equal(report.exit.name, 'OK')
      const activity = await runs(`select count(*)::int as n from activity_logs where metadata->'actor'->>'operator' = 'E2E Operator'`)
      assert.ok((activity[0] as { n: number }).n > 0, 'the operator label is on the audit rows')
    })

    it('a second apply without --resume, and a resume of a VERIFIED run, are each refused (exit 3) and change nothing', async () => {
      const counts = await tableCounts()
      const again = await RUN(['--apply', '--rehearsal-record', recordFile])()
      assert.equal(again.exitCode, 3, again.stderr)
      const resume = await RUN(['--apply', '--rehearsal-record', recordFile, '--resume'])()
      assert.equal(resume.exitCode, 3, resume.stderr)
      assert.equal(await tableCounts(), counts)
      assert.deepEqual(readdirSync(restoreDir), ['first-load-cli-e2e.dump'], 'no second restore point')
    })

    it('a resume whose recorded restore point has been changed is refused: there is no way back', async () => {
      // Put the run back to a resumable state, then damage the restore point.
      await runs(`update first_load_apply_runs set status = 'VERIFY_FAILED', version = version + 1`)
      const file = join(restoreDir, 'first-load-cli-e2e.dump')
      const bytes = readFileSync(file)
      writeFileSync(file, Buffer.concat([bytes, Buffer.from('x')]))
      const r = await RUN(['--apply', '--rehearsal-record', recordFile, '--resume'])()
      assert.equal(r.exitCode, 3, r.stderr)
      assert.match(r.stderr, /restore point is missing or has changed/)
      writeFileSync(file, bytes)
      // Control: restored byte for byte, the same resume verifies and records VERIFIED.
      const ok = await RUN(['--apply', '--rehearsal-record', recordFile, '--resume'])()
      assert.equal(ok.exitCode, 0, `${ok.stderr}\n${ok.stdout}`)
      assert.equal(((await runs('select status from first_load_apply_runs'))[0] as { status: string }).status, 'VERIFIED')
    })
  })

  describe('a rehearsal is not valid if the target changed under it', () => {
    it('a row added to the target while the child ran makes the verdict TARGET_CHANGED and the exit INTERNAL, and a rehearsal record with that verdict does not authorise an apply', async () => {
      // Mutation: drop the recount (or ignore its result) and this is exit 0 with verdict OK.
      await s.db.$disconnect()
      await runs('truncate products, suppliers, product_categories, purchase_orders, stock_movements, first_load_apply_runs, activity_logs restart identity cascade')
      const planDigest = (jsonOf(reportsIn().find((f) => f.includes('-plan-') && f.endsWith('.json'))!) as { manifestDigest: string }).manifestDigest
      const log: string[] = []
      const outcome = await rehearse({
        targetEnv: Object.fromEntries(readFileSync(envFile, 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])),
        targetSystemId: systemId,
        manifestPath: manifest,
        manifestDigest: planDigest,
        schemaHead: lastMigrationName(REPO),
        repoRoot: REPO,
        root: rehearsalRoot,
        reportDir,
        reportStem: 'first-load-apply-rehearse-changed-test',
        operator: 'E2E Operator',
        log: (l) => log.push(l),
        hooks: { beforeTargetRecount: async () => { await runs(`insert into settings (key, value, "updatedAt") values ('zq_changed', 'x', now())`) } },
      })
      assert.equal(outcome.targetUnchanged, false)
      assert.equal(outcome.record.verdict === 'OK', false)
      assert.equal(outcome.exit === 'OK', false)
      assert.ok(outcome.problems.some((p) => /row counts of the target database differ/.test(p)))
      assert.equal(outcome.teardownComplete, true)
      assert.deepEqual(readdirSync(rehearsalRoot), [])
    })
  })

  it('UNIVERSAL: nothing any run printed carries a secret of the scratch installation or a value of the prepared files', () => {
    const text = outputs.join('\n')
    assert.ok(outputs.length >= 20, `output chunks scanned: ${outputs.length}`)
    for (const secret of secrets) assert.ok(!text.includes(secret), 'a secret reached a command output')
    assert.doesNotMatch(text, /zqsent/i, 'a prepared-file value reached a command output')
  })
})
