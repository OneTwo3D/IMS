import { NextRequest, NextResponse } from 'next/server'
import { createHash, randomBytes } from 'crypto'
import { spawn } from 'child_process'
import pg from 'pg'
import { createReadStream, createWriteStream } from 'fs'
import { mkdir, access, unlink, stat, statfs } from 'fs/promises'
import path from 'path'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'
import type { ReadableStream as NodeReadableStream } from 'stream/web'
import { logActivity, redactActivityLogText } from '@/lib/activity-log'
import { requireApiFreshAdmin } from '@/lib/auth/server'
import { getBackupDir } from '@/lib/backup-storage'
import { disableMaintenanceMode, enableMaintenanceMode } from '@/lib/maintenance-mode'
import { sendEmail } from '@/lib/mailer'
import { consumeAuthToken, deleteAuthToken, setAuthToken } from '@/lib/auth/token-store'
import { db } from '@/lib/db'
import { ACCOUNTING_CONNECTOR_SELECTION_LOCK_KEY } from '@/lib/db/advisory-locks'
import { createRestoreSqlScanner } from '@/lib/backup/restore-sql-guard'
import { parsePositiveIntegerEnv } from '@/lib/env'
import { getClientIp } from '@/lib/request-ip'
import {
  parseBackupManifestContent,
  validateBackupManifestForFile,
  type BackupManifest,
} from '@/lib/backup-manifest'

const BACKUP_DIR = getBackupDir()
const RESTORE_TOKEN_TTL_MS = 2 * 60_000
const DEFAULT_MAX_RESTORE_FILE_BYTES = 50 * 1024 * 1024
const RESTORE_FORM_OVERHEAD_BYTES = 64 * 1024
const MAX_RESTORE_MANIFEST_BYTES = 1024 * 1024
const RESTORE_SQL_DISK_SPACE_MULTIPLIER = 10
const RESTORE_DATABASE_DISK_SPACE_MULTIPLIER = 1.25

export const runtime = 'nodejs'

type Env = Record<string, string | undefined>

type RestoreSession = {
  user: {
    id: string
    sessionVersion?: number | null
    sessionAuthTime?: number | null
  }
}

type RestoreAuthorizer = () => Promise<NextResponse | RestoreSession>

type RestoreUserClient = {
  findUnique(args: { where: { id: string }; select: { email: true } }): Promise<{ email: string | null } | null>
}

type RestoreTimestampDbClient = {
  $queryRaw<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>
}

export type RestoreLogEntry = Parameters<typeof logActivity>[0]

/** @internal Test seam for route-handler unit tests; not an application API. */
export type BackupRestoreHandlerDeps = {
  authorize?: RestoreAuthorizer
  users?: RestoreUserClient
  dbClient?: RestoreTimestampDbClient
  env?: Env
  backupDir?: string
  log?: (entry: RestoreLogEntry) => Promise<void>
  mailer?: typeof sendEmail
  setRestoreToken?: typeof setAuthToken
  consumeRestoreToken?: typeof consumeAuthToken
  deleteRestoreToken?: typeof deleteAuthToken
  enableMaintenance?: typeof enableMaintenanceMode
  disableMaintenance?: typeof disableMaintenanceMode
  runRestoreFile?: typeof runRestore
  validateBackupManifest?: typeof validateBackupManifestForFile
  getAvailableDiskBytes?: typeof getAvailableDiskBytes
  getTargetDatabaseTimestamp?: () => Promise<Date>
  now?: () => number
}

type RestoreTokenPayload = {
  userId: string
  sessionVersion: number | null
  sessionAuthTime: number | null
  clientIp: string
}

function isTruthy(value: string | undefined): boolean {
  // Unknown values fail closed. Only explicit opt-in strings enable restore gates.
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase())
}

function isProductionRestoreAllowed(env: Env): boolean {
  return env.NODE_ENV !== 'production' || isTruthy(env.ALLOW_DATABASE_RESTORE)
}

function isProductionUploadRestoreAllowed(env: Env): boolean {
  return env.NODE_ENV !== 'production' || isTruthy(env.ALLOW_DATABASE_RESTORE_UPLOAD)
}

function getMaxRestoreFileBytes(env: Env): number {
  return parsePositiveIntegerEnv(env.DATABASE_RESTORE_MAX_FILE_BYTES, DEFAULT_MAX_RESTORE_FILE_BYTES)
}

function getMaxRestoreFormBytes(env: Env): number {
  return getMaxRestoreFileBytes(env) + RESTORE_FORM_OVERHEAD_BYTES
}

async function getAvailableDiskBytes(directory: string): Promise<number> {
  const stats = await statfs(directory)
  return Number(stats.bavail) * Number(stats.bsize)
}

function restoreTokenClientIp(request?: Pick<NextRequest, 'headers'> | null): string | null {
  if (!request) return null
  return getClientIp(request.headers)
}

function restoreTokenPayload(session: RestoreSession, request?: Pick<NextRequest, 'headers'> | null): RestoreTokenPayload | null {
  const clientIp = restoreTokenClientIp(request)
  if (!clientIp) return null
  return {
    userId: session.user.id,
    sessionVersion: session.user.sessionVersion ?? null,
    sessionAuthTime: session.user.sessionAuthTime ?? null,
    clientIp,
  }
}

function serializeRestoreTokenPayload(payload: RestoreTokenPayload): string {
  return JSON.stringify(payload)
}

function parseRestoreTokenPayload(value: string | null): RestoreTokenPayload | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as Partial<RestoreTokenPayload>
    if (!parsed || typeof parsed !== 'object') return null
    if (typeof parsed.userId !== 'string' || typeof parsed.clientIp !== 'string') return null
    if (parsed.sessionVersion !== null && typeof parsed.sessionVersion !== 'number') return null
    if (parsed.sessionAuthTime !== null && typeof parsed.sessionAuthTime !== 'number') return null
    return {
      userId: parsed.userId,
      sessionVersion: parsed.sessionVersion ?? null,
      sessionAuthTime: parsed.sessionAuthTime ?? null,
      clientIp: parsed.clientIp,
    }
  } catch {
    return null
  }
}

