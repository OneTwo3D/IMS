/**
 * The rows and totals of a printed credit note, from the SAME figures the credit note posts (credit-note-display.ts +
 * creditNoteAmounts): each refund line's posted net with the VAT at the rate of the tax code it posts under, and the total summed
 * from the unrounded amounts. The printed lines therefore add up to the printed total, and both match what the ledger is sent.
 */
import { creditNoteAmounts, type CreditNoteLineFacts, type MoneyViewLine, type RefundAmounts } from '@/lib/domain/sales/sales-order-money-view'

export type CreditNoteDocumentRow = { description: string; qty: number; net: number; vat: number; gross: number }

export function creditNoteDocumentModel(input: {
  orderTaxRatePercent: number | null
  orderLines: ReadonlyArray<MoneyViewLine & { id: string }>
  refundLines: ReadonlyArray<CreditNoteLineFacts & { description: string; qty: number }>
}): { rows: CreditNoteDocumentRow[]; total: RefundAmounts } {
  const { perLine, total } = creditNoteAmounts(
    { taxRatePercent: input.orderTaxRatePercent, lines: input.orderLines },
    { lines: input.refundLines },
  )
  const rows = input.refundLines.map((l, i) => ({
    description: l.description,
    qty: l.qty,
    net: perLine[i].net,
    vat: perLine[i].vat,
    gross: perLine[i].gross,
  }))
  return { rows, total }
}
