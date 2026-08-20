/**
 * Poll Xero for paid invoices (sales) and bills (purchases).
 * - Sales forward pass (unpaid→paid): manual orders only. WC orders take payment
 *   status from their channel and arrive with paidAt already set, so there is
 *   nothing for the forward pass to detect (see the shoppingLinks:{none:{}} filter).
 * - Sales reversal pass (paid→reversed): ALL sales orders incl. WC-linked (6oyu.6).
 *   A reversed payment / chargeback must clear paidAt + unwind revenue regardless of
 *   channel; the WC refund webhook stays authoritative via a per-order dedup guard.
 * - Purchases: all POs — detects when a bill is paid via Xero bank feed
 *
 * All four passes read ONE delta GET (o3d-5gm). Two things forced that rewrite:
 *
 *  1. The delta was never real. Every pass sent `ModifiedAfter=<cursor>` as a query param, which
 *     the Accounting API does not have — its modified-since filter is the If-Modified-Since HEADER.
 *     Xero ignores unknown query params rather than rejecting them, so the cursor was computed,
 *     threaded and thrown away, and every pass asked for the whole collection.
 *  2. Which then hit the page cap. With no `page` param Xero stops at 100 rows, so "every ACCREC
 *     invoice ever marked PAID" arrived as an arbitrary 100-row slice of history. On a tenant with
 *     more than 100 paid invoices the forward pass could simply fail to see a payment.
 *
 * So this is a correctness fix that happens to be ~6x cheaper: 6 calls/run (~576/day against a
 * 1,000/day cap) became 1 (~96/day).
 *
 * That one GET reads a window that can be too big to page through. It is no longer refused outright:
 * an oversized window is DRAINED in bounded chunks with the cursor checkpointed per chunk (o3d-zdh),
 * so a bulk edit in Xero costs a few extra polls instead of stalling payment detection until someone
 * notices. See drainInvoicesModifiedSince for the boundary rules that keep chunking lossless.
 */

import { xeroHttpAttemptCount } from '@/lib/connectors/xero/api'
import { db } from '@/lib/db'
import { xeroGet } from './api'
import { logActivity, logActivityPersisted } from '@/lib/activity-log'
import { notify, notifyPersisted } from '@/lib/notifications'
import { INTERNAL_ACTION_BYPASS } from '@/lib/internal-action-bypass'
import { detectPaymentReversals } from '@/lib/domain/accounting/payment-reversal'
import { handleDetectedReversal, type DetectedReversalOrder } from '@/lib/domain/accounting/reversal-handling'
import { withPaymentWriteLockOrSkip, isLockSkipped } from './payment-write-lock'

import {
  advanceCheckpoint,
  classifyRegisteredPayment,
  CURSOR_OVERLAP_MS,
  drainInvoicesModifiedSince,
  idsWhere,
  parseLedgerAmount,
  partitionPaymentReversals,
  type PaymentReversalReading,
  type RegisteredPaymentRow,
  type RegisteredPaymentVerdict,
  type XeroInvoice,
  type XeroInvoicesResponse,
} from './invoice-delta'

/** A Xero reversal can only ever speak about rows Xero itself issued. */
const XERO_CONNECTOR = 'xero'

// A detected payment reversal / chargeback needs a human to reconcile (dispute the
// chargeback, revert fulfilment, chase re-payment). Broadcast a warning to active
// admins — status is never auto-reverted, so the alert is the only prompt to review a
// shipped-but-reversed order. Fires even when a recent WC refund covered the revenue
// side (wcHandled), since that refund may only partially explain a full payment removal.
async function notifyReversalAdmins(
  order: DetectedReversalOrder,
  wcHandled: boolean,
  // The reversal was proved by the payment's IDENTITY while the invoice still carries a payment, so
  // no chargeback was raised — the alert must say that, or finance reads "reversed" as "unwound".
  registeredPaymentGone = false,
): Promise<void> {
  const ref = order.orderNumber ?? order.externalOrderNumber ?? order.id
  const message = (wcHandled
    ? `Payment for order ${ref} is no longer present in Xero (status: ${order.status}). A WooCommerce refund in this window already reversed revenue (no duplicate credit note raised) and paidAt was cleared — verify the refund fully covers the reversal and whether the order status should revert.`
    : `Payment for order ${ref} is no longer present in Xero (status: ${order.status}). paidAt was cleared and revenue unwound where applicable — review whether the order status should revert.`)
    + (registeredPaymentGone
      ? ` The payment IMS registered is gone from the invoice but ANOTHER payment (or an amount Xero did not state) remains, so revenue was NOT unwound automatically — decide the credit note by hand.`
      : '')
  const admins = await db.user.findMany({ where: { role: 'ADMIN', active: true }, select: { id: true } })
  await Promise.all(
    admins.map((admin) =>
      notify({
        userId: admin.id,
        type: 'warning',
        title: 'Payment reversal detected',
        message,
        actionUrl: `/sales/${order.id}`,
      }),
    ),
  )
}