function missingRestoreClientIpResponse(): NextResponse {
  return NextResponse.json({ error: 'Cannot issue restore token without verifiable client IP.' }, { status: 400 })
}

function estimateRestoreDiskBytes(sqlFileBytes: number, manifest: BackupManifest): number {
  return Math.max(
    Math.ceil(sqlFileBytes * RESTORE_SQL_DISK_SPACE_MULTIPLIER),
    Math.ceil(manifest.databaseSizeBytes * RESTORE_DATABASE_DISK_SPACE_MULTIPLIER) + sqlFileBytes,
  )
}

async function validateRestoreDiskSpace(
  deps: RequiredRestoreDeps,
  sqlFileBytes: number,
  manifest: BackupManifest,
): Promise<NextResponse | null> {
  const requiredBytes = estimateRestoreDiskBytes(sqlFileBytes, manifest)
  const availableBytes = await deps.getAvailableDiskBytes(deps.backupDir)
  if (availableBytes >= requiredBytes) return null
  return NextResponse.json({
    error: `Not enough disk space for restore. Requires approximately ${RESTORE_SQL_DISK_SPACE_MULTIPLIER}x the SQL file size or ${RESTORE_DATABASE_DISK_SPACE_MULTIPLIER}x the manifest database size.`,
  }, { status: 507 })
}

async function parseUploadedBackupManifest(file: File | null, backupFilename: string): Promise<BackupManifest | NextResponse> {
  if (!file) {
    return NextResponse.json({ error: 'Backup manifest file is required for uploaded restores.' }, { status: 400 })
  }
  if (!file.name.endsWith('.manifest.json')) {
    return NextResponse.json({ error: 'Invalid manifest file type. Upload the .manifest.json sidecar for the SQL backup.' }, { status: 400 })
  }
  if (file.size > MAX_RESTORE_MANIFEST_BYTES) {
    return NextResponse.json({ error: 'Backup manifest file is too large.' }, { status: 413 })
  }

  let manifest: BackupManifest
  try {
    manifest = parseBackupManifestContent(await file.text())
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: `Backup manifest validation failed: ${message.slice(0, 200)}` }, { status: 400 })
  }
  if (manifest.backupFilename !== path.basename(backupFilename)) {
    return NextResponse.json({ error: 'Backup manifest does not match the uploaded backup.' }, { status: 400 })
  }
  return manifest
}

function restoreTokenPayloadMatches(actual: RestoreTokenPayload | null, expected: RestoreTokenPayload): boolean {
  return actual?.userId === expected.userId
    && actual.sessionVersion === expected.sessionVersion
    && actual.sessionAuthTime === expected.sessionAuthTime
    && actual.clientIp === expected.clientIp
}

async function consumeMatchingRestoreToken(
  deps: RequiredRestoreDeps,
  restoreToken: string,
  expected: RestoreTokenPayload,
): Promise<boolean> {
  const tokenValue = await deps.consumeRestoreToken(`backup_restore:${restoreToken.trim().toUpperCase()}`)
  return restoreTokenPayloadMatches(parseRestoreTokenPayload(tokenValue), expected)
}

async function logDeniedRestoreAttempt(deps: RequiredRestoreDeps, userId: string, reason: string): Promise<void> {
  await deps.log({
    entityType: 'SYSTEM',
    tag: 'system',
    action: 'backup_restore_denied',
    level: 'WARNING',
    description: `Denied database restore request: ${reason}`,
    userId,
    resolveUser: false,
    metadata: { reason },
  })
}

async function getRestoreTargetDatabaseTimestamp(deps: RequiredRestoreDeps): Promise<string | NextResponse> {
  try {
    return (await deps.getTargetDatabaseTimestamp()).toISOString()
  } catch (error) {
    const message = redactRestoreErrorMessage(error instanceof Error ? error.message : String(error), deps.env)
    await deps.log({
      entityType: 'SYSTEM',
      tag: 'system',
      action: 'backup_restore_preflight_failed',
      level: 'ERROR',
      description: `Failed to preflight database restore: ${message}`,
      metadata: {
        reason: 'target_database_timestamp_unavailable',
        error: message,
      },
    })
    return NextResponse.json({ error: `Restore preflight failed: ${message.slice(0, 200)}` }, { status: 500 })
  }
}

function restoreDisabledResponse(): NextResponse {
  return NextResponse.json({ error: 'Database restore is disabled in production.' }, { status: 403 })
}

function getDbConfig(env: Env = process.env) {
  const url = new URL(env.DATABASE_URL!)
  return {
    host: url.hostname,
    port: url.port || '5432',
    user: url.username,
    password: url.password,
    database: url.pathname.slice(1),
  }
}

function restoreSecretCandidates(env: Env): string[] {
  const candidates = new Set<string>()
  const databaseUrl = env.DATABASE_URL
  if (!databaseUrl) return []

  try {
    const url = new URL(databaseUrl)
    if (url.password.length >= 4) {
      // Four chars avoids exact-replacing common short tokens that can appear
      // innocently in error text. Short passwords still rely on URL-shaped and
      // password-key regex redaction below.
      candidates.add(url.password)
    }
    try {
      const decoded = decodeURIComponent(url.password)
      if (decoded.length >= 4) {
        candidates.add(decoded)
      }
    } catch {
      // Keep the raw URL password candidate when decoding malformed escapes fails.
    }
  } catch {
    // Invalid DATABASE_URL is handled by the normal restore failure path.
  }

  return [...candidates]
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isSafeExactSecretCandidate(value: string): boolean {
  return !/^(password|passphrase|secret|token)$/i.test(value)
}

export function redactRestoreErrorMessage(message: string, env: Env = process.env): string {
  let redacted = message
    .replace(
      /(\b[a-z][a-z0-9+.-]*:\/\/)([^:@/\s]+):([^@/\s]+)@/gi,
      '$1$2:[redacted]@',
    )
    .replace(
      /\b((?:pg)?password)(\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s;,)]+)/gi,
      '$1$2[redacted]',
    )

  for (const candidate of restoreSecretCandidates(env)) {
    if (!isSafeExactSecretCandidate(candidate)) continue
    redacted = redacted.replace(new RegExp(escapeRegExp(candidate), 'g'), '[redacted]')
  }

  return redactActivityLogText(redacted)
}

