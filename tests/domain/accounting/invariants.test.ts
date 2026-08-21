import assert from 'node:assert/strict'
import test from 'node:test'

import {
  collectAccountingInvariantRows,
  evaluateAccountingInvariantRows,
  type AccountingInvariantRows,
} from '@/lib/domain/accounting/invariants'

const A1_DATE = new Date('2026-01-01T10:00:00.000Z')
const A2_DATE = new Date('2026-01-01T11:00:00.000Z')
const B_DATE = new Date('2026-01-02T10:00:00.000Z')

function cleanRows(): AccountingInvariantRows {
  return {
    salesOrders: [{
      id: 'order-1',
      orderNumber: 'SO-1',
      externalOrderNumber: null,
      status: 'SHIPPED',
      revenueDeferredDate: A1_DATE,
      unearnedRevenueAmount: 100,
      inventoryAllocatedDate: A2_DATE,
      allocationBatchAmount: 30,
      shipments: [{
        id: 'shipment-1',
        status: 'SHIPPED',
        shipmentJournalDate: B_DATE,
        revenueRecognizedAmount: 100,
        cogsBatchAmount: 30,
      }],
      refunds: [{
        id: 'refund-1',
        creditNoteNumber: 'CN-1',
        accountingCreditNoteId: 'xero-credit-note-1',
        totalBase: 10,
        accountingRetryRequired: false,
        accountingWarning: null,
        accountingRetrySyncs: null,
      }],
    }],
    postedShipments: [{
      id: 'shipment-1',
      orderId: 'order-1',
      status: 'SHIPPED',
      shipmentJournalDate: B_DATE,
      revenueRecognizedAmount: 100,
      cogsBatchAmount: 30,
      order: {
        id: 'order-1',
        orderNumber: 'SO-1',
        status: 'SHIPPED',
        revenueDeferredDate: A1_DATE,
        inventoryAllocatedDate: A2_DATE,
      },
    }],
    syncLogs: [
      {
        id: 'daily-a1',
        connector: 'xero',
        type: 'DAILY_BATCH_REVENUE_DEFERRAL',
        status: 'SYNCED',
        referenceType: 'DailyBatch',
        referenceId: 'A1-2026-01-01',
        externalTransactionId: 'journal-a1',
        payload: { date: '2026-01-01' },
        errorMessage: null,
        retryCount: 0,
        createdAt: A1_DATE,
        syncedAt: A1_DATE,
      },
      {
        id: 'daily-a2',
        connector: 'xero',
        type: 'DAILY_BATCH_INVENTORY_ALLOC',
        status: 'SYNCED',
        referenceType: 'DailyBatch',
        referenceId: 'A2-2026-01-01',
        externalTransactionId: 'journal-a2',
        payload: { date: '2026-01-01' },
        errorMessage: null,
        retryCount: 0,
        createdAt: A2_DATE,
        syncedAt: A2_DATE,
      },
      {
        id: 'daily-b',
        connector: 'xero',
        type: 'DAILY_BATCH_GROUP_B',
        status: 'SYNCED',
        referenceType: 'DailyBatch',
        referenceId: 'B-2026-01-02',
        externalTransactionId: 'journal-b',
        payload: { date: '2026-01-02' },
        errorMessage: null,
        retryCount: 0,
        createdAt: B_DATE,
        syncedAt: B_DATE,
      },
      {
        id: 'credit-note',
        connector: 'xero',
        type: 'CREDIT_NOTE',
        status: 'SYNCED',
        referenceType: 'SalesOrderRefund',
        referenceId: 'refund-1',
        externalTransactionId: 'credit-note-1',
        payload: { _idempotencyKey: 'cn1' },
        errorMessage: null,
        retryCount: 0,
        createdAt: B_DATE,
        syncedAt: B_DATE,
      },
      {
        id: 'cogs-reversal',
        connector: 'xero',
        type: 'COGS_REVERSAL',
        status: 'SYNCED',
        referenceType: 'SalesOrderRefund',
        referenceId: 'refund-1',
        externalTransactionId: 'journal-refund-1',
        payload: { _idempotencyKey: 'rv1' },
        errorMessage: null,
        retryCount: 0,
        createdAt: B_DATE,
        syncedAt: B_DATE,
      },
    ],
  }
}

test('clean accounting rows produce no findings', () => {
  assert.deepEqual(evaluateAccountingInvariantRows(cleanRows()), [])
})

