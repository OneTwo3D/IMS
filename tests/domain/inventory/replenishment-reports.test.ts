import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Prisma, ProductType } from '@/app/generated/prisma/client'
import {
  getBackorderDemandReport,
  getComponentShortageReport,
  getReorderReport,
  type ReplenishmentReportClient,
} from '@/lib/domain/inventory/replenishment-reports'
import { SourceScanTooLargeError } from '@/lib/security/source-scan-error'

function decimal(value: string | number): Prisma.Decimal {
  return new Prisma.Decimal(value)
}

function unusedClient(): ReplenishmentReportClient {
  const unused = { findMany: async () => [] }
  return {
    product: unused,
    stockLevel: unused,
    stockMovement: unused,
    purchaseOrderLine: unused,
    purchaseReceipt: unused,
    salesOrderLine: unused,
    orderAllocation: unused,
    shipmentLine: unused,
    productionOrder: unused,
  }
}

const category = { id: 'category-1', name: 'Finished goods' }
const supplier = { name: 'Supplier A' }

test('reorder report throws a typed source-scan error at the source row cap', async () => {
  const client: ReplenishmentReportClient = {
    ...unusedClient(),
    product: {
      findMany: async () => Array.from({ length: 50001 }, (_, index) => ({ id: `product-${index}` })),
    },
  }

  await assert.rejects(
    getReorderReport({}, { deps: { client, now: () => new Date('2026-06-30T00:00:00.000Z') } }),
    (error: unknown) => error instanceof SourceScanTooLargeError && /Replenishment product source rows exceed 50,000/.test(error.message),
  )
})

test('reorder report nets available and inbound open PO against lead-time demand', async () => {
  const client: ReplenishmentReportClient = {
    ...unusedClient(),
    product: {
      findMany: async () => [{
        id: 'product-1',
        sku: 'SKU-1',
        name: 'Widget',
        type: ProductType.SIMPLE,
        stockUnit: 'pcs',
        reorderPoint: null,
        reorderQty: decimal('12'),
        safetyStockQty: decimal('5'),
        abcClass: 'A',
        category,
        supplierProducts: [{
          supplierId: 'supplier-1',
          supplierSku: 'SUP-SKU-1',
          lastUnitCost: decimal('2'),
          leadTimeDays: 10,
          supplier,
        }],
      }],
    },
    stockLevel: {
      findMany: async () => [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: decimal('4'), reservedQty: decimal('1') }],
    },
    stockMovement: {
      findMany: async () => [{
        productId: 'product-1',
        qty: decimal('90'),
        totalValueBase: decimal('180'),
        createdAt: new Date('2026-06-01T12:00:00.000Z'),
        product: { sku: 'SKU-1', name: 'Widget', category, supplierProducts: [{ supplier }] },
      }],
    },
    purchaseOrderLine: {
      findMany: async () => [{
        productId: 'product-1',
        qty: decimal('10'),
        qtyReceived: decimal('4'),
        qtyReturned: decimal('0'),
        po: { supplierId: 'supplier-1', expectedDelivery: new Date('2026-06-10T00:00:00.000Z'), destinationWarehouseId: 'warehouse-1', supplier },
      }],
    },
  }

  const report = await getReorderReport(
    { thresholdDays: 90 },
    { deps: { client, now: () => new Date('2026-06-01T18:00:00.000Z') } },
  )

  assert.equal(report.rows.length, 1)
  assert.equal(report.rows[0]?.averageDailyDemand, '1')
  assert.equal(report.rows[0]?.availableQty, '3')
  assert.equal(report.rows[0]?.warehouseAvailabilityBreakdown, 'warehouse-1: 3')
  assert.equal(report.rows[0]?.inboundOpenPoQty, '6')
  assert.equal(report.rows[0]?.reorderPoint, '15')
  assert.equal(report.rows[0]?.suggestedReorderQty, '12')
  assert.equal(report.rows[0]?.leadTimeDays, 10)
  assert.equal(report.rows[0]?.urgency, 'reorder')
})

test('reorder report ignores non-stock product type filters', async () => {
  const client: ReplenishmentReportClient = {
    ...unusedClient(),
    product: {
      findMany: async (args?: unknown) => {
        const where = (args as { where: { type: { in: ProductType[] } } }).where
        assert.deepEqual(where.type.in, [
          ProductType.SIMPLE,
          ProductType.VARIANT,
          ProductType.KIT,
          ProductType.BOM,
        ])
        return []
      },
    },
  }

  const report = await getReorderReport(
    { productType: ProductType.NON_INVENTORY },
    { deps: { client, now: () => new Date('2026-06-01T18:00:00.000Z') } },
  )

  assert.equal(report.rows.length, 0)
})

