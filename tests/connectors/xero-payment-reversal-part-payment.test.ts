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
  /** AccountingSyncLog rows: the BILL_PAYMENT / INVOICE_PAYMENT registrations IMS holds. */
  syncLogs: [] as Row[],
  attempts: 0,
  activity: [] as LoggedActivity[],
  notifications: [] as { title?: string; message?: string; userId?: string | null }[],
  chargebacks: [] as string[],
  purchaseInvoiceUpdates: [] as { id: unknown; data: Row }[],
  salesOrderUpdates: [] as { id: unknown; data: Row }[],
  /** Every cursor write the drain made. Empty means the chunk was NOT checkpointed. */
  settingUpserts: [] as unknown[],
  /** Set to make the activity-log / notification write REPORT failure, as the real ones do. */
  activityWriteFails: false,
  notificationWriteFails: false,
}

function reset(): void {
  state.invoices = []
  state.salesOrders = []
  state.purchaseInvoices = []
  state.syncLogs = []
  state.attempts = 0
  state.activity = []
  state.notifications = []
  state.chargebacks = []
  state.purchaseInvoiceUpdates = []
  state.salesOrderUpdates = []
  state.settingUpserts = []
  state.activityWriteFails = false
  state.notificationWriteFails = false
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

// Both real helpers SWALLOW their write failures and report them through the *Persisted variants —
// the doubles do the same, so a test can make the write fail without making the call throw.
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: LoggedActivity) => { if (!state.activityWriteFails) state.activity.push(entry) },
    logActivityPersisted: async (entry: LoggedActivity) => {
      if (state.activityWriteFails) return false
      state.activity.push(entry)
      return true
    },
  },
})
mock.module('@/lib/notifications', {
  namedExports: {
    notify: async (n: { title?: string; message?: string }) => { if (!state.notificationWriteFails) state.notifications.push(n) },
    notifyPersisted: async (n: { title?: string; message?: string }) => {
      if (state.notificationWriteFails) return false
      state.notifications.push(n)
      return true
    },
  },
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
        upsert: async (args: unknown) => { state.settingUpserts.push(args); return {} },
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
      accountingSyncLog: {
        findMany: async ({ where }: { where: Row }) => state.syncLogs.filter((r) => rowMatches(r, where)),
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
  assert.equal(state.notifications.some((n) => n.title === 'Payment reversal detected'), false,
    'no "payment reversal detected" alert for a payment that is present')
  assert.equal(state.notifications.filter((n) => n.title === 'Payment reversal withheld').length, 1,
    'the disagreement itself IS alerted — an activity row in a firehose is a record, not an alert (o3d-clxw r2)')

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

// ---------------------------------------------------------------------------
// o3d-clxw ROUND 2 — WHOSE PAYMENT IS GONE?
//
// Round 1 asked "does the ledger hold ANY payment". A residual payment somebody applied in Xero
// AFTER deleting the one IMS registered answers yes, so the reversal was withheld for ever: the
// supplier payment IMS believes it made is gone, the cursor moves past the invoice, and the bill
// reads settled until a human happens to reconcile it.
// ---------------------------------------------------------------------------

/** A BILL_PAYMENT registration IMS holds against bill pi_1. */
function billRegistration(overrides: Row = {}): Row {
  return {
    id: 'log_1',
    connector: 'xero',
    type: 'BILL_PAYMENT',
    referenceType: 'PurchaseInvoice',
    referenceId: 'pi_1',
    status: 'SYNCED',
    externalTransactionId: 'PAY-OURS',
    syncedAt: new Date(Date.now() - 5 * 60_000),
    ...overrides,
  }
}

function salesRegistration(overrides: Row = {}): Row {
  return {
    id: 'log_s1',
    connector: 'xero',
    type: 'INVOICE_PAYMENT',
    referenceType: 'SalesOrder',
    referenceId: 'so_1',
    status: 'SYNCED',
    externalTransactionId: 'PAY-OURS-S',
    syncedAt: new Date(Date.now() - 5 * 60_000),
    ...overrides,
  }
}

test('OUR supplier payment deleted with a smaller one left behind IS a reversal, not a part payment (o3d-clxw r2)', async () => {
  reset()
  // IMS registered 500 (payment PAY-OURS). Somebody in Xero deleted it and applied 20 of their own.
  // Round 1 reads AmountPaid 20 as "a payment is present" and keeps paidAt for ever.
  state.invoices = [bill({ AmountPaid: 20, AmountDue: 480, Payments: [{ PaymentID: 'PAY-SOMEONE-ELSE' }] })]
  state.purchaseInvoices = [paidBillRow()]
  state.syncLogs = [billRegistration()]

  const result = await poll()

  assert.deepEqual(clearedPaidAt(state.purchaseInvoiceUpdates).map((u) => u.id), ['pi_1'],
    'the payment IMS registered is not among the payments Xero lists, so it is gone and paidAt must be cleared')
  assert.equal(result.billsReversed, 1)
  assert.equal(result.billReversalsWithheld, 0)

  const detected = state.activity.find((a) => a.action === 'bill_payment_reversal_detected')
  assert.ok(detected, 'the reversal must be logged')
  assert.match(detected.description ?? '', /PAY-OURS/)
  assert.match(detected.description ?? '', /still shows 20\.00 paid/)
  assert.match(detected.description ?? '', /residual payment is somebody else's/)
})

test('a residual payment that IS ours is still a part payment: paidAt kept, and the warning says whose it is', async () => {
  reset()
  // Xero lists our payment, so the shortfall is a genuine part payment (the bill was edited upward).
  state.invoices = [bill({ AmountPaid: 400, AmountDue: 100, Payments: [{ PaymentID: 'pay-ours' }] })]
  state.purchaseInvoices = [paidBillRow()]
  state.syncLogs = [billRegistration()]

  const result = await poll()

  assert.deepEqual(clearedPaidAt(state.purchaseInvoiceUpdates), [],
    'our payment is still in the ledger — clearing paidAt would re-arm Mark Paid over money already sent')
  assert.equal(result.billsReversed, 0)
  assert.equal(result.billReversalsWithheld, 1)

  const withheld = state.activity.find((a) => a.action === 'bill_payment_reversal_withheld')
  assert.equal(withheld?.metadata?.registrationVerdict, 'STILL_HELD')
  assert.match(withheld?.description ?? '', /payment IMS registered \(PAY-OURS\) is still among the payments/)
})

test('a registration that finished AFTER the Xero read cannot be declared gone by it', async () => {
  reset()
  // The Mark Paid race: paidAt is set locally at once, the worker posts the payment a few seconds
  // later. A read taken in between lists a payment that is not ours and does not list ours YET —
  // and declaring a reversal there re-arms Mark Paid over a payment that was just made.
  state.invoices = [bill({ AmountPaid: 20, AmountDue: 480, Payments: [{ PaymentID: 'PAY-SOMEONE-ELSE' }] })]
  state.purchaseInvoices = [paidBillRow()]
  state.syncLogs = [billRegistration({ syncedAt: new Date(Date.now() + 60_000) })]

  const result = await poll()

  assert.deepEqual(clearedPaidAt(state.purchaseInvoiceUpdates), [],
    'a registration this read cannot speak for withholds the verdict — the next press of Mark Paid pays a supplier')
  assert.equal(result.billsReversed, 0)
  assert.equal(result.billReversalsWithheld, 1)
  const withheld = state.activity.find((a) => a.action === 'bill_payment_reversal_withheld')
  assert.equal(withheld?.metadata?.registrationVerdict, 'REGISTRATION_UNDECIDED')
  assert.match(withheld?.description ?? '', /log_1/)
})

test('an in-flight (PROCESSING) registration withholds the verdict too', async () => {
  reset()
  state.invoices = [bill({ AmountPaid: 20, AmountDue: 480, Payments: [{ PaymentID: 'PAY-SOMEONE-ELSE' }] })]
  state.purchaseInvoices = [paidBillRow()]
  state.syncLogs = [billRegistration({ status: 'PROCESSING', externalTransactionId: null, syncedAt: null })]

  const result = await poll()

  assert.deepEqual(clearedPaidAt(state.purchaseInvoiceUpdates), [])
  assert.equal(result.billReversalsWithheld, 1)
  assert.equal(state.activity.find((a) => a.action === 'bill_payment_reversal_withheld')?.metadata?.registrationVerdict,
    'REGISTRATION_UNDECIDED')
})

test('a payload that does not list the payments cannot prove ours is absent', async () => {
  reset()
  // No Payments array at all. Absent is not empty: reading it as "the ledger holds no payments" would
  // manufacture the proof, which is the Number('') === 0 mistake one field over.
  state.invoices = [bill({ AmountPaid: 20, AmountDue: 480 })]
  state.purchaseInvoices = [paidBillRow()]
  state.syncLogs = [billRegistration()]

  const result = await poll()

  assert.deepEqual(clearedPaidAt(state.purchaseInvoiceUpdates), [])
  assert.equal(result.billReversalsWithheld, 1)
  assert.equal(state.activity.find((a) => a.action === 'bill_payment_reversal_withheld')?.metadata?.registrationVerdict,
    'LEDGER_DID_NOT_LIST_PAYMENTS')
})

test('a bill IMS never registered a payment for stays a part payment: IMS has no payment to be missing', async () => {
  reset()
  state.invoices = [bill({ AmountPaid: 20, AmountDue: 480, Payments: [{ PaymentID: 'PAY-SOMEONE-ELSE' }] })]
  state.purchaseInvoices = [paidBillRow()]
  state.syncLogs = []

  const result = await poll()

  assert.deepEqual(clearedPaidAt(state.purchaseInvoiceUpdates), [])
  assert.equal(result.billReversalsWithheld, 1)
  assert.equal(state.activity.find((a) => a.action === 'bill_payment_reversal_withheld')?.metadata?.registrationVerdict,
    'NOTHING_REGISTERED')
})

test('OUR sales payment gone with a residual one left: paidAt clears but NO chargeback is raised', async () => {
  reset()
  state.invoices = [{
    InvoiceID: 'XS1', Type: 'ACCREC', Status: 'AUTHORISED', AmountPaid: 15, AmountDue: 85,
    Payments: [{ PaymentID: 'PAY-SOMEONE-ELSE' }],
  }]
  state.salesOrders = [paidOrderRow()]
  state.syncLogs = [salesRegistration()]

  const result = await poll()

  assert.deepEqual(clearedPaidAt(state.salesOrderUpdates).map((u) => u.id), ['so_1'],
    'the payment IMS registered is gone, so the order is not paid')
  assert.equal(result.salesReversed, 1)
  assert.deepEqual(state.chargebacks, [],
    'a chargeback unwinds the WHOLE recognised revenue, and the ledger is still holding 15 against this invoice')
  const detected = state.activity.find((a) => a.action === 'payment_reversal_detected')
  assert.match(detected?.description ?? '', /PAY-OURS-S/)
  assert.match(detected?.description ?? '', /NO chargeback credit note was raised automatically/)
  const alert = state.notifications.find((n) => n.title === 'Payment reversal detected')
  assert.match(alert?.message ?? '', /revenue was NOT unwound automatically/)
})

// ---------------------------------------------------------------------------
// o3d-clxw ROUND 2 — A WITHHELD VERDICT THAT LEFT NO RECORD MUST NOT BE CHECKPOINTED PAST
//
// A withheld verdict writes nothing to the database; the warning is its only artefact. logActivity
// and notify both swallow their own write failures, so round 1 could count a verdict, write nothing,
// and let the drain move the cursor past an invoice the delta will never return again.
// ---------------------------------------------------------------------------

test('a withheld verdict whose warning did not reach the activity log holds the poll cursor', async () => {
  reset()
  state.invoices = [bill({ AmountPaid: 400, AmountDue: 100, Payments: [{ PaymentID: 'pay-ours' }] })]
  state.purchaseInvoices = [paidBillRow()]
  state.syncLogs = [billRegistration()]
  state.activityWriteFails = true

  const result = await poll()

  assert.deepEqual(state.settingUpserts, [],
    'checkpointing here loses the disagreement for good: the delta only returns an invoice when it CHANGES')
  assert.equal(result.errors.length, 1)
  assert.match(result.errors[0], /left no durable signal: the activity warning could not be written/)
  assert.match(result.errors[0], /PO PO-0001/)
})

test('a withheld verdict whose operator alert did not land holds the poll cursor too', async () => {
  reset()
  state.invoices = [bill({ AmountPaid: 400, AmountDue: 100, Payments: [{ PaymentID: 'pay-ours' }] })]
  state.purchaseInvoices = [paidBillRow()]
  state.syncLogs = [billRegistration()]
  state.notificationWriteFails = true

  const result = await poll()

  assert.deepEqual(state.settingUpserts, [])
  assert.equal(result.errors.length, 1)
  assert.match(result.errors[0], /left no durable signal: the operator alert could not be written/)
})

test('a withheld verdict that WAS recorded checkpoints normally', async () => {
  reset()
  state.invoices = [bill({ AmountPaid: 400, AmountDue: 100, Payments: [{ PaymentID: 'pay-ours' }] })]
  state.purchaseInvoices = [paidBillRow()]
  state.syncLogs = [billRegistration()]

  const result = await poll()

  assert.deepEqual(result.errors, [])
  assert.equal(state.settingUpserts.length, 1,
    'a recorded disagreement must not stall the poller — the cursor is held only when nothing was written')
  assert.equal(state.notifications.filter((n) => n.title === 'Bill payment reversal withheld').length, 1)
})

// ---------------------------------------------------------------------------
// o3d-clxw ROUND 3 — AND AN IN-FLIGHT PAYMENT READS AS A ZERO
//
// This branch exists because a PART-paid bill read as a reversal. Round 1 replaced that with "the
// ledger holds nothing" — and a payment IMS posted moments ago, or is posting right now, also reads
// as nothing held. Mark Paid sets paidAt at once and queues a BILL_PAYMENT registration; until the
// worker posts it the ledger is empty. A poll landing in that gap cleared paidAt, re-armed the
// button over IMS's OWN payment, and the operator pressed it: markBillPaid sends no idempotency key,
// BILL_PAYMENT is outside every live-row dedupe, and Xero's own key expires after six minutes, so
// nothing anywhere refuses the second supplier payment.
// ---------------------------------------------------------------------------

test('a zero-paid bill whose payment is STILL ON THE WIRE is not reversed: Mark Paid stays disarmed (o3d-clxw r3)', async () => {
  reset()
  // Nothing paid in the ledger, and IMS is holding a PROCESSING registration — the request may be
  // in Xero's hands this instant.
  state.invoices = [bill({ AmountPaid: 0, AmountDue: 500, Payments: [] })]
  state.purchaseInvoices = [paidBillRow()]
  state.syncLogs = [billRegistration({ status: 'PROCESSING', externalTransactionId: null, syncedAt: null })]

  const result = await poll()

  assert.deepEqual(clearedPaidAt(state.purchaseInvoiceUpdates), [],
    'the zero is our own unposted payment, not a removal — clearing paidAt re-arms Mark Paid and pays the supplier twice')
  assert.equal(result.billsReversed, 0)
  assert.equal(result.billReversalsWithheld, 1)

  const withheld = state.activity.find((a) => a.action === 'bill_payment_reversal_withheld')
  assert.ok(withheld, 'a withheld money verdict must leave a durable record')
  assert.equal(withheld.metadata?.reason, 'zero-paid-unproven')
  assert.equal(withheld.metadata?.registrationVerdict, 'REGISTRATION_UNDECIDED')
  assert.equal(withheld.metadata?.amountPaid, 0)
  assert.match(withheld.description ?? '', /NOTHING paid against it/)
  assert.match(withheld.description ?? '', /may be in flight/)
  assert.match(withheld.description ?? '', /idempotency key expires after six minutes/)
  assert.match(withheld.description ?? '', /log_1/)

  assert.equal(state.activity.some((a) => a.action === 'bill_payment_reversal_detected'), false,
    'nothing was reversed, so nothing may be logged as "no longer present in Xero"')
  assert.equal(state.notifications.filter((n) => n.title === 'Bill payment reversal withheld').length, 1)
})

test('a zero-paid bill whose registration SYNCED after the Xero read is not reversed either', async () => {
  reset()
  // The exact Mark Paid race: paidAt set locally, the worker posts a few seconds later, and this read
  // was taken in between. Its emptiness says nothing about a payment created after it.
  state.invoices = [bill({ AmountPaid: 0, AmountDue: 500, Payments: [] })]
  state.purchaseInvoices = [paidBillRow()]
  state.syncLogs = [billRegistration({ syncedAt: new Date(Date.now() + 60_000) })]

  const result = await poll()

  assert.deepEqual(clearedPaidAt(state.purchaseInvoiceUpdates), [])
  assert.equal(result.billsReversed, 0)
  assert.equal(result.billReversalsWithheld, 1)
  assert.equal(state.activity.find((a) => a.action === 'bill_payment_reversal_withheld')?.metadata?.registrationVerdict,
    'REGISTRATION_UNDECIDED')
})

test('a zero-paid bill whose payment attempt FAILED is not reversed: a failure is not proof nothing posted', async () => {
  reset()
  // The processor posts BEFORE it persists the outcome, so a lost response is written down exactly
  // like a rejection. Re-arming here queues a replacement under a fresh entry id and therefore a
  // fresh Idempotency-Key, on top of a payment that may already exist.
  state.invoices = [bill({ AmountPaid: 0, AmountDue: 500, Payments: [] })]
  state.purchaseInvoices = [paidBillRow()]
  state.syncLogs = [billRegistration({ status: 'FAILED', externalTransactionId: null, syncedAt: null })]

  const result = await poll()

  assert.deepEqual(clearedPaidAt(state.purchaseInvoiceUpdates), [])
  assert.equal(result.billReversalsWithheld, 1)
  const withheld = state.activity.find((a) => a.action === 'bill_payment_reversal_withheld')
  assert.equal(withheld?.metadata?.reason, 'zero-paid-unproven')
  assert.match(withheld?.description ?? '', /cancel the sync entry named below by hand/)
})

test('a zero-paid bill whose registration POSTED before the read IS reversed: our payment really is gone', async () => {
  reset()
  // The counter-guard. The registration finished before Xero was asked and the ledger holds nothing,
  // so the payment IMS made has been removed and Mark Paid must be re-armed.
  state.invoices = [bill({ AmountPaid: 0, AmountDue: 500, Payments: [] })]
  state.purchaseInvoices = [paidBillRow()]
  state.syncLogs = [billRegistration()]

  const result = await poll()

  assert.deepEqual(clearedPaidAt(state.purchaseInvoiceUpdates).map((u) => u.id), ['pi_1'])
  assert.equal(result.billsReversed, 1)
  assert.equal(result.billReversalsWithheld, 0)
  assert.ok(state.activity.some((a) => a.action === 'bill_payment_reversal_detected'))
})

test('a zero-paid bill whose only registration is CANCELLED IS reversed: nothing of ours can be in flight', async () => {
  reset()
  state.invoices = [bill({ AmountPaid: 0, AmountDue: 500, Payments: [] })]
  state.purchaseInvoices = [paidBillRow()]
  state.syncLogs = [billRegistration({ status: 'CANCELLED', externalTransactionId: null, syncedAt: null })]

  const result = await poll()

  assert.deepEqual(clearedPaidAt(state.purchaseInvoiceUpdates).map((u) => u.id), ['pi_1'],
    'CANCELLED is only ever asserted where nothing was sent — and it is the operator remedy for a stuck FAILED row')
  assert.equal(result.billsReversed, 1)
})

test('a zero-paid bill whose payload omits Payments[] IS reversed: a stated zero needs no list', async () => {
  reset()
  // LEDGER_DID_NOT_LIST_PAYMENTS blocks a RESIDUAL-paid invoice, where the list is the only way to
  // tell whose payment is there. Against a stated zero there is no money to attribute.
  state.invoices = [bill({ AmountPaid: 0, AmountDue: 500 })]
  state.purchaseInvoices = [paidBillRow()]
  state.syncLogs = [billRegistration()]

  const result = await poll()

  assert.deepEqual(clearedPaidAt(state.purchaseInvoiceUpdates).map((u) => u.id), ['pi_1'])
  assert.equal(result.billsReversed, 1)
})

test('a zero-paid SALES invoice with a payment in flight raises NO chargeback and keeps paidAt', async () => {
  reset()
  // The sales half of the same race: a credit note raised here unwinds recognised revenue against a
  // payment that is about to land.
  state.invoices = [{ InvoiceID: 'XS1', Type: 'ACCREC', Status: 'AUTHORISED', AmountPaid: 0, AmountDue: 100, Payments: [] }]
  state.salesOrders = [paidOrderRow()]
  state.syncLogs = [salesRegistration({ status: 'PROCESSING', externalTransactionId: null, syncedAt: null })]

  const result = await poll()

  assert.deepEqual(state.chargebacks, [], 'no credit note against a payment that has not landed yet')
  assert.deepEqual(clearedPaidAt(state.salesOrderUpdates), [])
  assert.equal(result.salesReversed, 0)
  assert.equal(result.salesReversalsWithheld, 1)
  const withheld = state.activity.find((a) => a.action === 'payment_reversal_withheld')
  assert.equal(withheld?.metadata?.reason, 'zero-paid-unproven')
  assert.match(withheld?.description ?? '', /NOTHING paid against it/)
  assert.match(withheld?.description ?? '', /wrong credit note/)
  assert.equal(state.notifications.some((n) => n.title === 'Payment reversal detected'), false)
})

test('a withheld zero-paid verdict that left no record holds the poll cursor', async () => {
  reset()
  state.invoices = [bill({ AmountPaid: 0, AmountDue: 500, Payments: [] })]
  state.purchaseInvoices = [paidBillRow()]
  state.syncLogs = [billRegistration({ status: 'PROCESSING', externalTransactionId: null, syncedAt: null })]
  state.activityWriteFails = true

  const result = await poll()

  assert.deepEqual(state.settingUpserts, [],
    'checkpointing past an unsignalled disagreement loses it for good — the delta only returns an invoice when it CHANGES')
  assert.equal(result.errors.length, 1)
  assert.match(result.errors[0], /left no durable signal/)
})

test('a zero-paid bill IMS does not hold as paid is neither reversed nor reported', async () => {
  reset()
  // An ordinary unpaid bill sitting at AUTHORISED with nothing paid is the commonest row in the
  // window. It must not become a withheld "disagreement" now that zero-paid rows reach the reading.
  state.invoices = [bill({ AmountPaid: 0, AmountDue: 500, Payments: [] })]
  state.purchaseInvoices = [{ ...paidBillRow(), paidAt: null }]
  state.syncLogs = [billRegistration({ status: 'PROCESSING', externalTransactionId: null, syncedAt: null })]

  const result = await poll()

  assert.equal(result.billReversalsWithheld, 0)
  assert.equal(result.billsReversed, 0)
  assert.equal(state.activity.some((a) => a.action === 'bill_payment_reversal_withheld'), false)
})

test('two bills on one Xero invoice: an in-flight payment on either holds BOTH', async () => {
  reset()
  // The promoted sets are keyed by INVOICE id while the verdicts are per DOCUMENT, and the reversal
  // pass selects on the invoice id. Admitting the clean bill would carry the withheld one's paidAt
  // away with it — a second supplier payment on the bill nobody could decide.
  state.invoices = [bill({ AmountPaid: 0, AmountDue: 500, Payments: [] })]
  state.purchaseInvoices = [
    paidBillRow(),
    { ...paidBillRow(), id: 'pi_2', poId: 'po_2', po: { reference: 'PO-0002', status: 'RECEIVED' } },
  ]
  state.syncLogs = [billRegistration({ id: 'log_2', referenceId: 'pi_2', status: 'PROCESSING', externalTransactionId: null, syncedAt: null })]

  const result = await poll()

  assert.deepEqual(clearedPaidAt(state.purchaseInvoiceUpdates), [],
    'one undecidable document makes the whole invoice undecidable — pi_1 must not be reversed on pi_2 behalf')
  assert.equal(result.billsReversed, 0)
})

test('a ledger that lists our payment while stating nothing is paid withholds rather than guesses', async () => {
  reset()
  // Reachable: Xero can carry a payment in Payments[] that has since been deleted, so the aggregate
  // falls to zero while the id is still listed. IMS cannot settle that from one read, and an
  // unsettled contradiction is not proof of a removal.
  state.invoices = [bill({ AmountPaid: 0, AmountDue: 500, Payments: [{ PaymentID: 'pay-ours' }] })]
  state.purchaseInvoices = [paidBillRow()]
  state.syncLogs = [billRegistration()]

  const result = await poll()

  assert.deepEqual(clearedPaidAt(state.purchaseInvoiceUpdates), [])
  assert.equal(result.billsReversed, 0)
  assert.equal(result.billReversalsWithheld, 1)
  const withheld = state.activity.find((a) => a.action === 'bill_payment_reversal_withheld')
  assert.equal(withheld?.metadata?.reason, 'zero-paid-unproven')
  assert.equal(withheld?.metadata?.registrationVerdict, 'STILL_HELD')
  assert.match(withheld?.description ?? '', /while also stating that nothing has been paid/)
  assert.doesNotMatch(withheld?.description ?? '', /genuine PART payment/,
    'a zero has no reading as a part payment')
})
