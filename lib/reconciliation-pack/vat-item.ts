/**
 * ITEM R12: VAT PER (COUNTRY, REPORTING CATEGORY, PERIOD) AGREES ACROSS IMS, XERO AND WOOCOMMERCE.
 *
 * Behind an explicit opt-in (--vendor-reads-only), like every item that reads a vendor: without it nothing is read, no port is touched
 * and no request is made. The module is total: whatever it is handed it returns an item and never throws; whatever cannot be proven is
 * inconclusive with closed reasons, and nothing is assumed.
 *
 *   PERIOD. One calendar month, UTC (YYYY-MM). The window is the latest R12_WINDOW_MONTHS months that are CLOSED for the cycle date: a
 *   month is closed once the cycle date is at least R12_CLOSE_LAG_DAYS days after the month ended (the cycle date is the 8th of the
 *   following month or later), so late postings and status changes have settled and the periods are complete. An unclosed month is never
 *   read. A month that began before the recorded VERIFIED first load, or before the recorded storefront import, or beyond the sales
 *   retention horizon, is outside the population (IMS never held it): no recorded boundary is NO_POPULATION_RECORD, never "in". R12 does
 *   NOT settle (the catalogue says so): the periods are closed, a difference in one is a difference at once. The cycle date is
 *   therefore part of the evidence (the item's source `ims-ledger` is cycle-dated, so the gate requires the report's cycle date to be
 *   current, readiness-gate-pack.ts CYCLE_DATED_SOURCES).
 *
 *   KEYS. (period, country, reporting category), from the IMS tax rate: its countryCode (two capitals) and its reportingCategory
 *   (lower case, underscores as hyphens). The same rate is how each system's tax is placed: IMS sums SalesOrderLine.taxBase per rate;
 *   WooCommerce's tax lines name a rate id that IMS maps (shopping_tax_rate_mappings); a Xero invoice line names a Xero tax type that
 *   exactly one IMS rate carries (accounting_tax_type).
 *
 *   NETTING. A mapping is judged on every CONSTITUENT non-zero line (an IMS sales line, a Xero invoice line, a WooCommerce tax line), before
 *   anything is summed: lines that cancel on an unverified rate still make the item unverified. After that check, a verified key that nets to
 *   zero (after rounding to the penny) is not a key of that system, the same rule on all three sides, so a key that nets to zero in one
 *   system and has a non-zero value in another is a finding of the leg that sees the difference. Lines on the shipping account are cut
 *   from Xero before the check on purpose: shipping VAT is out of scope in every system.
 *
 *   SHIPPING AND FEES. Shipping VAT is cut from every side and the cut must be provable: the Xero shipping account must be configured, one
 *   active account of the stored chart, and neither the sales nor the discount account (else VAT_MAPPING_UNVERIFIED before any request).
 *   IMS never makes shipping a sales line (it is order level: shippingForeign, and the order's taxForeign adds shipping tax to the line tax,
 *   order-import.ts:178-195), and WooCommerce's shipping_tax_total is never read. FEE lines are different: IMS turns them into sales lines
 *   (field-mapping.ts mapWcFeeLines, order-import.ts:1926) and the storefront's tax_total is understood to count them, but that is not
 *   proven on the live store, so a WooCommerce order with a non-zero fee-line tax in the window makes the item VAT_MAPPING_UNVERIFIED.
 *
 *   FIGURES. Sales VAT in GBP, SHIPPING VAT EXCLUDED (IMS holds it at order level with no rate; the other two are cut to match): IMS =
 *   the sum of line taxBase (its recorded base amount) of orders by invoice instant, not CANCELLED, not archived (the IMS VAT report's
 *   own population); Xero = the sum of line TaxAmount of AUTHORISED and PAID sales invoices by invoice date, lines on the configured
 *   shipping account left out, a foreign invoice multiplied by Xero's own CurrencyRate (1 document-currency = X base: connectors/xero/fx.ts); WooCommerce = the sum of tax-line totals of
 *   orders in processing, completed and refunded by GMT creation date, a non-GBP order divided by the fxRateToBase (1 base = X foreign) IMS recorded on the
 *   linked order (the storefront records none). Each key is rounded to the penny, half up; a key whose total is zero in a system is not
 *   a key of that system (a key on one side only with a non-zero value is a finding; a zero is provably nothing because every read is
 *   proven complete).
 *
 *   COMPARISON. Three legs on one comparator, as distinct identities (ims-xero, ims-woo, xero-woo): the SET must be exact and each
 *   value must agree within GBP 0.05 INCLUSIVE (owner decision D1).
 *
 *   U8 (how OSS, EC and reverse-charge sales are coded in Xero) is UNVERIFIED. Only the verified categories (R12_VERIFIED_CATEGORIES:
 *   domestic) have a Xero side the pack believes, and only when the rate's Xero tax type is its own (no other IMS rate carries it), is in
 *   the PROVEN stored Xero tax-rate list (the master) and that list gives it a verified report tax type (OUTPUT). Any non-zero VAT on a
 *   rate that fails any of that, in any of the three systems, is VAT_MAPPING_UNVERIFIED for the whole item and nothing is compared:
 *   the affected keys are every OSS, EC sales and reverse-charge key (and any key with no category), plus any domestic key whose rate has
 *   no country, no Xero tax type, a shared one, or one the proven list does not hold with a verified report type. These checks are made on
 *   the IMS read, before any vendor request.
 *
 *   XERO SPEND. The pack never refreshes a token (that writes): a stored token with less than XERO_TOKEN_MIN_REMAINING_MS to live is
 *   XERO_CONNECTION_UNUSABLE. All Xero requests of the run are at most XERO_REQUEST_BUDGET, paced at XERO_MIN_REQUEST_INTERVAL_MS
 *   (xero-source.ts); more is CAP_EXCEEDED and no figure at all. The connection (tenant and generation) is read at the start and at the
 *   end of the Xero walk and must be equal and be the tenant of the proven tax-rate list.
 */

