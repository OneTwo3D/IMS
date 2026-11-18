/**
 * Sales quotations (a quote is a DRAFT sales order with `isQuote` set).
 *
 * WHAT A QUOTE IS NOT. It is not a status. A new status ahead of DRAFT would have rippled through every status consumer (the WooCommerce
 * status mapping, the warehouse push sweep, allocation, invoicing, analytics). A quote is a DRAFT, so every rule that already applies to a draft
 * applies to it unchanged:
 *   - it is never pushed to the warehouse (the create pass reads PROCESSING / ALLOCATED only: WMS_CREATE_READY_STATUSES);
 *   - it is never allocated and RESERVES NO STOCK, exactly like a draft (allocateSalesOrder skips a DRAFT under the order lock);
 *   - it is never invoiced (the invoice is queued when a draft is finalised, and a quote cannot be finalised until it is converted);
 *   - it is not mirrored to a storefront (only a storefront-linked order is), and a storefront import never sets the flag.
 *
 * The single place a quote is treated differently from a draft is that it cannot LEAVE the draft state (except to be cancelled) until it has been
 * converted: otherwise a status button could finalise a quotation as an order while the flag still said it was only an offer.
 *
 * Pure: no database, no clock (the caller passes today's date).
 */

/** The Settings key behind the "email quotes to customers" switch. Absent or anything but 'true' is OFF. */
export const SALES_QUOTE_EMAIL_SETTING_KEY = 'sales_quote_email_enabled'
export const SALES_QUOTE_EMAIL_KIND = 'SALES_QUOTE'
export const SALES_QUOTE_EMAIL_REFERENCE_TYPE = 'SalesOrder'
export const SALES_QUOTE_EMAIL_DISABLED_MESSAGE = 'Emailing quotes to customers is switched off (Settings > Documents). Download the quote PDF and send it to the customer directly.'
export const SALES_QUOTE_EMAIL_DISABLED_REASON = 'Not sent: emailing quotes to customers is switched off (Settings > Documents)'

/** The validity the "Save as quote" form pre-fills, in days from today. */
export const DEFAULT_QUOTE_VALIDITY_DAYS = 30
export const QUOTE_OVERRIDE_NOTE_MAX_LENGTH = 500

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/

/** A strict YYYY-MM-DD calendar date, or null. `2026-02-30` is null, not rolled into March. */
export function parseQuoteDate(input: string | null | undefined): string | null {
  const m = YMD.exec((input ?? '').trim())
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const probe = new Date(Date.UTC(y, mo - 1, d))
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null
  return `${m[1]}-${m[2]}-${m[3]}`
}

/** The calendar date of an instant in an IANA time zone, as YYYY-MM-DD. */
export function ymdInZone(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

/** The date `days` after `fromYmd`, as YYYY-MM-DD (calendar arithmetic in UTC, so no daylight-saving drift). */
export function addDaysYmd(fromYmd: string, days: number): string {
  const parsed = parseQuoteDate(fromYmd)
  if (!parsed) throw new Error(`Not a calendar date: ${fromYmd}`)
  const [y, mo, d] = parsed.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, mo - 1, d + days)).toISOString().slice(0, 10)
}

/** The stored DATE column as YYYY-MM-DD (the column carries no time zone: its UTC date is the date). */
export function quoteDateToYmd(value: Date | null | undefined): string | null {
  return value ? value.toISOString().slice(0, 10) : null
}

/** A quote's date as the value the DATE column stores (UTC midnight of the calendar date). */
export function quoteYmdToDate(ymd: string): Date {
  return new Date(`${ymd}T00:00:00.000Z`)
}

export type QuoteInputFacts = { isQuote?: boolean; isDraft?: boolean; quoteValidUntil?: string | null }
export type QuoteInputVerdict = { ok: true; isQuote: boolean; quoteValidUntil: string | null } | { ok: false; error: string }

/**
 * The quote part of a create / edit input. A quote is saved as a draft and needs a validity date that is a real calendar date and not already past (the
 * validity of a quote already saved may be left as it was: pass `allowPast` for an edit that does not move the date).
 */
