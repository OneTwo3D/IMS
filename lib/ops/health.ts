import { constants } from 'node:fs'
import { access, mkdir, readdir, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import packageJson from '@/package.json'

export const HEALTH_NO_STORE_HEADERS = {
  'Cache-Control': 'no-store',
} as const

const DAILY_BATCH_SYNC_TYPES = [
  'DAILY_BATCH_REVENUE_DEFERRAL',
  'DAILY_BATCH_INVENTORY_ALLOC',
  'DAILY_BATCH_GROUP_B',
] as const

const FX_SYNC_STALE_AFTER_MS = 36 * 60 * 60 * 1000

const HEALTH_CHECK_TIMEOUT_MS = 5000

type JsonPrimitive = string | number | boolean | null

export type PublicHealthResponse = {
  ok: true
  status: 'ok'
  checkedAt: string
}

export type HealthLevel = 'ok' | 'warning' | 'error'

export type HealthStatus = 'ok' | 'degraded' | 'down'

export type HealthCheck = {
  status: HealthLevel
  checkedAt: string
  message?: string
  details?: Record<string, JsonPrimitive>
}

export type DirectoryHealthCheck = HealthCheck & {
  label: string
  writable: boolean
}

export type LatestOperationHealthCheck = HealthCheck & {
  lastRunAt: string | null
  lastStatus: string | null
  reference: string | null
}

export type AdminHealthResponse = {
  ok: boolean
  status: HealthStatus
  checkedAt: string
  app: {
    version: string
    commitSha: string | null
  }
  checks: {
    database: HealthCheck
    migrations: LatestOperationHealthCheck
    writableDirectories: DirectoryHealthCheck[]
    latestBackup: LatestOperationHealthCheck
    latestAccountingBatch: LatestOperationHealthCheck
    latestWooCommerceSync: LatestOperationHealthCheck
    latestFxSync: LatestOperationHealthCheck
  }
}

export type HealthAdapters = {
  now: () => Date
  appVersion: () => string
  commitSha: () => string | null
  checkDatabase: () => Promise<HealthCheck>
  latestMigration: () => Promise<LatestOperationHealthCheck>
  checkWritableDirectories: () => Promise<DirectoryHealthCheck[]>
  latestBackup: () => Promise<LatestOperationHealthCheck>
  latestAccountingBatch: () => Promise<LatestOperationHealthCheck>
  latestWooCommerceSync: () => Promise<LatestOperationHealthCheck>
  latestFxSync: () => Promise<LatestOperationHealthCheck>
}

export type CollectAdminHealthOptions = {
  timeoutMs?: number
}

/**
 * Return a Response only when access should stop early, such as a 401/403
 * denial. Return null when the caller is authorized to receive diagnostics.
 */
export type AdminHealthAuthorizer = () => Promise<Response | null>

export function buildPublicHealthResponse(now: Date = new Date()): PublicHealthResponse {
  return {
    ok: true,
    status: 'ok',
    checkedAt: now.toISOString(),
  }
}

export async function collectAdminHealth(
  adapters: HealthAdapters = createDefaultHealthAdapters(),
  options: CollectAdminHealthOptions = {},
): Promise<AdminHealthResponse> {
  const checkedAt = adapters.now().toISOString()
  const timeoutMs = options.timeoutMs ?? HEALTH_CHECK_TIMEOUT_MS
  const [
    database,
    migrations,
    writableDirectories,
    latestBackup,
    latestAccountingBatch,
    latestWooCommerceSync,
    latestFxSync,
  ] = await Promise.all([
    runHealthAdapter('database', adapters.checkDatabase, timeoutMs, (message) => errorCheck(message)),
    runHealthAdapter('migrations', adapters.latestMigration, timeoutMs, (message) => warningLatest(message)),
    runHealthAdapter('writable directories', adapters.checkWritableDirectories, timeoutMs, (message) => [
      warningDirectoryCheck('writableDirectories', message),
    ]),
    runHealthAdapter('latest backup', adapters.latestBackup, timeoutMs, (message) => warningLatest(message)),
    runHealthAdapter('latest accounting batch', adapters.latestAccountingBatch, timeoutMs, (message) =>
      warningLatest(message),
    ),
    runHealthAdapter('latest WooCommerce sync', adapters.latestWooCommerceSync, timeoutMs, (message) =>
      warningLatest(message),
    ),
    runHealthAdapter('latest FX sync', adapters.latestFxSync, timeoutMs, (message) => warningLatest(message)),
  ])

  const status = summarizeHealthStatus(database, [
    ...writableDirectories,
    migrations,
    latestBackup,
    latestAccountingBatch,
    latestWooCommerceSync,
    latestFxSync,
  ])

  return {
    ok: status === 'ok',
    status,
    checkedAt,
    app: {
      version: adapters.appVersion(),
      commitSha: adapters.commitSha(),
    },
    checks: {
      database,
      migrations,
      writableDirectories,
      latestBackup,
      latestAccountingBatch,
      latestWooCommerceSync,
      latestFxSync,
    },
  }
}

export function createPublicHealthHandler(now: () => Date = () => new Date()) {
  return function publicHealthHandler() {
    return Response.json(buildPublicHealthResponse(now()), {
      headers: HEALTH_NO_STORE_HEADERS,
    })
  }
}

export function createAdminHealthHandler({
  authorize,
  collect = collectAdminHealth,
}: {
  authorize: AdminHealthAuthorizer
  collect?: () => Promise<AdminHealthResponse>
}) {
  return async function adminHealthHandler() {
    const denyResponse = await authorize()
    if (denyResponse) return denyResponse

    const health = await collect()
    return Response.json(health, {
      status: health.status === 'down' ? 503 : 200,
      headers: HEALTH_NO_STORE_HEADERS,
    })
  }
}

export function createDefaultHealthAdapters(): HealthAdapters {
  return {
    now: () => new Date(),
    appVersion: () => packageJson.version,
    commitSha: readCommitSha,
    checkDatabase: checkDatabaseConnectivity,
    latestMigration: getLatestMigration,
    checkWritableDirectories: checkWritableDirectories,
    latestBackup: getLatestBackup,
    latestAccountingBatch: getLatestAccountingBatch,
    latestWooCommerceSync: getLatestWooCommerceSync,
    latestFxSync: getLatestFxSync,
  }
}

export function summarizeHealthStatus(database: HealthCheck, checks: HealthCheck[]): HealthStatus {
  if (database.status === 'error' || checks.some((check) => check.status === 'error')) return 'down'
  if (database.status !== 'ok' || checks.some((check) => check.status !== 'ok')) return 'degraded'
  return 'ok'
}

function checkedAt(): string {
  return new Date().toISOString()
}

function checkedAtFrom(now: Date): string {
  return now.toISOString()
}

function okCheck(details?: Record<string, JsonPrimitive>): HealthCheck {
  return {
    status: 'ok',
    checkedAt: checkedAt(),
    details,
  }
}

function errorCheck(message: string): HealthCheck {
  return {
    status: 'error',
    checkedAt: checkedAt(),
    message,
  }
}

function warningDirectoryCheck(label: string, message: string): DirectoryHealthCheck {
  return {
    label,
    writable: false,
    status: 'warning',
    checkedAt: checkedAt(),
    message,
  }
}

function warningLatest(message: string): LatestOperationHealthCheck {
  return {
    status: 'warning',
    checkedAt: checkedAt(),
    message,
    lastRunAt: null,
    lastStatus: null,
    reference: null,
  }
}

async function runHealthAdapter<T>(
  label: string,
  run: () => Promise<T>,
  timeoutMs: number,
  fallback: (message: string) => T,
): Promise<T> {
  try {
    return await withHealthCheckTimeout(run(), timeoutMs, label)
  } catch (error) {
    console.error(`Admin health ${label} check failed`, error)
    return fallback(`Health check failed or timed out: ${label}`)
  }
}

function withHealthCheckTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`Health check timed out: ${label}`))
    }, timeoutMs)
  })

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout)
  })
}

