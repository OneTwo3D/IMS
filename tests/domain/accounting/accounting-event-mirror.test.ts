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
   * o3d-cvj9 r2's ordering key: when the row was mirrored. It is kept on the double ON PURPOSE,
   * even though production no longer reads it, so the fixtures below can set it to the value that
   * would make r2 answer "takeover" and prove r3 does not answer from it. Its column default is
   * `CURRENT_TIMESTAMP` — transaction START time — so it never carried edit order at all.
   */
  createdAt: Date
  /**
   * o3d-cvj9 r3: the stamp the EXTERNAL system put on the document as it applied this row's write
   * (Xero's `Invoice.UpdatedDateUTC`). Two writes to one invoice are serialised by Xero on one
   * clock, so these stamps are the order the edits were applied — the only order that says which
   * event describes the document now. `null` means "not established", never "oldest".
   */
  externalRevisionAt: Date | null
  /**
   * o3d-cvj9 r4: how a row with NO stamp may still be ordered against another revision. The only
   * value production writes is `historical_backfill_repair`, stamped by the administrative
   * backfill; it is a CATEGORY, not a clock. `null` on every live row — a live write records its
   * external stamp instead.
   */
  revisionOrderBasis: string | null
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

// ---------------------------------------------------------------------------------------------
// FIXTURE CLOCKS. Two different quantities, deliberately set AGAINST each other in several tests
// below so a fixture can distinguish "r3 ordered these correctly" from "r2's key happened to
// agree".
//
//  - *_MIRRORED_AT      — `accounting_events.createdAt`, r2's ordering key. Its column default is
//                         `CURRENT_TIMESTAMP`, which PostgreSQL evaluates at TRANSACTION START, so
//                         it is neither edit order nor enqueue order. Production no longer reads it.
//  - *_XERO_REVISION_AT — `externalRevisionAt`, the stamp Xero put on the invoice as it applied the
//                         write. This is what r3 orders by.
// ---------------------------------------------------------------------------------------------

/** The document's original post. */
const CREATE_MIRRORED_AT = new Date('2026-08-19T09:00:00.000Z')
/** The edit under test, mirrored after the create. */
const REVISION_MIRRORED_AT = new Date('2026-08-19T10:00:00.000Z')
/** Xero's stamp for the edit under test, when the fixture gives it one. */
const REVISION_XERO_REVISION_AT = new Date('2026-08-19T10:00:05.500Z')

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
    // Deliberately unstamped: every document created before `externalRevisionAt` existed looks
    // like this, and its first edit still has to be able to take the id.
    externalRevisionAt: null,
    revisionOrderBasis: null,
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
    externalRevisionAt: null,
    revisionOrderBasis: null,
    ...overrides,
  }
}

function postRevision(store: ReturnType<typeof createAccountingEventStore>, overrides: {
  status?: 'POSTED' | 'FAILED'
  type?: string
  externalRevisionAt?: Date | null
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
    ...('externalRevisionAt' in overrides ? { externalRevisionAt: overrides.externalRevisionAt } : {}),
  })
}

