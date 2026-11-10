import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { loadEnv, uid } from './po-landed-fixtures'

/**
 * A BILL'S FIRST POSTING THAT IS WRITTEN BACK BETWEEN updateInvoice's UNLOCKED READ AND ITS LOCK. The edit's payload was built for a bill with no ledger
 * document (a refresh of the queued create); the document exists now, so that is the wrong kind of write. The edit must be refused with nothing saved.
 * The write-back is injected deterministically (no sleeps): `getBaseCurrencyCode` is called by `updateInvoice` after its read of the bill and before its
 * transaction.
 *
 * [mutation: delete the accountingInvoiceId comparison under the lock in updateInvoice]
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

test('the bill is posted and written back between the read and the lock: the edit is refused and nothing is saved', SKIP, async () => {
  const { db } = await import('@/lib/db')
  const { createPurchaseOrder, createInvoice, updateInvoice } = await import('@/app/actions/purchase-orders')
  const settings = [['plugin_xero_enabled', 'true'], ['xero_sync_enabled', 'true'], ['xero_transit_account', '631']] as const
  const prior = await db.setting.findMany({ where: { key: { in: settings.map(([k]) => k) } } })
  for (const [key, value] of settings) await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
  const tag = `${uid()}-bpm`
  try {
    const product = await db.product.create({ data: { sku: tag, name: 'bpm', type: 'SIMPLE' }, select: { id: true } })
    const warehouse = await db.warehouse.create({ data: { code: `${uid()}-W`, name: `${tag} wh`, type: 'STANDARD' }, select: { id: true } })
    const supplier = await db.supplier.create({ data: { name: `${tag} supplier`, currency: 'GBP', prepaid: true }, select: { id: true } })
    const created = await createPurchaseOrder({
      reference: tag, supplierId: supplier.id, currency: 'GBP', destinationWarehouseId: warehouse.id, pricesIncludeVat: false, taxRateValue: 0,
      lines: [{ productId: product.id, sku: tag, productName: 'bpm', qty: 10, unitCostForeign: 12 }],
    } as never)
    assert.equal(created.success, true, String(created.error))
    const po = await db.purchaseOrder.findUniqueOrThrow({ where: { reference: tag }, select: { id: true, lines: { select: { id: true } } } })
    await db.purchaseOrder.update({ where: { id: po.id }, data: { status: 'PO_SENT' } })
    const bill = await createInvoice(po.id, { invoiceDate: '2026-11-01', invoiceNumber: 'SUP-1', lines: [{ kind: 'product', poLineId: po.lines[0]!.id, qtyBilled: 10, unitCostForeign: 12 }] } as never)
    assert.equal(bill.success, true, String(bill.error))
    const invoice = await db.purchaseInvoice.findFirstOrThrow({ where: { poId: po.id }, select: { id: true, lines: { select: { id: true } } } })

    betweenReadAndLock = async () => {
      await db.purchaseInvoice.update({ where: { id: invoice.id }, data: { accountingInvoiceId: `XERO-BILL-${tag}` } })
    }
    const result = await updateInvoice(invoice.id, { invoiceDate: '2026-11-01', invoiceNumber: 'SUP-1', lines: [{ id: invoice.lines[0]!.id, qtyBilled: 10, unitCostForeign: 10 }] } as never)
    assert.equal(betweenReadAndLock, null, 'the write-back really ran between the read and the lock')
    assert.equal(result.success, false)
    assert.match(String(result.error), /posted to the accounting system while it was being edited/)
    const after = await db.purchaseInvoice.findUniqueOrThrow({ where: { id: invoice.id }, select: { subtotalForeign: true } })
    assert.equal(Number(after.subtotalForeign), 120, 'IMS still holds the posted figures')
  } finally {
    for (const [key] of settings) {
      const was = prior.find((r: { key: string }) => r.key === key)
      if (was) await db.setting.update({ where: { key }, data: { value: was.value } })
      else await db.setting.deleteMany({ where: { key } })
    }
  }
})
