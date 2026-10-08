import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'

import { startFakeWooCommerce } from '@/tests/helpers/fake-woocommerce'
import { buildWooOrder, wooFixtureOrders, BULK_PROCESSING_ORDERS } from '@/tests/fixtures/woo-import/orders'

/**
 * The fake WooCommerce store the rehearsal runs against. These tests are on the INSTRUMENT: if the fake
 * could not see a write, or served the wrong page, the rehearsal's "no write reached the store" and its
 * order counts would prove nothing.
 *
 * Every request here goes to the fake on 127.0.0.1; nothing names a real host.
 */

const KEY = 'ck_test'
const SECRET = 'cs_test'
const AUTH = `Basic ${Buffer.from(`${KEY}:${SECRET}`).toString('base64')}`

function order(id: number, status: string, minutes: number) {
  return buildWooOrder({ id, status, createdOffsetMinutes: minutes, lines: [{ sku: 'X', qty: 1, unitMinor: 1000 }] })
}

async function call(base: string, path: string, init: { method?: string; auth?: string | null } = {}) {
  const res = await fetch(`${base}${path}`, { method: init.method ?? 'GET', headers: init.auth === null ? {} : { authorization: init.auth ?? AUTH } })
  const text = await res.text()
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null }
}

test('the fake binds loopback on an ephemeral port and says so', async () => {
  const fake = await startFakeWooCommerce({ orders: [order(1, 'processing', 1)], key: KEY, secret: SECRET })
  try {
    assert.match(fake.url, /^http:\/\/127\.0\.0\.1:\d+$/)
    assert.ok(fake.port > 1023)
    // A second fake gets a different port: the port is not a constant.
    const other = await startFakeWooCommerce({ orders: [], key: KEY, secret: SECRET })
    try { assert.notEqual(other.port, fake.port) } finally { await other.close() }
  } finally {
    await fake.close()
  }
})

test('credentials are enforced: no or wrong Basic auth is 401 and recorded as unauthenticated', async () => {
  const fake = await startFakeWooCommerce({ orders: [order(1, 'processing', 1)], key: KEY, secret: SECRET })
  try {
    assert.equal((await call(fake.url, '/wp-json/wc/v3/orders', { auth: null })).status, 401)
    assert.equal((await call(fake.url, '/wp-json/wc/v3/orders', { auth: 'Basic eDp5' })).status, 401)
    assert.equal((await call(fake.url, '/wp-json/wc/v3/orders')).status, 200)
    assert.deepEqual(fake.requests.map((r) => r.authenticated), [false, false, true])
  } finally {
    await fake.close()
  }
})

test('status filtering takes a comma list, ordering is by date, and paging carries the WooCommerce headers', async () => {
  const orders = [order(1, 'processing', 5), order(2, 'completed', 1), order(3, 'on-hold', 3), order(4, 'processing', 2)]
  const fake = await startFakeWooCommerce({ orders, key: KEY, secret: SECRET })
  try {
    const res = await call(fake.url, '/wp-json/wc/v3/orders?status=processing,on-hold&per_page=2&page=1&orderby=date&order=asc')
    console.log(`precondition: ${res.body.length} rows on page 1, x-wp-total=${res.headers.get('x-wp-total')}`)
    assert.deepEqual(res.body.map((o: { id: number }) => o.id), [4, 3])
    assert.equal(res.headers.get('x-wp-total'), '3')
    assert.equal(res.headers.get('x-wp-totalpages'), '2')
    const second = await call(fake.url, '/wp-json/wc/v3/orders?status=processing,on-hold&per_page=2&page=2&order=asc')
    assert.deepEqual(second.body.map((o: { id: number }) => o.id), [1])
    assert.equal(fake.countInStatuses(['processing', 'on-hold']), 3)
    assert.equal(fake.countInStatuses(['completed']), 1)
    // The status that was not asked for is never served.
    assert.ok(![...res.body, ...second.body].some((o: { status: string }) => o.status === 'completed'))
  } finally {
    await fake.close()
  }
})

test('a page past the end is an empty array, or HTTP 400 when the store is told to answer like that; headers can be omitted; a page can be told to fail', async () => {
  const orders = [order(1, 'processing', 1)]
  const plain = await startFakeWooCommerce({ orders, key: KEY, secret: SECRET })
  const strict = await startFakeWooCommerce({ orders, key: KEY, secret: SECRET, pastEnd: 'error', omitPaginationHeaders: true, failPages: [3] })
  try {
    const past = await call(plain.url, '/wp-json/wc/v3/orders?per_page=100&page=2')
    assert.equal(past.status, 200)
    assert.deepEqual(past.body, [])
    const err = await call(strict.url, '/wp-json/wc/v3/orders?per_page=100&page=2')
    assert.equal(err.status, 400)
    assert.equal(err.body.code, 'rest_post_invalid_page_number')
    assert.equal((await call(strict.url, '/wp-json/wc/v3/orders?per_page=100&page=1')).headers.get('x-wp-totalpages'), null)
    assert.equal((await call(strict.url, '/wp-json/wc/v3/orders?page=3')).status, 500)
  } finally {
    await plain.close()
    await strict.close()
  }
})

