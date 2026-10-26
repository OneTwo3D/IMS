/**
 * ITEM R16: THE XERO RATE CHECK. Every foreign-currency Xero document and payment of the pack's period carries the IMS central rate.
 *
 * The owner ruled (2026-10-24) that every exchange rate comes from one central table, fx_rates (fed by Aelia), and that Xero uses IMS's rates:
 * IMS sends its own CurrencyRate on every foreign document and payment (connectors/xero/fx.ts). This item checks that Xero holds it.
 *
 * Behind the explicit opt-in (--vendor-reads-only), like every item that reads a vendor: without it nothing is read, no port is touched and no
 * request is made (VENDOR_READS_OFF). The module is total: whatever it is handed it returns an item and never throws; whatever cannot be proven
 * is inconclusive with closed reasons, and a Xero read that is incomplete or unproven is NEVER a pass.
 *
 *   PERIOD. The same as R12 (vat-item.ts r12ClosedPeriods): the latest R12_WINDOW_MONTHS calendar months (UTC) closed for the cycle date. Xero is
 *   asked for the window widened by R12_XERO_DATE_MARGIN_DAYS each side and every row is then cut by its own date.
 *
 *   POPULATION. Every invoice, bill and credit note in a status of DRAFT, SUBMITTED, AUTHORISED or PAID (a document IMS posted is checked from the
 *   moment it exists, not only once approved) and every payment (not DELETED) dated in the period, read as proven complete lists (xero-rate-source.ts).
 *   VOIDED and DELETED documents are read too and are OUT OF SCOPE by decision: a voided or deleted document is reversed or removed and books
 *   nothing, so its CurrencyRate is not a booked rate; they are counted in the summary (never silently dropped), as a deleted payment is. Any other
 *   status makes the read unreadable (inconclusive). A document in the organisation's base currency is OUT OF SCOPE: it is counted in
 *   the summary and never listed. Xero's base currency and IMS's must both be GBP (the fx_rates table is read from GBP), else BASE_CURRENCY_NOT_GBP.
 *
 *   THE RATE RULE. A business date maps to the END of that day, UTC (endOfBusinessDateUtc, lib/currencies/fx-select.ts: the one date rule). The
 *   IMS rate is selectFxRateFromRows over the fx_rates rows read in one snapshot, with that instant (the pure half of lib/currencies/fx-lookup.ts
 *   getFxRateToBase: the latest row on or before the instant, a tie accepted only when the rows agree, a bad row refused). IMS stores 1 base = r
 *   foreign; Xero's CurrencyRate is 1 foreign = x base, so the IMS rate is converted by imsRateToXeroCurrencyRate (x = 1 / r, six decimals: the
 *   function that produced the rate IMS sent). Both rates are then rounded half up to six decimal places and must be EQUAL: the catalogue's
 *   tolerance is absolute 0, so a difference of one millionth is a finding.
 *
 *   FINDINGS, each a closed reason (the item fails with DIFFERENCES and the specific reasons):
 *     XERO_RATE_DIFFERS    both rates exist and differ: listed as a pair (the IMS rate in Xero's convention against Xero's).
 *     IMS_RATE_MISSING     no usable IMS rate at the document date (no row, a rate that is not positive, or an ambiguous tie, with the refusal
 *                          reason of the lookup in the identity): listed under the Xero rate, nothing on the IMS side.
 *     DOCUMENT_UNREADABLE  the document's own date, currency or CurrencyRate cannot be used (a foreign document with NO CurrencyRate is this,
 *                          never a rate of 1): listed with the value 0, which Xero never records as a rate.
 *
 *   IDENTITIES are deterministic: `xero-rate|<kind>|<xero id>` (kind: sales-invoice, purchase-bill, sales-cn, purchase-cn, payment), with the
 *   tail `|ims-rate-missing|<refusal reason>` or `|document-unreadable` on a finding that has no pair. Nothing else goes into an identity.
 *
 *   EMPTY. Nothing to compare passes only on the named proof that every list was proven complete and none holds a foreign-currency document.
 *
 *   SUMMARY (summariseRateCheck): the counts of what was read and how each row was judged, so a pass says what it covered.
 */

