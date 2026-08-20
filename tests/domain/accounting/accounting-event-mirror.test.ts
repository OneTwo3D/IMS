import assert from 'node:assert/strict'
import test from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'

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

test('sales and purchase document update sync logs mirror as document events', () => {
  assert.equal(isMirrorableAccountingSyncType('SALES_INVOICE_UPDATE'), true)
  assert.equal(isMirrorableAccountingSyncType('PURCHASE_INVOICE_UPDATE'), true)

  const sales = buildMirroredAccountingEventDraft({
    connector: 'xero',
    type: 'SALES_INVOICE_UPDATE',
    referenceType: 'SalesOrder',
    referenceId: 'order-1',
    currency: 'GBP',
    payload: {
      _idempotencyKey: 'sales-invoice-update:order-1:invoice-1:abc123',
      accountingInvoiceId: 'invoice-1',
      invoiceNumber: 'INV-1001',
      contactName: 'Customer One',
      date: '2026-06-12',
      currency: 'EUR',
      lines: [{ description: 'Item', quantity: 1, unitAmount: 10, accountCode: '400' }],
    },
  })
  const purchase = buildMirroredAccountingEventDraft({
    connector: 'xero',
    type: 'PURCHASE_INVOICE_UPDATE',
    referenceType: 'PurchaseInvoice',
    referenceId: 'purchase-invoice-1',
    currency: 'GBP',
    payload: {
      _idempotencyKey: 'purchase-invoice-update:purchase-invoice-1:bill-1:abc123',
      accountingInvoiceId: 'bill-1',
      invoiceNumber: 'SUP-123',
      contactName: 'Supplier Ltd',
      date: '2026-06-12',
      currency: 'USD',
      lines: [{ description: 'PO line', quantity: 2, unitAmount: 5, accountCode: '150' }],
    },
  })

  assert.ok(sales)
  assert.equal(sales.type, 'SALES_INVOICE_UPDATE')
  assert.equal(sales.idempotencyKey, 'accounting-sync:xero:sales_invoice_update:sales-invoice-update:order-1:invoice-1:abc123')
  assert.equal((sales.linesJson as Record<string, unknown>).documentType, 'SALES_INVOICE_UPDATE')
  assert.ok(purchase)
  assert.equal(purchase.type, 'PURCHASE_INVOICE_UPDATE')
  assert.equal(purchase.idempotencyKey, 'accounting-sync:xero:purchase_invoice_update:purchase-invoice-update:purchase-invoice-1:bill-1:abc123')
  assert.equal((purchase.linesJson as Record<string, unknown>).documentType, 'PURCHASE_INVOICE_UPDATE')
})

