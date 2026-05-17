import assert from 'node:assert/strict'
import test from 'node:test'

import {
  collectAccountingReconciliationRows,
  evaluateAccountingReconciliationRows,
  type AccountingReconciliationRows,
} from '@/lib/domain/accounting/reconciliation'

const A1_DATE = new Date('2026-04-24T10:00:00.000Z')
const A2_DATE = new Date('2026-04-24T11:00:00.000Z')
const B_DATE = new Date('2026-04-25T10:00:00.000Z')

function cleanRows(): AccountingReconciliationRows {
  return {
    salesOrders: [{
      id: 'order-1',
      orderNumber: 'SO-1',
      externalOrderNumber: null,
      status: 'SHIPPED',
      revenueDeferredDate: A1_DATE,
      inventoryAllocatedDate: A2_DATE,
    }],
    shipments: [{
      id: 'shipment-1',
      orderId: 'order-1',
      shipmentJournalDate: B_DATE,
    }],
    refunds: [{
      id: 'refund-1',
      orderId: 'order-1',
      creditNoteNumber: 'CN-1',
      accountingCreditNoteId: 'credit-note-1',
      totalBase: '10',
      accountingRetrySyncs: null,
    }],
    syncLogs: [
      {
        id: 'sync-a1',
        connector: 'xero',
        type: 'DAILY_BATCH_REVENUE_DEFERRAL',
        status: 'SYNCED',
        referenceType: 'DailyBatch',
        referenceId: 'A1-2026-04-24',
        externalTransactionId: 'journal-a1',
        payload: { date: '2026-04-24' },
      },
      {
        id: 'sync-a2',
        connector: 'xero',
        type: 'DAILY_BATCH_INVENTORY_ALLOC',
        status: 'SYNCED',
        referenceType: 'DailyBatch',
        referenceId: 'A2-2026-04-24',
        externalTransactionId: 'journal-a2',
        payload: { date: '2026-04-24' },
      },
      {
        id: 'sync-b',
        connector: 'xero',
        type: 'DAILY_BATCH_GROUP_B',
        status: 'SYNCED',
        referenceType: 'DailyBatch',
        referenceId: 'B-2026-04-25',
        externalTransactionId: 'journal-b',
        payload: { date: '2026-04-25' },
      },
      {
        id: 'sync-refund-cogs',
        connector: 'xero',
        type: 'COGS_REVERSAL',
        status: 'SYNCED',
        referenceType: 'SalesOrderRefund',
        referenceId: 'refund-1',
        externalTransactionId: 'journal-refund-cogs',
        payload: { _idempotencyKey: 'sales-order-refund:refund-1:cogs-reversal' },
      },
    ],
    accountingEvents: [
      {
        id: 'event-a1',
        type: 'DAILY_BATCH_REVENUE_DEFERRAL',
        sourceEntityType: 'DailyBatch',
        sourceEntityId: 'A1-2026-04-24',
        businessDate: A1_DATE,
        status: 'POSTED',
        idempotencyKey: 'event-a1-key',
        externalSystem: 'xero',
        externalId: 'journal-a1',
      },
      {
        id: 'event-a2',
        type: 'DAILY_BATCH_INVENTORY_ALLOC',
        sourceEntityType: 'DailyBatch',
        sourceEntityId: 'A2-2026-04-24',
        businessDate: A2_DATE,
        status: 'POSTED',
        idempotencyKey: 'event-a2-key',
        externalSystem: 'xero',
        externalId: 'journal-a2',
      },
      {
        id: 'event-b',
        type: 'DAILY_BATCH_GROUP_B',
        sourceEntityType: 'DailyBatch',
        sourceEntityId: 'B-2026-04-25',
        businessDate: B_DATE,
        status: 'POSTED',
        idempotencyKey: 'event-b-key',
        externalSystem: 'xero',
        externalId: 'journal-b',
      },
      {
        id: 'event-refund-cogs',
        type: 'COGS_REVERSAL',
        sourceEntityType: 'SalesOrderRefund',
        sourceEntityId: 'refund-1',
        businessDate: B_DATE,
        status: 'POSTED',
        idempotencyKey: 'event-refund-cogs-key',
        externalSystem: 'xero',
        externalId: 'journal-refund-cogs',
      },
    ],
  }
}

