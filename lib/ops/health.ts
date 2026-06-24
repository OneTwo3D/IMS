import { constants } from 'node:fs'
import { access, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { getAllCronJobs } from '@/lib/cron-jobs'
import type { CronJobDef } from '@/lib/cron-registry'
import { getIntegrationPluginState, isIntegrationModuleVisible } from '@/lib/integration-plugins'
import { checkFileScanHealth } from '@/lib/security/file-scan'
import packageJson from '@/package.json'

export const HEALTH_NO_STORE_HEADERS = {
  'Cache-Control': 'no-store',
} as const

const DAILY_BATCH_SYNC_TYPES = [
  'DAILY_BATCH_REVENUE_DEFERRAL',
  'DAILY_BATCH_INVENTORY_ALLOC',
  'DAILY_BATCH_GROUP_B',
] as const

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const FX_SYNC_STALE_AFTER_MS = 36 * HOUR_MS
const MINTSOFT_WEBHOOK_STALE_AFTER_MS = HOUR_MS
const INTEGRATION_OUTBOX_PENDING_STALE_AFTER_MS = 30 * MINUTE_MS
const INTEGRATION_OUTBOX_STUCK_PROCESSING_AFTER_MS = 10 * MINUTE_MS
const ACCOUNTING_EVENTS_PENDING_STALE_AFTER_MS = 30 * MINUTE_MS

const LATEST_OPERATION_OK_STATUSES = new Set([
  'SYNCED',
  'SUCCEEDED',
  'COMPLETED',
  'SENT',
  'OK',
  'applied',
  'available',
  'completed',
  'skipped',
])

const CRITICAL_WRITABLE_DIRECTORIES = new Set(['backups'])

const HEALTH_CHECK_TIMEOUT_MS = 5000

type JsonPrimitive = string | number | boolean | null
type HealthDetailValue = JsonPrimitive | HealthDetailValue[] | { [key: string]: HealthDetailValue }

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
  details?: Record<string, HealthDetailValue>
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

export type InvariantHealthCheck = LatestOperationHealthCheck & {
  criticalCount: number
  countShape: 'exact' | 'mismatch'
}

export type CronFreshnessHealthCheck = HealthCheck & {
  jobs: Record<string, {
    status: HealthLevel
    lastRunAt: string | null
    lastStatus: string | null
    ageMs: number | null
    staleAfterMs: number
    schedule?: string
  }>
}

export type CronFreshnessPolicy = {
  jobName: string
  schedule: string
  staleAfterMs: number
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
    integrationOutbox: HealthCheck
    latestInvariantCheck: InvariantHealthCheck
    latestWmsStockSync: LatestOperationHealthCheck
    mintsoftWebhookQueue: HealthCheck
    accountingEvents: HealthCheck
    cronFreshness: CronFreshnessHealthCheck
    fileScanner: HealthCheck
  }
}