// ---------------------------------------------------------------------------
// WHY A WITHHELD REVERSAL IS LOUD, AND WHAT MAKES IT DURABLE (o3d-clxw)
// ---------------------------------------------------------------------------
//
// A withheld reversal is a real disagreement: Xero says this document is not fully paid and IMS says
// it is paid. What must NOT follow from that is the automatic reconciliation — clearing paidAt
// re-arms Mark Paid over a supplier payment that has already been made, and on the sales side raises
// a chargeback credit note against a payment the ledger is still holding. So the write is withheld
// and the disagreement is reported instead, naming the amounts, for a human to settle.
//
// Only documents IMS currently holds as PAID are reported: the rest are ordinary unpaid invoices
// sitting at AUTHORISED, which is what almost every AUTHORISED invoice in the window is.
//
// ROUND 2: REPORTING IT WAS NOT THE SAME AS RECORDING IT.
//
// A withheld verdict writes NOTHING to the database. It is the one outcome of this poll whose only
// artefact is the warning — and round 1 wrote that warning with `logActivity`, which swallows its own
// failures by design and says so in its own doc comment: "AWAITING IT PROVES NOTHING about whether the
// entry was written. Callers that make a DECISION on the strength of having warned somebody ... must
// use logActivityPersisted". This is exactly such a caller, and the decision is the largest one this
// poll makes: leave a document IMS shows as PAID disagreeing with the ledger about money.
//
// The cursor then moved past the invoice. A checkpoint is one-way and the delta returns an invoice
// only when it CHANGES, so a warning that failed to write was not merely lost — the disagreement
// could never be re-derived. The bill reads settled for ever and nobody was ever told.
//
// So the signal is now DURABLE and FENCED:
//   - `logActivityPersisted` and `notifyPersisted` each REPORT whether they landed, and the verdict
//     reaches an operator through the same notification channel a DETECTED reversal uses. A row in an
//     activity firehose is a record; it is not an alert.
//   - if either fails, an error is pushed onto the poll result, and that is what stops the drain from
//     checkpointing this chunk. The window is re-read on the next poll and the verdict re-derived.
//
// Holding the cursor on a write that did not land is the rule every other pass in this poll already
// follows. The alternative is checkpointing past a money disagreement nobody was told about, which is
// the defect itself.

type WithheldAmountReason = 'part-payment' | 'amount-not-stated'

function withheldReason(invoice: XeroInvoice): WithheldAmountReason {
  return parseLedgerAmount(invoice.AmountPaid) === null ? 'amount-not-stated' : 'part-payment'
}

function ledgerAmountText(value: unknown): string {
  const parsed = parseLedgerAmount(value)
  return parsed === null ? 'an amount Xero did not state' : parsed.toFixed(2)
}

/**
 * What the REGISTRATION reading adds to a withheld warning: WHOSE payment the ledger is holding.
 *
 * The amount reading can only say "a payment is present". This says whether it is the one IMS
 * registered, or why IMS could not tell — which is the difference between "settle the balance" and
 * "our payment has been deleted and nobody noticed".
 */
function registrationText(verdict: RegisteredPaymentVerdict): string {
  switch (verdict.verdict) {
    case 'STILL_HELD':
      return ` The payment IMS registered (${verdict.paymentIds.join(', ')}) is still among the payments the `
        + `ledger lists on this invoice, so this is a genuine PART payment and not a removal of ours.`
    case 'NOTHING_REGISTERED':
      return ` IMS holds no payment registration for this document, so it cannot say whether the payment `
        + `the ledger is holding is the one IMS recorded.`
    case 'LEDGER_DID_NOT_LIST_PAYMENTS':
      return ` The payload did not list the payments held against the invoice, so IMS could not check `
        + `whether the payment it registered is still among them.`
    case 'REGISTRATION_UNDECIDED':
      return ` ${verdict.entryIds.length} payment registration(s) (${verdict.entryIds.join(', ')}) had not `
        + `finished when this Xero read was taken, so the read cannot say whether the payment they created `
        + `is still there.`
    case 'GONE':
      return ''
  }
}

/**
 * Alert every active admin, and REPORT whether every alert landed.
 *
 * A notification with no recipient is not a signal, so an installation with no active admin gets one
 * BROADCAST notification (userId null is visible to all users) rather than silently nothing.
 */
async function alertAdmins(params: { title: string; message: string; actionUrl: string }): Promise<boolean> {
  const admins = await db.user.findMany({ where: { role: 'ADMIN', active: true }, select: { id: true } })
  const targets: Array<string | null> = admins.length > 0 ? admins.map((a) => a.id) : [null]
  const landed = await Promise.all(
    targets.map((userId) => notifyPersisted({ userId, type: 'warning', ...params })),
  )
  return landed.every(Boolean)
}

/**
 * Write the durable record of a withheld verdict, and say so on the poll result if it did not land.
 *
 * The error is not decorative: `processDeltaChunk`'s caller stops the drain on any new error, which is
 * what keeps the cursor behind an unsignalled disagreement.
 */
async function signalWithheldReversal(
  entry: {
    label: string
    activity: Parameters<typeof logActivityPersisted>[0]
    alert: { title: string; message: string; actionUrl: string }
  },
  result: PollResult,
): Promise<void> {
  const logged = await logActivityPersisted(entry.activity)
  const alerted = await alertAdmins(entry.alert)
  if (logged && alerted) return
  const failures = [logged ? null : 'the activity warning', alerted ? null : 'the operator alert']
    .filter((f): f is string => f !== null)
    .join(' and ')
  result.errors.push(
    `Withheld payment reversal for ${entry.label} left no durable signal: ${failures} could not be written. `
    + `Holding the poll cursor so the disagreement is re-derived on the next poll instead of being `
    + `checkpointed past.`,
  )
}

