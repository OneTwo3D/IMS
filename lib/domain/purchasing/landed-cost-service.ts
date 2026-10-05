import { randomUUID } from 'node:crypto'
import { MARK_REMEDY_TAIL } from '@/lib/domain/accounting/hand-post-instruction'
import { Prisma } from '@/app/generated/prisma/client'
import { getAccountingSettings, queueAccountingSync, queueAccountingSyncTx, type AccountingSettings } from '@/lib/accounting'
import { postingIsOwed, reportPostingNotQueued, type EnqueueOutcomeLike } from '@/lib/domain/accounting/enqueue-outcome'
import { accountingPayloadKey } from '@/lib/accounting/payload-key'
import { logActivity } from '@/lib/activity-log'
import {
  getDependentOutputSourceLines,
  getInTransitTransferLinesForCostLayer,
  getManufacturingConsumedQtyForCostLayer,
  getReturnedQtyForCostLayer,
  getReversalConsumedQtyForCostLayer,
  getSupplierReturnedQtyForCostLayer,
  getTransferConsumedQtyForCostLayer,
  recordCostLayerRevaluation,
  refreshSalesOrderLineCogsForCostLayerChange,
  refreshShipmentCogsForCostLayerChange,
  updateSnapshotsForCostLayerChange,
  type ShipmentRevaluationContext,
} from '@/lib/cost-layers'
import { db } from '@/lib/db'
import { toJsonInputValue } from '@/lib/db/json-input'
import { recordCogsSubledgerMovement } from '@/lib/domain/accounting/cogs-subledger-movement'
import { recordTransitSubledgerMovement } from '@/lib/domain/accounting/transit-subledger-movement'
import { loadTransferLineLandedQty, requireLandedQty } from '@/lib/domain/inventory/transfer-landed-quantity'
import { LANDED_COST_PROPAGATION_MAX_DEPTH } from '@/lib/domain/wms/transfer-asn-lock-order'
import { sliceTransferSnapshotForReceipt } from '@/lib/domain/wms/asn-reconciliation'
import { scheduleLandedCostJournalOutbox } from './landed-cost-journal-outbox'
import {
  allocateLandedCost,
  unabsorbedBaseForQty,
  type LandedAllocation,
  type LandedAllocationCostLine,
  type LandedAllocationEvent,
  type LandedAllocationSourceRank,
} from './landed-cost-allocation'
import { logFlooredLandedCredit } from './landed-cost-floor-activity'
import { describeFlooredLandedCredit, type FlooredLandedCreditEntry } from './landed-cost-floor-text'

export {
  LANDED_COST_DISTRIBUTION_METHODS,
  computeDistributionBase,
  normalizeLandedCostMethod,
  type LandedCostDistributionMethod,
} from './landed-cost-allocation'

export type PendingGrossCostLine = {
  id: string
  qty: Prisma.Decimal | number | string
  unitCostBase: Prisma.Decimal | number | string
  totalBase: Prisma.Decimal | number | string
  landedUnitCostBase?: Prisma.Decimal | number | string | null
  weight?: Prisma.Decimal | number | string | null
}

export type PendingGrossCostLineSource = {
  /** Selected by every reader so the allocation has a deterministic order; see allocateLandedCost. */
  id?: string | null
  amountBase: Prisma.Decimal | number | string
  distributionMethod: string | null | undefined
}

export type LandedCostRecalcResult = {
  revalidatePoIds: string[]
  auditRunIds: string[]
  warnings: LandedCostRevaluationWarning[]
  inventoryTransitAdjustments: Array<{
    primaryPoId: string
    primaryPoRef: string
    freightPoId: string | null
    eventKey: string
    totalDelta: number
  }>
  /** COGS adjustment needed for layers that were already consumed before
   *  the landed cost changed. Positive = cost increase, negative = decrease. */
  cogsAdjustments: Array<{
    primaryPoId: string
    primaryPoRef: string
    freightPoId: string | null
    eventKey: string
    totalDelta: number
  }>
  /**
   * Floored-negative-landed-cost activity entries still to be written, by the caller, AFTER its transaction
   * commits (see logLandedCostCreditFloorActivities). Optional so a result rebuilt from an outbox payload,
   * which carries only the journals, stays valid.
   */
  creditFloorActivities?: Array<{
    purchaseOrderId: string
    context: string
    entries: FlooredLandedCreditEntry[]
  }>
}

export type LandedCostRevaluationWarning = {
  code: 'weight_fallback' | 'weight_zero_line' | 'landed_cost_credit_floored'
  context: string
  message: string
}

export const LANDED_COST_REVALUATION_REASONS = [
  'direct_landed_cost_recalculation',
  'linked_freight_recalculation',
  'purchase_order_additional_costs_updated',
  'freight_purchase_order_created',
  'freight_purchase_order_costs_updated',
  'freight_purchase_order_cancelled',
] as const

export type LandedCostRevaluationReason = typeof LANDED_COST_REVALUATION_REASONS[number]

export type LandedCostRevaluationOptions = {
  triggeredById: string | null
  reason?: LandedCostRevaluationReason | null
  /**
   * audit-grob: also enqueue the adjustment journals into the durable outbox IN
   * this recalc's transaction (a crash-recovery backstop for the post-commit
   * queueLandedCostAdjustmentJournals call). Only the journaling callers pass it.
   */
  scheduleAdjustmentJournals?: boolean
}

type DecimalInput = Prisma.Decimal | number | string

/**
 * Every quantity a cost layer's raw consumedQty must be netted against before the
 * remainder is treated as customer COGS. One type, one loader
 * (loadLayerConsumptionExclusions), one subtraction site
 * (calculateLayerAdjustmentDeltas) — because the recurring defect in this area is
 * an exclusion that reaches some revaluation entry points and not others
 * (audit-jz9i, scjz.14, 6oyu.19 all had this shape).
 *
 * Every field is REQUIRED, deliberately. An omitted exclusion silently defaults to
 * "there is nothing to exclude" — the permissive answer, and the one that posts
 * spurious COGS — so optionality here would be a bug that compiles.
 *
 * supplierReturnedQty is carried but NOT subtracted (scjz.10: supplier returns ride
 * the same COGS-adjustment journal as sold goods). It lives here because it is
 * loaded per layer alongside the others and reported in the adjustment audit
 * context.
 */
type LayerConsumptionExclusions = {
  returnedQty: DecimalInput
  supplierReturnedQty: DecimalInput
  manufacturingConsumedQty: DecimalInput
  reversalConsumedQty: DecimalInput
  transferConsumedQty: DecimalInput
}

/** What loadLayerConsumptionExclusions returns: the same fields, already Decimal. */
type LoadedLayerConsumptionExclusions = {
  [K in keyof LayerConsumptionExclusions]: Prisma.Decimal
}

type CostLayerAdjustmentInput = {
  oldUnitCost: DecimalInput
  newUnitCost: DecimalInput
  receivedQty: DecimalInput
  remainingQty: DecimalInput
} & LayerConsumptionExclusions

type PropagatedOutputLayerAudit = {
  sourceCostLayerId: string
  outputCostLayerId: string
  oldUnitCostBase: string
  newUnitCostBase: string
  consumedQty: string
  cogsDelta: string
  /** On-hand delta PLUS the in-transit residue below: the whole inventory/transit amount this output contributes. */
  inventoryDelta: string
  /** o3d-nrl4 PR B: the portion of `inventoryDelta` that belongs to units of this output still in transit. */
  inTransitResidue: InTransitResidueEntry[]
}

/** One cost layer's row in a revaluation run's `afterJson`. The two floor keys exist only on a layer whose
 *  line hit the zero floor (a new JSON key, no schema change; same precedent as `inTransitResidue`). */
type AfterLayerAudit = {
  costLayerId: string
  oldUnitCostBase: string
  newUnitCostBase: string
  receivedQty: string
  remainingQty: string
  consumedQty: string
  returnedQty: string
  supplierReturnedQty: string
  manufacturingConsumedQty: string
  cogsDelta: string
  inventoryDelta: string
  affectedRefundSnapshots: number
  affectedShipments: number
  affectedSalesOrderLines: number
  /** The 6dp unit cost before the floor (strictly negative). Present only when the line was floored. */
  unflooredGrossUnitCostBase?: string
  /** `max(0, -unflooredGrossUnitCostBase) x receivedQty`, exact. Present only when the line was floored. */
  unabsorbedBase?: string
}

type AfterLineAudit = {
  lineId: string
  qty: string
  unitCostBase: string
  landedAmountBase: string
  grossUnitCostBase: string
  costLayers: AfterLayerAudit[]
}

type LandedCostAdjustment = LandedCostRecalcResult['inventoryTransitAdjustments'][number]
type LandedCostAdjustmentLayerContext = {
  costLayerId: string
  oldUnitCost: Prisma.Decimal
  newUnitCost: Prisma.Decimal
  receivedQty: Prisma.Decimal
  remainingQty: Prisma.Decimal
  returnedQty: Prisma.Decimal
  supplierReturnedQty: Prisma.Decimal
  manufacturingConsumedQty: Prisma.Decimal
}

export type LandedCostServiceDeps = {
  getReturnedQtyForCostLayer: typeof getReturnedQtyForCostLayer
  getSupplierReturnedQtyForCostLayer: typeof getSupplierReturnedQtyForCostLayer
  getManufacturingConsumedQtyForCostLayer: typeof getManufacturingConsumedQtyForCostLayer
  getReversalConsumedQtyForCostLayer: typeof getReversalConsumedQtyForCostLayer
  getTransferConsumedQtyForCostLayer: typeof getTransferConsumedQtyForCostLayer
  /** o3d-nrl4 PR B: the transfer lines whose units may still be in transit (see capitaliseInTransitResidue). */
  getInTransitTransferLinesForCostLayer: typeof getInTransitTransferLinesForCostLayer
  getDependentOutputSourceLines: typeof getDependentOutputSourceLines
  updateSnapshotsForCostLayerChange: typeof updateSnapshotsForCostLayerChange
  refreshShipmentCogsForCostLayerChange: typeof refreshShipmentCogsForCostLayerChange
  refreshSalesOrderLineCogsForCostLayerChange: typeof refreshSalesOrderLineCogsForCostLayerChange
  recordCostLayerRevaluation: typeof recordCostLayerRevaluation
  warnWeightFallback: (context: string) => LandedCostRevaluationWarning | void
  warnWeightZeroLines: (context: string, lineIds: string[]) => LandedCostRevaluationWarning | void
}

const defaultDeps: LandedCostServiceDeps = {
  getReturnedQtyForCostLayer,
  getSupplierReturnedQtyForCostLayer,
  getManufacturingConsumedQtyForCostLayer,
  getReversalConsumedQtyForCostLayer,
  getTransferConsumedQtyForCostLayer,
  getInTransitTransferLinesForCostLayer,
  getDependentOutputSourceLines,
  updateSnapshotsForCostLayerChange,
  refreshShipmentCogsForCostLayerChange,
  refreshSalesOrderLineCogsForCostLayerChange,
  recordCostLayerRevaluation,
  warnWeightFallback,
  warnWeightZeroLines,
}

