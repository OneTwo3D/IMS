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
    Payments?: Array<{ PaymentID?: string; Date?: string; Amount?: number; Reference?: string }>
  }>
}
type XeroCreditNoteResponse = {
  CreditNotes?: Array<{
    CreditNoteID?: string
    Allocations?: Array<{ Amount?: number; Date?: string; Invoice?: { InvoiceID?: string } }>
  }>
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
    // Only allocations against THIS bill: the same credit note legitimately offsets others.
    const records: LedgerSettlementRecord[] = (note.Allocations ?? [])
      .filter((a) => str(a.Invoice?.InvoiceID).toLowerCase() === invoiceId.toLowerCase())
      // No reference field exists on a Xero credit-note allocation, so this type has no mark to
      // match and falls back to amount and date alone. Stated rather than left to be inferred from
      // a missing property.
      .map((a) => ({ amount: num(a.Amount), date: normaliseXeroSettlementDate(a.Date), reference: null }))
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
 * Links that take money off the document by some means IMS does not post, and links that take no
 * money off it at all. Both are ignored; they are listed together because what matters here is
 * only "recognised", and split by comment so the coverage statement stays honest.
 *
 * OUT OF COVERAGE, DELIBERATELY: the settlements in the first group are not the shape any IMS
 * attempt creates, so none of them can BE the attempt this probe is asked about. They are not
 * treated as evidence for or against it. The residual is stated rather than closed: a human who
 * settles a bill with a vendor credit or a journal entry instead of a bill payment is invisible
 * to this probe, and the document's own balance check below is what notices that something has
 * happened that no link explains.
 */
const QBO_KNOWN_OTHER_LINK_TYPES: ReadonlySet<string> = new Set([
  // Settle the document, by a shape IMS never posts.
  'CreditMemo', 'VendorCredit', 'Deposit', 'JournalEntry', 'Refund', 'RefundReceipt',
  'Check', 'Expense', 'Purchase', 'Transfer', 'CreditCardCredit', 'CreditCardPayment',
  // The other document kind's payment link, seen on a document it does not settle.
  'Payment', 'BillPayment', 'BillPaymentCheck', 'BillPaymentCreditCard',
  // Carry no money off the document at all: what it was raised FROM, and what was billed ONTO it.
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
  const unclassified = [...new Set(links.map((t) => str(t.TxnType)).filter(
    (type) => type !== '' && !paymentLinkTypes.has(type) && !QBO_KNOWN_OTHER_LINK_TYPES.has(type),
  ))]
  if (unclassified.length > 0) {
    return {
      ok: false,
      reason: `QuickBooks linked ${unclassified.join(', ')} to this ${documentKey.toLowerCase()} and this `
        + 'probe cannot tell whether that settles it',
    }
  }

  const settlementIds = links
    .filter((t) => paymentLinkTypes.has(str(t.TxnType)))
    .map((t) => str(t.TxnId))
    .filter(Boolean)

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

  // THE SHAPE-INDEPENDENT BACKSTOP. Everything above depends on a list of type names being right,
  // and the bug this replaces was a list of type names being wrong. `TotalAmt` and `Balance` are
  // not names — they are the document's own account of how much of it has been settled, by any
  // means whatsoever. When money has come off this document and NOTHING is linked to it, no list
  // could have found what did that, so the probe must not report a picture it knows is short.
  //
  // Deliberately narrow: it fires only when there is no link at all to account for the movement.
  // A credit memo, a vendor credit or a journal entry DOES appear as a link, is recognised above,
  // and legitimately explains a reduced balance on a document IMS still has a payment to make
  // against — refusing those would make every partially-credited document permanently unpayable
  // through IMS, which is a self-inflicted outage rather than a safety property.
  const total = num(body.TotalAmt)
  const balance = num(body.Balance)
  if (total !== null && balance !== null && total - balance > QBO_AMOUNT_EPSILON && links.length === 0) {
    return {
      ok: false,
      reason: `QuickBooks reports ${(total - balance).toFixed(2)} already applied to this `
        + `${documentKey.toLowerCase()} but links no transaction that accounts for it`,
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
 * Includes the TYPE because the two connectors read a bill and an invoice from different endpoints.
 */
export function settlementProbeKey(target: SettlementProbeTarget): string {
  const payload = asRecord(target.payload)
  return [target.type, str(payload.accountingInvoiceId), str(payload.creditNoteId)].join(' ')
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
  const verdict = classifyLedgerSettlement(describeAttempt(params.payload, marker), probe)
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
  /** Injected so the guard is testable without a database. */
  db: {
    accountingSyncLog: {
      updateMany: (args: { where: { id: string; remoteAttemptedAt: null }; data: { remoteAttemptedAt: Date } }) => Promise<{ count: number }>
      findMany: (args: {
        where: {
          connector: string
          type: AccountingSyncType
          referenceType: string
          referenceId: string
          remoteAttemptedAt: { not: null }
          id: { not: string }
        }
        select: { id: true; payload: true }
      }) => Promise<Array<{ id: string; payload: unknown }>>
    }
  }
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
  const claimed = await params.db.accountingSyncLog.updateMany({
    where: { id: params.entryId, remoteAttemptedAt: null },
    data: { remoteAttemptedAt: (params.now ?? (() => new Date()))() },
  })
  // This ROW may be new — but the DOCUMENT may not be (Codex round 3). A receipt recorded beside an
  // older failed attempt queues a brand-new row, and that row's first post would otherwise go out on
  // the strength of a reading taken before it was even created. So: every OTHER row in this scope
  // that has ever been sent, whatever became of it.
  //
  // Fetched even when this row is a repeat, because a rival attempt is a hazard to it too, and it
  // is one indexed read on a path that is about to make a network call anyway.
  const attemptedSiblings = await params.db.accountingSyncLog.findMany({
    where: {
      connector: params.connector,
      type: params.type as AccountingSyncType,
      referenceType: params.referenceType,
      referenceId: params.referenceId,
      remoteAttemptedAt: { not: null },
      id: { not: params.entryId },
    },
    select: { id: true, payload: true },
  })
  const { classifyLedgerSettlement, describeAttempt, settlementMarkerFor } = await import('@/lib/domain/accounting/ledger-settlement-evidence')
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
    .filter((row) => attemptCouldBeTheSameDocument(row.payload, params.payload))

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
   * The one place `unknown` does not refuse, stated plainly rather than left to be discovered:
   * when the unknown is `attempt-undescribable` — our own payload does not pin an amount and a
   * date. That is a fact about this row, not about the ledger; the processors default a missing
   * date to the day they run, so such a row can never be described. Refusing on it would make
   * every payment enqueued without a pinned date permanently unsendable while telling us nothing
   * about whether the document is settled. Both LEDGER unknowns — the probe could not answer, or
   * it returned a settlement it could not measure — still refuse.
   */
  if (contenders.length === 0) {
    const marker = settlementMarkerFor(effectiveTokenFor(params.connector, { id: params.entryId, payload: params.payload }))
    const verdict = classifyLedgerSettlement(describeAttempt(params.payload, marker), probe)
    if (verdict.outcome === 'present') {
      return {
        proceed: false,
        error: `Not sent: the accounting connector already holds a settlement of ${verdict.detail} against `
          + 'this document, and IMS has never sent one for it — so it was recorded outside IMS. '
          + 'Sending this would pay it twice. Check the ledger and resolve this entry by hand.',
      }
    }
    if (verdict.outcome === 'unknown' && verdict.cause !== 'attempt-undescribable') {
      return {
        proceed: false,
        error: `Not sent: IMS could not establish what the accounting connector already holds against `
          + `this document (${verdict.reason}). Posting on a reading that failed could pay it twice.`,
      }
    }
    return { proceed: true }
  }

  for (const contender of contenders) {
    const marker = settlementMarkerFor(effectiveTokenFor(params.connector, contender))
    const verdict = classifyLedgerSettlement(describeAttempt(contender.payload, marker), probe)
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
  const outcome = await lock({
    connector: params.connector,
    type: params.type,
    referenceType: params.referenceType,
    referenceId: params.referenceId,
  }, async (held): Promise<MoneyPostOutcome> => {
    const authorised = await authoriseMoneyPost(params)
    if (!authorised.proceed) return { success: false, error: authorised.error }
    // THE LAST THING CHECKED BEFORE THE CALL. PostgreSQL frees a session advisory lock the instant
    // its connection dies, so a pinned connection that failed during the ledger read means the
    // exclusion this verdict was taken under is already gone and another worker may be posting to
    // this document now. Throwing here is correct — the reading is void, not merely stale.
    held.assertHeld('posting money to the accounting connector')
    return post()
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
