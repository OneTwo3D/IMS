/**
 * THE XERO RATE SOURCE (R16): every invoice, bill, credit note and payment of a date window, each resource read as a PROVEN list.
 *
 * It stands on the same GET-only port as R12 (xero-source.ts XeroGetPort; the real one is xero-transport.ts, which refuses every request
 * that is not a GET to Organisation, Invoices, CreditNotes or Payments with the listed parameters). This module decides what a read PROVES.
 * A resource's list is returned only when ALL of the following hold; any other state is a closed reason and NO list at all (a partial list is
 * never handed to the comparison, and the item is then inconclusive, never a pass):
 *
 *   - the document lists ask for every status Xero gives a document, and a row whose status is not one of those six is SOURCE_UNREADABLE (a
 *     status filter that left a status out would hide its rows from every pagination check, so none is left out);
 *   - every response is HTTP 200 with a JSON object body carrying Xero's own `pagination` object (page, pageSize, pageCount, itemCount), all
 *     plain whole numbers; no page size is sent and none is assumed (the size Xero reports is what the page lengths are checked against);
 *   - the item count is not above the walk cap (CAP_EXCEEDED), the page count is exactly ceil(itemCount / pageSize) (a zero count may report 0
 *     or 1 page), every page reports the page asked for and the same size, count and page count as the first, every page but the last holds
 *     exactly pageSize rows and the last holds the remainder, no identifier repeats, and the rows read are exactly as many as the item count;
 *   - every row has the identity of its resource and the type it was asked for, and its date lies inside the window that was asked for: a row
 *     that is not what the request asked for is SOURCE_UNREADABLE (the whole read), never dropped;
 *   - the whole walk is then read AGAIN and the two reads are equal row for row (a proven double scan).
 *
 * WHAT A ROW IS ALLOWED TO BE UNREADABLE ABOUT. A row whose identity and place in the window are proven but whose date, currency or CurrencyRate
 * cannot be used is NOT a reason to withhold the list: it is kept as an unreadable document (`readable: false`) and the item reports it as a
 * finding (DOCUMENT_UNREADABLE). Nothing is repaired or defaulted: a foreign document with no CurrencyRate is unreadable, never a rate of 1.
 *
 * The run's request budget is the walker's (R16_XERO_REQUEST_BUDGET: exhausting it is CAP_EXCEEDED, never a shorter list) and a pause separates
 * requests. No response body, URL, header or message is kept: what comes out is the validated rows or a closed reason.
 *
 * LIMITS, stated: the item count is Xero's own claim and there is no second source for it (the proof is internal consistency plus the double
 * read); the `where` syntax on Date and the payment list's paging are unverified against the live service (a service that ignores the filter is
 * unreadable because every row is checked against the window, but one that wrongly EXCLUDES documents while reporting a consistent count is not
 * detectable here); a payment's currency is the currency of the invoice or credit note it is applied to (Xero's payment has none of its own).
 */

import { Prisma } from '@/app/generated/prisma/client'
import { R16_XERO_CHECKED_STATUSES, R16_XERO_DOCUMENT_STATUSES, R16_XERO_SET_ASIDE_STATUSES, isKnownCurrency, type PackReasonCode, type XeroResource } from '@/lib/reconciliation-pack/constants'
import { XERO_MAX_PAGE_SIZE } from '@/lib/reconciliation-pack/constants'
import { DATE_RE, Stop, UUID_RE, decimalOf, reasonOf, record, request, validDate, wholeNumber, type Walker, type XeroWalkWindow } from '@/lib/reconciliation-pack/xero-source'

/** The five kinds of thing R16 checks, as the words that appear in an identity (each is a plain token that passes the identity screen). */
export const XERO_RATE_KINDS = ['sales-invoice', 'purchase-bill', 'sales-cn', 'purchase-cn', 'payment'] as const
export type XeroRateKind = (typeof XERO_RATE_KINDS)[number]

export type XeroRateDocument =
  | { readable: true; kind: XeroRateKind; id: string; date: string; currency: string; /** Xero's CurrencyRate as plain decimal text (1 document-currency = X base), or null when Xero recorded none. A document in the base currency is set aside by the item whatever this is; a foreign one with none is unreadable there. */ rate: string | null }
  | { readable: false; kind: XeroRateKind; id: string; /** The date, when it could be read (the item cuts the periods by it); null when it could not. */ date: string | null }

export type XeroRateRead = {
  documents: XeroRateDocument[]
  /** Rows read per resource list (invoices and bills together, credit notes, payments), as Xero reported them. */
  totals: { invoices: number; creditNotes: number; payments: number }
  /** Payments Xero lists as DELETED: read, counted in the total, and set aside (a deleted payment books nothing). */
  deletedPayments: number
  /** Invoices, bills and credit notes Xero lists as VOIDED or DELETED: read, counted in the totals, and set aside as out of scope (reversed or removed, they book nothing). */
  setAsideDocuments: number
}

const DATE_STRING_RE = /^([0-9]{4}-[0-9]{2}-[0-9]{2})T00:00:00$/

