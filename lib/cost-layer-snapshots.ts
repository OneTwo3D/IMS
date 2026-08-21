import { addMoney, multiplyMoney, roundQuantity, toDecimal, type Decimal, type DecimalInput } from '@/lib/domain/math/decimal'

export type CostLayerSnapshotSource = 'allocation' | 'shipment'

export type CostLayerSnapshotEntry = {
  costLayerId: string
  qty: DecimalInput
  unitCostBase: DecimalInput
  orderAllocationId?: string
  shipmentLineId?: string
  source?: CostLayerSnapshotSource
  /**
   * THE AMOUNT A POSTING RECORDED FOR THIS ENTRY, per unit (o3d-0i5y r9).
   *
   * `unitCostBase` is the layer's cost as it stands NOW, and it is REWRITTEN IN PLACE whenever a
   * landed-cost correction revalues the layer (`updateSnapshotsForCostLayerChange` patches every
   * `costLayerSnapshot` in the database, this one included). That makes it useless as evidence of
   * what a journal moved: a revaluation posts to COGS/Inventory and never to Allocated Inventory,
   * so the pounds Group A2 debited stay exactly what they were while the pin underneath them
   * changes.
   *
   * So the pass that VALUES an entry stamps what it valued it at, in the same statement that
   * writes the entry and the same transaction that raises the journal — and nothing downstream
   * rewrites it. An entry carrying this field is therefore POSITIVE EVIDENCE that a journal was
   * raised for it, at this amount; an entry without one says nothing, and a path that reverses
   * must fail closed on it rather than reverse the revalued pin. This is the same rule
   * `o3d-batch-cancelrb` applied on the refund side with `SalesOrder.allocationBatchAmount` — the
   * record is written BY the posting it stands for — at the grain the record has to survive at
   * here, which is the UNIT, because the units move between rows.
   */
  postedUnitCostBase?: DecimalInput
}

export type SerializableCostLayerSnapshotEntry = Omit<CostLayerSnapshotEntry, 'qty' | 'unitCostBase'> & {
  qty: DecimalInput
  unitCostBase: DecimalInput
}

export type SerializedCostLayerSnapshotEntry = Omit<CostLayerSnapshotEntry, 'qty' | 'unitCostBase' | 'postedUnitCostBase'> & {
  qty: string
  unitCostBase: string
  postedUnitCostBase?: string
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
    // o3d-0i5y r9: carried through serialization untouched, INCLUDING by the revaluation rewrite
    // — which re-serializes each patched entry from a spread of the stored row, so the posted
    // amount survives the very rewrite that changes `unitCostBase` out from under it.
    ...(entry.postedUnitCostBase != null
      ? { postedUnitCostBase: roundQuantity(entry.postedUnitCostBase, 6).toFixed(6) }
      : {}),
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
      postedUnitCostBase: parsePostedUnitCostBase(row.postedUnitCostBase),
    }]
  })
}

/**
 * o3d-0i5y r9: a missing/unparseable posted amount is NOT zero and NOT the live pin — it is
 * "this entry cannot say what was posted for it", which every reversal path has to see as such.
 */
function parsePostedUnitCostBase(value: unknown): string | undefined {
  if (value == null) return undefined
  try {
    const parsed = roundQuantity(value as DecimalInput, 6)
    return parsed.lt(0) ? undefined : parsed.toFixed(6)
  } catch {
    return undefined
  }
}

/**
 * Value a set of entries AT WHAT WAS POSTED FOR THEM, and say which of them could not answer
 * (o3d-0i5y r9).
 *
 * {@link sumCostLayerSnapshot} answers "what are these units worth today", which is the right
 * question for pricing a new posting and the wrong one for reversing an old one. A reversal
 * posted wrongly is as bad as the original, so this one splits the answer: `posted` covers only
 * the entries that carry their own record of what a journal moved, and `unevidenced` is
 * everything else, for the caller to report rather than guess at.
 */
