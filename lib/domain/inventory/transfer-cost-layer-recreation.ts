/**
 * THE one way to recreate FIFO cost layers from a stock-transfer dispatch snapshot.
 *
 * WHY THIS EXISTS (6oyu.19, Codex round-2 HIGH-1 and HIGH-2). Four paths land
 * transferred units back into a warehouse and rebuild layers from the frozen
 * dispatch snapshot:
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
 * The same function is also the settlement point for the deferred in-transit reclass
 * (HIGH-2): a revaluation that lands while the units are in transit has no layer to
 * journal against, so it persists a PendingTransferLandedCostReclass instead. This
 * is the moment the layer comes into existence, so this is where the obligation is
 * discharged — in the SAME transaction, so a crash cannot leave the layer without
 * its journal or the journal without its layer.
 */

import type { Prisma } from '@/app/generated/prisma/client'
import { getAccountingSettings, queueAccountingSyncTx } from '@/lib/accounting'
import { createCostLayer, copyCostLayerSourceLinesProportionally } from '@/lib/cost-layers'
import type { CostLayerSnapshotEntry } from '@/lib/cost-layer-snapshots'
import { recordTransitSubledgerMovement } from '@/lib/domain/accounting/transit-subledger-movement'
import {
  addMoney,
  multiplyMoney,
  roundQuantity,
  subtractMoney,
  toDecimal,
  type Decimal,
} from '@/lib/domain/math/decimal'

type TxClient = Prisma.TransactionClient

/**
 * Below this the reclass is not worth a journal line. Deliberately the SAME
 * threshold queueLandedCostAdjustmentJournals uses for the on-hand reclass, so a
 * delta that would have been dropped had the transfer already been received is
 * dropped here too, rather than the two paths disagreeing by rounding.
 */
const RECLASS_JOURNAL_EPSILON = toDecimal('0.01')

export type TransferLayerRecreationTarget = {
  productId: string
  /** Destination for a receipt; the SOURCE warehouse for a dispatch cancellation. */
  warehouseId: string
  /**
   * The transfer line whose dispatch snapshot this slice was drawn from. Required:
   * it is half the key that finds the pending in-transit reclass obligations, so a
   * caller that cannot name its line cannot settle them either.
   */
  transferLineId: string
  /** Stamped on created layers by the WMS alignment path; null everywhere else. */
  adjustmentMovementId?: string | null
  /** Journal narration context ("Transfer TR-1 received"). */
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
   */
  skippedNegativeCostEntries: number
  /** Signed base-currency in-transit reclass settled (and journaled) by this call. */
  settledReclassBase: Decimal
  /** Pending obligations touched, whether or not they cleared the journal epsilon. */
  settledReclassRows: number
}

export type TransferCostLayerRecreationDeps = {
  createCostLayer: typeof createCostLayer
  copyCostLayerSourceLinesProportionally: typeof copyCostLayerSourceLinesProportionally
  getAccountingSettings: typeof getAccountingSettings
  queueAccountingSyncTx: typeof queueAccountingSyncTx
  recordTransitSubledgerMovement: typeof recordTransitSubledgerMovement
}

const defaultDeps: TransferCostLayerRecreationDeps = {
  createCostLayer,
  copyCostLayerSourceLinesProportionally,
  getAccountingSettings,
  queueAccountingSyncTx,
  recordTransitSubledgerMovement,
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
  params: { costLayerId: string; sourceCostLayerId: string; transferLineId: string },
): Promise<void> {
  const links = await tx.costLayerSourceLine.count({ where: { costLayerId: params.costLayerId } })
  if (links > 0) return
  throw new Error(
    `recreateTransferCostLayersFromSnapshotSlice: cost layer ${params.costLayerId} was created from ` +
    `source layer ${params.sourceCostLayerId} (transfer line ${params.transferLineId}) with no ` +
    `costLayerSourceLine, so a retrospective landed-cost revaluation of the source could never reach ` +
    `it. Refusing to leave an unreachable layer behind (6oyu.19).`,
  )
}

/**
 * Settle the in-transit landed-cost reclass obligations this newly created layer
 * discharges, and queue the journal that was deferred when the revaluation ran.
 *
 * Runs on the CALLER'S transaction, alongside the layer insert. That atomicity is
 * the point: the obligation exists precisely because "the layer now exists" and
 * "the reclass has been posted" must become true together.
 */