test('THE TRAP CAN FAIL: a POST, PUT, DELETE and PATCH are each answered 405 and recorded as a write violation (the control for "no write reached the store")', async () => {
  const fake = await startFakeWooCommerce({ orders: [order(1, 'processing', 1)], key: KEY, secret: SECRET })
  try {
    assert.equal(fake.writeViolations().length, 0, 'precondition: none before the control')
    await call(fake.url, '/wp-json/wc/v3/orders')
    assert.equal(fake.writeViolations().length, 0, 'a read is not a violation')
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await call(fake.url, '/wp-json/wc/v3/webhooks', { method })
      assert.equal(res.status, 405, method)
    }
    assert.deepEqual(fake.writeViolations().map((r) => r.method), ['POST', 'PUT', 'DELETE', 'PATCH'])
    console.log(`control: ${fake.writeViolations().length} write violations recorded of ${fake.requests.length} requests`)
  } finally {
    await fake.close()
  }
})

test('a write with a body is drained and recorded, and a route the fake does not model is recorded as unmodelled', async () => {
  const fake = await startFakeWooCommerce({ orders: [], key: KEY, secret: SECRET })
  try {
    await new Promise<void>((resolve, reject) => {
      const req = http.request(`${fake.url}/wp-json/wc/v3/orders`, { method: 'POST', headers: { authorization: AUTH, 'content-type': 'application/json' } }, (res) => { res.resume(); res.on('end', resolve) })
      req.on('error', reject)
      req.end(JSON.stringify({ status: 'completed' }))
    })
    await call(fake.url, '/wp-json/wc/v3/products?sku=A')
    assert.equal(fake.writeViolations().length, 1)
    assert.deepEqual(fake.unmodelledRequests().map((r) => `${r.method} ${r.path}`), ['POST /wp-json/wc/v3/orders', 'GET /wp-json/wc/v3/products'])
  } finally {
    await fake.close()
  }
})

test('single-order and refunds routes answer; an unknown id is a WooCommerce 404', async () => {
  const fake = await startFakeWooCommerce({ orders: [order(7, 'processing', 1)], key: KEY, secret: SECRET })
  try {
    assert.equal((await call(fake.url, '/wp-json/wc/v3/orders/7')).body.id, 7)
    assert.deepEqual((await call(fake.url, '/wp-json/wc/v3/orders/7/refunds')).body, [])
    const missing = await call(fake.url, '/wp-json/wc/v3/orders/8')
    assert.equal(missing.status, 404)
    assert.equal(missing.body.code, 'woocommerce_rest_shop_order_invalid_id')
  } finally {
    await fake.close()
  }
})

// ---------------------------------------------------------------------------------------------
// The synthetic orders themselves
// ---------------------------------------------------------------------------------------------

test('FIXTURES: every order total is exactly the sum of its parts, in integer pence', () => {
  const all = wooFixtureOrders()
  let checked = 0
  for (const { order: o } of all) {
    const cents = (v: string) => Math.round(Number(v) * 100)
    const lines = o.line_items.reduce((s, l) => s + cents(l.total) + cents(l.total_tax), 0)
    const fees = o.fee_lines.reduce((s, f) => s + cents(f.total) + cents(f.total_tax), 0)
    const shipping = o.shipping_lines.reduce((s, l) => s + cents(l.total) + cents(l.total_tax), 0)
    assert.equal(lines + fees + shipping, cents(o.total), `order ${o.id}`)
    // the tax lines add up to the order's tax
    assert.equal(o.tax_lines.reduce((s, t) => s + cents(t.tax_total) + cents(t.shipping_tax_total), 0), cents(o.total_tax), `order ${o.id} tax lines`)
    checked++
  }
  console.log(`precondition: ${checked} fixture orders checked`)
  assert.ok(checked >= 100 + BULK_PROCESSING_ORDERS - 100)
})

test('FIXTURES: the set covers each shape the rehearsal claims (statuses, refunds, coupons, fees, tax rates, guest, currency, absent SKU, bulk beyond one page)', () => {
  const all = wooFixtureOrders().map((f) => f.order)
  const has = (pred: (o: (typeof all)[number]) => boolean) => all.filter(pred).length
  const shapes = {
    pending: has((o) => o.status === 'pending'),
    onHold: has((o) => o.status === 'on-hold'),
    processing: has((o) => o.status === 'processing'),
    completed: has((o) => o.status === 'completed'),
    cancelled: has((o) => o.status === 'cancelled'),
    refunded: has((o) => o.status === 'refunded'),
    failed: has((o) => o.status === 'failed'),
    partialRefund: has((o) => o.status === 'processing' && o.refunds.length > 0),
    coupon: has((o) => o.coupon_lines.length > 0),
    fee: has((o) => o.fee_lines.length > 0),
    twoTaxRates: has((o) => o.tax_lines.length > 1),
    guest: has((o) => o.customer_id === 0),
    euro: has((o) => o.currency === 'EUR'),
    noRateCurrency: has((o) => o.currency === 'USD'),
    shipping: has((o) => o.shipping_lines.length > 0),
    taxInclusive: has((o) => o.prices_include_tax),
    noTaxLines: has((o) => o.tax_lines.length === 0),
    noSkuLine: has((o) => o.line_items.some((l) => l.sku === '')),
    absentSku: has((o) => o.line_items.some((l) => l.sku === 'REH-X-ABSENT-FROM-IMS')),
    unmappedRate: has((o) => o.tax_lines.some((t) => t.rate_id === 99)),
  }
  console.log(`shapes: ${JSON.stringify(shapes)}`)
  for (const [shape, n] of Object.entries(shapes)) assert.ok(n > 0, `no fixture order has the shape "${shape}"`)
  assert.ok(shapes.processing + shapes.pending + shapes.onHold > 100, 'more than one page of 100 in the selected statuses')
  // ids are unique
  assert.equal(new Set(all.map((o) => o.id)).size, all.length)
})