test('reorder report treats configured reorderQty zero as opt-out', async () => {
  const client: ReplenishmentReportClient = {
    ...unusedClient(),
    product: {
      findMany: async () => [{
        id: 'product-1',
        sku: 'SKU-1',
        name: 'Widget',
        type: ProductType.SIMPLE,
        stockUnit: 'pcs',
        reorderPoint: decimal('10'),
        reorderQty: decimal('0'),
        safetyStockQty: decimal('0'),
        abcClass: null,
        category,
        supplierProducts: [],
      }],
    },
    stockLevel: {
      findMany: async () => [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: decimal('0'), reservedQty: decimal('0') }],
    },
  }

  const report = await getReorderReport({}, { deps: { client, now: () => new Date('2026-06-01T00:00:00.000Z') } })

  assert.equal(report.rows.length, 0)
})

test('reorder report suppresses critical urgency when inbound covers a zero-stock SKU', async () => {
  const client: ReplenishmentReportClient = {
    ...unusedClient(),
    product: {
      findMany: async () => [{
        id: 'product-1',
        sku: 'SKU-1',
        name: 'Widget',
        type: ProductType.SIMPLE,
        stockUnit: 'pcs',
        reorderPoint: decimal('10'),
        reorderQty: decimal('12'),
        safetyStockQty: decimal('0'),
        abcClass: 'B',
        category,
        supplierProducts: [],
      }],
    },
    stockLevel: {
      findMany: async () => [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: decimal('0'), reservedQty: decimal('0') }],
    },
    purchaseOrderLine: {
      findMany: async () => [{
        productId: 'product-1',
        qty: decimal('100'),
        qtyReceived: decimal('0'),
        qtyReturned: decimal('0'),
        po: { supplierId: 'supplier-1', expectedDelivery: null, destinationWarehouseId: 'warehouse-1', supplier },
      }],
    },
  }

  const report = await getReorderReport({}, { deps: { client, now: () => new Date('2026-06-01T00:00:00.000Z') } })

  assert.equal(report.rows.length, 0)
  assert.match(report.notices.join(' '), /projected available stock/)
})

test('reorder report falls back to observed supplier-product P95 lead time when configured lead time is absent', async () => {
  const client: ReplenishmentReportClient = {
    ...unusedClient(),
    product: {
      findMany: async () => [{
        id: 'product-1',
        sku: 'SKU-1',
        name: 'Widget',
        type: ProductType.SIMPLE,
        stockUnit: 'pcs',
        reorderPoint: null,
        reorderQty: null,
        safetyStockQty: decimal('0'),
        abcClass: null,
        category,
        supplierProducts: [{
          supplierId: 'supplier-1',
          supplierSku: 'SUP-SKU-1',
          lastUnitCost: decimal('2'),
          leadTimeDays: null,
          supplier,
        }],
      }],
    },
    stockLevel: {
      findMany: async () => [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: decimal('0'), reservedQty: decimal('0') }],
    },
    stockMovement: {
      findMany: async () => [{
        productId: 'product-1',
        qty: decimal('90'),
        totalValueBase: decimal('180'),
        createdAt: new Date('2026-06-01T12:00:00.000Z'),
        product: { sku: 'SKU-1', name: 'Widget', category, supplierProducts: [{ supplier }] },
      }],
    },
    purchaseReceipt: {
      findMany: async () => [
        {
          id: 'receipt-1',
          receivedAt: new Date('2026-05-11T00:00:00.000Z'),
          po: { id: 'po-1', reference: 'PO-1', supplierId: 'supplier-1', expectedDelivery: null, poSentAt: new Date('2026-05-01T00:00:00.000Z'), createdAt: new Date('2026-05-01T00:00:00.000Z'), supplier },
          lines: [{ poLineId: 'line-1', qtyReceived: decimal('1'), poLine: { qty: decimal('1'), productId: 'product-1', product: { sku: 'SKU-1', name: 'Widget', category } } }],
        },
        {
          id: 'receipt-2',
          receivedAt: new Date('2026-05-21T00:00:00.000Z'),
          po: { id: 'po-2', reference: 'PO-2', supplierId: 'supplier-1', expectedDelivery: null, poSentAt: new Date('2026-05-01T00:00:00.000Z'), createdAt: new Date('2026-05-01T00:00:00.000Z'), supplier },
          lines: [{ poLineId: 'line-2', qtyReceived: decimal('1'), poLine: { qty: decimal('1'), productId: 'product-1', product: { sku: 'SKU-1', name: 'Widget', category } } }],
        },
      ],
    },
  }

  const report = await getReorderReport(
    { thresholdDays: 90 },
    { deps: { client, now: () => new Date('2026-06-01T18:00:00.000Z') } },
  )

  assert.equal(report.rows[0]?.leadTimeDays, 20)
  assert.equal(report.rows[0]?.reorderPoint, '20')
})

