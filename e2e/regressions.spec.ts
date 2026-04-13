import { expect, test, type Page } from '@playwright/test'
import { addStockAdjustment, createSimpleProduct } from './helpers'

const CBG_WAREHOUSE_LABEL = 'CBG — Cambridge'
const CBG_WAREHOUSE_CODE = 'CBG'
const DEFAULT_WAREHOUSE_LABEL = 'DEFAULT — Default'
const DEFAULT_WAREHOUSE_CODE = 'DEFAULT'

async function createDraftSalesOrder(page: Page, sku: string, warehouseLabel: string) {
  await page.goto('/sales')
  await expect(page.getByRole('heading', { name: 'Sales Orders' })).toBeVisible()
  await page.getByRole('button', { name: /new order/i }).click()

  const dialog = page.getByRole('dialog', { name: 'New Sales Order' })
  await dialog.getByRole('heading', { name: 'New Sales Order' }).waitFor()

  const customerSelect = dialog.locator('select').first()
  await customerSelect.selectOption({ index: 1 })
  await dialog.getByText('Ship From Warehouse').locator('..').locator('select').selectOption({ label: warehouseLabel })
  await dialog.getByPlaceholder(/search product to add/i).fill(sku)
  await dialog.getByRole('button', { name: new RegExp(sku) }).first().click()
  await dialog.getByRole('button', { name: /save as draft/i }).click()

  await page.waitForURL(/\/sales\/.+/)
  await expect(page.getByText(sku, { exact: true })).toBeVisible()
}

test('processing shows allocations in the UI without a page reload', async ({ page }) => {
  const product = await createSimpleProduct(page, { price: '18.50' })
  await addStockAdjustment(page, product.sku, 5, CBG_WAREHOUSE_CODE)

  await createDraftSalesOrder(page, product.sku, CBG_WAREHOUSE_LABEL)

  await page.getByRole('button', { name: 'Process' }).click()

  await expect(page.getByRole('button', { name: /create shipments/i })).toBeVisible()
  await expect(page.getByText(/allocated stock/i)).toBeVisible()
})

test('processing allocates stock from the DEFAULT warehouse', async ({ page }) => {
  const product = await createSimpleProduct(page, { price: '18.50' })
  await addStockAdjustment(page, product.sku, 5, DEFAULT_WAREHOUSE_CODE)

  await createDraftSalesOrder(page, product.sku, DEFAULT_WAREHOUSE_LABEL)

  await page.getByRole('button', { name: 'Process' }).click()
  await expect.poll(async () => {
    await page.reload()
    const createShipmentsVisible = await page.getByRole('button', { name: /create shipments/i }).isVisible().catch(() => false)
    const allocatedStockVisible = await page.getByText(/allocated stock/i).isVisible().catch(() => false)
    return createShipmentsVisible && allocatedStockVisible
  }, {
    timeout: 15000,
    message: 'expected DEFAULT warehouse processing flow to show allocations and shipment creation controls',
  }).toBe(true)

  await expect(page.getByText(/backorder/i)).toHaveCount(0)
})