function errorLatest(message: string): LatestOperationHealthCheck {
  return {
    status: 'error',
    checkedAt: checkedAt(),
    message,
    lastRunAt: null,
    lastStatus: null,
    reference: null,
  }
}

export function buildFxSyncHealthFromLastFetched(
  lastFetchedAt: string | null | undefined,
  now: Date = new Date(),
): LatestOperationHealthCheck {
  if (!lastFetchedAt) {
    return {
      status: 'warning',
      checkedAt: checkedAtFrom(now),
      message: 'No FX rate fetch timestamp found',
      lastRunAt: null,
      lastStatus: null,
      reference: null,
    }
  }

  const lastFetchedDate = new Date(lastFetchedAt)
  if (Number.isNaN(lastFetchedDate.getTime())) {
    return {
      status: 'warning',
      checkedAt: checkedAtFrom(now),
      message: 'FX rate fetch timestamp is invalid',
      lastRunAt: null,
      lastStatus: null,
      reference: null,
    }
  }

  const ageMs = Math.max(0, now.getTime() - lastFetchedDate.getTime())
  const stale = ageMs > FX_SYNC_STALE_AFTER_MS

  return {
    status: stale ? 'warning' : 'ok',
    checkedAt: checkedAtFrom(now),
    message: stale ? 'Latest FX fetch is stale' : undefined,
    lastRunAt: lastFetchedDate.toISOString(),
    lastStatus: stale ? 'stale' : 'fetched',
    reference: 'frankfurter',
    details: {
      ageMs,
      staleAfterMs: FX_SYNC_STALE_AFTER_MS,
    },
  }
}