export type HealthAdapters = {
  now: () => Date
  appVersion: () => string
  commitSha: () => string | null
  checkDatabase: (now: Date) => Promise<HealthCheck>
  latestMigration: (now: Date) => Promise<LatestOperationHealthCheck>
  checkWritableDirectories: (now: Date) => Promise<DirectoryHealthCheck[]>
  latestBackup: (now: Date) => Promise<LatestOperationHealthCheck>
  latestAccountingBatch: (now: Date) => Promise<LatestOperationHealthCheck>
  latestWooCommerceSync: (now: Date) => Promise<LatestOperationHealthCheck>
  latestFxSync: (now: Date) => Promise<LatestOperationHealthCheck>
  integrationOutbox: (now: Date) => Promise<HealthCheck>
  latestInvariantCheck: (now: Date) => Promise<InvariantHealthCheck>
  latestWmsStockSync: (now: Date) => Promise<LatestOperationHealthCheck>
  mintsoftWebhookQueue: (now: Date) => Promise<HealthCheck>
  accountingEvents: (now: Date) => Promise<HealthCheck>
  cronFreshness: (now: Date) => Promise<CronFreshnessHealthCheck>
  fileScanner: (now: Date) => Promise<HealthCheck>
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
  const now = adapters.now()
  const checkedAt = now.toISOString()
  const timeoutMs = options.timeoutMs ?? HEALTH_CHECK_TIMEOUT_MS
  const [
    database,
    migrations,
    writableDirectories,
    latestBackup,
    latestAccountingBatch,
    latestWooCommerceSync,
    latestFxSync,
    integrationOutbox,
    latestInvariantCheck,
    latestWmsStockSync,
    mintsoftWebhookQueue,
    accountingEvents,
    cronFreshness,
    fileScanner,
  ] = await Promise.all([
    runHealthAdapter('database', () => adapters.checkDatabase(now), timeoutMs, (message) => errorCheck(message, now)),
    runHealthAdapter('migrations', () => adapters.latestMigration(now), timeoutMs, (message) =>
      warningLatest(message, now),
    ),
    runHealthAdapter('writable directories', () => adapters.checkWritableDirectories(now), timeoutMs, (message) => [
      warningDirectoryCheck('writableDirectories', message, now),
    ]),
    runHealthAdapter('latest backup', () => adapters.latestBackup(now), timeoutMs, (message) =>
      warningLatest(message, now),
    ),
    runHealthAdapter('latest accounting batch', () => adapters.latestAccountingBatch(now), timeoutMs, (message) =>
      warningLatest(message, now),
    ),
    runHealthAdapter('latest WooCommerce sync', () => adapters.latestWooCommerceSync(now), timeoutMs, (message) =>
      warningLatest(message, now),
    ),
    runHealthAdapter('latest FX sync', () => adapters.latestFxSync(now), timeoutMs, (message) =>
      warningLatest(message, now),
    ),
    runHealthAdapter('integration outbox', () => adapters.integrationOutbox(now), timeoutMs, (message) =>
      warningCheck(message, now),
    ),
    runHealthAdapter('latest invariant check', () => adapters.latestInvariantCheck(now), timeoutMs, (message) =>
      warningInvariantCheck(message, now),
    ),
    runHealthAdapter('latest WMS stock sync', () => adapters.latestWmsStockSync(now), timeoutMs, (message) =>
      warningLatest(message, now),
    ),
    runHealthAdapter('Mintsoft webhook queue', () => adapters.mintsoftWebhookQueue(now), timeoutMs, (message) =>
      warningCheck(message, now),
    ),
    runHealthAdapter('accounting events', () => adapters.accountingEvents(now), timeoutMs, (message) =>
      warningCheck(message, now),
    ),
    runHealthAdapter('cron freshness', () => adapters.cronFreshness(now), timeoutMs, (message) =>
      warningCronFreshness(message, now),
    ),
    runHealthAdapter('file scanner', () => adapters.fileScanner(now), timeoutMs, (message) =>
      warningCheck(message, now),
    ),
  ])

  const status = summarizeHealthStatus([
    database,
    ...writableDirectories,
    migrations,
    latestBackup,
    latestAccountingBatch,
    latestWooCommerceSync,
    latestFxSync,
    integrationOutbox,
    latestInvariantCheck,
    latestWmsStockSync,
    mintsoftWebhookQueue,
    accountingEvents,
    cronFreshness,
    fileScanner,
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
      integrationOutbox,
      latestInvariantCheck,
      latestWmsStockSync,
      mintsoftWebhookQueue,
      accountingEvents,
      cronFreshness,
      fileScanner,
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
    integrationOutbox: getIntegrationOutboxHealth,
    latestInvariantCheck: getLatestInvariantCheck,
    latestWmsStockSync: getLatestWmsStockSync,
    mintsoftWebhookQueue: getMintsoftWebhookQueueHealth,
    accountingEvents: getAccountingEventsHealth,
    cronFreshness: getCronFreshnessHealth,
    fileScanner: getFileScannerHealth,
  }
}

export function summarizeHealthStatus(checks: HealthCheck[]): HealthStatus {
  if (checks.some((check) => check.status === 'error')) return 'down'
  if (checks.some((check) => check.status !== 'ok')) return 'degraded'
  return 'ok'
}

function checkedAtFrom(now: Date): string {
  return now.toISOString()
}

function okCheck(details?: Record<string, HealthDetailValue>, now: Date = new Date()): HealthCheck {
  return {
    status: 'ok',
    checkedAt: checkedAtFrom(now),
    details,
  }
}

function errorCheck(message: string, now: Date = new Date()): HealthCheck {
  return {
    status: 'error',
    checkedAt: checkedAtFrom(now),
    message,
  }
}

function warningDirectoryCheck(label: string, message: string, now: Date = new Date()): DirectoryHealthCheck {
  return {
    label,
    writable: false,
    status: 'warning',
    checkedAt: checkedAtFrom(now),
    message,
  }
}

function warningLatest(message: string, now: Date = new Date()): LatestOperationHealthCheck {
  return {
    status: 'warning',
    checkedAt: checkedAtFrom(now),
    message,
    lastRunAt: null,
    lastStatus: null,
    reference: null,
  }
}

function warningInvariantCheck(message: string, now: Date = new Date()): InvariantHealthCheck {
  return {
    status: 'warning',
    checkedAt: checkedAtFrom(now),
    message,
    lastRunAt: null,
    lastStatus: null,
    reference: null,
    criticalCount: 0,
    countShape: 'mismatch',
  }
}

function warningCheck(message: string, now: Date = new Date(), details?: Record<string, HealthDetailValue>): HealthCheck {
  return {
    status: 'warning',
    checkedAt: checkedAtFrom(now),
    message,
    details,
  }
}

function warningCronFreshness(message: string, now: Date = new Date()): CronFreshnessHealthCheck {
  return {
    status: 'warning',
    checkedAt: checkedAtFrom(now),
    message,
    jobs: {},
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
    return fallback(`Health check failed or timed out: ${label} (${summarizeHealthError(error)})`)
  }
}

/**
 * Bounds the health response latency but does not cancel the underlying work.
 * Do not reuse for high-volume paths where an abandoned DB query could hold a
 * scarce connection slot after the health response has already returned.
 */
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

function errorLatest(message: string, now: Date = new Date()): LatestOperationHealthCheck {
  return {
    status: 'error',
    checkedAt: checkedAtFrom(now),
    message,
    lastRunAt: null,
    lastStatus: null,
    reference: null,
  }
}

function summarizeHealthError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, 200)
}

