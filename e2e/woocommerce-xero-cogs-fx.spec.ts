import { execFileSync } from 'node:child_process'
import { expect, test } from '@playwright/test'

type SeedResult = {
  orderId: string
  sku: string
  expected: {
    currency: string
    fxRateToBase: number
    lineUnitForeign: number
    lineUnitBase: number
    subtotalForeign: number
    subtotalBase: number
    shippingForeign: number
    shippingBase: number
    totalForeign: number
    totalBase: number
    cogsBase: number
    revenueBase: number
  }
}

type ShipAndBatchResult = {
  shipmentId: string
  batchStartedAt: string
  batchResult: {
    groupA1: number
    groupA2: number
    groupB: number
    errors: string[]
  }
}

type InspectResult = {
  order: {
    status: string
    currency: string
    fxRateToBase: number
    subtotalForeign: number
    shippingForeign: number
    taxForeign: number
    totalForeign: number
    subtotalBase: number
    shippingBase: number
    taxBase: number
    totalBase: number
    paid: boolean
    accountingInvoiceId: string | null
    revenueDeferred: boolean
    unearnedRevenueAmount: number
    inventoryAllocated: boolean
    allocationBatchAmount: number
  }
  lines: Array<{
    sku: string | null
    qty: number
    unitPriceForeign: number
    unitPriceBase: number
    totalForeign: number
    totalBase: number
    cogsBase: number | null
  }>
  allocations: Array<{ qty: number; snapshot: Array<Record<string, unknown>> }>
  shipments: Array<{
    status: string
    cogsBatchAmount: number | null
    revenueRecognizedAmount: number | null
    journaled: boolean
    lines: Array<{ qty: number; snapshot: Array<Record<string, unknown>> }>
  }>
  invoicePayload: {
    currency: string | null
    shippingAmount: number
    lineAmountsIncludeTax: boolean | null
    lines: Array<{
      itemCode: string | null
      quantity: number
      unitAmount: number
      accountCode: string | null
      taxType: string | null
    }>
  }
  cogsEntries: Array<{
    qty: number
    unitCostBase: number
    totalCostBase: number
    remainingQty: number
  }>
  dailyLogs: Array<{
    type: string
    lines: Array<{
      accountCode: string | null
      description: string | null
      debit: number
      credit: number
    }>
    orderDeferrals: Array<{ orderId: string | null; amount: number }>
  }>
}

function runFixture(args: string[]): string {
  return execFileSync(
    'npx',
    ['tsx', 'scripts/commerce-accounting-e2e-fixture.ts', ...args],
    {
      cwd: process.cwd(),
      env: process.env,
      encoding: 'utf8',
    },
  ).trim()
}

function parseJsonLine<T>(output: string): T {
  const lines = output.split('\n').map((line) => line.trim()).filter(Boolean)
  const json = lines.at(-1)
  if (!json) throw new Error('fixture output was empty')
  return JSON.parse(json) as T
}

function journalAmount(
  logs: InspectResult['dailyLogs'],
  type: string,
  accountCode: string,
  side: 'debit' | 'credit',
) {
  return logs
    .filter((log) => log.type === type)
    .flatMap((log) => log.lines)
    .filter((line) => line.accountCode === accountCode)
    .reduce((sum, line) => sum + line[side], 0)
}

