import assert from 'node:assert/strict'
import test from 'node:test'

import { WOO_MIN_REQUEST_INTERVAL_MS } from '../../lib/reconciliation-pack/constants.ts'
import { readWooOrders, readWooProducts, readWooTaxRates, type WooPage } from '../../lib/reconciliation-pack/woo-source.ts'
import { fakeStore, many, noSleep, order, type Tweak } from './woo-fixtures.ts'

/**
 * THE WALKS. Every arm is a store that lies in one way; the walk must give a closed reason and NO list. Mutations are listed in the PR
 * (each guard in woo-source.ts disabled in turn, one test of this file turns red).
 */

const opts = { sleep: noSleep }
const okPage = (page: Extract<WooPage, { ok: true }>, over: Partial<Extract<WooPage, { ok: true }>>): WooPage => ({ ...page, ...over })
const fails = async (data: Parameters<typeof fakeStore>[0], tweak: Tweak | undefined, reason: string, statuses = ['processing'], options: Parameters<typeof readWooOrders>[2] = opts) => {
  const read = await readWooOrders(fakeStore(data, tweak), statuses, options)
  assert.equal(read.ok, false, 'a lying store gives no list')
  if (!read.ok) assert.equal(read.reason, reason)
  assert.ok(!('value' in read), 'and no partial value')
}

test('a faithful store: every status walked on its own in two full sweeps, with the rows exactly as the store holds them', async () => {
  const store = fakeStore({ orders: { processing: many(250), 'on-hold': many(3, 1000, 'on-hold') } })
  const read = await readWooOrders(store, ['processing', 'on-hold'], opts)
  assert.ok(read.ok)
  assert.equal(read.value.orders.length, 253)
  assert.deepEqual(read.value.totals, [{ status: 'processing', total: 250 }, { status: 'on-hold', total: 3 }])
  assert.equal(read.value.allZero, false)
  assert.deepEqual(read.value.orders[0], { id: '1', status: 'processing', currency: 'GBP', total: '12.50', createdAt: '2026-10-10T09:30:00.000Z' })
  // 250 rows = 3 pages, read twice; 3 rows = 1 page, read twice: 8 requests, none for a status the caller did not name.
  assert.equal(store.calls.length, 8)
  assert.deepEqual([...new Set(store.calls.map((c) => c.params.status))], ['processing', 'on-hold'])
  for (const call of store.calls) assert.deepEqual(Object.keys(call.params).sort(), ['_fields', 'order', 'orderby', 'page', 'per_page', 'status'])
  // Sweep A (processing 3 pages, on-hold 1) finishes before sweep B starts.
  assert.deepEqual(store.calls.map((c) => `${c.params.status}:${c.params.page}`), ['processing:1', 'processing:2', 'processing:3', 'on-hold:1', 'processing:1', 'processing:2', 'processing:3', 'on-hold:1'])
})

test('products and tax rates are walked in full and twice, with their own fields', async () => {
  const taxes = fakeStore({ taxes: Array.from({ length: 105 }, (_, i) => ({ id: i + 1 })) })
  const rates = await readWooTaxRates(taxes, opts)
  assert.ok(rates.ok && rates.value.rates.length === 105 && rates.value.total === 105)
  assert.equal(taxes.calls.length, 4)
  assert.ok(taxes.calls.every((c) => c.collection === 'taxes' && c.params._fields === 'id'))
  const products = fakeStore({ products: [{ id: 5, sku: 'ABC-1', status: 'publish', type: 'simple' }, { id: 9, sku: '', status: 'draft', type: 'variable' }] })
  const read = await readWooProducts(products, opts)
  assert.ok(read.ok)
  assert.deepEqual(read.value.products, [{ id: '5', sku: 'ABC-1', status: 'publish', type: 'simple' }, { id: '9', sku: '', status: 'draft', type: 'variable' }])
  assert.ok(products.calls.every((c) => c.params.status === 'any'))
})

// [mutation: the count check against X-WP-Total removed / the page-length check removed]
test('the count must be the total the store reported, page by page: a short page, a long page and a total that is not the rows are all unstable', async () => {
  const data = { orders: { processing: many(150) } }
  await fails(data, (call, _n, page) => call.params.page === '1' ? okPage(page, { body: (page.body as unknown[]).slice(0, 99) }) : undefined, 'VENDOR_READ_UNSTABLE')
  await fails(data, (call, _n, page) => call.params.page === '2' ? okPage(page, { body: [...(page.body as unknown[]), order(9999)] }) : undefined, 'VENDOR_READ_UNSTABLE')
  await fails(data, (_c, _n, page) => okPage(page, { total: '149', totalPages: '2' }), 'VENDOR_READ_UNSTABLE')
  await fails(data, (_c, _n, page) => okPage(page, { total: '151', totalPages: '2' }), 'VENDOR_READ_UNSTABLE')
})