type Spec = {
  resource: XeroResource
  listKey: 'Invoices' | 'CreditNotes' | 'Payments'
  /** Extra parameters besides the where and the page. */
  statuses: string | null
  parse: (raw: unknown, window: XeroWalkWindow) => { document: XeroRateDocument; deleted: boolean }
}

/** Xero's `where` text for the rows dated in [from, toExclusive), of any type. The transport's gate accepts exactly this shape for these resources. */
export function xeroDateWhere(window: XeroWalkWindow): string {
  const part = (date: string) => { const m = DATE_RE.exec(date)!; return `DateTime(${Number(m[1])}, ${Number(m[2])}, ${Number(m[3])})` }
  return `Date>=${part(window.from)} AND Date<${part(window.toExclusive)}`
}

function dateOf(value: unknown): string | null {
  const m = typeof value === 'string' ? DATE_STRING_RE.exec(value) : null
  return m && validDate(m[1]!) ? m[1]! : null
}

/** The currency and rate of a document; null when either is present and unusable (an unknown currency code, a rate that is not a positive plain decimal of at most twelve places). An absent rate is carried as null: whether it matters depends on the base currency, which only the item knows. */
function judge(currencyRaw: unknown, rateRaw: unknown): { currency: string; rate: string | null } | null {
  if (!isKnownCurrency(currencyRaw)) return null
  let rate: string | null = null
  if (rateRaw !== undefined && rateRaw !== null) {
    try { rate = decimalOf(rateRaw, 12) } catch { return null }
    if (!new Prisma.Decimal(rate).gt(0)) return null
  }
  return { currency: currencyRaw, rate }
}

function identity(raw: Record<string, unknown>, key: string): string {
  const id = raw[key]
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw new Stop('SOURCE_UNREADABLE')
  return id.toLowerCase()
}

function inWindow(date: string, window: XeroWalkWindow): void {
  // The request was for this window; a row outside it is a service that did not do what was asked.
  if (date < window.from || date >= window.toExclusive) throw new Stop('SOURCE_UNREADABLE')
}

function documentSpec(resource: 'Invoices' | 'CreditNotes'): Spec {
  const kinds: Record<string, XeroRateKind> = resource === 'Invoices' ? { ACCREC: 'sales-invoice', ACCPAY: 'purchase-bill' } : { ACCRECCREDIT: 'sales-cn', ACCPAYCREDIT: 'purchase-cn' }
  return {
    resource,
    listKey: resource,
    statuses: R16_XERO_DOCUMENT_STATUSES.join(','),
    parse(rawRow, window) {
      const r = record(rawRow)
      const id = identity(r, resource === 'Invoices' ? 'InvoiceID' : 'CreditNoteID')
      if (typeof r.Type !== 'string' || !Object.prototype.hasOwnProperty.call(kinds, r.Type)) throw new Stop('SOURCE_UNREADABLE')
      const kind = kinds[r.Type]!
      // EVERY status is read. A live one is checked; a voided or deleted one is read, counted and set aside (out of scope, it books nothing); a
      // status that is neither (one this code does not know) is a service that is not what was understood, so the whole read is closed.
      if (typeof r.Status !== 'string') throw new Stop('SOURCE_UNREADABLE')
      if ((R16_XERO_SET_ASIDE_STATUSES as readonly string[]).includes(r.Status)) return { document: { readable: false, kind, id, date: null }, deleted: true }
      if (!(R16_XERO_CHECKED_STATUSES as readonly string[]).includes(r.Status)) throw new Stop('SOURCE_UNREADABLE')
      const date = dateOf(r.DateString)
      // A row whose date cannot be read has no place in the window to prove: it is the one unreadable document, not a reason to drop the list.
      if (date === null) return { document: { readable: false, kind, id, date: null }, deleted: false }
      inWindow(date, window)
      const judged = judge(r.CurrencyCode, r.CurrencyRate)
      return { document: judged === null ? { readable: false, kind, id, date } : { readable: true, kind, id, date, ...judged }, deleted: false }
    },
  }
}

const PAYMENT_SPEC: Spec = {
  resource: 'Payments',
  listKey: 'Payments',
  statuses: null,
  parse(rawRow, window) {
    const r = record(rawRow)
    const id = identity(r, 'PaymentID')
    if (r.Status === 'DELETED') return { document: { readable: false, kind: 'payment', id, date: null }, deleted: true }
    if (r.Status !== 'AUTHORISED') throw new Stop('SOURCE_UNREADABLE')
    const date = dateOf(r.DateString)
    if (date === null) return { document: { readable: false, kind: 'payment', id, date: null }, deleted: false }
    inWindow(date, window)
    // A payment has no currency of its own: it is the currency of the document it settles (an invoice, a credit note, a prepayment or an overpayment).
    const holders = ['Invoice', 'CreditNote', 'Prepayment', 'Overpayment'].map((name) => r[name]).filter((value) => value !== undefined && value !== null)
    const currency = holders.length === 1 && typeof holders[0] === 'object' && !Array.isArray(holders[0]) ? (holders[0] as Record<string, unknown>).CurrencyCode : undefined
    const judged = judge(currency, r.CurrencyRate)
    return { document: judged === null ? { readable: false, kind: 'payment', id, date } : { readable: true, kind: 'payment', id, date, ...judged }, deleted: false }
  },
}

