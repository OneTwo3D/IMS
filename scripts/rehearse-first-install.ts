#!/usr/bin/env tsx
/**
 * FRESH-INSTALL REHEARSAL (npm run rehearse:first-install).
 *
 * Rehearses the first install of a production IMS instance, WITHOUT scripts/install.sh, on a
 * throwaway PostgreSQL cluster of its own, and writes a readiness report (JSON and Markdown):
 *
 *   prisma migrate deploy -> npm run db:seed -> scripts/provision-instance.mjs
 *   then: seeded rows, isBaseCurrencyLocked(), system_identifier, preflight:production,
 *   validate:db, invariant-check:preflight, outbound:status (once the script exists), and a
 *   pg_dump restore point restored into a SECOND database with row-count and md5 parity per table.
 *
 * Usage:   npm run rehearse:first-install -- [--root <dir>] [--report-dir <dir>]
 *   --root <dir>        parent directory for the throwaway cluster (default /var/tmp; refused on a
 *                       RAM-backed file system). Each run creates its own ims-rehearsal-* directory,
 *                       so a re-run never meets the previous run's cluster.
 *   --report-dir <dir>  where the report is written (default /var/tmp/ims-rehearsal-reports).
 *
 * Exit codes (documented once: docs/installation.md, "Fresh-install rehearsal"; the table is
 * REHEARSAL_EXIT in lib/ops/first-install-rehearsal.ts and a test compares the two):
 *   0 GREEN   1 RED   2 refused to start   3 teardown incomplete
 *
 * WHAT IT NEVER DOES. It never reads an inherited DATABASE_URL: every child gets a whitelisted
 * environment built from the throwaway cluster's own env file, and `assertThrowawayDatabaseUrl`
 * refuses any other URL before a process is spawned or a connection opened. SMTP stays unset, no
 * connector credential or outbound grant is in any environment, and nothing leaves the loopback
 * interface. The cluster's superuser is a role of its own with a random password, written to a
 * mode-600 env file inside the run directory (never on a command line) and shredded in the teardown.
 *
 * THE TEARDOWN RUNS IN A `finally`: whether a step failed, threw, or the process was signalled.
 * Processes are stopped by the PID captured at start-up and never by name.
 */

import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  accessSync,
  chmodSync,
  closeSync,
  fstatSync,
  fsyncSync,
  openSync,
  writeSync,
  lstatSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import pg from 'pg'

import {
  EXPECTED_BASE_CURRENCY,
  OUTBOUND_STATUS_SCRIPT,
  REHEARSAL_EXIT,
  REHEARSAL_EXIT_MEANING,
  REHEARSAL_INSTANCE_ROLE_VAR,
  RehearsalGuardError,
  STEP_CATALOGUE,
  type ParityResult,
  type RehearsalExitCode,
  type RehearsalReport,
  type SeededRowFacts,
  type StepDefinition,
  type StepId,
  type StepResult,
  type TableFingerprint,
  type TeardownResult,
  assertNoConnectorEnv,
  assertThrowawayDatabaseUrl,
  assessBaseCurrencyLock,
  assessOutboundStatus,
  BASE_CURRENCY_LOCK_TABLES,
  assessParity,
  assessSeededRows,
  buildReport,
  compareParity,
  outboundStatusScriptPresent,
  redactSecrets,
  renderMarkdown,
} from '../lib/ops/first-install-rehearsal.ts'
import { type Cluster, currentUser, freePort, pgBinDir, startCluster, toolEnv } from '../tests/scripts/real-postgres-cluster.ts'

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const DEFAULT_PARENT = '/var/tmp'
const DEFAULT_REPORT_DIR = '/var/tmp/ims-rehearsal-reports'
const RUN_DIR_PREFIX = 'ims-rehearsal-'
const SOURCE_DATABASE = 'ims_rehearsal'
const RESTORE_DATABASE = 'ims_rehearsal_restore'
const CHILD_TIMEOUT_MS = 15 * 60 * 1000
const OUTPUT_TAIL_BYTES = 16 * 1024

/** Seams for the rehearsal's own tests. The command line does not reach any of them. */
export type RehearsalHooks = {
  beforeStep?: (id: StepId) => void | Promise<void>
  /** Runs once the cluster is up and before any step; throwing aborts the run (the catch-all path). */
  afterClusterStart?: () => void | Promise<void>
  /** Runs inside teardown after the first identity check and before the stop, so a test can replace the postmaster in that gap. */
  betweenIdentityAndStop?: () => void
  /** Runs just before the report is published, with the run's report directory path (a test plants things there). */
  beforePublish?: (outDir: string) => void
  /** Replaces the report file writer, so a test can fail one of the two report files. */
  writeReportFile?: (file: string, data: string) => void
  /** Replaces the cluster starter, so a test can make a start fail after the postmaster has forked. */
  clusterStarter?: typeof startCluster
  afterProvision?: (client: pg.Client) => Promise<void>
  afterRestore?: (client: pg.Client) => Promise<void>
  tamperStepEnv?: (id: StepId, env: Record<string, string>) => void
}

export type RehearsalOptions = {
  repoRoot?: string
  parentDir?: string
  reportDir?: string
  /** Run only these steps; the rest are omitted from the report. Used by tests, never by the CLI. */
  only?: ReadonlySet<StepId>
  hooks?: RehearsalHooks
  log?: (line: string) => void
}

export type RehearsalOutcome = {
  exitCode: RehearsalExitCode
  report: RehearsalReport | null
  refusal?: string
  reportPaths?: { json: string; markdown: string }
  /** The run completed but its report files could not be written; the exit code is then at least RED. */
  reportWriteError?: string
  runRoot?: string
}

type ChildResult = { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }
type StepOutcome = { status: 'passed' | 'failed'; reason?: string; detail?: Record<string, unknown>; required?: boolean; skipped?: boolean }

type RunState = {
  root: string
  envFile: string
  /** device and inode of the env file, recorded when this run created it */
  envFileId: FileIdentity | null
  cluster: Cluster | null
  postmasterPid: number | null
  postmaster: PostmasterIdentity | null
  betweenIdentityAndStop?: () => void
  role: string | null
  password: string
  secrets: string[]
  teardown: TeardownResult | null
}

// ---------------------------------------------------------------------------------------------
// Small process and file-system helpers.
// ---------------------------------------------------------------------------------------------

/** The file-system type under a path, from `stat -f`. */
function filesystemType(target: string): string {
  return execFileSync('stat', ['-f', '-c', '%T', target], { encoding: 'utf8', env: toolEnv() }).trim()
}

const RAM_BACKED = new Set(['tmpfs', 'ramfs'])

function readProcStat(pid: number): { state: string; ppid: number } | null {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const match = /^\d+ \([\s\S]*\) (\S) (\d+)/.exec(raw)
    return match ? { state: match[1]!, ppid: Number(match[2]) } : null
  } catch {
    return null
  }
}

/** A live, non-zombie process. */
export function processIsAlive(pid: number): boolean {
  const stat = readProcStat(pid)
  return stat !== null && stat.state !== 'Z'
}

/** A postmaster as this run identified it: pid AND start time AND data directory, so a reused pid is not mistaken for it. */
export type PostmasterIdentity = { pid: number; startTicks: string; dataDir: string; pidFileStart: string }

export function readStartTicks(pid: number): string | null {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const tokens = raw.slice(raw.lastIndexOf(')') + 2).split(' ')
    return tokens[19] ?? null // field 22, `starttime`
  } catch {
    return null
  }
}

