/**
 * THE XERO SOURCE (R12): the organisation's base currency and the sales invoices of a date window, each read as a PROVEN list.
 *
 * Everything here stands on ONE port, `XeroGetPort.get(resource, params)`, which can only ask for a page of two read-only resources
 * (the real one is lib/reconciliation-pack/xero-transport.ts: GET only, through the connector fetch seam, never refreshing a token).
 * This module decides what a read PROVES. A list is returned only when ALL of the following hold; any other state is a closed reason
 * and NO list at all (a partial list is never handed to a comparison):
 *
 *   - every response is HTTP 200 with a JSON object body; the invoice list carries Xero's own `pagination` object (page, pageSize,
 *     pageCount, itemCount), all plain whole numbers (U7: the PAGE SIZE IS NOT ASSUMED - none is sent and none is taken as known; the
 *     size Xero reports is what the page lengths are checked against). A response without it proves nothing and is SOURCE_UNREADABLE;
 *   - the item count is not above the walk cap (CAP_EXCEEDED), the page count is exactly ceil(itemCount / pageSize) (a zero count may
 *     report 0 or 1 page), every page reports the page asked for and the same size, count and page count as the first, every page but
 *     the last holds exactly pageSize invoices and the last holds the remainder, no invoice repeats, and the invoices read are exactly
 *     as many as the item count Xero reported;
 *   - every invoice is validated (type, status, date inside the window that was asked for, currency, rate, lines, tax types, amounts):
 *     an invoice that is not what the request asked for is SOURCE_UNREADABLE - no row is dropped or repaired;
 *   - the whole walk is then read AGAIN and the two reads are equal invoice for invoice (a proven double scan).
 *
 * The run has a hard request budget (XERO_REQUEST_BUDGET: exhausting it is CAP_EXCEEDED, never a shorter list) and a pause between
 * requests (XERO_MIN_REQUEST_INTERVAL_MS). No response body, URL, header or message is kept: what comes out is the validated rows
 * or a closed reason.
 *
 * TRUST BOUNDARY, stated: R12 trusts that Xero's API returns an invoice's own line items. Omitted lines are caught when the tax or the amounts
 * of the invoice stop adding up to its totals; a response that omits lines whose tax AND amounts both net to zero is undetectable from one
 * invoice response (the API gives no independent line count).
 *
 * LIMITS, stated: the item count is Xero's own claim; there is no second source for it (U7 open: not compared with Xero's screens), so
 * the proof is internal consistency plus the double read. The `where` syntax and the `Statuses` filter are unverified against the
 * live service; the window is asked for widened by a day each side and every row is checked against the filter that was sent, so a
 * service that ignores it is unreadable, but a service that wrongly EXCLUDES invoices while reporting a consistent count is not
 * detectable here.
 */

import { Prisma } from '@/app/generated/prisma/client'
import {
  R12_XERO_INVOICE_STATUSES,
  XERO_MAX_PAGE_SIZE,
  XERO_MIN_REQUEST_INTERVAL_MS,
  XERO_REQUEST_BUDGET,
  XERO_WALK_MAX_ROWS,
  isKnownCurrency,
  type PackReasonCode,
  type XeroResource,
} from '@/lib/reconciliation-pack/constants'
import { XERO_TAX_TYPE_RE } from '@/lib/connectors/xero/tax-rate-list'

export type XeroPage = { ok: true; status: number; body: unknown } | { ok: false }

export interface XeroGetPort {
  get(resource: XeroResource, params: Readonly<Record<string, string>>): Promise<XeroPage>
}

export type XeroInvoiceLine = { taxType: string; taxAmount: string; lineAmount: string; accountCode: string | null }
/** `rate` is Xero's CurrencyRate as plain decimal text (Xero's convention, connectors/xero/fx.ts: 1 document-currency = X base, so base = amount times rate; 1 for the base currency). `date` is the invoice date, YYYY-MM-DD. */
export type XeroInvoiceRow = { id: string; date: string; currency: string; rate: string; lines: XeroInvoiceLine[] }

