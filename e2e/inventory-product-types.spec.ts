import { expect, test } from '@playwright/test'
import {
  addStockAdjustment,
  configureProductComponents,
  createDraftSalesOrder,
  createInventoryProduct,
  openInventoryProduct,
} from './helpers'

const DEFAULT_WAREHOUSE_LABEL = 'DEFAULT — Default'
const DEFAULT_WAREHOUSE_CODE = 'DEFAULT'

test.describe('inventory product types', () => {
  test('supports child simple, kit, and BOM variants under one variable parent', async ({ page }) => {
    const parent = await createInventoryProduct(page, { type: 'VARIABLE' })
    const parentLabel = `${parent.sku} — ${parent.name}`

    const simpleChild = await createInventoryProduct(page, { type: 'VARIANT', parentLabel })
    await openInventoryProduct(page, simpleChild.sku)
    await expect(page.getByRole('link', { name: parent.sku, exact: true })).toBeVisible()
    await expect(page.getByLabel('Type *')).toHaveValue('VARIANT')

    const kitChild = await createInventoryProduct(page, { type: 'KIT', parentLabel })
    await openInventoryProduct(page, kitChild.sku)
    await expect(page.getByRole('link', { name: parent.sku, exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Kit Components' })).toBeVisible()

    const bomChild = await createInventoryProduct(page, { type: 'BOM', parentLabel })
    await openInventoryProduct(page, bomChild.sku)
    await expect(page.getByRole('link', { name: parent.sku, exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Bill of Materials' })).toBeVisible()
  })

  test('allows zero-activity products to transform between simple, kit, BOM, and back', async ({ page }) => {
    const component = await createInventoryProduct(page, { type: 'SIMPLE' })
    const product = await createInventoryProduct(page, { type: 'SIMPLE' })

    await openInventoryProduct(page, product.sku)
    await page.getByLabel('Type *').selectOption('KIT')
    await page.getByRole('button', { name: /save product/i }).click()
    await expect(page.getByText('Kit Components')).toBeVisible()

    await configureProductComponents(page, [{ sku: component.sku, qty: '2' }])
    await expect(page.getByText(component.sku, { exact: true })).toBeVisible()

    await page.getByLabel('Type *').selectOption('BOM')
    await page.getByRole('button', { name: /save product/i }).click()
    await expect(page.getByRole('heading', { name: 'Bill of Materials' })).toBeVisible()
    await expect(page.getByText(component.sku, { exact: true })).toBeVisible()

    await page.getByLabel('Type *').selectOption('SIMPLE')
    await page.getByRole('button', { name: /save product/i }).click()
    await expect(page.getByRole('heading', { name: 'Bill of Materials' })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Kit Components' })).toHaveCount(0)
  })

  test('blocks transforms when stock exists or sales orders are still open', async ({ page }) => {
    const stockBlocked = await createInventoryProduct(page, { type: 'SIMPLE' })
    await addStockAdjustment(page, stockBlocked.sku, 2, DEFAULT_WAREHOUSE_CODE)

    await openInventoryProduct(page, stockBlocked.sku)
    await page.getByLabel('Type *').selectOption('KIT')
    await page.getByRole('button', { name: /save product/i }).click()
    await expect(page.getByText(/cannot change product type while this product has stock on hand/i).first()).toBeVisible()

    const orderBlocked = await createInventoryProduct(page, { type: 'SIMPLE' })
    await createDraftSalesOrder(page, { sku: orderBlocked.sku, warehouseLabel: DEFAULT_WAREHOUSE_LABEL })

    await openInventoryProduct(page, orderBlocked.sku)
    await page.getByLabel('Type *').selectOption('KIT')
    await page.getByRole('button', { name: /save product/i }).click()
    await expect(page.getByText(/open sales order line/i).first()).toBeVisible()
  })

  test('breaks manual kit fulfillment into component allocations and shipment lines', async ({ page }) => {
    const componentA = await createInventoryProduct(page, { type: 'SIMPLE', price: '3.00' })
    const componentB = await createInventoryProduct(page, { type: 'SIMPLE', price: '4.00' })
    const kit = await createInventoryProduct(page, { type: 'KIT', price: '15.00' })

    await openInventoryProduct(page, kit.sku)
    await configureProductComponents(page, [
      { sku: componentA.sku, qty: '2' },
      { sku: componentB.sku, qty: '1' },
    ])

    await addStockAdjustment(page, componentA.sku, 6, DEFAULT_WAREHOUSE_CODE)
    await addStockAdjustment(page, componentB.sku, 3, DEFAULT_WAREHOUSE_CODE)

    await createDraftSalesOrder(page, { sku: kit.sku, warehouseLabel: DEFAULT_WAREHOUSE_LABEL })
    await page.getByRole('button', { name: 'Process' }).click()

    await expect(page.getByText(componentA.sku, { exact: true })).toBeVisible()
    await expect(page.getByText(componentB.sku, { exact: true })).toBeVisible()
    await expect(page.getByText(`For sales line ${kit.sku}`)).toHaveCount(2)

    const createShipmentsButton = page.getByRole('button', { name: /create shipments/i })
    if (await createShipmentsButton.isVisible()) {
      await createShipmentsButton.click()
    }

    await expect(page.getByText(/shipment from/i)).toBeVisible()
    await expect(page.getByText(componentA.sku, { exact: true })).toHaveCount(2)
    await expect(page.getByText(componentB.sku, { exact: true })).toHaveCount(2)
    await expect(page.getByText(`For sales line ${kit.sku}`)).toHaveCount(4)
  })
})
