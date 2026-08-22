import assert from 'node:assert/strict'
import test from 'node:test'

import {
  collectAccountingInvariantRows,
  evaluateAccountingInvariantRows,
  type AccountingInvariantRows,
} from '@/lib/domain/accounting/invariants'
import {
  REVERSAL_STAGING_NOT_STAGED,
  REVERSAL_STAGING_STAGED,
} from '@/lib/domain/sales/refund-reversal-record'

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
    // o3d-o97 r4: the refusals arrive as their OWN row set, loaded by a query with none of the
    // filters the sales-order query carries — that is the whole point of the field existing.
    unresolvedAllocationBasisRefunds: [],
    // o3d-2sm1: same reasoning — the "staged and never recorded" refunds are their own row set.
    reversalNeverRecordedRefunds: [],
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
    salesOrderRefund: {
      async findMany(args: unknown) {
        calls.salesOrderRefund = args
        return []
      },
    },
  }

  const now = new Date('2026-08-31T00:00:00.000Z')
  await collectAccountingInvariantRows(client, { now, syncLogRetentionMonths: 6 })

  assert.ok(calls.salesOrder)
  assert.ok(calls.shipment)
  assert.ok(calls.accountingSyncLog)
  assert.ok(calls.salesOrderRefund)
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
    unresolvedAllocationBasisRefunds: [],
    // o3d-2sm1: same reasoning — the "staged and never recorded" refunds are their own row set.
    reversalNeverRecordedRefunds: [],
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

test('o3d-o97 r4: a refusal is reported from its own row set, with NO posted shipment on the order', () => {
  // The refusal's remedy. The refund path deliberately reverses nothing when it cannot establish
  // what A2 debited, and the commonest shape is an ALLOCATED, never-shipped order — which has no
  // posted shipment at all, so it can never be reached through the per-order refund checks that sit
  // behind the posted-shipment guard. Without this the pounds sit in Allocated Inventory with
  // nothing anywhere pointing at them: both daily-batch windows exclude a fully-refunded order.
  const rows = cleanRows()
  rows.unresolvedAllocationBasisRefunds = [{
    id: 'refund-unresolved',
    orderId: 'order-unresolved',
    creditNoteNumber: 'CN-UNRESOLVED',
    allocatedReliefAmount: 0,
    allocationBasisUnresolved: 'the A2 journal this order was staged into is CANCELLED, not SYNCED. Recorded A2 debit £40.00; this refund credited Allocated Inventory £0.00.',
    order: {
      orderNumber: 'SO-UNRESOLVED',
      externalOrderNumber: null,
      status: 'ALLOCATED',
      refundStatus: 'FULL',
      inventoryAllocatedDate: A2_DATE,
      allocationBatchAmount: 40,
    },
  }]

  const findings = evaluateAccountingInvariantRows(rows)
  const finding = findings.find((row) => row.code === 'sales_order_refund_allocation_basis_unresolved')
  assert.ok(finding, 'the refusal is reported')
  assert.equal(finding.severity, 'critical')
  assert.equal(finding.refundId, 'refund-unresolved')
  assert.equal(finding.orderId, 'order-unresolved')
  assert.match(finding.message, /Recorded A2 debit £40\.00/)
  assert.equal((finding.details as { allocationBatchAmount: number }).allocationBatchAmount, 40)
  assert.equal(
    findings.filter((row) => row.code === 'sales_order_refund_allocation_basis_unresolved').length,
    1,
    'and only for the refund that carries the note',
  )
})

