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

// decimal-boundary-ok: display-only rounding of figures already stored/posted; nothing here is written back
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100

export type CreditNoteDocumentRow = { description: string; qty: number; net: number; vat: number; gross: number }
export type RawCreditNoteLine = { description: string; qty: number; net: number; vat: number }
export type CreditNoteDocumentModel = { rows: CreditNoteDocumentRow[]; rounding: RefundAmounts | null; total: RefundAmounts }

/** Round each row for display, the total once from the unrounded sums, and expose the difference as a Rounding amount. */
export function finishCreditNoteRows(lines: ReadonlyArray<RawCreditNoteLine>): CreditNoteDocumentModel {
  const rows = lines.map((l) => {
    const net = round2(l.net)
    const vat = round2(l.vat)
    return { description: l.description, qty: l.qty, net, vat, gross: round2(net + vat) }
  })
  const rawNet = lines.reduce((s, l) => s + l.net, 0)
  const rawVat = lines.reduce((s, l) => s + l.vat, 0)
  const total = { net: round2(rawNet), vat: round2(rawVat), gross: round2(rawNet + rawVat) }
  const diff = {
    net: round2(total.net - rows.reduce((s, r) => s + r.net, 0)),
    vat: round2(total.vat - rows.reduce((s, r) => s + r.vat, 0)),
    gross: round2(total.gross - rows.reduce((s, r) => s + r.gross, 0)),
  }
  const rounding = diff.net === 0 && diff.vat === 0 && diff.gross === 0 ? null : diff
  return { rows, rounding, total }
}

/** A refund that was never staged: the recorded lines priced as the credit note would be (draft). */
export function draftCreditNoteModel(input: {
  orderTaxRatePercent: number | null
  orderLines: ReadonlyArray<MoneyViewLine & { id: string }>
  refundLines: ReadonlyArray<CreditNoteLineFacts & { description: string; qty: number }>
}): CreditNoteDocumentModel {
  return finishCreditNoteRows(input.refundLines.map((rl) => {
    const orderLine = rl.salesOrderLineId ? input.orderLines.find((l) => l.id === rl.salesOrderLineId) : undefined
    const rate = rl.vatRate ?? (orderLine ? lineVatRate(orderLine, input.orderTaxRatePercent) : Number(input.orderTaxRatePercent ?? 0))
    return { description: rl.description, qty: rl.qty, net: rl.postedNet, vat: rl.postedNet * rate }
  }))
}

export type PostedPayloadLine = { description?: unknown; quantity?: unknown; unitAmount?: unknown; noTaxKind?: unknown }

/**
 * A refund whose credit note was staged: its payload lines as posted. `rateOf(i)` is the FROZEN rate for payload line i (0 for a line
 * that is not a refund line); it is ignored when the VAT is its own line (`vatIsOwnLine`, a scheme credit note).
 */
export function postedCreditNoteModel(input: {
  payloadLines: ReadonlyArray<PostedPayloadLine>
  lineAmountsIncludeTax: boolean
  vatIsOwnLine: boolean
  rateOf: (index: number) => number
}): CreditNoteDocumentModel {
  return finishCreditNoteRows(input.payloadLines.map((l, i) => {
    const qty = Number(l.quantity ?? 1)
    const amount = qty * Number(l.unitAmount ?? 0)
    const description = typeof l.description === 'string' ? l.description : 'Refund line'
    // The scheme credit note's ONE VAT line (noTaxKind 'eu-vat-recovery') IS the VAT: it prints as VAT, not as net. Fee and rounding lines stay
    // net lines of their own kind (a fee on NONE carries no VAT of its own; the rounding line is the rounding the credit note itself posts).
    if (l.noTaxKind === 'eu-vat-recovery') return { description, qty, net: 0, vat: amount }
    const rate = input.vatIsOwnLine ? 0 : input.rateOf(i)
    if (input.lineAmountsIncludeTax && rate > 0) {
      const net = amount / (1 + rate)
      return { description, qty, net, vat: amount - net }
    }
    return { description, qty, net: amount, vat: amount * rate }
  }))
}
