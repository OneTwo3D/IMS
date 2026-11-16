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
import { planXeroRoundingLine, predictXeroDocumentTotal, xeroUnitDpFields } from '@/lib/connectors/xero/write-path'

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

/** Round to a currency's minor units (display/posting arithmetic; nothing is written back). */
// decimal-boundary-ok: display-only rounding of figures already stored/posted
export function roundMinor(n: number, currency: string | null | undefined): number {
  const f = 10 ** currencyMinorUnits(currency)
  return Math.round((n + Number.EPSILON) * f) / f
}

/** Base of the refusals the PDF route turns into a 409 with operator wording. */
export class CreditNoteDocumentRefusedError extends Error {}

/** The posted credit note's lines cannot be reproduced the way the writer posts them (its own planner would refuse the document). */
export class CreditNotePostingUnprovableError extends CreditNoteDocumentRefusedError {
  constructor(why: string) {
    super(`This credit note's PDF cannot be printed: ${why} IMS will not guess a total. Use the credit note in your accounting system as the document of record.`)
    this.name = 'CreditNotePostingUnprovableError'
  }
}

/** A posted credit note line whose VAT rate cannot be proven from anything frozen at posting. The PDF is refused rather than printed with a guessed rate. */
export class CreditNoteRateUnprovableError extends CreditNoteDocumentRefusedError {
  constructor(readonly lineNumbers: number[]) {
    super(
      `This credit note's VAT cannot be printed: line${lineNumbers.length === 1 ? '' : 's'} ${lineNumbers.join(', ')} of the posted credit note `
      + 'has no recorded VAT rate for its tax code (the credit note was posted before IMS recorded it, or its tax code maps to no single rate). '
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
    // VAT per line on the line's rounded net, rounded to the minor unit: how the ledger computes it.
    return { description: rl.description, qty: rl.qty, net: rl.postedNet, vat: roundMinor(roundMinor(rl.postedNet, input.currency) * rate, input.currency) }
  }), input.currency)
}

export type PostedPayloadLine = { refundLineId?: unknown; taxRatePosted?: unknown; description?: unknown; quantity?: unknown; unitAmount?: unknown; noTaxKind?: unknown }

/**
 * A refund whose credit note was staged: its payload lines as posted. `rateOf(i)` is the FROZEN rate for payload line i, or null when it
 * cannot be proven (the whole document then throws CreditNoteRateUnprovableError: a rate is never guessed); it is ignored when the VAT is
 * its own line (`vatIsOwnLine`, a scheme credit note) and for the scheme VAT line itself.
 */
