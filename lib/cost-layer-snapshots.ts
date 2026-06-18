import { addMoney, multiplyMoney, roundQuantity, toDecimal, type Decimal, type DecimalInput } from '@/lib/domain/math/decimal'

export type CostLayerSnapshotSource = 'allocation' | 'shipment'

export type CostLayerSnapshotEntry = {
  costLayerId: string
  qty: DecimalInput
  unitCostBase: DecimalInput
  orderAllocationId?: string
  shipmentLineId?: string
  source?: CostLayerSnapshotSource
}

export type SerializableCostLayerSnapshotEntry = Omit<CostLayerSnapshotEntry, 'qty' | 'unitCostBase'> & {
  qty: DecimalInput
  unitCostBase: DecimalInput
}

export type SerializedCostLayerSnapshotEntry = Omit<CostLayerSnapshotEntry, 'qty' | 'unitCostBase'> & {
  qty: string
  unitCostBase: string
}

// Snapshot JSON is intentionally precision-bounded to the 6-decimal scale used
// by IMS cost and movement value columns. This avoids JS-number serialization
// while keeping persisted audit snapshots comparable and fixed-width.
export function serializeCostLayerSnapshotEntry(
  entry: SerializableCostLayerSnapshotEntry,
): SerializedCostLayerSnapshotEntry {
  const serialized = {
    costLayerId: entry.costLayerId,
    qty: roundQuantity(entry.qty, 6).toFixed(6),
    unitCostBase: roundQuantity(entry.unitCostBase, 6).toFixed(6),
    ...(entry.orderAllocationId ? { orderAllocationId: entry.orderAllocationId } : {}),
    ...(entry.shipmentLineId ? { shipmentLineId: entry.shipmentLineId } : {}),
    ...(entry.source ? { source: entry.source } : {}),
  }
  return serialized satisfies SerializedCostLayerSnapshotEntry
}

export function serializeCostLayerSnapshot(
  entries: SerializableCostLayerSnapshotEntry[],
): SerializedCostLayerSnapshotEntry[] {
  return entries.map(serializeCostLayerSnapshotEntry)
}

function isSnapshotSource(value: unknown): value is CostLayerSnapshotSource {
  return value === 'allocation' || value === 'shipment'
}

function warnDroppedSnapshotEntry(costLayerId: string, reason: string): void {
  // A snapshot entry being silently dropped shrinks the COGS this snapshot
  // represents (and can lower booked COGS during a retrospective refresh). Make
  // corruption visible instead of silently reducing value (cogs-audit scjz.8).
  console.warn(`Dropped costLayerSnapshot entry (costLayerId=${costLayerId || '(missing)'}): ${reason}`)
}

export function parseCostLayerSnapshot(value: unknown): CostLayerSnapshotEntry[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') {
      warnDroppedSnapshotEntry('', 'entry is not an object')
      return []
    }
    const row = entry as Record<string, unknown>
    const costLayerId = typeof row.costLayerId === 'string' ? row.costLayerId : ''
    if (row.qty == null || row.unitCostBase == null) {
      warnDroppedSnapshotEntry(costLayerId, 'missing qty/unitCostBase')
      return []
    }
    let qty: string
    let unitCostBase: string
    try {
      qty = roundQuantity(row.qty as DecimalInput, 6).toFixed(6)
      unitCostBase = roundQuantity(row.unitCostBase as DecimalInput, 6).toFixed(6)
    } catch {
      warnDroppedSnapshotEntry(costLayerId, 'unparseable qty/unitCostBase')
      return []
    }
    if (!costLayerId) {
      warnDroppedSnapshotEntry('', 'missing costLayerId')
      return []
    }
    if (toDecimal(qty).lte(0)) {
      warnDroppedSnapshotEntry(costLayerId, 'non-positive qty')
      return []
    }
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
  deductions: Array<{ costLayerId: string; qty: DecimalInput }>,
): CostLayerSnapshotEntry[] {
  const remaining = baseEntries.map((entry) => ({ ...entry }))

  for (const deduction of deductions) {
    let qtyToRemove = toDecimal(deduction.qty)
    if (qtyToRemove.lte(0)) continue

    for (const entry of remaining) {
      if (entry.costLayerId !== deduction.costLayerId || qtyToRemove.lte(0)) continue
      const entryQty = toDecimal(entry.qty)
      const take = entryQty.lt(qtyToRemove) ? entryQty : qtyToRemove
      entry.qty = roundQuantity(entryQty.sub(take), 6).toFixed(6)
      qtyToRemove = qtyToRemove.sub(take)
    }
  }

  return remaining.filter((entry) => toDecimal(entry.qty).gt('0.0000001'))
}

export function takeFromSnapshotEntries(
  entries: CostLayerSnapshotEntry[],
  qty: number,
  decorate?: Partial<CostLayerSnapshotEntry>,
): { taken: CostLayerSnapshotEntry[]; remainingQty: number } {
  let remainingQty = toDecimal(qty)
  const taken: CostLayerSnapshotEntry[] = []

  for (const entry of entries) {
    if (remainingQty.lte(0)) break
    const entryQty = toDecimal(entry.qty)
    const take = entryQty.lt(remainingQty) ? entryQty : remainingQty
    if (take.lte(0)) continue
    taken.push({
      costLayerId: entry.costLayerId,
      qty: roundQuantity(take, 6).toFixed(6),
      unitCostBase: entry.unitCostBase,
      orderAllocationId: decorate?.orderAllocationId ?? entry.orderAllocationId,
      shipmentLineId: decorate?.shipmentLineId ?? entry.shipmentLineId,
      source: decorate?.source ?? entry.source,
    })
    remainingQty = remainingQty.sub(take)
  }

  return { taken, remainingQty: remainingQty.toNumber() }
}