// ---------------------------------------------------------------------------
// IS IT OUR PAYMENT THAT IS GONE? (o3d-clxw round 2)
// ---------------------------------------------------------------------------
//
// Round 1 asked the ledger whether it holds ANY payment. A residual payment — one somebody applied in
// Xero after deleting the one IMS registered — answers YES, and the reversal is withheld for ever:
// the supplier payment IMS believes it made is gone, the cursor moves past the invoice, and the bill
// reads settled until somebody reconciles by hand.
//
// So every withheld document is asked the narrower question against the identity IMS recorded (the
// PaymentID Xero returned when the registration posted, stored as `externalTransactionId`) and the
// payments the ledger LISTS on the invoice. Only `GONE` — every registered payment proved absent from
// a list we could fully read, from registrations that certainly posted before the read — is promoted
// to a reversal. Every other answer stays withheld exactly as round 1 left it, with the reason now
// naming whose payment is in question.

type ResidualDoc<T> = { doc: T; invoice: XeroInvoice; verdict: RegisteredPaymentVerdict }

type ResidualReading<T> = {
  /** Invoice id -> the document whose OWN registered payment is provably gone. Promoted to a reversal. */
  provenGone: Map<string, { doc: T; invoice: XeroInvoice; paymentIds: string[] }>
  /** Still withheld, with the reason the registration reading gives. */
  withheld: ResidualDoc<T>[]
}

function emptyResidual<T>(): ResidualReading<T> {
  return { provenGone: new Map(), withheld: [] }
}

/**
 * Ask, for each document IMS holds as paid whose invoice regressed, whether the payment IMS
 * registered against it is still in the ledger.
 *
 * `ledgerObservedBefore` is the instant Xero was asked; see classifyRegisteredPayment for why a
 * registration that finished after it cannot be decided by this read.
 */
async function readResidualVerdicts<T extends { id: string; accountingInvoiceId: string | null }>(
  docs: T[],
  withheldInvoices: Map<string, XeroInvoice>,
  registrationType: 'BILL_PAYMENT' | 'INVOICE_PAYMENT',
  referenceType: 'PurchaseInvoice' | 'SalesOrder',
  ledgerObservedBefore: Date,
): Promise<ResidualReading<T>> {
  const out = emptyResidual<T>()
  if (docs.length === 0) return out

  const rows = await db.accountingSyncLog.findMany({
    where: {
      connector: XERO_CONNECTOR,
      type: registrationType,
      referenceType,
      referenceId: { in: docs.map((d) => d.id) },
    },
    select: { id: true, referenceId: true, status: true, externalTransactionId: true, syncedAt: true },
  })
  const byDocument = new Map<string, RegisteredPaymentRow[]>()
  for (const row of rows) {
    const list = byDocument.get(row.referenceId) ?? []
    list.push({
      id: row.id,
      status: row.status,
      externalTransactionId: row.externalTransactionId,
      syncedAt: row.syncedAt,
    })
    byDocument.set(row.referenceId, list)
  }

  for (const doc of docs) {
    const invoice = doc.accountingInvoiceId ? withheldInvoices.get(doc.accountingInvoiceId) : undefined
    if (!invoice) continue
    const verdict = classifyRegisteredPayment(invoice, byDocument.get(doc.id) ?? [], ledgerObservedBefore)
    if (verdict.verdict === 'GONE') {
      out.provenGone.set(invoice.InvoiceID, { doc, invoice, paymentIds: verdict.paymentIds })
    } else {
      out.withheld.push({ doc, invoice, verdict })
    }
  }
  return out
}

type WithheldBillDoc = {
  id: string
  accountingInvoiceId: string | null
  poId: string
  po: { reference: string; status: string }
}

type WithheldOrderDoc = {
  id: string
  accountingInvoiceId: string | null
  orderNumber: string | null
  externalOrderNumber: string | null
  status: string
}

async function signalWithheldBillReversals(residual: ResidualReading<WithheldBillDoc>, result: PollResult): Promise<void> {
  for (const { doc: bill, invoice, verdict } of residual.withheld) {
    const reason = withheldReason(invoice)
    result.billReversalsWithheld++
    const description = (reason === 'part-payment'
      ? `Bill for PO ${bill.po.reference} is ${invoice.Status} in Xero (not fully paid), but the ledger `
        + `still holds a payment of ${ledgerAmountText(invoice.AmountPaid)} against it with `
        + `${ledgerAmountText(invoice.AmountDue)} still due. That is a PART payment, NOT a reversal, so `
        + `paidAt was left set: clearing it would re-arm Mark Paid over a supplier payment that has `
        + `already been made, and pressing it again would pay the supplier twice. Settle the balance in `
        + `Xero, or correct the bill total in IMS.`
      : `Bill for PO ${bill.po.reference} is ${invoice.Status} in Xero (not fully paid), but the invoice `
        + `payload did not state how much has been paid, so IMS cannot tell a part payment from a `
        + `removed one. paidAt was left set rather than guessed — clearing it would re-arm Mark Paid and `
        + `risk a second supplier payment. Check the bill in Xero and reconcile it by hand.`)
      + registrationText(verdict)

    await signalWithheldReversal({
      label: `PO ${bill.po.reference}`,
      activity: {
        entityType: 'PURCHASE_ORDER',
        entityId: bill.poId,
        action: 'bill_payment_reversal_withheld',
        tag: 'sync',
        level: 'WARNING',
        description,
        metadata: {
          reason,
          registrationVerdict: verdict.verdict,
          accountingInvoiceId: invoice.InvoiceID,
          xeroStatus: invoice.Status,
          amountPaid: parseLedgerAmount(invoice.AmountPaid),
          amountDue: parseLedgerAmount(invoice.AmountDue),
        },
        resolveUser: false,
      },
      alert: {
        title: 'Bill payment reversal withheld',
        message: description,
        actionUrl: `/purchasing/${bill.poId}`,
      },
    }, result)
  }
}

