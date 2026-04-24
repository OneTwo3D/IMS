/**
 * Pure-math helpers for manufacturing-cost capitalisation. Kept separate
 * from app/actions/manufacturing.ts so the unit-cost computation can be
 * unit-tested without spinning up Prisma.
 */

export type LayerInfo = {
  /** Cost-layer id (passthrough — used only to identify rows). */
  id: string
  /** Original receivedQty on the layer. Used as the divisor for unit cost. */
  receivedQty: number
  /** Sum of `costLayerSourceLine.totalCostBase` for this layer — the
   *  component-only base cost before any manufacturing overhead. */
  base: number
}

export type RecalcResult = {
  layerId: string
  newUnitCostBase: number
}

/**
 * Spread `currentMfgCostBase` proportionally across `layers` by their
 * component base value, returning the new unit cost per layer.
 *
 * - Single-layer (assembly): the layer takes the full overhead.
 * - Multi-layer (disassembly): each layer's share = layer.base / totalBase.
 * - If totalBase is zero (assembled stock had zero cost), the overhead
 *   is split equally across layers as a fallback.
 *
 * Rounded to 6 decimal places to match `costLayer.unitCostBase`'s
 * Decimal(18,6) precision.
 */
export function recomputeManufacturingUnitCosts(
  layers: LayerInfo[],
  currentMfgCostBase: number,
): RecalcResult[] {
  if (layers.length === 0) return []
  const totalBase = layers.reduce((s, l) => s + l.base, 0)
  return layers.map((l) => {
    const share = totalBase > 0 ? l.base / totalBase : 1 / layers.length
    const overhead = currentMfgCostBase * share
    const unit = l.receivedQty > 0
      ? Math.round(((l.base + overhead) / l.receivedQty) * 1_000_000) / 1_000_000
      : 0
    return { layerId: l.id, newUnitCostBase: unit }
  })
}