const LANDED_COST_DELTA_EPSILON = new Prisma.Decimal('0.000001')
const LANDED_COST_JOURNAL_EPSILON = new Prisma.Decimal('0.01')

function decimal(value: Prisma.Decimal | number | string | null | undefined): Prisma.Decimal {
  return new Prisma.Decimal(value ?? 0)
}

function emptyRecalcResult(): LandedCostRecalcResult {
  return {
    revalidatePoIds: [],
    auditRunIds: [],
    warnings: [],
    inventoryTransitAdjustments: [],
    cogsAdjustments: [],
    creditFloorActivities: [],
  }
}

/**
 * Accepts Decimal, number, or string inputs so focused tests and boundary
 * callers can exercise exact decimal strings without building Prisma rows.
 * The implementation normalizes immediately and keeps all internal math in
 * Decimal until the accounting or snapshot-refresh boundary.
 */
export function calculateLayerAdjustmentDeltas(input: CostLayerAdjustmentInput): {
  costDelta: Prisma.Decimal
  consumedQty: Prisma.Decimal
  netConsumedQty: Prisma.Decimal
  cogsDelta: Prisma.Decimal
  inventoryDelta: Prisma.Decimal
} {
  const costDelta = decimal(input.newUnitCost).sub(decimal(input.oldUnitCost))
  const consumedQty = decimal(input.receivedQty).sub(decimal(input.remainingQty))
  // What this delta journals as COGS, and why each class is excluded:
  // - audit-jz9i: manufacturing-consumed units are not customer COGS — their cost
  //   was capitalised into the produced output's layer, so the delta is propagated
  //   into that output by propagateLandedCostToOutputs (audit-e7h8), not here.
  // - scjz.14: PURCHASE_REVERSAL units (PO cancellation) were reversed out, not
  //   sold; they wrote cogs_entries only for the outbound-evidence guard.
  // - 6oyu.19: TRANSFER_OUT units moved warehouse, they were not sold. The delta
  //   is carried to the destination layer by propagateLandedCostToOutputs (the
  //   transfer receipt links it back via costLayerSourceLine), so counting it
  //   here too double-posted it and stranded a balance in transit. Sourced from
  //   the transfer-line snapshot, since transfers write no cogs_entries at all.
  // - returnedQty (customer returns): handled by updateSnapshotsForCostLayerChange
  //   rewriting the refund-line snapshots, so the refund reversal already carries
  //   the revalued cost — excluded here to avoid double-counting.
  // - scjz.10: supplier-returned units ARE included. The late-cost delta on goods
  //   returned to the supplier was previously dropped (excluded here, handled
  //   nowhere). They ride the SAME consumed-qty COGS-adjustment journal as sold
  //   goods — the retrospective COGS-adjustment journal (DR cogsAccount / CR
  //   transitAccount on a cost increase; scjz.34).
  const netConsumedQty = Prisma.Decimal.max(
    new Prisma.Decimal(0),
    consumedQty
      .sub(decimal(input.returnedQty))
      .sub(decimal(input.manufacturingConsumedQty))
      .sub(decimal(input.reversalConsumedQty))
      .sub(decimal(input.transferConsumedQty)),
  )
  return {
    costDelta,
    consumedQty,
    netConsumedQty,
    cogsDelta: netConsumedQty.gt(0) && costDelta.abs().gt(LANDED_COST_DELTA_EPSILON)
      ? costDelta.mul(netConsumedQty)
      : new Prisma.Decimal(0),
    inventoryDelta: decimal(input.remainingQty).gt(LANDED_COST_DELTA_EPSILON) && costDelta.abs().gt(LANDED_COST_DELTA_EPSILON)
      ? costDelta.mul(decimal(input.remainingQty))
      : new Prisma.Decimal(0),
  }
}

/**
 * Load every exclusion quantity for one cost layer. The ONLY place the exclusion
 * queries are enumerated: recalculateLandedCosts, recalculateDirectLandedCosts and
 * propagateLandedCostToOutputs all revalue layers and all must net off the same
 * set, so adding a new exclusion must be a one-line change here rather than three
 * edits, two of which get made.
 *
 * `consumedQty <= 0` short-circuits to zeros: netConsumedQty is floored at 0, so
 * the result is identical and the per-layer queries are skipped.
 */
async function loadLayerConsumptionExclusions(
  tx: Prisma.TransactionClient,
  deps: LandedCostServiceDeps,
  costLayerId: string,
  consumedQty: Prisma.Decimal,
): Promise<LoadedLayerConsumptionExclusions> {
  if (consumedQty.lte(LANDED_COST_DELTA_EPSILON)) {
    return {
      returnedQty: new Prisma.Decimal(0),
      supplierReturnedQty: new Prisma.Decimal(0),
      manufacturingConsumedQty: new Prisma.Decimal(0),
      reversalConsumedQty: new Prisma.Decimal(0),
      transferConsumedQty: new Prisma.Decimal(0),
    }
  }
  return {
    returnedQty: decimal(await deps.getReturnedQtyForCostLayer(tx, costLayerId)),
    supplierReturnedQty: decimal(await deps.getSupplierReturnedQtyForCostLayer(tx, costLayerId)),
    manufacturingConsumedQty: decimal(await deps.getManufacturingConsumedQtyForCostLayer(tx, costLayerId)),
    reversalConsumedQty: decimal(await deps.getReversalConsumedQtyForCostLayer(tx, costLayerId)),
    transferConsumedQty: decimal(await deps.getTransferConsumedQtyForCostLayer(tx, costLayerId)),
  }
}

/**
 * One in-transit residue line: which transfer line, how many of its units were still in transit at the
 * moment of the revaluation, and the signed amount posted for them (o3d-nrl4 PR B).
 */
export type InTransitResidueEntry = {
  costLayerId: string
  transferLineId: string
  qty: string
  unitDelta: string
  delta: string
}

type InTransitResidue = {
  /** unitDelta x quantity still in transit, signed. Added to the inventory/transit adjustment. */
  delta: Prisma.Decimal
  qty: Prisma.Decimal
  entries: InTransitResidueEntry[]
}

function noInTransitResidue(): InTransitResidue {
  return { delta: new Prisma.Decimal(0), qty: new Prisma.Decimal(0), entries: [] }
}

/**
 * THE IN-TRANSIT RESIDUE (o3d-nrl4 PR B, ex-6oyu.19): the share of a revaluation that belongs to units of
 * this cost layer which are on a transfer and have NOT landed anywhere yet.
 *
 * calculateLayerAdjustmentDeltas correctly keeps transferred units out of COGS (they moved warehouse, they
 * were not sold), and for a RECEIVED or CANCELLED transfer propagateLandedCostToOutputs carries the delta
 * to the layer holding them. For a unit still in transit nothing holds it: the layer's remainingQty is 0
 * (so inventoryDelta is 0) and no cost-layer source line exists yet, so before this function the delta
 * reached nothing and the recalculation queued NO journal for it, leaving the freight debit in Stock in
 * Transit and Inventory understated, invisibly.
 *
 * THE DECISION (D1). Transfers post no GL entry, so those units are still in GL Inventory, and their
 * share is the entry on-hand units get: DR Inventory / CR Transit AT REVALUATION TIME (reversed for a
 * decrease). The snapshot the revaluation rewrites is what the later receipt or cancellation costs its
 * layer from, and that posts nothing. Each revaluation measures the state at ITS moment, so a second
 * revaluation, a reversal and a freight cancellation each post their own signed difference: there is no
 * obligation to persist or settle and no ledger to read.
 *
 * WHAT COUNTS. For every line of an IN_TRANSIT transfer whose snapshot names the layer
 * (TRANSFER_STATUSES_WITH_IN_TRANSIT_RESIDUE: RECEIVED and CANCELLED contribute zero, their units are in
 * layers propagation reaches), the snapshot is sliced PAST the line's LANDED quantity with
 * `sliceTransferSnapshotForReceipt` (the receipts' own slicer, so the residue and the layer a receipt will
 * create walk past the same units) and the entries naming this layer are summed. LANDED is
 * `loadTransferLineLandedQty`'s definition: manual and WMS-webhook receipts (`qtyReceived`) AND an
 * unabsorbed alignment credit (`qtyAccountedViaSnapshot`), which `qty - qtyReceived` would miss and so
 * overstate the residue (6oyu.19 Codex r6).
 *
 * `consumedQty` is the layer's received - remaining: units in transit were consumed from the layer at
 * dispatch, so a layer with nothing consumed cannot have any, and the JSONB containment query is skipped
 * (the same short-circuit loadLayerConsumptionExclusions makes).
 *
 * EVERYTHING reads through `tx` (no pooled client inside the revaluation transaction), and the caller
 * holds the transfers (lockLandedCostRevaluationScope), so a receipt, an alignment or a cancellation
 * cannot move units between this read and the commit.
 *
 * It must be called at EVERY site that revalues a layer and journals its inventory delta: the root loop of
 * recalculateLandedCosts, recalculateDirectLandedCosts and the output recursion of
 * propagateLandedCostToOutputs. A site that skips it silently strands that site's in-transit share, which
 * is exactly the defect; tests/domain/purchasing/in-transit-residue-census.test.ts reads the source and
 * fails when one stops calling it.
 *
 * @internal Exported for tests; production callers reach it through the three revaluation sites.
 */
export async function capitaliseInTransitResidue(
  tx: Prisma.TransactionClient,
  deps: LandedCostServiceDeps,
  costLayerId: string,
  unitDelta: Prisma.Decimal,
  consumedQty: Prisma.Decimal,
): Promise<InTransitResidue> {
  if (unitDelta.abs().lte(LANDED_COST_DELTA_EPSILON)) return noInTransitResidue()
  if (consumedQty.lte(LANDED_COST_DELTA_EPSILON)) return noInTransitResidue()
  const lines = await deps.getInTransitTransferLinesForCostLayer(tx, costLayerId)
  if (lines.length === 0) return noInTransitResidue()
  const landedByLineId = await loadTransferLineLandedQty(tx, lines)

  const entries: InTransitResidueEntry[] = []
  let totalQty = new Prisma.Decimal(0)
  let totalDelta = new Prisma.Decimal(0)
  for (const line of lines) {
    const inTransit = sliceTransferSnapshotForReceipt({
      snapshot: line.costLayerSnapshot,
      alreadyLanded: requireLandedQty(landedByLineId, line.id),
      // Everything the snapshot still holds past the landed units: the slicer takes up to this many.
      qtyReceived: Number.MAX_SAFE_INTEGER,
    })
    const qty = inTransit
      .filter((entry) => entry.costLayerId === costLayerId)
      .reduce((sum, entry) => sum.add(new Prisma.Decimal(String(entry.qty ?? 0))), new Prisma.Decimal(0))
    if (qty.lte(LANDED_COST_DELTA_EPSILON)) continue
    const delta = unitDelta.mul(qty)
    entries.push({
      costLayerId,
      transferLineId: line.id,
      qty: qty.toString(),
      unitDelta: unitDelta.toString(),
      delta: delta.toString(),
    })
    totalQty = totalQty.add(qty)
    totalDelta = totalDelta.add(delta)
  }
  return { delta: totalDelta, qty: totalQty, entries }
}