async function signalWithheldSalesReversals(residual: ResidualReading<WithheldOrderDoc>, result: PollResult): Promise<void> {
  for (const { doc: order, invoice, verdict } of residual.withheld) {
    const reason = withheldReason(invoice)
    const ref = order.orderNumber ?? order.externalOrderNumber ?? order.id
    result.salesReversalsWithheld++
    const description = (reason === 'part-payment'
      ? `Invoice for order ${ref} is ${invoice.Status} in Xero (not fully paid), but the ledger still `
        + `holds a payment of ${ledgerAmountText(invoice.AmountPaid)} against it with `
        + `${ledgerAmountText(invoice.AmountDue)} still due. That is a PART payment, NOT a reversal, so `
        + `paidAt was left set and NO chargeback credit note was raised — unwinding revenue against a `
        + `payment the ledger is still holding would be wrong. Settle the balance in Xero, or correct `
        + `the order total in IMS.`
      : `Invoice for order ${ref} is ${invoice.Status} in Xero (not fully paid), but the invoice payload `
        + `did not state how much has been paid, so IMS cannot tell a part payment from a removed one. `
        + `paidAt was left set and NO chargeback credit note was raised. Check the invoice in Xero and `
        + `reconcile it by hand.`)
      + registrationText(verdict)

    await signalWithheldReversal({
      label: `order ${ref}`,
      activity: {
        entityType: 'SALES_ORDER',
        entityId: order.id,
        action: 'payment_reversal_withheld',
        tag: 'sync',
        level: 'WARNING',
        description,
        metadata: {
          reason,
          registrationVerdict: verdict.verdict,
          accountingInvoiceId: invoice.InvoiceID,
          xeroStatus: invoice.Status,
          orderStatus: order.status,
          amountPaid: parseLedgerAmount(invoice.AmountPaid),
          amountDue: parseLedgerAmount(invoice.AmountDue),
        },
        resolveUser: false,
      },
      alert: {
        title: 'Payment reversal withheld',
        message: description,
        actionUrl: `/sales/${order.id}`,
      },
    }, result)
  }
}

type PollResult = {
  salesPaid: number
  billsPaid: number
  salesReversed: number
  billsReversed: number
  /**
   * Invoices that are no longer PAID in Xero but still carry a payment (or whose payment the payload
   * did not state), so the reversal was WITHHELD and paidAt left alone (o3d-clxw). Counted separately
   * from `reversed` because they are the opposite outcome: nothing was reconciled, and a human has
   * something to look at.
   */
  salesReversalsWithheld: number
  billReversalsWithheld: number
  errors: string[]
  skipped?: string
}

/**
 * The four passes, run over ONE slice of the delta.
 *
 * Lifted out of the poll body because an oversized window is no longer read whole: it is drained in
 * bounded chunks, each one processed and checkpointed before the next is read (o3d-zdh). Every pass
 * is idempotent, which is what makes both the chunk overlap and CURSOR_OVERLAP_MS free — the forward
 * passes only consider paidAt:null and the reversal passes only paidAt:not-null, so re-seeing an
 * invoice already reconciled does nothing.
 *
 * Errors are pushed onto `result` rather than thrown: the caller reads that to decide whether this
 * chunk may be checkpointed.
 */
