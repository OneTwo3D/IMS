import assert from 'node:assert/strict'
import test from 'node:test'

import { XERO_MIN_REQUEST_INTERVAL_MS } from '../../lib/reconciliation-pack/constants.ts'
import { makeXeroWalker, readXeroBaseCurrency, readXeroInvoices, xeroInvoiceWhere, type XeroWalkWindow } from '../../lib/reconciliation-pack/xero-source.ts'
import { invoice, noSleep, uuid, xeroDouble, type XeroTweak } from './vat-fixtures.ts'

/**
 * THE XERO INVOICE WALK: what a read proves. Every refusal is a closed reason and NO list. Mutations are named per test.
 */

const WINDOW: XeroWalkWindow = { from: '2026-07-31', toExclusive: '2026-10-02' }
const line = [{ type: 'OUTPUT2', tax: 20 }]
const five = [1, 2, 3, 4, 5].map((n) => invoice(n, '2026-09-10', line))
const walk = (double: ReturnType<typeof xeroDouble>, options: Parameters<typeof makeXeroWalker>[1] = {}) => readXeroInvoices(makeXeroWalker(double, { sleep: noSleep, ...options }), WINDOW)
const body = (page: { body: unknown }) => page.body as { Invoices: Array<Record<string, unknown>>; pagination: Record<string, number> }

test('a faithful multi-page walk returns every invoice, normalised, once, after reading the whole walk twice', async () => {
  const double = xeroDouble(five, { pageSize: 2 })
  const read = await walk(double)
  assert.ok(read.ok)
  assert.equal(read.value.total, 5)
  assert.deepEqual(read.value.invoices.map((i) => i.id).sort(), [1, 2, 3, 4, 5].map(uuid).sort())
  assert.deepEqual(read.value.invoices[0], { id: read.value.invoices[0]!.id, date: '2026-09-10', currency: 'GBP', rate: '1', lines: [{ taxType: 'OUTPUT2', taxAmount: '20', accountCode: '200' }] })
  assert.equal(double.calls.length, 6, 'three pages, read twice')
  assert.deepEqual(double.calls.map((c) => c.params.page), ['1', '2', '3', '1', '2', '3'])
})

test('the where text is the one fixed shape, with the window dates as plain numbers', () => {
  assert.equal(xeroInvoiceWhere(WINDOW), 'Type=="ACCREC" AND Date>=DateTime(2026, 7, 31) AND Date<DateTime(2026, 10, 2)')
})

// [mutation: the pagination object not required / defaulted from the body length]
test('NO PAGINATION OBJECT PROVES NOTHING: a body without it, or with a malformed one, is SOURCE_UNREADABLE and no list (U7: the page size is never assumed)', async () => {
  const cases: Array<[string, XeroTweak]> = [
    ['absent', (_c, _n, p) => ({ ...p, body: { Invoices: body(p).Invoices } })],
    ['not an object', (_c, _n, p) => ({ ...p, body: { Invoices: body(p).Invoices, pagination: 5 } })],
    ['a string count', (_c, _n, p) => ({ ...p, body: { ...body(p), pagination: { ...body(p).pagination, itemCount: '5' } } })],
    ['a fractional size', (_c, _n, p) => ({ ...p, body: { ...body(p), pagination: { ...body(p).pagination, pageSize: 2.5 } } })],
    ['a zero size', (_c, _n, p) => ({ ...p, body: { ...body(p), pagination: { ...body(p).pagination, pageSize: 0 } } })],
    ['a size over the bound', (_c, _n, p) => ({ ...p, body: { ...body(p), pagination: { ...body(p).pagination, pageSize: 5000 } } })],
    ['a negative count', (_c, _n, p) => ({ ...p, body: { ...body(p), pagination: { ...body(p).pagination, itemCount: -1 } } })],
    ['no invoice list', (_c, _n, p) => ({ ...p, body: { pagination: body(p).pagination } })],
    ['a list that is an object', (_c, _n, p) => ({ ...p, body: { Invoices: {}, pagination: body(p).pagination } })],
  ]
  for (const [name, tweak] of cases) {
    const read = await walk(xeroDouble(five, { pageSize: 2, tweak }))
    assert.deepEqual(read, { ok: false, reason: 'SOURCE_UNREADABLE' }, name)
  }
})

