import assert from 'node:assert/strict'
import test from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'

import {
  buildMirroredAccountingEventDraft,
  isMirrorableAccountingSyncType,
  resetMirroredAccountingEventsToPending,
  resolveDocumentRevisionExternalIdClaim,
  updateMirroredAccountingEventStatus,
} from '@/lib/domain/accounting/accounting-event-mirror'
// o3d-cvj9 r7: the report end of the operator surface, asserted in the same test as the mirror end —
// the two halves agree on the audit metadata or the surface silently degrades to a blank finding.
import { evaluateAccountingReconciliationRows } from '@/lib/domain/accounting/reconciliation'

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

/**
 * A stand-in for the mirrored-event table: one row, looked up by idempotency key, plus the
 * update/log calls the transition makes against it.
 */
function mirrorClient(row: { id?: string; currency?: string; linesJson: unknown } | null) {
  const updates: Array<Record<string, unknown>> = []
  const logs: Array<Record<string, unknown>> = []
  const finds: unknown[] = []
  const client = {
    accountingEvent: {
      findUnique: async (args: unknown) => {
        finds.push(args)
        return row === null ? null : { id: row.id ?? 'event-1', currency: row.currency ?? 'GBP', linesJson: row.linesJson }
      },
      update: async (args: Record<string, unknown>) => {
        updates.push(args)
        return { id: row?.id ?? 'event-1' }
      },
    },
    accountingEventLog: {
      create: async (args: Record<string, unknown>) => {
        logs.push(args)
        return { id: `log-${logs.length}` }
      },
    },
  }
  const logActions = () => logs.map((l) => (l.data as { action: string }).action)
  const logFor = (action: string) => logs.map((l) => l.data as Record<string, unknown>).find((d) => d.action === action)
  return { client, updates, logs, finds, logActions, logFor }
}

const GROUP_B_KEY = 'accounting-sync:xero:daily_batch_group_b:dailybatch:b-2026-04-26:2026-04-26'
const groupBLines = [
  { accountCode: '210', description: 'Revenue recognition', debit: 10 },
  { accountCode: '400', description: 'Revenue recognition', credit: 10 },
]

test('sync success updates mirrored daily batch event to posted with external id', async () => {
  // The ordinary case: the payload posted is the payload queued, so the rebuild is a no-op and
  // must leave no audit noise behind.
  const { client, updates, logs } = mirrorClient({ linesJson: groupBLines })

  await updateMirroredAccountingEventStatus(client as never, {
    connector: 'xero',
    type: 'DAILY_BATCH_GROUP_B',
    referenceType: 'DailyBatch',
    referenceId: 'B-2026-04-26',
    payload: { date: '2026-04-26', lines: groupBLines },
    status: 'POSTED',
    externalId: 'journal-1',
  })

  assert.equal(updates.length, 1)
  assert.deepEqual(updates[0].where, { idempotencyKey: GROUP_B_KEY })
  const data = updates[0].data as Record<string, unknown>
  assert.equal(data.status, 'POSTED')
  assert.equal(data.externalId, 'journal-1')
  assert.deepEqual(data.linesJson, groupBLines)
  assert.equal(data.currency, 'GBP', 'the row\'s own currency, never re-derived')
  assert.deepEqual(logs.map((l) => (l.data as { action: string }).action), ['posted_from_sync_log'],
    'an unchanged payload must not log a rebuild')
})

