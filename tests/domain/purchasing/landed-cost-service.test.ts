import assert from 'node:assert/strict'
import test from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import {
  LANDED_COST_DISTRIBUTION_METHODS,
  calculateLayerAdjustmentDeltas,
  computeGrossUnitCostBaseByLine,
  landedCostAdjustmentIdempotencyKey,
  normalizeLandedCostMethod,
  recalculateDirectLandedCosts,
  recalculateLandedCosts,
  type LandedCostServiceDeps,
} from '@/lib/domain/purchasing/landed-cost-service'

const baseLines = [
  {
    id: 'line-a',
    qty: 2,
    unitCostBase: 10,
    totalBase: 20,
    weight: 2,
  },
  {
    id: 'line-b',
    qty: 1,
    unitCostBase: 20,
    totalBase: 20,
    weight: 1,
  },
]

function grossFor(amountBase: number, distributionMethod: string): Record<string, number> {
  return Object.fromEntries(computeGrossUnitCostBaseByLine({
    lines: baseLines,
    directCostLines: [{ amountBase, distributionMethod }],
  }))
}

function deltasToNumbers(input: ReturnType<typeof calculateLayerAdjustmentDeltas>): Record<string, number> {
  return {
    costDelta: input.costDelta.toNumber(),
    consumedQty: input.consumedQty.toNumber(),
    netConsumedQty: input.netConsumedQty.toNumber(),
    cogsDelta: input.cogsDelta.toNumber(),
    inventoryDelta: input.inventoryDelta.toNumber(),
  }
}

test('centralizes supported landed-cost distribution methods', () => {
  assert.deepEqual(
    [...LANDED_COST_DISTRIBUTION_METHODS].sort(),
    ['BY_QUANTITY', 'BY_VALUE', 'BY_WEIGHT', 'EQUAL_SPLIT'].sort(),
  )
  assert.equal(normalizeLandedCostMethod('BY_WEIGHT'), 'BY_WEIGHT')
  assert.equal(normalizeLandedCostMethod('unknown'), 'BY_VALUE')
  assert.equal(normalizeLandedCostMethod(null), 'BY_VALUE')
})

test('allocates landed cost by line value', () => {
  assert.deepEqual(grossFor(40, 'BY_VALUE'), {
    'line-a': 20,
    'line-b': 40,
  })
})

test('allocates landed cost by received quantity', () => {
  assert.deepEqual(grossFor(30, 'BY_QUANTITY'), {
    'line-a': 20,
    'line-b': 30,
  })
})

test('allocates landed cost by total line weight', () => {
  assert.deepEqual(grossFor(50, 'BY_WEIGHT'), {
    'line-a': 30,
    'line-b': 30,
  })
})

test('allocates landed cost equally by eligible line', () => {
  assert.deepEqual(grossFor(30, 'EQUAL_SPLIT'), {
    'line-a': 17.5,
    'line-b': 35,
  })
})

test('combines direct and linked landed-cost sources', () => {
  const gross = Object.fromEntries(computeGrossUnitCostBaseByLine({
    lines: baseLines,
    directCostLines: [{ amountBase: 30, distributionMethod: 'BY_QUANTITY' }],
    linkedCostLines: [{ amountBase: 40, distributionMethod: 'BY_VALUE' }],
  }))

  assert.deepEqual(gross, {
    'line-a': 30,
    'line-b': 50,
  })
})

test('retrospective layer adjustment splits inventory and consumed COGS deltas', () => {
  assert.deepEqual(deltasToNumbers(calculateLayerAdjustmentDeltas({
    oldUnitCost: 10,
    newUnitCost: 12,
    receivedQty: 10,
    remainingQty: 4,
    returnedQty: 1,
    supplierReturnedQty: 2,
  })), {
    costDelta: 2,
    consumedQty: 6,
    netConsumedQty: 3,
    cogsDelta: 6,
    inventoryDelta: 8,
  })
})

test('retrospective layer adjustment handles landed-cost decreases', () => {
  assert.deepEqual(deltasToNumbers(calculateLayerAdjustmentDeltas({
    oldUnitCost: 12,
    newUnitCost: 10,
    receivedQty: 8,
    remainingQty: 5,
    returnedQty: 0,
    supplierReturnedQty: 0,
  })), {
    costDelta: -2,
    consumedQty: 3,
    netConsumedQty: 3,
    cogsDelta: -6,
    inventoryDelta: -10,
  })
})

test('retrospective layer adjustment excludes customer and supplier returns from COGS', () => {
  const deltas = calculateLayerAdjustmentDeltas({
    oldUnitCost: 10,
    newUnitCost: 12,
    receivedQty: 10,
    remainingQty: 4,
    returnedQty: 4,
    supplierReturnedQty: 2,
  })

  assert.equal(deltas.netConsumedQty.toNumber(), 0)
  assert.equal(deltas.cogsDelta.toNumber(), 0)
  assert.equal(deltas.inventoryDelta.toNumber(), 8)
})