function parseOrigin(value: string | undefined): string | null {
  const raw = value?.trim()
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    if (url.origin === 'null') return null
    return url.origin
  } catch {
    return null
  }
}

type RestoreOriginCheck = {
  allowed: boolean
  denialReason?: 'cross_origin_restore_request' | 'misconfigured_app_origin'
}

function getAllowedRequestOrigins(env: Env, request: NextRequest): Set<string> {
  const origins = new Set<string>()
  const appOrigin = parseOrigin(env.NEXT_PUBLIC_APP_URL)
  if (appOrigin) {
    origins.add(appOrigin)
  } else {
    const authOrigin = parseOrigin(env.AUTH_URL)
    if (authOrigin) origins.add(authOrigin)
  }

  // Return early when configured origins exist, or in production so an empty set
  // fails closed instead of falling back to the request URL.
  if (origins.size > 0 || env.NODE_ENV === 'production') return origins

  // Local/dev route-handler tests often do not configure app URLs. Fall back to
  // the request URL origin outside production only. NextRequest.url can still
  // reflect the Host header; production therefore never uses this fallback.
  origins.add(new URL(request.url).origin)
  return origins
}

function checkSameOriginRequest(request: NextRequest, env: Env): RestoreOriginCheck {
  const allowedOrigins = getAllowedRequestOrigins(env, request)
  if (allowedOrigins.size === 0) {
    return {
      allowed: false,
      denialReason: env.NODE_ENV === 'production'
        ? 'misconfigured_app_origin'
        : 'cross_origin_restore_request',
    }
  }

  const originHeader = request.headers.get('origin')
  if (originHeader) {
    const origin = parseOrigin(originHeader)
    return { allowed: origin !== null && allowedOrigins.has(origin), denialReason: 'cross_origin_restore_request' }
  }

  const referer = request.headers.get('referer')
  if (!referer) return { allowed: false, denialReason: 'cross_origin_restore_request' }

  const refererOrigin = parseOrigin(referer)
  return { allowed: refererOrigin !== null && allowedOrigins.has(refererOrigin), denialReason: 'cross_origin_restore_request' }
}

function resolveBackupPath(backupDir: string, filename: string): string | null {
  const safe = path.basename(filename)
  const resolvedBase = path.resolve(backupDir)
  const resolvedTarget = path.resolve(backupDir, safe)
  if (!resolvedTarget.startsWith(`${resolvedBase}${path.sep}`) && resolvedTarget !== resolvedBase) {
    return null
  }
  return resolvedTarget
}

function formatRestoreEmail(token: string) {
  return `
    <p>A database restore was requested for your onetwoInventory admin account.</p>
    <p>Use this confirmation code to continue:</p>
    <p style="font-size:24px;font-weight:700;letter-spacing:0.2em;"><code>${token}</code></p>
    <p>This code expires in 2 minutes and can be used only once.</p>
    <p>If you did not request this, review admin access immediately.</p>
  `
}

/**
 * REFUSE ANYTHING THE REPLAY CANNOT BE HELD TO ONE TRANSACTION (o3d-osl8 round 9, finding 3).
 *
 * The previous check was `/^\s*\\/` per line — a psql-metacommand scan that ALSO rejected every
 * `\.` COPY terminator, i.e. every plain `pg_dump` this application produces (both writers here use
 * `--format=plain` with default COPY output). It rejected the app's own backups and, being purely
 * lexical, could not see transaction control at all.
 *
 * `createRestoreSqlScanner` lexes the file instead: it knows strings, dollar-quoted bodies,
 * comments and COPY data blocks, so a top-level `COMMIT;` is caught and a `COMMIT` inside a PL/pgSQL
 * body is not. Its guarantees and its stated limits are in lib/backup/restore-sql-guard.ts —
 * including the two classes it cannot see (indirect transaction control, and statements that cannot
 * run in a transaction block), both of which PostgreSQL turns into a clean rollback rather than a
 * partial apply.
 */
async function validateRestoreSqlFile(filePath: string): Promise<void> {
  const scanner = createRestoreSqlScanner()
  const stream = createReadStream(filePath, { encoding: 'utf8' })
  try {
    for await (const chunk of stream) scanner.push(chunk as string)
  } finally {
    stream.destroy()
  }
  scanner.end()
}

const RESTORE_PSQL_TIMEOUT_MS = 300_000
/** Bounded acquisition: a restore that cannot get the lock fails fast and says so. */
const RESTORE_SELECTION_LOCK_MAX_WAIT_MS = 60_000
const RESTORE_SELECTION_LOCK_POLL_MS = 250
/**
 * After SIGKILL, how long we wait to observe psql's `close` before giving up on it. SIGKILL cannot
 * be caught, so this is teardown time, not a grace period.
 */
const RESTORE_PSQL_KILL_GRACE_MS = 30_000
/** Keeps the holder session from being reaped by an `idle_session_timeout` or an idle TCP path. */
const RESTORE_LOCK_KEEPALIVE_MS = 30_000
/**
 * How long the holder waits for `pg_stat_activity` to stop listing this run's backend after it has
 * been signalled. Longer than the psql kill grace on purpose: this is the observation the lock's
 * release depends on, and giving up early is the failure mode being fixed.
 */
const RESTORE_BACKEND_EXIT_CONFIRM_MS = 60_000
const RESTORE_BACKEND_EXIT_POLL_MS = 250

/**
 * WHAT `pg_terminate_backend` ACTUALLY TELLS YOU (o3d-osl8 round 10, finding 2).
 *
 * Round 9's version ran the termination query and returned `rows.length`. Two things are wrong with
 * that, and both of them read as success:
 *
 *   1. IT DISCARDED THE ANSWER. `pg_terminate_backend(pid)` returns a BOOLEAN — false when the
 *      signal could not be sent (no permission, the pid is gone, it is not a backend). A row came
 *      back either way, so one row that returned `false` was reported as "1 backend terminated".
 *   2. THE SIGNAL IS NOT THE DEATH. `pg_terminate_backend` sends SIGTERM and returns; the backend
 *      dies when it next reaches an interrupt point, which for a long DDL statement inside a
 *      restore is exactly the case we are here for. Returning as soon as it is signalled is the
 *      same assumption the SIGKILL path made about psql, one layer down.
 *
 * So confirmation is a POLL, not a return value: signal, then re-read `pg_stat_activity` for this
 * run's `application_name` until nothing answers to it, or until the deadline. `confirmed` is true
 * only when the backend is GONE from the catalogue — the one observation that makes "the restore
 * has stopped writing" a fact rather than an inference. (`pg_terminate_backend(pid, timeout)` would
 * do the waiting server-side, but it is PostgreSQL 14+; the poll works on every version this
 * application supports and is what the caller has to be able to trust.)
 */