test('o3d-o97 r4: a refusal on a FULLY-REFUNDED order is still reported — the per-order query never returns one', () => {
  // THE FINDING THIS ROUND FIXES. `allocationBasisUnresolved` is written when the refusal COST
  // something, and it only costs something on a FULL refund — that is the last moment anything in
  // IMS looks at the order's A2 posting. The sales-order query the per-order checks are fed from
  // excludes `refundStatus: 'FULL'` and `status: 'CANCELLED'`, so r3's version reported the refusal
  // from inside a loop that could not, in production, ever contain it. Here the order is absent
  // from `salesOrders` entirely — exactly what that query returns — and the finding still lands.
  const rows = cleanRows()
  rows.unresolvedAllocationBasisRefunds = [{
    id: 'refund-full',
    orderId: 'order-gone',
    creditNoteNumber: 'CN-FULL',
    allocatedReliefAmount: 0,
    allocationBasisUnresolved: 'the A2 journal this order was staged into is PENDING, not SYNCED. Recorded A2 debit £40.00; this refund credited Allocated Inventory £0.00.',
    order: {
      orderNumber: 'SO-GONE',
      externalOrderNumber: null,
      status: 'CANCELLED',
      refundStatus: 'FULL',
      inventoryAllocatedDate: A2_DATE,
      allocationBatchAmount: 40,
    },
  }]
  assert.equal(rows.salesOrders.some((order) => order.id === 'order-gone'), false)

  const finding = evaluateAccountingInvariantRows(rows)
    .find((row) => row.code === 'sales_order_refund_allocation_basis_unresolved')
  assert.ok(finding, 'a refusal outside the per-order query is still reported')
  assert.equal(finding.orderId, 'order-gone')
  assert.equal((finding.details as { refundStatus: string }).refundStatus, 'FULL')
  assert.equal((finding.details as { orderStatus: string }).orderStatus, 'CANCELLED')
})

test('o3d-2sm1: a reversal that was staged and never recorded is reported, on a FULLY-REFUNDED order', () => {
  // The state the whole issue is about: staging committed — `allocatedReliefAmount` is written in
  // the same transaction as the un-stage, so the order's A1/A2 stamps are already gone — and the
  // syncs it produced were never recorded. Nothing else in this report can see it: the order is
  // `refundStatus: 'FULL'`, which the per-order query excludes, and the reconciliation's own refund
  // scan is windowed by `refundedAt` and needs a posted shipment. Here the order is absent from
  // `salesOrders` entirely, exactly as production returns it.
  const rows = cleanRows()
  rows.reversalNeverRecordedRefunds = [{
    id: 'refund-lost',
    orderId: 'order-gone',
    creditNoteNumber: 'CN-LOST',
    totalBase: 100,
    accountingRetryRequired: true,
    accountingRetrySyncs: null,
    accountingWarning: null,
    allocatedReliefAmount: 20,
    // o3d-2sm1 (Codex r1): the witness the staging transaction wrote one statement before the
    // un-stage. THIS is what makes the row a confirmed loss; the nullable amount above cannot,
    // because it is NULL on every row written before it existed.
    reversalStagingState: REVERSAL_STAGING_STAGED,
    order: {
      orderNumber: 'SO-GONE',
      externalOrderNumber: null,
      status: 'SHIPPED',
      refundStatus: 'FULL',
      revenueDeferredDate: null,
      unearnedRevenueAmount: 100,
    },
  }]
  assert.equal(rows.salesOrders.some((order) => order.id === 'order-gone'), false)

  const finding = evaluateAccountingInvariantRows(rows)
    .find((row) => row.code === 'refund_reversal_staged_never_recorded')
  assert.ok(finding, 'the lost reversal is reported')
  assert.equal(finding.severity, 'critical')
  assert.equal(finding.refundId, 'refund-lost')
  assert.equal(finding.orderId, 'order-gone')
  assert.equal((finding.details as { allocatedReliefAmount: number }).allocatedReliefAmount, 20)
})

