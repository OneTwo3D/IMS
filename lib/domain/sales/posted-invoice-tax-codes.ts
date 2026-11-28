/**
 * THE TAX CODES A SALES INVOICE WAS POSTED WITH, read back from the invoice's own sync record.
 *
 * Owner ruling: once an invoice is posted, its refunds and credit notes reverse its goods lines, its discount and its shipping on the codes the INVOICE POSTED WITH. A tax rate remapped to another
 * accounting code afterwards (an in-place edit of the rate: no row keeps the old code) only affects invoices not yet posted; a credit note that read the rate's current code instead would move VAT
 * between codes (and VAT boxes) in the ledger.
 *
 * The record is the payload of the order's NEWEST sync row of type SALES_INVOICE / SALES_INVOICE_UPDATE that names the document (what was sent). Each goods line, each part of a per-rate discount, the
 * header discount and the shipping carry the id of the tax rate their code was read from (`taxRateId`, `discountTaxRateId`, `shippingTaxRateId`: bindings the ledger never sees), so a code is looked up by rate id,
 * never by position. A code is returned only when the record states it unambiguously AND binds it to a rate (a payload the EU treatment retyped has lost its bindings): anything else answers null and the
 * caller keeps its existing derivation (the rate's current code), which is also what an order with no posted invoice does.
 *
 * PRICING. The old code may now be on no TaxRate row at all (the remap edits the rate in place), so the rate a posted code carried is the PERCENTAGE of the rate the record binds it to (a remap does not
 * change it): `ratesByCode` holds those pairs (a reverse-charged rate is left out: its code is the swap code, priced from its own mapping) and `withPostedCodeRates` unions them into a rate index, so a code
 * mapped on both sides to different rates still reads as ambiguous.
 */
import type { db } from '@/lib/db'
import { PROVEN_LEDGER_FACT_WHERE } from '@/lib/domain/accounting/ledger-standing'
import { toDecimal } from '@/lib/domain/math/decimal'
import type { DiscountTaxSplitEntry } from '@/lib/domain/sales/discount-tax-split'
import { buildTaxTypeRateIndex, type TaxTypeRateIndex } from '@/lib/domain/sales/refund-posted-tax-identity'

export type PostedInvoiceTaxCodes = {
  /** rate id -> the (post reverse-charge-swap) code its goods lines were posted on. */
  lineCodeByRateId: ReadonlyMap<string, string>
  /** rate id -> the code its discount part was posted on (only when the invoice carried per-rate discount parts). */
  discountCodeByRateId: ReadonlyMap<string, string>
  /** The code the invoice's discount parts without a rate of their own were posted on (the order default's), or null. */
  orderDefaultDiscountCode: string | null
  /** True when the invoice carried per-rate discount parts (an apportioned order's discount). */
  hasDiscountParts: boolean
  /** The code the single (header-rate) discount line was posted on, when it names the rate it was read from; else null. */
  headerDiscountCode: string | null
  /** The code the shipping line was posted on, when it names the rate it was read from; else null. */
  shippingCode: string | null
  /** code -> the ids of the rates the record bound it to (every goods line, discount part, header discount and shipping). */
  rateIdsByCode: ReadonlyMap<string, ReadonlySet<string>>
  /** code -> the normalised percentages of those rates, filled by the reader (empty from the pure parse). */
  ratesByCode: ReadonlyMap<string, ReadonlySet<string>>
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value : null)

/** rate id -> code over a list of payload objects; a rate the record gives two different codes is left out (ambiguous, never guessed). */
function codesByRate(items: unknown): Map<string, string> {
  const out = new Map<string, string>()
  const ambiguous = new Set<string>()
  if (!Array.isArray(items)) return out
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const rateId = text(record.taxRateId)
    const code = text(record.taxType)
    if (!rateId || !code) continue
    const known = out.get(rateId)
    if (known !== undefined && known !== code) ambiguous.add(rateId)
    out.set(rateId, code)
  }
  for (const id of ambiguous) out.delete(id)
  return out
}

