import { execFileSync } from 'node:child_process'
import { expect, test } from '@playwright/test'
import { createDraftSalesOrder, createSimpleProduct } from './helpers'

type DispatchSeed = {
  sku: string
  warehouseLabel: string
}

type DispatchInspect = {
  lineCogsBase: number | null
  shipmentCogsBatchAmount: number | null
  shipmentSnapshot: Array<Record<string, unknown>>
}

type AdjustmentSeed = {
  movementId: string
  sku: string
  note: string
}

type AdjustmentInspect = {
  signedQty: number
  note: string | null
  stockQty: number | null
  cogsEntries: Array<{
    costLayerId: string
    qty: number
    unitCostBase: number
    totalCostBase: number
  }>
  costLayers: Array<{
    id: string
    receivedQty: number
    remainingQty: number
    unitCostBase: number
    adjustmentMovementId: string | null
  }>
}

function runFixture(args: string[]): string {
  return execFileSync(
    'node',
    ['--experimental-strip-types', 'scripts/cogs-e2e-fixture.ts', ...args],
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

test.describe.serial('COGS workflow coverage', () => {
  test('dispatch persists shipment FIFO cost into sales order line COGS', async ({ page }) => {
    const product = await createSimpleProduct(page, { price: '12.00' })
    const seeded = parseJsonLine<DispatchSeed>(runFixture(['seed-dispatch', product.sku]))

    await createDraftSalesOrder(page, {
      sku: product.sku,
      warehouseLabel: seeded.warehouseLabel,
    })

    const orderId = page.url().split('/').pop()
    if (!orderId) throw new Error('failed to determine sales order id from URL')

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

    const inspected = parseJsonLine<DispatchInspect>(runFixture(['inspect-dispatch', orderId]))

    expect(inspected.lineCogsBase).toBe(4)
    expect(inspected.shipmentCogsBatchAmount).toBe(4)
    expect(inspected.shipmentSnapshot).toEqual([
      expect.objectContaining({
        qty: 1,
        unitCostBase: 4,
      }),
    ])
  })

  test('editing a tracked negative adjustment rewrites FIFO consumption to the new quantity', async ({ page }) => {
    const seeded = parseJsonLine<AdjustmentSeed>(runFixture(['seed-adjustment-safe']))

    await page.goto('/stock-control/stock-adjustments')
    const row = page.locator('tbody tr').first()
    await expect(row).toBeVisible()
    await expect(row).toContainText(seeded.note)
    await row.getByTitle('Edit').click({ force: true })

    const editingRow = page.locator('tbody tr').filter({ has: page.getByRole('spinbutton') }).first()
    await editingRow.getByRole('spinbutton').fill('-3')
    await editingRow.locator('button').first().click()

    await expect.poll(() => runFixture(['inspect-adjustment', seeded.movementId])).toContain('"signedQty":-3')
    const inspected = parseJsonLine<AdjustmentInspect>(runFixture(['inspect-adjustment', seeded.movementId]))

    expect(inspected.signedQty).toBe(-3)
    expect(inspected.stockQty).toBe(2)
    expect(inspected.cogsEntries).toEqual([
      expect.objectContaining({
        qty: 3,
        unitCostBase: 4,
        totalCostBase: 12,
      }),
    ])
    expect(inspected.costLayers[0]).toEqual(
      expect.objectContaining({
        receivedQty: 5,
        remainingQty: 2,
        unitCostBase: 4,
      }),
    )
  })

  test('editing an older adjustment is blocked once later stock movements exist', async ({ page }) => {
    const seeded = parseJsonLine<AdjustmentSeed>(runFixture(['seed-adjustment-blocked']))

    await page.goto('/stock-control/stock-adjustments')
    const row = page.locator('tbody tr').filter({ hasText: seeded.note }).first()
    await expect(row).toBeVisible()
    await row.getByTitle('Edit').click({ force: true })

    const editingRow = page.locator('tbody tr').filter({ has: page.getByRole('spinbutton') }).first()
    await editingRow.getByRole('spinbutton').fill('-3')
    await editingRow.locator('button').first().click()

    await expect(editingRow.getByText('Failed to update adjustment.')).toBeVisible()

    const inspected = parseJsonLine<AdjustmentInspect>(runFixture(['inspect-adjustment', seeded.movementId]))
    expect(inspected.signedQty).toBe(-5)
    expect(inspected.stockQty).toBe(1)
    expect(inspected.cogsEntries).toEqual([
      expect.objectContaining({
        qty: 5,
        totalCostBase: 20,
      }),
    ])
    expect(inspected.costLayers[0]).toEqual(
      expect.objectContaining({
        receivedQty: 5,
        remainingQty: 0,
      }),
    )
  })
})
