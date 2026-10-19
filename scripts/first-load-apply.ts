#!/usr/bin/env tsx
/**
 * FIRST-LOAD APPLY (npm run first-load:apply): loads a prepared first-load run into an installation through the application's own importers, verifies it, and records it.
 *
 *   --rehearse (the default)   the whole load on a COPY of the target in a throwaway cluster; the target is only read, and proved unchanged. Writes a rehearsal record.
 *   --plan                     read the target and say what a load would do. Writes nothing.
 *   --apply --rehearsal-record <file> [--resume]
 *                              load the target: restore point first, then each step under its lock, then the verification and census.
 *
 * Exit codes: lib/first-load/apply/constants.ts APPLY_EXIT_CODE_TABLE (printed by --help; docs/first-load-apply.md has the same table, and a test compares them).
 *
 * THE APPLICATION MUST BE STOPPED for --apply (docs/first-load-apply.md, "PRECONDITION"). The runner proves nobody else is connected; it does not stop anybody connecting.
 *
 * HARDENING. The target is named by an env file read by path (a regular file, owned by the caller, mode 600); no secret is ever an argument, and an argument that looks like a
 * connection string with a credential is refused. The process environment is REPLACED by a short whitelist plus the file's variables before the application's database client is
 * imported, so an inherited DATABASE_URL, PG variable or outbound grant cannot change where the run writes or what it believes. The target must be confirmed twice by what the server says
 * about itself: `--expect-db` against current_database() and `--expect-system-id` against the cluster's system identifier. Reports are created exclusively (mode 600) in a directory
 * that only this account can use, Markdown first and the JSON last as the commit record.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, constants as fsConstants, lstatSync, openSync, rmSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import pg from 'pg'

import {
  APPLY_EXIT_CODES, REHEARSAL_MAX_AGE_HOURS, REHEARSAL_RECORD_STEM_PREFIX, RUNNER_APPLICATION_NAME, exitOperatorText, type ApplyExitName,
} from '../lib/first-load/apply/constants'
import { REHEARSAL_DATABASE, buildRunnerEnv, checkRecordBinding, checkRecordReportFile, checkRecordSchema, exitCodeOf, helpText, libpqEnvFromUrl, parseCliArgs, reportStem, type CliArgs } from '../lib/first-load/apply/cli'
import { readPreparedDir, PreparedDirError } from '../lib/first-load/apply/io'
import { ApplyManifestError, parseApplyManifest, type ApplyManifest } from '../lib/first-load/apply/manifest'
import { checkRehearsalGate, type ApplyResult } from '../lib/first-load/apply/orchestrate'
import { loadPreparedRun, type PreparedRun } from '../lib/first-load/apply/prepared'
import { buildApplyReport, renderApplyMarkdown, type ReportRestorePoint, type ReportTarget } from '../lib/first-load/apply/report'
import { countMigrationDirectories, lastMigrationName } from '../lib/first-load/apply/db/migrations'
import { pgBinDir } from '../tests/scripts/real-postgres-cluster'
import {
  prepareReportDir, publishRecord, publishReportPair, readEnvFile, readRegularFile, readSmallFile, sha256OfFile, ReportDirReplacedError, type ReportDir,
} from './lib/first-load-apply-files'
import { insideRunDir, rehearse } from './lib/first-load-rehearse'

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')

export interface CliIo {
  out: (text: string) => void
  err: (text: string) => void
}

interface Identity extends ReportTarget {
  dataDirectory: string
}

/** What the server says about itself. A read-only connection: this call can write nothing. */
async function readIdentity(url: string): Promise<Identity> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000, options: '-c default_transaction_read_only=on', application_name: RUNNER_APPLICATION_NAME })
  await client.connect()
  try {
    const row = (await client.query<{ db: string; sid: string; migrations: number; dir: string }>(
      `select current_database() as db, (select system_identifier::text from pg_control_system()) as sid, (select count(*)::int from _prisma_migrations) as migrations, current_setting('data_directory') as dir`,
    )).rows[0]!
    return { database: row.db, systemId: row.sid, migrations: row.migrations, dataDirectory: row.dir }
  } finally {
    await client.end()
  }
}

function replaceProcessEnv(env: Record<string, string>): void {
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, env)
}

