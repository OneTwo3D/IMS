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
import { disableMaintenanceMode, enableMaintenanceMode, recordMaintenanceHold } from '@/lib/maintenance-mode'
import { sendEmail } from '@/lib/mailer'
import { consumeAuthToken, deleteAuthToken, setAuthToken } from '@/lib/auth/token-store'
import { db } from '@/lib/db'
import { ACCOUNTING_CONNECTOR_SELECTION_LOCK_KEY } from '@/lib/db/advisory-locks'
import { pgConnectionConfig, pinClientToMeasuredBackend } from '@/lib/db/database-url-schema.mjs'
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
  recordMaintenanceHold?: typeof recordMaintenanceHold
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
 * How long to wait for the restore's backend to appear in `pg_stat_activity` after `psql` is
 * spawned and before any of the dump is written to it. Generous, because the cost of waiting is a
 * delayed start and the cost of giving up early is a restore that runs unidentified — but bounded,
 * because nothing has been streamed yet, so expiry is a clean no-op failure.
 */
const RESTORE_BACKEND_IDENTIFY_MS = 30_000
const RESTORE_BACKEND_IDENTIFY_POLL_MS = 100

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
 * So confirmation is a POLL, not a return value: signal, then re-read `pg_stat_activity` until
 * nothing answers, or until the deadline. `confirmed` is true only when the backend is GONE from
 * the catalogue — the one observation that makes "the restore has stopped writing" a fact rather
 * than an inference. (`pg_terminate_backend(pid, timeout)` would do the waiting server-side, but it
 * is PostgreSQL 14+; the poll works on every version this application supports.)
 *
 * ══ ROUND 11, FINDING 2 — THE POLL WAS KEYED ON SOMETHING THE RESTORE CAN CHANGE ══
 *
 * Round 10 polled `WHERE application_name = $1`. `application_name` is a GUC: any statement in the
 * replayed file — `SET application_name = 'x'`, or a `SET` inside a function body — changes it, and
 * the backend then vanishes from a query that only knows that name. Zero rows was read as "gone",
 * so the lock was released and maintenance mode switched off while the backend went on writing.
 * The confirmation confirmed A NAME, not a process, and the name belonged to the thing being
 * confirmed. That is the same shape as round 9's "the signal is not the death", one level up: an
 * observation the observed party controls is not evidence.
 *
 * SO IDENTITY IS TAKEN ONCE, EARLY, AND IS IMMUTABLE THEREAFTER. `(pid, backend_start)` is a
 * property of the BACKEND — no SQL can change either, and `backend_start` disambiguates a reused
 * pid. It is captured by `identifyRestoreBackend` immediately after `psql` is spawned and BEFORE a
 * single byte of the dump reaches its stdin, which is what makes `application_name` trustworthy at
 * that one moment: `psql` connects at startup, so the backend exists and still carries `PGAPPNAME`
 * before it can have executed anything that would rename it. From then on the name is never used
 * again. If the backend cannot be identified in that window, NOTHING has been streamed, so the
 * restore fails having changed nothing — a bounded, clean refusal rather than a guess.
 *
 * `backend_start` is compared AS TEXT, in the database's own rendering. `pg_stat_activity` stores it
 * with microsecond precision and a JavaScript `Date` has milliseconds, so round-tripping it through
 * the driver would silently lose the digits the comparison depends on and match a DIFFERENT
 * backend on a reused pid.
 */
export type RestoreBackendIdentity = {
  pid: number
  /** `backend_start::text`, exactly as the server rendered it. Never a parsed Date — see above. */
  backendStart: string
}

/** What `identifyRestoreBackend` could establish before any SQL was streamed. */
export type RestoreBackendIdentification =
  | { status: 'identified'; identity: RestoreBackendIdentity }
  | { status: 'not-found' }
  /** More than one backend answered to the name, so none of them is provably ours. */
  | { status: 'ambiguous'; pids: number[] }

