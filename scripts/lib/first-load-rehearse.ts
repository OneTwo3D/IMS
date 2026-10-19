/**
 * THE REHEARSAL OF A FIRST LOAD: the whole load, steps, verification and census, on a COPY of the target in a throwaway cluster of its own.
 *
 * Why a copy and not the importers' own preview: a preview writes nothing, so on an empty database every downstream file fails to find what the earlier file would have created
 * (an opening-stock preview cannot see products, a purchase-order preview cannot see suppliers), and the purchase-order preview never reaches the code that needs an exchange
 * rate. Only a full apply on a copy proves the load. The target is only READ: a read-only connection, a custom-format `pg_dump`, and an exact row count of every table before and
 * after (a change makes the rehearsal not valid, because the copy is then not a copy of the target as it now is).
 *
 * THE COPY. A custom-format dump of the target is restored into a database named REHEARSAL_DATABASE in a cluster that this run initialises under `<root>/ims-rehearsal-*`, on a
 * loopback port nothing else holds, with a superuser role of its own and a random password. Credentials are passed to the client tools as environment variables of the child only
 * (never on a command line), and the child's env file is mode 600 inside the run directory and shredded in the teardown. The cluster is stopped by the PID captured at start and
 * confirmed to still be ours (scripts/rehearse-first-install.ts teardownRun, reused unchanged), in a `finally`.
 *
 * THE RUN ITSELF is a child process: this same command with `--apply --rehearsal-child-dir`, pointed at the copy. A child, because the application's database client reads its URL
 * once, when it is first imported; a process that has imported it for the target cannot be pointed at the copy. The child proves the database it is handed is the throwaway (its
 * name, and that its data directory is inside this run's directory) before it waives the need for a rehearsal record, which is the one thing it waives.
 *
 * WHAT A GREEN REHEARSAL DOES NOT SAY: that the target will behave like the copy under a concurrent writer (it is quiesced, not fenced), that the real data's timing or size will,
 * or that anything outside the database (a connector, a cron job) is quiet. It says the same files, through the same code, onto the same schema and configuration, load and verify.
 */
import { closeSync, constants as fsConstants, chmodSync, existsSync, fstatSync, fsyncSync, mkdirSync, mkdtempSync, openSync, realpathSync, statSync, writeSync } from 'node:fs'
import path from 'node:path'

import pg from 'pg'

import { freePort, pgBinDir, startCluster } from '../../tests/scripts/real-postgres-cluster'
import {
  RAM_BACKED, RUN_DIR_PREFIX, capturePostmaster, databaseUrl, filesystemType, ident, inheritedEnv, randomHex, runChild, socketPsql, teardownRun, withClient, type RunState,
} from '../rehearse-first-install'
import { checkAncestors } from '../../lib/ops/published-report'
import { type ApplyExitName } from '../../lib/first-load/apply/constants'
import { REHEARSAL_DATABASE, buildRehearsalRecord, exitNameOfCode, libpqEnvFromUrl, type RehearsalRecordFile } from '../../lib/first-load/apply/cli'
import { readRegularFile, sha256OfFile } from './first-load-apply-files'

const CHILD_TIMEOUT_MS = 90 * 60 * 1000
const DUMP_TIMEOUT_MS = 30 * 60 * 1000
const TABLE_NAME = /^[A-Za-z0-9_]{1,63}$/

export interface RehearseInput {
  /** The target's installation env, exactly as the env file gave it (its DATABASE_URL is the target's). */
  targetEnv: Readonly<Record<string, string>>
  targetSystemId: string
  manifestPath: string
  manifestDigest: string
  schemaHead: string
  repoRoot: string
  /** Parent directory of the throwaway cluster. */
  root: string
  /** Where the child publishes its report (an already prepared, trusted directory). */
  reportDir: string
  reportStem: string
  operator: string
  log: (line: string) => void
  /** Test seams. */
  hooks?: {
    afterRestore?: () => Promise<void>
    /** Runs after the child finished and before the target is counted again (a test changes the target here). */
    beforeTargetRecount?: () => Promise<void>
  }
}

export interface RehearseOutcome {
  /** The exit the parent command should report. */
  exit: ApplyExitName
  /** The child's own exit (the load's), or null when the child never ran. */
  loadExit: ApplyExitName | null
  record: RehearsalRecordFile
  targetUnchanged: boolean
  teardownComplete: boolean
  problems: string[]
  /** The child's report as published, with the digest of its JSON. */
  report: { json: string; sha256: string } | null
}

/** Exact `count(*)` of every base table, over a connection that cannot write. */
export async function countTargetTables(url: string): Promise<Record<string, number>> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000, options: '-c default_transaction_read_only=on', application_name: 'ims-first-load-apply' })
  await client.connect()
  try {
    const names = (await client.query<{ table_name: string }>(`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`)).rows.map((r) => r.table_name)
    if (names.length === 0 || names.some((n) => !TABLE_NAME.test(n))) throw new Error('the table list is empty or holds a name this reader does not trust')
    const rows = (await client.query<{ t: string; n: string }>(names.map((n) => `select '${n}' as t, count(*)::text as n from "${n}"`).join(' union all '))).rows
    const out: Record<string, number> = {}
    for (const row of rows) out[row.t] = Number(row.n)
    return out
  } finally {
    await client.end()
  }
}

