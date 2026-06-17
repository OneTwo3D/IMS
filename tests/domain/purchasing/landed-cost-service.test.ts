import assert from 'node:assert/strict'
import test from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import {
  getReturnedQtyForCostLayer,
  getSupplierReturnedQtyForCostLayer,
  updateSnapshotsForCostLayerChange,
} from '@/lib/cost-layers'
import { toDecimal } from '@/lib/domain/math/decimal'
import {
  LANDED_COST_DISTRIBUTION_METHODS,
  calculateLayerAdjustmentDeltas,
  computeGrossUnitCostBaseByLine,
  landedCostAdjustmentEventKey,
  landedCostAdjustmentIdempotencyKey,
  normalizeLandedCostMethod,
  recalculateDirectLandedCosts,
  recalculateLandedCosts,
  roundAdjustmentContextValue,
  roundAdjustmentTotalDelta,
  type LandedCostServiceDeps,
} from '@/lib/domain/purchasing/landed-cost-service'

const TEST_AUDIT_OPTIONS = {
  triggeredById: null,
  reason: 'direct_landed_cost_recalculation',
} as const

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
    manufacturingConsumedQty: 0,
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
    manufacturingConsumedQty: 0,
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
    manufacturingConsumedQty: 0,
  })

  assert.equal(deltas.netConsumedQty.toNumber(), 0)
  assert.equal(deltas.cogsDelta.toNumber(), 0)
  assert.equal(deltas.inventoryDelta.toNumber(), 8)
})

test('retrospective layer adjustment excludes manufacturing-consumed units from COGS (audit-jz9i)', () => {
  // received 10, 4 on-hand → 6 consumed; 3 of those were consumed by manufacturing
  // (capitalised into the produced output), so only 3 are customer COGS.
  const deltas = calculateLayerAdjustmentDeltas({
    oldUnitCost: 10,
    newUnitCost: 12,
    receivedQty: 10,
    remainingQty: 4,
    returnedQty: 0,
    supplierReturnedQty: 0,
    manufacturingConsumedQty: 3,
  })

  assert.equal(deltas.consumedQty.toNumber(), 6)
  assert.equal(deltas.netConsumedQty.toNumber(), 3) // 6 - 3 manufacturing
  assert.equal(deltas.cogsDelta.toNumber(), 6) // costDelta 2 × 3 net customer-consumed
  assert.equal(deltas.inventoryDelta.toNumber(), 8) // costDelta 2 × 4 on-hand (unchanged)
})

test('retrospective layer adjustment uses Decimal arithmetic for fractional landed-cost deltas', () => {
  const deltas = calculateLayerAdjustmentDeltas({
    oldUnitCost: '0.10',
    newUnitCost: '0.30',
    receivedQty: '3',
    remainingQty: '1',
    returnedQty: '0',
    supplierReturnedQty: '0',
    manufacturingConsumedQty: '0',
  })

  assert.equal(deltas.costDelta.toString(), '0.2')
  assert.equal(deltas.cogsDelta.toString(), '0.4')
  assert.equal(deltas.inventoryDelta.toString(), '0.2')
})

test('returned quantity helpers return Decimal without fractional drift', async () => {
  const refundTx = {
    $queryRawUnsafe: async () => [
      { costLayerSnapshot: [{ costLayerId: 'layer-a', qty: '0.1', unitCostBase: 1 }] },
      { costLayerSnapshot: [{ costLayerId: 'layer-a', qty: '0.2', unitCostBase: 1 }] },
      { costLayerSnapshot: [{ costLayerId: 'other-layer', qty: '9', unitCostBase: 1 }] },
    ],
  }
  const supplierTx = {
    cogsEntry: {
      findMany: async () => [
        { qty: new Prisma.Decimal('0.1') },
        { qty: new Prisma.Decimal('0.2') },
      ],
    },
  }

  const customerReturned = await getReturnedQtyForCostLayer(refundTx as never, 'layer-a')
  const supplierReturned = await getSupplierReturnedQtyForCostLayer(supplierTx as never, 'layer-a')

  assert.equal(customerReturned.toString(), '0.3')
  assert.equal(supplierReturned.toString(), '0.3')
})

