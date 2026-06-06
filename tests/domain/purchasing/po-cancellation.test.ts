import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import {
  assertPurchaseOrderCancellationHasNoInvoices,
  isPurchaseOrderCancellationNoop,
  reversePurchaseOrderCostLayersForCancellation,
} from '@/lib/domain/purchasing/po-cancellation'

type CostLayerRow = {
  id: string
  poLineId: string | null
  productId: string
  warehouseId: string
  remainingQty: Prisma.Decimal
  unitCostBase: Prisma.Decimal
}

type StockLevelRow = {
  productId: string
  warehouseId: string
  quantity: Prisma.Decimal
  reservedQty: Prisma.Decimal
}

function createTx(state: {
  costLayers: CostLayerRow[]
  stockLevels: StockLevelRow[]
}) {
  const movements: unknown[] = []
  const cogsEntries: unknown[] = []
  const costLayerUpdates: Array<{ where: { id: string }; data: { remainingQty: number } }> = []
  const stockLevelUpdates: Array<{
    where: { productId_warehouseId: { productId: string; warehouseId: string } }
    data: { quantity: { decrement: number } }
  }> = []
  const lockedStockLevels: unknown[] = []

  const tx = {
    $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      if (Array.isArray(values[0])) {
        const lineIds = values[0] as string[]
        return state.costLayers
          .filter((layer) => layer.poLineId && lineIds.includes(layer.poLineId))
          .filter((layer) => layer.remainingQty.gt(0))
      }
      const [productId, warehouseId] = values as [string, string]
      lockedStockLevels.push({ productId, warehouseId })
      return []
    },
    stockMovement: {
      create: async (args: { data: unknown }) => {
        movements.push(args.data)
        return { id: `movement-${movements.length}` }
      },
    },
    cogsEntry: {
      create: async (args: { data: unknown }) => {
        cogsEntries.push(args.data)
      },
    },
    stockLevel: {
      findUnique: async ({ where }: { where: { productId_warehouseId: { productId: string; warehouseId: string } } }) => (
        state.stockLevels.find((level) => (
          level.productId === where.productId_warehouseId.productId &&
          level.warehouseId === where.productId_warehouseId.warehouseId
        )) ?? null
      ),
      update: async (args: {
        where: { productId_warehouseId: { productId: string; warehouseId: string } }
        data: { quantity: { decrement: number } }
      }) => {
        stockLevelUpdates.push(args)
        const row = state.stockLevels.find((level) => (
          level.productId === args.where.productId_warehouseId.productId &&
          level.warehouseId === args.where.productId_warehouseId.warehouseId
        ))
        if (row) row.quantity = row.quantity.sub(args.data.quantity.decrement)
      },
    },
    costLayer: {
      update: async (args: { where: { id: string }; data: { remainingQty: number } }) => {
        costLayerUpdates.push(args)
        const row = state.costLayers.find((layer) => layer.id === args.where.id)
        if (row) row.remainingQty = new Prisma.Decimal(args.data.remainingQty)
      },
    },
  }

  return { tx, movements, cogsEntries, costLayerUpdates, stockLevelUpdates, lockedStockLevels }
}