export type RestoreBackendTerminationResult = {
  /** True ONLY when pg_stat_activity no longer lists a backend for this run. */
  confirmed: boolean
  /** How many backends were ever seen for this run. */
  found: number
  /** Still listed when we gave up. Zero whenever `confirmed`. */
  remaining: number
  /** Why confirmation failed, when it did. */
  error?: string
}

/** What the holder lends the work it wraps. */
export type RestoreLockContext = {
  /**
   * Terminate any backend still executing this restore, identified by `application_name`, and WAIT
   * until the catalogue agrees it is gone. Used only on the timeout path.
   */
  terminateAndConfirmRestoreBackends: (applicationName: string) => Promise<RestoreBackendTerminationResult>
  /**
   * KEEP THE LOCK. Called when the restore backend could not be confirmed dead: releasing then
   * would hand the connector-selection lock to a writer while a restore may still be replaying over
   * the same rows, which is the exact state the lock exists to prevent — and it would look
   * protected. The holder's session, its keepalive and the advisory lock are all deliberately
   * leaked; an operator restart is the recovery, and that is the loud failure this is choosing.
   */
  retainLock: (reason: string) => void
}

/**
 * The restore timed out AND its database backend could not be confirmed gone.
 *
 * Typed, because the caller has to treat it differently from every other restore failure: the
 * database may still be being written to, so maintenance mode STAYS ON rather than being switched
 * back off by the endpoint's `finally`.
 */
export class RestoreBackendNotConfirmedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RestoreBackendNotConfirmedError'
  }
}

/** Runs `work` while the connector-selection lock is held by a session `work` does not control. */
export type RestoreSelectionLockHolder = <T>(work: (ctx: RestoreLockContext) => Promise<T>) => Promise<T>

/** The minimum of a `pg` client this needs. Structural, so a test can supply one. */
export type RestoreLockClient = {
  connect(): Promise<void>
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>
  end(): Promise<void>
}

/**
 * HOLD THE CONNECTOR-SELECTION LOCK, WITH NO EXPIRY, FOR THE WHOLE RESTORE
 * (o3d-osl8 round 7 finding 2 → round 8 finding 3 → round 9 finding 2).
 *
 * A restore replays arbitrary SQL over the whole database. It rewrites `settings` — plugin selection
 * rows included — and `accounting_sync_logs` WITHOUT naming a single plugin key, which is why the
 * lexical writer inventory in tests/accounting/plugin-selection-lock.test.ts could never have found
 * it: a name-based sweep cannot enumerate a generic replay path.
 *
 * Two things go wrong without the lock.
 *
 *   1. NO SERIALIZATION. `cancelOrphanedAccountingSyncRows` reads the connector selection under this
 *      lock and decides from it which queue to discard. A restore committing a DIFFERENT selection
 *      while that decision is in flight is exactly the transition the lock exists to stop.
 *   2. DEADLOCK, in the opposite direction. The cancellation locks the plugin `settings` rows first
 *      and updates `accounting_sync_logs` second. A restore whose SQL happens to touch
 *      `accounting_sync_logs` before `settings` takes them in the reverse order, and PostgreSQL
 *      resolves that by aborting one of the two.
 *
 * THREE SHAPES, AND WHY THE FIRST TWO FAILED.
 *
 *   ROUND 7 put `SELECT pg_advisory_xact_lock(k);` on psql's OWN stdin, inside the transaction
 *   `--single-transaction` opens. Any `COMMIT;` in the dump ended that transaction and released the
 *   lock with the replay still running.
 *
 *   ROUND 8 moved it into a Prisma interactive transaction — a session the dump cannot reach, which
 *   was the right move — but an interactive transaction HAS A TIMEOUT, and its clock starts when
 *   the transaction opens, BEFORE `pg_advisory_xact_lock` returns. A restore queued behind another
 *   one could therefore acquire the lock with a minute of its 360s budget left, whereupon Prisma
 *   aborted the transaction and released the lock while psql kept writing for another four minutes.
 *   Strictly worse than round 7: it looked protected. Reconciling that timeout against psql's own
 *   ceiling was not a matter of picking a bigger number, because the two clocks start at different
 *   moments and the gap between them is unbounded queueing time.
 *
 *   THIS SHAPE removes the clock instead of raising it. A dedicated `pg` session takes a SESSION
 *   advisory lock — `pg_try_advisory_lock`, which is held until it is explicitly unlocked or the
 *   session ends, and has no timeout of any kind. There is no transaction open on the holder, so
 *   `idle_in_transaction_session_timeout` cannot reach it either, and a keepalive `SELECT 1` every
 *   30s defends the session against `idle_session_timeout` and idle TCP reaping. The lifetime
 *   question therefore has no numbers to reconcile: the lock is released by the `finally` after the
 *   restore promise settles, and by nothing else.
 *
 * ACQUISITION IS BOUNDED, RELEASE IS NOT. `pg_advisory_lock` waits forever, which would turn a
 * contended restore into a hung request; `pg_try_advisory_lock` polled to a 60s deadline fails fast
 * with a message naming the cause. That is the one place a timeout belongs.
 *
 * WHY IT CANNOT DEADLOCK AGAINST THE RESTORE IT PROTECTS. The holder session takes the advisory lock
 * and nothing else — no table lock, no row lock, no snapshot the replay needs — so psql can DROP,
 * CREATE and rewrite freely while it waits. And the restore no longer takes the advisory lock
 * itself: two sessions asking for the same key WOULD block on each other forever.
 *
 * WHAT IS STILL NOT COVERED, stated rather than implied:
 *   • The lock ends with the holder's SESSION, so anything that kills that session (a dropped
 *     connection, a database restart, an operator's `pg_terminate_backend`) releases it while psql
 *     runs on. Nothing in the replayed SQL can cause that; an outage or an operator can. The
 *     maintenance-mode gate remains the coarse protection for that case. This is inherent to
 *     advisory locks — there is no PostgreSQL lock that outlives its session.
 *   • Only writers that TAKE this lock are serialized against the restore. That set is asserted by
 *     the inventories in tests/accounting/plugin-selection-lock.test.ts, with their own limits
 *     recorded there.
 */