// BOM nesting is shallow in practice; this is a runaway/cycle backstop only. The constant lives in
// transfer-asn-lock-order.ts because `lockLandedCostRevaluationScope` locks exactly the closure this walk
// can reach (o3d-nrl4 PR A): one number, so the lock and the walk cannot drift apart.
const MAX_LANDED_COST_PROPAGATION_DEPTH = LANDED_COST_PROPAGATION_MAX_DEPTH

/**
 * Propagate a retrospective per-unit cost change on `sourceCostLayerId` into the
 * manufactured output layers it fed (audit-e7h8). For each dependent output layer:
 *  - bump its unitCostBase proportionally: delta × component-qty-consumed / output
 *    receivedQty (the output's total cost rises by delta × units consumed),
 *  - refresh COGS snapshots for finished goods already sold from it,
 *  - split the bump into COGS (sold) / inventory (on-hand) via
 *    calculateLayerAdjustmentDeltas, accumulated into the SAME landed-cost journals,
 *  - recurse into ITS outputs, so the change cascades through nested BOM levels.
 * The output's own manufacturing-consumed portion is excluded from its COGS by
 * calculateLayerAdjustmentDeltas and instead carried by the recursion.
 *
 * `ancestors` is the set of layers on the CURRENT path (root → here). The guard is
 * path-based, not a global visited set, so a layer reached via two distinct paths
 * (a diamond BOM — one output feeding two parents that share an ancestor) still
 * accumulates BOTH contributions, while a true cycle (a layer that is its own
 * ancestor) is cut. A depth bound backstops runaway.
 */
/** @internal Exported for tests; production callers reach it via the recalc paths. */
export async function propagateLandedCostToOutputs(
  tx: Prisma.TransactionClient,
  deps: LandedCostServiceDeps,
  sourceCostLayerId: string,
  costDeltaPerUnit: Prisma.Decimal,
  accumulate: (
    cogsDelta: Prisma.Decimal,
    inventoryDelta: Prisma.Decimal,
    audit: { sourceCostLayerId: string; outputCostLayerId: string; oldUnitCostBase: string; newUnitCostBase: string; consumedQty: string; inTransitResidue: InTransitResidueEntry[] },
  ) => void,
  ancestors: Set<string>,
  depth: number,
  recalcRunId: string,
  revaluedAt: Date,
  revaluationContext?: ShipmentRevaluationContext,
): Promise<void> {
  if (costDeltaPerUnit.abs().lte(LANDED_COST_DELTA_EPSILON)) return
  if (depth > MAX_LANDED_COST_PROPAGATION_DEPTH) return
  if (ancestors.has(sourceCostLayerId)) return // cycle on the current path
  const nextAncestors = new Set(ancestors).add(sourceCostLayerId)

  const sourceLines = await deps.getDependentOutputSourceLines(tx, sourceCostLayerId)
  if (sourceLines.length === 0) return

  // Keep the produced output's source-line valuation in sync with the new source
  // cost. recalculateManufacturingCostLayers recomputes an output layer's
  // unitCostBase by re-summing its sourceLines.totalCostBase, so a later
  // manufacturing-cost edit would otherwise ERASE this propagated uplift
  // (Codex F1). Bump each contributing source line by the per-unit delta.
  for (const sl of sourceLines) {
    await tx.costLayerSourceLine.update({
      where: { id: sl.sourceLineId },
      data: {
        unitCostBase: { increment: costDeltaPerUnit },
        totalCostBase: { increment: costDeltaPerUnit.mul(decimal(sl.qty)) },
      },
    })
  }

  // An output layer can consume the same source layer via multiple lines — sum.
  const qtyByOutput = new Map<string, Prisma.Decimal>()
  for (const sl of sourceLines) {
    qtyByOutput.set(sl.outputCostLayerId, (qtyByOutput.get(sl.outputCostLayerId) ?? new Prisma.Decimal(0)).add(decimal(sl.qty)))
  }

  for (const [outputCostLayerId, consumedQty] of qtyByOutput) {
    const output = await tx.costLayer.findUnique({
      where: { id: outputCostLayerId },
      select: { unitCostBase: true, receivedQty: true, remainingQty: true },
    })
    if (!output) continue
    const outputReceivedQty = decimal(output.receivedQty)
    if (outputReceivedQty.lte(LANDED_COST_DELTA_EPSILON)) continue

    // The output's total cost rises by delta × component units consumed; spread
    // over the produced quantity for the per-unit bump.
    const outputUnitDelta = costDeltaPerUnit.mul(consumedQty).div(outputReceivedQty)
    if (outputUnitDelta.abs().lte(LANDED_COST_DELTA_EPSILON)) continue
    const oldOutputUnitCost = decimal(output.unitCostBase)
    const newOutputUnitCost = oldOutputUnitCost.add(outputUnitDelta).toDecimalPlaces(6, Prisma.Decimal.ROUND_HALF_UP)

    await tx.costLayer.update({ where: { id: outputCostLayerId }, data: { unitCostBase: newOutputUnitCost } })
    await deps.recordCostLayerRevaluation(tx, {
      costLayerId: outputCostLayerId,
      oldUnitCostBase: oldOutputUnitCost,
      newUnitCostBase: newOutputUnitCost,
      effectiveAt: revaluedAt,
      reason: 'landed_cost_output_propagation',
    })

    const outputRemainingQty = decimal(output.remainingQty)
    const outputExclusions = await loadLayerConsumptionExclusions(
      tx,
      deps,
      outputCostLayerId,
      outputReceivedQty.sub(outputRemainingQty),
    )
    const outDeltas = calculateLayerAdjustmentDeltas({
      oldUnitCost: oldOutputUnitCost,
      newUnitCost: newOutputUnitCost,
      receivedQty: outputReceivedQty,
      remainingQty: outputRemainingQty,
      ...outputExclusions,
    })
    // Reflect the new output cost in finished goods already sold from this layer,
    // FIRST, so its COGS revaluation can be removed from the cascade's COGS
    // delta (audit-3aph): the shipment path owns the sold-finished-good COGS, so
    // counting it here too would double-post COGS for the same units.
    let outputShipmentRevalDelta = new Prisma.Decimal(0)
    if (outDeltas.costDelta.abs().gt(LANDED_COST_DELTA_EPSILON)) {
      await deps.updateSnapshotsForCostLayerChange(tx, outputCostLayerId, newOutputUnitCost)
      const shipmentRefresh = await deps.refreshShipmentCogsForCostLayerChange(tx, outputCostLayerId, {
        recalcRunId,
        revaluationContext: revaluationContext
          ? { ...revaluationContext, source: 'landed_cost_output_propagation' }
          : undefined,
      })
      outputShipmentRevalDelta = shipmentRefresh.cogsRevaluationDelta
      await deps.refreshSalesOrderLineCogsForCostLayerChange(tx, outputCostLayerId)
    }
    // o3d-nrl4 PR B (site 3 of 3): units of THIS output layer that are on an IN_TRANSIT transfer have no
    // layer for the delta to reach (a chained transfer, or a manufactured output dispatched before it
    // landed), so their share is capitalised here, exactly as at the root.
    const outputResidue = await capitaliseInTransitResidue(
      tx, deps, outputCostLayerId, outDeltas.costDelta, outputReceivedQty.sub(outputRemainingQty),
    )
    accumulate(outDeltas.cogsDelta.sub(outputShipmentRevalDelta), outDeltas.inventoryDelta.add(outputResidue.delta), {
      sourceCostLayerId,
      outputCostLayerId,
      oldUnitCostBase: oldOutputUnitCost.toString(),
      newUnitCostBase: newOutputUnitCost.toString(),
      consumedQty: consumedQty.toString(),
      inTransitResidue: outputResidue.entries,
    })

    // Cascade into outputs that consumed THIS output (nested BOM levels).
    await propagateLandedCostToOutputs(tx, deps, outputCostLayerId, outputUnitDelta, accumulate, nextAncestors, depth + 1, recalcRunId, revaluedAt, revaluationContext)
  }
}

/**
 * o3d-c08y: the NEGATIVE (credit) cost lines behind a revaluation, named in a refusal so the operator
 * is told exactly which line to correct. Positive lines are left out: they cannot drive a basis
 * below zero. The allocation now floors every unit cost at zero, so a landed-cost revaluation can no
 * longer reach that refusal; the context is still carried for the backstop (see buildRefusalRemedy).
 */
function creditCostLinesOf(
  entries: Array<{ line: { id?: string | null; amountBase: Prisma.Decimal | number | string | null }; poId: string; poReference: string | null }>,
): NonNullable<ShipmentRevaluationContext['creditCostLines']> {
  return entries
    .filter((entry) => decimal(entry.line.amountBase).lt(0))
    .map((entry) => ({
      freightCostLineId: String(entry.line.id ?? '(unknown line)'),
      purchaseOrderId: entry.poId,
      purchaseOrderReference: entry.poReference,
      amountBase: decimal(entry.line.amountBase).toFixed(2),
    }))
}

function makeWeightFallbackWarning(context: string): LandedCostRevaluationWarning {
  const description = `${context}: BY_WEIGHT landed-cost allocation fell back to equal split because every eligible line had zero weight`
  return { code: 'weight_fallback', context, message: description }
}

function warnWeightFallback(context: string): LandedCostRevaluationWarning {
  const warning = makeWeightFallbackWarning(context)
  const description = warning.message
  console.warn(description)
  void logActivity({
    entityType: 'PURCHASE_ORDER',
    entityId: null,
    action: 'landed_cost_weight_fallback',
    tag: 'purchase',
    level: 'WARNING',
    description,
    metadata: { context },
    resolveUser: false,
  }).catch((error) => console.error(error))
  return warning
}

function captureWeightFallback(
  result: LandedCostRecalcResult,
  runWarnings: LandedCostRevaluationWarning[],
  deps: LandedCostServiceDeps,
  context: string,
): void {
  const warning = deps.warnWeightFallback(context) ?? makeWeightFallbackWarning(context)
  result.warnings.push(warning)
  runWarnings.push(warning)
}

function makeWeightZeroLineWarning(context: string, lineIds: string[]): LandedCostRevaluationWarning {
  const description = `${context}: BY_WEIGHT landed-cost allocation assigned zero freight to ${lineIds.length} positive-quantity line(s) with zero/blank weight; that freight was distributed onto the weighted lines instead`
  return { code: 'weight_zero_line', context, message: description }
}

function warnWeightZeroLines(context: string, lineIds: string[]): LandedCostRevaluationWarning {
  const warning = makeWeightZeroLineWarning(context, lineIds)
  console.warn(warning.message)
  void logActivity({
    entityType: 'PURCHASE_ORDER',
    entityId: null,
    action: 'landed_cost_weight_zero_line',
    tag: 'purchase',
    level: 'WARNING',
    description: warning.message,
    metadata: { context, lineIds },
    resolveUser: false,
  }).catch((error) => console.error(error))
  return warning
}