test('o3d-2sm1: a refund that recorded an EMPTY stage, or never staged at all, is NOT reported', () => {
  // The two rows that share the same missing deferral date and owe nothing. Reporting either would
  // make the finding noise — and the finding has to be trusted, because it is the only thing that
  // says a reversal was lost.
  const rows = cleanRows()
  rows.reversalNeverRecordedRefunds = [
    {
      // Staging ran and staged nothing (a fully-shipped chargeback), then the credit-note enqueue
      // failed and re-flagged the row. `[]` is the written record of that.
      id: 'refund-empty-stage',
      orderId: 'order-a',
      creditNoteNumber: 'CN-A',
      totalBase: 100,
      accountingRetryRequired: true,
      accountingRetrySyncs: [],
      accountingWarning: 'Refund was created, but accounting queueing failed',
      allocatedReliefAmount: 0,
      reversalStagingState: REVERSAL_STAGING_STAGED,
      order: { orderNumber: 'SO-A', externalOrderNumber: null, status: 'SHIPPED', refundStatus: 'FULL', revenueDeferredDate: null },
    },
    {
      // Staging never ran: the order was never revenue-deferred, so the null date means what it
      // looks like — and the row SAYS so, because the witness written at INSERT is still standing.
      id: 'refund-never-staged',
      orderId: 'order-b',
      creditNoteNumber: 'CN-B',
      totalBase: 100,
      accountingRetryRequired: true,
      accountingRetrySyncs: null,
      accountingWarning: 'Refund was created, but accounting queueing failed',
      allocatedReliefAmount: undefined,
      reversalStagingState: REVERSAL_STAGING_NOT_STAGED,
      order: { orderNumber: 'SO-B', externalOrderNumber: null, status: 'SHIPPED', refundStatus: 'PARTIAL', revenueDeferredDate: null },
    },
    {
      // Staging committed and its syncs were lost — but the order is still A1-deferred, so nothing
      // was un-staged and a retry re-derives the reversal from stamps that are still there. Lost
      // and RECOVERABLE are different findings, and this one is not this finding.
      id: 'refund-recoverable',
      orderId: 'order-c',
      creditNoteNumber: 'CN-C',
      totalBase: 100,
      accountingRetryRequired: true,
      accountingRetrySyncs: null,
      accountingWarning: null,
      allocatedReliefAmount: 20,
      reversalStagingState: REVERSAL_STAGING_STAGED,
      order: { orderNumber: 'SO-C', externalOrderNumber: null, status: 'SHIPPED', refundStatus: 'PARTIAL', revenueDeferredDate: A1_DATE },
    },
  ]

  const findings = evaluateAccountingInvariantRows(rows)
  assert.deepEqual(findings.filter((row) => row.code === 'refund_reversal_staged_never_recorded'), [])
  // o3d-2sm1 (Codex r1): and not as the undecidable warning either. Every row here CARRIES a
  // witness, so each one is decided on evidence — the third state is for rows that have none.
  assert.deepEqual(findings.filter((row) => row.code === 'refund_reversal_record_undecidable'), [])
})

test('o3d-o97 r4 + o3d-2sm1: the refund queries carry no refundStatus, status or retention filter', async () => {
  // The row sets are only as visible as their queries. Every filter on the sales-order query is
  // right there and fatal here, so this pins each predicate to exactly the one condition that
  // bounds it. A window or a status filter added to either would silence its report again.
  const refundQueries: Array<{ where: unknown; select?: Record<string, unknown> }> = []
  const client = {
    salesOrder: { async findMany() { return [] } },
    shipment: { async findMany() { return [] } },
    accountingSyncLog: { async findMany() { return [] } },
    salesOrderRefund: {
      async findMany(args: unknown) {
        refundQueries.push(args as { where: unknown; select?: Record<string, unknown> })
        return []
      },
    },
  }

  await collectAccountingInvariantRows(client, {
    now: new Date('2026-08-31T00:00:00.000Z'),
    syncLogRetentionMonths: 6,
  })

  assert.deepEqual(
    refundQueries.map((query) => query.where),
    [
      { allocationBasisUnresolved: { not: null } },
      // o3d-2sm1: the flag o3d-mrwu made durable is the bound. Nothing else — a FULL refund is
      // exactly the row this set exists for, so the per-order query's `refundStatus` exclusion
      // would remove every one of them.
      { accountingRetryRequired: true },
    ],
  )

  // o3d-2sm1 (Codex r1): AND THE WITNESS IS READ, NOT FILTERED ON. A row carrying no witness is
  // exactly the one that has to be reported as undecidable, so narrowing the query by it — the
  // obvious "only look at rows we can decide" optimisation — would drop the whole third state and
  // recreate the silence. It belongs in the select and nowhere near the where.
  assert.equal(refundQueries[1]?.select?.reversalStagingState, true, 'the witness is selected')
  assert.equal(
    Object.keys(refundQueries[1]?.where as Record<string, unknown>).includes('reversalStagingState'),
    false,
    'and never used to bound the set',
  )
})