test('a posted sales invoice revision takes the external id from the invoice event it revises', async () => {
  const store = createAccountingEventStore([invoiceCreateRow(), revisionRow()])

  await postRevision(store, { externalRevisionAt: REVISION_XERO_REVISION_AT })

  assert.deepEqual(store.table.map((row) => ({ id: row.id, status: row.status, externalId: row.externalId })), [
    { id: 'event-create', status: 'SUPERSEDED', externalId: null },
    { id: 'event-revision', status: 'POSTED', externalId: 'INV-9' },
  ])
  // The rejected write, the read of the holder, the release of the claim, then the write that now
  // succeeds — the P2002 is handled where it was raised, not by rewriting the transition into
  // something that cannot fail. r2 read the ARRIVING row here too, for a `createdAt` that never
  // meant what it was read for; r3 does not need it and does not read it.
  assert.deepEqual(store.statements, ['update', 'findUnique', 'updateMany', 'update', 'log', 'log'])
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
    () => postRevision(store, { externalRevisionAt: REVISION_XERO_REVISION_AT }),
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

  await assert.rejects(
    () => postRevision(store, { externalRevisionAt: REVISION_XERO_REVISION_AT }),
    (error: unknown) => (error as { code?: string }).code === 'P2002',
  )
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
    () => postRevision(store, { type: 'SALES_INVOICE', externalRevisionAt: REVISION_XERO_REVISION_AT }),
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

  await postRevision(store, { externalRevisionAt: REVISION_XERO_REVISION_AT })

  assert.deepEqual(store.statements, ['update', 'log'], 'the retry path must not run when nothing conflicts')
  assert.deepEqual(store.table.map((row) => ({ id: row.id, status: row.status, externalId: row.externalId })), [
    { id: 'event-create', status: 'SUPERSEDED', externalId: null },
    { id: 'event-revision', status: 'POSTED', externalId: 'INV-9' },
  ])
})

// ---------------------------------------------------------------------------------------------
// o3d-cvj9 r3 — WHICH OF TWO EVENTS DESCRIBES THE DOCUMENT NOW.
//
// r1 established that the holder was a legitimate PREDECESSOR TYPE for the same document but never
// that the arriving revision described a LATER state. r2 answered that from the mirrored event's
// `createdAt`, on the argument that the row is written at enqueue. The column default is
// `CURRENT_TIMESTAMP` — TRANSACTION START time, verified against onetwo3d_ims_dev in a rolled-back
// transaction — so an enqueue inside a long transaction stamps EARLIER than one that began and
// committed after it. The row-`id` tie-break r2 layered on top is cuid mint time: the same quantity
// again.
//
// r3 orders by the only two things that are true:
//   1. a document must exist before it can be revised, so its CREATE precedes every revision;
//   2. revision against revision is ordered by the stamp XERO put on the document as it applied
//      each write, or it is not ordered at all.
// ---------------------------------------------------------------------------------------------

/** A revision of the same invoice that already posted and already holds the document id. */
function holdingRevisionRow(overrides: Partial<FakeAccountingEventRow> = {}): FakeAccountingEventRow {
  return {
    id: 'event-revision-holder',
    type: 'SALES_INVOICE_UPDATE',
    sourceEntityType: 'SalesOrder',
    sourceEntityId: 'so-1',
    idempotencyKey: 'accounting-sync:xero:sales_invoice_update:sales-invoice-update:so-1:inv-9:other',
    status: 'POSTED',
    externalSystem: 'xero',
    externalId: 'INV-9',
    createdAt: new Date('2026-08-19T11:00:00.000Z'),
    externalRevisionAt: null,
    revisionOrderBasis: null,
    ...overrides,
  }
}

test('o3d-cvj9 r3: a revision takes the id from its document CREATE with no revision stamp anywhere', async () => {
  // The whole pre-existing population: a document posted before `externalRevisionAt` existed, edited
  // after. Nothing has a stamp, and the handover must still happen — it is provable without one.
  const store = createAccountingEventStore([
    invoiceCreateRow({ externalRevisionAt: null }),
    revisionRow({ externalRevisionAt: null }),
  ])

  await postRevision(store, { externalRevisionAt: null })

  assert.deepEqual(store.table.map((row) => ({ id: row.id, status: row.status, externalId: row.externalId })), [
    { id: 'event-create', status: 'SUPERSEDED', externalId: null },
    { id: 'event-revision', status: 'POSTED', externalId: 'INV-9' },
  ])
  assert.equal(
    store.logs.find((entry) => entry.action === 'superseded_by_revision')?.accountingEventId,
    'event-create',
  )
})

