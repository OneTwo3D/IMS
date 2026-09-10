/**
 * THE one way to recreate FIFO cost layers from a stock-transfer dispatch snapshot.
 *
 * WHY THIS EXISTS (6oyu.19, Codex round-2 HIGH-1). Four paths land transferred units
 * back into a warehouse and rebuild layers from the frozen dispatch snapshot:
 *
 *   1. manual receipt              app/actions/transfers.ts  (applyTransferLineReceipt)
 *   2. dispatch cancellation       app/actions/transfers.ts  (cancelDispatchedTransfer)
 *   3. WMS webhook receipt         lib/domain/wms/booked-in-service.ts
 *   4. WMS stock-sync alignment    the active WMS connector's sync/stock-sync.ts
 *
 * All four wrote the same three lines by hand, and two of them wrote only two of
 * the three. The registry entry that lets retrospective landed-cost revaluation
 * subtract transferred units from COGS (MOVEMENT_COGS_RELEVANCE.TRANSFER_OUT /
 * STOCK_TRANSFER_SOURCE_LAYER_CONSUMPTION) is sound ONLY if the units end up in a
 * layer that propagateLandedCostToOutputs can reach. Paths 3 and 4 called
 * copyCostLayerSourceLinesProportionally and IGNORED its result: that helper returns
 * 0 for an ordinary PO-derived source layer, which has no sourceLines of its own, so
 * those destination layers had NO costLayerSourceLine at all. The snapshot query
 * removed the units from COGS while getDependentOutputSourceLines could not find
 * anywhere to put the delta — the freight debit stayed stranded in transit.
 *
 * So the link is a POSTCONDITION of this function, asserted before it returns, not
 * something four call sites have to remember. `assertLayerIsReachableByPropagation`
 * fails loudly rather than leaving a silently unreachable layer behind, and the
 * source census in tests/domain/inventory/transfer-cost-layer-recreation.test.ts
 * fails if a fifth path ever open-codes the sequence again.
 *
 * THE SECOND POSTCONDITION IS QUANTITY (Codex round-4 HIGH, o3d-eiuo). All four
 * callers increment stock and then call this, in one transaction, so anything this
 * function declines to lay down is not a reportable gap — it is stock on hand with
 * no FIFO layer behind it. An earlier revision skipped negative-cost snapshot
 * entries and returned a count nobody read; see `negativeCostLayers` for why the
 * input is reachable rather than pathological. The layers created now cover the
 * slice's whole positive quantity or the function throws, taking the caller's stock
 * increment down with it. A skip can only ever be a visible failure, not a trade.
 *
 * WHAT THIS FUNCTION DOES NOT DO (6oyu.19 split, o3d-nrl4). It does not settle a
 * landed-cost revaluation that happened while these units were IN TRANSIT. That
 * revaluation has no layer to journal against, and IMS currently posts nothing for
 * it — the delta stays in the transit clearing account. An earlier revision of this
 * branch persisted a `PendingTransferLandedCostReclass` and discharged it here; that
 * settlement machinery was withdrawn on Codex round-2 review (four HIGH findings,
 * including per-transfer rather than per-revaluation obligations and settlement on a
 * disabled connector) and is tracked as o3d-nrl4 on branch
 * `o3d-6oyu19-deferred-transit-reclass-withdrawn` (commit 89a124f5). This function
 * is the natural settlement point when that work returns; it deliberately does not
 * pretend to be one today.
 */

import type { Prisma } from '@/app/generated/prisma/client'
import { createCostLayer, copyCostLayerSourceLinesProportionally } from '@/lib/cost-layers'
import type { CostLayerSnapshotEntry } from '@/lib/cost-layer-snapshots'
import { addMoney, multiplyMoney, roundQuantity, toDecimal } from '@/lib/domain/math/decimal'

type TxClient = Prisma.TransactionClient

