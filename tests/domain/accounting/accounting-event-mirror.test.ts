import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildMirroredAccountingEventDraft,
  isMirrorableAccountingSyncType,
  resetMirroredAccountingEventsToPending,
  updateMirroredAccountingEventStatus,
} from '@/lib/domain/accounting/accounting-event-mirror'

test('daily batch sync log payload mirrors to an accounting event', () => {
  const payload = {
    date: '2026-04-26',
    reference: 'Revenue Deferral 2026-04-26',
    lines: [
      { accountCode: '400', description: 'Daily revenue deferral', debit: 12.345 },
      { accountCode: '210', description: 'Daily revenue deferral', credit: 12.345 },
    ],
  }

  const event = buildMirroredAccountingEventDraft({
    connector: 'xero',
    type: 'DAILY_BATCH_REVENUE_DEFERRAL',
    referenceType: 'DailyBatch',
    referenceId: 'A1-2026-04-26',
    payload,
    currency: 'KWD',
    status: 'PENDING',
  })

  assert.ok(event)
  assert.equal(event.type, 'DAILY_BATCH_REVENUE_DEFERRAL')
  assert.equal(event.sourceEntityType, 'DailyBatch')
  assert.equal(event.sourceEntityId, 'A1-2026-04-26')
  assert.equal(event.businessDate.toISOString(), '2026-04-26T00:00:00.000Z')
  assert.equal(event.currency, 'KWD')
  assert.equal(event.status, 'PENDING')
  assert.equal(event.externalSystem, 'xero')
  assert.equal(event.idempotencyKey, 'accounting-sync:xero:daily_batch_revenue_deferral:dailybatch:a1-2026-04-26:2026-04-26')
  assert.deepEqual(event.linesJson, [
    { accountCode: '400', description: 'Daily revenue deferral', debit: 12.345 },
    { accountCode: '210', description: 'Daily revenue deferral', credit: 12.345 },
  ])
})

test('refund reversal sync log payload mirrors using the existing idempotency key', () => {
  const event = buildMirroredAccountingEventDraft({
    connector: 'quickbooks',
    type: 'COGS_REVERSAL',
    referenceType: 'SalesOrderRefund',
    referenceId: 'refund-1',
    currency: 'GBP',
    status: 'SYNCED',
    externalId: 'journal-1',
    payload: {
      date: '2026-04-26',
      _idempotencyKey: 'sales-order-refund:refund-1:cogs-reversal',
      lines: [
        { accountCode: '120', description: 'COGS reversal', debit: 10.005 },
        { accountCode: '500', description: 'COGS reversal', credit: 10.005 },
      ],
    },
  })

  assert.ok(event)
  assert.equal(event.status, 'POSTED')
  assert.equal(event.externalSystem, 'quickbooks')
  assert.equal(event.externalId, 'journal-1')
  assert.equal(event.idempotencyKey, 'accounting-sync:quickbooks:cogs_reversal:sales-order-refund:refund-1:cogs-reversal')
  assert.deepEqual(event.linesJson, [
    { accountCode: '120', description: 'COGS reversal', debit: 10.01 },
    { accountCode: '500', description: 'COGS reversal', credit: 10.01 },
  ])
})

test('credit note sync logs mirror as document-shaped accounting events', () => {
  assert.equal(isMirrorableAccountingSyncType('CREDIT_NOTE'), true)
  const event = buildMirroredAccountingEventDraft({
    connector: 'xero',
    type: 'CREDIT_NOTE',
    referenceType: 'SalesOrderRefund',
    referenceId: 'refund-1',
    currency: 'GBP',
    status: 'PENDING',
    payload: {
      _idempotencyKey: 'sales-order-refund:refund-1:credit-note',
      creditNoteNumber: 'CN-1001',
      contactName: 'Customer One',
      contactEmail: 'customer@example.com',
      date: '2026-04-26',
      currency: 'EUR',
      currencyRateToBase: 1.18,
      reference: 'SO-1001',
      lineAmountsIncludeTax: false,
      lines: [{ description: 'Refund line', quantity: 1, unitAmount: 10, accountCode: '400', taxType: 'OUTPUT2' }],
    },
  })

  assert.ok(event)
  assert.equal(event.type, 'CREDIT_NOTE')
  assert.equal(event.currency, 'EUR')
  assert.equal(event.idempotencyKey, 'accounting-sync:xero:credit_note:sales-order-refund:refund-1:credit-note')
  assert.deepEqual(event.linesJson, {
    kind: 'accounting-document',
    schemaVersion: 1,
    documentType: 'CREDIT_NOTE',
    documentNumber: 'CN-1001',
    creditNoteNumber: 'CN-1001',
    contact: { name: 'Customer One', email: 'customer@example.com' },
    date: '2026-04-26',
    currency: 'EUR',
    currencyRateToBase: 1.18,
    reference: 'SO-1001',
    lineAmountMode: 'EXCLUSIVE',
    lineAmountsIncludeTax: false,
    sourceRefundId: 'refund-1',
    lines: [{ description: 'Refund line', quantity: 1, unitAmount: 10, accountCode: '400', taxType: 'OUTPUT2' }],
  })
})