async function processDeltaChunk(
  changed: XeroInvoice[],
  result: PollResult,
  { windowStart, ledgerObservedBefore }: { windowStart: Date; ledgerObservedBefore: Date },
): Promise<void> {
  const paidSalesIds = idsWhere(changed, 'ACCREC', ['PAID'])
  // NOT `idsWhere(..., ['AUTHORISED', 'VOIDED'])` any more (o3d-clxw). AUTHORISED means "approved and
  // not fully paid", which a bill carrying a real PART payment satisfies — reading it as a removal
  // cleared paidAt over money that had already left the bank. partitionPaymentReversals asks the
  // payload what the ledger HOLDS, and withholds the verdict when it cannot tell.
  const salesReversal = partitionPaymentReversals(changed, 'ACCREC')
  const voidedSalesIds = idsWhere(changed, 'ACCREC', ['VOIDED'])
  const paidBillIds = idsWhere(changed, 'ACCPAY', ['PAID'])
  const billReversal = partitionPaymentReversals(changed, 'ACCPAY')
  const invoiceById = new Map(changed.map((i) => [i.InvoiceID, i]))

  // --- Whose payment is gone? (o3d-clxw round 2) ---
  //
  // Read BEFORE either reversal pass, because its answer decides which documents those passes act on.
  // A read that throws leaves the reading empty, which is round 1's behaviour exactly — every withheld
  // document stays withheld — and pushes an error, so the chunk is not checkpointed and the question is
  // asked again next poll rather than silently answered "no".
  const billWithheldInvoices = new Map(
    [...billReversal.partPaid, ...billReversal.unverifiable].map((i) => [i.InvoiceID, i]),
  )
  let billResidual = emptyResidual<WithheldBillDoc>()
  try {
    const withheldBills = billWithheldInvoices.size === 0 ? [] : await db.purchaseInvoice.findMany({
      where: { accountingInvoiceId: { in: [...billWithheldInvoices.keys()] }, paidAt: { not: null } },
      select: { id: true, accountingInvoiceId: true, poId: true, po: { select: { reference: true, status: true } } },
    })
    billResidual = await readResidualVerdicts(
      withheldBills, billWithheldInvoices, 'BILL_PAYMENT', 'PurchaseInvoice', ledgerObservedBefore,
    )
  } catch (e) {
    result.errors.push(`Bills registered-payment reading error: ${String(e)}`)
  }

  const salesWithheldInvoices = new Map(
    [...salesReversal.partPaid, ...salesReversal.unverifiable].map((i) => [i.InvoiceID, i]),
  )
  let salesResidual = emptyResidual<WithheldOrderDoc>()
  try {
    const withheldOrders = salesWithheldInvoices.size === 0 ? [] : await db.salesOrder.findMany({
      where: { accountingInvoiceId: { in: [...salesWithheldInvoices.keys()] }, paidAt: { not: null } },
      select: { id: true, accountingInvoiceId: true, orderNumber: true, externalOrderNumber: true, status: true },
    })
    salesResidual = await readResidualVerdicts(
      withheldOrders, salesWithheldInvoices, 'INVOICE_PAYMENT', 'SalesOrder', ledgerObservedBefore,
    )
  } catch (e) {
    result.errors.push(`Sales registered-payment reading error: ${String(e)}`)
  }

  // A document whose OWN registered payment is proved absent from the ledger's list IS reversed, even
  // though a residual payment somebody else applied is still sitting there.
  const reversedSalesIds = new Set([...salesReversal.reversed, ...salesResidual.provenGone.keys()])
  const reversedBillIds = new Set([...billReversal.reversed, ...billResidual.provenGone.keys()])

  // --- Sales invoices (manual orders only — no shopping connector link) ---
  try {
    // Bounded by the delta rather than by history. This used to load EVERY unpaid order with an
    // invoice id and intersect client-side; now Xero has already told us which invoices moved.
    const unpaidManualOrders = paidSalesIds.size === 0 ? [] : await db.salesOrder.findMany({
      where: {
        accountingInvoiceId: { in: [...paidSalesIds] },
        paidAt: null,
        refundStatus: { not: 'FULL' }, // a fully refunded order must not be revived as paid
        shoppingLinks: { none: {} }, // Shopping orders get payment status from their channel
      },
      select: { id: true, accountingInvoiceId: true, orderNumber: true, externalOrderNumber: true, status: true },
    })

    for (const order of unpaidManualOrders) {
      const paidInvoice = order.accountingInvoiceId ? invoiceById.get(order.accountingInvoiceId) : undefined
      const paidDate = paidInvoice?.FullyPaidOnDate ? new Date(paidInvoice.FullyPaidOnDate) : new Date()

      // TWO independent guarded writes, not one, so a concurrent lifecycle move can neither drop the
      // payment nor be overwritten (o3d-2s8, Codex review of #496).
      //
      // 1) Record the payment. Guarded on the SAME invariants the candidate query used (still unpaid,
      //    not fully refunded), re-checked at WRITE time — a full refund committing after selection
      //    must not be revived, and this captures the payment regardless of any status change, so a
      //    concurrent PENDING_PAYMENT→ON_HOLD/PROCESSING cannot make us silently lose a real payment.
      const paid = await db.salesOrder.updateMany({
        where: { id: order.id, paidAt: null, refundStatus: { not: 'FULL' } },
        data: { paidAt: paidDate },
      })
      if (paid.count === 0) continue // already paid, or fully refunded since selection — nothing to do

      // 2) Advance the lifecycle ONLY if it is still waiting for payment, as an atomic conditional
      //    transition. The refund invariant is re-checked HERE too, not just on the payment write: a
      //    full refund can commit between the two writes (leaving status PENDING_PAYMENT), and
      //    advancing + allocating a fully-refunded order violates the invariant. Allocation follows
      //    only when the transition took, so a concurrent cancel/hold/refund is never overwritten.
      const advanced = await db.salesOrder.updateMany({
        where: { id: order.id, status: 'PENDING_PAYMENT', paidAt: { not: null }, refundStatus: { not: 'FULL' } },
        data: { status: 'PROCESSING' },
      })
      if (advanced.count === 1) {
        try {
          const { autoAllocateOrder } = await import('@/app/actions/allocation')
          await autoAllocateOrder(order.id, { internalBypassToken: INTERNAL_ACTION_BYPASS })
        } catch { /* Non-critical */ }
      }

      result.salesPaid++
      await logActivity({
        entityType: 'SALES_ORDER',
        entityId: order.id,
        action: 'payment_detected',
        tag: 'sync',
        level: 'INFO',
        description: `Payment detected via Xero for order ${order.orderNumber ?? order.externalOrderNumber}`,
        resolveUser: false,
      })
    }
  } catch (e) {
    result.errors.push(`Sales polling error: ${String(e)}`)
  }

  // --- Sales payment reversals (audit-M-acct #3, WC-inclusion 6oyu.6) ---
  // The forward poll only marks unpaid→paid. If an invoice IMS thinks is paid is
  // no longer PAID in Xero — payment reversed/deleted (back to AUTHORISED), an
  // amendment that voided the payment (AUTHORISED), or the invoice VOIDED — clear
  // paidAt so IMS stops showing it paid. Status is NOT auto-reverted (an order may
  // already be picking/shipped); a WARNING + admin notification carrying the current
  // status flags it.
  // 6oyu.6: WooCommerce-linked orders (the bulk of volume) are now INCLUDED — a
  // reversed payment / chargeback on a WC order must clear paidAt and unwind revenue
  // too. The WC refund webhook stays authoritative: handleDetectedReversal's
  // hasWooCommerceRefund dedup guard defers to any existing WC-side refund so the
  // poller never double-reverses an order the refund path already handled.
  // NOTE: still ordered after the forward pass, but the hazard that note describes is now gone at
  // the source: both passes read ONE snapshot, in which a pay-then-reverse invoice holds exactly
  // one current status (AUTHORISED) and so cannot appear in the paid set at all.
  try {
    // Bounded by the delta: ask only about orders whose invoice actually regressed. The old query
    // loaded every order ever paid on every run to intersect client-side.
    const paidOrders = reversedSalesIds.size === 0 ? [] : await db.salesOrder.findMany({
      where: {
        accountingInvoiceId: { in: [...reversedSalesIds] },
        paidAt: { not: null },
      },
      select: { id: true, accountingInvoiceId: true, orderNumber: true, externalOrderNumber: true, status: true, revenueDeferredDate: true },
    })
    if (paidOrders.length > 0) {
      for (const order of detectPaymentReversals(paidOrders, reversedSalesIds)) {
        // A VOIDED invoice has already had its AR/revenue reversed by Xero, so a
        // separate credit note would double-reverse — only auto-chargeback an
        // AUTHORISED payment removal where the invoice is still live (Codex P2).
        const invoiceVoided = order.accountingInvoiceId != null && voidedSalesIds.has(order.accountingInvoiceId)
        // A reversal PROVED by the payment's identity rather than by a zero balance (o3d-clxw r2). The
        // invoice still carries a payment — somebody else's, or an amount Xero did not state — so the
        // revenue unwind is suppressed: a chargeback credit note reverses the WHOLE recognised revenue,
        // and against an invoice the ledger is still holding money for that over-reverses. This is
        // round 1's rule kept intact, not relaxed: no automatic chargeback while the ledger holds a
        // payment. paidAt is still cleared, because the payment IMS recorded is genuinely gone.
        const registeredPaymentGone = order.accountingInvoiceId != null
          && salesResidual.provenGone.has(order.accountingInvoiceId)
        const { outcome, error } = await handleDetectedReversal(order, {
          invoiceVoided,
          ledgerStillHoldsPayment: registeredPaymentGone,
        }, {
          // Dedup (window-scoped): a WC-side refund (SalesOrderRefund carrying the WC
          // externalRefundId) recorded within THIS poll window means the WC refund
          // webhook already owns the revenue reversal — skip the redundant chargeback
          // and log quietly. Window-scoped so a HISTORIC partial refund never
          // permanently suppresses a genuine later reversal, and a no-op for manual
          // orders (which never have an externalRefundId), leaving that path unchanged.
          wasHandledByRecentWcRefund: async (orderId) => {
            const wcRefund = await db.salesOrderRefund.findFirst({
              where: { orderId, externalRefundId: { not: null }, createdAt: { gte: windowStart } },
              select: { id: true },
            })
            return wcRefund != null
          },
          // scjz.71: a reversed payment on a revenue-POSTED order is a chargeback —
          // raise a revenue-only credit note that reverses recognised revenue against
          // AR (COGS kept as a loss, no restock). raiseChargebackForReversedOrder is
          // idempotent (one chargeback per order) and refuses orders with any prior
          // refund — the authoritative guard against a double credit note even if the
          // window check races a WC refund. Dynamic import breaks the lib→action cycle.
          raiseChargeback: async (orderId) => {
            const { raiseChargebackForReversedOrder } = await import('@/app/actions/sales')
            return raiseChargebackForReversedOrder(orderId, { internalBypassToken: INTERNAL_ACTION_BYPASS })
          },
          // paidAt is reconciled unconditionally on a genuine regression (payment is
          // gone in Xero; the WC refund path does NOT clear paidAt), but ONLY after any
          // required chargeback succeeded — a failed chargeback holds paidAt so the
          // order stays in the next poll's paidOrders window and the reversal is
          // re-attempted (Codex P1) rather than left unpaid-and-unreversed.
          clearPaidAt: async (orderId) => {
            await db.salesOrder.update({ where: { id: orderId }, data: { paidAt: null } })
          },
          notifyNeedsAttention: (o, { wcHandled }) => notifyReversalAdmins(o, wcHandled, registeredPaymentGone),
          logReversalDetected: (o, { wcHandled }) => logActivity({
            entityType: 'SALES_ORDER',
            entityId: o.id,
            action: 'payment_reversal_detected',
            tag: 'sync',
            level: 'WARNING',
            description: (wcHandled
              ? `Payment reversed in Xero for order ${o.orderNumber ?? o.externalOrderNumber} (status: ${o.status}) — a WooCommerce refund in this window already reversed revenue (no duplicate credit note raised); cleared paidAt. Verify the WC refund fully covers the reversal and whether the order status should revert.`
              : `Payment no longer present in Xero for order ${o.orderNumber ?? o.externalOrderNumber} (status: ${o.status}) — cleared paidAt. Review whether the order status should revert.`)
              + (registeredPaymentGone
                ? ` The payment IMS registered (${salesResidual.provenGone.get(o.accountingInvoiceId ?? '')?.paymentIds.join(', ')}) is no longer among the payments Xero lists on this invoice, but the invoice still carries another payment or an amount Xero did not state — so NO chargeback credit note was raised automatically. Unwind revenue by hand if that is what the removal means.`
                : ''),
            resolveUser: false,
          }),
        })
        if (outcome === 'reversed') {
          result.salesReversed++
        } else if (outcome === 'chargeback-failed') {
          result.errors.push(`Chargeback for order ${order.orderNumber ?? order.id} failed: ${error}`)
        }
      }
    }
  } catch (e) {
    result.errors.push(`Sales reversal polling error: ${String(e)}`)
  }

  // Reported in its own pass so a reporting failure cannot lose a reversal that DID reconcile, and a
  // reversal pass that threw still leaves the withheld ones described.
  try {
    await signalWithheldSalesReversals(salesResidual, result)
  } catch (e) {
    result.errors.push(`Sales withheld-reversal reporting error: ${String(e)}`)
  }

  // --- Purchase bills (all POs) ---
  try {
    const unpaidBills = paidBillIds.size === 0 ? [] : await db.purchaseInvoice.findMany({
      where: {
        accountingInvoiceId: { in: [...paidBillIds] },
        paidAt: null,
      },
      select: { id: true, accountingInvoiceId: true, poId: true, po: { select: { reference: true } } },
    })

    for (const bill of unpaidBills) {
      const paidInvoice = bill.accountingInvoiceId ? invoiceById.get(bill.accountingInvoiceId) : undefined
      const paidDate = paidInvoice?.FullyPaidOnDate ? new Date(paidInvoice.FullyPaidOnDate) : new Date()

      await db.purchaseInvoice.update({
        where: { id: bill.id },
        data: { paidAt: paidDate },
      })

      result.billsPaid++
      await logActivity({
        entityType: 'PURCHASE_ORDER',
        entityId: bill.poId,
        action: 'bill_payment_detected',
        tag: 'sync',
        level: 'INFO',
        description: `Bill payment detected via Xero for PO ${bill.po.reference}`,
        resolveUser: false,
      })
    }
  } catch (e) {
    result.errors.push(`Bills polling error: ${String(e)}`)
  }

  // --- Purchase bill payment reversals (audit-M-acct #3) ---
  try {
    const paidBills = reversedBillIds.size === 0 ? [] : await db.purchaseInvoice.findMany({
      where: { accountingInvoiceId: { in: [...reversedBillIds] }, paidAt: { not: null } },
      select: { id: true, accountingInvoiceId: true, poId: true, po: { select: { reference: true, status: true } } },
    })
    if (paidBills.length > 0) {
      for (const bill of detectPaymentReversals(paidBills, reversedBillIds)) {
        await db.purchaseInvoice.update({ where: { id: bill.id }, data: { paidAt: null } })
        result.billsReversed++
        await logActivity({
          entityType: 'PURCHASE_ORDER',
          entityId: bill.poId,
          action: 'bill_payment_reversal_detected',
          tag: 'sync',
          level: 'WARNING',
          description: `Bill payment no longer present in Xero for PO ${bill.po.reference} (PO status: ${bill.po.status}) — cleared paidAt.`
            + (billResidual.provenGone.has(bill.accountingInvoiceId ?? '')
              // Named, because this is the case an amount reading calls a part payment: the ledger is
              // still holding money against this bill — just not ours.
              ? ` The payment IMS registered (${billResidual.provenGone.get(bill.accountingInvoiceId ?? '')?.paymentIds.join(', ')}) is no longer among the payments Xero lists on this invoice, though the invoice still shows ${ledgerAmountText(invoiceById.get(bill.accountingInvoiceId ?? '')?.AmountPaid)} paid — that residual payment is somebody else's, not the one IMS made.`
              : ''),
          resolveUser: false,
        })
      }
    }
  } catch (e) {
    result.errors.push(`Bills reversal polling error: ${String(e)}`)
  }

  try {
    await signalWithheldBillReversals(billResidual, result)
  } catch (e) {
    result.errors.push(`Bills withheld-reversal reporting error: ${String(e)}`)
  }
}