import { Prisma } from '@/app/generated/prisma/client'
import { compareItem, outcomeOfComparison, type SideRow } from '@/lib/reconciliation-pack/compare'
import {
  R12_WINDOW_MONTHS,
  R12_XERO_DATE_MARGIN_DAYS,
  R16_RATE_DECIMALS,
  R16_XERO_REQUEST_BUDGET,
  VAT_BASE_CURRENCY,
  type PackReasonCode,
  type PackSourceCode,
} from '@/lib/reconciliation-pack/constants'
import { imsRateToXeroCurrencyRate } from '@/lib/connectors/xero/fx'
import { endOfBusinessDateUtc, isMissingFxRateError, selectFxRateFromRows, type FxRateRow as SelectRow } from '@/lib/currencies/fx-select'
import type { KeyPart } from '@/lib/reconciliation-pack/identity'
import type { FxRateRow, ImsRead, ImsReadOptions } from '@/lib/reconciliation-pack/ims-readers'
import type { ItemInput } from '@/lib/reconciliation-pack/report'
import { addDays, r12ClosedPeriods, type XeroVatVendor } from '@/lib/reconciliation-pack/vat-item'
import { readXeroRateDocuments, type XeroRateDocument, type XeroRateRead } from '@/lib/reconciliation-pack/xero-rate-source'
import { makeXeroWalker, readXeroBaseCurrency, type XeroSourceOptions } from '@/lib/reconciliation-pack/xero-source'

export const XERO_RATE_ITEM_IDS = ['R16'] as const
export type XeroRateItemId = (typeof XERO_RATE_ITEM_IDS)[number]
export function isXeroRateItem(id: string): id is XeroRateItemId {
  return (XERO_RATE_ITEM_IDS as readonly string[]).includes(id)
}

export type XeroRateItemContext = {
  asOf: string
  /** The explicit opt-in. Anything but the boolean true is "off". */
  vendorReads?: boolean
  vendor?: { xero?: XeroVatVendor }
  ims?: (options: ImsReadOptions) => Promise<ImsRead>
  /** Test seam for pacing and budget. */
  xeroOptions?: XeroSourceOptions
}

const IMS: PackSourceCode = 'ims-database'
const XERO: PackSourceCode = 'xero-api'

const inconclusive = (sources: readonly PackSourceCode[], ...reasons: PackReasonCode[]): ItemInput => ({ id: 'R16', outcome: 'inconclusive', reasons: [...new Set(reasons)], sources: [...sources] })

const D = (value: string | number): Prisma.Decimal => new Prisma.Decimal(value)
const sku = (raw: string): KeyPart => ({ kind: 'sku', raw })
const baseKey = (document: Pick<XeroRateDocument, 'kind' | 'id'>): KeyPart[] => [sku('xero-rate'), sku(document.kind), sku(document.id)]

export type RateCheckSummary = {
  /** The closed months asked about. */
  periods: string[]
  /** Rows Xero reported per list (documents, credit notes, payments), deleted payments included. */
  read: { invoices: number; creditNotes: number; payments: number }
  deletedPayments: number
  /** Invoices, bills and credit notes read as VOIDED or DELETED: out of scope, counted. */
  setAsideDocuments: number
  /** Rows read that are dated outside the periods (the widened margin) and so not judged. */
  outsidePeriod: number
  /** Documents and payments in the base currency: out of scope. */
  baseCurrency: number
  /** Foreign documents with a readable date, currency and rate, whose IMS rate was found: compared. */
  compared: number
  equal: number
  xeroRateDiffers: number
  imsRateMissing: number
  documentUnreadable: number
}

export type RateCheckRows = { ims: SideRow[]; vendor: SideRow[]; summary: RateCheckSummary }

const six = (value: Prisma.Decimal): Prisma.Decimal => value.toDecimalPlaces(R16_RATE_DECIMALS, Prisma.Decimal.ROUND_HALF_UP)

/**
 * Judge every document against the IMS rows. Pure: no clock, no database, no network. `fxRows` are the fx_rates rows from the base currency
 * (read in one snapshot); `periods` are the closed months (YYYY-MM) that are in scope.
 */
