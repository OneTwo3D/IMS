import assert from 'node:assert/strict'
import test from 'node:test'

import { readWooOrderTaxes, readWooOrders } from '../../lib/reconciliation-pack/woo-source.ts'
import { noSleep, wooDouble, wooOrder, type WooTweak } from './vat-fixtures.ts'

/**
 * R12's WooCommerce read: the tax lines of the orders of a date window, as the proven double sweep. Mutations are named per test.
 */

const WINDOW = { after: '2026-07-30', before: '2026-10-03' }
const orders = { processing: [wooOrder(101, '2026-09-10T09:30:00', [[11, '60.00'], [12, '5.00']]), wooOrder(102, '2026-09-21T10:00:00', [[11, '40.00']])], completed: [wooOrder(103, '2026-08-12T10:00:00', [[11, '50.00']], { status: 'completed' })] }
const read = (double: ReturnType<typeof wooDouble>, statuses = ['processing', 'completed'], options: Parameters<typeof readWooOrderTaxes>[3] = {}) => readWooOrderTaxes(double, statuses, WINDOW, { sleep: noSleep, ...options })
const bodyOf = (page: { body: unknown }) => page.body as Array<Record<string, unknown>>

test('the tax lines of every order of every status, each status walked twice; only line tax is read, shipping tax never', async () => {
  const double = wooDouble(orders)
  const result = await read(double)
  assert.ok(result.ok)
  assert.deepEqual(result.value.orders.map((o) => [o.id, o.createdAt, o.taxes, o.feeTaxLines]), [
    ['101', '2026-09-10T09:30:00.000Z', [{ rateId: '11', tax: '60' }, { rateId: '12', tax: '5' }], 0],
    ['102', '2026-09-21T10:00:00.000Z', [{ rateId: '11', tax: '40' }], 0],
    ['103', '2026-08-12T10:00:00.000Z', [{ rateId: '11', tax: '50' }], 0],
  ])
  assert.deepEqual(result.value.totals, [{ status: 'processing', total: 2 }, { status: 'completed', total: 1 }])
  assert.equal(double.calls.length, 4)
  for (const call of double.calls) {
    assert.equal(call.params._fields, 'id,status,currency,date_created_gmt,tax_lines,fee_lines')
    assert.deepEqual([call.params.after, call.params.before], [WINDOW.after, WINDOW.before])
    assert.ok(!JSON.stringify(call.params).includes('shipping'))
  }
  assert.ok(JSON.stringify(result).indexOf('99.00') === -1, "the double's shipping_tax_total (99.00) is not carried")
  // The ordinary order walk is unchanged by the generalisation: it still asks for its own fields and no date.
  const plain = wooDouble({ processing: [{ id: 1, status: 'processing', currency: 'GBP', total: '1.00', date_created_gmt: '2026-09-10T09:30:00' }] })
  assert.ok((await readWooOrders(plain, ['processing'], { sleep: noSleep })).ok)
  assert.ok(plain.calls.every((c) => c.params._fields === 'id,status,currency,total,date_created_gmt' && c.params.after === undefined))
})

// [mutation: lines of one rate merged in the reader]
test('EVERY TAX LINE STAYS A LINE: two lines of one rate (even +x and -x) are carried separately, in the store\'s order, never merged', async () => {
  const double = wooDouble({ processing: [wooOrder(1, '2026-09-10T09:30:00', [[12, '1.10'], [11, '2.20'], [12, '-1.10']])] })
  const result = await read(double, ['processing'])
  assert.ok(result.ok)
  assert.deepEqual(result.value.orders[0]!.taxes, [{ rateId: '12', tax: '1.1' }, { rateId: '11', tax: '2.2' }, { rateId: '12', tax: '-1.1' }])
})

// [mutation: the second sweep removed / compared by count]
test('THE SECOND SWEEP MUST EQUAL THE FIRST: a tax figure that changed, an order that moved to another status between the sweeps, is VENDOR_READ_UNSTABLE', async () => {
  const changed: WooTweak = (call, n, page) => (n > 2 && call.params.status === 'processing' ? { ...page, body: bodyOf(page).map((row, i) => (i === 0 ? wooOrder(Number(row.id), '2026-09-10T09:30:00', [[11, '61.00'], [12, '5.00']]) : row)) } : undefined)
  assert.deepEqual(await read(wooDouble(orders, changed)), { ok: false, reason: 'VENDOR_READ_UNSTABLE' })
  let moved = false
  const switching: WooTweak = (call, n, page) => {
    if (n <= 2 || call.params.status !== 'completed') return undefined
    moved = true
    return { ...page, total: '0', totalPages: '0', body: [] }
  }
  assert.deepEqual(await read(wooDouble(orders, switching)), { ok: false, reason: 'VENDOR_READ_UNSTABLE' })
  assert.ok(moved)
})