test('o3d-cvj9 r3: the posted revision records the stamp Xero returned for its own write', async () => {
  const store = createAccountingEventStore([invoiceCreateRow(), revisionRow()])

  await postRevision(store, { externalRevisionAt: REVISION_XERO_REVISION_AT })

  assert.deepEqual(
    store.table.find((row) => row.id === 'event-revision')?.externalRevisionAt,
    REVISION_XERO_REVISION_AT,
    'the stamp is the ordering key for the NEXT revision, so the write that establishes it must persist it',
  )
})

test('o3d-cvj9 r3: a revision Xero applied LATER takes the id off the revision it overwrote', async () => {
  const store = createAccountingEventStore([
    invoiceCreateRow({ status: 'SUPERSEDED', externalId: null }),
    revisionRow(),
    holdingRevisionRow({
      // Xero applied the holder's write first...
      externalRevisionAt: new Date('2026-08-19T10:00:01.000Z'),
      // ...but it was MIRRORED later, so r2's key would have called this arrival the stale one.
      createdAt: new Date('2026-08-19T23:00:00.000Z'),
    }),
  ])

  // ...and applied the arriving write afterwards, so the arriving write is what the invoice says.
  await postRevision(store, { externalRevisionAt: new Date('2026-08-19T10:00:02.000Z') })

  assert.deepEqual(store.table.map((row) => ({ id: row.id, status: row.status, externalId: row.externalId })), [
    { id: 'event-create', status: 'SUPERSEDED', externalId: null },
    { id: 'event-revision', status: 'POSTED', externalId: 'INV-9' },
    { id: 'event-revision-holder', status: 'SUPERSEDED', externalId: null },
  ])
  assert.equal(
    store.logs.find((entry) => entry.action === 'superseded_by_revision')?.accountingEventId,
    'event-revision-holder',
  )
})

test('o3d-cvj9 r3: a revision Xero applied EARLIER does not take the id off the one applied after it', async () => {
  const store = createAccountingEventStore([
    invoiceCreateRow({ status: 'SUPERSEDED', externalId: null }),
    revisionRow(),
    holdingRevisionRow({
      externalRevisionAt: new Date('2026-08-19T10:00:09.000Z'),
      // Mirrored EARLIER than the arriving row, so r2's key would have handed the claim over.
      createdAt: new Date('2026-08-19T09:30:00.000Z'),
    }),
  ])

  await postRevision(store, { externalRevisionAt: new Date('2026-08-19T10:00:02.000Z') })

  assert.deepEqual(store.table.map((row) => ({ id: row.id, status: row.status, externalId: row.externalId })), [
    { id: 'event-create', status: 'SUPERSEDED', externalId: null },
    // Recorded for what it is, claiming nothing: this write did land, and was then overwritten.
    { id: 'event-revision', status: 'SUPERSEDED', externalId: null },
    { id: 'event-revision-holder', status: 'POSTED', externalId: 'INV-9' },
  ])
  assert.equal(
    store.logs.find((entry) => entry.action === 'superseded_by_revision'),
    undefined,
    'an overwritten write must never be audited as a takeover',
  )
  const declined = store.logs.find((entry) => entry.action === 'revision_superseded_by_newer')
  assert.ok(declined, 'the declined claim is audited on the arriving row')
  assert.equal((declined!.metadata as { externalIdHeldByEventId?: string }).externalIdHeldByEventId, 'event-revision-holder')
})

test('o3d-cvj9 r3: the overwritten revision still records the stamp of the write it made', async () => {
  const overwrittenAt = new Date('2026-08-19T10:00:02.000Z')
  const store = createAccountingEventStore([
    invoiceCreateRow({ status: 'SUPERSEDED', externalId: null }),
    revisionRow(),
    holdingRevisionRow({ externalRevisionAt: new Date('2026-08-19T10:00:09.000Z') }),
  ])

  await postRevision(store, { externalRevisionAt: overwrittenAt })

  assert.deepEqual(store.table.find((row) => row.id === 'event-revision')?.externalRevisionAt, overwrittenAt)
  assert.equal(store.table.find((row) => row.id === 'event-revision')?.externalId, null)
})

