/**
 * THE one definition of "how much of this stock-transfer line has already landed".
 *
 * WHY THIS EXISTS (6oyu.19, Codex round-6 HIGH-1). Two columns record the same
 * fact, and until this module every reader picked one of them:
 *
 *   · `stock_transfer_lines.qtyReceived` — incremented by the manual receipt paths
 *     (receiveTransfer, receiveTransferPartial) and by the WMS webhook book-in
 *     (booked-in-service).
 *   · `wms_asn_line_maps.qtyAccountedViaSnapshot` — incremented by the WMS
 *     stock-sync ALIGNMENT path, which brings units into stock and lays down their
 *     cost layers WITHOUT ever touching `qtyReceived`.
 *
 * So an aligned transfer line has landed units and a `qtyReceived` of zero. Every
 * reader that asked only `qtyReceived` therefore concluded "nothing has arrived":
 *
 *   · `cancelDispatchedTransfer` allowed the cancellation, restored the FULL line
 *     quantity to source and created a SECOND set of replacement cost layers linked
 *     back to the same source layer. A later landed-cost revaluation then propagated
 *     into both live layers and posted the inventory reclassification TWICE for one
 *     dispatch. That is the original 6oyu.19 defect's own shape — transit debited
 *     once, drained twice — one route over.
 *   · the manual receipt paths sliced the dispatch snapshot from offset zero and
 *     re-laid layers the alignment had already laid (the same double-count, reached
 *     from the other side).
 *   · the alignment path itself sliced from `qtyAccountedViaSnapshot` alone, so a
 *     manual receipt followed by an alignment double-costed in the same way.
 *
 * Adding the second column to the cancellation check would have left the next
 * reader to discover a third. So the QUESTION is defined once, here, and the answer
 * is a value only this module can construct — see `TransferLineLandedQty`. Every
 * consumer takes that type rather than a number, so a reader that reaches for one
 * raw column cannot type-check.
 *
 * THE COMBINATOR IS `qtyReceived + Σ unabsorbed snapshot`, NOT a max, and not a
 * plain sum of both columns. The two counters OVERLAP by design: when a WMS webhook
 * receipt arrives for units the alignment had already credited,
 * `reconcileBookedInQuantities` folds them into `qtyReceived` and records the same
 * amount on `qtyAccountedViaReceipt`. `max(0, qtyAccountedViaSnapshot −
 * qtyAccountedViaReceipt)` is therefore the portion of the alignment credit NOT yet
 * reflected in `qtyReceived` — the codebase already names it `unabsorbedFromSnapshot`
 * (lib/domain/wms/asn-reconciliation.ts). Adding that to `qtyReceived` counts each
 * landed unit exactly once, including when one transfer line spans several ASNs,
 * which a `max` over the two columns silently under-counts.
 *
 * WHAT THIS IS NOT. It is not "how much is at the DESTINATION warehouse" — a
 * dispatch cancellation lands units back at the SOURCE, and both count as landed
 * because the question every reader is really asking is "how much of this line has
 * come to rest somewhere and been laid into cost layers", i.e. how much of the
 * dispatch snapshot has already been consumed. That is exactly the offset
 * `sliceTransferSnapshotForReceipt` needs.
 */

import type { Decimal, DecimalInput } from '@/lib/domain/math/decimal'
import { addMoney, roundQuantity, subtractMoney, toDecimal } from '@/lib/domain/math/decimal'

/**
 * Quantity tolerance, matching WMS_RECEIPT_QTY_EPSILON in
 * lib/domain/wms/asn-reconciliation.ts. Deliberately re-declared rather than
 * imported: that module imports the branded type from here, and a cycle between the
 * two would make the brand's initialisation order load-bearing.
 */
export const TRANSFER_LANDED_QTY_EPSILON = 0.0001

declare const TRANSFER_LANDED_QTY_BRAND: unique symbol

/**
 * The answer to "how much of this transfer line has already landed".
 *
 * BRANDED ON PURPOSE. The brand is a `declare`d unique symbol, so no code outside
 * this module can produce a value of this type — a caller that passes
 * `Number(line.qtyReceived)`, or `candidate.qtyAccountedViaSnapshot`, or a hand-made
 * object literal, fails to compile. That is what makes "every reader asks the same
 * question" a property of the type system rather than a convention someone has to
 * remember, and it is why the four snapshot-slice call sites can no longer drift
 * apart the way they had.
 *
 * The components are carried alongside the total so that a diagnostic, an audit
 * entry or a test can say WHICH counter contributed — the round-6 finding was
 * invisible partly because nothing ever reported the two figures together.
 */