export function sameCounts(a: Record<string, number>, b: Record<string, number>): boolean {
  const names = new Set([...Object.keys(a), ...Object.keys(b)])
  return [...names].every((name) => a[name] === b[name])
}

function toolChild(cmd: string, args: string[], env: Record<string, string>, timeoutMs: number) {
  return runChild({ cmd, args, env: { PATH: process.env.PATH ?? '', ...env }, cwd: '/', timeoutMs })
}

export async function rehearse(input: RehearseInput): Promise<RehearseOutcome> {
  const problems: string[] = []
  const record = (loadExit: ApplyExitName | null, targetUnchanged: boolean, teardownComplete: boolean): RehearsalRecordFile =>
    buildRehearsalRecord({ manifestDigest: input.manifestDigest, targetSystemId: input.targetSystemId, schemaHead: input.schemaHead, finishedAt: new Date(), loadExit, targetUnchanged, teardownComplete })
  const refused = (message: string): RehearseOutcome => ({ exit: 'PRECONDITION_REFUSED', loadExit: null, record: record(null, true, true), targetUnchanged: true, teardownComplete: true, problems: [message], report: null })

  // ---- Refusals: nothing has been created yet. ----
  if (typeof process.getuid === 'function' && process.getuid() === 0) return refused('refusing to rehearse as root: initdb will not run as root, and a rehearsal must not own files in an IMS tree. Run it as the account that owns the checkout.')
  try {
    pgBinDir()
  } catch {
    return refused('no PostgreSQL server binaries (initdb, pg_ctl) were found')
  }
  const parent = path.resolve(input.root)
  if (!existsSync(parent) || !statSync(parent).isDirectory()) return refused('--root is not a directory')
  const ancestors = checkAncestors(parent, '--root')
  if (ancestors !== null) return refused('--root has an ancestor that other accounts could modify')
  try {
    if (RAM_BACKED.has(filesystemType(parent))) return refused('--root is on a RAM-backed file system: a cluster there is held in RAM')
  } catch {
    return refused('the file-system type of --root cannot be determined')
  }
  const target = libpqEnvFromUrl(input.targetEnv.DATABASE_URL ?? '')
  if (target.problems.length > 0) return refused(target.problems[0]!)
  for (const needed of ['node_modules/.bin/tsx', 'scripts/first-load-apply.ts']) if (!existsSync(path.join(input.repoRoot, needed))) return refused(`${needed} not found under the checkout`)

  // ---- The target, before: it is only ever read. ----
  let before: Record<string, number>
  try {
    before = await countTargetTables(input.targetEnv.DATABASE_URL!)
  } catch {
    return refused('the target database could not be read')
  }

  const root = mkdtempSync(path.join(parent, RUN_DIR_PREFIX))
  chmodSync(root, 0o700)
  const state: RunState = { root, envFile: path.join(root, 'child.env'), envFileId: null, cluster: null, postmasterPid: null, postmaster: null, role: null, password: randomHex(24), secrets: [], teardown: null }
  let loadExit: ApplyExitName | null = null
  let report: RehearseOutcome['report'] = null
  try {
    // ---- The copy. ----
    const dumpFile = path.join(root, 'target.dump')
    const bin = pgBinDir()
    const dump = await toolChild(path.join(bin, 'pg_dump'), ['--format=custom', '--no-owner', '--no-privileges', `--file=${dumpFile}`], target.env, DUMP_TIMEOUT_MS)
    if (dump.exitCode !== 0) throw new RehearsalFailure('the target could not be dumped (pg_dump did not exit 0)')
    input.log('[rehearsal] the target was dumped (read only)')

    const port = await freePort()
    state.cluster = startCluster(root, 'pg', port, '127.0.0.1')
    state.postmaster = capturePostmaster(state.cluster.data)
    if (state.postmaster === null) throw new RehearsalFailure('the throwaway postmaster could not be identified from its data directory')
    state.postmasterPid = state.postmaster.pid
    const role = `rehearsal_${randomHex(4)}`
    state.role = role
    socketPsql(state.cluster, `create role ${ident(role)} superuser login password '${state.password}';\n`)
    socketPsql(state.cluster, `create database ${ident(REHEARSAL_DATABASE)} owner ${ident(role)};\n`)
    const copyUrl = databaseUrl(role, state.password, port, REHEARSAL_DATABASE)
    const copy = libpqEnvFromUrl(copyUrl)
    const restore = await toolChild(path.join(bin, 'pg_restore'), ['--no-owner', '--no-privileges', '--exit-on-error', `--dbname=${REHEARSAL_DATABASE}`, dumpFile], copy.env, DUMP_TIMEOUT_MS)
    if (restore.exitCode !== 0) throw new RehearsalFailure('the dump could not be restored into the throwaway database (pg_restore did not exit 0)')
    await input.hooks?.afterRestore?.()
    const copySystemId = await withClient(copyUrl, async (c) => (await c.query<{ id: string }>('select system_identifier::text as id from pg_control_system()')).rows[0]!.id)
    input.log(`[rehearsal] the copy is up on port ${port}`)

    // ---- The child's env file: the installation's own variables, with the database replaced. Created exclusively, mode 600, shredded in the teardown. ----
    const childEnv = { ...input.targetEnv, DATABASE_URL: copyUrl }
    const fd = openSync(state.envFile, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600)
    try {
      writeSync(fd, `${Object.entries(childEnv).map(([k, v]) => `${k}=${v}`).join('\n')}\n`)
      fsyncSync(fd)
      const info = fstatSync(fd)
      state.envFileId = { dev: info.dev, ino: info.ino, birthtimeMs: info.birthtimeMs }
    } finally {
      closeSync(fd)
    }
    mkdirSync(path.join(root, 'home'), { recursive: true })
    mkdirSync(path.join(root, 'npm-cache'), { recursive: true })

    const args = [
      'scripts/first-load-apply.ts', '--apply', '--rehearsal-child-dir', root, '--report-stem', input.reportStem,
      '--manifest', path.resolve(input.manifestPath), '--env-file', state.envFile, '--expect-db', REHEARSAL_DATABASE, '--expect-system-id', copySystemId,
      '--report-dir', input.reportDir, '--operator', input.operator,
    ]
    const child = await runChild({ cmd: path.join(input.repoRoot, 'node_modules/.bin/tsx'), args, env: inheritedEnv(root), cwd: input.repoRoot, timeoutMs: CHILD_TIMEOUT_MS })
    loadExit = exitNameOfCode(child.exitCode)
    if (child.timedOut) problems.push('the rehearsal child timed out and was stopped')
    if (loadExit === null) problems.push('the rehearsal child ended without one of the documented exit codes')
    input.log(`[rehearsal] the load on the copy ended ${loadExit ?? 'unknown'}`)
    const json = path.join(input.reportDir, `${input.reportStem}.json`)
    const hashed = sha256OfFile(json)
    if (hashed.ok) report = { json, sha256: hashed.sha256 }
    else problems.push('the rehearsal child published no report')
  } catch (error) {
    problems.push(error instanceof RehearsalFailure ? error.message : 'the rehearsal failed before the load could run')
  } finally {
    state.teardown = teardownRun(state)
  }
  const teardownComplete = teardownIsComplete(state)
  if (!teardownComplete) problems.push('the throwaway cluster or its files could not be removed completely; remove the leftover by hand')

  // ---- The target, after. ----
  await input.hooks?.beforeTargetRecount?.()
  let targetUnchanged = false
  try {
    targetUnchanged = sameCounts(before, await countTargetTables(input.targetEnv.DATABASE_URL!))
  } catch {
    problems.push('the target database could not be read again after the rehearsal')
  }
  if (!targetUnchanged) problems.push('the row counts of the target database differ from before the rehearsal: the copy is not a copy of the target as it now is, so this rehearsal is not valid')

  // The report the child published must be the one this load produced.
  if (report !== null) {
    const read = readRegularFile(report.json, 16 * 1024 * 1024)
    let parsed: { tool?: unknown; manifestDigest?: unknown; exit?: { name?: unknown } } = {}
    try { parsed = read.ok ? JSON.parse(read.bytes.toString('utf8')) : {} } catch { parsed = {} }
    if (parsed.tool !== 'first-load-apply' || parsed.manifestDigest !== input.manifestDigest || parsed.exit?.name !== loadExit) {
      problems.push('the report the rehearsal child published is not the report of this load')
      loadExit = null
    }
  }

  const rec = record(loadExit, targetUnchanged, teardownComplete)
  const exit: ApplyExitName = !teardownComplete ? 'REHEARSAL_TEARDOWN_INCOMPLETE' : rec.verdict === 'OK' && problems.length === 0 ? 'OK' : loadExit !== null && loadExit !== 'OK' ? loadExit : !targetUnchanged ? 'INTERNAL' : 'PRECONDITION_REFUSED'
  return { exit, loadExit, record: rec, targetUnchanged, teardownComplete, problems, report }
}

class RehearsalFailure extends Error {}

function teardownIsComplete(state: RunState): boolean {
  const t = state.teardown
  return t !== null && t.clusterStopped && t.envFileShredded && t.rootRemoved && t.errors.length === 0 && t.orphanPids.length === 0
}

/** A path inside the run directory, resolved through symlinks: the child's proof that a data directory belongs to this rehearsal. */
export function insideRunDir(candidate: string, runDir: string): boolean {
  try {
    const real = realpathSync(candidate)
    const root = realpathSync(runDir)
    return path.basename(root).startsWith(RUN_DIR_PREFIX) && (real === root || real.startsWith(`${root}${path.sep}`))
  } catch {
    return false
  }
}