test.describe.serial('WooCommerce, IMS, and Xero COGS/FX coverage', () => {
  test('imports a foreign-currency WC order into IMS and queues the Xero invoice in source currency', async () => {
    const seeded = parseJsonLine<SeedResult>(runFixture(['seed-wc-fx-cogs-flow']))
    const inspected = parseJsonLine<InspectResult>(runFixture(['inspect-wc-fx-cogs-flow', seeded.orderId]))

    expect(inspected.order).toEqual(
      expect.objectContaining({
        status: 'ALLOCATED',
        currency: seeded.expected.currency,
        fxRateToBase: seeded.expected.fxRateToBase,
        subtotalForeign: seeded.expected.subtotalForeign,
        shippingForeign: seeded.expected.shippingForeign,
        taxForeign: 0,
        totalForeign: seeded.expected.totalForeign,
        paid: true,
      }),
    )
    expect(inspected.order.subtotalBase).toBeCloseTo(seeded.expected.subtotalBase, 4)
    expect(inspected.order.shippingBase).toBeCloseTo(seeded.expected.shippingBase, 4)
    expect(inspected.order.totalBase).toBeCloseTo(seeded.expected.totalBase, 4)

    expect(inspected.lines).toEqual([
      expect.objectContaining({
        sku: seeded.sku,
        qty: 2,
        unitPriceForeign: seeded.expected.lineUnitForeign,
        unitPriceBase: seeded.expected.lineUnitBase,
        totalForeign: seeded.expected.subtotalForeign,
        totalBase: seeded.expected.subtotalBase,
        cogsBase: null,
      }),
    ])
    expect(inspected.allocations).toEqual([
      expect.objectContaining({ qty: 2 }),
    ])

    expect(inspected.invoicePayload).toEqual(
      expect.objectContaining({
        currency: seeded.expected.currency,
        shippingAmount: seeded.expected.shippingForeign,
        lineAmountsIncludeTax: false,
      }),
    )
    expect(inspected.invoicePayload.lines).toEqual([
      expect.objectContaining({
        itemCode: seeded.sku,
        quantity: 2,
        unitAmount: seeded.expected.lineUnitForeign,
        accountCode: '200',
      }),
    ])
  })

  test('ships WC stock, records IMS FIFO COGS in base currency, and stages Xero daily-batch journals', async () => {
    const seeded = parseJsonLine<SeedResult>(runFixture(['seed-wc-fx-cogs-flow']))
    const batched = parseJsonLine<ShipAndBatchResult>(runFixture(['ship-and-batch-wc-fx-cogs-flow', seeded.orderId]))
    expect(batched.batchResult.groupA1).toBeGreaterThanOrEqual(1)
    expect(batched.batchResult.groupA2).toBeGreaterThanOrEqual(1)
    expect(batched.batchResult.groupB).toBeGreaterThanOrEqual(1)

    const inspected = parseJsonLine<InspectResult>(runFixture([
      'inspect-wc-fx-cogs-flow',
      seeded.orderId,
      batched.batchStartedAt,
    ]))

    expect(inspected.order).toEqual(
      expect.objectContaining({
        status: 'SHIPPED',
        revenueDeferred: true,
        inventoryAllocated: true,
      }),
    )
    expect(inspected.order.unearnedRevenueAmount).toBeCloseTo(seeded.expected.revenueBase, 2)
    expect(inspected.order.allocationBatchAmount).toBeCloseTo(seeded.expected.cogsBase, 2)
    expect(inspected.lines[0].cogsBase).toBeCloseTo(seeded.expected.cogsBase, 2)

    expect(inspected.shipments).toEqual([
      expect.objectContaining({
        status: 'SHIPPED',
        journaled: true,
        cogsBatchAmount: seeded.expected.cogsBase,
        revenueRecognizedAmount: seeded.expected.revenueBase,
      }),
    ])
    expect(inspected.shipments[0].lines[0].snapshot).toEqual([
      expect.objectContaining({
        qty: 2,
        unitCostBase: 4.25,
      }),
    ])
    expect(inspected.cogsEntries).toEqual([
      expect.objectContaining({
        qty: 2,
        unitCostBase: 4.25,
        totalCostBase: seeded.expected.cogsBase,
        remainingQty: 0,
      }),
    ])

    const deferralLog = inspected.dailyLogs.find((log) => (
      log.type === 'DAILY_BATCH_REVENUE_DEFERRAL'
      && log.orderDeferrals.some((deferral) => deferral.orderId === seeded.orderId)
    ))
    expect(deferralLog?.orderDeferrals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          orderId: seeded.orderId,
          amount: seeded.expected.revenueBase,
        }),
      ]),
    )

    expect(journalAmount(inspected.dailyLogs, 'DAILY_BATCH_INVENTORY_ALLOC', '631', 'debit')).toBeGreaterThanOrEqual(seeded.expected.cogsBase)
    expect(journalAmount(inspected.dailyLogs, 'DAILY_BATCH_INVENTORY_ALLOC', '630', 'credit')).toBeGreaterThanOrEqual(seeded.expected.cogsBase)
    expect(journalAmount(inspected.dailyLogs, 'DAILY_BATCH_GROUP_B', '820', 'debit')).toBeGreaterThanOrEqual(seeded.expected.revenueBase)
    expect(journalAmount(inspected.dailyLogs, 'DAILY_BATCH_GROUP_B', '200', 'credit')).toBeGreaterThanOrEqual(seeded.expected.revenueBase)
    expect(journalAmount(inspected.dailyLogs, 'DAILY_BATCH_GROUP_B', '500', 'debit')).toBeGreaterThanOrEqual(seeded.expected.cogsBase)
    expect(journalAmount(inspected.dailyLogs, 'DAILY_BATCH_GROUP_B', '631', 'credit')).toBeGreaterThanOrEqual(seeded.expected.cogsBase)
  })
})