export type TransferLineLandedQty = {
  readonly [TRANSFER_LANDED_QTY_BRAND]: 'transfer-line-landed-qty'
  readonly transferLineId: string
  /** Total landed quantity, to 6dp. */
  readonly qty: Decimal
  /** The same figure as a number, for the number-based snapshot slicer. */
  readonly qtyNumber: number
  /** The `stock_transfer_lines.qtyReceived` component. */
  readonly fromQtyReceived: Decimal
  /** Σ max(0, qtyAccountedViaSnapshot − qtyAccountedViaReceipt) over the line's ASN rows. */
  readonly fromUnabsorbedWmsSnapshot: Decimal
}

/** The two WMS counters this module reads, from one `wms_asn_line_maps` row. */
export type TransferLineWmsAsnCounters = {
  qtyAccountedViaSnapshot: DecimalInput
  qtyAccountedViaReceipt: DecimalInput
}

/**
 * Build the landed quantity for one transfer line. THE ONLY constructor of
 * `TransferLineLandedQty`.
 *
 * `wmsAsnLines` must be EVERY `wms_asn_line_maps` row whose
 * `sourceType = 'STOCK_TRANSFER_LINE'` and `sourceLineId` is this line — pass an
 * empty array when the line has no WMS ASN at all, which is the ordinary case for a
 * transfer that never went near a 3PL. `loadTransferLineLandedQty` below is how a
 * caller with a database client gets them.
 */
export function resolveTransferLineLandedQty(input: {
  transferLineId: string
  qtyReceived: DecimalInput
  wmsAsnLines: ReadonlyArray<TransferLineWmsAsnCounters>
}): TransferLineLandedQty {
  const qtyReceived = maxZero(toDecimal(input.qtyReceived))
  const unabsorbed = input.wmsAsnLines.reduce(
    (sum, row) => addMoney(sum, unabsorbedSnapshotQty(row)),
    toDecimal(0),
  )
  const total = roundQuantity(addMoney(qtyReceived, unabsorbed), 6)
  return {
    transferLineId: input.transferLineId,
    qty: total,
    qtyNumber: total.toNumber(),
    fromQtyReceived: roundQuantity(qtyReceived, 6),
    fromUnabsorbedWmsSnapshot: roundQuantity(unabsorbed, 6),
  } as TransferLineLandedQty
}

/**
 * The portion of one ASN line's alignment credit that a webhook receipt has NOT yet
 * folded into `stock_transfer_lines.qtyReceived`. Floored at zero: once a receipt
 * has absorbed the whole credit the two columns are equal, and a remote regression
 * can push `qtyAccountedViaReceipt` past the snapshot without meaning that units
 * un-landed.
 */
function unabsorbedSnapshotQty(row: TransferLineWmsAsnCounters): Decimal {
  return maxZero(subtractMoney(toDecimal(row.qtyAccountedViaSnapshot), toDecimal(row.qtyAccountedViaReceipt)))
}

function maxZero(value: Decimal): Decimal {
  return value.lt(0) ? toDecimal(0) : value
}

/** The minimum a client must expose for `loadTransferLineLandedQty`. */
export type TransferLandedQtyClient = {
  wmsAsnLineMap: {
    findMany: (args: {
      where: { sourceType: 'STOCK_TRANSFER_LINE'; sourceLineId: { in: string[] } }
      select: { sourceLineId: true; qtyAccountedViaSnapshot: true; qtyAccountedViaReceipt: true }
    }) => Promise<Array<{
      sourceLineId: string
      qtyAccountedViaSnapshot: DecimalInput
      qtyAccountedViaReceipt: DecimalInput
    }>>
  }
}

/**
 * Landed quantity for a set of transfer lines, in ONE query rather than one per
 * line.
 *
 * Pass the transaction client when the answer has to be consistent with rows the
 * same transaction has locked — the cancellation and both receipt paths do, because
 * a concurrent WMS book-in between the read and the write is precisely the race
 * these counters exist to survive.
 */
