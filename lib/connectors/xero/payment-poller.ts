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
import {
  detectPaymentReversals,
  retireBillPaymentRegistrationsReversedInLedger,
  type LedgerClassifierProof,
} from '@/lib/domain/accounting/payment-reversal'
import { handleDetectedReversal, type DetectedReversalOrder } from '@/lib/domain/accounting/reversal-handling'
import { withPaymentWriteLockOrSkip, isLockSkipped } from './payment-write-lock'

import {
  advanceCheckpoint,
  classifyRegisteredPayment,
  CURSOR_OVERLAP_MS,
  databaseLedgerFence,
  drainInvoicesModifiedSince,
  idsWhere,
  parseLedgerAmount,
  partitionPaymentReversals,
  zeroPaidIsProvenReversal,
  type LedgerReadFence,
  type PaymentReversalReading,
  type RegisteredPaymentRow,
  type RegisteredPaymentVerdict,
  type XeroInvoice,
  type XeroInvoicesResponse,
} from './invoice-delta'
import type { ActivityEntityType } from '@/app/generated/prisma/client'

/** A Xero reversal can only ever speak about rows Xero itself issued. */
const XERO_CONNECTOR = 'xero'

/**
 * THE INSTANT THE LEDGER WAS ASKED, READ FROM THE DATABASE (o3d-clxw round 4).
 *
 * This is one half of the fence that decides whether a registration's absence from a Xero snapshot
 * proves the payment was removed; the other half is `accounting_sync_logs."syncedAt"`, stamped by
 * `stampSyncedAtFromDatabaseClock` with the SAME expression on the SAME server. Round 3 had this end
 * as `new Date()` on the poll host and the other end as `new Date()` on the sync-processor host, and
 * an ordering that rests on two machines agreeing is not an ordering: with the poller's clock ahead,
 * a payment posted AFTER the snapshot reads as posted before it, its absence reads as proof, `paidAt`
 * is cleared, Mark Paid re-arms and the supplier is paid twice.
 *
 * MUST be read BEFORE the ledger request goes out. That ordering is this function returning before
 * `xeroGet` is called — program order inside one process — not a comparison of any two clock values.
 *
 * NULL ON FAILURE, and null means NOTHING IS DECIDED (see classifyRegisteredPayment): with no fence
 * every registration might have landed after the snapshot, so every document with one withholds.
 * Fail-closed also keeps the o3d-batch-payidx algebra: the decided set only ever shrinks.
 */