export type FxSyncAttemptHealthInput = {
  lastAttemptAt?: string | null
  lastAttemptStatus?: string | null
  retryCount?: number | null
  failedCurrencies?: string[] | null
  skippedManualOverrideCurrencies?: string[] | null
  error?: string | null
}

export function buildFxSyncHealthFromLastFetched(
  lastFetchedAt: string | null | undefined,
  now: Date = new Date(),
  attempt: FxSyncAttemptHealthInput = {},
): LatestOperationHealthCheck {
  const attemptDetails = {
    lastAttemptAt: attempt.lastAttemptAt ?? null,
    lastAttemptStatus: attempt.lastAttemptStatus ?? null,
    retryCount: attempt.retryCount ?? 0,
    failedCurrencies: attempt.failedCurrencies ?? [],
    skippedManualOverrideCurrencies: attempt.skippedManualOverrideCurrencies ?? [],
    error: attempt.error ?? null,
  }

  if (attempt.lastAttemptStatus === 'failed') {
    return {
      status: 'warning',
      checkedAt: checkedAtFrom(now),
      message: attempt.error ? `Latest FX fetch failed: ${attempt.error}` : 'Latest FX fetch failed',
      lastRunAt: attempt.lastAttemptAt ?? null,
      lastStatus: 'failed',
      reference: 'frankfurter',
      details: attemptDetails,
    }
  }

  if (attempt.lastAttemptStatus === 'skipped_manual_override') {
    return {
      status: 'ok',
      checkedAt: checkedAtFrom(now),
      message: undefined,
      lastRunAt: attempt.lastAttemptAt ?? null,
      lastStatus: 'skipped_manual_override',
      reference: 'manual override',
      details: attemptDetails,
    }
  }

  if (!lastFetchedAt) {
    return {
      status: 'warning',
      checkedAt: checkedAtFrom(now),
      message: 'No FX rate fetch timestamp found',
      lastRunAt: null,
      lastStatus: null,
      reference: null,
      details: attemptDetails,
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
      details: attemptDetails,
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
      ...attemptDetails,
    },
  }
}

export function buildIntegrationOutboxHealth(input: {
  pending: number
  retryableFailed: number
  permanentFailed: number
  processing: number
  oldestPendingCreatedAt?: Date | null
  oldestProcessingLockedAt?: Date | null
  now?: Date
}): HealthCheck {
  const now = input.now ?? new Date()
  const oldestPendingAgeMs = input.oldestPendingCreatedAt
    ? Math.max(0, now.getTime() - input.oldestPendingCreatedAt.getTime())
    : null
  const oldestProcessingAgeMs = input.oldestProcessingLockedAt
    ? Math.max(0, now.getTime() - input.oldestProcessingLockedAt.getTime())
    : null
  const stalePending = oldestPendingAgeMs != null && oldestPendingAgeMs > INTEGRATION_OUTBOX_PENDING_STALE_AFTER_MS
  const stuckProcessing =
    oldestProcessingAgeMs != null && oldestProcessingAgeMs > INTEGRATION_OUTBOX_STUCK_PROCESSING_AFTER_MS
  const status =
    input.permanentFailed > 0 || input.retryableFailed > 0 || stalePending || stuckProcessing ? 'warning' : 'ok'

  return {
    status,
    checkedAt: checkedAtFrom(now),
    message: status === 'warning' ? 'Integration outbox requires attention' : undefined,
    details: {
      pending: input.pending,
      retryableFailed: input.retryableFailed,
      permanentFailed: input.permanentFailed,
      processing: input.processing,
      oldestPendingCreatedAt: input.oldestPendingCreatedAt?.toISOString() ?? null,
      oldestPendingAgeMs,
      pendingStaleAfterMs: INTEGRATION_OUTBOX_PENDING_STALE_AFTER_MS,
      oldestProcessingLockedAt: input.oldestProcessingLockedAt?.toISOString() ?? null,
      oldestProcessingAgeMs,
      stuckProcessingAfterMs: INTEGRATION_OUTBOX_STUCK_PROCESSING_AFTER_MS,
    },
  }
}