export type RestoreBackendTerminationResult = {
  /** True ONLY when pg_stat_activity no longer lists THE identified backend. */
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
   * Record `(pid, backend_start)` for the backend currently answering to `applicationName`.
   *
   * MUST be called before any of the dump is streamed — that is the only moment the name is a
   * trustworthy handle, because the backend has not yet executed anything that could rename it.
   */
  identifyRestoreBackend: (applicationName: string) => Promise<RestoreBackendIdentification>
  /**
   * Terminate the identified backend and WAIT until the catalogue agrees it is gone, matching on
   * `(pid, backend_start)` — which the restore cannot change about itself. Used only on the timeout
   * path.
   */
  terminateAndConfirmRestoreBackend: (identity: RestoreBackendIdentity) => Promise<RestoreBackendTerminationResult>
  /**
   * KEEP THE LOCK. Called when the restore backend could not be confirmed dead: releasing then
   * would hand the connector-selection lock to a writer while a restore may still be replaying over
   * the same rows, which is the exact state the lock exists to prevent — and it would look
   * protected. The holder's session, its keepalive and the advisory lock are all deliberately
   * leaked; the recovery is an operator's, and that is the loud failure this is choosing.
   *
   * WHAT THIS DOES AND DOES NOT BUY, because round 11 found the surrounding claim was too big:
   * it stops the writers that TAKE this lock, and nothing else. It does not stop an interactive
   * dashboard write. See `MAINTENANCE_MODE_REACH`.
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
/**
 * WHAT MAINTENANCE MODE ACTUALLY FENCES (o3d-osl8 round 11, finding 4).
 *
 * Round 10 left maintenance mode ON when a restore backend could not be confirmed gone, and said
 * that kept the application down. IT DOES NOT. In this repository the flag is consulted in exactly
 * two places — `app/api/cron/*` route handlers and the connector webhook entry point
 * (`lib/connectors/woocommerce/webhooks.ts`), both via `getMaintenanceModeResponse`. NOTHING ELSE
 * READS IT. Every interactive server action under `app/actions/*` writes straight through it, and
 * so does every other API route. So an unconfirmed restore can still overlap ordinary dashboard
 * writes, and the round-10 recovery was weaker than it read — which is worse than an outright gap,
 * because the next person to touch this path would have trusted it.
 *
 * ROUND 12, FINDING 4 — AND THE SECOND CONSECUTIVE ROUND IN WHICH THIS CLAIM WAS WRONG.
 *
 * Round 11 rewrote the sentence above after measuring the flag's readers, and it was STILL false:
 * it said "inbound connector webhooks" are fenced. They are not. Only the WooCommerce ones are.
 *
 * The measurement was taken the wrong way round. Enumerating `getMaintenanceModeResponse` callers
 * answers "what consults the flag?", which can only ever confirm the things that do — it cannot
 * name an entry point that does not, because such a route contains nothing to grep for. The
 * inventory has to start from the ROUTES and classify each one. Doing that:
 *
 *   app/api/webhooks/shopping/[connector]/[resource]  → FENCED only for `woocommerce`. The route
 *       itself never reads the flag; `handleShoppingWebhook` dispatches on the connector and only
 *       `handleWcWebhook` checks it (first thing it does, before any write). A `shopify` delivery
 *       to the same route reaches `lib/connectors/shopify` unfenced — currently a 501 stub, so it
 *       is not a live writer, but it is not fenced either and will not become fenced by itself.
 * wms-connector-boundary-ok: o3d-hl8l: naming which routes maintenance mode does and does not fence is the measured claim itself, not connector dispatch.
 *   app/api/webhooks/mintsoft/asn-booked-in            → FENCED as of o3d-hl8l. The route consults
 *       the flag as its FIRST statement, before the body is read and before the signature is
 *       verified, so nothing on the persist path runs during a held restore.
 * wms-connector-boundary-ok: o3d-hl8l: naming which routes maintenance mode does and does not fence is the measured claim itself, not connector dispatch.
 *   app/api/webhooks/shiphero/[event]                  → STILL NOT FENCED. Persists via
 * wms-connector-boundary-ok: o3d-hl8l: naming which routes maintenance mode does and does not fence is the measured claim itself, not connector dispatch.
 *       `persistShipheroWebhookEvent` with no maintenance check anywhere on the path. Left as a
 * wms-connector-boundary-ok: o3d-hl8l: naming which routes maintenance mode does and does not fence is the measured claim itself, not connector dispatch.
 *       stated gap by owner instruction (o3d-hl8l scoped the fix to the Mintsoft half); the row
 *       below says `fenced: 'no'` because that is what the route does, not because nobody looked.
 *   app/api/accounting/callback                        → NOT FENCED. An inbound OAuth callback
 *       that writes credentials and activity rows.
 *
 * wms-connector-boundary-ok: o3d-hl8l: naming which routes maintenance mode does and does not fence is the measured claim itself, not connector dispatch.
 * o3d-hl8l CLOSED THE MINTSOFT HALF, and the durability question that deferred it. The choice was
 * between fencing (and relying on sender retry) and persisting-then-deferring (the o3d-56b shape).
 * Persisting loses either way: the ONLY caller that enables this flag is this endpoint, and the
 * window it stays on for is a restore that may still be replaying — a row written into it is
 * overwritten, so `202 accepted` would be a promise the restore breaks. A 503 promises nothing and
 * is the standard retry signal.
 *
 * WHAT THE RESIDUAL RISK IS ACTUALLY BOUNDED BY (round 3, finding 1 — the third consecutive round in
 * which this sentence claimed more than the code does). It said "the watchdog's open-ASN-past-ETA
 * wms-connector-boundary-ok: o3d-hl8l: naming the recovery helper that cannot reach a refused callback is the correction itself.
 * alert and the ASN replay". THE ASN REPLAY CANNOT REACH IT: `replayMintsoftBookedInEventsForAsn`
 * re-drives receipt-event rows that already exist, and a refused callback leaves none — which
 * o3d-hl8l round 2 established at the fence itself and then did not correct here. The recovery is
 * wms-connector-boundary-ok: o3d-hl8l: naming the recovery that CAN reach it is the correction itself.
 * `enqueueMintsoftBookedInRecheckForAsn` ("Re-check" on the purchase order's ASN table), which
 * reconstructs the trigger and re-reads the quantities from the warehouse.
 *
 * ROUND 4, FINDING 1 — THE FOURTH CONSECUTIVE ROUND IN WHICH THIS PARAGRAPH OVERSTATED THE
 * RECOVERY. Round 3 listed three bounds and called them a bound. Every one of them was conditional,
 * and on a DEFAULT INSTALLATION none of them held: the sender may not retry (its behaviour, not
 * ours); the "Re-check" control existed on the purchase-order ASN table ONLY, while stock-transfer
 * ASNs go through the same callback processor and the same fence; and the watchdog that was named
 * as the backstop was registered `defaultEnabled: false`, so it did not run. Their intersection —
 * a transfer ASN, a sender that gives up, a watchdog nobody enabled — was an ASN left IN_TRANSIT
 * with its destination stock never applied, and NOTHING anywhere that would ever say so.
 *
 * WHAT ACTUALLY RECOVERS IT NOW, in the order it happens:
 *   • AT REFUSAL — the process log, and nothing else. `recordMaintenanceRefusal` in the webhook
 *     route emits a line naming the route and the remedy. It writes NO database row, deliberately:
 *     a row written into this window is being replayed over, and the fence runs before signature
 *     verification, so persisting would mean writing rows from unauthenticated callers. THE ROW
 *     THAT IS WRITTEN INSTEAD is about the WINDOW, not the callback — see the hold record below —
 *     because the window is a thing this endpoint knows and is authenticated to record, while the
 *     refusals are neither.
 *   • THE 503 carries `Retry-After: 300`, so a sender that retries at all has a defined schedule
 *     rather than whatever its own backoff decides.
 *   • AUTOMATICALLY, WITHIN MINUTES OF THE WINDOW CLOSING — `disableMaintenanceMode` stamps
 * wms-connector-boundary-ok: o3d-hl8l: the recovery is hosted on the Mintsoft sweeper; naming the job that carries it IS the correction.
 *     `wms_booked_in_recheck_due_since` whenever a real window ends, and the Mintsoft webhook
 *     sweeper (`defaultEnabled: true`, every five minutes, itself fenced so it cannot run during the
 *     window) drains that stamp by re-checking EVERY open ASN — purchase-order and stock-transfer
 *     alike, because the candidates come from `wms_asn_maps` rather than from whichever screens have
 *     a button. See lib/domain/wms/post-maintenance-recheck.ts for why re-checking indiscriminately
 *     is the only available targeting (the refusal is unrecordable, so there is no set of "the ones
 *     that were refused") and why it is safe (a re-check reconstructs the TRIGGER; an ASN with
 *     nothing outstanding books nothing in). The stamp is kept, not cleared, if any candidate threw
 *     or the page truncated, so the next tick finishes the job.
 *   • BY HAND, at any time — "Re-check" on the ASN, now present on BOTH the purchase-order and the
 *     stock-transfer ASN tables (one shared component, so they cannot diverge again).
 *   • THE ALERT — the WMS watchdog, NOW `defaultEnabled: true`, and only after ETA + 24h, or 7 days
 *     for an ASN with no ETA recorded, or 7 days of renewed silence for one that had already had a
 *     partial callback. It requires a WMS connector to be enabled and at least one active ADMIN to
 *     notify, and it fires ONCE per ASN (deduped by `sloAlertedAt`, cleared only by a fresh callback
 *     or a close). Its message names the Re-check remedy AND links to the screen that carries it for
 *     that ASN's kind — it previously said "purchase order → ASNs" for a transfer ASN, sending the
 *     reader to a page that could not act on it.
 *
 * So: a refused callback is recorded in the log, retried by any sender that honours a 503,
 * automatically re-checked within about five minutes of the window closing, recoverable by one
 * operator action on either kind of ASN, and alerted on a scale of days if it is still open for some
 * other reason.
 *
 * ROUND 5, FINDING 1 — AND THE PATH ROUND 4 NAMED AS "NOT AUTOMATIC" WAS THE ONE THAT MATTERED.
 *
 * Round 4 closed the ordinary window and then wrote off the held one: the stamp is written by
 * `disableMaintenanceMode`, the unconfirmed-backend branch below never calls it, so the operator
 * cleared `system_maintenance_mode` by hand and no stamp was ever written. It said this was
 * acceptable because nobody walks that path unattended. That reasoning is backwards. The held branch
 * is the branch where the window lasts LONGEST — a timed-out restore plus however long it takes
 * somebody to notice, quiesce the application and verify a backend — so it is the branch most likely
 * to have refused callbacks, and it was the only one with no automatic recovery at all. "The remedy
 * exists but this path skips it" is not a bound; it is the defect.
 *
 * WHAT CLOSES IT (lib/domain/system/maintenance-recovery.ts):
 *   • THE HOLD IS RECORDED. `recordMaintenanceHold` writes `system_maintenance_hold` — why, when,
 *     and the `(pid, backend_start)` that has to be gone — from the handler's catch, after the
 *     decision to hold the gate and best-effort, because this write is to the database whose restore
 *     just failed. A lost record degrades to round 4's behaviour, not to anything worse.
 *   • THE EXCEPTION INBOX RENDERS IT, and counts it in the /sync banner total, so a held window is
 *     visible from the application instead of only in a log line and an HTTP response nobody kept.
 *   • "END THE HOLD" IS AN OPERATOR ACTION, and it is now the ONLY sanctioned clear. It re-reads the
 *     flag and the record `FOR UPDATE`, re-checks the backend against `pg_stat_activity` at the
 *     moment of the click, refuses by name if any precondition has moved — and STAMPS
 *     `wms_booked_in_recheck_due_since` in the same transaction. That last part is the whole point:
 *     the hand-written UPDATE ended the window and scheduled nothing.
 *   • "RUN THE RE-CHECK NOW" drains that stamp on demand, for an installation whose five-minute cron
 *     is disabled or whose scheduler is down — which is not a rare state on the day a restore was
 *     needed. It refuses while the flag is still on, because a re-check issued into the window is
 *     stopped at the same gate the callbacks were.
 *
 * WHAT IS STILL NOT CLAIMED. The backend check proves the backend has DETACHED, not that the
 * application is quiet — the inbox row says so in those words, and the fence inventory below is
 * still the honest statement of what maintenance mode reaches. And if the hold record is lost with
 * the restore's rollback, there is no inbox row: the window is then ended the old way, by hand, and
 * its refused callbacks fall back to the watchdog and the per-ASN Re-check.
 *
 * So ONE inbound webhook entry point and one OAuth callback still write to the database throughout
 * a held restore, and the operator message below names them.
 *
 * WHAT IS THEREFORE CLAIMED, and nothing beyond it:
 *   • HELD: the accounting connector-selection advisory lock, on a leaked session. That serializes
 *     the writers inventoried in tests/accounting/plugin-selection-lock.test.ts and no others.
 * wms-connector-boundary-ok: o3d-hl8l: naming which routes maintenance mode does and does not fence is the measured claim itself, not connector dispatch.
 *   • FENCED: scheduled jobs (`app/api/cron/*`), WooCommerce webhooks, and the Mintsoft ASN
 *     booked-in webhook.
 * wms-connector-boundary-ok: o3d-hl8l: naming which routes maintenance mode does and does not fence is the measured claim itself, not connector dispatch.
 *   • NOT FENCED: the ShipHero webhook route, the accounting OAuth callback, interactive writes
 *     from the dashboard, other API routes, and anything holding a direct database connection. The
 *     operator has to take the application out of service to stop those; the message below says so
 *     in those words rather than implying it is already down.
 *
 * AND THE RECOVERY IS NOT "RESTART". Restarting drops the holder's session, which RELEASES the
 * advisory lock — the one protection that is real — while the restore backend may still be
 * replaying. It also leaves maintenance mode enabled, because the flag lives in the `settings`
 * table and this path deliberately never clears it, so scheduled jobs and webhooks stay off with no
 * screen to turn them back on. Both facts are in the operator message, in the order they have to be
 * acted on: quiesce, verify the named backend is gone, then restart, then clear the flag.
 *
 * This constant exists so the claim is a thing tests can pin (tests/api/backup-restore.test.ts
 * asserts the reach against the repository), rather than prose that drifts away from the code.
 */
export const MAINTENANCE_MODE_REACH = {
  // wms-connector-boundary-ok: o3d-hl8l: the fence inventory is measured from route paths; naming the route IS the measurement.
  /** Route-handler families that consult the flag before doing work. */
  fenced: [
    'app/api/cron/*',
    // wms-connector-boundary-ok: o3d-hl8l: naming which routes maintenance mode does and does not fence is the measured claim itself, not connector dispatch.
    'app/api/webhooks/mintsoft/asn-booked-in/route.ts',
    'lib/connectors/woocommerce/webhooks.ts',
  ] as const,
  /** Everything else, stated so it cannot be quietly assumed. */
  notFenced: ['app/actions/* (interactive server actions)', 'all other app/api/* routes'] as const,
  /**
   * INBOUND WEBHOOK ENTRY POINTS, classified individually (round 12, finding 4).
   *
   * Kept separate from `fenced`/`notFenced` because those are stated as path GLOBS, and a glob is
   * exactly what hid this: `app/api/webhooks/shopping/[connector]/[resource]` is fenced for one
   * connector and not for another, which no glob can express. Enumerated from the route files, so
   * a new webhook route that is not listed here fails the test that pins this.
   */
  inboundWebhooks: [
    { route: 'app/api/webhooks/shopping/[connector]/[resource]', fenced: 'woocommerce-only' },
    // wms-connector-boundary-ok: o3d-hl8l: naming which routes maintenance mode does and does not fence is the measured claim itself, not connector dispatch.
    { route: 'app/api/webhooks/mintsoft/asn-booked-in', fenced: 'yes' },
    // wms-connector-boundary-ok: o3d-hl8l: naming which routes maintenance mode does and does not fence is the measured claim itself, not connector dispatch.
    // Honestly 'no', not "unreviewed": o3d-hl8l deliberately scoped the fix to the Mintsoft half.
    // wms-connector-boundary-ok: o3d-hl8l: naming which routes maintenance mode does and does not fence is the measured claim itself, not connector dispatch.
    { route: 'app/api/webhooks/shiphero/[event]', fenced: 'no' },
    { route: 'app/api/accounting/callback', fenced: 'no' },
  ] as const,
  /**
   * o3d-hl8l r5 (Codex r4 finding 1): there IS a control now — Sync → Exceptions → "Maintenance
   * window" — and it is the only clear that also stamps the booked-in re-check. It refuses unless
   * the flag is really on, a hold was really recorded, and the named backend is really gone.
   */
  hasOperatorControl: true,
} as const

export class RestoreBackendNotConfirmedError extends Error {
  /**
   * The backend the operator has to see gone before the hold can be ended (o3d-hl8l r5).
   *
   * Carried on the error rather than recorded where it is thrown, because the recovery row is the
   * HANDLER's to write: only the handler knows the redacted message, and only it is downstream of
   * the decision to hold the gate — which must never be downstream of a database write.
   */
  readonly identity: RestoreBackendIdentity & { applicationName: string }

  constructor(message: string, identity: RestoreBackendIdentity & { applicationName: string }) {
    super(message)
    this.name = 'RestoreBackendNotConfirmedError'
    this.identity = identity
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
 *     runs on. Nothing in the replayed SQL can cause that; an outage or an operator can. This is
 *     inherent to advisory locks — there is no PostgreSQL lock that outlives its session. NOTHING
 *     ELSE COVERS THAT CASE: maintenance mode is not a global write fence (see
 *     `MAINTENANCE_MODE_REACH` below), so the honest statement is that the window is unprotected,
 *     not that a coarser gate catches it.
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
  /** How long to wait for the restore's backend to appear, before any SQL is streamed. */
  backendIdentifyMs?: number
  /** Called when the lock is deliberately NOT released. Loud by default; injectable for tests. */
  onLockRetained?: (reason: string) => void
} = {}): RestoreSelectionLockHolder {
  // BUILT FROM THE GUARDED CONFIG (o3d-2k5r r23, Codex HIGH). This client takes the advisory lock
  // that decides whether a restore may overwrite the database, and it reads `pg_stat_activity` to
  // confirm the restore's own backend has gone. A raw `{ connectionString: DATABASE_URL }` carries
  // no `search_path` pin and none of the per-connection backend checks, so on a deployment whose
  // schema needs a non-ASCII startup option it could hold the lock on a backend other than the one
  // the restore runs against. `pinClientToMeasuredBackend` is a no-op for an ASCII schema — it
  // returns the client untouched when the config carries no guard.
  const createClient = options.createClient ?? (() => {
    const clientConfig = {
      ...pgConnectionConfig(process.env.DATABASE_URL),
      application_name: 'ims_restore_lock_holder',
    }
    return pinClientToMeasuredBackend(new pg.Client(clientConfig), clientConfig) as unknown as RestoreLockClient
  })
  const now = options.now ?? Date.now
  const delay = options.delay ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) }))
  const maxWaitMs = options.maxWaitMs ?? RESTORE_SELECTION_LOCK_MAX_WAIT_MS
  const backendExitConfirmMs = options.backendExitConfirmMs ?? RESTORE_BACKEND_EXIT_CONFIRM_MS
  const backendIdentifyMs = options.backendIdentifyMs ?? RESTORE_BACKEND_IDENTIFY_MS
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
        identifyRestoreBackend: async (applicationName: string) => {
          // The ONE use of `application_name`, and only before the dump is streamed. Polled because
          // psql's connection is not instantaneous; bounded because a backend that never appears
          // means nothing was ever written and the run can fail cleanly.
          const deadline = now() + backendIdentifyMs
          for (;;) {
            const listed = await client.query(
              'SELECT pid, backend_start::text AS backend_start FROM pg_stat_activity '
              + 'WHERE application_name = $1 AND pid <> pg_backend_pid()',
              [applicationName],
            )
            if (listed.rows.length === 1) {
              const row = listed.rows[0]
              const pid = Number(row.pid)
              const backendStart = typeof row.backend_start === 'string' ? row.backend_start : ''
              if (Number.isFinite(pid) && backendStart !== '') {
                return { status: 'identified', identity: { pid, backendStart } }
              }
            }
            if (listed.rows.length > 1) {
              // Two sessions answering to a per-run random name is not a state this code can reason
              // about, and picking one would be a guess about which is writing.
              return { status: 'ambiguous', pids: listed.rows.map((row) => Number(row.pid)) }
            }
            if (now() >= deadline) return { status: 'not-found' }
            await delay(RESTORE_BACKEND_IDENTIFY_POLL_MS)
          }
        },
        terminateAndConfirmRestoreBackend: async (identity: RestoreBackendIdentity) => {
          const deadline = now() + backendExitConfirmMs
          let found = 0
          let signalRefused = 0
          for (;;) {
            // Signalling and listing are ONE query on purpose: the rows it returns are the backends
            // that were still there at the moment they were signalled, so `remaining` cannot be
            // read from a snapshot taken before the signal.
            //
            // MATCHED ON `(pid, backend_start)`, NOT ON A NAME (round 11, finding 2). Neither is
            // settable from SQL, so a restore that renames itself — or that a function body renames
            // — is still found here, and a pid the operating system has recycled onto a different
            // backend is not mistaken for ours.
            const listed = await client.query(
              'SELECT pid, pg_terminate_backend(pid) AS terminated FROM pg_stat_activity '
              + 'WHERE pid = $1 AND backend_start::text = $2 AND pid <> pg_backend_pid()',
              [identity.pid, identity.backendStart],
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

    /**
     * IDENTIFY THE BACKEND BEFORE THE FIRST BYTE OF THE DUMP (round 11, finding 2).
     *
     * This ordering IS the guarantee. `psql` connects to the database as it starts, so its backend
     * exists and still carries `PGAPPNAME` before it has read anything from stdin — and nothing is
     * written to stdin until this resolves. The name is therefore trustworthy exactly here and
     * nowhere afterwards, which is why `(pid, backend_start)` is captured now and used from then on.
     *
     * Raced against the child exiting so a `psql` that fails to start (missing binary, refused
     * connection) fails in milliseconds instead of waiting out the identification window.
     */
    const identified = await Promise.race([
      lock.identifyRestoreBackend(applicationName),
      exited.then(() => 'child-exited' as const),
    ])

    if (identified === 'child-exited') {
      const early = await exited
      if (early.error) throw early.error
      throw new Error(
        stderr.trim()
        || `psql exited with code ${early.code} before its database backend could be identified. Nothing was restored.`,
      )
    }

    if (identified.status !== 'identified') {
      // NOTHING HAS BEEN STREAMED, so this is a clean failure and not an unconfirmed one: there is
      // no backend that could be mid-replay, the lock is released normally, and maintenance mode is
      // switched back off by the caller's `finally`. Refusing to run a restore we cannot later
      // terminate is the whole reason this check is before the pipe rather than after it.
      child.kill('SIGKILL')
      throw new Error(
        identified.status === 'ambiguous'
          ? `Refusing to restore: ${identified.pids.length} database backends answer to this restore's `
            + 'application name, so the one to terminate on a timeout cannot be identified. Nothing was restored.'
          : 'Refusing to restore: psql\'s database backend did not appear in pg_stat_activity, so it '
            + 'could not be terminated if the restore overran. Nothing was restored.',
      )
    }

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
      const outcome = await lock.terminateAndConfirmRestoreBackend(identified.identity).catch((error: unknown) => ({
        confirmed: false as const,
        found: -1,
        remaining: -1,
        error: error instanceof Error ? error.message : String(error),
      }))

      if (!outcome.confirmed) {
        // Every clause here is something the system actually does. See MAINTENANCE_MODE_REACH for
        // why the round-10 wording ("maintenance mode stays ON", "restart the application") both
        // overstated the protection and named a recovery that would have DESTROYED the real one.
        const reason = 'Restore timed out and its database backend could NOT be confirmed gone'
          + `${outcome.error ? ` (${outcome.error})` : ''}. Backend pid ${identified.identity.pid}, `
          + `started ${identified.identity.backendStart}, may still be writing. `
          + 'The connector-selection lock is being HELD, not released, so connector-selection '
          + 'changes and orphaned-sync cancellation cannot interleave with it. Scheduled jobs '
          // wms-connector-boundary-ok: o3d-hl8l: naming which routes maintenance mode does and does not fence is the measured claim itself, not connector dispatch.
          + '(app/api/cron/*), WooCommerce webhooks and the Mintsoft ASN webhook are stopped by '
          + 'maintenance mode. THE '
          // wms-connector-boundary-ok: o3d-hl8l: naming which routes maintenance mode does and does not fence is the measured claim itself, not connector dispatch.
          + 'SHIPHERO WEBHOOK ROUTE, THE ACCOUNTING OAUTH CALLBACK AND ALL '
          + 'INTERACTIVE WRITES FROM THE DASHBOARD ARE NOT STOPPED BY ANYTHING — take the '
          + 'application out of service to stop those. Do NOT '
          + 'restart yet: restarting releases the held lock. Confirm in pg_stat_activity that pid '
          + `${identified.identity.pid} with backend_start ${identified.identity.backendStart} is gone `
          + '(terminate it if not), then restart, then end the hold from Sync → Exceptions → '
          + '"Maintenance window". That control re-checks this backend before it clears anything, '
          + 'and clearing it there ALSO schedules the re-check for the warehouse callbacks refused '
          + 'during the window — editing the `system_maintenance_mode` row in `settings` by hand '
          + 'does neither.'
        lock.retainLock(reason)
        throw new RestoreBackendNotConfirmedError(reason, { ...identified.identity, applicationName })
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
    recordMaintenanceHold: deps.recordMaintenanceHold ?? recordMaintenanceHold,
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
      // mistake as releasing the lock: it reopens scheduled jobs and webhooks on the strength of an
      // assumption that the restore has stopped. When the backend could not be confirmed gone the
      // flag stays on — but ONLY the entry points inventoried in MAINTENANCE_MODE_REACH are held
      // off by it, and the error the operator receives says so rather than implying the
      // application is down.
      const backendUnconfirmed = error instanceof RestoreBackendNotConfirmedError

      // ROUND 12, FINDING 3. THE DECISION TO HOLD THE GATE IS MADE BEFORE ANY FALLIBLE AWAIT.
      //
      // This assignment used to sit AFTER the failure audit below. The audit is a write to the
      // database — the same database whose restore has just failed with a backend that may still
      // be attached to it — so it is one of the LIKELIEST things to reject on this exact path. If
      // it did, control left the catch for the `finally` with `holdMaintenance` still false, and
      // the gate was switched off while the restore backend was unconfirmed: the one deliberate
      // protection this branch exists to apply, discarded because a log line could not be written.
      //
      // A protective decision must never be downstream of the thing it is protecting against.
      if (backendUnconfirmed) holdMaintenance = true

      const message = redactRestoreErrorMessage(error instanceof Error ? error.message : String(error), resolvedDeps.env)

      // o3d-hl8l r5 (Codex r4 finding 1): MAKE THE HELD WINDOW SOMETHING AN OPERATOR CAN SEE AND
      // END. Until now this branch left the flag on with no screen and no record, so the only
      // available clear was a hand-written UPDATE — which never stamped the booked-in re-check, so
      // every callback the fence refused during the LONGEST kind of window fell back to a
      // days-scale alert. This row is what the exception inbox renders and what the "End the hold"
      // action re-checks the backend against before it clears anything.
      //
      // AFTER the gate decision above and best-effort by contract (`recordMaintenanceHold` catches
      // its own failures): the database this writes to is the one whose restore just failed, so it
      // is among the likeliest writes to be rejected here, and a protective decision must never be
      // downstream of the thing it is protecting against.
      let holdRecorded = false
      if (error instanceof RestoreBackendNotConfirmedError) {
        holdRecorded = await resolvedDeps.recordMaintenanceHold({
          reason: message,
          backendPid: error.identity.pid,
          backendStart: error.identity.backendStart,
          applicationName: error.identity.applicationName,
        })
      }

      try {
        await resolvedDeps.log({
          entityType: 'SYSTEM',
          tag: 'system',
          action: 'backup_restored',
          level: 'ERROR',
          metadata: backendUnconfirmed
            ? { error: message, backendUnconfirmed: true, maintenanceModeHeld: true, holdRecorded }
            : { error: message },
          description: `Failed to restore backup: ${message}`,
        })
      } catch {
        // BEST-EFFORT ON THIS PATH ONLY. A rejected audit write must not replace the caller's
        // diagnosis with a generic 500 (which is what an exception escaping this catch produced),
        // and must not change what happens to maintenance mode. The restore failure is the fact
        // worth reporting; the record of it failing to be recorded is not worth losing it over.
      }
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