/** A restore point: a custom-format dump written to a file that did not exist, mode 600, read back with pg_restore --list. The runner never restores by itself. */
function takeRestorePoint(dir: string, runId: string, libpq: Record<string, string>): { ok: true; value: ReportRestorePoint } | { ok: false; problem: string } {
  const file = path.join(dir, `first-load-${runId}.dump`)
  let fd: number
  try {
    fd = openSync(file, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600)
  } catch {
    return { ok: false, problem: 'the restore point file already exists or cannot be created (it is never overwritten)' }
  }
  let dumped
  try {
    dumped = spawnSync(path.join(pgBinDir(), 'pg_dump'), ['--format=custom', '--no-owner'], { env: { PATH: process.env.PATH ?? '', ...libpq } as unknown as NodeJS.ProcessEnv, stdio: ['ignore', fd, 'pipe'], timeout: 30 * 60 * 1000 })
  } finally {
    closeSync(fd)
  }
  const discard = (problem: string) => { rmSync(file, { force: true }); return { ok: false as const, problem } }
  if (dumped.status !== 0) return discard('the restore point could not be taken (pg_dump did not exit 0); nothing was written to the database')
  const hashed = sha256OfFile(file)
  if (!hashed.ok || hashed.bytes === 0) return discard('the restore point file is empty or unreadable')
  const listed = spawnSync(path.join(pgBinDir(), 'pg_restore'), ['--list', file], { env: { PATH: process.env.PATH ?? '' } as unknown as NodeJS.ProcessEnv, stdio: ['ignore', 'ignore', 'ignore'], timeout: 5 * 60 * 1000 })
  if (listed.status !== 0) return discard('pg_restore cannot read the restore point (it was removed); nothing was written to the database')
  return { ok: true, value: { path: file, sha256: hashed.sha256, bytes: hashed.bytes, listed: true } }
}

/** The directory restore points go into: it exists, is a real directory owned by the caller and closed to group and others. Not created (a typo would make a new one). */
function checkRestoreDir(dir: string): string | null {
  try {
    const info = lstatSync(dir)
    if (info.isSymbolicLink() || !info.isDirectory()) return 'restorePointDir is not a real directory'
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) return 'restorePointDir is not owned by the account running this command'
    if ((info.mode & 0o077) !== 0) return 'restorePointDir is accessible to group or others; it must be mode 700'
    return null
  } catch {
    return 'restorePointDir does not exist; create it (mode 700) first'
  }
}

