import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { Prisma } from '../../../app/generated/prisma/client.ts'
import { xeroTrialBalanceRef } from '../../../lib/connectors/xero/account-balance-refs.ts'

/**
 * The inventory valuation report asks the ledger for the balance AS OF a London day. getOnHandAsOf reports a date-only as-of as the last millisecond of
 * that London day (2026-07-01T22:59:59.999Z in BST), and the report used to hand that timestamp to the balance lookup, which accepts only YYYY-MM-DD and threw,
 * so an unfiltered report failed whenever an accounting connector and an inventory account were configured. It now passes the London day label.
 */

type Snap = { balanceDate: Date; amountBase: Prisma.Decimal; sourcePayloadRef: string; parserVersion: number; currency: string }
let AS_OF = '2026-07-01T22:59:59.999Z'
let STORED: Snap | null = null
const SNAPSHOT_QUERIES: unknown[] = []

mock.module('@/lib/db', {
  namedExports: {
    db: {
      product: { findMany: async () => [{ id: 'p1', sku: 'SKU-1', name: 'Widget', stockUnit: 'ea', category: null, supplierProducts: [] }] },
      warehouse: { findMany: async () => [{ id: 'w1', code: 'MAIN', name: 'Main' }] },
      accountingAccount: { findMany: async () => [{ externalAccountId: 'acc-630', type: 'INVENTORY' }] },
      accountingToken: { findUnique: async () => ({ tenantId: 'tenant-1' }) },
      accountingAccountBalanceSnapshot: {
        findFirst: async (args: unknown) => {
          SNAPSHOT_QUERIES.push(args)
          const lte = (args as { where: { balanceDate: { lte: Date } } }).where.balanceDate.lte
          return STORED && STORED.balanceDate <= lte ? STORED : null
        },
      },
    },
  },
})
mock.module('@/lib/accounting', {
  namedExports: {
    getActiveAccountingConnectorInfo: async () => ({ id: 'xero' }),
    getAccountingSettingsFor: async () => ({ inventoryAccount: '630', allocatedInventoryAccount: '', cogsAccount: '500' }),
    syncAccountingAccountBalanceSnapshots: async () => ({}),
  },
})
mock.module('@/lib/base-currency', { namedExports: { getBaseCurrencyCode: async () => 'GBP' } })
mock.module('@/lib/domain/inventory/get-on-hand-as-of', {
  namedExports: {
    getOnHandAsOf: async () => ({
      asOf: AS_OF,
      generatedAt: '2026-11-19T10:00:00.000Z',
      source: 'snapshot',
      anchorDate: '2026-06-30',
      valueReplayReliable: true,
      missingValueMovementCount: 0,
      orphanWarehouseMovementCount: 0,
      currentValueDriftCount: 0,
      postAsOfRevaluationCount: 0,
      staleSnapshotCount: 0,
      rows: [{ productId: 'p1', warehouseId: 'w1', qty: '10', unitCostBase: '1', valueBase: '10' }],
    }),
  },
})

const stored = (day: string, amount: number): Snap => ({
  balanceDate: new Date(`${day}T00:00:00.000Z`),
  amountBase: new Prisma.Decimal(amount),
  sourcePayloadRef: xeroTrialBalanceRef(day, 'reported'),
  parserVersion: 2,
  currency: 'GBP',
})

test('valuation report with a connector and an inventory account does not throw, and compares the GL balance by London day label (BST)', async () => {
  const { getInventoryValuationReport } = await import('../../../lib/domain/inventory/inventory-costing-reports.ts')
  AS_OF = '2026-07-01T22:59:59.999Z'
  STORED = stored('2026-07-01', 12)
  SNAPSHOT_QUERIES.length = 0
  const report = await getInventoryValuationReport({ asOf: '2026-07-01' }, { paginate: false })
  assert.equal(report.asOf, '2026-07-01T22:59:59.999Z')
  assert.equal(report.totals.glBalanceBase, '12.000000')
  assert.equal(Number(report.totals.glVarianceBase), -2, 'valuation 10 less GL 12')
  assert.deepEqual(report.notices, [])
  const lte = (SNAPSHOT_QUERIES[0] as { where: { balanceDate: { lte: Date } } }).where.balanceDate.lte
  assert.equal(lte.toISOString(), '2026-07-01T00:00:00.000Z', 'looked up by the date label, not the instant')
})

test('a GL balance dated the previous day is not presented as the variance for the as-of day', async () => {
  const { getInventoryValuationReport } = await import('../../../lib/domain/inventory/inventory-costing-reports.ts')
  AS_OF = '2026-07-01T22:59:59.999Z'
  STORED = stored('2026-06-30', 12)
  const report = await getInventoryValuationReport({ asOf: '2026-07-01' }, { paginate: false })
  assert.equal(report.totals.glVarianceBase, null)
  assert.match(report.notices.join('\n'), /dated 2026-06-30, not 2026-07-01/)
})

test('GMT control: the label is the same day (23:59:59.999Z)', async () => {
  const { getInventoryValuationReport } = await import('../../../lib/domain/inventory/inventory-costing-reports.ts')
  AS_OF = '2026-01-10T23:59:59.999Z'
  STORED = stored('2026-01-10', 10)
  const report = await getInventoryValuationReport({ asOf: '2026-01-10' }, { paginate: false })
  assert.equal(Number(report.totals.glVarianceBase ?? 'x'), 0)
  assert.equal(report.totals.glBalanceBase, '10.000000')
})
