import { expect, test, type Page } from '@playwright/test'
import { addStockAdjustment, createSimpleProduct, signIn, uniqueSuffix } from './helpers'

function csvFile(contents: string) {
  return {
    name: 'import.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(contents, 'utf8'),
  }
}

async function uploadCsvForReview(page: Page, csv: string) {
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Import CSV' }).first().click()
  const chooser = await chooserPromise
  await chooser.setFiles(csvFile(csv))
  const reviewDialog = page.getByRole('dialog', { name: 'Review CSV Import' })
  await expect(reviewDialog).toBeVisible({ timeout: 20000 })
  return reviewDialog
}

async function approveCsvImport(page: Page) {
  const reviewDialog = page.getByRole('dialog', { name: 'Review CSV Import' })
  await reviewDialog.getByRole('button', { name: /^Import /i }).click()
  const resultDialog = page.getByRole('dialog', { name: /Import (Complete|Completed With Issues|Failed)/ })
  await expect(resultDialog).toBeVisible({ timeout: 20000 })
  await resultDialog.getByRole('button', { name: 'Close' }).first().click()
  await expect(resultDialog).toBeHidden()
}

async function createUserFromSettings(
  page: Page,
  options: {
    name: string
    email: string
    password: string
    role: string
  },
) {
  await page.goto('/settings/users')
  await page.getByRole('button', { name: /add user/i }).click()

  const dialog = page.getByRole('dialog', { name: 'Add User' })
  await dialog.locator('input').nth(0).fill(options.name)
  await dialog.locator('input').nth(1).fill(options.email)
  await dialog.locator('input').nth(2).fill(options.password)
  await dialog.locator('select').first().selectOption(options.role)
  await dialog.getByRole('button', { name: /create user/i }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('row').filter({ hasText: options.email }).first()).toContainText(options.role)
}