function latestOperation({
  lastRunAt,
  lastStatus,
  reference,
  details,
}: {
  lastRunAt: Date | null
  lastStatus: string | null
  reference: string | null
  details?: Record<string, JsonPrimitive>
}): LatestOperationHealthCheck {
  return {
    status: lastStatus === 'FAILED' ? 'warning' : 'ok',
    checkedAt: checkedAt(),
    lastRunAt: lastRunAt?.toISOString() ?? null,
    lastStatus,
    reference,
    details,
  }
}

async function checkDatabaseConnectivity(): Promise<HealthCheck> {
  try {
    const { db } = await import('@/lib/db')
    await db.$queryRaw`SELECT 1`
    return okCheck()
  } catch (error) {
    console.error('Admin health database check failed', error)
    return {
      status: 'error',
      checkedAt: checkedAt(),
      message: 'Database connectivity check failed',
    }
  }
}

async function getLatestMigration(): Promise<LatestOperationHealthCheck> {
  try {
    const { db } = await import('@/lib/db')
    const rows = await db.$queryRaw<Array<{ migration_name: string; finished_at: Date | null }>>`
      SELECT migration_name, finished_at
      FROM "_prisma_migrations"
      WHERE finished_at IS NOT NULL
      ORDER BY finished_at DESC
      LIMIT 1
    `
    const latest = rows[0]
    if (!latest) return warningLatest('No applied migrations found')

    return latestOperation({
      lastRunAt: latest.finished_at,
      lastStatus: 'applied',
      reference: null,
    })
  } catch (error) {
    console.error('Admin health migration check failed', error)
    return errorLatest('Migration check failed')
  }
}

async function checkWritableDirectories(): Promise<DirectoryHealthCheck[]> {
  const { getBackupDir } = await import('@/lib/backup-storage')
  const checks = [
    ['avatarUploads', path.join(process.cwd(), 'public', 'uploads', 'avatars')],
    ['brandingUploads', path.join(process.cwd(), 'public', 'uploads', 'branding')],
    ['invoiceUploads', path.join(process.cwd(), 'uploads', 'invoices')],
    ['temporaryUploads', path.join(os.tmpdir(), 'onetwoinventory', 'uploads')],
    ['backups', getBackupDir()],
  ] as const

  return Promise.all(checks.map(([label, directory]) => checkWritableDirectory(label, directory)))
}