export type XeroSourceOptions = {
  sleep?: (ms: number) => Promise<void>
  budget?: number
  maxRows?: number
}

export type XeroWalkWindow = { from: string; toExclusive: string }

class Stop extends Error {
  constructor(readonly reason: PackReasonCode) { super(reason) }
}

const DATE_RE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/
const DATE_STRING_RE = /^([0-9]{4}-[0-9]{2}-[0-9]{2})T00:00:00$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ACCOUNT_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

type Walker = { port: XeroGetPort; left: number; requests: number; maxRows: number; sleep: (ms: number) => Promise<void> }

export function makeXeroWalker(port: XeroGetPort, options: XeroSourceOptions = {}): Walker {
  return {
    port,
    left: options.budget ?? XERO_REQUEST_BUDGET,
    requests: 0,
    maxRows: options.maxRows ?? XERO_WALK_MAX_ROWS,
    sleep: options.sleep ?? ((ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms) })),
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Stop('SOURCE_UNREADABLE')
  return value as Record<string, unknown>
}

function wholeNumber(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Stop('SOURCE_UNREADABLE')
  return value
}

/** A JSON number as exact decimal text; a number with an exponent form, too many places or too large is BAD_VALUE. */
function decimalOf(value: unknown, places: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) >= 1e12) throw new Stop('BAD_VALUE')
  const text = new Prisma.Decimal(value).toFixed()
  const fraction = text.split('.')[1]
  if (fraction !== undefined && fraction.length > places) throw new Stop('BAD_VALUE')
  return text
}

