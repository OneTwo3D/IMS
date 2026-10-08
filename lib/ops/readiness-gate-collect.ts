/**
 * THE IMPURE HALF OF THE READINESS GATE: collect each check's evidence, hand it to the pure assessor,
 * and turn ANY failure to collect into an `unreadable` result, never into silence.
 *
 * Every dependency is injected (`GateDeps`) so a test can drive the whole collection without a database,
 * a child process or a disk, and so a test can PROVE the collection performs no write: the default
 * dependencies are the only place a database is touched, and each one only reads.
 *
 *  - invariant report       lib/cron/invariant-check-preflight (the function behind
 *                           `npm run invariant-check:preflight`, with its no-op writers), in process
 *  - schema state          `npm run db:migrate:status`, `db:schema:diff`, `db:schema:drift` as children (read-only;
 *                           NOT validate:db, which inserts probe rows and regenerates the client) plus a read of
 *                           pg_constraint; no shell, a whitelisted environment, the
 *                           database URL in that environment and never on a command line
 *  - outbound status        lib/ops/outbound-status (the function behind `npm run outbound:status`), in
 *                           process: it reads the ENVIRONMENT OF THIS PROCESS and the activity log
 *  - rehearsal              the newest report in the rehearsal directory, verified with verifyPublishedReport
 *  - reconciliation         collectAccountingReconciliationReadiness (lib/ops/rollout-readiness.ts), the same
 *                           code the rollout-readiness endpoint uses
 *  - read-sync liveness     `npm run read-sync:status`, only if package.json defines it
 *
 * Nothing here contacts a vendor: no connector module is imported, and the only children are npm scripts
 * that touch the database named by DATABASE_URL.
 */

import { spawn } from 'node:child_process'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

import { UntrustedPathError, checkAncestors, readTrustedRegularFile } from '@/lib/ops/published-report'
import {
  CHECK_CATALOGUE,
  PACK_ITEMS,
  READ_SYNC_STATUS_SCRIPT,
  REQUIRED_CHECK_CONSTRAINTS,
  REHEARSAL_TRUST_TEXT,
  SCHEMA_STATE_SCRIPTS,
  type PackItemId,
  type ReadinessPhase,
} from '@/lib/ops/readiness-gate-constants'
import {
  assessInvariantReport,
  assessOutboundStatus,
  assessReadSyncStatus,
  assessRehearsalReport,
  derivePackItemFromInvariant,
  type CheckResult,
  type CollectedResults,
  type GateWarning,
  type InvariantEvidence,
  type OutboundEvidence,
  type RehearsalEvidence,
} from '@/lib/ops/readiness-gate'
import type { BuildIdentity } from '@/lib/ops/build-identity'
import type { AccountingReconciliationReadiness } from '@/lib/ops/rollout-readiness'

export type ChildResult = { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }

export type ChildSpec = {
  /** The npm script name. The command is always `npm run <script>`; no other program is ever run. */
  script: string
  silent: boolean
  /** Fixed arguments after `--` (never a credential). */
  args?: readonly string[]
  env: Record<string, string>
  cwd: string
  timeoutMs: number
}

export type GateDeps = {
  now: () => Date
  runInvariant: () => Promise<InvariantEvidence>
  readOutbound: () => Promise<OutboundEvidence>
  readReconciliation: (now: Date) => Promise<AccountingReconciliationReadiness>
  runScript: (spec: ChildSpec) => Promise<ChildResult>
  readPackageScripts: () => Record<string, string>
  /** The commit and tree of the checkout the gate runs from. Throws when git cannot say. */
  readBuildIdentity: () => BuildIdentity
  /** Names of the CHECK constraints that exist and are validated (a read of pg_constraint). */
  readInstalledConstraints: () => Promise<string[]>
  /** The newest rehearsal report in `dir`, or a reason there is none. Throws when the directory cannot be read. */
  readNewestRehearsal: (dir: string, now: Date) => RehearsalEvidence | { none: string } | { untrusted: string }
  /** The environment of this process, read only by name. */
  env: Record<string, string | undefined>
  repoRoot: string
}

