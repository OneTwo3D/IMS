import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { loadEnv, uid } from './po-landed-fixtures'

/**
 * THE FX TABLE LOCK DIES MID-IMPORT (lib/currencies/fx-table-lock.ts). The importers write each order on pooled connections, so when the pinned lock connection dies PostgreSQL frees the shared
 * lock and a rate writer can run while the importer would carry on. Each importer must check the lock immediately before every write and after the last one.
 *
 *   arm 1  lost BEFORE the first write -> the whole file is refused, nothing written (FX_TABLE_LOCK_LOST)
 *   arm 2  lost AFTER some orders were saved -> no further write; the saved orders are named, the rest reported as not written (FX_TABLE_LOCK_LOST)
 *   arm 3  lost during the LAST order -> reported by the check after the last write
 *   arm 4  the normal path is unchanged (see fx-table-held-during-import.concurrent.test.ts)
 * Real Postgres; the lock connection is really terminated (pg_terminate_backend). Mutation: delete the assertHeld calls in the importers -> arms 1 and 2 write the whole file, arm 3 reports nothing.
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

// Which create call (1-based, of the whole file) is preceded / followed by the lock connection's death. 0 = never.
let killOnAcquire = false
let killAfterCall = 0
let salesCalls = 0
let poCalls = 0

type Db = typeof import('@/lib/db')['db']
async function killFxLock(db: Db): Promise<void> {
  const killed = await db.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(pg_terminate_backend(l.pid))::bigint AS n FROM pg_locks l
    WHERE l.locktype = 'advisory' AND l.granted AND l.mode = 'ShareLock' AND l.objsubid = 1
      AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database()) AND l.pid <> pg_backend_pid()`
  assert.equal(Number(killed[0]?.n ?? 0), 1, 'PRECONDITION: exactly one shared advisory lock connection was terminated')
  await new Promise((r) => setTimeout(r, 400)) // the pg client's idle-error event marks the pinned lock lost
}

test('FX lock lost mid-import: nothing written before the first write; precise partial report after; the check after the last write', SKIP, async (t) => {
  loadEnv()
  const { db } = await import('@/lib/db')
  const realSales = await import('@/app/actions/sales')
  const realPo = await import('@/app/actions/purchase-orders')
  const realLock = await import('@/lib/db/pinned-advisory-lock')
  mock.module('@/lib/db/pinned-advisory-lock', {
    namedExports: {
      ...realLock,
      acquirePinnedSharedAdvisoryLockWaiting: async (...args: Parameters<typeof realLock.acquirePinnedSharedAdvisoryLockWaiting>) => {
        const lock = await realLock.acquirePinnedSharedAdvisoryLockWaiting(...args)
        if (killOnAcquire) await killFxLock(db) // the lock connection dies right after the import took the lock, before any order is written
        return lock
      },
    },
  })
  mock.module('@/app/actions/sales', {
    namedExports: {
      ...realSales,
      createSalesOrder: async (...args: Parameters<typeof realSales.createSalesOrder>) => {
        salesCalls += 1
        const out = await realSales.createSalesOrder(...args)
        if (salesCalls === killAfterCall) await killFxLock(db)
        return out
      },
    },
  })
  mock.module('@/app/actions/purchase-orders', {
    namedExports: {
      ...realPo,
      createPurchaseOrder: async (...args: Parameters<typeof realPo.createPurchaseOrder>) => {
        poCalls += 1
        const out = await realPo.createPurchaseOrder(...args)
        if (poCalls === killAfterCall) await killFxLock(db)
        return out
      },
    },
  })
  const { importSalesOrdersCsv, importPurchaseOrdersCsv } = await import('@/app/actions/import')

  const eurExisted = (await db.currency.findUnique({ where: { code: 'EUR' }, select: { code: true } })) !== null
  await db.currency.upsert({ where: { code: 'EUR' }, update: {}, create: { code: 'EUR', name: 'EUR', symbol: 'EUR' } })
  await db.fxRate.create({ data: { fromCurrency: 'GBP', toCurrency: 'EUR', rate: 1.3, fetchedAt: new Date(Date.now() - 2000), source: 'manual', manualOverride: true } })
  const product = await db.product.create({ data: { sku: 'FXL-' + uid(), name: 'fx lost', type: 'SIMPLE' }, select: { id: true, sku: true } })
  const supplier = await db.supplier.create({ data: { name: 'FXL Supplier ' + uid(), currency: 'EUR' }, select: { id: true, name: true } })
  const tag = uid()
  t.after(async () => {
    const sos = (await db.salesOrder.findMany({ where: { externalOrderNumber: { startsWith: `FXL${tag}` } }, select: { id: true } })).map((r) => r.id)
    await db.salesOrderLine.deleteMany({ where: { orderId: { in: sos } } })
    await db.salesOrder.deleteMany({ where: { id: { in: sos } } })
    const pos = (await db.purchaseOrder.findMany({ where: { reference: { startsWith: `FXL${tag}` } }, select: { id: true } })).map((r) => r.id)
    await db.purchaseOrderLine.deleteMany({ where: { poId: { in: pos } } })
    await db.purchaseOrder.deleteMany({ where: { id: { in: pos } } })
    await db.supplier.deleteMany({ where: { id: supplier.id } }).catch(() => undefined)
    await db.product.deleteMany({ where: { id: product.id } }).catch(() => undefined)
    await db.fxRate.deleteMany({ where: { toCurrency: 'EUR' } })
    if (!eurExisted) await db.currency.deleteMany({ where: { code: 'EUR' } })
  })

  const soCsv = (arm: string, n: number) => `orderKey,customerName,currency,fxRateToBase,sku,qty,unitPriceForeign\r\n${Array.from({ length: n }, (_, i) => `FXL${tag}${arm}${i},FX Lost,EUR,,${product.sku},1,10`).join('\r\n')}\r\n`
  const poCsv = (arm: string, n: number) => `orderKey,supplierName,currency,fxRateToBase,sku,qty,unitCostForeign\r\n${Array.from({ length: n }, (_, i) => `FXL${tag}${arm}${i},${supplier.name},EUR,,${product.sku},1,2`).join('\r\n')}\r\n`
  const form = (csv: string) => { const f = new FormData(); f.set('file', new File([csv], 'x.csv')); return f }
  const errs = (r: unknown) => ((r as { errors?: string[] }).errors ?? []).join('\n')
  const soCount = (arm: string) => db.salesOrder.count({ where: { externalOrderNumber: { startsWith: `FXL${tag}${arm}` } } })
  const poCount = (arm: string) => db.purchaseOrder.count({ where: { reference: { startsWith: `FXL${tag}${arm}` } } })

  // ---- sales
  killOnAcquire = true; killAfterCall = 0; salesCalls = 0
  let r = await importSalesOrdersCsv(form(soCsv('a', 3)))
  assert.match(errs(r), /FX_TABLE_LOCK_LOST/)
  assert.match(errs(r), /no sales order was written/)
  assert.equal(await soCount('a'), 0, 'sales arm 1: lost before the first write -> nothing written')

  killOnAcquire = false; killAfterCall = 1; salesCalls = 0
  r = await importSalesOrdersCsv(form(soCsv('b', 3)))
  assert.match(errs(r), /FX_TABLE_LOCK_LOST/)
  assert.match(errs(r), new RegExp(`after 1 sales order\\(s\\) were saved \\(FXL${tag}b0\\); 2 further group\\(s\\) were NOT written`))
  assert.equal(await soCount('b'), 1, 'sales arm 2: exactly the first order saved, no further write after the lock was lost')
  assert.equal((r as { created?: number }).created, 1)

  killOnAcquire = false; killAfterCall = 2; salesCalls = 0
  r = await importSalesOrdersCsv(form(soCsv('c', 2)))
  assert.match(errs(r), /FX_TABLE_LOCK_LOST/)
  assert.match(errs(r), /after 2 sales order\(s\) were saved/)
  assert.equal(await soCount('c'), 2, 'sales arm 3: lost during the last order -> reported by the check after the last write')

  // ---- purchase
  killOnAcquire = true; killAfterCall = 0; poCalls = 0
  r = await importPurchaseOrdersCsv(form(poCsv('a', 3)))
  assert.match(errs(r), /FX_TABLE_LOCK_LOST/)
  assert.match(errs(r), /no purchase order was written/)
  assert.equal(await poCount('a'), 0, 'purchase arm 1: nothing written')

  killOnAcquire = false; killAfterCall = 1; poCalls = 0
  r = await importPurchaseOrdersCsv(form(poCsv('b', 3)))
  assert.match(errs(r), /FX_TABLE_LOCK_LOST/)
  assert.match(errs(r), new RegExp(`after 1 purchase order\\(s\\) were saved \\(FXL${tag}b0\\); 2 further group\\(s\\) were NOT written`))
  assert.equal(await poCount('b'), 1, 'purchase arm 2: exactly the first order saved')

  killOnAcquire = false; killAfterCall = 2; poCalls = 0
  r = await importPurchaseOrdersCsv(form(poCsv('c', 2)))
  assert.match(errs(r), /FX_TABLE_LOCK_LOST/)
  assert.equal(await poCount('c'), 2, 'purchase arm 3: reported by the check after the last write')

  // ---- arm 4: the normal path
  killOnAcquire = false; killAfterCall = 0; salesCalls = 0; poCalls = 0
  r = await importSalesOrdersCsv(form(soCsv('d', 2)))
  assert.equal(errs(r), '', 'normal path: no error')
  assert.equal(await soCount('d'), 2)
  r = await importPurchaseOrdersCsv(form(poCsv('d', 2)))
  assert.equal(errs(r), '', 'normal path: no error (purchase)')
  assert.equal(await poCount('d'), 2)
})