export function validateQuoteInput(input: QuoteInputFacts, todayYmd: string, options: { allowPastDate?: string | null } = {}): QuoteInputVerdict {
  if (!input.isQuote) {
    if (input.quoteValidUntil) return { ok: false, error: 'A validity date belongs to a quote only.' }
    return { ok: true, isQuote: false, quoteValidUntil: null }
  }
  if (input.isDraft !== true) return { ok: false, error: 'A quote is saved as a draft: it cannot be created as a live order (isDraft must be true; omitting it is a live order).' }
  const ymd = parseQuoteDate(input.quoteValidUntil)
  if (!ymd) return { ok: false, error: 'Enter the date the quote is valid until.' }
  if (ymd < todayYmd && ymd !== options.allowPastDate) return { ok: false, error: 'The quote validity date is in the past.' }
  return { ok: true, isQuote: true, quoteValidUntil: ymd }
}

/** Valid THROUGH the validity date: it expires the day after. Only a quote can be expired. */
export function isQuoteExpired(facts: { isQuote: boolean; quoteValidUntil: string | null }, todayYmd: string): boolean {
  return facts.isQuote && facts.quoteValidUntil !== null && facts.quoteValidUntil < todayYmd
}

export type QuoteConversionFacts = {
  isQuote: boolean
  status: string
  quoteValidUntil: string | null
  hasExternalSource: boolean
}
export type QuoteConversionVerdict =
  | { ok: true; expired: boolean; overrideNote: string | null }
  | { ok: false; error: string }

/**
 * Whether a quote may become an order, and whether it is doing so after expiry.
 * An expired quote converts only with an operator's note (recorded in the activity log). Prices are never touched: the conversion clears the flag and nothing else.
 */
export function decideQuoteConversion(facts: QuoteConversionFacts, todayYmd: string, overrideNote?: string | null): QuoteConversionVerdict {
  if (!facts.isQuote) return { ok: false, error: 'This order is not a quote.' }
  if (facts.hasExternalSource) return { ok: false, error: 'A storefront order is never a quote.' }
  if (facts.status !== 'DRAFT') return { ok: false, error: `Only a draft quote can be converted (this one is ${facts.status}).` }
  const expired = isQuoteExpired(facts, todayYmd)
  const note = (overrideNote ?? '').trim()
  if (!expired) return { ok: true, expired: false, overrideNote: null }
  if (!note) return { ok: false, error: `This quote expired on ${facts.quoteValidUntil}. Converting it needs a note saying why the prices still stand.` }
  if (note.length > QUOTE_OVERRIDE_NOTE_MAX_LENGTH) return { ok: false, error: `The note is longer than ${QUOTE_OVERRIDE_NOTE_MAX_LENGTH} characters.` }
  return { ok: true, expired: true, overrideNote: note }
}

/** The refusal for a status move of a quote (cancelling is the one move a quote may make before it is converted). */
export const QUOTE_STATUS_MOVE_REFUSAL = 'This is a quote. Convert it to an order first, then confirm the order.'

export function quoteStatusMoveRefused(isQuote: boolean, targetStatus: string): string | null {
  return isQuote && targetStatus !== 'CANCELLED' && targetStatus !== 'DRAFT' ? QUOTE_STATUS_MOVE_REFUSAL : null
}

/** The document title a quote prints under (drawHeader upper-cases it) and the line that states how long the prices stand. */
export const QUOTE_DOCUMENT_TITLE = 'Quote'
export function quoteValidityLine(validUntilYmd: string | null, format: (ymd: string) => string): string | null {
  return validUntilYmd ? `Valid until ${format(validUntilYmd)}` : null
}

/** The default Documents > Quote template (used until an operator saves one): no payment terms, a plain statement that this is not an invoice. */
export const DEFAULT_QUOTE_TEMPLATE = {
  headerNote: '',
  footerNote: 'This is a quotation, not an order or an invoice. The prices shown stand until the validity date above.',
  termsText: '',
  customFooter: '',
  showLogo: true,
  showVat: true,
  showPaymentTerms: false,
  paymentTermsText: '',
} as const
