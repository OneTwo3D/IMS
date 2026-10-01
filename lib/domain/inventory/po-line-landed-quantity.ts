/**
 * THE one definition of "how much of this purchase-order line has already landed" (o3d-papk).
 *
 * WHY THIS EXISTS. Two columns record the same fact and, until this module, every reader picked one:
 *
 *   · `purchase_order_lines.qtyReceived` — incremented by the manual receipt (`receivePurchaseOrder`) and by
 *     the WMS webhook book-in (booked-in-service).
 *   · `wms_asn_line_maps.qtyAccountedViaSnapshot` — incremented by the WMS stock-sync ALIGNMENT, which brings
 *     the units into stock, lays their cost layer (with the PO line) and queues the STOCK_RECEIPT journal
 *     WITHOUT ever writing `qtyReceived`.
 *
 * So an aligned PO line has landed units and a `qtyReceived` of zero, and every reader that asked only
 * `qty - qtyReceived` concluded the units had not arrived. The worst of them was the operator's manual
 * receipt: it accepted the full line quantity on top of the units alignment had already booked, so stock
 * went up by more than the physical goods, with a second cost layer and a second journal (o3d-papk,
 * "Sequence A").
 *
 * THE COMBINATOR IS `qtyReceived + Σ unabsorbed snapshot`, NOT a max and not a plain sum of both columns.
 * The two counters overlap by design: when the WMS book-in arrives for units alignment had already credited,
 * `reconcileBookedInQuantities` folds them into `qtyReceived` and records the same amount on
 * `qtyAccountedViaReceipt`. `max(0, qtyAccountedViaSnapshot - qtyAccountedViaReceipt)` is therefore the part
 * of the credit NOT yet in `qtyReceived`. Summed over EVERY ASN row of the line — CLOSED AND RETIRED ROWS
 * INCLUDED, because a retired reservation's credit is still real stock — it counts each landed unit exactly
 * once, including when one line spans several ASNs (which a `max` over the rows silently under-counts).
 *
 * This is the transfer combinator (transfer-landed-quantity.ts) without the dispatch snapshot: a PO line has
 * none. It is a SEPARATE module with its OWN brands on purpose — a PO answer accepted where a transfer
 * answer is meant (or the reverse) must not type-check, which is the confusion round 7 of 6oyu.19 had to
 * undo for the two transfer residues.
 *
 * WRITE-THROUGH (alignment writing `qtyReceived`) IS REJECTED: `reconcileBookedInQuantities` treats the
 * LINE-wide `qtyReceived` as manual receipts against THIS ASN, so units alignment had parked there would be
 * read as manual and a replacement ASN would add no stock.
 *
 * CANCELLED. Landed stays a physical fact; OUTSTANDING is gated by the order's status — a CANCELLED or CLOSED
 * order expects nothing more, so its outstanding is 0 whatever its lines say.
 *
 * RETURNS ARE NOT SUBTRACTED: a returned unit did land. (The returns, invoicing and statistics readers stay
 * on `qtyReceived` for now: bead o3d-nnics.)
 */

import type { Decimal, DecimalInput } from '@/lib/domain/math/decimal'
import { addMoney, roundQuantity, subtractMoney, toDecimal } from '@/lib/domain/math/decimal'

/**
 * Quantity tolerance, matching WMS_RECEIPT_QTY_EPSILON in lib/domain/wms/asn-reconciliation.ts. Re-declared
 * rather than imported so this module has no dependency on the WMS reconciliation code.
 */
export const PO_LANDED_QTY_EPSILON = 0.0001

/** Purchase-order statuses that expect nothing more: outstanding is zero whatever the lines say. */
export const PO_STATUSES_EXPECTING_NOTHING = ['CANCELLED', 'CLOSED'] as const

/** Can a WMS receipt (alignment or book-in) still be brought to rest against an order in this status? */
export function isPurchaseOrderUsableForWmsReceipt(status: string): boolean {
  return !(PO_STATUSES_EXPECTING_NOTHING as ReadonlyArray<string>).includes(status)
}

