import assert from 'node:assert/strict'
import test from 'node:test'

import { GET as publicHealthGET, HEAD as publicHealthHEAD } from '../../app/api/health/route.ts'
import {
  type AdminHealthResponse,
  type HealthAdapters,
  buildFxSyncHealthFromLastFetched,
  buildPublicHealthResponse,
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

test('admin health status treats any error check as down without relying on array position', () => {
  const okCheck = { status: 'ok', checkedAt: FIXED_DATE.toISOString() } as const
  const errorCheck = { status: 'error', checkedAt: FIXED_DATE.toISOString() } as const

  assert.equal(summarizeHealthStatus(okCheck, [errorCheck]), 'down')
  assert.equal(summarizeHealthStatus(errorCheck, [okCheck]), 'down')
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
  assert.equal(report.checks.latestBackup.message, 'Health check failed or timed out: latest backup')
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
    ...overrides,
  }
}
