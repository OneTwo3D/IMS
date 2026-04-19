import { execFileSync } from 'node:child_process'
import { expect, test, type Page } from '@playwright/test'
import { createDraftSalesOrder, createSimpleProduct } from './helpers'

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

function tryRunFixture(args: string[]): string {
  try {
    return runFixture(args)
  } catch {
    return ''
  }
}

function parseJsonLine<T>(output: string): T {
  const lines = output.split('\n').map((line) => line.trim()).filter(Boolean)
  const json = lines.at(-1)
  if (!json) throw new Error('fixture output was empty')
  return JSON.parse(json) as T
}

async function uploadCsv(page: Page, csv: string, inputIndex = 0) {
  await expect(page.getByRole('button', { name: 'Import CSV' }).first()).toBeVisible()
  await page.locator('input[type="file"][accept=".csv,text/csv"]').nth(inputIndex).setInputFiles(csvFile(csv))
  await expect(page.getByRole('dialog', { name: 'Review CSV Import' })).toBeVisible({ timeout: 20000 })
}

async function uploadCsvAndWaitForResult(page: Page, csv: string, inputIndex = 0) {
  await uploadCsv(page, csv, inputIndex)
  const reviewDialog = page.getByRole('dialog', { name: 'Review CSV Import' })
  await reviewDialog.getByRole('button', { name: /^Import /i }).click()
  const resultDialog = page.getByRole('dialog', { name: /Import (Complete|Completed With Issues|Failed)/ })
  await expect(resultDialog).toBeVisible({ timeout: 20000 })
  await resultDialog.getByRole('button', { name: 'Close' }).first().click()
  await expect(resultDialog).toBeHidden()
}

async function uploadCsvAndExpectPreviewError(page: Page, csv: string, errorMessage: RegExp | string, inputIndex = 0) {
  await uploadCsv(page, csv, inputIndex)
  const reviewDialog = page.getByRole('dialog', { name: 'Review CSV Import' })
  await expect(reviewDialog.getByText(errorMessage)).toBeVisible()
  await expect(reviewDialog.getByRole('button', { name: /^Import 0 Records$/i })).toBeDisabled()
  await reviewDialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(reviewDialog).toBeHidden()
}

async function shipCurrentOrder(page: Page) {
  await page.getByRole('button', { name: 'Process' }).click()
  await expect(page.getByText(/^Allocated$/).first()).toBeVisible()

  const createShipmentsButton = page.getByRole('button', { name: /create shipments/i })
  if (await createShipmentsButton.isVisible()) {
    await createShipmentsButton.click()
  }

  await expect(page.getByText(/shipment from/i)).toBeVisible()
  await page.getByRole('button', { name: /start picking/i }).click()
  await page.getByRole('button', { name: /mark packed/i }).click()
  await page.getByRole('button', { name: /^Ship$/ }).click()
  const shipDialog = page.getByRole('dialog', { name: /Ship/i })
  await shipDialog.getByRole('button', { name: /confirm shipment/i }).click()
  await expect(shipDialog).toBeHidden()
  await expect(page.getByText(/^Shipped$/).first()).toBeVisible()
}