function captureWeightZeroLines(
  result: LandedCostRecalcResult,
  runWarnings: LandedCostRevaluationWarning[],
  deps: LandedCostServiceDeps,
  context: string,
  lineIds: string[],
): void {
  if (lineIds.length === 0) return
  const warning = deps.warnWeightZeroLines(context, lineIds) ?? makeWeightZeroLineWarning(context, lineIds)
  result.warnings.push(warning)
  runWarnings.push(warning)
}

/**
 * Turn the allocation's events into the recalculation's warnings, in the order the cost lines were
 * processed. `contextPrefix` is e.g. `recalculateLandedCosts:PO-1`; linked-freight cost lines add `:linked`.
 */
function captureAllocationEvents(
  events: LandedAllocationEvent[],
  result: LandedCostRecalcResult,
  runWarnings: LandedCostRevaluationWarning[],
  deps: LandedCostServiceDeps,
  contextPrefix: string,
): void {
  for (const event of events) {
    const context = event.sourceRank === 1 ? `${contextPrefix}:linked` : contextPrefix
    if (event.kind === 'weight_fallback') captureWeightFallback(result, runWarnings, deps, context)
    else captureWeightZeroLines(result, runWarnings, deps, context, event.lineIds)
  }
}

/**
 * The floor's footprint on one revaluation: the per-layer audit keys, and the single warning the run
 * carries. `activityDue` is true only when a floored layer's unit cost actually CHANGED in this run, so a
 * no-op recalculation repeats the warning in `warningsJson` (state) without writing another activity entry
 * (event). A change of the unabsorbed AMOUNT while the layer stays at zero is an event too: the callers
 * compare it with the previous run's record (`previousFloorResidue`) and set `activityDue`.
 */
type FloorFootprint = {
  entries: FlooredLandedCreditEntry[]
  activityDue: boolean
}

/**
 * What the PREVIOUS revaluation of this order recorded as unabsorbed (the sum of `unabsorbedBase` over its
 * layers in `afterJson`), or zero when it floored nothing or there was no run. The floor's residue can change
 * while every floored layer stays at 0.00 (a credit that grows), so "did the unit cost change" cannot tell a
 * repeat from a new amount; the previous run's own record can. Read only when this run floored something.
 */
