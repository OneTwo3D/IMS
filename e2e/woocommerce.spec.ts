import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const wcEnabled = process.env.E2E_WC_ENABLED === 'true'

async function openWooCommerceConnector(page: Page) {
  await page.goto('/sync?connector=woocommerce')
  await expect(page.getByRole('heading', { name: 'WooCommerce Connector' })).toBeVisible()
}

async function ensureWcProductAndStockSyncEnabled(page: Page) {
  await page.getByRole('button', { name: 'Products' }).click()

  const productCheckbox = page.locator('input[type="checkbox"]').nth(0)
  const stockCheckbox = page.locator('input[type="checkbox"]').nth(1)
  let changed = false

  if (!(await productCheckbox.isChecked())) {
    await productCheckbox.check()
    changed = true
  }
  if (!(await stockCheckbox.isChecked())) {
    await stockCheckbox.check()
    changed = true
  }

  if (changed) {
    await page.getByRole('button', { name: /save settings/i }).click()
    await expect(page.getByText(/saved/i)).toBeVisible()
  }
}

test.describe('@external @wc WooCommerce integration', () => {
  test.skip(!wcEnabled, 'Set E2E_WC_ENABLED=true to run live WooCommerce integration tests.')

  test('runs a live WooCommerce product sync and records it in the WC sync log', async ({ page }) => {
    await openWooCommerceConnector(page)

    await page.getByRole('button', { name: 'Products' }).click()
    const syncButton = page.getByRole('button', { name: /sync products now/i })
    await expect(syncButton).toBeVisible()
    await syncButton.click()

    await expect(page.getByText(/products sync completed:/i)).toBeVisible({ timeout: 60000 })

    await page.getByRole('button', { name: 'Sync Log' }).click()
    await expect(page.getByText(/PRODUCT/i).first()).toBeVisible()
  })

  test('runs a live WooCommerce order sync', async ({ page }) => {
    await openWooCommerceConnector(page)

    await page.getByRole('button', { name: 'Orders' }).click()

    const importButton = page.getByRole('button', { name: /import active orders/i })
    if (await importButton.isVisible()) {
      await importButton.click()
      await expect(page.getByText(/Import completed/i)).toBeVisible({ timeout: 120000 })
    }

    const syncButton = page.getByRole('button', { name: /sync orders now/i })
    await expect(syncButton).toBeVisible()
    await expect(syncButton).toBeEnabled()
    await syncButton.click()

    await expect(page.getByText(/orders sync completed:/i)).toBeVisible({ timeout: 60000 })
  })

  test.fixme('runs a live WooCommerce stock push and records TO_WC sync activity', async () => {
    test.fail(true, 'The demo WooCommerce connector does not currently surface a stable completion signal for Push Stock Now in Playwright runs.')
  })
})