test('o3d-cvj9 r3: replaying the overwritten revision again is idempotent, not a fresh supersession', async () => {
  const store = createAccountingEventStore([
    invoiceCreateRow({ status: 'SUPERSEDED', externalId: null }),
    revisionRow({ status: 'SUPERSEDED', externalId: null }),
    holdingRevisionRow({ externalRevisionAt: new Date('2026-08-19T10:00:09.000Z') }),
  ])

  await postRevision(store, { externalRevisionAt: new Date('2026-08-19T10:00:02.000Z') })
  await postRevision(store, { externalRevisionAt: new Date('2026-08-19T10:00:02.000Z') })

  assert.equal(store.table.find((row) => row.id === 'event-revision-holder')?.externalId, 'INV-9')
  assert.equal(store.table.find((row) => row.id === 'event-revision')?.status, 'SUPERSEDED')
})

test('o3d-cvj9 r3: two revisions with no external stamp are refused, not ordered by mirror time', async () => {
  const store = createAccountingEventStore([
    invoiceCreateRow({ status: 'SUPERSEDED', externalId: null }),
    revisionRow(),
    // Unstamped, and mirrored an hour BEFORE the arriving row — r2 would have handed the claim over
    // on exactly this fixture. There is nothing here that orders the two writes, so nothing may.
    holdingRevisionRow({ externalRevisionAt: null, createdAt: new Date('2026-08-19T09:00:00.000Z') }),
  ])

  await assert.rejects(
    () => postRevision(store, { externalRevisionAt: null }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'P2002')
      assert.deepEqual(
        (error as { meta?: { driverAdapterError?: { cause?: { constraint?: unknown } } } }).meta?.driverAdapterError?.cause?.constraint,
        { fields: ['"externalSystem"', '"externalId"'] },
        'refusing must leave the unique violation fatal, so the sync log retries and an operator sees it',
      )
      return true
    },
  )
  assert.equal(store.table.find((row) => row.id === 'event-revision-holder')?.externalId, 'INV-9')
  assert.equal(store.table.find((row) => row.id === 'event-revision')?.status, 'PENDING')
  assert.deepEqual(store.logs, [], 'an unordered pair is not audited as either a takeover or a supersession')
})

test('o3d-cvj9 r3: an unstamped HOLDER is not treated as older than a stamped arrival', async () => {
  const store = createAccountingEventStore([
    invoiceCreateRow({ status: 'SUPERSEDED', externalId: null }),
    revisionRow(),
    holdingRevisionRow({ externalRevisionAt: null }),
  ])

  await assert.rejects(
    () => postRevision(store, { externalRevisionAt: REVISION_XERO_REVISION_AT }),
    (error: unknown) => (error as { code?: string }).code === 'P2002',
    'a missing stamp means "not established", never "oldest"',
  )
  assert.equal(store.table.find((row) => row.id === 'event-revision-holder')?.externalId, 'INV-9')
})

test('o3d-cvj9 r3: revisions Xero stamped at the same instant are refused, not tie-broken by row id', async () => {
  const sameInstant = new Date('2026-08-19T10:00:02.000Z')
  const store = createAccountingEventStore([
    invoiceCreateRow({ status: 'SUPERSEDED', externalId: null }),
    revisionRow(),
    // `event-earlier-edit` < `event-revision` as a string, so r2's cuid tie-break answered
    // "takeover" on precisely this shape. Equal stamps order nothing, so r3 refuses.
    holdingRevisionRow({ id: 'event-earlier-edit', externalRevisionAt: sameInstant, createdAt: REVISION_MIRRORED_AT }),
  ])

  await assert.rejects(
    () => postRevision(store, { externalRevisionAt: sameInstant }),
    (error: unknown) => (error as { code?: string }).code === 'P2002',
  )
  assert.equal(store.table.find((row) => row.id === 'event-earlier-edit')?.externalId, 'INV-9')
  assert.equal(store.table.find((row) => row.id === 'event-revision')?.status, 'PENDING')
})

