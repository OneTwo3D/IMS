import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Prisma, PurchaseOrderStatus } from '@/app/generated/prisma/client'
import {
  getLeadTimeReport,
  getObservedLeadTimeP95ByProduct,
  getOpenPurchaseOrdersReport,
  getPurchasePriceVarianceReport,
  getSpendReport,
  getSupplierPerformanceReport,
  type PurchasingAnalyticsClient,
} from '@/lib/domain/purchasing/purchasing-analytics'
import { SourceScanTooLargeError } from '@/lib/security/source-scan-error'

function decimal(value: string | number): Prisma.Decimal {
  return new Prisma.Decimal(value)
}

function unusedClient(): PurchasingAnalyticsClient {
  const unused = { findMany: async () => [] }
  return {
    purchaseOrder: unused,
    purchaseOrderLine: unused,
    purchaseReceipt: unused,
    purchaseReturnLine: unused,
    supplierProduct: unused,
  }
}

const supplier = { name: 'Supplier A' }
const category = { name: 'Components' }
const product = { sku: 'SKU-1', name: 'Widget', category }

test('open purchase order report throws a typed source-scan error at the source row cap', async () => {
  const client: PurchasingAnalyticsClient = {
    ...unusedClient(),
    purchaseOrder: {
      findMany: async () => Array.from({ length: 50001 }, (_, index) => ({ id: `po-${index}` })),
    },
  }

  await assert.rejects(
    getOpenPurchaseOrdersReport({}, { deps: { client, now: () => new Date('2026-06-30T00:00:00.000Z') } }),
    (error: unknown) => error instanceof SourceScanTooLargeError && /Open purchase order source rows exceed 50,000/.test(error.message),
  )
})

test('open purchase order report uses only open statuses and nets received and returned quantities', async () => {
  const client: PurchasingAnalyticsClient = {
    ...unusedClient(),
    purchaseOrder: {
      findMany: async (args?: unknown) => {
        const where = (args as { where: { status: { in: PurchaseOrderStatus[] } } }).where
        assert.deepEqual(where.status.in, [
          PurchaseOrderStatus.PO_SENT,
          PurchaseOrderStatus.PARTIALLY_RECEIVED,
          PurchaseOrderStatus.SHIPPED,
        ])
        return [{
          id: 'po-1',
          reference: 'PO-1',
          status: PurchaseOrderStatus.PO_SENT,
          poSentAt: new Date('2026-05-01T00:00:00.000Z'),
          expectedDelivery: new Date('2026-05-20T00:00:00.000Z'),
          createdAt: new Date('2026-05-01T00:00:00.000Z'),
          supplierId: 'supplier-1',
          supplier,
          lines: [{ qty: decimal('10'), qtyReceived: decimal('4'), qtyReturned: decimal('1'), unitCostBase: decimal('2'), landedUnitCostBase: decimal('3') }],
        }]
      },
    },
  }

  const report = await getOpenPurchaseOrdersReport({}, { deps: { client, now: () => new Date('2026-06-01T00:00:00.000Z') } })

  assert.equal(report.rows[0]?.outstandingQty, '5')
  assert.equal(report.rows[0]?.outstandingValueBase, '15')
  assert.equal(report.rows[0]?.overdue, true)
})

test('purchasing analytics formats base amounts with the configured base currency minor units', async () => {
  const client: PurchasingAnalyticsClient = {
    ...unusedClient(),
    purchaseOrder: {
      findMany: async () => [{
        id: 'po-1',
        reference: 'PO-1',
        status: PurchaseOrderStatus.PO_SENT,
        poSentAt: new Date('2026-06-01T00:00:00.000Z'),
        expectedDelivery: null,
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
        supplierId: 'supplier-1',
        supplier,
        lines: [{ qty: decimal('1'), qtyReceived: decimal('0'), qtyReturned: decimal('0'), unitCostBase: decimal('10.5'), landedUnitCostBase: decimal('10.5') }],
      }],
    },
  }

  const report = await getOpenPurchaseOrdersReport(
    { dateFrom: '2026-06-01', dateTo: '2026-06-30' },
    { deps: { client, now: () => new Date('2026-06-30T00:00:00.000Z'), baseCurrency: async () => 'JPY' } },
  )

  assert.equal(report.totals.outstandingValueBase, '11')
})

