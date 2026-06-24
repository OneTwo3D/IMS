import { expect, test } from '@playwright/test'
import { createSimpleProduct } from './helpers'

test.describe('workflow coverage', () => {
  test('creates a product through the inventory UI', async ({ page }) => {
    const product = await createSimpleProduct(page)

    await page.getByRole('textbox', { name: /search products/i }).fill(product.sku)
    // Keep first() because highlighted/virtualized search results can render
    // duplicate row-like matches while still representing the same product.
    const row = page.getByRole('row').filter({
      has: page.getByRole('link', { name: product.sku, exact: true }),
    }).first()
    await expect(row).toContainText(product.name)
  })

  test('creates a stock adjustment and shows it in history', async ({ page }) => {
    const product = await createSimpleProduct(page, { price: '9.99' })

    await page.goto('/stock-control/stock-adjustments')
    await expect(page.getByRole('heading', { name: 'Stock Adjustments' })).toBeVisible()
    await page.getByRole('button', { name: /new adjustment/i }).click()

    const dialog = page.getByRole('dialog', { name: 'New Stock Adjustment' })
    await dialog.getByRole('heading', { name: 'New Stock Adjustment' }).waitFor()
    await dialog.getByPlaceholder(/search by sku or name/i).fill(product.sku)
    // vzlk-2c: search results are combobox options now, not plain buttons.
    await dialog.getByRole('option', { name: new RegExp(product.sku) }).first().click()

    // vzlk-2b: target the labelled qty field (no longer the last number input — that
    // is the unit-cost field) and supply a unit cost for the positive new line.
    await dialog.getByRole('spinbutton', { name: /quantity to add or remove/i }).last().fill('5')
    await dialog.locator('input[title^="Unit cost"]').last().fill('10')
    await dialog.getByRole('button', { name: /save adjustments/i }).click()

    await expect(dialog.getByText(/1 adjustment saved\./i)).toBeVisible()
    await expect(dialog).toBeHidden()

    await page.goto('/inventory')
    await page.getByPlaceholder(/search sku, name, barcode/i).fill(product.sku)
    const row = page.getByRole('row').filter({
      has: page.getByRole('link', { name: product.sku, exact: true }),
    }).first()
    await expect(row).toContainText('5 pcs')
  })

  test('creates a draft sales order', async ({ page }) => {
    const product = await createSimpleProduct(page, { price: '15.00' })

    await page.goto('/sales')
    await expect(page.getByRole('heading', { name: 'Sales Orders' })).toBeVisible()
    const dialog = page.getByRole('dialog', { name: 'New Sales Order' })
    const newOrderButton = page.getByRole('button', { name: /new order/i })
    await expect(newOrderButton).toBeVisible()
    await newOrderButton.click()
    if (!(await dialog.isVisible())) {
      await newOrderButton.click()
    }
    await dialog.getByRole('heading', { name: 'New Sales Order' }).waitFor()

    const customerSelect = dialog.locator('select').first()
    const customerName = ((await customerSelect.locator('option').nth(1).textContent()) ?? '').trim()
    await customerSelect.selectOption({ index: 1 })

    await dialog.getByPlaceholder(/search product to add/i).fill(product.sku)
    await dialog.getByRole('button', { name: new RegExp(product.sku) }).first().click()

    await dialog.getByRole('button', { name: /save as draft/i }).click()

    await page.waitForURL(/\/sales\/.+/)
    await expect(page.getByText(customerName, { exact: false })).toBeVisible()
    await expect(page.getByText(product.sku, { exact: true })).toBeVisible()
  })
})
