import assert from 'node:assert/strict'
import test from 'node:test'

import {
  calculatePurchaseLineTaxSnapshot,
  calculateSalesLineTaxSnapshot,
  refreshMutableDocumentTaxSnapshotsForRate,
} from '@/lib/tax/document-tax-snapshot-refresh'

test('sales tax snapshot refresh extracts net from tax-inclusive prices at the new rate', () => {
  const refreshed = calculateSalesLineTaxSnapshot({
    qty: '2',
    unitPriceForeign: '12',
    discountAmount: '0',
    fxRateToBase: '1.2',
    pricesIncludeVat: true,
    taxRateValue: '0.2',
  })

  assert.equal(refreshed.totalForeign.toFixed(4), '20.0000')
  assert.equal(refreshed.taxForeign.toFixed(4), '4.0000')
  assert.equal(refreshed.totalBase.toFixed(4), '16.6667')
  assert.equal(refreshed.taxBase.toFixed(4), '3.3333')
})

test('purchase tax snapshot refresh keeps the net line total and recalculates tax only', () => {
  const refreshed = calculatePurchaseLineTaxSnapshot({
    totalForeign: '100',
    fxRateToBase: '1.25',
    taxRateValue: '0.05',
  })

  assert.equal(refreshed.taxForeign.toFixed(4), '5.0000')
  assert.equal(refreshed.taxBase.toFixed(4), '4.0000')
})

test('tax snapshot refresh locks mutable parents and batches only still-mutable lines', async () => {
  const calls = {
    salesFindMany: [] as unknown[],
    purchaseFindMany: [] as unknown[],
    queryRaw: [] as unknown[],
    executeRaw: [] as unknown[],
    salesOrderUpdateMany: [] as unknown[],
    purchaseOrderUpdateMany: [] as unknown[],
  }
  let lockCall = 0
  const client = {
    salesOrderLine: {
      findMany: async (args: unknown) => {
        calls.salesFindMany.push(args)
        return [
          {
            id: 'sales-line-draft',
            orderId: 'sales-order-draft',
            qty: '2',
            unitPriceForeign: '10',
            discountAmount: '0',
            taxForeign: '2',
            taxBase: '2',
            totalForeign: '20',
            totalBase: '20',
            order: {
              id: 'sales-order-draft',
              fxRateToBase: '1',
              pricesIncludeVat: false,
              taxRateName: 'Old VAT',
            },
          },
          {
            id: 'sales-line-raced',
            orderId: 'sales-order-raced',
            qty: '1',
            unitPriceForeign: '10',
            discountAmount: '0',
            taxForeign: '1',
            taxBase: '1',
            totalForeign: '10',
            totalBase: '10',
            order: {
              id: 'sales-order-raced',
              fxRateToBase: '1',
              pricesIncludeVat: false,
              taxRateName: 'Old VAT',
            },
          },
        ]
      },
    },
    salesOrder: {
      updateMany: async (args: unknown) => {
        calls.salesOrderUpdateMany.push(args)
        return { count: 1 }
      },
    },
    purchaseOrderLine: {
      findMany: async (args: unknown) => {
        calls.purchaseFindMany.push(args)
        return [
          {
            id: 'purchase-line-draft',
            poId: 'po-draft',
            taxForeign: '5',
            taxBase: '5',
            totalForeign: '100',
            po: {
              id: 'po-draft',
              fxRateToBase: '1',
              taxRateName: 'Old VAT',
            },
          },
          {
            id: 'purchase-line-sent',
            poId: 'po-sent',
            taxForeign: '5',
            taxBase: '5',
            totalForeign: '100',
            po: {
              id: 'po-sent',
              fxRateToBase: '1',
              taxRateName: 'Old VAT',
            },
          },
        ]
      },
    },
    purchaseOrder: {
      updateMany: async (args: unknown) => {
        calls.purchaseOrderUpdateMany.push(args)
        return { count: 1 }
      },
    },
    activityLog: {
      create: async () => ({ id: 'activity-1' }),
    },
    $queryRaw: async (query: unknown) => {
      calls.queryRaw.push(query)
      lockCall += 1
      return lockCall === 1 ? [{ id: 'sales-order-draft' }] : [{ id: 'po-draft' }]
    },
    $executeRaw: async (query: unknown) => {
      calls.executeRaw.push(query)
      return 1
    },
  }

  const result = await refreshMutableDocumentTaxSnapshotsForRate(client as never, {
    oldRate: { id: 'old-rate', name: 'Old VAT', rate: '0.1' },
    newRate: { id: 'new-rate', name: 'New VAT', rate: '0.2' },
  })

  assert.deepEqual(result, { salesOrders: 1, salesLines: 1, purchaseOrders: 1, purchaseLines: 1 })
  assert.equal(calls.queryRaw.length, 2)
  assert.equal(calls.executeRaw.length, 4)
  assert.equal(calls.salesOrderUpdateMany.length, 0)
  assert.equal(calls.purchaseOrderUpdateMany.length, 0)
  assert.equal(JSON.stringify((calls.executeRaw[0] as { values?: unknown[] }).values), '["sales-line-draft","20","20","4","4"]')
  assert.deepEqual(
    (calls.salesFindMany[0] as { where: { order: { status: { in: string[] } } } }).where.order.status.in,
    ['DRAFT'],
  )
  assert.deepEqual(
    (calls.purchaseFindMany[0] as { where: { po: { status: { in: string[] } } } }).where.po.status.in,
    ['DRAFT'],
  )
  assert.match(JSON.stringify((calls.executeRaw[1] as { values?: unknown[] }).values), /sales-order-draft/)
  assert.doesNotMatch(JSON.stringify((calls.executeRaw[1] as { values?: unknown[] }).values), /sales-order-raced/)
  assert.equal(JSON.stringify((calls.executeRaw[2] as { values?: unknown[] }).values), '["purchase-line-draft","20","20"]')
  assert.match(JSON.stringify((calls.executeRaw[3] as { values?: unknown[] }).values), /po-draft/)
  assert.doesNotMatch(JSON.stringify((calls.executeRaw[3] as { values?: unknown[] }).values), /po-sent/)
})
