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
import {
  evaluateReconciliationProof,
  type ReconciliationHistory,
  type ReconciliationProof,
} from '@/lib/ops/reconciliation-proof'

type JsonPrimitive = string | number | boolean | null
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

const ROLLOUT_READINESS_RESPONSE_VERSION = 1 as const
const DEFAULT_READINESS_TIMEOUT_MS = 10_000
const DEFAULT_READINESS_CACHE_TTL_MS = 30_000
const TERMINAL_ACCOUNTING_RECONCILIATION_RUN_STATUSES = ['COMPLETED', 'FAILED', 'PARTIAL'] as const
/**
 * o3d-6e4v — HOW OLD THE NEWEST RECONCILIATION RUN MAY BE BEFORE ITS ANSWER IS NOT TODAY'S ANSWER.
 *
 * Reconciliation is run by an operator (POST /api/admin/accounting/reconciliation), not on a schedule, so
 * there is no cadence to derive this from. Seven days is a CHOSEN default, stated here as one: it is the
 * longest a clean answer is read as current. A run older than this is a WARNING, not a blocker — the
 * remedy is simply to run reconciliation — and it is reported with its age so the choice is visible.
 */
export const ROLLOUT_RECONCILIATION_MAX_AGE_DAYS = 7
/**
 * How many recorded runs the completeness reader will evaluate after the oldest unresolved truncation.
 * Past it the history is reported as UNEVALUATED (a blocker) rather than read partially as clean.
 */
export const RECONCILIATION_HISTORY_READ_LIMIT = 5_000
const BLOCKING_CRON_JOBS = new Set([
  'account-balance-snapshot',
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
  /**
   * o3d-6e4v: the run's interval and its RAW truncation record. The gate never reads `truncations` itself —
   * it hands it to evaluateReconciliationProof, which interprets it only through
   * readReconciliationCompleteness. Absent (undefined) is read as NULL: not recorded.
   */
  fromDate?: string | null
  toDate?: string | null
  truncations?: unknown
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
    /** o3d-6e4v: whether the reconciliation is PROVEN complete across its history, and if not, why. */
    accountingReconciliationProof: ReconciliationProof | null
  }
}

export type RolloutReadinessAdapters = {
  now: () => Date
  runPreflight: () => Promise<PreflightResult>
  collectAdminHealth: () => Promise<AdminHealthResponse>
  latestAccountingReconciliationRun: () => Promise<LatestAccountingReconciliationRun | null>
  /**
   * o3d-6e4v: the run history the completeness proof needs — every recorded run from the oldest
   * unresolved truncation onward (see ReconciliationHistory). Asked only when a newest run exists.
   */
  accountingReconciliationHistory: (newest: LatestAccountingReconciliationRun) => Promise<ReconciliationHistory>
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
    accountingReconciliationHistory: (newest) => getAccountingReconciliationHistory(newest),
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

  // o3d-6e4v: completeness is a question about the HISTORY, asked separately from the newest run's
  // status and counts. An adapter that fails is not a clean answer: it is a blocker, because the only
  // thing this check establishes is a proof, and there is none.
  let accountingReconciliationProof: ReconciliationProof | null = null
  if (latestAccountingReconciliationRun) {
    const historyResult = await settleReadinessAdapter(
      'accounting-reconciliation-history',
      adapters.accountingReconciliationHistory(latestAccountingReconciliationRun),
      timeoutMs,
    )
    if (historyResult.ok) {
      accountingReconciliationProof = evaluateReconciliationProof(latestAccountingReconciliationRun, historyResult.value)
      classifyReconciliationProof(accountingReconciliationProof, blockers, warnings)
    } else {
      blockers.push({
        id: 'accounting-reconciliation:completeness-unevaluated',
        severity: 'blocker',
        source: 'accounting-reconciliation',
        message: 'Whether the accounting reconciliation is complete could not be established: its run history could not be read.',
        details: { error: summarizeReadinessError(historyResult.error) },
      })
    }
    classifyReconciliationAge(latestAccountingReconciliationRun, now, warnings)
  }

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
      accountingReconciliationProof,
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
      fromDate: true,
      toDate: true,
      truncations: true,
    },
  })

  if (!latest) return null
  return {
    ...latest,
    status: latest.status as AccountingReconciliationRunStatus,
    createdAt: latest.createdAt.toISOString(),
    fromDate: latest.fromDate?.toISOString() ?? null,
    toDate: latest.toDate?.toISOString() ?? null,
    truncations: latest.truncations,
  }
}

