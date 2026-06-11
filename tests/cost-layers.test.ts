import assert from 'node:assert/strict'
import test from 'node:test'
import { Prisma } from '@/app/generated/prisma/client'
import {
  addCostLayerSourceLines,
  buildShipmentCogsRevaluationSyncPayload,
  cogsEntryDataFromConsumed,
  consumeFifoLayers,
  consumeFifoLayersStrict,
  createCostLayer,
  refreshShipmentCogsForCostLayerChange,
} from '../lib/cost-layers.ts'
import { manufacturingCostLayerReceivedAt } from '@/lib/domain/manufacturing/manufacturing-action-inputs'

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

test('shipment COGS revaluation payload reverses old COGS and posts the recomputed amount', () => {
  const payload = buildShipmentCogsRevaluationSyncPayload({
    shipmentId: 'shipment-1',
    costLayerId: 'layer-1',
    inventoryAccount: '120',
    cogsAccount: '500',
    oldCogsBase: '20.00',
    newCogsBase: '27.50',
  })

  assert.deepEqual(payload, {
    date: new Date().toISOString().slice(0, 10),
    reference: 'Shipment COGS revaluation: shipment-1',
    narration: 'Reverse and repost shipment COGS after cost-layer revaluation for shipment shipment-1',
    lines: [
      { accountCode: '120', description: 'Reverse old shipment COGS shipment-1', debit: 20 },
      { accountCode: '500', description: 'Reverse old shipment COGS shipment-1', credit: 20 },
      { accountCode: '500', description: 'Post revalued shipment COGS shipment-1', debit: 27.5 },
      { accountCode: '120', description: 'Post revalued shipment COGS shipment-1', credit: 27.5 },
    ],
    sourceCostLayerId: 'layer-1',
    oldCogsBase: 20,
    newCogsBase: 27.5,
  })
  const lines = payload.lines as Array<{ debit?: number; credit?: number }>
  assert.equal(
    lines.reduce((sum, line) => sum + (line.debit ?? 0), 0),
    lines.reduce((sum, line) => sum + (line.credit ?? 0), 0),
  )
})

test('shipment COGS revaluation payload ignores sub-cent changes', () => {
  assert.equal(buildShipmentCogsRevaluationSyncPayload({
    shipmentId: 'shipment-1',
    costLayerId: 'layer-1',
    inventoryAccount: '120',
    cogsAccount: '500',
    oldCogsBase: '20.00',
    newCogsBase: '20.004',
  }), null)
})

test('refreshShipmentCogsForCostLayerChange queues COGS revaluation sync for posted shipments', async () => {
  const updates: unknown[] = []
  const queued: unknown[] = []
  const tx = {
    $queryRawUnsafe: async () => [{ id: 'shipment-1' }],
    shipment: {
      findUnique: async () => ({ cogsBatchAmount: '20.00', shipmentJournalDate: new Date('2026-01-02T00:00:00.000Z') }),
      update: async (args: unknown) => {
        updates.push(args)
      },
    },
    shipmentLine: {
      findMany: async () => [{
        costLayerSnapshot: [{ costLayerId: 'layer-1', qty: '5.000000', unitCostBase: '5.500000' }],
      }],
    },
  }

  const updated = await refreshShipmentCogsForCostLayerChange(tx as never, 'layer-1', {
    accountingSettings: { inventoryAccount: '120', cogsAccount: '500' },
    queueAccountingSync: async (_tx, params) => {
      queued.push(params)
    },
  })

  assert.equal(updated, 1)
  assert.deepEqual(updates, [{
    where: { id: 'shipment-1' },
    data: { cogsBatchAmount: 27.5 },
  }])
  assert.deepEqual(queued, [{
    type: 'COGS_REVERSAL',
    referenceType: 'Shipment',
    referenceId: 'shipment-1',
    idempotencyKey: 'shipment-cogs-revalue:shipment-1:layer-1:20:27.5',
    payload: {
      date: new Date().toISOString().slice(0, 10),
      reference: 'Shipment COGS revaluation: shipment-1',
      narration: 'Reverse and repost shipment COGS after cost-layer revaluation for shipment shipment-1',
      lines: [
        { accountCode: '120', description: 'Reverse old shipment COGS shipment-1', debit: 20 },
        { accountCode: '500', description: 'Reverse old shipment COGS shipment-1', credit: 20 },
        { accountCode: '500', description: 'Post revalued shipment COGS shipment-1', debit: 27.5 },
        { accountCode: '120', description: 'Post revalued shipment COGS shipment-1', credit: 27.5 },
      ],
      sourceCostLayerId: 'layer-1',
      oldCogsBase: 20,
      newCogsBase: 27.5,
    },
  }])
})