test('o3d-cvj9 r3: a create and its revision enqueued in ONE transaction still hand over', async () => {
  // `now()` is transaction start time, so a document posted and edited inside one transaction gives
  // both rows an IDENTICAL `createdAt`. That is the ordinary case, and it never needed a tie-break:
  // the holder is the CREATE, and a document exists before it is revised.
  const store = createAccountingEventStore([
    invoiceCreateRow({ createdAt: REVISION_MIRRORED_AT }),
    revisionRow(),
  ])

  await postRevision(store, { externalRevisionAt: REVISION_XERO_REVISION_AT })

  assert.deepEqual(store.table.map((row) => ({ id: row.id, status: row.status, externalId: row.externalId })), [
    { id: 'event-create', status: 'SUPERSEDED', externalId: null },
    { id: 'event-revision', status: 'POSTED', externalId: 'INV-9' },
  ])
})

// ---------------------------------------------------------------------------------------------
// o3d-cvj9 r4 — Codex r3 finding 4: RULE 1 WAS NOT UNCONDITIONAL AFTER ALL.
//
// r3 answered "the holder is the CREATE" before it ever looked at the stamps, and justified it by
// saying a replayed create can never re-apply itself over an edit: the processor short-circuits a
// sync log that already carries an external id, and a genuine replay goes out under the same Xero
// `Idempotency-Key`, which returns the original record. Xero honours that key for SIX MINUTES.
// Past the window the request is a fresh one, and `POST /Invoices` with an `InvoiceNumber` that
// already exists UPDATES that invoice — so a create re-claimed and re-posted later really does
// write itself over an edit that landed in between, and Xero stamps that write.
// ---------------------------------------------------------------------------------------------

/** Xero's stamp for a create that was re-posted AFTER the edit under test had landed. */
const CREATE_REPOSTED_XERO_REVISION_AT = new Date('2026-08-19T10:05:00.000Z')
/** Xero's stamp for the edit under test, applied before that re-post. */
const EDIT_XERO_REVISION_AT = new Date('2026-08-19T10:00:02.000Z')

test('o3d-cvj9 r4: a create Xero applied AFTER the edit keeps the id, and the edit is recorded superseded', async () => {
  const store = createAccountingEventStore([
    invoiceCreateRow({ externalRevisionAt: CREATE_REPOSTED_XERO_REVISION_AT }),
    revisionRow(),
  ])

  await postRevision(store, { externalRevisionAt: EDIT_XERO_REVISION_AT })

  assert.deepEqual(store.table.map((row) => ({ id: row.id, status: row.status, externalId: row.externalId })), [
    // The invoice says what the re-posted create says, so the create keeps the claim...
    { id: 'event-create', status: 'POSTED', externalId: 'INV-9' },
    // ...and the edit is recorded for what it is: it landed, and was then written over.
    { id: 'event-revision', status: 'SUPERSEDED', externalId: null },
  ])
  assert.equal(
    store.logs.find((entry) => entry.action === 'superseded_by_revision'),
    undefined,
    'an overwritten edit must never be audited as a takeover',
  )
  const declined = store.logs.find((entry) => entry.action === 'revision_superseded_by_newer')
  assert.ok(declined, 'the declined claim is audited on the arriving row')
  assert.equal((declined!.metadata as { externalIdHeldByEventId?: string }).externalIdHeldByEventId, 'event-create')
})