export async function loadTransferLineLandedQty(
  client: TransferLandedQtyClient,
  lines: ReadonlyArray<{ id: string; qtyReceived: DecimalInput }>,
): Promise<Map<string, TransferLineLandedQty>> {
  const result = new Map<string, TransferLineLandedQty>()
  if (lines.length === 0) return result

  const asnRows = await client.wmsAsnLineMap.findMany({
    where: { sourceType: 'STOCK_TRANSFER_LINE', sourceLineId: { in: lines.map((line) => line.id) } },
    select: { sourceLineId: true, qtyAccountedViaSnapshot: true, qtyAccountedViaReceipt: true },
  })
  const byLineId = new Map<string, TransferLineWmsAsnCounters[]>()
  for (const row of asnRows) {
    const bucket = byLineId.get(row.sourceLineId)
    if (bucket) bucket.push(row)
    else byLineId.set(row.sourceLineId, [row])
  }

  for (const line of lines) {
    result.set(line.id, resolveTransferLineLandedQty({
      transferLineId: line.id,
      qtyReceived: line.qtyReceived,
      wmsAsnLines: byLineId.get(line.id) ?? [],
    }))
  }
  return result
}

/**
 * The landed quantity for one line out of a map built by
 * `loadTransferLineLandedQty`. Throws rather than defaulting to zero: a missing
 * entry means the caller loaded a different set of lines than it is now iterating,
 * and silently answering "nothing has landed" is the exact failure this module was
 * written to remove.
 */
export function requireLandedQty(
  landedByLineId: ReadonlyMap<string, TransferLineLandedQty>,
  transferLineId: string,
): TransferLineLandedQty {
  const landed = landedByLineId.get(transferLineId)
  if (!landed) {
    throw new Error(
      `requireLandedQty: no landed quantity was loaded for transfer line ${transferLineId}. ` +
      'Load it with loadTransferLineLandedQty over the SAME set of lines being iterated (6oyu.19).',
    )
  }
  return landed
}

/** The minimum a client must expose for `absorbWmsSnapshotCreditIntoQtyReceived`. */
export type TransferLandedQtyAbsorbClient = TransferLandedQtyClient & {
  wmsAsnLineMap: {
    findMany: (args: {
      where: { sourceType: 'STOCK_TRANSFER_LINE'; sourceLineId: string }
      select: { id: true; qtyAccountedViaSnapshot: true; qtyAccountedViaReceipt: true }
      orderBy: { createdAt: 'asc' }
    }) => Promise<Array<{
      id: string
      qtyAccountedViaSnapshot: DecimalInput
      qtyAccountedViaReceipt: DecimalInput
    }>>
    update: (args: {
      where: { id: string }
      data: { qtyAccountedViaReceipt: { increment: string } }
    }) => Promise<unknown>
  }
}

/**
 * MARK WMS ALIGNMENT CREDIT AS ABSORBED, when a caller has just folded those units
 * into `stock_transfer_lines.qtyReceived`.
 *
 * WHY THIS IS NOT OPTIONAL (6oyu.19, Codex round-6 HIGH-1). The landed total is
 * `qtyReceived + Σ unabsorbed snapshot`, and it only stays correct while the two
 * columns cannot both claim the same unit. `receiveTransfer` closes a line by
 * SETTING `qtyReceived` to the full line quantity — including any units a WMS
 * alignment had already credited — so without this call those units would be
 * counted a second time through the snapshot arm and the line would read as
 * over-landed for ever. The WMS webhook path has always done the equivalent
 * (booked-in-service increments `qtyAccountedViaReceipt` by `newlyProcessedQty`);
 * the manual paths never did, because until now they did not know the other column
 * existed.
 *
 * `receiveTransferPartial` does NOT need this: it increments `qtyReceived` only by
 * units drawn from the OUTSTANDING quantity, which already excludes the aligned
 * ones, so the two arms stay disjoint on their own.
 *
 * Absorbs oldest-ASN-first, capped per row at that row's own unabsorbed credit, and
 * returns how much it actually absorbed — which is less than `absorbQty` when the
 * caller offered more than the line had outstanding credit for.
 */
