import { Prisma } from '@/app/generated/prisma/client'
import { getAccountingSettings, queueAccountingSync } from '@/lib/accounting'
import { accountingPayloadKey } from '@/lib/accounting/payload-key'
import { logActivity } from '@/lib/activity-log'
import {
  getReturnedQtyForCostLayer,
  getSupplierReturnedQtyForCostLayer,
  refreshSalesOrderLineCogsForCostLayerChange,
  refreshShipmentCogsForCostLayerChange,
  updateSnapshotsForCostLayerChange,
} from '@/lib/cost-layers'
import { toJsonInputValue } from '@/lib/db/json-input'

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
  code: 'weight_fallback'
  context: string
  message: string
}

export const LANDED_COST_REVALUATION_REASONS = [
  'direct_landed_cost_recalculation',
  'linked_freight_recalculation',
  'purchase_order_additional_costs_updated',
  'freight_purchase_order_created',
  'freight_purchase_order_costs_updated',
] as const

export type LandedCostRevaluationReason = typeof LANDED_COST_REVALUATION_REASONS[number]

export type LandedCostRevaluationOptions = {
  triggeredById: string | null
  reason?: LandedCostRevaluationReason | null
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
}

export type LandedCostServiceDeps = {
  getReturnedQtyForCostLayer: typeof getReturnedQtyForCostLayer
  getSupplierReturnedQtyForCostLayer: typeof getSupplierReturnedQtyForCostLayer
  updateSnapshotsForCostLayerChange: typeof updateSnapshotsForCostLayerChange
  refreshShipmentCogsForCostLayerChange: typeof refreshShipmentCogsForCostLayerChange
  refreshSalesOrderLineCogsForCostLayerChange: typeof refreshSalesOrderLineCogsForCostLayerChange
  warnWeightFallback: (context: string) => LandedCostRevaluationWarning | void
}

const defaultDeps: LandedCostServiceDeps = {
  getReturnedQtyForCostLayer,
  getSupplierReturnedQtyForCostLayer,
  updateSnapshotsForCostLayerChange,
  refreshShipmentCogsForCostLayerChange,
  refreshSalesOrderLineCogsForCostLayerChange,
  warnWeightFallback,
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
  const netConsumedQty = Prisma.Decimal.max(
    new Prisma.Decimal(0),
    consumedQty.sub(decimal(input.returnedQty)).sub(decimal(input.supplierReturnedQty)),
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

function landedCostAdjustmentEventKey(
  primaryPoId: string,
  layers: LandedCostAdjustmentLayerContext[],
): string {
  return accountingPayloadKey('landed-cost-adjustment-event', {
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
          accountCode: isIncrease ? settings.cogsAccount : settings.transitAccount,
          description: `COGS adjustment — ${adj.primaryPoRef}`,
          debit: absDelta,
        },
        {
          accountCode: isIncrease ? settings.transitAccount : settings.cogsAccount,
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
      throw new Error(`Cannot recalculate landed costs for ${primaryPoId}: purchase order is in a locked status`)
    }
    const beforeJson = revaluationBeforeJson(primaryPo)

    const allLinks = await tx.landedCostLink.findMany({
      where: { primaryPoId },
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
        const deltas = calculateLayerAdjustmentDeltas({
          oldUnitCost,
          newUnitCost,
          receivedQty,
          remainingQty,
          returnedQty,
          supplierReturnedQty,
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
          })
        }

        await tx.costLayer.update({
          where: { id: cl.id },
          data: { unitCostBase: grossUnitCostBase },
        })

        let affectedRefundSnapshots = 0
        let affectedShipments = 0
        let affectedSalesOrderLines = 0
        if (deltas.costDelta.abs().gt(LANDED_COST_DELTA_EPSILON)) {
          affectedRefundSnapshots = await serviceDeps.updateSnapshotsForCostLayerChange(tx, cl.id, grossUnitCostBase)
          affectedShipments = await serviceDeps.refreshShipmentCogsForCostLayerChange(tx, cl.id)
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
    const eventKey = landedCostAdjustmentEventKey(primaryPoId, adjustmentLayers)

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

    await tx.landedCostLink.updateMany({
      where: { primaryPoId, freightPoId },
      data: { allocated: true },
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
      const deltas = calculateLayerAdjustmentDeltas({
        oldUnitCost,
        newUnitCost,
        receivedQty,
        remainingQty,
        returnedQty,
        supplierReturnedQty,
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
        })
      }

      await tx.costLayer.update({
        where: { id: cl.id },
        data: { unitCostBase: grossUnitCostBase },
      })

      let affectedRefundSnapshots = 0
      let affectedShipments = 0
      let affectedSalesOrderLines = 0
      if (deltas.costDelta.abs().gt(LANDED_COST_DELTA_EPSILON)) {
        affectedRefundSnapshots = await serviceDeps.updateSnapshotsForCostLayerChange(tx, cl.id, grossUnitCostBase)
        affectedShipments = await serviceDeps.refreshShipmentCogsForCostLayerChange(tx, cl.id)
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
  const eventKey = landedCostAdjustmentEventKey(poId, adjustmentLayers)
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
  return result
}
