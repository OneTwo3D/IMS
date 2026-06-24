import assert from 'node:assert/strict'
import test from 'node:test'
import { Prisma } from '@/app/generated/prisma/client'
import {
  addCostLayerSourceLines,
  buildShipmentCogsRevaluationSyncPayload,
  cogsEntryDataFromConsumed,
  consumeFifoLayers,
  consumeFifoLayersStrict,
  copyCostLayerSourceLinesProportionally,
  createCostLayer,
  lockStockLevelRow,
  recordCostLayerRevaluation,
  refreshSalesOrderLineCogs,
  refreshShipmentCogsForCostLayerChange,
  updateCostLayerUnitCost,
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

test('lockStockLevelRow upserts the stock-level row then takes a FOR UPDATE lock on it', async () => {
  const calls: string[] = []
  let upsertArgs: { where?: unknown; create?: unknown } | undefined
  let lockValues: unknown[] = []
  const tx = {
    stockLevel: {
      upsert: async (args: { where?: unknown; create?: unknown }) => {
        calls.push('upsert')
        upsertArgs = args
        return {}
      },
    },
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push(`lock:${strings.join('?').replace(/\s+/g, ' ').trim()}`)
      lockValues = values
      return []
    },
  }

  await lockStockLevelRow(tx as never, 'product-1', 'warehouse-1')

  // Upsert (to guarantee the row exists) must precede the row lock.
  assert.equal(calls[0], 'upsert')
  assert.match(calls[1], /^lock:/)
  assert.match(calls[1], /FROM stock_levels/)
  assert.match(calls[1], /FOR UPDATE$/)
  assert.deepEqual(lockValues, ['product-1', 'warehouse-1'])
  assert.deepEqual(upsertArgs?.where, { productId_warehouseId: { productId: 'product-1', warehouseId: 'warehouse-1' } })
  assert.deepEqual(upsertArgs?.create, { productId: 'product-1', warehouseId: 'warehouse-1', quantity: 0 })
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
    cogsSubledgerMovement: { upsert: async ({ create }: { create: unknown }) => create },
  }

  const updated = await refreshShipmentCogsForCostLayerChange(tx as never, 'layer-1', {
    accountingSettings: { inventoryAccount: '120', cogsAccount: '500' },
    isReversalPostingEnabled: async () => true,
    queueAccountingSync: async (_tx, params) => {
      queued.push(params)
      return true
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
    cogsSubledgerMovement: { upsert: async ({ create }: { create: unknown }) => create },
  }

  await refreshShipmentCogsForCostLayerChange(tx as never, 'layer-1', {
    accountingSettings: { inventoryAccount: '120', cogsAccount: '500' },
    isReversalPostingEnabled: async () => true,
    recalcRunId: 'run-abc',
    queueAccountingSync: async (_tx, params) => { queued.push(params); return true },
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
    queueAccountingSync: async (_tx, params) => { queued.push(params); return true },
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
      return true
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
    queueAccountingSync: async (_tx, params) => { queued.push(params); return true },
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
  // No FIFO rows → nothing consumed. A qty within the sub-µ shortfall tolerance
  // would otherwise return empty consumed, and the outbound writers (guarding on
  // consumed.length > 0) would skip cogs_entries, so the deferred evidence guard
  // would trip at COMMIT. Fail clearly here instead. (A larger qty trips the
  // Insufficient-FIFO-layers guard first — also a hard error.)
  const tx = {
    $executeRaw: async () => 0,
    $queryRaw: async () => [],
    costLayer: { update: async () => {} },
  }
  await assert.rejects(
    () => consumeFifoLayersStrict(tx as never, 'product-1', 'warehouse-1', 0.000001),
    /No FIFO cost layers to consume for product product-1 in warehouse warehouse-1/,
  )
})

test('consumeFifoLayersStrict throws on a >1e-6 shortfall previously absorbed by the 1e-4 band (scjz.6)', async () => {
  // Layer covers 4.99999 of a requested 5 → shortfall 0.00001. The old 0.0001
  // tolerance absorbed this (understating unit cost over the full rowQty); the
  // tightened 1e-6 tolerance surfaces it.
  const tx = {
    $executeRaw: async () => 0,
    $queryRaw: async () => [
      { id: 'layer-1', remainingQty: new Prisma.Decimal('4.99999'), unitCostBase: new Prisma.Decimal('2') },
    ],
    costLayer: { update: async () => {} },
  }
  await assert.rejects(
    () => consumeFifoLayersStrict(tx as never, 'product-1', 'warehouse-1', 5),
    /Insufficient FIFO layers for product product-1 in warehouse warehouse-1: needed 5, only 4.99999 available/,
  )
})

test('consumeFifoLayersStrict absorbs a sub-µ shortfall and still returns the consumed layers (scjz.6)', async () => {
  // 5 - 4.9999995 = 0.0000005 ≤ 1e-6: float→Decimal noise, not a real shortfall.
  const tx = {
    $executeRaw: async () => 0,
    $queryRaw: async () => [
      { id: 'layer-1', remainingQty: new Prisma.Decimal('4.9999995'), unitCostBase: new Prisma.Decimal('2') },
    ],
    costLayer: { update: async () => {} },
  }
  const result = await consumeFifoLayersStrict(tx as never, 'product-1', 'warehouse-1', 5)
  assert.equal(result.consumed.length, 1)
  assert.equal(result.consumed[0].qty.toString(), '4.9999995')
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

function copySourceLinesTx(sourceLayer: unknown, createdRows: unknown[]) {
  return {
    costLayer: {
      findUnique: async () => sourceLayer,
    },
    costLayerSourceLine: {
      createMany: async ({ data }: { data: unknown[] }) => {
        createdRows.push(...data)
        return { count: data.length }
      },
    },
  }
}

test('copyCostLayerSourceLinesProportionally copies a proportional slice when copiedQty < receivedQty', async () => {
  const createdRows: unknown[] = []
  const tx = copySourceLinesTx({
    receivedQty: '10',
    sourceLines: [
      { sourceProductId: 'comp-a', sourceCostLayerId: 'src-a', qty: '10', unitCostBase: '4', totalCostBase: '40' },
    ],
  }, createdRows)

  const count = await copyCostLayerSourceLinesProportionally(tx as never, 'from-1', 'to-1', 4)

  assert.equal(count, 1)
  assert.deepEqual(createdRows, [{
    costLayerId: 'to-1',
    sourceProductId: 'comp-a',
    sourceCostLayerId: 'src-a',
    qty: 4,
    unitCostBase: 4,
    totalCostBase: 16,
  }])
})

test('copyCostLayerSourceLinesProportionally throws when copiedQty exceeds source receivedQty (no silent cost leak)', async () => {
  const createdRows: unknown[] = []
  const tx = copySourceLinesTx({
    receivedQty: '10',
    sourceLines: [
      { sourceProductId: 'comp-a', sourceCostLayerId: 'src-a', qty: '10', unitCostBase: '10', totalCostBase: '100' },
    ],
  }, createdRows)

  await assert.rejects(
    () => copyCostLayerSourceLinesProportionally(tx as never, 'from-1', 'to-1', 15),
    /copiedQty exceeds source receivedQty/,
  )
  assert.equal(createdRows.length, 0)
})

test('copyCostLayerSourceLinesProportionally clamps a sub-micro rounding overshoot to ratio 1', async () => {
  const createdRows: unknown[] = []
  const tx = copySourceLinesTx({
    receivedQty: '10',
    sourceLines: [
      { sourceProductId: 'comp-a', sourceCostLayerId: 'src-a', qty: '10', unitCostBase: '10', totalCostBase: '100' },
    ],
  }, createdRows)

  // 10.0000005 / 10 = 1.00000005 — within the sub-µ rounding band, clamp to 1.
  const count = await copyCostLayerSourceLinesProportionally(tx as never, 'from-1', 'to-1', '10.0000005')

  assert.equal(count, 1)
  assert.deepEqual(createdRows, [{
    costLayerId: 'to-1',
    sourceProductId: 'comp-a',
    sourceCostLayerId: 'src-a',
    qty: 10,
    unitCostBase: 10,
    totalCostBase: 100,
  }])
})

function refreshCogsTx(
  shipmentLines: Array<{ lineId: string; costLayerSnapshot: unknown }>,
  updates: unknown[],
  findManyArgs?: unknown[],
) {
  return {
    shipmentLine: {
      findMany: async (args?: unknown) => {
        findManyArgs?.push(args)
        return shipmentLines
      },
    },
    salesOrderLine: {
      update: async (args: unknown) => {
        updates.push(args)
      },
    },
  }
}

test('refreshSalesOrderLineCogs only considers SHIPPED shipment lines (scjz.24)', async () => {
  const findManyArgs: unknown[] = []
  const tx = refreshCogsTx([], [], findManyArgs)

  await refreshSalesOrderLineCogs(tx as never, ['line-1'])

  assert.deepEqual((findManyArgs[0] as { where: unknown }).where, {
    lineId: { in: ['line-1'] },
    shipment: { status: 'SHIPPED' },
  })
})

test('refreshSalesOrderLineCogs sums COGS when every shipment line is snapshotted', async () => {
  const updates: unknown[] = []
  const tx = refreshCogsTx([
    { lineId: 'line-1', costLayerSnapshot: [{ costLayerId: 'la', qty: '3', unitCostBase: '10' }] },
    { lineId: 'line-1', costLayerSnapshot: [{ costLayerId: 'lb', qty: '2', unitCostBase: '5' }] },
  ], updates)

  const updated = await refreshSalesOrderLineCogs(tx as never, ['line-1'])

  assert.equal(updated, 1)
  assert.deepEqual(updates, [{ where: { id: 'line-1' }, data: { cogsBase: 40 } }])
})

test('refreshSalesOrderLineCogs preserves prior cogsBase on mixed snapshot presence (scjz.24)', async () => {
  const updates: unknown[] = []
  // line-1: one partial snapshotted (30), one partial cleared — must NOT write 30.
  const tx = refreshCogsTx([
    { lineId: 'line-1', costLayerSnapshot: [{ costLayerId: 'la', qty: '3', unitCostBase: '10' }] },
    { lineId: 'line-1', costLayerSnapshot: [] },
  ], updates)

  const updated = await refreshSalesOrderLineCogs(tx as never, ['line-1'])

  assert.equal(updated, 0)
  assert.deepEqual(updates, [])
})

test('refreshSalesOrderLineCogs preserves prior cogsBase when all shipment lines are un-snapshotted (legacy)', async () => {
  const updates: unknown[] = []
  const tx = refreshCogsTx([
    { lineId: 'line-1', costLayerSnapshot: [] },
    { lineId: 'line-1', costLayerSnapshot: [] },
  ], updates)

  const updated = await refreshSalesOrderLineCogs(tx as never, ['line-1'])

  assert.equal(updated, 0)
  assert.deepEqual(updates, [])
})

test('refreshSalesOrderLineCogs nulls cogsBase when a line has no shipment lines at all', async () => {
  const updates: unknown[] = []
  const tx = refreshCogsTx([], updates)

  const updated = await refreshSalesOrderLineCogs(tx as never, ['line-1'])

  assert.equal(updated, 1)
  assert.deepEqual(updates, [{ where: { id: 'line-1' }, data: { cogsBase: null } }])
})

test('recordCostLayerRevaluation logs a real basis change', async () => {
  const created: unknown[] = []
  const tx = {
    costLayerRevaluation: { findFirst: async () => null, create: async (args: { data: unknown }) => { created.push(args.data) } },
  }

  const logged = await recordCostLayerRevaluation(tx as never, {
    costLayerId: 'layer-1',
    oldUnitCostBase: '10',
    newUnitCostBase: '12.5',
    effectiveAt: new Date('2026-06-10T00:00:00.000Z'),
    reason: 'landed_cost_recalc',
  })

  assert.equal(logged, true)
  assert.deepEqual(created, [{
    costLayerId: 'layer-1',
    oldUnitCostBase: '10.000000',
    newUnitCostBase: '12.500000',
    effectiveAt: new Date('2026-06-10T00:00:00.000Z'),
    reason: 'landed_cost_recalc',
  }])
})

test('recordCostLayerRevaluation skips a no-op (old == new at 6dp)', async () => {
  const created: unknown[] = []
  const tx = {
    costLayerRevaluation: { findFirst: async () => null, create: async (args: { data: unknown }) => { created.push(args.data) } },
  }

  const logged = await recordCostLayerRevaluation(tx as never, {
    costLayerId: 'layer-1',
    oldUnitCostBase: '10.0000004',
    newUnitCostBase: '10.0000001',
    effectiveAt: new Date('2026-06-10T00:00:00.000Z'),
    reason: 'fx_rebase',
  })

  assert.equal(logged, false)
  assert.equal(created.length, 0)
})

test('updateCostLayerUnitCost updates the layer and logs the delta, returning the old cost', async () => {
  const updates: unknown[] = []
  const created: unknown[] = []
  const tx = {
    costLayer: {
      findUnique: async () => ({ unitCostBase: '8' }),
      update: async (args: unknown) => { updates.push(args) },
    },
    costLayerRevaluation: { findFirst: async () => null, create: async (args: { data: unknown }) => { created.push(args.data) } },
  }

  const oldUnit = await updateCostLayerUnitCost(tx as never, 'layer-1', '9.25', {
    effectiveAt: new Date('2026-06-11T00:00:00.000Z'),
    reason: 'manufacturing_recompute',
  })

  assert.equal(oldUnit.toString(), '8')
  assert.deepEqual(updates, [{ where: { id: 'layer-1' }, data: { unitCostBase: '9.250000' } }])
  assert.deepEqual(created, [{
    costLayerId: 'layer-1',
    oldUnitCostBase: '8.000000',
    newUnitCostBase: '9.250000',
    effectiveAt: new Date('2026-06-11T00:00:00.000Z'),
    reason: 'manufacturing_recompute',
  }])
})

test('updateCostLayerUnitCost updates but logs nothing when the cost is unchanged', async () => {
  const updates: unknown[] = []
  const created: unknown[] = []
  const tx = {
    costLayer: {
      findUnique: async () => ({ unitCostBase: '9.25' }),
      update: async (args: unknown) => { updates.push(args) },
    },
    costLayerRevaluation: { findFirst: async () => null, create: async (args: { data: unknown }) => { created.push(args.data) } },
  }

  await updateCostLayerUnitCost(tx as never, 'layer-1', '9.25', {
    effectiveAt: new Date('2026-06-11T00:00:00.000Z'),
    reason: 'landed_cost_recalc',
  })

  assert.equal(updates.length, 1)
  assert.equal(created.length, 0)
})

test('recordCostLayerRevaluation coalesces a repeat for the same layer+run into one net event', async () => {
  const updates: unknown[] = []
  const created: unknown[] = []
  const tx = {
    costLayerRevaluation: {
      findFirst: async () => ({ id: 'rev-1', oldUnitCostBase: '5' }),
      create: async (args: { data: unknown }) => { created.push(args.data) },
      update: async (args: unknown) => { updates.push(args) },
      delete: async () => { throw new Error('should not delete on a real net change') },
    },
  }

  // First event recorded 5->6 (returned by findFirst); now 6->7 in the same run.
  const logged = await recordCostLayerRevaluation(tx as never, {
    costLayerId: 'layer-1',
    oldUnitCostBase: '6',
    newUnitCostBase: '7',
    effectiveAt: new Date('2026-06-12T00:00:00.000Z'),
    reason: 'landed_cost_output_propagation',
  })

  assert.equal(logged, true)
  assert.equal(created.length, 0)
  // Keeps the original old (5), advances new to 7 → net 5->7.
  assert.deepEqual(updates, [{ where: { id: 'rev-1' }, data: { newUnitCostBase: '7.000000' } }])
})

test('recordCostLayerRevaluation drops a coalesced net no-op (5->6->5)', async () => {
  const deleted: unknown[] = []
  const tx = {
    costLayerRevaluation: {
      findFirst: async () => ({ id: 'rev-1', oldUnitCostBase: '5' }),
      create: async () => { throw new Error('should not create') },
      update: async () => { throw new Error('should not update on a net no-op') },
      delete: async (args: unknown) => { deleted.push(args) },
    },
  }

  const logged = await recordCostLayerRevaluation(tx as never, {
    costLayerId: 'layer-1',
    oldUnitCostBase: '6',
    newUnitCostBase: '5',
    effectiveAt: new Date('2026-06-12T00:00:00.000Z'),
    reason: 'landed_cost_recalc',
  })

  assert.equal(logged, true)
  assert.deepEqual(deleted, [{ where: { id: 'rev-1' } }])
})