test('snapshot updates accept Decimal input and serialize JSON unit costs as strings', async () => {
  const updates: Array<{ sql: string; snapshot: unknown; id: string }> = []
  const tx = {
    $queryRawUnsafe: async (_sql: string, containsCostLayer: string) => (
      containsCostLayer === JSON.stringify([{ costLayerId: 'layer-a' }])
        ? [{
          id: 'row-a',
          costLayerSnapshot: [
            { costLayerId: 'layer-a', qty: 1, unitCostBase: 10 },
            { costLayerId: 'layer-b', qty: 1, unitCostBase: 5 },
          ],
        }]
        : []
    ),
    $executeRawUnsafe: async (sql: string, snapshotJson: string, id: string) => {
      updates.push({ sql, snapshot: JSON.parse(snapshotJson), id })
      return 1
    },
  }

  const updated = await updateSnapshotsForCostLayerChange(tx as never, 'layer-a', new Prisma.Decimal('14.123456'))

  assert.equal(updated, 4)
  assert.equal(updates.length, 4)
  for (const update of updates) {
    assert.equal(update.id, 'row-a')
    assert.deepEqual(update.snapshot, [
      { costLayerId: 'layer-a', qty: '1.000000', unitCostBase: '14.123456' },
      { costLayerId: 'layer-b', qty: 1, unitCostBase: 5 },
    ])
  }
})

test('snapshot updates write an activity-log audit trail for changed rows', async () => {
  const activityLogs: unknown[] = []
  const tx = {
    $queryRawUnsafe: async (sql: string) => (
      sql.includes('"shipment_lines"')
        ? [{
          id: 'shipment-line-a',
          costLayerSnapshot: [
            { costLayerId: 'layer-a', qty: 2, unitCostBase: 10 },
            { costLayerId: 'layer-b', qty: 1, unitCostBase: 5 },
          ],
        }]
        : []
    ),
    $executeRawUnsafe: async () => 1,
    activityLog: {
      create: async (args: unknown) => {
        activityLogs.push(args)
        return { id: 'activity-1' }
      },
    },
  }

  const updated = await updateSnapshotsForCostLayerChange(tx as never, 'layer-a', new Prisma.Decimal('14.123456'))

  assert.equal(updated, 1)
  assert.equal(activityLogs.length, 1)
  assert.deepEqual(activityLogs[0], {
    data: {
      entityType: 'SYSTEM',
      entityId: 'shipment-line-a',
      action: 'cost_layer_snapshot_revalued',
      tag: 'inventory',
      level: 'INFO',
      description: 'Revalued shipment_lines cost-layer snapshot shipment-line-a for cost layer layer-a',
      metadata: {
        tableName: 'shipment_lines',
        rowId: 'shipment-line-a',
        costLayerId: 'layer-a',
        changedEntryCount: 1,
        previousSnapshotEntryCount: 2,
        patchedSnapshotEntryCount: 2,
        changedEntries: [{
          previousUnitCostBase: 10,
          newUnitCostBase: '14.123456',
          qty: 2,
        }],
      },
    },
  })
})

test('snapshot updates avoid the JSON number precision boundary', async () => {
  const runSnapshotUpdate = async (newUnitCostBase: Prisma.Decimal) => {
    let snapshot: unknown = null
    const tx = {
      $queryRawUnsafe: async (sql: string) => (
        sql.includes('"shipment_lines"')
          ? [{
            id: 'row-a',
            costLayerSnapshot: [{ costLayerId: 'layer-a', qty: 1, unitCostBase: 1 }],
          }]
          : []
      ),
      $executeRawUnsafe: async (_sql: string, snapshotJson: string) => {
        snapshot = JSON.parse(snapshotJson)
        return 1
      },
    }

    const updated = await updateSnapshotsForCostLayerChange(tx as never, 'layer-a', newUnitCostBase)
    assert.equal(updated, 1)
    return (snapshot as Array<{ unitCostBase: string }>)[0].unitCostBase
  }

  assert.equal(await runSnapshotUpdate(new Prisma.Decimal('1.123456789012345')), '1.123457')
  assert.equal(await runSnapshotUpdate(new Prisma.Decimal('1.1234567890123456789')), '1.123457')
})

