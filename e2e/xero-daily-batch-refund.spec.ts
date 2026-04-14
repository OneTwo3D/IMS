import { execFileSync } from 'node:child_process'
import { expect, test } from '@playwright/test'

type SeedResult = {
  orderId: string
  productId: string
  warehouseId: string
  allocationId: string
  shipmentLineId: string
  costLayerId: string
  unearnedRevenueAmount: number
  allocationBatchAmount: number
  shipmentRevenueRecognizedAmount: number
  shipmentCogsBatchAmount: number
}

type InspectResult = {
  orderStatus: string
  revenueDeferredDate: string | null
  inventoryAllocatedDate: string | null
  allocationSnapshot: Array<Record<string, unknown>>
  shipmentSnapshot: Array<Record<string, unknown>>
  refundSnapshot: Array<Record<string, unknown>>
  replacementLayers: Array<{ id: string; receivedQty: number; remainingQty: number; unitCostGbp: number }>
  orderLogs: Array<{ type: string; payload: { lines?: Array<{ description?: string; debit?: number }> } }>
  refundLogId: string | null
  costLayerId: string
}

function runFixture(args: string[]): string {
  return execFileSync(
    'node',
    ['--experimental-strip-types', 'scripts/xero-daily-batch-refund-fixture.ts', ...args],
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

test.describe('xero daily batch refund verification', () => {
  test('captures historical FIFO snapshots through A1/A2/B and refund reversal', async ({ page }) => {
    const seeded = parseJsonLine<SeedResult>(runFixture(['seed']))

    expect(seeded.unearnedRevenueAmount).toBe(20)
    expect(seeded.allocationBatchAmount).toBe(8)
    expect(seeded.shipmentRevenueRecognizedAmount).toBe(10)
    expect(seeded.shipmentCogsBatchAmount).toBe(4)

    await page.goto(`/sales/${seeded.orderId}`)
    await expect(page.getByText(/^Shipped$/).first()).toBeVisible()

    await page.getByRole('button', { name: /^Refund$/ }).click()
    const refundDialog = page.getByRole('dialog', { name: 'Process Refund' })
    await expect(refundDialog).toBeVisible()
    await refundDialog.locator('input').first().fill('Seeded mixed refund verification')
    await refundDialog.locator('select').selectOption('')
    await refundDialog.locator('input[type="number"]').first().fill('2')
    await refundDialog.getByRole('button', { name: /confirm refund/i }).click()
    await expect(refundDialog).toBeHidden()
    await expect(page.getByText(/Refunds \(1\)/)).toBeVisible()

    await expect
      .poll(() => runFixture([
        'inspect',
        seeded.orderId,
        seeded.allocationId,
        seeded.shipmentLineId,
        seeded.costLayerId,
        seeded.productId,
        seeded.warehouseId,
      ]))
      .toContain('"orderStatus":"REFUNDED"')

    const inspected = parseJsonLine<InspectResult>(runFixture([
      'inspect',
      seeded.orderId,
      seeded.allocationId,
      seeded.shipmentLineId,
      seeded.costLayerId,
      seeded.productId,
      seeded.warehouseId,
    ]))

    expect(inspected.orderStatus).toBe('REFUNDED')
    expect(inspected.revenueDeferredDate).toBeNull()
    expect(inspected.inventoryAllocatedDate).toBeNull()

    expect(inspected.allocationSnapshot).toEqual([
      expect.objectContaining({
        costLayerId: seeded.costLayerId,
        qty: 2,
        unitCostGbp: 4,
      }),
    ])

    expect(inspected.shipmentSnapshot).toEqual([
      expect.objectContaining({
        costLayerId: seeded.costLayerId,
        qty: 1,
        unitCostGbp: 4,
        orderAllocationId: seeded.allocationId,
        shipmentLineId: seeded.shipmentLineId,
        source: 'shipment',
      }),
    ])

    expect(inspected.refundSnapshot).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          costLayerId: seeded.costLayerId,
          qty: 1,
          unitCostGbp: 4,
          shipmentLineId: seeded.shipmentLineId,
          source: 'shipment',
        }),
        expect.objectContaining({
          costLayerId: seeded.costLayerId,
          qty: 1,
          unitCostGbp: 4,
          orderAllocationId: seeded.allocationId,
          source: 'allocation',
        }),
      ]),
    )

    const cogsLog = inspected.orderLogs.find((log) => log.type === 'COGS_REVERSAL')
    const unearnedLog = inspected.orderLogs.find((log) => log.type === 'UNEARNED_REV_REVERSAL')

    expect(cogsLog?.payload.lines?.[0]?.debit).toBe(4)
    expect(unearnedLog?.payload.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ debit: 10, description: expect.stringContaining('Unearned revenue reversal') }),
        expect.objectContaining({ debit: 4, description: expect.stringContaining('Allocation reversal') }),
      ]),
    )

    expect(inspected.refundLogId).toBeTruthy()
  })

  test('recreates warehouse cost layers when refunded stock is returned', async ({ page }) => {
    const seeded = parseJsonLine<SeedResult>(runFixture(['seed']))

    await page.goto(`/sales/${seeded.orderId}`)
    await expect(page.getByText(/^Shipped$/).first()).toBeVisible()

    await page.getByRole('button', { name: /^Refund$/ }).click()
    const refundDialog = page.getByRole('dialog', { name: 'Process Refund' })
    await expect(refundDialog).toBeVisible()
    await refundDialog.locator('input').first().fill('Seeded warehouse return verification')
    await refundDialog.locator('select').selectOption(seeded.warehouseId)
    await refundDialog.locator('input[type="number"]').first().fill('2')
    await refundDialog.getByRole('button', { name: /confirm refund/i }).click()
    await expect(refundDialog).toBeHidden()
    await expect(page.getByText(/Refunds \(1\)/)).toBeVisible()

    const inspected = parseJsonLine<InspectResult>(runFixture([
      'inspect',
      seeded.orderId,
      seeded.allocationId,
      seeded.shipmentLineId,
      seeded.costLayerId,
      seeded.productId,
      seeded.warehouseId,
    ]))

    expect(inspected.replacementLayers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ receivedQty: 1, remainingQty: 1, unitCostGbp: 4 }),
        expect.objectContaining({ receivedQty: 1, remainingQty: 1, unitCostGbp: 4 }),
      ]),
    )
    expect(inspected.replacementLayers).toHaveLength(2)
  })
})
