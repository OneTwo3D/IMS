import assert from 'node:assert/strict'
import test from 'node:test'

import { GET } from '@/app/api/cron/invariant-check/route'
import { getAllCronJobs } from '@/lib/cron-jobs'
import {
  commitWarningBaselineInTx,
  countNotifiableWarnings,
  NOTIFIABLE_WARNING_CODES,
  notifiableWarningIncreases,
  runScheduledInvariantCheck,
} from '@/lib/cron/invariant-check'
import type { AccountingInvariantReport } from '@/lib/domain/accounting/invariants'
import type { InventoryInvariantReport } from '@/lib/domain/inventory/invariants'
import type { RefundStatusReconciliationReport } from '@/lib/domain/sales/refund-status-reconciliation'

type CronEnv = {
  CRON_SECRET?: string
  INVARIANT_CHECK_STOCK_MOVEMENT_LOOKBACK_DAYS?: string
  NODE_ENV?: string
}

const ENV_KEYS = ['CRON_SECRET', 'INVARIANT_CHECK_STOCK_MOVEMENT_LOOKBACK_DAYS', 'NODE_ENV'] as const

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

type FakeNotification = { userId: string | null; type: string; title: string; message: string }

/**
 * An in-memory stand-in for the transaction client with REAL rollback semantics: if the callback throws, every
 * setting and notification written inside it is undone, as PostgreSQL would.
 */
