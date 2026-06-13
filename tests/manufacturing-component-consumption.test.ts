import assert from 'node:assert/strict'
import test from 'node:test'
import { Prisma } from '@/app/generated/prisma/client'
import {
  buildDisassemblyRecoveryPlan,
  calculateRequiredComponentQty,
  parseProductionOrderComponentSnapshot,
} from '../lib/domain/manufacturing/component-consumption.ts'

function fakeTx(layerDetails: unknown[]) {
  return {
    costLayer: {
      async findMany() {
        return layerDetails
      },
    },
  } as unknown as Prisma.TransactionClient
}

test('calculateRequiredComponentQty multiplies component quantity by planned production quantity', () => {
  assert.equal(
    calculateRequiredComponentQty({ componentId: 'component-a', qty: new Prisma.Decimal('0.25') }, 8).toString(),
    '2',
  )
})

test('calculateRequiredComponentQty preserves Decimal precision for fractional component quantities', () => {
  assert.equal(
    calculateRequiredComponentQty({ componentId: 'component-a', qty: new Prisma.Decimal('0.3333') }, 9999).toFixed(4),
    '3332.6667',
  )
})

test('calculateRequiredComponentQty rejects negative planned production quantity', () => {
  assert.throws(
    () => calculateRequiredComponentQty({ componentId: 'component-a', qty: new Prisma.Decimal('1') }, -1),
    /Planned production quantity must be non-negative/,
  )
})

test('buildDisassemblyRecoveryPlan rejects products without BOM components', async () => {
  await assert.rejects(
    buildDisassemblyRecoveryPlan(
      fakeTx([]),
      [{ costLayerId: 'layer-1', qty: new Prisma.Decimal(1), unitCostBase: new Prisma.Decimal(1) }],
      [],
      'warehouse-1',
      1,
    ),
    /Cannot disassemble product without BOM components/,
  )
})

test('buildDisassemblyRecoveryPlan preserves historical source-line cost by component', async () => {
  const plan = await buildDisassemblyRecoveryPlan(
    fakeTx([
      {
        id: 'layer-1',
        receivedQty: new Prisma.Decimal(10),
        sourceLines: [
          { sourceProductId: 'component-a', qty: new Prisma.Decimal(6), totalCostBase: new Prisma.Decimal(60) },
          { sourceProductId: 'component-b', qty: new Prisma.Decimal(4), totalCostBase: new Prisma.Decimal(40) },
        ],
      },
    ]),
    [{ costLayerId: 'layer-1', qty: new Prisma.Decimal(5), unitCostBase: new Prisma.Decimal(10) }],
    [
      { componentId: 'component-a', qty: new Prisma.Decimal(0.6) },
      { componentId: 'component-b', qty: new Prisma.Decimal(0.4) },
    ],
    'warehouse-1',
    5,
  )

  assert.equal(plan.usedLegacyFallback, false)
  assert.equal(plan.recoveredLayerCount, 1)
  assert.deepEqual(
    Object.fromEntries(plan.entries.map((entry) => [
      entry.componentId,
      { totalQty: entry.totalQty.toNumber(), totalCostBase: entry.totalCostBase.toNumber() },
    ])),
    {
      'component-a': { totalQty: 3, totalCostBase: 30 },
      'component-b': { totalQty: 2, totalCostBase: 20 },
    },
  )
})

test('buildDisassemblyRecoveryPlan allocates missing provenance by average-cost residual basis', async () => {
  const plan = await buildDisassemblyRecoveryPlan(
    fakeTx([]),
    [{ costLayerId: 'missing-layer', qty: new Prisma.Decimal(10), unitCostBase: new Prisma.Decimal(5) }],
    [
      { componentId: 'component-a', qty: 1 },
      { componentId: 'component-b', qty: 3 },
    ],
    'warehouse-1',
    2,
    {
      async getAverageUnitCost(_tx, productId) {
        return productId === 'component-a' ? 10 : 2
      },
    },
  )

  assert.equal(plan.usedLegacyFallback, true)
  assert.equal(plan.recoveredLayerCount, 1)
  assert.deepEqual(
    Object.fromEntries(plan.entries.map((entry) => [
      entry.componentId,
      { totalQty: entry.totalQty.toNumber(), totalCostBase: entry.totalCostBase.toNumber() },
    ])),
    {
      'component-a': { totalQty: 2, totalCostBase: 31.25 },
      'component-b': { totalQty: 6, totalCostBase: 18.75 },
    },
  )
})

