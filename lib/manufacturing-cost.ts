import { createHash } from 'crypto'

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

export type ManufacturingCostAccountLine = {
  amountBase: number | string | { toString(): string }
  accountCode: string | null
}

export type OverheadAccountDeltas = {
  deltas: Map<string, number>
  missingAccount: boolean
}

function roundSix(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

function addToMap(map: Map<string, number>, key: string, value: number) {
  if (Math.abs(value) < 0.000001) return
  map.set(key, (map.get(key) ?? 0) + value)
}

function stableNormalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Map) {
    return [...value.entries()]
      .map(([key, entryValue]) => [stableNormalize(key), stableNormalize(entryValue)])
      .sort(([a], [b]) => compareAccountCodes(JSON.stringify(a) ?? '', JSON.stringify(b) ?? ''))
  }
  if (value instanceof Set) {
    return [...value.values()]
      .map((entryValue) => stableNormalize(entryValue))
      .sort((a, b) => compareAccountCodes(JSON.stringify(a) ?? '', JSON.stringify(b) ?? ''))
  }
  if (Array.isArray(value)) return value.map((entryValue) => stableNormalize(entryValue))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => compareAccountCodes(a, b))
        .map(([key, entryValue]) => [key, stableNormalize(entryValue)]),
    )
  }
  return value
}

export function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stableNormalize(value)) ?? 'undefined').digest('hex')
}

export function compareAccountCodes(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export function buildOverheadAccountDeltas(
  oldLines: ManufacturingCostAccountLine[],
  newLines: ManufacturingCostAccountLine[],
  defaultAccount: string,
): OverheadAccountDeltas {
  const deltas = new Map<string, number>()
  let missingAccount = false

  for (const line of oldLines) {
    const amount = Number(line.amountBase)
    if (amount <= 0) continue
    // Old completed-order lines must carry the account that was actually
    // posted. Do not fall back to today's default account; defaults can change.
    const account = line.accountCode
    if (!account) { missingAccount = true; continue }
    addToMap(deltas, account, -amount)
  }

  for (const line of newLines) {
    const amount = Number(line.amountBase)
    if (amount <= 0) continue
    const account = line.accountCode || defaultAccount
    if (!account) { missingAccount = true; continue }
    addToMap(deltas, account, amount)
  }

  for (const [account, delta] of [...deltas.entries()]) {
    const rounded = roundSix(delta)
    if (Math.abs(rounded) < 0.005) deltas.delete(account)
    else deltas.set(account, rounded)
  }

  return { deltas, missingAccount }
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