import { Prisma } from '@/app/generated/prisma/client'
import { compareItem, outcomeOfComparison, parseDecimalStrict, type CompareResult, type SideRow } from '@/lib/reconciliation-pack/compare'
import {
  R12_CLOSE_LAG_DAYS,
  R12_VERIFIED_CATEGORIES,
  R12_VERIFIED_XERO_REPORT_TAX_TYPES,
  R12_WINDOW_MONTHS,
  R12_WOO_DATE_MARGIN_DAYS,
  R12_WOO_STATUSES,
  R12_XERO_DATE_MARGIN_DAYS,
  VAT_BASE_CURRENCY,
  type PackReasonCode,
  type PackSourceCode,
} from '@/lib/reconciliation-pack/constants'
import { xeroDocumentAmountToBase } from '@/lib/connectors/xero/fx'
import type { KeyPart } from '@/lib/reconciliation-pack/identity'
import { classifyPopulation, type ImsRead, type ImsReadOptions, type ImsTaxes, type ImsVat, type PopulationBoundaries, type TaxRateRow, type XeroTaxRateStore } from '@/lib/reconciliation-pack/ims-readers'
import type { ItemInput } from '@/lib/reconciliation-pack/report'
import type { XeroBinding } from '@/lib/reconciliation-pack/xero-credentials'
import { makeXeroWalker, readXeroBaseCurrency, readXeroInvoices, type XeroGetPort, type XeroSourceOptions } from '@/lib/reconciliation-pack/xero-source'
import { readWooOrderTaxes, type WooGetPort, type WooSourceOptions } from '@/lib/reconciliation-pack/woo-source'

export const VAT_ITEM_IDS = ['R12'] as const
export type VatItemId = (typeof VAT_ITEM_IDS)[number]
export function isVatItem(id: string): id is VatItemId {
  return (VAT_ITEM_IDS as readonly string[]).includes(id)
}

/** What R12 reads from Xero: the GET-only port, and a read of the stored connection's tenant and generation (for the start and end of the walk). */
export type XeroVatVendor = { port: XeroGetPort; binding: () => Promise<XeroBinding | null> }

export type VatItemContext = {
  asOf: string
  /** The explicit opt-in. Anything but the boolean true is "off". */
  vendorReads?: boolean
  vendor?: { woo?: WooGetPort; xero?: XeroVatVendor }
  ims?: (options: ImsReadOptions) => Promise<ImsRead>
  /** Test seams for pacing and budget. */
  wooOptions?: WooSourceOptions
  xeroOptions?: XeroSourceOptions
}