/** A process's start time as seconds since the epoch, from /proc (boot time + starttime ticks / 100). */
export function processStartEpochSeconds(pid: number): number | null {
  const ticks = readStartTicks(pid)
  if (ticks === null) return null
  try {
    const btime = /^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'))
    return btime ? Number(btime[1]) + Number(ticks) / 100 : null
  } catch {
    return null
  }
}

function cmdlineOf(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ')
  } catch {
    return ''
  }
}

/**
 * Identify the postmaster that owns `dataDir` from the directory's OWN postmaster.pid, whether or not
 * pg_ctl reported success: a start that fails after the fork leaves a running server and no handle.
 * Null unless the file names this directory and a live process with that pid is running from it.
 */
export function capturePostmaster(dataDir: string): PostmasterIdentity | null {
  let lines: string[]
  try {
    lines = readFileSync(path.join(dataDir, 'postmaster.pid'), 'utf8').split('\n')
  } catch {
    return null
  }
  const pid = Number(lines[0])
  if (!Number.isInteger(pid) || pid <= 1 || lines[1] !== dataDir || !processIsAlive(pid)) return null
  // It must BE a postmaster started on this directory: argv[0] is `postgres` and `-D <dir>` is among
  // its arguments. A process that merely mentions the directory (a shell, an editor) is not one.
  const argv = cmdlineOf(pid).split(' ')
  const dFlag = argv.indexOf('-D')
  if (path.basename(argv[0] ?? '') !== 'postgres' || dFlag === -1 || argv[dFlag + 1] !== dataDir) return null
  // And the pid file's own start record must agree with when that process actually started, so a
  // stale file whose pid was reused cannot be mistaken for its writer.
  const recorded = Number(lines[2])
  const actual = processStartEpochSeconds(pid)
  if (!Number.isFinite(recorded) || actual === null || Math.abs(recorded - actual) > 3) return null
  const startTicks = readStartTicks(pid)
  if (startTicks === null) return null
  return { pid, startTicks, dataDir, pidFileStart: lines[2]! }
}

/** The data directory's postmaster.pid still names this pid, this directory and this start record: what `pg_ctl -D` is about to act on. */
export function pidFileStillNames(identity: PostmasterIdentity): boolean {
  try {
    const lines = readFileSync(path.join(identity.dataDir, 'postmaster.pid'), 'utf8').split('\n')
    return Number(lines[0]) === identity.pid && lines[1] === identity.dataDir && lines[2] === identity.pidFileStart
  } catch {
    return false
  }
}

/** The process at that pid is still the one captured: same start time, still running from the same directory. */
export function postmasterIsStillOurs(identity: PostmasterIdentity): boolean {
  return processIsAlive(identity.pid) && readStartTicks(identity.pid) === identity.startTicks && cmdlineOf(identity.pid).includes(identity.dataDir)
}

function listPids(): number[] {
  return readdirSync('/proc').filter((name) => /^\d+$/.test(name)).map(Number)
}

/** Every descendant of `rootPid`, by parent-pid links. */
export function descendantsOf(rootPid: number): number[] {
  const parentOf = new Map<number, number>()
  for (const pid of listPids()) {
    const stat = readProcStat(pid)
    if (stat) parentOf.set(pid, stat.ppid)
  }
  const found: number[] = []
  const queue = [rootPid]
  while (queue.length > 0) {
    const parent = queue.shift()!
    for (const [pid, ppid] of parentOf) {
      if (ppid === parent && !found.includes(pid)) {
        found.push(pid)
        queue.push(pid)
      }
    }
  }
  return found
}

/** Live processes (other than this one) whose command line names `needle`. */
export function processesNaming(needle: string): number[] {
  const hits: number[] = []
  for (const pid of listPids()) {
    if (pid === process.pid) continue
    try {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ')
      if (cmdline.includes(needle) && processIsAlive(pid)) hits.push(pid)
    } catch {
      // The process exited between the listing and the read.
    }
  }
  return hits
}

function tail(text: string, bytes = OUTPUT_TAIL_BYTES): string {
  return text.length > bytes ? text.slice(text.length - bytes) : text
}

/**
 * NOT NODE_OPTIONS, NODE_PATH, LD_*, *_PROXY or any npm_config_* but the cache: a `--require` or
 * `--import` in the caller's NODE_OPTIONS runs code in every node child before it starts, past every
 * guard in this file. The one NODE_OPTIONS a child gets is the rehearsal's own (below).
 */
const WHITELISTED_PARENT_ENV = ['PATH', 'LANG', 'LC_ALL', 'TZ'] as const
const CHILD_NODE_OPTIONS = '--max-old-space-size=3072'

/** The only part of this process's environment a child inherits. Not DATABASE_URL, not PG*, not a credential. */
export function inheritedEnv(scratchRoot: string): Record<string, string> {
  // HOME is the run directory's, not the caller's: npm reads a user .npmrc from HOME (script-shell,
  // node options, registries) and that file is outside every guard here.
  const env: Record<string, string> = { HOME: path.join(scratchRoot, 'home'), npm_config_cache: path.join(scratchRoot, 'npm-cache') }
  for (const name of WHITELISTED_PARENT_ENV) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  env.NODE_OPTIONS = CHILD_NODE_OPTIONS
  return env
}

function parseEnvFile(file: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line === '' || line.startsWith('#')) continue
    const at = line.indexOf('=')
    if (at > 0) env[line.slice(0, at)] = line.slice(at + 1)
  }
  return env
}

let currentChild: ChildProcess | null = null