test('clean reconciliation rows produce no findings', () => {
  assert.deepEqual(evaluateAccountingReconciliationRows(cleanRows()), [])
})

test('sources with accounting state report missing mirrored events', () => {
  const rows = cleanRows()
  rows.accountingEvents = []

  const codes = evaluateAccountingReconciliationRows(rows).map((finding) => finding.code)

  assert.ok(codes.includes('source_order_revenue_deferral_without_event'))
  assert.ok(codes.includes('source_order_inventory_allocation_without_event'))
  assert.ok(codes.includes('source_shipment_without_event'))
  assert.ok(codes.includes('source_refund_without_event'))
})

test('old mirrorable sync logs report missing accounting events', () => {
  const rows = cleanRows()
  rows.accountingEvents = rows.accountingEvents.filter((event) => event.type !== 'COGS_REVERSAL')

  const finding = evaluateAccountingReconciliationRows(rows).find((entry) => (
    entry.code === 'old_sync_log_without_mirrored_event' &&
    entry.syncLogId === 'sync-refund-cogs'
  ))

  assert.ok(finding)
})

test('events report missing source state, posted external IDs, and duplicate external references', () => {
  const rows = cleanRows()
  rows.accountingEvents.push(
    {
      id: 'event-orphan',
      type: 'DAILY_BATCH_GROUP_B',
      sourceEntityType: 'DailyBatch',
      sourceEntityId: 'B-2026-04-20',
      businessDate: new Date('2026-04-20T00:00:00.000Z'),
      status: 'PENDING',
      idempotencyKey: 'event-orphan-key',
      externalSystem: 'xero',
      externalId: null,
    },
    {
      id: 'event-posted-missing-id',
      type: 'DAILY_BATCH_GROUP_B',
      sourceEntityType: 'DailyBatch',
      sourceEntityId: 'B-2026-04-25',
      businessDate: B_DATE,
      status: 'POSTED',
      idempotencyKey: 'event-posted-missing-id-key',
      externalSystem: 'xero',
      externalId: null,
    },
    {
      id: 'event-duplicate-reference',
      type: 'DAILY_BATCH_GROUP_B',
      sourceEntityType: 'DailyBatch',
      sourceEntityId: 'B-2026-04-25',
      businessDate: B_DATE,
      status: 'POSTED',
      idempotencyKey: 'event-duplicate-reference-key',
      externalSystem: 'xero',
      externalId: 'journal-b',
    },
  )

  const codes = evaluateAccountingReconciliationRows(rows).map((finding) => finding.code)

  assert.ok(codes.includes('event_without_source'))
  assert.ok(codes.includes('posted_event_without_external_id'))
  assert.ok(codes.includes('duplicate_external_reference'))
})

test('refund retry sync payload counts as expected refund event source', () => {
  const rows = cleanRows()
  rows.syncLogs = rows.syncLogs.filter((log) => log.type !== 'COGS_REVERSAL')
  rows.refunds[0] = {
    ...rows.refunds[0],
    accountingRetrySyncs: [
      { type: 'UNEARNED_REV_REVERSAL', referenceType: 'SalesOrderRefund', referenceId: 'refund-1' },
    ],
  }
  rows.accountingEvents = rows.accountingEvents.filter((event) => event.type !== 'UNEARNED_REV_REVERSAL')

  const finding = evaluateAccountingReconciliationRows(rows).find((entry) => (
    entry.code === 'source_refund_without_event' &&
    entry.refundId === 'refund-1'
  ))

  assert.ok(finding)
})

test('cancelled terminal order with posted accounting reports missing reversal evidence', () => {
  const rows = cleanRows()
  rows.salesOrders = [{
    ...rows.salesOrders[0],
    id: 'order-cancelled',
    orderNumber: 'SO-CANCELLED',
    status: 'CANCELLED',
  }]
  rows.shipments = []
  rows.refunds = []

  const finding = evaluateAccountingReconciliationRows(rows).find((entry) => (
    entry.code === 'terminal_cancelled_order_missing_reversal_evidence' &&
    entry.orderId === 'order-cancelled'
  ))

  assert.ok(finding)
  assert.equal(finding.severity, 'critical')
})

