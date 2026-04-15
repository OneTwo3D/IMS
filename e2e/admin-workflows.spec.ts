import { expect, test } from '@playwright/test'
import { addStockAdjustment, signIn, uniqueSuffix } from './helpers'

function csvFile(contents: string) {
  return {
    name: 'import.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(contents, 'utf8'),
  }
}

test.describe('admin workflows', () => {
  test('imports products from CSV through the inventory UI', async ({ page }) => {
    const suffix = uniqueSuffix()
    const sku = `000-E2E-CSV-${suffix}`
    const csv = [
      'sku,name,type,salesPriceBase,stockUnit',
      `${sku},CSV Imported Product,SIMPLE,9.95,pcs`,
    ].join('\n')

    await page.goto('/inventory')
    await page.locator('input[type="file"]').setInputFiles(csvFile(csv))
    await expect(page.getByText('+1 created')).toBeVisible()

    const search = page.getByPlaceholder(/search sku, name, barcode/i)
    await search.fill(sku)
    await expect(page.getByRole('link', { name: sku, exact: true })).toBeVisible()
  })

  test('creates a warehouse from inventory settings', async ({ page }) => {
    const suffix = uniqueSuffix().slice(-6).toUpperCase()
    const code = `E2W${suffix}`
    const name = `E2E Warehouse ${suffix}`

    await page.goto('/settings/inventory')
    await page.getByRole('button', { name: /add warehouse/i }).click()

    const dialog = page.getByRole('dialog', { name: 'Add Warehouse' })
    await dialog.locator('input').nth(0).fill(code)
    await dialog.locator('input').nth(1).fill(name)
    await dialog.locator('input').nth(6).fill('Cambridge')
    await dialog.getByRole('button', { name: /create warehouse/i }).click()

    await expect(dialog).toBeHidden()
    const row = page.getByRole('row').filter({ hasText: code }).first()
    await expect(row).toContainText(name)
  })

  test('creates a user and verifies profile update plus password change', async ({ browser, page }) => {
    const suffix = uniqueSuffix()
    const email = `e2e.user.${suffix}@example.com`
    const password = 'changeme123'
    const updatedPassword = 'changed1234'
    const initialName = `E2E User ${suffix}`
    const updatedName = `Renamed ${suffix}`

    await page.goto('/settings/users')
    await page.getByRole('button', { name: /add user/i }).click()

    const createDialog = page.getByRole('dialog', { name: 'Add User' })
    await createDialog.locator('input').nth(0).fill(initialName)
    await createDialog.locator('input').nth(1).fill(email)
    await createDialog.locator('input').nth(2).fill(password)
    await createDialog.locator('select').first().selectOption('READONLY')
    await createDialog.getByRole('button', { name: /create user/i }).click()
    await expect(createDialog).toBeHidden()
    await expect(page.getByRole('row').filter({ hasText: email }).first()).toContainText('READONLY')

    const userPage = await browser.newPage({ storageState: { cookies: [], origins: [] } })
    await signIn(userPage, email, password)
    await userPage.waitForURL('**/dashboard')

    await userPage.goto('/profile')
    await expect(userPage.getByRole('heading', { name: 'Profile', exact: true })).toBeVisible()
    await userPage.locator('input:not([type="file"])').nth(0).fill(updatedName)
    await userPage.getByRole('button', { name: /save changes/i }).click()
    await expect(userPage.getByText('Profile updated.')).toBeVisible()

    await userPage.getByRole('button', { name: /change password/i }).click()
    const passwordDialog = userPage.getByRole('dialog', { name: 'Change Password' })
    await passwordDialog.locator('input').nth(0).fill(password)
    await passwordDialog.locator('input').nth(1).fill(updatedPassword)
    await passwordDialog.locator('input').nth(2).fill(updatedPassword)
    await passwordDialog.getByRole('button', { name: /^Change Password$/ }).click()
    await expect(passwordDialog.getByText(/Password changed successfully\./i)).toBeVisible()
    await userPage.close()

    const reloginPage = await browser.newPage({ storageState: { cookies: [], origins: [] } })
    await signIn(reloginPage, email, updatedPassword)
    await reloginPage.waitForURL('**/dashboard')
    await reloginPage.goto('/profile')
    await expect(reloginPage.locator('input:not([type="file"])').nth(0)).toHaveValue(updatedName)
    await reloginPage.close()
  })

  test('creates and completes a manufacturing order from an imported BOM product', async ({ page }) => {
    const suffix = uniqueSuffix()
    const compA = `000-E2E-COMP-A-${suffix}`
    const compB = `000-E2E-COMP-B-${suffix}`
    const bomSku = `000-E2E-BOM-${suffix}`
    const csv = [
      'sku,name,type,salesPriceBase,stockUnit,components',
      `${compA},E2E Component A,SIMPLE,2.00,pcs,`,
      `${compB},E2E Component B,SIMPLE,3.00,pcs,`,
      `${bomSku},E2E BOM ${suffix},BOM,10.00,pcs,${compA}:2;${compB}:1`,
    ].join('\n')

    await page.goto('/inventory')
    await page.locator('input[type="file"]').setInputFiles(csvFile(csv))
    await expect(page.getByText('+3 created')).toBeVisible()

    await addStockAdjustment(page, compA, 10, 'DEFAULT')
    await addStockAdjustment(page, compB, 5, 'DEFAULT')

    await page.goto('/manufacturing')
    await page.getByRole('button', { name: /new order/i }).click()

    const dialog = page.getByRole('dialog', { name: /New Manufacturing Order/i })
    await dialog.getByPlaceholder(/search by sku or name/i).fill(bomSku)
    await dialog.getByRole('button', { name: new RegExp(bomSku) }).first().click()
    await dialog.locator('select').first().selectOption({ label: 'Default (DEFAULT)' })
    await dialog.locator('input[type="number"]').first().fill('2')
    await dialog.locator('input').last().fill('E2E manufacturing run')
    await dialog.getByRole('button', { name: /create order/i }).click()

    const row = page.getByRole('row').filter({ hasText: bomSku }).first()
    await expect(row).toBeVisible()
    await Promise.all([
      page.waitForURL(/\/manufacturing\/.+/),
      row.locator('td').first().click(),
    ])
    await expect(page.getByRole('button', { name: /start production/i })).toBeVisible()

    await page.getByRole('button', { name: /start production/i }).click()
    await expect(page.getByText(/^IN PROGRESS$/i)).toBeVisible()

    await page.getByRole('button', { name: /mark completed/i }).click()
    await expect(page.getByText(/^COMPLETED$/i)).toBeVisible()
  })
})