export type CollectOptions = {
  phase: ReadinessPhase
  expectGranted: string[] | null
  rehearsalDir: string
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Run one check's collector; ANY throw is `unreadable`, never a pass and never skipped. */
async function guarded(label: string, collect: () => Promise<CheckResult> | CheckResult): Promise<CheckResult> {
  try {
    return await collect()
  } catch (error) {
    return { kind: 'unreadable', reason: `${label} could not be read: ${describe(error)}` }
  }
}

// ---------------------------------------------------------------------------------------------
// The child environment: a short whitelist, never the caller's whole environment.
// ---------------------------------------------------------------------------------------------

/**
 * The only variables of this process a child may inherit. PRISMA_DEV_DB_CONFIRM is the operator's own opt-in for the
 * schema commands (scripts/prisma-dev-db.sh refuses a DATABASE_URL that is not on this host without it); the gate never
 * sets it, so a database on another host makes the schema check fail with that script's refusal until the operator exports it.
 * NOT a connector credential, an outbound grant, SMTP, NODE_OPTIONS or PG*. */
export const CHILD_ENV_WHITELIST = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'npm_config_cache', 'DATABASE_URL', 'PRISMA_DEV_DB_CONFIRM'] as const

/** Fixed additions: do not source the checkout's .env over the database URL, and make no telemetry request. */
export const CHILD_ENV_FIXED: Record<string, string> = {
  IMS_SKIP_ENV_FILE: '1',
  CHECKPOINT_DISABLE: '1',
  PRISMA_HIDE_UPDATE_MESSAGE: '1',
  DOTENV_CONFIG_QUIET: 'true',
  NO_UPDATE_NOTIFIER: '1',
}

export function buildChildEnv(source: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of CHILD_ENV_WHITELIST) {
    const value = source[name]
    if (value !== undefined && value !== '') env[name] = value
  }
  return { ...env, ...CHILD_ENV_FIXED }
}

const OUTPUT_TAIL_BYTES = 16 * 1024
function tail(text: string): string {
  return text.length > OUTPUT_TAIL_BYTES ? text.slice(text.length - OUTPUT_TAIL_BYTES) : text
}

/** `npm run [--silent] <script>` with no shell. The child leads its own process group so a timeout stops what it started. */
export function runNpmScript(spec: ChildSpec): Promise<ChildResult> {
  return new Promise((resolve) => {
    const args = ['run', ...(spec.silent ? ['--silent'] : []), spec.script, ...(spec.args && spec.args.length > 0 ? ['--', ...spec.args] : [])]
    const child = spawn('npm', args, { cwd: spec.cwd, env: spec.env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: true, shell: false })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout.on('data', (chunk: Buffer) => { stdout = tail(stdout + chunk.toString('utf8')) })
    child.stderr.on('data', (chunk: Buffer) => { stderr = tail(stderr + chunk.toString('utf8')) })
    const timer = setTimeout(() => {
      timedOut = true
      try { process.kill(-(child.pid as number), 'SIGKILL') } catch { /* already gone */ }
    }, spec.timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ exitCode: null, stdout, stderr: `${stderr}${error.message}`, timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ exitCode: code, stdout, stderr, timedOut })
    })
  })
}

export const SCHEMA_SCRIPT_TIMEOUT_MS = 5 * 60 * 1000
export const READ_SYNC_TIMEOUT_MS = 2 * 60 * 1000

// ---------------------------------------------------------------------------------------------
// Rehearsal reports on disk.
// ---------------------------------------------------------------------------------------------

const REHEARSAL_JSON = 'readiness-report.json'
const REHEARSAL_MARKDOWN = 'readiness-report.md'
const MAX_REPORT_BYTES = 5 * 1024 * 1024

/**
 * The NEWEST rehearsal report, by the time it says it finished (or its file's modification time when it
 * says nothing readable). The newest is judged on its own: an older GREEN report is never a fallback for a
 * newer one that is RED, corrupt or fails its digest.
 *
 * TRUST, BEFORE ANYTHING IS READ. The digest only binds the Markdown to the JSON that names it; both sit in the
 * same directory, so whoever can write one can write the other. What makes a report worth reading is therefore
 * WHO COULD HAVE WRITTEN IT: the report directory and its ancestors, EVERY run directory, and both report files
 * of each must be real (never symlinks), owned by root or the running account, and not writable by group or
 * others (the ancestor policy of lib/ops/published-report.ts). Any violation anywhere refuses the whole
 * location, even in a run directory that is not the newest: a directory somebody else can populate is not
 * evidence. A process running as the same account or as root is out of scope; this proves nothing about
 * authenticity beyond ownership and mode.
 */
