import { execFileSync } from 'node:child_process'
import { expect, test, type Page } from '@playwright/test'
import { parseCsv, toCsv } from '../lib/csv'
import { createSimpleProduct } from './helpers'

const CONTACT_HEADERS = ['customerId', 'firstName', 'lastName', 'email', 'phone', 'company', 'taxNumber', 'billing_line1', 'billing_line2', 'billing_city', 'billing_county', 'billing_postcode', 'billing_country', 'shipping_line1', 'shipping_line2', 'shipping_city', 'shipping_county', 'shipping_postcode', 'shipping_country', 'notes']
const SUPPLIER_HEADERS = ['supplierId', 'name', 'contactName', 'email', 'phone', 'currency', 'vatNumber', 'accountNumber', 'paymentTermsDays', 'addressLine1', 'addressLine2', 'city', 'county', 'postcode', 'country', 'notes']
const PRODUCT_EXPORT_HEADERS = ['productId', 'parentProductId', 'sku', 'name', 'description', 'type', 'parentSku', 'barcode', 'weight', 'widthCm', 'heightCm', 'depthCm', 'salesPriceBase', 'salePriceBase', 'salesPriceTaxInclusive', 'stockUnit', 'oversellAllowed', 'imageUrl', 'active', 'lifecycleStatus', 'components', 'totalStock', 'inventoryValue']
const PRODUCT_IMPORT_HEADERS = PRODUCT_EXPORT_HEADERS.slice(0, -2)

function csvFile(contents: string) {
  return {
    name: 'import.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(contents, 'utf8'),
  }
}

function runFixture(args: string[]): string {
  return execFileSync(
    'npx',
    ['tsx', 'scripts/csv-import-e2e-fixture.ts', ...args],
    {
      cwd: process.cwd(),
      env: process.env,
      encoding: 'utf8',
    },
  ).trim()
}

function parseJsonLine<T>(output: string): T {
  const lines = output.split('\n').map((line) => line.trim()).filter(Boolean)
  const json = lines.at(-1)
  if (!json) throw new Error('fixture output was empty')
  return JSON.parse(json) as T
}

function tryRunFixture(args: string[]): string {
  try {
    return runFixture(args)
  } catch {
    return ''
  }
}

async function uploadCsv(page: Page, csv: string) {
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Import CSV' }).first().click()
  const chooser = await chooserPromise
  await chooser.setFiles(csvFile(csv))
  await expect(page.getByRole('dialog', { name: 'Review CSV Import' })).toBeVisible({ timeout: 20000 })
}

async function uploadCsvAndWaitForResult(page: Page, csv: string) {
  await uploadCsv(page, csv)
  const reviewDialog = page.getByRole('dialog', { name: 'Review CSV Import' })
  await reviewDialog.getByRole('button', { name: /^Import /i }).click()
  const resultDialog = page.getByRole('dialog', { name: /Import (Complete|Completed With Issues|Failed)/ })
  await expect(resultDialog).toBeVisible({ timeout: 20000 })
  await resultDialog.getByRole('button', { name: 'Close' }).first().click()
  await expect(resultDialog).toBeHidden()
}

async function fetchCsv(page: Page, path: string): Promise<string> {
  const baseUrl = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
  const response = await page.context().request.get(new URL(path, baseUrl).toString())
  expect(response.ok()).toBeTruthy()
  return await response.text()
}

