/**
 * THE EU VAT SHADOW COMPARISON. Pure: no database, no clock, no network, no WooCommerce or Xero types.
 *
 * The shadow report (scripts/eu-vat-shadow-report.ts) builds the sales invoice IMS WOULD post for an order and fetches the invoice the storefront plugin and Xeroom actually posted. This module only
 * turns each of the two into a small comparable shape and compares them, per line (account code, TaxType, line amount, tax amount), the VAT line and the invoice total.
 *
 * What is compared, and ONLY this: AccountCode, TaxType, LineAmount, TaxAmount, the document total and the currency. Descriptions, contacts, dates and references are never read, so nothing that could
 * identify a customer passes through here. Lines are matched by their figures, not by position (the storefront plugin and IMS may order the same lines differently); a line that does not match exactly is
 * paired with the closest unmatched one on the other side so the difference is shown field by field.
 *
 * TAX. IMS sends no TaxAmount (Xero computes it), so the expected tax of a line is its net times the effective rate of its TaxType, to the minor unit, using the rates the caller supplies. A tax figure
 * or total is accepted within `toleranceMinor` minor units per taxed line (Xero rounds per line). MATCH MEANS FULLY COMPARED: an unknown rate, a Xero line with no TaxAmount, or an unavailable total on either side makes the
 * order `not_comparable` (with the reasons), never a match. Nothing is guessed.
 * On the scheme, B2B and fee lines every type is zero-rated or NONE, so the comparison there is exact.
 *
 * BOUNDARY ORDERS (owner ruling Q5). An order whose regime warnings include a threshold-band or adopted-regime difference may legitimately decide differently from the plugin, because IMS converts the goods
 * value at the order-date rate and the plugin at its live rate. If such an order differs it is labelled `review`, never `differs`. A boundary order that matches is `match`.
 */
import { currencyMinorUnits, roundMoney, toDecimal, type Decimal } from '@/lib/domain/math/decimal'

export type ShadowLineKind = 'goods' | 'shipping' | 'discount' | 'vat' | 'fee' | 'rounding'

export type ComparableLine = {
  kind: ShadowLineKind | null
  accountCode: string
  taxType: string
  /** The net amount of the line as a decimal string, to the currency's minor unit (gross when the document is tax-inclusive, as Xero reports it). */
  lineAmount: string
  /** The tax of the line, or null when it is not known (an unknown rate on the IMS side; absent on the Xero side). */
  taxAmount: string | null
}

export type ComparableInvoice = {
  currency: string
  /** True when the currency is not the organisation's base currency: then the exchange rate is part of the comparison. */
  foreignCurrency: boolean
  /** The `CurrencyRate` the document carries (Xero's direction, the same as fxRateToBase: document-currency units per one base unit), or null when it carries none. */
  currencyRate: number | null
  lineAmountsIncludeTax: boolean
  lines: ComparableLine[]
  /** The document total, or null when it cannot be stated (a tax rate is unknown). */
  total: string | null
}

/** One unit in the 6th decimal place: the precision at which Xero stores `CurrencyRate`. */
export const CURRENCY_RATE_TOLERANCE = 1e-6

const IMS_NO_TAX_KIND_TO_LINE_KIND: Readonly<Record<string, ShadowLineKind>> = { 'eu-vat-recovery': 'vat', 'fee-no-tax': 'fee', 'rounding-difference': 'rounding' }

/** The description the Xero connector gives the one untaxed line that makes a unitdp=4 document total what the order totals (write-path.ts `planXeroRoundingLine`). It is appended after the IMS lines, shipping and discount, so it is recognised by this. */
export const ROUNDING_ADJUSTMENT_DESCRIPTION = 'Rounding adjustment'