test('snapshot updates rewrite malformed unit costs and emit warnings', async () => {
  const updates: unknown[] = []
  const warnings: string[] = []
  const originalWarn = console.warn
  console.warn = (message?: unknown) => {
    warnings.push(String(message))
  }

  try {
    const tx = {
      $queryRawUnsafe: async (sql: string) => (
        sql.includes('"shipment_lines"')
          ? [{
            id: 'row-a',
            costLayerSnapshot: [
              { costLayerId: 'layer-a', qty: 1, unitCostBase: null },
              { costLayerId: 'layer-a', qty: 1, unitCostBase: 'abc' },
              { costLayerId: 'layer-a', qty: 1, unitCostBase: {} },
              { costLayerId: 'layer-b', qty: 1, unitCostBase: 5 },
            ],
          }]
          : []
      ),
      $executeRawUnsafe: async (_sql: string, snapshotJson: string) => {
        updates.push(JSON.parse(snapshotJson))
        return 1
      },
    }

    const updated = await updateSnapshotsForCostLayerChange(tx as never, 'layer-a', new Prisma.Decimal('9.25'))

    assert.equal(updated, 1)
    assert.equal(warnings.length, 3)
    assert.ok(warnings.every((warning) => warning.includes('costLayerId=layer-a')))
    assert.match(warnings[0], /value=null/)
    assert.match(warnings[1], /value="abc"/)
    assert.match(warnings[2], /value=\{\}/)
    assert.deepEqual(updates, [[
      { costLayerId: 'layer-a', qty: '1.000000', unitCostBase: '9.250000' },
      { costLayerId: 'layer-a', qty: '1.000000', unitCostBase: '9.250000' },
      { costLayerId: 'layer-a', qty: '1.000000', unitCostBase: '9.250000' },
      { costLayerId: 'layer-b', qty: 1, unitCostBase: 5 },
    ]])
  } finally {
    console.warn = originalWarn
  }
})

test('snapshot updates skip rows whose unit cost already matches', async () => {
  let executed = false
  const tx = {
    $queryRawUnsafe: async (sql: string) => (
      sql.includes('"shipment_lines"')
        ? [{
          id: 'row-a',
          costLayerSnapshot: [
            { costLayerId: 'layer-a', qty: 1, unitCostBase: 14.123456 },
            { costLayerId: 'layer-b', qty: 1, unitCostBase: 5 },
          ],
        }]
        : []
    ),
    $executeRawUnsafe: async () => {
      executed = true
      return 1
    },
  }

  const updated = await updateSnapshotsForCostLayerChange(tx as never, 'layer-a', new Prisma.Decimal('14.123456'))

  assert.equal(updated, 0)
  assert.equal(executed, false)
})

test('landed-cost adjustment idempotency key ignores wall-clock journal date', () => {
  const adj = { primaryPoId: 'po-1', primaryPoRef: 'PO-1', freightPoId: null, eventKey: 'event-a', totalDelta: 12.345 }

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
  const adj = { primaryPoId: 'po-1', primaryPoRef: 'PO-1', freightPoId: 'freight-1', eventKey: 'event-a', totalDelta: 10 }

  assert.notEqual(
    landedCostAdjustmentIdempotencyKey('inventory', adj),
    landedCostAdjustmentIdempotencyKey('inventory', { ...adj, eventKey: 'event-b' }),
  )
  assert.notEqual(
    landedCostAdjustmentIdempotencyKey('inventory', adj),
    landedCostAdjustmentIdempotencyKey('inventory', { ...adj, freightPoId: 'freight-2' }),
  )
})