export type TransferLayerRecreationTarget = {
  productId: string
  /** Destination for a receipt; the SOURCE warehouse for a dispatch cancellation. */
  warehouseId: string
  /**
   * The transfer line whose dispatch snapshot this slice was drawn from. Diagnostic
   * context: it is what names the offending line if the reachability postcondition
   * ever fires, and an unreachable layer is otherwise almost impossible to trace
   * back to the receipt that created it.
   */
  transferLineId: string
  /** Stamped on created layers by the WMS alignment path; null everywhere else. */
  adjustmentMovementId?: string | null
  /** Human context for diagnostics ("transfer TR-1 receipt"). */
  contextLabel: string
}

export type TransferLayerRecreationResult = {
  createdLayers: Array<{
    costLayerId: string
    sourceCostLayerId: string
    qty: string
    unitCostBase: string
    /** True when the direct fallback link had to be written (source had no sourceLines). */
    linkedDirectly: boolean
  }>
  /**
   * QUANTITY ACTUALLY PLACED INTO LAYERS, to 6dp. Equal to the slice's own positive
   * quantity by the postcondition asserted below — the point being that a caller
   * that has already committed a stock increment can measure its layers against THIS
   * rather than against the slice it passed in.
   *
   * The manual receipt path's £0 balancing layer (cogs-audit scjz.5) is computed from
   * this figure. It used to re-sum `snapshotSlice`, which counted any entry this
   * helper declined as covered — the balancing step could not see the gap it existed
   * to close.
   */
  recreatedQty: string
  /**
   * Layers created at a NEGATIVE unit cost — RECORDED, never skipped (Codex round-4
   * HIGH; o3d-eiuo).
   *
   * An earlier revision skipped these entries on the theory that a negative snapshot
   * unit cost is corrupt provenance and pathological, "since dispatch snapshots are
   * built from real layers". BOTH halves of that were wrong, and the skip was the
   * dangerous half:
   *
   *  - It is REACHABLE. `recalculateLandedCosts` distributes freight cost lines with
   *    no positivity filter at all — its own comment names "a zero/credit cost line"
   *    — so `grossUnitCostBase = unitCostBase + landedPerUnit` can go negative with
   *    nothing flooring it, and it is written straight onto the layer. A snapshot is
   *    not frozen against that either: `updateSnapshotsForCostLayerChange` patches
   *    `stock_transfer_lines.costLayerSnapshot` IN PLACE with the new unit cost. So a
   *    credit note landing while units are in transit rewrites a positive dispatch
   *    snapshot negative, and the receipt then reads it.
   *  - Skipping did not avoid the bad outcome, it created a worse one. All four
   *    callers increment stock BEFORE calling here, so a skipped entry left UNLAYERED
   *    STOCK: on-hand above Σ layer qty, understating inventory and leaving a later
   *    FIFO consumption to fail or misvalue. Nothing reported it — every caller
   *    ignored the count, and the balancing step counted the skipped units as covered.
   *
   * So the negative cost is preserved, not discarded: the source layer already stands
   * at that value, and a warehouse-to-warehouse move must not revalue the units it
   * moves. This count is a record of an unusual valuation for diagnostics; it is NOT
   * a gap, and no caller has anything to compensate for.
   */
  negativeCostLayers: number
}

export type TransferCostLayerRecreationDeps = {
  createCostLayer: typeof createCostLayer
  copyCostLayerSourceLinesProportionally: typeof copyCostLayerSourceLinesProportionally
}

const defaultDeps: TransferCostLayerRecreationDeps = {
  createCostLayer,
  copyCostLayerSourceLinesProportionally,
}

/**
 * The postcondition the whole registry contract rests on: a layer built from a
 * transfer snapshot must be REACHABLE by propagateLandedCostToOutputs, which walks
 * costLayerSourceLine.sourceCostLayerId.
 *
 * "Reachable" is satisfied two ways, which is why this checks for ANY source line
 * rather than for a link naming the snapshot entry's own layer:
 *  - the proportional copy succeeded, so the new layer carries the source layer's
 *    OWN provenance (pointing at its ancestors — the layers a landed-cost recalc
 *    actually revalues), or
 *  - the copy returned 0 (an ordinary PO-derived source layer has no sourceLines),
 *    so a direct link naming the source layer was written instead.
 * Zero source lines means neither happened and the layer is unreachable — the exact
 * state that stranded the freight debit in transit.
 */