async function settlePendingTransitReclass(
  tx: TxClient,
  deps: TransferCostLayerRecreationDeps,
  params: {
    sourceCostLayerId: string
    transferLineId: string
    destinationCostLayerId: string
    qty: Decimal
    contextLabel: string
  },
): Promise<{ settledBase: Decimal; rows: number }> {
  const pending = await tx.pendingTransferLandedCostReclass.findMany({
    where: {
      sourceCostLayerId: params.sourceCostLayerId,
      transferLineId: params.transferLineId,
      settledAt: null,
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, qty: true, qtyConsumed: true, unitCostDelta: true, primaryPoId: true, primaryPoRef: true },
  })
  if (pending.length === 0) return { settledBase: toDecimal(0), rows: 0 }

  let remaining = params.qty
  let settledBase = toDecimal(0)
  let rows = 0

  for (const row of pending) {
    if (remaining.lte(0)) break
    const outstanding = subtractMoney(row.qty, row.qtyConsumed)
    if (outstanding.lte(0)) continue
    const take = roundQuantity(outstanding.lt(remaining) ? outstanding : remaining, 6)
    if (take.lte(0)) continue
    remaining = subtractMoney(remaining, take)

    const nowConsumed = roundQuantity(addMoney(row.qtyConsumed, take), 6)
    const fullySettled = nowConsumed.gte(roundQuantity(row.qty, 6))
    await tx.pendingTransferLandedCostReclass.update({
      where: { id: row.id },
      data: {
        qtyConsumed: nowConsumed.toFixed(6),
        settledAt: fullySettled ? new Date() : null,
      },
    })
    rows += 1

    const amount = roundQuantity(multiplyMoney(take, row.unitCostDelta), 6)
    settledBase = addMoney(settledBase, amount)
    if (amount.abs().lte(RECLASS_JOURNAL_EPSILON)) {
      // Same epsilon the on-hand reclass uses. The obligation is still marked
      // consumed: leaving it open would make it look unsettled forever, and the
      // sub-penny residue is exactly what the guarded reconciliation sweep absorbs.
      continue
    }

    const settings = await deps.getAccountingSettings()
    const isIncrease = amount.gt(0)
    const absDelta = amount.abs().toDecimalPlaces(2).toNumber()
    // Keyed by the OBLIGATION plus the layer that discharged it: one pending row
    // split across two partial receipts settles into two distinct journals, and a
    // replay of the same receipt collides on this key rather than double-posting.
    const idempotencyKey = `landed-cost-transit-reclass:${row.id}:${params.destinationCostLayerId}`
    const payload = {
      date: new Date().toISOString().slice(0, 10),
      reference: `Landed cost reclass — ${row.primaryPoRef}`,
      narration:
        `Deferred landed cost ${isIncrease ? 'capitalisation' : 'reversal'} of £${absDelta.toFixed(2)} ` +
        `on ${row.primaryPoRef}, released by ${params.contextLabel}`,
      lines: [
        {
          accountCode: isIncrease ? settings.inventoryAccount : settings.transitAccount,
          description: `Landed cost reclass — ${row.primaryPoRef}`,
          debit: absDelta,
        },
        {
          accountCode: isIncrease ? settings.transitAccount : settings.inventoryAccount,
          description: `Landed cost reclass — ${row.primaryPoRef}`,
          credit: absDelta,
        },
      ],
    }
    // A disabled connector / posting type returns false: no queue row, and so no
    // subledger row either. The obligation is still marked settled, deliberately and
    // for the same reason queueLandedCostAdjustmentJournals does not retry its own
    // reclass — when postings are off, "not posted" is the correct outcome, and a
    // row left open would later post at a moment with no relation to the movement.
    const queued = await deps.queueAccountingSyncTx(tx, {
      type: 'STOCK_IN_TRANSIT',
      referenceType: 'PurchaseOrder',
      referenceId: row.primaryPoId,
      payload,
      idempotencyKey,
    })
    if (queued) {
      // Same 6oyu.4 pairing as queueLandedCostAdjustmentJournals: the transit LEG of
      // this journal, signed from transit's point of view (capitalisation credits
      // transit). Already inside the caller's transaction, so queue and ledger row
      // commit together by construction.
      await deps.recordTransitSubledgerMovement(tx, {
        sourceType: 'LANDED_COST_RECLASS',
        sourceRef: row.primaryPoId,
        idempotencyKey,
        baseDelta: isIncrease ? -absDelta : absDelta,
        journalDate: payload.date,
      })
    }
  }

  return { settledBase, rows }
}

/**
 * Recreate the FIFO layers for one slice of a dispatch snapshot, guaranteeing both
 * halves of the registry contract: every created layer is reachable by
 * propagateLandedCostToOutputs, and any landed-cost delta deferred while these units
 * were in transit is settled and journaled here.
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
    settledReclassBase: toDecimal(0),
    settledReclassRows: 0,
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
    })

    const settled = await settlePendingTransitReclass(tx, deps, {
      sourceCostLayerId: entry.costLayerId,
      transferLineId: target.transferLineId,
      destinationCostLayerId: newLayerId,
      qty: entryQty,
      contextLabel: target.contextLabel,
    })
    result.settledReclassBase = addMoney(result.settledReclassBase, settled.settledBase)
    result.settledReclassRows += settled.rows

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