export type R12Source = 'ims' | 'xero' | 'woo'
/** The three legs: label, left operand, right operand. A test walks this table (two different sources per leg; the pairs are exactly the three pairs). */
export const R12_LEGS: ReadonlyArray<{ label: string; left: R12Source; right: R12Source }> = [
  { label: 'ims-xero', left: 'ims', right: 'xero' },
  { label: 'ims-woo', left: 'ims', right: 'woo' },
  { label: 'xero-woo', left: 'xero', right: 'woo' },
]

const LEDGER: PackSourceCode = 'ims-ledger'
const WOO: PackSourceCode = 'woocommerce-api'
const XERO: PackSourceCode = 'xero-api'

const inconclusive = (sources: readonly PackSourceCode[], ...reasons: PackReasonCode[]): ItemInput => ({ id: 'R12', outcome: 'inconclusive', reasons: [...new Set(reasons)], sources: [...sources] })

// ---------------------------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------------------------

const ASOF_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/
const DAY_MS = 86_400_000

const dateMs = (date: string): number => Date.parse(`${date}T00:00:00.000Z`)
const msDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10)
export const addDays = (date: string, days: number): string => msDate(dateMs(date) + days * DAY_MS)
function nextMonth(period: string): string {
  const [y, m] = period.split('-').map(Number) as [number, number]
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
}
function previousMonth(period: string): string {
  const [y, m] = period.split('-').map(Number) as [number, number]
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
}

/** The latest `count` CLOSED months for a cycle date, oldest first. A month is closed once the cycle date is at least R12_CLOSE_LAG_DAYS days after its last day (the day after the month ended plus the lag). null = the cycle date is not a real calendar date. */
export function r12ClosedPeriods(asOf: string, count: number = R12_WINDOW_MONTHS, lagDays: number = R12_CLOSE_LAG_DAYS): string[] | null {
  if (typeof asOf !== 'string' || !ASOF_RE.test(asOf) || Number.isNaN(dateMs(asOf)) || msDate(dateMs(asOf)) !== asOf) return null
  let period = asOf.slice(0, 7)
  const closed = (p: string) => dateMs(asOf) >= dateMs(`${nextMonth(p)}-01`) + lagDays * DAY_MS
  while (!closed(period)) period = previousMonth(period)
  const out: string[] = []
  for (let i = 0; i < count; i += 1) { out.unshift(period); period = previousMonth(period) }
  return out
}

// ---------------------------------------------------------------------------------------------
// Rates and keys
// ---------------------------------------------------------------------------------------------

type VatKey = { period: string; country: string; category: string }
const keyId = (key: VatKey): string => `${key.period}\u0001${key.country}\u0001${key.category}`
const COUNTRY_RE = /^[A-Z]{2}$/
const CATEGORY_TOKEN_RE = /^[a-z][a-z-]{0,31}$/

type RateInfo = { country: string; category: string }
type RateCatalogue = {
  /** The key place of a rate whose every dependency is verified; null when any is not. */
  place(rateId: string | null): RateInfo | null
  /** The one IMS rate that carries a Xero tax type, or null (none, or more than one). */
  ownerOf(taxType: string): string | null
}

function buildCatalogue(rates: readonly TaxRateRow[], reportTypes: ReadonlyMap<string, string | null>): RateCatalogue {
  const byId = new Map(rates.map((rate) => [rate.id, rate] as const))
  const owners = new Map<string, string[]>()
  for (const rate of rates) {
    if (rate.accountingTaxType === null) continue
    owners.set(rate.accountingTaxType, [...(owners.get(rate.accountingTaxType) ?? []), rate.id])
  }
  const verifiedCategories: readonly string[] = R12_VERIFIED_CATEGORIES
  const verifiedReportTypes: readonly string[] = R12_VERIFIED_XERO_REPORT_TAX_TYPES
  return {
    place(rateId) {
      if (rateId === null) return null
      const rate = byId.get(rateId)
      if (rate === undefined) return null
      const country = rate.countryCode === null ? '' : rate.countryCode.trim().toUpperCase()
      const category = rate.reportingCategory === null ? '' : rate.reportingCategory.trim().toLowerCase().replace(/[\s_]+/g, '-')
      if (!COUNTRY_RE.test(country) || !CATEGORY_TOKEN_RE.test(category) || !verifiedCategories.includes(category)) return null
      // The Xero side of this rate: its tax type is its own, the PROVEN stored list holds it, and the list gives it a verified report tax type.
      const type = rate.accountingTaxType
      if (type === null || (owners.get(type)?.length ?? 0) !== 1) return null
      const report = reportTypes.get(type)
      if (report === undefined || report === null || !verifiedReportTypes.includes(report)) return null
      return { country, category }
    },
    ownerOf(taxType) {
      const list = owners.get(taxType)
      return list !== undefined && list.length === 1 ? list[0]! : null
    },
  }
}

