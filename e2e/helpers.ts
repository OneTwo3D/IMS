import type { Page } from '@playwright/test'

export function uniqueSuffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export async function signIn(page: Page, email: string, password: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.locator('form').getByRole('button', { name: 'Sign in', exact: true }).click()
}

export async function createSimpleProduct(page: Page, opts?: {
  sku?: string
  name?: string
  price?: string
}) {
  const suffix = uniqueSuffix()
  const sku = opts?.sku ?? `000-E2E-SKU-${suffix}`
  const name = opts?.name ?? `E2E Product ${suffix}`
  const price = opts?.price ?? '12.50'

  await page.goto('/inventory')
  await page.getByRole('button', { name: /add product/i }).click()
  await page.getByRole('heading', { name: 'New Product' }).waitFor()

  await page.getByLabel('SKU *').fill(sku)
  await page.getByLabel('Name *').fill(name)
  await page.getByLabel('Regular Price (GBP)').fill(price)
  await page.getByRole('button', { name: /save product/i }).click()

  await page.waitForURL(/\/inventory/)
  const searchInput = page.getByPlaceholder(/search sku, name, barcode/i)
  await searchInput.fill(sku)
  await page.getByRole('link', { name: sku, exact: true }).waitFor()

  return { sku, name, price }
}

export async function addStockAdjustment(page: Page, sku: string, qty: number, warehouseCode?: string) {
  await page.goto('/stock-control/stock-adjustments')
  await page.getByRole('button', { name: /new adjustment/i }).click()

  const dialog = page.getByRole('dialog', { name: 'New Stock Adjustment' })
  await dialog.getByPlaceholder(/search by sku or name/i).fill(sku)
  await dialog.getByRole('button', { name: new RegExp(sku) }).first().click()
  if (warehouseCode) {
    const warehouseSelect = dialog.locator('select').first()
    const requestedWarehouse = warehouseSelect.locator('option', { hasText: warehouseCode })
    if (await requestedWarehouse.count()) {
      const requestedWarehouseLabel = (await requestedWarehouse.first().textContent())?.trim()
      if (requestedWarehouseLabel) {
        await warehouseSelect.selectOption({ label: requestedWarehouseLabel })
      }
    }
  }
  await dialog.locator('input[type="number"]').last().fill(String(qty))
  await dialog.getByRole('button', { name: /save adjustments/i }).click()

  await dialog.getByText(/1 adjustment saved\./i).waitFor()
  await dialog.waitFor({ state: 'hidden' })
}
