import { expect, test } from '@playwright/test'
import { createDraftSalesOrder, createSimpleProduct } from './helpers'

test.describe('detail navigation coverage', () => {
  test('loads a customer detail page from contacts and links back to its order', async ({ page }) => {
    const product = await createSimpleProduct(page)
    const { customerName, orderUrl } = await createDraftSalesOrder(page, { sku: product.sku })
    const orderId = orderUrl.split('/').pop()

    await page.goto('/sales/contacts')
    const customerLink = page.getByRole('link', { name: customerName, exact: true }).first()
    const customerHref = await customerLink.getAttribute('href')

    expect(customerHref).toBeTruthy()

    await page.goto(customerHref!)
    await expect(page.getByRole('heading', { name: customerName, exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: /orders \(\d+\)/i })).toBeVisible()

    const orderLink = page.locator(`a[href="/sales/${orderId}"]`).first()
    await expect(orderLink).toBeVisible()
  })

  test('loads a help document detail page from the help index', async ({ page }) => {
    await page.goto('/help')
    await expect(page.getByRole('heading', { name: 'Documentation', exact: true })).toBeVisible()

    const docLink = page.getByRole('link', { name: 'Sales Orders', exact: true }).first()
    await docLink.click()

    await expect(page).toHaveURL(/\/help\/sales$/)
    await expect(page.getByRole('heading', { name: 'Sales Orders', level: 1, exact: true })).toBeVisible()
  })
})