// ---------------------------------------------------------------------------
// o3d-2sm1, Codex r1 (CRITICAL) — THE PRE-WITNESS ROWS, NAMED WITHOUT BEING ACCUSED.
//
// Round 1 decided this from `allocatedReliefAmount != null && accountingRetrySyncs == null`, and
// both columns are NULL on every row written before they existed. So the genuinely lost legacy
// reversal answered "no finding" — the report was silent about the only rows that can still be in
// this state — and so did the legacy row that never staged anything.
//
// The rows below are byte-identical in the database and describe opposite histories. Neither may be
// reported as a confirmed loss (that would put a fabricated accusation on every historical row that
// still owes accounting, and the critical has to stay trustworthy) and neither may be dropped
// (that is the silence). They get their own code, at warning, and stay until an operator decides
// them against the ledger — which is the same act that clears the flag they are bounded by.
// ---------------------------------------------------------------------------

function preWitnessRefundRow(overrides: Partial<AccountingInvariantRows['reversalNeverRecordedRefunds'][number]>) {
  return {
    id: 'refund-pre-witness',
    orderId: 'order-pre-witness',
    creditNoteNumber: 'CN-OLD',
    totalBase: 100,
    accountingRetryRequired: true,
    // Both of the columns round 1 read. NULL on this row because neither existed when it was
    // written — not because either event happened.
    accountingRetrySyncs: null,
    allocatedReliefAmount: undefined,
    accountingWarning: null,
    ...overrides,
  }
}

test('o3d-2sm1 Codex r1: a PRE-WITNESS row whose reversal was genuinely lost is reported, not silently cleared', () => {
  // The order was A1-deferred and A2-staged, a FULL refund's staging un-staged it, and the syncs
  // were never recorded. Round 1 produced no finding at all for this — the exact row the report
  // exists to surface.
  const rows = cleanRows()
  rows.reversalNeverRecordedRefunds = [preWitnessRefundRow({
    id: 'refund-old-lost',
    orderId: 'order-old-lost',
    order: {
      orderNumber: 'SO-OLD-LOST',
      externalOrderNumber: null,
      status: 'SHIPPED',
      refundStatus: 'FULL',
      revenueDeferredDate: null,
      unearnedRevenueAmount: 100,
    },
  })]

  const findings = evaluateAccountingInvariantRows(rows)
  assert.deepEqual(
    findings.filter((row) => row.code === 'refund_reversal_staged_never_recorded'),
    [],
    'not asserted as a confirmed loss — nothing on the row can prove that',
  )
  const undecidable = findings.find((row) => row.code === 'refund_reversal_record_undecidable')
  assert.ok(undecidable, 'but reported, which round 1 did not do at all')
  assert.equal(undecidable.severity, 'warning')
  assert.equal(undecidable.refundId, 'refund-old-lost')
  assert.match(undecidable.message, /predates the record of whether its reversals were staged/)
})

test('o3d-2sm1 Codex r1: a PRE-WITNESS row that never staged anything gets the same warning, on its own fixture', () => {
  // The converse history — a PARTIAL refund on an order that was never revenue-deferred, flagged
  // only by a failed credit-note enqueue, so no reversal was ever owed. Identical in the database
  // to the row above, which is why the report must describe the ambiguity rather than resolve it:
  // calling this one a lost reversal would be the cry-wolf the critical cannot afford.
  const rows = cleanRows()
  rows.reversalNeverRecordedRefunds = [preWitnessRefundRow({
    id: 'refund-old-never-staged',
    orderId: 'order-old-never-staged',
    accountingWarning: 'Refund was created, but accounting queueing failed',
    order: {
      orderNumber: 'SO-OLD-CLEAN',
      externalOrderNumber: null,
      status: 'SHIPPED',
      refundStatus: 'PARTIAL',
      revenueDeferredDate: null,
      unearnedRevenueAmount: null,
    },
  })]

  const findings = evaluateAccountingInvariantRows(rows)
  assert.deepEqual(findings.filter((row) => row.code === 'refund_reversal_staged_never_recorded'), [])
  const undecidable = findings.find((row) => row.code === 'refund_reversal_record_undecidable')
  assert.ok(undecidable, 'named rather than dropped — an operator still has to decide it')
  assert.equal(undecidable.severity, 'warning')
  assert.equal((undecidable.details as { reversalStagingState: unknown }).reversalStagingState, null)
})
