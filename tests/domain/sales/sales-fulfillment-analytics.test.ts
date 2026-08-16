import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Prisma, ProductType, SalesOrderStatus, ShipmentStatus } from '@/app/generated/prisma/client'
import {
  computeInWindowDispatchedQtyByLine,
  getFulfillmentAnalyticsReport,
  getMarginAnalyticsReport,
  getReturnsAnalyticsReport,
  getSalesAnalyticsReport,
  getThroughputAnalyticsReport,
  type SalesFulfillmentAnalyticsClient,
} from '@/lib/domain/sales/sales-fulfillment-analytics'
import { SourceScanTooLargeError } from '@/lib/security/source-scan-error'

function decimal(value: string | number): Prisma.Decimal {
  return new Prisma.Decimal(value)
}

function unusedClient(): SalesFulfillmentAnalyticsClient {
  const unused = { findMany: async () => [] }
  return {
    // Answers the fulfillment-graph load: every product is SIMPLE unless a test says otherwise, so
    // a line is a single self-requirement of factor 1. Returning [] instead would make every
    // product an unknown leaf and log a warning per line.
    product: {
      findMany: async (args?: unknown) => (args as { where: { id: { in: string[] } } }).where.id.in
        .map((id) => ({ id, type: 'SIMPLE', productComponents: [] })),
    },
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

test('sales analytics throws a typed source-scan error at the source row cap', async () => {
  const client: SalesFulfillmentAnalyticsClient = {
    ...unusedClient(),
    salesOrder: {
      findMany: async () => Array.from({ length: 50001 }, (_, index) => ({ id: `order-${index}` })),
    },
  }

  await assert.rejects(
    getSalesAnalyticsReport(
      { dateFrom: '2026-06-01', dateTo: '2026-06-30' },
      { client, now: () => new Date('2026-06-30T00:00:00.000Z') },
    ),
    (error: unknown) => error instanceof SourceScanTooLargeError && /Sales analytics source orders exceed 50,000/.test(error.message),
  )
})

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

test('sales analytics formats base amounts with the configured base currency minor units', async () => {
  const client: SalesFulfillmentAnalyticsClient = {
    ...unusedClient(),
    salesOrder: {
      findMany: async () => [{
        id: 'order-1',
        status: SalesOrderStatus.PROCESSING,
        currency: 'USD',
        customerId: 'customer-1',
        customerName: 'Customer A',
        customerEmail: 'a@example.com',
        createdAt: new Date('2026-06-01T12:00:00.000Z'),
        expectedDelivery: null,
        paidAt: null,
        totalForeign: decimal('100.25'),
        totalBase: decimal('100.5'),
        taxForeign: decimal('0'),
        taxBase: decimal('0'),
        shippingForeign: decimal('0'),
        shippingBase: decimal('0'),
        discountAmount: decimal('0'),
        shoppingLinks: [],
        lines: [{ id: 'line-1', productId: 'product-1', sku: 'SKU-1', description: 'Widget', qty: decimal('1'), totalForeign: decimal('100.25'), totalBase: decimal('100.5'), taxForeign: decimal('0'), taxBase: decimal('0'), discountAmount: decimal('0'), product }],
      }],
    },
  }

  const report = await getSalesAnalyticsReport(
    { dateFrom: '2026-06-01', dateTo: '2026-06-01', currencyMode: 'base' },
    { client, now: () => new Date('2026-06-01T15:00:00.000Z'), baseCurrency: async () => 'JPY' },
  )

  assert.equal(report.rows[0]?.currency, 'JPY')
  assert.equal(report.totals.revenue, '101')
})

test('computeInWindowDispatchedQtyByLine attributes linked dispatch exactly to its line', () => {
  const result = computeInWindowDispatchedQtyByLine(
    [{ orderId: 'order-1', productId: 'product-1', qty: 4, shipmentLineLineId: 'line-1' }],
    [{ id: 'line-1', orderId: 'order-1', productId: 'product-1', qty: 10 }],
  )
  assert.equal(result.get('line-1|product-1')?.toString(), '4')
})

test('computeInWindowDispatchedQtyByLine does not attribute kit-component dispatch to the kit line', () => {
  // A kit SalesOrderLine (product = kit) ships at component granularity: the
  // dispatch movements link to the kit lineId but carry component productIds.
  // The kit line keys on (lineId, kitProduct), so no component qty leaks in.
  const result = computeInWindowDispatchedQtyByLine(
    [
      { orderId: 'order-1', productId: 'component-a', qty: 6, shipmentLineLineId: 'kit-line' },
      { orderId: 'order-1', productId: 'component-b', qty: 3, shipmentLineLineId: 'kit-line' },
    ],
    [{ id: 'kit-line', orderId: 'order-1', productId: 'kit-product', qty: 3 }],
  )
  assert.equal(result.get('kit-line|kit-product'), undefined)
  assert.equal(result.size, 0)
})

test('computeInWindowDispatchedQtyByLine drops unlinked residual when no line qty to share against', () => {
  const result = computeInWindowDispatchedQtyByLine(
    [{ orderId: 'order-1', productId: 'product-1', qty: 5, shipmentLineLineId: null }],
    [{ id: 'line-1', orderId: 'order-1', productId: 'product-1', qty: 0 }],
  )
  assert.equal(result.size, 0)
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
    stockMovement: {
      // Both line units dispatched in-window → full line revenue is booked.
      findMany: async () => [{
        qty: decimal('2'),
        referenceId: 'order-1',
        productId: 'product-1',
        shipmentLine: { lineId: 'line-1' },
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

test('margin report prorates line revenue to in-window dispatched quantity (scjz.51)', async () => {
  // Line of 10 @ £100 (rev £1000); only 4 units dispatched + costed this window.
  // Revenue must prorate to 4/10 (£400) so margin matches the in-window COGS,
  // not book the full £1000 against the partial COGS.
  const client: SalesFulfillmentAnalyticsClient = {
    ...unusedClient(),
    salesOrder: {
      findMany: async () => [{
        id: 'order-1',
        status: SalesOrderStatus.PROCESSING,
        currency: 'GBP',
        customerId: null,
        customerName: 'Customer A',
        customerEmail: null,
        createdAt: new Date('2026-06-01T12:00:00.000Z'),
        expectedDelivery: null,
        paidAt: null,
        totalForeign: decimal('1000'),
        totalBase: decimal('1000'),
        taxForeign: decimal('0'),
        taxBase: decimal('0'),
        shippingForeign: decimal('0'),
        shippingBase: decimal('0'),
        discountAmount: decimal('0'),
        shoppingLinks: [],
        lines: [{ id: 'line-1', productId: 'product-1', sku: 'SKU-1', description: 'Widget', qty: decimal('10'), totalForeign: decimal('1000'), totalBase: decimal('1000'), taxForeign: decimal('0'), taxBase: decimal('0'), discountAmount: decimal('0'), product }],
      }],
    },
    cogsEntry: {
      findMany: async () => [{
        id: 'cogs-1',
        totalCostBase: decimal('240'),
        movement: {
          referenceType: 'SalesOrder',
          referenceId: 'order-1',
          productId: 'product-1',
          createdAt: new Date('2026-06-01T13:00:00.000Z'),
          product,
        },
      }],
    },
    stockMovement: {
      findMany: async () => [{
        qty: decimal('4'),
        referenceId: 'order-1',
        productId: 'product-1',
        shipmentLine: { lineId: 'line-1' },
      }],
    },
  }

  const report = await getMarginAnalyticsReport(
    { dateFrom: '2026-06-01', dateTo: '2026-06-01' },
    { client, now: () => new Date('2026-06-01T15:00:00.000Z') },
  )

  assert.equal(report.rows[0]?.revenueBase, '400')
  assert.equal(report.rows[0]?.cogsBase, '240')
  assert.equal(report.rows[0]?.grossProfitBase, '160')
  assert.equal(report.rows[0]?.marginPct, '40')
})

test('margin report distributes legacy unlinked dispatch residual across same-product lines (scjz.51)', async () => {
  // Two same-product lines; the in-window dispatch movement has no shipment-line
  // link (legacy/pre-backfill). The 6 unlinked units are distributed across the
  // two lines proportionally to line qty (4:2), so revenue prorates rather than
  // dropping to zero — never worse than the old full-revenue behaviour.
  const client: SalesFulfillmentAnalyticsClient = {
    ...unusedClient(),
    salesOrder: {
      findMany: async () => [{
        id: 'order-1',
        status: SalesOrderStatus.PROCESSING,
        currency: 'GBP',
        customerId: null,
        customerName: 'Customer A',
        customerEmail: null,
        createdAt: new Date('2026-06-01T12:00:00.000Z'),
        expectedDelivery: null,
        paidAt: null,
        totalForeign: decimal('600'),
        totalBase: decimal('600'),
        taxForeign: decimal('0'),
        taxBase: decimal('0'),
        shippingForeign: decimal('0'),
        shippingBase: decimal('0'),
        discountAmount: decimal('0'),
        shoppingLinks: [],
        lines: [
          { id: 'line-a', productId: 'product-1', sku: 'SKU-1', description: 'Widget', qty: decimal('4'), totalForeign: decimal('400'), totalBase: decimal('400'), taxForeign: decimal('0'), taxBase: decimal('0'), discountAmount: decimal('0'), product },
          { id: 'line-b', productId: 'product-1', sku: 'SKU-1', description: 'Widget', qty: decimal('2'), totalForeign: decimal('200'), totalBase: decimal('200'), taxForeign: decimal('0'), taxBase: decimal('0'), discountAmount: decimal('0'), product },
        ],
      }],
    },
    cogsEntry: {
      findMany: async () => [{
        id: 'cogs-1',
        totalCostBase: decimal('300'),
        movement: {
          referenceType: 'SalesOrder',
          referenceId: 'order-1',
          productId: 'product-1',
          createdAt: new Date('2026-06-01T13:00:00.000Z'),
          product,
        },
      }],
    },
    stockMovement: {
      findMany: async () => [{
        qty: decimal('6'),
        referenceId: 'order-1',
        productId: 'product-1',
        shipmentLine: null,
      }],
    },
  }

  const report = await getMarginAnalyticsReport(
    { dateFrom: '2026-06-01', dateTo: '2026-06-01' },
    { client, now: () => new Date('2026-06-01T15:00:00.000Z') },
  )

  // line-a: 4 units @ £100 = £400; line-b: 2 units @ £100 = £200 → £600 total.
  assert.equal(report.rows[0]?.revenueBase, '600')
  assert.equal(report.rows[0]?.cogsBase, '300')
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
        lines: [{ lineId: 'line-1', productId: 'product-1', qty: decimal('3') }],
        order: {
          id: 'order-1',
          createdAt: new Date('2026-06-01T12:00:00.000Z'),
          expectedDelivery: new Date('2026-06-04T00:00:00.000Z'),
          lines: [{ id: 'line-1', productId: 'product-1', qty: decimal('5') }],
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

/**
 * The same orders must report the same total discount whichever way they are grouped (o3d-3gp).
 *
 * The two groupings read different fields: customer/channel took only the ORDER-level discount and
 * product/category only the LINE discounts. That was self-consistent while the WooCommerce importer
 * wrote a coupon into both — and o3d-y14 correctly stopped it doing that, at which point a coupon order
 * reported its full discount in one view and nothing in the other. Both now report the whole thing:
 * the order-level residual plus what the lines carry, allocated across lines the way revenue, tax and
 * shipping already are.
 */
function couponOrderClient(): SalesFulfillmentAnalyticsClient {
  return {
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
        totalForeign: decimal('100'),
        totalBase: decimal('100'),
        taxForeign: decimal('0'),
        taxBase: decimal('0'),
        shippingForeign: decimal('0'),
        shippingBase: decimal('0'),
        // A WooCommerce coupon: GBP10 allocated onto the lines, plus GBP4 Woo left unallocated.
        discountAmount: decimal('4'),
        shoppingLinks: [{ connector: 'woocommerce' }],
        lines: [
          { id: 'line-1', productId: 'product-1', sku: 'SKU-1', description: 'Widget', qty: decimal('1'), totalForeign: decimal('50'), totalBase: decimal('50'), taxForeign: decimal('0'), taxBase: decimal('0'), discountAmount: decimal('6'), product },
          { id: 'line-2', productId: 'product-2', sku: 'SKU-2', description: 'Second', qty: decimal('1'), totalForeign: decimal('50'), totalBase: decimal('50'), taxForeign: decimal('0'), taxBase: decimal('0'), discountAmount: decimal('4'), product: { ...product, id: 'product-2', sku: 'SKU-2', name: 'Second' } },
        ],
      }],
    },
  }
}

test('sales analytics reports the SAME total discount however the orders are grouped', async () => {
  const opts = { dateFrom: '2026-06-01', dateTo: '2026-06-01' } as const
  const ctx = { now: () => new Date('2026-06-01T15:00:00.000Z') }

  const byCustomer = await getSalesAnalyticsReport({ ...opts, groupBy: 'customer' }, { client: couponOrderClient(), ...ctx })
  const byProduct = await getSalesAnalyticsReport({ ...opts, groupBy: 'product' }, { client: couponOrderClient(), ...ctx })

  // 6 + 4 on the lines, plus the 4 the order still carries.
  assert.equal(byCustomer.totals.discount, '14')
  assert.equal(byProduct.totals.discount, byCustomer.totals.discount)
})

test('the order-level residual is spread across lines, not dumped on one', async () => {
  const report = await getSalesAnalyticsReport(
    { dateFrom: '2026-06-01', dateTo: '2026-06-01', groupBy: 'product' },
    { client: couponOrderClient(), now: () => new Date('2026-06-01T15:00:00.000Z') },
  )
  // Two equal lines, so each takes half of the GBP4 residual on top of its own discount.
  assert.equal(report.rows.find((r) => r.label.startsWith('SKU-1'))?.discount, '8')
  assert.equal(report.rows.find((r) => r.label.startsWith('SKU-2'))?.discount, '6')
})

test('o3d-4kfh r3: fill rate counts KIT shipments in ORDERED units, not component units', async () => {
  // ShipmentLine.qty is a leaf-component quantity; SalesOrderLine.qty is in parent units. Summing
  // both by order and dividing gave a 300% fill rate for a one-kit order whose kit expands to three
  // components — and, because `shipmentQty < orderQty` was then false, the order was never counted
  // as partial however short it actually shipped.
  //
  // Here: 4 kits ordered, kit = 2 x COMP-A + 1 x COMP-B. Two kits are shipped (4 x A + 2 x B = 6
  // component units). The honest answer is 2 of 4 = 50% and PARTIAL. Reading the raw component
  // units gave 6 of 4 = 150% and "complete".
  const client: SalesFulfillmentAnalyticsClient = {
    ...unusedClient(),
    product: {
      findMany: async (args?: unknown) => (args as { where: { id: { in: string[] } } }).where.id.in
        .map((id) => (id === 'kit-1'
          ? {
            id,
            type: 'KIT',
            productComponents: [
              { componentId: 'comp-a', qty: decimal('2'), component: { sku: 'COMP-A', type: 'SIMPLE', oversellAllowed: false } },
              { componentId: 'comp-b', qty: decimal('1'), component: { sku: 'COMP-B', type: 'SIMPLE', oversellAllowed: false } },
            ],
          }
          : { id, type: 'SIMPLE', productComponents: [] })),
    },
    shipment: {
      findMany: async () => [{
        id: 'shipment-1',
        orderId: 'order-1',
        status: ShipmentStatus.SHIPPED,
        createdAt: new Date('2026-06-01T12:00:00.000Z'),
        updatedAt: new Date('2026-06-03T12:00:00.000Z'),
        shippedAt: new Date('2026-06-03T12:00:00.000Z'),
        lines: [
          { lineId: 'line-1', productId: 'comp-a', qty: decimal('4') },
          { lineId: 'line-1', productId: 'comp-b', qty: decimal('2') },
        ],
        order: {
          id: 'order-1',
          createdAt: new Date('2026-06-01T12:00:00.000Z'),
          expectedDelivery: new Date('2026-06-04T00:00:00.000Z'),
          lines: [{ id: 'line-1', productId: 'kit-1', qty: decimal('4') }],
        },
      }],
    },
  }

  const report = await getFulfillmentAnalyticsReport(
    { dateFrom: '2026-06-01', dateTo: '2026-06-04' },
    { client, now: () => new Date('2026-06-04T15:00:00.000Z') },
  )

  assert.equal(report.rows.find((row) => row.metric === 'Fill rate')?.value, '50%')
  assert.equal(report.rows.find((row) => row.metric === 'Fill rate')?.numerator, '2')
  assert.equal(report.rows.find((row) => row.metric === 'Fill rate')?.denominator, '4')
  assert.equal(report.totals.shippedQty, '2', 'the "Shipped qty" total and its CSV export are in kits too')
  assert.equal(report.rows.find((row) => row.metric === 'Partial ship rate')?.value, '100%')
})