// ---------------------------------------------------------------------------------------------
// Sums
// ---------------------------------------------------------------------------------------------

const D = (value: string | number): Prisma.Decimal => new Prisma.Decimal(value)
type Sums = Map<string, { key: VatKey; total: Prisma.Decimal }>
function add(sums: Sums, key: VatKey, amount: Prisma.Decimal): void {
  if (amount.isZero()) return
  const id = keyId(key)
  const entry = sums.get(id)
  if (entry) entry.total = entry.total.add(amount)
  else sums.set(id, { key, total: amount })
}
/** The penny figure per key, half up; a key that rounds to zero is not a key. */
function rounded(sums: Sums): Map<string, { key: VatKey; value: string }> {
  const out = new Map<string, { key: VatKey; value: string }>()
  for (const [id, entry] of sums) {
    const value = entry.total.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
    if (!value.isZero()) out.set(id, { key: entry.key, value: value.toFixed(2) })
  }
  return out
}

const part = (raw: string): KeyPart => ({ kind: 'sku', raw })
function rows(leg: string, figures: ReadonlyMap<string, { key: VatKey; value: string }>): SideRow[] {
  return [...figures.values()].map(({ key, value }): SideRow => ({ key: [part(leg), part(key.period), part(key.country), part(key.category)], value, currency: VAT_BASE_CURRENCY }))
}

// ---------------------------------------------------------------------------------------------
// The item
// ---------------------------------------------------------------------------------------------

