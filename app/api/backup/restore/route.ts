import { NextRequest, NextResponse } from 'next/server'
import { createHash, randomBytes } from 'crypto'
import { spawn } from 'child_process'
import { createReadStream, createWriteStream } from 'fs'
import { mkdir, access, unlink, stat, statfs } from 'fs/promises'
import path from 'path'
import readline from 'readline'
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
import { parsePositiveIntegerEnv } from '@/lib/env'
import { getClientIp } from '@/lib/request-ip'
import { validateBackupManifestForFile, type BackupManifest } from '@/lib/backup-manifest'

const BACKUP_DIR = getBackupDir()
const RESTORE_TOKEN_TTL_MS = 2 * 60_000
const DEFAULT_MAX_RESTORE_FILE_BYTES = 50 * 1024 * 1024
const RESTORE_FORM_OVERHEAD_BYTES = 64 * 1024

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

function restoreTokenClientIp(request?: Pick<NextRequest, 'headers'> | null): string {
  if (!request) return 'unknown'
  return getClientIp(request.headers) ?? 'unknown'
}

function restoreTokenPayload(session: RestoreSession, request?: Pick<NextRequest, 'headers'> | null): RestoreTokenPayload {
  return {
    userId: session.user.id,
    sessionVersion: session.user.sessionVersion ?? null,
    sessionAuthTime: session.user.sessionAuthTime ?? null,
    clientIp: restoreTokenClientIp(request),
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

async function validateRestoreSqlFile(filePath: string): Promise<void> {
  const rl = readline.createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })

  let lineNumber = 0
  try {
    for await (const line of rl) {
      lineNumber++
      if (/^\s*\\/.test(line)) {
        throw new Error(`Restore file contains unsupported psql metacommand on line ${lineNumber}`)
      }
    }
  } finally {
    rl.close()
  }
}

async function runRestore(filePath: string, db: ReturnType<typeof getDbConfig>): Promise<void> {
  await validateRestoreSqlFile(filePath)

  await new Promise<void>((resolve, reject) => {
    const args = [
      '-X',
      '-h', db.host,
      '-p', db.port,
      '-U', db.user,
      '-d', db.database,
      '--single-transaction',
      '--set', 'ON_ERROR_STOP=1',
    ]
    const child = spawn('psql', args, {
      env: { ...process.env, PGPASSWORD: db.password },
      stdio: ['pipe', 'ignore', 'pipe'],
    })

    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('Restore timed out'))
    }, 300000)

    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString()
      if (stderr.length > 2000) stderr = stderr.slice(-2000)
    })

    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })

    child.on('close', (code) => {
      clearTimeout(timeout)
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(stderr.trim() || `psql exited with code ${code}`))
    })

    const input = createReadStream(filePath)
    input.on('error', (error) => {
      child.stdin.destroy(error)
    })
    child.stdin.on('error', () => {
      // handled by child close/error paths
    })
    input.pipe(child.stdin)
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
    await resolvedDeps.setRestoreToken(
      restoreTokenKey,
      serializeRestoreTokenPayload(restoreTokenPayload(session, req)),
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
    const filename = formData.get('filename') as string | null

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
      await mkdir(resolvedDeps.backupDir, { recursive: true })
      const availableBytes = await resolvedDeps.getAvailableDiskBytes(resolvedDeps.backupDir)
      if (availableBytes < file.size * 2) {
        return NextResponse.json({ error: 'Not enough disk space for restore upload.' }, { status: 507 })
      }
      const targetTimestamp = await getRestoreTargetDatabaseTimestamp(resolvedDeps)
      if (targetTimestamp instanceof NextResponse) return targetTimestamp
      targetDatabaseTimestamp = targetTimestamp
      // Validate upload policy and shape before consuming the one-time email code.
      const tokenMatches = await consumeMatchingRestoreToken(resolvedDeps, restoreToken, restoreTokenPayload(session, req))
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
      sourceBackupTimestamp = fileInfo.mtime.toISOString()
      sourceBackupName = path.basename(restorePath)
      sourceType = 'stored_backup'
      sourceBackupBytes = fileInfo.size
      const targetTimestamp = await getRestoreTargetDatabaseTimestamp(resolvedDeps)
      if (targetTimestamp instanceof NextResponse) return targetTimestamp
      targetDatabaseTimestamp = targetTimestamp
      const tokenMatches = await consumeMatchingRestoreToken(resolvedDeps, restoreToken, restoreTokenPayload(session, req))
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
      const message = redactRestoreErrorMessage(error instanceof Error ? error.message : String(error), resolvedDeps.env)
      await resolvedDeps.log({
        entityType: 'SYSTEM',
        tag: 'system',
        action: 'backup_restored',
        level: 'ERROR',
        metadata: { error: message },
        description: `Failed to restore backup: ${message}`,
      })
      return NextResponse.json({ error: `Restore failed: ${message.slice(0, 200)}` }, { status: 500 })
    } finally {
      await resolvedDeps.disableMaintenance()
      await cleanup()
    }
  }
}

export const GET = createBackupRestoreGetHandler()
export const POST = createBackupRestorePostHandler()