export function buildMintsoftWebhookQueueHealth(input: {
  pending: number
  pendingRetry: number
  failedRetry: number
  requiresReview: number
  dead: number
  oldestUnprocessedReceivedAt?: Date | null
  now?: Date
}): HealthCheck {
  const now = input.now ?? new Date()
  const oldestUnprocessedAgeMs = input.oldestUnprocessedReceivedAt
    ? Math.max(0, now.getTime() - input.oldestUnprocessedReceivedAt.getTime())
    : null
  const stale = oldestUnprocessedAgeMs != null && oldestUnprocessedAgeMs > MINTSOFT_WEBHOOK_STALE_AFTER_MS
  // Any receipt review backlog is intentionally amber for now: each item represents a paused
  // stock mutation that needs operator acknowledgement or source-data repair before retry.
  const status = input.dead > 0 || input.failedRetry > 0 || input.requiresReview > 0 || stale ? 'warning' : 'ok'

  return {
    status,
    checkedAt: checkedAtFrom(now),
    message: status === 'warning' ? 'Mintsoft webhook queue requires attention' : undefined,
    details: {
      pending: input.pending,
      pendingRetry: input.pendingRetry,
      failedRetry: input.failedRetry,
      requiresReview: input.requiresReview,
      dead: input.dead,
      oldestUnprocessedReceivedAt: input.oldestUnprocessedReceivedAt?.toISOString() ?? null,
      oldestUnprocessedAgeMs,
      staleAfterMs: MINTSOFT_WEBHOOK_STALE_AFTER_MS,
    },
  }
}

export function buildAccountingEventsHealth(input: {
  pending: number
  failed: number
  oldestPendingCreatedAt?: Date | null
  now?: Date
}): HealthCheck {
  const now = input.now ?? new Date()
  const oldestPendingAgeMs = input.oldestPendingCreatedAt
    ? Math.max(0, now.getTime() - input.oldestPendingCreatedAt.getTime())
    : null
  const stalePending = oldestPendingAgeMs != null && oldestPendingAgeMs > ACCOUNTING_EVENTS_PENDING_STALE_AFTER_MS
  const status = input.failed > 0 || stalePending ? 'warning' : 'ok'
  return {
    status,
    checkedAt: checkedAtFrom(now),
    message: input.failed > 0
      ? 'Accounting events have failed rows'
      : stalePending
        ? 'Accounting event pending backlog is stale'
        : undefined,
    details: {
      pending: input.pending,
      failed: input.failed,
      oldestPendingCreatedAt: input.oldestPendingCreatedAt?.toISOString() ?? null,
      oldestPendingAgeMs,
      pendingStaleAfterMs: ACCOUNTING_EVENTS_PENDING_STALE_AFTER_MS,
    },
  }
}

export function buildInvariantCheckHealthFromCronRun(
  latest: {
    runId: string
    startedAt: Date
    finishedAt: Date | null
    status: string
    countsJson: unknown
  } | null,
  now: Date = new Date(),
): InvariantHealthCheck {
  if (!latest) return warningLatestFrom('No invariant check cron run found', now)

  const parsedCounts = extractInvariantCriticalCount(latest.countsJson)
  const status =
    latest.status === 'failed' || parsedCounts.criticalCount > 0 || parsedCounts.countShape === 'mismatch'
      ? 'warning'
      : 'ok'
  return {
    status,
    checkedAt: checkedAtFrom(now),
    message: parsedCounts.criticalCount > 0
      ? 'Latest invariant check reported critical findings'
      : parsedCounts.countShape === 'mismatch'
        ? 'Invariant check count payload is unrecognized'
        : undefined,
    lastRunAt: (latest.finishedAt ?? latest.startedAt).toISOString(),
    lastStatus: parsedCounts.criticalCount > 0 ? 'critical_findings' : latest.status,
    reference: latest.runId,
    criticalCount: parsedCounts.criticalCount,
    countShape: parsedCounts.countShape,
    details: {
      criticalCount: parsedCounts.criticalCount,
      countShape: parsedCounts.countShape,
    },
  }
}

export function buildCronFreshnessHealth(
  runs: Array<{ jobName: string; startedAt: Date; finishedAt: Date | null; status: string }>,
  now: Date = new Date(),
  policies: ReadonlyArray<CronFreshnessPolicy> = buildCronFreshnessPolicies(getAllCronJobs(), new Map()),
): CronFreshnessHealthCheck {
  const latestByJob = new Map<string, { jobName: string; startedAt: Date; finishedAt: Date | null; status: string }>()
  for (const run of runs) {
    const current = latestByJob.get(run.jobName)
    const runTime = (run.finishedAt ?? run.startedAt).getTime()
    const currentTime = current ? (current.finishedAt ?? current.startedAt).getTime() : -Infinity
    if (runTime > currentTime) latestByJob.set(run.jobName, run)
  }

  const jobs: CronFreshnessHealthCheck['jobs'] = {}
  let warningCount = 0
  for (const policy of policies) {
    const run = latestByJob.get(policy.jobName)
    const lastRunAt = run ? (run.finishedAt ?? run.startedAt) : null
    const ageMs = lastRunAt ? Math.max(0, now.getTime() - lastRunAt.getTime()) : null
    const stale = ageMs == null || ageMs > policy.staleAfterMs
    const failed = run?.status === 'failed'
    const status: HealthLevel = stale || failed ? 'warning' : 'ok'
    if (status !== 'ok') warningCount += 1
    jobs[policy.jobName] = {
      status,
      lastRunAt: lastRunAt?.toISOString() ?? null,
      lastStatus: run?.status ?? null,
      ageMs,
      staleAfterMs: policy.staleAfterMs,
      schedule: policy.schedule,
    }
  }

  return {
    status: warningCount > 0 ? 'warning' : 'ok',
    checkedAt: checkedAtFrom(now),
    message: warningCount > 0 ? 'One or more cron jobs are stale or failed' : undefined,
    details: { warningCount },
    jobs,
  }
}

