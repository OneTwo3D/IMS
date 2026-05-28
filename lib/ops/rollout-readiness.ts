import { db } from '@/lib/db'
import {
  HEALTH_NO_STORE_HEADERS,
  collectAdminHealth,
  type AdminHealthAuthorizer,
  type AdminHealthResponse,
  type HealthCheck,
  type LatestOperationHealthCheck,
} from '@/lib/ops/health'
import {
  runProductionPreflight,
  type PreflightCheck,
  type PreflightResult,
  type PreflightStatus,
} from '@/lib/ops/production-preflight'

type JsonPrimitive = string | number | boolean | null
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

const ROLLOUT_READINESS_RESPONSE_VERSION = 1 as const
const DEFAULT_READINESS_TIMEOUT_MS = 10_000
const DEFAULT_READINESS_CACHE_TTL_MS = 30_000
const TERMINAL_ACCOUNTING_RECONCILIATION_RUN_STATUSES = ['COMPLETED', 'FAILED', 'PARTIAL'] as const
const BLOCKING_CRON_JOBS = new Set([
  'accounting-daily-batch',
  'accounting-sync',
  'invariant-check',
  'mintsoft-stock-sync',
  'mintsoft-webhook-sweeper',
  'shopping-webhook-inbox',
])

const SECRET_KEY_PATTERN = /(authorization|credential|database[_-]?url|password|secret|settings[_-]?encryption[_-]?key|token|api[_-]?key)/i
const SECRET_VALUE_PATTERNS = [
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s"'<>]+/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/g,
]

export type RolloutReadinessStatus = 'ready' | 'warning' | 'blocked'

export type RolloutReadinessSeverity = 'blocker' | 'warning'

export type RolloutReadinessFinding = {
  id: string
  severity: RolloutReadinessSeverity
  source: string
  message: string
  details?: Record<string, JsonValue>
}

export type AccountingReconciliationRunStatus = typeof TERMINAL_ACCOUNTING_RECONCILIATION_RUN_STATUSES[number]

export type LatestAccountingReconciliationRun = {
  id: string
  status: AccountingReconciliationRunStatus
  totalCount: number
  warningCount: number
  criticalCount: number
  createdAt: string
}

export type RolloutReadinessResponse = {
  version: typeof ROLLOUT_READINESS_RESPONSE_VERSION
  ok: boolean
  status: RolloutReadinessStatus
  checkedAt: string
  staleAfter: string
  cache: {
    ttlMs: number
    hit: boolean
  }
  blockers: RolloutReadinessFinding[]
  warnings: RolloutReadinessFinding[]
  contract: {
    stable: readonly ['version', 'ok', 'status', 'blockers', 'warnings']
    supplementary: readonly ['checks']
  }
  checks: {
    preflight: {
      ok: boolean
      status: PreflightStatus
      checks: PreflightCheck[]
    }
    adminHealth: AdminHealthResponse
    latestAccountingReconciliationRun: LatestAccountingReconciliationRun | null
  }
}

export type RolloutReadinessAdapters = {
  now: () => Date
  runPreflight: () => Promise<PreflightResult>
  collectAdminHealth: () => Promise<AdminHealthResponse>
  latestAccountingReconciliationRun: () => Promise<LatestAccountingReconciliationRun | null>
}

export type CollectRolloutReadinessOptions = {
  timeoutMs?: number
  cacheTtlMs?: number
}

let cachedReadiness:
  | {
    expiresAtMs: number
    report: RolloutReadinessResponse
  }
  | null = null

export function createDefaultRolloutReadinessAdapters(): RolloutReadinessAdapters {
  return {
    now: () => new Date(),
    runPreflight: () => runProductionPreflight(),
    collectAdminHealth: () => collectAdminHealth(),
    latestAccountingReconciliationRun: getLatestAccountingReconciliationRun,
  }
}