test('refreshShipmentCogsForCostLayerChange does not queue COGS revaluation sync for unposted shipments', async () => {
  const queued: unknown[] = []
  const tx = {
    $queryRawUnsafe: async () => [{ id: 'shipment-1' }],
    shipment: {
      findUnique: async () => ({ cogsBatchAmount: '20.00', shipmentJournalDate: null }),
      update: async () => {},
    },
    shipmentLine: {
      findMany: async () => [{
        costLayerSnapshot: [{ costLayerId: 'layer-1', qty: '5.000000', unitCostBase: '5.500000' }],
      }],
    },
  }

  await refreshShipmentCogsForCostLayerChange(tx as never, 'layer-1', {
    accountingSettings: { inventoryAccount: '120', cogsAccount: '500' },
    queueAccountingSync: async (_tx, params) => {
      queued.push(params)
    },
  })

  assert.deepEqual(queued, [])
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

test('manufacturing cost layers created out of order consume FIFO by completedAt receivedAt', async () => {
  const layers: Array<{
    id: string
    productId: string
    warehouseId: string
    remainingQty: Prisma.Decimal
    unitCostBase: Prisma.Decimal
    receivedAt: Date
  }> = []
  let nextLayer = 1
  const tx = {
    $executeRaw: async () => 0,
    $queryRaw: async (_strings: TemplateStringsArray, productId: string, warehouseId: string) => {
      return layers
        .filter((layer) => (
          layer.productId === productId &&
          layer.warehouseId === warehouseId &&
          layer.remainingQty.gt(0)
        ))
        .sort((left, right) => (
          left.receivedAt.getTime() - right.receivedAt.getTime() ||
          left.id.localeCompare(right.id)
        ))
        .map((layer) => ({
          id: layer.id,
          remainingQty: layer.remainingQty,
          unitCostBase: layer.unitCostBase,
        }))
    },
    costLayer: {
      create: async ({ data }: {
        data: {
          productId: string
          warehouseId: string
          remainingQty: string
          unitCostBase: number
          receivedAt?: Date
        }
      }) => {
        const id = `layer-${nextLayer++}`
        layers.push({
          id,
          productId: data.productId,
          warehouseId: data.warehouseId,
          remainingQty: new Prisma.Decimal(data.remainingQty),
          unitCostBase: new Prisma.Decimal(data.unitCostBase),
          receivedAt: data.receivedAt ?? new Date(),
        })
        return { id }
      },
      update: async ({ where, data }: {
        where: { id: string }
        data: { remainingQty: { decrement: number } }
      }) => {
        const layer = layers.find((candidate) => candidate.id === where.id)
        if (!layer) throw new Error(`Missing layer ${where.id}`)
        layer.remainingQty = layer.remainingQty.minus(data.remainingQty.decrement)
      },
    },
  }
  const productId = 'manufactured-product-1'
  const warehouseId = 'warehouse-1'
  const completedA = new Date('2026-06-01T09:00:00.000Z')
  const completedB = new Date('2026-06-01T10:00:00.000Z')

  const layerB = await createCostLayer(tx as never, {
    productId,
    warehouseId,
    qty: 1,
    unitCostBase: 20,
    productionOrderId: 'production-b',
    receivedAt: manufacturingCostLayerReceivedAt({
      orderType: 'ASSEMBLY',
      completedAt: completedB,
      transitionAt: new Date('2026-06-01T12:00:00.000Z'),
    }),
  })
  const layerA = await createCostLayer(tx as never, {
    productId,
    warehouseId,
    qty: 1,
    unitCostBase: 10,
    productionOrderId: 'production-a',
    receivedAt: manufacturingCostLayerReceivedAt({
      orderType: 'ASSEMBLY',
      completedAt: completedA,
      transitionAt: new Date('2026-06-01T13:00:00.000Z'),
    }),
  })

  assert.deepEqual(layers.map((layer) => layer.id), [layerB, layerA])
  assert.equal(layers.find((layer) => layer.id === layerA)?.receivedAt.toISOString(), completedA.toISOString())
  assert.equal(layers.find((layer) => layer.id === layerB)?.receivedAt.toISOString(), completedB.toISOString())

  const result = await consumeFifoLayersStrict(tx as never, productId, warehouseId, 1.5)

  assert.deepEqual(result.consumed.map((layer) => layer.costLayerId), [layerA, layerB])
  assert.deepEqual(result.consumed.map((layer) => layer.qty.toString()), ['1', '0.5'])
  assert.equal(result.totalCost.toString(), '20')
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
