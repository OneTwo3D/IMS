import assert from 'node:assert/strict'
import { chmodSync, existsSync, rmSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { spawnSync } from 'node:child_process'
import { databaseUrl, runChild, withClient } from '../../scripts/rehearse-first-install'
import { pgBinDir } from '../scripts/real-postgres-cluster'
import { libpqEnvFromUrl } from '../../lib/first-load/apply/cli'
import { verifyPublishedReport } from '../../lib/ops/published-report'
import { REHEARSAL_RECORD_FORMAT_VERSION } from '../../lib/first-load/apply/constants'
import { rehearse } from '../../scripts/lib/first-load-rehearse'
import { readBuildIdentity } from '../../lib/ops/build-identity'
import { checkoutMigrationNames } from '../../lib/first-load/apply/db/migrations'
import { migrationsHash } from '../../lib/first-load/apply/verify-core'
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

const RUN = (extra: string[], over: { env?: Record<string, string>; expectDb?: string; expectSid?: string; envFile?: string; reportDir?: string; script?: string } = {}) =>
  async () => {
    await s.db.$disconnect()
    // The caller's environment is hostile on purpose: an inherited database and PG variables that point somewhere else.
    const env: Record<string, string> = { PATH: process.env.PATH ?? '', LANG: 'C', HOME: join(s.root, 'home'), DATABASE_URL: 'postgresql://decoy:decoy@127.0.0.1:1/decoy', PGHOST: '127.0.0.1', PGPORT: '1', MINTSOFT_WRITE_ALLOWED: 'https://api.example.test|89', ...over.env }
    const result = await runChild({
      cmd: TSX,
      args: [over.script ?? 'scripts/first-load-apply.ts', '--manifest', manifest, '--env-file', over.envFile ?? envFile, '--expect-db', over.expectDb ?? s.database, '--expect-system-id', over.expectSid ?? systemId, '--report-dir', over.reportDir ?? reportDir, ...extra],
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
    // The crons rail reads this account's crontab. The test must not depend on the machine it runs on (a CI image may have no crontab command): a `crontab` that says, as the real one does, that this account has none.
    const shim = join(dir, 'shim-bin')
    mkdirSync(shim)
    writeFileSync(join(shim, 'crontab'), '#!/bin/sh\necho "no crontab for $(id -un)" >&2\nexit 1\n', { mode: 0o755 })
    chmodSync(join(shim, 'crontab'), 0o755)
    process.env.PATH = `${shim}:${process.env.PATH ?? ''}`
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
    // The scratch installation has the storefront configured AND enabled (other suites use that to prove an effect is suppressed). The connectors rail refuses exactly that, so the command
    // tests switch the storefront off (credentials stay): the arms below that need it enabled turn it back on and restore it.
    await s.sql(`update settings set value = 'false' where key = 'plugin_woocommerce_enabled'`)
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

    it('a target whose migration history is not exactly the checkout\'s (same count, one name different) is refused (exit 3) before anything is written', async () => {
      // Mutation: compare the number of migrations only (the old precondition) and this plans OK.
      const first = `(select migration_name from _prisma_migrations order by migration_name limit 1)`
      await s.db.$disconnect()
      const before = await tableCounts()
      await runs(`update _prisma_migrations set migration_name = migration_name || '_other' where migration_name = ${first}`)
      try {
        const r = await RUN(['--plan'])()
        assert.equal(r.exitCode, 3, r.stderr)
        assert.match(r.stderr, /MIGRATIONS_MISSING x1, MIGRATIONS_EXTRA x1/)
        assert.doesNotMatch(r.stderr, /20\d{12}/, 'no migration name is printed')
      } finally {
        await runs(`update _prisma_migrations set migration_name = replace(migration_name, '_other', '') where migration_name like '%\\_other'`)
      }
      assert.equal(await tableCounts(), before)
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

    it('the public command has no child mode at all: the child flags are unknown arguments (exit 2), whatever database name and directory they are paired with', async () => {
      // Mutation: put the child flags back into the public parser and this proceeds to the proof (exit 3) or worse.
      const before = await tableCounts()
      const r = await RUN(['--apply', '--rehearsal-child-dir', s.root, '--report-stem', 'forged'])()
      assert.equal(r.exitCode, 2, r.stderr)
      assert.match(r.stderr, /not recognised/)
      assert.equal(await tableCounts(), before)
      assert.equal(await runRecords(), 0)
    })

    const CHILD = 'scripts/first-load-apply-rehearsal-child.ts'
    const clusterId = () => systemId // the scratch cluster stands in for the "throwaway": the proofs below name it
    const proofFile = () => join(s.root, 'rehearsal-child.json')
    const writeProof = (over: Record<string, unknown> = {}, token = 'c'.repeat(64)) => {
      writeFileSync(proofFile(), JSON.stringify({ tokenSha256: createHash('sha256').update(token).digest('hex'), clusterSystemId: clusterId(), targetSystemId: 'some-other-real-target', ...over }), { mode: 0o600 })
      chmodSync(proofFile(), 0o600)
    }
    const childRun = (token: string | undefined) => RUN(['--apply', '--rehearsal-child-dir', s.root, '--report-stem', 'forged'], { script: CHILD, env: token === undefined ? {} : { IMS_FIRST_LOAD_REHEARSAL_TOKEN: token } })()

    it('a forged child is refused with rails intact: name and directory matching is not proof (no token, a wrong token, a wrong cluster, the real target, a replay)', async (t) => {
      // The scratch database is NOT named ims_firstload_rehearsal, so these arms isolate the TOKEN proof by using a lookalike database below; here they check the refusal text and effects.
      // Mutation: skip the proof (checkChildProof) in runCli and the next section's loads run with no record and no restore point.
      await s.db.$disconnect()
      await runs('create database ims_firstload_rehearsal template ims_scratch')
      const env = join(dir, 'lookalike.env')
      writeFileSync(env, readFileSync(envFile, 'utf8').replace(/^DATABASE_URL=.*$/m, `DATABASE_URL=${s.url.replace(/\/ims_scratch$/, '/ims_firstload_rehearsal')}`), { mode: 0o600 })
      chmodSync(env, 0o600)
      const forged = (token: string | undefined) => RUN(['--apply', '--rehearsal-child-dir', s.root, '--report-stem', 'forged'], { script: CHILD, envFile: env, expectDb: 'ims_firstload_rehearsal', env: token === undefined ? {} : { IMS_FIRST_LOAD_REHEARSAL_TOKEN: token } })()
      try {
        const before = await tableCounts()
        const arms: Array<[string, () => void, string | undefined, string]> = [
          ['no proof file and no token', () => rmSync(proofFile(), { force: true }), undefined, 'NO_PROOF'],
          ['a proof file and no token', () => writeProof(), undefined, 'NO_TOKEN'],
          ['a proof file and the wrong token', () => writeProof(), 'd'.repeat(64), 'TOKEN_MISMATCH'],
          ['the right token on another cluster', () => writeProof({ clusterSystemId: 'another-cluster' }), 'c'.repeat(64), 'WRONG_CLUSTER'],
          ['the right token on the real target\'s cluster', () => writeProof({ targetSystemId: clusterId() }), 'c'.repeat(64), 'IS_THE_TARGET'],
        ]
        for (const [label, setup, token, code] of arms) {
          setup()
          const r = await forged(token)
          assert.equal(r.exitCode, 3, `${label}: ${r.stderr}`)
          assert.match(r.stderr, new RegExp(`REHEARSAL_CHILD_UNAUTHENTICATED: .*${code}`), label)
          assert.equal(existsSync(proofFile()), false, `${label}: the proof is consumed whether or not it was accepted`)
        }
        // A replay: a valid proof is consumed by its first use, so a second claimant with the same token finds nothing.
        writeProof()
        const first = await forged('c'.repeat(64))
        const replay = await forged('c'.repeat(64))
        assert.match(replay.stderr, /NO_PROOF/, `${first.stderr}\n${replay.stderr}`)
        // Rails intact: no relaxation of anything: no restore point, no run record, no table changed by any refusal.
        assert.deepEqual(readdirSync(restoreDir), [])
        assert.equal(await tableCounts(), before)
        precondition(t, 'forged-child arms', arms.length + 1)
      } finally {
        await runs('drop database ims_firstload_rehearsal')
      }
    })

    it('with a VALID proof the child still needs the throwaway database by name and by place; each is checked on its own', async () => {
      // Mutation: drop the REHEARSAL_DATABASE name proof, or the insideRunDir proof, and the matching arm loads.
      const before = await tableCounts()
      writeProof()
      const wrongName = await childRun('c'.repeat(64))
      assert.equal(wrongName.exitCode, 3, wrongName.stderr)
      assert.match(wrongName.stderr, /only on the throwaway database/)
      await s.db.$disconnect()
      await runs('create database ims_firstload_rehearsal template ims_scratch')
      try {
        const env = join(dir, 'lookalike.env')
        writeFileSync(env, readFileSync(envFile, 'utf8').replace(/^DATABASE_URL=.*$/m, `DATABASE_URL=${s.url.replace(/\/ims_scratch$/, '/ims_firstload_rehearsal')}`), { mode: 0o600 })
        chmodSync(env, 0o600)
        // A valid proof sits in the other directory too: the proof is valid, the PLACE is wrong (the data directory is not inside that directory).
        writeFileSync(join(dir, 'rehearsal-child.json'), JSON.stringify({ tokenSha256: createHash('sha256').update('c'.repeat(64)).digest('hex'), clusterSystemId: clusterId(), targetSystemId: 'some-other-real-target' }), { mode: 0o600 })
        const wrongPlace = await RUN(['--apply', '--rehearsal-child-dir', dir, '--report-stem', 'lookalike'], { script: CHILD, envFile: env, expectDb: 'ims_firstload_rehearsal', env: { IMS_FIRST_LOAD_REHEARSAL_TOKEN: 'c'.repeat(64) } })()
        assert.equal(wrongPlace.exitCode, 3, wrongPlace.stderr)
        assert.match(wrongPlace.stderr, /only on the throwaway database/)
        assert.equal(await tableCounts(), before)
      } finally {
        await runs('drop database ims_firstload_rehearsal')
      }
    })

    it('the child entrypoint without child arguments is refused (exit 2)', async () => {
      const r = await RUN(['--apply', '--rehearsal-record', join(dir, 'none.json')], { script: CHILD })()
      assert.equal(r.exitCode, 2, r.stderr)
      assert.match(r.stderr, /needs its child arguments/)
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
      const good = { formatVersion: REHEARSAL_RECORD_FORMAT_VERSION, manifestDigest: 'x', verdict: 'OK', systemId, schemaHash: migrationsHash(checkoutMigrationNames(REPO)), loadExit: 'OK', targetUnchanged: true, teardownComplete: true, report: { file: 'r.json', sha256: 'a'.repeat(64), verificationItems: 17, verificationFailed: 0 }, finishedAt: new Date().toISOString() }
      const prepared = JSON.parse(readFileSync(join(reportDir, reportsIn().find((f) => f.includes('-plan-') && f.endsWith('.json'))!), 'utf8')) as { manifestDigest: string }
      const digest = prepared.manifestDigest
      const arms: Array<[string, Record<string, unknown>]> = [
        ['another digest', { ...good, manifestDigest: 'f'.repeat(64) }],
        ['another target', { ...good, manifestDigest: digest, systemId: '1' }],
        ['older than 24 hours', { ...good, manifestDigest: digest, finishedAt: new Date(Date.now() - 25 * 3_600_000).toISOString() }],
        ['verdict not OK', { ...good, manifestDigest: digest, verdict: 'VERIFY_FAILED' }],
        ['another schema', { ...good, manifestDigest: digest, schemaHash: 'f'.repeat(64) }],
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

    it('an apply refuses a record that says OK but whose bound evidence is gone, changed, or not passing (the verdict is not taken on its word)', async (t) => {
      // Mutation: drop checkRecordBinding / checkRecordReportFile from the command and the matching arm loads.
      const rec = JSON.parse(readFileSync(recordFile, 'utf8')) as { report: { file: string; sha256: string } } & Record<string, unknown>
      const original = readFileSync(join(reportDir, rec.report.file))
      const place = (name: string, record: unknown, report: Buffer | null): string => {
        const d = join(dir, `bound-${name}`)
        mkdirSync(d, { mode: 0o700 })
        if (report) writeFileSync(join(d, rec.report.file), report)
        writeFileSync(join(d, 'record.json'), JSON.stringify(record), { mode: 0o600 })
        return join(d, 'record.json')
      }
      const flipped = JSON.parse(original.toString('utf8')) as { verification: Array<{ result: string }> }
      flipped.verification[0]!.result = 'fail'
      const arms: Array<[string, string]> = [
        ['report file absent', place('absent', rec, null)],
        ['report file changed by a byte', place('changed', rec, Buffer.concat([original, Buffer.from(' ')]))],
        ['report with a failing item, hash re-bound', (() => { const b = Buffer.from(JSON.stringify(flipped)); return place('failing', { ...rec, report: { ...rec.report, sha256: createHash('sha256').update(b).digest('hex') } }, b) })()],
        ['no bound report', place('unbound', { ...rec, report: null }, original)],
        ['load exit not OK', place('exit', { ...rec, loadExit: 'VERIFY_FAILED' }, original)],
        ['target not proved unchanged', place('target', { ...rec, targetUnchanged: false }, original)],
      ]
      for (const [label, file] of arms) {
        const r = await RUN(['--apply', '--rehearsal-record', file])()
        assert.equal(r.exitCode, 3, `${label}: ${r.stderr}`)
        assert.equal(await runRecords(), 0, label)
        assert.deepEqual(readdirSync(restoreDir), [], `${label}: no restore point`)
      }
      // Control: the same record beside its own, untouched report is accepted by the binding checks (the next test applies with it).
      assert.equal(createHash('sha256').update(original).digest('hex'), rec.report.sha256)
      precondition(t, 'binding arms', arms.length)
    })

    it('the pre-load rails refuse BEFORE the restore point: a grant in the installation env file, an enabled storefront, an armed cron, an unreadable crontab: exit 3, no dump, no run record, nothing changed', async (t) => {
      // Mutation: evaluate the pre-load rails only inside runLoad (after the dump) and the dump directory is no longer empty; remove the rails and the arm exits 0.
      const counts = await tableCounts()
      const withGrant = join(dir, 'installation-with-grant.env')
      writeFileSync(withGrant, `${readFileSync(envFile, 'utf8')}MINTSOFT_WRITE_ALLOWED=https://api.example.test|89\n`, { mode: 0o600 })
      chmodSync(withGrant, 0o600)
      const cronShim = (body: string): string => {
        const bin = join(dir, `shim-${createHash('sha256').update(body).digest('hex').slice(0, 8)}`)
        mkdirSync(bin, { recursive: true })
        writeFileSync(join(bin, 'crontab'), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
        chmodSync(join(bin, 'crontab'), 0o755)
        return bin
      }
      const writerCron = cronShim(`echo '*/5 * * * * curl -sf -K - "$BASE_URL/accounting-sync"'`)
      const brokenCron = cronShim('echo "crontab: cannot read the spool" >&2; exit 1')
      const arms: Array<[string, () => Promise<{ exitCode: number | null; stderr: string; stdout: string }>, RegExp, (() => Promise<void>) | null]> = [
        ['a grant in the installation env file', RUN(['--apply', '--rehearsal-record', recordFile], { envFile: withGrant }), /outbound grants: a write grant for Mintsoft is present/, null],
        ['the storefront enabled with credentials', RUN(['--apply', '--rehearsal-record', recordFile]), /connectors: the WooCommerce connector is enabled with store credentials/, null],
        ['an armed writing cron', RUN(['--apply', '--rehearsal-record', recordFile], { env: { PATH: `${writerCron}:${process.env.PATH}` } }), /crons: 1 active scheduled-job line\(s\) in the crontab could write/, null],
        ['an unreadable crontab', RUN(['--apply', '--rehearsal-record', recordFile], { env: { PATH: `${brokenCron}:${process.env.PATH}` } }), /crons: the crontab of the account running the load could not be read/, null],
      ]
      precondition(t, 'pre-load arms', arms.length)
      for (const [label, run, expected] of arms) {
        if (label.startsWith('the storefront')) await s.sql(`update settings set value = 'true' where key = 'plugin_woocommerce_enabled'`)
        try {
          const r = await run()
          assert.equal(r.exitCode, 3, `${label}: ${r.stderr}`)
          assert.match(r.stderr, expected, label)
          assert.ok(!r.stderr.includes('api.example.test') && !r.stderr.includes('accounting-sync'), `${label}: no value from the installation in the text`)
        } finally {
          if (label.startsWith('the storefront')) await s.sql(`update settings set value = 'false' where key = 'plugin_woocommerce_enabled'`)
        }
        assert.deepEqual(readdirSync(restoreDir), [], `${label}: no restore point was taken`)
        assert.equal(await runRecords(), 0, `${label}: no run record`)
        assert.equal(await tableCounts(), counts, `${label}: no table changed`)
      }
    })

    it('an apply with that record takes a restore point (mode 600, readable by pg_restore, restorable with row-count parity), loads, verifies, and ends VERIFIED', async (t) => {
      const beforeLoad = await tableCounts()
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
      // RESTORE PARITY: the restore point, restored into a database of its own, holds exactly the rows the target held when it was taken (counted table by table). A restore point that is only
      // readable (pg_restore --list) is not yet a way back. Mutation: dump with --schema-only (or the wrong database) and the restored counts differ from the pre-load counts.
      const parity = 'ims_restore_parity'
      await withClient(s.url, async (client) => { await client.query(`create database ${parity}`) })
      const lib = libpqEnvFromUrl(s.url).env
      const restored = spawnSync(join(pgBinDir(), 'pg_restore'), ['--no-owner', '--no-privileges', '--exit-on-error', '-d', parity, join(restoreDir, dumps[0]!)], { env: { PATH: process.env.PATH ?? '', ...lib, PGDATABASE: parity } as unknown as NodeJS.ProcessEnv, encoding: 'utf8' })
      assert.equal(restored.status, 0, restored.stderr)
      const parityUrl = databaseUrl(s.role, s.password, s.port, parity)
      const restoredCounts = await withClient(parityUrl, async (client) => {
        const names = (await client.query<{ table_name: string }>(`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`)).rows.map((x) => x.table_name)
        const rows = (await client.query<{ t: string; n: string }>(names.map((n) => `select '${n}' as t, count(*)::text as n from "${n}"`).join(' union all '))).rows
        return JSON.stringify(Object.fromEntries(rows.map((x) => [x.t, x.n]).sort()))
      })
      precondition(t, 'tables compared', Object.keys(JSON.parse(beforeLoad)).length)
      assert.equal(restoredCounts, beforeLoad, 'the restore point holds exactly the pre-load rows')
      assert.notEqual(restoredCounts, await tableCounts(), 'control: the loaded database differs from the restore point')
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
      // A path from the database is accepted only at the one place this load composes: a copy with the same bytes elsewhere is refused. Mutation: drop the path check and this resumes.
      const copyPath = join(restoreDir, 'copy-of-the-dump.dump')
      writeFileSync(copyPath, bytes, { mode: 0o600 })
      const recorded = (await runs('select facts from first_load_apply_runs'))[0] as { facts: { restorePoint: Record<string, unknown> } }
      await runs(`update first_load_apply_runs set facts = jsonb_set(facts, '{restorePoint,path}', to_jsonb($1::text))`, [copyPath])
      const elsewhere = await RUN(['--apply', '--rehearsal-record', recordFile, '--resume'])()
      assert.equal(elsewhere.exitCode, 3, elsewhere.stderr)
      assert.match(elsewhere.stderr, /not the one this load takes/)
      await runs(`update first_load_apply_runs set facts = jsonb_set(facts, '{restorePoint,path}', to_jsonb($1::text))`, [String(recorded.facts.restorePoint.path)])
      rmSync(copyPath)
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
        steps: ['suppliers', 'products', 'opening-stock', 'purchase-orders'],
        schemaHash: migrationsHash(checkoutMigrationNames(REPO)),
        build: readBuildIdentity(REPO),
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

  describe('a child that exits OK but whose report cannot be trusted never yields an OK record', () => {
    const attempt = async (stem: string, afterChild: (json: string) => void) => {
      await s.db.$disconnect()
      await runs('truncate products, suppliers, product_categories, purchase_orders, stock_movements, first_load_apply_runs, activity_logs restart identity cascade')
      const planDigest = (jsonOf(reportsIn().find((f) => f.includes('-plan-') && f.endsWith('.json'))!) as { manifestDigest: string }).manifestDigest
      return rehearse({
        targetEnv: Object.fromEntries(readFileSync(envFile, 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])),
        targetSystemId: systemId, manifestPath: manifest, manifestDigest: planDigest, steps: ['suppliers', 'products', 'opening-stock', 'purchase-orders'], schemaHash: migrationsHash(checkoutMigrationNames(REPO)), build: readBuildIdentity(REPO), repoRoot: REPO, root: rehearsalRoot, reportDir, reportStem: stem, operator: 'E2E Operator',
        log: () => undefined, hooks: { afterChild },
      })
    }
    // Mutation: derive the verdict from the child's exit code alone (the old shape) and every arm below records OK.
    const arms: Array<[string, (json: string) => void]> = [
      ['the report deleted', (json) => rmSync(json)],
      ['the report truncated to invalid JSON', (json) => writeFileSync(json, '{"tool": "first-load-apply", "manif')],
      ['the report of another load', (json) => { const r = JSON.parse(readFileSync(json, 'utf8')); r.manifestDigest = 'f'.repeat(64); writeFileSync(json, JSON.stringify(r)) }],
      ['the report with a failing verification item', (json) => { const r = JSON.parse(readFileSync(json, 'utf8')); r.verification[0].result = 'fail'; writeFileSync(json, JSON.stringify(r)) }],
      ['the report with one verification item dropped', (json) => { const r = JSON.parse(readFileSync(json, 'utf8')); r.verification = r.verification.slice(1); writeFileSync(json, JSON.stringify(r)) }],
      ['the report with one dropped and a duplicate as padding', (json) => { const r = JSON.parse(readFileSync(json, 'utf8')); r.verification = [...r.verification.slice(1), r.verification[1]]; writeFileSync(json, JSON.stringify(r)) }],
      ['the report with a step removed', (json) => { const r = JSON.parse(readFileSync(json, 'utf8')); r.steps = r.steps.slice(1); writeFileSync(json, JSON.stringify(r)) }],
      ['the report with no verification items', (json) => { const r = JSON.parse(readFileSync(json, 'utf8')); r.verification = []; writeFileSync(json, JSON.stringify(r)) }],
      ['the report naming another exit than the process', (json) => { const r = JSON.parse(readFileSync(json, 'utf8')); r.exit.name = 'VERIFY_FAILED'; writeFileSync(json, JSON.stringify(r)) }],
    ]
    arms.forEach(([label, tamper], i) => {
      it(label, async () => {
        const outcome = await attempt(`first-load-apply-rehearse-tamper-${i}`, tamper)
        assert.notEqual(outcome.record.verdict, 'OK')
        assert.notEqual(outcome.exit, 'OK')
        assert.notEqual(outcome.record.loadExit, 'OK')
        assert.equal(outcome.teardownComplete, true)
      })
    })
    it('CONTROL: untouched, the same call records OK with the report bound', async () => {
      const outcome = await attempt('first-load-apply-rehearse-control', () => undefined)
      assert.equal(outcome.record.verdict, 'OK', outcome.problems.join('; '))
      assert.ok(outcome.record.report && outcome.record.report.verificationItems > 0 && outcome.record.report.verificationFailed === 0)
      assert.equal(outcome.exit, 'OK')
    })
  })

  it('UNIVERSAL: nothing any run printed carries a secret of the scratch installation or a value of the prepared files', () => {
    const text = outputs.join('\n')
    assert.ok(outputs.length >= 20, `output chunks scanned: ${outputs.length}`)
    for (const secret of secrets) assert.ok(!text.includes(secret), 'a secret reached a command output')
    assert.doesNotMatch(text, /zqsent/i, 'a prepared-file value reached a command output')
  })
})