test('digest-suffixed daily-batch logs satisfy the bare-key sync-evidence check (scjz.37)', () => {
  const rows = cleanRows()
  // Live Xero daily-batch posting stamps `<group>-<date>-<8 hex>`; the invariant
  // expects the bare `<group>-<date>`. The digest-suffixed log must still count as
  // evidence — no shipment_posted_without_sync_evidence false-positive.
  rows.syncLogs = rows.syncLogs.map((log) =>
    log.type === 'DAILY_BATCH_GROUP_B'
      ? { ...log, referenceId: 'B-2026-01-02-abcd1234' }
      : log.type === 'DAILY_BATCH_REVENUE_DEFERRAL'
        ? { ...log, referenceId: 'A1-2026-01-01-deadbeef' }
        : log.type === 'DAILY_BATCH_INVENTORY_ALLOC'
          ? { ...log, referenceId: 'A2-2026-01-01-0badf00d' }
          : log,
  )

  const codes = evaluateAccountingInvariantRows(rows).map((f) => f.code)
  assert.ok(!codes.includes('shipment_posted_without_sync_evidence'),
    'digest-suffixed Group-B log should satisfy the sync-evidence check')
})

test('still flags a posted shipment with no Group-B sync evidence at all (scjz.37)', () => {
  const rows = cleanRows()
  rows.syncLogs = rows.syncLogs.filter((log) => log.type !== 'DAILY_BATCH_GROUP_B')

  const codes = evaluateAccountingInvariantRows(rows).map((f) => f.code)
  assert.ok(codes.includes('shipment_posted_without_sync_evidence'),
    'a shipment with no Group-B log must still be flagged')
})

test('flags posted revenue whose payment was reversed with no compensating credit note', () => {
  const rows = cleanRows()
  // Payment reversed (paidAt cleared) on an order with A1 revenue posted, and the
  // refund/credit-note that would compensate it is absent (scjz.72).
  rows.salesOrders[0] = { ...rows.salesOrders[0], paidAt: null, refunds: [] }

  const findings = evaluateAccountingInvariantRows(rows)
  const finding = findings.find((f) => f.code === 'revenue_posted_without_payment')
  assert.ok(finding, 'expected a revenue_posted_without_payment finding')
  assert.equal(finding?.severity, 'critical')
  assert.equal(finding?.orderId, 'order-1')
})

test('does not flag reversed payment when a credit note fully covers the posted revenue', () => {
  const rows = cleanRows()
  const order = rows.salesOrders[0]
  // paidAt cleared but a credit note covers the full posted revenue (100).
  rows.salesOrders[0] = {
    ...order,
    paidAt: null,
    unearnedRevenueAmount: 100,
    refunds: [{ ...order.refunds[0], totalBase: 100 }],
  }

  const codes = evaluateAccountingInvariantRows(rows).map((f) => f.code)
  assert.ok(!codes.includes('revenue_posted_without_payment'))
})

test('flags reversed payment when the credit note has no durable accounting id (only a local number)', () => {
  const rows = cleanRows()
  const order = rows.salesOrders[0]
  // A credit-note number was generated locally but the credit note never synced
  // (no accountingCreditNoteId) — that is not durable evidence of compensation.
  rows.salesOrders[0] = {
    ...order,
    paidAt: null,
    unearnedRevenueAmount: 100,
    refunds: [{ ...order.refunds[0], creditNoteNumber: 'CN-1', accountingCreditNoteId: null, totalBase: 100 }],
  }

  const codes = evaluateAccountingInvariantRows(rows).map((f) => f.code)
  assert.ok(codes.includes('revenue_posted_without_payment'))
})

test('flags reversed payment when only a partial credit note covers the posted revenue', () => {
  const rows = cleanRows()
  const order = rows.salesOrders[0]
  // Posted revenue 100, but the only credit note covers 10 — the remaining 90 is
  // recognized revenue with no cash, so the finding must NOT be suppressed.
  rows.salesOrders[0] = {
    ...order,
    paidAt: null,
    unearnedRevenueAmount: 100,
    refunds: [{ ...order.refunds[0], totalBase: 10 }],
  }

  const codes = evaluateAccountingInvariantRows(rows).map((f) => f.code)
  assert.ok(codes.includes('revenue_posted_without_payment'))
})

test('does not flag posted revenue while payment is still present', () => {
  const rows = cleanRows()
  rows.salesOrders[0] = { ...rows.salesOrders[0], paidAt: A1_DATE, refunds: [] }

  const codes = evaluateAccountingInvariantRows(rows).map((f) => f.code)
  assert.ok(!codes.includes('revenue_posted_without_payment'))
})