/** The posted codes a sent invoice payload states, or null when it is not an invoice payload with lines. */
export function postedTaxCodesFromPayload(payload: unknown): PostedInvoiceTaxCodes | null {
  if (typeof payload !== 'object' || payload === null) return null
  const record = payload as Record<string, unknown>
  if (!Array.isArray(record.lines)) return null
  const parts = Array.isArray(record.discountParts) ? record.discountParts : []
  const noRateCodes = new Set<string>()
  for (const part of parts) {
    if (typeof part !== 'object' || part === null) continue
    const p = part as Record<string, unknown>
    const code = text(p.taxType)
    if (code && !text(p.taxRateId)) noRateCodes.add(code)
  }
  const lineCodeByRateId = codesByRate(record.lines)
  const discountCodeByRateId = codesByRate(parts)
  const headerDiscountCode = text(record.discountTaxRateId) ? text(record.discountTaxType) : null
  const shippingCode = text(record.shippingTaxRateId) ? text(record.shippingTaxType) : null
  const rateIdsByCode = new Map<string, Set<string>>()
  const bind = (code: string | null, rateId: string | null) => {
    if (!code || !rateId) return
    const set = rateIdsByCode.get(code) ?? new Set<string>()
    set.add(rateId)
    rateIdsByCode.set(code, set)
  }
  for (const [rateId, code] of lineCodeByRateId) bind(code, rateId)
  for (const [rateId, code] of discountCodeByRateId) bind(code, rateId)
  bind(headerDiscountCode, text(record.discountTaxRateId))
  bind(shippingCode, text(record.shippingTaxRateId))
  return {
    lineCodeByRateId,
    discountCodeByRateId,
    orderDefaultDiscountCode: parts.length > 0 ? (noRateCodes.size === 1 ? [...noRateCodes][0]! : text(record.discountTaxType)) : null,
    hasDiscountParts: parts.length > 0,
    headerDiscountCode,
    shippingCode,
    rateIdsByCode,
    ratesByCode: new Map(),
  }
}

/**
 * The tax codes the order's posted invoice carries, or null when the order has no posted invoice (`accountingInvoiceId` null) or no usable record of it (a Xeroom-posted or hand-linked invoice has no row
 * here): the caller then reads the rates' current codes, as before.
 *
 * WHICH ROW. The NEWEST row (createdAt, then id) of type SALES_INVOICE / SALES_INVOICE_UPDATE that names the document, by its `externalTransactionId` or, for an update not yet confirmed, by the
 * `accountingInvoiceId` in its payload. It must be a row the ledger holds (PROVEN_LEDGER_FACT_WHERE: the connector's own basis, never a shadow or an operator assertion) with a readable payload. If the newest
 * row is anything else (an accepted update still in flight, an asserted one, a compacted payload) the answer is null: the record is not trusted to say what the document carries, and an OLDER version is never
 * read in its place.
 */
export async function readPostedInvoiceTaxCodes(
  client: Pick<typeof db, 'accountingSyncLog' | 'taxRate'>,
  orderId: string,
  accountingInvoiceId: string | null | undefined,
): Promise<PostedInvoiceTaxCodes | null> {
  if (!accountingInvoiceId) return null
  const newest = await client.accountingSyncLog.findFirst({
    where: {
      connector: 'xero',
      type: { in: ['SALES_INVOICE', 'SALES_INVOICE_UPDATE'] },
      referenceType: 'SalesOrder',
      referenceId: orderId,
      OR: [{ externalTransactionId: accountingInvoiceId }, { payload: { path: ['accountingInvoiceId'], equals: accountingInvoiceId } }],
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true },
  })
  if (!newest) return null
  const proven = await client.accountingSyncLog.findFirst({ where: { AND: [PROVEN_LEDGER_FACT_WHERE, { id: newest.id }] }, select: { payload: true } })
  const codes = proven ? postedTaxCodesFromPayload(proven.payload) : null
  if (!codes) return null
  const rateIds = [...new Set([...codes.rateIdsByCode.values()].flatMap((ids) => [...ids]))]
  if (rateIds.length === 0) return codes
  // A reverse-charged rate is not priced from its own percentage: its posted code is the swap code.
  const rates = await client.taxRate.findMany({ where: { id: { in: rateIds }, reverseCharge: false }, select: { id: true, rate: true } })
  const pctById = new Map(rates.map((r) => [r.id, toDecimal(r.rate).toString()] as const))
  const ratesByCode = new Map<string, Set<string>>()
  for (const [code, ids] of codes.rateIdsByCode) {
    const pcts = new Set<string>()
    for (const id of ids) { const pct = pctById.get(id); if (pct !== undefined) pcts.add(pct) }
    if (pcts.size > 0) ratesByCode.set(code, pcts)
  }
  return { ...codes, ratesByCode }
}

