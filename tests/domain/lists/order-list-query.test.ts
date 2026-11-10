import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PO_STATUSES, SO_STATUSES, buildListPage, buildPurchaseOrderListWhere, buildSalesOrderListWhere,
  normaliseListQuery, normalisePage, normaliseStatuses, poListHidesArchived, soListHides,
} from '@/lib/domain/lists/order-list-query'
import { EMPTY_ORDER_LIST_URL_STATE, orderListHref, orderListRangeLabel } from '@/lib/domain/lists/order-list-url'

const json = (v: unknown) => JSON.stringify(v)

test('sales default view hides completed/delivered and archived orders, and says it hides them', () => {
  assert.deepEqual(soListHides({}), { completed: true, archived: true })
  const where = json(buildSalesOrderListWhere({}))
  assert.ok(where.includes('"notIn":["COMPLETED","DELIVERED"]'))
  assert.ok(where.includes('"archived":{"not":true}'))
})

test('a sales search always includes completed, delivered and archived orders', () => {
  const filter = { q: 'T584' }
  assert.deepEqual(soListHides(filter), { completed: false, archived: false })
  const where = json(buildSalesOrderListWhere(filter))
  assert.ok(!where.includes('notIn'), 'no status exclusion while searching')
  assert.ok(!where.includes('"archived"'), 'no archived exclusion while searching')
})

test('a sales search covers number, external number, customer, email, tracking, SKU and shipment tracking', () => {
  const where = json(buildSalesOrderListWhere({ q: 'abc' }))
  for (const field of ['orderNumber', 'externalOrderNumber', 'customerName', 'customerEmail', 'trackingNumber', 'shoppingLinks', 'externalOrderId', '"sku"', 'shipments']) {
    assert.ok(where.includes(field), `search covers ${field}`)
  }
  assert.ok(where.includes('"mode":"insensitive"'))
})

test('showing completed, or picking a completed status, lifts the completed exclusion; archived stays hidden', () => {
  assert.deepEqual(soListHides({ showCompleted: true }), { completed: false, archived: true })
  assert.deepEqual(soListHides({ statuses: ['COMPLETED'] }), { completed: false, archived: true })
  const where = json(buildSalesOrderListWhere({ statuses: ['COMPLETED'] }))
  assert.ok(where.includes('"status":{"in":["COMPLETED"]}'))
  assert.ok(!where.includes('notIn'))
  assert.ok(where.includes('"archived":{"not":true}'))
})

test('including archived shows archived orders without a search', () => {
  assert.equal(soListHides({ includeArchived: true }).archived, false)
  assert.ok(!json(buildSalesOrderListWhere({ includeArchived: true })).includes('"archived"'))
})

test('purchase order search covers reference, supplier, supplier ref, tracking and SKU, and includes archived', () => {
  assert.equal(poListHidesArchived({}), true)
  assert.equal(poListHidesArchived({ q: 'PO-1' }), false)
  const where = json(buildPurchaseOrderListWhere({ q: 'PO-1' }))
  for (const field of ['reference', 'supplierRef', 'trackingNumber', '"supplier":{"name"', '"sku"']) assert.ok(where.includes(field), field)
  assert.ok(!where.includes('"archived"'))
  assert.ok(json(buildPurchaseOrderListWhere({})).includes('"archived":{"not":true}'))
})

test('purchase order invoiced and returned filters run in the database', () => {
  const where = json(buildPurchaseOrderListWhere({ invoiced: true, returned: true }))
  assert.ok(where.includes('"invoices":{"some":{}}'))
  assert.ok(where.includes('"qtyReturned":{"gt":0}'))
})

test('input normalisation: trims and caps the query, clamps the page, drops unknown statuses', () => {
  assert.equal(normaliseListQuery('  hi  '), 'hi')
  assert.equal(normaliseListQuery('x'.repeat(500)).length, 100)
  assert.equal(normaliseListQuery(undefined), '')
  assert.equal(normalisePage('0'), 1)
  assert.equal(normalisePage('abc'), 1)
  assert.equal(normalisePage('3'), 3)
  assert.deepEqual(normaliseStatuses('PROCESSING, NOPE ,SHIPPED,PROCESSING', SO_STATUSES), ['PROCESSING', 'SHIPPED'])
  assert.deepEqual(normaliseStatuses(['RETURNED', 'x'], PO_STATUSES), ['RETURNED'])
  assert.deepEqual(buildListPage(1, 50, 0), { page: 1, pageSize: 50, total: 0, pageCount: 1 })
  assert.equal(buildListPage(1, 50, 201).pageCount, 5)
})

test('URL state round-trips and the range label states the total, never a silent cap', () => {
  assert.equal(orderListHref('/sales', EMPTY_ORDER_LIST_URL_STATE), '/sales')
  assert.equal(
    orderListHref('/sales', { ...EMPTY_ORDER_LIST_URL_STATE, q: 'a b', statuses: ['SHIPPED', 'COMPLETED'], page: 3, showCompleted: true, includeArchived: true }),
    '/sales?q=a+b&status=SHIPPED%2CCOMPLETED&completed=1&archived=1&page=3',
  )
  assert.equal(orderListRangeLabel(2, 50, 120, 'sales orders'), 'Showing 51–100 of 120 sales orders')
  assert.equal(orderListRangeLabel(1, 50, 0, 'sales orders'), 'No sales orders')
})

test('a 1-2 character search is not a substring scan: exact number match only, and flagged as too short', async () => {
  const { isShortListQuery } = await import('@/lib/domain/lists/order-list-query')
  assert.equal(isShortListQuery('a'), true)
  assert.equal(isShortListQuery('ab'), true)
  assert.equal(isShortListQuery('abc'), false)
  assert.equal(isShortListQuery(''), false)
  const so = json(buildSalesOrderListWhere({ q: 'a' }))
  assert.ok(!so.includes('contains'), 'no substring scan')
  assert.ok(so.includes('"equals":"a"'))
  assert.ok(!so.includes('customerEmail'))
  assert.ok(!json(buildSalesOrderListWhere({ q: 'a' })).includes('notIn'), 'still searches completed orders')
  const po = json(buildPurchaseOrderListWhere({ q: 'ab' }))
  assert.ok(!po.includes('contains') && po.includes('"equals":"ab"'))
  assert.ok(json(buildSalesOrderListWhere({ q: 'abc' })).includes('contains'))
})

test('debounced search keeps a filter changed during the debounce, and resyncs only on outside navigation', async () => {
  const { withSearchQuery, shouldResyncSearchInput } = await import('@/lib/domain/lists/order-list-url')
  // The status was ticked after the timer started: the live query string already has it.
  assert.equal(withSearchQuery('/sales', '?status=SHIPPED&completed=1&page=4', 'smith'), '/sales?status=SHIPPED&completed=1&q=smith')
  assert.equal(withSearchQuery('/sales', '?q=old&archived=1', ''), '/sales?archived=1')
  assert.equal(withSearchQuery('/sales', '', 'x y'), '/sales?q=x+y')
  assert.equal(shouldResyncSearchInput('back-q', 'typed'), true, 'Back changed q')
  assert.equal(shouldResyncSearchInput('typed', 'typed'), false, 'our own push does not clobber the box')
})
