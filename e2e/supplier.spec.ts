import { expect, test } from '@playwright/test'
import { createSimpleProduct, signIn } from './helpers'
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

  test('supplier user can submit a quote for an RFQ', async ({ browser, page }) => {
    const adminPage = await browser.newPage({ storageState: 'e2e/.auth/admin.json' })
    const product = await createSimpleProduct(adminPage, { price: '15.25' })

    await adminPage.goto('/purchase-orders')
    await adminPage.getByRole('button', { name: /new po/i }).click()

    const dialog = adminPage.getByRole('dialog', { name: 'New Purchase Order' })
    await dialog.locator('select').first().selectOption({ label: 'E2E Supplier' })
    await dialog.getByPlaceholder(/search product to add/i).fill(product.sku)
    await dialog.getByRole('button', { name: new RegExp(product.sku) }).first().click()
    await dialog.getByRole('button', { name: /create purchase order/i }).click()

    await adminPage.waitForURL(/\/purchase-orders\/.+/)
    await expect(adminPage.getByText(product.sku, { exact: true })).toBeVisible()
    await adminPage.getByRole('button', { name: /mark rfq sent/i }).click()
    await expect(adminPage.getByText(/^RFQ Sent$/)).toBeVisible()

    const poReference = (await adminPage.locator('h1.font-mono').first().textContent())?.trim()
    expect(poReference).toBeTruthy()
    await adminPage.close()

    await signIn(page, E2E_SUPPLIER_EMAIL, E2E_SUPPLIER_PASSWORD)
    await page.waitForURL('**/dashboard')

    await page.goto('/supplier/rfqs')
    await expect(page.getByRole('heading', { name: 'Requests for Quotation' })).toBeVisible()

    const rfqRow = page.getByRole('row').filter({ hasText: poReference! }).first()
    await expect(rfqRow).toContainText('Awaiting Quote')
    await rfqRow.getByRole('link', { name: poReference!, exact: true }).click()

    await expect(page.getByText(product.sku, { exact: true })).toBeVisible()
    await page.getByPlaceholder('e.g. INV-12345').fill(`SUP-${product.sku}`)
    await page.locator('input[type="date"]').fill('2026-04-20')
    const quoteDetails = page.locator('div').filter({ has: page.getByRole('heading', { name: 'Your Quote Details' }) }).first()
    await quoteDetails.locator('input[type="number"]').last().fill('12.50')
    await page.getByPlaceholder('e.g. DHL Express, Sea Freight').fill('DHL Express')

    const quoteRow = page.getByRole('row').filter({ hasText: product.sku }).first()
    await quoteRow.locator('input[type="number"]').nth(1).fill('13.40')
    await page.getByRole('button', { name: /submit quote/i }).click()

    await expect(page.getByRole('heading', { name: 'Quote Submitted' })).toBeVisible()
    await page.goto('/supplier/orders')
    const orderRow = page.getByRole('row').filter({ hasText: poReference! }).first()
    await expect(orderRow).toContainText(`SUP-${product.sku}`)
    await expect(orderRow).toContainText('PO SENT')
  })
})