test('flags a live accounting journal whose debits and credits do not balance', () => {
  const rows = cleanRows()
  rows.syncLogs.push({
    id: 'unbalanced-journal',
    connector: 'xero',
    type: 'COGS_REVERSAL',
    status: 'SYNCED',
    referenceType: 'Shipment',
    referenceId: 'shipment-x',
    externalTransactionId: 'journal-x',
    payload: {
      _idempotencyKey: 'k-x',
      lines: [
        { accountCode: '120', description: 'a', debit: 10 },
        { accountCode: '500', description: 'b', credit: 7 },
      ],
    },
    errorMessage: null,
    retryCount: 0,
    createdAt: B_DATE,
    syncedAt: B_DATE,
  })

  const finding = evaluateAccountingInvariantRows(rows).find((f) => f.code === 'accounting_sync_journal_unbalanced')
  assert.ok(finding, 'expected an unbalanced-journal finding')
  assert.equal(finding?.severity, 'critical')
  assert.deepEqual([(finding?.details as { debit: number }).debit, (finding?.details as { credit: number }).credit], [10, 7])
})

test('does not flag a balanced journal or a non-journal metadata payload', () => {
  const rows = cleanRows()
  rows.syncLogs.push(
    {
      id: 'balanced-journal',
      connector: 'xero',
      type: 'COGS_REVERSAL',
      status: 'SYNCED',
      referenceType: 'Shipment',
      referenceId: 'shipment-y',
      externalTransactionId: 'journal-y',
      payload: {
        _idempotencyKey: 'k-y',
        lines: [
          { accountCode: '120', description: 'a', debit: 10 },
          { accountCode: '500', description: 'b', credit: 10 },
        ],
      },
      errorMessage: null,
      retryCount: 0,
      createdAt: B_DATE,
      syncedAt: B_DATE,
    },
  )

  const codes = evaluateAccountingInvariantRows(rows).map((f) => f.code)
  assert.ok(!codes.includes('accounting_sync_journal_unbalanced'))
})

test('does not balance-check a failed (unposted) journal', () => {
  const rows = cleanRows()
  rows.syncLogs.push({
    id: 'failed-unbalanced',
    connector: 'xero',
    type: 'COGS_REVERSAL',
    status: 'FAILED',
    referenceType: 'Shipment',
    referenceId: 'shipment-z',
    externalTransactionId: null,
    payload: {
      _idempotencyKey: 'k-z',
      lines: [
        { accountCode: '120', description: 'a', debit: 10 },
        { accountCode: '500', description: 'b', credit: 1 },
      ],
    },
    errorMessage: 'boom',
    retryCount: 1,
    createdAt: B_DATE,
    syncedAt: null,
  })

  const codes = evaluateAccountingInvariantRows(rows).map((f) => f.code)
  assert.ok(!codes.includes('accounting_sync_journal_unbalanced'))
})

test('posted shipments require live Group B sync evidence and batch amounts', () => {
  const rows = cleanRows()
  rows.postedShipments[0] = {
    ...rows.postedShipments[0],
    revenueRecognizedAmount: null,
    cogsBatchAmount: null,
  }
  rows.syncLogs = rows.syncLogs.filter((log) => log.type !== 'DAILY_BATCH_GROUP_B')

  const codes = evaluateAccountingInvariantRows(rows).map((finding) => finding.code)

  assert.ok(codes.includes('shipment_posted_without_sync_evidence'))
  assert.ok(codes.includes('shipment_posted_missing_revenue_amount'))
  assert.ok(codes.includes('shipment_posted_missing_cogs_amount'))
})

test('posted shipment amount checks report revenue and COGS gaps independently', () => {
  const revenueOnly = cleanRows()
  revenueOnly.postedShipments[0] = {
    ...revenueOnly.postedShipments[0],
    cogsBatchAmount: null,
  }
  const revenueOnlyCodes = evaluateAccountingInvariantRows(revenueOnly).map((finding) => finding.code)

  assert.equal(revenueOnlyCodes.includes('shipment_posted_missing_revenue_amount'), false)
  assert.ok(revenueOnlyCodes.includes('shipment_posted_missing_cogs_amount'))

  const cogsOnly = cleanRows()
  cogsOnly.postedShipments[0] = {
    ...cogsOnly.postedShipments[0],
    revenueRecognizedAmount: null,
  }
  const cogsOnlyCodes = evaluateAccountingInvariantRows(cogsOnly).map((finding) => finding.code)

  assert.ok(cogsOnlyCodes.includes('shipment_posted_missing_revenue_amount'))
  assert.equal(cogsOnlyCodes.includes('shipment_posted_missing_cogs_amount'), false)
})