test('o3d-cvj9 r4: a STAMPED create is not handed over to a revision that brings no stamp', async () => {
  // The create has made a write whose time is known; the arrival has not. There is nothing to
  // decide the pair on, so it is refused — and refusing keeps the P2002 fatal and visible.
  const store = createAccountingEventStore([
    invoiceCreateRow({ externalRevisionAt: CREATE_REPOSTED_XERO_REVISION_AT }),
    revisionRow(),
  ])

  await assert.rejects(
    () => postRevision(store, { externalRevisionAt: null }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'P2002')
      assert.deepEqual(
        (error as { meta?: { driverAdapterError?: { cause?: { constraint?: unknown } } } }).meta?.driverAdapterError?.cause?.constraint,
        { fields: ['"externalSystem"', '"externalId"'] },
      )
      return true
    },
  )
  assert.equal(store.table.find((row) => row.id === 'event-create')?.externalId, 'INV-9')
  assert.equal(store.table.find((row) => row.id === 'event-revision')?.status, 'PENDING')
  assert.deepEqual(store.logs, [], 'a refused claim is audited as neither a takeover nor a supersession')
})

// ---------------------------------------------------------------------------------------------
// o3d-cvj9 r4 — Codex r3 finding 3: A BACKFILLED CLAIMANT MUST NOT POISON THE DOCUMENT FOR EVER.
//
// The administrative backfill repairs a historical post, and a historical sync log never recorded
// the connector response — so a repaired row that HOLDS the document id carries no stamp. Under r3
// nothing could order it: it is not the create, and it has no stamp. Every later live revision of
// that document was refused, permanently, and the ledger froze naming a historical edit as the
// document's current state.
//
// `revisionOrderBasis = 'historical_backfill_repair'` records the one provable fact instead: the
// write it mirrors was already complete when the backfill selected it, and the backfill only
// selects documents with NO mirrored revision event — so every live revision able to contend with
// it was enqueued afterwards. Causal, not a clock comparison.
// ---------------------------------------------------------------------------------------------

test('o3d-cvj9 r4: a live stamped revision takes the id from a BACKFILL-REPAIRED holder that has no stamp', async () => {
  const store = createAccountingEventStore([
    invoiceCreateRow({ status: 'SUPERSEDED', externalId: null }),
    revisionRow(),
    holdingRevisionRow({ externalRevisionAt: null, revisionOrderBasis: 'historical_backfill_repair' }),
  ])

  await postRevision(store, { externalRevisionAt: REVISION_XERO_REVISION_AT })

  assert.deepEqual(store.table.map((row) => ({ id: row.id, status: row.status, externalId: row.externalId })), [
    { id: 'event-create', status: 'SUPERSEDED', externalId: null },
    { id: 'event-revision', status: 'POSTED', externalId: 'INV-9' },
    { id: 'event-revision-holder', status: 'SUPERSEDED', externalId: null },
  ])
  assert.equal(
    store.logs.find((entry) => entry.action === 'superseded_by_revision')?.accountingEventId,
    'event-revision-holder',
  )
})

test('o3d-cvj9 r4: a backfill repair does not hand its claim to an arrival that brings no stamp either', async () => {
  // A SECOND administrative repair brings no stamp, so it is not a live write made after the first
  // repair existed and the causal argument does not reach it. Two historical writes, unordered.
  const store = createAccountingEventStore([
    invoiceCreateRow({ status: 'SUPERSEDED', externalId: null }),
    revisionRow(),
    holdingRevisionRow({ externalRevisionAt: null, revisionOrderBasis: 'historical_backfill_repair' }),
  ])

  await assert.rejects(
    () => postRevision(store, { externalRevisionAt: null }),
    (error: unknown) => (error as { code?: string }).code === 'P2002',
    'the basis says the holder is historical, not that anything unstamped is newer than it',
  )
  assert.equal(store.table.find((row) => row.id === 'event-revision-holder')?.externalId, 'INV-9')
  assert.equal(store.table.find((row) => row.id === 'event-revision')?.status, 'PENDING')
  assert.deepEqual(store.logs, [])
})