// [mutation: page 2's total compared with page 1's removed]
test('PAGE DRIFT: a total or a page count that changes between pages of one walk is unstable', async () => {
  const data = { orders: { processing: many(250) } }
  await fails(data, (call, _n, page) => call.params.page === '2' ? okPage(page, { total: '251', totalPages: '3' }) : undefined, 'VENDOR_READ_UNSTABLE')
  await fails(data, (call, _n, page) => call.params.page === '3' ? okPage(page, { totalPages: '4' }) : undefined, 'VENDOR_READ_UNSTABLE')
})

// [mutation: the pages = ceil(total / per_page) check removed]
test('a page count that is not the total over the page size is unstable; a zero total may report one page, nothing else may', async () => {
  await fails({ orders: { processing: many(150) } }, (_c, _n, page) => okPage(page, { totalPages: '3' }), 'VENDOR_READ_UNSTABLE')
  await fails({ orders: { processing: many(150) } }, (_c, _n, page) => okPage(page, { totalPages: '1' }), 'VENDOR_READ_UNSTABLE')
  await fails({ orders: { processing: [] } }, (_c, _n, page) => okPage(page, { totalPages: '2' }), 'VENDOR_READ_UNSTABLE')
  const zero = await readWooOrders(fakeStore({ orders: { processing: [] } }, (_c, _n, page) => okPage(page, { totalPages: '1' })), ['processing'], opts)
  assert.ok(zero.ok && zero.value.allZero)
})

// [mutation: the header parser accepts any parseInt, or a missing header reads as 0 / 1]
test('a missing, empty, signed, padded, fractional or oversized pagination header is unreadable - the store saying nothing is never one page', async () => {
  const data = { orders: { processing: many(5) } }
  for (const bad of [null, '', ' 5', '5 ', '+5', '-5', '5.0', '5e0', '0x5', '05', 'five', '1234567890']) {
    await fails(data, (_c, _n, page) => okPage(page, { total: bad }), 'SOURCE_UNREADABLE')
    await fails(data, (_c, _n, page) => okPage(page, { totalPages: bad }), 'SOURCE_UNREADABLE')
  }
})

// [mutation: the status === 200 check removed]
test('any answer that is not an HTTP 200 JSON array is unreadable: a failure, another status, a body that is an object, a string or null, a throw', async () => {
  const data = { orders: { processing: many(5) } }
  await fails(data, () => ({ ok: false }), 'SOURCE_UNREADABLE')
  await fails(data, (_c, _n, page) => okPage(page, { status: 206 }), 'SOURCE_UNREADABLE')
  await fails(data, (_c, _n, page) => okPage(page, { status: 204 }), 'SOURCE_UNREADABLE')
  for (const body of [{}, 'x', null, 7, { 0: order(1) }]) await fails(data, (_c, _n, page) => okPage(page, { body }), 'SOURCE_UNREADABLE')
  await fails(data, () => { throw new Error('connection refused to https://shop.example/?consumer_secret=hunter2') }, 'SOURCE_UNREADABLE')
  await fails(data, () => 'not a page' as never, 'SOURCE_UNREADABLE')
  // The failing page may be the second page, or the second READ.
  await fails({ orders: { processing: many(150) } }, (call) => call.params.page === '2' ? { ok: false } : undefined, 'SOURCE_UNREADABLE')
  await fails(data, (_c, n) => n === 2 ? { ok: false } : undefined, 'SOURCE_UNREADABLE')
})

// [mutation: the duplicate-id check removed] [mutation: the ascending-id check removed]
test('a store that ignores `page` (the same rows again), repeats an id, or does not honour the order asked for is unstable', async () => {
  await fails({ orders: { processing: many(250) } }, (_c, _n, page) => ({ ...page, body: many(100) }), 'VENDOR_READ_UNSTABLE')
  await fails({ orders: { processing: many(5) } }, (_c, _n, page) => okPage(page, { body: [...(page.body as unknown[]).slice(0, 4), order(2)] }), 'VENDOR_READ_UNSTABLE')
  await fails({ orders: { processing: many(5) } }, (_c, _n, page) => okPage(page, { body: [...(page.body as unknown[])].reverse() }), 'VENDOR_READ_UNSTABLE')
  // The same order id in two statuses is one order seen twice.
  await fails({ orders: { processing: many(2), 'on-hold': [order(2, 'on-hold')] } }, undefined, 'VENDOR_READ_UNSTABLE', ['processing', 'on-hold'])
})

