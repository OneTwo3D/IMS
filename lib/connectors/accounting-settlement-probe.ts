/**
 * o3d-0m56 — read what a connector's ledger ALREADY holds against a document, so a money-moving
 * row that has been attempted once is never re-posted on the strength of remote deduplication
 * alone (see ledger-settlement-evidence.ts for why that strength is imaginary).
 *
 * READ-ONLY by construction: every call here is a GET. It is used at two decision points — the
 * operator's manual retry, and the automatic re-enqueue of a FAILED money row — and both treat
 * anything other than a positive `ok: true` as a refusal, so a probe that cannot answer must say
 * so rather than guess.
 *
 * The connector-specific part is only "where does this ledger record settlements against this
 * kind of document"; the comparison itself is pure and lives in the domain module.
 */

import type { AccountingSyncType } from '@/app/generated/prisma/client'
import type { LedgerSettlementProbe, LedgerSettlementRecord } from '@/lib/domain/accounting/ledger-settlement-evidence'
import { settlementDocumentAnchorFilters, settlementDocumentKey } from '@/lib/domain/accounting/money-post-document'
import type { MoneyPostLock } from '@/lib/domain/accounting/money-post-lock'

export type SettlementProbeTarget = {
  type: string
  payload: unknown
}

function asRecord(payload: unknown): Record<string, unknown> {
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {}
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Xero serialises dates BOTH ways depending on the field and endpoint: `/Date(1750000000000+0000)/`
 * on most transaction reads, plain ISO on a few. Anything else reads as null, which the classifier
 * turns into `unknown` rather than a silent non-match.
 */
export function normaliseXeroSettlementDate(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  // An ISO date is taken VERBATIM rather than parsed. `2026-07-01T00:00:00` carries no zone, so
  // Date.parse reads it as local time and toISOString can then move it to the previous day — a
  // settlement that no longer matches the attempt that created it, on nothing but the server's
  // timezone.
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim())
  if (iso) return iso[1]!
  const dotNet = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/.exec(value.trim())
  if (!dotNet) return null
  const ms = Number(dotNet[1])
  if (!Number.isFinite(ms)) return null
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * A collection Xero reports on an invoice for money taken off it by something that is NOT a
 * payment. Each entry says how much of that document was APPLIED here, which is all this probe
 * needs from it: never a candidate settlement (IMS posts payments, not these), only an
 * explanation for an `AmountCredited`/`AmountDue` movement the payments do not account for.
 */
type XeroAppliedCollection = Array<{ AppliedAmount?: number }>

/** The document a settlement probe reads, per money-moving type. */
type XeroPaymentsResponse = {
  Invoices?: Array<{
    InvoiceID?: string
    /**
     * Xero's own total of the payments applied to this document. Read as a CROSS-CHECK on the
     * collection below, never as a record in its own right — see the completeness note in
     * `probeXeroSettlement`.
     */
    AmountPaid?: number
    /**
     * Money taken off this document by CREDIT NOTES, prepayments and overpayments. It is NOT part
     * of `AmountPaid` — that is the whole of Codex round 6 finding 3 — so an invoice settled
     * entirely by an allocation reports `AmountPaid: 0` with an empty `Payments` collection, and
     * a probe reading only those two answered "positively nothing settles this document".
     */
    AmountCredited?: number
    /** The document's face value and what is still owed on it — the shape-independent cross-check. */
    Total?: number
    AmountDue?: number
    Payments?: Array<{ PaymentID?: string; Date?: string; Amount?: number; Reference?: string }>
    CreditNotes?: XeroAppliedCollection
    Prepayments?: XeroAppliedCollection
    Overpayments?: XeroAppliedCollection
  }>
}
type XeroCreditNoteResponse = {
  CreditNotes?: Array<{
    CreditNoteID?: string
    /** The credit's face value and what is left of it — how much of it has been allocated. */
    Total?: number
    RemainingCredit?: number
    Allocations?: Array<{ Amount?: number; Date?: string; Invoice?: { InvoiceID?: string } }>
  }>
}

/**
 * Sum a collection's `AppliedAmount`s, or null the moment one of them cannot be read.
 *
 * An absent collection sums to ZERO rather than to null: "Xero sent no credit notes" has to be
 * able to mean "there are none", or every ordinary invoice would refuse. What stops that reading
 * being a hole is that the arithmetic it feeds is directional — an absent collection explains
 * nothing, so an `AmountCredited` it should have accounted for shows up as an unexplained
 * shortfall and refuses.
 */
function sumApplied(collection: XeroAppliedCollection | undefined): number | null {
  return (collection ?? []).reduce<number | null>(
    (sum, entry) => (sum === null || num(entry.AppliedAmount) === null ? null : sum + (entry.AppliedAmount as number)),
    0,
  )
}

/** The shape of the connector read each probe needs, so both can be driven without a network. */
export type XeroFetcher = <T>(path: string) => Promise<{ ok: boolean; status: number; data?: T; error?: string }>
export type QboFetcher = <T>(path: string) => Promise<{ ok: boolean; status: number; data?: T; error?: string }>

export async function probeXeroSettlement(
  target: SettlementProbeTarget,
  xeroGet: XeroFetcher,
): Promise<LedgerSettlementProbe> {
  const payload = asRecord(target.payload)
  const invoiceId = str(payload.accountingInvoiceId)

  if (target.type === 'PURCHASE_CREDIT_NOTE_ALLOCATION') {
    const creditNoteId = str(payload.creditNoteId)
    if (!creditNoteId || !invoiceId) {
      return { ok: false, reason: 'the row records no credit note and invoice to check' }
    }
    const res = await xeroGet<XeroCreditNoteResponse>(`CreditNotes/${encodeURIComponent(creditNoteId)}`)
    if (!res.ok) return { ok: false, reason: res.error ?? `HTTP ${res.status}` }
    const note = res.data?.CreditNotes?.[0]
    if (!note) return { ok: false, reason: 'Xero returned no credit note for that id' }
    const allocations = note.Allocations ?? []
    // Only allocations against THIS bill: the same credit note legitimately offsets others.
    const records: LedgerSettlementRecord[] = allocations
      .filter((a) => str(a.Invoice?.InvoiceID).toLowerCase() === invoiceId.toLowerCase())
      // No reference field exists on a Xero credit-note allocation, so this type has no mark to
      // match and falls back to amount and date alone. Stated rather than left to be inferred from
      // a missing property.
      .map((a) => ({ amount: num(a.Amount), date: normaliseXeroSettlementDate(a.Date), reference: null }))

    // COMPLETENESS, CHECKED RATHER THAN ASSUMED (Codex round 6, finding 3). This branch had NO
    // cross-check at all, so `Allocations` absent and `Allocations` empty were the same value —
    // and the difference between them is the difference between "this credit has been applied to
    // nothing" and "Xero did not send us the collection". A fully applied credit note read as the
    // first is a positive CLEAR, and the fence allocates it to the bill a second time.
    //
    // `Total - RemainingCredit` is Xero's OWN account of how much of this credit has been used, by
    // any means, so it is the thing the returned collection has to add up to. ALL allocations
    // count here, not only this bill's: the credit legitimately offsets other documents, and it is
    // the COLLECTION's completeness being tested, not this bill's share of it.
    const creditTotal = num(note.Total)
    const remaining = num(note.RemainingCredit)
    const applied = creditTotal !== null && remaining !== null ? creditTotal - remaining : null
    const allocated = allocations.reduce<number | null>(
      (sum, a) => (sum === null || num(a.Amount) === null ? null : sum + (a.Amount as number)),
      0,
    )
    if (applied !== null && applied > XERO_AMOUNT_EPSILON
      && (allocated === null || applied - allocated > XERO_AMOUNT_EPSILON)) {
      return {
        ok: false,
        reason: `Xero reports ${applied.toFixed(2)} of this credit note already applied but returned `
          + (allocated === null
            ? 'an allocation whose amount could not be read'
            : allocations.length === 0
              ? 'no allocations'
              : `allocations totalling ${allocated.toFixed(2)}`),
      }
    }
    return { ok: true, records }
  }

  if (!invoiceId) return { ok: false, reason: 'the row records no document id to check' }
  // Single-document GET, not the list endpoint: Xero omits the Payments collection from a
  // multi-invoice response, and an empty Payments array read from a summary would be indistinguishable
  // from a document with no payments at all — the exact false CLEAR this probe exists to prevent.
  const res = await xeroGet<XeroPaymentsResponse>(`Invoices/${encodeURIComponent(invoiceId)}`)
  if (!res.ok) return { ok: false, reason: res.error ?? `HTTP ${res.status}` }
  const invoice = res.data?.Invoices?.[0]
  if (!invoice) return { ok: false, reason: 'Xero returned no document for that id' }
  const records: LedgerSettlementRecord[] = (invoice.Payments ?? []).map((p) => ({
    amount: num(p.Amount),
    date: normaliseXeroSettlementDate(p.Date),
    id: str(p.PaymentID) || null,
    // Where IMS writes its own mark; matching it identifies the attempt whatever has since been
    // done to the amount or the date.
    reference: str(p.Reference) || null,
  }))
  // COMPLETENESS, CHECKED RATHER THAN ASSUMED (Codex round 4, finding 1 generalised). `Payments`
  // being absent and `Payments` being empty are the same value in JavaScript, and the difference
  // between them is the difference between "nothing settles this document" and "we asked the
  // wrong endpoint". `AmountPaid` is Xero's OWN total of the same collection, so the two must
  // agree; when the collection is short of it, the probe has an incomplete picture and says so
  // rather than reporting a clear built from it.
  //
  // Directional on purpose — only a SHORTFALL escalates. A record whose amount is unreadable
  // already yields `unknown` in the classifier, so it is excluded here rather than counted as
  // zero (which would fake a shortfall).
  const amountPaid = num(invoice.AmountPaid)
  if (amountPaid !== null && records.every((r) => r.amount !== null)) {
    const seen = records.reduce((total, r) => total + (r.amount ?? 0), 0)
    if (amountPaid - seen > XERO_AMOUNT_EPSILON) {
      return {
        ok: false,
        reason: `Xero reports ${amountPaid.toFixed(2)} paid against this document but returned `
          + `${records.length === 0 ? 'no payments' : `payments totalling ${seen.toFixed(2)}`}`,
      }
    }
  }

  // THE SHAPE-INDEPENDENT SETTLEMENT ACCOUNTING (Codex round 6, finding 3) — the same arithmetic
  // the QuickBooks probe already does, for the same reason, because `AmountPaid` is not the whole
  // of what settles a Xero document.
  //
  // WHAT XERO CAN AND CANNOT SEE FROM HERE. A credit note allocated to this invoice reduces
  // `AmountCredited`, NOT `AmountPaid`, and does not appear in `Payments` at all. So an invoice a
  // human has settled entirely with a credit note reads as `AmountPaid: 0, Payments: []` — the
  // strongest answer this probe can give, "positively nothing settles this document", and false.
  // Prepayment and overpayment allocations are the same shape.
  //
  // So the question asked here is arithmetic, not vocabulary: `Total - AmountDue` is Xero's own
  // account of how much of this document has been settled BY ANY MEANS, and every penny of it has
  // to be explained by something this probe actually read — a payment, or an applied credit /
  // prepayment / overpayment. Whatever is left over is money off the document by a shape IMS
  // cannot see, and a `clear` built on the payment list alone would be a claim that list cannot
  // support.
  //
  // WHAT THIS COSTS, STATED. An invoice whose credit is reported in `AmountCredited` while the
  // `CreditNotes` collection is missing or short can no longer be posted to automatically; the row
  // fails visibly and a human resolves it. A credit that IS itemised explains itself and changes
  // no verdict, so the ordinary part-credited invoice still pays automatically — which is the
  // difference between reading the collections and simply refusing on `AmountCredited > 0`.
  const total = num(invoice.Total)
  const amountDue = num(invoice.AmountDue)
  const amountCredited = num(invoice.AmountCredited)
  const settled = total !== null && amountDue !== null
    ? total - amountDue
    // Fallback for a response that omits the totals: the two component fields, which is still
    // strictly more than `AmountPaid` alone was.
    : amountPaid !== null && amountCredited !== null ? amountPaid + amountCredited : null
  const applied = [sumApplied(invoice.CreditNotes), sumApplied(invoice.Prepayments), sumApplied(invoice.Overpayments)]
    .reduce<number | null>((sum, part) => (sum === null || part === null ? null : sum + part), 0)
  // Null the moment any read settlement is unmeasurable: an unknown addend makes the whole sum
  // unknown, and an unknown sum must not be allowed to "explain" anything.
  const explained = records.reduce<number | null>(
    (sum, record) => (sum === null || record.amount === null ? null : sum + record.amount),
    applied,
  )
  if (settled !== null && settled > XERO_AMOUNT_EPSILON
    && (explained === null || settled - explained > XERO_AMOUNT_EPSILON)) {
    return {
      ok: false,
      reason: `Xero reports ${settled.toFixed(2)} already settled against this document but `
        + (explained === null
          ? 'IMS could not measure what it holds against it'
          : `only ${explained.toFixed(2)} of it is accounted for by settlements IMS can read`)
        + (amountCredited !== null && amountCredited > XERO_AMOUNT_EPSILON
          ? ` (${amountCredited.toFixed(2)} of it credited, not paid)`
          : ''),
    }
  }
  return { ok: true, records }
}

/** Money compares to the half-penny here too — the same tolerance the classifier uses. */
const XERO_AMOUNT_EPSILON = 0.005

type QboLinkedTxn = { TxnId?: string; TxnType?: string }
type QboPaymentLine = { Amount?: number; LinkedTxn?: QboLinkedTxn[] }
type QboDocumentBody = {
  LinkedTxn?: QboLinkedTxn[]
  /** The document's face value and what is still owed on it — the shape-independent cross-check. */
  TotalAmt?: number
  Balance?: number
}

/**
 * WHAT QUICKBOOKS ACTUALLY WRITES INTO `LinkedTxn.TxnType` (Codex round 4, finding 1).
 *
 * The entity you POST is `BillPayment`. The link QuickBooks then records on the Bill is NOT
 * `BillPayment` — it is `BillPaymentCheck` or `BillPaymentCreditCard`, named after the PayType.
 * IMS posts `PayType: 'Check'`, so every bill payment this system has ever made is recorded as
 * `BillPaymentCheck`, and a probe matching on `BillPayment` found NONE of them. It reported
 * `records: []`, the classifier read that as `clear`, and the fence treated "I looked and there
 * is nothing" as permission to pay the bill again. A probe that cannot see a real settlement is
 * worse than no probe at all, because the fence claims a coverage it does not have.
 *
 * Hence three rules, not one:
 *
 *  1. PAYMENT links — the shape IMS itself posts — are enumerated and READ. Both bill-payment
 *     spellings, plus the bare entity name defensively, because a name that has changed once can
 *     change again and the cost of accepting an extra alias is nil.
 *  2. Links that are KNOWN not to be that shape are ignored, and which ones they are is written
 *     down (below) instead of being left to a silent `filter`.
 *  3. Anything else FAILS THE PROBE. An unclassified link type is exactly the state this bug was
 *     in for a whole release: a settlement the probe cannot account for, silently dropped. It is
 *     now an `unknown`, which every caller treats as a refusal.
 */
const QBO_PAYMENT_LINK_TYPES: Record<'Bill' | 'Invoice', ReadonlySet<string>> = {
  // Read from /billpayment/{id} whichever of the three names the link carries.
  Bill: new Set(['BillPaymentCheck', 'BillPaymentCreditCard', 'BillPayment']),
  // Customer payments keep the plain entity name on the invoice's link.
  Invoice: new Set(['Payment']),
}

/**
 * RECOGNISED, AND NOT THEREFORE HARMLESS (Codex round 5, finding 3).
 *
 * These links take money off the document by a shape IMS neither posts nor reads. Round 4 lumped
 * them in with the links that take NO money off it and ignored both, so a bill an operator had
 * settled with a vendor credit or a journal entry came back from this probe as `records: []` —
 * which the classifier reads as `clear` and the fence acts on. "Recognised" was doing the work of
 * "accounted for", and they are not the same claim: an unrecognised type fails closed, while a
 * recognised-but-uncovered one was reported as a positive clear. That is a lie about money.
 *
 * They are still not fetched — none of them can BE an IMS attempt, and reading five more entity
 * shapes to measure them is a bigger change than this fence should carry. What they do instead is
 * make the document's own arithmetic decide: see the settlement accounting at the end of
 * `probeQuickBooksSettlement`. A linked vendor credit that has taken nothing off the balance
 * changes no verdict; one that has taken money off leaves an amount no readable payment explains,
 * and the probe then refuses instead of reporting a clear it cannot support.
 */
const QBO_UNCOVERED_SETTLEMENT_LINK_TYPES: ReadonlySet<string> = new Set([
  'CreditMemo', 'VendorCredit', 'Deposit', 'JournalEntry', 'Refund', 'RefundReceipt',
  'Check', 'Expense', 'Purchase', 'Transfer', 'CreditCardCredit', 'CreditCardPayment',
  // The other document kind's payment link. Treated as a settlement rather than as noise: it is
  // payment-shaped money movement, and its appearing on a document this probe does not read it
  // for means the reasoning about which endpoint holds the settlements is already off.
  'Payment', 'BillPayment', 'BillPaymentCheck', 'BillPaymentCreditCard',
])

/**
 * Links that carry no money off the document at all: what it was raised FROM, and what was billed
 * ONTO it. These genuinely are noise, and ignoring them is what stops the probe refusing every
 * bill that came from a purchase order.
 */
const QBO_NON_SETTLING_LINK_TYPES: ReadonlySet<string> = new Set([
  'Estimate', 'PurchaseOrder', 'SalesReceipt', 'TimeActivity', 'ReimburseCharge', 'Charge',
  'Invoice', 'Bill', 'InventoryQuantityAdjustment',
])

/** Money compares to the half-penny, as everywhere else on this path. */
const QBO_AMOUNT_EPSILON = 0.005

/**
 * The amount a QuickBooks payment applied to ONE document.
 *
 * Not TotalAmt: a payment can settle several invoices at once, and IMS's own attempt posts a single
 * line for a single document. Summing the lines linked to this document is what compares like with
 * like. A payment with no readable line for it yields null, which reads as `unknown`.
 */
function qboAmountAppliedTo(lines: QboPaymentLine[] | undefined, documentId: string, txnType: string): number | null {
  if (!lines) return null
  let total: number | null = null
  for (const line of lines) {
    const linked = (line.LinkedTxn ?? []).some(
      (t) => str(t.TxnId) === documentId && str(t.TxnType) === txnType,
    )
    if (!linked) continue
    const amount = num(line.Amount)
    if (amount === null) return null
    total = (total ?? 0) + amount
  }
  return total
}

export async function probeQuickBooksSettlement(
  target: SettlementProbeTarget,
  qboGet: QboFetcher,
): Promise<LedgerSettlementProbe> {
  const payload = asRecord(target.payload)
  const documentId = str(payload.accountingInvoiceId)
  if (target.type === 'PURCHASE_CREDIT_NOTE_ALLOCATION') {
    // The QuickBooks processor has no branch for this type, so a row of it cannot have posted here
    // — but "cannot have posted" is a claim about code, and this module's contract is evidence.
    return { ok: false, reason: 'QuickBooks does not post credit-note allocations, so IMS cannot read one back' }
  }
  if (!documentId) return { ok: false, reason: 'the row records no document id to check' }

  const isBill = target.type === 'BILL_PAYMENT'
  const documentPath = isBill ? 'bill' : 'invoice'
  const documentKey = isBill ? 'Bill' : 'Invoice'
  const settlementPath = isBill ? 'billpayment' : 'payment'
  // The entity NAME a payment is read back under, which is not the same string as the LINK type
  // the document carries — see QBO_PAYMENT_LINK_TYPES.
  const settlementKey = isBill ? 'BillPayment' : 'Payment'
  const linkedType = isBill ? 'Bill' : 'Invoice'
  const paymentLinkTypes = QBO_PAYMENT_LINK_TYPES[documentKey]

  const doc = await qboGet<Record<string, QboDocumentBody | undefined>>(
    `${documentPath}/${encodeURIComponent(documentId)}`,
  )
  if (!doc.ok) return { ok: false, reason: doc.error ?? `HTTP ${doc.status}` }
  const body = doc.data?.[documentKey]
  if (!body) return { ok: false, reason: `QuickBooks returned no ${documentKey.toLowerCase()} for that id` }

  const links = body.LinkedTxn ?? []
  // Rule 3 first, so an unclassified link cannot be quietly outvoted by classified ones.
  //
  // A link with NO READABLE TYPE counts as unclassified (Codex round 5, finding 4, escape one).
  // Round 4 excluded `type !== ''` from this filter, so a link whose TxnType was absent, blank or
  // not a string was matched by nothing: not a payment, so never read; not unclassified, so never
  // refused. It is the same "a settlement the probe cannot account for, silently dropped" this
  // rule exists to stop, wearing a missing field instead of a new name.
  const unclassified = [...new Set(links.map((t) => str(t.TxnType) || '(untyped)').filter(
    (type) => !paymentLinkTypes.has(type) && !QBO_UNCOVERED_SETTLEMENT_LINK_TYPES.has(type)
      && !QBO_NON_SETTLING_LINK_TYPES.has(type),
  ))]
  if (unclassified.length > 0) {
    return {
      ok: false,
      reason: `QuickBooks linked ${unclassified.join(', ')} to this ${documentKey.toLowerCase()} and this `
        + 'probe cannot tell whether that settles it',
    }
  }

  const paymentLinks = links.filter((t) => paymentLinkTypes.has(str(t.TxnType)))
  // A PAYMENT LINK WITH NO ID cannot be fetched, and dropping it is the second escape (Codex
  // round 5, finding 4). `.filter(Boolean)` removed it silently, leaving a settlement this probe
  // KNOWS exists out of the record list it then reports as complete — the same shape as the
  // unreadable-settlement refusal below, and it must fail the same way.
  if (paymentLinks.some((t) => str(t.TxnId) === '')) {
    return {
      ok: false,
      reason: `QuickBooks linked a ${settlementKey} to this ${documentKey.toLowerCase()} with no id, `
        + 'so IMS cannot read what it settled',
    }
  }
  const settlementIds = paymentLinks.map((t) => str(t.TxnId))

  const records: LedgerSettlementRecord[] = []
  for (const id of settlementIds) {
    const res = await qboGet<Record<string, { TxnDate?: string; PrivateNote?: string; Line?: QboPaymentLine[] } | undefined>>(
      `${settlementPath}/${encodeURIComponent(id)}`,
    )
    // A settlement we know EXISTS but cannot read is the most dangerous shape of all: dropping it
    // would leave a clear verdict built from an incomplete list.
    if (!res.ok) return { ok: false, reason: `could not read ${settlementKey} ${id}: ${res.error ?? `HTTP ${res.status}`}` }
    const settlement = res.data?.[settlementKey]
    if (!settlement) return { ok: false, reason: `QuickBooks returned no ${settlementKey} ${id}` }
    const date = str(settlement.TxnDate)
    records.push({
      amount: qboAmountAppliedTo(settlement.Line, documentId, linkedType),
      date: date.length >= 10 ? date.slice(0, 10) : null,
      id,
      // PrivateNote is where IMS writes its mark on this connector.
      reference: str(settlement.PrivateNote) || null,
    })
  }

  // THE SHAPE-INDEPENDENT SETTLEMENT ACCOUNTING. Everything above depends on a list of type names
  // being right, and the bug this replaces was a list of type names being wrong. `TotalAmt` and
  // `Balance` are not names — they are the document's own account of how much of it has been
  // settled, by any means whatsoever. So the question asked here is arithmetic, not vocabulary:
  // is every penny that has come off this document explained by a settlement this probe actually
  // READ? Whatever is not is money moved by something the record list below does not contain, and
  // a `clear` built from that list would be a claim the list cannot support.
  //
  // Round 4 asked this only when NOTHING was linked, which is why finding 3 was possible: a
  // vendor credit or a journal entry appears as a link, was "recognised", and so suppressed the
  // only check that could have noticed it had taken money off the bill.
  //
  // WHAT THIS COSTS, STATED. A document part-settled by a shape IMS does not read — a vendor
  // credit, a deposit, a manual journal — can no longer be posted to automatically; the row fails
  // visibly and a human resolves it. That is a real cost and it is the right way round: the
  // alternative is the fence being told the document is clear when an operator has already
  // settled it. Restoring automatic coverage means READING those entities (each has its own line
  // and link shape), which is a bigger change than this fence should carry — tracked separately.
  const total = num(body.TotalAmt)
  const balance = num(body.Balance)
  const applied = total !== null && balance !== null ? total - balance : null
  // Null the moment any read settlement's applied amount is unreadable: an unknown addend makes
  // the whole sum unknown, and an unknown sum must not be allowed to "explain" anything.
  const explained = records.reduce<number | null>(
    (sum, record) => (sum === null || record.amount === null ? null : sum + record.amount),
    0,
  )
  // `Payment` and the bill-payment spellings appear in BOTH tables — they are the covered shape on
  // one document kind and an uncovered one on the other — so the payment table wins first, or a
  // settlement this probe has just READ would be counted as one it cannot account for.
  const uncovered = [...new Set(links.map((t) => str(t.TxnType)).filter(
    (type) => !paymentLinkTypes.has(type) && QBO_UNCOVERED_SETTLEMENT_LINK_TYPES.has(type),
  ))]
  if (applied === null) {
    // The document's own numbers are missing, so nothing can be reconciled against them. Only a
    // problem when a settlement IMS cannot measure is linked — otherwise the read payments are
    // the whole picture and the classifier judges them on their own terms.
    if (uncovered.length > 0) {
      return {
        ok: false,
        reason: `QuickBooks links ${uncovered.join(', ')} to this ${documentKey.toLowerCase()} and reports no `
          + 'total or balance, so IMS cannot tell how much of it is already settled',
      }
    }
  } else if (applied > QBO_AMOUNT_EPSILON && (explained === null || applied - explained > QBO_AMOUNT_EPSILON)) {
    return {
      ok: false,
      reason: `QuickBooks reports ${applied.toFixed(2)} already applied to this ${documentKey.toLowerCase()} but `
        + (explained === null
          ? 'IMS could not measure what the payments it links applied to it'
          : `only ${explained.toFixed(2)} of it is accounted for by payments IMS can read`)
        + (uncovered.length > 0
          ? ` (${uncovered.join(', ')} linked)`
          : links.length === 0 ? ' and links no transaction that accounts for it' : ''),
    }
  }
  return { ok: true, records }
}

/**
 * Ask a connector what it already holds against the document this row targets.
 *
 * Never throws: a thrown probe would be caught by the caller's outer try and reported as a generic
 * action failure, which reads to an operator as "try again" — the opposite of the intended refusal.
 */
export async function probeLedgerSettlement(
  connector: 'xero' | 'quickbooks',
  target: SettlementProbeTarget,
): Promise<LedgerSettlementProbe> {
  try {
    if (connector === 'xero') {
      const { xeroGet } = await import('./xero/api')
      return await probeXeroSettlement(target, xeroGet as XeroFetcher)
    }
    const { qboGet } = await import('./quickbooks/api')
    return await probeQuickBooksSettlement(target, qboGet as QboFetcher)
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * The document a probe answers about, so several rows targeting the same one share a single read.
 *
 * Delegates to the SAME key the money-post lock is taken on (round 6, Codex CRITICAL #2): the
 * document the exclusion covers and the document the probe reads must not be able to be two
 * different things.
 */
export function settlementProbeKey(target: SettlementProbeTarget): string {
  return settlementDocumentKey(target.type, target.payload)
}

/**
 * o3d-0m56 — the AUTOMATIC counterpart of the manual retry's settlement rule.
 *
 * `planFollowUpEnqueue` revives a FAILED money row under the token that row's attempt used, on the
 * same reasoning the manual retry used to rely on: the remote will recognise the repeat. It will
 * not, once its deduplication window has closed, and a re-enqueue happens whenever the connector
 * next runs — which for a row that failed hours ago is far outside that window. So the automatic
 * path has to establish the same thing the operator-facing one does: that this attempt is not
 * already in the ledger.
 *
 * Only for a PINNED token: a rotated one means the planner already established that no surviving
 * attempt could have committed this document, so there is nothing to have happened twice.
 */
export async function ledgerClearsFollowUpRevival(params: {
  connector: 'xero' | 'quickbooks'
  type: string
  payload: unknown
  tokenDisposition: 'pinned' | 'rotated'
  /** The row being revived, so its own mark can be looked for. */
  syncLogId?: string
}): Promise<{ clear: true } | { clear: false; reason: string }> {
  const { isMoneyMovingSyncType, effectiveTokenFor } = await import('@/lib/domain/accounting/followup-retry-guard')
  if (params.tokenDisposition !== 'pinned' || !isMoneyMovingSyncType(params.type)) return { clear: true }

  const { classifyLedgerSettlement, describeAttempt, settlementMarkerFor } = await import('@/lib/domain/accounting/ledger-settlement-evidence')
  const probe = await probeLedgerSettlement(params.connector, { type: params.type, payload: params.payload })
  const marker = settlementMarkerFor(effectiveTokenFor(params.connector, { id: params.syncLogId ?? '', payload: params.payload }))
  const verdict = classifyLedgerSettlement(describeAttempt(params.type, params.payload, marker), probe)
  if (verdict.outcome === 'clear') return { clear: true }
  return {
    clear: false,
    reason: verdict.outcome === 'present'
      ? `the ledger already holds a settlement of ${verdict.detail} matching this attempt`
      : verdict.reason,
  }
}

/**
 * o3d-0m56 round 2 (Codex) — THE CHECK THAT ACTUALLY AUTHORISES A MONEY POST.
 *
 * Everything above runs at RETRY or ENQUEUE time, which is early enough to tell an operator why
 * their click was refused and far too early to be the thing money depends on. Two gaps proved it:
 *
 *   - A failed money row does not go straight to FAILED. It returns to PENDING for up to five
 *     attempts, and each of those attempts posts again with no ledger read at all — the revival
 *     guard only ever saw terminal rows.
 *   - A verdict taken before a lock is a verdict about the past. Between reading the ledger and
 *     writing PENDING, something else can post the very attempt that was just declared absent.
 *
 * Both close the same way: the reading that permits a POST is taken in the same code path as the
 * POST, immediately before it. `remoteAttemptedAt` is what makes that possible — it is set once,
 * before the first call, and survives every retryCount reset, so a row can always answer "have I
 * been sent before?".
 *
 * Round 4 removed the last exemption. A first attempt in a scope nothing has been sent from used
 * to skip the ledger read entirely; it no longer does, because the settlement such a row cannot
 * know about is the one a HUMAN entered, and that is the case a first attempt is least equipped
 * to reason about and most likely to pay twice. Every money post now pays for one GET.
 *
 * "Everything else" is wider than this row's own history, and that is round 3: the fence judges
 * this attempt AND every rival attempt in the same scope, each against its own mark. A rival's
 * committed payment carries the rival's mark, so it is invisible to this row's — and invisible to
 * the amount-and-date fallback as soon as the two receipts differ.
 *
 * Returns the refusal as an ERROR rather than a silent skip: the caller reports it exactly like a
 * remote rejection, so the row retries a bounded number of times and then ends FAILED — visible,
 * and (correctly) un-revivable while the ledger still holds the payment.
 */
export type MoneyPostFenceParams = {
  connector: 'xero' | 'quickbooks'
  entryId: string
  type: string
  referenceType: string
  referenceId: string
  payload: unknown
  /**
   * THE DATE THIS POST IS SENDING — resolved ONCE, by the caller, and carried (Codex round 7,
   * HIGH #1).
   *
   * Round 6 gave the processor and the fence one shared function and called the mirror gone. It
   * was not: `moneyPostDateToSend`'s wall-clock arm answers about the `Date` it is handed, and the
   * two sides handed it two different instants. Astride a UTC midnight those are different days,
   * so the probe went looking for a settlement dated the 19th while the post created one dated the
   * 18th — and a human's payment on the 18th was therefore not matched. A weakened match is not a
   * conservative failure here; it is precisely how a real settlement goes unseen and a second
   * payment is authorised.
   *
   * REQUIRED, not defaulted: a fence that could fall back to a clock of its own is a fence that
   * still has a second resolution site in it. The value is the exact string the branch puts on the
   * wire, so the date this authorisation was taken against and the date the ledger will hold are
   * the same value by construction, not by agreement.
   */
  postingDate: string
  /** Injected so the guard is testable without a database. */
  db: {
    accountingSyncLog: {
      updateMany: (args: { where: { id: string; remoteAttemptedAt: null }; data: { remoteAttemptedAt: Date } }) => Promise<{ count: number }>
      findMany: (args: {
        where: {
          connector: string
          type: AccountingSyncType
          remoteAttemptedAt: { not: null }
          id: { not: string }
          /**
           * BOTH KEYS, IN A DEFINED ORDER (round 6, Codex CRITICAL #2): the local scope this row
           * sits in, then the external document it names — one arm per anchor THIS TYPE is
           * identified by (round 9, HIGH #1), each a CASE-INSENSITIVE match, because `equals` on a
           * JSON path is byte-exact and an enumeration of spellings cannot cover mixed case
           * (round 8, HIGH #1). See the query below.
           */
          OR: Array<
            | { referenceType: string; referenceId: string }
            | { payload: { path: string[]; string_contains: string; mode: 'insensitive' } }
          >
        }
        select: { id: true; payload: true }
      }) => Promise<Array<{ id: string; payload: unknown }>>
    }
  }
  /**
   * The clock for the ATTEMPT STAMP only, injected so the write is testable.
   *
   * Deliberately NOT the source of the posting date any more (round 7, Codex HIGH #1) — that
   * arrives as `postingDate`, already resolved. Two clocks on one path is exactly how the fence
   * ended up authorising a different day from the one it was authorising for.
   */
  now?: () => Date
}

export async function authoriseMoneyPost(
  params: MoneyPostFenceParams,
): Promise<{ proceed: true } | { proceed: false; error: string }> {
  const { isMoneyMovingSyncType } = await import('@/lib/domain/accounting/followup-retry-guard')
  if (!isMoneyMovingSyncType(params.type)) return { proceed: true }

  // ONE conditional write decides it, with no read first — and the absence of the read is the
  // point. "Has this been sent before?" asked as a SELECT is a question about the past: two
  // workers can both read `remoteAttemptedAt: null` and both conclude they are the first. Claiming
  // the stamp is the same question asked as a WRITE, which exactly one caller can win.
  //
  // count 1 — this call claimed the first attempt. Nothing can have been posted from this row
  //           before, so there is nothing to duplicate and nothing to check.
  // count 0 — the stamp is already set (a previous attempt), or the row is GONE (retention, a
  //           connector switch), or another worker claimed it a moment ago. All three mean the
  //           same thing here: IMS cannot say this row has never been sent, and unknown must
  //           never read as "first time".
  const now = params.now ?? (() => new Date())
  const claimed = await params.db.accountingSyncLog.updateMany({
    where: { id: params.entryId, remoteAttemptedAt: null },
    data: { remoteAttemptedAt: now() },
  })
  // This ROW may be new — but the DOCUMENT may not be (Codex round 3). A receipt recorded beside an
  // older failed attempt queues a brand-new row, and that row's first post would otherwise go out on
  // the strength of a reading taken before it was even created. So: every OTHER row that has ever
  // been sent and could have settled this document, whatever became of it.
  //
  // KEYED ON THE DOCUMENT AS WELL AS THE SCOPE (round 6, Codex CRITICAL #2). Round 5 asked only
  // about `(referenceType, referenceId)` — where the row lives in IMS. A rival row for the SAME
  // `accountingInvoiceId` filed under another scope (a re-raised purchase invoice, a payment row
  // re-created against a replacement order, a bill payment queued against the PO in one release
  // and the invoice in the next) was invisible to it, and invisible to the lock for the same
  // reason. The probe reads the document, so the rival's committed payment IS in the reading —
  // but it carries the RIVAL's mark, and the amount-and-date fallback loses it the moment the two
  // receipts differ. Nothing then refuses, and the document is paid twice.
  //
  // Both arms, in a defined order. The scope arm is first and is unconditional: it is indexed, and
  // it keeps a row with NO recorded anchor a contender of its own scope, which is what
  // `attemptCouldBeTheSameDocument` has always treated as "possibly this document". The document
  // arms follow, one per anchor THIS TYPE is identified by that this row actually names — with no
  // id there is nothing to match, and the probe below refuses such a post outright anyway.
  //
  // AND THE ARMS ARE THE TYPE'S OWN ANCHORS (round 9, Codex HIGH #1). They come from
  // `documentAnchorFields`, the same definition the lock key, the probe cache key and the contender
  // comparison use — so a type identified by something other than `accountingInvoiceId` cannot
  // leave this pre-filter looking somewhere the decision does not. They are OR'd, not AND'd: a row
  // that really is this document matches EVERY anchor and so matches the OR, whereas an AND would
  // drop a rival whose payload merely omits one of them. Over-fetching is free here and
  // under-fetching is the double post.
  //
  // AND CASE-FOLDED — FOR EVERY CASING, NOT THREE OF THEM (round 8, Codex HIGH #1). `equals` on a
  // JSON path is byte-exact in PostgreSQL, so a rival row holding the SAME Xero GUID in another
  // case was matched by neither arm: the scope arm because it sits elsewhere, the document arm
  // because `4D8A…` is not `4d8a…`. Round 7 answered that with three spellings — as-stored, lower,
  // upper — which a MIXED-case id is outside all of, leaving the identical cross-scope double post
  // one spelling further along. Enumerating spellings can never be complete; the fold has to be in
  // the predicate, so the arm is a case-insensitive match the database performs
  // (`LOWER(payload#>>…) LIKE LOWER(…)`, verified against the dev database — see
  // settlementDocumentAnchorFilters). The returned rows are still put through
  // `attemptCouldBeTheSameDocument` below, which folds case the same way, so this pre-filter can
  // only add contenders and never decides anything on its own.
  //
  // NOTHING IN THE TYPES CHECKS THIS ARM, and it was worth finding out: `db` is a structural shape
  // so the call sites never compare it with the real client, and Prisma's own `payload` filter type
  // admits any JSON object, so a misspelt filter key type-checks either way (both tried; `tsc
  // --noEmit` stayed silent across the repo for `string_contains_bogus`). A wrong key here would
  // therefore fail at runtime, inside the money-post lock. What pins it instead is the pair of
  // checks that can: this exact filter was run against the dev database, and the tests assert the
  // arm's shape literally.
  const documentFilters = settlementDocumentAnchorFilters(params.type, params.payload)
  const attemptedSiblings = await params.db.accountingSyncLog.findMany({
    where: {
      connector: params.connector,
      type: params.type as AccountingSyncType,
      remoteAttemptedAt: { not: null },
      id: { not: params.entryId },
      OR: [
        { referenceType: params.referenceType, referenceId: params.referenceId },
        ...documentFilters.map((filter) => ({ payload: filter })),
      ],
    },
    select: { id: true, payload: true },
  })
  const { classifyLedgerSettlement, comparableAttemptDate, describeAttempt, settlementMarkerFor } = await import('@/lib/domain/accounting/ledger-settlement-evidence')
  const { effectiveTokenFor, attemptCouldHaveReachedTheLedger, attemptCouldBeTheSameDocument } = await import('@/lib/domain/accounting/followup-retry-guard')

  // EVERY CONTENDER, EACH BY ITS OWN MARK — this row and every rival that could have settled the
  // same document (Codex round 3 follow-up). Judging only this row's own attempt was the hole the
  // mark was invented to close, reopened one level down: the sibling that made this post suspicious
  // in the first place was never asked about. Its payment carries ITS token's mark, not this one's,
  // so a settlement it committed is invisible to this row's marker — and invisible to the amount-
  // and-date fallback too the moment the second receipt is entered for a different day or amount,
  // which is exactly what an operator re-recording a lost payment does.
  //
  // This row is a contender only when it did NOT claim the stamp. Winning the claim is proof that
  // no remote call has ever left this row, so its own attempt cannot be in the ledger; judging it
  // anyway would refuse a fresh receipt whenever some unrelated payment happened to share its
  // amount and date, and leave the row pointing at a settlement that was never its own.
  const contenders: Array<{ id: string; payload: unknown; own: boolean }> = [
    ...(claimed.count > 0 ? [] : [{ id: params.entryId, payload: params.payload, own: true }]),
    ...attemptedSiblings.map((row) => ({ id: row.id, payload: row.payload, own: false })),
  ]
    // Filtered the same two ways `planManualRetry` filters its contenders, so the POST fence and
    // the retry planner cannot disagree about who the rivals are.
    //
    // A body missing a field its connector requires was rejected before any HTTP call, so it
    // provably committed nothing. Without this, one malformed row makes a valid payment unsendable
    // for ever — and a malformed body of our own would be refused for want of evidence about a
    // call that was never made, which is the exemption `planManualRetry` already gives its target.
    .filter((row) => attemptCouldHaveReachedTheLedger(params.type, row.payload))
    // An attempt against a different document cannot have settled this one, and is not covered by
    // the probe below either — so judging this post against it would be comparing an attempt with
    // a ledger reading that says nothing about it.
    .filter((row) => attemptCouldBeTheSameDocument(params.type, row.payload, params.payload))

  const probe = await probeLedgerSettlement(params.connector, { type: params.type, payload: params.payload })

  /**
   * THE FIRST ROW IN A VIRGIN SCOPE — no longer a free pass (Codex round 4, finding 3).
   *
   * It used to return before the probe, on the reasoning that a row nothing has been sent from
   * cannot duplicate an attempt of OURS. That is true and it is not the hazard. The hazard is a
   * settlement A HUMAN made: an operator who records the payment in Xero by hand and then marks
   * the invoice paid in IMS queues a brand-new row against a document that is already settled,
   * and a first attempt is precisely the case that cannot know about it from its own history.
   * The probe CAN see it. Being told to ignore what the probe can see, on a money path, is not a
   * defensible saving — and the saving was one GET.
   *
   * Judged with this row's own MARKER as well as its numbers, because a marker match is possible
   * here even though this row has never posted: a revival that carried a pinned
   * `_idempotencyKey` over from a row retention has since deleted posts under the SAME mark, and
   * that vanished predecessor leaves no sibling to be found.
   *
   * THE DATE IS PINNED HERE, NOT WAIVED (Codex round 5, finding 1). Round 4 let an `unknown` of
   * cause `attempt-undescribable` proceed, on the reasoning that a row the processors will date
   * "today at post time" can never be described, so refusing would strand it for ever. The
   * reasoning was right that refusing for ever is wrong and wrong that proceeding is therefore
   * right: it let a virgin undated row walk straight past a settlement the probe could SEE.
   *
   * What makes it describable is that this row has not been sent yet. `params.postingDate` is
   * the very value the processor is about to put in the ledger — not a prediction of it. Round 6
   * predicted it by calling the processors' own date function a second time here, which is a
   * prediction whenever that function reads a clock: astride a UTC midnight the two calls answer
   * different days, and the probe then hunts a settlement the post will never create (round 7,
   * Codex HIGH #1). The caller resolves it once and hands it over, so the attempt is compared on
   * what it WILL create by construction. (Sound only because this branch is unreachable for a row
   * that has posted: a row that failed to claim the stamp is a contender unless
   * `attemptCouldHaveReachedTheLedger` rejects its body, and that rejection is itself proof no
   * call was ever made.)
   *
   * That leaves one genuinely undescribable shape — a payload with no readable AMOUNT, which
   * both connectors reject before any HTTP call anyway. It may still not walk past a settlement
   * the probe can see: an undescribable attempt proceeds only when the ledger positively holds
   * NOTHING, which is the one state in which there is nothing to duplicate. Both LEDGER unknowns
   * — the probe could not answer, or it returned a settlement it could not measure — refuse as
   * before.
   */
  if (contenders.length === 0) {
    const marker = settlementMarkerFor(effectiveTokenFor(params.connector, { id: params.entryId, payload: params.payload }))
    const attempt = describeAttempt(params.type, params.payload, marker, { postingOn: comparableAttemptDate(params.postingDate) })
    const verdict = classifyLedgerSettlement(attempt, probe)
    if (verdict.outcome === 'present') {
      return {
        proceed: false,
        error: `Not sent: the accounting connector already holds a settlement of ${verdict.detail} against `
          + 'this document, and IMS has never sent one for it — so it was recorded outside IMS. '
          + 'Sending this would pay it twice. Check the ledger and resolve this entry by hand.',
      }
    }
    if (verdict.outcome === 'unknown') {
      if (verdict.cause !== 'attempt-undescribable') {
        return {
          proceed: false,
          error: `Not sent: IMS could not establish what the accounting connector already holds against `
            + `this document (${verdict.reason}). Posting on a reading that failed could pay it twice.`,
        }
      }
      // Undescribable AND the ledger is not empty: this row cannot say what it would create, so it
      // cannot rule itself out against what is already there. Refuse on what is visible.
      if (!probe.ok || probe.records.length > 0) {
        return {
          proceed: false,
          error: 'Not sent: this entry does not record the amount its attempt would send, and the '
            + `accounting connector already holds ${probe.ok ? probe.records.length : 'a'} settlement`
            + `${probe.ok && probe.records.length === 1 ? '' : 's'} against this document. IMS cannot `
            + 'tell them apart, so sending could pay it twice. Resolve this entry by hand.',
        }
      }
    }
    return { proceed: true }
  }

  for (const contender of contenders) {
    const marker = settlementMarkerFor(effectiveTokenFor(params.connector, contender))
    const verdict = classifyLedgerSettlement(describeAttempt(params.type, contender.payload, marker), probe)
    if (verdict.outcome === 'clear') continue
    if (verdict.outcome === 'present') {
      return {
        proceed: false,
        error: `Not sent: the accounting connector already holds a settlement of ${verdict.detail} against `
          + `this document, matching ${contender.own ? 'an earlier attempt from this entry' : `another entry for it (${contender.id})`}. `
          + 'Sending it again would pay it twice. Check the ledger and resolve this entry by hand.',
      }
    }
    return {
      proceed: false,
      error: `Not sent: ${contender.own ? 'this entry has been attempted before' : `another entry for this document has been attempted (${contender.id})`} `
        + `and IMS could not establish whether that attempt reached the ledger (${verdict.reason}). `
        + 'Re-posting could pay the document twice.',
    }
  }
  return { proceed: true }
}

/** What a money branch returns to its processor. Structurally the two connectors' `EntryResult`. */
export type MoneyPostOutcome = { success: boolean; externalId?: string; error?: string }

/**
 * A money POST made while its exclusion was gone. Every field needed to find the document — this
 * is the record that turns "we may have paid twice" from something discovered at reconciliation
 * into something searchable from the minute it happened.
 *
 * DURABLE, NOT LOG-ONLY (round 6, Codex HIGH #4). Round 5 wrote this to stderr and called it
 * "announced". Stderr is a stream: whoever is watching at that second sees it and nobody else
 * ever does, so an operator looking at the accounting sync history — or any alerting that reads
 * IMS's own records rather than a container's log driver — finds a payment that simply succeeded,
 * with nothing anywhere saying it went out unprotected. On a double-payment path that is the
 * difference between a searchable incident and a rumour.
 *
 * So it is also written to the ACTIVITY LOG, at ERROR, against the sync row. Not to the sync row
 * itself: a successful post is immediately followed by `status: SYNCED, errorMessage: null` in
 * both processors, so anything this wrote there would be erased by the write that reports the
 * success.
 *
 * AND THE WRITE IS CHECKED (round 7, Codex MEDIUM #3). It used to call `logActivity`, which never
 * throws AND swallows its own failures — so the `catch` around it could not fire, and a write that
 * failed was indistinguishable here from one that succeeded. The durable record could therefore
 * vanish silently at exactly the moment it mattered, leaving the code believing it had made the
 * incident findable. `logActivityPersisted` is the same call that REPORTS, and its answer is used:
 *
 *  1. one retry, because the common failure is a transient blip on a connection pool that has just
 *     been hammered by an HTTP round trip, and a second attempt costs nothing on the happy path
 *     (it is not reached at all unless the first fails);
 *  2. failing that, a distinct stderr line that says the durable record was NOT written and
 *     carries the whole incident as JSON, so it is reconstructable from the log stream rather than
 *     merely alluded to;
 *  3. the outcome is RETURNED, so the caller can put the incident somewhere that does survive when
 *     it has such a place — a failed post's `errorMessage` is written to the sync row and not
 *     overwritten, so that branch says so in the operator-facing text.
 *
 * It still never throws. The incident must not turn a committed payment into an exception, which
 * is the one thing worse than an unrecorded incident.
 *
 * Deliberately NOT a re-probe. Reading the ledger again here could not be conclusive: a rival
 * post inside the same window may not be readable yet, and one that lands a second later would be
 * missed anyway. An inconclusive check that reads like a verdict is worse than a plain alarm.
 */
async function reportLostMoneyPostExclusion(
  params: { connector: string; entryId: string; type: string; referenceType: string; referenceId: string; payload?: unknown },
  outcome: 'committed' | 'failed' | 'threw',
  externalId?: string,
): Promise<{ persisted: boolean }> {
  const description = `Money post made without its exclusion: the advisory lock's connection died `
    + `while the ${params.type} call to ${params.connector} was in flight, so another entry may have `
    + `posted to this document at the same time (outcome=${outcome}). Check the accounting connector `
    + `for a duplicate settlement.`
  const metadata = {
    connector: params.connector,
    type: params.type,
    referenceType: params.referenceType,
    referenceId: params.referenceId,
    documentKey: settlementDocumentKey(params.type, params.payload),
    entryId: params.entryId,
    outcome,
    externalId: externalId ?? null,
  }
  console.error(
    `[money-post] EXCLUSION LOST during the post — the advisory lock's connection died while the call `
    + `was in flight, so another entry may have posted to this document at the same time. `
    + `connector=${params.connector} type=${params.type} scope=${params.referenceType}:${params.referenceId} `
    + `entry=${params.entryId} outcome=${outcome}. Check the accounting connector for a duplicate settlement.`,
  )
  let persisted = false
  try {
    const { logActivityPersisted } = await import('@/lib/activity-log')
    const entry = {
      entityType: 'SYNC' as const,
      entityId: params.entryId,
      action: 'money_post_exclusion_lost',
      tag: 'accounting',
      level: 'ERROR' as const,
      description,
      // No session to resolve on a connector worker, and resolving one would be the only part of
      // this call that can be slow on a path that has just moved money.
      resolveUser: false,
      metadata,
    }
    persisted = await logActivityPersisted(entry)
    if (!persisted) persisted = await logActivityPersisted(entry)
  } catch (error) {
    // `logActivityPersisted` does not throw, so this is the module failing to import at all. The
    // console line above is still out; an activity-log failure must not be the thing that turns a
    // committed payment into an exception.
    console.error('[money-post] could not record the lost-exclusion incident:', error)
  }
  if (!persisted) {
    // NOT the same line as the one above, and not a duplicate of it: that one says a payment went
    // out unprotected, this one says the only durable record of it does not exist. An operator
    // reading IMS's own history will find nothing about this payment, so the log stream is now the
    // sole copy and it has to carry the whole incident rather than a pointer to it.
    console.error(
      '[money-post] INCIDENT NOT PERSISTED — the lost-exclusion record could not be written to the '
      + 'activity log, so IMS holds no durable trace of this unprotected money post. Incident: '
      + JSON.stringify(metadata),
    )
  }
  return { persisted }
}

/**
 * o3d-0m56 round 4, Codex CRITICAL #2 — THE ONLY WAY A MONEY POST SHOULD BE SPELT.
 *
 * `authoriseMoneyPost` answers "is this document already settled?" and the caller then posts. On
 * its own that is a decision and a write with a network round trip between them, and nothing
 * serialized them against a competing row for the same document: two rows could each probe, each
 * see nothing, and each post. The read was in the right place and still left the window it was
 * invented to close.
 *
 * This wrapper puts the stamp, the sibling read, the probe AND the post inside one per-document
 * lock, so the whole sequence is indivisible to any other worker. The post is a callback rather
 * than something the caller runs afterwards precisely so that it CANNOT be left outside: there is
 * no shape of this API in which a caller acquires protection and then posts without it.
 *
 * A caller that cannot take the lock does not wait — see money-post-lock.ts. It returns a normal
 * retryable failure, which is the same shape as a remote rejection, so the row is re-attempted
 * later and re-probes then, by which time the holder's payment is readable.
 *
 * `lock` is injectable so the fence is testable without PostgreSQL; nothing in production passes
 * it.
 */
export async function postMoneyUnderLedgerFence(
  params: MoneyPostFenceParams & { lock?: MoneyPostLock },
  post: () => Promise<MoneyPostOutcome>,
): Promise<MoneyPostOutcome> {
  const { isMoneyMovingSyncType } = await import('@/lib/domain/accounting/followup-retry-guard')
  // Non-money types take neither the lock nor the fence, exactly as before: the ordinary queue
  // traffic must not queue behind a payment.
  if (!isMoneyMovingSyncType(params.type)) return post()

  const lock = params.lock
    ?? (await import('@/lib/domain/accounting/money-post-lock')).withMoneyPostLock
  // THE DOCUMENT, not the scope (round 6, Codex CRITICAL #2). `referenceType`/`referenceId` are
  // carried for the incident report, but the key the exclusion is taken on is the external
  // document this post will settle — see money-post-document.ts.
  const outcome = await lock({
    connector: params.connector,
    type: params.type,
    referenceType: params.referenceType,
    referenceId: params.referenceId,
    documentKey: settlementDocumentKey(params.type, params.payload),
  }, async (held): Promise<MoneyPostOutcome> => {
    const authorised = await authoriseMoneyPost(params)
    if (!authorised.proceed) return { success: false, error: authorised.error }
    // THE LAST THING CHECKED BEFORE THE CALL. PostgreSQL frees a session advisory lock the instant
    // its connection dies, so a pinned connection that failed during the ledger read means the
    // exclusion this verdict was taken under is already gone and another worker may be posting to
    // this document now. Throwing here is correct — the reading is void, not merely stale.
    held.assertHeld('posting money to the accounting connector')
    let outcome: MoneyPostOutcome
    try {
      outcome = await post()
    } catch (error) {
      if (!held.lost) throw error
      const incident = await reportLostMoneyPostExclusion(params, 'threw')
      // THE THROWN PATH HAS THE SAME DURABLE FALLBACK AS THE FAILED ONE (round 8, Codex MEDIUM #2).
      // A throw here is a post of UNKNOWN outcome made without its exclusion, and both processors
      // record `String(e)` as the row's `errorMessage` — so the thrown text is written to the sync
      // row exactly as a failed post's error text is, and is the same last-resort place to put the
      // incident when the activity log could not take it. Round 7 added that fallback to the failed
      // branch and left this one rethrowing the bare error, which discards it: the activity write
      // had already failed, the stderr line is a stream, and the row then said only "socket hang
      // up" about a call that may have moved money unprotected.
      //
      // The connector's own words come FIRST and unaltered, and the original is kept as `cause`:
      // the retry classification both processors run (`isRateLimitError`) reads this text, and it
      // must still recognise a 429 that happened to lose the lock.
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} — Not sent safely: the money-post `
        + 'lock for this document was lost while IMS was posting to the accounting connector, so '
        + 'another entry may have posted at the same time and this call\'s outcome is unknown. Check '
        + 'the ledger for a duplicate before retrying.'
        + (incident.persisted
          ? ''
          : ' IMS could also not record this incident in the activity log, so this message is the '
            + 'only durable record of it.'),
        { cause: error },
      )
    }
    if (!held.lost) return outcome
    // THE ASSERTION ABOVE CANNOT COVER THE CALL ITSELF (Codex round 5, finding 2). The connection
    // can die after it and while the HTTP request is in flight, and no amount of re-checking makes
    // a check-then-act atomic against a remote system. So the residual is not argued away, it is
    // made DETECTABLE — asked once the call has returned, when the answer is finally knowable —
    // and RECOVERABLE, which it already is by construction:
    //
    //   - the payment carries IMS's mark (Xero `Reference`, QuickBooks `PrivateNote`), so a later
    //     probe finds it whoever posted it and whatever has since been done to its amount or date;
    //   - `remoteAttemptedAt` was stamped before the call, so no later row treats this scope as
    //     virgin, and every subsequent post re-probes under a FRESH lock — there is no path from
    //     here to a second post on this reading;
    //   - a successful outcome keeps its `externalId`, because that is the handle a reversal needs.
    //     Discarding it to report a failure would hide a real payment and buy nothing.
    //
    // What is irreducible: if another worker took the freed lock and posted in the same window,
    // the document really is paid twice. That is now announced at the moment it becomes possible,
    // by the process that did it, naming the document — not discovered at reconciliation.
    const incident = await reportLostMoneyPostExclusion(params, outcome.success ? 'committed' : 'failed', outcome.externalId)
    if (outcome.success) return outcome
    return {
      success: false,
      error: 'Not sent safely: the money-post lock for this document was lost while IMS was posting to '
        + 'the accounting connector, so another entry may have posted at the same time. '
        + `The connector reported: ${outcome.error ?? 'no error'}. Check the ledger for a duplicate `
        + 'before retrying.'
        // The DURABLE fallback for this branch (round 7, Codex MEDIUM #3). A failed post's error
        // message IS written to the sync row and survives, so when the activity-log record could
        // not be written the incident still reaches an operator through the row itself — which is
        // the only place left once the activity log is unavailable.
        + (incident.persisted
          ? ''
          : ' IMS could also not record this incident in the activity log, so this message is the '
            + 'only durable record of it.'),
    }
  })
  if (!outcome.locked) {
    return {
      success: false,
      error: 'Not sent: another entry for this document is posting to the accounting connector right '
        + 'now. This entry will retry once that attempt is readable in the ledger.',
    }
  }
  return outcome.result
}