export function postedCreditNoteModel(input: {
  currency: string
  payloadLines: ReadonlyArray<PostedPayloadLine & { taxType?: unknown }>
  lineAmountsIncludeTax: boolean
  vatIsOwnLine: boolean
  rateOf: (index: number) => number | null
}): CreditNoteDocumentModel {
  const unprovable: number[] = []
  // Each line exactly as the credit-note writer sends it: Quantity x UnitAmount at Xero's 4 decimals (xeroUnitDpFields), the line amount rounded to
  // the minor unit, tax per line on that amount at the frozen rate of the line's posted code.
  const sent = input.payloadLines.map((l) => {
    const qty = Number(l.quantity ?? 1)
    const unit = xeroUnitDpFields(qty, Number(l.unitAmount ?? 0)).UnitAmount
    return { qty, unit, amount: roundMinor(qty * unit, input.currency) }
  })
  const raws = input.payloadLines.map((l, i) => {
    const { qty, amount } = sent[i]
    const description = typeof l.description === 'string' ? l.description : 'Refund line'
    // The scheme credit note's ONE VAT line (noTaxKind 'eu-vat-recovery') IS the VAT: it prints as VAT, not as net. Fee and rounding lines stay
    // net lines of their own kind (a fee on NONE carries no VAT of its own; the rounding line is the rounding the credit note itself posts).
    if (l.noTaxKind === 'eu-vat-recovery') return { description, qty, net: 0, vat: amount }
    const proven = input.vatIsOwnLine ? 0 : input.rateOf(i)
    if (proven === null) unprovable.push(i + 1)
    const rate = proven ?? 0
    // Per-line VAT rounded to the currency's minor unit, as the ledger does (exclusive: on the line amount; inclusive: the tax part of it).
    if (input.lineAmountsIncludeTax && rate > 0) {
      const vat = roundMinor(amount - amount / (1 + rate), input.currency)
      return { description, qty, net: amount - vat, vat }
    }
    return { description, qty, net: amount, vat: roundMinor(amount * rate, input.currency) }
  })
  if (unprovable.length > 0) throw new CreditNoteRateUnprovableError(unprovable)

  // The untaxed "Rounding adjustment" line the writer adds when 4-decimal unit prices change a line amount: sized by the writer's own planner on the
  // frozen rates, so the document's total is the one the posting produces. A document the planner would refuse is refused here.
  const ratePercentByType = new Map<string, number>()
  input.payloadLines.forEach((l) => {
    const r = postedLineVatRate(l)
    if (typeof l.taxType === 'string' && r !== null && !ratePercentByType.has(l.taxType.trim())) ratePercentByType.set(l.taxType.trim(), r * 100)
  })
  const planLines = input.payloadLines.map((l, i) => ({ quantity: sent[i].qty, unitAmount: Number(l.unitAmount ?? 0), taxType: typeof l.taxType === 'string' ? l.taxType : null }))
  let adjustment: Record<string, unknown> | null
  try {
    // The account is not printed; any non-blank value lets the planner size the line (the posting already had one, or it would have been refused).
    adjustment = planXeroRoundingLine({ lines: planLines, lineAmountsIncludeTax: input.lineAmountsIncludeTax, rateOf: (t) => ratePercentByType.get(t.trim()) ?? null, account: 'rounding', what: 'This credit note' })
  } catch (e) {
    throw new CreditNotePostingUnprovableError(e instanceof Error ? e.message : String(e))
  }
  if (adjustment !== null) raws.push({ description: String(adjustment.Description), qty: Number(adjustment.Quantity), net: Number(adjustment.UnitAmount), vat: 0 })
  return finishCreditNoteRows(raws, input.currency)
}

/** The total a posted credit note's lines make in Xero (the writer's own prediction), for cross-checking a model's total. */
export function predictedPostedTotal(input: { currency: string; payloadLines: ReadonlyArray<PostedPayloadLine & { taxType?: unknown }>; lineAmountsIncludeTax: boolean }): number | null {
  const ratePercentByType = new Map<string, number>()
  for (const l of input.payloadLines) {
    const r = postedLineVatRate(l)
    if (typeof l.taxType === 'string' && r !== null && !ratePercentByType.has(l.taxType.trim())) ratePercentByType.set(l.taxType.trim(), r * 100)
  }
  const lines = input.payloadLines.map((l) => ({ quantity: Number(l.quantity ?? 1), unitAmount: Number(l.unitAmount ?? 0), taxType: typeof l.taxType === 'string' ? l.taxType : null }))
  const predicted = predictXeroDocumentTotal(lines, input.lineAmountsIncludeTax, (t) => ratePercentByType.get(t.trim()) ?? null)
  return predicted.ok ? predicted.total.toNumber() : null
}

/**
 * The VAT rate (a fraction) the tax code posted on a payload line carries, or null when it cannot be proven.
 *
 * `taxRatePosted` is written onto the payload line when the credit note is queued: the rate of the line's posted tax code (its `taxType`) priced
 * against the sales tax table at that moment (null/absent when the code maps to no rate or to two). It is frozen with the payload, so the PDF is
 * stable if rates change later, and it is the rate the ledger applies. The rounded VAT the source stated is NOT used: it can differ by a minor
 * unit from what the code calculates. A payload without it (queued before it was recorded, or an unpriceable code) is unprovable: null.
 */
export function postedLineVatRate(payloadLine: { taxRatePosted?: unknown } | undefined): number | null {
  const r = payloadLine?.taxRatePosted
  return typeof r === 'number' && Number.isFinite(r) && r >= 0 ? r : null
}
