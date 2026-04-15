import { expect, test } from '@playwright/test'
import { addStockAdjustment, createSimpleProduct } from './helpers'

const FULFILLMENT_WAREHOUSE_LABEL = 'CBG — Cambridge'
const FULFILLMENT_WAREHOUSE_CODE = 'CBG'
const allocatedStatus = /^(Allocated)$/
const shippedStatus = /^(Shipped)$/
const INITIAL_TRACKING = 'E2E-TRACK-INITIAL-001'
const UPDATED_TRACKING = 'E2E-TRACK-UPDATED-002'
const INITIAL_CARRIER = 'Royal Mail'
const UPDATED_CARRIER = 'DHL'

test('processes a sales order through shipment and tracking edit', async ({ page }) => {
  const product = await createSimpleProduct(page, { price: '18.50' })
  await addStockAdjustment(page, product.sku, 5, FULFILLMENT_WAREHOUSE_CODE)

  await page.goto('/sales')
  await expect(page.getByRole('heading', { name: 'Sales Orders' })).toBeVisible()
  await page.getByRole('button', { name: /new order/i }).click()

  const createDialog = page.getByRole('dialog', { name: 'New Sales Order' })
  const customerSelect = createDialog.locator('select').first()
  await customerSelect.selectOption({ index: 1 })
  await createDialog.getByText('Ship From Warehouse').locator('..').locator('select').selectOption({ label: FULFILLMENT_WAREHOUSE_LABEL })
  await createDialog.getByPlaceholder(/search product to add/i).fill(product.sku)
  await createDialog.getByRole('button', { name: new RegExp(product.sku) }).first().click()
  await createDialog.getByRole('button', { name: /save as draft/i }).click()

  await page.waitForURL(/\/sales\/.+/)
  await expect(page.getByText(product.sku, { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Process' }).click()
  await expect(page.getByText(allocatedStatus)).toBeVisible()
  await page.reload()
  await expect(page.getByText(allocatedStatus)).toBeVisible()

  const createShipmentsButton = page.getByRole('button', { name: /create shipments/i })
  if (await createShipmentsButton.isVisible()) {
    await createShipmentsButton.click()
  }
  await expect(page.getByText(/shipment from/i)).toBeVisible()

  await page.getByRole('button', { name: /start picking/i }).click()
  await expect(page.getByText('Picking', { exact: false })).toBeVisible()

  await page.getByRole('button', { name: /mark packed/i }).click()
  await expect(page.getByText('Packed', { exact: false })).toBeVisible()

  await page.getByRole('button', { name: /^Ship$/ }).click()
  const shipDialog = page.getByRole('dialog', { name: 'Ship Parcel' })
  await expect(shipDialog).toBeVisible()
  await shipDialog.locator('select').selectOption({ label: INITIAL_CARRIER })
  await shipDialog.locator('input').fill(INITIAL_TRACKING)
  await shipDialog.getByRole('button', { name: /confirm shipment/i }).click()
  await expect(shipDialog).toBeHidden()

  await expect(page.getByText(shippedStatus).first()).toBeVisible()
  await expect(page.getByText(`#${INITIAL_TRACKING}`)).toBeVisible()

  await page.getByRole('button', { name: /edit tracking/i }).click()
  const editDialog = page.getByRole('dialog', { name: 'Edit Tracking' })
  await expect(editDialog).toBeVisible()
  await expect(editDialog.locator('input')).toHaveValue(INITIAL_TRACKING)
  await editDialog.locator('select').selectOption({ label: UPDATED_CARRIER })
  await editDialog.locator('input').fill(UPDATED_TRACKING)
  await editDialog.getByRole('button', { name: /save tracking/i }).click()
  await expect(editDialog).toBeHidden()

  await expect(page.getByText(`#${UPDATED_TRACKING}`)).toBeVisible()
  await expect(page.getByText(`#${INITIAL_TRACKING}`)).toHaveCount(0)
})