export async function collectCachedRolloutReadiness(
  adapters: RolloutReadinessAdapters = createDefaultRolloutReadinessAdapters(),
  options: CollectRolloutReadinessOptions = {},
): Promise<RolloutReadinessResponse> {
  const now = adapters.now()
  if (cachedReadiness && cachedReadiness.expiresAtMs > now.getTime()) {
    return {
      ...cachedReadiness.report,
      cache: {
        ...cachedReadiness.report.cache,
        hit: true,
      },
    }
  }

  const report = await collectRolloutReadiness(adapters, options)
  cachedReadiness = {
    expiresAtMs: new Date(report.staleAfter).getTime(),
    report,
  }
  return report
}

export function clearRolloutReadinessCache(): void {
  cachedReadiness = null
}

export async function collectRolloutReadiness(
  adapters: RolloutReadinessAdapters = createDefaultRolloutReadinessAdapters(),
  options: CollectRolloutReadinessOptions = {},
): Promise<RolloutReadinessResponse> {
  const now = adapters.now()
  const checkedAt = now.toISOString()
  const timeoutMs = options.timeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_READINESS_CACHE_TTL_MS
  const staleAfter = new Date(now.getTime() + cacheTtlMs).toISOString()
  const [preflightResult, adminHealthResult, reconciliationResult] = await Promise.all([
    settleReadinessAdapter('production-preflight', adapters.runPreflight(), timeoutMs),
    settleReadinessAdapter('admin-health', adapters.collectAdminHealth(), timeoutMs),
    settleReadinessAdapter('accounting-reconciliation', adapters.latestAccountingReconciliationRun(), timeoutMs),
  ])

  const blockers: RolloutReadinessFinding[] = []
  const warnings: RolloutReadinessFinding[] = []
  const preflight = preflightResult.ok
    ? preflightResult.value
    : failedPreflightResult(preflightResult.error)
  const adminHealth = adminHealthResult.ok
    ? adminHealthResult.value
    : unavailableAdminHealth(checkedAt, adminHealthResult.error)
  const latestAccountingReconciliationRun = reconciliationResult.ok
    ? reconciliationResult.value
    : null

  if (!reconciliationResult.ok) {
    warnings.push({
      id: 'readiness-adapter:accounting-reconciliation',
      severity: 'warning',
      source: 'rollout-readiness',
      message: 'Accounting reconciliation readiness check failed or timed out.',
      details: { error: summarizeReadinessError(reconciliationResult.error) },
    })
  }

  classifyPreflight(preflight, blockers, warnings)
  classifyAdminHealth(adminHealth, blockers, warnings)
  classifyAccountingReconciliation(latestAccountingReconciliationRun, blockers, warnings)

  const status: RolloutReadinessStatus = blockers.length > 0
    ? 'blocked'
    : warnings.length > 0
      ? 'warning'
      : 'ready'

  return redactSecrets({
    version: ROLLOUT_READINESS_RESPONSE_VERSION,
    ok: status === 'ready',
    status,
    checkedAt,
    staleAfter,
    cache: {
      ttlMs: cacheTtlMs,
      hit: false,
    },
    blockers,
    warnings,
    contract: {
      stable: ['version', 'ok', 'status', 'blockers', 'warnings'],
      supplementary: ['checks'],
    },
    checks: {
      preflight: {
        ok: preflight.ok,
        status: summarizePreflightStatus(preflight),
        checks: preflight.checks,
      },
      adminHealth,
      latestAccountingReconciliationRun,
    },
  })
}

export function createRolloutReadinessHandler({
  authorize,
  collect = collectCachedRolloutReadiness,
}: {
  authorize: AdminHealthAuthorizer
  collect?: () => Promise<RolloutReadinessResponse>
}) {
  return async function rolloutReadinessHandler(request?: Request) {
    const denyResponse = await authorize()
    if (denyResponse) return denyResponse

    const report = await collect()
    const allowWarnings = request ? new URL(request.url).searchParams.get('allowWarnings') === 'true' : false
    const statusCode = report.status === 'ready' || (report.status === 'warning' && allowWarnings) ? 200 : 412
    return Response.json(report, {
      status: statusCode,
      headers: HEALTH_NO_STORE_HEADERS,
    })
  }
}