test('A1 and A2 stages require live daily batch sync evidence', () => {
  const rows = cleanRows()
  rows.syncLogs = rows.syncLogs.filter((log) => (
    log.type !== 'DAILY_BATCH_REVENUE_DEFERRAL' &&
    log.type !== 'DAILY_BATCH_INVENTORY_ALLOC'
  ))

  const codes = evaluateAccountingInvariantRows(rows).map((finding) => finding.code)

  assert.ok(codes.includes('sales_order_revenue_deferral_without_sync_evidence'))
  assert.ok(codes.includes('sales_order_inventory_allocation_without_sync_evidence'))
})

test('sync logs report missing reference metadata, missing idempotency keys, and failed entries', () => {
  const rows = cleanRows()
  rows.syncLogs.push(
    {
      id: 'missing-ref',
      connector: 'xero',
      type: 'CREDIT_NOTE',
      status: 'PENDING',
      referenceType: '',
      referenceId: '',
      externalTransactionId: null,
      payload: { _idempotencyKey: 'missing-ref' },
      errorMessage: null,
      retryCount: 0,
      createdAt: B_DATE,
      syncedAt: null,
    },
    {
      id: 'missing-idempotency',
      connector: 'quickbooks',
      type: 'PURCHASE_INVOICE',
      status: 'PENDING',
      referenceType: 'PurchaseOrder',
      referenceId: 'po-1',
      externalTransactionId: null,
      payload: {},
      errorMessage: null,
      retryCount: 0,
      createdAt: B_DATE,
      syncedAt: null,
    },
    {
      id: 'failed-no-error',
      connector: 'xero',
      type: 'SALES_INVOICE',
      status: 'FAILED',
      referenceType: 'SalesOrder',
      referenceId: 'order-1',
      externalTransactionId: null,
      payload: {},
      errorMessage: '',
      retryCount: 5,
      createdAt: B_DATE,
      syncedAt: null,
    },
  )

  const findings = evaluateAccountingInvariantRows(rows)
  const codes = findings.map((finding) => finding.code)

  assert.ok(codes.includes('accounting_sync_missing_reference'))
  assert.ok(codes.includes('accounting_sync_missing_idempotency_key'))
  assert.ok(findings.some((finding) => (
    finding.code === 'accounting_sync_missing_idempotency_key' &&
    finding.syncLogId === 'failed-no-error'
  )))
  assert.ok(codes.includes('accounting_sync_failed'))
  assert.ok(codes.includes('accounting_sync_failed_without_error'))
})

test('sales order A1 A2 and B staging combinations are validated', () => {
  const rows = cleanRows()
  rows.salesOrders.push(
    {
      id: 'order-a2-only',
      orderNumber: 'SO-A2',
      externalOrderNumber: null,
      status: 'ALLOCATED',
      revenueDeferredDate: null,
      unearnedRevenueAmount: null,
      inventoryAllocatedDate: A2_DATE,
      allocationBatchAmount: 0,
      shipments: [],
      refunds: [],
    },
    {
      id: 'order-b-only',
      orderNumber: 'SO-B',
      externalOrderNumber: null,
      status: 'SHIPPED',
      revenueDeferredDate: A1_DATE,
      unearnedRevenueAmount: 0,
      inventoryAllocatedDate: null,
      allocationBatchAmount: null,
      shipments: [{
        id: 'shipment-b-only',
        status: 'SHIPPED',
        shipmentJournalDate: B_DATE,
        revenueRecognizedAmount: 10,
        cogsBatchAmount: 3,
      }],
      refunds: [],
    },
    {
      id: 'order-out-of-order',
      orderNumber: 'SO-DATES',
      externalOrderNumber: null,
      status: 'ALLOCATED',
      revenueDeferredDate: A2_DATE,
      unearnedRevenueAmount: 100,
      inventoryAllocatedDate: A1_DATE,
      allocationBatchAmount: 20,
      shipments: [],
      refunds: [],
    },
  )

  const codes = evaluateAccountingInvariantRows(rows).map((finding) => finding.code)

  assert.ok(codes.includes('sales_order_inventory_allocated_without_revenue_deferral'))
  assert.ok(codes.includes('sales_order_inventory_allocation_missing_amount'))
  assert.ok(codes.includes('sales_order_revenue_deferral_missing_amount'))
  assert.ok(codes.includes('sales_order_shipment_posted_without_prior_stage'))
  assert.ok(codes.includes('sales_order_stage_dates_out_of_order'))
})

