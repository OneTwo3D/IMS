import {
  addMoney,
  multiplyMoney,
  roundQuantity,
  subtractMoney,
  toDecimal,
  type DecimalInput,
} from '@/lib/domain/math/decimal'

// ---------------------------------------------------------------------------
// Prepaid PO billed-vs-received reconciliation (audit-C1b)
//
// The three-way-match block (C1) lets a PREPAID supplier be billed up to the
// ORDERED quantity (the deposit was deliberate) — so prepaid POs lose the
// billed<=received protection. Prepay/bill 100, receive 90 → 10 units paid for
// but never arrived, with no signal. This computes, read-time, the per-line
// billed-vs-received delta for a prepaid PO so the detail page can show a soft
// reconciliation banner (not a block). Pay-on-receipt POs (which can't over-bill)
// never surface it.
// ---------------------------------------------------------------------------

export type PrepaidReconciliationLine = {
  poLineId: string
  productId: string
  sku: string | null
  billedQty: string
  receivedQty: string
  /** billed − received when positive (prepaid but not arrived). */
  shortfallQty: string
  /** shortfallQty × average billed unit cost, base currency. */
  shortfallValueBase: string
}

export type PrepaidReconciliationSummary = {
  /** True only for prepaid suppliers (the banner is suppressed otherwise). */
  isPrepaidSupplier: boolean
  /** A line is billed for more than received — prepaid but not arrived. */
  hasShortfall: boolean
  /** A line received more than billed — a balancing bill is still due. */
  hasUnderBilled: boolean
  totalShortfallQty: string
  totalShortfallValueBase: string
  lines: PrepaidReconciliationLine[]
}

type PoLineInput = {
  id: string
  productId: string
  sku?: string | null
  qtyReceived: DecimalInput
  qtyReturned: DecimalInput
}

type InvoiceInput = {
  lines: Array<{ poLineId: string | null; qtyBilled: DecimalInput; totalBase: DecimalInput }>
}

const QTY_EPSILON = 1e-6

export function computePrepaidReconciliation(input: {
  isPrepaidSupplier: boolean
  lines: PoLineInput[]
  invoices: InvoiceInput[]
}): PrepaidReconciliationSummary {
  const empty: PrepaidReconciliationSummary = {
    isPrepaidSupplier: input.isPrepaidSupplier,
    hasShortfall: false,
    hasUnderBilled: false,
    totalShortfallQty: '0',
    totalShortfallValueBase: '0',
    lines: [],
  }
  if (!input.isPrepaidSupplier) return empty

  // Sum billed quantity + value per PO line across all invoices.
  const billedByLine = new Map<string, { qty: ReturnType<typeof toDecimal>; valueBase: ReturnType<typeof toDecimal> }>()
  for (const invoice of input.invoices) {
    for (const line of invoice.lines) {
      if (!line.poLineId) continue
      const existing = billedByLine.get(line.poLineId) ?? { qty: toDecimal(0), valueBase: toDecimal(0) }
      existing.qty = addMoney(existing.qty, line.qtyBilled)
      existing.valueBase = addMoney(existing.valueBase, line.totalBase)
      billedByLine.set(line.poLineId, existing)
    }
  }

  let totalShortfallQty = toDecimal(0)
  let totalShortfallValueBase = toDecimal(0)
  let hasUnderBilled = false
  const lines: PrepaidReconciliationLine[] = []

  for (const poLine of input.lines) {
    const billed = billedByLine.get(poLine.id)
    if (!billed || billed.qty.lte(0)) continue
    // "Prepaid but not arrived" is billed − ever-RECEIVED. Returns are NOT netted
    // here: goods that were delivered then returned DID arrive, and the returned
    // value is handled separately by the auto-created supplier credit note.
    // Netting returns in would mislabel a return as a non-delivery — telling the
    // user to "chase the delivery" for goods they deliberately sent back.
    const everReceived = toDecimal(poLine.qtyReceived)
    const shortfall = subtractMoney(billed.qty, everReceived)
    // Under-billed (a balancing bill may be due) is about goods KEPT beyond what
    // was billed, so it nets returns: returned goods don't need billing. Using
    // ever-received here would wrongly flag "final bill due" for returned goods.
    const netKept = subtractMoney(poLine.qtyReceived, poLine.qtyReturned)
    if (subtractMoney(netKept, billed.qty).gt(QTY_EPSILON)) hasUnderBilled = true
    if (shortfall.lte(QTY_EPSILON)) continue

    // billed.qty > 0 is guaranteed by the early-continue above.
    const avgUnitCostBase = billed.valueBase.div(billed.qty)
    const shortfallValueBase = roundQuantity(multiplyMoney(shortfall, avgUnitCostBase), 2)
    totalShortfallQty = addMoney(totalShortfallQty, shortfall)
    totalShortfallValueBase = addMoney(totalShortfallValueBase, shortfallValueBase)
    lines.push({
      poLineId: poLine.id,
      productId: poLine.productId,
      sku: poLine.sku ?? null,
      billedQty: roundQuantity(billed.qty, 4).toString(),
      receivedQty: roundQuantity(everReceived, 4).toString(),
      shortfallQty: roundQuantity(shortfall, 4).toString(),
      shortfallValueBase: shortfallValueBase.toString(),
    })
  }

  return {
    isPrepaidSupplier: true,
    hasShortfall: lines.length > 0,
    hasUnderBilled,
    totalShortfallQty: roundQuantity(totalShortfallQty, 4).toString(),
    totalShortfallValueBase: roundQuantity(totalShortfallValueBase, 2).toString(),
    lines,
  }
}
