import { expect, test } from '@playwright/test'

test.describe('authenticated smoke', () => {
  test('loads dashboard shell', async ({ page }) => {
    await page.goto('/dashboard')
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Inventory' })).toBeVisible()
  })

  test('loads inventory page', async ({ page }) => {
    await page.goto('/inventory')
    await expect(page.getByRole('heading', { name: 'Inventory' })).toBeVisible()
    await expect(page.getByRole('button', { name: /add product/i })).toBeVisible()
  })

  test('loads sales orders page', async ({ page }) => {
    await page.goto('/sales')
    await expect(page.getByRole('heading', { name: 'Sales Orders' })).toBeVisible()
    await expect(page.getByRole('button', { name: /new order/i })).toBeVisible()
  })

  test('loads purchase orders page', async ({ page }) => {
    await page.goto('/purchase-orders')
    await expect(page.getByRole('heading', { name: 'Purchase Orders' })).toBeVisible()
    await expect(page.getByRole('button', { name: /new po/i })).toBeVisible()
  })
})
