import assert from 'node:assert/strict'
import test from 'node:test'

import { GET as publicHealthGET, HEAD as publicHealthHEAD } from '../../app/api/health/route.ts'
import {
  type AdminHealthResponse,
  type HealthAdapters,
  buildAccountingEventsHealth,
  buildCronFreshnessPolicies,
  buildCronFreshnessHealth,
  buildFxSyncHealthFromLastFetched,
  buildIntegrationOutboxHealth,
  buildInvariantCheckHealthFromCronRun,
  buildMintsoftWebhookQueueHealth,
  buildPublicHealthResponse,
  buildWmsStockSyncHealth,
  collectAdminHealth,
  createAdminHealthHandler,
  summarizeHealthStatus,
} from '../../lib/ops/health.ts'

const FIXED_DATE = new Date('2026-04-28T12:00:00.000Z')

test('public health response exposes only minimal uptime status', async () => {
  const response = await publicHealthGET()
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  assert.equal(body.ok, true)
  assert.equal(body.status, 'ok')
  assert.equal(typeof body.checkedAt, 'string')
  assert.equal('services' in body, false)
  assert.equal('database' in body, false)
})

test('public health builder is deterministic when supplied a clock', () => {
  assert.deepEqual(buildPublicHealthResponse(FIXED_DATE), {
    ok: true,
    status: 'ok',
    checkedAt: '2026-04-28T12:00:00.000Z',
  })
})

test('public health HEAD returns only status and no-store header', async () => {
  const response = await publicHealthHEAD()

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  assert.equal(await response.text(), '')
})

test('admin health handler returns auth response before collecting diagnostics', async () => {
  let collected = false
  const handler = createAdminHealthHandler({
    authorize: async () => Response.json({ error: 'Unauthorized' }, { status: 401 }),
    collect: async () => {
      collected = true
      return createAdminReport()
    },
  })

  const response = await handler()
  const body = await response.json()

  assert.equal(response.status, 401)
  assert.deepEqual(body, { error: 'Unauthorized' })
  assert.equal(collected, false)
})

test('admin health handler returns detailed diagnostics for authorized admins', async () => {
  const report = createAdminReport()
  const handler = createAdminHealthHandler({
    authorize: async () => null,
    collect: async () => report,
  })

  const response = await handler()
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  assert.deepEqual(body, report)
  assert.equal(body.app.version, '1.5.0')
  assert.equal(body.checks.database.status, 'ok')
  assert.equal(body.checks.writableDirectories[0].label, 'backups')
  assert.equal(body.checks.integrationOutbox.status, 'ok')
  assert.equal(body.checks.latestInvariantCheck.details?.criticalCount, 0)
  assert.equal(body.checks.cronFreshness.jobs['invariant-check'].status, 'ok')
})

test('admin health handler returns service-unavailable only when core health is down', async () => {
  const handler = createAdminHealthHandler({
    authorize: async () => null,
    collect: async () => createAdminReport({ status: 'down', ok: false }),
  })

  const response = await handler()

  assert.equal(response.status, 503)
})

test('admin health collection summarizes adapter checks without exposing raw environment data', async () => {
  const adapters = createHealthAdapters({
    latestAccountingBatch: async () => ({
      status: 'warning',
      checkedAt: FIXED_DATE.toISOString(),
      lastRunAt: FIXED_DATE.toISOString(),
      lastStatus: 'FAILED',
      reference: 'DAILY_BATCH_GROUP_B',
    }),
  })

  const report = await collectAdminHealth(adapters)

  assert.equal(report.status, 'degraded')
  assert.equal(report.ok, false)
  assert.equal(report.checkedAt, FIXED_DATE.toISOString())
  assert.deepEqual(report.app, { version: '1.5.0', commitSha: 'abc1234' })
  assert.equal(JSON.stringify(report).includes('DATABASE_URL'), false)
  assert.equal(JSON.stringify(report).includes('stage_091'), false)
})