async function readDatabaseLedgerFence(): Promise<LedgerReadFence | null> {
  try {
    const rows = await db.$queryRaw<Array<{ fence: Date | string | null }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS fence`
    const fence = rows?.[0]?.fence
    // Normalised rather than `instanceof`-checked: a raw query can hand back a driver Date, a Date
    // from another realm, or a string, and none of those is a reason to lose the ordering. An
    // unreadable value still is.
    if (fence == null) return null
    const at = new Date(fence as string | Date).getTime()
    if (!Number.isFinite(at)) return null
    return databaseLedgerFence(new Date(at))
  } catch {
    return null
  }
}

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
  // o3d-w00 (Codex r8 #3): set when the revenue unwind was REFUSED for a reason polling cannot clear.
  // The alert has to say so on the FIRST failure — this is the only thing that will tell anyone the
  // credit note is outstanding, since no further poll can raise it.
  chargebackManualReason?: string,
  // o3d-w00 (Codex r9 #4): the alert now fires even when clearing paidAt FAILED, so it must say which
  // of the two happened. `false` means IMS still shows the order paid; the next poll re-detects it.
  paidAtCleared: boolean = true,
): Promise<void> {
  const ref = order.orderNumber ?? order.externalOrderNumber ?? order.id
  const paidAtClause = paidAtCleared
    ? 'paidAt was cleared'
    : 'paidAt could NOT be cleared and the order still shows as paid in IMS'
  const message = (chargebackManualReason
    ? `Payment for order ${ref} is no longer present in Xero (status: ${order.status}). ${paidAtClause}, but the revenue unwind was REFUSED and NO credit note has been raised: ${chargebackManualReason} Raise the credit note manually, or fix the tax mapping and re-run the payment poller.`
    : wcHandled
      ? `Payment for order ${ref} is no longer present in Xero (status: ${order.status}). A WooCommerce refund in this window already reversed revenue (no duplicate credit note raised) and ${paidAtClause} — verify the refund fully covers the reversal and whether the order status should revert.`
      : `Payment for order ${ref} is no longer present in Xero (status: ${order.status}). ${paidAtClause} and revenue unwound where applicable — review whether the order status should revert.`)
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

/**
 * WHY a reversal was withheld. Three causes, one outcome — `paidAt` left set and a human told.
 *
 * `zero-paid-unproven` is round 3's: the LEDGER's answer was a clean zero and would have been acted
 * on, and it is IMS's OWN registration rows that withheld it, because one of them may have put a
 * payment into the ledger that this read did not see.
 */
type WithheldAmountReason = 'part-payment' | 'amount-not-stated' | 'zero-paid-unproven'

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
function registrationText(verdict: RegisteredPaymentVerdict, reason: WithheldAmountReason): string {
  switch (verdict.verdict) {
    case 'STILL_HELD':
      return reason === 'zero-paid-unproven'
        // A ledger that lists our payment while stating nothing is paid is contradicting itself, and
        // "a part payment" is not an available reading of a zero.
        ? ` The ledger LISTS the payment IMS registered (${verdict.paymentIds.join(', ')}) on this `
          + `invoice while also stating that nothing has been paid against it. IMS cannot settle that `
          + `contradiction from one read, and an unsettled contradiction is not proof of a removal.`
        : ` The payment IMS registered (${verdict.paymentIds.join(', ')}) is still among the payments the `
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
 *
 * ON A RECHECK (o3d-clxw round 4) the alert is deliberately NOT re-raised: the operator was already
 * told when the verdict was first withheld, that alert is durable, and re-alerting every recheck
 * interval for a document nobody can resolve today turns the signal into noise. The activity row IS
 * still rewritten, because it is what carries the recheck timer — a row that fails to land leaves the
 * previous marker as the latest one, which leaves the document due, which is the behaviour we want.
 */
async function signalWithheldReversal(
  entry: {
    label: string
    activity: Parameters<typeof logActivityPersisted>[0]
    alert: { title: string; message: string; actionUrl: string }
  },
  result: PollResult,
  mode: WithheldSignalMode,
): Promise<void> {
  const logged = await logActivityPersisted(entry.activity)
  const alerted = mode.recheck ? true : await alertAdmins(entry.alert)
  if (logged && alerted) return
  const failures = [logged ? null : 'the activity warning', alerted ? null : 'the operator alert']
    .filter((f): f is string => f !== null)
    .join(' and ')
  result.errors.push(
    `Withheld payment reversal for ${entry.label} left no durable signal: ${failures} could not be written. `
    + (mode.recheck
      ? `The recheck marker was not refreshed, so the document stays due and will be reconsidered on `
        + `the next poll.`
      : `Holding the poll cursor so the disagreement is re-derived on the next poll instead of being `
        + `checkpointed past.`),
  )
}

/**
 * How a withheld verdict is being signalled, and who wants to know it happened.
 *
 * `observe` is how the recheck pass learns that a document it re-asked about is STILL withheld. It is
 * called for every withheld document whether or not the record landed, because "we could not write it
 * down" must never be mistaken for "the disagreement is over".
 */
type WithheldSignalMode = {
  recheck: boolean
  observe?: (entityKey: string) => void
}

/** The key a withheld document is tracked by — the same pair its activity rows are written under. */
function withheldEntityKey(entityType: ActivityEntityType, entityId: string): string {
  return `${entityType}:${entityId}`
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

type ResidualDoc<T> = {
  doc: T
  invoice: XeroInvoice
  verdict: RegisteredPaymentVerdict
  reason: WithheldAmountReason
}

type ResidualReading<T> = {
  /**
   * Invoice id -> the document whose OWN registered payment is provably gone WHILE THE LEDGER STILL
   * HOLDS MONEY against the invoice. Promoted to a reversal, with the revenue unwind suppressed:
   * somebody else's payment is sitting there.
   */
  provenGone: Map<string, { doc: T; invoice: XeroInvoice; paymentIds: string[] }>
  /**
   * Invoice ids the LEDGER read as zero-paid AND whose registrations this read can account for
   * (o3d-clxw round 3). An ordinary reversal in every respect — the ledger holds nothing, so a sales
   * chargeback is correct here and is NOT suppressed.
   *
   * Empty is the fail-closed answer: if the registration read throws, nothing is admitted, an error
   * is pushed, and the chunk is not checkpointed.
   */
  zeroPaidReversed: Set<string>
  /** Still withheld, with the reason the readings give between them. */
  withheld: ResidualDoc<T>[]
}

function emptyResidual<T>(): ResidualReading<T> {
  return { provenGone: new Map(), zeroPaidReversed: new Set(), withheld: [] }
}

/**
 * Ask, for each document IMS holds as paid whose invoice regressed, whether the payment IMS
 * registered against it is still in the ledger — and route the answer by WHAT THE LEDGER SAID.
 *
 * Two populations arrive here and they need opposite defaults, which is the whole of round 3:
 *
 *   the ledger holds money (partPaid / unverifiable)   withheld by default. Only a PROVED absence of
 *                                                      our own payment (GONE) promotes it.
 *   the ledger holds nothing (zeroPaid)                a reversal by default — EXCEPT that a zero is
 *                                                      also what an unposted payment of ours looks
 *                                                      like, so a registration this read cannot speak
 *                                                      for withholds it. See zeroPaidIsProvenReversal.
 *
 * `ledgerObservedBefore` is the instant Xero was asked AS THE DATABASE MEASURED IT; see
 * classifyRegisteredPayment for why a registration that finished after it cannot be decided by this
 * read, and why a null fence decides nothing at all.
 */
async function readResidualVerdicts<T extends { id: string; accountingInvoiceId: string | null }>(
  docs: T[],
  candidateInvoices: Map<string, XeroInvoice>,
  zeroPaidInvoiceIds: ReadonlySet<string>,
  registrationType: 'BILL_PAYMENT' | 'INVOICE_PAYMENT',
  referenceType: 'PurchaseInvoice' | 'SalesOrder',
  ledgerObservedBefore: LedgerReadFence | null,
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
    // `syncedAtDatabaseClock` is selected WITH `syncedAt` and never instead of it: the fence is the
    // two agreeing, which is what makes a stamp written by an old build's host clock visible as one
    // (o3d-clxw round 5, finding 1 — see databaseStampedCompletion).
    select: {
      id: true, referenceId: true, status: true, externalTransactionId: true,
      syncedAt: true, syncedAtDatabaseClock: true,
    },
  })
  const byDocument = new Map<string, RegisteredPaymentRow[]>()
  for (const row of rows) {
    const list = byDocument.get(row.referenceId) ?? []
    list.push({
      id: row.id,
      status: row.status,
      externalTransactionId: row.externalTransactionId,
      syncedAt: row.syncedAt,
      syncedAtDatabaseClock: row.syncedAtDatabaseClock,
    })
    byDocument.set(row.referenceId, list)
  }

  for (const doc of docs) {
    const invoice = doc.accountingInvoiceId ? candidateInvoices.get(doc.accountingInvoiceId) : undefined
    if (!invoice) continue
    const verdict = classifyRegisteredPayment(invoice, byDocument.get(doc.id) ?? [], ledgerObservedBefore)

    if (zeroPaidInvoiceIds.has(invoice.InvoiceID)) {
      if (zeroPaidIsProvenReversal(verdict)) {
        out.zeroPaidReversed.add(invoice.InvoiceID)
      } else {
        out.withheld.push({ doc, invoice, verdict, reason: 'zero-paid-unproven' })
      }
      continue
    }

    const reason: WithheldAmountReason =
      parseLedgerAmount(invoice.AmountPaid) === null ? 'amount-not-stated' : 'part-payment'
    if (verdict.verdict === 'GONE') {
      out.provenGone.set(invoice.InvoiceID, { doc, invoice, paymentIds: verdict.paymentIds })
    } else {
      out.withheld.push({ doc, invoice, verdict, reason })
    }
  }

  // AN INVOICE WITH ANY WITHHELD DOCUMENT IS NEVER REVERSED. Both promoted sets are keyed by INVOICE
  // id while the verdicts are per DOCUMENT, and the reversal passes select on the invoice id — so two
  // IMS documents sharing one `accountingInvoiceId` could otherwise have the admitted one's id clear
  // `paidAt` on the withheld one as well. The intersection is the safe reading of a disagreement.
  for (const { doc } of out.withheld) {
    if (doc.accountingInvoiceId == null) continue
    out.zeroPaidReversed.delete(doc.accountingInvoiceId)
    out.provenGone.delete(doc.accountingInvoiceId)
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

function billWithheldDescription(bill: WithheldBillDoc, invoice: XeroInvoice, reason: WithheldAmountReason): string {
  switch (reason) {
    case 'part-payment':
      return `Bill for PO ${bill.po.reference} is ${invoice.Status} in Xero (not fully paid), but the ledger `
        + `still holds a payment of ${ledgerAmountText(invoice.AmountPaid)} against it with `
        + `${ledgerAmountText(invoice.AmountDue)} still due. That is a PART payment, NOT a reversal, so `
        + `paidAt was left set: clearing it would re-arm Mark Paid over a supplier payment that has `
        + `already been made, and pressing it again would pay the supplier twice. Settle the balance in `
        + `Xero, or correct the bill total in IMS.`
    case 'amount-not-stated':
      return `Bill for PO ${bill.po.reference} is ${invoice.Status} in Xero (not fully paid), but the invoice `
        + `payload did not state how much has been paid, so IMS cannot tell a part payment from a `
        + `removed one. paidAt was left set rather than guessed — clearing it would re-arm Mark Paid and `
        + `risk a second supplier payment. Check the bill in Xero and reconcile it by hand.`
    case 'zero-paid-unproven':
      return `Bill for PO ${bill.po.reference} is ${invoice.Status} in Xero with NOTHING paid against it, `
        + `which normally means the payment was removed. paidAt was LEFT SET anyway: IMS holds a payment `
        + `registration for this bill that this Xero read cannot speak for, so the zero may be a payment `
        + `of OURS that has not reached the ledger yet rather than one taken away. Clearing paidAt would `
        + `re-arm Mark Paid over a payment that may be in flight, and pressing it would pay the supplier `
        + `a second time — Xero's idempotency key expires after six minutes, so nothing downstream would `
        + `refuse it. IMS will decide this by itself once a read covers those registrations; if it never `
        + `does, reconcile the bill in Xero and cancel the sync entry named below by hand.`
  }
}

async function signalWithheldBillReversals(
  residual: ResidualReading<WithheldBillDoc>,
  result: PollResult,
  mode: WithheldSignalMode,
): Promise<void> {
  for (const { doc: bill, invoice, verdict, reason } of residual.withheld) {
    result.billReversalsWithheld++
    mode.observe?.(withheldEntityKey('PURCHASE_ORDER', bill.poId))
    const description = billWithheldDescription(bill, invoice, reason) + registrationText(verdict, reason)

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
    }, result, mode)
  }
}