// ---------------------------------------------------------------------------------------------
// o3d-cvj9 r5 — Codex r4 finding 3: THE REPAIR MARKER MUST BE CLEARABLE BY LIVE OPERATION.
//
// A marker written by an administrative repair that no live operation can ever remove is a
// permanent fixture of the ledger placed there by a repair — the defect is the permanence, not what
// the marker says. Two things clear it now: any live write on the row replaces it with that write's
// stamp, and an arrival that made no write at all is recorded as the stale replay it is instead of
// failing the sync log for ever against a holder it can never out-order.
// ---------------------------------------------------------------------------------------------

test('o3d-cvj9 r5: a live stamped write clears the backfill repair marker off the row it wrote', async () => {
  const store = createAccountingEventStore([
    invoiceCreateRow(),
    revisionRow({ revisionOrderBasis: 'historical_backfill_repair' }),
  ])

  await postRevision(store, { externalRevisionAt: REVISION_XERO_REVISION_AT })

  const revision = store.table.find((row) => row.id === 'event-revision')
  assert.equal(revision?.externalId, 'INV-9', 'the write landed and the row holds the document')
  assert.deepEqual(revision?.externalRevisionAt, REVISION_XERO_REVISION_AT)
  assert.equal(
    revision?.revisionOrderBasis,
    null,
    'the row is ordered by a real external stamp now, so the repair category it was written with is spent',
  )
})

test('o3d-cvj9 r5: a replay that made NO connector write is recorded superseded, not refused for ever', async () => {
  // The processor's short-circuit: a sync log that already carries its document id is replayed
  // without calling Xero, so it can never acquire a stamp however many times it runs. Against a
  // BACKFILL-REPAIRED holder r4 had no rule for it — not the create rule, not the stamp rule, and
  // not the repair rule (which needs a stamped arrival) — so the P2002 stayed fatal and the sync log
  // retried to FAILED permanently, with nothing in live operation able to clear it.
  const store = createAccountingEventStore([
    invoiceCreateRow({ status: 'SUPERSEDED', externalId: null }),
    revisionRow(),
    holdingRevisionRow({ externalRevisionAt: null, revisionOrderBasis: 'historical_backfill_repair' }),
  ])

  await postRevision(store)

  assert.deepEqual(store.table.map((row) => ({ id: row.id, status: row.status, externalId: row.externalId })), [
    { id: 'event-create', status: 'SUPERSEDED', externalId: null },
    // It wrote nothing, so it cannot be the document's later state — recorded for what it is.
    { id: 'event-revision', status: 'SUPERSEDED', externalId: null },
    { id: 'event-revision-holder', status: 'POSTED', externalId: 'INV-9' },
  ])
  const declined = store.logs.find((entry) => entry.action === 'revision_superseded_by_newer')
  assert.ok(declined, 'the arrival records that it did not take the claim')
  assert.equal((declined!.metadata as { externalIdHeldByEventId?: string }).externalIdHeldByEventId, 'event-revision-holder')
  assert.equal(
    store.logs.find((entry) => entry.action === 'superseded_by_revision'),
    undefined,
    'nothing was superseded by this replay, so nothing may say so',
  )
  assert.equal(
    store.table.find((row) => row.id === 'event-revision-holder')?.revisionOrderBasis,
    'historical_backfill_repair',
    'a replay that wrote nothing does not clear the marker either — it just stops being fatal',
  )
})

// ---------------------------------------------------------------------------------------------
// o3d-cvj9 r5 — Codex r4 finding 4: A REPLAY PAST SIX MINUTES IS A FRESH CREATE.
//
// Xero retains an `Idempotency-Key` for SIX MINUTES. Past that the same request is a new one, and
// `POST /Invoices` carrying an `InvoiceNumber` that already exists UPDATES that invoice (whence
// o3d-batch-invnum, which owns invoice-number ownership). r4 answered this by comparing stamps
// before the create rule — necessary, and not sufficient, because it assumed the re-post came back
// WITH a stamp. When it does not, the mirror records `externalRevisionAt: null`, wiping whatever
// stamp the row had; and an unstamped create is exactly what the create rule reads as "this create
// has made no write, so it precedes every revision of the document".
// ---------------------------------------------------------------------------------------------