async function previousFloorResidue(tx: Prisma.TransactionClient, primaryPoId: string): Promise<Prisma.Decimal> {
  const run = await tx.landedCostRevaluationRun.findFirst({
    where: { primaryPoId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { afterJson: true },
  })
  const lines = (run?.afterJson as { lines?: Array<{ costLayers?: Array<{ unabsorbedBase?: string }> }> } | null | undefined)?.lines ?? []
  let total = new Prisma.Decimal(0)
  for (const line of lines) {
    for (const layer of line.costLayers ?? []) {
      if (layer.unabsorbedBase) total = total.add(new Prisma.Decimal(layer.unabsorbedBase))
    }
  }
  return total
}

function recordFlooredLandedCredit(
  result: LandedCostRecalcResult,
  runWarnings: LandedCostRevaluationWarning[],
  purchaseOrderId: string,
  context: string,
  footprint: FloorFootprint,
): void {
  if (footprint.entries.length === 0) return
  const message = describeFlooredLandedCredit({ context, entries: footprint.entries })
  const warning: LandedCostRevaluationWarning = { code: 'landed_cost_credit_floored', context, message }
  result.warnings.push(warning)
  runWarnings.push(warning)
  if (footprint.activityDue) {
    ;(result.creditFloorActivities ??= []).push({ purchaseOrderId, context, entries: footprint.entries })
  }
}

/**
 * Write the durable activity WARNINGs a recalculation collected. Call it AFTER the transaction that ran the
 * recalculation has committed: an activity write uses its own connection, so writing inside would leave the
 * entry standing if the transaction later rolled back.
 */
export async function logLandedCostCreditFloorActivities(
  result: Pick<LandedCostRecalcResult, 'creditFloorActivities'> | null | undefined,
): Promise<void> {
  for (const activity of result?.creditFloorActivities ?? []) {
    await logFlooredLandedCredit(activity)
  }
}

function decimalText(value: Prisma.Decimal | number | string | null | undefined): string {
  return decimal(value).toString()
}

function revaluationBeforeJson(po: {
  id: string
  reference: string
  lines: Array<{
    id: string
    qty: Prisma.Decimal | number | string
    unitCostBase: Prisma.Decimal | number | string
    landedUnitCostBase?: Prisma.Decimal | number | string | null
    costLayers: Array<{
      id: string
      unitCostBase: Prisma.Decimal | number | string
      receivedQty: Prisma.Decimal | number | string
      remainingQty: Prisma.Decimal | number | string
    }>
  }>
}) {
  return {
    purchaseOrder: { id: po.id, reference: po.reference },
    lines: po.lines.map((line) => ({
      lineId: line.id,
      qty: decimalText(line.qty),
      unitCostBase: decimalText(line.unitCostBase),
      landedUnitCostBase: decimalText(line.landedUnitCostBase),
      costLayers: line.costLayers.map((layer) => ({
        costLayerId: layer.id,
        unitCostBase: decimalText(layer.unitCostBase),
        receivedQty: decimalText(layer.receivedQty),
        remainingQty: decimalText(layer.remainingQty),
      })),
    })),
  }
}

function revaluationAccountingJson(params: {
  primaryPoId: string
  inventoryTransitAdjustments: LandedCostRecalcResult['inventoryTransitAdjustments']
  cogsAdjustments: LandedCostRecalcResult['cogsAdjustments']
}) {
  return {
    inventoryTransitAdjustments: params.inventoryTransitAdjustments
      .filter((adj) => adj.primaryPoId === params.primaryPoId)
      .map((adj) => ({
        ...adj,
        idempotencyKey: landedCostAdjustmentIdempotencyKey('inventory', adj),
      })),
    cogsAdjustments: params.cogsAdjustments
      .filter((adj) => adj.primaryPoId === params.primaryPoId)
      .map((adj) => ({
        ...adj,
        idempotencyKey: landedCostAdjustmentIdempotencyKey('cogs', adj),
      })),
  }
}

function landedCostAdjustmentKeyPayload(adj: LandedCostAdjustment): Record<string, unknown> {
  // Including freightPoId intentionally separates linked freight adjustments
  // for the same primary PO. A live deployment must drain or rewrite any
  // pre-change queued adjustment keys before replaying landed-cost syncs.
  return {
    primaryPoId: adj.primaryPoId,
    primaryPoRef: adj.primaryPoRef,
    freightPoId: adj.freightPoId,
    eventKey: adj.eventKey,
    totalDelta: Math.round(adj.totalDelta * 100) / 100,
  }
}

// Event-key context uses the project rounding policy so equivalent Decimal
// inputs normalize consistently before hashing.
export function roundAdjustmentContextValue(value: Prisma.Decimal): number {
  return value.toDecimalPlaces(6, Prisma.Decimal.ROUND_HALF_UP).toNumber()
}

// Journal totals preserve the legacy JS midpoint behavior for backward
// compatibility with existing landed-cost adjustment idempotency keys.
export function roundAdjustmentTotalDelta(value: Prisma.Decimal): number {
  return Math.round(value.mul(100).toNumber()) / 100
}

export function landedCostAdjustmentEventKey(
  primaryPoId: string,
  layers: LandedCostAdjustmentLayerContext[],
  // audit-g4la: a per-recalc-run nonce so two recalcs that produce IDENTICAL
  // layer content (e.g. landed cost A→B today, then A→B again later via B→A→B)
  // still get DISTINCT event keys — otherwise the content-only hash re-collides
  // and the second real correction's journal is deduped against the first and
  // silently dropped. The nonce is generated once per recalc and stamped onto
  // every adjustment, so it flows through the grob durable outbox: the direct
  // post-commit call and the cron drain read the SAME stored eventKey and still
  // dedupe each other, while a distinct later recalc gets a distinct key.
  recalcRunId: string,
): string {
  return accountingPayloadKey('landed-cost-adjustment-event', {
    recalcRunId,
    primaryPoId,
    layers: layers
      .map((layer) => ({
        costLayerId: layer.costLayerId,
        oldUnitCost: roundAdjustmentContextValue(layer.oldUnitCost),
        newUnitCost: roundAdjustmentContextValue(layer.newUnitCost),
        receivedQty: roundAdjustmentContextValue(layer.receivedQty),
        remainingQty: roundAdjustmentContextValue(layer.remainingQty),
        returnedQty: roundAdjustmentContextValue(layer.returnedQty),
        supplierReturnedQty: roundAdjustmentContextValue(layer.supplierReturnedQty),
        manufacturingConsumedQty: roundAdjustmentContextValue(layer.manufacturingConsumedQty),
      }))
      .sort((left, right) => left.costLayerId.localeCompare(right.costLayerId)),
  })
}

export function landedCostAdjustmentIdempotencyKey(
  kind: 'inventory' | 'cogs',
  adj: LandedCostAdjustment,
): string {
  return accountingPayloadKey(
    `landed-cost:${kind}:${adj.primaryPoId}`,
    landedCostAdjustmentKeyPayload(adj),
  )
}

/**
 * WHICH LINKED FREIGHT ORDERS STILL CONTRIBUTE LANDED COST — ONE DEFINITION (o3d-6nd55 r2).
 *
 * A CANCELLED freight purchase order must no longer contribute: excluding it is exactly what lets
 * cancellation revert the uplift it had applied. Both landed-cost recalculation paths in this file
 * have said so for a long time, each with its own inline copy of the predicate and its own audit
 * reference — `recalculateLandedCosts` (audit-C3) and `recalculateDirectLandedCosts` (audit-izrf).
 *
 * WHY IT IS NOW A CONSTANT. Codex round 2 on o3d-6nd55 found the WMS stock-sync align-up path
 * reading `landedCostLinks` with NO filter, so a cancelled freight order's cost lines were added
 * back into the align-up cost layer, the stock movement and the STOCK_RECEIPT journal — overstating
 * inventory by freight the business had cancelled, and disagreeing with what recalculation would
 * compute for the same units. A third reader of "which links count" was a third chance to get it
 * wrong, so the predicate has one name and the readers derive it rather than restate it.
 *
 * IT FILTERS ON STATUS AND DELIBERATELY NOT ON `LandedCostLink.allocated`. `allocated` records
 * whether the uplift has been WRITTEN to `landedUnitCostBase` yet; the whole purpose of
 * `computeGrossUnitCostBaseByLine` is to value a receipt whose freight has NOT been allocated yet, so
 * filtering on it would zero exactly the case the helper exists for. Cancellation sets both — the
 * status is the fact about whether the cost still exists, and that is the one both recalc paths test.
 */
export const CONTRIBUTING_LANDED_COST_LINK_WHERE = {
  freightPO: { status: { not: 'CANCELLED' } },
} as const

/**
 * The receipt-side entry point to the ONE allocation (lib/domain/purchasing/landed-cost-allocation.ts): a
 * thin adapter from the shapes the callers already hold (PO lines, the PO's own cost lines, its linked
 * freight POs' cost lines) to `allocateLandedCost`. It adds nothing to the arithmetic, so the preview, the
 * manual receipt, the WMS book-in and the WMS align-up cannot disagree with `recalculateLandedCosts` or
 * `recalculateDirectLandedCosts`, which call the same function.
 *
 * Returns the whole allocation, not just the cost: a caller that lays a layer must also learn whether the
 * zero floor absorbed part of a negative landed cost (`floors`), because that is the one number the
 * operator has to be told. Pure apart from the weight-fallback warning it has always raised.
 */
export function computeLandedCostForPendingLines(params: {
  lines: PendingGrossCostLine[]
  directCostLines?: PendingGrossCostLineSource[]
  linkedCostLines?: PendingGrossCostLineSource[]
  onWeightZeroLines?: (lineIds: string[]) => void
}): LandedAllocation {
  const toCostLines = (sources: PendingGrossCostLineSource[] | undefined, sourceRank: LandedAllocationSourceRank): LandedAllocationCostLine[] => (
    (sources ?? []).map((source) => ({
      id: source.id ?? null,
      amountBase: source.amountBase,
      distributionMethod: source.distributionMethod,
      sourceRank,
    }))
  )
  const allocation = allocateLandedCost(
    params.lines.map((line) => ({
      id: line.id,
      qty: line.qty,
      unitCostBase: line.unitCostBase,
      totalBase: line.totalBase,
      weight: line.weight ?? null,
    })),
    [...toCostLines(params.directCostLines, 0), ...toCostLines(params.linkedCostLines, 1)],
  )
  for (const event of allocation.events) {
    if (event.kind === 'weight_fallback') {
      warnWeightFallback('computeGrossUnitCostBaseByLine')
    } else if (params.onWeightZeroLines) {
      // Opt-in only: this helper also runs on read-only cost previews
      // (getPurchaseOrder, receipt validation), so it must not persist a warning
      // by default. The recalc paths surface the diagnostic via result.warnings.
      params.onWeightZeroLines(event.lineIds)
    }
  }
  return allocation
}

export function computeGrossUnitCostBaseByLine(params: {
  lines: PendingGrossCostLine[]
  directCostLines?: PendingGrossCostLineSource[]
  linkedCostLines?: PendingGrossCostLineSource[]
  onWeightZeroLines?: (lineIds: string[]) => void
}): Map<string, Prisma.Decimal> {
  return computeLandedCostForPendingLines(params).grossUnitCostBaseByLine
}

/**
 * Whether a freight PO's cost lines still count toward landed cost. The in-memory twin of
 * `CONTRIBUTING_LANDED_COST_LINK_WHERE` (derived from it, never restated): the PO detail preview reads its
 * freight links through `getLinkedFreightPos`, which is deliberately unfiltered because it also LISTS
 * cancelled freight for the operator, so the cost inputs must be filtered here to agree with receipt and
 * recalculation.
 */
export function freightPoContributesLandedCost(freightPoStatus: string): boolean {
  return freightPoStatus !== CONTRIBUTING_LANDED_COST_LINK_WHERE.freightPO.status.not
}

/**
 * scjz.34: the account that offsets a CONSUMED-qty retrospective COGS correction
 * (goods already sold). The freight bill debits the transit/clearing account for
 * ALL received units; the landed-cost recalc then drains transit in full — the
 * ON-HAND portion via DR inventory / CR transit, and the CONSUMED portion via this
 * COGS adjustment (DR COGS / CR transit on an increase). Routing the consumed
 * portion to transit (rather than the inventory-revaluation P&L account, the prior
 * audit-o3yb behaviour) is what fully clears the freight bill's transit debit;
 * otherwise the sold units' freight share stayed permanently in transit.
 */
export function resolveConsumedCogsOffsetAccount(
  settings: Pick<AccountingSettings, 'transitAccount'>,
): string {
  return settings.transitAccount
}

/**
 * o3d-j625 r4 (SWEEP 1) — HOW MANY OF THIS RUN'S JOURNALS ARE STILL OWED.
 *
 * Returned so the landed-cost journal OUTBOX — the backstop that exists precisely to re-run this — can
 * tell a run that queued everything from a run whose journals were refused. It used to call this, get
 * `void`, and mark the job SUCCEEDED either way, so a refused journal was reported once and then never
 * retried by the one mechanism built to retry it.
 */
export type LandedCostJournalRunOutcome = { owed: number }

export async function queueLandedCostAdjustmentJournals(
  adjustments: LandedCostRecalcResult,
): Promise<LandedCostJournalRunOutcome> {
  const settings = await getAccountingSettings()
  let owed = 0

  for (const adj of adjustments.inventoryTransitAdjustments) {
    const absDelta = Math.abs(adj.totalDelta)
    if (absDelta <= 0.01) continue
    const isIncrease = adj.totalDelta > 0
    const payload = {
      date: new Date().toISOString().slice(0, 10),
      reference: `Landed cost reclass — ${adj.primaryPoRef}`,
      narration: `Late landed cost ${isIncrease ? 'capitalisation' : 'reversal'} of £${absDelta.toFixed(2)} on ${adj.primaryPoRef}`,
      lines: [
        {
          accountCode: isIncrease ? settings.inventoryAccount : settings.transitAccount,
          description: `Landed cost reclass — ${adj.primaryPoRef}`,
          debit: absDelta,
        },
        {
          accountCode: isIncrease ? settings.transitAccount : settings.inventoryAccount,
          description: `Landed cost reclass — ${adj.primaryPoRef}`,
          credit: absDelta,
        },
      ],
    }
    // 6oyu.4 (khdw): commit the STOCK_IN_TRANSIT reclass queue + its transit subledger
    // row atomically (mirrors the COGS bcz9.2 pattern below) so a crash between them
    // can't desync the ledger from the GL. Record only when actually queued; the
    // signed delta follows the transit LEG: increase → CR transit (−), decrease → DR
    // transit (+). Keyed by the journal's OWN idempotency key.
    const reclassIdempotencyKey = landedCostAdjustmentIdempotencyKey('inventory', adj)
    // o3d-j625 r3 (Codex HIGH 1 family): a HOLDER, so TypeScript does not collapse it to `never` on the
    // strength of assignments it cannot see inside the transaction callback.
    const postingOutcome: { outcome?: EnqueueOutcomeLike } = {}
    await db.$transaction(async (tx) => {
      const queued = await queueAccountingSyncTx(tx, {
        type: 'STOCK_IN_TRANSIT',
        referenceType: 'PurchaseOrder',
        referenceId: adj.primaryPoId,
        payload,
        idempotencyKey: reclassIdempotencyKey,
        // o3d-j625 r2: `payload`'s two lines are `settings.inventoryAccount` and
        // `settings.transitAccount` from the ONE `getAccountingSettings()` at the top of
        // `queueLandedCostAdjustmentJournals`. That read is outside the loop, and each iteration opens
        // its OWN transaction — so a connector switch part-way through a multi-PO recalculation used to
        // split one run's journals across two ledgers while every one of them carried the first
        // connector's codes. Routed by the chart, the later ones refuse instead.
        chartConnector: settings.connector,
        // o3d-j625 r3 (Codex HIGH 1 family): the whole answer. Each iteration opens its own transaction
        // and nothing outside the loop accounts for a failure, so a mid-loop decline silently dropped
        // that PO's reclass while the recalculation reported normally.
        reportOutcome: (outcome) => { postingOutcome.outcome = outcome },
      })
      if (queued) {
        await recordTransitSubledgerMovement(tx, {
          sourceType: 'LANDED_COST_RECLASS',
          sourceRef: adj.primaryPoId,
          idempotencyKey: reclassIdempotencyKey,
          baseDelta: isIncrease ? -absDelta : absDelta,
          journalDate: payload.date,
        })
      }
    })
    if (postingOutcome.outcome && postingIsOwed(postingOutcome.outcome)) {
      owed++
      await reportPostingNotQueued({
        entityType: 'PURCHASE_ORDER',
        entityId: adj.primaryPoId,
        action: 'landed_cost_reclass_not_queued',
        // o3d-j625 r6 (review H4): which site refused, and so whether its row clears itself or is marked handled.
        // o3d-j625 r7 (review H-B): ONE kind whoever raised it. The direct callers (a PO edit, a freight PO, a
        // cancellation) schedule the landed-cost outbox too, and it retries this SAME posting — r6 called
        // their refusals manual-only, so a hand-posted journal was then posted again by the outbox.
        kind: 'landed_cost_transit_journal',
        posting: `the landed-cost inventory/transit reclass for ${adj.primaryPoRef}`,
        committed: 'the landed cost is applied to the stock on hand in IMS',
        // r6 (review H4): the outbox retries its own; posting that one by hand as well would post it twice.
        remedy:
          'Inventory and goods-in-transit in the ledger no longer match IMS for this order. The landed-cost '
          + 'journal outbox retries it once the accounting connector selection has settled; if it has given up, '
          + 'post the reclass by hand and mark this row handled. ' + MARK_REMEDY_TAIL,
        outcome: postingOutcome.outcome,
        metadata: { primaryPoRef: adj.primaryPoRef, chartConnector: settings.connector },
      })
    }
  }

  // scjz.34: the CONSUMED-qty correction (goods already sold) offsets COGS to the
  // transit/clearing account so the freight bill's transit debit drains in full.
  // The ON-HAND portion is handled by the inventoryTransitAdjustments loop above and
  // also clears through transit; together they fully reconcile the freight liability.
  const consumedCogsOffsetAccount = resolveConsumedCogsOffsetAccount(settings)
  for (const adj of adjustments.cogsAdjustments) {
    const absDelta = Math.abs(adj.totalDelta)
    if (absDelta <= 0.01) continue
    const isIncrease = adj.totalDelta > 0
    const payload = {
      date: new Date().toISOString().slice(0, 10),
      reference: `Landed cost adjustment — ${adj.primaryPoRef}`,
      narration: `Retrospective COGS adjustment: landed cost ${isIncrease ? 'increase' : 'decrease'} of £${absDelta.toFixed(2)} on ${adj.primaryPoRef}`,
      lines: [
        {
          accountCode: isIncrease ? settings.cogsAccount : consumedCogsOffsetAccount,
          description: `COGS adjustment — ${adj.primaryPoRef}`,
          debit: absDelta,
        },
        {
          accountCode: isIncrease ? consumedCogsOffsetAccount : settings.cogsAccount,
          description: `COGS adjustment — ${adj.primaryPoRef}`,
          credit: absDelta,
        },
      ],
    }
    const cogsIdempotencyKey = landedCostAdjustmentIdempotencyKey('cogs', adj)
    // o3d-j625 r3 (Codex HIGH 1 family): a HOLDER, so TypeScript does not collapse it to `never` on the
    // strength of assignments it cannot see inside the transaction callback.
    const cogsPostingOutcome: { outcome?: EnqueueOutcomeLike } = {}
    // bcz9.2: commit the COGS journal queue + its subledger ledger row atomically in
    // one transaction so a crash (or a posting-setting change) between them can't leave
    // a queued journal with no ledger row, or a ledger row with no journal — either of
    // which would make the daily-batch COGS reconciliation perpetually flag. The ledger
    // row is recorded based on the queue's OWN decision (queueAccountingSyncTx's return)
    // per adjustment, not a separate settings recheck, so a connector/setting flip
    // mid-loop can't desync queue vs ledger (Codex bcz9.4).
    await db.$transaction(async (tx) => {
      const queued = await queueAccountingSyncTx(tx, {
        type: 'COGS_JOURNAL',
        referenceType: 'PurchaseOrder',
        referenceId: adj.primaryPoId,
        payload,
        idempotencyKey: cogsIdempotencyKey,
        // o3d-j625 r2: `settings.cogsAccount` and `resolveConsumedCogsOffsetAccount(settings)` — the
        // same `settings` object as the reclass loop above, and the same per-iteration transaction.
        chartConnector: settings.connector,
        // o3d-j625 r3 (Codex HIGH 1 family): per-iteration, per-transaction, and previously unreported.
        reportOutcome: (outcome) => { cogsPostingOutcome.outcome = outcome },
      })
      if (queued) {
        await recordCogsSubledgerMovement(tx, {
          sourceType: 'LANDED_COST_ADJUSTMENT',
          sourceRef: adj.primaryPoId,
          idempotencyKey: cogsIdempotencyKey,
          baseDelta: isIncrease ? absDelta : -absDelta,
          journalDate: payload.date,
        })
        // 6oyu.4 (khdw): the consumed-qty COGS adjustment offsets the TRANSIT account
        // (resolveConsumedCogsOffsetAccount → transitAccount), so the SAME journal also
        // moves transit — record its transit leg. On an increase: DR COGS / CR transit
        // (transit −); on a decrease: DR transit / CR COGS (transit +). Same key as the
        // COGS row but a separate ledger table, so no collision.
        await recordTransitSubledgerMovement(tx, {
          sourceType: 'LANDED_COST_CONSUMED_OFFSET',
          sourceRef: adj.primaryPoId,
          idempotencyKey: cogsIdempotencyKey,
          baseDelta: isIncrease ? -absDelta : absDelta,
          journalDate: payload.date,
        })
      }
    })
    if (cogsPostingOutcome.outcome && postingIsOwed(cogsPostingOutcome.outcome)) {
      owed++
      await reportPostingNotQueued({
        entityType: 'PURCHASE_ORDER',
        entityId: adj.primaryPoId,
        action: 'landed_cost_cogs_journal_not_queued',
        // o3d-j625 r6 (review H4): which site refused, and so whether its row clears itself or is marked handled.
        kind: 'landed_cost_cogs_journal',
        posting: `the retrospective COGS adjustment for ${adj.primaryPoRef}`,
        committed: 'the landed-cost change is applied to the sold units in IMS',
        remedy:
          'COGS in the ledger does not reflect this landed-cost change and the freight liability will not drain '
          + 'out of goods-in-transit. The landed-cost journal outbox retries it once the accounting connector '
          + 'selection has settled; if it has given up, post the adjustment by hand and mark this row handled. '
          + MARK_REMEDY_TAIL,
        outcome: cogsPostingOutcome.outcome,
        metadata: { primaryPoRef: adj.primaryPoRef, chartConnector: settings.connector },
      })
    }
  }
  return { owed }
}

/**
 * Recalculate landed cost on all primary POs linked to this freight PO.
 * Updates PO line `landedUnitCostBase`, CostLayer `unitCostBase`, and CogsEntry costs.
 */
export async function recalculateLandedCosts(
  tx: Prisma.TransactionClient,
  freightPoId: string,
  deps: LandedCostServiceDeps | undefined,
  options: LandedCostRevaluationOptions,
): Promise<LandedCostRecalcResult> {
  const serviceDeps = deps ?? defaultDeps
  const links = await tx.landedCostLink.findMany({
    where: { freightPoId },
    select: { primaryPoId: true },
  })
  const result = emptyRecalcResult()
  // audit-g4la: one nonce per recalc run, stamped onto every adjustment's eventKey.
  const recalcRunId = randomUUID()
  // One effective timestamp per recalc run for the revaluation event log (blq0).
  const revaluedAt = new Date()

  for (const link of links) {
    const primaryPoId = link.primaryPoId

    const primaryPo = await tx.purchaseOrder.findUnique({
      where: { id: primaryPoId },
      select: {
        id: true,
        reference: true,
        status: true,
        subtotalBase: true,
        directFreightBase: true,
        lines: {
          // o3d-c08y r2: ordered for the same reason as the direct recalc — the refusal fires on the
          // first layer that would take a journaled shipment negative, so the walk order is observable
          // and must not be Postgres' choice.
          orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            qty: true,
            unitCostBase: true,
            landedUnitCostBase: true,
            totalBase: true,
            product: { select: { weight: true } },
            costLayers: {
              orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
              select: {
                id: true,
                unitCostBase: true,
                receivedQty: true,
                remainingQty: true,
              },
            },
          },
        },
        freightCostLines: {
          select: { id: true, amountBase: true, distributionMethod: true },
        },
      },
    })
    if (!primaryPo) continue
    if (primaryPo.status === 'CLOSED') {
      throw new Error(`Cannot recalculate landed costs for ${primaryPo.reference}: linked purchase order is in a locked status`)
    }
    const beforeJson = revaluationBeforeJson(primaryPo)

    const allLinks = await tx.landedCostLink.findMany({
      // audit-C3: a CANCELLED freight PO must no longer contribute landed cost —
      // excluding it here is what lets cancellation revert the uplift it applied. The predicate is
      // CONTRIBUTING_LANDED_COST_LINK_WHERE so this path, the direct recalc below and the WMS
      // align-up receipt cannot disagree about it (o3d-6nd55 r2).
      where: { primaryPoId, ...CONTRIBUTING_LANDED_COST_LINK_WHERE },
      select: {
        freightPO: {
          select: {
            id: true,
            reference: true,
            freightCostLines: {
              select: { id: true, amountBase: true, distributionMethod: true },
            },
          },
        },
      },
    })
    // o3d-c08y: what a refusal names as the thing to correct.
    const revaluationContext: ShipmentRevaluationContext = {
      source: 'landed_cost_recalc',
      // o3d-c08y r2: a cancellation cannot be "saved again", and this freight PO's own cost lines are
      // excluded from the figures above, so the remedy must name a different action and a different
      // document. See buildRefusalRemedy.
      operation: options.reason === 'freight_purchase_order_cancelled' ? 'cancel_freight_po' : 'save',
      primaryPoId,
      primaryPoReference: primaryPo.reference,
      freightPoId,
      creditCostLines: creditCostLinesOf([
        ...primaryPo.freightCostLines.map((line) => ({ line, poId: primaryPo.id, poReference: primaryPo.reference })),
        ...allLinks.flatMap((link) => link.freightPO.freightCostLines.map((line) => ({
          line,
          poId: link.freightPO.id,
          poReference: link.freightPO.reference,
        }))),
      ]),
    }
    // THE ONE ALLOCATION (landed-cost-allocation.ts): the same function the preview, the receipt, the WMS
    // book-in and the align-up call, so a layer laid at receipt and the same layer revalued here cannot
    // differ for the same cost lines. Source rank 0 = this PO's own lines, 1 = the linked freight POs'.
    const runWarnings: LandedCostRevaluationWarning[] = []
    const allocation = allocateLandedCost(
      primaryPo.lines.map((line) => ({
        id: line.id,
        qty: line.qty,
        unitCostBase: line.unitCostBase,
        totalBase: line.totalBase,
        weight: line.product?.weight ?? null,
      })),
      [
        ...primaryPo.freightCostLines.map((costLine) => ({ ...costLine, sourceRank: 0 as const })),
        ...allLinks.flatMap((linkRow) => linkRow.freightPO.freightCostLines.map((costLine) => ({ ...costLine, sourceRank: 1 as const }))),
      ],
    )
    captureAllocationEvents(allocation.events, result, runWarnings, serviceDeps, `recalculateLandedCosts:${primaryPo.reference}`)
    const floorByLine = new Map(allocation.floors.map((floor) => [floor.lineId, floor]))
    const floorFootprint: FloorFootprint = { entries: [], activityDue: false }

    let totalCogsDelta = new Prisma.Decimal(0)
    let totalInventoryDelta = new Prisma.Decimal(0)
    const adjustmentLayers: LandedCostAdjustmentLayerContext[] = []
    // audit-e7h8: itemised record of the BOM-cascade so the journal total (which
    // includes propagated output-layer deltas) is substantiated in the audit run.
    const propagatedOutputLayers: PropagatedOutputLayerAudit[] = []
    // o3d-nrl4 PR B: every in-transit residue line this run capitalised (root layers and propagated outputs),
    // itemised so the journal total is substantiated in the audit run. A new JSON key, no schema change.
    const inTransitResidue: InTransitResidueEntry[] = []
    const afterLines: AfterLineAudit[] = []

    for (const line of primaryPo.lines) {
      const lineQty = decimal(line.qty)
      if (lineQty.lte(0)) continue

      const baseUnitCostBase = decimal(line.unitCostBase)
      const landedForLine = decimal(allocation.landedAmountByLine.get(line.id))
      const grossUnitCostBase = allocation.grossUnitCostBaseByLine.get(line.id)!
      const floor = floorByLine.get(line.id)
      let lineUnabsorbedBase = new Prisma.Decimal(0)
      const afterLayers: AfterLayerAudit[] = []

      await tx.purchaseOrderLine.update({
        where: { id: line.id },
        data: { landedUnitCostBase: grossUnitCostBase },
      })

      for (const cl of line.costLayers) {
        const oldUnitCost = decimal(cl.unitCostBase)
        const newUnitCost = grossUnitCostBase
        const receivedQty = decimal(cl.receivedQty)
        const remainingQty = decimal(cl.remainingQty)
        const consumedQty = receivedQty.sub(remainingQty)
        const exclusions = await loadLayerConsumptionExclusions(tx, serviceDeps, cl.id, consumedQty)
        const { returnedQty, supplierReturnedQty, manufacturingConsumedQty } = exclusions
        const deltas = calculateLayerAdjustmentDeltas({
          oldUnitCost,
          newUnitCost,
          receivedQty,
          remainingQty,
          ...exclusions,
        })
        // o3d-nrl4 PR B (site 1 of 3): the units of this layer still in transit post their own share.
        const residue = await capitaliseInTransitResidue(tx, serviceDeps, cl.id, deltas.costDelta, consumedQty)
        inTransitResidue.push(...residue.entries)
        totalCogsDelta = totalCogsDelta.add(deltas.cogsDelta)
        totalInventoryDelta = totalInventoryDelta.add(deltas.inventoryDelta).add(residue.delta)
        if (
          deltas.cogsDelta.abs().gt(LANDED_COST_DELTA_EPSILON)
          || deltas.inventoryDelta.abs().gt(LANDED_COST_DELTA_EPSILON)
          || residue.delta.abs().gt(LANDED_COST_DELTA_EPSILON)
        ) {
          adjustmentLayers.push({
            costLayerId: cl.id,
            oldUnitCost,
            newUnitCost,
            receivedQty,
            remainingQty,
            returnedQty,
            supplierReturnedQty,
            manufacturingConsumedQty,
          })
        }
        await tx.costLayer.update({
          where: { id: cl.id },
          data: { unitCostBase: grossUnitCostBase },
        })
        await serviceDeps.recordCostLayerRevaluation(tx, {
          costLayerId: cl.id,
          oldUnitCostBase: oldUnitCost,
          newUnitCostBase: newUnitCost,
          effectiveAt: revaluedAt,
          reason: 'landed_cost_recalc',
        })

        // audit-e7h8: cascade the delta into produced output layers (the
        // manufacturing-consumed portion was excluded from this layer's COGS).
        await propagateLandedCostToOutputs(
          tx, serviceDeps, cl.id, deltas.costDelta,
          (cogsD, invD, audit) => {
            totalCogsDelta = totalCogsDelta.add(cogsD)
            totalInventoryDelta = totalInventoryDelta.add(invD)
            inTransitResidue.push(...audit.inTransitResidue)
            propagatedOutputLayers.push({ ...audit, cogsDelta: cogsD.toString(), inventoryDelta: invD.toString() })
          },
          new Set(), 1, recalcRunId, revaluedAt, revaluationContext,
        )

        let affectedRefundSnapshots = 0
        let affectedShipments = 0
        let affectedSalesOrderLines = 0
        if (deltas.costDelta.abs().gt(LANDED_COST_DELTA_EPSILON)) {
          affectedRefundSnapshots = await serviceDeps.updateSnapshotsForCostLayerChange(tx, cl.id, grossUnitCostBase)
          const shipmentRefresh = await serviceDeps.refreshShipmentCogsForCostLayerChange(tx, cl.id, { recalcRunId, revaluationContext })
          affectedShipments = shipmentRefresh.shipmentsUpdated
          // audit-3aph: the shipment path now owns the COGS revaluation for sold
          // goods (COGS_REVERSAL now / daily batch later), so remove it from the
          // COGS_JOURNAL to avoid debiting COGS twice for the same sold units.
          totalCogsDelta = totalCogsDelta.sub(shipmentRefresh.cogsRevaluationDelta)
          affectedSalesOrderLines = await serviceDeps.refreshSalesOrderLineCogsForCostLayerChange(tx, cl.id)
        }
        // The zero floor's footprint on this layer (units the floor could not absorb), exact Decimal.
        const layerUnabsorbedBase = floor ? unabsorbedBaseForQty(floor.unflooredGrossUnitCostBase, receivedQty) : null
        if (floor && layerUnabsorbedBase) {
          lineUnabsorbedBase = lineUnabsorbedBase.add(layerUnabsorbedBase)
          if (!oldUnitCost.eq(newUnitCost)) floorFootprint.activityDue = true
        }
        afterLayers.push({
          costLayerId: cl.id,
          oldUnitCostBase: oldUnitCost.toString(),
          newUnitCostBase: newUnitCost.toString(),
          receivedQty: receivedQty.toString(),
          remainingQty: remainingQty.toString(),
          consumedQty: consumedQty.toString(),
          returnedQty: returnedQty.toString(),
          supplierReturnedQty: supplierReturnedQty.toString(),
          manufacturingConsumedQty: manufacturingConsumedQty.toString(),
          cogsDelta: deltas.cogsDelta.toString(),
          inventoryDelta: deltas.inventoryDelta.toString(),
          affectedRefundSnapshots,
          affectedShipments,
          affectedSalesOrderLines,
          ...(floor && layerUnabsorbedBase
            ? {
              unflooredGrossUnitCostBase: floor.unflooredGrossUnitCostBase.toString(),
              unabsorbedBase: layerUnabsorbedBase.toString(),
            }
            : {}),
        })
      }
      if (floor && lineUnabsorbedBase.gt(0)) {
        floorFootprint.entries.push({
          label: `PO line ${line.id}`,
          unabsorbedBase: lineUnabsorbedBase,
          unflooredGrossUnitCostBase: floor.unflooredGrossUnitCostBase,
        })
      }
      afterLines.push({
        lineId: line.id,
        qty: lineQty.toString(),
        unitCostBase: baseUnitCostBase.toString(),
        landedAmountBase: landedForLine.toString(),
        grossUnitCostBase: grossUnitCostBase.toString(),
        costLayers: afterLayers,
      })
    }

    if (floorFootprint.entries.length > 0 && !floorFootprint.activityDue) {
      // The layer cost did not change; a changed RESIDUE still deserves a new entry.
      const residueNow = floorFootprint.entries.reduce((sum, entry) => sum.add(entry.unabsorbedBase), new Prisma.Decimal(0))
      if (!(await previousFloorResidue(tx, primaryPoId)).eq(residueNow)) floorFootprint.activityDue = true
    }
    recordFlooredLandedCredit(
      result, runWarnings, primaryPoId, `recalculateLandedCosts:${primaryPo.reference}`, floorFootprint,
    )
    result.revalidatePoIds.push(primaryPoId)
    const eventKey = landedCostAdjustmentEventKey(primaryPoId, adjustmentLayers, recalcRunId)

    if (totalCogsDelta.abs().gt(LANDED_COST_JOURNAL_EPSILON)) {
      result.cogsAdjustments.push({
        primaryPoId,
        primaryPoRef: primaryPo.reference,
        freightPoId,
        eventKey,
        totalDelta: roundAdjustmentTotalDelta(totalCogsDelta),
      })
    }
    if (totalInventoryDelta.abs().gt(LANDED_COST_JOURNAL_EPSILON)) {
      result.inventoryTransitAdjustments.push({
        primaryPoId,
        primaryPoRef: primaryPo.reference,
        freightPoId,
        eventKey,
        totalDelta: roundAdjustmentTotalDelta(totalInventoryDelta),
      })
    }

    // audit-C3: when this recalc reverts a cancelled freight PO's uplift, its
    // cost is no longer applied to the primary — mark the link unallocated.
    const linkAllocated = options.reason !== 'freight_purchase_order_cancelled'
    await tx.landedCostLink.updateMany({
      where: { primaryPoId, freightPoId },
      data: { allocated: linkAllocated },
    })

    // Audit row writes inside the transaction so an audit failure aborts the
    // recalc. Trade-off: schema bugs here break the operation; benefit:
    // every committed landed-cost change has a matching audit row.
    const auditRun = await tx.landedCostRevaluationRun.create({
      data: {
        freightPoId,
        primaryPoId,
        triggeredById: options.triggeredById ?? null,
        status: 'COMPLETED',
        reason: options.reason ?? 'linked_freight_recalculation',
        beforeJson: toJsonInputValue(beforeJson),
        afterJson: toJsonInputValue({
          purchaseOrder: { id: primaryPo.id, reference: primaryPo.reference },
          lines: afterLines,
          propagatedOutputLayers,
          inTransitResidue,
        }),
        accountingJson: toJsonInputValue(revaluationAccountingJson({
          primaryPoId,
          inventoryTransitAdjustments: result.inventoryTransitAdjustments,
          cogsAdjustments: result.cogsAdjustments,
        })),
        warningsJson: toJsonInputValue(runWarnings),
      },
      select: { id: true },
    })
    result.auditRunIds.push(auditRun.id)
  }
  // audit-grob: durably enqueue the adjustment journals IN this tx (backstop).
  if (options.scheduleAdjustmentJournals) {
    await scheduleLandedCostJournalOutbox(tx, result)
  }
  return result
}