test('admin health collection degrades when invariant critical counts exist', async () => {
  const report = await collectAdminHealth(createHealthAdapters({
    latestInvariantCheck: async () => buildInvariantCheckHealthFromCronRun({
      runId: 'run-1',
      startedAt: new Date('2026-04-28T11:59:00.000Z'),
      finishedAt: new Date('2026-04-28T12:00:00.000Z'),
      status: 'completed',
      countsJson: { total: { total: 3, info: 0, warning: 1, critical: 2 } },
    }, FIXED_DATE),
  }))

  assert.equal(report.status, 'degraded')
  assert.equal(report.ok, false)
  assert.equal(report.checks.latestInvariantCheck.status, 'warning')
  assert.equal(report.checks.latestInvariantCheck.lastStatus, 'critical_findings')
  assert.equal(report.checks.latestInvariantCheck.criticalCount, 2)
  assert.equal(report.checks.latestInvariantCheck.details?.criticalCount, 2)
})

test('admin health status treats any error check as down without relying on array position', () => {
  const okCheck = { status: 'ok', checkedAt: FIXED_DATE.toISOString() } as const
  const errorCheck = { status: 'error', checkedAt: FIXED_DATE.toISOString() } as const

  assert.equal(summarizeHealthStatus([okCheck, errorCheck]), 'down')
  assert.equal(summarizeHealthStatus([errorCheck, okCheck]), 'down')
})

test('admin health collection degrades instead of hanging when an adapter times out', async () => {
  const report = await collectAdminHealth(
    createHealthAdapters({
      latestBackup: async () => new Promise(() => undefined),
    }),
    { timeoutMs: 5 },
  )

  assert.equal(report.status, 'degraded')
  assert.equal(report.checks.latestBackup.status, 'warning')
  assert.equal(
    report.checks.latestBackup.message,
    'Health check failed or timed out: latest backup (Health check timed out: latest backup)',
  )
})

test('admin health collection marks down when database check times out', async () => {
  const report = await collectAdminHealth(
    createHealthAdapters({
      checkDatabase: async () => new Promise(() => undefined),
    }),
    { timeoutMs: 5 },
  )

  assert.equal(report.status, 'down')
  assert.equal(report.checks.database.status, 'error')
  assert.equal(
    report.checks.database.message,
    'Health check failed or timed out: database (Health check timed out: database)',
  )
})

test('FX health uses last successful fetch timestamp instead of FX rate rows', () => {
  assert.deepEqual(
    buildFxSyncHealthFromLastFetched('2026-04-28T06:00:00.000Z', FIXED_DATE),
    {
      status: 'ok',
      checkedAt: FIXED_DATE.toISOString(),
      message: undefined,
      lastRunAt: '2026-04-28T06:00:00.000Z',
      lastStatus: 'fetched',
      reference: 'frankfurter',
      details: {
        ageMs: 21600000,
        staleAfterMs: 129600000,
        lastAttemptAt: null,
        lastAttemptStatus: null,
        retryCount: 0,
        failedCurrencies: [],
        skippedManualOverrideCurrencies: [],
        error: null,
      },
    },
  )
})

test('FX health warns when the last successful fetch timestamp is stale or missing', () => {
  const stale = buildFxSyncHealthFromLastFetched('2026-04-26T00:00:00.000Z', FIXED_DATE)
  const missing = buildFxSyncHealthFromLastFetched(null, FIXED_DATE)

  assert.equal(stale.status, 'warning')
  assert.equal(stale.lastStatus, 'stale')
  assert.equal(stale.message, 'Latest FX fetch is stale')
  assert.equal(missing.status, 'warning')
  assert.equal(missing.message, 'No FX rate fetch timestamp found')
})

test('FX health reports latest failed fetch attempt with retry metadata', () => {
  const health = buildFxSyncHealthFromLastFetched('2026-04-28T06:00:00.000Z', FIXED_DATE, {
    lastAttemptAt: '2026-04-28T11:58:00.000Z',
    lastAttemptStatus: 'failed',
    retryCount: 3,
    failedCurrencies: ['EUR', 'USD'],
    error: 'API returned no response',
  })

  assert.equal(health.status, 'warning')
  assert.equal(health.lastRunAt, '2026-04-28T11:58:00.000Z')
  assert.equal(health.lastStatus, 'failed')
  assert.equal(health.message, 'Latest FX fetch failed: API returned no response')
  assert.deepEqual(health.details, {
    lastAttemptAt: '2026-04-28T11:58:00.000Z',
    lastAttemptStatus: 'failed',
    retryCount: 3,
    failedCurrencies: ['EUR', 'USD'],
    skippedManualOverrideCurrencies: [],
    error: 'API returned no response',
  })
})