// [mutation: any one of the consistency checks removed]
test('INCONSISTENT PAGINATION is VENDOR_READ_UNSTABLE: a wrong page number, a page count that is not ceil(count/size), pages that disagree, a short page, a long page, a missing last page', async () => {
  const at = (n: number, change: (p: ReturnType<typeof body>) => unknown): XeroTweak => (call, i, page) => (call.resource === 'Invoices' && i === n ? { ...page, body: change(body(page)) } : undefined)
  // call 1 is the organisation? no: the walker here is used directly, so call 1 is page 1 of sweep A.
  const cases: Array<[string, XeroTweak]> = [
    ['page number', at(2, (b) => ({ ...b, pagination: { ...b.pagination, page: 3 } }))],
    ['page count too small on page 1', at(1, (b) => ({ ...b, pagination: { ...b.pagination, pageCount: 2 } }))],
    ['page count too large on page 1', at(1, (b) => ({ ...b, pagination: { ...b.pagination, pageCount: 4 } }))],
    ['item count changes on page 2', at(2, (b) => ({ ...b, pagination: { ...b.pagination, itemCount: 6 } }))],
    ['page size changes on page 2', at(2, (b) => ({ ...b, pagination: { ...b.pagination, pageSize: 3 } }))],
    ['page count changes on page 2', at(2, (b) => ({ ...b, pagination: { ...b.pagination, pageCount: 4 } }))],
    ['a short middle page', at(2, (b) => ({ ...b, Invoices: b.Invoices.slice(0, 1) }))],
    ['a long page', at(1, (b) => ({ ...b, Invoices: [...b.Invoices, invoice(77, '2026-09-10', line)] }))],
    ['a short last page', at(3, (b) => ({ ...b, Invoices: [] }))],
    ['a last page with extra rows', at(3, (b) => ({ ...b, Invoices: [...b.Invoices, invoice(78, '2026-09-10', line)] }))],
  ]
  // The SAME fault in BOTH scans, so the second scan cannot be what catches it: the page's own length and the rows-against-count check must.
  const everyTime = (page: number, change: (p: ReturnType<typeof body>) => unknown): XeroTweak => (call, _n, p) => (call.resource === 'Invoices' && Number(call.params.page) === page ? { ...p, body: change(body(p)) } : undefined)
  cases.push(
    ['a short middle page, every scan', everyTime(2, (b) => ({ ...b, Invoices: b.Invoices.slice(0, 1) }))],
    ['a long middle page, every scan', everyTime(2, (b) => ({ ...b, Invoices: [...b.Invoices, invoice(60, '2026-09-10', line)] }))],
    ['a short last page, every scan', everyTime(3, (b) => ({ ...b, Invoices: [] }))],
    ['a last page with a different invoice, every scan (count right, one invoice never seen)', everyTime(3, (b) => ({ ...b, Invoices: [invoice(2, '2026-09-10', line)] }))],
  )
  for (const [name, tweak] of cases) {
    const read = await walk(xeroDouble(five, { pageSize: 2, tweak }))
    assert.deepEqual(read, { ok: false, reason: 'VENDOR_READ_UNSTABLE' }, name)
  }
})

// [mutation: the repeated-row check removed]
test('A REPEATED INVOICE is VENDOR_READ_UNSTABLE even when every count adds up (a service that ignores the page)', async () => {
  // Page 2 answers with page 1's rows again: the lengths and counts are right, the invoices are not new.
  const ignoresPage: XeroTweak = (call, _n, page) => (call.resource === 'Invoices' && Number(call.params.page) === 2 ? { ...page, body: { ...body(page), Invoices: [invoice(1, '2026-09-10', line), invoice(2, '2026-09-10', line)] } } : undefined)
  const read = await walk(xeroDouble(five, { pageSize: 2, tweak: ignoresPage }))
  assert.deepEqual(read, { ok: false, reason: 'VENDOR_READ_UNSTABLE' })
})

// [mutation: the second scan removed or compared by count only]
test('THE SECOND SCAN MUST EQUAL THE FIRST: an invoice added, changed in value, or swapped between the scans is VENDOR_READ_UNSTABLE', async () => {
  const sweepB = (change: (rows: Array<Record<string, unknown>>) => Array<Record<string, unknown>>, newCount?: number): XeroTweak => (call, n, page) => {
    if (call.resource !== 'Invoices' || n < 2) return undefined
    const rows = change(body(page).Invoices)
    return { ...page, body: { Invoices: rows, pagination: { ...body(page).pagination, itemCount: newCount ?? body(page).pagination.itemCount } } }
  }
  const one = [1, 2, 3].map((n) => invoice(n, '2026-09-10', line))
  const cases: Array<[string, XeroTweak]> = [
    ['a value changed', sweepB((rows) => rows.map((row, i) => (i === 0 ? { ...row, LineItems: [{ TaxType: 'OUTPUT2', TaxAmount: 21 }] } : row)))],
    ['an invoice swapped for another', sweepB((rows) => rows.map((row, i) => (i === 0 ? { ...row, InvoiceID: uuid(99) } : row)))],
    ['a date changed', sweepB((rows) => rows.map((row, i) => (i === 0 ? { ...row, DateString: '2026-09-11T00:00:00' } : row)))],
    ['a line added', sweepB((rows) => rows.map((row, i) => (i === 0 ? { ...row, LineItems: [...(row.LineItems as unknown[]), { TaxType: 'OUTPUT2', TaxAmount: 0 }] } : row)))],
  ]
  for (const [name, tweak] of cases) assert.deepEqual(await walk(xeroDouble(one, { pageSize: 100, tweak })), { ok: false, reason: 'VENDOR_READ_UNSTABLE' }, name)
  // A second scan with a different count is caught by its own consistency or by the comparison; either way no list.
  const grown = await walk(xeroDouble(one, { pageSize: 100, tweak: sweepB((rows) => [...rows, invoice(50, '2026-09-10', line)], 4) }))
  assert.equal(grown.ok, false)
})

