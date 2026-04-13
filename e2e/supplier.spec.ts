import { expect, test } from '@playwright/test'
import { signIn } from './helpers'
import { E2E_SUPPLIER_EMAIL, E2E_SUPPLIER_PASSWORD } from './test-data'

test.describe('supplier portal and permissions', () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  test('supplier user can access supplier portal orders page', async ({ page }) => {
    await signIn(page, E2E_SUPPLIER_EMAIL, E2E_SUPPLIER_PASSWORD)
    await page.waitForURL('**/dashboard')

    await page.goto('/supplier/orders')
    await expect(page.getByRole('heading', { name: 'Purchase Orders' })).toBeVisible()
    await expect(page.getByText('Orders placed with your company.')).toBeVisible()
  })

  test('supplier user is forbidden from internal export endpoints', async ({ page }) => {
    await signIn(page, E2E_SUPPLIER_EMAIL, E2E_SUPPLIER_PASSWORD)
    await page.waitForURL('**/dashboard')

    const salesExport = await page.goto('/api/export/sales')
    expect(salesExport?.status()).toBe(403)

    const contactsExport = await page.goto('/api/export/contacts')
    expect(contactsExport?.status()).toBe(403)

    const suppliersExport = await page.goto('/api/export/suppliers')
    expect(suppliersExport?.status()).toBe(403)
  })

  test('supplier user is forbidden from packing slip pdf endpoint', async ({ page }) => {
    await signIn(page, E2E_SUPPLIER_EMAIL, E2E_SUPPLIER_PASSWORD)
    await page.waitForURL('**/dashboard')

    const packingSlip = await page.goto('/api/packing-slip/nonexistent-e2e-order')
    expect(packingSlip?.status()).toBe(403)
  })
})