export function sumPostedCostLayerSnapshot(entries: CostLayerSnapshotEntry[]): {
  posted: Decimal
  unevidenced: CostLayerSnapshotEntry[]
} {
  let posted = toDecimal(0)
  const unevidenced: CostLayerSnapshotEntry[] = []
  for (const entry of entries) {
    if (entry.postedUnitCostBase == null) {
      unevidenced.push(entry)
      continue
    }
    posted = addMoney(posted, multiplyMoney(entry.qty, entry.postedUnitCostBase))
  }
  return { posted, unevidenced }
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
      // o3d-0i5y r9: this function REBUILDS each entry field by field, so anything not named here
      // is dropped. The posted amount is carried through every take — the record has to follow the
      // units when a rewrite moves them between rows, and this is the only path they move by.
      postedUnitCostBase: decorate?.postedUnitCostBase ?? entry.postedUnitCostBase,
    })
    remainingQty = remainingQty.sub(take)
  }

  return { taken, remainingQty: remainingQty.toNumber() }
}

/**
 * The dispatched entries a pass may still value: `candidates` LESS the ones the row's own record
 * already accounts for (o3d-0i5y r8).
 *
 * WHAT HAS BEEN POSTED IS A RECORDED FACT, NOT A QUANTITY RE-DERIVED EACH PASS. r6 and r7 got the
 * QUANTITY right — {@link accountedAllocationQty} answers how many dispatched units no entry on the
 * row accounts for — and then chose the ENTRIES for that quantity by re-deriving them: taking FIFO
 * from every dispatched line at the scope, as though none of them had ever been taken from. They
 * had. The units a pass records are taken out of exactly this pool and written onto the row, so on
 * the next pass the front of the pool is entries that are already in the ledger:
 *
 *   pass 1  6 units dispatched from shipment line S1 at £10. Nothing is pinned, so all 6 are
 *           unrecorded; A2 takes 6 × £10 from S1, records them, and posts £60.
 *   pass 2  a residual of 4 has since dispatched from S2 at £2. `accountedAllocationQty` says 4
 *           units are unrecorded — correct. The take then walks the pool from the front and hands
 *           back 4 MORE units of S1 at £10, so A2 posts £40 for units that cost £8, re-presenting
 *           £40 of S1's already-posted cost as new. The row ends up claiming 10 units of a layer
 *           the dispatch only consumed 6 of, which Group B and the refund reversal then relieve
 *           against.
 *
 * Netting the pool by the record makes that impossible rather than unlikely: an entry can be valued
 * ONCE, because the record of having valued it is subtracted before anything is taken. Only
 * `source: 'shipment'` entries net the pool — an allocation-source pin describes units on the shelf
 * that overlap the dispatch rather than coming out of it, which is the overlap `accountedAllocationQty`
 * resolves with `max` and must not be double-charged here.
 *
 * Matched on (shipmentLineId, costLayerId) so a line partly recorded by an earlier pass offers only
 * its remainder; a record that carries no `shipmentLineId` nets by layer alone, which is the most a
 * pre-r6 entry can say about itself.
 */
export function unrecordedShipmentEntries(
  recorded: CostLayerSnapshotEntry[],
  candidates: CostLayerSnapshotEntry[],
): CostLayerSnapshotEntry[] {
  const byShipmentLine = new Map<string, Decimal>()
  const byLayerOnly = new Map<string, Decimal>()
  for (const entry of recorded) {
    if (entry.source !== 'shipment') continue
    const pool = entry.shipmentLineId ? byShipmentLine : byLayerOnly
    const key = entry.shipmentLineId ? `${entry.shipmentLineId}|${entry.costLayerId}` : entry.costLayerId
    pool.set(key, (pool.get(key) ?? toDecimal(0)).add(toDecimal(entry.qty)))
  }

  const consume = (pool: Map<string, Decimal>, key: string, qty: Decimal): Decimal => {
    const available = pool.get(key)
    if (!available || available.lte(0)) return qty
    const take = available.lt(qty) ? available : qty
    pool.set(key, available.sub(take))
    return qty.sub(take)
  }

  const remaining: CostLayerSnapshotEntry[] = []
  for (const entry of candidates) {
    let qty = toDecimal(entry.qty)
    if (entry.shipmentLineId) {
      qty = consume(byShipmentLine, `${entry.shipmentLineId}|${entry.costLayerId}`, qty)
    }
    if (qty.gt(0)) qty = consume(byLayerOnly, entry.costLayerId, qty)
    if (qty.gt('0.0000001')) {
      remaining.push({ ...entry, qty: roundQuantity(qty, 6).toFixed(6) })
    }
  }
  return remaining
}