/**
 * o3d-6e4v — THE RUNS THE COMPLETENESS PROOF QUANTIFIES OVER.
 *
 * 1. The OLDEST run whose record is truncated (a non-empty array) or unreadable (non-NULL and not an
 *    array). If none exists, no truncation needs covering and only the newest run's own record matters.
 * 2. Every run with a non-NULL record created at or after it, oldest first — the only runs that can cover
 *    it. NULL rows are left out: they make no statement, and cannot cover anything.
 * One statement, so no timestamp crosses the driver between them (`createdAt` is a zone-less timestamp,
 * and a round-tripped Date could be re-read in the session's zone).
 * Bounded by RECONCILIATION_HISTORY_READ_LIMIT; one more is read so that overflow is detected, never
 * guessed. Terminal statuses only, as for the newest run.
 */
export type ReconciliationHistoryClient = {
  $queryRaw: typeof db.$queryRaw
}

export async function getAccountingReconciliationHistory(
  newest: LatestAccountingReconciliationRun,
  client: ReconciliationHistoryClient = db,
): Promise<ReconciliationHistory> {
  const statuses = [...TERMINAL_ACCOUNTING_RECONCILIATION_RUN_STATUSES]
  const recordedBefore = await client.$queryRaw<Array<{ found: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM "accounting_reconciliation_runs"
      WHERE "status" = ANY(${statuses}::text[])
        AND "truncations" IS NOT NULL
        AND "createdAt" < (SELECT "createdAt" FROM "accounting_reconciliation_runs" WHERE "id" = ${newest.id})
    ) AS "found"
  `
  const recordedBeforeNewest = recordedBefore[0]?.found === true

  // Raw SQL rather than findMany: Prisma hands back a JSON `null` payload as JS `null`, which is exactly
  // what an SQL NULL looks like — and the two mean different things here. SQL NULL is "not recorded"; a
  // JSON null is a non-NULL record that is not an array, i.e. UNREADABLE. `jsonb_typeof` tells them apart,
  // and a JSON null is passed on as a value readReconciliationCompleteness reads as unreadable.
  const rows = await client.$queryRaw<Array<{
    id: string; createdAt: Date; fromDate: Date | null; toDate: Date | null; truncations: unknown; payloadType: string
  }>>`
    WITH "oldestUnproven" AS (
      SELECT "createdAt"
      FROM "accounting_reconciliation_runs"
      WHERE "status" = ANY(${statuses}::text[])
        AND "truncations" IS NOT NULL
        -- CASE, not OR: SQL does not promise to short-circuit, and jsonb_array_length ERRORS on a
        -- non-array, which is precisely the unreadable row this must find.
        AND CASE WHEN jsonb_typeof("truncations") = 'array' THEN jsonb_array_length("truncations") > 0 ELSE true END
      ORDER BY "createdAt" ASC, "id" ASC
      LIMIT 1
    )
    SELECT "id", "createdAt", "fromDate", "toDate", "truncations", jsonb_typeof("truncations") AS "payloadType"
    FROM "accounting_reconciliation_runs"
    WHERE "status" = ANY(${statuses}::text[])
      AND "truncations" IS NOT NULL
      -- No unproven run: the subquery is empty, the comparison is NULL, and nothing is returned.
      AND "createdAt" >= (SELECT "createdAt" FROM "oldestUnproven")
    ORDER BY "createdAt" ASC, "id" ASC
    LIMIT ${RECONCILIATION_HISTORY_READ_LIMIT + 1}
  `
  return {
    runs: rows.slice(0, RECONCILIATION_HISTORY_READ_LIMIT).map((row) => ({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      fromDate: row.fromDate?.toISOString() ?? null,
      toDate: row.toDate?.toISOString() ?? null,
      truncations: row.payloadType === 'null' ? { unreadable: 'json-null' } : row.truncations,
    })),
    overflow: rows.length > RECONCILIATION_HISTORY_READ_LIMIT,
    recordedBeforeNewest,
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

/**
 * o3d-6e4v — WHAT THE COMPLETENESS PROOF COSTS THE VERDICT. See lib/ops/reconciliation-proof.ts for why each
 * state has the severity it has; in short, the two that are the data's own statement of loss (truncated,
 * unreadable) are blockers, because `?allowWarnings=true` makes any warning HTTP 200 without a record.
 */
function classifyReconciliationProof(
  proof: ReconciliationProof,
  blockers: RolloutReadinessFinding[],
  warnings: RolloutReadinessFinding[],
): void {
  if (proof.state === 'proven') return
  const shown = proof.unresolved.slice(0, 20).map((entry) => ({
    runId: entry.runId,
    createdAt: entry.createdAt,
    fromDate: entry.fromDate,
    toDate: entry.toDate,
    code: entry.code,
  }))
  const truncated = proof.unresolved.filter((entry) => entry.code !== '*')
  const unreadable = proof.unresolved.filter((entry) => entry.code === '*')
  if (truncated.length > 0) {
    blockers.push({
      id: 'accounting-reconciliation:truncation-unresolved',
      severity: 'blocker',
      source: 'accounting-reconciliation',
      message:
        `${truncated.length} accounting reconciliation truncation(s) are not covered by a later complete run: a run `
        + 'reported that it omitted findings, and no later run that completed that check has examined the same '
        + 'period. Run reconciliation with a lookback that reaches back past the earliest one listed.',
      details: { unresolved: shown.filter((entry) => entry.code !== '*'), total: truncated.length },
    })
  }
  if (unreadable.length > 0) {
    blockers.push({
      id: 'accounting-reconciliation:completeness-unreadable',
      severity: 'blocker',
      source: 'accounting-reconciliation',
      message:
        `${unreadable.length} accounting reconciliation run(s) carry a completeness record this build cannot read, `
        + 'and no later complete run covers their period.',
      details: { unresolved: shown.filter((entry) => entry.code === '*'), total: unreadable.length },
    })
  }
  if (proof.overflow) {
    blockers.push({
      id: 'accounting-reconciliation:completeness-unevaluated',
      severity: 'blocker',
      source: 'accounting-reconciliation',
      message:
        `The accounting reconciliation history after the oldest unresolved truncation holds more than `
        + `${RECONCILIATION_HISTORY_READ_LIMIT} runs, so whether it is complete was not established.`,
    })
  }
  if (proof.newest === 'not-recorded') {
    const finding: RolloutReadinessFinding = {
      id: 'accounting-reconciliation:completeness-not-recorded',
      severity: proof.notRecordedAfterRecording ? 'blocker' : 'warning',
      source: 'accounting-reconciliation',
      message: proof.notRecordedAfterRecording
        ? 'The newest accounting reconciliation run did not record whether it was complete, although earlier runs '
          + 'did: the build that wrote it is not recording completeness. Run reconciliation again on this build.'
        : 'The newest accounting reconciliation run predates completeness recording, so whether it was complete '
          + 'is unknown. Run reconciliation again on this build.',
    }
    ;(proof.notRecordedAfterRecording ? blockers : warnings).push(finding)
  }
}

/** o3d-6e4v: the newest run's answer is today's only if it is recent (ROLLOUT_RECONCILIATION_MAX_AGE_DAYS). */
function classifyReconciliationAge(
  latest: LatestAccountingReconciliationRun,
  now: Date,
  warnings: RolloutReadinessFinding[],
): void {
  const ageMs = now.getTime() - Date.parse(latest.createdAt)
  const maxAgeMs = ROLLOUT_RECONCILIATION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000
  if (!Number.isFinite(ageMs) || ageMs > maxAgeMs) {
    warnings.push({
      id: 'accounting-reconciliation:stale',
      severity: 'warning',
      source: 'accounting-reconciliation',
      message: `The newest accounting reconciliation run is older than ${ROLLOUT_RECONCILIATION_MAX_AGE_DAYS} days. Run reconciliation again.`,
      details: { id: latest.id, createdAt: latest.createdAt, maxAgeDays: ROLLOUT_RECONCILIATION_MAX_AGE_DAYS },
    })
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
