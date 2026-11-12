import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import test, { after, mock } from 'node:test'

import { loadEnv, uid } from './po-landed-fixtures'

/**
 * TWO EDITS OF ONE BILL: the second must not save over the first. Each edit calculates its figures from the bill it READ, before the bill lock; an edit that
 * commits between that read and the lock replaced the bill, and the late edit is refused with a request to reload (instead of silently dropping the first).
 * The first edit is injected deterministically (no sleeps): `getBaseCurrencyCode` is called by `updateInvoice` after its read of the bill and before its
 * transaction, so the hook runs a complete second `updateInvoice` exactly there.
 *
 * [mutation: delete the stale-bill comparison under the lock in updateInvoice]
 */
const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const SKIP = { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' } as const

// The mapped rate this file gives its supplier is removed afterwards: the shared scratch database is read by later files (the reconciliation pack compares the IMS rate set with the
// stored Xero list), and a leftover rate of ours would be a difference they did not expect.
const fixtureRateIds: string[] = []
after(async () => {
  if (fixtureRateIds.length === 0) return
  const { db } = await import('@/lib/db')
  await db.supplier.updateMany({ where: { taxRateId: { in: fixtureRateIds } }, data: { taxRateId: null } })
  await db.taxRate.deleteMany({ where: { id: { in: fixtureRateIds } } })
})

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

test('an edit that commits between another edit\'s read and its lock is not overwritten: the late edit is refused', SKIP, async () => {
  const { db } = await import('@/lib/db')
  const { createPurchaseOrder, createInvoice, updateInvoice } = await import('@/app/actions/purchase-orders')
  const tag = `${uid()}-lost`
  const product = await db.product.create({ data: { sku: tag, name: 'lost', type: 'SIMPLE' }, select: { id: true } })
  const warehouse = await db.warehouse.create({ data: { code: `${uid()}-W`, name: `${tag} wh`, type: 'STANDARD' }, select: { id: true } })
  // A bill going to the ledger is not saved with an undecided tax type, and an earlier file in this tier can leave accounting sync switched on in the shared database: this order bills at no VAT, so
  // its supplier's default is a mapped 0% purchase rate (the supplier's own default is what decides among several 0% rates).
  const zeroRate = await db.taxRate.create({ data: { name: `${tag} zero`, rate: '0', usedFor: 'PURCHASE', accountingTaxType: 'ZERORATEDINPUT', active: true }, select: { id: true } })
  fixtureRateIds.push(zeroRate.id)
  const supplier = await db.supplier.create({ data: { name: `${tag} supplier`, currency: 'GBP', prepaid: true, taxRateId: zeroRate.id }, select: { id: true } })
  const created = await createPurchaseOrder({
    reference: tag, supplierId: supplier.id, currency: 'GBP', destinationWarehouseId: warehouse.id, pricesIncludeVat: false, taxRateValue: 0,
    lines: [{ productId: product.id, sku: tag, productName: 'lost', qty: 10, unitCostForeign: 12 }],
  } as never)
  assert.equal(created.success, true, String(created.error))
  const po = await db.purchaseOrder.findUniqueOrThrow({ where: { reference: tag }, select: { id: true, lines: { select: { id: true } } } })
  await db.purchaseOrder.update({ where: { id: po.id }, data: { status: 'PO_SENT' } })
  const bill = await createInvoice(po.id, { invoiceDate: '2026-11-01', invoiceNumber: 'SUP-1', lines: [{ kind: 'product', poLineId: po.lines[0]!.id, qtyBilled: 10, unitCostForeign: 12 }] } as never)
  assert.equal(bill.success, true, String(bill.error))
  const invoice = await db.purchaseInvoice.findFirstOrThrow({ where: { poId: po.id }, select: { id: true, lines: { select: { id: true } } } })
  const edit = (unitCostForeign: number, invoiceNumber = 'SUP-1') => updateInvoice(invoice.id, { invoiceDate: '2026-11-01', invoiceNumber, lines: [{ id: invoice.lines[0]!.id, qtyBilled: 10, unitCostForeign }] } as never)

  let first: { success: boolean; error?: string } | null = null
  betweenReadAndLock = async () => { first = await edit(11, 'SUP-1B') }
  const late = await edit(10)
  assert.equal(betweenReadAndLock, null, 'the first edit really ran between the late edit\'s read and its lock')
  assert.equal((first as unknown as { success: boolean }).success, true)
  assert.equal(late.success, false)
  assert.match(String(late.error), /changed by another edit/)
  const after = await db.purchaseInvoice.findUniqueOrThrow({ where: { id: invoice.id }, select: { subtotalForeign: true, invoiceNumber: true } })
  assert.equal(Number(after.subtotalForeign), 110, 'the first edit stands')
  assert.equal(after.invoiceNumber, 'SUP-1B')
  // Reloaded, the same edit goes through.
  const retried = await updateInvoice(invoice.id, { invoiceDate: '2026-11-01', invoiceNumber: 'SUP-1B', lines: [{ id: invoice.lines[0]!.id, qtyBilled: 10, unitCostForeign: 10 }] } as never)
  assert.equal(retried.success, true, retried.error)
  assert.equal(Number((await db.purchaseInvoice.findUniqueOrThrow({ where: { id: invoice.id } })).subtotalForeign), 100)
})
