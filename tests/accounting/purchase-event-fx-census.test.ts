import assert from 'node:assert/strict'
import test from 'node:test'

import { TRANSIT_SUBLEDGER_SOURCE_TYPES } from '@/lib/domain/accounting/transit-subledger-movement'
import { TRANSIT_SOURCE_TYPES } from '@/lib/reconciliation-pack/ims-readers'
import { GRIR_BALANCE_SOURCE_TYPES, GRIR_SOURCE_TYPES, GRIR_VARIANCE_SOURCE_TYPES } from '@/lib/domain/accounting/grir-subledger-movement'
import { GRIR_REPORT_BALANCE_SOURCE_TYPES, GRIR_REPORT_VARIANCE_SOURCE_TYPES, getGrirReport } from '@/lib/domain/finance/finance-period-analytics'

/**
 * o3d-hqvrp.51 (per-event FX rates for purchasing, step 1): the two sub-ledgers gained a source type each (transit PURCHASE_FX_VARIANCE, GR/IR
 * BILL_FX_VARIANCE) before anything writes them, so every exhaustive reader knows them first. These censuses hold each reader's literal list equal to the
 * writer's, so the next new source type cannot reach a reader that would misread it.
 */

const sorted = (values: readonly string[]) => [...values].sort()

test('census: the reconciliation pack\'s transit source types are exactly the ones the transit sub-ledger records (R11 reads nothing else)', () => {
  assert.deepEqual(sorted(TRANSIT_SOURCE_TYPES.map((entry) => entry.type)), sorted(TRANSIT_SUBLEDGER_SOURCE_TYPES))
  assert.ok(TRANSIT_SUBLEDGER_SOURCE_TYPES.includes('PURCHASE_FX_VARIANCE'))
  assert.ok(TRANSIT_SUBLEDGER_SOURCE_TYPES.includes('GRIR_RECLASS'))
  assert.equal(new Set(TRANSIT_SUBLEDGER_SOURCE_TYPES).size, TRANSIT_SUBLEDGER_SOURCE_TYPES.length)
})

test('census: the GR/IR report sums exactly the balance source types and shows exactly the variance source types beside the balance', () => {
  assert.deepEqual(sorted(GRIR_REPORT_BALANCE_SOURCE_TYPES), sorted(GRIR_BALANCE_SOURCE_TYPES))
  assert.deepEqual(sorted(GRIR_REPORT_VARIANCE_SOURCE_TYPES), sorted(GRIR_VARIANCE_SOURCE_TYPES))
  assert.deepEqual(sorted([...GRIR_REPORT_BALANCE_SOURCE_TYPES, ...GRIR_REPORT_VARIANCE_SOURCE_TYPES]), sorted(GRIR_SOURCE_TYPES))
  assert.ok(GRIR_VARIANCE_SOURCE_TYPES.includes('BILL_FX_VARIANCE'))
})

type Group = { poId: string; poLineId: string | null; sourceType: string; _sum: { baseDelta: string; qtyDelta: string | null }; _min: { occurredAt: Date } }
const group = (sourceType: string, baseDelta: string, qtyDelta: string | null = null, poLineId: string | null = 'l1'): Group => ({
  poId: 'po1', poLineId, sourceType, _sum: { baseDelta, qtyDelta }, _min: { occurredAt: new Date('2026-11-01T10:00:00Z') },
})
const reportOver = (groups: Group[]) => getGrirReport({ pageSize: 500 }, {
  deps: {
    baseCurrency: async () => 'GBP',
    now: () => new Date('2026-11-22T12:00:00Z'),
    client: {
      grirSubledgerMovement: { groupBy: async () => groups, findMany: async () => [] },
      purchaseOrder: { findMany: async () => [{ id: 'po1', reference: 'PO-1', status: 'RECEIVED', supplierId: 's1', supplier: { name: 'Supplier' } }] },
    } as never,
  },
})

// [mutation: BILL_FX_VARIANCE summed into the balance, or an unknown source type summed instead of refused]
test('GR/IR report: the FX difference is shown beside the balance and never in it; an unknown source type is refused, not summed', async () => {
  const report = await reportOver([group('RECEIPT', '100', '10'), group('BILL', '-100', '-10'), group('BILL_PRICE_VARIANCE', '2', null), group('BILL_FX_VARIANCE', '3.5', null)])
  assert.equal(report.rows.length, 0, 'received and billed in full: no open balance, whatever the variances')
  const open = await reportOver([group('RECEIPT', '100', '10'), group('BILL_FX_VARIANCE', '3.5', null)])
  assert.equal(open.rows.length, 1)
  assert.equal(open.rows[0]!.netBase, '100.00')
  assert.equal(open.rows[0]!.fxVarianceBase, '3.50')
  assert.equal(open.rows[0]!.priceVarianceBase, '0.00')
  assert.equal(open.totals.fxVarianceBase, '3.50')
  await assert.rejects(reportOver([group('RECEIPT', '100', '10'), group('SOMETHING_NEW', '5', null)]), /SOMETHING_NEW/)
})
