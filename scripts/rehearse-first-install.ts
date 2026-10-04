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
  constants as fsConstants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
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
  assessOutboundStatus,
  assessParity,
  assessSeededRows,
  buildReport,
  compareParity,
  outboundStatusScriptPresent,
  redactSecrets,
  renderMarkdown,
} from '../lib/ops/first-install-rehearsal.ts'
import { type Cluster, currentUser, freePort, pgBinDir, startCluster } from '../tests/scripts/real-postgres-cluster.ts'

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
  cluster: Cluster | null
  postmasterPid: number | null
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
  return execFileSync('stat', ['-f', '-c', '%T', target], { encoding: 'utf8' }).trim()
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

const WHITELISTED_PARENT_ENV = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'NODE_OPTIONS', 'npm_config_cache'] as const

/** The only part of this process's environment a child inherits. Not DATABASE_URL, not PG*, not a credential. */
function inheritedEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of WHITELISTED_PARENT_ENV) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
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

export function shredFile(file: string): boolean {
  if (!existsSync(file)) return true
  try {
    execFileSync('shred', ['-u', '-n', '1', file], { stdio: 'pipe' })
  } catch {
    // shred missing or refused: overwrite then unlink. Best effort on a copy-on-write file system.
    try {
      writeFileSync(file, randomBytes(Math.max(statSync(file).size, 1)))
    } catch { /* fall through to unlink */ }
    try { unlinkSync(file) } catch { /* checked below */ }
  }
  return !existsSync(file)
}

function teardownRun(state: RunState): TeardownResult {
  const errors: string[] = []
  const pid = state.postmasterPid
  let clusterStopped = true
  let orphanPids: number[] = []

  const family = pid === null ? [] : [pid, ...descendantsOf(pid)]
  if (state.cluster) {
    try {
      state.cluster.stop()
    } catch (error) {
      errors.push(`cluster stop threw: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (pid !== null && processIsAlive(pid)) {
    // pg_ctl did not get it. SIGKILL the postmaster THIS run captured, and nothing else.
    try { process.kill(pid, 'SIGKILL') } catch { /* gone in the meantime */ }
    for (let i = 0; i < 50 && processIsAlive(pid); i += 1) execFileSync('sleep', ['0.1'])
  }

  const envFileShredded = shredFile(state.envFile)
  if (!envFileShredded) errors.push(`env file still present: ${state.envFile}`)

  let rootRemoved = false
  const base = path.basename(state.root)
  if (base.startsWith(RUN_DIR_PREFIX) && path.isAbsolute(state.root)) {
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
  clusterStopped = orphanPids.length === 0 && (pid === null || !processIsAlive(pid))

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
  let parentType: string
  try {
    parentType = filesystemType(parentDir)
  } catch (error) {
    return refuse(`cannot determine the file-system type of ${parentDir}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (RAM_BACKED.has(parentType)) {
    return refuse(`${parentDir} is on ${parentType}: a cluster there is held in RAM. Use a disk-backed directory such as /var/tmp.`)
  }
  // The report directory is checked BEFORE the cluster exists: a run that cannot write its report
  // has produced nothing, and finding that out after the teardown would waste the whole rehearsal.
  try {
    mkdirSync(reportDir, { recursive: true })
    accessSync(reportDir, fsConstants.W_OK)
  } catch (error) {
    return refuse(`--report-dir ${reportDir} cannot be created or written: ${error instanceof Error ? error.message : String(error)}`)
  }
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
    cluster: null,
    postmasterPid: null,
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

  const onSignal = (signal: NodeJS.Signals) => {
    log(`[rehearsal] ${signal}: tearing down before exit`)
    if (currentChild?.pid) {
      try { process.kill(-currentChild.pid, 'SIGKILL') } catch { /* gone */ }
    }
    const result = teardownRun(state)
    process.exit(result.errors.length === 0 && result.orphanPids.length === 0 ? 130 : REHEARSAL_EXIT.TEARDOWN_INCOMPLETE)
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  const redact = (text: string) => redactSecrets(text, state.secrets)
  const included = (def: StepDefinition) => (options.only ? options.only.has(def.id) : true)

  try {
    // ---- Cluster: its own directory, port, superuser role and scram password auth. ----
    port = await freePort()
    state.cluster = startCluster(root, 'pg', port, '127.0.0.1')
    const cluster = state.cluster
    state.postmasterPid = Number(readFileSync(path.join(cluster.data, 'postmaster.pid'), 'utf8').split('\n')[0])
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
    writeFileSync(path.join(root, 'empty.env'), '')
    writeFileSync(state.envFile, `${Object.entries(envEntries).map(([k, v]) => `${k}=${v}`).join('\n')}\n`, { mode: 0o600, flag: 'wx' })
    chmodSync(state.envFile, 0o600)
    if ((statSync(state.envFile).mode & 0o777) !== 0o600) throw new Error('the env file is not mode 600')
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
      const env = { ...inheritedEnv(), ...fileEnv, ...extra }
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
        // The precondition the answer is only meaningful under: the six tables the lock reads are empty.
        const counts = await pgClient(async (client) => {
          const out: Record<string, number> = {}
          for (const table of ['products', 'suppliers', 'customers', 'purchase_orders', 'sales_orders', 'stock_movements']) {
            out[table] = Number((await client.query(`select count(*)::int as n from public.${ident(table)}`)).rows[0].n)
          }
          const flag = await client.query(`select value from settings where key = 'base_currency_locked'`)
          out.base_currency_locked_setting_rows = flag.rowCount ?? 0
          return out
        })
        const run = await childIn('base-currency-unlocked', bin('tsx'), ['scripts/lib/first-install-probe.ts'])
        const line = run.stdout.split('\n').find((candidate) => candidate.startsWith('REHEARSAL_PROBE '))
        if (run.exitCode !== 0 || !line) return { status: 'failed', reason: `the probe did not report (exit ${run.exitCode}). ${outputTail(run)}`, detail: { tablesRead: counts } }
        const probe = JSON.parse(line.slice('REHEARSAL_PROBE '.length)) as { locked: boolean; baseCurrencyCode: string }
        const ok = probe.locked === false
        return {
          status: ok ? 'passed' : 'failed',
          reason: ok ? undefined : 'isBaseCurrencyLocked() returned true on a fresh install: something wrote master data or the lock setting before the rehearsal read it',
          detail: { isBaseCurrencyLocked: probe.locked, baseCurrencyCode: probe.baseCurrencyCode, tablesRead: counts },
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
        const run = await childIn('outbound-status', 'npm', ['run', OUTBOUND_STATUS_SCRIPT])
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
      state.teardown = { clusterStopped: false, postmasterPid: state.postmasterPid, envFileShredded: !existsSync(state.envFile), rootRemoved: !existsSync(root), orphanPids: [], errors: [`teardown threw: ${error instanceof Error ? error.message : String(error)}`] }
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
  })

  const outDir = path.join(reportDir, runId)
  const json = path.join(outDir, 'readiness-report.json')
  const markdown = path.join(outDir, 'readiness-report.md')
  try {
    mkdirSync(outDir, { recursive: true })
    writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`)
    writeFileSync(markdown, renderMarkdown(report))
  } catch (error) {
    // The run happened; its verdict must not be lost with the files. The caller prints the report.
    const reportWriteError = error instanceof Error ? error.message : String(error)
    return { exitCode: report.exitCode === REHEARSAL_EXIT.OK ? REHEARSAL_EXIT.RED : report.exitCode, report, runRoot: root, reportWriteError }
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
