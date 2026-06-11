import assert from 'node:assert/strict'
import test from 'node:test'

import { Prisma, type PurchaseOrderStatus } from '@/app/generated/prisma/client'
import { cancelPurchaseOrder, type CancelPurchaseOrderDeps } from '@/app/actions/purchase-orders'
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
    qty: (entry as { qty: string }).qty,
    totalCostBase: (entry as { totalCostBase: string }).totalCostBase,
  })), [
    { costLayerId: 'layer-1', movementId: 'movement-1', qty: '2.000000', totalCostBase: '10.500000' },
    { costLayerId: 'layer-2', movementId: 'movement-2', qty: '3.000000', totalCostBase: '12.000000' },
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

test('cancelPurchaseOrder action is idempotent when called twice', async () => {
  const po: { status: PurchaseOrderStatus; reference: string } = { status: 'PARTIALLY_RECEIVED', reference: 'PO-1' }
  const logs: Array<{ action: string; description: string }> = []
  const revalidated: string[] = []
  const accountingSyncs: unknown[] = []
  const stockSyncs: Array<{ productIds: string[]; reason: string }> = []
  let transactionCalls = 0
  let reversalCalls = 0

  const tx = {
    purchaseOrder: {
      findUnique: async () => ({
        status: po.status,
        reference: po.reference,
        lines: [{ id: 'po-line-1' }],
        _count: { invoices: 0 },
      }),
      update: async ({ data }: { data: { status: typeof po.status } }) => {
        po.status = data.status
        return { id: 'po-1' }
      },
    },
  }
  const deps: CancelPurchaseOrderDeps = {
    requirePermission: async () => ({ user: { id: 'user-1', role: 'ADMIN' } }) as never,
    findPurchaseOrderFast: async () => ({ status: po.status, reference: po.reference }),
    transaction: async (fn) => {
      transactionCalls += 1
      return fn(tx as never)
    },
    revalidatePath: (path) => {
      revalidated.push(path)
    },
    logActivity: async (input) => {
      logs.push({ action: input.action, description: input.description })
    },
    enqueueStockSync: async (productIds, reason) => {
      stockSyncs.push({ productIds, reason })
    },
    getAccountingSettings: async () => ({
      syncEnabled: true,
      transitAccount: '140',
      inventoryAccount: '120',
    }) as never,
    queueAccountingSyncTx: async (_tx, input) => {
      accountingSyncs.push(input)
      return { id: `sync-${accountingSyncs.length}` } as never
    },
    reversePurchaseOrderCostLayersForCancellation: async () => {
      reversalCalls += 1
      return {
        reversedLayers: [{
          costLayerId: 'layer-1',
          poLineId: 'po-line-1',
          productId: 'product-1',
          warehouseId: 'warehouse-1',
          qty: '2.000000',
          unitCostBase: '5.000000',
          totalValueBase: '10.000000',
        }],
        productIds: ['product-1'],
        totalReversalValueBase: new Prisma.Decimal('10'),
      }
    },
  }

  assert.deepEqual(await cancelPurchaseOrder('po-1', deps), {
    success: true,
    reversedCostLayers: [{
      costLayerId: 'layer-1',
      poLineId: 'po-line-1',
      productId: 'product-1',
      warehouseId: 'warehouse-1',
      qty: '2.000000',
      unitCostBase: '5.000000',
      totalValueBase: '10.000000',
    }],
    notice: 'Cancelled PO and reversed 1 remaining receipt cost layer(s).',
  })
  assert.equal(po.status, 'CANCELLED')

  assert.deepEqual(await cancelPurchaseOrder('po-1', deps), { success: true })

  assert.equal(transactionCalls, 1)
  assert.equal(reversalCalls, 1)
  assert.equal(accountingSyncs.length, 1)
  assert.deepEqual(stockSyncs, [{ productIds: ['product-1'], reason: 'IMS_CHANGE' }])
  assert.deepEqual(logs.map((log) => log.action), ['cancelled', 'cancelled_noop'])
  assert.equal(logs.filter((log) => log.action === 'cancelled').length, 1)
  assert.deepEqual(revalidated, [
    '/purchase-orders',
    '/purchase-orders/po-1',
    '/purchase-orders',
    '/purchase-orders/po-1',
  ])
})