export async function runCli(argv: readonly string[], io: CliIo, parentEnv: Readonly<Record<string, string | undefined>> = process.env): Promise<number> {
  const parsed = parseCliArgs(argv)
  if (parsed.kind === 'help') { io.out(helpText()); return APPLY_EXIT_CODES.OK }
  if (parsed.kind === 'usage') {
    io.err(`${parsed.problems.map((p) => `first-load-apply: ${p}`).join('\n')}\n(run with --help for the usage and the exit codes)\n`)
    return APPLY_EXIT_CODES.USAGE
  }
  const args = parsed.args
  const stopWith = (name: ApplyExitName, problems: string[]): number => {
    io.err(`${problems.map((p) => `first-load-apply: ${p}`).join('\n')}\nfirst-load-apply: ${name} (exit ${exitCodeOf(name)})\n${exitOperatorText(name) === '' ? '' : `${exitOperatorText(name)}\n`}`)
    return exitCodeOf(name)
  }
  const now = new Date()

  // ---- 1. Everything that needs no database: the report directory, the manifest, the prepared run. Nothing is written but an empty directory. ----
  const reportDir = prepareReportDir(args.reportDir)
  if (!reportDir.ok) return stopWith('USAGE', [reportDir.problem])
  const manifestFile = readSmallFile(args.manifest)
  if (!manifestFile.ok) return stopWith('USAGE', [`the apply manifest is ${manifestFile.reason}`])
  let manifest: ApplyManifest
  try {
    manifest = parseApplyManifest(manifestFile.text)
  } catch (error) {
    return stopWith('USAGE', error instanceof ApplyManifestError ? error.problems : ['the apply manifest cannot be used'])
  }
  const base = path.dirname(path.resolve(args.manifest))
  let files
  try {
    files = readPreparedDir(path.resolve(base, manifest.preparedDir))
  } catch (error) {
    return stopWith('USAGE', [error instanceof PreparedDirError ? error.message : 'the prepared directory cannot be read'])
  }
  const readBytes = (p: string): Uint8Array | null => {
    const read = readRegularFile(path.resolve(base, p), 64 * 1024 * 1024)
    return read.ok ? read.bytes : null
  }
  const woo = manifest.wooSnapshot ? { snapshot: readBytes(manifest.wooSnapshot.snapshot), provenance: readBytes(manifest.wooSnapshot.provenance), variantParents: readBytes(manifest.wooSnapshot.variantParents) } : null
  const loaded = loadPreparedRun({ manifest, files, woo })
  if (!loaded.ok) return stopWith('USAGE', loaded.problems)
  const prepared: PreparedRun = loaded.run

  // ---- 2. The environment, replaced before the application's database client exists. ----
  const envFile = readEnvFile(args.envFile)
  if (!envFile.ok) return stopWith('USAGE', [envFile.problem])
  const built = buildRunnerEnv(envFile.env, parentEnv, parentEnv.HOME ?? '/tmp')
  if (built.problems.length > 0) return stopWith('USAGE', built.problems)
  const targetUrl = built.env.DATABASE_URL!
  replaceProcessEnv(built.env)

  // ---- 3. The target, by what the server says about itself. ----
  let identity: Identity
  try {
    identity = await readIdentity(targetUrl)
  } catch {
    return stopWith('PRECONDITION_REFUSED', ['the target database could not be read (no connection, or it is not an IMS database)'])
  }
  if (identity.database !== args.expectDb) return stopWith('PRECONDITION_REFUSED', ['--expect-db does not equal the database the server reports; the target is not the database you named'])
  if (identity.systemId !== args.expectSystemId) return stopWith('PRECONDITION_REFUSED', ['--expect-system-id does not equal the cluster system identifier the server reports; the target is not the cluster you named'])
  if (args.rehearsalChild !== null) {
    // The child may waive the need for a rehearsal record only on the throwaway database its parent made: by name, and by its data directory being inside the parent's run directory.
    if (identity.database !== REHEARSAL_DATABASE || !insideRunDir(identity.dataDirectory, args.rehearsalChild.runDir)) {
      return stopWith('PRECONDITION_REFUSED', ['a rehearsal child may run only on the throwaway database its rehearsal made; this is not it'])
    }
  }

  const expectedMigrationCount = countMigrationDirectories(REPO_ROOT)
  if (identity.migrations !== expectedMigrationCount) {
    return stopWith('PRECONDITION_REFUSED', [`the target records ${identity.migrations} migration(s) and this checkout has ${expectedMigrationCount}: run the checkout that matches the installed schema (or migrate first)`])
  }

  const stem = reportStem(args.mode, prepared.manifest.runId, now)
  const target: ReportTarget = { database: identity.database, systemId: identity.systemId, migrations: identity.migrations }

  // ---- 4. Modes. ----
  if (args.mode === 'rehearse') return rehearseMode(args, io, { prepared, targetEnv: envFile.env, identity, reportDir: reportDir.value, stem, now, stopWith })

  // The database side is imported only now: the client reads DATABASE_URL when first imported.
  const { db } = await import('../lib/db')
  const { createDbPorts, RESTORE_POINT_FACT } = await import('../lib/first-load/apply/db/ports')
  const { createJournal, loadFacts } = await import('../lib/first-load/apply/db/journal')
  const { runLoad } = await import('../lib/first-load/apply/orchestrate')
  const finishDb = async () => { await Promise.race([db.$disconnect(), new Promise<void>((resolve) => setTimeout(resolve, 5_000).unref())]) }
  try {
    const verification = { outboundEnv: { ...process.env }, expectedMigrationCount }
    let restorePoint: ReportRestorePoint | null = null
    let rehearsalRecord: unknown = null
    const isRehearsalChild = args.rehearsalChild !== null

    if (args.mode === 'apply' && !isRehearsalChild) {
      // The rehearsal gate, checked here too BEFORE a restore point is taken (the core checks it again before it reads the database).
      const recordFile = readSmallFile(args.rehearsalRecord!)
      if (!recordFile.ok) return stopWith('USAGE', [`the rehearsal record is ${recordFile.reason}`])
      try {
        rehearsalRecord = JSON.parse(recordFile.text)
      } catch {
        return stopWith('USAGE', ['the rehearsal record is not valid JSON'])
      }
      const gate = checkRehearsalGate(rehearsalRecord, { manifestDigest: prepared.manifestDigest, systemId: identity.systemId, now, maxAgeHours: REHEARSAL_MAX_AGE_HOURS })
      if (gate.length > 0) return stopWith('PRECONDITION_REFUSED', gate)
      const schema = checkRecordSchema(rehearsalRecord, lastMigrationName(REPO_ROOT))
      if (schema.length > 0) return stopWith('PRECONDITION_REFUSED', schema)
      // The record's verdict is not taken on its word: it must carry every bound field, and the child report it binds is re-read from beside the record and re-validated.
      const binding = checkRecordBinding(rehearsalRecord)
      if (binding.length > 0) return stopWith('PRECONDITION_REFUSED', binding)
      const bound = (rehearsalRecord as { report: { file: string } }).report.file
      const boundRead = readRegularFile(path.join(path.dirname(path.resolve(args.rehearsalRecord!)), bound), 16 * 1024 * 1024)
      if (!boundRead.ok) return stopWith('PRECONDITION_REFUSED', ['the report the rehearsal record binds cannot be read next to the record'])
      let boundParsed: unknown = null
      try { boundParsed = JSON.parse(boundRead.bytes.toString('utf8')) } catch { boundParsed = null }
      const boundProblems = checkRecordReportFile(rehearsalRecord, createHash('sha256').update(boundRead.bytes).digest('hex'), boundParsed, prepared.manifestDigest)
      if (boundProblems.length > 0) return stopWith('PRECONDITION_REFUSED', boundProblems)
      const restoreProblem = checkRestoreDir(prepared.manifest.restorePointDir)
      if (restoreProblem !== null) return stopWith('PRECONDITION_REFUSED', [restoreProblem])

      let existing
      try {
        existing = await createJournal().load()
      } catch {
        return stopWith('PRECONDITION_REFUSED', ['the run record could not be read; an unreadable state is never assumed to be empty'])
      }
      if (existing !== null && !args.resume) return stopWith('PRECONDITION_REFUSED', ['a run record already exists in this database; use --resume for the same load'])
      if (existing === null && args.resume) return stopWith('PRECONDITION_REFUSED', ['--resume was given but no run record exists for this database'])
      if (existing !== null) {
        // A resume needs the restore point the first attempt took, unchanged: it is the only way back.
        let recorded: unknown
        try {
          recorded = (await loadFacts())[RESTORE_POINT_FACT]
        } catch {
          return stopWith('PRECONDITION_REFUSED', ['the run record could not be read'])
        }
        const r = recorded as { path?: unknown; sha256?: unknown; bytes?: unknown } | undefined
        if (!r || typeof r.path !== 'string' || typeof r.sha256 !== 'string' || typeof r.bytes !== 'number') return stopWith('PRECONDITION_REFUSED', ['the run record names no restore point; this load was begun without one and cannot be resumed'])
        const hashed = sha256OfFile(r.path)
        if (!hashed.ok || hashed.sha256 !== r.sha256 || hashed.bytes !== r.bytes) return stopWith('PRECONDITION_REFUSED', ['the recorded restore point is missing or has changed; do not resume without a way back'])
        restorePoint = { path: r.path, sha256: r.sha256, bytes: r.bytes, listed: true }
      } else {
        const libpq = libpqEnvFromUrl(targetUrl)
        if (libpq.problems.length > 0) return stopWith('PRECONDITION_REFUSED', libpq.problems)
        const taken = takeRestorePoint(prepared.manifest.restorePointDir, prepared.manifest.runId, libpq.env)
        if (!taken.ok) return stopWith('PRECONDITION_REFUSED', [taken.problem])
        restorePoint = taken.value
      }
    }

    const ports = createDbPorts(prepared, {
      operator: args.operator,
      verification,
      ...(restorePoint ? { restorePoint: { path: restorePoint.path, sha256: restorePoint.sha256, bytes: restorePoint.bytes } } : {}),
    })
    const windowStart = new Date()
    const result: ApplyResult = await runLoad(prepared, ports, {
      mode: args.mode === 'plan' ? 'plan' : 'apply',
      resume: args.resume,
      rehearsal: rehearsalRecord,
      systemId: identity.systemId,
      now,
      maxRehearsalAgeHours: REHEARSAL_MAX_AGE_HOURS,
      ...(isRehearsalChild ? { thisIsTheRehearsal: true as const } : {}),
    })
    const report = buildApplyReport({ prepared, result, target, restorePoint, window: { start: windowStart.toISOString(), end: new Date().toISOString() } })
    return publishAndPrint(io, reportDir.value, args.rehearsalChild?.reportStem ?? stem, report, result.exit, result.problems, restorePoint)
  } finally {
    await finishDb()
  }
}