function noopDeps(overrides: Partial<LandedCostServiceDeps> = {}): LandedCostServiceDeps {
  return {
    getReturnedQtyForCostLayer: async () => new Prisma.Decimal(0),
    getSupplierReturnedQtyForCostLayer: async () => new Prisma.Decimal(0),
    getManufacturingConsumedQtyForCostLayer: async () => new Prisma.Decimal(0),
    updateSnapshotsForCostLayerChange: async () => 0,
    refreshShipmentCogsForCostLayerChange: async () => 0,
    refreshSalesOrderLineCogsForCostLayerChange: async () => 0,
    warnWeightFallback: () => {},
    ...overrides,
  }
}

function createDirectTx(
  po: unknown,
  options: {
    createAuditRun?: (args: unknown, existingRuns: unknown[]) => Promise<{ id: string }>
  } = {},
) {
  const purchaseOrderLineUpdates: unknown[] = []
  const costLayerUpdates: unknown[] = []
  const landedCostRevaluationRuns: unknown[] = []
  return {
    purchaseOrderLineUpdates,
    costLayerUpdates,
    landedCostRevaluationRuns,
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
      landedCostRevaluationRun: {
        create: async (args: unknown) => {
          if (options.createAuditRun) return options.createAuditRun(args, landedCostRevaluationRuns)
          landedCostRevaluationRuns.push(args)
          return { id: `audit-${landedCostRevaluationRuns.length}` }
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

  return recalculateDirectLandedCosts(tx as never, 'po-1', noopDeps(), TEST_AUDIT_OPTIONS)
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
    recalculateDirectLandedCosts(tx as never, 'po-1', noopDeps(), TEST_AUDIT_OPTIONS),
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
    recalculateLandedCosts(tx as never, 'freight-1', noopDeps(), TEST_AUDIT_OPTIONS),
    /locked status/,
  )
})

test('recalculateLandedCosts attributes adjustments to the triggering freight PO', async () => {
  const createLinkedTx = (freightPoId: string) => ({
    landedCostLink: {
      findMany: async ({ where }: { where: { freightPoId?: string; primaryPoId?: string } }) => {
        if (where.freightPoId) return [{ primaryPoId: 'po-1' }]
        if (where.primaryPoId) {
          return [
            { freightPO: { freightCostLines: [{ amountBase: '0.10', distributionMethod: 'BY_QUANTITY' }] } },
            { freightPO: { freightCostLines: [{ amountBase: '0.20', distributionMethod: 'BY_QUANTITY' }] } },
          ]
        }
        return []
      },
      updateMany: async () => ({ count: 1 }),
    },
    purchaseOrder: {
      findUnique: async () => ({
        id: 'po-1',
        reference: 'PO-1',
        status: 'RECEIVED',
        subtotalBase: '1',
        directFreightBase: '0',
        lines: [{
          id: 'line-a',
          qty: '1',
          unitCostBase: '1.00',
          landedUnitCostBase: '1.00',
          totalBase: '1.00',
          product: { weight: 1 },
          costLayers: [{ id: 'layer-a', unitCostBase: '1.00', receivedQty: '1', remainingQty: '1' }],
        }],
        freightCostLines: [],
      }),
    },
    purchaseOrderLine: { update: async () => ({}) },
    costLayer: { update: async () => ({}) },
    landedCostRevaluationRun: { create: async () => ({ id: `audit-${freightPoId}` }) },
  })

  const first = await recalculateLandedCosts(createLinkedTx('freight-1') as never, 'freight-1', noopDeps(), TEST_AUDIT_OPTIONS)
  const second = await recalculateLandedCosts(createLinkedTx('freight-2') as never, 'freight-2', noopDeps(), TEST_AUDIT_OPTIONS)

  assert.equal(first.inventoryTransitAdjustments[0]?.freightPoId, 'freight-1')
  assert.equal(second.inventoryTransitAdjustments[0]?.freightPoId, 'freight-2')
  assert.notEqual(
    landedCostAdjustmentIdempotencyKey('inventory', first.inventoryTransitAdjustments[0]!),
    landedCostAdjustmentIdempotencyKey('inventory', second.inventoryTransitAdjustments[0]!),
  )
})

test('recalculateDirectLandedCosts falls back to equal split when every BY_WEIGHT line has zero weight', async () => {
  const warned: string[] = []
  const { tx, purchaseOrderLineUpdates, landedCostRevaluationRuns } = createDirectTx({
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

  const result = await recalculateDirectLandedCosts(tx as never, 'po-1', noopDeps({
    warnWeightFallback: (context) => {
      warned.push(context)
    },
  }), TEST_AUDIT_OPTIONS)

  assert.deepEqual(warned, ['recalculateDirectLandedCosts:PO-1'])
  assert.deepEqual(result.warnings.map((warning) => warning.context), ['recalculateDirectLandedCosts:PO-1'])
  const auditRun = landedCostRevaluationRuns[0] as {
    data: {
      triggeredById: string | null
      reason: string
      warningsJson: Array<{ context: string }>
    }
  }
  assert.deepEqual(auditRun.data.warningsJson.map((warning) => warning.context), ['recalculateDirectLandedCosts:PO-1'])
  assert.equal(auditRun.data.triggeredById, null)
  assert.equal(auditRun.data.reason.length > 0, true)
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

  await recalculateDirectLandedCosts(tx as never, 'po-1', noopDeps(), TEST_AUDIT_OPTIONS)

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

test('recalculateDirectLandedCosts records direct and linked weight fallback warnings separately', async () => {
  const { tx, landedCostRevaluationRuns } = createDirectTx({
    id: 'po-1',
    reference: 'PO-1',
    status: 'RECEIVED',
    lines: [{
      id: 'line-a',
      qty: 1,
      unitCostBase: 10,
      landedUnitCostBase: 10,
      totalBase: 10,
      product: { weight: 0 },
      costLayers: [{ id: 'layer-a', unitCostBase: 10, receivedQty: 1, remainingQty: 1 }],
    }],
    freightCostLines: [{ amountBase: 5, distributionMethod: 'BY_WEIGHT' }],
    landedCostLinks: [{
      freightPO: {
        freightCostLines: [{ amountBase: 7, distributionMethod: 'BY_WEIGHT' }],
      },
    }],
  })

  const result = await recalculateDirectLandedCosts(tx as never, 'po-1', noopDeps(), TEST_AUDIT_OPTIONS)

  assert.deepEqual(
    result.warnings.map((warning) => warning.context),
    ['recalculateDirectLandedCosts:PO-1', 'recalculateDirectLandedCosts:PO-1:linked'],
  )
  const auditRun = landedCostRevaluationRuns[0] as { data: { warningsJson: Array<{ context: string }> } }
  assert.deepEqual(
    auditRun.data.warningsJson.map((warning) => warning.context),
    ['recalculateDirectLandedCosts:PO-1', 'recalculateDirectLandedCosts:PO-1:linked'],
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
  }), TEST_AUDIT_OPTIONS)

  assert.equal(snapshotRefreshes, 0)
})

test('recalculateDirectLandedCosts keeps fractional returns and snapshot cost as Decimal inputs', async () => {
  let snapshotUnitCost: string | null = null
  const { tx } = createDirectTx({
    id: 'po-1',
    reference: 'PO-1',
    status: 'RECEIVED',
    lines: [{
      id: 'line-a',
      qty: 1,
      unitCostBase: '1.00',
      totalBase: '1.00',
      product: { weight: 1 },
      costLayers: [{
        id: 'layer-a',
        unitCostBase: '1.00',
        receivedQty: '1',
        remainingQty: '0.5',
      }],
    }],
    freightCostLines: [{ amountBase: '0.10', distributionMethod: 'BY_QUANTITY' }],
    landedCostLinks: [],
  })

  const result = await recalculateDirectLandedCosts(tx as never, 'po-1', noopDeps({
    getReturnedQtyForCostLayer: async () => new Prisma.Decimal('0.1'),
    getSupplierReturnedQtyForCostLayer: async () => new Prisma.Decimal('0.2'),
    updateSnapshotsForCostLayerChange: async (_tx, _costLayerId, newUnitCostBase) => {
      snapshotUnitCost = toDecimal(newUnitCostBase).toString()
      return 1
    },
  }), TEST_AUDIT_OPTIONS)

  assert.equal(snapshotUnitCost, '1.1')
  assert.deepEqual(result.cogsAdjustments.map((adj) => adj.totalDelta), [0.02])
  assert.deepEqual(result.cogsAdjustments.map((adj) => adj.freightPoId), [null])
  assert.deepEqual(result.inventoryTransitAdjustments.map((adj) => adj.totalDelta), [0.05])
  assert.deepEqual(result.inventoryTransitAdjustments.map((adj) => adj.freightPoId), [null])
})

test('recalculateDirectLandedCosts writes an audit run with cost-layer and accounting context', async () => {
  const { tx, landedCostRevaluationRuns } = createDirectTx({
    id: 'po-1',
    reference: 'PO-1',
    status: 'RECEIVED',
    lines: [{
      id: 'line-a',
      qty: '1',
      unitCostBase: '1.00',
      landedUnitCostBase: '1.00',
      totalBase: '1.00',
      product: { weight: 1 },
      costLayers: [{
        id: 'layer-a',
        unitCostBase: '1.00',
        receivedQty: '1',
        remainingQty: '1',
      }],
    }],
    freightCostLines: [{ amountBase: '0.10', distributionMethod: 'BY_QUANTITY' }],
    landedCostLinks: [],
  })

  const result = await recalculateDirectLandedCosts(tx as never, 'po-1', noopDeps({
    updateSnapshotsForCostLayerChange: async () => 2,
    refreshShipmentCogsForCostLayerChange: async () => 3,
    refreshSalesOrderLineCogsForCostLayerChange: async () => 4,
  }), { triggeredById: 'user-1', reason: 'direct_landed_cost_recalculation' })

  assert.deepEqual(result.auditRunIds, ['audit-1'])
  const auditRun = landedCostRevaluationRuns[0] as {
    data: {
      primaryPoId: string
      freightPoId: string | null
      triggeredById: string | null
      status: string
      reason: string
      beforeJson: {
        lines: Array<{ costLayers: Array<{ unitCostBase: string }> }>
      }
      afterJson: {
        lines: Array<{
          grossUnitCostBase: string
          costLayers: Array<{
            oldUnitCostBase: string
            newUnitCostBase: string
            inventoryDelta: string
            affectedRefundSnapshots: number
            affectedShipments: number
            affectedSalesOrderLines: number
          }>
        }>
      }
      accountingJson: {
        inventoryTransitAdjustments: Array<{ totalDelta: number; idempotencyKey: string }>
        cogsAdjustments: unknown[]
      }
      warningsJson: unknown[]
    }
  }

  assert.equal(auditRun.data.primaryPoId, 'po-1')
  assert.equal(auditRun.data.freightPoId, null)
  assert.equal(auditRun.data.triggeredById, 'user-1')
  assert.equal(auditRun.data.status, 'COMPLETED')
  assert.equal(auditRun.data.reason, 'direct_landed_cost_recalculation')
  assert.equal(auditRun.data.beforeJson.lines[0]?.costLayers[0]?.unitCostBase, '1')
  assert.equal(auditRun.data.afterJson.lines[0]?.grossUnitCostBase, '1.1')
  assert.deepEqual(auditRun.data.afterJson.lines[0]?.costLayers[0], {
    costLayerId: 'layer-a',
    oldUnitCostBase: '1',
    newUnitCostBase: '1.1',
    receivedQty: '1',
    remainingQty: '1',
    consumedQty: '0',
    returnedQty: '0',
    supplierReturnedQty: '0',
    manufacturingConsumedQty: '0',
    cogsDelta: '0',
    inventoryDelta: '0.1',
    affectedRefundSnapshots: 2,
    affectedShipments: 3,
    affectedSalesOrderLines: 4,
  })
  assert.equal(auditRun.data.accountingJson.inventoryTransitAdjustments[0]?.totalDelta, 0.1)
  assert.equal(
    auditRun.data.accountingJson.inventoryTransitAdjustments[0]?.idempotencyKey,
    landedCostAdjustmentIdempotencyKey('inventory', result.inventoryTransitAdjustments[0]!),
  )
  assert.deepEqual(auditRun.data.accountingJson.cogsAdjustments, [])
  assert.deepEqual(auditRun.data.warningsJson, [])
})

test('recalculateDirectLandedCosts treats audit persistence as transaction-critical', async () => {
  const { tx } = createDirectTx({
    id: 'po-1',
    reference: 'PO-1',
    status: 'RECEIVED',
    lines: [{
      id: 'line-a',
      qty: '1',
      unitCostBase: '1.00',
      landedUnitCostBase: '1.00',
      totalBase: '1.00',
      product: { weight: 1 },
      costLayers: [{
        id: 'layer-a',
        unitCostBase: '1.00',
        receivedQty: '1',
        remainingQty: '1',
      }],
    }],
    freightCostLines: [{ amountBase: '0.10', distributionMethod: 'BY_QUANTITY' }],
    landedCostLinks: [],
  }, {
    createAuditRun: async () => {
      throw new Error('audit insert failed')
    },
  })

  await assert.rejects(
    recalculateDirectLandedCosts(tx as never, 'po-1', noopDeps(), TEST_AUDIT_OPTIONS),
    /audit insert failed/,
  )
})

test('landed-cost adjustment rounding documents context-vs-journal behavior', () => {
  assert.equal(roundAdjustmentContextValue(new Prisma.Decimal('-0.0000005')), -0.000001)
  assert.equal(Object.is(roundAdjustmentTotalDelta(new Prisma.Decimal('-0.005')), -0), true)
})

test('recalculateDirectLandedCosts preserves legacy negative midpoint journal rounding', async () => {
  const result = await directRecalcForSingleLayer({
    unitCostBase: '0.98',
    costLayerUnitCostBase: '1.00',
    amountBase: '0.005',
  })

  assert.deepEqual(result.inventoryTransitAdjustments.map((adj) => adj.totalDelta), [-0.01])
})

test('landed-cost adjustment event keys normalize equivalent decimal input shapes', () => {
  // audit-g4la: the event key is now per-recalc-run unique (a nonce), so equivalent
  // shapes only collapse to one key when the run id is held FIXED — which is what
  // proves the LAYER-content normalization (the original intent of this test).
  const inputs = [
    0.3,
    '0.3',
    0.30000000000000004,
    new Prisma.Decimal('0.300000123456'),
  ]
  const eventKeys = inputs.map((newUnitCost) => landedCostAdjustmentEventKey('po-1', [{
    costLayerId: 'cl-1',
    oldUnitCost: new Prisma.Decimal('0.20'),
    newUnitCost: new Prisma.Decimal(newUnitCost),
    receivedQty: new Prisma.Decimal('1'),
    remainingQty: new Prisma.Decimal('1'),
    returnedQty: new Prisma.Decimal('0'),
    supplierReturnedQty: new Prisma.Decimal('0'),
    manufacturingConsumedQty: new Prisma.Decimal('0'),
  }], 'fixed-run-id'))

  assert.equal(new Set(eventKeys).size, 1)
})