test('posted-shipment refunds require visible credit note and reversal state', () => {
  const rows = cleanRows()
  rows.salesOrders[0].refunds = [
    {
      id: 'refund-missing-sync',
      creditNoteNumber: 'CN-MISSING',
      accountingCreditNoteId: null,
      totalBase: 25,
      accountingRetryRequired: false,
      accountingWarning: null,
      accountingRetrySyncs: null,
    },
    {
      id: 'refund-hidden-retry',
      creditNoteNumber: 'CN-HIDDEN',
      accountingCreditNoteId: null,
      totalBase: 25,
      accountingRetryRequired: true,
      accountingWarning: null,
      accountingRetrySyncs: null,
    },
  ]

  const codes = evaluateAccountingInvariantRows(rows).map((finding) => finding.code)

  assert.ok(codes.includes('refund_missing_credit_note_sync'))
  assert.ok(codes.includes('refund_missing_reversal_sync'))
  assert.ok(codes.includes('refund_accounting_retry_not_visible'))
})

test('refund accounting retry sync payload counts as visible refund sync evidence', () => {
  const rows = cleanRows()
  rows.salesOrders[0].refunds = [{
    id: 'refund-retry',
    creditNoteNumber: 'CN-RETRY',
    accountingCreditNoteId: null,
    totalBase: 25,
    accountingRetryRequired: true,
    accountingWarning: 'Previous accounting staging failed',
    accountingRetrySyncs: [
      { type: 'CREDIT_NOTE', referenceType: 'SalesOrderRefund', referenceId: 'refund-retry', payload: {} },
      { type: 'COGS_REVERSAL', referenceType: 'SalesOrderRefund', referenceId: 'refund-retry', payload: {} },
    ],
  }]

  assert.deepEqual(evaluateAccountingInvariantRows(rows), [])
})

test('refund accounting retry details must cover all missing refund accounting actions', () => {
  const rows = cleanRows()
  rows.salesOrders[0].refunds = [{
    id: 'refund-partial-retry',
    creditNoteNumber: 'CN-PARTIAL',
    accountingCreditNoteId: null,
    totalBase: 25,
    accountingRetryRequired: true,
    accountingWarning: 'Previous accounting staging failed',
    accountingRetrySyncs: [
      { type: 'CREDIT_NOTE', referenceType: 'SalesOrderRefund', referenceId: 'refund-partial-retry', payload: {} },
    ],
  }]

  const findings = evaluateAccountingInvariantRows(rows)
  const finding = findings.find((entry) => entry.code === 'refund_accounting_retry_incomplete')

  assert.ok(finding)
  assert.equal(finding.refundId, 'refund-partial-retry')
})

test('credit-note retry evidence does not satisfy refund reversal evidence', () => {
  const rows = cleanRows()
  rows.salesOrders[0].refunds = [{
    id: 'refund-credit-only',
    creditNoteNumber: 'CN-CREDIT',
    accountingCreditNoteId: null,
    totalBase: 25,
    accountingRetryRequired: false,
    accountingWarning: null,
    accountingRetrySyncs: [
      { type: 'CREDIT_NOTE', referenceType: 'SalesOrderRefund', referenceId: 'refund-credit-only', payload: {} },
    ],
  }]

  const codes = evaluateAccountingInvariantRows(rows).map((finding) => finding.code)

  assert.equal(codes.includes('refund_missing_credit_note_sync'), false)
  assert.ok(codes.includes('refund_missing_reversal_sync'))
})

test('accounting row collection selects staged orders, posted shipments, and sync logs', async () => {
  const calls: Record<string, unknown> = {}
  const client = {
    salesOrder: {
      async findMany(args: unknown) {
        calls.salesOrder = args
        return []
      },
    },
    shipment: {
      async findMany(args: unknown) {
        calls.shipment = args
        return []
      },
    },
    accountingSyncLog: {
      async findMany(args: unknown) {
        calls.accountingSyncLog = args
        return []
      },
    },
  }

  const now = new Date('2026-08-31T00:00:00.000Z')
  await collectAccountingInvariantRows(client, { now, syncLogRetentionMonths: 6 })

  assert.ok(calls.salesOrder)
  assert.ok(calls.shipment)
  assert.ok(calls.accountingSyncLog)
  assert.deepEqual(
    (calls.salesOrder as { where: { status: unknown; refundStatus: unknown } }).where.status,
    { not: 'CANCELLED' },
  )
  assert.deepEqual(
    (calls.salesOrder as { where: { status: unknown; refundStatus: unknown } }).where.refundStatus,
    { not: 'FULL' },
  )
  assert.deepEqual(
    (calls.shipment as { where: unknown }).where,
    {
      shipmentJournalDate: { gte: new Date('2026-02-28T00:00:00.000Z') },
      order: { status: { not: 'CANCELLED' }, refundStatus: { not: 'FULL' } },
    },
  )
  assert.deepEqual(
    (calls.accountingSyncLog as { where: unknown }).where,
    {
      createdAt: { gte: new Date('2026-02-28T00:00:00.000Z') },
      OR: [
        { status: 'FAILED' },
        { status: { in: ['PENDING', 'PROCESSING', 'SYNCED'] } },
      ],
    },
  )
})