test.describe.serial('CSV import workflows', () => {
  test('imports a foreign-currency sales order with correct base values', async ({ page }) => {
    const product = await createSimpleProduct(page, { price: '30.00' })
    const customerName = `CSV FX Customer ${Date.now()}`
    const note = `fx-sales-import-${Date.now()}`
    const orderKey = `SO-FX-${Date.now()}`
    const csv = [
      'orderKey,customerName,currency,fxRateToBase,sku,qty,unitPriceForeign,pricesIncludeVat,notes',
      `${orderKey},${customerName},EUR,1.25,${product.sku},2,25,false,${note}`,
    ].join('\n')

    await page.goto('/sales')
    await uploadCsvAndWaitForResult(page, csv)
    await expect
      .poll(() => tryRunFixture(['inspect-sales-import', note]), { timeout: 20000 })
      .toContain('"currency":"EUR"')

    const imported = parseJsonLine<{
      id: string
      currency: string
      fxRateToBase: number
      subtotalForeign: number
      subtotalBase: number
      lines: Array<{
        sku: string
        qty: number
        unitPriceForeign: number
        unitPriceBase: number
        totalForeign: number
        totalBase: number
      }>
    }>(runFixture(['inspect-sales-import', note]))

    expect(imported.currency).toBe('EUR')
    expect(imported.fxRateToBase).toBe(1.25)
    expect(imported.subtotalForeign).toBe(50)
    expect(imported.subtotalBase).toBe(40)
    expect(imported.lines).toEqual([
      expect.objectContaining({
        sku: product.sku,
        qty: 2,
        unitPriceForeign: 25,
        unitPriceBase: 20,
        totalForeign: 50,
        totalBase: 40,
      }),
    ])

    await uploadCsvAndExpectPreviewError(page, csv, new RegExp(`Sales order \"${orderKey}\" already exists`))
    const duplicateSales = parseJsonLine<{ count: number }>(runFixture(['count-sales-imports', note]))
    expect(duplicateSales.count).toBe(1)
  })

  test('imports a foreign-currency purchase order and received stock flows into shipment COGS', async ({ page }) => {
    const product = await createSimpleProduct(page, { price: '22.00' })
    runFixture(['ensure-supplier'])

    const note = `csv-po-${Date.now()}`
    const orderKey = `PO-FX-${Date.now()}`
    const csv = [
      'orderKey,supplierName,currency,fxRateToBase,destinationWarehouseCode,sku,qty,unitCostForeign,pricesIncludeVat,notes',
      `${orderKey},E2E Supplier,USD,1.25,DEFAULT,${product.sku},3,10,false,${note}`,
    ].join('\n')

    await page.goto('/purchase-orders')
    await uploadCsvAndWaitForResult(page, csv)
    await expect
      .poll(() => tryRunFixture(['inspect-purchase-import', note]), { timeout: 20000 })
      .toContain('"currency":"USD"')

    const importedPo = parseJsonLine<{
      id: string
      currency: string
      fxRateToBase: number
      subtotalForeign: number
      subtotalBase: number
      lines: Array<{
        sku: string
        qty: number
        unitCostForeign: number
        unitCostBase: number
        totalForeign: number
        totalBase: number
      }>
    }>(runFixture(['inspect-purchase-import', note]))

    expect(importedPo.currency).toBe('USD')
    expect(importedPo.fxRateToBase).toBe(1.25)
    expect(importedPo.subtotalForeign).toBe(30)
    expect(importedPo.subtotalBase).toBe(24)
    expect(importedPo.lines).toEqual([
      expect.objectContaining({
        sku: product.sku,
        qty: 3,
        unitCostForeign: 10,
        unitCostBase: 8,
        totalForeign: 30,
        totalBase: 24,
      }),
    ])

    await uploadCsvAndExpectPreviewError(page, csv, new RegExp(`Purchase order \"${orderKey}\" already exists`))
    const duplicatePurchaseOrders = parseJsonLine<{ count: number }>(runFixture(['count-purchase-imports', note]))
    expect(duplicatePurchaseOrders.count).toBe(1)

    await page.goto(`/purchase-orders/${importedPo.id}`)
    await page.getByRole('button', { name: /confirm & send po/i }).click()
    await expect(page.getByText(/^PO Sent$/).first()).toBeVisible()

    await page.getByRole('button', { name: /receive goods/i }).click()
    const receiveDialog = page.getByRole('dialog', { name: /Receive Goods/i })
    await receiveDialog.getByRole('button', { name: /confirm receipt/i }).click()
    await expect(receiveDialog).toBeHidden()
    await expect(page.getByText(/^Received$/).first()).toBeVisible()

    await createDraftSalesOrder(page, {
      sku: product.sku,
      warehouseLabel: 'DEFAULT — Default',
    })
    const orderId = page.url().split('/').pop()
    if (!orderId) throw new Error('missing order id after creating draft sales order')

    await shipCurrentOrder(page)

    const shipment = parseJsonLine<{
      lineCogsBase: number | null
      shipmentCogsBatchAmount: number | null
      shipmentSnapshot: Array<Record<string, unknown>>
    }>(runFixture(['inspect-shipment-cogs', orderId]))

    expect(shipment.lineCogsBase).toBe(8)
    expect(shipment.shipmentCogsBatchAmount).toBe(8)
    expect(shipment.shipmentSnapshot).toEqual([
      expect.objectContaining({
        qty: 1,
        unitCostBase: 8,
      }),
    ])
  })

  test('imports a stock adjustment and preserves FIFO consumption plus COGS entries', async ({ page }) => {
    const seeded = parseJsonLine<{ sku: string; warehouseCode: string }>(runFixture(['seed-adjustment-source']))
    const note = `csv-adjust-${Date.now()}`
    const csv = [
      'sku,warehouseCode,qty,note',
      `${seeded.sku},${seeded.warehouseCode},-3,${note}`,
    ].join('\n')

    await page.goto('/stock-control/stock-adjustments')
    await uploadCsvAndWaitForResult(page, csv)
    await expect
      .poll(() => tryRunFixture(['inspect-adjustment-import', seeded.sku, note]), { timeout: 20000 })
      .toContain('"stockQty":2')

    const inspected = parseJsonLine<{
      stockQty: number | null
      movementQty: number
      cogsEntries: Array<{ qty: number; unitCostBase: number; totalCostBase: number }>
      layers: Array<{ receivedQty: number; remainingQty: number; unitCostBase: number }>
    }>(runFixture(['inspect-adjustment-import', seeded.sku, note]))

    expect(inspected.stockQty).toBe(2)
    expect(inspected.movementQty).toBe(3)
    expect(inspected.cogsEntries).toEqual([
      expect.objectContaining({
        qty: 3,
        unitCostBase: 4,
        totalCostBase: 12,
      }),
    ])
    expect(inspected.layers[0]).toEqual(
      expect.objectContaining({
        receivedQty: 5,
        remainingQty: 2,
        unitCostBase: 4,
      }),
    )
  })

  test('imports opening stock per warehouse with an opening cost layer', async ({ page }) => {
    const product = await createSimpleProduct(page, { price: '18.00' })
    const note = `csv-opening-${Date.now()}`
    const csv = [
      'sku,warehouseCode,qty,unitCostBase,note',
      `${product.sku},DEFAULT,7,3.5,${note}`,
    ].join('\n')

    await page.goto('/stock-control/stock-adjustments')
    await uploadCsvAndWaitForResult(page, csv, 1)
    await expect
      .poll(() => tryRunFixture(['inspect-opening-stock-import', product.sku, 'DEFAULT']), { timeout: 20000 })
      .toContain('"movementType":"OPENING_STOCK"')

    const inspected = parseJsonLine<{
      movementType: string
      movementQty: number
      note: string | null
      stockQty: number | null
      reservedQty: number | null
      layers: Array<{ receivedQty: number; remainingQty: number; unitCostBase: number; isOpeningStock: boolean }>
    }>(runFixture(['inspect-opening-stock-import', product.sku, 'DEFAULT']))

    expect(inspected.movementType).toBe('OPENING_STOCK')
    expect(inspected.movementQty).toBe(7)
    expect(inspected.note).toBe(note)
    expect(inspected.stockQty).toBe(7)
    expect(inspected.reservedQty).toBe(0)
    expect(inspected.layers).toEqual([
      expect.objectContaining({
        receivedQty: 7,
        remainingQty: 7,
        unitCostBase: 3.5,
        isOpeningStock: true,
      }),
    ])

    await uploadCsvAndExpectPreviewError(
      page,
      csv,
      new RegExp(`opening stock can only be imported into an empty warehouse record`, 'i'),
      1,
    )
  })

  test('imports a received transfer and preserves stock plus destination layer cost', async ({ page }) => {
    const seeded = parseJsonLine<{ sku: string; fromWarehouseCode: string; toWarehouseCode: string }>(runFixture(['seed-transfer-source']))
    const note = `csv-transfer-${Date.now()}`
    const transferKey = `TRF-E2E-${Date.now()}`
    const csv = [
      'transferKey,fromWarehouseCode,toWarehouseCode,status,sku,qty,notes',
      `${transferKey},${seeded.fromWarehouseCode},${seeded.toWarehouseCode},RECEIVED,${seeded.sku},2,${note}`,
    ].join('\n')

    await page.goto('/stock-control/transfers')
    await uploadCsvAndWaitForResult(page, csv)
    await expect
      .poll(() => tryRunFixture(['inspect-transfer-import', seeded.sku, note]), { timeout: 20000 })
      .toContain('"status":"RECEIVED"')

    const inspected = parseJsonLine<{
      status: string
      sourceQty: number | null
      destinationQty: number | null
      lineQty: number
      qtyReceived: number
      snapshot: Array<Record<string, unknown>>
      destinationLayers: Array<{ receivedQty: number; remainingQty: number; unitCostBase: number }>
    }>(runFixture(['inspect-transfer-import', seeded.sku, note]))

    expect(inspected.status).toBe('RECEIVED')
    expect(inspected.sourceQty).toBe(2)
    expect(inspected.destinationQty).toBe(2)
    expect(inspected.lineQty).toBe(2)
    expect(inspected.qtyReceived).toBe(2)
    expect(inspected.snapshot).toEqual([
      expect.objectContaining({
        qty: 2,
        unitCostBase: 6,
      }),
    ])
    expect(inspected.destinationLayers[0]).toEqual(
      expect.objectContaining({
        receivedQty: 2,
        remainingQty: 2,
        unitCostBase: 6,
      }),
    )

    await uploadCsvAndExpectPreviewError(page, csv, new RegExp(`Transfer \"${transferKey}\" already exists`))
    const duplicateTransfers = parseJsonLine<{ count: number }>(runFixture(['count-transfer-imports', note]))
    expect(duplicateTransfers.count).toBe(1)
  })
})