function validDate(text: string): boolean {
  const m = DATE_RE.exec(text)
  if (!m) return false
  const parsed = new Date(`${text}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text
}

function parseInvoice(raw: unknown, window: XeroWalkWindow): XeroInvoiceRow {
  const r = record(raw)
  if (typeof r.InvoiceID !== 'string' || !UUID_RE.test(r.InvoiceID)) throw new Stop('SOURCE_UNREADABLE')
  if (r.Type !== 'ACCREC') throw new Stop('SOURCE_UNREADABLE')
  if (typeof r.Status !== 'string' || !(R12_XERO_INVOICE_STATUSES as readonly string[]).includes(r.Status)) throw new Stop('SOURCE_UNREADABLE')
  const dateMatch = typeof r.DateString === 'string' ? DATE_STRING_RE.exec(r.DateString) : null
  if (!dateMatch || !validDate(dateMatch[1]!)) throw new Stop('SOURCE_UNREADABLE')
  const date = dateMatch[1]!
  // The request was for this window; an invoice outside it is a service that did not do what was asked.
  if (date < window.from || date >= window.toExclusive) throw new Stop('SOURCE_UNREADABLE')
  if (!isKnownCurrency(r.CurrencyCode)) throw new Stop('CURRENCY_UNKNOWN')
  const currency = r.CurrencyCode
  let rate = '1'
  if (r.CurrencyRate !== undefined && r.CurrencyRate !== null) {
    rate = decimalOf(r.CurrencyRate, 12)
    if (!new Prisma.Decimal(rate).gt(0)) throw new Stop('BAD_VALUE')
  } else if (currency !== 'GBP') {
    // A foreign invoice with no recorded rate cannot be put in GBP by Xero's own figures.
    throw new Stop('CURRENCY_UNKNOWN')
  }
  if (currency === 'GBP' && !new Prisma.Decimal(rate).eq(1)) throw new Stop('BAD_VALUE')
  if (!Array.isArray(r.LineItems) || r.LineItems.length > 2000) throw new Stop('SOURCE_UNREADABLE')
  const lines = r.LineItems.map((entry): XeroInvoiceLine => {
    const line = record(entry)
    if (typeof line.TaxType !== 'string' || !XERO_TAX_TYPE_RE.test(line.TaxType)) throw new Stop('SOURCE_UNREADABLE')
    let accountCode: string | null = null
    if (line.AccountCode !== undefined && line.AccountCode !== null) {
      if (typeof line.AccountCode !== 'string' || !ACCOUNT_CODE_RE.test(line.AccountCode)) throw new Stop('SOURCE_UNREADABLE')
      accountCode = line.AccountCode
    }
    return { taxType: line.TaxType, taxAmount: decimalOf(line.TaxAmount, 6), lineAmount: decimalOf(line.LineAmount, 6), accountCode }
  })
  // THE LINES MUST ADD UP TO WHAT THE INVOICE SAYS. Xero's TotalTax is the sum of the lines' TaxAmount (each a plain 2dp amount), and Total is
  // SubTotal (tax excluded) plus TotalTax, in every LineAmountTypes (Exclusive, Inclusive, NoTax): TaxAmount means the tax inside the line in all
  // three, and NoTax lines carry none. Checked exactly, on ALL the returned lines before any cut or classification; an invoice that is missing a
  // figure or does not add up (lines dropped from the page, a truncated list, an invoice-level adjustment) is unreadable, never a partial figure.
  for (const key of ['TotalTax', 'SubTotal', 'Total'] as const) if (typeof r[key] !== 'number') throw new Stop('SOURCE_UNREADABLE')
  if (r.LineAmountTypes !== 'Exclusive' && r.LineAmountTypes !== 'Inclusive' && r.LineAmountTypes !== 'NoTax') throw new Stop('SOURCE_UNREADABLE')
  const totalTax = new Prisma.Decimal(decimalOf(r.TotalTax, 6))
  const subTotal = new Prisma.Decimal(decimalOf(r.SubTotal, 6))
  const total = new Prisma.Decimal(decimalOf(r.Total, 6))
  const linesTax = lines.reduce((sum, line) => sum.add(line.taxAmount), new Prisma.Decimal(0))
  if (!linesTax.eq(totalTax) || !subTotal.add(totalTax).eq(total)) throw new Stop('SOURCE_UNREADABLE')
  // THE LINE AMOUNTS MUST ADD UP TOO (an independent figure: tax that is hidden by omitting offsetting lines would have to offset in amounts as
  // well). Exact, as Xero stores them (2dp): Exclusive => SubTotal = sum of LineAmount (LineAmount excludes tax); Inclusive => Total = sum of
  // LineAmount (LineAmount includes tax); NoTax => SubTotal = Total = sum of LineAmount. NOT checked: LineAmount against Quantity x UnitAmount
  // less discount - Xero rounds the unit amount, the discount and the product in ways its documentation does not pin to the penny, so it is not
  // an exact test and a tolerance would be a guess.
  const linesAmount = lines.reduce((sum, line) => sum.add(line.lineAmount), new Prisma.Decimal(0))
  const amountsAgree = r.LineAmountTypes === 'Exclusive' ? linesAmount.eq(subTotal) : r.LineAmountTypes === 'Inclusive' ? linesAmount.eq(total) : linesAmount.eq(subTotal) && subTotal.eq(total)
  if (!amountsAgree) throw new Stop('SOURCE_UNREADABLE')
  if (r.LineAmountTypes === 'NoTax' && !totalTax.isZero()) throw new Stop('SOURCE_UNREADABLE')
  return { id: r.InvoiceID.toLowerCase(), date, currency, rate, lines }
}

async function request(w: Walker, resource: XeroResource, params: Readonly<Record<string, string>>): Promise<Record<string, unknown>> {
  if (w.left <= 0) throw new Stop('CAP_EXCEEDED')
  w.left -= 1
  if (w.requests > 0) await w.sleep(XERO_MIN_REQUEST_INTERVAL_MS)
  w.requests += 1
  let response: XeroPage
  try {
    response = await w.port.get(resource, params)
  } catch {
    throw new Stop('SOURCE_UNREADABLE')
  }
  if (typeof response !== 'object' || response === null || response.ok !== true || response.status !== 200) throw new Stop('SOURCE_UNREADABLE')
  return record(response.body)
}

/** Xero's `where` text for the sales invoices dated in [from, toExclusive). The transport's gate accepts exactly this shape and no other. */
export function xeroInvoiceWhere(window: XeroWalkWindow): string {
  const part = (date: string) => { const m = DATE_RE.exec(date)!; return `DateTime(${Number(m[1])}, ${Number(m[2])}, ${Number(m[3])})` }
  return `Type=="ACCREC" AND Date>=${part(window.from)} AND Date<${part(window.toExclusive)}`
}

async function walkInvoicesOnce(w: Walker, window: XeroWalkWindow): Promise<{ rows: XeroInvoiceRow[]; total: number }> {
  const rows: XeroInvoiceRow[] = []
  const seen = new Set<string>()
  let pageSize = -1
  let pageCount = -1
  let total = -1
  for (let page = 1; ; page += 1) {
    const body = await request(w, 'Invoices', { where: xeroInvoiceWhere(window), Statuses: R12_XERO_INVOICE_STATUSES.join(','), page: String(page) })
    const pagination = record(body.pagination)
    const reportedPage = wholeNumber(pagination.page, 1, 1_000_000)
    const size = wholeNumber(pagination.pageSize, 1, XERO_MAX_PAGE_SIZE)
    const count = wholeNumber(pagination.pageCount, 0, 1_000_000)
    const items = wholeNumber(pagination.itemCount, 0, 100_000_000)
    if (reportedPage !== page) throw new Stop('VENDOR_READ_UNSTABLE')
    if (!Array.isArray(body.Invoices)) throw new Stop('SOURCE_UNREADABLE')
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
    if (body.Invoices.length !== expectedLength) throw new Stop('VENDOR_READ_UNSTABLE')
    for (const raw of body.Invoices) {
      const row = parseInvoice(raw, window)
      if (seen.has(row.id)) throw new Stop('VENDOR_READ_UNSTABLE')
      seen.add(row.id)
      rows.push(row)
    }
    if (total === 0 || page >= pageCount) break
  }
  if (rows.length !== total) throw new Stop('VENDOR_READ_UNSTABLE')
  return { rows, total }
}

const canonical = (rows: readonly XeroInvoiceRow[]): string[] => rows.map((row) => JSON.stringify(row)).sort()

function reasonOf(error: unknown): PackReasonCode {
  return error instanceof Stop ? error.reason : 'SOURCE_UNREADABLE'
}

export type XeroInvoicesRead = { invoices: XeroInvoiceRow[]; total: number }

/**
 * Every sales invoice (ACCREC, AUTHORISED or PAID) dated in [window.from, window.toExclusive): a DOUBLE SCAN. The second scan starts only
 * after the first finished and the two must be equal invoice for invoice. The budget is the walker's, shared with the organisation read.
 */
export async function readXeroInvoices(w: Walker, window: XeroWalkWindow): Promise<{ ok: true; value: XeroInvoicesRead } | { ok: false; reason: PackReasonCode }> {
  try {
    if (!validDate(window.from) || !validDate(window.toExclusive) || window.from >= window.toExclusive) return { ok: false, reason: 'BAD_MODE' }
    const first = await walkInvoicesOnce(w, window)
    const second = await walkInvoicesOnce(w, window)
    const a = canonical(first.rows)
    const b = canonical(second.rows)
    if (first.total !== second.total || a.length !== b.length || a.some((entry, index) => entry !== b[index])) throw new Stop('VENDOR_READ_UNSTABLE')
    return { ok: true, value: { invoices: first.rows, total: first.total } }
  } catch (error) {
    return { ok: false, reason: reasonOf(error) }
  }
}

/** The connected organisation's base currency (GET Organisation). Anything but exactly one organisation with a known currency code is unreadable. */
export async function readXeroBaseCurrency(w: Walker): Promise<{ ok: true; value: string } | { ok: false; reason: PackReasonCode }> {
  try {
    const body = await request(w, 'Organisation', {})
    if (!Array.isArray(body.Organisations) || body.Organisations.length !== 1) throw new Stop('SOURCE_UNREADABLE')
    const base = record(body.Organisations[0]).BaseCurrency
    if (!isKnownCurrency(base)) throw new Stop('CURRENCY_UNKNOWN')
    return { ok: true, value: base }
  } catch (error) {
    return { ok: false, reason: reasonOf(error) }
  }
}
