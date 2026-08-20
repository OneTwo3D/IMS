// o3d-clxw — AUTHORISED IS NOT "UNPAID".
//
// The poller's reversal passes used to read every ACCREC/ACCPAY invoice sitting at AUTHORISED as a
// payment REMOVAL. AUTHORISED is Xero's status for an approved invoice that is not FULLY paid, which
// a bill carrying a real PART payment satisfies — Xero only moves an invoice to PAID when the
// outstanding amount reaches zero.
//
// What followed on the BILL side was a duplicate supplier payment: paidAt was cleared, the activity
// log said the payment was "no longer present in Xero", and Mark Paid re-armed in the UI (it renders
// only while paidAt is null). markBillPaid sends no idempotency key and BILL_PAYMENT is outside every
// live-row dedupe, so the second press posts a second payment on top of the part payment.
//
// On the SALES side the same reading additionally raised an automatic chargeback credit note,
// unwinding recognised revenue against a payment the ledger was still holding.
//
// These tests drive the real poller over a mocked Xero and database.

import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import type { XeroInvoice } from '@/lib/connectors/xero/invoice-delta'

type Row = Record<string, unknown>
type LoggedActivity = { action?: string; level?: string; description?: string; metadata?: Record<string, unknown> }

const state = {
  invoices: [] as XeroInvoice[],
  salesOrders: [] as Row[],
  purchaseInvoices: [] as Row[],
  attempts: 0,
  activity: [] as LoggedActivity[],
  notifications: [] as { title?: string; message?: string }[],
  chargebacks: [] as string[],
  purchaseInvoiceUpdates: [] as { id: unknown; data: Row }[],
  salesOrderUpdates: [] as { id: unknown; data: Row }[],
}

function reset(): void {
  state.invoices = []
  state.salesOrders = []
  state.purchaseInvoices = []
  state.attempts = 0
  state.activity = []
  state.notifications = []
  state.chargebacks = []
  state.purchaseInvoiceUpdates = []
  state.salesOrderUpdates = []
}

/** Just enough Prisma `where` to answer the poller's own queries honestly. */
function rowMatches(row: Row, where: Row | undefined): boolean {
  for (const [key, condition] of Object.entries(where ?? {})) {
    // The fixture holds manual orders only, so `shoppingLinks: { none: {} }` matches every row.
    if (key === 'shoppingLinks') continue
    const actual = row[key]
    if (condition === null) {
      if (actual != null) return false
      continue
    }
    if (typeof condition === 'object') {
      const c = condition as { in?: unknown[]; not?: unknown }
      if (Array.isArray(c.in) && !c.in.includes(actual)) return false
      if ('not' in c) {
        if (c.not === null ? actual == null : actual === c.not) return false
      }
      continue
    }
    if (actual !== condition) return false
  }
  return true
}

mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async (entry: LoggedActivity) => { state.activity.push(entry) } },
})
mock.module('@/lib/notifications', {
  namedExports: { notify: async (n: { title?: string; message?: string }) => { state.notifications.push(n) } },
})
mock.module('@/lib/connectors/xero/payment-write-lock', {
  namedExports: {
    withPaymentWriteLockOrSkip: async <T,>(fn: () => Promise<T>): Promise<T> => fn(),
    isLockSkipped: () => false,
  },
})
mock.module('@/lib/connectors/xero/api', {
  namedExports: {
    xeroHttpAttemptCount: () => state.attempts,
    xeroGet: async () => {
      state.attempts += 1
      // One short page: walkPages treats it as the last, so the whole window is one chunk.
      return { ok: true, status: 200, data: { Invoices: state.invoices } }
    },
  },
})
mock.module('@/app/actions/sales', {
  namedExports: {
    raiseChargebackForReversedOrder: async (orderId: string) => {
      state.chargebacks.push(orderId)
      return { raised: true }
    },
  },
})
mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: {
        findUnique: async () => ({ key: 'xero_last_payment_poll', value: new Date(Date.now() - 60_000).toISOString() }),
        upsert: async () => ({}),
      },
      user: { findMany: async () => [{ id: 'admin_1' }] },
      salesOrderRefund: { findFirst: async () => null },
      salesOrder: {
        findMany: async ({ where }: { where: Row }) => state.salesOrders.filter((r) => rowMatches(r, where)),
        updateMany: async () => ({ count: 0 }),
        update: async ({ where, data }: { where: { id: unknown }; data: Row }) => {
          state.salesOrderUpdates.push({ id: where.id, data })
          return {}
        },
      },
      purchaseInvoice: {
        findMany: async ({ where }: { where: Row }) => state.purchaseInvoices.filter((r) => rowMatches(r, where)),
        update: async ({ where, data }: { where: { id: unknown }; data: Row }) => {
          state.purchaseInvoiceUpdates.push({ id: where.id, data })
          return {}
        },
      },
    },
  },
})