async function assertLayerIsReachableByPropagation(
  tx: TxClient,
  params: { costLayerId: string; sourceCostLayerId: string; transferLineId: string; contextLabel: string },
): Promise<void> {
  const links = await tx.costLayerSourceLine.count({ where: { costLayerId: params.costLayerId } })
  if (links > 0) return
  throw new Error(
    `recreateTransferCostLayersFromSnapshotSlice: cost layer ${params.costLayerId} was created from ` +
    `source layer ${params.sourceCostLayerId} (transfer line ${params.transferLineId}, ` +
    `${params.contextLabel}) with no costLayerSourceLine, so a retrospective landed-cost revaluation ` +
    `of the source could never reach it. Refusing to leave an unreachable layer behind (6oyu.19).`,
  )
}

/**
 * Recreate the FIFO layers for one slice of a dispatch snapshot, guaranteeing the
 * half of the registry contract that IS guaranteed today: every created layer is
 * reachable by propagateLandedCostToOutputs, so a landed-cost revaluation of the
 * source layer carries its delta onto these units — and that the layers created
 * cover the slice's whole quantity, so the caller's already-committed stock
 * increment is never left standing above Σ layer qty.
 *
 * `snapshotSlice` must come from sliceTransferSnapshotForReceipt — it is the
 * unconsumed portion of the dispatch snapshot for the quantity now landing.
 */
