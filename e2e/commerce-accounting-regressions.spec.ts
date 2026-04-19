import { execFileSync } from 'node:child_process'
import { expect, test, type Page } from '@playwright/test'
import { createSimpleProduct } from './helpers'

type FxRefundSeed = {
  orderId: string
  expectedUnitAmount: number
}

type FxRefundInspect = {
  refundLine: {
    unitPriceForeign: number
    unitPriceBase: number
    totalForeign: number
    totalBase: number
  } | null
  creditNoteCurrency: string | null
  creditNoteLines: Array<{
    description: string | null
    quantity: number
    unitAmount: number
  }>
}

type CreditNoteInspect = {
  lines: Array<{
    description: string | null
    quantity: number
    unitAmount: number
    taxType: string | null
  }>
}

type WcFeeSeed = {
  orderId: string
  feeDescription: string
}

type MixedRateRefundSeed = {
  orderId: string
  expectedTaxTypes: string[]
}

type ManualFxUiSeed = {
  currency: string
  expectedLineUnitAmount: number
  expectedLineDiscountAmount: number
  expectedShippingAmount: number
  expectedOrderDiscountAmount: number
}

type WcFeeInspect = {
  shippingForeign: number
  taxForeign: number
  orderLines: Array<{
    description: string
    qty: number
    unitPriceForeign: number
    taxForeign: number
    totalForeign: number
  }>
  invoicePayload: {
    shippingAmount: number
    shippingTaxType: string | null
    lines: Array<{
      description: string | null
      quantity: number
      unitAmount: number
      taxType: string | null
    }>
  }
}

type SalesInvoiceInspect = {
  currency: string | null
  shippingAmount: number
  discountAmount: number
  lineAmountsIncludeTax: boolean | null
  lines: Array<{
    description: string | null
    quantity: number
    unitAmount: number
    discountAmount: number
    taxType: string | null
  }>
}

type WcDiscountSeed = {
  orderId: string
  productDescription: string
  expectedLineDiscountAmount: number
}

type DailyBatchDiscountSeed = {
  manualOrderId: string
  wcOrderId: string
}

type DailyBatchDiscountInspect = Array<{
  id: string
  unearnedRevenueAmount: number
  revenueDeferred: boolean
}>

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

async function createRefundWithoutRestock(page: Page, orderId: string) {
  await page.goto(`/sales/${orderId}`)
  await expect(page.getByRole('button', { name: /^Refund$/ })).toBeVisible()
  await page.getByRole('button', { name: /^Refund$/ }).click()

  const refundDialog = page.getByRole('dialog', { name: 'Process Refund' })
  await expect(refundDialog).toBeVisible()
  await refundDialog.locator('input').first().fill('FX regression refund')
  await refundDialog.locator('select').selectOption('')
  await refundDialog.locator('input[type="number"]').first().fill('1')
  await refundDialog.getByRole('button', { name: /confirm refund/i }).click()
  await expect(refundDialog).toBeHidden()
}