type XeroLineItem = { Quantity?: unknown; UnitAmount?: unknown; DiscountAmount?: unknown; AccountCode?: unknown; TaxType?: unknown; Description?: unknown }

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
/** A code that a vendor sent, kept only if it looks like a code (an account code, a tax type, a status): anything else is free text that could carry a name, and is replaced. */
const code = (value: unknown): string => { const t = text(value); return /^[A-Za-z0-9._-]{0,32}$/.test(t) ? t : '?' }
const rateOrNull = (value: unknown): number | null => (isFiniteNumber(value) && value > 0 ? value : null)
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

function numeric(value: unknown): Decimal | null {
  if (isFiniteNumber(value)) return toDecimal(value)
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return toDecimal(value.trim())
  return null
}

/**
 * What the invoice IMS WOULD post comes to, from the output of the real Xero payload builder (`buildSalesInvoicePayload`) and the IMS payload it was built from.
 * `imsLines` supplies each line's `noTaxKind` (the builder drops it), so the VAT line, the fee lines and a rounding line are named. `rateOf` gives the effective percentage of a TaxType, or null if unknown.
 */
export function comparableFromBuiltPayload(
  built: Record<string, unknown>,
  imsLines: ReadonlyArray<{ noTaxKind?: unknown }>,
  rateOf: (taxType: string) => number | null,
  baseCurrency: string,
): { ok: true; invoice: ComparableInvoice } | { ok: false; reason: string } {
  const currency = code(built.CurrencyCode)
  const items = built.LineItems
  if (currency === '' || !Array.isArray(items)) return { ok: false, reason: 'the built payload has no currency or no line items' }
  const inclusive = built.LineAmountTypes === 'Inclusive'
  const lines: ComparableLine[] = []
  let total = toDecimal(0)
  let totalKnown = true
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i] as XeroLineItem
    const quantity = numeric(item.Quantity)
    const unit = numeric(item.UnitAmount)
    if (quantity === null || unit === null) return { ok: false, reason: `line ${i + 1} of the built payload has an unreadable quantity or amount` }
    const discount = isFiniteNumber(item.DiscountAmount) && item.DiscountAmount > 0 ? toDecimal(item.DiscountAmount).toDecimalPlaces(2, 4) : toDecimal(0)
    const amount = roundMoney(quantity.times(unit).minus(discount), currency)
    const taxType = code(item.TaxType)
    const rate = rateOf(taxType)
    let tax: Decimal | null = null
    if (rate !== null) {
      tax = inclusive
        ? roundMoney(amount.minus(amount.div(toDecimal(1).plus(toDecimal(rate).div(100)))), currency)
        : roundMoney(amount.times(toDecimal(rate).div(100)), currency)
    }
    let kind: ShadowLineKind | null
    if (i < imsLines.length) kind = IMS_NO_TAX_KIND_TO_LINE_KIND[text(imsLines[i]!.noTaxKind)] ?? 'goods'
    else if (text(item.Description) === ROUNDING_ADJUSTMENT_DESCRIPTION) kind = 'rounding'
    else kind = text(item.Description) === 'Order discount' ? 'discount' : 'shipping'
    lines.push({ kind, accountCode: code(item.AccountCode), taxType, lineAmount: amount.toFixed(currencyMinorUnits(currency)), taxAmount: tax === null ? null : tax.toFixed(currencyMinorUnits(currency)) })
    total = total.plus(amount)
    if (tax === null) totalKnown = false
    else if (!inclusive) total = total.plus(tax)
  }
  return { ok: true, invoice: { currency, foreignCurrency: currency !== baseCurrency, currencyRate: rateOrNull(built.CurrencyRate), lineAmountsIncludeTax: inclusive, lines, total: totalKnown ? roundMoney(total, currency).toFixed(currencyMinorUnits(currency)) : null } }
}

/** The invoice Xero holds, reduced to the compared fields. Reads only the fields named here, from the shape Xero returns (`Invoices[0]`); anything else in the response is ignored and never kept. */
export type XeroInvoiceReading =
  | { ok: true; status: string; invoice: ComparableInvoice }
  | { ok: false; reason: string }

