import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Prisma } from '@/app/generated/prisma/client'
import {
  getReturnsByReasonReport,
  RETURN_REASON_UNSPECIFIED,
  type SalesFulfillmentAnalyticsClient,
} from '@/lib/domain/sales/sales-fulfillment-analytics'

/** Returns by configured return reason: counts and values per ReturnReason, a refund counted once however many lines it has. */

type Line = {
  refundId: string
  qty: string
  totalBase: string
  totalsBasis: string | null
  reason: { id: string; name: string } | null
}

function lineRow(spec: Line) {
  return {
    refundId: spec.refundId,
    qty: new Prisma.Decimal(spec.qty),
    totalBase: new Prisma.Decimal(spec.totalBase),
    refund: { totalsBasis: spec.totalsBasis, returnReasonId: spec.reason?.id ?? null, returnReason: spec.reason ? { name: spec.reason.name } : null },
  }
}

async function report(lines: Line[]) {
  let sawSelect: unknown = null
  const unused = { findMany: async () => [] }
  const client = {
    product: unused, salesOrder: unused, salesOrderRefund: unused, cogsEntry: unused, stockMovement: unused, shipment: unused, activityLog: unused,
    salesOrderRefundLine: { findMany: async (args: unknown) => { sawSelect = args; return lines.map(lineRow) } },
  } as unknown as SalesFulfillmentAnalyticsClient
  const result = await getReturnsByReasonReport({ dateFrom: '2026-06-01', dateTo: '2026-06-01' }, { client, now: () => new Date('2026-06-01T15:00:00.000Z') })
  return { result, sawSelect }
}

const DAMAGED = { id: 'rr-damaged', name: 'Damaged' }
const CHANGED = { id: 'rr-changed', name: 'Changed mind' }

test('counts and values are totalled per reason; a refund with two lines counts once', async () => {
  const { result } = await report([
    { refundId: 'r1', qty: '1', totalBase: '40', totalsBasis: 'NET', reason: DAMAGED },
    { refundId: 'r1', qty: '2', totalBase: '60', totalsBasis: 'NET', reason: DAMAGED },
    { refundId: 'r2', qty: '1', totalBase: '25', totalsBasis: 'NET', reason: DAMAGED },
    { refundId: 'r3', qty: '1', totalBase: '10', totalsBasis: 'NET', reason: CHANGED },
  ])
  assert.deepEqual(result.rows.map((r) => [r.reason, r.refundCount, r.returnedQty, r.refundValueBase]), [
    ['Damaged', 2, '4', '125'],
    ['Changed mind', 1, '1', '10'],
  ])
})

test('refunds with no reason are grouped as Unspecified, not dropped', async () => {
  const { result } = await report([
    { refundId: 'r1', qty: '1', totalBase: '40', totalsBasis: 'NET', reason: null },
    { refundId: 'r2', qty: '1', totalBase: '5', totalsBasis: 'NET', reason: DAMAGED },
  ])
  const unspecified = result.rows.find((r) => r.reasonId === null)
  assert.equal(unspecified?.reason, RETURN_REASON_UNSPECIFIED)
  assert.equal(unspecified?.refundCount, 1)
  assert.equal(unspecified?.refundValueBase, '40')
})

test('a reason whose credits are on mixed bases states no single value but keeps the buckets', async () => {
  const { result } = await report([
    { refundId: 'r1', qty: '1', totalBase: '100', totalsBasis: 'NET', reason: DAMAGED },
    { refundId: 'r2', qty: '1', totalBase: '120', totalsBasis: 'GROSS', reason: DAMAGED },
  ])
  assert.equal(result.rows[0]!.refundValueBase, null)
  assert.equal(result.rows[0]!.refundValueNetBasis, '100')
  assert.equal(result.rows[0]!.refundValueGrossBasis, '120')
})

test('the structured reason is what is read, not the free-text refund reason', async () => {
  const { sawSelect } = await report([])
  const select = (sawSelect as { select: { refund: { select: Record<string, unknown> } } }).select.refund.select
  assert.ok('returnReasonId' in select && 'returnReason' in select)
  assert.ok(!('reason' in select))
})

test('no refunds in the period gives no rows', async () => {
  const { result } = await report([])
  assert.deepEqual(result.rows, [])
})