test.describe.serial('connector and accounting regressions', () => {
  test('manual foreign-currency sales orders queue invoice amounts in order currency', async ({ page }) => {
    const seeded = parseJsonLine<ManualFxUiSeed>(runFixture(['seed-manual-fx-order-ui']))
    const product = await createSimpleProduct(page, { price: '10.00' })

    await page.goto('/sales')
    await expect(page.getByRole('heading', { name: 'Sales Orders' })).toBeVisible()
    const newOrderButton = page.getByRole('button', { name: /new order/i })
    await newOrderButton.click()

    const dialog = page.getByRole('dialog', { name: 'New Sales Order' })
    if (!(await dialog.isVisible())) {
      await newOrderButton.click()
    }
    await expect(dialog).toBeVisible()

    await dialog.locator('select').first().selectOption({ index: 1 })
    await dialog.locator('select').nth(1).selectOption(seeded.currency)
    await dialog.locator('input[type="number"]').first().fill('173.4568')
    await dialog.getByPlaceholder(/search product to add/i).fill(product.sku)
    await page.getByRole('button', { name: new RegExp(product.sku) }).first().click()
    await dialog.locator('tbody tr').first().locator('input[type="number"]').nth(1).fill(String(seeded.expectedLineUnitAmount))
    await dialog.locator('tbody tr').first().locator('input[placeholder]').fill(String(seeded.expectedLineDiscountAmount))
    await dialog.getByPlaceholder(/Royal Mail|DPD Next Day/i).fill('EMS')
    await dialog.locator('div').filter({ hasText: /^Shipping/ }).locator('input[type="number"]').fill(String(seeded.expectedShippingAmount))
    await dialog.locator('div').filter({ hasText: /^Order Discount/ }).locator('input[placeholder]').fill(String(seeded.expectedOrderDiscountAmount))
    await dialog.getByRole('button', { name: /^Create Order$/ }).click()

    await page.waitForURL(/\/sales\/.+/)
    const orderId = page.url().split('/').at(-1)
    if (!orderId) throw new Error('failed to determine sales order id from URL')

    const inspected = parseJsonLine<SalesInvoiceInspect>(runFixture(['inspect-sales-invoice', orderId]))
    expect(inspected.currency).toBe(seeded.currency)
    expect(inspected.shippingAmount).toBe(seeded.expectedShippingAmount)
    expect(inspected.discountAmount).toBe(seeded.expectedOrderDiscountAmount)
    expect(inspected.lineAmountsIncludeTax).toBe(false)
    expect(inspected.lines).toEqual([
      expect.objectContaining({
        quantity: 1,
        unitAmount: seeded.expectedLineUnitAmount,
        discountAmount: seeded.expectedLineDiscountAmount,
      }),
    ])
  })

  test('queues foreign-currency credit notes using the original refund currency amount', async ({ page }) => {
    const seeded = parseJsonLine<FxRefundSeed>(runFixture(['seed-fx-refund']))

    await createRefundWithoutRestock(page, seeded.orderId)

    await expect
      .poll(() => runFixture(['inspect-fx-refund', seeded.orderId]))
      .toContain('"creditNoteCurrency":"JPY"')

    const inspected = parseJsonLine<FxRefundInspect>(runFixture(['inspect-fx-refund', seeded.orderId]))

    expect(inspected.refundLine).not.toBeNull()
    expect(inspected.creditNoteCurrency).toBe('JPY')
    expect(inspected.refundLine?.unitPriceForeign).toBeCloseTo(seeded.expectedUnitAmount, 4)
    expect(inspected.refundLine?.totalForeign).toBeCloseTo(seeded.expectedUnitAmount, 4)
    expect(inspected.creditNoteLines).toEqual([
      expect.objectContaining({
        quantity: 1,
        unitAmount: seeded.expectedUnitAmount,
      }),
    ])
  })

  test('queues mixed-rate credit notes with the originating line tax types', async ({ page }) => {
    const seeded = parseJsonLine<MixedRateRefundSeed>(runFixture(['seed-mixed-rate-refund']))

    await page.goto(`/sales/${seeded.orderId}`)
    await expect(page.getByRole('button', { name: /^Refund$/ })).toBeVisible()
    await page.getByRole('button', { name: /^Refund$/ }).click()

    const refundDialog = page.getByRole('dialog', { name: 'Process Refund' })
    await expect(refundDialog).toBeVisible()
    await refundDialog.locator('input').first().fill('Mixed VAT refund')
    await refundDialog.locator('select').selectOption('')
    const qtyInputs = refundDialog.locator('input[type="number"]')
    await qtyInputs.nth(0).fill('1')
    await qtyInputs.nth(1).fill('1')
    await refundDialog.getByRole('button', { name: /confirm refund/i }).click()
    await expect(refundDialog).toBeHidden()

    const inspected = parseJsonLine<CreditNoteInspect>(runFixture(['inspect-credit-note', seeded.orderId]))
    expect(inspected.lines).toHaveLength(2)
    expect(inspected.lines.map((line) => line.taxType)).toEqual(seeded.expectedTaxTypes)
  })

  test('imports WooCommerce fee lines separately from shipping and preserves fee tax', async ({ page }) => {
    const seeded = parseJsonLine<WcFeeSeed>(runFixture(['import-wc-fee-order']))

    await page.goto(`/sales/${seeded.orderId}`)
    await expect(page.getByText(seeded.feeDescription)).toBeVisible()

    const inspected = parseJsonLine<WcFeeInspect>(runFixture(['inspect-wc-fee-order', seeded.orderId]))
    const feeLine = inspected.orderLines.find((line) => line.description === seeded.feeDescription)
    const payloadFeeLine = inspected.invoicePayload.lines.find((line) => line.description === seeded.feeDescription)

    expect(inspected.shippingForeign).toBe(10)
    expect(inspected.taxForeign).toBe(4.25)
    expect(inspected.orderLines).toHaveLength(2)
    expect(feeLine).toEqual(
      expect.objectContaining({
        qty: 1,
        unitPriceForeign: 5,
        taxForeign: 0.25,
        totalForeign: 5,
      }),
    )
    expect(inspected.invoicePayload.shippingAmount).toBe(10)
    expect(inspected.invoicePayload.shippingTaxType).toBe('STANDARD20')
    expect(payloadFeeLine).toEqual(
      expect.objectContaining({
        quantity: 1,
        unitAmount: 5,
        taxType: 'REDUCED5',
      }),
    )
  })

  test('forwards WooCommerce per-line discounts into the Xero invoice payload', async () => {
    const seeded = parseJsonLine<WcDiscountSeed>(runFixture(['import-wc-discount-order']))
    const inspected = parseJsonLine<SalesInvoiceInspect>(runFixture(['inspect-sales-invoice', seeded.orderId]))
    const discountedLine = inspected.lines.find((line) => line.description === seeded.productDescription)

    expect(discountedLine).toEqual(
      expect.objectContaining({
        quantity: 1,
        unitAmount: 12,
        discountAmount: seeded.expectedLineDiscountAmount,
      }),
    )
  })

  test('daily revenue deferral uses source-correct discount treatment for manual and WooCommerce orders', async () => {
    const seeded = parseJsonLine<DailyBatchDiscountSeed>(runFixture(['seed-daily-batch-discounts']))

    const batchRun = runFixture(['run-daily-batch-discounts'])
    expect(batchRun).toContain('"groupA1":2')

    const inspected = parseJsonLine<DailyBatchDiscountInspect>(runFixture([
      'inspect-daily-batch-discounts',
      seeded.manualOrderId,
      seeded.wcOrderId,
    ]))

    const manualOrder = inspected.find((order) => order.id === seeded.manualOrderId)
    const wcOrder = inspected.find((order) => order.id === seeded.wcOrderId)

    expect(manualOrder).toEqual(
      expect.objectContaining({
        revenueDeferred: true,
        unearnedRevenueAmount: 80,
      }),
    )
    expect(wcOrder).toEqual(
      expect.objectContaining({
        revenueDeferred: true,
        unearnedRevenueAmount: 76,
      }),
    )
  })
})
