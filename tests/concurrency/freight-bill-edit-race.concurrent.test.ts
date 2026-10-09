import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { loadEnv, uid } from './po-landed-fixtures'

/**
 * A FREIGHT EDIT THAT COMMITS BETWEEN createInvoice's UNLOCKED READ AND ITS LOCK must not produce a bill whose VAT
 * comes from the old order. The edit keeps the cost-line ids (they are matched by id and edited in place), so the id
 * checks cannot see it. The edit is injected deterministically (no sleeps): `getBaseCurrencyCode` is called by
 * `createInvoice` AFTER its read of the order and BEFORE its transaction, so the hook runs the real
 * `updateFreightPoCosts` exactly there.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const SKIP = { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' } as const

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireInternalUser: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireRole: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireFreshPermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('@/lib/shopping', { namedExports: { enqueueStockSync: async () => {} } })
mock.module('@/lib/notifications', { namedExports: { notify: async () => {} } })

let betweenReadAndLock: (() => Promise<void>) | null = null
if (RUN) {
  loadEnv()
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const realBaseCurrency = require('@/lib/base-currency') as typeof import('@/lib/base-currency')
  mock.module('@/lib/base-currency', {
    namedExports: {
      ...realBaseCurrency,
      getBaseCurrencyCode: async () => {
        const hook = betweenReadAndLock
        betweenReadAndLock = null
        if (hook) await hook()
        return realBaseCurrency.getBaseCurrencyCode()
      },
    },
  })
}

async function seedMixedFreight() {
  const { db } = await import('@/lib/db')
  const { createPurchaseOrder, createFreightPo } = await import('@/app/actions/purchase-orders')
  const tag = `${uid()}-fbrace`
  const product = await db.product.create({ data: { sku: tag, name: `fbrace`, type: 'SIMPLE', countryOfOrigin: 'CN' }, select: { id: true } })
  const warehouse = await db.warehouse.create({ data: { code: `${uid()}-W`, name: `${tag} wh`, type: 'STANDARD' }, select: { id: true } })
  await db.stockLevel.create({ data: { productId: product.id, warehouseId: warehouse.id, quantity: '0', reservedQty: '0' } })
  const supplier = await db.supplier.create({ data: { name: `${tag} supplier`, currency: 'GBP' }, select: { id: true } })
  const goods = await createPurchaseOrder({
    reference: tag, supplierId: supplier.id, currency: 'GBP', fxRateToBase: 1, destinationWarehouseId: warehouse.id,
    pricesIncludeVat: false, taxRateValue: 0,
    lines: [{ productId: product.id, sku: tag, productName: 'fbrace', qty: 4, unitCostForeign: 10 }],
  })
  assert.equal(goods.success, true, String(goods.error))
  const goodsPo = await db.purchaseOrder.findUniqueOrThrow({ where: { reference: tag }, select: { id: true } })
  await db.purchaseOrder.update({ where: { id: goodsPo.id }, data: { status: 'PO_SENT' } })
  const freight = await createFreightPo({
    supplierId: supplier.id, currency: 'GBP', fxRateToBase: 1, primaryPoIds: [goodsPo.id], taxRateValue: 0.2,
    costLines: [
      { description: 'Duty', amountForeign: 100, vatable: true, distributionMethod: 'BY_VALUE' },
      { description: 'Handling', amountForeign: 100, vatable: false, distributionMethod: 'BY_VALUE' },
    ],
  })
  assert.equal(freight.success, true, String(freight.error))
  const lines = await db.freightCostLine.findMany({ where: { poId: freight.po!.id }, orderBy: { sortOrder: 'asc' }, select: { id: true, description: true, amountForeign: true, vatable: true, distributionMethod: true } })
  return { db, poId: freight.po!.id, lines }
}

const asInput = (rows: Array<{ id: string; description: string; amountForeign: unknown; vatable: boolean; distributionMethod: string }>) =>
  rows.map((r) => ({ id: r.id, description: r.description, amountForeign: Number(r.amountForeign), vatable: r.vatable, distributionMethod: r.distributionMethod }))

test('control: a partial bill of the vatable line of a mixed freight order records VAT 20 (the order rate), not the blended 10', SKIP, async () => {
  const { db, poId, lines } = await seedMixedFreight()
  const { createInvoice } = await import('@/app/actions/purchase-orders')
  const result = await createInvoice(poId, { invoiceDate: '2026-10-01', lines: [{ kind: 'cost', costLineId: lines[0]!.id, description: 'Duty', amountForeign: 100 }] })
  const invoices = await db.purchaseInvoice.findMany({ where: { poId }, select: { taxForeign: true, totalForeign: true } })
  console.log(`control PRECONDITION: success=${result.success} ${result.error ?? ''}; invoices=${invoices.length}; tax=${invoices[0]?.taxForeign}, total=${invoices[0]?.totalForeign}`)
  assert.equal(result.success, true, String(result.error))
  assert.equal(invoices.length, 1)
  assert.equal(invoices[0]!.taxForeign.toString(), '20')
  assert.equal(invoices[0]!.totalForeign.toString(), '120')
})

for (let round = 1; round <= 3; round += 1) {
  test(`race (round ${round}/3): a freight edit committing between createInvoice's read and its lock aborts the bill and saves nothing`, SKIP, async () => {
    const { db, poId, lines } = await seedMixedFreight()
    const { createInvoice, updateFreightPoCosts } = await import('@/app/actions/purchase-orders')
    let editResult: { success: boolean; error?: string } | null = null
    betweenReadAndLock = async () => {
      // The Duty line stops being vatable: same ids, new VAT (20 -> 0).
      editResult = await updateFreightPoCosts(poId, asInput(lines).map((l) => (l.id === lines[0]!.id ? { ...l, vatable: false } : l)))
    }
    const result = await createInvoice(poId, { invoiceDate: '2026-10-01', lines: [{ kind: 'cost', costLineId: lines[0]!.id, description: 'Duty', amountForeign: 100 }] })
    const after = await db.purchaseOrder.findUniqueOrThrow({ where: { id: poId }, select: { taxForeign: true } })
    const invoices = await db.purchaseInvoice.count({ where: { poId } })
    console.log(`race PRECONDITION (round ${round}): hook ran=${editResult !== null} edit.success=${(editResult as { success: boolean } | null)?.success}; order tax now ${after.taxForeign}; bill result success=${result.success}; invoices=${invoices}`)
    assert.equal(editResult !== null, true, 'the edit really ran between the read and the lock')
    assert.equal((editResult as unknown as { success: boolean }).success, true)
    assert.equal(after.taxForeign.toString(), '0', 'the committed edit zeroed the order VAT')
    assert.equal(result.success, false)
    assert.match(String(result.error), /changed while the bill was being prepared/)
    assert.equal(invoices, 0, 'no bill was saved from the old order')
  })
}