// [mutation: the second read removed / the second read compared by count only]
test('THE DOUBLE SCAN: a store whose second read differs - in a value, a status, a currency, or one identity swapped for another - is unstable', async () => {
  const data = { orders: { processing: many(5) } }
  const second = (change: (rows: Array<Record<string, unknown>>) => Array<Record<string, unknown>>): Tweak => (_c, n, page) => n === 2 ? okPage(page, { body: change(page.body as Array<Record<string, unknown>>) }) : undefined
  await fails(data, second((rows) => rows.map((r, i) => i === 2 ? { ...r, total: '12.51' } : r)), 'VENDOR_READ_UNSTABLE')
  await fails(data, second((rows) => rows.map((r, i) => i === 2 ? { ...r, currency: 'EUR' } : r)), 'VENDOR_READ_UNSTABLE')
  // IDENTITY SWAP: same count, same total, same page count, one identity replaced by another on the second read.
  await fails(data, second((rows) => rows.map((r, i) => i === 4 ? { ...r, id: 99 } : r)), 'VENDOR_READ_UNSTABLE')
  await fails(data, (_c, n, page) => n === 2 ? okPage(page, { total: '4', totalPages: '1', body: (page.body as unknown[]).slice(0, 4) }) : undefined, 'VENDOR_READ_UNSTABLE')
})

// [mutation: each field's validation removed in turn]
test('every field of every row is validated: nothing is dropped, repaired or coerced', async () => {
  const bad: Array<[string, Record<string, unknown>, string]> = [
    ['id as text', { id: '7' }, 'SOURCE_UNREADABLE'], ['id zero', { id: 0 }, 'SOURCE_UNREADABLE'], ['id negative', { id: -3 }, 'SOURCE_UNREADABLE'], ['id fractional', { id: 1.5 }, 'SOURCE_UNREADABLE'],
    ['id unsafe', { id: 2 ** 60 }, 'SOURCE_UNREADABLE'], ['id missing', { id: undefined }, 'SOURCE_UNREADABLE'],
    ['currency lower case', { currency: 'gbp' }, 'CURRENCY_UNKNOWN'], ['currency unknown', { currency: 'XXX' }, 'CURRENCY_UNKNOWN'], ['currency missing', { currency: undefined }, 'CURRENCY_UNKNOWN'],
    ['total a number', { total: 12.5 }, 'BAD_VALUE'], ['total exponent', { total: '1e3' }, 'BAD_VALUE'], ['total comma', { total: '1,000.00' }, 'BAD_VALUE'], ['total empty', { total: '' }, 'BAD_VALUE'],
    ['total negative', { total: '-1.00' }, 'BAD_VALUE'], ['total missing', { total: undefined }, 'BAD_VALUE'], ['total too precise', { total: '1.1234567890123' }, 'BAD_VALUE'],
    ['status another than asked', { status: 'completed' }, 'SOURCE_UNREADABLE'], ['status missing', { status: undefined }, 'SOURCE_UNREADABLE'], ['status a number', { status: 3 }, 'SOURCE_UNREADABLE'],
    ['date with a zone', { date_created_gmt: '2026-10-10T09:30:00Z' }, 'SOURCE_UNREADABLE'], ['date impossible', { date_created_gmt: '2026-02-30T09:30:00' }, 'SOURCE_UNREADABLE'], ['date a number', { date_created_gmt: 5 }, 'SOURCE_UNREADABLE'],
  ]
  for (const [, over, reason] of bad) await fails({ orders: { processing: [order(1), order(2, 'processing', over)] } }, undefined, reason)
  for (const row of [null, 7, 'x', [], [order(2)]]) await fails({ orders: { processing: [order(1)] } }, (_c, _n, page) => okPage(page, { body: [row] }), 'SOURCE_UNREADABLE')
  // A missing or null creation date is allowed: the order then has no instant (the item decides what that means), and `wc-` is the same status.
  const read = await readWooOrders(fakeStore({ orders: { processing: [order(1, 'processing', { date_created_gmt: null }), order(2, 'wc-processing', { date_created_gmt: undefined })] } }), ['processing'], opts)
  assert.ok(read.ok && read.value.orders.every((o) => o.createdAt === null && o.status === 'processing'))
  // Product and tax rows too.
  for (const row of [{ id: 1, sku: 5, status: 'publish', type: 'simple' }, { id: 1, sku: 'A', status: 'publish' }, { id: 0, sku: 'A', status: 'publish', type: 'simple' }, { id: 1, sku: 'A\nB', status: 'publish', type: 'simple' }]) {
    const read2 = await readWooProducts(fakeStore({ products: [row] }), opts)
    assert.ok(!read2.ok && read2.reason === 'SOURCE_UNREADABLE')
  }
  assert.equal((await readWooTaxRates(fakeStore({ taxes: [{ id: 'x' }] }), opts)).ok, false)
  assert.equal((await readWooTaxRates(fakeStore({ taxes: [{}] }), opts)).ok, false)
})

