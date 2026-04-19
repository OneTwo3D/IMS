import { execFileSync } from 'node:child_process'
import { expect, test, type Page } from '@playwright/test'

type SeedResult = {
  scenario: 'delivered' | 'shipped' | 'shipped-returned' | 'delivered-invoiced-mixed-costs'
  freightPoId: string
  goodsPoId: string
  orderId: string | null
  warehouseId: string
  originalCostLayerId: string
  poLineId: string
}

type InspectResult = {
  landedUnitCostBase: number
  originalLayerUnitCostBase: number
  returnLayers: Array<{
    id: string
    receivedQty: number
    remainingQty: number
    unitCostBase: number
    poLineId: string | null
  }>
  shipmentCogsBatchAmount: number | null
  salesOrderLineCogsBase: number | null
  shipmentSnapshot: Array<Record<string, unknown>>
  refundSnapshots: Array<Array<Record<string, unknown>>>
  stockInTransitJournalLines: Array<Array<{
    accountCode: string | null
    debit: number
    credit: number
  }>>
  cogsJournalLines: Array<Array<{
    accountCode: string | null
    debit: number
    credit: number
  }>>
}

function runFixture(args: string[]): string {
  return execFileSync(
    'node',
    ['--experimental-strip-types', 'scripts/landed-cost-e2e-fixture.ts', ...args],
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

async function revalueFreightPo(page: Page, freightPoId: string) {
  await page.goto(`/purchase-orders/${freightPoId}`)
  await expect(page.getByRole('button', { name: /edit costs/i })).toBeVisible()
  await page.getByRole('button', { name: /edit costs/i }).click()

  const dialog = page.getByRole('dialog', { name: /Edit Landed Costs/i })
  await expect(dialog).toBeVisible()
  await dialog.locator('input[type="number"]').first().fill('3')
  await dialog.getByRole('button', { name: /update & recalculate/i }).click()
  await expect(dialog).toBeHidden()
}

test.describe.serial('landed cost revaluation workflows', () => {
  test('revalues on-hand inventory when landed cost arrives after receipt but before shipment', async ({ page }) => {
    const seeded = parseJsonLine<SeedResult>(runFixture(['seed', 'delivered']))

    await revalueFreightPo(page, seeded.freightPoId)

    await expect
      .poll(() => runFixture(['inspect', seeded.goodsPoId, seeded.poLineId, seeded.originalCostLayerId]))
      .toContain('"landedUnitCostBase":7')

    const inspected = parseJsonLine<InspectResult>(runFixture([
      'inspect',
      seeded.goodsPoId,
      seeded.poLineId,
      seeded.originalCostLayerId,
    ]))

    expect(inspected.landedUnitCostBase).toBe(7)
    expect(inspected.originalLayerUnitCostBase).toBe(7)
    expect(inspected.shipmentCogsBatchAmount).toBeNull()
    expect(inspected.salesOrderLineCogsBase).toBeNull()
    expect(inspected.stockInTransitJournalLines).toHaveLength(1)
    expect(inspected.stockInTransitJournalLines[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountCode: '630', debit: 2, credit: 0 }),
        expect.objectContaining({ accountCode: '640', debit: 0, credit: 2 }),
      ]),
    )
    expect(inspected.cogsJournalLines).toHaveLength(0)
  })

  test('revalues shipped COGS and queues a retrospective journal when landed cost arrives after shipment', async ({ page }) => {
    const seeded = parseJsonLine<SeedResult>(runFixture(['seed', 'shipped']))

    await revalueFreightPo(page, seeded.freightPoId)

    await expect
      .poll(() => runFixture(['inspect', seeded.goodsPoId, seeded.poLineId, seeded.originalCostLayerId]))
      .toContain('"shipmentCogsBatchAmount":7')

    const inspected = parseJsonLine<InspectResult>(runFixture([
      'inspect',
      seeded.goodsPoId,
      seeded.poLineId,
      seeded.originalCostLayerId,
    ]))

    expect(inspected.landedUnitCostBase).toBe(7)
    expect(inspected.originalLayerUnitCostBase).toBe(7)
    expect(inspected.shipmentCogsBatchAmount).toBe(7)
    expect(inspected.salesOrderLineCogsBase).toBe(7)
    expect(inspected.stockInTransitJournalLines).toHaveLength(0)
    expect(inspected.shipmentSnapshot).toEqual([
      expect.objectContaining({
        qty: 1,
        unitCostBase: 7,
      }),
    ])
    expect(inspected.cogsJournalLines).toHaveLength(1)
    expect(inspected.cogsJournalLines[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ debit: 2, credit: 0 }),
        expect.objectContaining({ debit: 0, credit: 2 }),
      ]),
    )
  })

  test('revalues returned stock without leaving a net shipped COGS delta after a full return', async ({ page }) => {
    const seeded = parseJsonLine<SeedResult>(runFixture(['seed', 'shipped-returned']))
    if (!seeded.orderId) throw new Error('expected an order id for shipped-returned seed')

    await page.goto(`/sales/${seeded.orderId}`)
    await expect(page.getByText(/^Shipped$/).first()).toBeVisible()
    await page.getByRole('button', { name: /^Refund$/ }).click()

    const refundDialog = page.getByRole('dialog', { name: 'Process Refund' })
    await expect(refundDialog).toBeVisible()
    await refundDialog.locator('input').first().fill('Returned before freight finalized')
    await refundDialog.locator('select').selectOption(seeded.warehouseId)
    await refundDialog.locator('input[type="number"]').first().fill('1')
    await refundDialog.getByRole('button', { name: /confirm refund/i }).click()
    await expect(refundDialog).toBeHidden()
    await expect(page.getByText(/Refunds \(1\)/)).toBeVisible()

    await revalueFreightPo(page, seeded.freightPoId)

    await expect
      .poll(() => runFixture(['inspect', seeded.goodsPoId, seeded.poLineId, seeded.originalCostLayerId]))
      .toContain('"originalLayerUnitCostBase":7')

    const inspected = parseJsonLine<InspectResult>(runFixture([
      'inspect',
      seeded.goodsPoId,
      seeded.poLineId,
      seeded.originalCostLayerId,
    ]))

    expect(inspected.landedUnitCostBase).toBe(7)
    expect(inspected.originalLayerUnitCostBase).toBe(7)
    expect(inspected.shipmentCogsBatchAmount).toBe(7)
    expect(inspected.salesOrderLineCogsBase).toBe(7)
    expect(inspected.stockInTransitJournalLines).toHaveLength(1)
    expect(inspected.stockInTransitJournalLines[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountCode: '630', debit: 2, credit: 0 }),
        expect.objectContaining({ accountCode: '640', debit: 0, credit: 2 }),
      ]),
    )
    expect(inspected.returnLayers).toEqual([
      expect.objectContaining({
        receivedQty: 1,
        remainingQty: 1,
        unitCostBase: 7,
        poLineId: seeded.poLineId,
      }),
    ])
    expect(inspected.refundSnapshots).toHaveLength(1)
    expect(inspected.refundSnapshots[0]).toEqual([
      expect.objectContaining({
        qty: 1,
        unitCostBase: 7,
        source: 'shipment',
      }),
    ])
    expect(inspected.cogsJournalLines).toHaveLength(0)
  })

  test('recalculates linked freight on invoiced goods POs without dropping the goods PO direct costs', async ({ page }) => {
    const seeded = parseJsonLine<SeedResult>(runFixture(['seed', 'delivered-invoiced-mixed-costs']))

    await revalueFreightPo(page, seeded.freightPoId)

    await expect
      .poll(() => runFixture(['inspect', seeded.goodsPoId, seeded.poLineId, seeded.originalCostLayerId]))
      .toContain('"landedUnitCostBase":8')

    const inspected = parseJsonLine<InspectResult>(runFixture([
      'inspect',
      seeded.goodsPoId,
      seeded.poLineId,
      seeded.originalCostLayerId,
    ]))

    expect(inspected.landedUnitCostBase).toBe(8)
    expect(inspected.originalLayerUnitCostBase).toBe(8)
    expect(inspected.stockInTransitJournalLines).toHaveLength(1)
    expect(inspected.stockInTransitJournalLines[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountCode: '630', debit: 2, credit: 0 }),
        expect.objectContaining({ accountCode: '640', debit: 0, credit: 2 }),
      ]),
    )
  })
})