test('retrospective layer adjustment uses Decimal arithmetic for fractional landed-cost deltas', () => {
  const deltas = calculateLayerAdjustmentDeltas({
    oldUnitCost: '0.10',
    newUnitCost: '0.30',
    receivedQty: '3',
    remainingQty: '1',
    returnedQty: '0',
    supplierReturnedQty: '0',
  })

  assert.equal(deltas.costDelta.toString(), '0.2')
  assert.equal(deltas.cogsDelta.toString(), '0.4')
  assert.equal(deltas.inventoryDelta.toString(), '0.2')
})

test('landed-cost adjustment idempotency key ignores wall-clock journal date', () => {
  const adj = { primaryPoId: 'po-1', primaryPoRef: 'PO-1', eventKey: 'event-a', totalDelta: 12.345 }

  assert.equal(
    landedCostAdjustmentIdempotencyKey('inventory', adj),
    landedCostAdjustmentIdempotencyKey('inventory', { ...adj, totalDelta: 12.35 }),
  )
  assert.notEqual(
    landedCostAdjustmentIdempotencyKey('inventory', adj),
    landedCostAdjustmentIdempotencyKey('cogs', adj),
  )
})

test('landed-cost adjustment idempotency key includes recalculation context', () => {
  const adj = { primaryPoId: 'po-1', primaryPoRef: 'PO-1', eventKey: 'event-a', totalDelta: 10 }

  assert.notEqual(
    landedCostAdjustmentIdempotencyKey('inventory', adj),
    landedCostAdjustmentIdempotencyKey('inventory', { ...adj, eventKey: 'event-b' }),
  )
})

function noopDeps(overrides: Partial<LandedCostServiceDeps> = {}): LandedCostServiceDeps {
  return {
    getReturnedQtyForCostLayer: async () => 0,
    getSupplierReturnedQtyForCostLayer: async () => 0,
    updateSnapshotsForCostLayerChange: async () => 0,
    refreshShipmentCogsForCostLayerChange: async () => 0,
    refreshSalesOrderLineCogsForCostLayerChange: async () => 0,
    warnWeightFallback: () => {},
    ...overrides,
  }
}

function createDirectTx(po: unknown) {
  const purchaseOrderLineUpdates: unknown[] = []
  const costLayerUpdates: unknown[] = []
  return {
    purchaseOrderLineUpdates,
    costLayerUpdates,
    tx: {
      purchaseOrder: {
        findUnique: async () => po,
      },
      purchaseOrderLine: {
        update: async (args: unknown) => {
          purchaseOrderLineUpdates.push(args)
          return args
        },
      },
      costLayer: {
        update: async (args: unknown) => {
          costLayerUpdates.push(args)
          return args
        },
      },
    },
  }
}

async function directRecalcForSingleLayer(params: {
  unitCostBase: Prisma.Decimal | number | string
  costLayerUnitCostBase: Prisma.Decimal | number | string
  amountBase: Prisma.Decimal | number | string
}) {
  const { tx } = createDirectTx({
    id: 'po-1',
    reference: 'PO-1',
    status: 'RECEIVED',
    lines: [{
      id: 'line-a',
      qty: 1,
      unitCostBase: params.unitCostBase,
      totalBase: 1,
      product: { weight: 1 },
      costLayers: [{
        id: 'layer-a',
        unitCostBase: params.costLayerUnitCostBase,
        receivedQty: 1,
        remainingQty: 1,
      }],
    }],
    freightCostLines: [{ amountBase: params.amountBase, distributionMethod: 'BY_QUANTITY' }],
    landedCostLinks: [],
  })

  return recalculateDirectLandedCosts(tx as never, 'po-1', noopDeps())
}

test('recalculateDirectLandedCosts rejects CLOSED purchase orders', async () => {
  const { tx } = createDirectTx({
    id: 'po-1',
    reference: 'PO-1',
    status: 'CLOSED',
    lines: [],
    freightCostLines: [],
    landedCostLinks: [],
  })

  await assert.rejects(
    recalculateDirectLandedCosts(tx as never, 'po-1', noopDeps()),
    /locked status/,
  )
})

test('recalculateLandedCosts rejects CLOSED linked primary purchase orders', async () => {
  const tx = {
    landedCostLink: {
      findMany: async ({ where }: { where: { freightPoId?: string; primaryPoId?: string } }) => (
        where.freightPoId
          ? [{ primaryPoId: 'po-1' }]
          : []
      ),
      updateMany: async () => ({ count: 0 }),
    },
    purchaseOrder: {
      findUnique: async () => ({
        id: 'po-1',
        reference: 'PO-1',
        status: 'CLOSED',
        lines: [],
        freightCostLines: [],
      }),
    },
  }

  await assert.rejects(
    recalculateLandedCosts(tx as never, 'freight-1', noopDeps()),
    /locked status/,
  )
})

