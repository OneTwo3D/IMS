import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'

const wcEnabled = process.env.E2E_WC_ENABLED === 'true'
const databaseUrl = process.env.DATABASE_URL!

function psql(query: string) {
  return execFileSync('psql', [databaseUrl, '-At', '-F', '|', '-c', query], {
    encoding: 'utf8',
  }).trim()
}

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

  const fromWooRadio = page.getByLabel('WC → IMS')
  if (!(await fromWooRadio.isChecked())) {
    await fromWooRadio.check()
    changed = true
  }

  if (changed) {
    await page.getByRole('button', { name: /save settings/i }).click()
    await expect(page.getByText(/saved/i)).toBeVisible()
  }
}

test.describe('@external @wc WooCommerce existing-product stock push', () => {
  test.skip(!wcEnabled, 'Set E2E_WC_ENABLED=true to run live WooCommerce integration tests.')

  test('syncs a Woo product into IMS, adds stock, then pushes stock back to Woo', async ({ page }) => {
    test.setTimeout(180000)

    const previousWarehouseFlag = psql(`select "syncToStore"::text from warehouses where code = 'DEFAULT' limit 1;`)
    if (!previousWarehouseFlag) throw new Error('DEFAULT warehouse missing')

    psql(`update warehouses set "syncToStore" = true where code = 'DEFAULT';`)

    try {
      await openWooCommerceConnector(page)
      await ensureWcProductAndStockSyncEnabled(page)

      const syncProductsButton = page.getByRole('button', { name: /sync products now/i })
      await syncProductsButton.click()

      const syncResult = page.getByTestId('sync-result')
      await expect(syncResult).toBeVisible({ timeout: 120000 })
      await expect(syncResult).toContainText(/products sync completed:/i, { timeout: 120000 })
      await expect(syncResult).toHaveAttribute('data-sync-status', 'ok')

      const productRow = psql(`select p.id || '|' || p.sku || '|' || replace(p.name, '|', '/')
        from products p
        join shopping_sync_logs l on l."entityId" = p.id
        where l.direction = 'FROM_CONNECTOR'
          and l.status = 'SYNCED'
          and l."entityType" = 'Product'
          and p.active = true
          and p.type not in ('VARIABLE', 'KIT', 'NON_INVENTORY')
        order by l."createdAt" desc
        limit 1;`)
      const [productId, productSku, productName] = productRow.split('|')
      if (!productId || !productSku || !productName) throw new Error('No Woo-linked product found after product sync')

      await page.goto('/stock-control/stock-adjustments')
      await page.getByRole('button', { name: /new adjustment/i }).click()
      const dialog = page.getByRole('dialog', { name: 'New Stock Adjustment' })
      await dialog.getByPlaceholder(/search by sku or name/i).fill(productName)
      await expect(dialog.getByRole('button').filter({ hasText: productSku }).first()).toBeVisible({ timeout: 30000 })
      await dialog.getByRole('button').filter({ hasText: productSku }).first().click()
      const warehouseSelect = dialog.locator('select').first()
      const requestedWarehouse = warehouseSelect.locator('option', { hasText: 'DEFAULT' })
      if (await requestedWarehouse.count()) {
        const requestedWarehouseLabel = (await requestedWarehouse.first().textContent())?.trim()
        if (requestedWarehouseLabel) {
          await warehouseSelect.selectOption({ label: requestedWarehouseLabel })
        }
      }
      await dialog.locator('input[type="number"]').last().fill('5')
      await dialog.getByRole('button', { name: /save adjustments/i }).click()
      await dialog.getByText(/1 adjustment saved\./i).waitFor({ timeout: 30000 })
      await dialog.waitFor({ state: 'hidden' })

      await openWooCommerceConnector(page)
      await page.getByRole('button', { name: 'Products' }).click()
      await page.getByRole('button', { name: /push stock now/i }).click()

      await expect(syncResult).toBeVisible({ timeout: 120000 })
      await expect(syncResult).not.toHaveAttribute('data-sync-status', 'error')
      await expect(syncResult).toContainText(/synced|candidate|matched/i, { timeout: 120000 })

      const externalProductId = psql(`select coalesce("externalProductId"::text, '') from products where id = '${productId}' limit 1;`)
      if (!externalProductId) throw new Error(`Selected Woo-linked product ${productSku} (${productId}) is missing externalProductId after sync`)

      await expect.poll(() => (
        psql(`select id from shopping_sync_logs where "entityType" = 'StockLevel' and "externalId" = ${externalProductId} and direction = 'TO_CONNECTOR' and status = 'SYNCED' order by "createdAt" desc limit 1;`)
      ), {
        timeout: 120000,
      }).not.toEqual('')
    } finally {
      psql(`update warehouses set "syncToStore" = ${previousWarehouseFlag === 'true' ? 'true' : 'false'} where code = 'DEFAULT';`)
    }
  })
})