export function createRestoreSelectionLockHolder(options: {
  createClient?: () => RestoreLockClient
  now?: () => number
  delay?: (ms: number) => Promise<void>
  maxWaitMs?: number
  /** How long to wait for the catalogue to stop listing a signalled restore backend. */
  backendExitConfirmMs?: number
  /** Called when the lock is deliberately NOT released. Loud by default; injectable for tests. */
  onLockRetained?: (reason: string) => void
} = {}): RestoreSelectionLockHolder {
  const createClient = options.createClient ?? (() => new pg.Client({
    connectionString: process.env.DATABASE_URL,
    application_name: 'ims_restore_lock_holder',
  }) as unknown as RestoreLockClient)
  const now = options.now ?? Date.now
  const delay = options.delay ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) }))
  const maxWaitMs = options.maxWaitMs ?? RESTORE_SELECTION_LOCK_MAX_WAIT_MS
  const backendExitConfirmMs = options.backendExitConfirmMs ?? RESTORE_BACKEND_EXIT_CONFIRM_MS
  const onLockRetained = options.onLockRetained ?? ((reason: string) => { console.error(`[restore] ${reason}`) })

  return async <T>(work: (ctx: RestoreLockContext) => Promise<T>): Promise<T> => {
    const client = createClient()
    await client.connect()
    let acquired = false
    let retained: string | null = null
    let keepalive: ReturnType<typeof setInterval> | undefined
    try {
      const deadline = now() + maxWaitMs
      for (;;) {
        const result = await client.query(
          'SELECT pg_try_advisory_lock($1) AS locked',
          [ACCOUNTING_CONNECTOR_SELECTION_LOCK_KEY],
        )
        if (result.rows[0]?.locked === true) { acquired = true; break }
        if (now() >= deadline) {
          throw new Error(
            'Could not acquire the accounting connector-selection lock within '
            + `${Math.round(maxWaitMs / 1000)}s — another restore or a connector-selection change is `
            + 'in progress. Nothing was restored.',
          )
        }
        await delay(RESTORE_SELECTION_LOCK_POLL_MS)
      }

      keepalive = setInterval(() => { void client.query('SELECT 1').catch(() => {}) }, RESTORE_LOCK_KEEPALIVE_MS)
      keepalive.unref?.()

      return await work({
        terminateAndConfirmRestoreBackends: async (applicationName: string) => {
          const deadline = now() + backendExitConfirmMs
          let found = 0
          let signalRefused = 0
          for (;;) {
            // Signalling and listing are ONE query on purpose: the rows it returns are the backends
            // that were still there at the moment they were signalled, so `remaining` cannot be
            // read from a snapshot taken before the signal.
            const listed = await client.query(
              'SELECT pid, pg_terminate_backend(pid) AS terminated FROM pg_stat_activity '
              + 'WHERE application_name = $1 AND pid <> pg_backend_pid()',
              [applicationName],
            )
            found = Math.max(found, listed.rows.length)
            // GONE FROM THE CATALOGUE. The only observation that proves the writing has stopped.
            if (listed.rows.length === 0) return { confirmed: true, found, remaining: 0 }
            signalRefused += listed.rows.filter((row) => row.terminated === false).length
            if (now() >= deadline) {
              return {
                confirmed: false,
                found,
                remaining: listed.rows.length,
                error: signalRefused > 0
                  ? 'pg_terminate_backend refused the signal for at least one backend'
                  : 'the backend was signalled but is still listed in pg_stat_activity',
              }
            }
            await delay(RESTORE_BACKEND_EXIT_POLL_MS)
          }
        },
        retainLock: (reason: string) => { retained = reason },
      })
    } finally {
      if (retained !== null) {
        // DELIBERATELY LEAKED. No unlock, no `client.end()` (which would release the lock as a side
        // effect of the session dying), and the keepalive keeps running so the session is not
        // reaped. A restore backend that may still be writing must not be overlapped by a writer
        // that thinks the coast is clear; holding a lock nobody releases makes that impossible and
        // makes the fault visible, whereas releasing it makes the fault silent.
        onLockRetained(retained)
      } else {
        if (keepalive) clearInterval(keepalive)
        // Explicit unlock first so the lock is gone before the socket teardown races; ending the
        // session releases it anyway, which is the belt to this brace.
        if (acquired) {
          try {
            await client.query('SELECT pg_advisory_unlock($1)', [ACCOUNTING_CONNECTOR_SELECTION_LOCK_KEY])
          } catch {
            // The session is about to end, which releases the lock regardless.
          }
        }
        await client.end().catch(() => {})
      }
    }
  }
}

