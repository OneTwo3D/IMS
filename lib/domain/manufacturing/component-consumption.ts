import { Prisma } from '@/app/generated/prisma/client'
import { getAverageUnitCost } from '@/lib/cost-layers'

export type ManufacturingComponentRequirement = {
  componentId: string
  qty: Prisma.Decimal | number
}

/**
 * Frozen BOM component requirements snapshotted onto a production order at its
 * IN_PROGRESS transition (audit-H6). Stored as JSON; qty is per output unit.
 */
export type ProductionOrderComponentSnapshot = Array<{ componentId: string; qty: number }>

/**
 * Validate and normalise a production order's persisted componentSnapshot JSON.
 * Returns null when absent, empty, or malformed — callers then fall back to the
 * live BOM (an order completed without ever being started has no snapshot).
 */
export function parseProductionOrderComponentSnapshot(
  raw: unknown,
): ProductionOrderComponentSnapshot | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const parsed: ProductionOrderComponentSnapshot = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return null
    const { componentId, qty } = entry as { componentId?: unknown; qty?: unknown }
    if (typeof componentId !== 'string' || componentId.length === 0) return null
    // Reject non-positive quantities: a negative qty would flip a reservedQty
    // decrement into an increment and corrupt reserved stock.
    if (typeof qty !== 'number' || !Number.isFinite(qty) || qty <= 0) return null
    parsed.push({ componentId, qty })
  }
  return parsed
}

export type RecoveredCostLayer = {
  costLayerId: string
  qty: Prisma.Decimal
  unitCostBase: Prisma.Decimal
}

export type DisassemblyRecoveryPlan = {
  entries: Array<{ componentId: string; totalQty: Prisma.Decimal; totalCostBase: Prisma.Decimal }>
  usedLegacyFallback: boolean
  recoveredLayerCount: number
}

type DisassemblyLayerDetail = {
  id: string
  receivedQty: Prisma.Decimal | number
  sourceLines: Array<{
    sourceProductId: string
    qty: Prisma.Decimal | number
    totalCostBase: Prisma.Decimal | number
  }>
}

type BuildDisassemblyRecoveryPlanOptions = {
  getAverageUnitCost?: (
    tx: Prisma.TransactionClient,
    productId: string,
    warehouseId: string,
  ) => Promise<number>
}

export function calculateRequiredComponentQty(
  component: ManufacturingComponentRequirement,
  qtyPlanned: number,
): Prisma.Decimal {
  if (!Number.isFinite(qtyPlanned) || qtyPlanned < 0) {
    throw new Error('Planned production quantity must be non-negative')
  }
  return new Prisma.Decimal(component.qty).mul(qtyPlanned)
}