// --- scjz.75: A1 deferred revenue == Group-B recognized revenue tie-out ---

function fullyShippedNoRefundRows(): AccountingInvariantRows {
  // A fully-shipped terminal order with all shipments posted and no refunds,
  // recognized revenue tying out exactly to the A1 deferred amount.
  return {
    salesOrders: [{
      id: 'order-tie',
      orderNumber: 'SO-TIE',
      externalOrderNumber: null,
      status: 'COMPLETED',
      paidAt: B_DATE,
      revenueDeferredDate: A1_DATE,
      unearnedRevenueAmount: 100,
      inventoryAllocatedDate: A2_DATE,
      allocationBatchAmount: 30,
      shipments: [
        { id: 's1', status: 'SHIPPED', shipmentJournalDate: B_DATE, revenueRecognizedAmount: 60, cogsBatchAmount: 18 },
        { id: 's2', status: 'SHIPPED', shipmentJournalDate: B_DATE, revenueRecognizedAmount: 40, cogsBatchAmount: 12 },
      ],
      refunds: [],
    }],
    postedShipments: [],
    syncLogs: [
      {
        id: 'a1', connector: 'xero', type: 'DAILY_BATCH_REVENUE_DEFERRAL', status: 'SYNCED',
        referenceType: 'DailyBatch', referenceId: 'A1-2026-01-01', externalTransactionId: 'j-a1',
        payload: { date: '2026-01-01' }, errorMessage: null, retryCount: 0, createdAt: A1_DATE, syncedAt: A1_DATE,
      },
      {
        id: 'a2', connector: 'xero', type: 'DAILY_BATCH_INVENTORY_ALLOC', status: 'SYNCED',
        referenceType: 'DailyBatch', referenceId: 'A2-2026-01-01', externalTransactionId: 'j-a2',
        payload: { date: '2026-01-01' }, errorMessage: null, retryCount: 0, createdAt: A2_DATE, syncedAt: A2_DATE,
      },
      {
        id: 'b', connector: 'xero', type: 'DAILY_BATCH_GROUP_B', status: 'SYNCED',
        referenceType: 'DailyBatch', referenceId: 'B-2026-01-02', externalTransactionId: 'j-b',
        payload: { date: '2026-01-02' }, errorMessage: null, retryCount: 0, createdAt: B_DATE, syncedAt: B_DATE,
      },
    ],
  }
}

test('scjz.75: fully-shipped order whose recognized revenue ties out to deferral produces no mismatch', () => {
  const codes = evaluateAccountingInvariantRows(fullyShippedNoRefundRows()).map((f) => f.code)
  assert.ok(!codes.includes('sales_order_recognized_revenue_deferral_mismatch'))
})

test('scjz.75: flags a fully-shipped order whose recognized revenue does not tie out to deferral', () => {
  const rows = fullyShippedNoRefundRows()
  // Strand £10: only £90 recognized against £100 deferred.
  rows.salesOrders[0].shipments[1].revenueRecognizedAmount = 30
  const finding = evaluateAccountingInvariantRows(rows)
    .find((f) => f.code === 'sales_order_recognized_revenue_deferral_mismatch')
  assert.ok(finding, 'expected a deferral mismatch finding')
  assert.equal(finding!.severity, 'warning')
  assert.equal((finding!.details as { difference: number }).difference, -10)
})

test('scjz.75: does not flag an order still mid-recognition (a SHIPPED shipment not yet posted)', () => {
  const rows = fullyShippedNoRefundRows()
  // s2 is shipped but its Group-B batch has not run yet — recognized < deferred is expected.
  rows.salesOrders[0].shipments[1].shipmentJournalDate = null
  rows.salesOrders[0].shipments[1].revenueRecognizedAmount = 0
  const codes = evaluateAccountingInvariantRows(rows).map((f) => f.code)
  assert.ok(!codes.includes('sales_order_recognized_revenue_deferral_mismatch'))
})

test('scjz.75: skips the tie-out for refunded orders (reversal adjusts deferral outside this sum)', () => {
  const rows = fullyShippedNoRefundRows()
  rows.salesOrders[0].shipments[1].revenueRecognizedAmount = 30 // would otherwise mismatch
  rows.salesOrders[0].refunds = [{
    id: 'r1', creditNoteNumber: 'CN-9', accountingCreditNoteId: 'xc-9', totalBase: 10,
    accountingRetryRequired: false, accountingWarning: null, accountingRetrySyncs: null,
  }]
  const codes = evaluateAccountingInvariantRows(rows).map((f) => f.code)
  assert.ok(!codes.includes('sales_order_recognized_revenue_deferral_mismatch'))
})