test('refunded terminal order with posted shipment reports missing credit-note and reversal evidence', () => {
  const rows = cleanRows()
  rows.salesOrders = [{
    ...rows.salesOrders[0],
    status: 'REFUNDED',
  }]
  rows.refunds = [{
    ...rows.refunds[0],
    accountingCreditNoteId: null,
    accountingRetrySyncs: null,
  }]
  rows.syncLogs = rows.syncLogs.filter((log) => log.referenceType !== 'SalesOrderRefund')
  rows.accountingEvents = rows.accountingEvents.filter((event) => event.sourceEntityType !== 'SalesOrderRefund')

  const codes = evaluateAccountingReconciliationRows(rows).map((finding) => finding.code)

  assert.ok(codes.includes('terminal_refunded_order_missing_credit_note_evidence'))
  assert.ok(codes.includes('terminal_refunded_order_missing_reversal_evidence'))
})

test('refunded terminal order with credit-note and reversal evidence stays clean', () => {
  const rows = cleanRows()
  rows.salesOrders = [{
    ...rows.salesOrders[0],
    status: 'PARTIALLY_REFUNDED',
  }]
  rows.syncLogs.push({
    id: 'sync-refund-credit-note',
    connector: 'xero',
    type: 'CREDIT_NOTE',
    status: 'SYNCED',
    referenceType: 'SalesOrderRefund',
    referenceId: 'refund-1',
    externalTransactionId: 'credit-note-1',
    payload: { _idempotencyKey: 'sales-order-refund:refund-1:credit-note' },
  })

  const codes = evaluateAccountingReconciliationRows(rows).map((finding) => finding.code)

  assert.equal(codes.includes('terminal_refunded_order_missing_credit_note_evidence'), false)
  assert.equal(codes.includes('terminal_refunded_order_missing_reversal_evidence'), false)
})

test('accounting reconciliation row collection selects required datasets', async () => {
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
    salesOrderRefund: {
      async findMany(args: unknown) {
        calls.salesOrderRefund = args
        return []
      },
    },
    accountingSyncLog: {
      async findMany(args: unknown) {
        calls.accountingSyncLog = args
        return []
      },
    },
    accountingEvent: {
      async findMany(args: unknown) {
        calls.accountingEvent = args
        return []
      },
    },
  }

  await collectAccountingReconciliationRows(client)

  assert.ok(calls.salesOrder)
  assert.ok(calls.shipment)
  assert.ok(calls.salesOrderRefund)
  assert.ok(calls.accountingSyncLog)
  assert.ok(calls.accountingEvent)
  const salesOrderCall = calls.salesOrder as {
    where: {
      OR: Array<{
        revenueDeferredDate?: { gte?: unknown }
        inventoryAllocatedDate?: { gte?: unknown }
        status?: { in?: string[] }
        updatedAt?: { gte?: unknown }
      }>
    }
    take: number
  }
  const salesOrderWhere = salesOrderCall.where
  assert.ok(salesOrderWhere.OR[0].revenueDeferredDate?.gte instanceof Date)
  assert.ok(salesOrderWhere.OR[1].inventoryAllocatedDate?.gte instanceof Date)
  assert.deepEqual(salesOrderWhere.OR[2].status, {
    in: ['REFUNDED', 'PARTIALLY_REFUNDED', 'CANCELLED', 'COMPLETED', 'DELIVERED'],
  })
  assert.ok(salesOrderWhere.OR[2].updatedAt?.gte instanceof Date)
  assert.equal(salesOrderCall.take, 10000)
  const shipmentWhere = (calls.shipment as { where: { shipmentJournalDate: { gte?: unknown } } }).where
  assert.ok(shipmentWhere.shipmentJournalDate.gte instanceof Date)
  assert.equal((calls.salesOrderRefund as { take: number }).take, 10000)
  assert.equal((calls.accountingSyncLog as { take: number }).take, 10000)
  assert.equal((calls.accountingEvent as { take: number }).take, 10000)
})