declare const PO_LINE_LANDED_QTY_BRAND: unique symbol

/**
 * The answer to "how much of this purchase-order line has already landed". BRANDED ON PURPOSE: the brand is
 * a `declare`d unique symbol, so nothing outside this module can produce one. A caller passing
 * `Number(line.qtyReceived)`, a credit column or a hand-made object fails to compile.
 */
export type PurchaseOrderLineLandedQty = {
  readonly [PO_LINE_LANDED_QTY_BRAND]: 'purchase-order-line-landed-qty'
  readonly poLineId: string
  /** Total landed quantity, to 6dp. */
  readonly qty: Decimal
  readonly qtyNumber: number
  /** The `purchase_order_lines.qtyReceived` component. */
  readonly fromQtyReceived: Decimal
  /** Σ max(0, qtyAccountedViaSnapshot − qtyAccountedViaReceipt) over EVERY ASN row of the line. */
  readonly fromUnabsorbedWmsSnapshot: Decimal
}

/** The two WMS counters this module reads from one `wms_asn_line_maps` row. */
export type PurchaseOrderLineWmsAsnCounters = {
  qtyAccountedViaSnapshot: DecimalInput
  qtyAccountedViaReceipt: DecimalInput
}

function maxZero(value: Decimal): Decimal {
  return value.lt(0) ? toDecimal(0) : value
}

/**
 * The part of one ASN row's alignment credit that a webhook receipt has NOT yet folded into `qtyReceived`.
 * Floored at zero: once a receipt has absorbed the whole credit the columns are equal, and a remote
 * regression can push `qtyAccountedViaReceipt` past the snapshot without units un-landing.
 */
function unabsorbedSnapshotQty(row: PurchaseOrderLineWmsAsnCounters): Decimal {
  return maxZero(subtractMoney(toDecimal(row.qtyAccountedViaSnapshot), toDecimal(row.qtyAccountedViaReceipt)))
}

/**
 * Build the landed quantity for one PO line. THE ONLY constructor of `PurchaseOrderLineLandedQty`.
 *
 * `wmsAsnLines` must be EVERY `wms_asn_line_maps` row with `sourceType = 'PURCHASE_ORDER_LINE'` and this
 * `sourceLineId`, closed rows included. Pass an empty array when the line never went near a 3PL.
 */
export function resolvePurchaseOrderLineLandedQty(input: {
  poLineId: string
  qtyReceived: DecimalInput
  wmsAsnLines: ReadonlyArray<PurchaseOrderLineWmsAsnCounters>
}): PurchaseOrderLineLandedQty {
  const qtyReceived = maxZero(toDecimal(input.qtyReceived))
  const unabsorbed = input.wmsAsnLines.reduce(
    (sum, row) => addMoney(sum, unabsorbedSnapshotQty(row)),
    toDecimal(0),
  )
  const total = roundQuantity(addMoney(qtyReceived, unabsorbed), 6)
  return {
    poLineId: input.poLineId,
    qty: total,
    qtyNumber: total.toNumber(),
    fromQtyReceived: roundQuantity(qtyReceived, 6),
    fromUnabsorbedWmsSnapshot: roundQuantity(unabsorbed, 6),
  } as PurchaseOrderLineLandedQty
}

/** The minimum a client must expose for the loaders. */
export type PurchaseOrderLandedQtyClient = {
  wmsAsnLineMap: {
    findMany: (args: {
      where: { sourceType: 'PURCHASE_ORDER_LINE'; sourceLineId: { in: string[] } }
      select: { sourceLineId: true; qtyAccountedViaSnapshot: true; qtyAccountedViaReceipt: true }
    }) => Promise<Array<{
      sourceLineId: string
      qtyAccountedViaSnapshot: DecimalInput
      qtyAccountedViaReceipt: DecimalInput
    }>>
  }
}

