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

/** Total QUANTITY a snapshot pins, as opposed to {@link sumCostLayerSnapshot}'s value. */
export function sumCostLayerSnapshotQty(entries: CostLayerSnapshotEntry[]): Decimal {
  return entries.reduce((sum, entry) => sum.add(toDecimal(entry.qty)), toDecimal(0))
}

/**
 * What Group A2 has already reclassified at one (line, warehouse, product) scope, and how much of the
 * dispatched quantity NO record on the row accounts for yet (o3d-0i5y r6).
 *
 * THE STAMP IS AN ORDER-LEVEL FACT ABOUT A ROW-LEVEL QUESTION, and that is where the original hole
 * was. A2 marks the ORDER `inventoryAllocatedDate`, so "already reclassified" was read as
 * all-or-nothing for the order — and once a shipment on it had been journaled the stamp was
 * deliberately kept (clearing it would re-post the shipped value it had already posted). Residual
 * quantity allocated AFTER that point therefore had no route into the ledger at all: A2 never looked
 * at the order again, and Group B still CREDITED Allocated Inventory when the residual shipped, for a
 * debit that was never made.
 *
 * The quantity A2 has accounted at a scope is recorded twice over, and the two records do not add up
 * — they OVERLAP, because a dispatch consumes the very allocation it ships:
 *
 *   `snapshotQty`  the FIFO layers A2 pinned on the allocation row. Written once and never reduced
 *                  afterwards (Group B relieves its contra from an in-memory copy), so it stays a
 *                  truthful record of what was posted.
 *   `shippedQty`   quantity already dispatched at this scope.
 *
 * So the accounted quantity is the LARGER of the two, never the sum. Taking the sum would double-count
 * an ordinary allocate-then-ship row (pinned 6, shipped 6, accounted 6 — not 12) and strand the very
 * residual r5 exists to account for.
 *
 * THAT HOLDS ONLY WHILE BOTH RECORDS DESCRIBE THE SAME UNITS, and r5 left one case where they do not.
 * A dispatch can consume a pin that already existed; it cannot consume one written afterwards. When
 * A2 first meets a scope that has ALREADY shipped it does not pin those units at all — dispatch has
 * consumed their layers, so it takes their VALUE from the shipment snapshots and pins only the
 * remainder. The row then holds a pin (4 on the shelf) BESIDE a shipment that predates it (6 gone),
 * describing disjoint units that total 10 — and `max` answers 6. The next pass therefore found 4
 * "unaccounted", re-pinned them and POSTED THEM A SECOND TIME, every time the order came back.
 *
 * The fix is not a cleverer inference over two ambiguous records; there is nothing on the row that
 * distinguishes the two cases. It is `unrecordedShippedQty`: dispatched quantity the pin does not
 * account for, which A2 now WRITES ONTO THE ROW as shipment-source entries in the same pass that
 * values it. The pin becomes the complete record of accounted quantity, `max` is never again asked a
 * question it cannot answer, and the residual is pinned once.
 */
export function accountedAllocationQty(input: {
  snapshot: CostLayerSnapshotEntry[]
  shippedQty: DecimalInput
}): { accounted: Decimal; unrecordedShippedQty: Decimal } {
  const pinned = sumCostLayerSnapshotQty(input.snapshot)
  const uncovered = roundQuantity(toDecimal(input.shippedQty).sub(pinned), 6)
  const unrecordedShippedQty = uncovered.gt('0.0000001') ? uncovered : toDecimal(0)
  // pinned + max(0, shipped - pinned) is max(pinned, shipped) — r5's rule, unchanged — split so the
  // part that is accounted but UNRECORDED can be written down instead of re-derived next pass.
  return { accounted: pinned.add(unrecordedShippedQty), unrecordedShippedQty }
}

/**
 * How much of an allocation row's quantity Group A2 has NOT yet reclassified into Allocated
 * Inventory — the row's allocated quantity less {@link accountedAllocationQty}, floored at zero
 * because a refund or a shrunk row can leave more accounted than allocated.
 */
export function unaccountedAllocationQty(input: {
  allocatedQty: DecimalInput
  snapshot: CostLayerSnapshotEntry[]
  shippedQty: DecimalInput
}): Decimal {
  const { accounted } = accountedAllocationQty(input)
  const outstanding = roundQuantity(toDecimal(input.allocatedQty).sub(accounted), 6)
  return outstanding.gt('0.0000001') ? outstanding : toDecimal(0)
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

/**
 * Reduce snapshot entries by a flat quantity, FIFO across entries regardless of
 * costLayerId. Used to relieve a per-allocation Allocated-Inventory contra by the
 * shipped/refunded qty even when dispatch consumed different cost layers than the
 * allocation pinned (cogs-audit scjz.21): the contra is a single account, so only
 * the qty matters for clearing it, not which specific layer was consumed.
 */
export function reduceSnapshotByQty(
  baseEntries: CostLayerSnapshotEntry[],
  qty: DecimalInput,
): CostLayerSnapshotEntry[] {
  const remaining = baseEntries.map((entry) => ({ ...entry }))
  let qtyToRemove = toDecimal(qty)
  for (const entry of remaining) {
    if (qtyToRemove.lte(0)) break
    const entryQty = toDecimal(entry.qty)
    const take = entryQty.lt(qtyToRemove) ? entryQty : qtyToRemove
    if (take.lte(0)) continue
    entry.qty = roundQuantity(entryQty.sub(take), 6).toFixed(6)
    qtyToRemove = qtyToRemove.sub(take)
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