test('scjz.75: does not flag a non-terminal (still-shipping) order even if sums differ', () => {
  const rows = fullyShippedNoRefundRows()
  rows.salesOrders[0].status = 'ALLOCATED' // not a fully-shipped terminal status
  rows.salesOrders[0].shipments[1].revenueRecognizedAmount = 30
  const codes = evaluateAccountingInvariantRows(rows).map((f) => f.code)
  assert.ok(!codes.includes('sales_order_recognized_revenue_deferral_mismatch'))
})

// --- o3d-0qoo: persisted daily-batch referenceIds ---

const A1_REF = 'A1-2026-01-01-abcd1234'
const A2_REF = 'A2-2026-01-01-0badf00d'
const B_REF = 'B-2026-01-02-beefcafe'

const SYNC_EVIDENCE_CODES = [
  'shipment_posted_without_sync_evidence',
  'sales_order_revenue_deferral_without_sync_evidence',
  'sales_order_inventory_allocation_without_sync_evidence',
]

/**
 * cleanRows(), but each row carries the exact referenceId its batch wrote and the
 * stage stamps land just after UTC midnight on the day AFTER the batch date —
 * exactly what a run that crosses midnight leaves behind (batch date captured once
 * at run start, stamps written with later new Date() calls). Deriving the reference
 * from the stamp here looks for a batch that does not exist.
 */
function midnightCrossingRows(): AccountingInvariantRows {
  const rows = cleanRows()
  const a1Stamp = new Date('2026-01-02T00:00:03.000Z')
  const a2Stamp = new Date('2026-01-02T00:00:07.000Z')
  const bStamp = new Date('2026-01-03T00:00:04.000Z')
  rows.salesOrders[0] = {
    ...rows.salesOrders[0],
    revenueDeferredDate: a1Stamp,
    revenueDeferredBatchRef: A1_REF,
    inventoryAllocatedDate: a2Stamp,
    inventoryAllocatedBatchRef: A2_REF,
    shipments: rows.salesOrders[0].shipments.map((shipment) => ({ ...shipment, shipmentJournalDate: bStamp })),
  }
  rows.postedShipments[0] = {
    ...rows.postedShipments[0],
    shipmentJournalDate: bStamp,
    shipmentJournalBatchRef: B_REF,
    order: {
      ...rows.postedShipments[0].order,
      revenueDeferredDate: a1Stamp,
      inventoryAllocatedDate: a2Stamp,
    },
  }
  rows.syncLogs = withDailyBatchReferenceIds(rows.syncLogs, A1_REF, A2_REF, B_REF)
  return rows
}

function withDailyBatchReferenceIds(
  syncLogs: AccountingInvariantRows['syncLogs'],
  a1: string,
  a2: string,
  b: string,
): AccountingInvariantRows['syncLogs'] {
  return syncLogs.map((log) => (
    log.type === 'DAILY_BATCH_REVENUE_DEFERRAL'
      ? { ...log, referenceId: a1 }
      : log.type === 'DAILY_BATCH_INVENTORY_ALLOC'
        ? { ...log, referenceId: a2 }
        : log.type === 'DAILY_BATCH_GROUP_B'
          ? { ...log, referenceId: b }
          : log
  ))
}

test('o3d-0qoo: persisted batch refs match the log a midnight-crossing batch wrote', () => {
  const codes = evaluateAccountingInvariantRows(midnightCrossingRows()).map((finding) => finding.code)
  for (const code of SYNC_EVIDENCE_CODES) {
    assert.ok(!codes.includes(code), `${code} must not fire when the persisted ref names a live log`)
  }
})

test('o3d-0qoo: legacy rows without a persisted ref still match via the derived date key', () => {
  const rows = cleanRows()
  // Pre-migration shape: stamps only, no persisted refs — and live Xero logs still
  // digest-suffixed, so the derived bare key only matches through the digest bridge.
  rows.salesOrders[0] = {
    ...rows.salesOrders[0],
    revenueDeferredBatchRef: null,
    inventoryAllocatedBatchRef: null,
  }
  rows.postedShipments[0] = { ...rows.postedShipments[0], shipmentJournalBatchRef: null }
  rows.syncLogs = withDailyBatchReferenceIds(rows.syncLogs, A1_REF, A2_REF, B_REF)

  const codes = evaluateAccountingInvariantRows(rows).map((finding) => finding.code)
  for (const code of SYNC_EVIDENCE_CODES) {
    assert.ok(!codes.includes(code), `${code} must not fire for a legacy row whose derived key matches`)
  }
})