function runChild(spec: { cmd: string; args: string[]; env: Record<string, string>; cwd: string; stdin?: string; timeoutMs?: number }): Promise<ChildResult> {
  return new Promise((resolve) => {
    // detached: the child leads its own process group, so a timeout stops it and what it started,
    // by the group id of a process THIS script created.
    const child = spawn(spec.cmd, spec.args, { cwd: spec.cwd, env: spec.env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    currentChild = child
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout.on('data', (chunk: Buffer) => { stdout = tail(stdout + chunk.toString('utf8')) })
    child.stderr.on('data', (chunk: Buffer) => { stderr = tail(stderr + chunk.toString('utf8')) })
    child.stdin.end(spec.stdin ?? '')
    const timer = setTimeout(() => {
      timedOut = true
      try { process.kill(-(child.pid as number), 'SIGKILL') } catch { /* already gone */ }
    }, spec.timeoutMs ?? CHILD_TIMEOUT_MS)
    child.on('error', (error) => {
      clearTimeout(timer)
      currentChild = null
      resolve({ exitCode: null, stdout, stderr: `${stderr}${error.message}`, timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      currentChild = null
      resolve({ exitCode: code, stdout, stderr, timedOut })
    })
  })
}

// ---------------------------------------------------------------------------------------------
// The throwaway cluster.
// ---------------------------------------------------------------------------------------------

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex')
}

function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/** Run SQL on the cluster as its bootstrap superuser, over the private socket, with the SQL on stdin. */
function socketPsql(cluster: Cluster, sql: string, database = 'postgres'): string {
  const env = { PATH: process.env.PATH } as unknown as NodeJS.ProcessEnv
  return execFileSync('psql', [
    '-X', '-w', '-q', '-tA', '-v', 'ON_ERROR_STOP=1',
    '-h', cluster.socket, '-p', String(cluster.port), '-U', currentUser(), '-d', database,
  ], { input: sql, encoding: 'utf8', env, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}

function databaseUrl(role: string, password: string, port: number, database: string): string {
  return `postgresql://${encodeURIComponent(role)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}`
}

async function withClient<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000 })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end().catch(() => undefined)
  }
}

async function fingerprintTables(client: pg.Client): Promise<Map<string, TableFingerprint>> {
  const tables = await client.query<{ relname: string }>(
    `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p') order by c.relname`,
  )
  const out = new Map<string, TableFingerprint>()
  for (const { relname } of tables.rows) {
    // md5 per row, then md5 over the sorted per-row digests: a deterministic digest of the table's
    // content that never builds one string the size of the table.
    const result = await client.query<{ rows: string; md5: string }>(
      `select count(*)::text as rows, coalesce(md5(string_agg(md5(t::text), '' order by md5(t::text))), '') as md5 from public.${ident(relname)} t`,
    )
    out.set(relname, { rows: Number(result.rows[0]!.rows), md5: result.rows[0]!.md5 })
  }
  return out
}

function countMigrationDirectories(repoRoot: string): number {
  const dir = path.join(repoRoot, 'prisma', 'migrations')
  return readdirSync(dir).filter((name) => existsSync(path.join(dir, name, 'migration.sql'))).length
}

// ---------------------------------------------------------------------------------------------
// Teardown. Synchronous on purpose: it must be able to finish inside a signal handler.
// ---------------------------------------------------------------------------------------------

/** Facts about one path component, as `lstat` reports them. */
export type ComponentInfo = { isDirectory: boolean; isSymlink: boolean; uid: number; mode: number }

/**
 * Why a directory is NOT trustworthy as an ancestor of the rehearsal's work or report directories, or
 * null when it is: it must be a real directory (never a symlink), owned by root or the running account,
 * and not writable by group or others, unless it carries the sticky bit AND is owned by root (the
 * /tmp and /var/tmp shape, where others can create names but cannot rename or remove ours).
 */
export function ancestorProblem(info: ComponentInfo, myUid: number): string | null {
  if (info.isSymlink) return 'is a symlink'
  if (!info.isDirectory) return 'is not a directory'
  if (info.uid !== 0 && info.uid !== myUid) return `is owned by uid ${info.uid}, neither root nor the running account`
  if ((info.mode & 0o022) !== 0 && !((info.mode & 0o1000) !== 0 && info.uid === 0)) return 'is writable by group or others and is not a root-owned sticky directory'
  return null
}

/**
 * Check `target` and every ancestor up to `/`. A same-host attacker who can ALREADY rename or replace one
 * of these is out of scope: this refuses configurations in which OTHER accounts could, and it cannot
 * defend against an account that already owns (or is root over) a validated ancestor. Node offers no
 * directory-descriptor-anchored `openat`, so what follows the check is a path walk, not a held handle.
 */
export function checkAncestors(target: string, label: string): string | null {
  const myUid = typeof process.getuid === 'function' ? process.getuid() : 0
  let current = path.resolve(target)
  for (;;) {
    let info: ComponentInfo
    try {
      const stat = lstatSync(current)
      info = { isDirectory: stat.isDirectory(), isSymlink: stat.isSymbolicLink(), uid: stat.uid, mode: stat.mode }
    } catch (error) {
      return `${label} ${target}: cannot inspect ${current}: ${error instanceof Error ? error.message : String(error)}`
    }
    const problem = ancestorProblem(info, myUid)
    if (problem !== null) return `${label} ${target}: ${current} ${problem}. Use a directory whose every ancestor only root or this account can modify.`
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

class DirectoryReplacedError extends Error {}

/** `birthtimeMs` is recorded where the file system reports one: an inode NUMBER can be reused after a delete, its creation time cannot match by accident. */
export type FileIdentity = { dev: number; ino: number; birthtimeMs?: number }

function sameFile(info: { dev: number; ino: number; birthtimeMs: number }, expected: FileIdentity): boolean {
  if (info.dev !== expected.dev || info.ino !== expected.ino) return false
  return expected.birthtimeMs === undefined || expected.birthtimeMs === 0 || info.birthtimeMs === 0 || info.birthtimeMs === expected.birthtimeMs
}

/**
 * Overwrite and remove a file THIS run created, and nothing else. The file is opened with O_NOFOLLOW
 * (a symlink at the name is refused, ELOOP) and O_NONBLOCK (a FIFO planted there cannot hang the open),
 * the DESCRIPTOR is fstat-ed, and it must be a regular file with the dev and inode recorded when the run
 * created it; only then are random bytes written through that descriptor. If the identity does not
 * match, nothing is written and the reason is returned (the teardown then exits 3). There is no
 * fallback that writes by path. The final unlink re-checks the name's identity first; the gap between
 * that check and the unlink is the same accepted residual as the rest of the path-based teardown.
 */
export function shredFile(file: string, expected: FileIdentity | null): { ok: boolean; reason?: string } {
  let fd: number
  try {
    fd = openSync(file, fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { ok: true }
    return { ok: false, reason: `${file} was not opened (${code ?? 'error'}): it is not the file this run created, so it was left alone` }
  }
  try {
    const info = fstatSync(fd)
    if (expected === null || !info.isFile() || !sameFile(info, expected)) {
      return { ok: false, reason: `${file} is not the file this run created (device, inode or creation time differ, or it is not a regular file), so it was neither overwritten nor removed` }
    }
    writeSync(fd, randomBytes(Math.max(info.size, 1)))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    const now = lstatSync(file)
    if (now.isSymbolicLink() || !sameFile(now, expected)) return { ok: false, reason: `${file} changed after it was overwritten, so it was not removed` }
    unlinkSync(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { ok: false, reason: `${file} could not be removed: ${error instanceof Error ? error.message : String(error)}` }
  }
  return { ok: !existsSync(file) }
}

/**
 * Create a file that must not exist yet, never through a symlink, readable by this account only:
 * O_EXCL (fail if anything, including a symlink, is already at the name) with O_NOFOLLOW, then fsync so
 * the bytes are on disk before anything is renamed over a published name.
 */
export function writeExclusive(file: string, data: string): void {
  const fd = openSync(file, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600)
  try {
    writeSync(fd, data)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function fsyncDirectory(dir: string): void {
  const fd = openSync(dir, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY)
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/**
 * The JSON is the commit record of a published report and names its companion Markdown by sha256.
 * `{ ok: true }` only when the JSON parses, and the Markdown beside it exists with exactly that digest.
 */
export function verifyPublishedReport(jsonFile: string): { ok: true } | { ok: false; reason: string } {
  try {
    const parsed = JSON.parse(readFileSync(jsonFile, 'utf8')) as { companionMarkdownSha256?: unknown }
    if (typeof parsed.companionMarkdownSha256 !== 'string') return { ok: false, reason: 'the JSON carries no companionMarkdownSha256' }
    const markdown = readFileSync(jsonFile.replace(/\.json$/, '.md'))
    const actual = createHash('sha256').update(markdown).digest('hex')
    return actual === parsed.companionMarkdownSha256 ? { ok: true } : { ok: false, reason: 'the Markdown does not match the digest the JSON records' }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

function teardownRun(state: RunState): TeardownResult {
  const errors: string[] = []
  // A start that failed after the fork left no handle and no pid: read both from the data directory.
  if (state.postmaster === null) state.postmaster = capturePostmaster(path.join(state.root, 'pg', 'data'))
  const identity = state.postmaster
  const pid = identity?.pid ?? state.postmasterPid
  state.postmasterPid = pid
  let clusterStopped = true
  let orphanPids: number[] = []

  const family = pid === null ? [] : [pid, ...descendantsOf(pid)]
  // Stop ONLY the process this run identified, and only after confirming it still is that process.
  // pg_ctl resolves its target from the data directory's CURRENT postmaster.pid, so running it against
  // a directory a replacement now owns would stop the replacement; there is no unconditional stop here
  // and no numeric-pid SIGKILL (a pid can be reused between any check and the signal): a postmaster
  // that cannot be stopped this way is reported as an orphan and the exit code says so.
  //
  // WHAT THIS DOES NOT CLOSE, stated plainly: the identity check and `pg_ctl` are two separate acts, and
  // Linux offers no handle (pidfd) that Node can pass to pg_ctl, so a replacement that takes the data
  // directory between the LAST check below and pg_ctl's own read of postmaster.pid would be stopped.
  // The window is narrowed to the gap between two reads of the same small file: identity is confirmed,
  // then the pid file is confirmed to still name that pid, directory and start record, immediately
  // before pg_ctl runs. The residual is an accepted limit of a throwaway cluster on a private port in a
  // directory only this run knows the name of; anything detected as replaced is reported, never stopped.
  if (identity !== null && postmasterIsStillOurs(identity)) {
    state.betweenIdentityAndStop?.()
    if (pidFileStillNames(identity) && postmasterIsStillOurs(identity)) {
      try {
        execFileSync(path.join(pgBinDir(), 'pg_ctl'), ['-D', identity.dataDir, '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe', env: toolEnv() })
      } catch (error) {
        errors.push(`pg_ctl stop failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (postmasterIsStillOurs(identity)) errors.push(`postmaster ${identity.pid} is still running after pg_ctl stop; it is left alone and reported as an orphan`)
    } else {
      errors.push('the data directory was taken over between the identity check and the stop; nothing was stopped')
    }
  } else if (state.cluster) {
    errors.push('the postmaster this run started no longer matches its captured identity; it was not stopped, because whatever owns the data directory now is not ours to stop')
  }

  const shred = shredFile(state.envFile, state.envFileId)
  const envFileShredded = shred.ok
  if (!envFileShredded) errors.push(`env file: ${shred.reason ?? `still present: ${state.envFile}`}`)

  let rootRemoved = false
  const base = path.basename(state.root)
  const stillRunningHere = processesNaming(state.root)
  if (stillRunningHere.length > 0) {
    errors.push(`not removing ${state.root}: process(es) ${stillRunningHere.join(', ')} still run from it`)
  } else if (base.startsWith(RUN_DIR_PREFIX) && path.isAbsolute(state.root)) {
    try {
      rmSync(state.root, { recursive: true, force: true })
    } catch (error) {
      errors.push(`removing ${state.root} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    rootRemoved = !existsSync(state.root)
  } else {
    errors.push(`refusing to remove ${state.root}: not an ${RUN_DIR_PREFIX}* directory`)
  }

  orphanPids = [...new Set([...family.filter((candidate) => processIsAlive(candidate)), ...processesNaming(state.root)])].sort((a, b) => a - b)
  clusterStopped = orphanPids.length === 0 && (identity === null || !postmasterIsStillOurs(identity))

  return { clusterStopped, postmasterPid: pid, envFileShredded, rootRemoved, orphanPids, errors }
}

// ---------------------------------------------------------------------------------------------
// The rehearsal.
// ---------------------------------------------------------------------------------------------

function refuse(message: string): RehearsalOutcome {
  return { exitCode: REHEARSAL_EXIT.REFUSED, report: null, refusal: message }
}

export async function runRehearsal(options: RehearsalOptions = {}): Promise<RehearsalOutcome> {
  const repoRoot = options.repoRoot ?? REPO_ROOT
  const parentDir = path.resolve(options.parentDir ?? DEFAULT_PARENT)
  const reportDir = path.resolve(options.reportDir ?? DEFAULT_REPORT_DIR)
  const hooks = options.hooks ?? {}
  const log = options.log ?? ((line: string) => console.error(line))

  // ---- Refusals: nothing has been created yet. ----
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    return refuse('refusing to run as root: initdb will not, and the rehearsal must not own an IMS tree. Run it as the account that owns the checkout.')
  }
  try {
    pgBinDir()
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error))
  }
  if (!existsSync(parentDir) || !statSync(parentDir).isDirectory()) return refuse(`--root ${parentDir} is not a directory`)
  const rootAncestors = checkAncestors(parentDir, '--root')
  if (rootAncestors !== null) return refuse(rootAncestors)
  let parentType: string
  try {
    parentType = filesystemType(parentDir)
  } catch (error) {
    return refuse(`cannot determine the file-system type of ${parentDir}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (RAM_BACKED.has(parentType)) {
    return refuse(`${parentDir} is on ${parentType}: a cluster there is held in RAM. Use a disk-backed directory such as /var/tmp.`)
  }
  let reportDirId: FileIdentity | null = null
  // The report directory is checked BEFORE the cluster exists: a run that cannot write its report
  // has produced nothing, and finding that out after the teardown would waste the whole rehearsal.
  try {
    mkdirSync(reportDir, { recursive: true, mode: 0o700 })
    accessSync(reportDir, fsConstants.W_OK)
    // The directory reports are published INTO must be a real directory (not a symlink), owned by this
    // account, and not writable by anyone else: otherwise another account could plant names in it.
    const info = lstatSync(reportDir)
    if (!info.isDirectory()) throw new Error('it is not a real directory (a symlink is refused)')
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error('it is not owned by the account running the rehearsal')
    if ((info.mode & 0o022) !== 0) throw new Error('it is writable by group or others')
    reportDirId = { dev: info.dev, ino: info.ino }
  } catch (error) {
    return refuse(`--report-dir ${reportDir} cannot be created or written: ${error instanceof Error ? error.message : String(error)}`)
  }
  const reportAncestors = checkAncestors(reportDir, '--report-dir')
  if (reportAncestors !== null) return refuse(reportAncestors)
  for (const needed of ['prisma/schema.prisma', 'node_modules/.bin/prisma', 'node_modules/.bin/tsx', 'scripts/provision-instance.mjs']) {
    if (!existsSync(path.join(repoRoot, needed))) return refuse(`${needed} not found under ${repoRoot}: run from an IMS checkout with its dependencies installed and prisma generated`)
  }

  // ---- State ----
  const startedAt = new Date()
  const root = mkdtempSync(path.join(parentDir, RUN_DIR_PREFIX))
  chmodSync(root, 0o700)
  const runId = path.basename(root)
  const password = randomHex(24)
  const adminPassword = randomHex(16)
  const authSecret = randomHex(32)
  const cronSecret = randomHex(32)
  const settingsKey = randomHex(32)
  const state: RunState = {
    root,
    envFile: path.join(root, 'rehearsal.env'),
    envFileId: null,
    cluster: null,
    postmasterPid: null,
    postmaster: null,
    role: null,
    password,
    secrets: [password, adminPassword, authSecret, cronSecret, settingsKey],
    teardown: null,
  }
  const notes: string[] = []
  const results: StepResult[] = []
  let abortReason: string | null = null
  let postgresServer: string | null = null
  let systemIdentifier: string | null = null
  let scramVerified = false
  let port: number | null = null

  // An interruption is recorded, the running child is stopped, and the normal path finishes: the
  // remaining steps become `skipped`, the teardown runs in the `finally`, and a RED report is written
  // with exit code 1 (an unrun required step is RED; no signal-specific code exists). A SECOND signal
  // gives up on the report and only tears down.
  let interrupted: string | null = null
  const onSignal = (signal: NodeJS.Signals) => {
    if (interrupted === null) {
      interrupted = signal
      notes.push(`The rehearsal was interrupted by ${signal}: the running step was stopped and the remaining steps were not run.`)
      log(`[rehearsal] ${signal}: stopping the running step; the report and teardown will still complete`)
      if (currentChild?.pid) {
        try { process.kill(-currentChild.pid, 'SIGKILL') } catch { /* gone */ }
      }
      return
    }
    log(`[rehearsal] second ${signal}: tearing down now, without a report`)
    teardownRun(state)
    process.exit(REHEARSAL_EXIT.TEARDOWN_INCOMPLETE)
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  const redact = (text: string) => redactSecrets(text, state.secrets)
  const included = (def: StepDefinition) => (options.only ? options.only.has(def.id) : true)

  try {
    // ---- Cluster: its own directory, port, superuser role and scram password auth. ----
    port = await freePort()
    state.betweenIdentityAndStop = hooks.betweenIdentityAndStop
    state.cluster = (hooks.clusterStarter ?? startCluster)(root, 'pg', port, '127.0.0.1')
    const cluster = state.cluster
    state.postmaster = capturePostmaster(cluster.data)
    if (state.postmaster === null) throw new Error('the postmaster could not be identified from its data directory')
    state.postmasterPid = state.postmaster.pid
    log(`[rehearsal] cluster up: port ${port}, postmaster pid ${state.postmasterPid}, directory ${root}`)
    await hooks.afterClusterStart?.()

    const role = `rehearsal_${randomHex(4)}`
    state.role = role
    socketPsql(cluster, `create role ${ident(role)} superuser login password '${password}';\n`)
    socketPsql(cluster, `create database ${ident(SOURCE_DATABASE)} owner ${ident(role)};\n`)
    socketPsql(cluster, `create database ${ident(RESTORE_DATABASE)} owner ${ident(role)};\n`)
    postgresServer = socketPsql(cluster, 'show server_version;')
    const encryption = socketPsql(cluster, 'show password_encryption;')
    const stored = socketPsql(cluster, `select rolpassword like 'SCRAM-SHA-256$%' from pg_authid where rolname = '${role}';`)
    const hostRules = socketPsql(cluster, `select string_agg(distinct auth_method, ',') from pg_hba_file_rules where type like 'host%';`)
    scramVerified = encryption === 'scram-sha-256' && stored === 't' && hostRules === 'scram-sha-256'
    if (!scramVerified) throw new Error(`the throwaway cluster is not scram-only: password_encryption=${encryption}, stored scram=${stored}, host auth methods=${hostRules}`)

    const target = { host: '127.0.0.1', port, user: role, databases: [SOURCE_DATABASE, RESTORE_DATABASE] as const }
    const sourceUrl = databaseUrl(role, password, port, SOURCE_DATABASE)
    const restoreUrl = databaseUrl(role, password, port, RESTORE_DATABASE)

    // ---- The mode-600 env file: created with the mode, never on a command line. ----
    const stateDir = path.join(root, 'state')
    // The children's scratch space is inside the run directory: disk-backed (never the caller's
    // tmpfs) and removed with it.
    mkdirSync(path.join(root, 'tmp'), { recursive: true })
    mkdirSync(path.join(root, 'home'), { recursive: true })
    mkdirSync(path.join(root, 'npm-cache'), { recursive: true })
    for (const sub of ['public/avatars', 'public/branding', 'private/invoices', 'private/quarantine/invoices', 'invoices', 'backups']) {
      mkdirSync(path.join(stateDir, sub), { recursive: true })
    }
    const envEntries: Record<string, string> = {
      DATABASE_URL: sourceUrl,
      TMPDIR: path.join(root, 'tmp'),
      NODE_ENV: 'production',
      [REHEARSAL_INSTANCE_ROLE_VAR]: 'production',
      AUTH_SECRET: authSecret,
      CRON_SECRET: cronSecret,
      SETTINGS_ENCRYPTION_KEY: settingsKey,
      NEXT_PUBLIC_APP_URL: 'https://ims-rehearsal.test',
      AUTH_URL: 'https://ims-rehearsal.test',
      PUBLIC_APP_URL: 'https://ims-rehearsal.test',
      UPLOAD_STORAGE_DIR: path.join(stateDir, 'private'),
      PUBLIC_UPLOAD_STORAGE_DIR: path.join(stateDir, 'public'),
      INVOICE_PDF_STORAGE_DIR: path.join(stateDir, 'invoices'),
      BACKUP_DIR: path.join(stateDir, 'backups'),
      FILE_SCAN_MODE: 'disabled',
      PREFLIGHT_DB_CONNECT: '1',
      DEFAULT_ADMIN_EMAIL: 'rehearsal-admin@ims-rehearsal.test',
      DEFAULT_ADMIN_NAME: 'Rehearsal Admin',
      DEFAULT_ADMIN_PASSWORD: adminPassword,
      CHECKPOINT_DISABLE: '1',
      PRISMA_HIDE_UPDATE_MESSAGE: '1',
      // scripts/validate-db.sh and prisma-dev-db.sh source .env.local/.env over the environment
      // unless told not to; a rehearsal must reach its own cluster and nothing the checkout names.
      IMS_SKIP_ENV_FILE: '1',
      // `dotenv/config` (prisma.config.ts, prisma/seed.ts) would otherwise read the checkout's .env
      // for every variable the environment does not already set: an SMTP host, a connector key, a
      // session-lock URL. An empty file in the run directory leaves it nothing to load.
      DOTENV_CONFIG_PATH: path.join(root, 'empty.env'),
      DOTENV_CONFIG_QUIET: 'true',
    }
    writeFileSync(path.join(root, 'empty.env'), '', { flag: 'wx' })
    {
      // Created exclusively, never through a symlink, mode 600; its device and inode are recorded so the
      // teardown can prove it is overwriting THIS file and not whatever now sits at the name.
      const fd = openSync(state.envFile, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600)
      try {
        writeSync(fd, `${Object.entries(envEntries).map(([k, v]) => `${k}=${v}`).join('\n')}\n`)
        fsyncSync(fd)
        const info = fstatSync(fd)
        if ((info.mode & 0o777) !== 0o600) throw new Error('the env file is not mode 600')
        state.envFileId = { dev: info.dev, ino: info.ino, birthtimeMs: info.birthtimeMs }
      } finally {
        closeSync(fd)
      }
    }
    const fileEnv = parseEnvFile(state.envFile)
    if (process.env.DATABASE_URL) {
      notes.push('An inherited DATABASE_URL was present and was IGNORED: every step used the throwaway cluster\'s own URL.')
    }

    // The identity of what the steps will hit, by the server's own account (CONSTRAINTS: SELECT current_database()).
    assertThrowawayDatabaseUrl(fileEnv.DATABASE_URL, target)
    const identity = await withClient(fileEnv.DATABASE_URL!, async (client) => {
      const row = await client.query<{ db: string; port: number; dir: string }>(
        `select current_database() as db, inet_server_port() as port, current_setting('data_directory') as dir`,
      )
      return row.rows[0]!
    })
    if (identity.db !== SOURCE_DATABASE || identity.port !== port || realpathSync(identity.dir) !== realpathSync(cluster.data)) {
      throw new Error(`connected to the wrong server: database ${identity.db}, port ${identity.port}, data directory ${identity.dir}`)
    }
    log(`[rehearsal] verified: current_database()=${identity.db}, inet_server_port()=${identity.port}, data_directory=${identity.dir}`)

    // ---- Steps ----
    const stepEnv = (id: StepId, extra: Record<string, string> = {}): Record<string, string> => {
      const env = { ...inheritedEnv(root), ...fileEnv, ...extra }
      hooks.tamperStepEnv?.(id, env)
      assertThrowawayDatabaseUrl(env.DATABASE_URL, target)
      assertNoConnectorEnv(env)
      return env
    }
    const bin = (name: string) => path.join(repoRoot, 'node_modules', '.bin', name)
    const childIn = async (id: StepId, cmd: string, args: string[], extra: Record<string, string> = {}): Promise<ChildResult> => {
      const env = stepEnv(id, extra)
      const result = await runChild({ cmd, args, env, cwd: repoRoot })
      return { ...result, stdout: redact(result.stdout), stderr: redact(result.stderr) }
    }
    const outputTail = (result: ChildResult) => tail(`${result.stdout}\n${result.stderr}`.trim(), 1500)
    const pgClient = <T>(fn: (client: pg.Client) => Promise<T>) => {
      assertThrowawayDatabaseUrl(sourceUrl, target)
      return withClient(sourceUrl, fn)
    }

    let provisionFingerprint: Map<string, TableFingerprint> | null = null

    const runStep = async (def: StepDefinition, body: () => Promise<StepOutcome>): Promise<boolean> => {
      if (!included(def)) return true
      const began = Date.now()
      let outcome: StepOutcome
      try {
        await hooks.beforeStep?.(def.id)
        outcome = await body()
      } catch (error) {
        const message = redact(error instanceof Error ? error.message : String(error))
        outcome = { status: 'failed', reason: `${error instanceof RehearsalGuardError ? 'GUARD: ' : 'threw: '}${message}` }
      }
      const result: StepResult = {
        id: def.id,
        item: def.item,
        title: def.title,
        required: outcome.required ?? true,
        status: outcome.skipped ? 'skipped' : outcome.status,
        reason: outcome.reason,
        detail: outcome.detail ?? {},
        durationMs: Date.now() - began,
      }
      results.push(result)
      log(`[rehearsal] ${def.id}: ${result.status}${result.reason ? ` (${result.reason})` : ''}`)
      return result.status === 'passed' || !def.prerequisite
    }

    const stepBodies: Record<StepId, () => Promise<StepOutcome>> = {
      'migrate-deploy': async () => {
        const run = await childIn('migrate-deploy', bin('prisma'), ['migrate', 'deploy'])
        const expected = countMigrationDirectories(repoRoot)
        const applied = await pgClient(async (client) => Number((await client.query(
          'select count(*)::int as n from _prisma_migrations where finished_at is not null and rolled_back_at is null',
        )).rows[0]!.n))
        const ok = run.exitCode === 0 && expected > 0 && applied === expected
        return {
          status: ok ? 'passed' : 'failed',
          reason: ok ? undefined : `exit ${run.exitCode}; applied ${applied} of ${expected} migrations. ${outputTail(run)}`,
          detail: { migrationsOnDisk: expected, migrationsApplied: applied },
        }
      },
      'migrate-status': async () => {
        const run = await childIn('migrate-status', bin('prisma'), ['migrate', 'status'])
        const upToDate = /Database schema is up to date!/.test(run.stdout)
        const ok = run.exitCode === 0 && upToDate
        return { status: ok ? 'passed' : 'failed', reason: ok ? undefined : `exit ${run.exitCode}; up-to-date line present: ${upToDate}. ${outputTail(run)}`, detail: { upToDate } }
      },
      seed: async () => {
        const run = await childIn('seed', bin('tsx'), ['prisma/seed.ts'])
        return { status: run.exitCode === 0 ? 'passed' : 'failed', reason: run.exitCode === 0 ? undefined : `exit ${run.exitCode}. ${outputTail(run)}` }
      },
      provision: async () => {
        const run = await childIn('provision', process.execPath, ['scripts/provision-instance.mjs'])
        const skippedEmail = /Skipping provisioning email because SMTP or notification details are incomplete/.test(run.stdout)
        const sentEmail = /Provisioning email sent/.test(run.stdout)
        const adminCreated = /Default admin created/.test(run.stdout)
        const ok = run.exitCode === 0 && skippedEmail && !sentEmail && adminCreated
        return {
          status: ok ? 'passed' : 'failed',
          reason: ok ? undefined : `exit ${run.exitCode}; email skipped: ${skippedEmail}; email sent: ${sentEmail}; admin created: ${adminCreated}. ${outputTail(run)}`,
          detail: { emailSkippedBecauseSmtpUnset: skippedEmail, adminCreated },
        }
      },
      'seeded-rows': async () => {
        const facts = await pgClient(async (client): Promise<SeededRowFacts> => {
          const organisations = await client.query<{ id: string; baseCurrency: string; country: string }>('select id, "baseCurrency", country from organisations order by id')
          const warehouses = await client.query<{ code: string; isDefault: boolean }>('select code, "isDefault" from warehouses order by code')
          const taxRates = await client.query<{ name: string; rate: string; isDefault: boolean }>('select name, rate::text as rate, "isDefault" from tax_rates order by name')
          const currencies = await client.query<{ code: string }>('select code from currencies order by code')
          const admins = await client.query<{ n: number }>(`select count(*)::int as n from users where role = 'ADMIN' and active`)
          const smtp = await client.query<{ key: string }>(`select key from settings where key like 'email\\_smtp\\_%' order by key`)
          return {
            organisations: organisations.rows,
            warehouses: warehouses.rows,
            taxRates: taxRates.rows,
            currencies: currencies.rows.map((row) => row.code),
            adminUsers: admins.rows[0]!.n,
            smtpSettingKeys: smtp.rows.map((row) => row.key),
          }
        })
        const assessment = assessSeededRows(facts)
        return {
          status: assessment.ok ? 'passed' : 'failed',
          reason: assessment.ok ? undefined : assessment.failures.join('; '),
          detail: {
            organisations: facts.organisations,
            warehouses: facts.warehouses,
            taxRates: facts.taxRates.map((row) => `${row.name} @ ${row.rate}${row.isDefault ? ' (default)' : ''}`),
            currencies: facts.currencies,
            adminUsers: facts.adminUsers,
            expectedBaseCurrency: EXPECTED_BASE_CURRENCY,
          },
        }
      },
      'base-currency-unlocked': async () => {
        // The preconditions the answer is only meaningful under, recorded AND counted: the six tables the
        // lock reads are empty and no lock setting row exists (assessBaseCurrencyLock).
        const facts = await pgClient(async (client) => {
          const tableCounts: Record<string, number> = {}
          for (const table of BASE_CURRENCY_LOCK_TABLES) {
            tableCounts[table] = Number((await client.query(`select count(*)::int as n from public.${ident(table)}`)).rows[0].n)
          }
          const flag = await client.query(`select value from settings where key = 'base_currency_locked'`)
          return { tableCounts, lockSettingRows: flag.rowCount ?? 0 }
        })
        const run = await childIn('base-currency-unlocked', bin('tsx'), ['scripts/lib/first-install-probe.ts'])
        const line = run.stdout.split('\n').find((candidate) => candidate.startsWith('REHEARSAL_PROBE '))
        const tablesRead = { ...facts.tableCounts, base_currency_locked_setting_rows: facts.lockSettingRows }
        if (run.exitCode !== 0 || !line) return { status: 'failed', reason: `the probe did not report (exit ${run.exitCode}). ${outputTail(run)}`, detail: { tablesRead } }
        const probe = JSON.parse(line.slice('REHEARSAL_PROBE '.length)) as { locked: boolean; baseCurrencyCode: string }
        const assessment = assessBaseCurrencyLock({ isBaseCurrencyLocked: probe.locked, tableCounts: facts.tableCounts, lockSettingRows: facts.lockSettingRows })
        return {
          status: assessment.ok ? 'passed' : 'failed',
          reason: assessment.ok ? undefined : assessment.failures.join('; '),
          detail: { isBaseCurrencyLocked: probe.locked, baseCurrencyCode: probe.baseCurrencyCode, tablesRead },
        }
      },
      'system-identifier': async () => {
        const identifier = await pgClient(async (client) => (await client.query<{ id: string }>('select system_identifier::text as id from pg_control_system()')).rows[0]!.id)
        systemIdentifier = identifier
        const ok = /^\d{10,}$/.test(identifier)
        return { status: ok ? 'passed' : 'failed', reason: ok ? undefined : `unexpected system_identifier ${identifier}`, detail: { systemIdentifier: identifier } }
      },
      'preflight-production': async () => {
        const run = await childIn('preflight-production', bin('tsx'), ['scripts/preflight-production.ts'])
        const lines = `${run.stdout}\n${run.stderr}`.split('\n')
        const warnings = lines.filter((line) => line.startsWith('- WARN '))
        const failures = lines.filter((line) => line.startsWith('- FAIL '))
        const ok = run.exitCode === 0
        return {
          status: ok ? 'passed' : 'failed',
          reason: ok ? undefined : `exit ${run.exitCode}; ${failures.join(' | ') || outputTail(run)}`,
          detail: { passLines: lines.filter((line) => line.startsWith('- PASS ')).length, warnings },
        }
      },
      'validate-db': async () => {
        const run = await childIn('validate-db', 'npm', ['run', 'validate:db'])
        const concurrencySkipped = /SKIPPED: npm run test:concurrency/.test(run.stdout)
        const ok = run.exitCode === 0
        return {
          status: ok ? 'passed' : 'failed',
          reason: ok ? undefined : `exit ${run.exitCode}. ${outputTail(run)}`,
          detail: { concurrencyTierSkippedInsideValidateDb: concurrencySkipped },
        }
      },
      'invariant-preflight': async () => {
        const run = await childIn('invariant-preflight', 'npm', ['run', 'invariant-check:preflight'])
        const summary = run.stdout.split('\n').find((line) => line.startsWith('Invariant preflight summary:'))
        const ok = run.exitCode === 0
        return { status: ok ? 'passed' : 'failed', reason: ok ? undefined : `exit ${run.exitCode}. ${outputTail(run)}`, detail: { summary } }
      },
      'outbound-status': async () => {
        const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }
        if (!outboundStatusScriptPresent(pkg.scripts)) {
          return {
            status: 'failed',
            skipped: true,
            required: false,
            reason: `skipped: package.json has no ${OUTBOUND_STATUS_SCRIPT} script on this tree. The step becomes REQUIRED as soon as the script exists.`,
            detail: { scriptPresent: false },
          }
        }
        const run = await childIn('outbound-status', 'npm', ['run', OUTBOUND_STATUS_SCRIPT, '--', '--json', '--expect-held'])
        const assessment = assessOutboundStatus(run)
        return {
          status: assessment.ok ? 'passed' : 'failed',
          reason: assessment.ok ? undefined : assessment.failures.join('; '),
          detail: { scriptPresent: true, output: tail(run.stdout, 1200) },
        }
      },
      'restore-parity': async () => {
        const dumpFile = path.join(root, 'restore-point.dump')
        const pgEnv: Record<string, string> = {
          PATH: process.env.PATH ?? '',
          PGHOST: '127.0.0.1',
          PGPORT: String(port),
          PGUSER: role,
          PGPASSWORD: password,
          PGCONNECT_TIMEOUT: '10',
        }
        const binDir = pgBinDir()
        const dump = await runChild({ cmd: path.join(binDir, 'pg_dump'), args: ['-Fc', '--no-sync', '-f', dumpFile, SOURCE_DATABASE], env: pgEnv, cwd: root })
        if (dump.exitCode !== 0) return { status: 'failed', reason: `pg_dump exited ${dump.exitCode}: ${redact(tail(dump.stderr, 1500))}` }
        const dumpBytes = statSync(dumpFile).size
        const dumpSha256 = createHash('sha256').update(readFileSync(dumpFile)).digest('hex')
        const restore = await runChild({ cmd: path.join(binDir, 'pg_restore'), args: ['--no-owner', '--exit-on-error', '-d', RESTORE_DATABASE, dumpFile], env: pgEnv, cwd: root })
        if (restore.exitCode !== 0) return { status: 'failed', reason: `pg_restore exited ${restore.exitCode}: ${redact(tail(restore.stderr, 1500))}`, detail: { dumpBytes } }

        assertThrowawayDatabaseUrl(restoreUrl, target)
        const restoredFingerprints = await withClient(restoreUrl, async (client) => {
          await hooks.afterRestore?.(client)
          return fingerprintTables(client)
        })
        const sourceFingerprints = await pgClient((client) => fingerprintTables(client))
        const parity: ParityResult = compareParity(sourceFingerprints, restoredFingerprints)
        const assessment = assessParity(parity)
        const changed = provisionFingerprint
          ? [...sourceFingerprints].filter(([table, fp]) => provisionFingerprint!.get(table)?.md5 !== fp.md5).map(([table]) => table)
          : null
        return {
          status: assessment.ok ? 'passed' : 'failed',
          reason: assessment.ok ? undefined : assessment.failures.join('; '),
          detail: {
            dumpBytes,
            dumpSha256,
            tablesCompared: parity.tablesCompared,
            tablesWithRows: parity.tablesWithRows,
            totalRows: parity.totalRows,
            mismatches: parity.mismatches.length,
            tablesChangedSinceProvisioning: changed,
          },
        }
      },
    }

    let prerequisiteFailed: string | null = null
    for (const definition of STEP_CATALOGUE) {
      if (!included(definition)) continue
      if (interrupted !== null) {
        results.push({
          id: definition.id,
          item: definition.item,
          title: definition.title,
          required: true,
          status: 'skipped',
          reason: `not run: interrupted by ${interrupted}`,
          detail: {},
          durationMs: 0,
        })
        continue
      }
      if (prerequisiteFailed) {
        results.push({
          id: definition.id,
          item: definition.item,
          title: definition.title,
          required: true,
          status: 'skipped',
          reason: `not run: prerequisite step ${prerequisiteFailed} failed, so there is nothing to inspect`,
          detail: {},
          durationMs: 0,
        })
        continue
      }
      const proceed = await runStep(definition, stepBodies[definition.id])
      if (!proceed) prerequisiteFailed = definition.id
      if (definition.id === 'provision' && proceed) {
        // Hook, then the fingerprint every later step is compared against (informational).
        try {
          await pgClient(async (client) => { await hooks.afterProvision?.(client) })
          provisionFingerprint = await pgClient((client) => fingerprintTables(client))
        } catch (error) {
          notes.push(`post-provision hook or fingerprint failed: ${redact(error instanceof Error ? error.message : String(error))}`)
        }
      }
    }
  } catch (error) {
    abortReason = redact(error instanceof Error ? error.message : String(error))
    notes.push(`The rehearsal aborted before or between steps: ${abortReason}`)
    log(`[rehearsal] aborted: ${abortReason}`)
  } finally {
    // Every step the catalogue names ends up in the report, so an abort can never read as green.
    for (const definition of STEP_CATALOGUE) {
      if (!included(definition) || results.some((result) => result.id === definition.id)) continue
      results.push({
        id: definition.id,
        item: definition.item,
        title: definition.title,
        required: true,
        status: 'skipped',
        reason: `not run: ${abortReason ?? 'the rehearsal aborted'}`,
        detail: {},
        durationMs: 0,
      })
    }
    try {
      state.teardown = teardownRun(state)
    } catch (error) {
      state.teardown = { clusterStopped: false, postmasterPid: state.postmasterPid, envFileShredded: false, rootRemoved: !existsSync(root), orphanPids: [], errors: [`teardown threw: ${error instanceof Error ? error.message : String(error)}`] }
    }
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
  }

  const order = new Map(STEP_CATALOGUE.map((definition, index) => [definition.id, index]))
  results.sort((a, b) => order.get(a.id)! - order.get(b.id)!)
  const report = buildReport({
    runId,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    host: { node: process.version, postgresServer },
    cluster: { root, port, role: state.role, scramVerified, systemIdentifier, sourceDatabase: SOURCE_DATABASE, restoreDatabase: RESTORE_DATABASE },
    steps: results,
    teardown: state.teardown,
    notes,
    interrupted: interrupted as string | null,
  })

  const outDir = path.join(reportDir, runId)
  const json = path.join(outDir, 'readiness-report.json')
  const markdown = path.join(outDir, 'readiness-report.md')
  const write = hooks.writeReportFile ?? writeExclusive
  // PUBLICATION. The run's report directory is created EXCLUSIVELY (mode 700; anything already at that
  // name, including a planted directory or symlink, refuses the whole publication), and inside it every
  // file is created with O_EXCL|O_NOFOLLOW under a random temporary name, fsynced, and renamed within
  // the directory: Markdown first, the JSON LAST. The JSON is the COMMIT RECORD: it carries
  // `companionMarkdownSha256`, so a JSON whose Markdown is missing or different is detectably not the
  // pair that was published (`verifyPublishedReport`). Rename is atomic per file, not across the pair:
  // after a crash or power loss the directory can hold a Markdown without a JSON, or leftover `*.tmp`
  // files; neither is a report, and only a JSON whose companion verifies is. On a CAUGHT failure
  // everything this run created is removed and an amended RED copy is attempted, so whatever exists says RED.
  let outDirCreated = false
  let outDirId: FileIdentity | null = null
  const created: string[] = []
  // The directories are re-identified by device and inode before the first write, before each rename and
  // before the paths are returned: a report directory (or an ancestor of it) swapped for another after
  // validation is detected, nothing more is written, and nothing is cleaned up by path inside it.
  // RESIDUAL, stated plainly: this is a path walk, not a held directory handle (Node has no openat), so
  // a swap in the instants between a check and the next call is not excluded; an attacker who can swap
  // a validated ancestor is one the ancestor check above already refuses to run beside.
  const assertDirectories = (): void => {
    for (const [dir, id] of [[reportDir, reportDirId], [outDir, outDirId]] as const) {
      if (id === null) continue
      const now = lstatSync(dir)
      if (now.isSymbolicLink() || now.dev !== id.dev || now.ino !== id.ino) throw new DirectoryReplacedError(`${dir} is no longer the directory that was validated (device/inode changed)`)
    }
  }
  const publish = (toPublish: RehearsalReport): void => {
    const suffix = randomHex(6)
    const tmpJson = path.join(outDir, `.readiness-report.json.${suffix}.tmp`)
    const tmpMarkdown = path.join(outDir, `.readiness-report.md.${suffix}.tmp`)
    try {
      assertDirectories()
      const markdownText = renderMarkdown(toPublish)
      const record = { ...toPublish, companionMarkdownSha256: createHash('sha256').update(markdownText).digest('hex') }
      created.push(tmpMarkdown)
      write(tmpMarkdown, markdownText)
      created.push(tmpJson)
      write(tmpJson, `${JSON.stringify(record, null, 2)}\n`)
      assertDirectories()
      created.push(markdown)
      renameSync(tmpMarkdown, markdown)
      assertDirectories()
      created.push(json)
      renameSync(tmpJson, json)
      fsyncDirectory(outDir)
      assertDirectories()
    } catch (error) {
      // After a replaced directory, never touch it by path: whatever is there is not ours to clean.
      if (!(error instanceof DirectoryReplacedError)) for (const file of created.splice(0)) rmSync(file, { force: true })
      throw error
    }
  }
  hooks.beforePublish?.(outDir)
  try {
    assertDirectories()
    mkdirSync(outDir, { mode: 0o700 }) // not recursive: EEXIST (a planted directory) is a refusal
    outDirCreated = true
    const outInfo = lstatSync(outDir)
    outDirId = { dev: outInfo.dev, ino: outInfo.ino }
    publish(report)
  } catch (error) {
    const reportWriteError = error instanceof Error ? error.message : String(error)
    const exitCode = report.exitCode === REHEARSAL_EXIT.OK ? REHEARSAL_EXIT.RED : report.exitCode
    const amended: RehearsalReport = { ...report, verdict: 'RED', exitCode, notes: [...report.notes, `The report could not be written (${reportWriteError}); this copy is the only record.`] }
    if (!outDirCreated) return { exitCode, report: amended, runRoot: root, reportWriteError }
    try {
      publish(amended)
      return { exitCode, report: amended, reportPaths: { json, markdown }, runRoot: root, reportWriteError }
    } catch {
      return { exitCode, report: amended, runRoot: root, reportWriteError }
    }
  }
  return { exitCode: report.exitCode, report, reportPaths: { json, markdown }, runRoot: root }
}

// ---------------------------------------------------------------------------------------------
// Command line.
// ---------------------------------------------------------------------------------------------

const USAGE = `Usage: npm run rehearse:first-install -- [--root <dir>] [--report-dir <dir>]

Exit codes:
${Object.entries(REHEARSAL_EXIT_MEANING).map(([code, meaning]) => `  ${code}  ${meaning}`).join('\n')}
`

export function parseArgs(argv: readonly string[]): { root?: string; reportDir?: string; help: boolean } | { error: string } {
  const out: { root?: string; reportDir?: string; help: boolean } = { help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg === '--help' || arg === '-h') out.help = true
    else if (arg === '--root' || arg === '--report-dir') {
      const value = argv[i + 1]
      if (!value || value.startsWith('--')) return { error: `${arg} needs a value` }
      if (arg === '--root') out.root = value
      else out.reportDir = value
      i += 1
    } else return { error: `unknown argument ${arg}` }
  }
  return out
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2))
  if ('error' in parsed) {
    console.error(`${parsed.error}\n\n${USAGE}`)
    return REHEARSAL_EXIT.REFUSED
  }
  if (parsed.help) {
    console.log(USAGE)
    return REHEARSAL_EXIT.OK
  }
  const outcome = await runRehearsal({ parentDir: parsed.root, reportDir: parsed.reportDir })
  if (outcome.report === null) {
    console.error(`Refused: ${outcome.refusal}`)
    return outcome.exitCode
  }
  console.log(renderMarkdown(outcome.report))
  if (outcome.reportPaths) {
    console.log(`Report: ${outcome.reportPaths.json}`)
    console.log(`Report: ${outcome.reportPaths.markdown}`)
  } else {
    console.error(`The report could not be written (${outcome.reportWriteError}); it is printed above.`)
  }
  return outcome.exitCode
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(
    (code) => { process.exitCode = code },
    (error: unknown) => {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error))
      process.exitCode = REHEARSAL_EXIT.RED
    },
  )
}
