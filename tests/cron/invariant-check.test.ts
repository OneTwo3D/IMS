import assert from 'node:assert/strict'
import test from 'node:test'

import { GET } from '@/app/api/cron/invariant-check/route'
import { getAllCronJobs } from '@/lib/cron-jobs'
import { runScheduledInvariantCheck } from '@/lib/cron/invariant-check'
import type { AccountingInvariantReport } from '@/lib/domain/accounting/invariants'
import type { InventoryInvariantReport } from '@/lib/domain/inventory/invariants'

type CronEnv = {
  ALLOW_LOCALHOST_CRON_BYPASS?: string
  CRON_SECRET?: string
  INVARIANT_CHECK_STOCK_MOVEMENT_LOOKBACK_DAYS?: string
  NODE_ENV?: string
}

const ENV_KEYS = ['ALLOW_LOCALHOST_CRON_BYPASS', 'CRON_SECRET', 'INVARIANT_CHECK_STOCK_MOVEMENT_LOOKBACK_DAYS', 'NODE_ENV'] as const

async function withCronEnv(env: CronEnv, fn: () => Promise<void>): Promise<void> {
  const mutableEnv = process.env as Record<string, string | undefined>
  const previous = Object.fromEntries(
    ENV_KEYS.map((key) => [key, mutableEnv[key]]),
  ) as Record<(typeof ENV_KEYS)[number], string | undefined>

  try {
    for (const key of ENV_KEYS) {
      if (env[key] === undefined) {
        delete mutableEnv[key]
      } else {
        mutableEnv[key] = env[key]
      }
    }

    await fn()
  } finally {
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) {
        delete mutableEnv[key]
      } else {
        mutableEnv[key] = previous[key]
      }
    }
  }
}

function cronRequest(authorization?: string): Request {
  const headers = new Headers({ host: 'ims.example.com' })
  if (authorization) headers.set('authorization', authorization)

  return new Request('https://ims.example.com/api/cron/invariant-check', { headers })
}

function inventoryReport(): InventoryInvariantReport {
  return {
    checkedAt: '2026-01-01T00:00:01.000Z',
    findings: [
      {
        severity: 'critical',
        code: 'stock_negative_quantity',
        productId: 'product-1',
        warehouseId: 'warehouse-1',
        message: 'Stock quantity is negative',
        details: { quantity: -1 },
      },
      {
        severity: 'warning',
        code: 'stock_cost_layer_quantity_mismatch',
        productId: 'product-2',
        warehouseId: 'warehouse-1',
        message: 'Stock quantity does not match remaining cost-layer quantity',
        details: { delta: 2 },
      },
    ],
    summary: {
      total: 2,
      info: 0,
      warning: 1,
      critical: 1,
    },
  }
}

function accountingReport(): AccountingInvariantReport {
  return {
    checkedAt: '2026-01-01T00:00:02.000Z',
    findings: [
      {
        severity: 'critical',
        code: 'accounting_sync_failed_without_error',
        syncLogId: 'sync-1',
        message: 'Accounting sync failed without a visible error message',
        details: { retryCount: 1 },
      },
    ],
    summary: {
      total: 1,
      info: 0,
      warning: 0,
      critical: 1,
    },
  }
}

test('cron invariant check rejects requests without the cron secret', async () => {
  await withCronEnv({ CRON_SECRET: 'secret-token', NODE_ENV: 'production' }, async () => {
    const response = await GET(cronRequest())

    assert.equal(response.status, 401)
  })
})

test('invariant check is registered as a scheduled system cron job', () => {
  const job = getAllCronJobs().find((entry) => entry.slug === 'invariant-check')

  assert.ok(job)
  assert.equal(job.settingKey, 'invariant_check')
  assert.equal(job.module, 'system')
  assert.equal(job.defaultSchedule, '0 4 * * *')
  assert.equal(job.defaultEnabled, true)
})