test('FX health treats manual-override skip separately from failed fetches', () => {
  const health = buildFxSyncHealthFromLastFetched('2026-04-26T00:00:00.000Z', FIXED_DATE, {
    lastAttemptAt: '2026-04-28T11:58:00.000Z',
    lastAttemptStatus: 'skipped_manual_override',
    retryCount: 0,
    skippedManualOverrideCurrencies: ['EUR'],
  })

  assert.equal(health.status, 'ok')
  assert.equal(health.lastStatus, 'skipped_manual_override')
  assert.equal(health.reference, 'manual override')
  assert.deepEqual(health.details, {
    lastAttemptAt: '2026-04-28T11:58:00.000Z',
    lastAttemptStatus: 'skipped_manual_override',
    retryCount: 0,
    failedCurrencies: [],
    skippedManualOverrideCurrencies: ['EUR'],
    error: null,
  })
})

test('operational health builders summarize outbox webhook accounting and cron risk', () => {
  const outbox = buildIntegrationOutboxHealth({
    pending: 4,
    retryableFailed: 1,
    permanentFailed: 0,
    processing: 2,
    oldestPendingCreatedAt: new Date('2026-04-28T11:00:00.000Z'),
    now: FIXED_DATE,
  })
  const webhook = buildMintsoftWebhookQueueHealth({
    pending: 1,
    pendingRetry: 0,
    failedRetry: 0,
    requiresReview: 1,
    dead: 1,
    oldestUnprocessedReceivedAt: new Date('2026-04-28T10:00:00.000Z'),
    now: FIXED_DATE,
  })
  const accountingEvents = buildAccountingEventsHealth({
    pending: 3,
    failed: 1,
    now: FIXED_DATE,
  })
  const cronFreshness = buildCronFreshnessHealth([
    {
      jobName: 'invariant-check',
      startedAt: new Date('2026-04-28T11:30:00.000Z'),
      finishedAt: new Date('2026-04-28T11:31:00.000Z'),
      status: 'completed',
    },
  ], FIXED_DATE, [
    { jobName: 'invariant-check', schedule: '0 4 * * *', staleAfterMs: 60 * 60 * 1000 },
    { jobName: 'wc-reconcile', schedule: '0 4 * * *', staleAfterMs: 60 * 60 * 1000 },
  ])

  assert.equal(outbox.status, 'warning')
  assert.equal(outbox.details?.oldestPendingAgeMs, 3600000)
  assert.equal(webhook.status, 'warning')
  assert.equal(webhook.details?.requiresReview, 1)
  assert.equal(webhook.details?.dead, 1)
  assert.equal(accountingEvents.status, 'warning')
  assert.equal(accountingEvents.details?.failed, 1)
  assert.equal(cronFreshness.status, 'warning')
  assert.equal(cronFreshness.jobs['invariant-check'].status, 'ok')
  assert.equal(cronFreshness.jobs['wc-reconcile'].status, 'warning')
})

test('operational health builders warn on stale backlogs and preserve healthy active queues', () => {
  const activeOutbox = buildIntegrationOutboxHealth({
    pending: 0,
    retryableFailed: 0,
    permanentFailed: 0,
    processing: 1,
    oldestProcessingLockedAt: new Date('2026-04-28T11:55:00.000Z'),
    now: FIXED_DATE,
  })
  const stuckOutbox = buildIntegrationOutboxHealth({
    pending: 0,
    retryableFailed: 0,
    permanentFailed: 0,
    processing: 1,
    oldestProcessingLockedAt: new Date('2026-04-28T11:30:00.000Z'),
    now: FIXED_DATE,
  })
  const freshAccountingBacklog = buildAccountingEventsHealth({
    pending: 20,
    failed: 0,
    oldestPendingCreatedAt: new Date('2026-04-28T11:45:00.000Z'),
    now: FIXED_DATE,
  })
  const staleAccountingBacklog = buildAccountingEventsHealth({
    pending: 20,
    failed: 0,
    oldestPendingCreatedAt: new Date('2026-04-28T11:00:00.000Z'),
    now: FIXED_DATE,
  })

  assert.equal(activeOutbox.status, 'ok')
  assert.equal(stuckOutbox.status, 'warning')
  assert.equal(freshAccountingBacklog.status, 'ok')
  assert.equal(staleAccountingBacklog.status, 'warning')
})