function salesWithheldDescription(ref: string, invoice: XeroInvoice, reason: WithheldAmountReason): string {
  switch (reason) {
    case 'part-payment':
      return `Invoice for order ${ref} is ${invoice.Status} in Xero (not fully paid), but the ledger still `
        + `holds a payment of ${ledgerAmountText(invoice.AmountPaid)} against it with `
        + `${ledgerAmountText(invoice.AmountDue)} still due. That is a PART payment, NOT a reversal, so `
        + `paidAt was left set and NO chargeback credit note was raised — unwinding revenue against a `
        + `payment the ledger is still holding would be wrong. Settle the balance in Xero, or correct `
        + `the order total in IMS.`
    case 'amount-not-stated':
      return `Invoice for order ${ref} is ${invoice.Status} in Xero (not fully paid), but the invoice payload `
        + `did not state how much has been paid, so IMS cannot tell a part payment from a removed one. `
        + `paidAt was left set and NO chargeback credit note was raised. Check the invoice in Xero and `
        + `reconcile it by hand.`
    case 'zero-paid-unproven':
      // The sales side of the same race: an INVOICE_PAYMENT registered and not yet posted reads as a
      // zero, and a chargeback raised there reverses recognised revenue against a payment about to land.
      return `Invoice for order ${ref} is ${invoice.Status} in Xero with NOTHING paid against it, which `
        + `normally means the payment was removed. paidAt was LEFT SET and NO chargeback credit note was `
        + `raised: IMS holds a payment registration for this order that this Xero read cannot speak for, `
        + `so the zero may be a payment of OURS that has not reached the ledger yet. Unwinding revenue `
        + `against a payment that is about to land would be a wrong credit note. IMS will decide this by `
        + `itself once a read covers those registrations.`
  }
}