async function poll() {
  const { pollXeroPayments } = await import('@/lib/connectors/xero/payment-poller')
  return pollXeroPayments()
}

function bill(overrides: Partial<XeroInvoice> = {}): XeroInvoice {
  return { InvoiceID: 'XB1', Type: 'ACCPAY', Status: 'AUTHORISED', ...overrides }
}

function paidBillRow(): Row {
  return {
    id: 'pi_1',
    accountingInvoiceId: 'XB1',
    paidAt: new Date('2026-08-01T00:00:00.000Z'),
    poId: 'po_1',
    po: { reference: 'PO-0001', status: 'RECEIVED' },
  }
}

function paidOrderRow(): Row {
  return {
    id: 'so_1',
    accountingInvoiceId: 'XS1',
    paidAt: new Date('2026-08-01T00:00:00.000Z'),
    orderNumber: 'SO-0001',
    externalOrderNumber: null,
    status: 'SHIPPED',
    refundStatus: 'NONE',
    revenueDeferredDate: new Date('2026-07-01T00:00:00.000Z'),
  }
}

const clearedPaidAt = (updates: { id: unknown; data: Row }[]) => updates.filter((u) => u.data.paidAt === null)

// ---------------------------------------------------------------------------
// Bills
// ---------------------------------------------------------------------------

test('a PART-paid bill is not a reversal: paidAt is kept and Mark Paid is not re-armed (o3d-clxw)', async () => {
  reset()
  state.invoices = [bill({ AmountPaid: 400, AmountDue: 100 })]
  state.purchaseInvoices = [paidBillRow()]

  const result = await poll()

  assert.deepEqual(clearedPaidAt(state.purchaseInvoiceUpdates), [],
    'the ledger still holds a payment, so paidAt must not be cleared — clearing it re-arms Mark Paid over a payment already made')
  assert.equal(result.billsReversed, 0)
  assert.equal(result.billReversalsWithheld, 1)

  const withheld = state.activity.find((a) => a.action === 'bill_payment_reversal_withheld')
  assert.ok(withheld, 'the disagreement must be reported, not swallowed')
  assert.equal(withheld.level, 'WARNING')
  assert.match(withheld.description ?? '', /PART payment, NOT a reversal/)
  assert.match(withheld.description ?? '', /pay the supplier twice/)
  assert.match(withheld.description ?? '', /400\.00/)
  assert.match(withheld.description ?? '', /100\.00/)
  assert.equal(withheld.metadata?.reason, 'part-payment')
  assert.equal(withheld.metadata?.amountPaid, 400)

  assert.equal(state.activity.some((a) => a.action === 'bill_payment_reversal_detected'), false,
    'nothing was reversed, so nothing may be logged as "no longer present in Xero"')
})

test('a bill whose payment really is gone (nothing paid in the ledger) is still reversed', async () => {
  reset()
  state.invoices = [bill({ AmountPaid: 0, AmountDue: 500 })]
  state.purchaseInvoices = [paidBillRow()]

  const result = await poll()

  assert.deepEqual(clearedPaidAt(state.purchaseInvoiceUpdates).map((u) => u.id), ['pi_1'])
  assert.equal(result.billsReversed, 1)
  assert.equal(result.billReversalsWithheld, 0)
  assert.ok(state.activity.some((a) => a.action === 'bill_payment_reversal_detected'))
})