test('terminal sync failure updates mirrored refund reversal event to failed', async () => {
  const { client, updates, logs } = mirrorClient({
    linesJson: [
      { accountCode: '120', description: 'COGS reversal', debit: 10 },
      { accountCode: '500', description: 'COGS reversal', credit: 10 },
    ],
  })

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

  // NOTHING was posted, so the mirrored body is left exactly as it was queued — the rebuild is a
  // POSTED-only concern (o3d-m26g).
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
   * o3d-cvj9 r4/r5: how a row with NO stamp may still be read against another revision. A CATEGORY,
   * not a clock. Production writes two values: `historical_backfill_repair` (the administrative
   * backfill, on a repair that TOOK the document id) and `live_write_unstamped` (a connector write
   * whose response carried no readable stamp). `null` once a live write records a real stamp.
   *
   * o3d-cvj9 r6: neither value ORDERS its row on its own — the rules built on them return an
   * assumption, labelled as one.
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
        // o3d-cvj9 r6: the create rule decided this one, and the audit says so — the holder is an
        // unstamped create that recorded no write, so nothing external ordered the pair.
        orderingBasis: 'create_precedes_unwritten',
        orderingEstablished: true,
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
// write it mirrors was already complete when the backfill selected it. o3d-cvj9 r6 (Codex r5
// finding 2): that fact does NOT place the repair against a later live write — what happens "now"
// is the RECORDING of the arrival, not the write it reports — so the rule survives (a holder that
// can never be superseded freezes its document for ever) as a labelled ASSUMPTION, not as a causal
// order. r4's second half — "and the backfill only selects documents with no mirrored revision
// event" — was retracted in r5: it was untrue of the candidate scan.
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
  // o3d-cvj9 r7: the handover is filed under the ASSUMED action, because rule 3 assumed the order.
  // Not under `superseded_by_revision`, which is now reserved for a handover Xero's stamps settled.
  assert.equal(
    store.logs.find((entry) => entry.action === 'superseded_by_assumed_order')?.accountingEventId,
    'event-revision-holder',
  )
  assert.equal(
    store.logs.find((entry) => entry.action === 'superseded_by_revision'),
    undefined,
    'nothing established this order, so nothing may file it as established',
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

test('o3d-cvj9 r5/r6: a replay that made NO connector write yields the claim instead of being refused for ever', async () => {
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
  // o3d-cvj9 r6 (Codex r5 finding 3): it yielded because it WROTE NOTHING, which is not the same
  // claim as "a newer write beat it" — that one is about where this row's ORIGINAL write sits, and
  // nothing here established that.
  assert.equal(
    store.logs.find((entry) => entry.action === 'revision_superseded_by_newer'),
    undefined,
    'staleness is a claim about the original write, and this path never ordered it',
  )
  const declined = store.logs.find((entry) => entry.action === 'revision_claim_yielded_no_write')
  assert.ok(declined, 'the arrival records that it did not take the claim')
  const declinedMeta = declined!.metadata as { externalIdHeldByEventId?: string; orderingBasis?: string; orderingEstablished?: boolean }
  assert.equal(declinedMeta.externalIdHeldByEventId, 'event-revision-holder')
  assert.equal(declinedMeta.orderingBasis, 'arrival_made_no_write')
  assert.equal(declinedMeta.orderingEstablished, false, 'no order was established, and the trail says so')
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

test('o3d-cvj9 r6: a create with an untimed write hands over, and the audit says the order was ASSUMED', async () => {
  // o3d-cvj9 r6 (Codex r5 finding 1). The same row shape is left by the ORDINARY case — a first
  // create post whose Xero response carried no readable UpdatedDateUTC — and by the rare one, a
  // re-post past the six-minute idempotency window that upserted over this edit. Nothing on the row
  // separates them, so r5's refusal classified the common case as the rare one, permanently: a
  // create never writes again, so the marker is never cleared and every later edit is refused for
  // ever. The claim moves, and the trail records that it moved on an assumption.
  const store = createAccountingEventStore([
    invoiceCreateRow({ externalRevisionAt: null, revisionOrderBasis: 'live_write_unstamped' }),
    revisionRow(),
  ])

  await postRevision(store, { externalRevisionAt: EDIT_XERO_REVISION_AT })

  assert.deepEqual(store.table.map((row) => ({ id: row.id, status: row.status, externalId: row.externalId })), [
    { id: 'event-create', status: 'SUPERSEDED', externalId: null },
    { id: 'event-revision', status: 'POSTED', externalId: 'INV-9' },
  ])
  // o3d-cvj9 r7 (Codex r7): audited under the ASSUMED action, not as an ordinary takeover with a
  // flag buried in its metadata — that is what the reconciliation report selects on.
  const takeover = store.logs.find((entry) => entry.action === 'superseded_by_assumed_order')
  assert.ok(takeover, 'the released row is audited as a handover made on an assumption')
  const meta = takeover!.metadata as { orderingBasis?: string; orderingEstablished?: boolean }
  assert.equal(meta.orderingBasis, 'create_precedes_untimed_write')
  assert.equal(meta.orderingEstablished, false, 'the create wrote at a time nobody recorded — this order is assumed')
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

// ---------------------------------------------------------------------------------------------
// o3d-cvj9 r6 — Codex r5 findings 1-3: AN ABSENT STAMP IS NOT A POSITIVE FACT.
//
// r5 read three absences as if each said something: an unstamped write on a create as "this may be
// a late replay"; a repair marker as "any stamped arrival came after this"; and an arrival that
// called nothing as "the holder is the newer write". The first misclassified the COMMON case as the
// rare one and did so permanently; the second and third asserted orders nothing had established.
//
// What is honest is to answer where an answer exists, and to say what the answer rests on. Every
// verdict now carries its basis and whether that basis ESTABLISHED the order or assumed it; the
// live mirror acts on an assumed order (its only alternative is to fail a sync log for ever) and
// records that it did, and the administrative backfill, which has an unclaimed repair to write
// instead, declines.
// ---------------------------------------------------------------------------------------------

/** The create's own post, as the mirror records it: same shape whatever attempt it is. */
const CREATE_PAYLOAD = {
  _idempotencyKey: 'sales-invoice:so-1',
  invoiceNumber: 'INV-1001',
  contactName: 'Customer One',
  date: '2026-08-19',
  currency: 'GBP',
  lines: [{ description: 'Widget', quantity: 1, unitAmount: 120, accountCode: '200' }],
}

function postCreate(store: ReturnType<typeof createAccountingEventStore>, externalRevisionAt: Date | null) {
  return updateMirroredAccountingEventStatus(store.client as never, {
    connector: 'xero',
    syncLogId: 'log-create',
    type: 'SALES_INVOICE',
    referenceType: 'SalesOrder',
    referenceId: 'so-1',
    payload: CREATE_PAYLOAD,
    status: 'POSTED',
    externalId: 'INV-9',
    externalRevisionAt,
  })
}

test('o3d-cvj9 r6: an ordinary create whose response carried no stamp still hands its document over', async () => {
  // The common case, driven through the mirror rather than asserted on a hand-set fixture. Xero's
  // create response carried no readable `UpdatedDateUTC` — `xeroDocumentRevisionAt` returns null for
  // anything it cannot parse — so the create records `live_write_unstamped`, the very marker r5 read
  // as "this create may have re-posted itself over the edit". Nothing a create does afterwards
  // clears the marker, so under r5 EVERY later edit of this invoice was refused, for ever.
  const store = createAccountingEventStore([
    invoiceCreateRow({ status: 'PENDING', externalId: null }),
    revisionRow(),
  ])

  await postCreate(store, null)

  assert.equal(
    store.table.find((row) => row.id === 'event-create')?.revisionOrderBasis,
    'live_write_unstamped',
    'an ordinary first post with an unreadable response stamp leaves exactly the marker r5 refused on',
  )

  await postRevision(store, { externalRevisionAt: REVISION_XERO_REVISION_AT })

  assert.deepEqual(store.table.map((row) => ({ id: row.id, status: row.status, externalId: row.externalId })), [
    { id: 'event-create', status: 'SUPERSEDED', externalId: null },
    { id: 'event-revision', status: 'POSTED', externalId: 'INV-9' },
  ])
  const takeover = store.logs.find((entry) => entry.action === 'superseded_by_assumed_order')
  assert.ok(takeover, 'the create released the claim, and the trail says the order was assumed')
  assert.deepEqual(
    (takeover!.metadata as { orderingBasis?: string; orderingEstablished?: boolean }).orderingBasis,
    'create_precedes_untimed_write',
    'and the trail names the rule that decided it, not just the outcome',
  )
  assert.equal((takeover!.metadata as { orderingEstablished?: boolean }).orderingEstablished, false)
})

test('o3d-cvj9 r6: a repair-marked holder yields to a live stamped write, and the audit calls it assumed', async () => {
  // Codex r5 finding 2. The repair mirrors a write its sync log had recorded complete before the
  // backfill selected it — and that does NOT place it against the arriving write, because what is
  // happening now is the RECORDING of the arrival, not the write it reports. The rule stays (a
  // repaired holder that can never be superseded freezes its document permanently) and stops
  // pretending to be causal.
  const store = createAccountingEventStore([
    invoiceCreateRow({ status: 'SUPERSEDED', externalId: null }),
    revisionRow(),
    holdingRevisionRow({ externalRevisionAt: null, revisionOrderBasis: 'historical_backfill_repair' }),
  ])

  await postRevision(store, { externalRevisionAt: REVISION_XERO_REVISION_AT })

  assert.equal(store.table.find((row) => row.id === 'event-revision')?.externalId, 'INV-9')
  const takeover = store.logs.find((entry) => entry.action === 'superseded_by_assumed_order')
  assert.ok(takeover, 'the repaired holder released the claim, on an order labelled as assumed')
  const meta = takeover!.metadata as { orderingBasis?: string; orderingEstablished?: boolean }
  assert.equal(meta.orderingBasis, 'historical_repair_precedes_live_write')
  assert.equal(meta.orderingEstablished, false, 'nothing placed the repair against this write — the order is assumed')
})

test('o3d-cvj9 r6: only the external stamps may record an arrival as superseded by a newer write', async () => {
  // The two ways an arrival ends up SUPERSEDED without the id must stay distinguishable on the
  // trail: one is Xero telling us its write was overwritten, the other is a replay that wrote
  // nothing at all and therefore established nothing about which write is newer.
  const overwritten = createAccountingEventStore([
    invoiceCreateRow({ externalRevisionAt: CREATE_REPOSTED_XERO_REVISION_AT }),
    revisionRow(),
  ])

  await postRevision(overwritten, { externalRevisionAt: EDIT_XERO_REVISION_AT })

  const stale = overwritten.logs.find((entry) => entry.action === 'revision_superseded_by_newer')
  assert.ok(stale, 'the stamps settled this one')
  const staleMeta = stale!.metadata as { orderingBasis?: string; orderingEstablished?: boolean }
  assert.equal(staleMeta.orderingBasis, 'external_stamps')
  assert.equal(staleMeta.orderingEstablished, true)

  const replayed = createAccountingEventStore([
    invoiceCreateRow({ status: 'SUPERSEDED', externalId: null }),
    revisionRow(),
    holdingRevisionRow({ externalRevisionAt: null, revisionOrderBasis: 'historical_backfill_repair' }),
  ])

  await postRevision(replayed)

  assert.equal(
    replayed.logs.find((entry) => entry.action === 'revision_superseded_by_newer'),
    undefined,
    'a replay that wrote nothing never establishes that a newer write beat it',
  )
  assert.equal(
    replayed.logs.find((entry) => entry.action === 'revision_claim_yielded_no_write')?.accountingEventId,
    'event-revision',
  )
})

test('o3d-cvj9 r6: a caller that declines an assumed order is refused with that specific reason', async () => {
  // The administrative backfill's position, asserted on the resolver itself: an order reached by
  // falling back is refused as `recency_only_assumed` — not as `recency_indeterminate`, which would
  // say nothing ordered them, and not silently as a takeover.
  const store = createAccountingEventStore([
    invoiceCreateRow({ externalRevisionAt: null, revisionOrderBasis: 'live_write_unstamped' }),
    revisionRow(),
  ])
  const params = {
    connector: 'xero',
    type: 'SALES_INVOICE_UPDATE',
    referenceType: 'SalesOrder',
    referenceId: 'so-1',
    status: 'POSTED' as const,
    externalId: 'INV-9',
  }

  const declined = await resolveDocumentRevisionExternalIdClaim(
    store.client as never,
    params,
    { externalRevisionAt: EDIT_XERO_REVISION_AT },
    { acceptAssumedOrder: false },
  )

  assert.deepEqual(declined, { claim: 'refused', reason: 'recency_only_assumed' })
  assert.equal(store.table.find((row) => row.id === 'event-create')?.externalId, 'INV-9', 'nothing was released')

  const accepted = await resolveDocumentRevisionExternalIdClaim(
    store.client as never,
    params,
    { externalRevisionAt: EDIT_XERO_REVISION_AT },
    { acceptAssumedOrder: true },
  )

  assert.deepEqual(accepted, {
    claim: 'takeover',
    supersededEventId: 'event-create',
    orderBasis: 'create_precedes_untimed_write',
    orderEstablished: false,
  })
})

// ---------------------------------------------------------------------------
// Codex r6, HIGH — THE CREATE FALLBACK RAN BEFORE THE NO-WRITE VERDICT.
//
// Round 6 established that a replay which made NO connector call takes NO claim, and then wrote that
// rule LAST — after the create fallback. The fallback matches on the HOLDER's type alone, so for the
// ordinary shape of a document (an unstamped create, revised) it answered first: "the create precedes
// its revisions", an ORDER, which the live mirror acts on because it accepts assumed orders. The claim
// moved onto an attempt that wrote nothing, which is exactly what round 6 said must not happen.
//
// Round 6's own test for this covered a BACKFILL-REPAIRED holder, which no rule above rule 4 matches —
// so it never exercised the ordering at all.
// ---------------------------------------------------------------------------

test('o3d-cvj9 r7 (Codex r6 HIGH): a replay that made NO connector call takes no claim FROM THE CREATE either', async () => {
  // The ordinary population, and the ordinary replay: a document created and then revised, with the
  // processor short-circuiting a sync log that already carries its document id — so no
  // `externalRevisionAt` field arrives at all. The holder is the create.
  const store = createAccountingEventStore([invoiceCreateRow(), revisionRow()])

  await postRevision(store)

  assert.deepEqual(store.table.map((row) => ({ id: row.id, status: row.status, externalId: row.externalId })), [
    // The create keeps the document: nothing in this attempt reached Xero, so nothing here can say
    // the revision describes a later state than it.
    { id: 'event-create', status: 'POSTED', externalId: 'INV-9' },
    { id: 'event-revision', status: 'SUPERSEDED', externalId: null },
  ])
  assert.equal(
    store.logs.find((entry) => entry.action === 'superseded_by_revision'),
    undefined,
    'the create must NOT release the claim to an attempt that made no connector write',
  )
  const yielded = store.logs.find((entry) => entry.action === 'revision_claim_yielded_no_write')
  assert.ok(yielded, 'the arrival is audited as having yielded WITHOUT writing')
  const meta = yielded!.metadata as {
    externalIdHeldByEventId?: string
    orderingBasis?: string
    orderingEstablished?: boolean
  }
  assert.equal(meta.externalIdHeldByEventId, 'event-create')
  assert.equal(meta.orderingBasis, 'arrival_made_no_write')
  assert.equal(meta.orderingEstablished, false, 'and the trail must not imply an order was reached')
})

test('o3d-cvj9 r7 (Codex r6 HIGH): the no-write verdict outranks the create fallback for BOTH callers', async () => {
  // `acceptAssumedOrder` decides whether an ASSUMED order may be ACTED on. It must not be able to
  // turn "this attempt wrote nothing" into a claim — and the live mirror is precisely the caller that
  // says yes to assumptions, which is why the defect bit there and not in the backfill.
  const params = {
    connector: 'xero',
    type: 'SALES_INVOICE_UPDATE',
    referenceType: 'SalesOrder',
    referenceId: 'so-1',
    status: 'POSTED' as const,
    externalId: 'INV-9',
  }

  for (const acceptAssumedOrder of [true, false]) {
    const store = createAccountingEventStore([invoiceCreateRow(), revisionRow()])

    const claim = await resolveDocumentRevisionExternalIdClaim(
      store.client as never,
      params,
      // The field is ABSENT — no connector call — as distinct from `null`, which is a call whose
      // stamp we did not get. Collapsing the two is the thing r5 separated.
      {},
      { acceptAssumedOrder },
    )

    assert.deepEqual(
      claim,
      { claim: 'yielded', holderEventId: 'event-create', orderBasis: 'arrival_made_no_write' },
      `acceptAssumedOrder=${acceptAssumedOrder}: no write means no claim, whatever the holder is`,
    )
    assert.equal(
      store.table.find((row) => row.id === 'event-create')?.externalId,
      'INV-9',
      'and nothing was released — a takeover is a WRITE, and this path must not make one',
    )
  }
})

test('o3d-cvj9 r7: a real write with an unreadable stamp still takes the create claim', async () => {
  // The counter-guard, and the whole reason the rule keys on the FIELD rather than on the value:
  // `externalRevisionAt: null` is a connector call whose response carried no readable stamp, and that
  // is a write. If the fix had reached one step further it would have frozen the ordinary
  // create -> first-edit handover for every document Xero answers without a stamp. Green under revert
  // BY DESIGN.
  const store = createAccountingEventStore([invoiceCreateRow(), revisionRow()])

  await postRevision(store, { externalRevisionAt: null })

  assert.deepEqual(store.table.map((row) => ({ id: row.id, status: row.status, externalId: row.externalId })), [
    { id: 'event-create', status: 'SUPERSEDED', externalId: null },
    { id: 'event-revision', status: 'POSTED', externalId: 'INV-9' },
  ])
  assert.equal(
    store.logs.find((entry) => entry.action === 'superseded_by_revision')?.accountingEventId,
    'event-create',
  )
  assert.equal(
    store.logs.find((entry) => entry.action === 'revision_claim_yielded_no_write'),
    undefined,
    'a write with no readable stamp is still a write',
  )
})

// ---------------------------------------------------------------------------------------------
// o3d-cvj9 r7 — Codex r7, HIGH: THE IDENTIFIER STILL MOVES ON AN ADMITTED GUESS.
//
// Codex proposed a third outcome — terminal, recording the write, NOT moving the claim. It is
// rejected, and the reasoning is on the `acceptAssumedOrder` call in the mirror: the id is already
// on the holder, so declining to move it is not abstention but the OPPOSITE guess, made silently and
// permanently (nothing ever clears the holder's basis, so every later revision of that document
// meets the same rule and parks again), where moving it converges — the taker holds a real external
// stamp, so the NEXT revision is settled by rule 1.
//
// What Codex is right about is the half r6 admitted against itself: the assumption had no operator
// surface. It has one now, and these two tests are the cases the reviewer named — the two shapes in
// which the guess is WRONG. Neither can be detected from the rows, which is the point: what is
// asserted is that the wrong guess is made VISIBLY and is traceable to the document, both ends of
// which have to hold for the refusal to be defensible.
// ---------------------------------------------------------------------------------------------

/** The report's view of one audit entry, as the database would hand it back. */
function claimLogRows(store: ReturnType<typeof createAccountingEventStore>, movedAt: Date) {
  return store.logs
    .filter((entry) => entry.action === 'superseded_by_assumed_order')
    .map((entry, index) => ({
      id: `log-${index}`,
      accountingEventId: entry.accountingEventId as string,
      action: entry.action as string,
      metadata: entry.metadata,
      createdAt: movedAt,
    }))
}

function emptyReconciliationRows() {
  return { salesOrders: [], shipments: [], refunds: [], syncLogs: [], accountingEvents: [] }
}

test('o3d-cvj9 r7 (Codex r7 HIGH): an unstamped late create replay takes the id from the edit it overwrote, and the report LISTS it', async () => {
  // The create's own first post, and then — past Xero's six-minute idempotency window, so the same
  // request is a fresh one and `POST /Invoices` on an existing `InvoiceNumber` UPSERTS — a REPLAY of
  // that same sync log, which writes the create's content over an edit that had landed in between.
  // Both responses carried no readable `UpdatedDateUTC`, so the row records two writes of unknown
  // time and NOTHING on it separates the first post from the replay.
  const store = createAccountingEventStore([
    invoiceCreateRow({ status: 'PENDING', externalId: null }),
    revisionRow(),
  ])

  await postCreate(store, null)
  await postCreate(store, null)

  const create = store.table.find((row) => row.id === 'event-create')
  assert.equal(create?.externalId, 'INV-9', 'the replay re-posted under the same claim, so no collision arose')
  assert.equal(create?.externalRevisionAt, null)
  assert.equal(
    create?.revisionOrderBasis,
    'live_write_unstamped',
    'the replay leaves EXACTLY the row an ordinary unstamped first post leaves — that is why this cannot be detected',
  )

  // The overwritten edit is only recorded now. Its stamp is from when Xero applied it, which was
  // BEFORE the replay above — so the true order is create, edit, replay, and the create is the write
  // the invoice actually reflects. Rule 1 cannot see that (the holder has no stamp to compare), so
  // rule 2 answers "the create precedes its revisions" and the claim moves the wrong way.
  await postRevision(store, { externalRevisionAt: EDIT_XERO_REVISION_AT })

  assert.deepEqual(store.table.map((row) => ({ id: row.id, status: row.status, externalId: row.externalId })), [
    { id: 'event-create', status: 'SUPERSEDED', externalId: null },
    { id: 'event-revision', status: 'POSTED', externalId: 'INV-9' },
  ])

  const takeover = store.logs.find((entry) => entry.action === 'superseded_by_assumed_order')
  assert.ok(takeover, 'the handover is filed under the action that says the order was assumed')
  assert.equal(
    store.logs.find((entry) => entry.action === 'superseded_by_revision'),
    undefined,
    'and never under the action reserved for an order the external stamps settled',
  )
  assert.equal(takeover!.accountingEventId, 'event-create', 'filed against the row that RELEASED the id')
  const meta = takeover!.metadata as Record<string, unknown>
  assert.equal(meta.orderingBasis, 'create_precedes_untimed_write')
  assert.equal(meta.orderingEstablished, false)
  assert.equal(meta.supersededByEventId, 'event-revision', 'and it names the row that now holds it')
  assert.equal(meta.externalId, 'INV-9', 'and the document, without which no operator can go and check')
  assert.match(String(takeover!.message ?? ''), /ASSUMED order/, 'the entry says what was assumed and what to do about it')

  // The half of Codex r7 that stands: an assumption nothing lists is not an audited decision.
  const findings = evaluateAccountingReconciliationRows({
    ...emptyReconciliationRows(),
    revisionClaimLogs: claimLogRows(store, new Date('2026-08-19T10:06:00.000Z')),
  })
  assert.deepEqual(findings.map((finding) => finding.code), ['document_claim_moved_on_assumed_order'])
  assert.equal(findings[0].severity, 'warning')
  assert.equal(findings[0].accountingEventId, 'event-revision', 'keyed to the row a reader is asked to confirm')
  assert.deepEqual(
    findings[0].details as Record<string, unknown>,
    {
      connector: 'xero',
      externalId: 'INV-9',
      orderingBasis: 'create_precedes_untimed_write',
      releasedByEventId: 'event-create',
      holdingEventId: 'event-revision',
      syncType: 'SALES_INVOICE_UPDATE',
      referenceType: 'SalesOrder',
      referenceId: 'so-1',
      movedAt: '2026-08-19T10:06:00.000Z',
    },
    'both rows, the document and the basis — everything the check needs without opening the audit table',
  )
})

test('o3d-cvj9 r7 (Codex r7 HIGH): a historical repair whose true write order is REVERSED still hands over, and the report LISTS it', async () => {
  // The repair mirrors a historical post and carries no stamp — there was never a connector response
  // to take one from. Here its write is the LATER of the two: the sync log it repairs was raised
  // after the arriving revision's, which is what `createdAt` records below. Nothing in production
  // reads that column for ordering (r2 did, and it is transaction START time, so it never carried
  // edit order at all), so the fixture states the reversed truth in the one place the code is
  // required to ignore — and the claim moves against it.
  const store = createAccountingEventStore([
    invoiceCreateRow({ status: 'SUPERSEDED', externalId: null }),
    revisionRow({ createdAt: new Date('2026-08-19T10:00:00.000Z') }),
    holdingRevisionRow({
      externalRevisionAt: null,
      revisionOrderBasis: 'historical_backfill_repair',
      createdAt: new Date('2026-08-19T23:00:00.000Z'),
    }),
  ])

  await postRevision(store, { externalRevisionAt: REVISION_XERO_REVISION_AT })

  assert.deepEqual(store.table.map((row) => ({ id: row.id, status: row.status, externalId: row.externalId })), [
    { id: 'event-create', status: 'SUPERSEDED', externalId: null },
    { id: 'event-revision', status: 'POSTED', externalId: 'INV-9' },
    { id: 'event-revision-holder', status: 'SUPERSEDED', externalId: null },
  ])

  const takeover = store.logs.find((entry) => entry.action === 'superseded_by_assumed_order')
  assert.ok(takeover, 'rule 3 assumed the order, so the handover is filed as assumed')
  assert.equal(
    store.logs.find((entry) => entry.action === 'superseded_by_revision'),
    undefined,
    'a repair carries no stamp, so no external record ever settled this pair',
  )
  assert.equal(takeover!.accountingEventId, 'event-revision-holder')
  const meta = takeover!.metadata as Record<string, unknown>
  assert.equal(meta.orderingBasis, 'historical_repair_precedes_live_write')
  assert.equal(meta.orderingEstablished, false)
  assert.equal(meta.supersededByEventId, 'event-revision')

  const findings = evaluateAccountingReconciliationRows({
    ...emptyReconciliationRows(),
    revisionClaimLogs: claimLogRows(store, new Date('2026-08-20T00:00:00.000Z')),
  })
  assert.deepEqual(findings.map((finding) => finding.code), ['document_claim_moved_on_assumed_order'])
  const details = findings[0].details as Record<string, unknown>
  assert.equal(details.orderingBasis, 'historical_repair_precedes_live_write')
  assert.equal(details.releasedByEventId, 'event-revision-holder')
  assert.equal(details.holdingEventId, 'event-revision')
  assert.equal(details.externalId, 'INV-9')
})

test('o3d-cvj9 r7: a handover the external stamps SETTLED is not reported for review', async () => {
  // The other side of the surface, and the thing that decides whether it is signal or noise: an
  // ESTABLISHED takeover is filed under its own action and never reaches the report. Without this the
  // finding would fire on every ordinary create -> first-edit handover in the ledger.
  const store = createAccountingEventStore([
    invoiceCreateRow({ externalRevisionAt: new Date('2026-08-19T09:00:01.000Z') }),
    revisionRow(),
  ])

  await postRevision(store, { externalRevisionAt: REVISION_XERO_REVISION_AT })

  const takeover = store.logs.find((entry) => entry.action === 'superseded_by_revision')
  assert.ok(takeover, 'Xero stamped both writes, so this order was established')
  assert.equal((takeover!.metadata as Record<string, unknown>).orderingEstablished, true)
  assert.deepEqual(claimLogRows(store, new Date()), [], 'nothing for the report to pick up')

  // And the evaluator asserts the action rather than trusting the query that selected it, so a
  // widened read cannot start reporting established handovers as guesses.
  assert.deepEqual(
    evaluateAccountingReconciliationRows({
      ...emptyReconciliationRows(),
      revisionClaimLogs: [{
        id: 'log-1',
        accountingEventId: 'event-create',
        action: 'superseded_by_revision',
        metadata: takeover!.metadata,
        createdAt: new Date(),
      }],
    }),
    [],
  )
})

// ---------------------------------------------------------------------------------------------
// o3d-m26g: the POSTED mirror must describe what was POSTED, not what was queued.
//
// The mirrored event is created at ENQUEUE time from the payload as it stood then. The status
// transition used to write only `status` and `externalId`, so any path that changed a queued
// payload before it went out left the internal audit event disagreeing with the ledger, silently.
// ---------------------------------------------------------------------------------------------

test('a payload changed after enqueue posts the CHANGED figures into the mirror (o3d-m26g)', async () => {
  // Queued at debit/credit 10.00; the payload that actually went to Xero carried 12.50.
  const enqueued = [
    { accountCode: '210', description: 'Revenue recognition', debit: 10 },
    { accountCode: '400', description: 'Revenue recognition', credit: 10 },
  ]
  const posted = [
    { accountCode: '210', description: 'Revenue recognition', debit: 12.5 },
    { accountCode: '400', description: 'Revenue recognition', credit: 12.5 },
  ]
  const { client, updates, logActions, logFor } = mirrorClient({ linesJson: enqueued })

  await updateMirroredAccountingEventStatus(client as never, {
    connector: 'xero',
    type: 'DAILY_BATCH_GROUP_B',
    referenceType: 'DailyBatch',
    referenceId: 'B-2026-04-26',
    payload: { date: '2026-04-26', lines: posted },
    status: 'POSTED',
    externalId: 'journal-1',
  })

  const data = updates[0].data as Record<string, unknown>
  assert.deepEqual(
    data.linesJson,
    posted,
    'the mirror must carry the 12.50 that was posted, not the 10.00 that was queued',
  )
  assert.equal(data.status, 'POSTED')

  // And the queued body is not destroyed by the rewrite — it moves into the audit log.
  assert.deepEqual(logActions(), ['posted_from_sync_log', 'payload_rebuilt_from_posted'])
  const rebuild = logFor('payload_rebuilt_from_posted')
  assert.deepEqual((rebuild?.metadata as Record<string, unknown>).enqueuedLinesJson, enqueued)
})

test('a document payload rebuilt at post carries the posted amounts and mode', async () => {
  const enqueued = {
    kind: 'accounting-document', schemaVersion: 1, documentType: 'SALES_INVOICE',
    documentNumber: 'WC-INV-1', invoiceNumber: 'WC-INV-1', contact: { name: 'A Customer' },
    date: '2026-08-20', currency: 'GBP', lineAmountMode: 'INCLUSIVE', lineAmountsIncludeTax: true,
    lines: [{ description: 'Widget', quantity: 1, unitAmount: 90, accountCode: '200' }],
  }
  const { client, updates } = mirrorClient({ linesJson: enqueued, currency: 'GBP' })

  await updateMirroredAccountingEventStatus(client as never, {
    connector: 'xero',
    syncLogId: 'sync-log-1',
    type: 'SALES_INVOICE',
    referenceType: 'SalesOrder',
    referenceId: 'so-1',
    payload: {
      invoiceNumber: 'WC-INV-1',
      contactName: 'A Customer',
      date: '2026-08-20',
      currency: 'GBP',
      lineAmountsIncludeTax: false,
      lines: [{ description: 'Widget', quantity: 1, unitAmount: 100, accountCode: '200', discountAmount: 10 }],
    },
    status: 'POSTED',
    externalId: 'inv-1',
  })

  const linesJson = (updates[0].data as Record<string, unknown>).linesJson as Record<string, unknown>
  const lines = linesJson.lines as Array<Record<string, unknown>>
  assert.equal(lines[0].unitAmount, 100, 'the unit amount that was posted')
  assert.equal(lines[0].discountAmount, 10, 'and the discount that went with it')
  assert.equal(linesJson.lineAmountMode, 'EXCLUSIVE', 'the tax convention the document was posted under')
  assert.equal(linesJson.lineAmountsIncludeTax, false)
})

test('a rebuild that cannot be built never costs the post — it is recorded, not thrown', async () => {
  // The transition runs inside the transaction that marks the sync log SYNCED. Throwing here would
  // roll back a post Xero has already accepted, and the retry would post it a SECOND time.
  const enqueued = [
    { accountCode: '210', description: 'Revenue recognition', debit: 10 },
    { accountCode: '400', description: 'Revenue recognition', credit: 10 },
  ]
  const { client, updates, logActions, logFor } = mirrorClient({ linesJson: enqueued })

  await updateMirroredAccountingEventStatus(client as never, {
    connector: 'xero',
    type: 'DAILY_BATCH_GROUP_B',
    referenceType: 'DailyBatch',
    referenceId: 'B-2026-04-26',
    // Unbalanced: 10 debit against 7 credit. The canonical builder refuses it.
    payload: {
      date: '2026-04-26',
      lines: [
        { accountCode: '210', description: 'Revenue recognition', debit: 10 },
        { accountCode: '400', description: 'Revenue recognition', credit: 7 },
      ],
    },
    status: 'POSTED',
    externalId: 'journal-1',
  })

  const data = updates[0].data as Record<string, unknown>
  assert.equal(data.status, 'POSTED', 'the SYNCED/POSTED transition still stands')
  assert.equal(data.externalId, 'journal-1')
  assert.equal('linesJson' in data, false, 'and the mirror keeps its enqueued body rather than a half-built one')
  assert.deepEqual(logActions(), ['posted_from_sync_log', 'payload_rebuild_failed'])
  assert.match(
    String(logFor('payload_rebuild_failed')?.message),
    /must balance: debit 10 != credit 7/,
    'the specific reason, so an operator knows which event to re-derive and why',
  )
})

test('an unchanged payload logs no rebuild even when the stored key order differs (jsonb)', async () => {
  // Postgres jsonb does not preserve key order, so a naive stringify comparison would report a
  // difference on essentially every post and bury the real ones.
  const { client, logActions } = mirrorClient({
    linesJson: [
      { debit: 10, description: 'Revenue recognition', accountCode: '210' },
      { credit: 10, accountCode: '400', description: 'Revenue recognition' },
    ],
  })

  await updateMirroredAccountingEventStatus(client as never, {
    connector: 'xero',
    type: 'DAILY_BATCH_GROUP_B',
    referenceType: 'DailyBatch',
    referenceId: 'B-2026-04-26',
    payload: { date: '2026-04-26', lines: groupBLines },
    status: 'POSTED',
    externalId: 'journal-1',
  })

  assert.deepEqual(logActions(), ['posted_from_sync_log'])
})

test('a mirrored event that does not exist is still a no-op', async () => {
  const { client, updates, logs } = mirrorClient(null)
  await updateMirroredAccountingEventStatus(client as never, {
    connector: 'xero',
    type: 'DAILY_BATCH_GROUP_B',
    referenceType: 'DailyBatch',
    referenceId: 'B-2026-04-26',
    payload: { date: '2026-04-26', lines: groupBLines },
    status: 'POSTED',
    externalId: 'journal-1',
  })
  assert.deepEqual(updates, [])
  assert.deepEqual(logs, [])
})

test('a posted payload that no longer yields an event at all is recorded, not skipped quietly', async () => {
  // The row exists, so this type WAS mirrorable at enqueue. A payload that has since lost its lines
  // must not slip through as "nothing to rebuild".
  const { client, updates, logActions, logFor } = mirrorClient({ linesJson: groupBLines })

  await updateMirroredAccountingEventStatus(client as never, {
    connector: 'xero',
    type: 'DAILY_BATCH_GROUP_B',
    referenceType: 'DailyBatch',
    referenceId: 'B-2026-04-26',
    payload: { date: '2026-04-26', lines: [] },
    status: 'POSTED',
    externalId: 'journal-1',
  })

  assert.equal((updates[0].data as Record<string, unknown>).status, 'POSTED')
  assert.deepEqual(logActions(), ['posted_from_sync_log', 'payload_rebuild_failed'])
  assert.match(
    String(logFor('payload_rebuild_failed')?.message),
    /no longer builds a mirrorable event/,
  )
})