test('reorder report surfaces default lead-time fallback and invalid ABC class notice', async () => {
  const client: ReplenishmentReportClient = {
    ...unusedClient(),
    product: {
      findMany: async (args?: unknown) => {
        const supplierProducts = (args as { select: { supplierProducts: { orderBy: unknown } } }).select.supplierProducts
        assert.deepEqual(supplierProducts.orderBy, [{ lastUnitCost: 'asc' }, { updatedAt: 'desc' }])
        return [{
          id: 'product-1',
          sku: 'SKU-1',
          name: 'Widget',
          type: ProductType.SIMPLE,
          stockUnit: 'pcs',
          reorderPoint: decimal('1'),
          reorderQty: null,
          safetyStockQty: decimal('0'),
          abcClass: 'z',
          category,
          supplierProducts: [],
        }]
      },
    },
    stockLevel: {
      findMany: async () => [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: decimal('0'), reservedQty: decimal('0') }],
    },
  }

  const report = await getReorderReport({}, { deps: { client, now: () => new Date('2026-06-01T00:00:00.000Z') } })

  assert.equal(report.rows[0]?.abcClass, null)
  assert.equal(report.rows[0]?.leadTimeDays, 14)
  assert.match(report.notices.join(' '), /Default 14-day lead time/)
  assert.match(report.notices.join(' '), /Ignored invalid abcClass/)
})

test('reorder report caps velocity source rows', async () => {
  const client: ReplenishmentReportClient = {
    ...unusedClient(),
    product: { findMany: async () => [] },
    stockMovement: {
      findMany: async () => Array.from({ length: 50001 }, (_, index) => ({
        productId: `product-${index}`,
        qty: decimal('1'),
        totalValueBase: decimal('1'),
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
        product: { sku: `SKU-${index}`, name: 'Widget', category, supplierProducts: [] },
      })),
    },
  }

  await assert.rejects(
    () => getReorderReport({}, { deps: { client, now: () => new Date('2026-06-01T00:00:00.000Z') } }),
    /source rows exceed 50,000/,
  )
})

test('backorder report aggregates active sales demand not covered by committed shipments and allocations', async () => {
  const client: ReplenishmentReportClient = {
    ...unusedClient(),
    salesOrderLine: {
      findMany: async () => [
        {
          id: 'line-1',
          orderId: 'order-1',
          productId: 'product-1',
          sku: 'SKU-1',
          description: 'Widget',
          qty: decimal('10'),
          order: { orderNumber: 'SO-1', createdAt: new Date('2026-05-01T00:00:00.000Z'), expectedDelivery: null, status: 'PROCESSING' },
          product: { id: 'product-1', sku: 'SKU-1', name: 'Widget', type: ProductType.SIMPLE, stockUnit: 'pcs', category, supplierProducts: [{ supplier }] },
        },
        {
          id: 'line-2',
          orderId: 'order-2',
          productId: 'product-1',
          sku: 'SKU-1',
          description: 'Widget',
          qty: decimal('3'),
          order: { orderNumber: 'SO-2', createdAt: new Date('2026-05-03T00:00:00.000Z'), expectedDelivery: null, status: 'ALLOCATED' },
          product: { id: 'product-1', sku: 'SKU-1', name: 'Widget', type: ProductType.SIMPLE, stockUnit: 'pcs', category, supplierProducts: [{ supplier }] },
        },
      ],
    },
    orderAllocation: {
      findMany: async (args?: unknown) => {
        assert.deepEqual((args as { where: { lineId: { in: string[] } } }).where.lineId.in.sort(), ['line-1', 'line-2'])
        return [{ lineId: 'line-1', qty: decimal('4') }]
      },
    },
    shipmentLine: {
      findMany: async () => [{ lineId: 'line-1', qty: decimal('2'), shipment: { status: 'PACKED' } }],
    },
    purchaseOrderLine: {
      findMany: async () => [{
        productId: 'product-1',
        qty: decimal('20'),
        qtyReceived: decimal('5'),
        qtyReturned: decimal('0'),
        po: { supplierId: 'supplier-1', expectedDelivery: new Date('2026-05-20T00:00:00.000Z'), destinationWarehouseId: null, supplier },
      }],
    },
  }

  const report = await getBackorderDemandReport({}, { deps: { client, now: () => new Date('2026-06-01T00:00:00.000Z') } })

  assert.equal(report.rows.length, 1)
  assert.equal(report.rows[0]?.orderCount, 2)
  assert.equal(report.rows[0]?.orderedQty, '13')
  assert.equal(report.rows[0]?.committedQty, '2')
  assert.equal(report.rows[0]?.allocatedQty, '2')
  assert.equal(report.rows[0]?.backorderQty, '9')
  assert.equal(report.rows[0]?.inboundOpenPoQty, '15')
  assert.equal(report.rows[0]?.projectedFillDate, '2026-05-20')
  assert.match(report.notices.join(' '), /Unassigned inbound POs/)
})