/**
 * Landed quantity for a set of PO lines in ONE query. NO `closedAt` FILTER, deliberately: a retired
 * reservation's credit is still real stock.
 *
 * Pass the transaction client when the answer has to agree with rows the same transaction has locked. The
 * landed read needs no line lock of its own: every writer of a PO row's credit columns (alignment, the
 * book-in, the retirement disposal) holds the `purchase_orders` row first (the #715 gate), so a read taken
 * under that row lock cannot interleave with one.
 */
export async function loadPurchaseOrderLineLandedQty(
  client: PurchaseOrderLandedQtyClient,
  lines: ReadonlyArray<{ id: string; qtyReceived: DecimalInput }>,
): Promise<Map<string, PurchaseOrderLineLandedQty>> {
  const result = new Map<string, PurchaseOrderLineLandedQty>()
  if (lines.length === 0) return result

  const asnRows = await client.wmsAsnLineMap.findMany({
    where: { sourceType: 'PURCHASE_ORDER_LINE', sourceLineId: { in: lines.map((line) => line.id) } },
    select: { sourceLineId: true, qtyAccountedViaSnapshot: true, qtyAccountedViaReceipt: true },
  })
  const byLineId = new Map<string, PurchaseOrderLineWmsAsnCounters[]>()
  for (const row of asnRows) {
    const bucket = byLineId.get(row.sourceLineId)
    if (bucket) bucket.push(row)
    else byLineId.set(row.sourceLineId, [row])
  }

  for (const line of lines) {
    result.set(line.id, resolvePurchaseOrderLineLandedQty({
      poLineId: line.id,
      qtyReceived: line.qtyReceived,
      wmsAsnLines: byLineId.get(line.id) ?? [],
    }))
  }
  return result
}

/**
 * One line's landed quantity out of a map built by `loadPurchaseOrderLineLandedQty`. Throws rather than
 * defaulting to zero: a missing entry means the caller loaded a different set of lines than it is iterating,
 * and silently answering "nothing has landed" is the failure this module exists to remove.
 */
export function requirePoLineLandedQty(
  landedByLineId: ReadonlyMap<string, PurchaseOrderLineLandedQty>,
  poLineId: string,
): PurchaseOrderLineLandedQty {
  const landed = landedByLineId.get(poLineId)
  if (!landed) {
    throw new Error(
      `requirePoLineLandedQty: no landed quantity was loaded for purchase-order line ${poLineId}. ` +
      'Load it with loadPurchaseOrderLineLandedQty over the SAME set of lines being iterated (o3d-papk).',
    )
  }
  return landed
}

/** Is the whole line accounted for? The RECEIVED status derivation: landed >= qty. */
export function isPurchaseOrderLineFullyLanded(lineQty: DecimalInput, landed: PurchaseOrderLineLandedQty): boolean {
  return maxZero(roundQuantity(subtractMoney(toDecimal(lineQty), landed.qty), 6)).lte(PO_LANDED_QTY_EPSILON)
}

// ---------------------------------------------------------------------------
// OUTSTANDING: "HOW MUCH IS STILL COMING?"
// ---------------------------------------------------------------------------

declare const PO_LINE_OUTSTANDING_QTY_BRAND: unique symbol

/**
 * LINE SCOPE: how much of a PO line has not landed yet — `max(0, lineQty − landed)`, gated to ZERO when the
 * order's status expects nothing more (CANCELLED, CLOSED).
 */
export type PurchaseOrderLineOutstandingQty = {
  readonly [PO_LINE_OUTSTANDING_QTY_BRAND]: 'purchase-order-line-outstanding-qty'
  readonly poLineId: string
  readonly qty: Decimal
  readonly qtyNumber: number
  /** The landed quantity this was derived from, so a diagnostic can name both arms. */
  readonly landed: PurchaseOrderLineLandedQty
}

