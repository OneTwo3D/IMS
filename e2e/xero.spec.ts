import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { addStockAdjustment, createDraftSalesOrder, createSimpleProduct } from './helpers'

const xeroEnabled = process.env.E2E_XERO_ENABLED === 'true'
const XERO_WAREHOUSE_LABEL = 'CBG — Cambridge'
const XERO_WAREHOUSE_CODE = 'CBG'

async function createShippedOrderWithPendingAccounting(page: Page) {
  const product = await createSimpleProduct(page, { price: '23.00' })
  await addStockAdjustment(page, product.sku, 3, XERO_WAREHOUSE_CODE)
  await createDraftSalesOrder(page, { sku: product.sku, warehouseLabel: XERO_WAREHOUSE_LABEL })

  const orderId = page.url().split('/').pop()!
  await page.getByRole('button', { name: 'Process' }).click()
  await expect(page.getByText(/^Allocated$/)).toBeVisible()
  await expect
    .poll(async () => {
      await page.reload()
      return page.getByRole('button', { name: /create shipments/i }).isVisible()
    })
    .toBe(true)

  await page.getByRole('button', { name: /create shipments/i }).click()
  await expect(page.getByText(/shipment from/i)).toBeVisible()
  await page.getByRole('button', { name: /start picking/i }).click()
  await expect(page.getByText('Picking', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: /mark packed/i }).click()
  await expect(page.getByText('Packed', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: /^Ship$/ }).click()
  const shipDialog = page.getByRole('dialog', { name: /Ship/ })
  await shipDialog.getByRole('button', { name: /confirm shipment/i }).click()
  await expect(shipDialog).toBeHidden()
  await expect(page.getByText(/^Shipped$/).first()).toBeVisible()
  await expect(page.getByText(/invoice pending sync/i)).toBeVisible()

  return { orderId }
}

async function openXeroConnector(page: Page) {
  await page.goto('/sync?connector=xero')
  await expect(page.getByRole('heading', { name: 'Xero Connector' })).toBeVisible()
}

async function processPendingXeroSync(page: Page) {
  await openXeroConnector(page)
  await page.getByRole('button', { name: 'Sync' }).click()

  const processButton = page.getByRole('button', { name: /process pending now/i })
  await expect(processButton).toBeVisible()
  await expect(processButton).toBeEnabled()
  await processButton.click()

  await expect(page.getByText(/Sync complete:/i)).toBeVisible({ timeout: 120000 })
}

async function expectXeroLogRow(
  page: Page,
  typeText: string,
  referenceIdPrefix: string,
) {
  const row = page.getByRole('row').filter({ hasText: typeText }).filter({ hasText: referenceIdPrefix }).first()
  await expect(row).toBeVisible({ timeout: 30000 })
}

async function createReceivedPoWithBill(page: Page) {
  const product = await createSimpleProduct(page, { price: '18.00' })

  await page.goto('/purchase-orders')
  await page.getByRole('button', { name: /new po/i }).click()

  const dialog = page.getByRole('dialog', { name: 'New Purchase Order' })
  await dialog.locator('select').first().selectOption({ label: 'E2E Supplier' })
  await dialog.getByPlaceholder(/search product to add/i).fill(product.sku)
  await dialog.getByRole('button', { name: new RegExp(product.sku) }).first().click()
  await dialog.getByRole('button', { name: /create purchase order/i }).click()

  await page.waitForURL(/\/purchase-orders\/.+/)
  const poId = page.url().split('/').pop()!
  await page.getByRole('button', { name: /confirm & send po/i }).click()
  await expect(page.getByText(/^PO Sent$/)).toBeVisible()

  await page.getByRole('button', { name: /receive goods/i }).click()
  const receiveDialog = page.getByRole('dialog', { name: /Receive Goods/ })
  await receiveDialog.getByRole('button', { name: /confirm receipt/i }).click()
  await expect(receiveDialog).toBeHidden()
  await expect(page.getByText(/^Received$/).first()).toBeVisible()

  await page.getByRole('button', { name: /create bill/i }).click()
  const billDialog = page.getByRole('dialog', { name: /Create Bill/ })
  await billDialog.getByRole('button', { name: /^Next$/ }).click()
  await expect(page.getByRole('dialog', { name: /Create Bill — Review & Confirm/ })).toBeVisible()
  await billDialog.getByPlaceholder(/supplier's invoice/i).fill(`E2E-BILL-${Date.now()}`)
  await billDialog.getByRole('button', { name: /confirm bill/i }).click()
  await expect(billDialog).toBeHidden()
  await expect(page.getByRole('button', { name: /Bills \(1\)/ })).toBeVisible()

  return { poId }
}

test.describe.serial('@external @xero Xero integration', () => {
  test.skip(!xeroEnabled, 'Set E2E_XERO_ENABLED=true to run live Xero integration tests.')

  test('processes pending sync entries in Xero for a shipped sales order', async ({ page }) => {
    const { orderId } = await createShippedOrderWithPendingAccounting(page)

    await processPendingXeroSync(page)
    await expectXeroLogRow(page, 'SALES INVOICE', orderId.slice(0, 8))
  })

  test('queues refund credit notes for Xero and records them in the sync log', async ({ page }) => {
    const { orderId } = await createShippedOrderWithPendingAccounting(page)

    await page.getByRole('button', { name: /^Refund$/ }).click()
    const refundDialog = page.getByRole('dialog', { name: 'Process Refund' })
    await refundDialog.locator('input').first().fill('Xero live refund')
    await refundDialog.locator('input[type="number"]').first().fill('1')
    await refundDialog.getByRole('button', { name: /confirm refund/i }).click()
    await expect(refundDialog).toBeHidden()
    await expect(page.getByText(/Refunds \(1\)/)).toBeVisible()

    await processPendingXeroSync(page)
    await expectXeroLogRow(page, 'CREDIT NOTE', orderId.slice(0, 8))
  })

  test('syncs purchase bills to Xero', async ({ page }) => {
    test.setTimeout(120000)
    const { poId } = await createReceivedPoWithBill(page)

    await processPendingXeroSync(page)
    await expectXeroLogRow(page, 'PURCHASE INVOICE', poId.slice(0, 8))
  })

  test.fixme('syncs stock receipt journals to Xero', async () => {
    test.fail(true, 'The demo Xero tenant currently does not surface a successful STOCK RECEIPT log row for the new PO after manual processing.')
  })

  test.fixme('syncs inventory adjustments to Xero', async () => {
    test.fail(true, 'The demo Xero tenant currently does not surface a successful INVENTORY ADJUSTMENT log row for a new stock adjustment after manual processing.')
  })
})