function warningLatestFrom(message: string, now: Date): InvariantHealthCheck {
  return {
    status: 'warning',
    checkedAt: checkedAtFrom(now),
    message,
    lastRunAt: null,
    lastStatus: null,
    reference: null,
    criticalCount: 0,
    countShape: 'mismatch',
  }
}

function extractInvariantCriticalCount(countsJson: unknown): { criticalCount: number; countShape: 'exact' | 'mismatch' } {
  if (!isRecord(countsJson)) return { criticalCount: 0, countShape: 'mismatch' }
  const total = countsJson.total
  if (!isRecord(total)) return { criticalCount: 0, countShape: 'mismatch' }
  if (typeof total.critical !== 'number' || !Number.isFinite(total.critical)) {
    return { criticalCount: 0, countShape: 'mismatch' }
  }
  return { criticalCount: total.critical, countShape: 'exact' }
}

function latestOperation({
  lastRunAt,
  lastStatus,
  reference,
  details,
  now = new Date(),
}: {
  lastRunAt: Date | null
  lastStatus: string | null
  reference: string | null
  details?: Record<string, HealthDetailValue>
  now?: Date
}): LatestOperationHealthCheck {
  return {
    status: lastStatus && LATEST_OPERATION_OK_STATUSES.has(lastStatus) ? 'ok' : 'warning',
    checkedAt: checkedAtFrom(now),
    lastRunAt: lastRunAt?.toISOString() ?? null,
    lastStatus,
    reference,
    details,
  }
}

async function checkDatabaseConnectivity(now: Date = new Date()): Promise<HealthCheck> {
  try {
    const { db } = await import('@/lib/db')
    await db.$queryRaw`SELECT 1`
    return okCheck(undefined, now)
  } catch (error) {
    console.error('Admin health database check failed', error)
    return {
      status: 'error',
      checkedAt: checkedAtFrom(now),
      message: 'Database connectivity check failed',
    }
  }
}

async function getLatestMigration(now: Date = new Date()): Promise<LatestOperationHealthCheck> {
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
    if (!latest) return warningLatest('No applied migrations found', now)

    return latestOperation({
      lastRunAt: latest.finished_at,
      lastStatus: 'applied',
      reference: null,
      now,
    })
  } catch (error) {
    console.error('Admin health migration check failed', error)
    return errorLatest('Migration check failed', now)
  }
}

async function checkWritableDirectories(now: Date = new Date()): Promise<DirectoryHealthCheck[]> {
  const { getBackupDir } = await import('@/lib/backup-storage')
  const { getInvoicePdfStorageDir } = await import('@/lib/invoice-pdf')
  const { getUploadStorageDirectories } = await import('@/lib/upload-storage')
  const checks = [
    ...getUploadStorageDirectories().map(({ label, directory }) => [label, directory] as const),
    ['invoicePdfStorage', getInvoicePdfStorageDir()],
    ['temporaryUploads', path.join(os.tmpdir(), 'onetwoinventory', 'uploads')],
    ['backups', getBackupDir()],
  ] as const

  return Promise.all(checks.map(([label, directory]) => checkWritableDirectory(label, directory, now)))
}

async function checkWritableDirectory(label: string, directory: string, now: Date): Promise<DirectoryHealthCheck> {
  const probePath = path.join(directory, `.ims-health-${process.pid}-${Date.now()}.tmp`)
  try {
    await access(directory, constants.W_OK)
    await writeFile(probePath, '')
    await unlink(probePath)

    return {
      label,
      writable: true,
      status: 'ok',
      checkedAt: checkedAtFrom(now),
    }
  } catch (error) {
    console.error(`Admin health writable directory check failed for ${label}`, error)
    const status = CRITICAL_WRITABLE_DIRECTORIES.has(label) ? 'error' : 'warning'
    return {
      label,
      writable: false,
      status,
      checkedAt: checkedAtFrom(now),
      message: 'Directory is not writable',
    }
  }
}

async function getLatestBackup(now: Date = new Date()): Promise<LatestOperationHealthCheck> {
  try {
    const { getBackupDir } = await import('@/lib/backup-storage')
    const backupDir = getBackupDir()
    const files = await readdir(backupDir)
    const candidates = files.filter((file) => file.endsWith('.sql') || file.endsWith('.dump'))

    if (candidates.length === 0) return warningLatest('No backup files found', now)

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
      now,
    })
  } catch (error) {
    console.error('Admin health backup check failed', error)
    return warningLatest('Backup check failed', now)
  }
}

async function getLatestAccountingBatch(now: Date = new Date()): Promise<LatestOperationHealthCheck> {
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

    if (!latest) return warningLatest('No accounting batch sync log found', now)

    return latestOperation({
      lastRunAt: latest.syncedAt ?? latest.createdAt,
      lastStatus: latest.status,
      reference: latest.type,
      details: { connector: latest.connector },
      now,
    })
  } catch (error) {
    console.error('Admin health accounting batch check failed', error)
    return errorLatest('Accounting batch check failed', now)
  }
}