test('getObservedLeadTimeP95ByProduct aggregates receipts per product (across suppliers) as P95 days', async () => {
  const receipt = (id: string, poId: string, supplierId: string, sentAt: string, receivedAt: string, productId: string) => ({
    id, receivedAt: new Date(receivedAt),
    po: { id: poId, reference: poId, supplierId, expectedDelivery: null, poSentAt: new Date(sentAt), createdAt: new Date(sentAt), supplier },
    lines: [{ poLineId: `${poId}-l`, qtyReceived: decimal('1'), poLine: { qty: decimal('1'), productId, product } }],
  })
  const client = {
    ...unusedClient(),
    purchaseReceipt: {
      findMany: async () => [
        // product-1: two receipts from DIFFERENT suppliers, 10 and 30 day lead times.
        receipt('r1', 'po-1', 'sup-a', '2026-05-01T00:00:00.000Z', '2026-05-11T00:00:00.000Z', 'product-1'),
        receipt('r2', 'po-2', 'sup-b', '2026-05-01T00:00:00.000Z', '2026-05-31T00:00:00.000Z', 'product-1'),
        // product-2: single 5-day receipt.
        receipt('r3', 'po-3', 'sup-a', '2026-05-01T00:00:00.000Z', '2026-05-06T00:00:00.000Z', 'product-2'),
      ],
    },
  } as unknown as PurchasingAnalyticsClient

  const map = await getObservedLeadTimeP95ByProduct({ client, now: () => new Date('2026-06-01T00:00:00.000Z') })
  // P95 of [10, 30] ~= 30 (top of range); product keyed by id, supplier-agnostic.
  assert.equal(map.get('product-1'), 30)
  assert.equal(map.get('product-2'), 5)
})

test('supplier performance uses receipt timestamps for on-time and return-rate metrics', async () => {
  const client: PurchasingAnalyticsClient = {
    ...unusedClient(),
    purchaseReceipt: {
      findMany: async () => [{
        id: 'receipt-1',
        receivedAt: new Date('2026-06-05T00:00:00.000Z'),
        po: { id: 'po-1', reference: 'PO-1', supplierId: 'supplier-1', expectedDelivery: new Date('2026-06-06T00:00:00.000Z'), poSentAt: new Date('2026-06-01T00:00:00.000Z'), createdAt: new Date('2026-06-01T00:00:00.000Z'), supplier },
        lines: [{ poLineId: 'po-line-1', qtyReceived: decimal('9'), poLine: { qty: decimal('10'), productId: 'product-1', product } }],
      }],
    },
    purchaseReturnLine: {
      findMany: async () => [{ qtyReturned: decimal('1'), return: { returnedAt: new Date('2026-06-07T00:00:00.000Z'), po: { supplierId: 'supplier-1', supplier } }, poLine: { productId: 'product-1' } }],
    },
    supplierProduct: {
      findMany: async () => [{ supplierId: 'supplier-1', productId: 'product-1', leadTimeDays: 7 }],
    },
  }

  const report = await getSupplierPerformanceReport(
    { dateFrom: '2026-06-01', dateTo: '2026-06-30' },
    { deps: { client, now: () => new Date('2026-06-30T00:00:00.000Z') } },
  )

  assert.equal(report.rows[0]?.onTimeRatePct, '100')
  assert.equal(report.rows[0]?.qtyVariance, '-1')
  assert.equal(report.rows[0]?.returnRatePct, '11.11')
  assert.equal(report.rows[0]?.averageActualLeadTimeDays, '4')
  assert.equal(report.rows[0]?.averageConfiguredLeadTimeDays, '7')
})

