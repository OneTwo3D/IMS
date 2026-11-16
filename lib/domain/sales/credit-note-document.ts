/**
 * The rows and totals of a printed credit note.
 *
 * Two sources, one finishing step:
 *   · POSTED: a refund whose credit note has been staged for the ledger (an AccountingSyncLog CREDIT_NOTE row with a payload) is
 *     printed from THAT payload, line for line: what was posted or queued, not what the refund would be priced at today. Its VAT uses
 *     only frozen figures (the refund line's own snapshot, else the order line's stored VAT/net), never the live tax-rate table, so a
 *     later settings change cannot change a posted credit note's PDF. A scheme (EU) credit note carries its VAT as its own payload
 *     line, so its goods lines print no VAT of their own.
 *   · DRAFT: a refund that was never staged is recalculated (credit-note-display.ts) and the PDF is labelled "Draft".
 *
 * The total is rounded ONCE from the unrounded amounts; rows are rounded for display, and any difference is printed as an explicit
 * "Rounding" row, so the printed rows always sum to the printed total.
 */
import { lineVatRate, type CreditNoteLineFacts, type MoneyViewLine, type RefundAmounts } from '@/lib/domain/sales/sales-order-money-view'
import { currencyMinorUnits } from '@/lib/domain/math/decimal'

export type CreditNoteDocumentRow = { description: string; qty: number; net: number; vat: number; gross: number }
export type RawCreditNoteLine = { description: string; qty: number; net: number; vat: number }
/** `digits` is the document currency's minor-unit precision: every figure here is rounded to it and must be printed with it. */
export type CreditNoteDocumentModel = { rows: CreditNoteDocumentRow[]; rounding: RefundAmounts | null; total: RefundAmounts; digits: number }

/** Round each row for display, the total once from the unrounded sums, and expose the difference as a Rounding amount. All at the currency's minor units. */
export function finishCreditNoteRows(lines: ReadonlyArray<RawCreditNoteLine>, currency: string | null | undefined): CreditNoteDocumentModel {
  const digits = currencyMinorUnits(currency)
  // decimal-boundary-ok: display-only rounding of figures already stored/posted; nothing here is written back
  const roundTo = (n: number): number => {
    const f = 10 ** digits
    return Math.round((n + Number.EPSILON) * f) / f
  }
  const rows = lines.map((l) => {
    const net = roundTo(l.net)
    const vat = roundTo(l.vat)
    return { description: l.description, qty: l.qty, net, vat, gross: roundTo(net + vat) }
  })
  const rawNet = lines.reduce((s, l) => s + l.net, 0)
  const rawVat = lines.reduce((s, l) => s + l.vat, 0)
  const total = { net: roundTo(rawNet), vat: roundTo(rawVat), gross: roundTo(rawNet + rawVat) }
  const diff = {
    net: roundTo(total.net - rows.reduce((s, r) => s + r.net, 0)),
    vat: roundTo(total.vat - rows.reduce((s, r) => s + r.vat, 0)),
    gross: roundTo(total.gross - rows.reduce((s, r) => s + r.gross, 0)),
  }
  const rounding = diff.net === 0 && diff.vat === 0 && diff.gross === 0 ? null : diff
  return { rows, rounding, total, digits }
}

/** A posted credit note line whose VAT rate cannot be proven from anything frozen at posting. The PDF is refused rather than printed with a guessed rate. */
export class CreditNoteRateUnprovableError extends Error {
  constructor(readonly lineNumbers: number[]) {
    super(
      `This credit note's VAT cannot be printed: line${lineNumbers.length === 1 ? '' : 's'} ${lineNumbers.join(', ')} of the posted credit note `
      + 'cannot be matched to a refund line with a recorded VAT rate (the credit note was posted before IMS recorded which refund line each posted line belongs to). '
      + 'IMS will not guess a rate. Use the credit note in your accounting system as the document of record.',
    )
    this.name = 'CreditNoteRateUnprovableError'
  }
}

/** A refund that was never staged: the recorded lines priced as the credit note would be (draft). */
export function draftCreditNoteModel(input: {
  currency: string
  orderTaxRatePercent: number | null
  orderLines: ReadonlyArray<MoneyViewLine & { id: string }>
  refundLines: ReadonlyArray<CreditNoteLineFacts & { description: string; qty: number }>
}): CreditNoteDocumentModel {
  return finishCreditNoteRows(input.refundLines.map((rl) => {
    const orderLine = rl.salesOrderLineId ? input.orderLines.find((l) => l.id === rl.salesOrderLineId) : undefined
    const rate = rl.vatRate ?? (orderLine ? lineVatRate(orderLine, input.orderTaxRatePercent) : Number(input.orderTaxRatePercent ?? 0))
    return { description: rl.description, qty: rl.qty, net: rl.postedNet, vat: rl.postedNet * rate }
  }), input.currency)
}

