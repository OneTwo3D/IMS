import assert from 'node:assert/strict'
import test from 'node:test'
import { addCostLayerSourceLines } from '../lib/cost-layers.ts'

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
