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
import { multiplyMoney, roundQuantity, toDecimal } from '@/lib/domain/math/decimal'

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
   * Snapshot entries NOT turned into a layer because their unit cost was negative.
   * The manual receipt path converts the resulting quantity gap into a £0 balancing
   * layer; reported here so no caller has to infer it from a length mismatch.
   *
   * The two WMS paths have no such balancing step, so for them a skipped entry is a
   * quantity at the destination with no cost layer behind it. That is the deliberate
   * side of the trade: a negative snapshot unit cost is corrupt provenance, and
   * capitalising a negative layer (what those paths did before they were routed
   * through here) is the worse of the two outcomes. It is pathological input —
   * dispatch snapshots are built from real layers — and the count makes it visible.
   */
  skippedNegativeCostEntries: number
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
 * source layer carries its delta onto these units.
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
    skippedNegativeCostEntries: 0,
  }

  for (const entry of snapshotSlice) {
    const entryQty = toDecimal(entry.qty)
    const unitCostBase = toDecimal(entry.unitCostBase)
    // parseCostLayerSnapshot already drops non-positive quantities, so the only
    // reachable skip is a negative unit cost — corrupt provenance we must not
    // capitalise. Counted rather than swallowed (see skippedNegativeCostEntries).
    if (entryQty.lte(0) || unitCostBase.lt(0)) {
      result.skippedNegativeCostEntries += 1
      continue
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

  return result
}