async function walkOnce(w: Walker, spec: Spec, window: XeroWalkWindow): Promise<{ documents: XeroRateDocument[]; deleted: number; total: number }> {
  const documents: XeroRateDocument[] = []
  const seen = new Set<string>()
  let deleted = 0
  let pageSize = -1
  let pageCount = -1
  let total = -1
  for (let page = 1; ; page += 1) {
    const params: Record<string, string> = { where: xeroDateWhere(window), page: String(page) }
    if (spec.statuses !== null) params.Statuses = spec.statuses
    const body = await request(w, spec.resource, params)
    const pagination = record(body.pagination)
    const reportedPage = wholeNumber(pagination.page, 1, 1_000_000)
    const size = wholeNumber(pagination.pageSize, 1, XERO_MAX_PAGE_SIZE)
    const count = wholeNumber(pagination.pageCount, 0, 1_000_000)
    const items = wholeNumber(pagination.itemCount, 0, 100_000_000)
    if (reportedPage !== page) throw new Stop('VENDOR_READ_UNSTABLE')
    const list = body[spec.listKey]
    if (!Array.isArray(list)) throw new Stop('SOURCE_UNREADABLE')
    if (page === 1) {
      if (items > w.maxRows) throw new Stop('CAP_EXCEEDED')
      const expected = Math.ceil(items / size)
      if (count !== expected && !(items === 0 && count <= 1)) throw new Stop('VENDOR_READ_UNSTABLE')
      pageSize = size
      pageCount = count
      total = items
    } else if (size !== pageSize || count !== pageCount || items !== total) {
      throw new Stop('VENDOR_READ_UNSTABLE')
    }
    const expectedLength = total === 0 ? 0 : page < pageCount ? pageSize : total - pageSize * (pageCount - 1)
    if (list.length !== expectedLength) throw new Stop('VENDOR_READ_UNSTABLE')
    for (const raw of list) {
      const parsed = spec.parse(raw, window)
      if (seen.has(parsed.document.id)) throw new Stop('VENDOR_READ_UNSTABLE')
      seen.add(parsed.document.id)
      if (parsed.deleted) deleted += 1
      else documents.push(parsed.document)
    }
    if (total === 0 || page >= pageCount) break
  }
  if (documents.length + deleted !== total) throw new Stop('VENDOR_READ_UNSTABLE')
  return { documents, deleted, total }
}

const canonical = (rows: readonly XeroRateDocument[]): string[] => rows.map((row) => JSON.stringify(row)).sort()

/** One resource: a DOUBLE SCAN. The second scan starts only after the first finished and the two must be equal row for row. */
async function walkProven(w: Walker, spec: Spec, window: XeroWalkWindow): Promise<{ documents: XeroRateDocument[]; deleted: number; total: number }> {
  const first = await walkOnce(w, spec, window)
  const second = await walkOnce(w, spec, window)
  const a = canonical(first.documents)
  const b = canonical(second.documents)
  if (first.total !== second.total || first.deleted !== second.deleted || a.length !== b.length || a.some((entry, index) => entry !== b[index])) throw new Stop('VENDOR_READ_UNSTABLE')
  return first
}

/**
 * Every invoice, bill and credit note of EVERY status (DRAFT, SUBMITTED, AUTHORISED and PAID are checked; VOIDED and DELETED are counted and set aside) and every payment dated in [window.from, window.toExclusive),
 * each list proven as above. Any resource that cannot be proven makes the whole read a closed reason: the rate check never judges a part of Xero.
 */
export async function readXeroRateDocuments(w: Walker, window: XeroWalkWindow): Promise<{ ok: true; value: XeroRateRead } | { ok: false; reason: PackReasonCode }> {
  try {
    if (!validDate(window.from) || !validDate(window.toExclusive) || window.from >= window.toExclusive) return { ok: false, reason: 'BAD_MODE' }
    const invoices = await walkProven(w, documentSpec('Invoices'), window)
    const creditNotes = await walkProven(w, documentSpec('CreditNotes'), window)
    const payments = await walkProven(w, PAYMENT_SPEC, window)
    const documents = [...invoices.documents, ...creditNotes.documents, ...payments.documents]
    // One identity is one document: a repeat across the three lists (different resources never share an id) is a service that is not consistent.
    if (new Set(documents.map((d) => d.id)).size !== documents.length) return { ok: false, reason: 'VENDOR_READ_UNSTABLE' }
    return { ok: true, value: { documents, totals: { invoices: invoices.total, creditNotes: creditNotes.total, payments: payments.total }, deletedPayments: payments.deleted, setAsideDocuments: invoices.deleted + creditNotes.deleted } }
  } catch (error) {
    return { ok: false, reason: reasonOf(error) }
  }
}
