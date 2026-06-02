import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const databaseUrl = process.env.DATABASE_URL!

function psql(query: string) {
  return execFileSync('psql', [databaseUrl, '-At', '-F', '|', '-c', query], {
    encoding: 'utf8',
  }).trim()
}

function escapeSql(value: string) {
  return value.replace(/'/g, "''")
}

function seedWarehouse() {
  const suffix = randomUUID().slice(0, 8)
  const warehouse = {
    id: `e2e-stock-position-${suffix}`,
    code: `SP${suffix.slice(0, 6).toUpperCase()}`,
    name: `Stock Position Filter ${suffix}`,
  }
  psql(`
    insert into warehouses (id, code, name, active, "createdAt", "updatedAt")
    values ('${escapeSql(warehouse.id)}', '${escapeSql(warehouse.code)}', '${escapeSql(warehouse.name)}', true, now(), now())
    on conflict (id) do nothing;
  `)
  return warehouse
}

test.describe('stock-position report filters', () => {
  test('support searchable keyboard selection, hydration, and clearing', async ({ page }) => {
    const seededWarehouse = seedWarehouse()
    await page.goto('/analytics/stock-on-hand')
    await expect(page.getByRole('heading', { name: 'Stock on Hand', exact: true })).toBeVisible()

    const warehouse = page.getByRole('combobox', { name: 'Warehouse' })
    await warehouse.click()
    await warehouse.pressSequentially(seededWarehouse.code)
    await expect(page.getByRole('listbox', { name: 'All warehouses' })).toBeVisible()
    await expect(page.getByRole('option', { name: new RegExp(seededWarehouse.code) })).toBeVisible()
    await warehouse.press('ArrowDown')
    await warehouse.press('ArrowUp')
    await warehouse.press('Enter')

    const warehouseId = page.locator('input[name="warehouseId"]')
    await expect(warehouseId).toHaveValue(seededWarehouse.id)
    const selectedWarehouseId = await warehouseId.inputValue()
    const selectedWarehouseLabel = await warehouse.inputValue()
    expect(selectedWarehouseLabel).toContain(seededWarehouse.code)

    await page.getByRole('button', { name: 'Apply' }).click()
    await expect(page).toHaveURL(new RegExp(`warehouseId=${encodeURIComponent(selectedWarehouseId)}`))
    await expect(page.getByRole('combobox', { name: 'Warehouse' })).toHaveValue(selectedWarehouseLabel)

    const hydratedWarehouse = page.getByRole('combobox', { name: 'Warehouse' })
    await hydratedWarehouse.click()
    await hydratedWarehouse.pressSequentially(`__${randomUUID()}__`)
    await expect(page.getByRole('option', { name: new RegExp(seededWarehouse.code) })).toBeVisible()
    await hydratedWarehouse.press('Escape')
    await expect(page.getByRole('listbox', { name: 'All warehouses' })).toBeHidden()

    await page.getByRole('button', { name: 'Clear All warehouses' }).click()
    await expect(page.locator('input[name="warehouseId"]')).toHaveCount(0)
    await page.getByRole('button', { name: 'Apply' }).click()
    await expect(page).not.toHaveURL(/warehouseId=/)
  })

  test('shows an empty state for unmatched option searches', async ({ page }) => {
    await page.goto('/analytics/stock-on-hand')

    const noMatchQuery = `__e2e_no_match_${randomUUID()}__`
    const supplier = page.getByRole('combobox', { name: 'Supplier' })
    await supplier.click()
    await supplier.pressSequentially(noMatchQuery)
    await expect(supplier).toHaveValue(noMatchQuery)

    await expect(page.getByText('No matches')).toBeVisible()
  })
})
