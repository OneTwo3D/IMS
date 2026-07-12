import type { Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'

const databaseUrl = process.env.DATABASE_URL!

function psql(query: string) {
  return execFileSync('psql', [databaseUrl, '-At', '-F', '|', '-c', query], {
    encoding: 'utf8',
  }).trim()
}

function escapeSql(value: string) {
  return value.replace(/'/g, "''")
}

export function uniqueSuffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

async function getProductRecordBySku(sku: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const row = psql(`
      select id, name
      from products
      where sku = '${escapeSql(sku)}'
      order by "createdAt" desc
      limit 1;
    `)
    if (row) {
      const [productId, name] = row.split('|')
      return {
        productId,
        name,
        productHref: `/inventory/${productId}`,
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  throw new Error(`Product with SKU ${sku} was not found in the database`)
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
  return createInventoryProduct(page, { ...opts, type: 'SIMPLE' })
}

export async function createInventoryProduct(page: Page, opts?: {
  sku?: string
  name?: string
  price?: string
  type?: 'SIMPLE' | 'VARIABLE' | 'VARIANT' | 'KIT' | 'BOM'
  parentLabel?: string
}) {
  const suffix = uniqueSuffix()
  const sku = opts?.sku ?? `000-E2E-SKU-${suffix}`
  const name = opts?.name ?? `E2E Product ${suffix}`
  const price = opts?.price ?? '12.50'
  const type = opts?.type ?? 'SIMPLE'

  await page.goto('/inventory')
  await page.getByRole('button', { name: /add product/i }).click()
  await page.getByRole('heading', { name: 'New Product' }).waitFor()

  await page.getByLabel('SKU *').fill(sku)
  await page.getByLabel('Type *').selectOption(type)
  await page.getByLabel('Name *').fill(name)
  if (opts?.parentLabel) {
    await page.getByLabel('Parent Product').selectOption({ label: opts.parentLabel })
  }
  if (type !== 'VARIABLE') {
    await page.getByLabel('Regular Price (GBP)').fill(price)
  }
  await page.getByRole('button', { name: /save product/i }).click()

  await page.waitForURL(/\/inventory/)
  const { productId, productHref } = await getProductRecordBySku(sku)

  return { sku, name, price, productHref, productId }
}

export async function openInventoryProduct(page: Page, sku: string) {
  const { productHref } = await getProductRecordBySku(sku)
  await page.goto(productHref)
  await page.waitForURL(/\/inventory\/.+/)
}

export async function configureProductComponents(page: Page, components: Array<{ sku: string; qty: string }>) {
  for (let index = 0; index < components.length; index++) {
    const component = components[index]
    await page.getByRole('button', { name: /add component/i }).click()
    const search = page.getByPlaceholder(/search sku or name/i).last()
    await search.fill(component.sku)
    await page.getByRole('button', { name: new RegExp(component.sku) }).last().click()
    await page.locator('input[placeholder="Qty"]').last().fill(component.qty)
  }

  await page.getByRole('button', { name: /save (kit components|bill of materials)/i }).click()
  await page.getByText('Saved.').waitFor()
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

export async function createDraftSalesOrder(
  page: Page,
  opts: {
    sku: string
    warehouseLabel?: string
  },
) {
  await page.goto('/sales')
  const newOrderButton = page.getByRole('button', { name: /new order/i })
  const dialog = page.getByRole('dialog', { name: 'New Sales Order' })
  await newOrderButton.click()
  if (!(await dialog.isVisible())) {
    await newOrderButton.click()
  }
  await dialog.getByRole('heading', { name: 'New Sales Order' }).waitFor()

  const customerSelect = dialog.locator('select').first()
  const customerName = ((await customerSelect.locator('option').nth(1).textContent()) ?? '').trim()
  const customerFullName = customerName.replace(/\s+\(.+\)$/, '')
  await customerSelect.selectOption({ index: 1 })

  if (opts.warehouseLabel) {
    await dialog.getByText('Ship From Warehouse').locator('..').locator('select').selectOption({ label: opts.warehouseLabel })
  }

  await dialog.getByPlaceholder(/search product to add/i).fill(opts.sku)
  await dialog.getByRole('button', { name: new RegExp(opts.sku) }).first().click()
  await dialog.getByRole('button', { name: /save as draft/i }).click()

  await page.waitForURL(/\/sales\/.+/)
  return {
    customerName: customerFullName,
    orderUrl: page.url(),
  }
}