async function getLatestAccountingReconciliationRun(): Promise<LatestAccountingReconciliationRun | null> {
  const latest = await db.accountingReconciliationRun.findFirst({
    where: {
      status: {
        in: [...TERMINAL_ACCOUNTING_RECONCILIATION_RUN_STATUSES],
      },
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      status: true,
      totalCount: true,
      warningCount: true,
      criticalCount: true,
      createdAt: true,
    },
  })

  if (!latest) return null
  return {
    ...latest,
    status: latest.status as AccountingReconciliationRunStatus,
    createdAt: latest.createdAt.toISOString(),
  }
}

function summarizePreflightStatus(preflight: PreflightResult): PreflightStatus {
  if (preflight.ok) return 'pass'
  return preflight.checks.some((check) => check.status === 'fail') ? 'fail' : 'warn'
}

async function settleReadinessAdapter<T>(
  label: string,
  promise: Promise<T>,
  timeoutMs: number,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await withReadinessTimeout(promise, timeoutMs, label) }
  } catch (error) {
    console.error(`Rollout readiness ${label} check failed`, error)
    return { ok: false, error }
  }
}

function withReadinessTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`Readiness check timed out: ${label}`))
    }, timeoutMs)
  })

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout)
  })
}

function failedPreflightResult(error: unknown): PreflightResult {
  return {
    ok: false,
    checks: [
      {
        id: 'rollout-readiness-preflight',
        name: 'rollout-readiness preflight adapter',
        status: 'fail',
        message: `Production preflight readiness check failed or timed out: ${summarizeReadinessError(error)}`,
      },
    ],
  }
}

function unavailableAdminHealth(checkedAt: string, error: unknown): AdminHealthResponse {
  const message = `Admin health readiness check failed or timed out: ${summarizeReadinessError(error)}`
  const warningLatest = {
    status: 'warning' as const,
    checkedAt,
    message,
    lastRunAt: null,
    lastStatus: null,
    reference: null,
  }
  return {
    ok: false,
    status: 'down',
    checkedAt,
    app: {
      version: 'unknown',
      commitSha: null,
    },
    checks: {
      database: {
        status: 'error',
        checkedAt,
        message,
      },
      migrations: warningLatest,
      writableDirectories: [],
      latestBackup: warningLatest,
      latestAccountingBatch: warningLatest,
      latestWooCommerceSync: warningLatest,
      latestFxSync: warningLatest,
      integrationOutbox: {
        status: 'warning',
        checkedAt,
        message,
      },
      latestInvariantCheck: {
        ...warningLatest,
        criticalCount: 0,
        countShape: 'mismatch',
      },
      latestWmsStockSync: warningLatest,
      mintsoftWebhookQueue: {
        status: 'warning',
        checkedAt,
        message,
      },
      accountingEvents: {
        status: 'warning',
        checkedAt,
        message,
      },
      cronFreshness: {
        status: 'warning',
        checkedAt,
        message,
        jobs: {},
      },
      fileScanner: {
        status: 'warning',
        checkedAt,
        message,
      },
    },
  }
}

function summarizeReadinessError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, 200)
}

function classifyPreflight(
  preflight: PreflightResult,
  blockers: RolloutReadinessFinding[],
  warnings: RolloutReadinessFinding[],
): void {
  for (const check of preflight.checks) {
    if (check.status === 'pass') continue
    const finding = {
      id: `preflight:${check.id}`,
      source: 'production-preflight',
      message: check.message,
      details: {
        checkId: check.id,
        name: check.name,
        status: check.status,
      },
    }
    if (check.status === 'fail') {
      blockers.push({ ...finding, severity: 'blocker' })
    } else {
      warnings.push({ ...finding, severity: 'warning' })
    }
  }
}