function publishAndPrint(io: CliIo, dir: ReportDir, stem: string, report: ReturnType<typeof buildApplyReport>, exit: ApplyExitName, problems: string[], restorePoint: ReportRestorePoint | null): number {
  let paths: { json: string; markdown: string } | null = null
  let finalExit = exit
  try {
    paths = publishReportPair(dir, stem, report as unknown as Record<string, unknown>, renderApplyMarkdown(report))
  } catch (error) {
    // The report is the evidence of the run: a run whose report could not be written is a defect of the run, not a success.
    problems = [...problems, error instanceof ReportDirReplacedError ? error.message : 'the report could not be written']
    finalExit = exit === 'OK' ? 'INTERNAL' : exit
  }
  const lines: string[] = [`first-load-apply: ${finalExit} (exit ${exitCodeOf(finalExit)})`]
  for (const step of report.steps) lines.push(`  ${step.step}: ${step.status}, emitted ${step.emitted}, created ${step.created}, skipped ${step.skippedExisting}, failed ${step.failed}`)
  for (const problem of problems) lines.push(`  problem: ${problem}`)
  const text = exitOperatorText(finalExit)
  if (text !== '') lines.push(text)
  if (finalExit !== 'OK' && restorePoint) lines.push(`Restore point: ${restorePoint.path} (SHA-256 ${restorePoint.sha256})`)
  if (paths) lines.push(`Report: ${paths.json}`, `Report: ${paths.markdown}`)
  else lines.push('The report could not be written; it is printed above.')
  ;(finalExit === 'OK' ? io.out : io.err)(`${lines.join('\n')}\n`)
  return exitCodeOf(finalExit)
}

