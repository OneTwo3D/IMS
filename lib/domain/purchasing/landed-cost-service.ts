import { randomUUID } from 'node:crypto'
import { Prisma } from '@/app/generated/prisma/client'
import { getAccountingSettings, queueAccountingSync, type AccountingSettings } from '@/lib/accounting'
import { accountingPayloadKey } from '@/lib/accounting/payload-key'
import { logActivity } from '@/lib/activity-log'
import {
  getDependentOutputSourceLines,
  getManufacturingConsumedQtyForCostLayer,
  getReturnedQtyForCostLayer,
  getReversalConsumedQtyForCostLayer,
  getSupplierReturnedQtyForCostLayer,
  recordCostLayerRevaluation,
  refreshSalesOrderLineCogsForCostLayerChange,
  refreshShipmentCogsForCostLayerChange,
  updateSnapshotsForCostLayerChange,
} from '@/lib/cost-layers'
import { toJsonInputValue } from '@/lib/db/json-input'
import { scheduleLandedCostJournalOutbox } from './landed-cost-journal-outbox'

export const LANDED_COST_DISTRIBUTION_METHODS = [
  'BY_VALUE',
  'BY_QUANTITY',
  'BY_WEIGHT',
  'EQUAL_SPLIT',
] as const

export type LandedCostDistributionMethod = typeof LANDED_COST_DISTRIBUTION_METHODS[number]

export type PendingGrossCostLine = {
  id: string
  qty: Prisma.Decimal | number | string
  unitCostBase: Prisma.Decimal | number | string
  totalBase: Prisma.Decimal | number | string
  landedUnitCostBase?: Prisma.Decimal | number | string | null
  weight?: Prisma.Decimal | number | string | null
}

export type PendingGrossCostLineSource = {
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
}

export type LandedCostRevaluationWarning = {
  code: 'weight_fallback' | 'weight_zero_line'
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

type DistributionLine = {
  qty: Prisma.Decimal
  totalBase: Prisma.Decimal
  product: { weight: Prisma.Decimal | null }
}

type CostLayerAdjustmentInput = {
  oldUnitCost: Prisma.Decimal | number | string
  newUnitCost: Prisma.Decimal | number | string
  receivedQty: Prisma.Decimal | number | string
  remainingQty: Prisma.Decimal | number | string
  returnedQty: Prisma.Decimal | number | string
  supplierReturnedQty: Prisma.Decimal | number | string
  manufacturingConsumedQty: Prisma.Decimal | number | string
  reversalConsumedQty?: Prisma.Decimal | number | string
}

type PropagatedOutputLayerAudit = {
  sourceCostLayerId: string
  outputCostLayerId: string
  oldUnitCostBase: string
  newUnitCostBase: string
  consumedQty: string
  cogsDelta: string
  inventoryDelta: string
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
  }
}

export function normalizeLandedCostMethod(
  method: string | null | undefined,
): LandedCostDistributionMethod {
  return LANDED_COST_DISTRIBUTION_METHODS.includes(method as LandedCostDistributionMethod)
    ? method as LandedCostDistributionMethod
    : 'BY_VALUE'
}

