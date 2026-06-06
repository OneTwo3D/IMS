import assert from 'node:assert/strict'
import test from 'node:test'
import { Prisma } from '@/app/generated/prisma/client'
import { addCostLayerSourceLines, cogsEntryDataFromConsumed, consumeFifoLayers, consumeFifoLayersStrict } from '../lib/cost-layers.ts'

test('cogsEntryDataFromConsumed preserves six-decimal consumed quantities', () => {
  assert.deepEqual(cogsEntryDataFromConsumed('movement-1', {
    costLayerId: 'layer-1',
    qty: new Prisma.Decimal('0.123456'),
    unitCostBase: new Prisma.Decimal('7.654321'),
  }), {
    costLayerId: 'layer-1',
    movementId: 'movement-1',
    qty: '0.123456',
    unitCostBase: '7.654321',
    totalCostBase: '0.944972',
  })
})

test('cogsEntryDataFromConsumed pins sub-six-decimal total value rounding', () => {
  assert.deepEqual(cogsEntryDataFromConsumed('movement-1', {
    costLayerId: 'layer-1',
    qty: new Prisma.Decimal('0.000001'),
    unitCostBase: new Prisma.Decimal('0.000001'),
  }), {
    costLayerId: 'layer-1',
    movementId: 'movement-1',
    qty: '0.000001',
    unitCostBase: '0.000001',
    totalCostBase: '0.000000',
  })
})

test('addCostLayerSourceLines rejects source lines without unit cost', async () => {
  const createdRows: unknown[] = []
  const tx = {
    costLayerSourceLine: {
      createMany: async ({ data }: { data: unknown[] }) => {
        createdRows.push(...data)
        return { count: data.length }
      },
    },
  }

  const count = await addCostLayerSourceLines(tx as never, 'layer-1', [
    { sourceProductId: 'component-1', qty: 1, unitCostBase: undefined },
    { sourceProductId: 'component-2', qty: 1, unitCostBase: null },
    { sourceProductId: 'component-3', qty: 1, unitCostBase: 2.5 },
  ])

  assert.equal(count, 1)
  assert.deepEqual(createdRows, [{
    costLayerId: 'layer-1',
    sourceProductId: 'component-3',
    sourceCostLayerId: null,
    qty: 1,
    unitCostBase: 2.5,
    totalCostBase: 2.5,
  }])
})

test('consumeFifoLayers selects FIFO candidates with row locks before consuming', async () => {
  let query = ''
  let queryValues: unknown[] = []
  const rawStatements: unknown[] = []
  const updates: unknown[] = []
  const tx = {
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      rawStatements.push({ query: strings.join('?'), values })
      return 0
    },
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      query = strings.join('?').trim()
      queryValues = values
      return [
        { id: 'layer-1', remainingQty: new Prisma.Decimal('10'), unitCostBase: new Prisma.Decimal('2.5') },
      ]
    },
    costLayer: {
      update: async (args: unknown) => {
        updates.push(args)
      },
    },
  }

  const result = await consumeFifoLayers(tx as never, 'product-1', 'warehouse-1', 8)

  assert.match(query, /FROM "cost_layers"/)
  assert.match(query, /"productId" = \?/)
  assert.match(query, /"warehouseId" = \?/)
  assert.match(query, /ORDER BY "receivedAt" ASC, id ASC/)
  assert.match(query, /ORDER BY "receivedAt" ASC, id ASC\s+FOR UPDATE\s*$/i)
  assert.equal(rawStatements.length, 1)
  assert.deepEqual(rawStatements, [{ query: "SET LOCAL lock_timeout = '30s'", values: [] }])
  assert.deepEqual(queryValues, ['product-1', 'warehouse-1'])
  assert.deepEqual(updates, [{
    where: { id: 'layer-1' },
    data: { remainingQty: { decrement: 8 } },
  }])
  assert.equal(result.remainingQty.toString(), '0')
  assert.equal(result.totalCost.toString(), '20')
  assert.deepEqual(result.consumed.map((layer) => ({
    costLayerId: layer.costLayerId,
    qty: layer.qty.toString(),
    unitCostBase: layer.unitCostBase.toString(),
  })), [{
    costLayerId: 'layer-1',
    qty: '8',
    unitCostBase: '2.5',
  }])
})

test('consumeFifoLayersStrict throws when locked FIFO rows cannot cover the request', async () => {
  const tx = {
    $executeRaw: async () => 0,
    $queryRaw: async () => [
      { id: 'layer-1', remainingQty: new Prisma.Decimal('5'), unitCostBase: new Prisma.Decimal('2') },
    ],
    costLayer: {
      update: async () => {},
    },
  }

  await assert.rejects(
    () => consumeFifoLayersStrict(tx as never, 'product-1', 'warehouse-1', 8),
    /Insufficient FIFO layers for product product-1 in warehouse warehouse-1: needed 8, only 5 available/,
  )
})

test('consumeFifoLayers returns the full remaining quantity when no FIFO rows are available', async () => {
  const tx = {
    $executeRaw: async () => 0,
    $queryRaw: async () => [],
    costLayer: {
      update: async () => {
        throw new Error('costLayer.update should not be called without FIFO rows')
      },
    },
  }

  const result = await consumeFifoLayers(tx as never, 'product-1', 'warehouse-1', 3)

  assert.equal(result.remainingQty.toString(), '3')
  assert.equal(result.totalCost.toString(), '0')
  assert.deepEqual(result.consumed, [])
})

test('consumeFifoLayersStrict throws when no FIFO rows are available', async () => {
  const tx = {
    $executeRaw: async () => 0,
    $queryRaw: async () => [],
    costLayer: {
      update: async () => {
        throw new Error('costLayer.update should not be called without FIFO rows')
      },
    },
  }

  await assert.rejects(
    () => consumeFifoLayersStrict(tx as never, 'product-1', 'warehouse-1', 3),
    /Insufficient FIFO layers for product product-1 in warehouse warehouse-1: needed 3, only 0 available/,
  )
})