async function rehearseMode(
  args: CliArgs,
  io: CliIo,
  ctx: { prepared: PreparedRun; targetEnv: Record<string, string>; identity: Identity; reportDir: ReportDir; stem: string; now: Date; stopWith: (name: ApplyExitName, problems: string[]) => number },
): Promise<number> {
  const outcome = await rehearse({
    targetEnv: ctx.targetEnv,
    targetSystemId: ctx.identity.systemId,
    manifestPath: args.manifest,
    manifestDigest: ctx.prepared.manifestDigest,
    schemaHead: lastMigrationName(REPO_ROOT),
    repoRoot: REPO_ROOT,
    root: args.root,
    reportDir: ctx.reportDir.dir,
    reportStem: ctx.stem,
    operator: args.operator,
    log: (line) => io.err(`${line}\n`),
  })
  let recordFile: string | null = null
  try {
    recordFile = publishRecord(ctx.reportDir, `${REHEARSAL_RECORD_STEM_PREFIX}${ctx.prepared.manifest.runId}-${ctx.stem.split('-').pop()}.json`, `${JSON.stringify(outcome.record, null, 2)}\n`)
  } catch {
    outcome.problems.push('the rehearsal record could not be written')
  }
  const lines = [`first-load-apply (rehearsal): ${outcome.exit} (exit ${exitCodeOf(outcome.exit)})`, `  the load on the copy ended: ${outcome.loadExit ?? 'it did not run'}`, `  the target was only read, and its table counts were ${outcome.targetUnchanged ? 'unchanged' : 'CHANGED'}`]
  for (const problem of outcome.problems) lines.push(`  problem: ${problem}`)
  lines.push(`  rehearsal verdict: ${outcome.record.verdict}`)
  const text = exitOperatorText(outcome.exit)
  if (text !== '') lines.push(text)
  if (outcome.report) lines.push(`Report: ${outcome.report.json}`)
  if (recordFile) lines.push(`Rehearsal record: ${recordFile}`)
  ;(outcome.exit === 'OK' ? io.out : io.err)(`${lines.join('\n')}\n`)
  return exitCodeOf(outcome.exit)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const flushAndExit = (code: number): void => {
    // The application's lock pool cannot be closed from here, so the process ends explicitly once the output is flushed.
    process.stderr.write('', () => process.stdout.write('', () => process.exit(code)))
  }
  runCli(process.argv.slice(2), { out: (t) => process.stdout.write(t), err: (t) => process.stderr.write(t) }).then(flushAndExit, (error: unknown) => {
    process.stderr.write(`first-load-apply: internal error: ${error instanceof Error ? error.name : 'Error'} (${exitOperatorText('INTERNAL')})\n`)
    flushAndExit(APPLY_EXIT_CODES.INTERNAL)
  })
}