test('buildDisassemblyRecoveryPlan falls back to quantity basis when average cost is unavailable', async () => {
  const plan = await buildDisassemblyRecoveryPlan(
    fakeTx([]),
    [{ costLayerId: 'missing-layer', qty: new Prisma.Decimal(8), unitCostBase: new Prisma.Decimal(5) }],
    [
      { componentId: 'component-a', qty: 1 },
      { componentId: 'component-b', qty: 3 },
    ],
    'warehouse-1',
    2,
    {
      async getAverageUnitCost() {
        return 0
      },
    },
  )

  assert.deepEqual(
    Object.fromEntries(plan.entries.map((entry) => [
      entry.componentId,
      { totalQty: entry.totalQty.toNumber(), totalCostBase: entry.totalCostBase.toNumber() },
    ])),
    {
      'component-a': { totalQty: 2, totalCostBase: 10 },
      'component-b': { totalQty: 6, totalCostBase: 30 },
    },
  )
})

test('buildDisassemblyRecoveryPlan returns no entries when planned quantity is zero', async () => {
  const plan = await buildDisassemblyRecoveryPlan(
    fakeTx([]),
    [{ costLayerId: 'missing-layer', qty: new Prisma.Decimal(8), unitCostBase: new Prisma.Decimal(5) }],
    [{ componentId: 'component-a', qty: new Prisma.Decimal('0.5') }],
    'warehouse-1',
    0,
  )

  assert.equal(plan.usedLegacyFallback, true)
  assert.deepEqual(plan.entries, [])
})

test('parseProductionOrderComponentSnapshot accepts a well-formed snapshot', () => {
  const snap = parseProductionOrderComponentSnapshot([
    { componentId: 'leg', qty: 4 },
    { componentId: 'top', qty: 1 },
  ])
  assert.deepEqual(snap, [
    { componentId: 'leg', qty: 4 },
    { componentId: 'top', qty: 1 },
  ])
})

test('parseProductionOrderComponentSnapshot returns null for absent/empty/malformed JSON (falls back to live BOM)', () => {
  assert.equal(parseProductionOrderComponentSnapshot(null), null)
  assert.equal(parseProductionOrderComponentSnapshot(undefined), null)
  assert.equal(parseProductionOrderComponentSnapshot([]), null)
  assert.equal(parseProductionOrderComponentSnapshot('nope'), null)
  assert.equal(parseProductionOrderComponentSnapshot([{ componentId: 'x' }]), null) // missing qty
  assert.equal(parseProductionOrderComponentSnapshot([{ qty: 4 }]), null) // missing componentId
  assert.equal(parseProductionOrderComponentSnapshot([{ componentId: '', qty: 4 }]), null) // empty id
  assert.equal(parseProductionOrderComponentSnapshot([{ componentId: 'x', qty: 'four' }]), null) // non-numeric
  assert.equal(parseProductionOrderComponentSnapshot([{ componentId: 'x', qty: Number.NaN }]), null) // NaN
})

test('edit-in-between: consumption follows the frozen snapshot, not the edited live BOM', () => {
  // Order started with 4 legs/unit; snapshot frozen at IN_PROGRESS.
  const snapshot = parseProductionOrderComponentSnapshot([{ componentId: 'leg', qty: 4 }])!
  // BOM later edited to 3 legs/unit — the live components the COMPLETED path would
  // otherwise read.
  const liveBom = [{ componentId: 'leg', qty: new Prisma.Decimal(3) }]
  const qtyPlanned = 10

  // Consuming from the snapshot removes exactly what was reserved (4 × 10 = 40),
  // leaving zero ghost reservation. Reading the edited live BOM would consume 30
  // and strand 10 reserved forever.
  const fromSnapshot = calculateRequiredComponentQty(snapshot[0], qtyPlanned)
  const fromLiveBom = calculateRequiredComponentQty(liveBom[0], qtyPlanned)
  assert.equal(fromSnapshot.toString(), '40')
  assert.equal(fromLiveBom.toString(), '30')
})