// [mutation: the per-row validation loosened]
test('EVERY ORDER IS VALIDATED: no date, a bad date, an unknown currency, a tax line without a rate or with a bad total, or an order in another status is refused whole', async () => {
  const bad = (change: Record<string, unknown>) => read(wooDouble({ processing: [wooOrder(1, '2026-09-10T09:30:00', [[11, '1.00']], change)] }), ['processing'])
  assert.deepEqual(await bad({ date_created_gmt: undefined }), { ok: false, reason: 'SOURCE_UNREADABLE' })
  assert.deepEqual(await bad({ date_created_gmt: null }), { ok: false, reason: 'SOURCE_UNREADABLE' })
  assert.deepEqual(await bad({ date_created_gmt: '2026-09-10' }), { ok: false, reason: 'SOURCE_UNREADABLE' })
  assert.deepEqual(await bad({ date_created_gmt: '2026-02-30T00:00:00' }), { ok: false, reason: 'SOURCE_UNREADABLE' })
  assert.deepEqual(await bad({ currency: 'XXX' }), { ok: false, reason: 'CURRENCY_UNKNOWN' })
  assert.deepEqual(await bad({ tax_lines: undefined }), { ok: false, reason: 'SOURCE_UNREADABLE' })
  assert.deepEqual(await bad({ tax_lines: {} }), { ok: false, reason: 'SOURCE_UNREADABLE' })
  assert.deepEqual(await bad({ tax_lines: [{ tax_total: '1.00' }] }), { ok: false, reason: 'SOURCE_UNREADABLE' })
  assert.deepEqual(await bad({ tax_lines: [{ rate_id: 0, tax_total: '1.00' }] }), { ok: false, reason: 'SOURCE_UNREADABLE' })
  assert.deepEqual(await bad({ tax_lines: [{ rate_id: 11, tax_total: 1 }] }), { ok: false, reason: 'BAD_VALUE' })
  assert.deepEqual(await bad({ tax_lines: [{ rate_id: 11, tax_total: '1,00' }] }), { ok: false, reason: 'BAD_VALUE' })
  assert.deepEqual(await bad({ tax_lines: [{ rate_id: 11, tax_total: '' }] }), { ok: false, reason: 'BAD_VALUE' })
  assert.deepEqual(await bad({ fee_lines: undefined }), { ok: false, reason: 'SOURCE_UNREADABLE' })
  assert.deepEqual(await bad({ fee_lines: {} }), { ok: false, reason: 'SOURCE_UNREADABLE' })
  assert.deepEqual(await bad({ fee_lines: [{ total_tax: 1 }] }), { ok: false, reason: 'BAD_VALUE' })
  assert.deepEqual(await bad({ fee_lines: [{}] }), { ok: false, reason: 'BAD_VALUE' })
  const fees = await bad({ fee_lines: [{ total_tax: '0.00' }, { total_tax: '1.20' }, { total_tax: '-1.20' }] })
  assert.ok(fees.ok && fees.value.orders[0]!.feeTaxLines === 2, 'fee lines with a non-zero tax are counted one by one, never netted')
  assert.deepEqual(await bad({ status: 'completed' }), { ok: false, reason: 'SOURCE_UNREADABLE' }, 'asked for processing, got completed')
  const ok = await bad({})
  assert.ok(ok.ok)
  const none = await bad({ tax_lines: [] })
  assert.ok(none.ok && none.value.orders[0]!.taxes.length === 0)
})

// [mutation: the budget not decremented]
test('THE BUDGET IS HARD and every status is a walk of its own: the request over the budget is not made, CAP_EXCEEDED, no list', async () => {
  for (const budget of [0, 1, 3]) {
    const double = wooDouble(orders)
    assert.deepEqual(await read(double, ['processing', 'completed'], { budget }), { ok: false, reason: 'CAP_EXCEEDED' }, String(budget))
    assert.equal(double.calls.length, budget)
  }
  assert.ok((await read(wooDouble(orders), ['processing', 'completed'], { budget: 4 })).ok)
})

test('the statuses and the window are validated before any request', async () => {
  const double = wooDouble(orders)
  const call = (statuses: string[], window: { after: string; before: string }) => readWooOrderTaxes(double, statuses, window, { sleep: noSleep })
  assert.deepEqual(await call([], WINDOW), { ok: false, reason: 'UNKNOWN_STATUS' })
  assert.deepEqual(await call(['processing', 'processing'], WINDOW), { ok: false, reason: 'UNKNOWN_STATUS' })
  assert.deepEqual(await call(['Processing'], WINDOW), { ok: false, reason: 'UNKNOWN_STATUS' })
  assert.deepEqual(await call(['processing'], { after: '2026-10-03', before: '2026-10-03' }), { ok: false, reason: 'BAD_MODE' })
  assert.deepEqual(await call(['processing'], { after: '2026-10-03T00:00:00', before: '2026-10-04' }), { ok: false, reason: 'BAD_MODE' })
  assert.equal(double.calls.length, 0)
})
