import { addMoney, compareDecimal, multiplyMoney, roundQuantity, toDecimal, type Decimal, type DecimalInput } from '@/lib/domain/math/decimal'

/**
 * Pure planning for a return expectation: turn a refund's return rows into the document's lines.
 *
 * The rows are the SAME rows the legacy path handed to `applyReturnInboundStockTx` (the refund's dispatch-cost
 * snapshot, valued at the originally posted COGS), so the value this plan reports is the figure the refund's
 * COGS reversal debits to Stock in Transit. Nothing here touches stock, a cost layer or a ledger.
 *
 * Identity is per record, not per aggregate: one line per (refund line, product). Two refund lines for the same
 * product stay two lines, so arrival can later be matched to a specific refund line and a short return on one
 * line cannot be absorbed by another.
 */
export type ReturnExpectationRowInput = {
  productId: string
  qty: DecimalInput
  refundLineId?: string | null
  unitCostBase?: DecimalInput
  poLineId?: string | null
  sourceCostLayerId?: string | null
}

export type ReturnExpectationCostEntry = {
  /** Decimal string at 6dp, the column precision. */
  qty: string
  /** Decimal string at 6dp, or null when the row carried no cost (a cost-less fallback row). */
  unitCostBase: string | null
  poLineId: string | null
  sourceCostLayerId: string | null
}

export type ReturnExpectationLinePlan = {
  refundLineId: string
  productId: string
  sku: string
  /** 6dp, the column precision. */
  qty: Decimal
  costSnapshot: ReturnExpectationCostEntry[]
  /** 6dp. Zero when no entry carried a cost. */
  transitValueBase: Decimal
}

export type ReturnExpectationPlan = {
  lines: ReturnExpectationLinePlan[]
  /**
   * The value of every priced entry, summed UNROUNDED and rounded to 6dp once: the same arithmetic the refund's
   * COGS reversal uses for its 6dp figure, so the two compare exactly with no tolerance.
   */
  totalValueBase: Decimal
  /** How many entries carried no cost. Non-zero means part of the document is not valued. */
  unpricedEntryCount: number
}

export class ReturnExpectationPlanError extends Error {
  constructor(readonly code: 'row_without_refund_line' | 'row_without_sku' | 'row_negative_cost') {
    super(`return_expectation_plan:${code}`)
    this.name = 'ReturnExpectationPlanError'
  }
}

export function planReturnExpectationLines(
  rows: readonly ReturnExpectationRowInput[],
  skuByProductId: ReadonlyMap<string, string>,
): ReturnExpectationPlan {
  const groups = new Map<string, {
    refundLineId: string
    productId: string
    qty: Decimal
    exactValue: Decimal
    entries: ReturnExpectationCostEntry[]
  }>()
  let totalExact = toDecimal(0)
  let unpricedEntryCount = 0

  for (const row of rows) {
    if (!row.productId) continue
    const qty = roundQuantity(row.qty, 6)
    // A row with no quantity moves nothing and is dropped; a negative or non-finite one is rejected by toDecimal/roundQuantity.
    if (compareDecimal(qty, 0) <= 0) continue
    // The legacy path tolerated a row without a refund line (it aggregated by product). A document is per refund
    // line, so a row that cannot name its line is refused rather than attached to a guess.
    if (!row.refundLineId) throw new ReturnExpectationPlanError('row_without_refund_line')
    const sku = skuByProductId.get(row.productId)
    if (!sku) throw new ReturnExpectationPlanError('row_without_sku')

    let unitCost: Decimal | null = null
    if (row.unitCostBase != null) {
      unitCost = toDecimal(row.unitCostBase)
      if (compareDecimal(unitCost, 0) < 0) throw new ReturnExpectationPlanError('row_negative_cost')
    }
    const exact = unitCost ? multiplyMoney(qty, unitCost) : toDecimal(0)
    if (!unitCost) unpricedEntryCount += 1
    totalExact = addMoney(totalExact, exact)

    const key = `${row.refundLineId}\u0000${row.productId}`
    const group = groups.get(key) ?? {
      refundLineId: row.refundLineId,
      productId: row.productId,
      qty: toDecimal(0),
      exactValue: toDecimal(0),
      entries: [],
    }
    group.qty = addMoney(group.qty, qty)
    group.exactValue = addMoney(group.exactValue, exact)
    group.entries.push({
      qty: qty.toFixed(6),
      unitCostBase: unitCost ? roundQuantity(unitCost, 6).toFixed(6) : null,
      poLineId: row.poLineId ?? null,
      sourceCostLayerId: row.sourceCostLayerId ?? null,
    })
    groups.set(key, group)
  }

  return {
    lines: [...groups.values()].map((group) => ({
      refundLineId: group.refundLineId,
      productId: group.productId,
      sku: skuByProductId.get(group.productId)!,
      qty: group.qty,
      costSnapshot: group.entries,
      transitValueBase: roundQuantity(group.exactValue, 6),
    })),
    totalValueBase: roundQuantity(totalExact, 6),
    unpricedEntryCount,
  }
}
