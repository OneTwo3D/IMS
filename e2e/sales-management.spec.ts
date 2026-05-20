import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { addStockAdjustment, createDraftSalesOrder, createSimpleProduct } from './helpers'

const DEFAULT_WAREHOUSE_LABEL = 'DEFAULT — Default'
const DEFAULT_WAREHOUSE_CODE = 'DEFAULT'
const CBG_WAREHOUSE_LABEL = 'CBG — Cambridge'
const CBG_WAREHOUSE_CODE = 'CBG'

async function openMoreActions(page: Page) {
  await page.locator('main button[aria-haspopup="menu"]').last().click()
}

async function createShippedSalesOrder(page: Page) {
  const product = await createSimpleProduct(page, { price: '21.00' })
  await addStockAdjustment(page, product.sku, 4, CBG_WAREHOUSE_CODE)
  await createDraftSalesOrder(page, { sku: product.sku, warehouseLabel: CBG_WAREHOUSE_LABEL })

  const orderId = page.url().split('/').pop()!
  await page.getByRole('button', { name: 'Process' }).click()
  await expect(page.getByText(/^Allocated$/)).toBeVisible()
  await expect
    .poll(async () => {
      await page.reload()
      return page.getByRole('button', { name: /create shipments/i }).isVisible()
    })
    .toBe(true)

  const createShipmentsButton = page.getByRole('button', { name: /create shipments/i })
  await expect(createShipmentsButton).toBeVisible()
  await createShipmentsButton.click()
  await expect(page.getByText(/shipment from/i)).toBeVisible()
  await page.getByRole('button', { name: /start picking/i }).click()
  await expect(page.getByText('Picking', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: /mark packed/i }).click()
  await page.getByRole('button', { name: /^Ship$/ }).click()
  const shipDialog = page.getByRole('dialog', { name: /Ship/ })
  await shipDialog.getByRole('button', { name: /confirm shipment/i }).click()
  await expect(shipDialog).toBeHidden()
  await expect(page.getByText(/^Shipped$/).first()).toBeVisible()

  return { product, orderId }
}

