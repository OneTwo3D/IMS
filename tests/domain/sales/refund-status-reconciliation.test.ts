import assert from 'node:assert/strict'
import test from 'node:test'

import {
  collectRefundStatusReconciliationRows,
  evaluateRefundStatusReconciliationRows,
  type RefundStatusOrderRow,
  type RefundStatusReconciliationClient,
} from '@/lib/domain/sales/refund-status-reconciliation'

const REFUNDED_AT = new Date('2026-01-01T12:00:00.000Z')

function order(overrides: Partial<RefundStatusOrderRow> = {}): RefundStatusOrderRow {
  return {
    id: 'order-1',
    orderNumber: 'SO-1',
    externalOrderNumber: null,
    status: 'SHIPPED',
    refundStatus: 'NONE',
    totalBase: '100.00',
    refunds: [],
    ...overrides,
  }
}

test('clean refund disposition rows produce no findings', () => {
  const findings = evaluateRefundStatusReconciliationRows({
    sourceRowLimitReached: false,
    salesOrders: [
      order({
        refundStatus: 'PARTIAL',
        refunds: [{ id: 'refund-1', creditNoteNumber: 'CN-1', totalBase: '25.00', refundedAt: REFUNDED_AT }],
      }),
      order({
        id: 'order-2',
        orderNumber: 'SO-2',
        refundStatus: 'FULL',
        refunds: [{ id: 'refund-2', creditNoteNumber: 'CN-2', totalBase: '99.90', refundedAt: REFUNDED_AT }],
      }),
    ],
  })

  assert.deepEqual(findings, [])
})

test('refund disposition reconciliation pins full-refund threshold and zero-total behavior', () => {
  const findings = evaluateRefundStatusReconciliationRows({
    sourceRowLimitReached: false,
    salesOrders: [
      order({
        id: 'order-threshold',
        orderNumber: 'SO-THRESHOLD',
        refundStatus: 'FULL',
        totalBase: '100.00',
        refunds: [{ id: 'refund-threshold', creditNoteNumber: 'CN-THRESHOLD', totalBase: '99.90', refundedAt: REFUNDED_AT }],
      }),
      order({
        id: 'order-zero-total',
        orderNumber: 'SO-ZERO',
        refundStatus: 'FULL',
        totalBase: '0.00',
        refunds: [{ id: 'refund-zero', creditNoteNumber: 'CN-ZERO', totalBase: '0.00', refundedAt: REFUNDED_AT }],
      }),
    ],
  })

  assert.deepEqual(findings, [])
})

test('refund disposition reconciliation applies negative correction totals to the effective refund sum', () => {
  const findings = evaluateRefundStatusReconciliationRows({
    sourceRowLimitReached: false,
    salesOrders: [
      order({
        id: 'order-corrected',
        orderNumber: 'SO-CORRECTED',
        refundStatus: 'FULL',
        totalBase: '100.00',
        refunds: [
          { id: 'refund-full', creditNoteNumber: 'CN-FULL', totalBase: '100.00', refundedAt: REFUNDED_AT },
          { id: 'refund-correction', creditNoteNumber: 'CN-CORRECTION', totalBase: '-10.00', refundedAt: REFUNDED_AT },
        ],
      }),
    ],
  })

  assert.equal(findings.length, 1)
  assert.equal(findings[0]?.code, 'sales_order_refund_status_mismatch')
  assert.equal((findings[0]?.details as { expectedDisposition: string }).expectedDisposition, 'PARTIAL')
  assert.equal((findings[0]?.details as { refundedTotalBase: string }).refundedTotalBase, '90')
})

test('refund disposition reconciliation flags stale and unsupported dispositions', () => {
  const findings = evaluateRefundStatusReconciliationRows({
    sourceRowLimitReached: false,
    salesOrders: [
      // Has a refund (implies PARTIAL) but refundStatus is still NONE → mismatch.
      order({
        id: 'order-refund-row-status-open',
        orderNumber: 'SO-OPEN',
        refundStatus: 'NONE',
        refunds: [{ id: 'refund-open', creditNoteNumber: 'CN-OPEN', totalBase: '10.00', refundedAt: REFUNDED_AT }],
      }),
      // Fully refunded by records but marked PARTIAL → mismatch.
      order({
        id: 'order-full-status-partial',
        orderNumber: 'SO-FULL',
        refundStatus: 'PARTIAL',
        refunds: [{ id: 'refund-full', creditNoteNumber: 'CN-FULL', totalBase: '100.00', refundedAt: REFUNDED_AT }],
      }),
      // Marked FULL but no refund rows → without_refunds.
      order({
        id: 'order-refunded-without-rows',
        orderNumber: 'SO-NO-REFUNDS',
        refundStatus: 'FULL',
      }),
    ],
  })

  assert.deepEqual(findings.map((finding) => finding.code), [
    'sales_order_refund_status_mismatch',
    'sales_order_refund_status_mismatch',
    'sales_order_refund_status_without_refunds',
  ])
  assert.deepEqual(findings.map((finding) => finding.orderId), [
    'order-refund-row-status-open',
    'order-full-status-partial',
    'order-refunded-without-rows',
  ])
  assert.deepEqual(findings.map((finding) => finding.severity), ['critical', 'critical', 'critical'])
  assert.deepEqual(
    findings.slice(0, 2).map((finding) => (finding.details as { expectedDisposition: string }).expectedDisposition),
    ['PARTIAL', 'FULL'],
  )
})

test('refund disposition reconciliation reports source row cap and caps collected rows', async () => {
  const requestedArgs: unknown[] = []
  const client: RefundStatusReconciliationClient = {
    salesOrder: {
      findMany: async (args: unknown) => {
        requestedArgs.push(args)
        return [
          order({ id: 'order-1' }),
          order({ id: 'order-2' }),
          order({ id: 'order-3' }),
        ]
      },
    },
  }

  const rows = await collectRefundStatusReconciliationRows(client, { sourceRowLimit: 2 })
  const findings = evaluateRefundStatusReconciliationRows(rows)

  assert.equal(rows.salesOrders.length, 2)
  assert.equal(rows.sourceRowLimitReached, true)
  assert.equal(findings[0]?.code, 'refund_status_reconciliation_row_cap_reached')
  assert.deepEqual(requestedArgs, [{
    where: {
      OR: [
        { refundStatus: { not: 'NONE' } },
        { refunds: { some: {} } },
      ],
    },
    orderBy: { id: 'asc' },
    take: 3,
    select: {
      id: true,
      orderNumber: true,
      externalOrderNumber: true,
      status: true,
      refundStatus: true,
      totalBase: true,
      refunds: {
        orderBy: { refundedAt: 'asc' },
        select: {
          id: true,
          creditNoteNumber: true,
          totalBase: true,
          refundedAt: true,
        },
      },
    },
  }])
})
