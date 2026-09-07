import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'

/**
 * o3d-1xq8 (Codex HIGH) — DB WIRING for the exact-amount half of the payment enqueue.
 *
 * tests/accounting/registration-amount-exactness.test.ts proves the READER: a payload carrying the
 * receipt's exact decimal string is read at that decimal, so an amount whose double rounds UP cannot
 * manufacture coverage and clear `paidAt` on a document nobody fully paid. That test builds its own
 * payloads, which is right for a rule and proves nothing about whether anything ever writes one.
 *
 * This file is the other end. It drives the real `registerDeferredOrderReceipts` against a fake
 * database — the harness shape of tests/accounting/deferred-receipt-redrive-wiring.test.ts — and
 * asserts the two things only the writer can answer:
 *
 *   1. the queued payload CARRIES the exact decimal string, and it is the stored `Decimal(18, 4)`
 *      receipt rather than a re-rendering of the double beside it;
 *   2. an amount whose two forms would disagree is REFUSED — nothing queued, an operator message
 *      that names the exact figure and says the refusal is terminal for it, and the deferred
 *      obligation retained. The REMEDY in that message comes from `invoicePaymentRemedyNote` and not
 *      from the refusal, which is the o3d-0bfh r13 rule: on the deferred path hand settlement is
 *      refused, because a payment keyed into the accounting package's own UI carries no request id.
 *
 * (2) is the backstop the string cannot provide: the connectors state a payment's amount as a JSON
 * NUMBER on the wire, so an amount no double names has no honest figure to send however exactly the
 * payload records it.
 */

type QueuedRow = { type: string; payload: Record<string, unknown>; idempotencyKey?: string }

const state = {
  syncRows: [] as Array<{ id: string; status: string; externalTransactionId: null; errorMessage: null; retryCount: number; payload: Record<string, unknown> }>,
  queued: [] as QueuedRow[],
  activity: [] as Array<{ action: string; level: string; description: string; metadata: Record<string, unknown> }>,
  /**
   * `amount` is a `Prisma.Decimal` and not a number, because that is what Prisma hands back for a
   * `Decimal(18, 4)` column and the whole finding is about what the enqueue does to it. A harness
   * that stored a number here could not tell the fix from the defect.
   */
  payments: [] as Array<{ id: string; amount: Prisma.Decimal; currency: string; method: string | null; reference: string | null; paidAt: Date }>,
  order: {
    id: 'order-1',
    orderNumber: 'SO-1',
    externalOrderNumber: null as string | null,
    accountingInvoiceId: 'INV-1' as string | null,
    currency: 'GBP',
    totalForeign: new Prisma.Decimal('100.0000') as Prisma.Decimal,
    taxForeign: new Prisma.Decimal('0.0000') as Prisma.Decimal,
    pricesIncludeVat: false,
    shoppingLinks: [] as Array<{ connector: string }>,
  },
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(txClient()),
      accountingSyncLog: { findMany: async () => state.syncRows },
      salesOrder: { findUnique: async () => ({ ...state.order, payments: state.payments }) },
      payment: { findUnique: async ({ where }: { where: { id: string } }) => state.payments.find((p) => p.id === where.id) ?? null },
    },
  },
})

function txClient() {
  return {
    accountingSyncLog: {
      findMany: async () => state.syncRows,
      updateMany: async () => ({ count: 1 }),
    },
    payment: {
      findUnique: async ({ where }: { where: { id: string } }) => state.payments.find((p) => p.id === where.id) ?? null,
      findMany: async () => state.payments,
    },
    salesOrder: { findUnique: async () => ({ ...state.order, payments: state.payments }) },
    // Both locks are no-ops here, but they must EXIST or the enqueue dies before it registers
    // anything and every count below reads zero.
    $executeRaw: async () => 1,
    $queryRaw: async () => [],
  }
}

mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: { action: string; level: string; description: string; metadata: Record<string, unknown> }) => {
      state.activity.push({ action: entry.action, level: entry.level, description: entry.description, metadata: entry.metadata })
    },
  },
})

mock.module('@/lib/domain/sales/allocation-service', {
  namedExports: { lockSalesOrder: async () => {} },
})

mock.module('@/lib/accounting', {
  namedExports: {
    isAccountingSyncTypeEnabled: async () => true,
    isAccountingSyncTypeEnabledFor: async () => true,
    getActiveAccountingConnectorInfo: async () => ({ id: 'xero' }),
    getPaymentAccountMap: async () => ({ default: 'BANK-1' }),
    lookupPaymentAccount: () => 'BANK-1',
    queueAccountingSyncTxWithOutcome: async (
      _tx: unknown,
      params: { type: string; payload: Record<string, unknown>; idempotencyKey?: string },
    ) => {
      state.queued.push({ type: params.type, payload: params.payload, idempotencyKey: params.idempotencyKey })
      state.syncRows.unshift({
        id: `log-${state.queued.length}`,
        status: 'PENDING',
        externalTransactionId: null,
        errorMessage: null,
        retryCount: 0,
        payload: { ...params.payload, ...(params.idempotencyKey ? { _idempotencyKey: params.idempotencyKey } : {}) },
      })
      return { queued: true, connector: 'xero' }
    },
  },
})

async function redrive() {
  const m = await import('@/lib/domain/accounting/invoice-payment-enqueue')
  return m.registerDeferredOrderReceipts('order-1', { connector: 'xero', accountingInvoiceId: 'INV-1' }, {
    syncLogId: 'sync-1',
    connector: 'xero',
    generation: new Date('2026-08-01T00:00:00.000Z'),
    recovery: { consumer: 'sweep' },
  })
}