export function buildRateRows(input: { documents: readonly XeroRateDocument[]; read: XeroRateRead['totals']; deletedPayments: number; setAsideDocuments: number; base: string; fxRows: readonly FxRateRow[]; periods: readonly string[] }): RateCheckRows {
  const { base } = input
  const periodSet = new Set(input.periods)
  const byCurrency = new Map<string, SelectRow[]>()
  for (const row of input.fxRows) {
    const list = byCurrency.get(row.currency) ?? []
    list.push({ fromCurrency: base, toCurrency: row.currency, rate: row.rate, fetchedAt: new Date(row.fetchedAt), manualOverride: row.manualOverride })
    byCurrency.set(row.currency, list)
  }
  const summary: RateCheckSummary = { periods: [...input.periods], read: { ...input.read }, deletedPayments: input.deletedPayments, setAsideDocuments: input.setAsideDocuments, outsidePeriod: 0, baseCurrency: 0, compared: 0, equal: 0, xeroRateDiffers: 0, imsRateMissing: 0, documentUnreadable: 0 }
  const ims: SideRow[] = []
  const vendor: SideRow[] = []
  // Sorted, so the evidence order does not depend on the order Xero listed its rows in.
  const documents = [...input.documents].sort((a, b) => (a.kind === b.kind ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.kind < b.kind ? -1 : 1))
  for (const document of documents) {
    if (document.date !== null && !periodSet.has(document.date.slice(0, 7))) { summary.outsidePeriod += 1; continue }
    if (document.readable && document.currency === base) { summary.baseCurrency += 1; continue }
    const unreadable = (): void => { summary.documentUnreadable += 1; vendor.push({ key: [...baseKey(document), sku('document-unreadable')], value: '0' }) }
    if (!document.readable || document.rate === null) { unreadable(); continue }
    const xero = six(D(document.rate))
    // A Xero rate that rounds to nothing at six places cannot be compared: it is not a rate.
    if (!xero.gt(0)) { unreadable(); continue }
    let missing: string | null = null
    let expected: Prisma.Decimal | null = null
    try {
      const selected = selectFxRateFromRows(byCurrency.get(document.currency) ?? [], { baseCurrency: base, currency: document.currency, asOf: endOfBusinessDateUtc(document.date) })
      const converted = imsRateToXeroCurrencyRate(selected.rate.toNumber())
      if (converted === undefined || !D(converted).gt(0)) missing = 'non-positive-rate'
      else expected = D(converted) // already rounded to six places by the function that produced the rate IMS sent
    } catch (error) {
      if (!isMissingFxRateError(error)) throw error
      missing = error.reason.replace(/_/g, '-')
    }
    if (missing !== null || expected === null) {
      summary.imsRateMissing += 1
      vendor.push({ key: [...baseKey(document), sku('ims-rate-missing'), sku(missing ?? 'no-rate')], value: xero.toFixed() })
      continue
    }
    summary.compared += 1
    if (expected.eq(xero)) summary.equal += 1
    else summary.xeroRateDiffers += 1
    ims.push({ key: baseKey(document), value: expected.toFixed() })
    vendor.push({ key: baseKey(document), value: xero.toFixed() })
  }
  return { ims, vendor, summary }
}

/** The one-line account of a run, for the PR and for a person reading the evidence: what was read and how each row was judged. */
export function summariseRateCheck(summary: RateCheckSummary): string {
  const s = summary
  return `periods ${s.periods.join(',')}; read ${s.read.invoices} invoices and bills, ${s.read.creditNotes} credit notes, ${s.read.payments} payments (${s.deletedPayments} deleted payments, ${s.setAsideDocuments} voided or deleted documents set aside as out of scope); ${s.outsidePeriod} outside the periods, ${s.baseCurrency} in the base currency (out of scope); ${s.compared} foreign compared (${s.equal} equal, ${s.xeroRateDiffers} differ), ${s.imsRateMissing} without an IMS rate, ${s.documentUnreadable} unreadable`
}

export type XeroRateRun = { item: ItemInput; summary: RateCheckSummary | null }