export function comparableFromXeroInvoice(raw: unknown): XeroInvoiceReading {
  const invoice = raw as Record<string, unknown> | null
  if (invoice === null || typeof invoice !== 'object') return { ok: false, reason: 'the Xero invoice could not be read' }
  const currency = code(invoice.CurrencyCode)
  const items = invoice.LineItems
  if (currency === '' || !Array.isArray(items)) return { ok: false, reason: 'the Xero invoice has no currency or no line items' }
  const lines: ComparableLine[] = []
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i] as Record<string, unknown>
    const amount = numeric(item.LineAmount)
    if (amount === null) return { ok: false, reason: `line ${i + 1} of the Xero invoice has no readable LineAmount` }
    const tax = numeric(item.TaxAmount)
    lines.push({
      kind: null,
      accountCode: code(item.AccountCode),
      taxType: code(item.TaxType),
      lineAmount: roundMoney(amount, currency).toFixed(currencyMinorUnits(currency)),
      taxAmount: tax === null ? null : roundMoney(tax, currency).toFixed(currencyMinorUnits(currency)),
    })
  }
  const total = numeric(invoice.Total)
  return {
    ok: true,
    status: code(invoice.Status),
    invoice: { currency, foreignCurrency: false, currencyRate: rateOrNull(invoice.CurrencyRate), lineAmountsIncludeTax: invoice.LineAmountTypes === 'Inclusive', lines, total: total === null ? null : roundMoney(total, currency).toFixed(currencyMinorUnits(currency)) },
  }
}

export type LineVerdict = 'match' | 'differs' | 'only_ims' | 'only_xero'
export type LineSide = { accountCode: string; taxType: string; lineAmount: string; taxAmount: string | null }
export type LineRow = {
  kind: ShadowLineKind | null
  ims: LineSide | null
  xero: LineSide | null
  verdict: LineVerdict
  /** Which of accountCode, taxType, lineAmount, taxAmount differ (empty for a match and for a line only one side has). */
  fields: Array<'accountCode' | 'taxType' | 'lineAmount' | 'taxAmount'>
  /** True when the tax of this line could not be compared (one side has no figure). */
  taxNotCompared: boolean
}

export type VatLineCheck =
  | { present: false }
  | { present: true; account: string; ims: string; xero: string | null; match: boolean }

export type InvoiceComparison = {
  /** `match` means FULLY compared and equal. `not_comparable`: nothing differs in what could be compared, but a required figure (a tax amount, the expected total or the Xero total) was unavailable, so equality is not established. */
  verdict: 'match' | 'differs' | 'not_comparable'
  /** Why a comparison is incomplete (empty for a full one). */
  incomplete: string[]
  currencyMatch: boolean
  lines: LineRow[]
  vatLine: VatLineCheck
  total: { ims: string | null; xero: string | null; compared: boolean; match: boolean }
  /** Short, figure-only descriptions of every difference, for the summary. */
  differences: string[]
}

const side = (line: ComparableLine): LineSide => ({ accountCode: line.accountCode, taxType: line.taxType, lineAmount: line.lineAmount, taxAmount: line.taxAmount })

