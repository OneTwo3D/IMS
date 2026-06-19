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
import { normalizeAccountingEventLine } from '@/lib/domain/accounting/accounting-event-builder'

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

test('shipment COGS revaluation payload drops zero legs when revaluing up from 0.00', () => {
  const payload = buildShipmentCogsRevaluationSyncPayload({
    shipmentId: 'shipment-1',
    costLayerId: 'layer-1',
    inventoryAccount: '120',
    cogsAccount: '500',
    oldCogsBase: '0.00',
    newCogsBase: '3.00',
  })

  const lines = (payload?.lines ?? []) as Array<{ accountCode: string; description: string; debit?: number; credit?: number }>
  // Only the post legs remain — the zero-amount reverse legs are dropped so the
  // accounting-event normalizer does not reject them.
  assert.deepEqual(lines, [
    { accountCode: '500', description: 'Post revalued shipment COGS shipment-1', debit: 3 },
    { accountCode: '120', description: 'Post revalued shipment COGS shipment-1', credit: 3 },
  ])
  // Each line must carry exactly one positive amount; this would throw on a zero leg.
  for (const line of lines) {
    assert.doesNotThrow(() => normalizeAccountingEventLine(line, 'GBP'))
  }
})

test('shipment COGS revaluation payload drops zero legs when revaluing down to 0.00', () => {
  const payload = buildShipmentCogsRevaluationSyncPayload({
    shipmentId: 'shipment-1',
    costLayerId: 'layer-1',
    inventoryAccount: '120',
    cogsAccount: '500',
    oldCogsBase: '3.00',
    newCogsBase: '0.00',
  })

  const lines = (payload?.lines ?? []) as Array<{ accountCode: string; description: string; debit?: number; credit?: number }>
  // Only the reverse legs remain.
  assert.deepEqual(lines, [
    { accountCode: '120', description: 'Reverse old shipment COGS shipment-1', debit: 3 },
    { accountCode: '500', description: 'Reverse old shipment COGS shipment-1', credit: 3 },
  ])
  for (const line of lines) {
    assert.doesNotThrow(() => normalizeAccountingEventLine(line, 'GBP'))
  }
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
    isReversalPostingEnabled: async () => true,
    queueAccountingSync: async (_tx, params) => {
      queued.push(params)
    },
  })

  assert.equal(updated.shipmentsUpdated, 1)
  // audit-3aph: the helper reports the COGS revaluation it owns (new 27.5 − old 20).
  assert.equal(updated.cogsRevaluationDelta.toString(), '7.5')
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

test('refreshShipmentCogsForCostLayerChange stamps the recalc-run nonce into the idempotency key (scjz.33)', async () => {
  const queued: Array<{ idempotencyKey?: string }> = []
  const tx = {
    $queryRawUnsafe: async () => [{ id: 'shipment-1' }],
    shipment: {
      findUnique: async () => ({ cogsBatchAmount: '20.00', shipmentJournalDate: new Date('2026-01-02T00:00:00.000Z') }),
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
    isReversalPostingEnabled: async () => true,
    recalcRunId: 'run-abc',
    queueAccountingSync: async (_tx, params) => { queued.push(params) },
  })

  // Same (shipment, layer, old, new) as the prior test, but the nonce makes the
  // key distinct so an A→B→A correction is not falsely deduped.
  assert.equal(queued[0]?.idempotencyKey, 'shipment-cogs-revalue:shipment-1:layer-1:20:27.5:run-abc')
})

test('refreshShipmentCogsForCostLayerChange does not claim the delta when COGS_REVERSAL posting is disabled (audit-3aph)', async () => {
  // Posted shipment, but COGS_REVERSAL posting is OFF → the reversal won't reach
  // the ledger, so the helper must NOT report the delta as shipment-owned (else
  // the caller would drop it from the COGS journal and it would post nowhere).
  const queued: unknown[] = []
  const tx = {
    $queryRawUnsafe: async () => [{ id: 'shipment-1' }],
    shipment: {
      findUnique: async () => ({ cogsBatchAmount: '20.00', shipmentJournalDate: new Date('2026-01-02T00:00:00.000Z') }),
      update: async () => {},
    },
    shipmentLine: {
      findMany: async () => [{ costLayerSnapshot: [{ costLayerId: 'layer-1', qty: '5.000000', unitCostBase: '5.500000' }] }],
    },
  }
  const result = await refreshShipmentCogsForCostLayerChange(tx as never, 'layer-1', {
    accountingSettings: { inventoryAccount: '120', cogsAccount: '500' },
    isReversalPostingEnabled: async () => false,
    queueAccountingSync: async (_tx, params) => { queued.push(params) },
  })
  assert.equal(result.shipmentsUpdated, 1)
  assert.equal(result.cogsRevaluationDelta.toString(), '0') // not shipment-owned → stays in the COGS journal
  assert.deepEqual(queued, []) // nothing posted
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

  const result = await refreshShipmentCogsForCostLayerChange(tx as never, 'layer-1', {
    accountingSettings: { inventoryAccount: '120', cogsAccount: '500' },
    isDailyBatchPostingEnabled: async () => true,
    queueAccountingSync: async (_tx, params) => {
      queued.push(params)
    },
  })

  assert.deepEqual(queued, []) // un-journaled → no COGS_REVERSAL now
  // Batch IS enabled → it will post the updated cost, so the shipment path owns
  // the delta (new 27.5 − old 20 = 7.5) and the caller drops it from the journal.
  assert.equal(result.cogsRevaluationDelta.toString(), '7.5')
})

test('refreshShipmentCogsForCostLayerChange keeps the un-journaled delta in the journal when the daily batch is disabled (audit-gbzh)', async () => {
  // Un-journaled shipment, but the daily batch is OFF → it will never post the
  // updated cost, so the helper must NOT claim the delta (else the caller drops
  // it from the COGS journal and it posts nowhere — an under-count).
  const queued: unknown[] = []
  const tx = {
    $queryRawUnsafe: async () => [{ id: 'shipment-1' }],
    shipment: {
      findUnique: async () => ({ cogsBatchAmount: '20.00', shipmentJournalDate: null }),
      update: async () => {},
    },
    shipmentLine: {
      findMany: async () => [{ costLayerSnapshot: [{ costLayerId: 'layer-1', qty: '5.000000', unitCostBase: '5.500000' }] }],
    },
  }
  const result = await refreshShipmentCogsForCostLayerChange(tx as never, 'layer-1', {
    accountingSettings: { inventoryAccount: '120', cogsAccount: '500' },
    isDailyBatchPostingEnabled: async () => false,
    queueAccountingSync: async (_tx, params) => { queued.push(params) },
  })
  assert.deepEqual(queued, [])
  assert.equal(result.cogsRevaluationDelta.toString(), '0') // not shipment-owned → stays in the COGS journal
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

test('consumeFifoLayersStrict throws on a tiny positive consume with NO cost layers (audit-snxr)', async () => {
  // No FIFO rows → nothing consumed. A qty within the 0.0001 shortfall tolerance
  // would otherwise return empty consumed, and the outbound writers (guarding on
  // consumed.length > 0) would skip cogs_entries, so the deferred evidence guard
  // would trip at COMMIT. Fail clearly here instead.
  const tx = {
    $executeRaw: async () => 0,
    $queryRaw: async () => [],
    costLayer: { update: async () => {} },
  }
  await assert.rejects(
    () => consumeFifoLayersStrict(tx as never, 'product-1', 'warehouse-1', 0.00005),
    /No FIFO cost layers to consume for product product-1 in warehouse warehouse-1/,
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