// [mutation: the row cap removed / the budget check removed]
test('a total above the cap is CAP_EXCEEDED, not a prefix; a run that exhausts its request budget is CAP_EXCEEDED, not a shorter list', async () => {
  await fails({ orders: { processing: many(30) } }, undefined, 'CAP_EXCEEDED', ['processing'], { ...opts, maxRows: 29, perPage: 10 })
  const exact = await readWooOrders(fakeStore({ orders: { processing: many(30) } }), ['processing'], { ...opts, maxRows: 30, perPage: 10 })
  assert.ok(exact.ok && exact.value.orders.length === 30)
  // 30 rows at 10 a page = 3 pages x 2 reads = 6 requests.
  await fails({ orders: { processing: many(30) } }, undefined, 'CAP_EXCEEDED', ['processing'], { ...opts, perPage: 10, budget: 5 })
  const enough = await readWooOrders(fakeStore({ orders: { processing: many(30) } }), ['processing'], { ...opts, perPage: 10, budget: 6 })
  assert.ok(enough.ok)
  // The budget is for the whole run, not per status.
  await fails({ orders: { processing: many(30), 'on-hold': many(1, 100, 'on-hold') } }, undefined, 'CAP_EXCEEDED', ['processing', 'on-hold'], { ...opts, perPage: 10, budget: 7 })
})

// [mutation: the pause removed]
test('requests are paced: the pause is taken before every request but the first', async () => {
  const pauses: number[] = []
  const store = fakeStore({ orders: { processing: many(250) } })
  const read = await readWooOrders(store, ['processing'], { sleep: async (ms) => { pauses.push(ms) } })
  assert.ok(read.ok)
  assert.equal(pauses.length, store.calls.length - 1)
  assert.ok(pauses.every((ms) => ms === WOO_MIN_REQUEST_INTERVAL_MS))
})

test('an empty store: all statuses zero on both reads is the named proof, no status enumerated is not', async () => {
  const empty = await readWooOrders(fakeStore({ orders: {} }), ['processing', 'on-hold'], opts)
  assert.ok(empty.ok && empty.value.allZero && empty.value.orders.length === 0)
  const none = await readWooOrders(fakeStore({ orders: {} }), [], opts)
  assert.ok(none.ok && none.value.allZero === false && none.value.totals.length === 0)
  // A zero on the first read and a row on the second is not empty.
  const lying = await readWooOrders(fakeStore({ orders: { processing: [] } }, (_c, n, page) => n === 2 ? okPage(page, { total: '1', totalPages: '1', body: [order(1)] }) : undefined), ['processing'], opts)
  assert.ok(!lying.ok && lying.reason === 'VENDOR_READ_UNSTABLE')
})

test('a status list that is not distinct closed slugs is refused before any request', async () => {
  for (const statuses of [['Processing'], ['a b'], ['processing', 'processing'], [''], ['x/y'], ['wc-processing\n']]) {
    const store = fakeStore({})
    const read = await readWooOrders(store, statuses, opts)
    assert.ok(!read.ok && read.reason === 'UNKNOWN_STATUS')
    assert.equal(store.calls.length, 0)
  }
})

test('nothing a failing store says is kept: the result is a closed reason and no text of the store\'s own', async () => {
  const read = await readWooOrders(fakeStore({ orders: { processing: many(2) } }, () => { throw new Error('hunter2 https://shop.example/?consumer_key=ck_abc') }), ['processing'], opts)
  assert.deepEqual(read, { ok: false, reason: 'SOURCE_UNREADABLE' })
})

// ---- THE DOUBLE SWEEP ---------------------------------------------------------------------------