test('recalculateDirectLandedCosts falls back to equal split when every BY_WEIGHT line has zero weight', async () => {
  const warned: string[] = []
  const { tx, purchaseOrderLineUpdates } = createDirectTx({
    id: 'po-1',
    reference: 'PO-1',
    status: 'RECEIVED',
    lines: [
      {
        id: 'line-a',
        qty: 2,
        unitCostBase: 10,
        totalBase: 20,
        product: { weight: 0 },
        costLayers: [{ id: 'layer-a', unitCostBase: 10, receivedQty: 2, remainingQty: 2 }],
      },
      {
        id: 'line-b',
        qty: 1,
        unitCostBase: 20,
        totalBase: 20,
        product: { weight: 0 },
        costLayers: [{ id: 'layer-b', unitCostBase: 20, receivedQty: 1, remainingQty: 1 }],
      },
    ],
    freightCostLines: [{ amountBase: 30, distributionMethod: 'BY_WEIGHT' }],
    landedCostLinks: [],
  })

  await recalculateDirectLandedCosts(tx as never, 'po-1', noopDeps({
    warnWeightFallback: (context) => warned.push(context),
  }))

  assert.deepEqual(warned, ['recalculateDirectLandedCosts:PO-1'])
  assert.deepEqual(
    purchaseOrderLineUpdates.map((entry) => ({
      id: (entry as { where: { id: string } }).where.id,
      landedUnitCostBase: (entry as { data: { landedUnitCostBase: { toNumber(): number } } }).data.landedUnitCostBase.toNumber(),
    })),
    [
      { id: 'line-a', landedUnitCostBase: 17.5 },
      { id: 'line-b', landedUnitCostBase: 35 },
    ],
  )
})

test('recalculateDirectLandedCosts combines direct and linked landed-cost lines', async () => {
  const { tx, purchaseOrderLineUpdates } = createDirectTx({
    id: 'po-1',
    reference: 'PO-1',
    status: 'RECEIVED',
    lines: [
      {
        id: 'line-a',
        qty: 2,
        unitCostBase: 10,
        totalBase: 20,
        product: { weight: 2 },
        costLayers: [{ id: 'layer-a', unitCostBase: 10, receivedQty: 2, remainingQty: 2 }],
      },
      {
        id: 'line-b',
        qty: 1,
        unitCostBase: 20,
        totalBase: 20,
        product: { weight: 1 },
        costLayers: [{ id: 'layer-b', unitCostBase: 20, receivedQty: 1, remainingQty: 1 }],
      },
    ],
    freightCostLines: [{ amountBase: 30, distributionMethod: 'BY_QUANTITY' }],
    landedCostLinks: [{
      freightPO: {
        freightCostLines: [{ amountBase: 40, distributionMethod: 'BY_VALUE' }],
      },
    }],
  })

  await recalculateDirectLandedCosts(tx as never, 'po-1', noopDeps())

  assert.deepEqual(
    purchaseOrderLineUpdates.map((entry) => ({
      id: (entry as { where: { id: string } }).where.id,
      landedUnitCostBase: (entry as { data: { landedUnitCostBase: { toNumber(): number } } }).data.landedUnitCostBase.toNumber(),
    })),
    [
      { id: 'line-a', landedUnitCostBase: 30 },
      { id: 'line-b', landedUnitCostBase: 50 },
    ],
  )
})

test('recalculateDirectLandedCosts skips snapshot refresh when cost delta is negligible', async () => {
  let snapshotRefreshes = 0
  const { tx } = createDirectTx({
    id: 'po-1',
    reference: 'PO-1',
    status: 'RECEIVED',
    lines: [{
      id: 'line-a',
      qty: 1,
      unitCostBase: 10,
      totalBase: 10,
      product: { weight: 1 },
      costLayers: [{ id: 'layer-a', unitCostBase: 10, receivedQty: 1, remainingQty: 1 }],
    }],
    freightCostLines: [{ amountBase: 0.0000004, distributionMethod: 'BY_QUANTITY' }],
    landedCostLinks: [],
  })

  await recalculateDirectLandedCosts(tx as never, 'po-1', noopDeps({
    updateSnapshotsForCostLayerChange: async () => {
      snapshotRefreshes += 1
      return 0
    },
  }))

  assert.equal(snapshotRefreshes, 0)
})

test('recalculateDirectLandedCosts preserves legacy negative midpoint journal rounding', async () => {
  const result = await directRecalcForSingleLayer({
    unitCostBase: '0.98',
    costLayerUnitCostBase: '1.00',
    amountBase: '0.005',
  })

  assert.deepEqual(result.inventoryTransitAdjustments.map((adj) => adj.totalDelta), [-0.01])
})

test('landed-cost adjustment event keys normalize equivalent decimal input shapes', async () => {
  const inputs = [
    0.3,
    '0.3',
    0.30000000000000004,
    new Prisma.Decimal('0.300000123456'),
  ]
  const eventKeys = await Promise.all(inputs.map(async (costLayerUnitCostBase) => {
    const result = await directRecalcForSingleLayer({
      unitCostBase: '0.30',
      costLayerUnitCostBase,
      amountBase: '1.00',
    })
    return result.inventoryTransitAdjustments[0]?.eventKey
  }))

  assert.equal(new Set(eventKeys).size, 1)
})