async function checkWritableDirectory(label: string, directory: string): Promise<DirectoryHealthCheck> {
  try {
    await mkdir(directory, { recursive: true })
    await access(directory, constants.W_OK)

    return {
      label,
      writable: true,
      status: 'ok',
      checkedAt: checkedAt(),
    }
  } catch (error) {
    console.error(`Admin health writable directory check failed for ${label}`, error)
    return {
      label,
      writable: false,
      status: 'error',
      checkedAt: checkedAt(),
      message: 'Directory is not writable',
    }
  }
}

async function getLatestBackup(): Promise<LatestOperationHealthCheck> {
  try {
    const { getBackupDir } = await import('@/lib/backup-storage')
    const backupDir = getBackupDir()
    await mkdir(backupDir, { recursive: true })
    const files = await readdir(backupDir)
    const candidates = files.filter((file) => file.endsWith('.sql') || file.endsWith('.dump'))

    if (candidates.length === 0) return warningLatest('No backup files found')

    const backups = await Promise.all(
      candidates.map(async (file) => {
        const info = await stat(path.join(backupDir, file))
        return { file, info }
      }),
    )
    backups.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs)
    const latest = backups[0]

    return latestOperation({
      lastRunAt: latest.info.mtime,
      lastStatus: 'available',
      reference: latest.file,
      details: { sizeBytes: latest.info.size },
    })
  } catch (error) {
    console.error('Admin health backup check failed', error)
    return errorLatest('Backup check failed')
  }
}

async function getLatestAccountingBatch(): Promise<LatestOperationHealthCheck> {
  try {
    const { db } = await import('@/lib/db')
    const latest = await db.accountingSyncLog.findFirst({
      where: { type: { in: [...DAILY_BATCH_SYNC_TYPES] } },
      orderBy: { createdAt: 'desc' },
      select: {
        connector: true,
        type: true,
        status: true,
        createdAt: true,
        syncedAt: true,
      },
    })

    if (!latest) return warningLatest('No accounting batch sync log found')

    return latestOperation({
      lastRunAt: latest.syncedAt ?? latest.createdAt,
      lastStatus: latest.status,
      reference: latest.type,
      details: { connector: latest.connector },
    })
  } catch (error) {
    console.error('Admin health accounting batch check failed', error)
    return errorLatest('Accounting batch check failed')
  }
}

async function getLatestWooCommerceSync(): Promise<LatestOperationHealthCheck> {
  try {
    const { db } = await import('@/lib/db')
    const latest = await db.shoppingSyncLog.findFirst({
      where: { connector: 'woocommerce' },
      orderBy: { createdAt: 'desc' },
      select: {
        connector: true,
        entityType: true,
        status: true,
        createdAt: true,
        syncedAt: true,
      },
    })

    if (!latest) return warningLatest('No WooCommerce sync log found')

    return latestOperation({
      lastRunAt: latest.syncedAt ?? latest.createdAt,
      lastStatus: latest.status,
      reference: latest.entityType,
      details: { connector: latest.connector },
    })
  } catch (error) {
    console.error('Admin health WooCommerce sync check failed', error)
    return errorLatest('WooCommerce sync check failed')
  }
}

async function getLatestFxSync(): Promise<LatestOperationHealthCheck> {
  try {
    const { db } = await import('@/lib/db')
    const latestFetch = await db.setting.findUnique({
      where: { key: 'fx_last_fetched' },
      select: { value: true },
    })

    return buildFxSyncHealthFromLastFetched(latestFetch?.value)
  } catch (error) {
    console.error('Admin health FX sync check failed', error)
    return errorLatest('FX sync check failed')
  }
}

function readCommitSha(): string | null {
  const candidates = [
    process.env.VERCEL_GIT_COMMIT_SHA,
    process.env.GIT_COMMIT_SHA,
    process.env.COMMIT_SHA,
    process.env.SOURCE_VERSION,
  ]

  for (const candidate of candidates) {
    if (!candidate) continue
    const trimmed = candidate.trim()
    if (/^[a-f0-9]{7,40}$/i.test(trimmed)) return trimmed.slice(0, 12)
  }

  return null
}