/** The rate index with the posted codes' rates unioned in (a code the table no longer maps is priced at the rate it was posted at; one mapped to a different rate stays ambiguous). */
export function withPostedCodeRates(index: TaxTypeRateIndex, posted: PostedInvoiceTaxCodes | null): TaxTypeRateIndex {
  if (!posted || posted.ratesByCode.size === 0) return index
  const out: TaxTypeRateIndex = new Map([...index].map(([code, rates]) => [code, new Set(rates)] as const))
  for (const [code, pcts] of posted.ratesByCode) {
    const set = out.get(code) ?? new Set<string>()
    for (const pct of pcts) set.add(pct)
    out.set(code, set)
  }
  return out
}

/** `buildTaxTypeRateIndex` over the current sales rates, with the posted codes' rates unioned in. */
export function postedAwareRateIndex(taxRates: readonly { accountingTaxType?: string | null; rate?: Parameters<typeof buildTaxTypeRateIndex>[0][number]['rate'] }[], posted: PostedInvoiceTaxCodes | null): TaxTypeRateIndex {
  return withPostedCodeRates(buildTaxTypeRateIndex(taxRates), posted)
}

/** The code a goods line at this rate was posted on, or null when the order has no posted record of it. */
export function postedLineTaxType(posted: PostedInvoiceTaxCodes | null, taxRateId: string | null | undefined): string | null {
  if (!posted || !taxRateId) return null
  return posted.lineCodeByRateId.get(taxRateId) ?? null
}

/**
 * The code this split group's discount part was posted on, or null when the invoice carried no per-rate parts or does not state it. A group with a rate: its part's code, else its goods lines' code
 * (one derivation for both). A group with no rate: the parts' order-default code.
 */
export function postedDiscountTaxType(posted: PostedInvoiceTaxCodes | null, entry: Pick<DiscountTaxSplitEntry, 'taxRateId'>): string | null {
  if (!posted || !posted.hasDiscountParts) return null
  if (entry.taxRateId) return posted.discountCodeByRateId.get(entry.taxRateId) ?? posted.lineCodeByRateId.get(entry.taxRateId) ?? null
  return posted.orderDefaultDiscountCode
}

/** The code the single header-rate discount line was posted on (an order with no per-rate parts), or null. */
export function postedHeaderDiscountTaxType(posted: PostedInvoiceTaxCodes | null): string | null {
  return posted && !posted.hasDiscountParts ? posted.headerDiscountCode : null
}

/** The code the shipping line was posted on, or null. */
export function postedShippingTaxType(posted: PostedInvoiceTaxCodes | null): string | null {
  return posted?.shippingCode ?? null
}

/** lineId -> the code that order line was posted on, for every line whose rate the posted record states (a line with no rate, or an unstated one, is absent: its code is derived as before). */
export function postedTaxTypeByLineId(
  lines: ReadonlyArray<{ id: string; taxRateId?: string | null }>,
  posted: PostedInvoiceTaxCodes | null,
): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of lines) {
    const code = postedLineTaxType(posted, line.taxRateId)
    if (code) out.set(line.id, code)
  }
  return out
}