test('reversePurchaseOrderCostLayersForCancellation reverses remaining PO cost layers', async () => {
  const state = {
    costLayers: [
      {
        id: 'layer-1',
        poLineId: 'po-line-1',
        productId: 'product-1',
        warehouseId: 'warehouse-1',
        remainingQty: new Prisma.Decimal('2'),
        unitCostBase: new Prisma.Decimal('5.25'),
      },
      {
        id: 'layer-2',
        poLineId: 'po-line-2',
        productId: 'product-2',
        warehouseId: 'warehouse-1',
        remainingQty: new Prisma.Decimal('3'),
        unitCostBase: new Prisma.Decimal('4'),
      },
      {
        id: 'consumed-layer',
        poLineId: 'po-line-2',
        productId: 'product-2',
        warehouseId: 'warehouse-1',
        remainingQty: new Prisma.Decimal('0'),
        unitCostBase: new Prisma.Decimal('4'),
      },
    ],
    stockLevels: [
      {
        productId: 'product-1',
        warehouseId: 'warehouse-1',
        quantity: new Prisma.Decimal('10'),
        reservedQty: new Prisma.Decimal('1'),
      },
      {
        productId: 'product-2',
        warehouseId: 'warehouse-1',
        quantity: new Prisma.Decimal('8'),
        reservedQty: new Prisma.Decimal('0'),
      },
    ],
  }
  const { tx, movements, cogsEntries, costLayerUpdates, stockLevelUpdates, lockedStockLevels } = createTx(state)

  const result = await reversePurchaseOrderCostLayersForCancellation(tx as never, {
    poId: 'po-1',
    poReference: 'PO-1',
    poLineIds: ['po-line-1', 'po-line-2'],
  })

  assert.deepEqual(result.productIds.sort(), ['product-1', 'product-2'])
  assert.equal(result.totalReversalValueBase.toString(), '22.5')
  assert.deepEqual(result.reversedLayers.map((layer) => ({
    costLayerId: layer.costLayerId,
    qty: layer.qty,
    unitCostBase: layer.unitCostBase,
    totalValueBase: layer.totalValueBase,
  })), [
    { costLayerId: 'layer-1', qty: '2', unitCostBase: '5.25', totalValueBase: '10.5' },
    { costLayerId: 'layer-2', qty: '3', unitCostBase: '4', totalValueBase: '12' },
  ])
  assert.equal(state.costLayers[0].remainingQty.toString(), '0')
  assert.equal(state.costLayers[1].remainingQty.toString(), '0')
  assert.equal(state.stockLevels[0].quantity.toString(), '8')
  assert.equal(state.stockLevels[1].quantity.toString(), '5')
  assert.deepEqual(lockedStockLevels, [
    { productId: 'product-1', warehouseId: 'warehouse-1' },
    { productId: 'product-2', warehouseId: 'warehouse-1' },
  ])
  assert.deepEqual(costLayerUpdates.map((args) => args.where.id), ['layer-1', 'layer-2'])
  assert.deepEqual(stockLevelUpdates.map((args) => args.data.quantity.decrement), [2, 3])
  assert.deepEqual(movements.map((movement) => ({
    type: (movement as { type: string }).type,
    productId: (movement as { productId: string }).productId,
    fromWarehouseId: (movement as { fromWarehouseId: string }).fromWarehouseId,
    qty: (movement as { qty: number }).qty,
    unitCostBase: (movement as { unitCostBase: string }).unitCostBase,
    totalValueBase: (movement as { totalValueBase: string }).totalValueBase,
    referenceType: (movement as { referenceType: string }).referenceType,
    referenceId: (movement as { referenceId: string }).referenceId,
  })), [
    {
      type: 'PURCHASE_REVERSAL',
      productId: 'product-1',
      fromWarehouseId: 'warehouse-1',
      qty: 2,
      unitCostBase: '5.250000',
      totalValueBase: '10.500000',
      referenceType: 'PurchaseOrder',
      referenceId: 'po-1',
    },
    {
      type: 'PURCHASE_REVERSAL',
      productId: 'product-2',
      fromWarehouseId: 'warehouse-1',
      qty: 3,
      unitCostBase: '4.000000',
      totalValueBase: '12.000000',
      referenceType: 'PurchaseOrder',
      referenceId: 'po-1',
    },
  ])
  assert.deepEqual(cogsEntries.map((entry) => ({
    costLayerId: (entry as { costLayerId: string }).costLayerId,
    movementId: (entry as { movementId: string }).movementId,
    qty: (entry as { qty: number }).qty,
    totalCostBase: (entry as { totalCostBase: number }).totalCostBase,
  })), [
    { costLayerId: 'layer-1', movementId: 'movement-1', qty: 2, totalCostBase: 10.5 },
    { costLayerId: 'layer-2', movementId: 'movement-2', qty: 3, totalCostBase: 12 },
  ])
})

test('reversePurchaseOrderCostLayersForCancellation rejects reserved stock that cannot be reversed', async () => {
  const { tx } = createTx({
    costLayers: [{
      id: 'layer-1',
      poLineId: 'po-line-1',
      productId: 'product-1',
      warehouseId: 'warehouse-1',
      remainingQty: new Prisma.Decimal('4'),
      unitCostBase: new Prisma.Decimal('5'),
    }],
    stockLevels: [{
      productId: 'product-1',
      warehouseId: 'warehouse-1',
      quantity: new Prisma.Decimal('5'),
      reservedQty: new Prisma.Decimal('2'),
    }],
  })

  await assert.rejects(
    () => reversePurchaseOrderCostLayersForCancellation(tx as never, {
      poId: 'po-1',
      poReference: 'PO-1',
      poLineIds: ['po-line-1'],
    }),
    /stock is reserved and cannot be reversed automatically/,
  )
})

test('assertPurchaseOrderCancellationHasNoInvoices rejects billed purchase orders', () => {
  assert.doesNotThrow(() => assertPurchaseOrderCancellationHasNoInvoices(0))
  assert.throws(
    () => assertPurchaseOrderCancellationHasNoInvoices(1),
    /Cannot cancel a purchase order after supplier invoices have been recorded/,
  )
})

test('isPurchaseOrderCancellationNoop treats already cancelled purchase orders as idempotent', () => {
  assert.equal(isPurchaseOrderCancellationNoop('CANCELLED'), true)
  assert.equal(isPurchaseOrderCancellationNoop('PO_SENT'), false)
  assert.equal(isPurchaseOrderCancellationNoop('RECEIVED'), false)
})

test('cancelPurchaseOrder action wires already-cancelled no-op before the stock transaction', () => {
  const source = readFileSync(join(process.cwd(), 'app/actions/purchase-orders.ts'), 'utf8')
  const fastPathIndex = source.indexOf('isPurchaseOrderCancellationNoop(fastExisting.status)')
  const transactionIndex = source.indexOf('const cancellation = await db.$transaction')

  assert.notEqual(fastPathIndex, -1)
  assert.notEqual(transactionIndex, -1)
  assert.ok(fastPathIndex < transactionIndex, 'expected no-op status check before stock transaction')
  assert.match(source, /select:\s*\{\s*status:\s*true,\s*reference:\s*true\s*\}/)
  assert.match(source, /action:\s*'cancelled_noop'/)
})
