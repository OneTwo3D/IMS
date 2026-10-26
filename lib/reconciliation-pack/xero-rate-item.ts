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
 *   IMS POSTINGS (Codex round 2). A record IMS posted (an IMS sync record, connector-confirmed, names its Xero id) is held to the rate that posting CARRIED, converted
 *   by the poster's own helper, not to the table now: the poster sends the stored rate and never looks one up. A second check holds that stored rate to the table
 *   where a date rule is stated in code (a storefront invoice or receipt); other posted records are counted, not table-checked. Records IMS did not post keep the
 *   reconstruction below. An IMS link whose rate cannot be read is IMS_POSTING_UNREADABLE (a finding), never a pass.
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
import type { FxRateRow, ImsRead, ImsReadOptions, XeroPostedRateRow } from '@/lib/reconciliation-pack/ims-readers'
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
  /** Xero documents and payments IMS posted (a connector-confirmed sync record names the Xero id): judged against the rate that posting carried. */
  imsPosted: number
  /** Posted records whose stored rate is not the central table rate under the record's date rule (IMS_POSTED_RATE_NOT_TABLE_RATE). */
  postedRateNotTableRate: number
  /** Posted records whose link or stored rate cannot be read (IMS_POSTING_UNREADABLE). */
  postingUnreadable: number
  /** Posted records of a kind with no verified date rule (not a storefront-imported invoice or receipt): checked against Xero only, not against the table. */
  postedTableNotChecked: number
}

export type RateCheckRows = { ims: SideRow[]; vendor: SideRow[]; summary: RateCheckSummary }