/**
 * Serialized with the daily backlog reconcile (o3d-2s8): both write paidAt from a Xero read, so they
 * must not interleave, or one could act on a state the other has already invalidated. If the reconcile
 * holds the write lock, this poll cycle skips and retries in 15 minutes — a skipped cycle is harmless
 * (the next one catches up), whereas a concurrent write is not.
 */
export async function pollXeroPayments(): Promise<PollResult> {
  const outcome = await withPaymentWriteLockOrSkip(() => pollXeroPaymentsLocked())
  if (isLockSkipped(outcome)) {
    return {
      salesPaid: 0, billsPaid: 0, salesReversed: 0, billsReversed: 0,
      salesReversalsWithheld: 0, billReversalsWithheld: 0,
      errors: [], skipped: 'backlog reconcile held the payment-write lock',
    }
  }
  return outcome
}

async function pollXeroPaymentsLocked(): Promise<PollResult> {
  const result = {
    salesPaid: 0, billsPaid: 0, salesReversed: 0, billsReversed: 0,
    salesReversalsWithheld: 0, billReversalsWithheld: 0,
    errors: [] as string[],
  }

  // Read last poll timestamp. Parsed defensively: the cursor is a free-text Setting, and an
  // unparseable one (hand-edited, truncated) would otherwise reach toISOString() and throw
  // RangeError straight out of here — the cron route does not wrap this call, so that is a 500
  // rather than a recorded error. Falling back to the same 24h default as a missing cursor keeps a
  // corrupt value degrading instead of breaking.
  const lastPollSetting = await db.setting.findUnique({ where: { key: 'xero_last_payment_poll' } })
  const defaultLastPoll = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const parsedLastPoll = lastPollSetting?.value ? new Date(lastPollSetting.value) : defaultLastPoll
  const lastPollDate = Number.isFinite(parsedLastPoll.getTime()) ? parsedLastPoll : defaultLastPoll
  if (lastPollDate !== parsedLastPoll) {
    console.warn(
      `[xero] xero_last_payment_poll is not a readable date (${JSON.stringify(lastPollSetting?.value)}); ` +
      `falling back to the last 24h.`,
    )
  }
  // Stamped BEFORE the fetch, not after the passes: anything modified while this poll is running
  // must fall inside the NEXT window, not be skipped by a cursor set to the time we happened to
  // finish. Paired with CURSOR_OVERLAP_MS below.
  const pollStartedAt = new Date()
  const since = new Date(lastPollDate.getTime() - CURSOR_OVERLAP_MS)

  // --- One delta read for all four passes, drained in bounded chunks if it is oversized ---
  //
  // The cursor moves per CHUNK, not per poll (o3d-zdh). A normal poll is still one unbounded request
  // and one chunk ending at pollStartedAt — identical to before. An oversized window is carved up
  // instead of refused, and each piece is checkpointed as soon as its passes complete, so a failure
  // partway through costs one chunk rather than the whole backlog and the next poll resumes from
  // where this one stopped instead of re-asking the same impossible question.
  //
  // `through` is the cursor value, NOT pollStartedAt: it is the exclusive upper bound of the slice
  // actually processed. Writing anything later would step over invoices this poll never read.
  //
  // AND NEVER EARLIER THAN THE CURSOR WE STARTED FROM (o3d-8f9 r3). The read floor is deliberately
  // CURSOR_OVERLAP_MS behind the persisted cursor so a record landing during the previous poll is
  // re-read; that overlap is a QUERY floor, not a checkpoint. If the overlap itself holds more than
  // one chunk — a couple of dense bulk-edit seconds is enough — the first chunk's `through` lands
  // BEFORE lastPollDate, and persisting it moves the cursor BACKWARD. The next poll then subtracts
  // the overlap from the regressed value and reproduces the same chunking, so it cycles: Codex
  // measured it settling at -44s, -49s, -55s, each poll spending 163-200 requests replaying overlap
  // and never reaching either the original checkpoint or newer work. Payment reconciliation stops
  // dead while burning the tenant's daily Xero allowance.
  //
  // Clamping to a monotonic maximum keeps the overlap doing its job (the records ARE re-read and
  // re-processed, idempotently) while making the checkpoint one-way.
  let checkpoint = lastPollDate
  const drain = await drainInvoicesModifiedSince(
    since,
    pollStartedAt,
    (path, opts) => xeroGet<XeroInvoicesResponse>(path, opts),  // budget-reconciled inside the drain
    async ({ invoices, through }) => {
      const errorsBefore = result.errors.length
      await processDeltaChunk(invoices, result, {
        windowStart: lastPollDate,
        // The instant Xero WAS ASKED, not the start of the window it covers: "had this registration
        // already posted when the ledger gave us this answer?" is a question about the READ. Stamped
        // before the fetch, so every chunk is read after it.
        ledgerObservedBefore: pollStartedAt,
      })
      // A pass that errored may have left work undone inside this chunk, so the chunk is not
      // checkpointed and the drain stops here — the same "hold the cursor on error" rule as before,
      // now applied per chunk instead of per poll.
      if (result.errors.length > errorsBefore) return 'stop'

      // A chunk inside the re-read overlap advances nothing: its work is done and recorded, but the
      // cursor stays where it was. Only a chunk that reaches past the old cursor moves it.
      const advanced = advanceCheckpoint(checkpoint, through)
      if (!advanced) return 'continue'
      checkpoint = advanced

      await db.setting.upsert({
        where: { key: 'xero_last_payment_poll' },
        create: { key: 'xero_last_payment_poll', value: through.toISOString() },
        update: { value: through.toISOString() },
      })
      return 'continue'
    },
    // Real HTTP attempts, not fetcher invocations: xeroGet retries a 429 internally, so one
    // invocation can be several tenant API calls (o3d-8f9 r3).
    xeroHttpAttemptCount,
  )

  if (!drain.ok) result.errors.push(`Xero invoice fetch failed: ${drain.error}`)

  if (result.errors.length > 0) {
    await logActivity({
      entityType: 'SYSTEM',
      action: 'xero_payment_poll_cursor_held',
      tag: 'sync',
      level: 'WARNING',
      description:
        `Xero payment poll stopped with errors after ${drain.chunks} chunk(s); the cursor is held at ` +
        `the last chunk that completed. ${result.errors.join(' | ')}`,
      metadata: result,
      resolveUser: false,
    })
  } else if (drain.ok && !drain.complete) {
    // Not an error: the backlog is being drained, progress is checkpointed, and the next scheduled
    // poll continues it. Logged as a WARNING anyway because an operator should know a bulk change
    // in Xero is taking several polls to work through.
    await logActivity({
      entityType: 'SYSTEM',
      action: 'xero_payment_poll_backlog_draining',
      tag: 'sync',
      level: 'WARNING',
      description:
        `Xero payment poll processed ${drain.chunks} bounded chunk(s) of an oversized delta and ` +
        `checkpointed each; the remainder resumes on the next poll.`,
      metadata: result,
      resolveUser: false,
    })
  }

  const withheld = result.salesReversalsWithheld + result.billReversalsWithheld
  if (result.salesPaid > 0 || result.billsPaid > 0 || result.salesReversed > 0 || result.billsReversed > 0 || withheld > 0) {
    await logActivity({
      entityType: 'SYSTEM',
      action: 'xero_payment_poll',
      tag: 'sync',
      level: 'INFO',
      description:
        `Payment poll: ${result.salesPaid} sales paid, ${result.billsPaid} bills paid, ` +
        `${result.salesReversed} sales reversed, ${result.billsReversed} bills reversed` +
        (withheld > 0
          ? `, ${withheld} reversal(s) WITHHELD because the ledger still holds a payment (or did not say) — ` +
            `see the per-document warnings`
          : ''),
      metadata: result,
      resolveUser: false,
    })
  }

  return result
}