// b8i6.4: report the latest shopping sync per CONFIGURED connector, not just
// WooCommerce, so a Shopify-only or dual setup isn't blind. The slot is
// represented by the most stale configured connector (so a lagging connector
// surfaces), with a per-connector breakdown in details. (Field/adapter name
// kept as latestWooCommerceSync for back-compat with rollout-readiness + UI.)
async function getLatestWooCommerceSync(now: Date = new Date()): Promise<LatestOperationHealthCheck> {
  try {
    const { db } = await import('@/lib/db')
    const { listActiveShoppingConnectorInfo } = await import('@/lib/shopping')
    const connectors = await listActiveShoppingConnectorInfo()
    if (connectors.length === 0) return warningLatest('No shopping connector configured', now)

    const perConnector = await Promise.all(connectors.map(async (c) => {
      const latest = await db.shoppingSyncLog.findFirst({
        where: { connector: c.id },
        orderBy: { createdAt: 'desc' },
        select: { connector: true, entityType: true, status: true, createdAt: true, syncedAt: true },
      })
      return { id: c.id, name: c.name, latest }
    }))

    const withLogs = perConnector.filter((p) => p.latest)
    if (withLogs.length === 0) {
      return warningLatest(`No sync log found for ${connectors.map((c) => c.name).join(', ')}`, now)
    }

    const runAt = (p: (typeof withLogs)[number]) => p.latest!.syncedAt ?? p.latest!.createdAt
    const oldest = withLogs.reduce((a, b) => (runAt(a) <= runAt(b) ? a : b))

    return latestOperation({
      lastRunAt: runAt(oldest),
      lastStatus: oldest.latest!.status,
      reference: oldest.latest!.entityType,
      details: {
        connectors: perConnector.map((p) => ({
          connector: p.id,
          lastRunAt: p.latest ? (p.latest.syncedAt ?? p.latest.createdAt).toISOString() : null,
          status: p.latest?.status ?? 'NONE',
        })),
      },
      now,
    })
  } catch (error) {
    console.error('Admin health shopping sync check failed', error)
    return errorLatest('Shopping sync check failed', now)
  }
}

async function getLatestFxSync(now: Date = new Date()): Promise<LatestOperationHealthCheck> {
  try {
    const { db } = await import('@/lib/db')
    const [
      latestFetch,
      lastAttemptAt,
      lastAttemptStatus,
      retryCount,
      failedCurrencies,
      skippedManualOverrides,
      lastError,
    ] = await Promise.all([
      db.setting.findUnique({ where: { key: 'fx_last_fetched' }, select: { value: true } }),
      db.setting.findUnique({ where: { key: 'fx_last_fetch_attempt_at' }, select: { value: true } }),
      db.setting.findUnique({ where: { key: 'fx_last_fetch_attempt_status' }, select: { value: true } }),
      db.setting.findUnique({ where: { key: 'fx_last_fetch_retry_count' }, select: { value: true } }),
      db.setting.findUnique({ where: { key: 'fx_last_fetch_failed_currencies' }, select: { value: true } }),
      db.setting.findUnique({ where: { key: 'fx_last_fetch_skipped_manual_overrides' }, select: { value: true } }),
      db.setting.findUnique({ where: { key: 'fx_last_fetch_error' }, select: { value: true } }),
    ])

    return buildFxSyncHealthFromLastFetched(latestFetch?.value, now, {
      lastAttemptAt: lastAttemptAt?.value ?? null,
      lastAttemptStatus: lastAttemptStatus?.value ?? null,
      retryCount: Number(retryCount?.value ?? 0) || 0,
      failedCurrencies: splitCsvSetting(failedCurrencies?.value),
      skippedManualOverrideCurrencies: splitCsvSetting(skippedManualOverrides?.value),
      error: lastError?.value || null,
    })
  } catch (error) {
    console.error('Admin health FX sync check failed', error)
    return errorLatest('FX sync check failed', now)
  }
}

function splitCsvSetting(value: string | null | undefined): string[] {
  return (value ?? '').split(',').map((item) => item.trim()).filter(Boolean)
}