export async function absorbWmsSnapshotCreditIntoQtyReceived(
  client: TransferLandedQtyAbsorbClient,
  transferLineId: string,
  absorbQty: DecimalInput,
): Promise<Decimal> {
  let remaining = maxZero(toDecimal(absorbQty))
  if (remaining.lte(TRANSFER_LANDED_QTY_EPSILON)) return toDecimal(0)

  const rows = await client.wmsAsnLineMap.findMany({
    where: { sourceType: 'STOCK_TRANSFER_LINE', sourceLineId: transferLineId },
    select: { id: true, qtyAccountedViaSnapshot: true, qtyAccountedViaReceipt: true },
    orderBy: { createdAt: 'asc' },
  })

  let absorbed = toDecimal(0)
  for (const row of rows) {
    if (remaining.lte(TRANSFER_LANDED_QTY_EPSILON)) break
    const available = unabsorbedSnapshotQty(row)
    if (available.lte(TRANSFER_LANDED_QTY_EPSILON)) continue
    const take = available.gt(remaining) ? remaining : available
    await client.wmsAsnLineMap.update({
      where: { id: row.id },
      data: { qtyAccountedViaReceipt: { increment: roundQuantity(take, 4).toFixed(4) } },
    })
    absorbed = addMoney(absorbed, take)
    remaining = subtractMoney(remaining, take)
  }
  return roundQuantity(absorbed, 6)
}

/** Has ANY part of this line come to rest yet? The cancellation precondition. */
export function hasAnyLandedQty(landed: TransferLineLandedQty): boolean {
  return landed.qty.gt(TRANSFER_LANDED_QTY_EPSILON)
}

/** How much of `lineQty` has NOT landed yet — floored at zero. */
export function transferLineOutstandingQty(lineQty: DecimalInput, landed: TransferLineLandedQty): Decimal {
  return maxZero(roundQuantity(subtractMoney(toDecimal(lineQty), landed.qty), 6))
}

/** Is the whole line accounted for? The RECEIVED status derivation. */
export function isTransferLineFullyLanded(lineQty: DecimalInput, landed: TransferLineLandedQty): boolean {
  return transferLineOutstandingQty(lineQty, landed).lte(TRANSFER_LANDED_QTY_EPSILON)
}

// ---------------------------------------------------------------------------
// TWO RESIDUES, TWO BRANDS (6oyu.19, Codex round-7 HIGH-2)
// ---------------------------------------------------------------------------

/**
 * `TransferLineLandedQty` above answers exactly ONE question — "how much of this
 * LINE has landed" — and round 6 handed that answer to a caller that needed a
 * DIFFERENT one: "how much room does THIS ASN row still have".
 *
 * The WMS stock-sync alignment planner subtracted the line-wide landed figure from
 * each individual ASN row's own `expectedQty`. For a ten-unit transfer line with three
 * units absorbed on a first, now-closed ASN, the follow-up ASN is correctly raised
 * for the remaining seven — and the planner then subtracted the line-wide three
 * from those seven and exposed four. A seven-unit WMS delta was rejected with
 * three units unallocated, and IMS stock stayed wrong.
 *
 * The brand did not catch it because both figures are "a landed quantity" and only
 * one of them had a name. So there are now two names and two SEPARATE brands:
 *
 *   · `TransferLineResidualQty` — LINE scope. `line.qty − landed`. How many more
 *     units this transfer line may take in EVER, across every ASN it spans.
 *   · `WmsAsnLineResidualQty`   — ASN scope. `expectedQty − this row's own credit`.
 *     How many more units THIS ASN row may absorb.
 *
 * Neither type is assignable to the other, so passing a line-wide figure where a
 * per-ASN residue is required is a compile error rather than a silent
 * under-allocation. A correct allocator needs BOTH, as two separate caps: each
 * allocation is limited by its own ASN row, AND the allocations against one
 * transfer line are limited in total by that line. Applying either cap alone is a
 * defect — the ASN cap alone is the round-6 finding (a manually received line still
 * looked open), the line cap alone is this one.
 */

declare const TRANSFER_LINE_RESIDUAL_QTY_BRAND: unique symbol
declare const WMS_ASN_LINE_RESIDUAL_QTY_BRAND: unique symbol

/**
 * LINE SCOPE: how much of a transfer line an allocator may still bring to rest —
 * what has not landed anywhere yet AND can still be costed from the dispatch
 * snapshot, whichever is the smaller (6oyu.19, Codex round-8 HIGH-1).
 */
export type TransferLineResidualQty = {
  readonly [TRANSFER_LINE_RESIDUAL_QTY_BRAND]: 'transfer-line-residual-qty'
  readonly transferLineId: string
  readonly qty: Decimal
  readonly qtyNumber: number
}