test('o3d-0qoo: a Xero digest-suffixed persisted ref is matched exactly', () => {
  const rows = cleanRows()
  // Stamps and batch dates agree here; the point is that the digest-shaped ref is
  // matched as written, with no stripping and no date arithmetic.
  rows.salesOrders[0] = {
    ...rows.salesOrders[0],
    revenueDeferredBatchRef: A1_REF,
    inventoryAllocatedBatchRef: A2_REF,
  }
  rows.postedShipments[0] = { ...rows.postedShipments[0], shipmentJournalBatchRef: B_REF }
  rows.syncLogs = withDailyBatchReferenceIds(rows.syncLogs, A1_REF, A2_REF, B_REF)

  const codes = evaluateAccountingInvariantRows(rows).map((finding) => finding.code)
  for (const code of SYNC_EVIDENCE_CODES) {
    assert.ok(!codes.includes(code), `${code} must not fire when the persisted digest ref matches exactly`)
  }
})

test('o3d-0qoo: a persisted batch ref whose log is absent still reports missing sync evidence', () => {
  const rows = midnightCrossingRows()
  // The A1 batch this row names is gone; a DIFFERENT A1 batch ran on the stamp's
  // date. Deriving from the stamp (plus the digest bridge) would accept that decoy
  // and make the finding vacuous — the persisted ref must not match it.
  rows.syncLogs = rows.syncLogs.map((log) => (
    log.type === 'DAILY_BATCH_REVENUE_DEFERRAL' ? { ...log, referenceId: 'A1-2026-01-02-99999999' } : log
  ))
  // ...and the Group-B batch left no live log at all.
  rows.syncLogs = rows.syncLogs.filter((log) => log.type !== 'DAILY_BATCH_GROUP_B')

  const findings = evaluateAccountingInvariantRows(rows)
  const a1Finding = findings.find((finding) => finding.code === 'sales_order_revenue_deferral_without_sync_evidence')
  assert.ok(a1Finding, 'expected the A1 sync-evidence finding to still be reported')
  assert.equal((a1Finding!.details as { expectedReferenceId: string }).expectedReferenceId, A1_REF)
  assert.equal((a1Finding!.details as { referenceSource: string }).referenceSource, 'persisted')

  const bFinding = findings.find((finding) => finding.code === 'shipment_posted_without_sync_evidence')
  assert.ok(bFinding, 'expected the Group-B sync-evidence finding to still be reported')
  assert.equal((bFinding!.details as { expectedReferenceId: string }).expectedReferenceId, B_REF)
})

test('o3d-o97 r3: a refund that could not account for the A2 debit is reported even with NO posted shipment', () => {
  // The refusal's remedy. The refund path deliberately reverses nothing when it cannot establish
  // what A2 debited, and the commonest shape is an ALLOCATED, never-shipped order — which has no
  // posted shipment at all, so it must be raised BEFORE the posted-shipment guard the rest of the
  // refund checks sit behind. Without it the pounds sit in Allocated Inventory with nothing
  // anywhere pointing at them: both daily-batch windows exclude a fully-refunded order for ever.
  const rows = cleanRows()
  rows.salesOrders.push({
    id: 'order-unresolved',
    orderNumber: 'SO-UNRESOLVED',
    externalOrderNumber: null,
    status: 'ALLOCATED',
    revenueDeferredDate: null,
    unearnedRevenueAmount: null,
    // The A2 stamp SURVIVED the refusal, which is what keeps the standing A2 checks alive too.
    inventoryAllocatedDate: A2_DATE,
    allocationBatchAmount: 40,
    shipments: [],
    refunds: [{
      id: 'refund-unresolved',
      creditNoteNumber: 'CN-UNRESOLVED',
      accountingCreditNoteId: 'xero-credit-note-9',
      totalBase: 100,
      accountingRetryRequired: false,
      accountingWarning: null,
      accountingRetrySyncs: null,
      allocationBasisUnresolved: 'the A2 journal this order was staged into is CANCELLED, not SYNCED. Recorded A2 debit £40.00; this refund credited Allocated Inventory £0.00.',
    }],
  })

  const findings = evaluateAccountingInvariantRows(rows)
  const finding = findings.find((row) => row.code === 'sales_order_refund_allocation_basis_unresolved')
  assert.ok(finding, 'the refusal is reported')
  assert.equal(finding.severity, 'critical')
  assert.equal(finding.refundId, 'refund-unresolved')
  assert.match(finding.message, /Recorded A2 debit £40\.00/)
  assert.equal(
    findings.filter((row) => row.code === 'sales_order_refund_allocation_basis_unresolved').length,
    1,
    'and only for the refund that carries the note',
  )
})
