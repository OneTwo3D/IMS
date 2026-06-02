import { expect, test } from '@playwright/test'

test.describe('stock-position report filters', () => {
  test('support searchable keyboard selection, hydration, and clearing', async ({ page }) => {
    await page.goto('/analytics/stock-on-hand')
    await expect(page.getByRole('heading', { name: 'Stock on Hand', exact: true })).toBeVisible()

    const warehouse = page.getByRole('combobox', { name: 'Warehouse' })
    await warehouse.click()
    await expect(page.getByRole('listbox', { name: 'All warehouses' })).toBeVisible()
    await warehouse.press('ArrowDown')
    await warehouse.press('Enter')

    const warehouseId = page.locator('input[name="warehouseId"]')
    await expect(warehouseId).not.toHaveValue('')
    const selectedWarehouseId = await warehouseId.inputValue()
    const selectedWarehouseLabel = await warehouse.inputValue()
    expect(selectedWarehouseLabel).not.toEqual('')

    await page.getByRole('button', { name: 'Apply' }).click()
    await expect(page).toHaveURL(new RegExp(`warehouseId=${encodeURIComponent(selectedWarehouseId)}`))
    await expect(page.getByRole('combobox', { name: 'Warehouse' })).toHaveValue(selectedWarehouseLabel)

    await page.getByRole('button', { name: 'Clear All warehouses' }).click()
    await expect(page.locator('input[name="warehouseId"]')).toHaveValue('')
  })

  test('shows an empty state for unmatched option searches', async ({ page }) => {
    await page.goto('/analytics/stock-on-hand')

    const supplier = page.getByRole('combobox', { name: 'Supplier' })
    await supplier.click()
    await supplier.pressSequentially('no-supplier-matches-this-e2e-search')
    await expect(supplier).toHaveValue('no-supplier-matches-this-e2e-search')

    await expect(page.getByText('No matches')).toBeVisible()
  })
})