/** ASN SCOPE: how much of ONE `wms_asn_line_maps` row's expectation is uncredited. */
export type WmsAsnLineResidualQty = {
  readonly [WMS_ASN_LINE_RESIDUAL_QTY_BRAND]: 'wms-asn-line-residual-qty'
  readonly asnLineMapId: string
  readonly qty: Decimal
  readonly qtyNumber: number
}

/**
 * LINE-SCOPE residue. THE ONLY constructor of `TransferLineResidualQty`.
 *
 * Takes the landed quantity rather than a number, so the line cap and the snapshot
 * offset provably come from the same reading of the same two columns.
 *
 * `costableRemainingQty` IS REQUIRED, and it is the round-8 half of this type
 * (Codex round-8 HIGH-1). "Outstanding" and "costable" are different quantities and
 * the second can be the smaller: a source warehouse that dispatched legacy or
 * uncosted stock leaves a dispatch snapshot recording fewer units than the line
 * shipped. An allocator capped only by the outstanding quantity plans to book units
 * the snapshot cannot cost, the caller increments stock for all of them, and the
 * layers cover only what the snapshot had. Taking the MINIMUM here means the
 * allocation a plan produces is, by construction, a quantity the snapshot can back —
 * so the two figures the cost-layer helper compares can never have been allowed to
 * diverge in the first place.
 *
 * Build it with `remainingCostableSnapshotQty` over the SAME line and the SAME
 * landed quantity. There is deliberately no default: a call site that does not know
 * its snapshot capacity must go and read it.
 */
export function resolveTransferLineResidualQty(input: {
  lineQty: DecimalInput
  landed: TransferLineLandedQty
  costableRemainingQty: DecimalInput
}): TransferLineResidualQty {
  const outstanding = transferLineOutstandingQty(input.lineQty, input.landed)
  const costable = maxZero(roundQuantity(toDecimal(input.costableRemainingQty), 6))
  const qty = outstanding.lt(costable) ? outstanding : costable
  return {
    transferLineId: input.landed.transferLineId,
    qty,
    qtyNumber: qty.toNumber(),
  } as TransferLineResidualQty
}

/**
 * ASN-SCOPE residue. THE ONLY constructor of `WmsAsnLineResidualQty`.
 *
 * Reads ONLY this row's own columns. `qtyAccountedViaSnapshot` (what alignment has
 * credited here) and `lastProcessedReceivedQty` (what the WMS has reported booked
 * in here) overlap — a webhook receipt reports units an earlier alignment already
 * credited — so the credit is their MAX, never their sum.
 *
 * Deliberately blind to `stock_transfer_lines.qtyReceived`: that is a LINE fact and
 * cannot be charged against one ASN row. It is carried by
 * `resolveTransferLineResidualQty` instead, and an allocator must apply both.
 */
export function resolveWmsAsnLineResidualQty(input: {
  asnLineMapId: string
  expectedQty: DecimalInput
  qtyAccountedViaSnapshot: DecimalInput
  lastProcessedReceivedQty: DecimalInput
}): WmsAsnLineResidualQty {
  const snapshotCredit = maxZero(toDecimal(input.qtyAccountedViaSnapshot))
  const receiptCredit = maxZero(toDecimal(input.lastProcessedReceivedQty))
  const credited = snapshotCredit.gt(receiptCredit) ? snapshotCredit : receiptCredit
  const qty = maxZero(roundQuantity(subtractMoney(toDecimal(input.expectedQty), credited), 6))
  return {
    asnLineMapId: input.asnLineMapId,
    qty,
    qtyNumber: qty.toNumber(),
  } as WmsAsnLineResidualQty
}

/**
 * The LINE-scope residue for one line out of a map keyed by transfer-line id.
 * Throws rather than defaulting: a missing entry means the caller assembled the
 * residues over a different set of lines than it is now allocating against, and
 * silently answering "no cap" is how round 6's regression would come back.
 */
export function requireTransferLineResidualQty(
  residualByLineId: ReadonlyMap<string, TransferLineResidualQty>,
  transferLineId: string,
): TransferLineResidualQty {
  const residual = residualByLineId.get(transferLineId)
  if (!residual) {
    throw new Error(
      `requireTransferLineResidualQty: no line-scope residual quantity was loaded for transfer line ${transferLineId}. ` +
      'Build it with resolveTransferLineResidualQty over the SAME set of lines being allocated against (6oyu.19 Codex r7).',
    )
  }
  return residual
}