function receipt(amount: string, id = 'pay-1') {
  return {
    id,
    amount: new Prisma.Decimal(amount),
    currency: 'GBP',
    method: 'card',
    reference: null,
    paidAt: new Date('2026-08-20T10:00:00.000Z'),
  }
}

test.beforeEach(() => {
  state.syncRows = []
  state.queued = []
  state.activity = []
  state.payments = []
  state.order.accountingInvoiceId = 'INV-1'
  state.order.totalForeign = new Prisma.Decimal('100.0000')
  state.order.taxForeign = new Prisma.Decimal('0.0000')
  state.order.pricesIncludeVat = false
  state.order.shoppingLinks = []
})

test('[o3d-1xq8] the queued payload carries the receipt\'s exact decimal string beside the number', async () => {
  state.payments = [receipt('100.0000')]

  const result = await redrive()
  assert.equal(result.settled, true, 'PRECONDITION: the receipt registered, so there IS a payload to read')
  assert.equal(state.queued.length, 1)

  const payload = state.queued[0]!.payload
  assert.equal(payload.type ?? 'INVOICE_PAYMENT', 'INVOICE_PAYMENT')
  // BOTH forms, and the number is the one that was already there — this field is ADDITIVE, so no
  // consumer that reads `amount` today sees anything change.
  assert.equal(payload.amount, 100, 'the JSON number the connectors put on the wire is unchanged')
  assert.equal(payload.amountDecimal, '100', 'and the exact decimal is recorded beside it')
  assert.equal(payload.currency, 'GBP', 'with the currency, without which the decimal is not comparable')
})

test('[o3d-1xq8] the decimal string is the STORED decimal, not a re-rendering of the double', async () => {
  // A four-decimal receipt whose trailing digits are the whole point. Read back through the payload's
  // NUMBER this is `1234567.8912`; the test is that the string is the column's own figure and travels
  // independently of it.
  state.payments = [receipt('1234567.8912')]
  state.order.totalForeign = new Prisma.Decimal('1234567.8912')

  await redrive()
  assert.equal(state.queued.length, 1)
  assert.equal(state.queued[0]!.payload.amountDecimal, '1234567.8912')
  // AND THE TWO AGREE, which is the round-trip refusal's guarantee showing up as a property of every
  // row the writer produces: a payload whose two forms disagreed could not have been written at all.
  assert.equal(Number(state.queued[0]!.payload.amountDecimal), state.queued[0]!.payload.amount)
})

test('[o3d-1xq8] an amount no JSON number can state is REFUSED, not sent as the nearest double', async () => {
  // THE FINDING'S OWN FIGURE. `Number('549755813888.0008')` reads back as `549755813888.0009` — a
  // whole minor unit higher — so there is no honest number for the wire.
  state.payments = [receipt('549755813888.0008')]
  state.order.totalForeign = new Prisma.Decimal('549755813888.0009')

  const result = await redrive()

  assert.equal(state.queued.length, 0, 'NOTHING was queued: money IMS would have to misstate does not leave it')
  const refusal = state.activity.find((a) => a.metadata.refusal === 'AMOUNT_NOT_REPRESENTABLE')
  assert.ok(refusal, 'and the refusal is REPORTED — a silent drop is the failure mode this path exists to prevent')
  assert.equal(refusal.action, 'invoice_payment_not_registered')
  assert.equal(refusal.level, 'WARNING')
  // The metadata records the EXACT figure as a string. Recording `amountNumber` in the metadata of the
  // refusal that exists because `amountNumber` is wrong would record the wrong number.
  assert.equal(refusal.metadata.amount, '549755813888.0008')
  assert.equal(refusal.metadata.asNumber, 549755813888.0009,
    'PRECONDITION: and the number it declined to send is the minor unit too high')
  // The operator message names the EXACT figure, says nothing was sent, and says the refusal is
  // terminal for it — so nobody re-records the same amount expecting a different answer.
  assert.match(refusal.description, /549755813888\.0008/)
  assert.match(refusal.description, /NOTHING was sent/)
  assert.match(refusal.description, /terminal for this figure/)
  // AND THE REMEDY COMES FROM `invoicePaymentRemedyNote`, NOT FROM THIS MESSAGE (o3d-0bfh r13). This
  // is the deferred path, where hand settlement is REFUSED: a payment keyed into the accounting
  // package's own UI carries no request id and could not be deduplicated against the registration
  // this obligation still owes. A refusal message that licensed one here would be the r13 defect.
  assert.match(refusal.description, /HAND SETTLEMENT IS REFUSED HERE/)
  assert.doesNotMatch(refusal.description, /register (the|this) (receipt|payment) in \w+ by hand/i)

  // AND THE OBLIGATION IS RETAINED. A refused receipt is not a settled one: the connector keeps the
  // marker so the deferred pass can come back for it, exactly as it does for every other refusal here.
  assert.equal(result.settled, false)
  assert.equal(result.release, 'retained')
})

test('[o3d-1xq8] the refusal is terminal for that receipt and does not block the others', async () => {
  // Two receipts on one order, one sendable and one not. The sendable one must still register — a
  // refusal is about ONE receipt's figure, and stranding an unrelated payment behind it would trade a
  // misstated amount for a missing one.
  state.order.totalForeign = new Prisma.Decimal('549755813888.0009')
  state.payments = [receipt('549755813888.0008', 'pay-bad'), receipt('40.0000', 'pay-good')]

  await redrive()

  assert.equal(state.queued.length, 1, 'exactly one registration was queued')
  assert.equal(state.queued[0]!.payload.paymentId, 'pay-good')
  assert.equal(state.queued[0]!.payload.amountDecimal, '40')
  assert.ok(state.activity.some((a) => a.metadata.refusal === 'AMOUNT_NOT_REPRESENTABLE'
    && a.metadata.paymentId === 'pay-bad'), 'and the other receipt was refused by name')
})