test('purchase price variance compares against prior received PO line in base currency', async () => {
  const client: PurchasingAnalyticsClient = {
    ...unusedClient(),
    purchaseOrderLine: {
      findMany: async () => [
        {
          id: 'line-prior',
          productId: 'product-1',
          qty: decimal('10'),
          unitCostBase: decimal('8'),
          landedUnitCostBase: decimal('8'),
          totalBase: decimal('80'),
          po: { reference: 'PO-0', supplierId: 'supplier-1', poSentAt: null, receivedAt: new Date('2026-05-15T00:00:00.000Z'), createdAt: new Date('2026-05-01T00:00:00.000Z'), status: PurchaseOrderStatus.RECEIVED, supplier },
          product,
        },
        {
          id: 'line-current',
          productId: 'product-1',
          qty: decimal('5'),
          unitCostBase: decimal('10'),
          landedUnitCostBase: decimal('10'),
          totalBase: decimal('50'),
          po: { reference: 'PO-1', supplierId: 'supplier-1', poSentAt: null, receivedAt: new Date('2026-06-10T00:00:00.000Z'), createdAt: new Date('2026-06-01T00:00:00.000Z'), status: PurchaseOrderStatus.RECEIVED, supplier },
          product,
        },
      ],
    },
  }

  const report = await getPurchasePriceVarianceReport(
    { dateFrom: '2026-06-01', dateTo: '2026-06-30' },
    { deps: { client, now: () => new Date('2026-06-30T00:00:00.000Z') } },
  )

  assert.equal(report.rows[0]?.referencePriceSource, 'prior_po')
  assert.equal(report.rows[0]?.referenceUnitCostBase, '8')
  assert.equal(report.rows[0]?.variancePerUnitBase, '2')
  assert.equal(report.rows[0]?.varianceTotalBase, '10')
})

test('spend report totals reconcile to received purchase order totalBase', async () => {
  const client: PurchasingAnalyticsClient = {
    ...unusedClient(),
    purchaseOrder: {
      findMany: async () => [{
        id: 'po-1',
        reference: 'PO-1',
        supplierId: 'supplier-1',
        receivedAt: new Date('2026-06-10T00:00:00.000Z'),
        totalBase: decimal('120'),
        supplier,
        lines: [
          { totalBase: decimal('30'), product: { category } },
          { totalBase: decimal('70'), product: { category: { name: 'Finished goods' } } },
        ],
      }],
    },
  }

  const report = await getSpendReport(
    { dateFrom: '2026-06-01', dateTo: '2026-06-30' },
    { deps: { client, now: () => new Date('2026-06-30T00:00:00.000Z') } },
  )

  assert.equal(report.totals.spendBase, '120')
  assert.equal(report.rows.reduce((sum, row) => sum.add(row.spendBase), new Prisma.Decimal(0)).toString(), '120')
})

test('lead-time report calculates supplier-SKU P50 and P95 from receipt lead times', async () => {
  const client: PurchasingAnalyticsClient = {
    ...unusedClient(),
    purchaseReceipt: {
      findMany: async () => [
        {
          id: 'receipt-1',
          receivedAt: new Date('2026-06-06T00:00:00.000Z'),
          po: { id: 'po-1', reference: 'PO-1', supplierId: 'supplier-1', expectedDelivery: null, poSentAt: new Date('2026-06-01T00:00:00.000Z'), createdAt: new Date('2026-06-01T00:00:00.000Z'), supplier },
          lines: [{ poLineId: 'line-1', qtyReceived: decimal('1'), poLine: { qty: decimal('1'), productId: 'product-1', product } }],
        },
        {
          id: 'receipt-2',
          receivedAt: new Date('2026-06-21T00:00:00.000Z'),
          po: { id: 'po-2', reference: 'PO-2', supplierId: 'supplier-1', expectedDelivery: null, poSentAt: new Date('2026-06-01T00:00:00.000Z'), createdAt: new Date('2026-06-01T00:00:00.000Z'), supplier },
          lines: [{ poLineId: 'line-2', qtyReceived: decimal('1'), poLine: { qty: decimal('1'), productId: 'product-1', product } }],
        },
      ],
    },
    supplierProduct: {
      findMany: async () => [{ supplierId: 'supplier-1', productId: 'product-1', leadTimeDays: 14 }],
    },
  }

  const report = await getLeadTimeReport(
    { dateFrom: '2026-06-01', dateTo: '2026-06-30' },
    { deps: { client, now: () => new Date('2026-06-30T00:00:00.000Z') } },
  )

  assert.equal(report.rows[0]?.averageLeadTimeDays, '12.5')
  assert.equal(report.rows[0]?.p50LeadTimeDays, '5')
  assert.equal(report.rows[0]?.p95LeadTimeDays, '20')
  assert.equal(report.rows[0]?.configuredLeadTimeDays, '14')
})