export async function runRestore(
  filePath: string,
  db: ReturnType<typeof getDbConfig>,
  options: {
    spawnProcess?: typeof spawn
    withSelectionLock?: RestoreSelectionLockHolder
    /** Injected so the timeout path is testable without waiting five minutes. */
    psqlTimeoutMs?: number
    killGraceMs?: number
    applicationName?: string
  } = {},
): Promise<void> {
  // Before the lock: a file that cannot be replayed — a psql metacommand, transaction control, an
  // unterminated construct — must fail without ever taking a lock the whole application contends
  // on, and without opening a session for nothing.
  await validateRestoreSqlFile(filePath)
  const spawnProcess = options.spawnProcess ?? spawn
  const withSelectionLock = options.withSelectionLock ?? createRestoreSelectionLockHolder()
  const psqlTimeoutMs = options.psqlTimeoutMs ?? RESTORE_PSQL_TIMEOUT_MS
  const killGraceMs = options.killGraceMs ?? RESTORE_PSQL_KILL_GRACE_MS
  // Unique per run so the timeout path terminates THIS restore's backend and nothing else — another
  // restore cannot be running (the lock is held), but ordinary psql sessions may be.
  const applicationName = options.applicationName ?? `ims_restore_${randomBytes(6).toString('hex')}`

  await withSelectionLock(async (lock) => {
    const args = [
      '-X',
      '-h', db.host,
      '-p', db.port,
      '-U', db.user,
      '-d', db.database,
      '--single-transaction',
      '--set', 'ON_ERROR_STOP=1',
    ]
    const child = spawnProcess('psql', args, {
      // PGAPPNAME becomes the backend's `application_name`, which is the only handle we have on the
      // server-side half of this restore once the client process is gone.
      env: { ...process.env, PGPASSWORD: db.password, PGAPPNAME: applicationName },
      stdio: ['pipe', 'ignore', 'pipe'],
    })

    let stderr = ''
    let timedOut = false

    /**
     * Resolves when psql's `close` is observed, or when `killGraceMs` elapses after SIGKILL.
     *
     * ROUND 9, FINDING 2 — the old timeout path called `child.kill('SIGKILL')` and rejected
     * IMMEDIATELY, so the holder's `finally` released the lock while the child (and, more to the
     * point, its BACKEND) might still be writing. Rejecting before the process is confirmed dead is
     * releasing the lock on an assumption.
     */
    const exited = new Promise<{ code: number | null; error?: Error }>((resolve) => {
      let settled = false
      let grace: ReturnType<typeof setTimeout> | undefined

      // Declared BEFORE the listeners that clear it, so `settle` never reads it in its temporal
      // dead zone — a hazard that only bites when a child emits synchronously.
      const timeout = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
        // The promise still settles on `close` if it arrives; this only BOUNDS how long we wait
        // for it, rather than assuming the process is gone the moment SIGKILL is sent.
        grace = setTimeout(() => settle({ code: null }), killGraceMs)
      }, psqlTimeoutMs)

      const settle = (value: { code: number | null; error?: Error }) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (grace) clearTimeout(grace)
        resolve(value)
      }

      child.on('error', (error) => settle({ code: null, error }))
      child.on('close', (code) => settle({ code }))
      child.stderr.on('data', (chunk: Buffer | string) => {
        stderr += chunk.toString()
        if (stderr.length > 2000) stderr = stderr.slice(-2000)
      })
    })

    const input = createReadStream(filePath)
    input.on('error', (error) => {
      child.stdin.destroy(error)
    })
    child.stdin.on('error', () => {
      // handled by child close/error paths
    })
    // The dump, and NOTHING else. The lock statement that used to be prepended here moved into a
    // separate session (createRestoreSelectionLockHolder) — held there, it cannot be released by the
    // stream below, and prepending it as well would make psql wait forever for a lock the holder
    // already has.
    input.pipe(child.stdin)

    const result = await exited

    if (timedOut) {
      // WHAT HAPPENS IF PSQL OUTLIVES ITS OWN CEILING. SIGKILL cannot be caught, so the client is
      // gone; its BACKEND, however, keeps executing the current statement until it next notices the
      // dead socket, which for a long DDL statement can be minutes. Terminating it from the holder
      // session — which still holds the lock at this point — is what makes "the restore has stopped
      // writing" true rather than assumed. `--single-transaction` means the terminated backend
      // rolls back everything it had applied.
      //
      // ROUND 10, FINDING 2. Round 9 called the termination query and threw on the next line, so
      // the holder's `finally` released the lock having only established that a signal was SENT.
      // The confirmation is now a poll of `pg_stat_activity`, and the branch below is the whole
      // point of it: if the backend cannot be confirmed gone, the lock is NOT released.
      const outcome = await lock.terminateAndConfirmRestoreBackends(applicationName).catch((error: unknown) => ({
        confirmed: false as const,
        found: -1,
        remaining: -1,
        error: error instanceof Error ? error.message : String(error),
      }))

      if (!outcome.confirmed) {
        const reason = 'Restore timed out and its database backend could NOT be confirmed gone'
          + `${outcome.error ? ` (${outcome.error})` : ''}. The connector-selection lock is being HELD, `
          + 'not released, because a still-live restore backend may be writing the same rows a '
          + 'connector-selection change would read. Maintenance mode stays ON. Restart the '
          + 'application once the database is known to be quiet.'
        lock.retainLock(reason)
        throw new RestoreBackendNotConfirmedError(reason)
      }

      throw new Error(
        `Restore timed out (terminated ${outcome.found} database backend${outcome.found === 1 ? '' : 's'})`,
      )
    }
    if (result.error) throw result.error
    if (result.code !== 0) throw new Error(stderr.trim() || `psql exited with code ${result.code}`)
  })
}

async function sha256OfFile(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(filePath), hash)
  return hash.digest('hex')
}

async function getTargetDatabaseTimestamp(dbClient: RestoreTimestampDbClient): Promise<Date> {
  const rows = await dbClient.$queryRaw<Array<{ timestamp: Date }>>`SELECT now() AS "timestamp"`
  return rows[0]?.timestamp ?? new Date()
}

type RequiredRestoreDeps = Required<Omit<BackupRestoreHandlerDeps, 'now'>> & {
  now: () => number
}

function withDefaults(deps: BackupRestoreHandlerDeps = {}): RequiredRestoreDeps {
  return {
    authorize: deps.authorize ?? requireApiFreshAdmin,
    users: deps.users ?? db.user,
    dbClient: deps.dbClient ?? db,
    // Keep the production route wired to the live process.env object so runtime
    // restore-window changes are observed without rebuilding handlers.
    env: deps.env ?? process.env,
    backupDir: deps.backupDir ?? BACKUP_DIR,
    log: deps.log ?? logActivity,
    mailer: deps.mailer ?? sendEmail,
    setRestoreToken: deps.setRestoreToken ?? setAuthToken,
    consumeRestoreToken: deps.consumeRestoreToken ?? consumeAuthToken,
    deleteRestoreToken: deps.deleteRestoreToken ?? deleteAuthToken,
    enableMaintenance: deps.enableMaintenance ?? enableMaintenanceMode,
    disableMaintenance: deps.disableMaintenance ?? disableMaintenanceMode,
    runRestoreFile: deps.runRestoreFile ?? runRestore,
    validateBackupManifest: deps.validateBackupManifest ?? validateBackupManifestForFile,
    getAvailableDiskBytes: deps.getAvailableDiskBytes ?? getAvailableDiskBytes,
    getTargetDatabaseTimestamp: deps.getTargetDatabaseTimestamp ?? (() => getTargetDatabaseTimestamp(deps.dbClient ?? db)),
    now: deps.now ?? Date.now,
  }
}

