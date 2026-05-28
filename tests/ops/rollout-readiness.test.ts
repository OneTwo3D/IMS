import assert from 'node:assert/strict'
import test from 'node:test'

import {
  clearRolloutReadinessCache,
  collectCachedRolloutReadiness,
  collectRolloutReadiness,
  createRolloutReadinessHandler,
  type LatestAccountingReconciliationRun,
  type RolloutReadinessAdapters,
} from '../../lib/ops/rollout-readiness.ts'
import {
  type AdminHealthResponse,
  type HealthLevel,
  buildAccountingEventsHealth,
  buildIntegrationOutboxHealth,
  buildMintsoftWebhookQueueHealth,
} from '../../lib/ops/health.ts'
import type { PreflightCheck, PreflightResult } from '../../scripts/preflight-production.ts'

const FIXED_DATE = new Date('2026-05-01T10:00:00.000Z')

test('rollout readiness handler returns auth response before collecting diagnostics', async () => {
  let collected = false
  const handler = createRolloutReadinessHandler({
    authorize: async () => Response.json({ error: 'Unauthorized' }, { status: 401 }),
    collect: async () => {
      collected = true
      return collectRolloutReadiness(createAdapters())
    },
  })

  const response = await handler()
  const body = await response.json()

  assert.equal(response.status, 401)
  assert.deepEqual(body, { error: 'Unauthorized' })
  assert.equal(collected, false)
})

test('rollout readiness reports ready when all rollout signals are clean', async () => {
  const report = await collectRolloutReadiness(createAdapters())

  assert.equal(report.ok, true)
  assert.equal(report.status, 'ready')
  assert.deepEqual(report.blockers, [])
  assert.deepEqual(report.warnings, [])
  assert.equal(report.checks.preflight.status, 'pass')
  assert.equal(report.checks.latestAccountingReconciliationRun?.status, 'COMPLETED')
})

test('rollout readiness reports warnings without blocking rollout', async () => {
  const report = await collectRolloutReadiness(createAdapters({
    preflight: createPreflight([
      { id: 'trusted-proxy', name: 'TRUSTED_PROXY_CIDRS', status: 'warn', message: 'Trusted proxy CIDRs are not configured.' },
    ]),
    adminHealth: createAdminHealth({
      status: 'degraded',
      ok: false,
      checks: {
        ...createAdminHealth().checks,
        cronFreshness: {
          status: 'warning',
          checkedAt: FIXED_DATE.toISOString(),
          message: 'One or more cron jobs are stale or failed',
          details: { warningCount: 1 },
          jobs: {
            'activity-cleanup': {
              status: 'warning',
              lastRunAt: null,
              lastStatus: null,
              ageMs: null,
              staleAfterMs: 129600000,
              schedule: '0 4 * * *',
            },
          },
        },
      },
    }),
    latestAccountingReconciliationRun: null,
  }))

  assert.equal(report.ok, false)
  assert.equal(report.status, 'warning')
  assert.deepEqual(report.blockers, [])
  assert(report.warnings.some((finding) => finding.id === 'preflight:trusted-proxy'))
  assert(report.warnings.some((finding) => finding.id === 'cron-freshness:activity-cleanup'))
  assert(report.warnings.some((finding) => finding.id === 'accounting-reconciliation:missing'))
})

test('rollout readiness reports blockers for active P0 rollout conditions', async () => {
  const health = createAdminHealth({
    status: 'down',
    ok: false,
    checks: {
      ...createAdminHealth().checks,
      database: {
        status: 'error',
        checkedAt: FIXED_DATE.toISOString(),
        message: 'Database connectivity check failed',
      },
      writableDirectories: [
        {
          label: 'backups',
          writable: false,
          status: 'error',
          checkedAt: FIXED_DATE.toISOString(),
          message: 'Directory is not writable',
        },
      ],
      latestBackup: {
        status: 'warning',
        checkedAt: FIXED_DATE.toISOString(),
        lastRunAt: null,
        lastStatus: null,
        reference: null,
        message: 'No backup files found',
      },
      latestInvariantCheck: {
        status: 'warning',
        checkedAt: FIXED_DATE.toISOString(),
        lastRunAt: FIXED_DATE.toISOString(),
        lastStatus: 'critical_findings',
        reference: 'invariant-run-1',
        criticalCount: 2,
        countShape: 'exact',
        message: 'Latest invariant check reported critical findings',
        details: { criticalCount: 2, countShape: 'exact' },
      },
      integrationOutbox: {
        status: 'warning',
        checkedAt: FIXED_DATE.toISOString(),
        message: 'Integration outbox requires attention',
        details: {
          pending: 0,
          retryableFailed: 0,
          permanentFailed: 1,
          processing: 0,
        },
      },
      mintsoftWebhookQueue: {
        status: 'warning',
        checkedAt: FIXED_DATE.toISOString(),
        message: 'Mintsoft webhook queue requires attention',
        details: {
          pending: 0,
          pendingRetry: 0,
          failedRetry: 0,
          requiresReview: 0,
          dead: 1,
        },
      },
      accountingEvents: {
        status: 'warning',
        checkedAt: FIXED_DATE.toISOString(),
        message: 'Accounting events have failed rows',
        details: {
          pending: 0,
          failed: 1,
        },
      },
    },
  })

  const report = await collectRolloutReadiness(createAdapters({
    preflight: createPreflight([
      { id: 'auth-secret', name: 'AUTH_SECRET/NEXTAUTH_SECRET', status: 'fail', message: 'Auth secret is missing.' },
    ]),
    adminHealth: health,
    latestAccountingReconciliationRun: {
      id: 'recon-1',
      status: 'FAILED',
      totalCount: 10,
      warningCount: 0,
      criticalCount: 0,
      createdAt: FIXED_DATE.toISOString(),
    },
  }))

  assert.equal(report.ok, false)
  assert.equal(report.status, 'blocked')
  const blockerIds = new Set(report.blockers.map((finding) => finding.id))
  const expectedBlockerIds = [
    'preflight:auth-secret',
    'admin-health:down',
    'database',
    'storage-path:backups',
    'latest-backup:missing',
    'latest-invariant-check:critical',
    'integration-outbox:permanent-failed',
    'wms-webhook-queue:dead',
    'accounting-events:failed',
    'accounting-reconciliation:failed',
  ]
  assert.equal(blockerIds.size, expectedBlockerIds.length)
  for (const expectedId of expectedBlockerIds) {
    assert.equal(blockerIds.has(expectedId), true, `expected blocker ${expectedId}`)
  }
})