test('cron freshness handles missing runs, clock skew, and registry-derived schedules', () => {
  const empty = buildCronFreshnessHealth([], FIXED_DATE, [
    { jobName: 'invariant-check', schedule: '0 4 * * *', staleAfterMs: 36 * 60 * 60 * 1000 },
    { jobName: 'mintsoft-webhook-sweeper', schedule: '*/5 * * * *', staleAfterMs: 15 * 60 * 1000 },
  ])
  const future = buildCronFreshnessHealth([
    {
      jobName: 'mintsoft-webhook-sweeper',
      startedAt: new Date('2026-04-28T12:05:00.000Z'),
      finishedAt: null,
      status: 'completed',
    },
  ], FIXED_DATE, [
    { jobName: 'mintsoft-webhook-sweeper', schedule: '*/5 * * * *', staleAfterMs: 15 * 60 * 1000 },
  ])
  const policies = buildCronFreshnessPolicies([
    {
      slug: 'wc-reconcile',
      settingKey: 'wc_reconcile',
      module: 'woocommerce',
      moduleLabel: 'WooCommerce',
      label: 'WooCommerce Reconcile',
      description: 'Daily WooCommerce reconcile',
      defaultSchedule: '0 4 * * *',
      defaultEnabled: true,
    },
    {
      slug: 'mintsoft-webhook-sweeper',
      settingKey: 'mintsoft_webhook_sweeper',
      module: 'mintsoft',
      moduleLabel: 'Mintsoft',
      label: 'Mintsoft Webhook Sweeper',
      description: 'Drain queued Mintsoft webhooks',
      defaultSchedule: '*/5 * * * *',
      defaultEnabled: true,
    },
    {
      slug: 'mintsoft-product-verify',
      settingKey: 'mintsoft_product_verify',
      module: 'mintsoft',
      moduleLabel: 'Mintsoft',
      label: 'Mintsoft Product Verification',
      description: 'Verify Mintsoft product mappings',
      defaultSchedule: '0 3 * * *',
      defaultEnabled: false,
    },
  ], new Map([['cron_mintsoft_product_verify_enabled', 'true']]))

  assert.equal(empty.status, 'warning')
  assert.equal(empty.jobs['invariant-check'].lastRunAt, null)
  assert.equal(future.jobs['mintsoft-webhook-sweeper'].ageMs, 0)
  assert.equal(policies.find((policy) => policy.jobName === 'wc-reconcile')?.staleAfterMs, 36 * 60 * 60 * 1000)
  assert.equal(
    policies.find((policy) => policy.jobName === 'mintsoft-webhook-sweeper')?.staleAfterMs,
    15 * 60 * 1000,
  )
  assert.equal(Boolean(policies.find((policy) => policy.jobName === 'mintsoft-product-verify')), true)
})

test('every-minute cron schedule yields a minute-scale staleness policy, not 36h', () => {
  const policies = buildCronFreshnessPolicies([
    {
      slug: 'every-minute-sweep',
      settingKey: 'every_minute_sweep',
      module: 'core',
      moduleLabel: 'Core',
      label: 'Every-minute sweep',
      description: 'Tick every minute',
      defaultSchedule: '* * * * *',
      defaultEnabled: true,
    },
  ], new Map())

  const policy = policies.find((p) => p.jobName === 'every-minute-sweep')
  assert.ok(policy, 'policy for * * * * * job should exist')
  // 1 minute interval * 3 = 3 minutes staleness window — same shape as the */N branch.
  assert.equal(policy.staleAfterMs, 3 * 60 * 1000)
})

test('invariant and WMS stock health elevate parse mismatches and completed jobs with findings', () => {
  const malformedInvariant = buildInvariantCheckHealthFromCronRun({
    runId: 'run-1',
    startedAt: new Date('2026-04-28T11:55:00.000Z'),
    finishedAt: new Date('2026-04-28T12:00:00.000Z'),
    status: 'completed',
    countsJson: { summary: { criticalCount: 5 } },
  }, FIXED_DATE)
  const stockSync = buildWmsStockSyncHealth({
    id: 'sync-1',
    status: 'SUCCEEDED',
    startedAt: new Date('2026-04-28T11:55:00.000Z'),
    finishedAt: new Date('2026-04-28T12:00:00.000Z'),
    totalChecked: 10,
    mismatched: 1,
    errors: 0,
  }, FIXED_DATE)

  assert.equal(malformedInvariant.status, 'warning')
  assert.equal(malformedInvariant.countShape, 'mismatch')
  assert.equal(malformedInvariant.details?.countShape, 'mismatch')
  assert.equal(stockSync.status, 'warning')
  assert.equal(stockSync.message, 'Latest Mintsoft stock sync completed with mismatches or errors')
})