function classifyAdminHealth(
  health: AdminHealthResponse,
  blockers: RolloutReadinessFinding[],
  warnings: RolloutReadinessFinding[],
): void {
  if (health.status === 'down') {
    blockers.push({
      id: 'admin-health:down',
      severity: 'blocker',
      source: 'admin-health',
      message: 'Admin health reports a down status.',
      details: { status: health.status },
    })
  } else if (health.status === 'degraded') {
    warnings.push({
      id: 'admin-health:degraded',
      severity: 'warning',
      source: 'admin-health',
      message: 'Admin health reports a degraded status.',
      details: { status: health.status },
    })
  }

  const { checks } = health
  classifyHealthCheck('database', checks.database, blockers, warnings, 'Database connectivity is not healthy.')
  classifyStoragePaths(checks.writableDirectories, blockers, warnings)
  classifyLatestBackup(checks.latestBackup, blockers, warnings)
  classifyLatestOperation(
    'migrations',
    'database-migrations',
    checks.migrations,
    warnings,
    'Latest migration state needs review.',
  )
  classifyLatestOperation(
    'latest-accounting-batch',
    'accounting-batch',
    checks.latestAccountingBatch,
    warnings,
    'Latest accounting batch evidence needs review.',
  )
  classifyLatestOperation(
    'latest-woocommerce-sync',
    'shopping-sync',
    checks.latestWooCommerceSync,
    warnings,
    'Latest WooCommerce sync evidence needs review.',
  )
  classifyLatestOperation(
    'latest-fx-sync',
    'fx-sync',
    checks.latestFxSync,
    warnings,
    'Latest FX sync evidence needs review.',
  )
  classifyInvariantCheck(checks.latestInvariantCheck, blockers, warnings)
  classifyLatestOperation(
    'latest-wms-stock-sync',
    'wms-stock-sync',
    checks.latestWmsStockSync,
    warnings,
    'Latest WMS stock sync evidence needs review.',
  )
  classifyIntegrationOutbox(checks.integrationOutbox, blockers, warnings)
  classifyMintsoftWebhookQueue(checks.mintsoftWebhookQueue, blockers, warnings)
  classifyAccountingEvents(checks.accountingEvents, blockers, warnings)
  classifyCronFreshness(checks.cronFreshness, blockers, warnings)
  classifyFileScanner(checks.fileScanner, warnings)
}

function classifyHealthCheck(
  id: string,
  check: HealthCheck,
  blockers: RolloutReadinessFinding[],
  warnings: RolloutReadinessFinding[],
  defaultMessage: string,
): void {
  if (check.status === 'ok') return
  const target = check.status === 'error' ? blockers : warnings
  target.push({
    id,
    severity: check.status === 'error' ? 'blocker' : 'warning',
    source: 'admin-health',
    message: check.message ?? defaultMessage,
    details: healthCheckDetails(check),
  })
}

function classifyFileScanner(
  check: HealthCheck,
  warnings: RolloutReadinessFinding[],
): void {
  if (check.status === 'ok') return
  warnings.push({
    id: 'file-scanner',
    severity: 'warning',
    source: 'file-scanner',
    message: check.message ?? 'File scanner status needs review.',
    details: healthCheckDetails(check),
  })
}

function classifyStoragePaths(
  checks: AdminHealthResponse['checks']['writableDirectories'],
  blockers: RolloutReadinessFinding[],
  warnings: RolloutReadinessFinding[],
): void {
  for (const check of checks) {
    if (check.status === 'ok') continue
    const target = check.status === 'error' ? blockers : warnings
    target.push({
      id: `storage-path:${check.label}`,
      severity: check.status === 'error' ? 'blocker' : 'warning',
      source: 'storage',
      message: check.message ?? `${check.label} storage path is not writable.`,
      details: {
        label: check.label,
        status: check.status,
        writable: check.writable,
      },
    })
  }
}

function classifyLatestBackup(
  check: LatestOperationHealthCheck,
  blockers: RolloutReadinessFinding[],
  warnings: RolloutReadinessFinding[],
): void {
  if (check.status === 'ok') return
  const missingBackup = check.lastRunAt == null
  const target = missingBackup || check.status === 'error' ? blockers : warnings
  target.push({
    id: missingBackup
      ? 'latest-backup:missing'
      : check.status === 'error'
        ? 'latest-backup:error'
        : 'latest-backup:warning',
    severity: target === blockers ? 'blocker' : 'warning',
    source: 'backup',
    message: check.message ?? (missingBackup ? 'No backup evidence found.' : 'Latest backup evidence needs review.'),
    details: latestOperationDetails(check),
  })
}