test.describe.serial('CSV round-trip exports', () => {
  test('contacts export uses stable ids and sparse import preserves existing values', async ({ page }) => {
    const seeded = parseJsonLine<{ id: string; email: string; firstName: string; lastName: string }>(runFixture(['seed-contact-roundtrip']))

    await page.goto('/sales/contacts')
    const exported = await fetchCsv(page, '/api/export/contacts')
    expect(exported.split('\n')[0]?.trim()).toBe(CONTACT_HEADERS.join(','))
    expect(exported).toContain(seeded.id)

    const csv = toCsv([{
      customerId: seeded.id,
      firstName: seeded.firstName,
      lastName: seeded.lastName,
      company: 'Updated Co',
    }], CONTACT_HEADERS)

    await uploadCsvAndWaitForResult(page, csv)
    await expect.poll(() => tryRunFixture(['inspect-contact-roundtrip', seeded.id]), { timeout: 10000 }).toContain('Updated Co')

    const inspected = parseJsonLine<{
      email: string | null
      company: string | null
      phone: string | null
      billingAddress: { line1?: string }
      shippingAddress: { line1?: string }
      notes: string | null
    }>(runFixture(['inspect-contact-roundtrip', seeded.id]))

    expect(inspected.email).toBe(seeded.email)
    expect(inspected.company).toBe('Updated Co')
    expect(inspected.phone).toBe('0123456789')
    expect(inspected.billingAddress?.line1).toBe('1 Existing Street')
    expect(inspected.shippingAddress?.line1).toBe('2 Existing Street')
    expect(inspected.notes).toBe('Existing notes')
  })

  test('suppliers export uses stable ids and sparse import preserves existing values', async ({ page }) => {
    const seeded = parseJsonLine<{ id: string; name: string }>(runFixture(['seed-supplier-roundtrip']))

    await page.goto('/purchase-orders/suppliers')
    const exported = await fetchCsv(page, '/api/export/suppliers')
    expect(exported.split('\n')[0]?.trim()).toBe(SUPPLIER_HEADERS.join(','))
    expect(exported).toContain(seeded.id)

    const csv = toCsv([{
      supplierId: seeded.id,
      name: seeded.name,
      currency: 'USD',
      notes: 'Updated supplier notes',
    }], SUPPLIER_HEADERS)

    await uploadCsvAndWaitForResult(page, csv)
    await expect.poll(() => tryRunFixture(['inspect-supplier-roundtrip', seeded.id]), { timeout: 10000 }).toContain('Updated supplier notes')

    const inspected = parseJsonLine<{
      currency: string
      email: string | null
      contactName: string | null
      notes: string | null
      paymentTermsDays: number | null
      addressLine1: string | null
    }>(runFixture(['inspect-supplier-roundtrip', seeded.id]))

    expect(inspected.currency).toBe('USD')
    expect(inspected.email).toContain('@example.com')
    expect(inspected.contactName).toBe('Original Buyer')
    expect(inspected.paymentTermsDays).toBe(30)
    expect(inspected.addressLine1).toBe('1 Supplier Road')
    expect(inspected.notes).toBe('Updated supplier notes')
  })

  test('products export uses stable ids and sparse import preserves existing values', async ({ page }) => {
    const seeded = parseJsonLine<{ id: string; sku: string }>(runFixture(['seed-product-roundtrip']))

    await page.goto('/inventory')
    const exported = await fetchCsv(page, '/api/export/products')
    expect(exported.split('\n')[0]?.trim()).toBe(PRODUCT_EXPORT_HEADERS.join(','))
    expect(exported).toContain(seeded.id)

    const csv = toCsv([{
      productId: seeded.id,
      sku: seeded.sku,
      name: 'Updated Product Name',
      salesPriceBase: '25.00',
    }], PRODUCT_IMPORT_HEADERS)

    await uploadCsvAndWaitForResult(page, csv)
    await expect.poll(() => tryRunFixture(['inspect-product-roundtrip', seeded.id]), { timeout: 10000 }).toContain('Updated Product Name')

    const inspected = parseJsonLine<{
      name: string
      barcode: string | null
      weight: number | null
      salesPriceBase: number | null
      salePriceBase: number | null
      salesPriceTaxInclusive: boolean
      description: string | null
    }>(runFixture(['inspect-product-roundtrip', seeded.id]))

    expect(inspected.name).toBe('Updated Product Name')
    expect(inspected.barcode).toContain('BC-')
    expect(inspected.weight).toBe(1.25)
    expect(inspected.salesPriceBase).toBe(25)
    expect(inspected.salePriceBase).toBe(18)
    expect(inspected.salesPriceTaxInclusive).toBe(true)
    expect(inspected.description).toBe('Original description')
  })

  test('operational export routes emit importer-compatible round-trip headers and values', async ({ page }) => {
    const product = await createSimpleProduct(page, { price: '30.00' })
    runFixture(['ensure-supplier'])

    const salesOrderKey = `SO-RT-${Date.now()}`
    const salesNote = `export-sales-${Date.now()}`
    await page.goto('/sales')
    await uploadCsvAndWaitForResult(page, [
      'orderKey,customerName,currency,fxRateToBase,sku,qty,unitPriceForeign,pricesIncludeVat,notes',
      `${salesOrderKey},Roundtrip Customer,EUR,1.20,${product.sku},1,24.00,false,${salesNote}`,
    ].join('\n'))
    await expect.poll(() => tryRunFixture(['inspect-sales-import', salesNote]), { timeout: 20000 }).toContain('"currency":"EUR"')

    const purchaseOrderKey = `PO-RT-${Date.now()}`
    const purchaseNote = `export-po-${Date.now()}`
    await page.goto('/purchase-orders')
    await uploadCsvAndWaitForResult(page, [
      'orderKey,supplierName,currency,fxRateToBase,destinationWarehouseCode,sku,qty,unitCostForeign,pricesIncludeVat,notes',
      `${purchaseOrderKey},E2E Supplier,USD,1.25,DEFAULT,${product.sku},2,10.00,false,${purchaseNote}`,
    ].join('\n'))
    await expect.poll(() => tryRunFixture(['inspect-purchase-import', purchaseNote]), { timeout: 20000 }).toContain('"currency":"USD"')

    const adjustmentSeed = parseJsonLine<{ sku: string; warehouseCode: string }>(runFixture(['seed-adjustment-source']))
    const adjustmentNote = `export-adjust-${Date.now()}`
    await page.goto('/stock-control/stock-adjustments')
    await uploadCsvAndWaitForResult(page, [
      'sku,warehouseCode,qty,note',
      `${adjustmentSeed.sku},${adjustmentSeed.warehouseCode},-2,${adjustmentNote}`,
    ].join('\n'))
    await expect.poll(() => tryRunFixture(['inspect-adjustment-import', adjustmentSeed.sku, adjustmentNote]), { timeout: 20000 }).toContain('"movementQty":2')

    const transferSeed = parseJsonLine<{ sku: string; fromWarehouseCode: string; toWarehouseCode: string }>(runFixture(['seed-transfer-source']))
    const transferKey = `TRF-RT-${Date.now()}`
    const transferNote = `export-transfer-${Date.now()}`
    await page.goto('/stock-control/transfers')
    await uploadCsvAndWaitForResult(page, [
      'transferKey,fromWarehouseCode,toWarehouseCode,status,sku,qty,notes',
      `${transferKey},${transferSeed.fromWarehouseCode},${transferSeed.toWarehouseCode},RECEIVED,${transferSeed.sku},1,${transferNote}`,
    ].join('\n'))
    await expect.poll(() => tryRunFixture(['inspect-transfer-import', transferSeed.sku, transferNote]), { timeout: 20000 }).toContain('"status":"RECEIVED"')

    const salesRows = parseCsv(await fetchCsv(page, '/api/export/sales'))
    expect(Object.keys(salesRows[0] ?? {})).toEqual([
      'orderKey', 'customerName', 'customerEmail', 'currency', 'fxRateToBase', 'shipFromWarehouseCode', 'sku', 'qty',
      'unitPriceForeign', 'lineDiscountForeign', 'lineDiscountStr', 'taxRateName', 'taxRateValue',
      'orderTaxRateName', 'orderTaxRateValue', 'pricesIncludeVat', 'shippingService', 'shippingForeign',
      'orderDiscountForeign', 'expectedDelivery', 'salesRep', 'notes',
    ])
    expect(salesRows.some((row) => row.notes === salesNote && row.sku === product.sku && row.unitPriceForeign === '24.000000')).toBe(true)

    const purchaseRows = parseCsv(await fetchCsv(page, '/api/export/purchase-orders'))
    expect(Object.keys(purchaseRows[0] ?? {})).toEqual([
      'orderKey', 'supplierName', 'currency', 'fxRateToBase', 'destinationWarehouseCode', 'sku', 'qty',
      'unitCostForeign', 'lineDiscountForeign', 'lineDiscountStr', 'taxRateName', 'taxRateValue',
      'orderTaxRateName', 'orderTaxRateValue', 'pricesIncludeVat', 'supplierRef', 'expectedDelivery',
      'orderDiscountForeign', 'notes',
    ])
    expect(purchaseRows.some((row) => row.notes === purchaseNote && row.sku === product.sku && row.unitCostForeign === '10.000000')).toBe(true)

    const adjustmentRows = parseCsv(await fetchCsv(page, '/api/export/adjustments'))
    expect(Object.keys(adjustmentRows[0] ?? {})).toEqual(['sku', 'warehouseCode', 'qty', 'note'])
    expect(adjustmentRows.some((row) => row.note === adjustmentNote && row.qty === '-2')).toBe(true)

    const transferRows = parseCsv(await fetchCsv(page, '/api/export/transfers'))
    expect(Object.keys(transferRows[0] ?? {})).toEqual(['transferKey', 'fromWarehouseCode', 'toWarehouseCode', 'status', 'sku', 'qty', 'notes'])
    expect(transferRows.some((row) => row.notes === transferNote && row.status === 'RECEIVED' && row.qty === '1')).toBe(true)
  })
})