/** THE ONLY constructor of `PurchaseOrderLineOutstandingQty`. */
export function resolvePurchaseOrderLineOutstandingQty(input: {
  lineQty: DecimalInput
  landed: PurchaseOrderLineLandedQty
  poStatus: string
}): PurchaseOrderLineOutstandingQty {
  const qty = isPurchaseOrderUsableForWmsReceipt(input.poStatus)
    ? maxZero(roundQuantity(subtractMoney(toDecimal(input.lineQty), input.landed.qty), 6))
    : toDecimal(0)
  return {
    poLineId: input.landed.poLineId,
    qty,
    qtyNumber: qty.toNumber(),
    landed: input.landed,
  } as PurchaseOrderLineOutstandingQty
}

/** Outstanding for a set of lines in ONE extra query. Each line carries its own order's status. */
export async function loadPurchaseOrderLineOutstandingQty(
  client: PurchaseOrderLandedQtyClient,
  lines: ReadonlyArray<{ id: string; qty: DecimalInput; qtyReceived: DecimalInput; poStatus: string }>,
): Promise<Map<string, PurchaseOrderLineOutstandingQty>> {
  const landedByLineId = await loadPurchaseOrderLineLandedQty(client, lines)
  const result = new Map<string, PurchaseOrderLineOutstandingQty>()
  for (const line of lines) {
    result.set(line.id, resolvePurchaseOrderLineOutstandingQty({
      lineQty: line.qty,
      landed: requirePoLineLandedQty(landedByLineId, line.id),
      poStatus: line.poStatus,
    }))
  }
  return result
}

/** As `requirePoLineLandedQty`, for the outstanding map. Throws rather than defaulting. */
export function requirePoLineOutstandingQty(
  outstandingByLineId: ReadonlyMap<string, PurchaseOrderLineOutstandingQty>,
  poLineId: string,
): PurchaseOrderLineOutstandingQty {
  const outstanding = outstandingByLineId.get(poLineId)
  if (!outstanding) {
    throw new Error(
      `requirePoLineOutstandingQty: no outstanding quantity was loaded for purchase-order line ${poLineId}. ` +
      'Load it with loadPurchaseOrderLineOutstandingQty over the SAME set of lines being iterated (o3d-papk).',
    )
  }
  return outstanding
}

/** Is any part of this line still to come? The gate and badge predicate. */
export function hasPoOutstandingQty(outstanding: PurchaseOrderLineOutstandingQty): boolean {
  return outstanding.qty.gt(PO_LANDED_QTY_EPSILON)
}

/** Are two readings of the SAME line's outstanding quantity the same reading? */
export function poOutstandingQtyEquals(
  left: PurchaseOrderLineOutstandingQty,
  right: PurchaseOrderLineOutstandingQty,
): boolean {
  return left.poLineId === right.poLineId && left.qty.equals(right.qty)
}

/** Total outstanding over a set of lines. Takes the branded values and nothing else. */
export function sumPurchaseOrderLineOutstandingQty(values: Iterable<PurchaseOrderLineOutstandingQty>): Decimal {
  let total = toDecimal(0)
  for (const value of values) total = addMoney(total, value.qty)
  return roundQuantity(total, 6)
}

// ---------------------------------------------------------------------------
// THE ALLOCATOR'S LINE CAP (WMS stock-sync alignment)
// ---------------------------------------------------------------------------

declare const PO_LINE_RESIDUAL_QTY_BRAND: unique symbol

/**
 * LINE SCOPE, FOR AN ALLOCATOR: how many more units alignment may bring to rest against this PO line, across
 * every ASN row it spans: `max(0, lineQty − landed)`. A PO line has no snapshot that could cap it further.
 *
 * DELIBERATELY NOT GATED BY THE ORDER'S STATUS, unlike `PurchaseOrderLineOutstandingQty`. A CANCELLED or
 * CLOSED order is refused by its own predicate (`isPurchaseOrderUsableForWmsReceipt`, reported to the
 * operator as `unusable`); folding the status into this figure too would let either mechanism hide the
 * other's failure.
 *
 * A SEPARATE type from the per-ASN residue (`WmsAsnLineResidualQty`, one row's own room) so the two cannot be
 * swapped: applying either cap alone is a defect, exactly as for transfers (6oyu.19 rounds 6 and 7).
 */
