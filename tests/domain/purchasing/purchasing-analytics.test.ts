import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Prisma, PurchaseOrderStatus } from '@/app/generated/prisma/client'
import {
  getLeadTimeReport,
  getOpenPurchaseOrdersReport,
  getPurchasePriceVarianceReport,
  getSpendReport,
  getSupplierPerformanceReport,
  type PurchasingAnalyticsClient,
} from '@/lib/domain/purchasing/purchasing-analytics'

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
          lines: [{ qty: decimal('10'), qtyReceived: decimal('4'), qtyReturned: decimal('1'), unitCostBase: decimal('2') }],
        }]
      },
    },
  }

  const report = await getOpenPurchaseOrdersReport({}, { deps: { client, now: () => new Date('2026-06-01T00:00:00.000Z') } })

  assert.equal(report.rows[0]?.outstandingQty, '5')
  assert.equal(report.rows[0]?.outstandingValueBase, '10')
  assert.equal(report.rows[0]?.overdue, true)
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