async function createDraftSalesOrderForRep(
  page: Page,
  options: {
    sku: string
    salesRepName: string
  },
) {
  await page.goto('/sales')
  const dialog = page.getByRole('dialog', { name: 'New Sales Order' })
  const newOrderButton = page.getByRole('button', { name: /new order/i })
  await newOrderButton.click()
  if (!(await dialog.isVisible())) {
    await newOrderButton.click()
  }
  await dialog.getByRole('heading', { name: 'New Sales Order' }).waitFor()

  await dialog.locator('select').first().selectOption({ index: 1 })
  await dialog.getByText('Sales Representative').locator('..').locator('select').selectOption({ label: options.salesRepName })
  await dialog.getByPlaceholder(/search product to add/i).fill(options.sku)
  await dialog.getByRole('button', { name: new RegExp(options.sku) }).first().click()
  await dialog.getByRole('button', { name: /save as draft/i }).click()

  await page.waitForURL(/\/sales\/.+/)
  return page.url()
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
    const reviewDialog = await uploadCsvForReview(page, csv)
    await expect(reviewDialog).toContainText('CSV Records')
    await expect(reviewDialog).toContainText('Will Create')
    await expect(reviewDialog).toContainText('Errors')
    await expect(reviewDialog.getByRole('button', { name: 'Import 1 Record' })).toBeVisible()
    await approveCsvImport(page)

    const search = page.getByPlaceholder(/search sku, name, barcode/i)
    await search.fill(sku)
    await expect(page.getByRole('link', { name: sku, exact: true })).toBeVisible()
  })

  test('creates a warehouse from inventory settings', async ({ page }) => {
    const suffix = uniqueSuffix().slice(-6).toUpperCase()
    const codeA = `E2W${suffix}A`
    const nameA = `E2E Warehouse ${suffix} A`
    const codeB = `E2W${suffix}B`
    const nameB = `E2E Warehouse ${suffix} B`

    await page.goto('/settings/inventory')
    await page.getByRole('button', { name: /add warehouse/i }).click()

    const dialog = page.getByRole('dialog', { name: 'Add Warehouse' })
    await dialog.locator('input').nth(0).fill(codeA)
    await dialog.locator('input').nth(1).fill(nameA)
    await dialog.locator('input').nth(6).fill('Cambridge')
    await dialog.getByRole('button', { name: /create warehouse/i }).click()

    await expect(dialog).toBeHidden()
    const rowA = page.getByRole('row').filter({ hasText: codeA }).first()
    await expect(rowA).toContainText(nameA)

    await page.getByRole('button', { name: /add warehouse/i }).click()
    await expect(dialog.locator('input').nth(0)).toHaveValue('')
    await expect(dialog.locator('input').nth(1)).toHaveValue('')
    await expect(dialog.locator('input').nth(6)).toHaveValue('')

    await dialog.locator('input').nth(0).fill(codeB)
    await dialog.locator('input').nth(1).fill(nameB)
    await dialog.locator('input').nth(6).fill('Oxford')
    await dialog.getByRole('button', { name: /create warehouse/i }).click()

    await expect(dialog).toBeHidden()
    const rowB = page.getByRole('row').filter({ hasText: codeB }).first()
    await expect(rowB).toContainText(nameB)
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

  test('prevents removing admin access from the only admin user', async ({ page }) => {
    await page.goto('/settings/users')

    const adminRow = page.getByRole('row').filter({ hasText: 'admin@example.com' }).first()
    await expect(adminRow).toBeVisible()
    await adminRow.getByRole('button', { name: 'Edit admin@example.com' }).click()

    const editDialog = page.getByRole('dialog', { name: 'Edit User' })
    await expect(editDialog).toBeVisible()

    await editDialog.locator('select').first().selectOption('READONLY')
    await editDialog.getByRole('button', { name: /save changes/i }).click()
    await expect(editDialog.getByText(/cannot change your own role away from admin/i)).toBeVisible()

    await editDialog.locator('select').first().selectOption('ADMIN')
    await editDialog.getByRole('checkbox').uncheck()
    await editDialog.getByRole('button', { name: /save changes/i }).click()
    await expect(editDialog.getByText(/cannot deactivate your own account/i)).toBeVisible()

    await editDialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(editDialog).toBeHidden()
  })

  test('deletes users while keeping or reassigning sales rep history', async ({ page }) => {
    const suffix = uniqueSuffix()
    const keepName = `Keep Rep ${suffix}`
    const keepEmail = `keep.rep.${suffix}@example.com`
    const transferName = `Transfer Rep ${suffix}`
    const transferEmail = `transfer.rep.${suffix}@example.com`
    const recipientName = `Recipient Rep ${suffix}`
    const recipientEmail = `recipient.rep.${suffix}@example.com`
    const password = 'changeme123'

    await createUserFromSettings(page, { name: keepName, email: keepEmail, password, role: 'READONLY' })
    await createUserFromSettings(page, { name: transferName, email: transferEmail, password, role: 'READONLY' })
    await createUserFromSettings(page, { name: recipientName, email: recipientEmail, password, role: 'MANAGER' })

    const product = await createSimpleProduct(page, { price: '18.50' })
    const keepOrderUrl = await createDraftSalesOrderForRep(page, { sku: product.sku, salesRepName: keepName })
    const transferOrderUrl = await createDraftSalesOrderForRep(page, { sku: product.sku, salesRepName: transferName })

    await page.goto('/settings/users')
    const keepRow = page.getByRole('row').filter({ hasText: keepEmail }).first()
    await keepRow.getByRole('button', { name: `Delete ${keepEmail}` }).click()

    const deleteDialog = page.getByRole('dialog', { name: 'Delete User' })
    await expect(deleteDialog).toContainText(`Historical sales orders will continue to show ${keepName}`)
    await deleteDialog.getByRole('button', { name: /delete user/i }).click()
    await expect(deleteDialog).toBeHidden()
    await expect(page.getByRole('row').filter({ hasText: keepEmail })).toHaveCount(0)

    await page.goto(keepOrderUrl)
    await expect(page.getByText(keepName, { exact: true })).toBeVisible()

    await page.goto('/settings/users')
    const transferRow = page.getByRole('row').filter({ hasText: transferEmail }).first()
    await transferRow.getByRole('button', { name: `Delete ${transferEmail}` }).click()

    const transferDialog = page.getByRole('dialog', { name: 'Delete User' })
    await transferDialog.getByLabel(/Reassign existing sales orders/i).check()
    await transferDialog.locator('select').first().selectOption({ label: `${recipientName} — ${recipientEmail} (MANAGER)` })
    await transferDialog.getByRole('button', { name: /delete user/i }).click()
    await expect(transferDialog).toBeHidden()
    await expect(page.getByRole('row').filter({ hasText: transferEmail })).toHaveCount(0)

    await page.goto(transferOrderUrl)
    await expect(page.getByText(recipientName, { exact: true })).toBeVisible()
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
    const reviewDialog = await uploadCsvForReview(page, csv)
    await expect(reviewDialog.getByRole('button', { name: 'Import 3 Records' })).toBeVisible()
    await approveCsvImport(page)

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