export function createBackupRestoreGetHandler(deps: BackupRestoreHandlerDeps = {}) {
  const resolvedDeps = withDefaults(deps)
  return async function GET(req?: NextRequest) {
    const session = await resolvedDeps.authorize()
    if (session instanceof NextResponse) return session
    if (!isProductionRestoreAllowed(resolvedDeps.env)) {
      await logDeniedRestoreAttempt(resolvedDeps, session.user.id, 'production_restore_disabled')
      return restoreDisabledResponse()
    }

    const user = await resolvedDeps.users.findUnique({
      where: { id: session.user.id },
      select: { email: true },
    })
    const email = user?.email?.trim().toLowerCase()
    if (!email) {
      return NextResponse.json({ error: 'Your user account does not have an email address configured.' }, { status: 400 })
    }

    const restoreToken = randomBytes(4).toString('hex').toUpperCase()
    const restoreTokenKey = `backup_restore:${restoreToken}`
    const payload = restoreTokenPayload(session, req)
    if (!payload) return missingRestoreClientIpResponse()
    await resolvedDeps.setRestoreToken(
      restoreTokenKey,
      serializeRestoreTokenPayload(payload),
      RESTORE_TOKEN_TTL_MS,
    )
    const mail = await resolvedDeps.mailer({
      to: email,
      subject: 'Backup restore confirmation code',
      html: formatRestoreEmail(restoreToken),
    })
    if (!mail.success) {
      await resolvedDeps.deleteRestoreToken(restoreTokenKey)
      return NextResponse.json({ error: mail.error ?? 'Failed to send restore confirmation email.' }, { status: 500 })
    }

    return NextResponse.json({ success: true, email, expiresInSec: RESTORE_TOKEN_TTL_MS / 1000 })
  }
}

