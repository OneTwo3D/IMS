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
  const row: RefundStatusOrderRow = {
    id: 'order-1',
    orderNumber: 'SO-1',
    externalOrderNumber: null,
    status: 'SHIPPED',
    refundStatus: 'NONE',
    totalBase: '100.00',
    refunds: [],
    ...overrides,
  }
  // Default refunds to NET basis (the post-o3d-n8p norm); a test marks a legacy refund with
  // totalsBasis: null explicitly to exercise the mixed-basis fallback.
  row.refunds = row.refunds.map((refund) => ({ totalsBasis: 'NET' as const, ...refund }))
  return row
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
      taxBase: true,
      refunds: {
        orderBy: { refundedAt: 'asc' },
        select: {
          id: true,
          creditNoteNumber: true,
          totalBase: true,
          refundedAt: true,
          totalsBasis: true,
        },
      },
    },
  }])
})

test('a fully-refunded taxable order with only NET refunds is FULL; a legacy GROSS refund falls back to the gross basis (o3d-w00 #3 / o3d-n8p)', () => {
  // NET-basis: gross 120, tax 20, net 100; a net-100 refund is a FULL refund vs the net total.
  const netFindings = evaluateRefundStatusReconciliationRows({
    sourceRowLimitReached: false,
    salesOrders: [
      order({
        id: 'order-net', orderNumber: 'SO-NET', refundStatus: 'FULL', totalBase: '120.00', taxBase: '20.00',
        refunds: [{ id: 'r-net', creditNoteNumber: 'CN-NET', totalBase: '100.00', refundedAt: REFUNDED_AT, totalsBasis: 'NET' }],
      }),
    ],
  })
  assert.deepEqual(netFindings, [], 'a full net refund of a taxable order reconciles as FULL')

  // Legacy refund (null basis) with a plausible status (FULL/PARTIAL): the sum mixes units so FULL vs
  // PARTIAL is unknowable — surface an explicit UNKNOWN warning for manual review, NOT a false mismatch.
  const legacyFindings = evaluateRefundStatusReconciliationRows({
    sourceRowLimitReached: false,
    salesOrders: [
      order({
        id: 'order-legacy', orderNumber: 'SO-LEGACY', refundStatus: 'FULL', totalBase: '120.00', taxBase: '20.00',
        refunds: [{ id: 'r-legacy', creditNoteNumber: 'CN-LEGACY', totalBase: '100.00', refundedAt: REFUNDED_AT, totalsBasis: null }],
      }),
    ],
  })
  assert.equal(legacyFindings.length, 1)
  assert.equal(legacyFindings[0]?.code, 'sales_order_refund_status_unknown_basis')
  assert.equal(legacyFindings[0]?.severity, 'warning')

  // Basis-INDEPENDENT corruption: a positive refund with refundStatus=NONE is wrong regardless of basis —
  // still flagged critical even on an unknown basis (must not be suppressed by the UNKNOWN skip).
  const noneFindings = evaluateRefundStatusReconciliationRows({
    sourceRowLimitReached: false,
    salesOrders: [
      order({
        id: 'order-none', orderNumber: 'SO-NONE', refundStatus: 'NONE', totalBase: '120.00', taxBase: '20.00',
        refunds: [{ id: 'r-none', creditNoteNumber: 'CN-NONE', totalBase: '50.00', refundedAt: REFUNDED_AT, totalsBasis: null }],
      }),
    ],
  })
  assert.equal(noneFindings.length, 1)
  assert.equal(noneFindings[0]?.code, 'sales_order_refund_status_mismatch')
  assert.equal(noneFindings[0]?.severity, 'critical')
})