test('rollout readiness handler uses precondition-failed for blocked and warning rollout by default', async () => {
  const readyHandler = createRolloutReadinessHandler({
    authorize: async () => null,
    collect: async () => collectRolloutReadiness(createAdapters()),
  })
  const warningHandler = createRolloutReadinessHandler({
    authorize: async () => null,
    collect: async () => collectRolloutReadiness(createAdapters({
      latestAccountingReconciliationRun: null,
    })),
  })
  const blockedHandler = createRolloutReadinessHandler({
    authorize: async () => null,
    collect: async () => collectRolloutReadiness(createAdapters({
      preflight: createPreflight([
        { id: 'database-url', name: 'DATABASE_URL', status: 'fail', message: 'DATABASE_URL is required in production.' },
      ]),
    })),
  })

  const ready = await readyHandler(new Request('https://ims.example.test/api/admin/rollout-readiness'))
  const warning = await warningHandler(new Request('https://ims.example.test/api/admin/rollout-readiness'))
  const warningAllowed = await warningHandler(
    new Request('https://ims.example.test/api/admin/rollout-readiness?allowWarnings=true'),
  )
  const blocked = await blockedHandler(new Request('https://ims.example.test/api/admin/rollout-readiness'))

  assert.equal(ready.status, 200)
  assert.equal(ready.headers.get('Cache-Control'), 'no-store')
  assert.equal(warning.status, 412)
  assert.equal(warningAllowed.status, 200)
  assert.equal(blocked.status, 412)
})

test('rollout readiness response does not expose raw secret values', async () => {
  const databaseUrl = 'postgres://user:password@example.test/ims'
  const jwtToken = [
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    'eyJzdWIiOiJhZG1pbiJ9',
    'abcdefghi0123456789',
  ].join('.')
  const settingsKey = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN'
  const report = await collectRolloutReadiness(createAdapters({
    preflight: createPreflight([
      { id: 'auth-secret', name: 'AUTH_SECRET/NEXTAUTH_SECRET', status: 'fail', message: `Auth secret leaked ${settingsKey}.` },
      { id: 'database-url', name: 'DATABASE_URL', status: 'fail', message: `DATABASE_URL leaked ${databaseUrl}.` },
    ]),
    adminHealth: createAdminHealth({
      checks: {
        ...createAdminHealth().checks,
        integrationOutbox: {
          status: 'warning',
          checkedAt: FIXED_DATE.toISOString(),
          message: `Connector token leaked ${jwtToken}`,
          details: {
            permanentFailed: 1,
            apiToken: jwtToken,
            databaseUrl,
            settingsEncryptionKey: settingsKey,
          },
        },
      },
    }),
  }))

  const serialized = JSON.stringify(report)
  assert.equal(serialized.includes(databaseUrl), false)
  assert.equal(serialized.includes(jwtToken), false)
  assert.equal(serialized.includes(settingsKey), false)
})

