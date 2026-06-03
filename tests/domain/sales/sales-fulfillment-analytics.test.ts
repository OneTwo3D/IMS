import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Prisma, ProductType, SalesOrderStatus, ShipmentStatus } from '@/app/generated/prisma/client'
import {
  getFulfillmentAnalyticsReport,
  getMarginAnalyticsReport,
  getReturnsAnalyticsReport,
  getSalesAnalyticsReport,
  getThroughputAnalyticsReport,
  type SalesFulfillmentAnalyticsClient,
} from '@/lib/domain/sales/sales-fulfillment-analytics'

function decimal(value: string | number): Prisma.Decimal {
  return new Prisma.Decimal(value)
}

function unusedClient(): SalesFulfillmentAnalyticsClient {
  const unused = { findMany: async () => [] }
  return {
    salesOrder: unused,
    salesOrderRefund: unused,
    salesOrderRefundLine: unused,
    cogsEntry: unused,
    stockMovement: unused,
    shipment: unused,
    activityLog: unused,
  }
}

const product = {
  id: 'product-1',
  sku: 'SKU-1',
  name: 'Widget',
  type: ProductType.SIMPLE,
  category: { name: 'Widgets' },
}

test('sales product grouping allocates order totals so revenue reconciles to SalesOrder totals', async () => {
  const client: SalesFulfillmentAnalyticsClient = {
    ...unusedClient(),
    salesOrder: {
      findMany: async () => [{
        id: 'order-1',
        status: SalesOrderStatus.PROCESSING,
        currency: 'GBP',
        customerId: 'customer-1',
        customerName: 'Customer A',
        customerEmail: 'a@example.com',
        createdAt: new Date('2026-06-01T12:00:00.000Z'),
        expectedDelivery: null,
        paidAt: null,
        totalForeign: decimal('132'),
        totalBase: decimal('132'),
        taxForeign: decimal('22'),
        taxBase: decimal('22'),
        shippingForeign: decimal('10'),
        shippingBase: decimal('10'),
        discountAmount: decimal('5'),
        shoppingLinks: [{ connector: 'woocommerce' }],
        lines: [
          { id: 'line-1', productId: 'product-1', sku: 'SKU-1', description: 'Widget', qty: decimal('1'), totalForeign: decimal('60'), totalBase: decimal('60'), taxForeign: decimal('10'), taxBase: decimal('10'), discountAmount: decimal('2'), product },
          { id: 'line-2', productId: 'product-2', sku: 'SKU-2', description: 'Second', qty: decimal('1'), totalForeign: decimal('60'), totalBase: decimal('60'), taxForeign: decimal('10'), taxBase: decimal('10'), discountAmount: decimal('3'), product: { ...product, id: 'product-2', sku: 'SKU-2', name: 'Second' } },
        ],
      }],
    },
  }

  const report = await getSalesAnalyticsReport(
    { dateFrom: '2026-06-01', dateTo: '2026-06-01', groupBy: 'product' },
    { client, now: () => new Date('2026-06-01T15:00:00.000Z') },
  )

  assert.equal(report.rows.length, 2)
  assert.equal(report.totals.revenue, '132')
  assert.equal(report.rows[0]?.revenue, '66')
  assert.equal(report.rows[1]?.revenue, '66')
})

test('gross margin report uses CogsEntry totals without recalculating FIFO', async () => {
  const client: SalesFulfillmentAnalyticsClient = {
    ...unusedClient(),
    salesOrder: {
      findMany: async () => [{
        id: 'order-1',
        status: SalesOrderStatus.SHIPPED,
        currency: 'GBP',
        customerId: null,
        customerName: 'Customer A',
        customerEmail: null,
        createdAt: new Date('2026-06-01T12:00:00.000Z'),
        expectedDelivery: null,
        paidAt: new Date('2026-06-02T00:00:00.000Z'),
        totalForeign: decimal('120'),
        totalBase: decimal('120'),
        taxForeign: decimal('20'),
        taxBase: decimal('20'),
        shippingForeign: decimal('0'),
        shippingBase: decimal('0'),
        discountAmount: decimal('0'),
        shoppingLinks: [],
        lines: [{ id: 'line-1', productId: 'product-1', sku: 'SKU-1', description: 'Widget', qty: decimal('2'), totalForeign: decimal('120'), totalBase: decimal('120'), taxForeign: decimal('20'), taxBase: decimal('20'), discountAmount: decimal('0'), product }],
      }],
    },
    cogsEntry: {
      findMany: async () => [{
        id: 'cogs-1',
        totalCostBase: decimal('70'),
        movement: {
          referenceType: 'SalesOrder',
          referenceId: 'order-1',
          productId: 'product-1',
          createdAt: new Date('2026-06-01T13:00:00.000Z'),
          product,
        },
      }],
    },
  }

  const report = await getMarginAnalyticsReport(
    { dateFrom: '2026-06-01', dateTo: '2026-06-01' },
    { client, now: () => new Date('2026-06-01T15:00:00.000Z') },
  )

  assert.equal(report.rows[0]?.revenueBase, '120')
  assert.equal(report.rows[0]?.cogsBase, '70')
  assert.equal(report.rows[0]?.grossProfitBase, '50')
  assert.equal(report.totals.marginPct, '41.67')
})