export function computeDistributionBase(
  line: DistributionLine,
  method: LandedCostDistributionMethod,
): Prisma.Decimal {
  switch (method) {
    case 'BY_WEIGHT':
      return decimal(line.product.weight).mul(line.qty)
    case 'BY_QUANTITY':
      return decimal(line.qty)
    case 'EQUAL_SPLIT':
      return new Prisma.Decimal(1)
    case 'BY_VALUE':
    default:
      return decimal(line.totalBase)
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
      .sub(decimal(input.reversalConsumedQty ?? 0)),
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

// BOM nesting is shallow in practice; this is a runaway/cycle backstop only.
const MAX_LANDED_COST_PROPAGATION_DEPTH = 20

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
    audit: { sourceCostLayerId: string; outputCostLayerId: string; oldUnitCostBase: string; newUnitCostBase: string; consumedQty: string },
  ) => void,
  ancestors: Set<string>,
  depth: number,
  recalcRunId: string,
  revaluedAt: Date,
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

    const returnedQty = decimal(await deps.getReturnedQtyForCostLayer(tx, outputCostLayerId))
    const supplierReturnedQty = decimal(await deps.getSupplierReturnedQtyForCostLayer(tx, outputCostLayerId))
    const manufacturingConsumedQty = decimal(await deps.getManufacturingConsumedQtyForCostLayer(tx, outputCostLayerId))
    const reversalConsumedQty = decimal(await deps.getReversalConsumedQtyForCostLayer(tx, outputCostLayerId))
    const outDeltas = calculateLayerAdjustmentDeltas({
      oldUnitCost: oldOutputUnitCost,
      newUnitCost: newOutputUnitCost,
      receivedQty: outputReceivedQty,
      remainingQty: decimal(output.remainingQty),
      returnedQty,
      supplierReturnedQty,
      manufacturingConsumedQty,
      reversalConsumedQty,
    })
    // Reflect the new output cost in finished goods already sold from this layer,
    // FIRST, so its COGS revaluation can be removed from the cascade's COGS
    // delta (audit-3aph): the shipment path owns the sold-finished-good COGS, so
    // counting it here too would double-post COGS for the same units.
    let outputShipmentRevalDelta = new Prisma.Decimal(0)
    if (outDeltas.costDelta.abs().gt(LANDED_COST_DELTA_EPSILON)) {
      await deps.updateSnapshotsForCostLayerChange(tx, outputCostLayerId, newOutputUnitCost)
      const shipmentRefresh = await deps.refreshShipmentCogsForCostLayerChange(tx, outputCostLayerId, { recalcRunId })
      outputShipmentRevalDelta = shipmentRefresh.cogsRevaluationDelta
      await deps.refreshSalesOrderLineCogsForCostLayerChange(tx, outputCostLayerId)
    }
    accumulate(outDeltas.cogsDelta.sub(outputShipmentRevalDelta), outDeltas.inventoryDelta, {
      sourceCostLayerId,
      outputCostLayerId,
      oldUnitCostBase: oldOutputUnitCost.toString(),
      newUnitCostBase: newOutputUnitCost.toString(),
      consumedQty: consumedQty.toString(),
    })

    // Cascade into outputs that consumed THIS output (nested BOM levels).
    await propagateLandedCostToOutputs(tx, deps, outputCostLayerId, outputUnitDelta, accumulate, nextAncestors, depth + 1, recalcRunId, revaluedAt)
  }
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
 * Positive-quantity lines that contributed zero weight to a BY_WEIGHT split
 * (weight 0/null) and therefore received no freight while other lines absorbed
 * it. Only meaningful on the non-fallback path (basisTotal > 0); the all-zero
 * case is already reported by the weight-fallback warning (scjz.17).
 */