export async function buildDisassemblyRecoveryPlan(
  tx: Prisma.TransactionClient,
  recoveredLayers: RecoveredCostLayer[],
  components: ManufacturingComponentRequirement[],
  warehouseId: string,
  qtyPlanned: number,
  options: BuildDisassemblyRecoveryPlanOptions = {},
): Promise<DisassemblyRecoveryPlan> {
  if (components.length === 0) {
    throw new Error('Cannot disassemble product without BOM components')
  }

  const loadAverageUnitCost = options.getAverageUnitCost ?? getAverageUnitCost
  const componentById = new Map(components.map((component) => [component.componentId, component]))
  const layerIds = recoveredLayers.map((layer) => layer.costLayerId)

  const layerDetails: DisassemblyLayerDetail[] = layerIds.length === 0
    ? []
    : await tx.costLayer.findMany({
        where: { id: { in: layerIds } },
        select: {
          id: true,
          receivedQty: true,
          sourceLines: {
            select: {
              sourceProductId: true,
              qty: true,
              totalCostBase: true,
            },
          },
        },
      })
  const layerDetailById = new Map(layerDetails.map((layer) => [layer.id, layer]))

  const historicalQtyByComponent = new Map<string, Prisma.Decimal>()
  const historicalCostByComponent = new Map<string, Prisma.Decimal>()
  let residualCostBase = new Prisma.Decimal(0)
  let usedLegacyFallback = false

  for (const recoveredLayer of recoveredLayers) {
    const layerDetail = layerDetailById.get(recoveredLayer.costLayerId)
    const entryCostBase = recoveredLayer.qty.mul(recoveredLayer.unitCostBase)

    if (!layerDetail || layerDetail.sourceLines.length === 0) {
      usedLegacyFallback = true
      residualCostBase = residualCostBase.add(entryCostBase)
      continue
    }

    const receivedQty = Number(layerDetail.receivedQty)
    if (!Number.isFinite(receivedQty) || receivedQty <= 0) {
      usedLegacyFallback = true
      residualCostBase = residualCostBase.add(entryCostBase)
      continue
    }

    const ratio = recoveredLayer.qty.div(receivedQty)
    let allocatedEntryCostBase = new Prisma.Decimal(0)

    for (const sourceLine of layerDetail.sourceLines) {
      const allocatedQty = new Prisma.Decimal(sourceLine.qty).mul(ratio)
      const allocatedCostBase = new Prisma.Decimal(sourceLine.totalCostBase).mul(ratio)
      allocatedEntryCostBase = allocatedEntryCostBase.add(allocatedCostBase)

      if (!componentById.has(sourceLine.sourceProductId)) {
        residualCostBase = residualCostBase.add(allocatedCostBase)
        continue
      }

      historicalQtyByComponent.set(
        sourceLine.sourceProductId,
        (historicalQtyByComponent.get(sourceLine.sourceProductId) ?? new Prisma.Decimal(0)).add(allocatedQty),
      )
      historicalCostByComponent.set(
        sourceLine.sourceProductId,
        (historicalCostByComponent.get(sourceLine.sourceProductId) ?? new Prisma.Decimal(0)).add(allocatedCostBase),
      )
    }

    const roundingResidual = entryCostBase.sub(allocatedEntryCostBase)
    if (roundingResidual.abs().gt(0.000001)) {
      residualCostBase = residualCostBase.add(roundingResidual)
    }
  }

  const residualBasis = await Promise.all(components.map(async (component) => {
    const totalQty = calculateRequiredComponentQty(component, qtyPlanned)
    const historicalQty = historicalQtyByComponent.get(component.componentId) ?? new Prisma.Decimal(0)
    const uncoveredQty = Prisma.Decimal.max(new Prisma.Decimal(0), totalQty.sub(historicalQty))
    const avgUnitCost = uncoveredQty.gt(0)
      ? await loadAverageUnitCost(tx, component.componentId, warehouseId)
      : 0
    return {
      componentId: component.componentId,
      totalQty,
      uncoveredQty,
      basis: avgUnitCost > 0 ? uncoveredQty.mul(avgUnitCost) : uncoveredQty,
    }
  }))

  const totalResidualBasis = residualBasis.reduce(
    (sum, component) => sum.add(component.basis),
    new Prisma.Decimal(0),
  )
  const fallbackResidualBasis = residualBasis.reduce(
    (sum, component) => sum.add(component.totalQty),
    new Prisma.Decimal(0),
  )
  const fallbackTriggered = usedLegacyFallback && residualCostBase.abs().gt(0.000001)

  const entries = residualBasis
    .filter((component) => component.totalQty.gt(0))
    .map((component) => {
      const historicalCost = historicalCostByComponent.get(component.componentId) ?? new Prisma.Decimal(0)
      const allocationBasis = totalResidualBasis.gt(0) ? component.basis : component.totalQty
      const residualAllocatedCost = residualCostBase.gt(0) && allocationBasis.gt(0)
        ? residualCostBase.mul(allocationBasis).div(
            totalResidualBasis.gt(0)
              ? totalResidualBasis
              : (fallbackResidualBasis.gt(0) ? fallbackResidualBasis : new Prisma.Decimal(1)),
          )
        : new Prisma.Decimal(0)
      return {
        componentId: component.componentId,
        totalQty: component.totalQty,
        totalCostBase: historicalCost.add(residualAllocatedCost),
      }
    })

  return {
    entries,
    usedLegacyFallback: fallbackTriggered,
    recoveredLayerCount: recoveredLayers.length,
  }
}
