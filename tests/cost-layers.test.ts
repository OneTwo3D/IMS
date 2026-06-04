import assert from 'node:assert/strict'
import test from 'node:test'
import { addCostLayerSourceLines, consumeFifoLayers, consumeFifoLayersStrict } from '../lib/cost-layers.ts'

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
  const updates: unknown[] = []
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      query = strings.join('?')
      queryValues = values
      return [
        { id: 'layer-1', remainingQty: 10, unitCostBase: 2.5 },
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
  assert.match(query, /FOR UPDATE/)
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
    $queryRaw: async () => [
      { id: 'layer-1', remainingQty: 5, unitCostBase: 2 },
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
