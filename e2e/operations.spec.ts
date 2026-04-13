import { expect, test } from '@playwright/test'
import { addStockAdjustment, createSimpleProduct } from './helpers'

test.describe.serial('operations workflows', () => {
  test('creates a draft warehouse transfer', async ({ page }) => {
    const product = await createSimpleProduct(page, { price: '7.50' })
    await addStockAdjustment(page, product.sku, 8)

    await page.goto('/stock-control/transfers')
    await expect(page.getByRole('heading', { name: 'Warehouse Transfers' })).toBeVisible()
    await page.getByRole('button', { name: /new transfer/i }).click()

    const dialog = page.getByRole('dialog', { name: 'New Stock Transfer' })
    await dialog.getByPlaceholder(/search by sku or name/i).fill(product.sku)
    await dialog.getByRole('button', { name: new RegExp(product.sku) }).first().click()
    await dialog.locator('input[type="number"]').last().fill('3')
    await dialog.getByRole('button', { name: /save as draft/i }).click()

    await expect(dialog).toBeHidden()

    const row = page.getByRole('row').filter({
      has: page.getByRole('button', { name: 'Dispatch' }),
    }).first()
    await expect(row).toContainText('Draft')

    await row.click()
    await expect(page.getByText(product.sku, { exact: true })).toBeVisible()
    await expect(page.getByText('3', { exact: true })).toBeVisible()
  })

  test('creates a purchase order for the seeded supplier', async ({ page }) => {
    const product = await createSimpleProduct(page, { price: '22.00' })

    await page.goto('/purchase-orders')
    await expect(page.getByRole('heading', { name: 'Purchase Orders' })).toBeVisible()
    await page.getByRole('button', { name: /new po/i }).click()

    const dialog = page.getByRole('dialog', { name: 'New Purchase Order' })
    const supplierSelect = dialog.locator('select').first()
    await supplierSelect.selectOption({ label: 'E2E Supplier' })

    await dialog.getByPlaceholder(/search product to add/i).fill(product.sku)
    await dialog.getByRole('button', { name: new RegExp(product.sku) }).first().click()
    await dialog.getByRole('button', { name: /create purchase order/i }).click()

    await page.waitForURL(/\/purchase-orders\/.+/)
    await expect(page.getByText('E2E Supplier', { exact: false })).toBeVisible()
    await expect(page.getByText(product.sku, { exact: true })).toBeVisible()
  })

  test('dispatches and receives a warehouse transfer', async ({ page }) => {
    const product = await createSimpleProduct(page, { price: '8.25' })
    await addStockAdjustment(page, product.sku, 6)

    await page.goto('/stock-control/transfers')
    await page.getByRole('button', { name: /new transfer/i }).click()

    const dialog = page.getByRole('dialog', { name: 'New Stock Transfer' })
    await dialog.locator('select').nth(1).selectOption({ label: 'E2E-SECOND — E2E Secondary' })
    await dialog.getByPlaceholder(/search by sku or name/i).fill(product.sku)
    await dialog.getByRole('button', { name: new RegExp(product.sku) }).first().click()
    await dialog.locator('input[type="number"]').last().fill('4')
    await dialog.getByRole('button', { name: /save as draft/i }).click()
    await expect(dialog).toBeHidden()

    const draftRow = page.getByRole('row').filter({
      has: page.getByRole('button', { name: 'Dispatch' }),
      hasText: 'E2E-SECOND',
    }).first()
    await draftRow.getByRole('button', { name: 'Dispatch' }).click()

    const transitRow = page.getByRole('row').filter({
      has: page.getByRole('button', { name: /mark received/i }),
      hasText: 'E2E-SECOND',
    }).first()
    await expect(transitRow).toContainText('In Transit')
    await expect(transitRow.getByRole('button', { name: /mark received/i })).toBeVisible()

    await transitRow.getByRole('button', { name: /mark received/i }).click()
    const receivedRow = page.getByRole('row').filter({
      hasText: 'E2E-SECOND',
    }).first()
    await expect(receivedRow).toContainText('Received')
    await receivedRow.click()
    await expect(page.getByText(product.sku, { exact: true })).toBeVisible()
    await expect(page.getByText('4', { exact: true })).toBeVisible()
  })

  test('confirms and receives a purchase order', async ({ page }) => {
    const product = await createSimpleProduct(page, { price: '19.00' })

    await page.goto('/purchase-orders')
    await page.getByRole('button', { name: /new po/i }).click()

    const dialog = page.getByRole('dialog', { name: 'New Purchase Order' })
    const supplierSelect = dialog.locator('select').first()
    await supplierSelect.selectOption({ label: 'E2E Supplier' })
    await dialog.getByPlaceholder(/search product to add/i).fill(product.sku)
    await dialog.getByRole('button', { name: new RegExp(product.sku) }).first().click()
    await dialog.getByRole('button', { name: /create purchase order/i }).click()

    await page.waitForURL(/\/purchase-orders\/.+/)
    await page.getByRole('button', { name: /confirm & send po/i }).click()
    await expect(page.getByText(/^PO Sent$/)).toBeVisible()

    await page.getByRole('button', { name: /receive goods/i }).click()
    const receiveDialog = page.getByRole('dialog', { name: new RegExp(`Receive Goods`) })
    await receiveDialog.getByRole('button', { name: /confirm receipt/i }).click()
    await expect(receiveDialog).toBeHidden()

    await expect(page.getByText('Received', { exact: false })).toBeVisible()
    const lineRow = page.getByRole('row').filter({
      has: page.getByText(product.sku, { exact: true }),
    }).first()
    await expect(lineRow).toContainText('1')
  })
})