test.describe('sales management workflows', () => {
  test.describe.configure({ mode: 'serial' })

  test('edits notes, clones, and deletes a draft sales order', async ({ page }) => {
    const product = await createSimpleProduct(page, { price: '14.50' })
    const original = await createDraftSalesOrder(page, { sku: product.sku, warehouseLabel: DEFAULT_WAREHOUSE_LABEL })
    const originalUrl = original.orderUrl

    await page.getByRole('button', { name: /notes/i }).click()
    const notesDialog = page.getByRole('dialog', { name: 'Edit Notes' })
    await notesDialog.locator('textarea').nth(0).fill('Handle with care')
    await notesDialog.locator('textarea').nth(1).fill('Internal pack note')
    await notesDialog.getByRole('button', { name: /save notes/i }).click()
    await expect(notesDialog).toBeHidden()
    await expect(page.getByText('Handle with care')).toBeVisible()
    await expect(page.getByText('Internal pack note')).toBeVisible()

    await openMoreActions(page)
    await page.getByRole('menuitem', { name: /clone/i }).click()
    await page.waitForURL(/\/sales\/.+/)
    await expect(page).not.toHaveURL(originalUrl)
    await expect(page.getByText(product.sku, { exact: true })).toBeVisible()

    await page.once('dialog', (dialogEvent) => dialogEvent.accept())
    await page.getByRole('button', { name: /delete/i }).click()
    await page.waitForURL(/\/sales$/)
  })

  test('cancels a draft sales order', async ({ page }) => {
    const product = await createSimpleProduct(page, { price: '11.00' })
    await createDraftSalesOrder(page, { sku: product.sku, warehouseLabel: DEFAULT_WAREHOUSE_LABEL })

    await page.once('dialog', (dialogEvent) => dialogEvent.accept())
    await page.getByRole('button', { name: /^Cancel$/ }).click()
    await expect(page.getByText(/^Cancelled$/).first()).toBeVisible()
  })

  test('deallocates and reallocates stock on an allocated order', async ({ page }) => {
    const product = await createSimpleProduct(page, { price: '17.25' })
    await addStockAdjustment(page, product.sku, 3, DEFAULT_WAREHOUSE_CODE)
    await createDraftSalesOrder(page, { sku: product.sku, warehouseLabel: DEFAULT_WAREHOUSE_LABEL })

    await page.getByRole('button', { name: 'Process' }).click()
    await expect(page.getByText(/^Allocated$/).first()).toBeVisible()
    await expect(page.getByRole('heading', { name: /stock allocation/i })).toBeVisible()

    await page.once('dialog', (dialogEvent) => dialogEvent.accept())
    await page.getByRole('button', { name: /^Deallocate$/ }).click()
    await expect
      .poll(async () => {
        await page.reload()
        return page.getByRole('button', { name: /auto-allocate/i }).isVisible()
      })
      .toBe(true)

    await page.getByRole('button', { name: /auto-allocate/i }).click()
    await expect(page.getByRole('heading', { name: /stock allocation/i })).toBeVisible()
  })

  test('handles post-shipment documents and refund flows', async ({ page }) => {
    const { product, orderId } = await createShippedSalesOrder(page)
    const origin = new URL(page.url()).origin

    const documentPage = await page.context().newPage()
    const [orderPdf] = await Promise.all([
      documentPage.waitForEvent('download'),
      documentPage.evaluate((url) => { window.location.href = url }, `${origin}/api/sales-order/${orderId}`),
    ])
    await expect(orderPdf.suggestedFilename()).toMatch(/\.pdf$/i)
    const [packingSlip] = await Promise.all([
      documentPage.waitForEvent('download'),
      documentPage.evaluate((url) => { window.location.href = url }, `${origin}/api/packing-slip/${orderId}`),
    ])
    await expect(packingSlip.suggestedFilename()).toMatch(/\.pdf$/i)
    await documentPage.close()
    await page.reload()

    const generateInvoiceButton = page.getByRole('button', { name: /generate invoice/i })
    if (await generateInvoiceButton.isVisible()) {
      await generateInvoiceButton.click()
      await expect(page.getByText(/Invoice #/i)).toBeVisible()

      const invoicePage = await page.context().newPage()
      const [invoicePdf] = await Promise.all([
        invoicePage.waitForEvent('download'),
        invoicePage.evaluate((url) => { window.location.href = url }, `${origin}/api/invoice/${orderId}`),
      ])
      await expect(invoicePdf.suggestedFilename()).toMatch(/\.pdf$/i)
      await invoicePage.close()

      await page.getByRole('button', { name: /add payment/i }).click()
      const paymentDialog = page.getByRole('dialog', { name: /Add Payment/ })
      await paymentDialog.locator('select').first().selectOption({ label: 'Bank Transfer' })
      await paymentDialog.locator('input').nth(2).fill(`PAY-${product.sku}`)
      await paymentDialog.getByRole('button', { name: /record payment/i }).click()
      await expect(paymentDialog).toBeHidden()
      await expect(page.getByText(/^Paid$/).first()).toBeVisible()
    } else {
      await expect(page.getByText(/invoice pending sync/i)).toBeVisible()
    }

    await page.getByRole('button', { name: /^Refund$/ }).click()
    const refundDialog = page.getByRole('dialog', { name: 'Process Refund' })
    await refundDialog.locator('input').first().fill('Customer return')
    await refundDialog.locator('input[type="number"]').first().fill('1')
    await refundDialog.getByRole('button', { name: /confirm refund/i }).click()
    await expect(refundDialog).toBeHidden()

    await expect(page.getByText(/Refunds \(1\)/)).toBeVisible()
    await page.getByRole('button', { name: /Refunds \(1\)/ }).click()
    await expect(page.getByText('Customer return')).toBeVisible()
  })
})