function classifyLatestOperation(
  id: string,
  source: string,
  check: LatestOperationHealthCheck,
  warnings: RolloutReadinessFinding[],
  defaultMessage: string,
): void {
  if (check.status === 'ok') return
  warnings.push({
    id,
    severity: 'warning',
    source,
    message: check.message ?? defaultMessage,
    details: latestOperationDetails(check),
  })
}

function classifyInvariantCheck(
  check: AdminHealthResponse['checks']['latestInvariantCheck'],
  blockers: RolloutReadinessFinding[],
  warnings: RolloutReadinessFinding[],
): void {
  if (check.criticalCount > 0) {
    blockers.push({
      id: 'latest-invariant-check:critical',
      severity: 'blocker',
      source: 'invariants',
      message: check.message ?? 'Latest invariant check reported critical findings.',
      details: latestOperationDetails(check),
    })
    return
  }

  if (check.status !== 'ok') {
    warnings.push({
      id: 'latest-invariant-check',
      severity: 'warning',
      source: 'invariants',
      message: check.message ?? 'Latest invariant check needs review.',
      details: latestOperationDetails(check),
    })
  }
}

function classifyIntegrationOutbox(
  check: HealthCheck,
  blockers: RolloutReadinessFinding[],
  warnings: RolloutReadinessFinding[],
): void {
  const permanentFailed = numberDetail(check, 'permanentFailed')
  if (permanentFailed > 0) {
    blockers.push({
      id: 'integration-outbox:permanent-failed',
      severity: 'blocker',
      source: 'integration-outbox',
      message: 'Integration outbox has permanent failures.',
      details: healthCheckDetails(check),
    })
  }

  if (check.status !== 'ok' && permanentFailed === 0) {
    warnings.push({
      id: 'integration-outbox',
      severity: 'warning',
      source: 'integration-outbox',
      message: check.message ?? 'Integration outbox needs review.',
      details: healthCheckDetails(check),
    })
  }
}

function classifyMintsoftWebhookQueue(
  check: HealthCheck,
  blockers: RolloutReadinessFinding[],
  warnings: RolloutReadinessFinding[],
): void {
  const dead = numberDetail(check, 'dead')
  if (dead > 0) {
    blockers.push({
      id: 'wms-webhook-queue:dead',
      severity: 'blocker',
      source: 'wms-webhook-queue',
      message: 'Mintsoft webhook queue has dead-lettered events.',
      details: healthCheckDetails(check),
    })
  }

  if (check.status !== 'ok' && dead === 0) {
    warnings.push({
      id: 'wms-webhook-queue',
      severity: 'warning',
      source: 'wms-webhook-queue',
      message: check.message ?? 'Mintsoft webhook queue needs review.',
      details: healthCheckDetails(check),
    })
  }
}

function classifyAccountingEvents(
  check: HealthCheck,
  blockers: RolloutReadinessFinding[],
  warnings: RolloutReadinessFinding[],
): void {
  const failed = numberDetail(check, 'failed')
  if (failed > 0) {
    blockers.push({
      id: 'accounting-events:failed',
      severity: 'blocker',
      source: 'accounting-events',
      message: 'Accounting events have failed rows.',
      details: healthCheckDetails(check),
    })
  }

  if (check.status !== 'ok' && failed === 0) {
    warnings.push({
      id: 'accounting-events',
      severity: 'warning',
      source: 'accounting-events',
      message: check.message ?? 'Accounting events need review.',
      details: healthCheckDetails(check),
    })
  }
}