// [mutation: the per-invoice validation loosened]
test('EVERY INVOICE IS VALIDATED: a row that is not what was asked for is SOURCE_UNREADABLE, never dropped or repaired', async () => {
  const bad = (change: Record<string, unknown>) => walk(xeroDouble([invoice(1, '2026-09-10', line, change)]))
  const reason = (name: string, change: Record<string, unknown>, expected: string) => bad(change).then((read) => assert.deepEqual(read, { ok: false, reason: expected }, name))
  await reason('a credit note type', { Type: 'ACCPAY' }, 'SOURCE_UNREADABLE')
  await reason('a draft', { Status: 'DRAFT' }, 'SOURCE_UNREADABLE')
  await reason('a voided invoice', { Status: 'VOIDED' }, 'SOURCE_UNREADABLE')
  await reason('an id that is not a uuid', { InvoiceID: 'abc' }, 'SOURCE_UNREADABLE')
  await reason('no date string', { DateString: undefined }, 'SOURCE_UNREADABLE')
  await reason('a date with a time', { DateString: '2026-09-10T10:00:00' }, 'SOURCE_UNREADABLE')
  await reason('an impossible date', { DateString: '2026-02-30T00:00:00' }, 'SOURCE_UNREADABLE')
  await reason('a date before the window', { DateString: '2026-07-30T00:00:00' }, 'SOURCE_UNREADABLE')
  await reason('a date on the exclusive end', { DateString: '2026-10-02T00:00:00' }, 'SOURCE_UNREADABLE')
  await reason('an unknown currency', { CurrencyCode: 'XXX' }, 'CURRENCY_UNKNOWN')
  await reason('a foreign invoice with no rate', { CurrencyCode: 'EUR', CurrencyRate: undefined }, 'CURRENCY_UNKNOWN')
  await reason('a zero rate', { CurrencyCode: 'EUR', CurrencyRate: 0 }, 'BAD_VALUE')
  await reason('a GBP invoice with a rate', { CurrencyRate: 1.1 }, 'BAD_VALUE')
  await reason('no lines', { LineItems: undefined }, 'SOURCE_UNREADABLE')
  await reason('a line that is not an object', { LineItems: [5] }, 'SOURCE_UNREADABLE')
  await reason('a tax type with a space', { LineItems: [{ TaxType: 'OUT PUT', TaxAmount: 1 }] }, 'SOURCE_UNREADABLE')
  await reason('a tax amount as text', { LineItems: [{ TaxType: 'OUTPUT2', TaxAmount: '1.00' }] }, 'BAD_VALUE')
  await reason('a tax amount of NaN', { LineItems: [{ TaxType: 'OUTPUT2', TaxAmount: Number.NaN }] }, 'BAD_VALUE')
  await reason('a tax amount with seven places', { LineItems: [{ TaxType: 'OUTPUT2', TaxAmount: 0.1234567 }] }, 'BAD_VALUE')
  await reason('an account code with a space', { LineItems: [{ TaxType: 'OUTPUT2', TaxAmount: 1, AccountCode: '2 60' }] }, 'SOURCE_UNREADABLE')
  assert.ok((await bad({})).ok, 'the unmodified row is accepted')
})

test('a transport failure, a non-200 answer or a throwing port on any request is SOURCE_UNREADABLE', async () => {
  const fail: XeroTweak = (_c, n) => (n === 2 ? { ok: false } : undefined)
  assert.deepEqual(await walk(xeroDouble(five, { pageSize: 2, tweak: fail })), { ok: false, reason: 'SOURCE_UNREADABLE' })
  const non200: XeroTweak = (_c, n, page) => (n === 1 ? { ...page, status: 429 } : undefined)
  assert.deepEqual(await walk(xeroDouble(five, { tweak: non200 })), { ok: false, reason: 'SOURCE_UNREADABLE' })
  const throwing = { get: async () => { throw new Error('boom') } }
  assert.deepEqual(await readXeroInvoices(makeXeroWalker(throwing, { sleep: noSleep }), WINDOW), { ok: false, reason: 'SOURCE_UNREADABLE' })
  const notObject = { get: async () => ({ ok: true as const, status: 200, body: [] }) }
  assert.deepEqual(await readXeroInvoices(makeXeroWalker(notObject, { sleep: noSleep }), WINDOW), { ok: false, reason: 'SOURCE_UNREADABLE' })
})