export async function runXeroRateCheck(context: XeroRateItemContext): Promise<XeroRateRun> {
  const none = (item: ItemInput): XeroRateRun => ({ item, summary: null })
  const xero = context.vendor?.xero
  const readIms = context.ims
  if (xero === undefined || readIms === undefined) return none(inconclusive([], 'SOURCE_UNREADABLE'))

  const periods = r12ClosedPeriods(context.asOf, R12_WINDOW_MONTHS)
  if (periods === null) return none(inconclusive([], 'STALE_BASIS'))
  const windowFrom = `${periods[0]}-01`
  const last = periods[periods.length - 1]!
  const [y, m] = last.split('-').map(Number) as [number, number]
  const windowTo = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`

  // The IMS side first, in ONE snapshot, before any request is made to the vendor.
  const read = await readIms({ sections: ['baseCurrency', 'fxRates'] })
  if (!read.ok) return none(inconclusive([IMS], read.reason))
  const failed = (['baseCurrency', 'fxRates'] as const).flatMap((name) => {
    const section = read.sections[name]
    return section === undefined ? ['SOURCE_UNREADABLE' as const] : section.ok ? [] : [section.reason]
  })
  if (failed.length > 0) return none(inconclusive([IMS], ...failed))
  const imsBase = (read.sections.baseCurrency as { ok: true; value: string }).value
  const fxRows = (read.sections.fxRates as { ok: true; value: FxRateRow[] }).value
  if (imsBase !== VAT_BASE_CURRENCY) return none(inconclusive([IMS], 'BASE_CURRENCY_NOT_GBP'))

  const walker = makeXeroWalker(xero.port, { budget: R16_XERO_REQUEST_BUDGET, ...context.xeroOptions })
  const start = await xero.binding()
  if (start === null) return none(inconclusive([IMS, XERO], 'XERO_CONNECTION_UNUSABLE'))
  const base = await readXeroBaseCurrency(walker)
  if (!base.ok) return none(inconclusive([IMS, XERO], base.reason === 'SOURCE_UNREADABLE' ? 'XERO_CONNECTION_UNUSABLE' : base.reason))
  if (base.value !== imsBase) return none(inconclusive([IMS, XERO], 'BASE_CURRENCY_NOT_GBP'))
  const documents = await readXeroRateDocuments(walker, { from: addDays(windowFrom, -R12_XERO_DATE_MARGIN_DAYS), toExclusive: addDays(windowTo, R12_XERO_DATE_MARGIN_DAYS) })
  if (!documents.ok) return none(inconclusive([IMS, XERO], documents.reason))
  const end = await xero.binding()
  if (end === null || end.tenantId !== start.tenantId || end.connectionGeneration !== start.connectionGeneration) return none(inconclusive([IMS, XERO], 'XERO_CONNECTION_UNUSABLE'))

  const rows = buildRateRows({ documents: documents.value.documents, read: documents.value.totals, deletedPayments: documents.value.deletedPayments, setAsideDocuments: documents.value.setAsideDocuments, base: base.value, fxRows, periods })
  const s = rows.summary
  const result = compareItem('R16', {
    ims: rows.ims,
    vendor: rows.vendor,
    imsComplete: true,
    vendorComplete: true,
    // Used by the comparator only when nothing at all was judged: every list was proven above, so then there is no foreign-currency document.
    emptyProof: 'no-foreign-currency-documents',
  })
  const verdict = outcomeOfComparison(result)
  const specific: PackReasonCode[] = []
  if (verdict.outcome === 'fail') {
    if (s.xeroRateDiffers > 0) specific.push('XERO_RATE_DIFFERS')
    if (s.imsRateMissing > 0) specific.push('IMS_RATE_MISSING')
    if (s.documentUnreadable > 0) specific.push('DOCUMENT_UNREADABLE')
  }
  return {
    item: {
      id: 'R16',
      outcome: verdict.outcome,
      reasons: [...new Set([...verdict.reasons, ...specific])],
      proof: verdict.outcome === 'pass' && result.status === 'compared' ? result.proof : null,
      sources: [IMS, XERO],
      entries: result.status === 'compared' ? result.buckets : undefined,
    },
    summary: rows.summary,
  }
}

/** Run R16. With the opt-in absent or anything but true, NOTHING is read: no port is touched and no request is made. Never throws. */
export async function runXeroRateItem(id: XeroRateItemId, context: XeroRateItemContext): Promise<ItemInput> {
  if (context.vendorReads !== true) return { id, outcome: 'inconclusive', reasons: ['VENDOR_READS_OFF'] }
  try {
    return (await runXeroRateCheck(context)).item
  } catch {
    return inconclusive([], 'INTERNAL_ERROR')
  }
}