export function createBackupRestorePostHandler(deps: BackupRestoreHandlerDeps = {}) {
  const resolvedDeps = withDefaults(deps)
  return async function POST(req: NextRequest) {
    const session = await resolvedDeps.authorize()
    if (session instanceof NextResponse) return session
    const originCheck = checkSameOriginRequest(req, resolvedDeps.env)
    if (!originCheck.allowed) {
      await logDeniedRestoreAttempt(resolvedDeps, session.user.id, originCheck.denialReason ?? 'cross_origin_restore_request')
      return NextResponse.json({ error: 'Cross-site restore requests are not allowed.' }, { status: 403 })
    }

    if (!isProductionRestoreAllowed(resolvedDeps.env)) {
      await logDeniedRestoreAttempt(resolvedDeps, session.user.id, 'production_restore_disabled')
      return restoreDisabledResponse()
    }

    const maxRestoreFileBytes = getMaxRestoreFileBytes(resolvedDeps.env)
    const maxRestoreFormBytes = getMaxRestoreFormBytes(resolvedDeps.env)
    const contentType = req.headers.get('content-type') ?? ''
    const contentLength = req.headers.get('content-length')
    if (contentType.includes('multipart/form-data')) {
      if (!contentLength) {
        return NextResponse.json({ error: 'Restore upload must include Content-Length.' }, { status: 411 })
      }
      const requestBytes = Number.parseInt(contentLength, 10)
      if (!Number.isFinite(requestBytes) || requestBytes <= 0) {
        return NextResponse.json({ error: 'Restore upload size is invalid.' }, { status: 400 })
      }
      if (requestBytes > maxRestoreFormBytes) {
        return NextResponse.json({ error: 'Restore upload is too large.' }, { status: 413 })
      }
    }

    const formData = await req.formData()
    const confirmationPhrase = formData.get('confirmationPhrase')
    const restoreToken = formData.get('restoreToken')
    if (confirmationPhrase !== 'RESTORE') {
      return NextResponse.json({ error: 'Restore confirmation missing.' }, { status: 400 })
    }
    if (typeof restoreToken !== 'string' || !/^[0-9A-Fa-f]{8}$/.test(restoreToken.trim())) {
      return NextResponse.json({ error: 'Restore email code missing.' }, { status: 400 })
    }

    const file = formData.get('file') as File | null
    const manifestFile = formData.get('manifestFile') as File | null
    const filename = formData.get('filename') as string | null
    const expectedRestoreTokenPayload = restoreTokenPayload(session, req)
    if (!expectedRestoreTokenPayload) {
      return NextResponse.json({ error: 'Cannot verify restore token without verifiable client IP.' }, { status: 400 })
    }

    let restorePath: string
    let uploadedTempFile = false
    let sourceBackupTimestamp: string
    let sourceBackupName: string
    let sourceType: 'uploaded_file' | 'stored_backup'
    let sourceBackupBytes: number
    let targetDatabaseTimestamp: string

    if (file) {
      if (!isProductionUploadRestoreAllowed(resolvedDeps.env)) {
        await logDeniedRestoreAttempt(resolvedDeps, session.user.id, 'production_upload_restore_disabled')
        return NextResponse.json({ error: 'Uploaded database restore is disabled in production.' }, { status: 403 })
      }
      if (!file.name.endsWith('.sql')) {
        return NextResponse.json({ error: 'Invalid file type. Only plain SQL (.sql) backups are supported. PostgreSQL custom-format .dump files require pg_restore and are not supported.' }, { status: 400 })
      }
      if (file.size > maxRestoreFileBytes) {
        return NextResponse.json({ error: 'Restore file is too large.' }, { status: 413 })
      }
      const manifest = await parseUploadedBackupManifest(manifestFile, file.name)
      if (manifest instanceof NextResponse) return manifest
      await mkdir(resolvedDeps.backupDir, { recursive: true })
      const diskSpaceResponse = await validateRestoreDiskSpace(resolvedDeps, file.size, manifest)
      if (diskSpaceResponse) return diskSpaceResponse
      const targetTimestamp = await getRestoreTargetDatabaseTimestamp(resolvedDeps)
      if (targetTimestamp instanceof NextResponse) return targetTimestamp
      targetDatabaseTimestamp = targetTimestamp
      // Validate upload policy and shape before consuming the one-time email code.
      const tokenMatches = await consumeMatchingRestoreToken(resolvedDeps, restoreToken, expectedRestoreTokenPayload)
      if (!tokenMatches) {
        return NextResponse.json({ error: 'Restore email code invalid or expired.' }, { status: 400 })
      }
      restorePath = path.join(resolvedDeps.backupDir, `restore-upload-${resolvedDeps.now()}.sql`)
      const uploadStream = file.stream() as unknown as NodeReadableStream<Uint8Array>
      await pipeline(
        Readable.fromWeb(uploadStream),
        createWriteStream(restorePath),
      )
      uploadedTempFile = true
      sourceBackupTimestamp = new Date(resolvedDeps.now()).toISOString()
      sourceBackupName = path.basename(file.name)
      sourceType = 'uploaded_file'
      sourceBackupBytes = file.size
    } else if (filename) {
      if (!filename.endsWith('.sql')) {
        return NextResponse.json({ error: 'Invalid backup filename.' }, { status: 400 })
      }
      const resolved = resolveBackupPath(resolvedDeps.backupDir, filename)
      if (!resolved) {
        return NextResponse.json({ error: 'Invalid backup filename.' }, { status: 400 })
      }
      restorePath = resolved
      try {
        await access(restorePath)
      } catch {
        return NextResponse.json({ error: 'Backup file not found.' }, { status: 404 })
      }
      const fileInfo = await stat(restorePath)
      if (fileInfo.size > maxRestoreFileBytes) {
        return NextResponse.json({ error: 'Restore file is too large.' }, { status: 413 })
      }
      let manifest: BackupManifest
      try {
        manifest = await resolvedDeps.validateBackupManifest(restorePath)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return NextResponse.json({ error: `Backup manifest validation failed: ${message.slice(0, 200)}` }, { status: 400 })
      }
      if (manifest.backupFilename !== path.basename(restorePath)) {
        return NextResponse.json({ error: 'Backup manifest does not match the selected backup.' }, { status: 400 })
      }
      const diskSpaceResponse = await validateRestoreDiskSpace(resolvedDeps, fileInfo.size, manifest)
      if (diskSpaceResponse) return diskSpaceResponse
      sourceBackupTimestamp = fileInfo.mtime.toISOString()
      sourceBackupName = path.basename(restorePath)
      sourceType = 'stored_backup'
      sourceBackupBytes = fileInfo.size
      const targetTimestamp = await getRestoreTargetDatabaseTimestamp(resolvedDeps)
      if (targetTimestamp instanceof NextResponse) return targetTimestamp
      targetDatabaseTimestamp = targetTimestamp
      const tokenMatches = await consumeMatchingRestoreToken(resolvedDeps, restoreToken, expectedRestoreTokenPayload)
      if (!tokenMatches) {
        return NextResponse.json({ error: 'Restore email code invalid or expired.' }, { status: 400 })
      }
    } else {
      return NextResponse.json({ error: 'No file provided.' }, { status: 400 })
    }

    const cleanup = async () => {
      if (!uploadedTempFile) return
      try {
        await unlink(restorePath)
      } catch {
        // Best-effort cleanup only.
      }
    }

    const restoreDbConfig = getDbConfig(resolvedDeps.env)
    /** Set when the restore backend could not be confirmed gone — the gate then stays on. */
    let holdMaintenance = false

    try {
      const sourceBackupSha256 = await sha256OfFile(restorePath)
      await resolvedDeps.log({
        entityType: 'SYSTEM',
        tag: 'system',
        action: 'backup_restore_initiated',
        level: 'WARNING',
        userId: session.user.id,
        resolveUser: false,
        description: `Initiated database restore from backup: ${sourceBackupName}`,
        metadata: {
          severity: 'critical',
          sourceBackupTimestamp,
          targetDatabaseTimestamp,
          initiatedBy: session.user.id,
          sourceBackupName,
          sourceType,
          sourceBackupBytes,
          sourceBackupSha256,
        },
      })
      await resolvedDeps.enableMaintenance(`Database restore requested by admin ${session.user.id}`)
      await resolvedDeps.runRestoreFile(restorePath, restoreDbConfig)
      await resolvedDeps.log({
        entityType: 'SYSTEM',
        tag: 'system',
        action: 'backup_restored',
        level: 'WARNING',
        // For uploads this is the generated temp filename, never user input.
        description: `Restored database from backup: ${path.basename(restorePath)}`,
      })
      return NextResponse.json({ success: true })
    } catch (error) {
      // ROUND 10, FINDING 2, second half. Switching maintenance mode back off is the same shape of
      // mistake as releasing the lock: it reopens the application to writers on the strength of an
      // assumption that the restore has stopped. When the backend could not be confirmed gone, the
      // one honest state is "still down", so the gate STAYS ON and the operator is told why.
      const backendUnconfirmed = error instanceof RestoreBackendNotConfirmedError
      const message = redactRestoreErrorMessage(error instanceof Error ? error.message : String(error), resolvedDeps.env)
      await resolvedDeps.log({
        entityType: 'SYSTEM',
        tag: 'system',
        action: 'backup_restored',
        level: 'ERROR',
        metadata: backendUnconfirmed ? { error: message, backendUnconfirmed: true, maintenanceModeHeld: true } : { error: message },
        description: `Failed to restore backup: ${message}`,
      })
      if (backendUnconfirmed) holdMaintenance = true
      return NextResponse.json({ error: `Restore failed: ${message.slice(0, 200)}` }, { status: 500 })
    } finally {
      // Unconditional EXCEPT for the unconfirmed-backend case: a failed `enableMaintenance` may
      // still have applied, so the cleanup runs anyway.
      if (!holdMaintenance) await resolvedDeps.disableMaintenance()
      await cleanup()
    }
  }
}

export const GET = createBackupRestoreGetHandler()
export const POST = createBackupRestorePostHandler()