function warningStore(initial: Record<string, number> = {}, initialCheckedAt = '2000-01-01T00:00:00.000Z') {
  let settings = new Map<string, string>()
  if (Object.keys(initial).length > 0) {
    settings.set('cron_invariant_check_notifiable_warning_counts', JSON.stringify({ counts: initial, checkedAt: initialCheckedAt }))
  }
  let notifications: FakeNotification[] = []
  const control = { failNotification: false }
  const tx = {
    $executeRaw: async () => 1,
    setting: {
      findUnique: async ({ where }: { where: { key: string } }) => (settings.has(where.key) ? { value: settings.get(where.key)! } : null),
      upsert: async ({ where, create }: { where: { key: string }; create: { value: string } }) => { settings.set(where.key, create.value); return {} },
    },
    user: { findMany: async () => [{ id: 'admin-1' }, { id: 'admin-2' }] },
    notification: {
      create: async ({ data }: { data: FakeNotification }) => {
        if (control.failNotification) throw new Error('insert failed')
        notifications.push(data)
        return {}
      },
    },
  }
  return {
    commitWarningBaseline: async (input: { counts: Record<string, number>; checkedAt: string; runId: string }) => {
      const snapshot = new Map(settings)
      const kept = notifications.length
      try {
        return await commitWarningBaselineInTx(tx as never, input)
      } catch (error) {
        settings = snapshot
        notifications = notifications.slice(0, kept)
        throw error
      }
    },
    read: (): Record<string, number> => {
      const raw = settings.get('cron_invariant_check_notifiable_warning_counts')
      return raw ? (JSON.parse(raw) as { counts: Record<string, number> }).counts : {}
    },
    readCheckedAt: (): string | null => {
      const raw = settings.get('cron_invariant_check_notifiable_warning_counts')
      return raw ? (JSON.parse(raw) as { checkedAt: string }).checkedAt : null
    },
    notifications: () => notifications,
    control,
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

function cleanSalesReport(): RefundStatusReconciliationReport {
  return {
    checkedAt: '2026-01-01T00:00:03.000Z',
    findings: [],
    summary: {
      total: 0,
      info: 0,
      warning: 0,
      critical: 0,
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
    runSalesReport: async () => cleanSalesReport(),
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
    commitWarningBaseline: warningStore({ stock_cost_layer_quantity_mismatch: 1 }).commitWarningBaseline,
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
    runSalesReport: async () => cleanSalesReport(),
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
    commitWarningBaseline: warningStore({ stock_cost_layer_quantity_mismatch: 1 }).commitWarningBaseline,
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
    runSalesReport: async () => cleanSalesReport(),
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
    commitWarningBaseline: warningStore({ stock_cost_layer_quantity_mismatch: 1 }).commitWarningBaseline,
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
    runSalesReport: async () => ({
      checkedAt: '2026-01-01T00:00:03.000Z',
      findings: [{
        severity: 'critical',
        code: 'sales_order_refund_status_mismatch',
        orderId: 'order-1',
        refundId: 'refund-1',
        message: 'Sales order refund status is stale',
        details: { status: 'SHIPPED', expectedStatus: 'PARTIALLY_REFUNDED' },
      }],
      summary: { total: 1, info: 0, warning: 0, critical: 1 },
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
    commitWarningBaseline: warningStore({ stock_cost_layer_quantity_mismatch: 1 }).commitWarningBaseline,
  })

  assert.equal(result.status, 'partial_failure')
  assert.equal(result.reports.inventory, null)
  assert.equal(result.reports.accounting?.summary.critical, 1)
  assert.equal(result.reports.sales?.summary.critical, 1)
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

const emptyReport = (checkedAt: string) => ({
  checkedAt,
  findings: [],
  summary: { total: 0, info: 0, warning: 0, critical: 0 },
})

function warningFindings(code: string, n: number) {
  return Array.from({ length: n }, (_, i) => ({
    severity: 'warning' as const,
    code,
    productId: `p-${i}`,
    warehouseId: 'w-1',
    message: 'Stock quantity does not match remaining cost-layer quantity',
    details: {},
  }))
}

let clockMs = Date.parse('2026-01-01T00:00:00.000Z')
async function runWithWarnings(
  store: ReturnType<typeof warningStore>,
  inventoryFindings: Array<{ severity: 'warning' | 'info'; code: string; productId?: string; warehouseId?: string; message: string; details: unknown }>,
  startedAt: Date = new Date((clockMs += 60_000)),
) {
  return runScheduledInvariantCheck({
    createRunId: () => 'run-w',
    now: () => startedAt,
    runInventoryReport: async () => ({
      checkedAt: '2026-01-01T00:00:01.000Z',
      findings: inventoryFindings,
      summary: { total: inventoryFindings.length, info: 0, warning: inventoryFindings.length, critical: 0 },
    }),
    runAccountingReport: async () => emptyReport('2026-01-01T00:00:02.000Z'),
    runSalesReport: async () => cleanSalesReport(),
    writeActivityLog: async () => {},
    notifyAdmins: async () => { throw new Error('warnings must not go through notifyAdmins') },
    getPreviousCriticalFindingsHash: async () => null,
    setCriticalFindingsHash: async () => {},
    commitWarningBaseline: store.commitWarningBaseline,
  })
}

test('named warning codes notify when newly appearing or rising, and are quiet otherwise', async () => {
  const store = warningStore()
  const code = 'stock_cost_layer_quantity_mismatch'

  await runWithWarnings(store, warningFindings(code, 2))
  assert.equal(store.notifications().length, 2, 'newly appearing: one row per active admin')
  assert.equal(store.notifications()[0]?.type, 'warning')
  assert.match(String(store.notifications()[0]?.message), /stock_cost_layer_quantity_mismatch 0 -> 2/)

  await runWithWarnings(store, warningFindings(code, 2))
  assert.equal(store.notifications().length, 2, 'same count is deduplicated')

  await runWithWarnings(store, warningFindings(code, 1))
  assert.equal(store.notifications().length, 2, 'a falling count is not news')
  assert.deepEqual(store.read(), { [code]: 1 }, 'but it lowers the baseline')

  await runWithWarnings(store, warningFindings(code, 2))
  assert.equal(store.notifications().length, 4, 'rising again after a fall notifies again')

  await runWithWarnings(store, [])
  assert.deepEqual(store.read(), {}, 'cleared')
  await runWithWarnings(store, warningFindings(code, 2))
  assert.equal(store.notifications().length, 6, 'reappearing after a clear notifies')
})

test('a notification that cannot be stored leaves the baseline unchanged, so the next run tries again', async () => {
  const store = warningStore()
  const code = 'transfer_stranded_in_transit'
  store.control.failNotification = true
  await assert.rejects(runWithWarnings(store, warningFindings(code, 3)), /insert failed/)
  assert.deepEqual(store.read(), {}, 'baseline did not advance over an alert nobody received')
  assert.equal(store.notifications().length, 0)

  store.control.failNotification = false
  await runWithWarnings(store, warningFindings(code, 3))
  assert.equal(store.notifications().length, 2, 'the retry notifies')
  assert.deepEqual(store.read(), { [code]: 3 })
})

test('an older run that finishes late stands down and cannot overwrite a newer baseline', async () => {
  const store = warningStore()
  const code = 'accounting_sync_failed'
  const older = new Date('2026-02-01T00:00:00.000Z')
  const newer = new Date('2026-02-01T00:10:00.000Z')
  await runWithWarnings(store, warningFindings(code, 5), newer)
  assert.equal(store.notifications().length, 2)
  await runWithWarnings(store, warningFindings(code, 1), older)
  assert.deepEqual(store.read(), { [code]: 5 }, 'the newer baseline stands')
  assert.equal(store.readCheckedAt(), newer.toISOString())
  assert.equal(store.notifications().length, 2, 'the older run notifies nobody')
})

test('with no active admin the alert is a broadcast, not nothing', async () => {
  const outcome = await (async () => {
    const settings = new Map<string, string>()
    const created: Array<{ userId: string | null }> = []
    const tx = {
      $executeRaw: async () => 1,
      setting: {
        findUnique: async () => null,
        upsert: async ({ where, create }: { where: { key: string }; create: { value: string } }) => { settings.set(where.key, create.value); return {} },
      },
      user: { findMany: async () => [] },
      notification: { create: async ({ data }: { data: { userId: string | null } }) => { created.push(data); return {} } },
    }
    await commitWarningBaselineInTx(tx as never, { counts: { accounting_sync_failed: 1 }, checkedAt: '2026-01-01T00:00:00.000Z', runId: 'r' })
    return created
  })()
  assert.equal(outcome.length, 1)
  assert.equal(outcome[0]?.userId, null)
})

test('warnings outside the named set never notify, and a failed report leaves the baseline alone', async () => {
  const store = warningStore({ transfer_stranded_in_transit: 3 })
  await runWithWarnings(store, warningFindings('stock_negative_reserved_quantity_unlisted', 5))
  assert.equal(store.notifications().length, 0)
  assert.deepEqual(store.read(), {})

  const baseline = warningStore({ transfer_stranded_in_transit: 3 })
  const result = await runScheduledInvariantCheck({
    createRunId: () => 'run-f',
    runInventoryReport: async () => { throw new Error('boom') },
    runAccountingReport: async () => emptyReport('2026-01-01T00:00:02.000Z'),
    runSalesReport: async () => cleanSalesReport(),
    writeActivityLog: async () => {},
    notifyAdmins: async () => {},
    getPreviousCriticalFindingsHash: async () => null,
    setCriticalFindingsHash: async () => {},
    commitWarningBaseline: baseline.commitWarningBaseline,
  })
  assert.equal(result.status, 'partial_failure')
  assert.equal(baseline.notifications().length, 0)
  assert.deepEqual(baseline.read(), { transfer_stranded_in_transit: 3 })
})

test('notifiable warning helpers count only named warning-severity findings', () => {
  assert.deepEqual(
    countNotifiableWarnings([
      { severity: 'warning', code: 'accounting_sync_failed' },
      { severity: 'warning', code: 'accounting_sync_failed' },
      { severity: 'critical', code: 'accounting_sync_failed' },
      { severity: 'warning', code: 'sales_order_stage_dates_out_of_order' },
    ]),
    { accounting_sync_failed: 2 },
  )
  assert.deepEqual(notifiableWarningIncreases({ a: 2 }, { a: 2, b: 1 }), [{ code: 'b', previous: 0, current: 1 }])
})

test('every named warning code exists as a warning in the domain it is read from', async () => {
  const { readFileSync } = await import('node:fs')
  const sources = [
    'lib/domain/inventory/invariants.ts',
    'lib/domain/accounting/invariants.ts',
  ].map((file) => readFileSync(file, 'utf8')).join('\n')
  for (const code of NOTIFIABLE_WARNING_CODES) {
    const at = sources.indexOf(`code: '${code}'`)
    assert.ok(at > 0, `${code} is emitted`)
    assert.match(sources.slice(Math.max(0, at - 160), at), /severity: 'warning'/, `${code} is a warning`)
  }
})

test('a truncated report does not move the baseline; admins hear about it once; the next complete run compares against the kept counts', async () => {
  const store = warningStore({ transfer_stranded_in_transit: 3 })
  const code = 'transfer_stranded_in_transit'
  const truncatedFinding = { severity: 'warning' as const, code: 'invariant_report_truncated', message: 'capped', details: {} }

  // The capped list happens to hold only 1 of the 3 stranded transfers, plus the truncation marker.
  await runWithWarnings(store, [...warningFindings(code, 1), truncatedFinding])
  assert.deepEqual(store.read(), { [code]: 3 }, 'counts kept: the 1 visible finding is a floor, not a count')
  assert.equal(store.notifications().length, 2, 'one truncation notice per admin')
  assert.equal(store.notifications()[0]?.title, 'Invariant report was truncated')

  await runWithWarnings(store, [...warningFindings(code, 9), truncatedFinding])
  assert.deepEqual(store.read(), { [code]: 3 }, 'a rise seen only through a capped list is not acted on either')
  assert.equal(store.notifications().length, 2, 'the truncation notice is deduplicated while it persists')

  await runWithWarnings(store, warningFindings(code, 3))
  assert.equal(store.notifications().length, 2, 'complete run, same count as the kept baseline: quiet')
  await runWithWarnings(store, warningFindings(code, 4))
  assert.equal(store.notifications().length, 4, 'a real rise after truncation ended notifies')
})

test('truncation markers are the ones the reports emit', async () => {
  const { readFileSync } = await import('node:fs')
  const { REPORT_TRUNCATION_CODES } = await import('@/lib/cron/invariant-check')
  const sources = ['lib/domain/inventory/invariants.ts', 'lib/domain/sales/refund-status-reconciliation.ts'].map((f) => readFileSync(f, 'utf8')).join('\n')
  for (const code of REPORT_TRUNCATION_CODES) assert.ok(sources.includes(`'${code}'`), `${code} is emitted`)
})