/** The log type that posts each kind of Xero record. */
const POSTED_KIND: Record<string, string> = { SALES_INVOICE: 'sales-invoice', PURCHASE_INVOICE: 'purchase-bill', CREDIT_NOTE: 'sales-cn', PURCHASE_CREDIT_NOTE: 'purchase-cn', INVOICE_PAYMENT: 'payment', BILL_PAYMENT: 'payment' }
const DAY_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/
const validDay = (day: string): boolean => !Number.isNaN(Date.parse(`${day}T00:00:00.000Z`)) && new Date(`${day}T00:00:00.000Z`).toISOString().slice(0, 10) === day
/** A stored IMS rate (1 base = X foreign) as a positive finite decimal, or null. */
function postedRateOf(text: string | null): Prisma.Decimal | null {
  if (text === null || !/^[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(text)) return null
  try { const v = new Prisma.Decimal(text); return v.isFinite() && v.gt(0) ? v : null } catch { return null }
}

const six = (value: Prisma.Decimal): Prisma.Decimal => value.toDecimalPlaces(R16_RATE_DECIMALS, Prisma.Decimal.ROUND_HALF_UP)

/**
 * Judge every document against the IMS rows. Pure: no clock, no database, no network. `fxRows` are the fx_rates rows from the base currency
 * (read in one snapshot); `periods` are the closed months (YYYY-MM) that are in scope.
 */
export function buildRateRows(input: { documents: readonly XeroRateDocument[]; read: XeroRateRead['totals']; deletedPayments: number; setAsideDocuments: number; base: string; fxRows: readonly FxRateRow[]; posted: readonly XeroPostedRateRow[]; periods: readonly string[] }): RateCheckRows {
  const { base } = input
  const periodSet = new Set(input.periods)
  const byCurrency = new Map<string, SelectRow[]>()
  for (const row of input.fxRows) {
    const list = byCurrency.get(row.currency) ?? []
    list.push({ fromCurrency: base, toCurrency: row.currency, rate: row.rate, fetchedAt: new Date(row.fetchedAt), manualOverride: row.manualOverride })
    byCurrency.set(row.currency, list)
  }
  const summary: RateCheckSummary = { periods: [...input.periods], read: { ...input.read }, deletedPayments: input.deletedPayments, setAsideDocuments: input.setAsideDocuments, outsidePeriod: 0, baseCurrency: 0, compared: 0, equal: 0, xeroRateDiffers: 0, imsRateMissing: 0, documentUnreadable: 0, imsPosted: 0, postedRateNotTableRate: 0, postingUnreadable: 0, postedTableNotChecked: 0 }
  const postedById = new Map<string, XeroPostedRateRow[]>()
  for (const row of input.posted) postedById.set(row.externalId.toLowerCase(), [...(postedById.get(row.externalId.toLowerCase()) ?? []), row])
  const ims: SideRow[] = []
  const vendor: SideRow[] = []
  // Sorted, so the evidence order does not depend on the order Xero listed its rows in.
  const documents = [...input.documents].sort((a, b) => (a.kind === b.kind ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.kind < b.kind ? -1 : 1))
  const tableRate = (currency: string, asOf: Date): Prisma.Decimal | null => {
    try {
      const converted = imsRateToXeroCurrencyRate(selectFxRateFromRows(byCurrency.get(currency) ?? [], { baseCurrency: base, currency, asOf }).rate.toNumber())
      return converted === undefined || !D(converted).gt(0) ? null : D(converted)
    } catch (error) {
      if (!isMissingFxRateError(error)) throw error
      return null
    }
  }
  // An IMS posting: the Xero id is named by a connector-confirmed sync record, so the rate to hold Xero to is the one that posting CARRIED (the poster
  // sends the stored rate and never looks one up), converted by the poster's own helper. A second check holds that stored rate to the central table.
  const judgePosted = (document: Extract<XeroRateDocument, { readable: true }>, xeroRate: Prisma.Decimal, linked: readonly XeroPostedRateRow[]): void => {
    summary.imsPosted += 1
    const unreadablePosting = (log: string, why: string): void => { summary.postingUnreadable += 1; vendor.push({ key: [...baseKey(document), sku('ims-posting-unreadable'), sku(log), sku(why)], value: xeroRate.toFixed() }) }
    if (linked.length !== 1) return unreadablePosting('several', 'ambiguous-link')
    const log = linked[0]!
    if (POSTED_KIND[log.type] !== document.kind) return unreadablePosting(log.id, 'kind-mismatch')
    if (log.noPayload) return unreadablePosting(log.id, 'payload-gone')
    if (log.currency === null || log.currency.trim().toUpperCase() !== document.currency) return unreadablePosting(log.id, 'currency-mismatch')
    const posted = postedRateOf(log.rate)
    if (posted === null) return unreadablePosting(log.id, 'rate-unreadable')
    const sent = imsRateToXeroCurrencyRate(posted.toNumber())
    if (sent === undefined || !D(sent).gt(0)) return unreadablePosting(log.id, 'rate-unusable')
    const expectedSent = D(sent)
    const key = [...baseKey(document), sku('ims-posting'), sku(log.id)]
    summary.compared += 1
    if (expectedSent.eq(xeroRate)) summary.equal += 1
    else summary.xeroRateDiffers += 1
    ims.push({ key, value: expectedSent.toFixed() })
    vendor.push({ key, value: xeroRate.toFixed() })
    // Check 2: the stored rate against the central table, under the date rule of the record's kind.
    const day = log.date !== null && DAY_RE.test(log.date.slice(0, 10)) && validDay(log.date.slice(0, 10)) ? log.date.slice(0, 10) : null
    const tableKey = [...baseKey(document), sku('posted-vs-table'), sku(log.id)]
    let candidates: Prisma.Decimal[] | null = null
    if (log.type === 'INVOICE_PAYMENT' && log.wooReceipt) {
      // A storefront receipt: the order's own booked rate when it was paid the day it was ordered, else the central rate at the end of the payment's day.
      if (day === null) return unreadablePosting(log.id, 'date-unreadable')
      const order = postedRateOf(log.orderRate)
      const orderSent = order === null ? undefined : imsRateToXeroCurrencyRate(order.toNumber())
      const table = tableRate(document.currency, endOfBusinessDateUtc(day))
      candidates = [...(table === null ? [] : [table]), ...(orderSent === undefined ? [] : [D(orderSent)])]
    } else if (log.type === 'SALES_INVOICE' && log.wooOrder) {
      // A storefront invoice carries the order's rate fixed at the order's instant, which is not stored; the rule is that it is a central rate in force at some instant of the order's day.
      if (day === null) return unreadablePosting(log.id, 'date-unreadable')
      const instants = [new Date(`${day}T00:00:00.000Z`), endOfBusinessDateUtc(day), ...(byCurrency.get(document.currency) ?? []).filter((r) => r.fetchedAt.toISOString().slice(0, 10) === day).map((r) => r.fetchedAt)]
      candidates = []
      for (const instant of instants) { const t = tableRate(document.currency, instant); if (t !== null) candidates.push(t) }
    }
    if (candidates === null) { summary.postedTableNotChecked += 1; return }
    if (candidates.length === 0) {
      summary.imsRateMissing += 1
      vendor.push({ key: [...tableKey, sku('ims-rate-missing')], value: expectedSent.toFixed() })
      return
    }
    if (candidates.some((c) => c.eq(expectedSent))) return
    summary.postedRateNotTableRate += 1
    ims.push({ key: tableKey, value: candidates[0]!.toFixed() })
    vendor.push({ key: tableKey, value: expectedSent.toFixed() })
  }
  for (const document of documents) {
    if (document.date !== null && !periodSet.has(document.date.slice(0, 7))) { summary.outsidePeriod += 1; continue }
    if (document.readable && document.currency === base) { summary.baseCurrency += 1; continue }
    const unreadable = (): void => { summary.documentUnreadable += 1; vendor.push({ key: [...baseKey(document), sku('document-unreadable')], value: '0' }) }
    if (!document.readable || document.rate === null) { unreadable(); continue }
    const xero = six(D(document.rate))
    // A Xero rate that rounds to nothing at six places cannot be compared: it is not a rate.
    if (!xero.gt(0)) { unreadable(); continue }
    const linked = postedById.get(document.id)
    if (linked !== undefined) {
      judgePosted(document, xero, linked)
      continue
    }
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
  return `periods ${s.periods.join(',')}; read ${s.read.invoices} invoices and bills, ${s.read.creditNotes} credit notes, ${s.read.payments} payments (${s.deletedPayments} deleted payments, ${s.setAsideDocuments} voided or deleted documents set aside as out of scope); ${s.outsidePeriod} outside the periods, ${s.baseCurrency} in the base currency (out of scope); ${s.compared} foreign compared (${s.equal} equal, ${s.xeroRateDiffers} differ), ${s.imsRateMissing} without an IMS rate, ${s.documentUnreadable} unreadable; ${s.imsPosted} posted by IMS (held to the rate the posting carried; ${s.postedRateNotTableRate} not the table rate, ${s.postingUnreadable} posting unreadable, ${s.postedTableNotChecked} with no table rule)`
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
  const read = await readIms({ sections: ['baseCurrency', 'fxRates', 'xeroPostedRates'] })
  if (!read.ok) return none(inconclusive([IMS], read.reason))
  const failed = (['baseCurrency', 'fxRates', 'xeroPostedRates'] as const).flatMap((name) => {
    const section = read.sections[name]
    return section === undefined ? ['SOURCE_UNREADABLE' as const] : section.ok ? [] : [section.reason]
  })
  if (failed.length > 0) return none(inconclusive([IMS], ...failed))
  const posted = (read.sections.xeroPostedRates as { ok: true; value: XeroPostedRateRow[] }).value
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

  const rows = buildRateRows({ documents: documents.value.documents, read: documents.value.totals, deletedPayments: documents.value.deletedPayments, setAsideDocuments: documents.value.setAsideDocuments, base: base.value, fxRows, posted, periods })
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
    if (s.postedRateNotTableRate > 0) specific.push('IMS_POSTED_RATE_NOT_TABLE_RATE')
    if (s.postingUnreadable > 0) specific.push('IMS_POSTING_UNREADABLE')
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
