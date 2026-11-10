import assert from 'node:assert/strict'
import test, { before, mock } from 'node:test'

import { createRecordingDb, type QueryContext } from '../security/recording-db'

/**
 * The sales and purchase-order lists used to read the newest 200 rows and filter them in the browser,
 * so an older order came back as "no results". These tests pin the server action: it must query the
 * database with the search, count the matches, and page with skip/take rather than a flat cap.
 */
let currentRole: 'ADMIN' | 'SUPPLIER' = 'ADMIN'
mock.module('@/lib/auth', {
  namedExports: {
    auth: async () => ({
      user: { id: 'u1', email: 'u@example.test', name: 'U', role: currentRole, supplierId: null, sessionInvalidReason: null, totpEnabled: false, totpVerified: false },
    }),
  },
})

const queries: QueryContext[] = []
let countResult = 0
const recorder = createRecordingDb((ctx: QueryContext) => {
  queries.push(ctx)
  if (ctx.op === 'count') return countResult
  if (ctx.op === 'findUnique' || ctx.op === 'findFirst') return null
  return []
})
mock.module('@/lib/db', { namedExports: { db: recorder.db } })

const whereOf = (ctx: QueryContext) => JSON.stringify((ctx.args[0] as { where?: unknown }).where ?? {})
const find = (model: string, op: string) => queries.filter((q) => q.model === model && q.op === op)
const argOf = (ctx: QueryContext) => ctx.args[0] as Record<string, unknown>

before(async () => {
  const { getPurchaseOrders } = await import('@/app/actions/purchase-orders')
  await recorder.prove(() => getPurchaseOrders())
})

test('getSalesOrders searches the database across all orders, with no 200-row cap', async () => {
  currentRole = 'ADMIN'
  queries.length = 0
  countResult = 1234
  const { getSalesOrders } = await import('@/app/actions/sales')
  const result = await getSalesOrders({ q: 'T584', page: 3 })

  const [findMany] = find('salesOrder', 'findMany')
  assert.ok(findMany, 'the rows come from a database query')
  assert.ok(whereOf(findMany).includes('T584'), 'the search term is in the where clause')
  assert.ok(whereOf(findMany).includes('customerEmail'), 'customer email is searched')
  assert.ok(!whereOf(findMany).includes('notIn'), 'a search includes completed orders')
  assert.ok(!whereOf(findMany).includes('"archived"'), 'a search includes archived orders')
  assert.equal(argOf(findMany).take, 50)
  assert.equal(argOf(findMany).skip, 100, 'page 3 skips two pages')
  assert.ok(find('salesOrder', 'count').length >= 1, 'the total is counted, not guessed from the page')
  assert.equal(result.total, 1234)
  assert.equal(result.pageCount, 25)
  assert.equal(result.page, 3)
  assert.deepEqual(result.hides, { completed: false, archived: false })
})

test('getSalesOrders default view hides completed and archived orders and counts what it hides', async () => {
  currentRole = 'ADMIN'
  queries.length = 0
  countResult = 7
  const { getSalesOrders } = await import('@/app/actions/sales')
  const result = await getSalesOrders()
  const [findMany] = find('salesOrder', 'findMany')
  assert.ok(whereOf(findMany).includes('"notIn":["COMPLETED","DELIVERED"]'))
  assert.ok(whereOf(findMany).includes('"archived":{"not":true}'))
  assert.deepEqual(result.hides, { completed: true, archived: true })
  assert.equal(result.hiddenCompletedCount, 7, 'the page can say how many completed orders are hidden')
  assert.equal(result.hiddenArchivedCount, 7)
})

test('getSalesOrders clamps an out-of-range page to the last page', async () => {
  currentRole = 'ADMIN'
  queries.length = 0
  countResult = 120
  const { getSalesOrders } = await import('@/app/actions/sales')
  const result = await getSalesOrders({ page: 99 })
  assert.equal(result.page, 3)
  assert.equal(argOf(find('salesOrder', 'findMany')[0]).skip, 100)
})

test('getSalesOrders still refuses a non-internal session before reading any order', async () => {
  currentRole = 'SUPPLIER'
  recorder.reset()
  const { getSalesOrders } = await import('@/app/actions/sales')
  await assert.rejects(() => getSalesOrders({ q: 'x' }), /Forbidden: missing permission internal/)
  recorder.assertNoReads('SUPPLIER searching sales orders')
})

test('getPurchaseOrders searches the database across all orders and includes archived ones', async () => {
  currentRole = 'ADMIN'
  queries.length = 0
  countResult = 400
  const { getPurchaseOrders } = await import('@/app/actions/purchase-orders')
  const result = await getPurchaseOrders({ q: 'PO-2024', page: 2 })
  const [findMany] = find('purchaseOrder', 'findMany')
  assert.ok(whereOf(findMany).includes('PO-2024'))
  assert.ok(whereOf(findMany).includes('"supplier":{"name"'), 'supplier name is searched')
  assert.ok(!whereOf(findMany).includes('"archived"'), 'a search includes archived orders')
  assert.equal(argOf(findMany).take, 50)
  assert.equal(argOf(findMany).skip, 50)
  assert.equal(result.total, 400)
  assert.equal(result.pageCount, 8)
  assert.equal(result.hidesArchived, false)
})

test('getPurchaseOrders default view hides archived orders and counts them', async () => {
  currentRole = 'ADMIN'
  queries.length = 0
  countResult = 3
  const { getPurchaseOrders } = await import('@/app/actions/purchase-orders')
  const result = await getPurchaseOrders()
  assert.ok(whereOf(find('purchaseOrder', 'findMany')[0]).includes('"archived":{"not":true}'))
  assert.equal(result.hidesArchived, true)
  assert.equal(result.hiddenArchivedCount, 3)
})

test('getPurchaseOrders still refuses a SUPPLIER session before reading any order', async () => {
  currentRole = 'SUPPLIER'
  recorder.reset()
  const { getPurchaseOrders } = await import('@/app/actions/purchase-orders')
  await assert.rejects(() => getPurchaseOrders({ q: 'x' }), /Forbidden: missing permission purchasing/)
  recorder.assertNoReads('SUPPLIER searching purchase orders')
})