test('sales and purchase document sync logs mirror with stable document keys', () => {
  const sales = buildMirroredAccountingEventDraft({
    connector: 'quickbooks',
    type: 'SALES_INVOICE',
    referenceType: 'SalesOrder',
    referenceId: 'order-1',
    currency: 'GBP',
    payload: {
      _idempotencyKey: 'sales-order:order-1:invoice',
      invoiceNumber: 'INV-1001',
      contactName: 'Customer One',
      date: '2026-04-26',
      currency: 'USD',
      lines: [{ description: 'Item', quantity: 2, unitAmount: 10.1234, accountCode: '400', taxType: 'OUTPUT2' }],
      lineAmountsIncludeTax: true,
    },
  })
  const purchase = buildMirroredAccountingEventDraft({
    connector: 'xero',
    type: 'PURCHASE_INVOICE',
    referenceType: 'PurchaseOrder',
    referenceId: 'po-1',
    currency: 'GBP',
    payload: {
      _idempotencyKey: 'purchase-invoice:po-1:abc123',
      invoiceNumber: 'SUP-123',
      contactName: 'Supplier Ltd',
      date: '2026-04-26',
      dueDate: '2026-05-10',
      currency: 'EUR',
      reference: 'PO-1',
      supplierInvoicePath: 'uploads/supplier/SUP-123.pdf',
      lines: [{ description: 'PO line', quantity: 5, unitAmount: 4.5678, accountCode: '150', taxType: 'INPUT2' }],
    },
  })

  assert.ok(sales)
  assert.equal(sales.idempotencyKey, 'accounting-sync:quickbooks:sales_invoice:sales-order:order-1:invoice')
  assert.equal(sales.currency, 'USD')
  assert.equal((sales.linesJson as Record<string, unknown>).lineAmountMode, 'INCLUSIVE')
  assert.ok(purchase)
  assert.equal(purchase.idempotencyKey, 'accounting-sync:xero:purchase_invoice:purchase-invoice:po-1:abc123')
  assert.equal(purchase.currency, 'EUR')
  assert.equal((purchase.linesJson as Record<string, unknown>).supplierInvoicePath, 'uploads/supplier/SUP-123.pdf')
})

test('reruns build the same deterministic accounting event key', () => {
  const params = {
    connector: 'xero',
    type: 'DAILY_BATCH_GROUP_B',
    referenceType: 'DailyBatch',
    referenceId: 'B-2026-04-26',
    currency: 'GBP',
    payload: {
      date: '2026-04-26',
      lines: [
        { accountCode: '210', description: 'Revenue recognition', debit: 10 },
        { accountCode: '400', description: 'Revenue recognition', credit: 10 },
      ],
    },
  }

  const first = buildMirroredAccountingEventDraft(params)
  const second = buildMirroredAccountingEventDraft(params)

  assert.ok(first)
  assert.ok(second)
  assert.equal(first.idempotencyKey, second.idempotencyKey)
})

test('sync success updates mirrored daily batch event to posted with external id', async () => {
  const updates: unknown[] = []
  const logs: unknown[] = []
  const client = {
    accountingEvent: {
      update: async (args: unknown) => {
        updates.push(args)
        return { id: 'event-1' }
      },
    },
    accountingEventLog: {
      create: async (args: unknown) => {
        logs.push(args)
        return { id: 'log-1' }
      },
    },
  }

  await updateMirroredAccountingEventStatus(client as never, {
    connector: 'xero',
    type: 'DAILY_BATCH_GROUP_B',
    referenceType: 'DailyBatch',
    referenceId: 'B-2026-04-26',
    payload: {
      date: '2026-04-26',
      lines: [
        { accountCode: '210', description: 'Revenue recognition', debit: 10 },
        { accountCode: '400', description: 'Revenue recognition', credit: 10 },
      ],
    },
    status: 'POSTED',
    externalId: 'journal-1',
  })

  assert.deepEqual(updates, [{
    where: { idempotencyKey: 'accounting-sync:xero:daily_batch_group_b:dailybatch:b-2026-04-26:2026-04-26' },
    data: { status: 'POSTED', externalId: 'journal-1' },
    select: { id: true },
  }])
  assert.deepEqual(logs, [{
    data: {
      accountingEventId: 'event-1',
      action: 'posted_from_sync_log',
      metadata: {
        connector: 'xero',
        syncType: 'DAILY_BATCH_GROUP_B',
        referenceType: 'DailyBatch',
        referenceId: 'B-2026-04-26',
        externalId: 'journal-1',
      },
    },
  }])
})

