import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Prisma, SalesOrderStatus } from '@/app/generated/prisma/client'
import {
  getApAgingReport,
  getArAgingReport,
  getFxGainLossReport,
  getVatReport,
  type FinanceAnalyticsClient,
} from '@/lib/domain/finance/finance-period-analytics'

function decimal(value: string | number): Prisma.Decimal {
  return new Prisma.Decimal(value)
}

function unusedClient(): FinanceAnalyticsClient {
  const unused = { findMany: async () => [] }
  return {
    salesOrder: unused,
    salesOrderLine: unused,
    payment: unused,
    purchaseInvoice: unused,
    fxRate: unused,
  }
}

const settings = async () => ({
  accountsReceivableAccount: '110',
  accountsPayableAccount: '210',
  realisedFxGainLossAccount: '610',
})

test('VAT report totals sales order line tax by rate and jurisdiction', async () => {
  const client: FinanceAnalyticsClient = {
    ...unusedClient(),
    salesOrderLine: {
      findMany: async () => [
        {
          taxRateId: 'tax-20',
          taxForeign: decimal('20'),
          taxBase: decimal('20'),
          totalBase: decimal('120'),
          order: { shippingAddress: { country: 'gb' }, pricesIncludeVat: true },
          taxRate: { name: 'UK Standard', rate: decimal('0.2'), accountingTaxType: 'OUTPUT2', countryCode: 'GB' },
        },
        {
          taxRateId: 'tax-20',
          taxForeign: decimal('10'),
          taxBase: decimal('10'),
          totalBase: decimal('50'),
          order: { shippingAddress: { country: 'GB' }, pricesIncludeVat: false },
          taxRate: { name: 'UK Standard', rate: decimal('0.2'), accountingTaxType: 'OUTPUT2', countryCode: 'GB' },
        },
      ],
    },
  }

  const report = await getVatReport(
    { dateFrom: '2026-06-01', dateTo: '2026-06-30' },
    { deps: { client, now: () => new Date('2026-06-30T00:00:00.000Z') } },
  )

  assert.equal(report.rows[0]?.taxableBase, '150')
  assert.equal(report.rows[0]?.taxBase, '30')
  assert.equal(report.totals.taxBase, '30')
})

test('AR aging subtracts non-refund payments and uses configurable buckets', async () => {
  const client: FinanceAnalyticsClient = {
    ...unusedClient(),
    salesOrder: {
      findMany: async () => [{
        id: 'so-1',
        customerId: 'customer-1',
        customerName: 'Customer A',
        customerEmail: 'a@example.com',
        createdAt: new Date('2026-05-01T00:00:00.000Z'),
        invoicedAt: new Date('2026-05-01T00:00:00.000Z'),
        paidAt: null,
        totalBase: decimal('120'),
        payments: [
          { amount: decimal('20'), paidAt: new Date('2026-05-05T00:00:00.000Z'), refundId: null },
          { amount: decimal('50'), paidAt: new Date('2026-06-05T00:00:00.000Z'), refundId: null },
          { amount: decimal('-5'), paidAt: new Date('2026-05-06T00:00:00.000Z'), refundId: 'refund-1' },
        ],
        status: SalesOrderStatus.PROCESSING,
      }],
    },
  }

  const report = await getArAgingReport(
    { bucket1Days: 10, bucket2Days: 20, bucket3Days: 40 },
    { deps: { client, now: () => new Date('2026-06-01T00:00:00.000Z') } },
  )

  assert.equal(report.rows[0]?.bucket3, '100')
  assert.equal(report.rows[0]?.outstandingBase, '100')
  assert.equal(report.totals.outstandingBase, '100')
  assert.equal(report.totals.bucket1Days, '10')
})

test('AP aging reconciles unpaid supplier invoices into aging buckets', async () => {
  const client: FinanceAnalyticsClient = {
    ...unusedClient(),
    purchaseInvoice: {
      findMany: async () => [{
        id: 'pi-1',
        invoiceNumber: 'PI-1',
        invoiceDate: new Date('2026-05-01T00:00:00.000Z'),
        dueDate: new Date('2026-05-15T00:00:00.000Z'),
        paidAt: null,
        totalBase: decimal('75'),
        po: { supplierId: 'supplier-1', supplier: { name: 'Supplier A', email: 'supplier@example.com' } },
      }],
    },
  }

  const report = await getApAgingReport(
    { bucket1Days: 30, bucket2Days: 60, bucket3Days: 90 },
    { deps: { client, now: () => new Date('2026-06-01T00:00:00.000Z') } },
  )

  assert.equal(report.rows[0]?.bucket1, '75')
  assert.equal(report.rows[0]?.outstandingBase, '75')
  assert.equal(report.totals.outstandingBase, '75')
})

test('FX gain/loss uses latest settlement rate and configured Xero accounts', async () => {
  const client: FinanceAnalyticsClient = {
    ...unusedClient(),
    payment: {
      findMany: async () => [{
        id: 'payment-1',
        amount: decimal('120'),
        currency: 'USD',
        paidAt: new Date('2026-06-10T00:00:00.000Z'),
        refundId: null,
        order: {
          id: 'so-1',
          orderNumber: 'SO-1',
          invoiceNumber: 'INV-1',
          currency: 'USD',
          fxRateToBase: decimal('1.2'),
          customerName: 'Customer A',
          customerEmail: null,
        },
      }],
    },
    fxRate: {
      findMany: async () => [
        { fromCurrency: 'GBP', toCurrency: 'USD', rate: decimal('1.5'), fetchedAt: new Date('2026-06-09T00:00:00.000Z') },
        { fromCurrency: 'GBP', toCurrency: 'USD', rate: decimal('1.1'), fetchedAt: new Date('2026-06-11T00:00:00.000Z') },
      ],
    },
  }

  const report = await getFxGainLossReport(
    { dateFrom: '2026-06-01', dateTo: '2026-06-30' },
    { deps: { client, now: () => new Date('2026-06-30T00:00:00.000Z'), accountingSettings: settings } },
  )

  assert.equal(report.rows[0]?.bookedBase, '100')
  assert.equal(report.rows[0]?.settlementBase, '80')
  assert.equal(report.rows[0]?.gainLossBase, '-20')
  assert.equal(report.rows[0]?.fxGainLossAccount, '610')
  assert.equal(report.totals.lossesBase, '20')
})
