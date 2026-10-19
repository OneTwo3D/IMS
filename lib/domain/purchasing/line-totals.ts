import { multiplyMoney, roundQuantity, toDecimal } from '@/lib/domain/math/decimal'

/**
 * The per-line base-currency arithmetic of a purchase order, moved out of app/actions/purchase-orders.ts UNCHANGED so that the first-load runner can validate a stored order with the very
 * functions that wrote it (a 'use server' module cannot export a plain function).
 */

export function safeFxRate(rate: number): number {
  return rate > 0 ? rate : 1
}

export function calcLineTotals(unitCostForeign: number, qty: number, fxRate: number) {
  const rate = safeFxRate(fxRate)
  // Use the shared Decimal (HALF_UP) helpers rather than Math.round on floats.
  // unitCostBase here becomes the cost-layer unitCostBase at receipt — the seed
  // of all downstream COGS — so it must round on the same engine as receipts,
  // FIFO consumption and COGS (cogs-audit scjz.58). Math.round((x/rate)*1eN)/1eN
  // operated on a float-contaminated mantissa and rounds .5 of negatives
  // asymmetrically, so PO line base costs could disagree with the cost layer
  // derived from them at the 6th dp / the penny.
  const totalForeign = roundQuantity(multiplyMoney(unitCostForeign, qty), 4).toNumber()
  const unitCostBase = roundQuantity(toDecimal(unitCostForeign).div(rate), 6).toNumber()
  const totalBase = roundQuantity(toDecimal(totalForeign).div(rate), 4).toNumber()
  return { unitCostBase, totalForeign, totalBase }
}