function createAdminReport(overrides: Partial<AdminHealthResponse> = {}): AdminHealthResponse {
  return {
    ok: true,
    status: 'ok',
    checkedAt: FIXED_DATE.toISOString(),
    app: {
      version: '1.5.0',
      commitSha: 'abc1234',
    },
    checks: {
      database: { status: 'ok', checkedAt: FIXED_DATE.toISOString() },
      migrations: {
        status: 'ok',
        checkedAt: FIXED_DATE.toISOString(),
        lastRunAt: FIXED_DATE.toISOString(),
        lastStatus: 'applied',
        reference: '202604280001_stage_091',
      },
      writableDirectories: [
        {
          label: 'backups',
          writable: true,
          status: 'ok',
          checkedAt: FIXED_DATE.toISOString(),
        },
      ],
      latestBackup: {
        status: 'ok',
        checkedAt: FIXED_DATE.toISOString(),
        lastRunAt: FIXED_DATE.toISOString(),
        lastStatus: 'available',
        reference: 'scheduled.dump',
      },
      latestAccountingBatch: {
        status: 'ok',
        checkedAt: FIXED_DATE.toISOString(),
        lastRunAt: FIXED_DATE.toISOString(),
        lastStatus: 'SYNCED',
        reference: 'DAILY_BATCH_REVENUE_DEFERRAL',
      },
      latestWooCommerceSync: {
        status: 'ok',
        checkedAt: FIXED_DATE.toISOString(),
        lastRunAt: FIXED_DATE.toISOString(),
        lastStatus: 'SYNCED',
        reference: 'Product',
      },
      latestFxSync: {
        status: 'ok',
        checkedAt: FIXED_DATE.toISOString(),
        lastRunAt: FIXED_DATE.toISOString(),
        lastStatus: 'synced',
        reference: 'EUR',
      },
      integrationOutbox: {
        status: 'ok',
        checkedAt: FIXED_DATE.toISOString(),
        details: {
          pending: 0,
          retryableFailed: 0,
          permanentFailed: 0,
          processing: 0,
          oldestPendingCreatedAt: null,
          oldestPendingAgeMs: null,
          pendingStaleAfterMs: 1800000,
          oldestProcessingLockedAt: null,
          oldestProcessingAgeMs: null,
          stuckProcessingAfterMs: 600000,
        },
      },
      latestInvariantCheck: {
        status: 'ok',
        checkedAt: FIXED_DATE.toISOString(),
        lastRunAt: FIXED_DATE.toISOString(),
        lastStatus: 'completed',
        reference: 'invariant-run-1',
        criticalCount: 0,
        countShape: 'exact',
        details: { criticalCount: 0, countShape: 'exact' },
      },
      latestWmsStockSync: {
        status: 'ok',
        checkedAt: FIXED_DATE.toISOString(),
        lastRunAt: FIXED_DATE.toISOString(),
        lastStatus: 'SUCCEEDED',
        reference: 'wms-sync-1',
        details: {
          connector: 'mintsoft',
          totalChecked: 10,
          mismatched: 0,
          errors: 0,
        },
      },
      mintsoftWebhookQueue: {
        status: 'ok',
        checkedAt: FIXED_DATE.toISOString(),
        details: {
          pending: 0,
          pendingRetry: 0,
          failedRetry: 0,
          dead: 0,
          oldestUnprocessedReceivedAt: null,
          oldestUnprocessedAgeMs: null,
          staleAfterMs: 3600000,
        },
      },
      accountingEvents: {
        status: 'ok',
        checkedAt: FIXED_DATE.toISOString(),
        details: {
          pending: 0,
          failed: 0,
          oldestPendingCreatedAt: null,
          oldestPendingAgeMs: null,
          pendingStaleAfterMs: 1800000,
        },
      },
      cronFreshness: {
        status: 'ok',
        checkedAt: FIXED_DATE.toISOString(),
        details: { warningCount: 0 },
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
      fileScanner: {
        status: 'ok',
        checkedAt: FIXED_DATE.toISOString(),
        details: {
          scanMode: 'disabled',
          scanStatus: 'skipped',
          scanReason: 'disabled',
          scanScannerId: null,
        },
      },
    },
    ...overrides,
  }
}

function createHealthAdapters(overrides: Partial<HealthAdapters> = {}): HealthAdapters {
  return {
    now: () => FIXED_DATE,
    appVersion: () => '1.5.0',
    commitSha: () => 'abc1234',
    checkDatabase: async () => ({ status: 'ok', checkedAt: FIXED_DATE.toISOString() }),
    latestMigration: async () => ({
      status: 'ok',
      checkedAt: FIXED_DATE.toISOString(),
      lastRunAt: FIXED_DATE.toISOString(),
      lastStatus: 'applied',
      reference: null,
    }),
    checkWritableDirectories: async () => [
      {
        label: 'backups',
        writable: true,
        status: 'ok',
        checkedAt: FIXED_DATE.toISOString(),
      },
    ],
    latestBackup: async () => ({
      status: 'ok',
      checkedAt: FIXED_DATE.toISOString(),
      lastRunAt: FIXED_DATE.toISOString(),
      lastStatus: 'available',
      reference: 'scheduled.dump',
    }),
    latestAccountingBatch: async () => ({
      status: 'ok',
      checkedAt: FIXED_DATE.toISOString(),
      lastRunAt: FIXED_DATE.toISOString(),
      lastStatus: 'SYNCED',
      reference: 'DAILY_BATCH_REVENUE_DEFERRAL',
    }),
    latestWooCommerceSync: async () => ({
      status: 'ok',
      checkedAt: FIXED_DATE.toISOString(),
      lastRunAt: FIXED_DATE.toISOString(),
      lastStatus: 'SYNCED',
      reference: 'Product',
      details: { connector: 'woocommerce' },
    }),
    latestFxSync: async () => ({
      status: 'ok',
      checkedAt: FIXED_DATE.toISOString(),
      lastRunAt: FIXED_DATE.toISOString(),
      lastStatus: 'synced',
      reference: 'frankfurter',
      details: { source: 'frankfurter' },
    }),
    integrationOutbox: async () => buildIntegrationOutboxHealth({
      pending: 0,
      retryableFailed: 0,
      permanentFailed: 0,
      processing: 0,
      oldestPendingCreatedAt: null,
      oldestProcessingLockedAt: null,
      now: FIXED_DATE,
    }),
    latestInvariantCheck: async () => buildInvariantCheckHealthFromCronRun({
      runId: 'invariant-run-1',
      startedAt: FIXED_DATE,
      finishedAt: FIXED_DATE,
      status: 'completed',
      countsJson: { total: { total: 0, info: 0, warning: 0, critical: 0 } },
    }, FIXED_DATE),
    latestWmsStockSync: async () => ({
      status: 'ok',
      checkedAt: FIXED_DATE.toISOString(),
      lastRunAt: FIXED_DATE.toISOString(),
      lastStatus: 'SUCCEEDED',
      reference: 'wms-sync-1',
      details: {
        connector: 'mintsoft',
        totalChecked: 10,
        mismatched: 0,
        errors: 0,
      },
    }),
    mintsoftWebhookQueue: async () => buildMintsoftWebhookQueueHealth({
      pending: 0,
      pendingRetry: 0,
      failedRetry: 0,
      requiresReview: 0,
      dead: 0,
      oldestUnprocessedReceivedAt: null,
      now: FIXED_DATE,
    }),
    accountingEvents: async () => buildAccountingEventsHealth({
      pending: 0,
      failed: 0,
      oldestPendingCreatedAt: null,
      now: FIXED_DATE,
    }),
    cronFreshness: async () => buildCronFreshnessHealth([
      {
        jobName: 'invariant-check',
        startedAt: FIXED_DATE,
        finishedAt: FIXED_DATE,
        status: 'completed',
      },
    ], FIXED_DATE, [
      { jobName: 'invariant-check', schedule: '0 4 * * *', staleAfterMs: 129600000 },
    ]),
    fileScanner: async () => ({
      status: 'ok',
      checkedAt: FIXED_DATE.toISOString(),
      details: {
        scanMode: 'disabled',
        scanStatus: 'skipped',
        scanReason: 'disabled',
        scanScannerId: null,
      },
    }),
    ...overrides,
  }
}