async function getIntegrationOutboxHealth(now: Date = new Date()): Promise<HealthCheck> {
  try {
    const { db } = await import('@/lib/db')
    const [statusCounts, oldestPending, oldestProcessing] = await Promise.all([
      db.integrationOutbox.groupBy({
        by: ['status'],
        where: {
          status: {
            in: ['PENDING', 'PROCESSING', 'RETRYABLE_FAILED', 'PERMANENT_FAILED'],
          },
        },
        _count: { _all: true },
      }),
      db.integrationOutbox.findFirst({
        where: {
          status: 'PENDING',
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
        },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
      db.integrationOutbox.findFirst({
        where: {
          status: 'PROCESSING',
          lockedAt: { not: null },
        },
        orderBy: { lockedAt: 'asc' },
        select: { lockedAt: true },
      }),
    ])

    return buildIntegrationOutboxHealth({
      pending: groupedStatusCount(statusCounts, 'PENDING'),
      processing: groupedStatusCount(statusCounts, 'PROCESSING'),
      retryableFailed: groupedStatusCount(statusCounts, 'RETRYABLE_FAILED'),
      permanentFailed: groupedStatusCount(statusCounts, 'PERMANENT_FAILED'),
      oldestPendingCreatedAt: oldestPending?.createdAt ?? null,
      oldestProcessingLockedAt: oldestProcessing?.lockedAt ?? null,
      now,
    })
  } catch (error) {
    console.error('Admin health integration outbox check failed', error)
    return errorCheck('Integration outbox check failed', now)
  }
}

async function getLatestInvariantCheck(now: Date = new Date()): Promise<InvariantHealthCheck> {
  try {
    const { db } = await import('@/lib/db')
    const latest = await db.cronRun.findFirst({
      where: { jobName: 'invariant-check' },
      orderBy: { startedAt: 'desc' },
      select: {
        runId: true,
        startedAt: true,
        finishedAt: true,
        status: true,
        countsJson: true,
      },
    })

    return buildInvariantCheckHealthFromCronRun(latest, now)
  } catch (error) {
    console.error('Admin health invariant check failed', error)
    return warningInvariantCheck('Invariant check health failed', now)
  }
}

async function getLatestWmsStockSync(now: Date = new Date()): Promise<LatestOperationHealthCheck> {
  try {
    const { db } = await import('@/lib/db')
    const latest = await db.wmsSyncJob.findFirst({
      where: {
        connector: 'mintsoft',
        type: 'STOCK_SYNC',
      },
      orderBy: { startedAt: 'desc' },
      select: {
        id: true,
        status: true,
        startedAt: true,
        finishedAt: true,
        totalChecked: true,
        mismatched: true,
        errors: true,
      },
    })

    if (!latest) return warningLatest('No Mintsoft stock sync job found', now)

    return buildWmsStockSyncHealth(latest, now)
  } catch (error) {
    console.error('Admin health WMS stock sync check failed', error)
    return errorLatest('WMS stock sync check failed', now)
  }
}

async function getMintsoftWebhookQueueHealth(now: Date = new Date()): Promise<HealthCheck> {
  try {
    const { db } = await import('@/lib/db')
    const [statusCounts, oldestUnprocessed] = await Promise.all([
      db.wmsInboundReceiptEvent.groupBy({
        by: ['processingStatus'],
        where: { connector: 'mintsoft' },
        _count: { _all: true },
      }),
      db.wmsInboundReceiptEvent.findFirst({
        where: {
          connector: 'mintsoft',
          processedAt: null,
        },
        orderBy: { receivedAt: 'asc' },
        select: { receivedAt: true },
      }),
    ])

    return buildMintsoftWebhookQueueHealth({
      pending: groupedProcessingStatusCount(statusCounts, 'PENDING'),
      pendingRetry: groupedProcessingStatusCount(statusCounts, 'PENDING_RETRY'),
      failedRetry: groupedProcessingStatusCount(statusCounts, 'FAILED_RETRY'),
      requiresReview: groupedProcessingStatusCount(statusCounts, 'REQUIRES_REVIEW'),
      dead: groupedProcessingStatusCount(statusCounts, 'DEAD'),
      oldestUnprocessedReceivedAt: oldestUnprocessed?.receivedAt ?? null,
      now,
    })
  } catch (error) {
    console.error('Admin health Mintsoft webhook queue check failed', error)
    return errorCheck('Mintsoft webhook queue check failed', now)
  }
}

async function getAccountingEventsHealth(now: Date = new Date()): Promise<HealthCheck> {
  try {
    const { db } = await import('@/lib/db')
    const [statusCounts, oldestPending] = await Promise.all([
      db.accountingEvent.groupBy({
        by: ['status'],
        where: {
          status: { in: ['PENDING', 'FAILED'] },
        },
        _count: { _all: true },
      }),
      db.accountingEvent.findFirst({
        where: { status: 'PENDING' },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
    ])

    return buildAccountingEventsHealth({
      pending: groupedStatusCount(statusCounts, 'PENDING'),
      failed: groupedStatusCount(statusCounts, 'FAILED'),
      oldestPendingCreatedAt: oldestPending?.createdAt ?? null,
      now,
    })
  } catch (error) {
    console.error('Admin health accounting event check failed', error)
    return errorCheck('Accounting event check failed', now)
  }
}

async function getCronFreshnessHealth(now: Date = new Date()): Promise<CronFreshnessHealthCheck> {
  try {
    const { db } = await import('@/lib/db')
    // Match the scheduler in app/actions/cron.ts: jobs from disabled integration plugins
    // are intentionally absent from crontab, so they must not be reported as stale.
    const pluginState = await getIntegrationPluginState()
    const jobs = getAllCronJobs().filter((job) => isIntegrationModuleVisible(job.module, pluginState))
    const settings = await db.setting.findMany({
      where: {
        key: {
          in: cronSettingKeys(jobs),
        },
      },
      select: { key: true, value: true },
    })
    const settingMap = new Map(settings.map((setting) => [setting.key, setting.value]))
    const policies = buildCronFreshnessPolicies(jobs, settingMap)
    const runs = await Promise.all(policies.map((policy) =>
      db.cronRun.findFirst({
        where: { jobName: policy.jobName },
        orderBy: { startedAt: 'desc' },
        select: {
          jobName: true,
          startedAt: true,
          finishedAt: true,
          status: true,
        },
      }),
    ))

    return buildCronFreshnessHealth(runs.filter((run) => run != null), now, policies)
  } catch (error) {
    console.error('Admin health cron freshness check failed', error)
    return warningCronFreshness('Cron freshness check failed', now)
  }
}

async function getFileScannerHealth(now: Date = new Date()): Promise<HealthCheck> {
  const result = await checkFileScanHealth()
  const details = {
    scanMode: result.mode,
    scanStatus: result.status,
    scanReason: result.reason ?? null,
    scanScannerId: result.scannerId ?? null,
  }

  if (result.mode === 'disabled' || result.status === 'clean') {
    return okCheck(details, now)
  }

  return warningCheck('File scanner command failed the health smoke check', now, details)
}

export function buildWmsStockSyncHealth(
  latest: {
    id: string
    status: string
    startedAt: Date
    finishedAt: Date | null
    totalChecked: number
    mismatched: number
    errors: number
  },
  now: Date,
): LatestOperationHealthCheck {
  const elevated = latest.errors > 0 || latest.mismatched > 0
  const operation = latestOperation({
    lastRunAt: latest.finishedAt ?? latest.startedAt,
    lastStatus: latest.status,
    reference: latest.id,
    details: {
      connector: 'mintsoft',
      totalChecked: latest.totalChecked,
      mismatched: latest.mismatched,
      errors: latest.errors,
    },
    now,
  })

  if (!elevated || operation.status !== 'ok') return operation
  return {
    ...operation,
    status: 'warning',
    message: 'Latest Mintsoft stock sync completed with mismatches or errors',
  }
}

function cronSettingKeys(jobs: CronJobDef[]): string[] {
  return jobs.flatMap((job) => [
    `cron_${job.settingKey}_enabled`,
    `cron_${job.settingKey}_schedule`,
    ...(job.legacyEnabledKey ? [job.legacyEnabledKey] : []),
  ])
}

export function buildCronFreshnessPolicies(
  jobs: CronJobDef[],
  settings: ReadonlyMap<string, string>,
): CronFreshnessPolicy[] {
  return jobs.flatMap((job) => {
    if (!isCronJobEnabled(job, settings)) return []
    const schedule = settings.get(`cron_${job.settingKey}_schedule`) ?? job.defaultSchedule
    return [{
      jobName: job.slug,
      schedule,
      staleAfterMs: staleAfterMsForCronSchedule(schedule),
    }]
  })
}

function isCronJobEnabled(job: CronJobDef, settings: ReadonlyMap<string, string>): boolean {
  const enabled = settings.get(`cron_${job.settingKey}_enabled`)
  if (enabled != null) return enabled === 'true'
  if (job.legacyEnabledKey) {
    const legacyEnabled = settings.get(job.legacyEnabledKey)
    if (legacyEnabled != null) return legacyEnabled === 'true'
  }
  return job.defaultEnabled
}

function staleAfterMsForCronSchedule(schedule: string): number {
  const fields = schedule.trim().split(/\s+/)
  if (fields.length !== 5) return 36 * HOUR_MS
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields
  if (dayOfMonth !== '*' || month !== '*' || dayOfWeek !== '*') return 36 * HOUR_MS

  // Treat `* * * * *` (every minute) like the */N branch with N=1 so the freshness
  // policy uses minute-scale staleness rather than the 36h fallback.
  if (minute === '*' && hour === '*') return 3 * MINUTE_MS
  if (minute.startsWith('*/') && hour === '*') {
    const intervalMinutes = Number(minute.slice(2))
    if (Number.isFinite(intervalMinutes) && intervalMinutes > 0) return intervalMinutes * 3 * MINUTE_MS
  }
  if (/^\d+$/.test(minute) && hour === '*') return 3 * HOUR_MS
  if (/^\d+$/.test(minute) && hour.startsWith('*/')) {
    const intervalHours = Number(hour.slice(2))
    if (Number.isFinite(intervalHours) && intervalHours > 0) return intervalHours * 3 * HOUR_MS
  }
  return 36 * HOUR_MS
}

function groupedStatusCount(rows: Array<{ status: string; _count: { _all: number } }>, status: string): number {
  return rows.find((row) => row.status === status)?._count._all ?? 0
}

function groupedProcessingStatusCount(
  rows: Array<{ processingStatus: string; _count: { _all: number } }>,
  status: string,
): number {
  return rows.find((row) => row.processingStatus === status)?._count._all ?? 0
}

/**
 * Reads the deployment commit from common platform variables and returns the
 * 12-character abbreviated SHA used in admin diagnostics. Deploys that need
 * full-SHA drift comparison should set one of these variables and compare
 * against source control outside the health payload; null means none was set.
 */
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