test('o3d-cvj9 r5: a create that re-posted WITHOUT a stamp does not hand the document to an older edit', async () => {
  const store = createAccountingEventStore([
    // The re-post landed, and Xero's response carried no readable UpdatedDateUTC — so the stamp is
    // gone and only the recorded write says the row wrote at all.
    invoiceCreateRow({ externalRevisionAt: null, revisionOrderBasis: 'live_write_unstamped' }),
    revisionRow(),
  ])

  await assert.rejects(
    () => postRevision(store, { externalRevisionAt: EDIT_XERO_REVISION_AT }),
    (error: unknown) => (error as { code?: string }).code === 'P2002',
    'a create that may have overwritten this edit must not be assumed to precede it',
  )
  assert.equal(store.table.find((row) => row.id === 'event-create')?.externalId, 'INV-9')
  assert.equal(store.table.find((row) => row.id === 'event-revision')?.status, 'PENDING')
  assert.deepEqual(store.logs, [], 'a refused claim is audited as neither a takeover nor a supersession')
})

test('o3d-cvj9 r5: an UNMARKED unstamped create still hands over, so pre-existing documents keep working', async () => {
  // The boundary the guard must not cross: every document posted before `externalRevisionAt`
  // existed has an unstamped create that never recorded a write, and its first edit still has to be
  // able to take the id.
  const store = createAccountingEventStore([invoiceCreateRow({ externalRevisionAt: null }), revisionRow()])

  await postRevision(store, { externalRevisionAt: EDIT_XERO_REVISION_AT })

  assert.deepEqual(store.table.map((row) => ({ id: row.id, externalId: row.externalId })), [
    { id: 'event-create', externalId: null },
    { id: 'event-revision', externalId: 'INV-9' },
  ])
})

test('o3d-cvj9 r5: a write whose response carried no stamp is recorded as a write, not as never having written', async () => {
  const store = createAccountingEventStore([
    invoiceCreateRow({ status: 'SUPERSEDED', externalId: null }),
    revisionRow(),
  ])

  await postRevision(store, { externalRevisionAt: null })

  const revision = store.table.find((row) => row.id === 'event-revision')
  assert.equal(revision?.externalRevisionAt, null, 'a stamp from an earlier write no longer describes this one')
  assert.equal(
    revision?.revisionOrderBasis,
    'live_write_unstamped',
    'without this the wipe is indistinguishable from a row that never wrote',
  )
})

test('o3d-cvj9 r5: a JOURNAL row records no revision-ordering basis when it posts', async () => {
  // Nothing outside a document-revision family ever contends for a document id, so a basis on one
  // would assert nothing.
  const store = createAccountingEventStore([
    revisionRow({
      id: 'event-journal',
      type: 'DAILY_BATCH_REVENUE_DEFERRAL',
      idempotencyKey: 'accounting-sync:xero:daily_batch_revenue_deferral:daily-batch:a1',
      externalId: null,
    }),
  ])

  await updateMirroredAccountingEventStatus(store.client as never, {
    connector: 'xero',
    syncLogId: 'log-journal',
    type: 'DAILY_BATCH_REVENUE_DEFERRAL',
    referenceType: 'SalesOrder',
    referenceId: 'so-1',
    payload: { _idempotencyKey: 'daily-batch:a1', date: '2026-08-19', lines: [] },
    status: 'POSTED',
    externalId: 'journal-1',
    externalRevisionAt: null,
  })

  assert.equal(store.table.find((row) => row.id === 'event-journal')?.revisionOrderBasis ?? null, null)
})