type Mutable = { orders: Record<string, Array<Record<string, unknown>>> }
/** A store that changes when a given request is first/next made: `when` sees the request (and how many like it came before) and may move orders. */
function shifting(data: Mutable, when: (call: { status: string; page: string }, nth: number, data: Mutable) => void) {
  const inner = fakeStore(data)
  const counts = new Map<string, number>()
  return {
    calls: inner.calls,
    get: async (collection: Parameters<typeof inner.get>[0], params: Record<string, string>) => {
      const id = `${params.status}:${params.page}`
      const nth = (counts.get(id) ?? 0) + 1
      counts.set(id, nth)
      when({ status: params.status ?? '', page: params.page ?? '' }, nth, data)
      return inner.get(collection, params)
    },
  }
}
const move = (data: Mutable, id: number, from: string, to: string) => {
  const row = data.orders[from]!.find((r) => r.id === id)!
  data.orders[from] = data.orders[from]!.filter((r) => r !== row)
  data.orders[to] = [...(data.orders[to] ?? []), { ...row, status: to }]
}
const SWEEP_STATUSES = ['processing', 'on-hold']

// [mutation: the combined comparison skipped / the sweeps compared by count only]
test('SWEEP A: an order that moves from a later open status to an earlier one after the earlier status was read and before the later one is read is VENDOR_READ_UNSTABLE, never a list - and never an empty proof', async () => {
  const data: Mutable = { orders: { processing: [], 'on-hold': [order(5, 'on-hold')] } }
  // The first request for on-hold comes after processing was read (twice, in a per-status double read; once, in sweep A).
  const store = shifting(data, (call, nth, d) => { if (call.status === 'on-hold' && call.page === '1' && nth === 1) move(d, 5, 'on-hold', 'processing') })
  const read = await readWooOrders(store, SWEEP_STATUSES, opts)
  assert.deepEqual(read, { ok: false, reason: 'VENDOR_READ_UNSTABLE' })
})

test('SWEEP B: the same move during the second sweep (after its processing walk) is unstable too', async () => {
  const data: Mutable = { orders: { processing: [], 'on-hold': [order(5, 'on-hold')] } }
  const store = shifting(data, (call, nth, d) => { if (call.status === 'on-hold' && call.page === '1' && nth === 2) move(d, 5, 'on-hold', 'processing') })
  assert.deepEqual(await readWooOrders(store, SWEEP_STATUSES, opts), { ok: false, reason: 'VENDOR_READ_UNSTABLE' })
})

test('an order that is held between sweeps changing status (processing in A, on-hold in B) is unstable; a count-preserving swap is unstable', async () => {
  const data: Mutable = { orders: { processing: [order(5)], 'on-hold': [] } }
  const store = shifting(data, (call, nth, d) => { if (call.status === 'processing' && call.page === '1' && nth === 2) move(d, 5, 'processing', 'on-hold') })
  assert.deepEqual(await readWooOrders(store, SWEEP_STATUSES, opts), { ok: false, reason: 'VENDOR_READ_UNSTABLE' })
  // Same totals per status in both sweeps, one identity replaced by another.
  const swap: Mutable = { orders: { processing: [order(5)], 'on-hold': [] } }
  const swapped = shifting(swap, (call, nth, d) => { if (call.status === 'processing' && call.page === '1' && nth === 2) d.orders.processing = [order(6)] })
  assert.deepEqual(await readWooOrders(swapped, SWEEP_STATUSES, opts), { ok: false, reason: 'VENDOR_READ_UNSTABLE' })
  // A value changed in place between the sweeps.
  const value: Mutable = { orders: { processing: [order(5)], 'on-hold': [] } }
  const changed = shifting(value, (call, nth, d) => { if (call.status === 'processing' && call.page === '1' && nth === 2) d.orders.processing = [order(5, 'processing', { total: '99.00' })] })
  assert.deepEqual(await readWooOrders(changed, SWEEP_STATUSES, opts), { ok: false, reason: 'VENDOR_READ_UNSTABLE' })
})

test('a quiet store gives the same list from both sweeps, with the empty proof only if every status was zero in both', async () => {
  const quiet = await readWooOrders(fakeStore({ orders: { processing: [order(5)], 'on-hold': [order(6, 'on-hold')] } }), SWEEP_STATUSES, opts)
  assert.ok(quiet.ok && quiet.value.orders.map((o) => o.id).join() === '5,6' && !quiet.value.allZero)
  // Zero in sweep A, an order only in B: unstable, so no allZero to pass on.
  const data: Mutable = { orders: { processing: [], 'on-hold': [] } }
  const store = shifting(data, (call, nth, d) => { if (call.status === 'processing' && call.page === '1' && nth === 2) d.orders.processing = [order(7)] })
  assert.deepEqual(await readWooOrders(store, SWEEP_STATUSES, opts), { ok: false, reason: 'VENDOR_READ_UNSTABLE' })
})