/**
 * Recalculate landed costs for a GOODS PO that has its own direct
 * additional costs (FreightCostLine rows on the PO itself, no
 * LandedCostLink). Same logic as recalculateLandedCosts but operates
 * on the PO's own cost lines instead of looking up linked freight POs.
 */
export async function recalculateDirectLandedCosts(
  tx: Prisma.TransactionClient,
  poId: string,
  deps: LandedCostServiceDeps | undefined,
  options: LandedCostRevaluationOptions,
): Promise<LandedCostRecalcResult> {
  const serviceDeps = deps ?? defaultDeps
  const result = emptyRecalcResult()
  // audit-g4la: one nonce per recalc run, stamped onto every adjustment's eventKey.
  const recalcRunId = randomUUID()
  // One effective timestamp per recalc run for the revaluation event log (blq0).
  const revaluedAt = new Date()
  const po = await tx.purchaseOrder.findUnique({
    where: { id: poId },
    select: {
      id: true,
      reference: true,
      status: true,
      subtotalBase: true,
      lines: {
        // o3d-c08y r2: ORDERED, because the walk order is observable. The refusal below fires on the
        // FIRST layer whose revaluation would take a journaled shipment negative, so on a PO whose
        // lines net out (layer A to -6, layer B to +11, total +5) whether it refuses depends on which
        // line is reached first — and an unordered Prisma read makes that Postgres' choice, so the same
        // edit could be accepted on one run and refused on the next. Refusing is the conservative
        // outcome either way (the per-layer COGS_REVERSAL for A would have had a negative side), but it
        // must be REPRODUCIBLE. `sortOrder` is the order the operator sees on the PO; `id` breaks ties.
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          qty: true,
          unitCostBase: true,
          landedUnitCostBase: true,
          totalBase: true,
          product: { select: { weight: true } },
          costLayers: {
            // FIFO order, for the same reason, with `id` breaking ties on a shared receivedAt.
            orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
            select: {
              id: true,
              unitCostBase: true,
              receivedQty: true,
              remainingQty: true,
            },
          },
        },
      },
      freightCostLines: {
        select: { id: true, amountBase: true, distributionMethod: true },
      },
      landedCostLinks: {
        // audit-izrf: a CANCELLED freight PO must no longer contribute landed
        // cost, mirroring the linked-freight recalc path (recalculateLandedCosts).
        // Shared predicate since o3d-6nd55 r2 — see CONTRIBUTING_LANDED_COST_LINK_WHERE.
        where: { ...CONTRIBUTING_LANDED_COST_LINK_WHERE },
        select: {
          freightPO: {
            select: {
              id: true,
              reference: true,
              freightCostLines: {
                select: { id: true, amountBase: true, distributionMethod: true },
              },
            },
          },
        },
      },
    },
  })
  if (!po) return result
  // o3d-c08y: what a refusal names as the thing to correct.
  const revaluationContext: ShipmentRevaluationContext = {
    source: 'direct_landed_cost_recalc',
    operation: 'save',
    primaryPoId: po.id,
    primaryPoReference: po.reference,
    creditCostLines: creditCostLinesOf([
      ...po.freightCostLines.map((line) => ({ line, poId: po.id, poReference: po.reference })),
      ...po.landedCostLinks.flatMap((link) => link.freightPO.freightCostLines.map((line) => ({
        line,
        poId: link.freightPO.id,
        poReference: link.freightPO.reference,
      }))),
    ]),
  }
  if (po.status === 'CLOSED') {
    throw new Error(`Cannot recalculate landed costs for ${poId}: purchase order is in a locked status`)
  }
  const beforeJson = revaluationBeforeJson(po)

  // THE ONE ALLOCATION (landed-cost-allocation.ts), shared with recalculateLandedCosts and every
  // receipt-side writer. Source rank 0 = this PO's own cost lines, 1 = its linked freight POs'.
  const runWarnings: LandedCostRevaluationWarning[] = []
  const allocation = allocateLandedCost(
    po.lines.map((line) => ({
      id: line.id,
      qty: line.qty,
      unitCostBase: line.unitCostBase,
      totalBase: line.totalBase,
      weight: line.product?.weight ?? null,
    })),
    [
      ...po.freightCostLines.map((costLine) => ({ ...costLine, sourceRank: 0 as const })),
      ...po.landedCostLinks.flatMap((link) => link.freightPO.freightCostLines.map((costLine) => ({ ...costLine, sourceRank: 1 as const }))),
    ],
  )
  captureAllocationEvents(allocation.events, result, runWarnings, serviceDeps, `recalculateDirectLandedCosts:${po.reference}`)
  const floorByLine = new Map(allocation.floors.map((floor) => [floor.lineId, floor]))
  const floorFootprint: FloorFootprint = { entries: [], activityDue: false }

  let totalCogsDelta = new Prisma.Decimal(0)
  let totalInventoryDelta = new Prisma.Decimal(0)
  const adjustmentLayers: LandedCostAdjustmentLayerContext[] = []
  // audit-e7h8: itemised record of the BOM-cascade so the journal total (which
  // includes propagated output-layer deltas) is substantiated in the audit run.
  const propagatedOutputLayers: PropagatedOutputLayerAudit[] = []
  // o3d-nrl4 PR B: every in-transit residue line this run capitalised (root layers and propagated outputs),
  // itemised so the journal total is substantiated in the audit run. A new JSON key, no schema change.
  const inTransitResidue: InTransitResidueEntry[] = []
  const afterLines: AfterLineAudit[] = []

  for (const line of po.lines) {
    const lineQty = decimal(line.qty)
    if (lineQty.lte(0)) continue

    const baseUnitCostBase = decimal(line.unitCostBase)
    const landedForLine = decimal(allocation.landedAmountByLine.get(line.id))
    const grossUnitCostBase = allocation.grossUnitCostBaseByLine.get(line.id)!
    const floor = floorByLine.get(line.id)
    let lineUnabsorbedBase = new Prisma.Decimal(0)
    const afterLayers: AfterLayerAudit[] = []

    await tx.purchaseOrderLine.update({
      where: { id: line.id },
      data: { landedUnitCostBase: grossUnitCostBase },
    })

    for (const cl of line.costLayers) {
      const oldUnitCost = decimal(cl.unitCostBase)
      const newUnitCost = grossUnitCostBase
      const receivedQty = decimal(cl.receivedQty)
      const remainingQty = decimal(cl.remainingQty)
      const consumedQty = receivedQty.sub(remainingQty)
      const exclusions = await loadLayerConsumptionExclusions(tx, serviceDeps, cl.id, consumedQty)
      const { returnedQty, supplierReturnedQty, manufacturingConsumedQty } = exclusions
      const deltas = calculateLayerAdjustmentDeltas({
        oldUnitCost,
        newUnitCost,
        receivedQty,
        remainingQty,
        ...exclusions,
      })
      // o3d-nrl4 PR B (site 2 of 3): the units of this layer still in transit post their own share.
      const residue = await capitaliseInTransitResidue(tx, serviceDeps, cl.id, deltas.costDelta, consumedQty)
      inTransitResidue.push(...residue.entries)
      totalCogsDelta = totalCogsDelta.add(deltas.cogsDelta)
      totalInventoryDelta = totalInventoryDelta.add(deltas.inventoryDelta).add(residue.delta)
      if (
        deltas.cogsDelta.abs().gt(LANDED_COST_DELTA_EPSILON)
        || deltas.inventoryDelta.abs().gt(LANDED_COST_DELTA_EPSILON)
        || residue.delta.abs().gt(LANDED_COST_DELTA_EPSILON)
      ) {
        adjustmentLayers.push({
          costLayerId: cl.id,
          oldUnitCost,
          newUnitCost,
          receivedQty,
          remainingQty,
          returnedQty,
          supplierReturnedQty,
          manufacturingConsumedQty,
        })
      }
      await tx.costLayer.update({
        where: { id: cl.id },
        data: { unitCostBase: grossUnitCostBase },
      })
      await serviceDeps.recordCostLayerRevaluation(tx, {
        costLayerId: cl.id,
        oldUnitCostBase: oldUnitCost,
        newUnitCostBase: newUnitCost,
        effectiveAt: revaluedAt,
        reason: 'landed_cost_recalc',
      })

      // audit-e7h8: cascade the delta into produced output layers (the
      // manufacturing-consumed portion was excluded from this layer's COGS).
      await propagateLandedCostToOutputs(
        tx, serviceDeps, cl.id, deltas.costDelta,
        (cogsD, invD, audit) => {
          totalCogsDelta = totalCogsDelta.add(cogsD)
          totalInventoryDelta = totalInventoryDelta.add(invD)
          inTransitResidue.push(...audit.inTransitResidue)
          propagatedOutputLayers.push({ ...audit, cogsDelta: cogsD.toString(), inventoryDelta: invD.toString() })
        },
        new Set(), 1, recalcRunId, revaluedAt, revaluationContext,
      )

      let affectedRefundSnapshots = 0
      let affectedShipments = 0
      let affectedSalesOrderLines = 0
      if (deltas.costDelta.abs().gt(LANDED_COST_DELTA_EPSILON)) {
        affectedRefundSnapshots = await serviceDeps.updateSnapshotsForCostLayerChange(tx, cl.id, grossUnitCostBase)
        const shipmentRefresh = await serviceDeps.refreshShipmentCogsForCostLayerChange(tx, cl.id, { recalcRunId, revaluationContext })
        affectedShipments = shipmentRefresh.shipmentsUpdated
        // audit-3aph: shipment path owns the sold-goods COGS revaluation — remove
        // it from the COGS_JOURNAL to avoid double-posting COGS for sold units.
        totalCogsDelta = totalCogsDelta.sub(shipmentRefresh.cogsRevaluationDelta)
        affectedSalesOrderLines = await serviceDeps.refreshSalesOrderLineCogsForCostLayerChange(tx, cl.id)
      }
      // The zero floor's footprint on this layer (units the floor could not absorb), exact Decimal.
      const layerUnabsorbedBase = floor ? unabsorbedBaseForQty(floor.unflooredGrossUnitCostBase, receivedQty) : null
      if (floor && layerUnabsorbedBase) {
        lineUnabsorbedBase = lineUnabsorbedBase.add(layerUnabsorbedBase)
        if (!oldUnitCost.eq(newUnitCost)) floorFootprint.activityDue = true
      }
      afterLayers.push({
        costLayerId: cl.id,
        oldUnitCostBase: oldUnitCost.toString(),
        newUnitCostBase: newUnitCost.toString(),
        receivedQty: receivedQty.toString(),
        remainingQty: remainingQty.toString(),
        consumedQty: consumedQty.toString(),
        returnedQty: returnedQty.toString(),
        supplierReturnedQty: supplierReturnedQty.toString(),
        manufacturingConsumedQty: manufacturingConsumedQty.toString(),
        cogsDelta: deltas.cogsDelta.toString(),
        inventoryDelta: deltas.inventoryDelta.toString(),
        affectedRefundSnapshots,
        affectedShipments,
        affectedSalesOrderLines,
        ...(floor && layerUnabsorbedBase
          ? {
            unflooredGrossUnitCostBase: floor.unflooredGrossUnitCostBase.toString(),
            unabsorbedBase: layerUnabsorbedBase.toString(),
          }
          : {}),
      })
    }
    if (floor && lineUnabsorbedBase.gt(0)) {
      floorFootprint.entries.push({
        label: `PO line ${line.id}`,
        unabsorbedBase: lineUnabsorbedBase,
        unflooredGrossUnitCostBase: floor.unflooredGrossUnitCostBase,
      })
    }
    afterLines.push({
      lineId: line.id,
      qty: lineQty.toString(),
      unitCostBase: baseUnitCostBase.toString(),
      landedAmountBase: landedForLine.toString(),
      grossUnitCostBase: grossUnitCostBase.toString(),
      costLayers: afterLayers,
    })
  }

  if (floorFootprint.entries.length > 0 && !floorFootprint.activityDue) {
    const residueNow = floorFootprint.entries.reduce((sum, entry) => sum.add(entry.unabsorbedBase), new Prisma.Decimal(0))
    if (!(await previousFloorResidue(tx, poId)).eq(residueNow)) floorFootprint.activityDue = true
  }
  recordFlooredLandedCredit(result, runWarnings, poId, `recalculateDirectLandedCosts:${po.reference}`, floorFootprint)
  result.revalidatePoIds.push(poId)
  const eventKey = landedCostAdjustmentEventKey(poId, adjustmentLayers, recalcRunId)
  if (totalInventoryDelta.abs().gt(LANDED_COST_JOURNAL_EPSILON)) {
    result.inventoryTransitAdjustments.push({
      primaryPoId: poId,
      primaryPoRef: po.reference,
      freightPoId: null,
      eventKey,
      totalDelta: roundAdjustmentTotalDelta(totalInventoryDelta),
    })
  }
  if (totalCogsDelta.abs().gt(LANDED_COST_JOURNAL_EPSILON)) {
    result.cogsAdjustments.push({
      primaryPoId: poId,
      primaryPoRef: po.reference,
      freightPoId: null,
      eventKey,
      totalDelta: roundAdjustmentTotalDelta(totalCogsDelta),
    })
  }
  // Audit row writes inside the transaction so an audit failure aborts the
  // recalc. Trade-off: schema bugs here break the operation; benefit:
  // every committed landed-cost change has a matching audit row.
  const auditRun = await tx.landedCostRevaluationRun.create({
    data: {
      freightPoId: null,
      primaryPoId: poId,
      triggeredById: options.triggeredById ?? null,
      status: 'COMPLETED',
      reason: options.reason ?? 'direct_landed_cost_recalculation',
      beforeJson: toJsonInputValue(beforeJson),
      afterJson: toJsonInputValue({
        purchaseOrder: { id: po.id, reference: po.reference },
        lines: afterLines,
        propagatedOutputLayers,
        inTransitResidue,
      }),
      accountingJson: toJsonInputValue(revaluationAccountingJson({
        primaryPoId: poId,
        inventoryTransitAdjustments: result.inventoryTransitAdjustments,
        cogsAdjustments: result.cogsAdjustments,
      })),
      warningsJson: toJsonInputValue(runWarnings),
    },
    select: { id: true },
  })
  result.auditRunIds.push(auditRun.id)
  // audit-grob: durably enqueue the adjustment journals IN this tx (backstop).
  if (options.scheduleAdjustmentJournals) {
    await scheduleLandedCostJournalOutbox(tx, result)
  }
  return result
}