function zeroWeightEligibleLineIds(
  method: LandedCostDistributionMethod,
  bases: Array<{ lineId: string; base: Prisma.Decimal }>,
): string[] {
  if (method !== 'BY_WEIGHT') return []
  return bases.filter((entry) => entry.base.lte(0)).map((entry) => entry.lineId)
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

export function computeGrossUnitCostBaseByLine(params: {
  lines: PendingGrossCostLine[]
  directCostLines?: PendingGrossCostLineSource[]
  linkedCostLines?: PendingGrossCostLineSource[]
  onWeightZeroLines?: (lineIds: string[]) => void
}): Map<string, number> {
  const eligibleLines = params.lines.filter((line) => decimal(line.qty).gt(0))
  const landedByLine = new Map<string, Prisma.Decimal>()
  for (const line of eligibleLines) {
    landedByLine.set(line.id, new Prisma.Decimal(0))
  }

  const allCostLines = [
    ...(params.directCostLines ?? []),
    ...(params.linkedCostLines ?? []),
  ]

  for (const costLine of allCostLines) {
    const amountBase = decimal(costLine.amountBase)
    if (amountBase.lte(0)) continue
    const method = normalizeLandedCostMethod(costLine.distributionMethod)
    const bases = eligibleLines.map((line) => ({
      lineId: line.id,
      base: computeDistributionBase(
        {
          qty: decimal(line.qty),
          totalBase: decimal(line.totalBase),
          product: { weight: decimal(line.weight) },
        },
        method,
      ),
    }))
    let basisTotal = bases.reduce((sum, entry) => sum.add(entry.base), new Prisma.Decimal(0))
    if (basisTotal.lte(0)) {
      if (method === 'BY_WEIGHT') warnWeightFallback('computeGrossUnitCostBaseByLine')
      basisTotal = new Prisma.Decimal(eligibleLines.length || 1)
      for (const entry of bases) entry.base = new Prisma.Decimal(1)
    } else if (params.onWeightZeroLines) {
      // Opt-in only: this helper also runs on read-only cost previews
      // (getPurchaseOrder, receipt validation), so it must not persist a warning
      // by default. The recalc paths surface the diagnostic via result.warnings.
      const zeroWeightLineIds = zeroWeightEligibleLineIds(method, bases)
      if (zeroWeightLineIds.length > 0) params.onWeightZeroLines(zeroWeightLineIds)
    }
    for (const entry of bases) {
      const share = amountBase.mul(entry.base).div(basisTotal)
      landedByLine.set(entry.lineId, decimal(landedByLine.get(entry.lineId)).add(share))
    }
  }

  const grossByLine = new Map<string, number>()
  for (const line of params.lines) {
    if (decimal(line.qty).lte(0)) {
      grossByLine.set(line.id, decimal(line.unitCostBase).toNumber())
      continue
    }
    grossByLine.set(
      line.id,
      decimal(line.unitCostBase)
        .add(decimal(landedByLine.get(line.id)).div(decimal(line.qty)))
        .toDecimalPlaces(6, Prisma.Decimal.ROUND_HALF_UP)
        .toNumber(),
    )
  }

  return grossByLine
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

export async function queueLandedCostAdjustmentJournals(
  adjustments: LandedCostRecalcResult,
): Promise<void> {
  const settings = await getAccountingSettings()

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
    await queueAccountingSync({
      type: 'STOCK_IN_TRANSIT',
      referenceType: 'PurchaseOrder',
      referenceId: adj.primaryPoId,
      payload,
      idempotencyKey: landedCostAdjustmentIdempotencyKey('inventory', adj),
    })
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
    await queueAccountingSync({
      type: 'COGS_JOURNAL',
      referenceType: 'PurchaseOrder',
      referenceId: adj.primaryPoId,
      payload,
      idempotencyKey: landedCostAdjustmentIdempotencyKey('cogs', adj),
    })
  }
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
          select: {
            id: true,
            qty: true,
            unitCostBase: true,
            landedUnitCostBase: true,
            totalBase: true,
            product: { select: { weight: true } },
            costLayers: {
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
          select: { amountBase: true, distributionMethod: true },
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
      // excluding it here is what lets cancellation revert the uplift it applied.
      where: { primaryPoId, freightPO: { status: { not: 'CANCELLED' } } },
      select: {
        freightPO: {
          select: {
            freightCostLines: {
              select: { amountBase: true, distributionMethod: true },
            },
          },
        },
      },
    })
    const landedByLine = new Map<string, Prisma.Decimal>()
    for (const line of primaryPo.lines) {
      landedByLine.set(line.id, new Prisma.Decimal(0))
    }

    const eligibleLines = primaryPo.lines.filter((line) => decimal(line.qty).gt(0))
    const runWarnings: LandedCostRevaluationWarning[] = []
    for (const freightCostLine of primaryPo.freightCostLines) {
      const method = normalizeLandedCostMethod(freightCostLine.distributionMethod)
      const bases = eligibleLines.map((line) => ({
        lineId: line.id,
        base: computeDistributionBase(line, method),
      }))
      let basisTotal = bases.reduce((sum, entry) => sum.add(entry.base), new Prisma.Decimal(0))

      if (basisTotal.lte(0)) {
        if (method === 'BY_WEIGHT') captureWeightFallback(
          result,
          runWarnings,
          serviceDeps,
          `recalculateLandedCosts:${primaryPo.reference}`,
        )
        const equalBase = new Prisma.Decimal(eligibleLines.length || 1)
        basisTotal = equalBase
        for (const entry of bases) entry.base = new Prisma.Decimal(1)
      } else if (decimal(freightCostLine.amountBase).gt(0)) {
        // Only warn when positive freight was actually distributed away from the
        // zero-weight line; a zero/credit cost line assigns nothing (scjz.17).
        captureWeightZeroLines(
          result,
          runWarnings,
          serviceDeps,
          `recalculateLandedCosts:${primaryPo.reference}`,
          zeroWeightEligibleLineIds(method, bases),
        )
      }

      const amountBase = decimal(freightCostLine.amountBase)
      for (const entry of bases) {
        const share = amountBase.mul(entry.base).div(basisTotal)
        landedByLine.set(entry.lineId, decimal(landedByLine.get(entry.lineId)).add(share))
      }
    }

    for (const linkRow of allLinks) {
      for (const freightCostLine of linkRow.freightPO.freightCostLines) {
        const method = normalizeLandedCostMethod(freightCostLine.distributionMethod)
        const bases = eligibleLines.map((line) => ({
          lineId: line.id,
          base: computeDistributionBase(line, method),
        }))
        let basisTotal = bases.reduce((sum, entry) => sum.add(entry.base), new Prisma.Decimal(0))

        if (basisTotal.lte(0)) {
          if (method === 'BY_WEIGHT') captureWeightFallback(
            result,
            runWarnings,
            serviceDeps,
            `recalculateLandedCosts:${primaryPo.reference}:linked`,
          )
          const equalBase = new Prisma.Decimal(eligibleLines.length || 1)
          basisTotal = equalBase
          for (const entry of bases) entry.base = new Prisma.Decimal(1)
        } else if (decimal(freightCostLine.amountBase).gt(0)) {
          captureWeightZeroLines(
            result,
            runWarnings,
            serviceDeps,
            `recalculateLandedCosts:${primaryPo.reference}:linked`,
            zeroWeightEligibleLineIds(method, bases),
          )
        }

        const amountBase = decimal(freightCostLine.amountBase)
        for (const entry of bases) {
          const share = amountBase.mul(entry.base).div(basisTotal)
          landedByLine.set(entry.lineId, decimal(landedByLine.get(entry.lineId)).add(share))
        }
      }
    }

    let totalCogsDelta = new Prisma.Decimal(0)
    let totalInventoryDelta = new Prisma.Decimal(0)
    const adjustmentLayers: LandedCostAdjustmentLayerContext[] = []
    // audit-e7h8: itemised record of the BOM-cascade so the journal total (which
    // includes propagated output-layer deltas) is substantiated in the audit run.
    const propagatedOutputLayers: PropagatedOutputLayerAudit[] = []
    const afterLines: Array<{
      lineId: string
      qty: string
      unitCostBase: string
      landedAmountBase: string
      grossUnitCostBase: string
      costLayers: Array<{
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
      }>
    }> = []

    for (const line of primaryPo.lines) {
      const lineQty = decimal(line.qty)
      if (lineQty.lte(0)) continue

      const baseUnitCostBase = decimal(line.unitCostBase)
      const landedForLine = decimal(landedByLine.get(line.id))
      const landedPerUnit = landedForLine.div(lineQty)
      const grossUnitCostBase = baseUnitCostBase.add(landedPerUnit).toDecimalPlaces(6, Prisma.Decimal.ROUND_HALF_UP)
      const afterLayers: Array<{
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
      }> = []

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
        const returnedQty = consumedQty.gt(LANDED_COST_DELTA_EPSILON)
          ? decimal(await serviceDeps.getReturnedQtyForCostLayer(tx, cl.id))
          : new Prisma.Decimal(0)
        const supplierReturnedQty = consumedQty.gt(LANDED_COST_DELTA_EPSILON)
          ? decimal(await serviceDeps.getSupplierReturnedQtyForCostLayer(tx, cl.id))
          : new Prisma.Decimal(0)
        const manufacturingConsumedQty = consumedQty.gt(LANDED_COST_DELTA_EPSILON)
          ? decimal(await serviceDeps.getManufacturingConsumedQtyForCostLayer(tx, cl.id))
          : new Prisma.Decimal(0)
        const reversalConsumedQty = consumedQty.gt(LANDED_COST_DELTA_EPSILON)
          ? decimal(await serviceDeps.getReversalConsumedQtyForCostLayer(tx, cl.id))
          : new Prisma.Decimal(0)
        const deltas = calculateLayerAdjustmentDeltas({
          oldUnitCost,
          newUnitCost,
          receivedQty,
          remainingQty,
          returnedQty,
          supplierReturnedQty,
          manufacturingConsumedQty,
          reversalConsumedQty,
        })
        totalCogsDelta = totalCogsDelta.add(deltas.cogsDelta)
        totalInventoryDelta = totalInventoryDelta.add(deltas.inventoryDelta)
        if (deltas.cogsDelta.abs().gt(LANDED_COST_DELTA_EPSILON) || deltas.inventoryDelta.abs().gt(LANDED_COST_DELTA_EPSILON)) {
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
            propagatedOutputLayers.push({ ...audit, cogsDelta: cogsD.toString(), inventoryDelta: invD.toString() })
          },
          new Set(), 1, recalcRunId, revaluedAt,
        )

        let affectedRefundSnapshots = 0
        let affectedShipments = 0
        let affectedSalesOrderLines = 0
        if (deltas.costDelta.abs().gt(LANDED_COST_DELTA_EPSILON)) {
          affectedRefundSnapshots = await serviceDeps.updateSnapshotsForCostLayerChange(tx, cl.id, grossUnitCostBase)
          const shipmentRefresh = await serviceDeps.refreshShipmentCogsForCostLayerChange(tx, cl.id, { recalcRunId })
          affectedShipments = shipmentRefresh.shipmentsUpdated
          // audit-3aph: the shipment path now owns the COGS revaluation for sold
          // goods (COGS_REVERSAL now / daily batch later), so remove it from the
          // COGS_JOURNAL to avoid debiting COGS twice for the same sold units.
          totalCogsDelta = totalCogsDelta.sub(shipmentRefresh.cogsRevaluationDelta)
          affectedSalesOrderLines = await serviceDeps.refreshSalesOrderLineCogsForCostLayerChange(tx, cl.id)
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
        select: {
          id: true,
          qty: true,
          unitCostBase: true,
          landedUnitCostBase: true,
          totalBase: true,
          product: { select: { weight: true } },
          costLayers: {
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
        select: { amountBase: true, distributionMethod: true },
      },
      landedCostLinks: {
        // audit-izrf: a CANCELLED freight PO must no longer contribute landed
        // cost, mirroring the linked-freight recalc path (recalculateLandedCosts).
        where: { freightPO: { status: { not: 'CANCELLED' } } },
        select: {
          freightPO: {
            select: {
              freightCostLines: {
                select: { amountBase: true, distributionMethod: true },
              },
            },
          },
        },
      },
    },
  })
  if (!po) return result
  if (po.status === 'CLOSED') {
    throw new Error(`Cannot recalculate landed costs for ${poId}: purchase order is in a locked status`)
  }
  const beforeJson = revaluationBeforeJson(po)

  const landedByLine = new Map<string, Prisma.Decimal>()
  for (const line of po.lines) {
    landedByLine.set(line.id, new Prisma.Decimal(0))
  }

  const eligibleLines = po.lines.filter((line) => decimal(line.qty).gt(0))
  const freightCostLines = [
    ...po.freightCostLines.map((freightCostLine) => ({
      freightCostLine,
      warningContext: `recalculateDirectLandedCosts:${po.reference}`,
    })),
    ...po.landedCostLinks.flatMap((link) => link.freightPO.freightCostLines.map((freightCostLine) => ({
      freightCostLine,
      warningContext: `recalculateDirectLandedCosts:${po.reference}:linked`,
    }))),
  ]
  const runWarnings: LandedCostRevaluationWarning[] = []
  for (const { freightCostLine, warningContext } of freightCostLines) {
    const method = normalizeLandedCostMethod(freightCostLine.distributionMethod)
    const bases = eligibleLines.map((line) => ({
      lineId: line.id,
      base: computeDistributionBase(line, method),
    }))
    let basisTotal = bases.reduce((sum, entry) => sum.add(entry.base), new Prisma.Decimal(0))
    if (basisTotal.lte(0)) {
      if (method === 'BY_WEIGHT') captureWeightFallback(
        result,
        runWarnings,
        serviceDeps,
        warningContext,
      )
      basisTotal = new Prisma.Decimal(eligibleLines.length || 1)
      for (const entry of bases) entry.base = new Prisma.Decimal(1)
    } else if (decimal(freightCostLine.amountBase).gt(0)) {
      captureWeightZeroLines(result, runWarnings, serviceDeps, warningContext, zeroWeightEligibleLineIds(method, bases))
    }
    const amountBase = decimal(freightCostLine.amountBase)
    for (const entry of bases) {
      const share = amountBase.mul(entry.base).div(basisTotal)
      landedByLine.set(entry.lineId, decimal(landedByLine.get(entry.lineId)).add(share))
    }
  }

  let totalCogsDelta = new Prisma.Decimal(0)
  let totalInventoryDelta = new Prisma.Decimal(0)
  const adjustmentLayers: LandedCostAdjustmentLayerContext[] = []
  // audit-e7h8: itemised record of the BOM-cascade so the journal total (which
  // includes propagated output-layer deltas) is substantiated in the audit run.
  const propagatedOutputLayers: PropagatedOutputLayerAudit[] = []
  const afterLines: Array<{
    lineId: string
    qty: string
    unitCostBase: string
    landedAmountBase: string
    grossUnitCostBase: string
    costLayers: Array<{
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
    }>
  }> = []

  for (const line of po.lines) {
    const lineQty = decimal(line.qty)
    if (lineQty.lte(0)) continue

    const baseUnitCostBase = decimal(line.unitCostBase)
    const landedForLine = decimal(landedByLine.get(line.id))
    const landedPerUnit = landedForLine.div(lineQty)
    const grossUnitCostBase = baseUnitCostBase.add(landedPerUnit).toDecimalPlaces(6, Prisma.Decimal.ROUND_HALF_UP)
    const afterLayers: Array<{
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
    }> = []

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
      const returnedQty = consumedQty.gt(LANDED_COST_DELTA_EPSILON)
        ? decimal(await serviceDeps.getReturnedQtyForCostLayer(tx, cl.id))
        : new Prisma.Decimal(0)
      const supplierReturnedQty = consumedQty.gt(LANDED_COST_DELTA_EPSILON)
        ? decimal(await serviceDeps.getSupplierReturnedQtyForCostLayer(tx, cl.id))
        : new Prisma.Decimal(0)
      const manufacturingConsumedQty = consumedQty.gt(LANDED_COST_DELTA_EPSILON)
        ? decimal(await serviceDeps.getManufacturingConsumedQtyForCostLayer(tx, cl.id))
        : new Prisma.Decimal(0)
      const reversalConsumedQty = consumedQty.gt(LANDED_COST_DELTA_EPSILON)
        ? decimal(await serviceDeps.getReversalConsumedQtyForCostLayer(tx, cl.id))
        : new Prisma.Decimal(0)
      const deltas = calculateLayerAdjustmentDeltas({
        oldUnitCost,
        newUnitCost,
        receivedQty,
        remainingQty,
        returnedQty,
        supplierReturnedQty,
        manufacturingConsumedQty,
        reversalConsumedQty,
      })
      totalCogsDelta = totalCogsDelta.add(deltas.cogsDelta)
      totalInventoryDelta = totalInventoryDelta.add(deltas.inventoryDelta)
      if (deltas.cogsDelta.abs().gt(LANDED_COST_DELTA_EPSILON) || deltas.inventoryDelta.abs().gt(LANDED_COST_DELTA_EPSILON)) {
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
          propagatedOutputLayers.push({ ...audit, cogsDelta: cogsD.toString(), inventoryDelta: invD.toString() })
        },
        new Set(), 1, recalcRunId, revaluedAt,
      )

      let affectedRefundSnapshots = 0
      let affectedShipments = 0
      let affectedSalesOrderLines = 0
      if (deltas.costDelta.abs().gt(LANDED_COST_DELTA_EPSILON)) {
        affectedRefundSnapshots = await serviceDeps.updateSnapshotsForCostLayerChange(tx, cl.id, grossUnitCostBase)
        const shipmentRefresh = await serviceDeps.refreshShipmentCogsForCostLayerChange(tx, cl.id, { recalcRunId })
        affectedShipments = shipmentRefresh.shipmentsUpdated
        // audit-3aph: shipment path owns the sold-goods COGS revaluation — remove
        // it from the COGS_JOURNAL to avoid double-posting COGS for sold units.
        totalCogsDelta = totalCogsDelta.sub(shipmentRefresh.cogsRevaluationDelta)
        affectedSalesOrderLines = await serviceDeps.refreshSalesOrderLineCogsForCostLayerChange(tx, cl.id)
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