async function signalWithheldSalesReversals(
  residual: ResidualReading<WithheldOrderDoc>,
  result: PollResult,
  mode: WithheldSignalMode,
): Promise<void> {
  for (const { doc: order, invoice, verdict, reason } of residual.withheld) {
    const ref = order.orderNumber ?? order.externalOrderNumber ?? order.id
    result.salesReversalsWithheld++
    mode.observe?.(withheldEntityKey('SALES_ORDER', order.id))
    const description = salesWithheldDescription(ref, invoice, reason) + registrationText(verdict, reason)

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
    }, result, mode)
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
   *
   * ONE FIELD AND ONE ACTION (`bill_payment_reversal_withheld`) FOR EVERY CAUSE: "we would have
   * cleared paidAt and did not" is one fact, and splitting it into per-cause counters would hide it.
   * Three causes now that the two branches are together — the ledger's amount/identity reading cannot
   * prove the payment is gone (o3d-clxw), a registration this read cannot speak for (o3d-a3wx round 4
   * #2), and a ledger status that does not prove a reversal at all (round 8). The cause is named in
   * the activity description, not in a second number.
   */
  salesReversalsWithheld: number
  billReversalsWithheld: number
  /**
   * Withheld reversals this poll went back and RECONSIDERED (o3d-clxw round 4), and how many of them
   * the reconsideration closed — either because the disagreement was resolved (the reversal was
   * finally admitted, the ledger caught up, or the document is no longer held as paid) or because
   * there is no longer anything to decide. `withheldRechecked - withheldResolved` is what is still
   * open and will be asked again after the next interval.
   */
  withheldRechecked: number
  withheldResolved: number
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
/**
 * TWO TIMESTAMPS, NOT ONE (Codex round 4 #2).
 *
 * Round 3 handed `lastPollDate` to this function under the single name `windowStart` and used it for
 * two unrelated jobs. It is correct for one of them and badly wrong for the other:
 *
 *   windowStart          the DELTA window. "Has a WooCommerce refund been recorded since the last
 *                        poll?" is a question about the period this poll covers, and lastPollDate is
 *                        exactly that period's start.
 *   ledgerObservedBefore the instant XERO WAS ASKED. "Had this registration already posted when the
 *                        ledger gave us this answer?" is a question about the READ, and the read
 *                        happens at the END of the window, not the start. Fenced on lastPollDate,
 *                        EVERY registration that posted during the preceding fifteen minutes counted
 *                        as unreadable — and on a cold cursor the default window is TWENTY-FOUR
 *                        HOURS, so a full day of registrations was undecidable for no reason.
 *
 * AND IT IS THE DATABASE'S CLOCK, NOT THIS HOST'S (o3d-clxw round 4, merged as #634). This branch
 * originally passed `pollStartedAt` — a `new Date()` on whichever instance ran the poll — against a
 * `syncedAt` written by `new Date()` on whichever instance ran the sync processor. Two free-running
 * clocks, and one skew direction clears paidAt over a payment still in flight. `LedgerReadFence` is
 * branded so only `databaseLedgerFence` can mint one, from a `SELECT clock_timestamp()` taken
 * immediately BEFORE the ledger was asked; a plain `Date` no longer type-checks here, which is the
 * point. NULL means the database clock could not be read, and then nothing this poll saw can be
 * ordered against anything — every registration withholds.
 */
async function processDeltaChunk(
  changed: XeroInvoice[],
  result: PollResult,
  { windowStart, ledgerObservedBefore, withheldMode = { recheck: false } }: {
    windowStart: Date
    /** Database-measured instant the ledger was asked; null = nothing this read can decide. */
    ledgerObservedBefore: LedgerReadFence | null
    /** Set by the withheld-recheck pass so it can tell "still withheld" from "resolved". */
    withheldMode?: WithheldSignalMode
  },
): Promise<void> {
  const paidSalesIds = idsWhere(changed, 'ACCREC', ['PAID'])
  // NOT `idsWhere(..., ['AUTHORISED', 'VOIDED'])` any more (o3d-clxw). AUTHORISED means "approved and
  // not fully paid", which a bill carrying a real PART payment satisfies — reading it as a removal
  // cleared paidAt over money that had already left the bank. partitionPaymentReversals asks the
  // payload what the ledger HOLDS, and withholds the verdict when it cannot tell.
  //
  // AND ITS `zeroPaid` BUCKET IS NOT A VERDICT EITHER (round 3). Only `voided` clears paidAt on the
  // strength of the ledger alone; a zero has to be put to the registration reading below, because a
  // payment IMS posted seconds ago reads exactly like one that was taken away.
  const salesReversal = partitionPaymentReversals(changed, 'ACCREC')
  const voidedSalesIds = salesReversal.voided
  const paidBillIds = idsWhere(changed, 'ACCPAY', ['PAID'])
  const billReversal = partitionPaymentReversals(changed, 'ACCPAY')
  const invoiceById = new Map(changed.map((i) => [i.InvoiceID, i]))

  // --- Whose payment is gone? (o3d-clxw round 2) ---
  //
  // Read BEFORE either reversal pass, because its answer decides which documents those passes act on.
  // A read that throws leaves the reading empty, which is round 1's behaviour exactly — every withheld
  // document stays withheld — and pushes an error, so the chunk is not checkpointed and the question is
  // asked again next poll rather than silently answered "no".
  const billZeroPaidIds = new Set(billReversal.zeroPaid.map((i) => i.InvoiceID))
  const billCandidateInvoices = new Map(
    [...billReversal.zeroPaid, ...billReversal.partPaid, ...billReversal.unverifiable].map((i) => [i.InvoiceID, i]),
  )
  let billResidual = emptyResidual<WithheldBillDoc>()
  try {
    const candidateBills = billCandidateInvoices.size === 0 ? [] : await db.purchaseInvoice.findMany({
      where: { accountingInvoiceId: { in: [...billCandidateInvoices.keys()] }, paidAt: { not: null } },
      select: { id: true, accountingInvoiceId: true, poId: true, po: { select: { reference: true, status: true } } },
    })
    billResidual = await readResidualVerdicts(
      candidateBills, billCandidateInvoices, billZeroPaidIds, 'BILL_PAYMENT', 'PurchaseInvoice', ledgerObservedBefore,
    )
  } catch (e) {
    result.errors.push(`Bills registered-payment reading error: ${String(e)}`)
  }

  const salesZeroPaidIds = new Set(salesReversal.zeroPaid.map((i) => i.InvoiceID))
  const salesCandidateInvoices = new Map(
    [...salesReversal.zeroPaid, ...salesReversal.partPaid, ...salesReversal.unverifiable].map((i) => [i.InvoiceID, i]),
  )
  let salesResidual = emptyResidual<WithheldOrderDoc>()
  try {
    const candidateOrders = salesCandidateInvoices.size === 0 ? [] : await db.salesOrder.findMany({
      where: { accountingInvoiceId: { in: [...salesCandidateInvoices.keys()] }, paidAt: { not: null } },
      select: { id: true, accountingInvoiceId: true, orderNumber: true, externalOrderNumber: true, status: true },
    })
    salesResidual = await readResidualVerdicts(
      candidateOrders, salesCandidateInvoices, salesZeroPaidIds, 'INVOICE_PAYMENT', 'SalesOrder', ledgerObservedBefore,
    )
  } catch (e) {
    result.errors.push(`Sales registered-payment reading error: ${String(e)}`)
  }

  // THREE WAYS INTO THE REVERSAL PASSES, AND ONLY ONE OF THEM NEEDS NO EVIDENCE FROM IMS:
  //
  //   voided             the ledger settles it alone — Xero refuses a payment against a voided invoice.
  //   zeroPaidReversed   the ledger read zero AND no registration of ours is unaccounted for.
  //   provenGone         the ledger still holds money, but our own payment id is absent from its list.
  //
  // A zero-paid invoice with an in-flight registration is in NONE of them, which is the round 3 fix:
  // it is withheld and reported instead of clearing paidAt over a payment that may be about to land.
  const reversedSalesIds = new Set([
    ...salesReversal.voided, ...salesResidual.zeroPaidReversed, ...salesResidual.provenGone.keys(),
  ])
  const reversedBillIds = new Set([
    ...billReversal.voided, ...billResidual.zeroPaidReversed, ...billResidual.provenGone.keys(),
  ])

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
          notifyNeedsAttention: (o, { wcHandled, chargebackManualReason, paidAtCleared }) =>
            notifyReversalAdmins(o, wcHandled, registeredPaymentGone, chargebackManualReason, paidAtCleared),
          logReversalDetected: (o, { wcHandled, chargebackManualReason, paidAtCleared }) => logActivity({
            entityType: 'SALES_ORDER',
            entityId: o.id,
            action: 'payment_reversal_detected',
            tag: 'sync',
            level: 'WARNING',
            // o3d-w00 (Codex r8 #3): a reversal whose revenue unwind was REFUSED is not a clean one, and
            // the audit entry is the durable record that it is outstanding — paidAt has been cleared
            // (the payment really is gone) but no credit note exists, and no poll will make one.
            description: (chargebackManualReason
              ? `Payment no longer present in Xero for order ${o.orderNumber ?? o.externalOrderNumber} (status: ${o.status}) — ${paidAtCleared ? 'cleared paidAt' : 'FAILED to clear paidAt'}, but the revenue unwind was REFUSED and no credit note has been raised: ${chargebackManualReason} Raise the credit note manually, or fix the tax mapping and re-run the poller.`
              : wcHandled
                ? `Payment reversed in Xero for order ${o.orderNumber ?? o.externalOrderNumber} (status: ${o.status}) — a WooCommerce refund in this window already reversed revenue (no duplicate credit note raised); ${paidAtCleared ? 'cleared paidAt' : 'FAILED to clear paidAt'}. Verify the WC refund fully covers the reversal and whether the order status should revert.`
                : `Payment no longer present in Xero for order ${o.orderNumber ?? o.externalOrderNumber} (status: ${o.status}) — ${paidAtCleared ? 'cleared paidAt' : 'FAILED to clear paidAt'}. Review whether the order status should revert.`)
              + (registeredPaymentGone
                ? ` The payment IMS registered (${salesResidual.provenGone.get(o.accountingInvoiceId ?? '')?.paymentIds.join(', ')}) is no longer among the payments Xero lists on this invoice, but the invoice still carries another payment or an amount Xero did not state — so NO chargeback credit note was raised automatically. Unwind revenue by hand if that is what the removal means.`
                : ''),
            resolveUser: false,
          }),
        })
        if (outcome === 'reversed') {
          result.salesReversed++
        } else if (outcome === 'chargeback-manual') {
          // Payment truth is already reconciled and finance already alerted; surfacing it as a run
          // error as well keeps the cursor gate (errors.length === 0) from advancing past an order
          // whose revenue is still recognised.
          result.salesReversed++
          result.errors.push(`Chargeback for order ${order.orderNumber ?? order.id} needs manual handling: ${error}`)
        } else if (outcome === 'chargeback-failed') {
          result.errors.push(`Chargeback for order ${order.orderNumber ?? order.id} failed: ${error}`)
        } else if (outcome === 'reversal-incomplete') {
          // o3d-w00 (Codex r9 #4): the decision was made and every effect attempted, but at least one
          // (paidAt, alert, audit) did not land. NOT counted as reversed, and reported so the cursor
          // gate holds — a failed paidAt clear leaves the order in the next poll's window, and a lost
          // alert is the one thing nobody would otherwise find out about.
          result.errors.push(`Payment reversal for order ${order.orderNumber ?? order.id} was not completed: ${error}`)
        }
      }
    }
  } catch (e) {
    result.errors.push(`Sales reversal polling error: ${String(e)}`)
  }

  // Reported in its own pass so a reporting failure cannot lose a reversal that DID reconcile, and a
  // reversal pass that threw still leaves the withheld ones described.
  try {
    await signalWithheldSalesReversals(salesResidual, result, withheldMode)
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
        // THE STATUS THE LEDGER ACTUALLY REPORTED, handed on verbatim (Codex round 8).
        //
        // `reversedBillIds` is `AUTHORISED` ∪ `VOIDED`, and AUTHORISED is Xero's status for an
        // APPROVED BILL THAT IS NOT FULLY PAID — a part payment, or a payment of ours that has not
        // posted yet, reads identically to a removal. Selecting a bill into this loop is therefore not
        // an observation that the payment is gone, and rounds 3–7 treated it as one. The candidate
        // query is deliberately left wide, because an AUTHORISED bill IMS holds paid still needs
        // REPORTING; what narrows is the destructive path, and it narrows inside
        // retireBillPaymentRegistrationsReversedInLedger where no caller can skip it.
        //
        // No classification happens here. The poller passes a fact; the domain module decides what it
        // proves — the sibling branch's amount/identity reading widens that same decision in one place
        // rather than adding a second answer at this call site.
        const ledgerStatus = (bill.accountingInvoiceId ? invoiceById.get(bill.accountingInvoiceId)?.Status : null) ?? null

        // AND WHICH CLASSIFIER BUCKET PUT IT HERE (o3d-m5qk). Round 8 said an AUTHORISED bill "is not
        // decidable from anything this branch reads" and that the widening belonged to the sibling's
        // classifier, "handed in here as further admissible proofs". That classifier is now merged and
        // is what built `reversedBillIds`, so this names the bucket instead of leaving the retirement
        // to re-decide from a status that cannot see it. Nothing is re-derived: these are the same two
        // sets the loop is iterating over.
        //
        // Without this the two answers collide in the WORST direction for the operator: a bill whose
        // supplier payment really was deleted — proved, by the ledger's own payment list — would be
        // reported as REVERSAL_UNPROVEN for ever, its posted registration never retired, and every
        // future Mark Paid on it refused.
        const invoiceKey = bill.accountingInvoiceId ?? ''
        const classifierProof: LedgerClassifierProof | null =
          billResidual.provenGone.has(invoiceKey)
            ? 'REGISTERED_PAYMENT_ABSENT'
            : billResidual.zeroPaidReversed.has(invoiceKey)
              ? 'ZERO_PAID_REGISTRATIONS_ACCOUNTED'
              : null

        // THE ONE PLACE THAT CAN RETIRE A POSTED REGISTRATION (Codex round 3 #1).
        //
        // markBillPaid used to call a SYNCED BILL_PAYMENT row "stale" from its status alone, which is
        // an inference about Xero made without reading Xero — and a slow worker that posted and then
        // wrote SYNCED looked identical to a payment the ledger had thrown away. Here it is not an
        // inference: this pass has read the bill back and the ledger has VOIDED it, which Xero does
        // not permit while any payment is attached. Recording that against the row, in the SAME
        // transaction that clears paidAt, is what lets markBillPaid refuse everything it cannot prove
        // without stranding the ordinary reversal-then-re-pay flow.
        //
        // ROUND 8 IS WHAT MAKES THAT SENTENCE TRUE. Rounds 3–7 wrote "found it no longer PAID", and
        // "no longer PAID" is AUTHORISED as well as VOIDED — a part-paid bill, or one whose payment
        // IMS has queued and not yet posted. Both walked into this transaction and had their
        // registrations cancelled and paidAt cleared. The proof gate now lives inside the retirement.
        //
        // `ledgerObservedBefore` is the instant Xero was asked (see processDeltaChunk), so a row that
        // synced before it had certainly posted by the time Xero answered. One synced later may have
        // created a payment this read never saw.
        //
        // AND IF THERE IS ONE, THE WHOLE VERDICT IS WITHHELD (Codex round 4 #2). Round 3 cleared
        // paidAt regardless and simply left such a row alone. That looks conservative and is the
        // opposite: clearing paidAt removes the bill from `paidAt: { not: null }`, which is the ONLY
        // query that ever produces another reversal observation for it, so the row could never be
        // decided again — permanently stranded, and permanently refusing Mark Paid, on the strength
        // of an observation nobody recorded.
        //
        // Holding paidAt keeps the bill inside every set that will look at it again: this pass, on
        // the next appearance of the invoice in the delta (by which time the row's syncedAt IS before
        // the read and the retirement completes on its own), and the daily reconcile, where a bill
        // IMS holds paid whose Xero invoice is not PAID is already reported as a suspect advance.
        //
        // It also happens to be the truthful answer more often than not: the undecidable case is a
        // registration that finished DURING the read, and if it posted, the bill really is paid.
        const outcome = await db.$transaction(async (tx) => {
          const verdict = await retireBillPaymentRegistrationsReversedInLedger(tx, {
            connector: XERO_CONNECTOR,
            invoiceId: bill.id,
            ledgerStatus,
            classifierProof,
            ledgerObservedBefore,
          })
          // The clear is written only on a decided verdict, and inside the same transaction as the
          // retirement it is justified by — neither may commit without the other.
          if (verdict.decided) {
            await tx.purchaseInvoice.update({ where: { id: bill.id }, data: { paidAt: null } })
          }
          return verdict
        })

        if (!outcome.decided) {
          // ONE OUTCOME, TWO CAUSES, and they are told apart in the words rather than in the counter.
          // `billReversalsWithheld` stays a single number — "we would have cleared paidAt and did not"
          // is one fact an operator watches, and splitting it per cause would hide it — but the two
          // causes ask for different things, so the description and the metadata name which one it is.
          result.billReversalsWithheld++
          const description = outcome.withheld === 'REVERSAL_UNPROVEN'
            // Round 8. The bill is not fully paid in Xero and that is ALL this read establishes.
            ? `Xero reports the bill for PO ${bill.po.reference} (PO status: ${bill.po.status}) as `
              + `${outcome.ledgerStatus ?? 'a status IMS could not read'} — approved and NOT FULLY PAID — `
              + `which IMS cannot tell apart from a genuine PART payment, or from a payment of its own `
              + `that has not reached Xero yet. Only a VOIDED invoice proves a payment was removed on `
              + `its own, because Xero requires every payment to be released before an invoice can be `
              + `voided. So nothing was retired and the bill is LEFT MARKED PAID: clearing paidAt would `
              + `re-arm Mark Paid over a supplier payment that may already have been made, and pressing `
              + `it would pay the supplier a second time — there is no idempotency key on that path to `
              + `refuse it. Open the bill in Xero: if the balance is a part payment, settle it or `
              + `correct the bill total in IMS; if the payment really was removed, cancel the bill's `
              + `payment sync entry by hand and mark the bill paid again.`
            // Round 4 #2. The reversal IS proved; it is IMS's own registrations the read cannot cover.
            : `Bill payment appears to be no longer present in Xero for PO ${bill.po.reference} `
              + `(PO status: ${bill.po.status}), but ${outcome.undecided.length} posted payment `
              + `registration(s) finished AFTER this Xero read was taken, so the read cannot say `
              + `whether the payment they created is gone. The bill is LEFT MARKED PAID rather than `
              + `re-armed for payment — clearing it would invite a second supplier payment on top of `
              + `one that may exist. IMS will decide this by itself on the next Xero read that covers `
              + `those registrations; if it never does, open the bill in Xero and either settle it or `
              + `cancel sync entr${outcome.undecided.length === 1 ? 'y' : 'ies'} `
              + `${outcome.undecided.join(', ')} by hand.`
          await logActivity({
            entityType: 'PURCHASE_ORDER',
            entityId: bill.poId,
            action: 'bill_payment_reversal_withheld',
            tag: 'sync',
            level: 'WARNING',
            description,
            metadata: {
              invoiceId: bill.id,
              reference: bill.po.reference,
              withheld: outcome.withheld,
              ledgerStatus,
              undecidedSyncLogIds: outcome.withheld === 'REGISTRATION_UNDECIDED' ? outcome.undecided : [],
              // Null when the database clock could not be read — the case where NOTHING is decidable.
              ledgerObservedBefore: ledgerObservedBefore?.databaseClock.toISOString() ?? null,
            },
            resolveUser: false,
          })
          continue
        }

        result.billsReversed++
        await logActivity({
          entityType: 'PURCHASE_ORDER',
          entityId: bill.poId,
          action: 'bill_payment_reversal_detected',
          tag: 'sync',
          level: 'WARNING',
          description: `Bill invoice VOIDED in Xero for PO ${bill.po.reference} (PO status: ${bill.po.status}), so the payment it held has been released — cleared paidAt`
            + (outcome.retired > 0
              ? ` and retired ${outcome.retired} posted payment registration(s), so the bill can be marked paid again.`
              : `. There was no posted payment registration to retire — if marking this bill paid again is refused, the entry named by the refusal must be reconciled in Xero and cancelled by hand.`)
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
    await signalWithheldBillReversals(billResidual, result, withheldMode)
  } catch (e) {
    result.errors.push(`Bills withheld-reversal reporting error: ${String(e)}`)
  }
}

// ---------------------------------------------------------------------------
// A WITHHELD VERDICT IS A QUESTION THAT MUST BE ASKED AGAIN (o3d-clxw round 4)
// ---------------------------------------------------------------------------
//
// Round 2 made a withheld verdict DURABLE: if the warning did not land, the cursor is held and the
// window re-read. Round 3 widened what withholds. Neither gave the successful case a way BACK.
//
// A withheld reversal that WAS reported is checkpointed like any other outcome, and the delta only
// ever returns an invoice that CHANGES. But the thing that will settle the question is usually not a
// change in Xero at all — it is IMS's own registration finishing, or an operator cancelling a FAILED
// one. Neither of those touches the invoice, so nothing ever puts it back in front of the poller. The
// document then sits `paidAt`-set for ever against a ledger that says it is not paid: on the bill side
// a supplier who was never actually paid reads as settled, and on the sales side a real chargeback is
// never recognised. The FAILED case round 3 named is the same defect one step on — a FAILED
// registration never becomes SYNCED, so on its own it withholds for ever.
//
// So the verdict goes ON A TIMER, driven by the poll it already runs inside:
//
//   THE WORK ITEM IS THE RECORD ITSELF. The durable warning round 2 insisted on IS the queue entry —
//   there is no second store to get out of step with it, and an entry can only exist if an operator
//   was actually told. The latest `sync`-tagged activity row for a document decides its state: a
//   withheld/deferred action means open, a cleared action means closed.
//
//   TERMINAL ROWS ARE CLOSED, NOT RE-SCANNED. When a recheck settles a document — the reversal is
//   finally admitted, the ledger caught up, or IMS no longer holds it as paid — a `..._cleared` row
//   is written and the document leaves the candidate set for good. An oldest-first bounded page that
//   rows can never leave is a page that starves.
//
//   AND A DOCUMENT THAT IS STILL WITHHELD DOES NOT STARVE THE PAGE EITHER, because every recheck
//   rewrites its marker. Oldest-first therefore means "least recently reconsidered first", which is a
//   round robin, not a queue with a permanent head. THAT ONLY HOLDS WHILE A DOCUMENT OCCUPIES ONE
//   PLACE IN THE ORDERING (round 5, finding 3): rewriting a marker appends a row rather than moving
//   one, so a page bounded by ROWS fills with the histories of the longest-withheld documents and
//   starves every newer one permanently. The candidate set is therefore built by GROUPING the markers
//   per document and taking each document's newest. AND THE PAGE MUST BE A PAGE OF DOCUMENTS THAT
//   NEED SOMETHING (round 6, finding 2): a settled document's open marker is frozen where an open
//   document's is rewritten, so under oldest-first every settled document sorts ahead of every worked
//   one, and a bound spent before the closures are read is spent on documents with nothing left to
//   decide. Openness is therefore decided across BOTH kinds of marker before the bound is applied —
//   see `openWithheldDocuments`.
//
// Failure is always towards asking again: a marker that could not be rewritten stays as it was, which
// leaves the document due; a Xero read that fails re-asks nothing and closes nothing; and a
// reconsideration that hit an error DEFERS rather than closes, because "we could not decide" must
// never be spent as "there is nothing left to decide" (round 5, finding 2).

/** Actions whose presence as the LATEST row means the disagreement is still open. */
const WITHHELD_OPEN_ACTIONS = [
  'bill_payment_reversal_withheld',
  'payment_reversal_withheld',
  'bill_payment_reversal_recheck_deferred',
  'payment_reversal_recheck_deferred',
] as const

/** Actions whose presence as the LATEST row means the document has left the candidate set. */
const WITHHELD_CLOSED_ACTIONS = [
  'bill_payment_reversal_withheld_cleared',
  'payment_reversal_withheld_cleared',
] as const

/** How long a withheld verdict rests before it is reconsidered. */
export const WITHHELD_RECHECK_INTERVAL_MS = 60 * 60 * 1000

/**
 * How many STILL-OPEN DOCUMENTS one poll rebuilds the open set from — not how many marker rows it
 * reads, and not how many documents have markers.
 *
 * The first distinction is round 5's finding 3: markers accumulate (reconsidering appends a row), so
 * a bound on rows is a bound one long-running document's own history can consume. The second is
 * round 6's finding 2: a settled document keeps its historical open marker for the rest of the
 * horizon, so a bound applied before the closures are known is a bound that documents needing
 * nothing can consume. Both are the same starvation, and both are answered by deciding what the
 * bound is counting BEFORE spending it — see `openWithheldDocuments`.
 */
export const WITHHELD_MARKER_SCAN = 400

/**
 * How old a marker may be and still be believed.
 *
 * Bounds the scan against the `createdAt` index instead of walking an activity log that is mostly
 * something else. It cannot lose work: an OPEN marker is rewritten every time it is reconsidered, so
 * one can only be older than this if the poll has not run for a month — and the daily reconcile keeps
 * reporting those documents as suspect advances regardless.
 */
const WITHHELD_MARKER_HORIZON_MS = 30 * 24 * 60 * 60 * 1000

/** How many documents one poll reconsiders. Bounds both the DB work and the extra Xero calls. */
const WITHHELD_RECHECK_PAGE = 40

/** Invoice ids per `Invoices?IDs=` request — Xero takes a comma-separated list. */
const WITHHELD_RECHECK_BATCH = 40

/**
 * A document's LAST marker of one kind — the newest open row, or the newest closure.
 *
 * No `action` field (round 5, finding 3): the two kinds now arrive from two queries whose own
 * predicates do the classifying, so an action carried through to be re-checked here would be a
 * restatement of the query rather than a fact about the document. Each side is at most one entry per
 * document, which is the property the round robin needs.
 */
type WithheldMarker = {
  entityType: ActivityEntityType
  entityId: string
  createdAt: Date
}

/**
 * The documents whose withheld verdict is due to be asked again, oldest reconsideration first.
 *
 * Reduced from the activity log rather than a queue table: a document is open when its newest OPEN
 * marker is newer than any closure written for it, and due when that marker has rested a full
 * interval. The two kinds arrive from one grouped scan that has already compared them per document
 * (`openWithheldDocuments`), so the rule below is applied a second time to data that satisfies it —
 * deliberately, because the openness rule belongs where it can be read and tested, and re-asserting
 * it costs a map lookup.
 *
 * Each list holds at most one entry per document, because the query groups by document. That is
 * load-bearing rather than tidy: the caller's page is bounded, and a list of raw marker ROWS lets one
 * document's history fill it and starve every other document for ever (r5 finding 3) — as does a
 * page whose bound is spent before closed documents are recognised (r6 finding 2).
 *
 * Note the two clocks that appear here are BOTH scheduling, not ordering — `createdAt` is the
 * database's and `now` is this host's, and disagreement between them can only make a recheck happen
 * earlier or later. It cannot change a verdict; the verdict's own fence is `readDatabaseLedgerFence`.
 */
export function dueWithheldMarkers(
  openMarkers: WithheldMarker[],
  closureMarkers: WithheldMarker[],
  now: number,
): WithheldMarker[] {
  const newest = (into: Map<string, WithheldMarker>, rows: WithheldMarker[]): Map<string, WithheldMarker> => {
    for (const row of rows) {
      const key = withheldEntityKey(row.entityType, row.entityId)
      const held = into.get(key)
      if (!held || held.createdAt.getTime() < row.createdAt.getTime()) into.set(key, row)
    }
    return into
  }
  const open = newest(new Map(), openMarkers)
  const closed = newest(new Map(), closureMarkers)

  return [...open.entries()]
    .filter(([key, marker]) => {
      const closure = closed.get(key)
      if (closure && closure.createdAt.getTime() >= marker.createdAt.getTime()) return false
      return marker.createdAt.getTime() <= now - WITHHELD_RECHECK_INTERVAL_MS
    })
    .map(([, marker]) => marker)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .slice(0, WITHHELD_RECHECK_PAGE)
}

async function closeWithheldMarker(marker: WithheldMarker, resolution: string, description: string): Promise<void> {
  await logActivity({
    entityType: marker.entityType,
    entityId: marker.entityId,
    action: marker.entityType === 'PURCHASE_ORDER'
      ? 'bill_payment_reversal_withheld_cleared'
      : 'payment_reversal_withheld_cleared',
    tag: 'sync',
    level: 'INFO',
    description,
    metadata: { resolution },
    resolveUser: false,
  })
}

async function deferWithheldMarker(marker: WithheldMarker, reason: string): Promise<void> {
  await logActivity({
    entityType: marker.entityType,
    entityId: marker.entityId,
    action: marker.entityType === 'PURCHASE_ORDER'
      ? 'bill_payment_reversal_recheck_deferred'
      : 'payment_reversal_recheck_deferred',
    tag: 'sync',
    level: 'WARNING',
    description:
      `The withheld payment reversal for this document could not be reconsidered this time: ${reason}. `
      + `It stays open and will be asked again.`,
    metadata: { reason },
    resolveUser: false,
  })
}

/** The entity types the recheck can act on — the two the withheld markers are ever written for. */
const RECHECKABLE_ENTITY_TYPES: ReadonlySet<string> = new Set(['PURCHASE_ORDER', 'SALES_ORDER'])

/**
 * The documents whose withheld verdict is STILL OPEN, least-recently-reconsidered first, with each
 * one's last closure alongside — classified in the database, before anything is discarded.
 *
 * ONE ROW PER DOCUMENT, NOT ONE PER MARKER (o3d-clxw round 5, Codex finding 3).
 *
 * Round 4's round robin rests on "oldest first means least recently reconsidered", and that only
 * holds if a document occupies ONE place in the ordering. It does not: reconsidering a document
 * APPENDS a marker, the old ones stay in the activity log for the whole thirty-day horizon, and a
 * bounded scan of ROWS ordered oldest-first therefore fills with the HISTORY of whichever documents
 * have been withheld longest. One document reconsidered hourly writes seven hundred rows a month on
 * its own — more than the whole scan — so a document that became withheld yesterday need never appear
 * in the page at all, and never being in the page means never being reconsidered, which means never
 * writing a newer marker: the starvation is permanent and self-sustaining. Worse, the marker such a
 * page DOES yield for the starving document is its oldest row, so the timer that decides whether it
 * is due is read from history rather than from its last reconsideration.
 *
 * Grouping per document made the bound a bound on DOCUMENTS. It did not make it a bound on documents
 * THAT NEED ANYTHING (round 6, Codex finding 2), and that is the same starvation one step along:
 *
 *   a settled document keeps its historical open marker for the rest of the horizon, and that marker
 *   is FROZEN — nothing rewrites it, because the document is never reconsidered again. An open
 *   document's marker, by contrast, is rewritten every time it IS reconsidered. So in an
 *   oldest-first ordering over open markers alone, every settled document sorts AHEAD of every
 *   document that is actually being worked, and once there are as many settled documents in the
 *   horizon as the scan is wide, the page is entirely documents that need nothing and no open
 *   document is ever reconsidered again. Reading the closures afterwards cannot repair it: by then
 *   the bound has already been spent.
 *
 * So the classification happens BEFORE the bound, and in the only place that can do it in one pass:
 * each document's last OPEN marker and last CLOSURE are aggregated together, the documents whose
 * latest marker across BOTH kinds is a closure are dropped, and only then are the oldest
 * `WITHHELD_MARKER_SCAN` of what remains returned. A settled document cannot occupy a slot, because
 * it never reaches the LIMIT.
 *
 * Raw SQL because this is a conditional aggregate — `MAX(...) FILTER (WHERE action IN ...)` twice
 * over one grouped scan — and comparing two aggregates of the same group is not something Prisma's
 * `groupBy` can express: `having` compares an aggregate against a constant. Two `groupBy` calls is
 * what round 5 did, and two calls is precisely what forces the bound to be applied to one kind before
 * the other kind is known. The closure is still returned rather than only used as a filter, so
 * `dueWithheldMarkers` keeps deciding openness from the pair it is given.
 *
 * (Cost: the aggregate sees the whole horizon rather than stopping at the first N rows — as round 5's
 * group already did. These six actions are a vanishingly small fraction of `activity_logs`, so
 * finding N of them meant scanning most of the window anyway. An index over
 * (action, entityType, entityId, createdAt) would make it cheap and is worth doing; it is a separate
 * concurrent-build migration, not part of this correctness fix.)
 */
async function openWithheldDocuments(horizon: Date): Promise<{ open: WithheldMarker[]; closed: WithheldMarker[] }> {
  const openActions = [...WITHHELD_OPEN_ACTIONS]
  const closedActions = [...WITHHELD_CLOSED_ACTIONS]
  // The horizon goes in as an explicit UTC instant and the two aggregates come back as explicit UTC
  // strings: `activity_logs."createdAt"` is TIMESTAMP WITHOUT TIME ZONE holding UTC, so a bare
  // parameter or a bare column would be read through whatever the session's TimeZone happens to be.
  // These markers only schedule (see `dueWithheldMarkers`) — but a whole-timezone shift in the due
  // timer is still a recheck that runs hours early or not at all.
  const rows = await db.$queryRaw<Array<{
    entityType: string
    entityId: string
    openMax: Date | string | null
    closedMax: Date | string | null
  }>>`
    SELECT d."entityType",
           d."entityId",
           to_char(d."openMax", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "openMax",
           to_char(d."closedMax", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "closedMax"
    FROM (
      SELECT "entityType"::text AS "entityType",
             "entityId" AS "entityId",
             MAX("createdAt") FILTER (WHERE "action" = ANY(${openActions}::text[])) AS "openMax",
             MAX("createdAt") FILTER (WHERE "action" = ANY(${closedActions}::text[])) AS "closedMax"
      FROM activity_logs
      WHERE "tag" = 'sync'
        AND "action" = ANY(${[...openActions, ...closedActions]}::text[])
        AND "entityId" IS NOT NULL
        AND "createdAt" >= ${horizon.toISOString()}::timestamptz AT TIME ZONE 'UTC'
      GROUP BY "entityType", "entityId"
    ) d
    WHERE d."openMax" IS NOT NULL
      AND (d."closedMax" IS NULL OR d."openMax" > d."closedMax")
    ORDER BY d."openMax" ASC
    LIMIT ${WITHHELD_MARKER_SCAN}
  `

  // Normalised rather than trusted: a raw query hands back whatever the driver made of a
  // `timestamp` — a Date, a Date from another realm, or a string — and none of those is a reason to
  // lose a document. A value that cannot be read as an instant is dropped, because a marker with no
  // time cannot be ordered, and an unordered marker would hold the head of an oldest-first page.
  const at = (value: Date | string | null): Date | null => {
    if (value == null) return null
    const ms = new Date(value).getTime()
    return Number.isFinite(ms) ? new Date(ms) : null
  }
  const open: WithheldMarker[] = []
  const closed: WithheldMarker[] = []
  for (const row of rows) {
    if (!RECHECKABLE_ENTITY_TYPES.has(row.entityType) || !row.entityId) continue
    const entityType = row.entityType as ActivityEntityType
    const openAt = at(row.openMax)
    if (openAt == null) continue
    open.push({ entityType, entityId: row.entityId, createdAt: openAt })
    const closedAt = at(row.closedMax)
    if (closedAt != null) closed.push({ entityType, entityId: row.entityId, createdAt: closedAt })
  }
  return { open, closed }
}

/**
 * Go back and re-ask every withheld reversal that has rested long enough.
 *
 * Reads the invoices by ID rather than waiting for them to re-enter the delta — the whole point is
 * that they never will. The answer is then produced by exactly the same passes the delta uses, with a
 * fresh database fence, so a recheck cannot reach a verdict the delta would not have reached.
 */
async function recheckWithheldReversals(
  result: PollResult,
  windowStart: Date,
  fetchInvoices: (path: string) => Promise<{ ok: boolean; data?: XeroInvoicesResponse; error?: string; status?: number }>,
): Promise<void> {
  const horizon = new Date(Date.now() - WITHHELD_MARKER_HORIZON_MS)
  const { open: openMarkers, closed: closureMarkers } = await openWithheldDocuments(horizon)

  const due = dueWithheldMarkers(openMarkers, closureMarkers, Date.now())
  if (due.length === 0) return
  result.withheldRechecked += due.length

  const poIds = due.filter((m) => m.entityType === 'PURCHASE_ORDER').map((m) => m.entityId)
  const soIds = due.filter((m) => m.entityType === 'SALES_ORDER').map((m) => m.entityId)

  // Only documents IMS STILL holds as paid have a disagreement left to settle. One PO can carry more
  // than one bill, which is why the bill side is keyed by poId and may map to several invoices.
  const bills = poIds.length === 0 ? [] : await db.purchaseInvoice.findMany({
    where: { poId: { in: poIds }, paidAt: { not: null }, accountingInvoiceId: { not: null } },
    select: { poId: true, accountingInvoiceId: true },
  })
  const orders = soIds.length === 0 ? [] : await db.salesOrder.findMany({
    where: { id: { in: soIds }, paidAt: { not: null }, accountingInvoiceId: { not: null } },
    select: { id: true, accountingInvoiceId: true },
  })

  const invoiceIdsByEntity = new Map<string, string[]>()
  const add = (key: string, invoiceId: string | null): void => {
    if (!invoiceId) return
    invoiceIdsByEntity.set(key, [...(invoiceIdsByEntity.get(key) ?? []), invoiceId])
  }
  for (const bill of bills) add(withheldEntityKey('PURCHASE_ORDER', bill.poId), bill.accountingInvoiceId)
  for (const order of orders) add(withheldEntityKey('SALES_ORDER', order.id), order.accountingInvoiceId)

  const wanted = [...new Set([...invoiceIdsByEntity.values()].flat())]
  const fetched = new Map<string, XeroInvoice>()
  // The fence is read BEFORE the ledger request goes out, and one fence covers every batch: a fence
  // EARLIER than the read it guards only ever decides FEWER registrations, which is the safe side.
  const ledgerObservedBefore = await readDatabaseLedgerFence()
  for (let i = 0; i < wanted.length; i += WITHHELD_RECHECK_BATCH) {
    const batch = wanted.slice(i, i + WITHHELD_RECHECK_BATCH)
    const res = await fetchInvoices(`Invoices?IDs=${batch.join(',')}`)
    if (!res.ok) {
      // Nothing is closed and nothing is deferred: every due document keeps the marker it already
      // has, so the whole page is still due on the next poll.
      result.errors.push(`Withheld-reversal recheck could not read Xero: ${res.error ?? `HTTP ${res.status}`}`)
      return
    }
    for (const invoice of res.data?.Invoices ?? []) fetched.set(invoice.InvoiceID, invoice)
  }

  const stillWithheld = new Set<string>()
  // WHAT THE DECISION PASS COULD NOT ANSWER MUST NOT BE READ AS AN ANSWER (round 5, finding 2).
  //
  // `stillWithheld` is positive evidence of one thing only — that a document was re-asked and is
  // withheld again. Its ABSENCE is not evidence of the opposite. The registered-payment reading is a
  // database read inside `processDeltaChunk`, and when it throws — a dropped connection, a pool
  // timeout, a statement cancelled under load — that chunk's residual reading is empty, no document
  // in it is signalled as withheld, and every one of them would fall through to the `settled` close
  // below. A transient fault would then permanently retire the recheck for documents nobody
  // reconsidered at all, leaving `paidAt` set against a ledger that disagrees with it and no marker
  // left to bring the question back. Permanent, from a cause that lasted a second.
  //
  // `processDeltaChunk` does not throw — it records what it could not do on `result.errors`, which is
  // exactly what its own caller uses to refuse to checkpoint the cursor past a chunk it could not
  // fully answer. The recheck's equivalent of refusing to checkpoint is refusing to CLOSE, so it
  // watches the same signal. Errors are counted rather than inspected on purpose: any error raised
  // while these documents were being decided means this pass did not decide them all, and which
  // document a given error belongs to is not always recoverable from the message.
  //
  // Coarse in the safe direction, and only in the safe direction: an unrelated error inside the same
  // chunk defers documents that were in fact settled, which costs one activity row and one more
  // reconsideration an hour later. The opposite mistake costs a supplier payment.
  const errorsBeforeDecision = result.errors.length
  if (fetched.size > 0) {
    await processDeltaChunk([...fetched.values()], result, {
      windowStart,
      ledgerObservedBefore,
      withheldMode: { recheck: true, observe: (key) => stillWithheld.add(key) },
    })
  }
  const decisionIncomplete = result.errors.length > errorsBeforeDecision

  for (const marker of due) {
    const key = withheldEntityKey(marker.entityType, marker.entityId)
    // Still withheld — the signal pass has already rewritten the marker, which is what restarts its
    // timer. If that write failed the OLD marker stands, and the document simply stays due.
    if (stillWithheld.has(key)) continue

    const invoiceIds = invoiceIdsByEntity.get(key)
    // Grounded in IMS's own state and in nothing the ledger said, so an error in the decision pass
    // below has no bearing on it: there is no disagreement left to decide either way.
    if (!invoiceIds || invoiceIds.length === 0) {
      result.withheldResolved++
      await closeWithheldMarker(marker, 'no-paid-document',
        `IMS no longer holds a paid, Xero-linked document for this record, so the withheld payment `
        + `reversal has nothing left to decide and is closed.`)
      continue
    }
    // A read that did not come back cannot close anything. Deferring rewrites the marker so this
    // document goes to the BACK of the oldest-first page instead of holding its head for ever.
    if (!invoiceIds.every((id) => fetched.has(id))) {
      await deferWithheldMarker(marker, 'Xero did not return the invoice')
      continue
    }
    // The read came back, but the pass that turns it into a verdict reported a failure. Nothing here
    // is evidence that this document settled, so it is deferred — asked again — not closed.
    if (decisionIncomplete) {
      await deferWithheldMarker(marker, 'the reconsideration pass could not complete')
      continue
    }
    result.withheldResolved++
    await closeWithheldMarker(marker, 'settled',
      `The withheld payment reversal for this document was reconsidered against a fresh Xero read and `
      + `is no longer withheld — it was either reversed, or the ledger and IMS now agree. Closed.`)
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
      withheldRechecked: 0, withheldResolved: 0,
      errors: [], skipped: 'backlog reconcile held the payment-write lock',
    }
  }
  return outcome
}