async function runR12(context: VatItemContext): Promise<ItemInput> {
  const woo = context.vendor?.woo
  const xero = context.vendor?.xero
  const readIms = context.ims
  if (woo === undefined || xero === undefined || readIms === undefined) return inconclusive([], 'SOURCE_UNREADABLE')

  const candidates = r12ClosedPeriods(context.asOf)
  if (candidates === null) return inconclusive([], 'STALE_BASIS')
  const first = candidates[0]!
  const last = candidates[candidates.length - 1]!
  const windowFrom = `${first}-01`
  const windowTo = `${nextMonth(last)}-01`

  // ONE IMS snapshot: the boundaries, the rates and their mappings, the proven Xero list, and the sales VAT of the whole window.
  const read = await readIms({ sections: ['boundaries', 'taxes', 'xeroTaxRates', 'vat'], vatWindow: { from: windowFrom, toExclusive: windowTo } })
  if (!read.ok) return inconclusive([LEDGER], read.reason)
  const failed = (['boundaries', 'taxes', 'xeroTaxRates', 'vat'] as const).flatMap((name) => {
    const section = read.sections[name]
    return section === undefined ? ['SOURCE_UNREADABLE' as const] : section.ok ? [] : [section.reason]
  })
  if (failed.length > 0) return inconclusive([LEDGER], ...failed)
  const boundaries = (read.sections.boundaries as { ok: true; value: PopulationBoundaries }).value
  const taxes = (read.sections.taxes as { ok: true; value: ImsTaxes }).value
  const storedList = (read.sections.xeroTaxRates as { ok: true; value: XeroTaxRateStore }).value
  const vat: ImsVat = (read.sections.vat as { ok: true; value: ImsVat }).value

  // The currency the tolerance is stated in.
  if (vat.baseCurrency !== VAT_BASE_CURRENCY) return inconclusive([LEDGER], 'BASE_CURRENCY_NOT_GBP')

  // The population: months IMS held. An unrecorded boundary is unknown, never in.
  const periods: string[] = []
  for (const period of candidates) {
    const start = `${period}-01T00:00:00.000Z`
    const verdicts = [classifyPopulation(boundaries, 'first-load', start, context.asOf), classifyPopulation(boundaries, 'storefront-order', start, context.asOf)]
    if (verdicts.some((verdict) => verdict.kind === 'unknown')) return inconclusive([LEDGER], 'NO_POPULATION_RECORD')
    if (verdicts.every((verdict) => verdict.kind === 'in')) periods.push(period)
  }
  if (periods.length === 0) return inconclusive([LEDGER], 'EMPTY_UNPROVEN')
  const periodSet = new Set(periods)

  // The Xero master list must be proven, for the organisation whose report types were read beside it.
  if (storedList.state !== 'proven') return inconclusive([LEDGER], 'VENDOR_LIST_UNPROVEN')
  const proven = new Set(storedList.taxTypes.map((entry) => entry.taxType))
  if (vat.xeroTenantId !== storedList.tenantId || vat.xeroReportTypes.length !== proven.size || !vat.xeroReportTypes.every((entry) => proven.has(entry.taxType))) return inconclusive([LEDGER], 'VENDOR_LIST_UNPROVEN')
  const catalogue = buildCatalogue(taxes.rates, new Map(vat.xeroReportTypes.map((entry) => [entry.taxType, entry.reportTaxType] as const)))

  // SHIPPING VAT MUST BE RELIABLY SEPARATED before anything is requested: the Xero lines on the shipping account are what is cut out, so
  // the account must be configured, be exactly one active account of the stored chart, and not be the sales or the discount account (a
  // shared account cannot tell shipping from goods).
  const shared = (account: string) => account !== '' && account === vat.shippingAccount
  if (vat.shippingAccount === '' || !vat.shippingAccountInChart || shared(vat.salesAccount) || shared(vat.discountAccount)) return inconclusive([LEDGER], 'VAT_MAPPING_UNVERIFIED')

  // THE IMS SIDE, before any vendor request: every non-zero figure must have a verified place.
  const imsSums: Sums = new Map()
  let imsRows = 0
  for (const row of vat.sales) {
    if (!periodSet.has(row.period)) continue
    const amount = parseDecimalStrict(row.taxBase)
    if (amount === null) return inconclusive([LEDGER], 'BAD_VALUE')
    imsRows += 1
    // VERIFICATION IS DECIDED ON THE CONSTITUENT LINES, never on what they net to: a +x and a -x line on an unverified rate sum to zero and
    // would otherwise vanish. Any non-zero line (the reader counts them) on a rate with no verified place makes the item unverified.
    const place = catalogue.place(row.taxRateId)
    if ((row.nonZeroLines > 0 || !amount.isZero()) && place === null) return inconclusive([LEDGER], 'VAT_MAPPING_UNVERIFIED')
    if (place === null) continue
    add(imsSums, { period: row.period, ...place }, amount)
  }
  // The storefront's rate ids resolve through IMS's own mapping rows.
  const wooRate = new Map<string, string>()
  for (const mapping of taxes.mappings) if (mapping.connector === 'woocommerce') wooRate.set(mapping.externalTaxRateId, mapping.taxRateId)
  const wooFx = new Map(vat.wooFx.map((row) => [row.externalOrderId, row] as const))

  // XERO. The organisation's base currency, then the invoices of the window (widened a day each side, cut by invoice date).
  const walker = makeXeroWalker(xero.port, context.xeroOptions)
  const start = await xero.binding()
  if (start === null || start.tenantId !== storedList.tenantId) return inconclusive([LEDGER, XERO], 'XERO_CONNECTION_UNUSABLE')
  const base = await readXeroBaseCurrency(walker)
  if (!base.ok) return inconclusive([LEDGER, XERO], base.reason === 'SOURCE_UNREADABLE' ? 'XERO_CONNECTION_UNUSABLE' : base.reason)
  if (base.value !== VAT_BASE_CURRENCY) return inconclusive([LEDGER, XERO], 'BASE_CURRENCY_NOT_GBP')
  const invoices = await readXeroInvoices(walker, { from: addDays(windowFrom, -R12_XERO_DATE_MARGIN_DAYS), toExclusive: addDays(windowTo, R12_XERO_DATE_MARGIN_DAYS) })
  if (!invoices.ok) return inconclusive([LEDGER, XERO], invoices.reason)
  const end = await xero.binding()
  if (end === null || end.tenantId !== start.tenantId || end.connectionGeneration !== start.connectionGeneration) return inconclusive([LEDGER, XERO], 'XERO_CONNECTION_UNUSABLE')

  const xeroSums: Sums = new Map()
  for (const invoice of invoices.value.invoices) {
    const period = invoice.date.slice(0, 7)
    if (!periodSet.has(period)) continue
    for (const line of invoice.lines) {
      // The shipping line is cut out: the figures compared exclude shipping VAT in every system.
      if (line.accountCode === vat.shippingAccount) continue
      const amount = D(line.taxAmount)
      if (amount.isZero()) continue
      const owner = catalogue.ownerOf(line.taxType)
      const place = owner === null ? null : catalogue.place(owner)
      if (place === null) return inconclusive([LEDGER, XERO], 'VAT_MAPPING_UNVERIFIED')
      add(xeroSums, { period, ...place }, invoice.currency === VAT_BASE_CURRENCY ? amount : xeroDocumentAmountToBase(amount, invoice.rate))
    }
  }

  // WOOCOMMERCE. Orders created in the window (widened, cut by GMT creation date), tax lines only.
  const walked = await readWooOrderTaxes(woo, R12_WOO_STATUSES, { after: addDays(windowFrom, -R12_WOO_DATE_MARGIN_DAYS), before: addDays(windowTo, R12_WOO_DATE_MARGIN_DAYS) }, context.wooOptions)
  if (!walked.ok) return inconclusive([LEDGER, XERO, WOO], walked.reason)
  const wooSums: Sums = new Map()
  for (const order of walked.value.orders) {
    const period = order.createdAt.slice(0, 7)
    if (!periodSet.has(period)) continue
    // Fee-line tax: IMS turns a fee line into a sales line (field-mapping.ts mapWcFeeLines) and WooCommerce's tax_total is understood to
    // include it, but that is not proven on the live store, so any fee tax in the window makes the item unverified.
    if (order.feeTaxLines > 0) return inconclusive([LEDGER, XERO, WOO], 'VAT_MAPPING_UNVERIFIED')
    for (const tax of order.taxes) {
      let amount = D(tax.tax)
      if (amount.isZero()) continue
      const mapped = wooRate.get(tax.rateId)
      const place = mapped === undefined ? null : catalogue.place(mapped)
      if (place === null) return inconclusive([LEDGER, XERO, WOO], 'VAT_MAPPING_UNVERIFIED')
      if (order.currency !== VAT_BASE_CURRENCY) {
        // The storefront records no rate: the rate IMS recorded on the linked order is the only one there is.
        const fx = wooFx.get(order.id)
        if (fx === undefined || fx.currency !== order.currency || !D(fx.fxRateToBase).gt(0)) return inconclusive([LEDGER, XERO, WOO], 'CURRENCY_UNKNOWN')
        amount = amount.div(D(fx.fxRateToBase))
      }
      add(wooSums, { period, ...place }, amount)
    }
  }

  const ims = rounded(imsSums)
  const xeroFigures = rounded(xeroSums)
  const wooFigures = rounded(wooSums)
  // Three legs, one comparator: the identity carries the leg, so a key on one side of one leg is a finding of that leg. The legs are a TABLE
  // (R12_LEGS) so that each compares two DIFFERENT sources and the pairs are exactly the three pairs of the three systems.
  const figures = { ims, xero: xeroFigures, woo: wooFigures }
  const result: CompareResult = compareItem('R12', {
    ims: R12_LEGS.flatMap((leg) => rows(leg.label, figures[leg.left])),
    vendor: R12_LEGS.flatMap((leg) => rows(leg.label, figures[leg.right])),
    imsComplete: true,
    vendorComplete: true,
    // Nothing compared is the true answer only when both vendors reported nothing at all for the whole (wider) window.
    emptyProof: invoices.value.total === 0 && walked.value.totals.length > 0 && walked.value.totals.every((entry) => entry.total === 0) && imsRows === 0 ? 'vendor-total-zero' : undefined,
  })
  const verdict = outcomeOfComparison(result)
  return {
    id: 'R12',
    outcome: verdict.outcome,
    reasons: verdict.reasons,
    proof: verdict.outcome === 'pass' && result.status === 'compared' ? result.proof : null,
    sources: [LEDGER, XERO, WOO],
    entries: result.status === 'compared' ? result.buckets : undefined,
  }
}

/** Run R12. With the opt-in absent or anything but true, NOTHING is read: no port is touched and no request is made. Never throws. */
export async function runVatItem(id: VatItemId, context: VatItemContext): Promise<ItemInput> {
  if (context.vendorReads !== true) return { id, outcome: 'inconclusive', reasons: ['VENDOR_READS_OFF'] }
  try {
    return await runR12(context)
  } catch {
    return inconclusive([], 'INTERNAL_ERROR')
  }
}