test('rollout readiness times out hanging adapters and caches successful reports briefly', async () => {
  clearRolloutReadinessCache()
  let preflightCalls = 0
  const adapters = createAdapters({
    preflight: undefined,
  })
  adapters.runPreflight = async () => {
    preflightCalls += 1
    return createPreflight()
  }

  const first = await collectCachedRolloutReadiness(adapters, { cacheTtlMs: 30_000 })
  const second = await collectCachedRolloutReadiness(adapters, { cacheTtlMs: 30_000 })

  assert.equal(first.cache.hit, false)
  assert.equal(second.cache.hit, true)
  assert.equal(preflightCalls, 1)

  const timedOut = await collectRolloutReadiness({
    ...createAdapters(),
    runPreflight: async () => new Promise<PreflightResult>(() => {}),
  }, { timeoutMs: 1 })

  assert.equal(timedOut.status, 'blocked')
  assert(timedOut.blockers.some((finding) => finding.id === 'preflight:rollout-readiness-preflight'))
})

test('rollout readiness locks health detail field contracts used for blocker classification', () => {
  const outbox = buildIntegrationOutboxHealth({
    pending: 0,
    retryableFailed: 0,
    permanentFailed: 1,
    processing: 0,
    now: FIXED_DATE,
  })
  const webhooks = buildMintsoftWebhookQueueHealth({
    pending: 0,
    pendingRetry: 0,
    failedRetry: 0,
    requiresReview: 0,
    dead: 1,
    now: FIXED_DATE,
  })
  const accountingEvents = buildAccountingEventsHealth({
    pending: 0,
    failed: 1,
    now: FIXED_DATE,
  })

  assert.equal(typeof outbox.details?.permanentFailed, 'number')
  assert.equal(typeof webhooks.details?.dead, 'number')
  assert.equal(typeof accountingEvents.details?.failed, 'number')
})

function createAdapters(overrides: {
  preflight?: PreflightResult
  adminHealth?: AdminHealthResponse
  latestAccountingReconciliationRun?: LatestAccountingReconciliationRun | null
} = {}): RolloutReadinessAdapters {
  return {
    now: () => FIXED_DATE,
    runPreflight: async () => overrides.preflight ?? createPreflight(),
    collectAdminHealth: async () => overrides.adminHealth ?? createAdminHealth(),
    latestAccountingReconciliationRun: async () =>
      overrides.latestAccountingReconciliationRun === undefined
        ? createReconciliationRun()
        : overrides.latestAccountingReconciliationRun,
  }
}

function createPreflight(checks: PreflightCheck[] = [
  { id: 'node-env', name: 'NODE_ENV', status: 'pass', message: 'NODE_ENV is production.' },
]): PreflightResult {
  return {
    ok: checks.every((check) => check.status !== 'fail'),
    checks,
  }
}

function createReconciliationRun(): LatestAccountingReconciliationRun {
  return {
    id: 'recon-1',
    status: 'COMPLETED',
    totalCount: 0,
    warningCount: 0,
    criticalCount: 0,
    createdAt: FIXED_DATE.toISOString(),
  }
}

function createAdminHealth(overrides: Partial<AdminHealthResponse> = {}): AdminHealthResponse {
  return {
    ok: true,
    status: 'ok',
    checkedAt: FIXED_DATE.toISOString(),
    app: {
      version: '1.5.0',
      commitSha: 'abc1234',
    },
    checks: {
      database: okCheck(),
      migrations: okLatest('applied'),
      writableDirectories: [
        {
          label: 'backups',
          writable: true,
          ...okCheck(),
        },
      ],
      latestBackup: okLatest('available'),
      latestAccountingBatch: okLatest('SYNCED'),
      latestWooCommerceSync: okLatest('SYNCED'),
      latestFxSync: okLatest('synced'),
      integrationOutbox: okCheck({
        pending: 0,
        retryableFailed: 0,
        permanentFailed: 0,
        processing: 0,
      }),
      latestInvariantCheck: {
        ...okLatest('completed'),
        criticalCount: 0,
        countShape: 'exact',
        details: { criticalCount: 0, countShape: 'exact' },
      },
      latestWmsStockSync: okLatest('SUCCEEDED'),
      mintsoftWebhookQueue: okCheck({
        pending: 0,
        pendingRetry: 0,
        failedRetry: 0,
        requiresReview: 0,
        dead: 0,
      }),
      accountingEvents: okCheck({
        pending: 0,
        failed: 0,
      }),
      cronFreshness: {
        ...okCheck({ warningCount: 0 }),
        jobs: {
          'invariant-check': {
            status: 'ok',
            lastRunAt: FIXED_DATE.toISOString(),
            lastStatus: 'completed',
            ageMs: 0,
            staleAfterMs: 129600000,
            schedule: '0 4 * * *',
          },
        },
      },
      fileScanner: okCheck({
        scanMode: 'disabled',
        scanStatus: 'skipped',
        scanReason: 'disabled',
        scanScannerId: null,
      }),
    },
    ...overrides,
  }
}

function okCheck(details?: Record<string, string | number | boolean | null>) {
  return {
    status: 'ok' as HealthLevel,
    checkedAt: FIXED_DATE.toISOString(),
    details,
  }
}

function okLatest(lastStatus: string) {
  return {
    ...okCheck(),
    lastRunAt: FIXED_DATE.toISOString(),
    lastStatus,
    reference: 'ok-ref',
  }
}