test('a VOIDED bill is reversed even though it states no amounts', async () => {
  reset()
  // Xero requires payments to be removed before an invoice can be voided, and refuses a payment
  // against a voided one — so re-arming here cannot move money twice.
  state.invoices = [bill({ Status: 'VOIDED' })]
  state.purchaseInvoices = [paidBillRow()]

  const result = await poll()

  assert.deepEqual(clearedPaidAt(state.purchaseInvoiceUpdates).map((u) => u.id), ['pi_1'])
  assert.equal(result.billsReversed, 1)
})

test('an AUTHORISED bill that states no AmountPaid withholds the verdict rather than guessing', async () => {
  reset()
  state.invoices = [bill({ AmountDue: 500 })]
  state.purchaseInvoices = [paidBillRow()]

  const result = await poll()

  assert.deepEqual(clearedPaidAt(state.purchaseInvoiceUpdates), [],
    'unknown must not read as "the payment is gone" on a path whose next step pays a supplier')
  assert.equal(result.billsReversed, 0)
  assert.equal(result.billReversalsWithheld, 1)
  const withheld = state.activity.find((a) => a.action === 'bill_payment_reversal_withheld')
  assert.equal(withheld?.metadata?.reason, 'amount-not-stated')
  assert.match(withheld?.description ?? '', /did not state how much has been paid/)
})

test('an AUTHORISED bill IMS does not hold as paid is not reported at all', async () => {
  reset()
  state.invoices = [bill({ AmountPaid: 400, AmountDue: 100 })]
  state.purchaseInvoices = [{ ...paidBillRow(), paidAt: null }]

  const result = await poll()

  assert.equal(result.billReversalsWithheld, 0, 'an ordinary unpaid bill sitting at AUTHORISED is not a disagreement')
  assert.equal(state.activity.some((a) => a.action === 'bill_payment_reversal_withheld'), false)
})

// ---------------------------------------------------------------------------
// Sales — the same reading, and it drives a chargeback as well as clearPaidAt
// ---------------------------------------------------------------------------

test('a PART-paid sales invoice raises NO chargeback and keeps paidAt (o3d-clxw)', async () => {
  reset()
  state.invoices = [{ InvoiceID: 'XS1', Type: 'ACCREC', Status: 'AUTHORISED', AmountPaid: 90, AmountDue: 10 }]
  state.salesOrders = [paidOrderRow()]

  const result = await poll()

  assert.deepEqual(state.chargebacks, [],
    'the ledger is still holding the payment, so unwinding revenue against it would be a wrong credit note')
  assert.deepEqual(clearedPaidAt(state.salesOrderUpdates), [])
  assert.equal(result.salesReversed, 0)
  assert.equal(result.salesReversalsWithheld, 1)
  assert.deepEqual(state.notifications, [], 'no "payment reversal detected" alert for a payment that is present')

  const withheld = state.activity.find((a) => a.action === 'payment_reversal_withheld')
  assert.ok(withheld)
  assert.match(withheld.description ?? '', /NO chargeback credit note was raised/)
  assert.match(withheld.description ?? '', /PART payment, NOT a reversal/)
  assert.equal(state.activity.some((a) => a.action === 'payment_reversal_detected'), false)
})

test('a sales invoice whose payment really is gone is still reversed and charged back', async () => {
  reset()
  state.invoices = [{ InvoiceID: 'XS1', Type: 'ACCREC', Status: 'AUTHORISED', AmountPaid: 0, AmountDue: 100 }]
  state.salesOrders = [paidOrderRow()]

  const result = await poll()

  assert.deepEqual(state.chargebacks, ['so_1'])
  assert.deepEqual(clearedPaidAt(state.salesOrderUpdates).map((u) => u.id), ['so_1'])
  assert.equal(result.salesReversed, 1)
  assert.equal(result.salesReversalsWithheld, 0)
  assert.equal(state.notifications.length, 1)
})
