import assert from 'node:assert/strict'
import test from 'node:test'

import { runInvariantCheckPreflight } from '@/lib/cron/invariant-check-preflight'
import type { ScheduledInvariantCheckResult } from '@/lib/cron/invariant-check'

function emptySummary() {
  return {
    total: 0,
    info: 0,
    warning: 0,
    critical: 0,
  }
}

function scheduledResult(
  overrides: Partial<ScheduledInvariantCheckResult> = {},
): ScheduledInvariantCheckResult {
  const summary = {
    total: emptySummary(),
    inventory: emptySummary(),
    accounting: emptySummary(),
    sales: emptySummary(),
    ...overrides.summary,
  }

  return {
    runId: 'preflight-test',
    checkedAt: '2026-06-10T00:00:00.000Z',
    status: 'completed',
    summary,
    errors: [],
    criticalFindings: [],
    reports: {
      inventory: null,
      accounting: null,
      sales: null,
    },
    ...overrides,
  }
}

test('invariant preflight passes completed reports without critical findings', async () => {
  const result = await runInvariantCheckPreflight(async () => scheduledResult({
    summary: {
      total: { total: 2, info: 1, warning: 1, critical: 0 },
      inventory: { total: 1, info: 0, warning: 1, critical: 0 },
      accounting: emptySummary(),
      sales: { total: 1, info: 1, warning: 0, critical: 0 },
    },
  }))

  assert.equal(result.ok, true)
  assert.equal(result.failure, null)
  assert.equal(result.result.summary.total.warning, 1)
})

test('invariant preflight fails when critical findings are present', async () => {
  const result = await runInvariantCheckPreflight(async () => scheduledResult({
    summary: {
      total: { total: 1, info: 0, warning: 0, critical: 1 },
      inventory: { total: 1, info: 0, warning: 0, critical: 1 },
      accounting: emptySummary(),
      sales: emptySummary(),
    },
    criticalFindings: [{
      domain: 'inventory',
      code: 'stock_negative_quantity',
      message: 'Stock quantity is negative',
      details: { quantity: '-1' },
      productId: 'product-1',
      warehouseId: 'warehouse-1',
    }],
  }))

  assert.equal(result.ok, false)
  assert.equal(result.failure, 'critical_findings')
  assert.equal(result.result.criticalFindings[0]?.code, 'stock_negative_quantity')
})

test('invariant preflight also fails when critical summary and finding list diverge', async () => {
  const result = await runInvariantCheckPreflight(async () => scheduledResult({
    summary: {
      total: { total: 1, info: 0, warning: 1, critical: 0 },
      inventory: { total: 1, info: 0, warning: 1, critical: 0 },
      accounting: emptySummary(),
      sales: emptySummary(),
    },
    criticalFindings: [{
      domain: 'accounting',
      code: 'accounting_sync_failed_without_error',
      message: 'Accounting sync failed without a visible error',
      details: { syncLogId: 'sync-1' },
      syncLogId: 'sync-1',
    }],
  }))

  assert.equal(result.ok, false)
  assert.equal(result.failure, 'critical_findings')
})

test('invariant preflight fails when any report fails', async () => {
  const result = await runInvariantCheckPreflight(async () => scheduledResult({
    status: 'partial_failure',
    errors: [{ domain: 'sales', message: 'refund reconciliation failed' }],
  }))

  assert.equal(result.ok, false)
  assert.equal(result.failure, 'report_failed')
  assert.deepEqual(result.result.errors, [
    { domain: 'sales', message: 'refund reconciliation failed' },
  ])
})
