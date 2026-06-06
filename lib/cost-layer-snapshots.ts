import { addMoney, multiplyMoney, roundQuantity, toDecimal, type Decimal, type DecimalInput } from '@/lib/domain/math/decimal'

export type CostLayerSnapshotSource = 'allocation' | 'shipment'

export type CostLayerSnapshotEntry = {
  costLayerId: string
  qty: number
  unitCostBase: DecimalInput
  orderAllocationId?: string
  shipmentLineId?: string
  source?: CostLayerSnapshotSource
}

export type SerializableCostLayerSnapshotEntry = Omit<CostLayerSnapshotEntry, 'qty' | 'unitCostBase'> & {
  qty: DecimalInput
  unitCostBase: DecimalInput
}

export function serializeCostLayerSnapshotEntry(
  entry: SerializableCostLayerSnapshotEntry,
): Record<string, string> & Pick<CostLayerSnapshotEntry, 'costLayerId' | 'orderAllocationId' | 'shipmentLineId' | 'source'> {
  const serialized = {
    costLayerId: entry.costLayerId,
    qty: roundQuantity(entry.qty, 6).toFixed(6),
    unitCostBase: roundQuantity(entry.unitCostBase, 6).toFixed(6),
    ...(entry.orderAllocationId ? { orderAllocationId: entry.orderAllocationId } : {}),
    ...(entry.shipmentLineId ? { shipmentLineId: entry.shipmentLineId } : {}),
    ...(entry.source ? { source: entry.source } : {}),
  }
  return serialized
}

export function serializeCostLayerSnapshot(
  entries: SerializableCostLayerSnapshotEntry[],
): Array<ReturnType<typeof serializeCostLayerSnapshotEntry>> {
  return entries.map(serializeCostLayerSnapshotEntry)
}

function isSnapshotSource(value: unknown): value is CostLayerSnapshotSource {
  return value === 'allocation' || value === 'shipment'
}

export function parseCostLayerSnapshot(value: unknown): CostLayerSnapshotEntry[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const row = entry as Record<string, unknown>
    const costLayerId = typeof row.costLayerId === 'string' ? row.costLayerId : ''
    const qty = Number(row.qty)
    if (row.unitCostBase == null) return []
    let unitCostBase: string
    try {
      unitCostBase = roundQuantity(row.unitCostBase as DecimalInput, 6).toFixed(6)
    } catch {
      return []
    }
    if (!costLayerId || !Number.isFinite(qty) || qty <= 0) return []
    return [{
      costLayerId,
      qty,
      unitCostBase,
      orderAllocationId: typeof row.orderAllocationId === 'string' ? row.orderAllocationId : undefined,
      shipmentLineId: typeof row.shipmentLineId === 'string' ? row.shipmentLineId : undefined,
      source: isSnapshotSource(row.source) ? row.source : undefined,
    }]
  })
}

export function sumCostLayerSnapshot(entries: CostLayerSnapshotEntry[]): Decimal {
  return entries.reduce(
    (sum, entry) => addMoney(sum, multiplyMoney(entry.qty, entry.unitCostBase)),
    toDecimal(0),
  )
}

export function reduceSnapshotByCostLayer(
  baseEntries: CostLayerSnapshotEntry[],
  deductions: Array<{ costLayerId: string; qty: number }>,
): CostLayerSnapshotEntry[] {
  const remaining = baseEntries.map((entry) => ({ ...entry }))

  for (const deduction of deductions) {
    let qtyToRemove = deduction.qty
    if (qtyToRemove <= 0) continue

    for (const entry of remaining) {
      if (entry.costLayerId !== deduction.costLayerId || qtyToRemove <= 0) continue
      const take = Math.min(entry.qty, qtyToRemove)
      entry.qty -= take
      qtyToRemove -= take
    }
  }

  return remaining.filter((entry) => entry.qty > 0.0000001)
}

export function takeFromSnapshotEntries(
  entries: CostLayerSnapshotEntry[],
  qty: number,
  decorate?: Partial<CostLayerSnapshotEntry>,
): { taken: CostLayerSnapshotEntry[]; remainingQty: number } {
  let remainingQty = qty
  const taken: CostLayerSnapshotEntry[] = []

  for (const entry of entries) {
    if (remainingQty <= 0) break
    const take = Math.min(entry.qty, remainingQty)
    if (take <= 0) continue
    taken.push({
      costLayerId: entry.costLayerId,
      qty: take,
      unitCostBase: entry.unitCostBase,
      orderAllocationId: decorate?.orderAllocationId ?? entry.orderAllocationId,
      shipmentLineId: decorate?.shipmentLineId ?? entry.shipmentLineId,
      source: decorate?.source ?? entry.source,
    })
    remainingQty -= take
  }

  return { taken, remainingQty }
}