// [mutation: the budget not decremented / checked after the request]
test('THE BUDGET IS HARD: the request that would exceed it is not made, and the answer is CAP_EXCEEDED with no list', async () => {
  for (const budget of [0, 1, 2, 3, 4, 5]) {
    const double = xeroDouble(five, { pageSize: 2 })
    const read = await walk(double, { budget })
    assert.deepEqual(read, { ok: false, reason: 'CAP_EXCEEDED' }, String(budget))
    assert.equal(double.calls.length, budget, 'exactly the budget was spent, never one more')
  }
  assert.ok((await walk(xeroDouble(five, { pageSize: 2 }), { budget: 6 })).ok)
  const rows = xeroDouble(five, { pageSize: 2 })
  assert.deepEqual(await walk(rows, { maxRows: 4 }), { ok: false, reason: 'CAP_EXCEEDED' })
  assert.equal(rows.calls.length, 1, 'the item count above the cap stops the walk at page 1')
})

test('PACING: every request after the first waits the minimum interval first', async () => {
  const waits: number[] = []
  const double = xeroDouble(five, { pageSize: 2 })
  assert.ok((await readXeroInvoices(makeXeroWalker(double, { sleep: async (ms) => { waits.push(ms); assert.equal(double.calls.length, waits.length, 'the pause comes before the next request') } }), WINDOW)).ok)
  assert.deepEqual(waits, [1, 2, 3, 4, 5].map(() => XERO_MIN_REQUEST_INTERVAL_MS))
})

test('an empty result is read as a proven zero (page count 0 or 1), and a window that is not a window is refused before any request', async () => {
  for (const pageCount of [0, 1]) {
    const double = xeroDouble([], { tweak: (_c, _n, page) => ({ ...page, body: { Invoices: [], pagination: { page: 1, pageSize: 100, pageCount, itemCount: 0 } } }) })
    const read = await walk(double)
    assert.ok(read.ok && read.value.total === 0 && read.value.invoices.length === 0, String(pageCount))
  }
  const double = xeroDouble([])
  for (const window of [{ from: '2026-10-02', toExclusive: '2026-10-02' }, { from: '2026-10-03', toExclusive: '2026-10-02' }, { from: '2026-13-01', toExclusive: '2026-14-02' }, { from: 'x', toExclusive: 'y' }]) {
    assert.deepEqual(await readXeroInvoices(makeXeroWalker(double, { sleep: noSleep }), window), { ok: false, reason: 'BAD_MODE' })
  }
  assert.equal(double.calls.length, 0)
  assert.deepEqual(await walk(xeroDouble([], { tweak: (_c, _n, page) => ({ ...page, body: { Invoices: [], pagination: { page: 1, pageSize: 100, pageCount: 2, itemCount: 0 } } }) })), { ok: false, reason: 'VENDOR_READ_UNSTABLE' })
})

test('THE ORGANISATION READ: exactly one organisation with a known base currency, else a closed reason', async () => {
  const one = await readXeroBaseCurrency(makeXeroWalker(xeroDouble([]), { sleep: noSleep }))
  assert.deepEqual(one, { ok: true, value: 'GBP' })
  const body = (b: unknown) => ({ get: async () => ({ ok: true as const, status: 200, body: b }) })
  assert.deepEqual(await readXeroBaseCurrency(makeXeroWalker(body({ Organisations: [] }))), { ok: false, reason: 'SOURCE_UNREADABLE' })
  assert.deepEqual(await readXeroBaseCurrency(makeXeroWalker(body({ Organisations: [{ BaseCurrency: 'GBP' }, { BaseCurrency: 'GBP' }] }))), { ok: false, reason: 'SOURCE_UNREADABLE' })
  assert.deepEqual(await readXeroBaseCurrency(makeXeroWalker(body({ Organisations: [{}] }))), { ok: false, reason: 'CURRENCY_UNKNOWN' })
  assert.deepEqual(await readXeroBaseCurrency(makeXeroWalker(body({ Organisations: [{ BaseCurrency: 'gbp' }] }))), { ok: false, reason: 'CURRENCY_UNKNOWN' })
  assert.deepEqual(await readXeroBaseCurrency(makeXeroWalker(body({ Organisations: [{ BaseCurrency: 'GBP' }] }), { budget: 0 })), { ok: false, reason: 'CAP_EXCEEDED' })
})