test('scheduled invariant check logs counts and notifies only for critical findings', async () => {
  const activityLogs: Array<Record<string, unknown>> = []
  const notifications: Array<Record<string, unknown>> = []
  let storedCriticalHash: string | null = null

  const result = await runScheduledInvariantCheck({
    createRunId: () => 'run-1',
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    runInventoryReport: async () => inventoryReport(),
    runAccountingReport: async () => accountingReport(),
    writeActivityLog: async (entry) => {
      activityLogs.push(entry as unknown as Record<string, unknown>)
    },
    notifyAdmins: async (notification) => {
      notifications.push(notification)
    },
    getPreviousCriticalFindingsHash: async () => storedCriticalHash,
    setCriticalFindingsHash: async (hash) => {
      storedCriticalHash = hash
    },
  })

  assert.equal(result.runId, 'run-1')
  assert.equal(result.status, 'completed')
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.summary.total, {
    total: 3,
    info: 0,
    warning: 1,
    critical: 2,
  })
  assert.equal(result.criticalFindings.length, 2)
  assert.deepEqual(
    result.criticalFindings.map((finding) => `${finding.domain}:${finding.code}`),
    [
      'inventory:stock_negative_quantity',
      'accounting:accounting_sync_failed_without_error',
    ],
  )

  assert.equal(activityLogs.length, 1)
  assert.equal(activityLogs[0]?.entityId, 'run-1')
  assert.equal(activityLogs[0]?.level, 'ERROR')
  assert.equal(activityLogs[0]?.action, 'invariant_check')
  assert.deepEqual(
    (activityLogs[0]?.metadata as { counts: unknown }).counts,
    result.summary,
  )

  assert.equal(notifications.length, 1)
  assert.equal(notifications[0]?.type, 'error')
  assert.match(String(notifications[0]?.message), /2 critical finding/)
  assert.equal(typeof storedCriticalHash, 'string')

  const repeatedResult = await runScheduledInvariantCheck({
    createRunId: () => 'run-2',
    runInventoryReport: async () => inventoryReport(),
    runAccountingReport: async () => accountingReport(),
    writeActivityLog: async (entry) => {
      activityLogs.push(entry as unknown as Record<string, unknown>)
    },
    notifyAdmins: async (notification) => {
      notifications.push(notification)
    },
    getPreviousCriticalFindingsHash: async () => storedCriticalHash,
    setCriticalFindingsHash: async (hash) => {
      storedCriticalHash = hash
    },
  })

  assert.equal(repeatedResult.status, 'completed')
  assert.equal(notifications.length, 1)
})

test('scheduled invariant check does not notify when there are no critical findings', async () => {
  const activityLogs: Array<Record<string, unknown>> = []
  const notifications: Array<Record<string, unknown>> = []
  let storedCriticalHash: string | null = 'previous-critical-hash'

  const result = await runScheduledInvariantCheck({
    createRunId: () => 'run-clean',
    runInventoryReport: async () => ({
      checkedAt: '2026-01-01T00:00:01.000Z',
      findings: [],
      summary: { total: 0, info: 0, warning: 0, critical: 0 },
    }),
    runAccountingReport: async () => ({
      checkedAt: '2026-01-01T00:00:02.000Z',
      findings: [],
      summary: { total: 0, info: 0, warning: 0, critical: 0 },
    }),
    writeActivityLog: async (entry) => {
      activityLogs.push(entry as unknown as Record<string, unknown>)
    },
    notifyAdmins: async (notification) => {
      notifications.push(notification)
    },
    getPreviousCriticalFindingsHash: async () => storedCriticalHash,
    setCriticalFindingsHash: async (hash) => {
      storedCriticalHash = hash
    },
  })

  assert.equal(result.status, 'completed')
  assert.equal(result.summary.total.critical, 0)
  assert.equal(activityLogs.length, 0)
  assert.equal(notifications.length, 0)
  assert.equal(storedCriticalHash, null)
})

test('scheduled invariant check logs partial report failures without discarding successful results', async () => {
  const activityLogs: Array<Record<string, unknown>> = []
  const notifications: Array<Record<string, unknown>> = []
  let storedCriticalHash: string | null = null

  const result = await runScheduledInvariantCheck({
    createRunId: () => 'run-partial',
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    runInventoryReport: async () => {
      throw new Error('inventory query failed')
    },
    runAccountingReport: async () => accountingReport(),
    writeActivityLog: async (entry) => {
      activityLogs.push(entry as unknown as Record<string, unknown>)
    },
    notifyAdmins: async (notification) => {
      notifications.push(notification)
    },
    getPreviousCriticalFindingsHash: async () => storedCriticalHash,
    setCriticalFindingsHash: async (hash) => {
      storedCriticalHash = hash
    },
  })

  assert.equal(result.status, 'partial_failure')
  assert.equal(result.reports.inventory, null)
  assert.equal(result.reports.accounting?.summary.critical, 1)
  assert.deepEqual(result.errors, [
    { domain: 'inventory', message: 'inventory query failed' },
  ])

  assert.equal(activityLogs.length, 1)
  assert.equal(activityLogs[0]?.level, 'ERROR')
  assert.equal(
    ((activityLogs[0]?.metadata as { errors: Array<{ message: string }> }).errors[0]?.message),
    'inventory query failed',
  )
  assert.equal(notifications.length, 1)
})