export function readNewestRehearsal(
  dir: string,
  verify: (jsonFile: string) => { ok: true } | { ok: false; reason: string },
): RehearsalEvidence | { none: string } | { untrusted: string } {
  const refuse = (reason: string) => ({ untrusted: REHEARSAL_TRUST_TEXT(reason) })
  let names: string[]
  try {
    const rootProblem = checkAncestors(dir, 'rehearsal report directory')
    if (rootProblem) {
      try { lstatSync(dir) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { none: `the rehearsal report directory ${dir} does not exist` } }
      return refuse(rootProblem)
    }
    names = readdirSync(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { none: `the rehearsal report directory ${dir} does not exist` }
    throw error
  }
  const candidates: Array<{ json: string; parsed: unknown; sortKey: number }> = []
  for (const name of names) {
    const sub = path.join(dir, name)
    const info = lstatSync(sub)
    if (info.isSymbolicLink()) return refuse(`${sub} is a symlink`)
    if (!info.isDirectory()) continue // a stray file in the directory is not a run and is never read
    const subProblem = checkAncestors(sub, 'run directory')
    if (subProblem) return refuse(subProblem)
    const json = path.join(sub, REHEARSAL_JSON)
    const markdown = path.join(sub, REHEARSAL_MARKDOWN)
    let jsonInfo
    try {
      jsonInfo = lstatSync(json)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    let text: string
    let parsed: unknown = null
    try {
      text = readTrustedRegularFile(json, MAX_REPORT_BYTES)
    } catch (error) {
      if (error instanceof UntrustedPathError) return refuse(error.message)
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') return refuse(`${json} is a symlink`)
      throw error
    }
    try {
      readTrustedRegularFile(markdown, MAX_REPORT_BYTES)
    } catch (error) {
      if (error instanceof UntrustedPathError) return refuse(error.message)
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') return refuse(`${markdown} is a symlink`)
      // A missing Markdown is left for the digest check to report (the pair does not verify).
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }
    const finished = typeof (parsed as { finishedAt?: unknown } | null)?.finishedAt === 'string' ? Date.parse((parsed as { finishedAt: string }).finishedAt) : Number.NaN
    candidates.push({ json, parsed, sortKey: Number.isFinite(finished) ? finished : jsonInfo.mtimeMs })
  }
  if (candidates.length === 0) return { none: `no rehearsal report was found under ${dir}` }
  candidates.sort((left, right) => right.sortKey - left.sortKey || right.json.localeCompare(left.json))
  const newest = candidates[0]!
  return { digest: verify(newest.json), parsed: newest.parsed, location: newest.json }
}

// ---------------------------------------------------------------------------------------------
// Reconciliation findings -> a check result.
// ---------------------------------------------------------------------------------------------

/** Findings the rollout-readiness endpoint reports as WARNINGS that cannot be warnings here: nothing was proven. */
export const RECONCILIATION_FINDINGS_THAT_FAIL_THE_GATE: ReadonlySet<string> = new Set([
  'accounting-reconciliation:missing',
  'accounting-reconciliation:partial',
])

export function assessReconciliationReadiness(readiness: AccountingReconciliationReadiness): CheckResult {
  const failures: string[] = []
  for (const blocker of readiness.blockers) failures.push(`${blocker.id}: ${blocker.message}`)
  const warnings: GateWarning[] = []
  for (const warning of readiness.warnings) {
    if (RECONCILIATION_FINDINGS_THAT_FAIL_THE_GATE.has(warning.id)) failures.push(`${warning.id}: ${warning.message}`)
    else warnings.push({ id: warning.id, message: warning.message })
  }
  if (readiness.latest === null) {
    // No run at all: nothing was reconciled, so nothing is proven complete. Never "no run = empty = fine".
    failures.push('no accounting reconciliation run exists, so reconciliation completeness is not proven')
  } else if (readiness.proof === null) {
    failures.push('the completeness proof was not evaluated for the newest run')
  } else if (readiness.proof.state === 'not-proven') {
    // Independent of the blocker list: the ONLY not-proven shape that may continue is "the newest run
    // predates completeness recording, and nothing else is wrong" (a warning). Anything else is a failure
    // even if a blocker was somehow not raised.
    const proof = readiness.proof
    const onlyNotRecorded = proof.newest === 'not-recorded' && proof.unresolved.length === 0 && !proof.overflow && !proof.notRecordedAfterRecording
    if (!onlyNotRecorded) failures.push(`reconciliation completeness is not proven (newest run ${proof.newest}; ${proof.unresolved.length} unresolved truncation(s); history overflow: ${proof.overflow})`)
  }
  const detail = {
    latestRunId: readiness.latest?.id ?? null,
    latestRunCreatedAt: readiness.latest?.createdAt ?? null,
    proof: readiness.proof?.state ?? null,
  }
  return failures.length > 0
    ? { kind: 'fail', reasons: failures, detail, ...(warnings.length > 0 ? { warnings } : {}) }
    : { kind: 'pass', summary: readiness.proof?.state === 'proven' ? 'reconciliation is proven complete' : 'no uncovered truncation; the newest run predates completeness recording (warning)', detail, ...(warnings.length > 0 ? { warnings } : {}) }
}

// ---------------------------------------------------------------------------------------------
// The collection.
// ---------------------------------------------------------------------------------------------

export async function collectGateResults(options: CollectOptions, deps: GateDeps): Promise<{ results: CollectedResults; notes: string[] }> {
  const now = deps.now()
  const notes: string[] = []
  const results: Record<string, CheckResult> = {}
  const childEnv = buildChildEnv(deps.env)

  // 1. Invariant report. The raw evidence is kept so pack items R3/R4/R15 are read from the SAME report.
  let invariantEvidence: InvariantEvidence | null = null
  results['invariant-preflight'] = await guarded('the invariant report', async () => {
    invariantEvidence = await deps.runInvariant()
    return assessInvariantReport(invariantEvidence)
  })

  // 2. Schema state: read-only equivalents of validate:db. NOT validate:db itself: its constraint probe inserts rows
  // (in a transaction it rolls back) and it regenerates the Prisma client in the checkout, and the gate writes neither.
  results['schema-state'] = await guarded('the schema state', async () => {
    const problems: string[] = []
    for (const script of SCHEMA_STATE_SCRIPTS) {
      const run = await deps.runScript({ script, silent: false, env: childEnv, cwd: deps.repoRoot, timeoutMs: SCHEMA_SCRIPT_TIMEOUT_MS })
      if (run.timedOut || run.exitCode === null) return { kind: 'unreadable', reason: `npm run ${script} did not complete${run.timedOut ? ' within the time allowed' : `: ${tail(run.stderr).slice(-300)}`}` } as CheckResult
      if (run.exitCode !== 0) problems.push(`npm run ${script} exited ${run.exitCode}: ${tail(run.stdout + run.stderr).slice(-400).replace(/\s+/g, ' ')}`)
    }
    const installed = new Set(await deps.readInstalledConstraints())
    const missing = REQUIRED_CHECK_CONSTRAINTS.filter((name) => !installed.has(name))
    if (missing.length > 0) problems.push(`CHECK constraint(s) not installed or not validated: ${missing.join(', ')}`)
    return problems.length > 0
      ? { kind: 'fail', reasons: problems } as CheckResult
      : { kind: 'pass', summary: `schema up to date, no drift, ${REQUIRED_CHECK_CONSTRAINTS.length} CHECK constraints installed`, detail: { scripts: [...SCHEMA_STATE_SCRIPTS], constraints: [...REQUIRED_CHECK_CONSTRAINTS] } } as CheckResult
  })

  // 3. Outbound status.
  results['outbound-status'] = await guarded('the outbound status', async () => assessOutboundStatus(await deps.readOutbound(), options.phase, options.expectGranted))

  // 4. Rehearsal.
  results['first-install-rehearsal'] = await guarded('the rehearsal report', () => {
    let gateBuild: BuildIdentity | { unreadable: string }
    try {
      gateBuild = deps.readBuildIdentity()
    } catch (error) {
      gateBuild = { unreadable: describe(error) }
    }
    const found = deps.readNewestRehearsal(options.rehearsalDir, now)
    if ('none' in found) return { kind: 'fail', reasons: [found.none] } as CheckResult
    if ('untrusted' in found) return { kind: 'fail', reasons: [found.untrusted] } as CheckResult
    return assessRehearsalReport(found, now, gateBuild)
  })

  // 5. Reconciliation completeness.
  results['reconciliation-completeness'] = await guarded('the reconciliation completeness proof', async () => assessReconciliationReadiness(await deps.readReconciliation(now)))

  // 6. Read-sync liveness: optional until the tree has the status script, then required.
  results['read-sync-liveness'] = await guarded('the read-sync liveness status', async () => {
    const scripts = deps.readPackageScripts()
    const script = scripts[READ_SYNC_STATUS_SCRIPT]
    if (typeof script !== 'string' || script.trim() === '') {
      return { kind: 'not-available', reason: `package.json has no ${READ_SYNC_STATUS_SCRIPT} script on this tree, so read-sync liveness is not checked; it becomes required the moment the script exists` } as CheckResult
    }
    const run = await deps.runScript({ script: READ_SYNC_STATUS_SCRIPT, silent: true, args: ['--json'], env: childEnv, cwd: deps.repoRoot, timeoutMs: READ_SYNC_TIMEOUT_MS })
    if (run.timedOut || run.exitCode === null) return { kind: 'unreadable', reason: `${READ_SYNC_STATUS_SCRIPT} did not complete` } as CheckResult
    return assessReadSyncStatus(run, now)
  })

  // 7. The reconciliation pack, as slots.
  for (const item of PACK_ITEMS) {
    const id = `pack-${item.id}`
    if (item.derivedFrom === 'invariant-report') {
      results[id] = derivePackItemFromInvariant(item.id as 'R3' | 'R4' | 'R15', invariantEvidence, results['invariant-preflight']!)
    } else {
      results[id] = { kind: 'not-available', reason: `no runner for ${item.id} exists on this tree (${item.source})` }
    }
  }
  const slotIds = new Set(CHECK_CATALOGUE.map((definition) => definition.id as string))
  for (const id of Object.keys(results)) if (!slotIds.has(id)) notes.push(`internal: collected a result for ${id}, which the catalogue does not define`)
  return { results, notes }
}

export function packItemIds(): PackItemId[] {
  return PACK_ITEMS.map((item) => item.id)
}

// ---------------------------------------------------------------------------------------------
// Default dependencies: the ONLY place a database is read.
// ---------------------------------------------------------------------------------------------

export async function defaultRunInvariant(): Promise<InvariantEvidence> {
  const { runInvariantCheckPreflight } = await import('@/lib/cron/invariant-check-preflight')
  return await runInvariantCheckPreflight() as unknown as InvariantEvidence
}

export async function defaultReadOutbound(now: Date): Promise<OutboundEvidence> {
  const { buildOutboundStatusReport } = await import('@/lib/ops/outbound-status')
  return await buildOutboundStatusReport({ now })
}

export async function defaultReadReconciliation(now: Date): Promise<AccountingReconciliationReadiness> {
  const { collectAccountingReconciliationReadiness, createDefaultRolloutReadinessAdapters } = await import('@/lib/ops/rollout-readiness')
  const adapters = createDefaultRolloutReadinessAdapters()
  return collectAccountingReconciliationReadiness(adapters, now)
}

export function readPackageScriptsFrom(repoRoot: string): Record<string, string> {
  const parsed = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }
  if (parsed === null || typeof parsed !== 'object' || typeof parsed.scripts !== 'object' || parsed.scripts === null) throw new Error('package.json has no scripts object')
  return parsed.scripts
}

export async function defaultReadInstalledConstraints(): Promise<string[]> {
  const { db } = await import('@/lib/db')
  const names = [...REQUIRED_CHECK_CONSTRAINTS]
  const rows = await db.$queryRaw<Array<{ conname: string }>>`
    SELECT c.conname FROM pg_constraint c
    WHERE c.contype = 'c' AND c.convalidated AND c.conname = ANY(${names}::text[])`
  return rows.map((row) => row.conname)
}