test('malformed document sync log payloads surface validation errors', () => {
  assert.throws(() => buildMirroredAccountingEventDraft({
    connector: 'xero',
    type: 'CREDIT_NOTE',
    referenceType: 'SalesOrderRefund',
    referenceId: 'refund-1',
    currency: 'GBP',
    payload: {
      _idempotencyKey: 'sales-order-refund:refund-1:credit-note',
      contactName: 'Customer One',
      date: '2026-04-26',
      currency: 'GBP',
      lines: [{ description: 'Refund line', quantity: 0, unitAmount: 10, accountCode: '400' }],
    },
  }), /quantity must be positive/)
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

test('sync-log id disambiguates mirror keys when payload only has a date fallback', () => {
  const params = {
    connector: 'xero',
    type: 'DAILY_BATCH_REVENUE_DEFERRAL',
    referenceType: 'DailyBatch',
    referenceId: 'A1-2026-04-26',
    currency: 'GBP',
    payload: {
      date: '2026-04-26',
      lines: [
        { accountCode: '400', description: 'Daily revenue deferral', debit: 10 },
        { accountCode: '210', description: 'Daily revenue deferral', credit: 10 },
      ],
    },
  }

  const first = buildMirroredAccountingEventDraft({ ...params, syncLogId: 'sync-1' })
  const second = buildMirroredAccountingEventDraft({ ...params, syncLogId: 'sync-2' })

  assert.ok(first)
  assert.ok(second)
  assert.equal(first.idempotencyKey, 'accounting-sync-log:xero:sync-1')
  assert.equal(second.idempotencyKey, 'accounting-sync-log:xero:sync-2')
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

// ---------------------------------------------------------------------------------------------
// o3d-cvj9: a document REVISION posts against the external document that already exists, so its
// mirrored event and the event it revises compete for the one `(externalSystem, externalId)` row
// the unique index allows.
//
// The double below is a table that ENFORCES both unique indexes on `accounting_events` and raises
// the P2002 from the statement that would violate one, with the meta shape `@prisma/adapter-pg`
// actually produces (captured from a rolled-back probe against onetwo3d_ims_dev: `meta.target` is
// undefined and the column list arrives quoted under
// `meta.driverAdapterError.cause.constraint.fields`). What it CANNOT express is Postgres aborting
// the transaction on 23505 — a double keeps answering queries after a throw. That half is covered
// against a real database in tests/concurrency/mirrored-document-revision.concurrent.test.ts.
// ---------------------------------------------------------------------------------------------

type FakeAccountingEventRow = {
  id: string
  type: string
  sourceEntityType: string
  sourceEntityId: string
  idempotencyKey: string
  status: string
  externalSystem: string | null
  externalId: string | null
  /**
   * o3d-cvj9 r2: WHEN the row was mirrored, which is when its sync log was ENQUEUED — so it orders
   * a document's edits even when the queue processes or replays them out of order. This is the only
   * thing that distinguishes "a newer revision taking over" from "a stale replay taking back".
   */
  createdAt: Date
}

function uniqueViolation(fields: string[]): Error {
  return new Prisma.PrismaClientKnownRequestError(
    `Unique constraint failed on the fields: (${fields.map((field) => `\`"${field}"\``).join(', ')})`,
    {
      code: 'P2002',
      clientVersion: 'test',
      meta: {
        modelName: 'AccountingEvent',
        driverAdapterError: {
          name: 'DriverAdapterError',
          cause: {
            originalCode: '23505',
            originalMessage: `duplicate key value violates unique constraint "accounting_events_${fields.join('_')}_key"`,
            kind: 'UniqueConstraintViolation',
            constraint: { fields: fields.map((field) => `"${field}"`) },
          },
        },
      },
    },
  )
}

function createAccountingEventStore(seed: FakeAccountingEventRow[]) {
  const table = seed.map((row) => ({ ...row }))
  const logs: Array<Record<string, unknown>> = []
  const statements: string[] = []

  function claimIsFree(row: FakeAccountingEventRow, externalSystem: string | null, externalId: string | null): boolean {
    if (externalId === null) return true
    return !table.some((other) => other.id !== row.id
      && other.externalSystem === externalSystem
      && other.externalId === externalId)
  }

  const client = {
    accountingEvent: {
      update: async (args: {
        where: { idempotencyKey?: string; id?: string }
        data: Record<string, unknown>
      }) => {
        statements.push('update')
        const row = table.find((candidate) => (args.where.idempotencyKey !== undefined
          ? candidate.idempotencyKey === args.where.idempotencyKey
          : candidate.id === args.where.id))
        if (!row) {
          throw new Prisma.PrismaClientKnownRequestError('An operation failed because it depends on one or more records that were required but not found.', {
            code: 'P2025',
            clientVersion: 'test',
          })
        }
        const next = { ...row, ...args.data } as FakeAccountingEventRow
        if (!claimIsFree(row, next.externalSystem, next.externalId)) throw uniqueViolation(['externalSystem', 'externalId'])
        Object.assign(row, args.data)
        return { id: row.id }
      },
      updateMany: async (args: {
        where: { id?: string; externalSystem?: string; externalId?: string }
        data: Record<string, unknown>
      }) => {
        statements.push('updateMany')
        const matched = table.filter((row) => (args.where.id === undefined || row.id === args.where.id)
          && (args.where.externalSystem === undefined || row.externalSystem === args.where.externalSystem)
          && (args.where.externalId === undefined || row.externalId === args.where.externalId))
        for (const row of matched) Object.assign(row, args.data)
        return { count: matched.length }
      },
      findUnique: async (args: {
        where: { externalSystem_externalId?: { externalSystem: string; externalId: string }; idempotencyKey?: string }
      }) => {
        statements.push('findUnique')
        if (args.where.idempotencyKey !== undefined) {
          return table.find((row) => row.idempotencyKey === args.where.idempotencyKey) ?? null
        }
        const key = args.where.externalSystem_externalId
        if (!key) return null
        return table.find((row) => row.externalSystem === key.externalSystem && row.externalId === key.externalId) ?? null
      },
    },
    accountingEventLog: {
      create: async (args: { data: Record<string, unknown> }) => {
        statements.push('log')
        logs.push(args.data)
        return { id: `log-${logs.length}` }
      },
    },
  }

  return { table, logs, statements, client }
}

const REVISION_PAYLOAD = {
  _idempotencyKey: 'sales-invoice-update:so-1:INV-9',
  invoiceNumber: 'INV-1001',
  contactName: 'Customer One',
  date: '2026-08-19',
  currency: 'GBP',
  lines: [{ description: 'Widget', quantity: 1, unitAmount: 120, accountCode: '200' }],
}

const REVISION_EVENT_KEY = 'accounting-sync:xero:sales_invoice_update:sales-invoice-update:so-1:inv-9'

/** The document's original post — the earliest row in every fixture below. */
const CREATE_MIRRORED_AT = new Date('2026-08-19T09:00:00.000Z')
/** The edit under test, mirrored after the create. */
const REVISION_MIRRORED_AT = new Date('2026-08-19T10:00:00.000Z')

function invoiceCreateRow(overrides: Partial<FakeAccountingEventRow> = {}): FakeAccountingEventRow {
  return {
    id: 'event-create',
    type: 'SALES_INVOICE',
    sourceEntityType: 'SalesOrder',
    sourceEntityId: 'so-1',
    idempotencyKey: 'accounting-sync:xero:sales_invoice:sales-invoice:so-1',
    status: 'POSTED',
    externalSystem: 'xero',
    externalId: 'INV-9',
    createdAt: CREATE_MIRRORED_AT,
    ...overrides,
  }
}

function revisionRow(overrides: Partial<FakeAccountingEventRow> = {}): FakeAccountingEventRow {
  return {
    id: 'event-revision',
    type: 'SALES_INVOICE_UPDATE',
    sourceEntityType: 'SalesOrder',
    sourceEntityId: 'so-1',
    idempotencyKey: REVISION_EVENT_KEY,
    status: 'PENDING',
    externalSystem: 'xero',
    externalId: null,
    createdAt: REVISION_MIRRORED_AT,
    ...overrides,
  }
}

function postRevision(store: ReturnType<typeof createAccountingEventStore>, overrides: {
  status?: 'POSTED' | 'FAILED'
  type?: string
} = {}) {
  return updateMirroredAccountingEventStatus(store.client as never, {
    connector: 'xero',
    syncLogId: 'log-update',
    type: overrides.type ?? 'SALES_INVOICE_UPDATE',
    referenceType: 'SalesOrder',
    referenceId: 'so-1',
    payload: REVISION_PAYLOAD,
    status: overrides.status ?? 'POSTED',
    externalId: 'INV-9',
  })
}

test('a posted sales invoice revision takes the external id from the invoice event it revises', async () => {
  const store = createAccountingEventStore([invoiceCreateRow(), revisionRow()])

  await postRevision(store)

  assert.deepEqual(store.table.map((row) => ({ id: row.id, status: row.status, externalId: row.externalId })), [
    { id: 'event-create', status: 'SUPERSEDED', externalId: null },
    { id: 'event-revision', status: 'POSTED', externalId: 'INV-9' },
  ])
  // The rejected write, the read of the arriving row's own mirror time, the read of the holder, the
  // release of the claim, then the write that now succeeds — the P2002 is handled where it was
  // raised, not by rewriting the transition into something that cannot fail.
  assert.deepEqual(store.statements, ['update', 'findUnique', 'findUnique', 'updateMany', 'update', 'log', 'log'])
  assert.deepEqual(store.logs, [
    {
      accountingEventId: 'event-create',
      action: 'superseded_by_revision',
      metadata: {
        connector: 'xero',
        syncLogId: 'log-update',
        syncType: 'SALES_INVOICE_UPDATE',
        referenceType: 'SalesOrder',
        referenceId: 'so-1',
        externalId: 'INV-9',
        supersededByEventId: 'event-revision',
      },
    },
    {
      accountingEventId: 'event-revision',
      action: 'posted_from_sync_log',
      metadata: {
        connector: 'xero',
        syncLogId: 'log-update',
        syncType: 'SALES_INVOICE_UPDATE',
        referenceType: 'SalesOrder',
        referenceId: 'so-1',
        externalId: 'INV-9',
      },
    },
  ])
})

test('a revision does not take an external id that belongs to a different source document', async () => {
  const store = createAccountingEventStore([
    invoiceCreateRow({ id: 'event-other-order', sourceEntityId: 'so-2' }),
    revisionRow(),
  ])

  await assert.rejects(
    () => postRevision(store),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'P2002')
      assert.deepEqual(
        (error as { meta?: { driverAdapterError?: { cause?: { constraint?: unknown } } } }).meta?.driverAdapterError?.cause?.constraint,
        { fields: ['"externalSystem"', '"externalId"'] },
      )
      return true
    },
  )
  assert.deepEqual(store.table.map((row) => ({ id: row.id, status: row.status, externalId: row.externalId })), [
    { id: 'event-other-order', status: 'POSTED', externalId: 'INV-9' },
    { id: 'event-revision', status: 'PENDING', externalId: null },
  ])
  assert.deepEqual(store.logs, [], 'a rejected takeover must not be audited as one')
})

test('a revision does not take an external id held by an unrelated event type on the same order', async () => {
  const store = createAccountingEventStore([
    invoiceCreateRow({ id: 'event-credit-note', type: 'CREDIT_NOTE' }),
    revisionRow(),
  ])

  await assert.rejects(() => postRevision(store), (error: unknown) => (error as { code?: string }).code === 'P2002')
  assert.equal(store.table[0].status, 'POSTED')
  assert.equal(store.table[0].externalId, 'INV-9')
  assert.deepEqual(store.logs, [])
})

test('a FAILED transition never takes over an external id', async () => {
  const store = createAccountingEventStore([invoiceCreateRow(), revisionRow()])

  await assert.rejects(
    () => postRevision(store, { status: 'FAILED' }),
    (error: unknown) => (error as { code?: string }).code === 'P2002',
  )
  assert.equal(store.table[0].status, 'POSTED', 'only a successful post owns a document id')
  assert.equal(store.table[0].externalId, 'INV-9')
})

test('a create-type event never takes over an external id another event holds', async () => {
  const store = createAccountingEventStore([
    invoiceCreateRow({ id: 'event-first-create' }),
    revisionRow({ id: 'event-second-create', type: 'SALES_INVOICE', idempotencyKey: 'accounting-sync:xero:sales_invoice:sales-invoice-update:so-1:inv-9' }),
  ])

  await assert.rejects(
    () => postRevision(store, { type: 'SALES_INVOICE' }),
    (error: unknown) => (error as { code?: string }).code === 'P2002',
    'two documents claiming one external id is the double post the unique index exists to catch',
  )
  assert.equal(store.table[0].status, 'POSTED')
  assert.equal(store.table[0].externalId, 'INV-9')
})

test('re-posting a revision that already holds the external id is a no-op, not a takeover', async () => {
  const store = createAccountingEventStore([
    invoiceCreateRow({ status: 'SUPERSEDED', externalId: null }),
    revisionRow({ status: 'POSTED', externalId: 'INV-9' }),
  ])

  await postRevision(store)

  assert.deepEqual(store.statements, ['update', 'log'], 'the retry path must not run when nothing conflicts')
  assert.deepEqual(store.table.map((row) => ({ id: row.id, status: row.status, externalId: row.externalId })), [
    { id: 'event-create', status: 'SUPERSEDED', externalId: null },
    { id: 'event-revision', status: 'POSTED', externalId: 'INV-9' },
  ])
})

// ---------------------------------------------------------------------------------------------
// o3d-cvj9 r2: r1 established that the holder was a legitimate PREDECESSOR TYPE for the same
// document, but never that the arriving revision was NEWER than it. Edits get replayed (a retry
// after a crash, a redelivered webhook) and processed out of order, so an OLDER revision could
// arrive after a newer one had already taken the id — and take it straight back, leaving the
// mirror naming a superseded edit as the document's current state.
// ---------------------------------------------------------------------------------------------

/** A LATER edit of the same invoice, already posted and already holding the document id. */
function newerRevisionRow(overrides: Partial<FakeAccountingEventRow> = {}): FakeAccountingEventRow {
  return {
    id: 'event-revision-newer',
    type: 'SALES_INVOICE_UPDATE',
    sourceEntityType: 'SalesOrder',
    sourceEntityId: 'so-1',
    idempotencyKey: 'accounting-sync:xero:sales_invoice_update:sales-invoice-update:so-1:inv-9:later',
    status: 'POSTED',
    externalSystem: 'xero',
    externalId: 'INV-9',
    createdAt: new Date('2026-08-19T11:00:00.000Z'),
    ...overrides,
  }
}

test('o3d-cvj9 r2: a replayed OLDER revision does not take the document id back off a newer one', async () => {
  const store = createAccountingEventStore([
    // The original post, already handed over.
    invoiceCreateRow({ status: 'SUPERSEDED', externalId: null }),
    // Edit 1 — posted, then superseded by edit 2 below. This is the row being replayed.
    revisionRow({ status: 'SUPERSEDED', externalId: null }),
    // Edit 2 — the current state of the document.
    newerRevisionRow(),
  ])

  await postRevision(store)

  assert.deepEqual(store.table.map((row) => ({ id: row.id, status: row.status, externalId: row.externalId })), [
    { id: 'event-create', status: 'SUPERSEDED', externalId: null },
    // The replay is recorded for what it is, and claims nothing.
    { id: 'event-revision', status: 'SUPERSEDED', externalId: null },
    // Untouched: the newest edit still names the document.
    { id: 'event-revision-newer', status: 'POSTED', externalId: 'INV-9' },
  ])
  assert.equal(
    store.logs.find((entry) => entry.action === 'superseded_by_revision'),
    undefined,
    'a stale replay must never be audited as a takeover',
  )
  const declined = store.logs.find((entry) => entry.action === 'revision_superseded_by_newer')
  assert.ok(declined, 'the declined claim is audited on the arriving row')
  assert.equal((declined!.metadata as { externalIdHeldByEventId?: string }).externalIdHeldByEventId, 'event-revision-newer')
})

test('o3d-cvj9 r2: replaying the stale revision again is idempotent, not a fresh supersession', async () => {
  const store = createAccountingEventStore([
    invoiceCreateRow({ status: 'SUPERSEDED', externalId: null }),
    revisionRow({ status: 'SUPERSEDED', externalId: null }),
    newerRevisionRow(),
  ])

  await postRevision(store)
  await postRevision(store)

  assert.equal(store.table.find((row) => row.id === 'event-revision-newer')?.externalId, 'INV-9')
  assert.equal(store.table.find((row) => row.id === 'event-revision')?.status, 'SUPERSEDED')
})

// `now()` is TRANSACTION start time in Postgres, so events mirrored inside one transaction all
// carry the same stamp — the ordinary case when a document's create and its first edit are enqueued
// together, not an exotic one. The row id breaks that tie, and the two tests below pin BOTH
// directions of it, because a tie-break that only ever answers "takeover" is not one.

test('o3d-cvj9 r2: on an identical mirror timestamp the row order decides — an EARLIER row hands over', async () => {
  const store = createAccountingEventStore([
    invoiceCreateRow({ status: 'SUPERSEDED', externalId: null }),
    revisionRow(),
    // Same stamp, and minted BEFORE the arriving revision (`event-earlier-edit` < `event-revision`).
    newerRevisionRow({ id: 'event-earlier-edit', createdAt: REVISION_MIRRORED_AT }),
  ])

  await postRevision(store)

  assert.equal(store.table.find((row) => row.id === 'event-earlier-edit')?.status, 'SUPERSEDED')
  assert.equal(store.table.find((row) => row.id === 'event-revision')?.externalId, 'INV-9')
})

test('o3d-cvj9 r2: on an identical mirror timestamp a LATER row is not handed over to', async () => {
  const store = createAccountingEventStore([
    invoiceCreateRow({ status: 'SUPERSEDED', externalId: null }),
    revisionRow(),
    // Same stamp, minted AFTER the arriving revision (`event-revision` < `event-revision-newer`).
    newerRevisionRow({ createdAt: REVISION_MIRRORED_AT }),
  ])

  await postRevision(store)

  assert.equal(store.table.find((row) => row.id === 'event-revision-newer')?.externalId, 'INV-9')
  assert.equal(store.table.find((row) => row.id === 'event-revision')?.status, 'SUPERSEDED')
  assert.equal(store.table.find((row) => row.id === 'event-revision')?.externalId, null)
})

test('o3d-cvj9 r2: a create and its revision enqueued in ONE transaction still hand over', async () => {
  // The everyday consequence of the tie-break: an invoice posted and edited inside one transaction
  // shares a stamp with its own revision, and the ordinary takeover has to keep working.
  const store = createAccountingEventStore([
    invoiceCreateRow({ createdAt: REVISION_MIRRORED_AT }),
    revisionRow(),
  ])

  await postRevision(store)

  assert.deepEqual(store.table.map((row) => ({ id: row.id, status: row.status, externalId: row.externalId })), [
    { id: 'event-create', status: 'SUPERSEDED', externalId: null },
    { id: 'event-revision', status: 'POSTED', externalId: 'INV-9' },
  ])
})