test('returns report aggregates refund lines and same-period shipped quantity', async () => {
  const client: SalesFulfillmentAnalyticsClient = {
    ...unusedClient(),
    salesOrderRefundLine: {
      findMany: async () => [{
        id: 'refund-line-1',
        refundId: 'refund-1',
        productId: 'product-1',
        description: 'Widget',
        qty: decimal('2'),
        totalBase: decimal('24'),
        product,
        refund: {
          id: 'refund-1',
          reason: 'Damaged',
          totalBase: decimal('24'),
          refundedAt: new Date('2026-06-01T12:00:00.000Z'),
          order: { customerName: 'Customer A', lines: [{ productId: 'product-1', qty: decimal('10') }] },
        },
      }],
    },
    stockMovement: {
      findMany: async () => [{ productId: 'product-1', qty: decimal('10') }],
    },
  }

  const report = await getReturnsAnalyticsReport(
    { dateFrom: '2026-06-01', dateTo: '2026-06-01' },
    { client, now: () => new Date('2026-06-01T15:00:00.000Z') },
  )

  assert.equal(report.rows[0]?.returnedQty, '2')
  assert.equal(report.rows[0]?.refundValueBase, '24')
  assert.equal(report.rows[0]?.returnRatePct, '20')
})

test('fulfillment report uses Shipment.shippedAt for on-time and elapsed metrics', async () => {
  const client: SalesFulfillmentAnalyticsClient = {
    ...unusedClient(),
    shipment: {
      findMany: async () => [{
        id: 'shipment-1',
        orderId: 'order-1',
        status: ShipmentStatus.SHIPPED,
        createdAt: new Date('2026-06-01T12:00:00.000Z'),
        updatedAt: new Date('2026-06-03T12:00:00.000Z'),
        shippedAt: new Date('2026-06-03T12:00:00.000Z'),
        lines: [{ lineId: 'line-1', qty: decimal('3') }],
        order: {
          id: 'order-1',
          createdAt: new Date('2026-06-01T12:00:00.000Z'),
          expectedDelivery: new Date('2026-06-04T00:00:00.000Z'),
          lines: [{ id: 'line-1', qty: decimal('5') }],
        },
      }],
    },
  }

  const report = await getFulfillmentAnalyticsReport(
    { dateFrom: '2026-06-01', dateTo: '2026-06-04' },
    { client, now: () => new Date('2026-06-04T15:00:00.000Z') },
  )

  assert.equal(report.rows.find((row) => row.metric === 'On-time ship rate')?.value, '100%')
  assert.equal(report.rows.find((row) => row.metric === 'Fill rate')?.value, '60%')
  assert.equal(report.rows.find((row) => row.metric === 'Average order-to-ship days')?.value, '2')
  assert.equal(report.rows.find((row) => row.metric === 'Partial ship rate')?.value, '100%')
})

test('throughput report keeps current queue depth in totals, not historical rows', async () => {
  const client: SalesFulfillmentAnalyticsClient = {
    ...unusedClient(),
    activityLog: {
      findMany: async () => [{
        userId: 'user-1',
        createdAt: new Date('2026-06-02T12:00:00.000Z'),
        metadata: { shipmentId: 'shipment-1' },
        user: { name: 'Operator A' },
      }],
    },
    shipment: {
      findMany: async (args?: unknown) => {
        const where = (args as { where: Record<string, unknown> }).where
        if ('status' in where) return [{ id: 'pending-1' }, { id: 'pending-2' }]
        return [{
          id: 'shipment-1',
          orderId: 'order-1',
          lines: [{ lineId: 'line-1', qty: decimal('1') }],
        }]
      },
    },
  }

  const report = await getThroughputAnalyticsReport(
    { dateFrom: '2026-06-01', dateTo: '2026-06-03' },
    { client, now: () => new Date('2026-06-03T00:00:00.000Z') },
  )

  assert.equal(report.rows[0]?.shipmentCount, 1)
  assert.equal('queueDepth' in (report.rows[0] as unknown as Record<string, unknown>), false)
  assert.equal(report.totals.queueDepth, '2')
})