test('component shortage report includes draft and in-progress production demand', async () => {
  const client: ReplenishmentReportClient = {
    ...unusedClient(),
    productionOrder: {
      findMany: async () => [
        {
          id: 'prod-1',
          reference: 'MO-1',
          status: 'DRAFT',
          warehouseId: 'warehouse-1',
          qtyPlanned: decimal('10'),
          qtyProduced: decimal('2'),
          scheduledAt: new Date('2026-06-15T00:00:00.000Z'),
          outputProduct: { sku: 'BOM-1', name: 'Assembly' },
          warehouse: { code: 'WH1', name: 'Main warehouse' },
          bom: {
            items: [{
              componentProductId: 'component-1',
              qty: decimal('2'),
              component: { id: 'component-1', sku: 'COMP-1', name: 'Component', type: ProductType.SIMPLE, stockUnit: 'pcs', category, supplierProducts: [{ supplier }] },
            }],
          },
        },
        {
          id: 'prod-2',
          reference: 'MO-2',
          status: 'IN_PROGRESS',
          warehouseId: 'warehouse-1',
          qtyPlanned: decimal('3'),
          qtyProduced: decimal('0'),
          scheduledAt: new Date('2026-06-10T00:00:00.000Z'),
          outputProduct: { sku: 'BOM-2', name: 'Second assembly' },
          warehouse: { code: 'WH1', name: 'Main warehouse' },
          bom: {
            items: [{
              componentProductId: 'component-1',
              qty: decimal('1'),
              component: { id: 'component-1', sku: 'COMP-1', name: 'Component', type: ProductType.SIMPLE, stockUnit: 'pcs', category, supplierProducts: [{ supplier }] },
            }],
          },
        },
      ],
    },
    stockLevel: {
      findMany: async () => [{ productId: 'component-1', warehouseId: 'warehouse-1', quantity: decimal('8'), reservedQty: decimal('1') }],
    },
    purchaseOrderLine: {
      findMany: async () => [{
        productId: 'component-1',
        qty: decimal('4'),
        qtyReceived: decimal('1'),
        qtyReturned: decimal('0'),
        po: { supplierId: 'supplier-1', expectedDelivery: null, destinationWarehouseId: 'warehouse-1', supplier },
      }],
    },
  }

  const report = await getComponentShortageReport({}, { deps: { client, now: () => new Date('2026-06-01T00:00:00.000Z') } })

  assert.equal(report.rows.length, 1)
  assert.equal(report.rows[0]?.productionOrderCount, 2)
  assert.equal(report.rows[0]?.requiredQty, '19')
  assert.equal(report.rows[0]?.availableQty, '7')
  assert.equal(report.rows[0]?.inboundOpenPoQty, '3')
  assert.equal(report.rows[0]?.shortageQty, '9')
  assert.deepEqual(report.rows[0]?.outputProducts, ['BOM-1 Assembly', 'BOM-2 Second assembly'])
  assert.equal(report.rows[0]?.earliestScheduledAt?.slice(0, 10), '2026-06-10')
  assert.match(report.notices.join(' '), /without a destination warehouse/)
})