export type PurchaseOrderLineResidualQty = {
  readonly [PO_LINE_RESIDUAL_QTY_BRAND]: 'purchase-order-line-residual-qty'
  readonly poLineId: string
  readonly qty: Decimal
  readonly qtyNumber: number
}

/** LINE-SCOPE residue for an allocator. THE ONLY constructor of `PurchaseOrderLineResidualQty`. */
export function resolvePurchaseOrderLineResidualQty(input: {
  lineQty: DecimalInput
  landed: PurchaseOrderLineLandedQty
}): PurchaseOrderLineResidualQty {
  const qty = maxZero(roundQuantity(subtractMoney(toDecimal(input.lineQty), input.landed.qty), 6))
  return {
    poLineId: input.landed.poLineId,
    qty,
    qtyNumber: qty.toNumber(),
  } as PurchaseOrderLineResidualQty
}

/** The line's residue out of a map keyed by PO-line id. Throws rather than defaulting to "no cap". */
export function requirePurchaseOrderLineResidualQty(
  residualByLineId: ReadonlyMap<string, PurchaseOrderLineResidualQty>,
  poLineId: string,
): PurchaseOrderLineResidualQty {
  const residual = residualByLineId.get(poLineId)
  if (!residual) {
    throw new Error(
      `requirePurchaseOrderLineResidualQty: no line-scope residual quantity was loaded for purchase-order line ${poLineId}. ` +
      'Build it with resolvePurchaseOrderLineResidualQty over the SAME set of lines being allocated against (o3d-papk).',
    )
  }
  return residual
}

// ---------------------------------------------------------------------------
// AGGREGATION THAT KEEPS THE BRAND
// ---------------------------------------------------------------------------

declare const PO_OUTSTANDING_TOTALS_BRAND: unique symbol

/**
 * Outstanding quantity totalled per key (per product for the incoming badges, per destination warehouse for
 * the per-warehouse block). Only `aggregatePurchaseOrderLineOutstandingQty` builds one, from branded
 * per-line values, so `qty − qtyReceived` cannot enter the pipeline through an accumulator.
 */
export type PurchaseOrderOutstandingTotals<K> = {
  readonly [PO_OUTSTANDING_TOTALS_BRAND]: 'purchase-order-outstanding-totals'
  readonly totals: ReadonlyMap<K, Decimal>
  /** How many lines went into each key's total, so a test can assert it saw them. */
  readonly lineCounts: ReadonlyMap<K, number>
}

/** THE ONLY constructor of `PurchaseOrderOutstandingTotals`. */
export function aggregatePurchaseOrderLineOutstandingQty<K>(
  entries: Iterable<readonly [K, PurchaseOrderLineOutstandingQty]>,
): PurchaseOrderOutstandingTotals<K> {
  const totals = new Map<K, Decimal>()
  const lineCounts = new Map<K, number>()
  for (const [key, outstanding] of entries) {
    totals.set(key, roundQuantity(addMoney(totals.get(key) ?? toDecimal(0), outstanding.qty), 6))
    lineCounts.set(key, (lineCounts.get(key) ?? 0) + 1)
  }
  return { totals, lineCounts } as unknown as PurchaseOrderOutstandingTotals<K>
}

/** OUTPUT BOUNDARY: the keys with something still to come, and how much. */
export function purchaseOrderOutstandingTotalEntries<K>(
  totals: PurchaseOrderOutstandingTotals<K>,
): Array<[K, number]> {
  const entries: Array<[K, number]> = []
  for (const [key, total] of totals.totals) {
    if (total.gt(PO_LANDED_QTY_EPSILON)) entries.push([key, total.toNumber()])
  }
  return entries
}

/** OUTPUT BOUNDARY: one key's total, zero when the key contributed nothing. */
export function readPurchaseOrderOutstandingTotal<K>(totals: PurchaseOrderOutstandingTotals<K>, key: K): number {
  const total = totals.totals.get(key)
  return total && total.gt(PO_LANDED_QTY_EPSILON) ? total.toNumber() : 0
}
