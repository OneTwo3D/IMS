import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { loadEnv, uid } from './po-landed-fixtures'

/**
 * A CSV IMPORT HOLDS THE EXCHANGE-RATE TABLE STILL, SO A RATE CANNOT CHANGE MID-FILE (owner ruling 2026-10-26; lib/currencies/fx-table-lock.ts).
 *
 * The importer checks every group's rate first and then creates the orders one at a time. Without the lock a manual override landing between two creates makes the second order's
 * expectedFxRate guard refuse it after the first has committed: a half-imported file. WITH the lock the writer (the same action an admin uses) waits for the import to finish.
 *
 * Real Postgres, the real importer and the real override action. The first createSalesOrder is held on a gate so the import is deterministically mid-file.
 * Mutation: remove withFxTableHeldStill from the importer -> the override lands mid-import and the second order is refused (FX_RATE_CHANGED).
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

let entered: () => void = () => {}
const enteredP = new Promise<void>((resolve) => { entered = resolve })
let release: () => void = () => {}
const gate = new Promise<void>((resolve) => { release = resolve })
let calls = 0

test('an admin override waits for a running import; the whole file lands at the rates it was checked at', SKIP, async (t) => {
  loadEnv()
  const real = await import('@/app/actions/sales')
  mock.module('@/app/actions/sales', {
    namedExports: {
      ...real,
      createSalesOrder: async (...args: Parameters<typeof real.createSalesOrder>) => {
        calls += 1
        if (calls === 1) { entered(); await gate }
        return real.createSalesOrder(...args)
      },
    },
  })
  const { db } = await import('@/lib/db')
  const { importSalesOrdersCsv } = await import('@/app/actions/import')
  const { setManualFxRate } = await import('@/app/actions/currencies')

  const eurExisted = (await db.currency.findUnique({ where: { code: 'EUR' }, select: { code: true } })) !== null
  await db.currency.upsert({ where: { code: 'EUR' }, update: {}, create: { code: 'EUR', name: 'EUR', symbol: 'EUR' } })
  const base = await db.fxRate.create({ data: { fromCurrency: 'GBP', toCurrency: 'EUR', rate: 1.3, fetchedAt: new Date(Date.now() - 2000), source: 'manual', manualOverride: true } })
  const product = await db.product.create({ data: { sku: 'FXH-' + uid(), name: 'fx held', type: 'SIMPLE' }, select: { id: true, sku: true } })
  const keyA = 'FXHA-' + uid()
  const keyB = 'FXHB-' + uid()
  const created: string[] = []
  t.after(async () => {
    await db.salesOrder.deleteMany({ where: { externalOrderNumber: { in: [keyA, keyB] } } })
    await db.fxRate.deleteMany({ where: { toCurrency: 'EUR' } })
    if (!eurExisted) await db.currency.deleteMany({ where: { code: 'EUR' } })
    void created
  })
  const csv = `orderKey,customerName,currency,fxRateToBase,sku,qty,unitPriceForeign\r\n${keyA},FX Held,EUR,,${product.sku},1,10\r\n${keyB},FX Held,EUR,,${product.sku},1,10\r\n`
  const form = new FormData()
  form.set('file', new File([csv], 'x.csv'))
  const importing = importSalesOrdersCsv(form)
  await enteredP // the import is mid-file: it holds the table still and has not created its first order
  const override = setManualFxRate('EUR', 1.9)
  // the writer must be WAITING on the advisory lock, and the table must not have moved
  let waiting = 0
  for (let i = 0; i < 100 && waiting === 0; i++) {
    const rows = await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`
    waiting = Number(rows[0]?.n ?? 0)
    if (waiting === 0) await new Promise((r) => setTimeout(r, 50))
  }
  assert.ok(waiting >= 1, 'PRECONDITION: the override is blocked on the advisory lock while the import runs')
  assert.equal(await db.fxRate.count({ where: { toCurrency: 'EUR', rate: 1.9 } }), 0, 'the rate table has not moved')
  release()
  const result = await importing
  assert.deepEqual((result as { errors?: string[] }).errors ?? [], [], 'no FX_RATE_CHANGED: the whole file was written')
  const orders = await db.salesOrder.findMany({ where: { externalOrderNumber: { in: [keyA, keyB] } }, select: { fxRateToBase: true } })
  assert.equal(orders.length, 2, 'both orders written')
  assert.deepEqual(orders.map((o) => Number(o.fxRateToBase)), [1.3, 1.3])
  assert.deepEqual(await override, { success: true })
  assert.equal(await db.fxRate.count({ where: { toCurrency: 'EUR', rate: 1.9 } }), 1, 'and the override landed AFTER the import')
  void base
})