export type PostedPayloadLine = { refundLineId?: unknown; description?: unknown; quantity?: unknown; unitAmount?: unknown; noTaxKind?: unknown }

/**
 * A refund whose credit note was staged: its payload lines as posted. `rateOf(i)` is the FROZEN rate for payload line i, or null when it
 * cannot be proven (the whole document then throws CreditNoteRateUnprovableError: a rate is never guessed); it is ignored when the VAT is
 * its own line (`vatIsOwnLine`, a scheme credit note) and for the scheme VAT line itself.
 */
export function postedCreditNoteModel(input: {
  currency: string
  payloadLines: ReadonlyArray<PostedPayloadLine>
  lineAmountsIncludeTax: boolean
  vatIsOwnLine: boolean
  rateOf: (index: number) => number | null
}): CreditNoteDocumentModel {
  const unprovable: number[] = []
  const model = finishCreditNoteRows(input.payloadLines.map((l, i) => {
    const qty = Number(l.quantity ?? 1)
    const amount = qty * Number(l.unitAmount ?? 0)
    const description = typeof l.description === 'string' ? l.description : 'Refund line'
    // The scheme credit note's ONE VAT line (noTaxKind 'eu-vat-recovery') IS the VAT: it prints as VAT, not as net. Fee and rounding lines stay
    // net lines of their own kind (a fee on NONE carries no VAT of its own; the rounding line is the rounding the credit note itself posts).
    if (l.noTaxKind === 'eu-vat-recovery') return { description, qty, net: 0, vat: amount }
    const proven = input.vatIsOwnLine ? 0 : input.rateOf(i)
    if (proven === null) unprovable.push(i + 1)
    const rate = proven ?? 0
    if (input.lineAmountsIncludeTax && rate > 0) {
      const net = amount / (1 + rate)
      return { description, qty, net, vat: amount - net }
    }
    return { description, qty, net: amount, vat: amount * rate }
  }), input.currency)
  if (unprovable.length > 0) throw new CreditNoteRateUnprovableError(unprovable)
  return model
}

export type PostedRateRefundLine = { id: string; salesOrderLineId: string | null; totalForeign: unknown; schemeTaxRateValue: unknown; chargedTaxForeign: unknown }
export type PostedRateOrderLine = { id: string; totalForeign: unknown; taxForeign: unknown }

/**
 * The FROZEN VAT rate (a fraction) of one posted payload line, or null when it cannot be proven.
 *
 * The line is tied to its refund line by the `refundLineId` the credit-note payload carries, never by its description (an empty description
 * posts as "Refund line", and two lines can share one). A payload without that id (posted before it was recorded) proves nothing: null.
 * Then, in order: the refund line's own frozen rate; the VAT the source stated over the line's net; the linked order line's stored VAT over its
 * stored net; for a line that links to no order line (shipping), the order's own rate, but only when the line posted under the order's default
 * tax code. Anything else is null.
 */
export function postedLineVatRate(input: {
  payloadLine: { refundLineId?: unknown; taxType?: unknown } | undefined
  refundLines: ReadonlyArray<PostedRateRefundLine>
  orderLines: ReadonlyArray<PostedRateOrderLine>
  orderRate: number | null
  orderDefaultTaxType: string | null
}): number | null {
  const id = input.payloadLine?.refundLineId
  if (typeof id !== 'string' || id === '') return null
  const rl = input.refundLines.find((l) => l.id === id)
  if (!rl) return null
  if (rl.schemeTaxRateValue != null) return Number(rl.schemeTaxRateValue)
  const net = Number(rl.totalForeign)
  if (rl.chargedTaxForeign != null && net > 0) return Number(rl.chargedTaxForeign) / net
  const ol = rl.salesOrderLineId ? input.orderLines.find((l) => l.id === rl.salesOrderLineId) : undefined
  if (ol && Number(ol.totalForeign) > 0) return Number(ol.taxForeign ?? 0) / Number(ol.totalForeign)
  const code = input.payloadLine?.taxType
  if (!ol && input.orderRate !== null && input.orderDefaultTaxType && typeof code === 'string' && code === input.orderDefaultTaxType) return input.orderRate
  return null
}