export async function recreateTransferCostLayersFromSnapshotSlice(
  tx: TxClient,
  target: TransferLayerRecreationTarget,
  snapshotSlice: CostLayerSnapshotEntry[],
  deps: TransferCostLayerRecreationDeps = defaultDeps,
): Promise<TransferLayerRecreationResult> {
  const result: TransferLayerRecreationResult = {
    createdLayers: [],
    recreatedQty: toDecimal(0).toFixed(6),
    negativeCostLayers: 0,
  }

  // Computed from the INPUT, before anything is created, and deliberately not
  // accumulated alongside the layers: the postcondition below compares two figures
  // derived from different things, so a future edit that reintroduces a skip cannot
  // also quietly shrink the target it is measured against.
  const requestedQty = snapshotSlice.reduce((sum, entry) => {
    const entryQty = toDecimal(entry.qty)
    return entryQty.gt(0) ? addMoney(sum, entryQty) : sum
  }, toDecimal(0))

  for (const entry of snapshotSlice) {
    const entryQty = toDecimal(entry.qty)
    const unitCostBase = toDecimal(entry.unitCostBase)
    // parseCostLayerSnapshot already drops non-positive quantities. Such an entry
    // carries NO quantity, so passing over it leaves nothing unlayered and cannot
    // open the gap this function's postcondition is about.
    if (entryQty.lte(0)) continue
    // A negative unit cost is a real revaluation outcome (see negativeCostLayers),
    // and the units are already on the shelf by the time we are called. Recreate the
    // layer at the cost the source layer stands at; do NOT decline it.
    //
    // Warned rather than only returned, for the same reason the skip was wrong: the
    // count is the kind of signal every caller ignored. It is unusual enough that
    // somebody should see it even though nothing has to act on it.
    if (unitCostBase.lt(0)) {
      result.negativeCostLayers += 1
      console.warn(
        `recreateTransferCostLayersFromSnapshotSlice: creating a NEGATIVE-cost layer ` +
        `(${unitCostBase.toFixed(6)}/unit x ${entryQty.toFixed(6)}) for product ${target.productId} at ` +
        `warehouse ${target.warehouseId} from source layer ${entry.costLayerId} (transfer line ` +
        `${target.transferLineId}, ${target.contextLabel}). The source layer stands at this cost — most ` +
        `likely a credit freight line revalued it — and the units are already on hand, so the layer is ` +
        `created rather than skipped (6oyu.19 / o3d-eiuo). Check the freight PO if this was not intended.`,
      )
    }

    const newLayerId = await deps.createCostLayer(tx, {
      productId: target.productId,
      warehouseId: target.warehouseId,
      qty: entryQty,
      unitCostBase,
      ...(target.adjustmentMovementId ? { adjustmentMovementId: target.adjustmentMovementId } : {}),
    })

    const copied = await deps.copyCostLayerSourceLinesProportionally(tx, entry.costLayerId, newLayerId, entryQty)
    if (copied === 0) {
      // The source layer carries no provenance of its own (the ordinary case: a
      // PO-derived layer). Without this the new layer is invisible to
      // getDependentOutputSourceLines and the revaluation delta is stranded.
      await tx.costLayerSourceLine.create({
        data: {
          costLayerId: newLayerId,
          sourceProductId: target.productId,
          sourceCostLayerId: entry.costLayerId,
          qty: entryQty.toFixed(6),
          unitCostBase: unitCostBase.toFixed(6),
          totalCostBase: roundQuantity(multiplyMoney(entryQty, unitCostBase), 6).toFixed(6),
        },
      })
    }
    await assertLayerIsReachableByPropagation(tx, {
      costLayerId: newLayerId,
      sourceCostLayerId: entry.costLayerId,
      transferLineId: target.transferLineId,
      contextLabel: target.contextLabel,
    })

    result.createdLayers.push({
      costLayerId: newLayerId,
      sourceCostLayerId: entry.costLayerId,
      qty: entryQty.toFixed(6),
      unitCostBase: unitCostBase.toFixed(6),
      linkedDirectly: copied === 0,
    })
  }

  // THE QUANTITY POSTCONDITION (Codex round-4 HIGH; o3d-eiuo).
  //
  // Every caller increments stock and THEN calls this function, inside the same
  // transaction. So an entry this function declines to lay down is not a bookkeeping
  // gap that someone can report — it is stock on the shelf with no cost layer behind
  // it, invisible to the caller (which had no reason to inspect a count) and to the
  // manual receipt path's balancing layer (which measured the slice, not the layers).
  //
  // The guarantee is therefore made here, where it cannot be ignored: the layers this
  // function creates cover the slice's whole positive quantity, or it throws and the
  // caller's stock increment rolls back with it. A skip cannot be reintroduced as a
  // silent trade-off again — only as a visible failure.
  //
  // Measured by RE-READING the persisted layers, not by summing the loop's own record
  // of what it meant to create. A tally assembled by the same statements it is meant
  // to police cannot fail: it would agree with the input no matter what reached the
  // database. This re-read fails on a layer that was skipped, one that was never
  // written, and one written short.
  const persistedLayers = result.createdLayers.length === 0
    ? []
    : await tx.costLayer.findMany({
      where: { id: { in: result.createdLayers.map((layer) => layer.costLayerId) } },
      select: { receivedQty: true },
    })
  const recreatedQty = persistedLayers.reduce((sum, layer) => addMoney(sum, layer.receivedQty), toDecimal(0))
  if (!roundQuantity(recreatedQty, 6).equals(roundQuantity(requestedQty, 6))) {
    throw new Error(
      `recreateTransferCostLayersFromSnapshotSlice: snapshot slice for transfer line ` +
      `${target.transferLineId} (${target.contextLabel}) carried ${requestedQty.toFixed(6)} units but only ` +
      `${recreatedQty.toFixed(6)} were placed into cost layers. The caller has already incremented stock, so ` +
      `returning would leave ${roundQuantity(requestedQty.sub(recreatedQty), 6).toFixed(6)} units on hand with ` +
      `no FIFO layer behind them (6oyu.19 / o3d-eiuo).`,
    )
  }
  result.recreatedQty = roundQuantity(recreatedQty, 6).toFixed(6)

  return result
}
