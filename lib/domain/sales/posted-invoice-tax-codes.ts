/**
 * THE TAX CODES A SALES INVOICE WAS POSTED WITH, read back from the invoice's own sync record.
 *
 * Owner ruling: once an invoice is posted, its refunds and credit notes reverse its goods lines and its discount on the codes the INVOICE POSTED WITH. A tax rate remapped to another
 * accounting code afterwards only affects invoices not yet posted; a credit note that read the rate's current code instead would move VAT between codes (and VAT boxes) in the ledger.
 *
 * The record is the payload of the order's SYNCED SALES_INVOICE / SALES_INVOICE_UPDATE row (what was sent; the latest such row is what the ledger holds now). Each goods line, and each part of a
 * per-rate discount, carries the id of the tax rate its code was read from (`taxRateId`, never sent to the ledger), so a rate's posted code is looked up by rate id, never by position. A code is
 * returned only when the record states it unambiguously; anything else answers null and the caller keeps its existing derivation (the rate's current code), which is also what an order with no
 * posted invoice does. Pure apart from the one read in `readPostedInvoiceTaxCodes`.
 */
import type { db } from '@/lib/db'
import { PROVEN_LEDGER_FACT_WHERE } from '@/lib/domain/accounting/ledger-standing'
import type { DiscountTaxSplitEntry } from '@/lib/domain/sales/discount-tax-split'

export type PostedInvoiceTaxCodes = {
  /** rate id -> the (post reverse-charge-swap) code its goods lines were posted on. */
  lineCodeByRateId: ReadonlyMap<string, string>
  /** rate id -> the code its discount part was posted on (only when the invoice carried per-rate discount parts). */
  discountCodeByRateId: ReadonlyMap<string, string>
  /** The code the invoice's discount parts without a rate of their own were posted on (the order default's), or null. */
  orderDefaultDiscountCode: string | null
  /** True when the invoice carried per-rate discount parts (an apportioned order's discount). */
  hasDiscountParts: boolean
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
  return {
    lineCodeByRateId: codesByRate(record.lines),
    discountCodeByRateId: codesByRate(parts),
    orderDefaultDiscountCode: parts.length > 0 ? (noRateCodes.size === 1 ? [...noRateCodes][0]! : text(record.discountTaxType)) : null,
    hasDiscountParts: parts.length > 0,
  }
}

/**
 * The tax codes the order's posted invoice carries, or null when the order has no posted invoice (`accountingInvoiceId` null) or no readable record of it (a Xeroom-posted or hand-linked invoice has
 * no row here): the caller then reads the rates' current codes, as before. Only a row the ledger holds counts (PROVEN_LEDGER_FACT_WHERE: a shadow or failed one posted nothing); the latest synced wins, because an update replaces the
 * document's lines.
 */
export async function readPostedInvoiceTaxCodes(
  client: Pick<typeof db, 'accountingSyncLog'>,
  orderId: string,
  accountingInvoiceId: string | null | undefined,
): Promise<PostedInvoiceTaxCodes | null> {
  if (!accountingInvoiceId) return null
  const rows = await client.accountingSyncLog.findMany({
    // A row the ledger holds (ledger-standing.ts: the connector's own basis, naming the document): never a shadow or an operator-asserted one.
    where: { AND: [PROVEN_LEDGER_FACT_WHERE, { type: { in: ['SALES_INVOICE', 'SALES_INVOICE_UPDATE'] }, referenceType: 'SalesOrder', referenceId: orderId, externalTransactionId: accountingInvoiceId }] },
    orderBy: [{ syncedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
    select: { payload: true },
    take: 5,
  })
  for (const row of rows) {
    const codes = postedTaxCodesFromPayload(row.payload)
    if (codes) return codes
  }
  return null
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
