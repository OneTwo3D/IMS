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
  return { ok: true, records }
}

type QboLinkedTxn = { TxnId?: string; TxnType?: string }
type QboPaymentLine = { Amount?: number; LinkedTxn?: QboLinkedTxn[] }

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
  const settlementType = isBill ? 'BillPayment' : 'Payment'
  const settlementPath = isBill ? 'billpayment' : 'payment'
  const linkedType = isBill ? 'Bill' : 'Invoice'

  const doc = await qboGet<Record<string, { LinkedTxn?: QboLinkedTxn[] } | undefined>>(
    `${documentPath}/${encodeURIComponent(documentId)}`,
  )
  if (!doc.ok) return { ok: false, reason: doc.error ?? `HTTP ${doc.status}` }
  const body = doc.data?.[documentKey]
  if (!body) return { ok: false, reason: `QuickBooks returned no ${documentKey.toLowerCase()} for that id` }

  const settlementIds = (body.LinkedTxn ?? [])
    .filter((t) => str(t.TxnType) === settlementType)
    .map((t) => str(t.TxnId))
    .filter(Boolean)

  const records: LedgerSettlementRecord[] = []
  for (const id of settlementIds) {
    const res = await qboGet<Record<string, { TxnDate?: string; PrivateNote?: string; Line?: QboPaymentLine[] } | undefined>>(
      `${settlementPath}/${encodeURIComponent(id)}`,
    )
    // A settlement we know EXISTS but cannot read is the most dangerous shape of all: dropping it
    // would leave a clear verdict built from an incomplete list.
    if (!res.ok) return { ok: false, reason: `could not read ${settlementType} ${id}: ${res.error ?? `HTTP ${res.status}`}` }
    const settlement = res.data?.[settlementType]
    if (!settlement) return { ok: false, reason: `QuickBooks returned no ${settlementType} ${id}` }
    const date = str(settlement.TxnDate)
    records.push({
      amount: qboAmountAppliedTo(settlement.Line, documentId, linkedType),
      date: date.length >= 10 ? date.slice(0, 10) : null,
      id,
      // PrivateNote is where IMS writes its mark on this connector.
      reference: str(settlement.PrivateNote) || null,
    })
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
 * been sent before?". A first attempt against a document nothing else has been sent to is free;
 * everything else pays for a GET.
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
export async function authoriseMoneyPost(params: {
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
}): Promise<{ proceed: true } | { proceed: false; error: string }> {
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
  // A first attempt from a row whose document nothing has ever been sent to cannot duplicate
  // anything. That is the only free pass, and it is the common case.
  if (claimed.count > 0 && attemptedSiblings.length === 0) return { proceed: true }

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

  // Nothing that could have settled this document has ever been sent, or been sendable at all, so
  // there is nothing for a ledger read to rule out. Skipped rather than taken and ignored: it is a
  // network call on the money path, and it must not be spent to reach a foregone conclusion.
  if (contenders.length === 0) return { proceed: true }

  const probe = await probeLedgerSettlement(params.connector, { type: params.type, payload: params.payload })

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