export function compareComparableInvoices(ims: ComparableInvoice, xero: ComparableInvoice, options: { toleranceMinor?: number } = {}): InvoiceComparison {
  const currency = ims.currency
  const minor = toDecimal(1).div(toDecimal(10).pow(currencyMinorUnits(currency)))
  const tolerance = minor.times(options.toleranceMinor ?? 1)
  const sameAmount = (a: string, b: string): boolean => toDecimal(a).eq(toDecimal(b))
  const taxClose = (a: string | null, b: string | null): boolean => a === null || b === null || toDecimal(a).minus(toDecimal(b)).abs().lte(tolerance)

  const unusedXero = xero.lines.map((line, index) => ({ line, index }))
  const rows: LineRow[] = []
  const pending: Array<{ imsLine: ComparableLine; position: number }> = []

  // Pass 1: an exact match on account, type and amount, with the tax within tolerance.
  ims.lines.forEach((imsLine, position) => {
    const at = unusedXero.findIndex(({ line }) => line.accountCode === imsLine.accountCode && line.taxType === imsLine.taxType && sameAmount(line.lineAmount, imsLine.lineAmount) && taxClose(imsLine.taxAmount, line.taxAmount))
    if (at === -1) { pending.push({ imsLine, position }); rows[position] = undefined as unknown as LineRow; return }
    const [taken] = unusedXero.splice(at, 1)
    rows[position] = { kind: imsLine.kind, ims: side(imsLine), xero: side(taken!.line), verdict: 'match', fields: [], taxNotCompared: imsLine.taxAmount === null || taken!.line.taxAmount === null }
  })

  // Pass 2: pair what is left, preferring the same account, then the same type, then the same position; show which fields differ.
  for (const { imsLine, position } of pending) {
    let at = unusedXero.findIndex(({ line }) => line.accountCode === imsLine.accountCode && line.taxType === imsLine.taxType)
    if (at === -1) at = unusedXero.findIndex(({ line }) => line.accountCode === imsLine.accountCode)
    if (at === -1) at = unusedXero.findIndex(({ line }) => line.taxType === imsLine.taxType)
    if (at === -1) { rows[position] = { kind: imsLine.kind, ims: side(imsLine), xero: null, verdict: 'only_ims', fields: [], taxNotCompared: false }; continue }
    const [taken] = unusedXero.splice(at, 1)
    const other = taken!.line
    const fields: LineRow['fields'] = []
    if (other.accountCode !== imsLine.accountCode) fields.push('accountCode')
    if (other.taxType !== imsLine.taxType) fields.push('taxType')
    if (!sameAmount(other.lineAmount, imsLine.lineAmount)) fields.push('lineAmount')
    if (!taxClose(imsLine.taxAmount, other.taxAmount)) fields.push('taxAmount')
    rows[position] = { kind: imsLine.kind, ims: side(imsLine), xero: side(other), verdict: fields.length === 0 ? 'match' : 'differs', fields, taxNotCompared: imsLine.taxAmount === null || other.taxAmount === null }
  }
  for (const { line } of unusedXero) rows.push({ kind: null, ims: null, xero: side(line), verdict: 'only_xero', fields: [], taxNotCompared: false })

  // The VAT line: the amount IMS puts on the VAT account, against what Xero holds on that account on NONE.
  const imsVat = ims.lines.find((line) => line.kind === 'vat')
  let vatLine: VatLineCheck = { present: false }
  if (imsVat) {
    const onAccount = xero.lines.filter((line) => line.accountCode === imsVat.accountCode && line.taxType === imsVat.taxType)
    const xeroAmount = onAccount.length === 0 ? null : roundMoney(onAccount.reduce((sum, line) => sum.plus(toDecimal(line.lineAmount)), toDecimal(0)), currency).toFixed(currencyMinorUnits(currency))
    vatLine = { present: true, account: imsVat.accountCode, ims: imsVat.lineAmount, xero: xeroAmount, match: xeroAmount !== null && sameAmount(xeroAmount, imsVat.lineAmount) }
  }

  // The total: compared only when IMS can state it: exactly when no line carries tax, otherwise within one minor unit per taxed line (Xero rounds per line).
  const taxedLines = ims.lines.filter((line) => line.taxAmount !== null && !toDecimal(line.taxAmount).isZero()).length
  const totalCompared = ims.total !== null && xero.total !== null
  const totalMatch = !totalCompared || toDecimal(ims.total!).minus(toDecimal(xero.total!)).abs().lte(tolerance.times(taxedLines))
  const currencyMatch = ims.currency === xero.currency

  // THE EXCHANGE RATE, for a foreign-currency invoice only. IMS stamps its rate (the same direction as Xero's); Xero stores the rate to 6 decimal places, so IMS's is rounded to 6 places and the two must agree within one unit of the
  // 6th place (1e-6 absolute). A missing rate on either side is not a match: the order is not comparable (`currency_rate_unavailable`).
  const rateUnavailable = ims.foreignCurrency && (ims.currencyRate === null || xero.currencyRate === null)
  const rateDiffers = ims.foreignCurrency && ims.currencyRate !== null && xero.currencyRate !== null
    && Math.abs(Math.round(ims.currencyRate * 1e6) / 1e6 - xero.currencyRate) > CURRENCY_RATE_TOLERANCE

  const differences: string[] = []
  if (rateDiffers) differences.push(`currency rate: IMS ${Math.round(ims.currencyRate! * 1e6) / 1e6}, Xero ${xero.currencyRate}`)
  if (!currencyMatch) differences.push(`currency: IMS ${ims.currency}, Xero ${xero.currency}`)
  rows.forEach((row, index) => {
    if (row.verdict === 'differs') differences.push(`line ${index + 1}${row.kind ? ` (${row.kind})` : ''}: ${row.fields.join(', ')} differ`)
    else if (row.verdict === 'only_ims') differences.push(`line ${index + 1}${row.kind ? ` (${row.kind})` : ''}: IMS has it, Xero does not`)
    else if (row.verdict === 'only_xero') differences.push(`line ${index + 1}: Xero has it, IMS does not`)
  })
  if (vatLine.present && !vatLine.match) differences.push(`VAT line on ${vatLine.account}: IMS ${vatLine.ims}, Xero ${vatLine.xero ?? 'none'}`)
  if (!totalMatch) differences.push(`total: IMS ${ims.total}, Xero ${xero.total}`)

  // MATCH MEANS FULLY COMPARED. A figure that was not available is never read as equal.
  const incomplete: string[] = []
  if (rateUnavailable) incomplete.push('currency_rate_unavailable: the exchange rate of a foreign-currency invoice is missing on the IMS side or on the Xero side')
  const unknownRates = new Set<string>()
  ims.lines.forEach((line) => { if (line.taxAmount === null) unknownRates.add(line.taxType) })
  if (unknownRates.size > 0) incomplete.push(`the tax rate of ${[...unknownRates].sort().join(', ')} is not known, so the tax amount was not compared`)
  if (xero.lines.some((line) => line.taxAmount === null)) incomplete.push('a Xero line carries no TaxAmount')
  if (ims.total === null) incomplete.push('IMS cannot state the expected total')
  if (xero.total === null) incomplete.push('the Xero invoice carries no Total')

  return {
    verdict: differences.length > 0 ? 'differs' : incomplete.length > 0 ? 'not_comparable' : 'match',
    incomplete,
    currencyMatch,
    lines: rows,
    vatLine,
    total: { ims: ims.total, xero: xero.total, compared: totalCompared, match: totalMatch },
    differences,
  }
}

/** Regime warnings that make an order a boundary order (owner ruling Q5). */
export const BOUNDARY_WARNING_CODES: readonly string[] = ['threshold_band', 'adopted_regime_differs']

export type ShadowStatus = 'match' | 'differs' | 'review' | 'no_xero_doc' | 'ims_refused' | 'not_comparable'

export function isBoundaryOrder(warnings: ReadonlyArray<{ code: string }>): boolean {
  return warnings.some((warning) => BOUNDARY_WARNING_CODES.includes(warning.code))
}

/** The status of a compared order: a boundary order that differs is `review`; one that matches is `match`. */
export function statusOfComparison(comparison: InvoiceComparison, boundary: boolean): 'match' | 'differs' | 'review' | 'not_comparable' {
  if (comparison.verdict === 'match') return 'match'
  if (comparison.verdict === 'not_comparable') return 'not_comparable'
  return boundary ? 'review' : 'differs'
}