test('terminal sync failure updates mirrored refund reversal event to failed', async () => {
  const updates: unknown[] = []
  const logs: unknown[] = []
  const client = {
    accountingEvent: {
      update: async (args: unknown) => {
        updates.push(args)
        return { id: 'event-1' }
      },
    },
    accountingEventLog: {
      create: async (args: unknown) => {
        logs.push(args)
        return { id: 'log-1' }
      },
    },
  }

  await updateMirroredAccountingEventStatus(client as never, {
    connector: 'quickbooks',
    type: 'COGS_REVERSAL',
    referenceType: 'SalesOrderRefund',
    referenceId: 'refund-1',
    payload: {
      date: '2026-04-26',
      _idempotencyKey: 'sales-order-refund:refund-1:cogs-reversal',
      lines: [
        { accountCode: '120', description: 'COGS reversal', debit: 10 },
        { accountCode: '500', description: 'COGS reversal', credit: 10 },
      ],
    },
    status: 'FAILED',
    message: 'connector failed',
  })

  assert.deepEqual(updates, [{
    where: { idempotencyKey: 'accounting-sync:quickbooks:cogs_reversal:sales-order-refund:refund-1:cogs-reversal' },
    data: { status: 'FAILED' },
    select: { id: true },
  }])
  assert.deepEqual(logs, [{
    data: {
      accountingEventId: 'event-1',
      action: 'failed_from_sync_log',
      message: 'connector failed',
      metadata: {
        connector: 'quickbooks',
        syncType: 'COGS_REVERSAL',
        referenceType: 'SalesOrderRefund',
        referenceId: 'refund-1',
        externalId: null,
      },
    },
  }])
})

test('failed daily batch mirror reset moves matching events back to pending', async () => {
  const findManyArgs: unknown[] = []
  const updateManyArgs: unknown[] = []
  const createManyArgs: unknown[] = []
  const client = {
    accountingEvent: {
      findMany: async (args: unknown) => {
        findManyArgs.push(args)
        return [{
          id: 'event-1',
          type: 'DAILY_BATCH_REVENUE_DEFERRAL',
          sourceEntityType: 'DailyBatch',
          sourceEntityId: 'A1-2026-04-26',
        }]
      },
      updateMany: async (args: unknown) => {
        updateManyArgs.push(args)
        return { count: 1 }
      },
    },
    accountingEventLog: {
      createMany: async (args: unknown) => {
        createManyArgs.push(args)
        return { count: 1 }
      },
    },
  }

  await resetMirroredAccountingEventsToPending(client as never, {
    connector: 'xero',
    types: ['DAILY_BATCH_REVENUE_DEFERRAL', 'CREDIT_NOTE'],
    referenceType: 'DailyBatch',
    referenceIds: ['A1-2026-04-26', 'A1-2026-04-26', ''],
  })

  assert.deepEqual(findManyArgs, [{
    where: {
      externalSystem: 'xero',
      type: { in: ['DAILY_BATCH_REVENUE_DEFERRAL', 'CREDIT_NOTE'] },
      sourceEntityType: 'DailyBatch',
      sourceEntityId: { in: ['A1-2026-04-26'] },
      status: 'FAILED',
    },
    select: {
      id: true,
      type: true,
      sourceEntityType: true,
      sourceEntityId: true,
    },
  }])
  assert.deepEqual(updateManyArgs, [{
    where: { id: { in: ['event-1'] } },
    data: {
      status: 'PENDING',
      externalId: null,
    },
  }])
  assert.deepEqual(createManyArgs, [{
    data: [{
      accountingEventId: 'event-1',
      action: 'reset_from_sync_log',
      metadata: {
        connector: 'xero',
        syncType: 'DAILY_BATCH_REVENUE_DEFERRAL',
        referenceType: 'DailyBatch',
        referenceId: 'A1-2026-04-26',
      },
    }],
  }])
})