function classifyCronFreshness(
  check: AdminHealthResponse['checks']['cronFreshness'],
  blockers: RolloutReadinessFinding[],
  warnings: RolloutReadinessFinding[],
): void {
  for (const [jobName, job] of Object.entries(check.jobs)) {
    if (job.status === 'ok') continue
    const blocksRollout = BLOCKING_CRON_JOBS.has(jobName)
    const target = blocksRollout ? blockers : warnings
    target.push({
      id: `cron-freshness:${jobName}`,
      severity: blocksRollout ? 'blocker' : 'warning',
      source: 'cron-freshness',
      message: `Cron job ${jobName} is stale or failed.`,
      details: {
        jobName,
        status: job.status,
        lastRunAt: job.lastRunAt,
        lastStatus: job.lastStatus,
        ageMs: job.ageMs,
        staleAfterMs: job.staleAfterMs,
        schedule: job.schedule ?? null,
      },
    })
  }

  if (check.status !== 'ok' && Object.values(check.jobs).every((job) => job.status === 'ok')) {
    warnings.push({
      id: 'cron-freshness',
      severity: 'warning',
      source: 'cron-freshness',
      message: check.message ?? 'Cron freshness needs review.',
      details: healthCheckDetails(check),
    })
  }
}

function classifyAccountingReconciliation(
  latest: LatestAccountingReconciliationRun | null,
  blockers: RolloutReadinessFinding[],
  warnings: RolloutReadinessFinding[],
): void {
  if (!latest) {
    warnings.push({
      id: 'accounting-reconciliation:missing',
      severity: 'warning',
      source: 'accounting-reconciliation',
      message: 'No accounting reconciliation run found.',
    })
    return
  }

  const details = {
    id: latest.id,
    status: latest.status,
    totalCount: latest.totalCount,
    warningCount: latest.warningCount,
    criticalCount: latest.criticalCount,
    createdAt: latest.createdAt,
  }

  switch (latest.status) {
    case 'FAILED':
      blockers.push({
        id: 'accounting-reconciliation:failed',
        severity: 'blocker',
        source: 'accounting-reconciliation',
        message: 'Latest accounting reconciliation run failed.',
        details,
      })
      return
    case 'PARTIAL':
      warnings.push({
        id: 'accounting-reconciliation:partial',
        severity: 'warning',
        source: 'accounting-reconciliation',
        message: 'Latest accounting reconciliation run completed partially.',
        details,
      })
      return
    case 'COMPLETED':
      if (latest.criticalCount > 0) {
        blockers.push({
          id: 'accounting-reconciliation:critical',
          severity: 'blocker',
          source: 'accounting-reconciliation',
          message: 'Latest accounting reconciliation run reported critical findings.',
          details,
        })
        return
      }
      if (latest.warningCount > 0) {
        warnings.push({
          id: 'accounting-reconciliation:warnings',
          severity: 'warning',
          source: 'accounting-reconciliation',
          message: 'Latest accounting reconciliation run reported warnings.',
          details,
        })
      }
  }
}

function healthCheckDetails(check: HealthCheck): Record<string, JsonValue> {
  return {
    status: check.status,
    message: check.message ?? null,
    ...(check.details ?? {}),
  }
}

function latestOperationDetails(check: LatestOperationHealthCheck): Record<string, JsonValue> {
  return {
    ...healthCheckDetails(check),
    lastRunAt: check.lastRunAt,
    lastStatus: check.lastStatus,
    reference: check.reference,
  }
}

function numberDetail(check: HealthCheck, key: string): number {
  const value = check.details?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function redactSecrets<T>(value: T): T {
  return redactValue(value, '') as T
}

function redactValue(value: unknown, key: string): unknown {
  if (typeof value === 'string') return redactString(value, key)
  if (Array.isArray(value)) return value.map((item) => redactValue(item, key))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactValue(entryValue, entryKey),
      ]),
    )
  }
  return value
}

function redactString(value: string, key: string): string {
  if (SECRET_KEY_PATTERN.test(key)) return '[REDACTED]'
  let redacted = value
  for (const pattern of SECRET_VALUE_PATTERNS) {
    redacted = redacted.replace(pattern, '[REDACTED]')
  }
  return redacted
}