async function pollXeroPaymentsLocked(): Promise<PollResult> {
  const result = {
    salesPaid: 0, billsPaid: 0, salesReversed: 0, billsReversed: 0,
    salesReversalsWithheld: 0, billReversalsWithheld: 0,
    withheldRechecked: 0, withheldResolved: 0,
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
  // THE FENCE, READ BEFORE THE LEDGER IS ASKED, FROM THE DATABASE (o3d-clxw round 4).
  //
  // Not `pollStartedAt`. `pollStartedAt` is this host's clock and it bounds the delta WINDOW, which is
  // all it was ever fit for. The registration fence is an ORDERING against stamps written by a
  // different host, and the only way two stamps can be ordered is if one authority wrote both — so
  // both now come from the database. One fence covers every chunk of the drain: a fence earlier than
  // the read it guards decides strictly fewer registrations, which is the direction that withholds.
  const ledgerObservedBefore = await readDatabaseLedgerFence()
  if (ledgerObservedBefore === null) {
    result.errors.push(
      `The database clock could not be read, so no payment registration can be ordered against this `
      + `Xero read; every reversal that depends on one is withheld for this poll.`,
    )
  }

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
        // already posted when the ledger gave us this answer?" is a question about the READ. Read
        // from the DATABASE before the fetch (never `pollStartedAt`, which is this host's clock), so
        // every chunk is read after it and both ends of the comparison are one clock's readings.
        ledgerObservedBefore,
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

  // Reconsider withheld verdicts AFTER the drain, so a recheck failure can never be mistaken for a
  // reason to hold the poll cursor: by here the cursor has already been decided.
  try {
    await recheckWithheldReversals(result, lastPollDate, (path) => xeroGet<XeroInvoicesResponse>(path))
  } catch (e) {
    result.errors.push(`Withheld-reversal recheck error: ${String(e)}`)
  }

  // `billReversalsWithheld` counts BOTH causes — a ledger amount that does not prove a reversal, and
  // a registration this read cannot speak for (o3d-a3wx round 4) — so this one summand covers both.
  const withheld = result.salesReversalsWithheld + result.billReversalsWithheld
  if (result.salesPaid > 0 || result.billsPaid > 0 || result.salesReversed > 0 || result.billsReversed > 0
    || withheld > 0 || result.withheldRechecked > 0) {
    await logActivity({
      entityType: 'SYSTEM',
      action: 'xero_payment_poll',
      tag: 'sync',
      level: 'INFO',
      description:
        `Payment poll: ${result.salesPaid} sales paid, ${result.billsPaid} bills paid, ` +
        `${result.salesReversed} sales reversed, ${result.billsReversed} bills reversed` +
        (withheld > 0
          ? `, ${withheld} reversal(s) WITHHELD because the ledger still holds a payment (or did not say), ` +
            `or a registration this read cannot speak for — see the per-document warnings`
          : '') +
        (result.withheldRechecked > 0
          ? `, ${result.withheldRechecked} previously-withheld reversal(s) reconsidered ` +
            `(${result.withheldResolved} closed)`
          : ''),
      metadata: result,
      resolveUser: false,
    })
  }

  return result
}
