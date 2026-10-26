import assert from 'node:assert/strict'
import test from 'node:test'

import { makeXeroWalker, type XeroWalkWindow } from '../../lib/reconciliation-pack/xero-source.ts'
import { readXeroRateDocuments, xeroDateWhere } from '../../lib/reconciliation-pack/xero-rate-source.ts'
import { creditNoteRow, invoiceRow, noSleep, paymentRow, rateDouble, uuid, type RateDouble, type XeroTweak } from './xero-rate-fixtures.ts'

/**
 * THE XERO RATE SOURCE: what a read of the three lists proves. Every refusal is a closed reason and NO list. The faults are injected into EVERY scan
 * (so the second scan cannot be what catches them) and into each of the three lists (each has its own row shape). Mutations are listed in the PR.
 */

const WINDOW: XeroWalkWindow = { from: '2026-07-31', toExclusive: '2026-10-02' }
const SEP = '2026-09-10'
type Json = Record<string, unknown>
type Kind = 'Invoices' | 'CreditNotes' | 'Payments'
const rows = (kind: Kind): Json[] => [1, 2, 3, 4, 5].map((n) => (kind === 'Invoices' ? invoiceRow({ n, date: SEP, currency: 'EUR', rate: 0.8 }) : kind === 'CreditNotes' ? creditNoteRow({ n: n + 10, date: SEP, currency: 'EUR', rate: 0.8 }) : paymentRow({ n: n + 20, date: SEP, currency: 'EUR', rate: 0.8 })))
const lists = (kind: Kind) => ({ invoices: kind === 'Invoices' ? rows(kind) : [], creditNotes: kind === 'CreditNotes' ? rows(kind) : [], payments: kind === 'Payments' ? rows(kind) : [] })
const walk = (double: RateDouble, options: Parameters<typeof makeXeroWalker>[1] = {}) => readXeroRateDocuments(makeXeroWalker(double, { sleep: noSleep, ...options }), WINDOW)
const body = (page: { body: unknown }) => page.body as Record<string, unknown> & { pagination: Record<string, number> }
const KINDS: Kind[] = ['Invoices', 'CreditNotes', 'Payments']

test('a faithful multi-page walk of each list returns every row once, after reading each list twice', async () => {
  for (const kind of KINDS) {
    const double = rateDouble(lists(kind), { pageSize: 2 })
    const read = await walk(double)
    assert.ok(read.ok, kind)
    assert.equal(read.value.documents.length, 5, kind)
    assert.equal(new Set(read.value.documents.map((d) => d.id)).size, 5, kind)
    assert.deepEqual(read.value.totals, { invoices: kind === 'Invoices' ? 5 : 0, creditNotes: kind === 'CreditNotes' ? 5 : 0, payments: kind === 'Payments' ? 5 : 0 })
    const own = double.calls.filter((c) => c.resource === kind)
    assert.deepEqual(own.map((c) => c.params.page), ['1', '2', '3', '1', '2', '3'], `${kind}: three pages, read twice`)
    assert.equal(double.calls.length, own.length + 4, 'the other two lists are read twice each, empty')
  }
})

test('the where text is the one fixed shape for every list, with the window dates as plain numbers', () => {
  assert.equal(xeroDateWhere(WINDOW), 'Date>=DateTime(2026, 7, 31) AND Date<DateTime(2026, 10, 2)')
})

// [mutation: the page-number check removed]
test('A PAGE THAT REPORTS ANOTHER PAGE NUMBER than the one asked is VENDOR_READ_UNSTABLE, in every scan of every list', async () => {
  for (const kind of KINDS) {
    const tweak: XeroTweak = (call, _n, page) => (call.resource === kind && call.params.page === '2' ? { ...page, body: { ...body(page), pagination: { ...body(page).pagination, page: 3 } } } : undefined)
    assert.deepEqual(await walk(rateDouble(lists(kind), { pageSize: 2, tweak })), { ok: false, reason: 'VENDOR_READ_UNSTABLE' }, kind)
  }
})

// [mutation: the whole pagination-consistency rule removed (count against size, pages agreeing, page lengths, rows against the count)]
test('INCONSISTENT PAGINATION is VENDOR_READ_UNSTABLE: a wrong page count, pages that disagree, a short page, a long page, a missing or surplus last page', async () => {
  const everyTime = (kind: Kind, page: number, change: (b: ReturnType<typeof body>) => unknown): XeroTweak => (call, _n, p) => (call.resource === kind && Number(call.params.page) === page ? { ...p, body: change(body(p)) } as typeof p : undefined)
  const everyPage = (kind: Kind, change: (b: ReturnType<typeof body>) => unknown): XeroTweak => (call, _n, p) => (call.resource === kind ? { ...p, body: change(body(p)) } as typeof p : undefined)
  for (const kind of KINDS) {
    const list = (b: ReturnType<typeof body>) => b[kind] as unknown[]
    const extra = kind === 'Invoices' ? invoiceRow({ n: 77, date: SEP, currency: 'EUR', rate: 0.8 }) : kind === 'CreditNotes' ? creditNoteRow({ n: 77, date: SEP, currency: 'EUR', rate: 0.8 }) : paymentRow({ n: 77, date: SEP, currency: 'EUR', rate: 0.8 })
    const cases: Array<[string, XeroTweak]> = [
      ['page count too large, on every page', everyPage(kind, (b) => ({ ...b, pagination: { ...b.pagination, pageCount: 4 } }))],
      ['page count too small, on every page', everyPage(kind, (b) => ({ ...b, pagination: { ...b.pagination, pageCount: 2 } }))],
      ['item count changes on page 2', everyTime(kind, 2, (b) => ({ ...b, pagination: { ...b.pagination, itemCount: 6 } }))],
      ['page size changes on page 2', everyTime(kind, 2, (b) => ({ ...b, pagination: { ...b.pagination, pageSize: 3 } }))],
      ['page count changes on page 2', everyTime(kind, 2, (b) => ({ ...b, pagination: { ...b.pagination, pageCount: 4 } }))],
      ['a short middle page', everyTime(kind, 2, (b) => ({ ...b, [kind]: list(b).slice(0, 1) }))],
      ['a long middle page', everyTime(kind, 2, (b) => ({ ...b, [kind]: [...list(b), extra] }))],
      ['a short last page', everyTime(kind, 3, (b) => ({ ...b, [kind]: [] }))],
      ['a last page with a surplus row', everyTime(kind, 3, (b) => ({ ...b, [kind]: [...list(b), extra] }))],
    ]
    for (const [name, tweak] of cases) assert.deepEqual(await walk(rateDouble(lists(kind), { pageSize: 2, tweak })), { ok: false, reason: 'VENDOR_READ_UNSTABLE' }, `${kind}: ${name}`)
  }
})

// [mutation: the repeated-identity check removed]
test('A ROW THAT REPEATS ACROSS PAGES is VENDOR_READ_UNSTABLE even when every count is right (one row is then never seen)', async () => {
  for (const kind of KINDS) {
    let first: unknown
    const tweak: XeroTweak = (call, _n, page) => {
      if (call.resource !== kind) return undefined
      const list = body(page)[kind] as unknown[]
      if (call.params.page === '1') first = list[0]
      if (call.params.page === '2') return { ...page, body: { ...body(page), [kind]: [first, list[1]] } }
      return undefined
    }
    assert.deepEqual(await walk(rateDouble(lists(kind), { pageSize: 2, tweak })), { ok: false, reason: 'VENDOR_READ_UNSTABLE' }, kind)
  }
})

// [mutation: the status check of a payment removed]
test('A PAYMENT IN A STATUS THAT IS NEITHER AUTHORISED NOR DELETED is SOURCE_UNREADABLE for the whole list, and a deleted one is read and set aside', async () => {
  const bad = rateDouble({ payments: [paymentRow({ n: 1, date: SEP, currency: 'EUR', rate: 0.8, status: 'PENDING' })] })
  assert.deepEqual(await walk(bad), { ok: false, reason: 'SOURCE_UNREADABLE' })
  const deleted = rateDouble({ payments: [paymentRow({ n: 1, date: SEP, currency: 'EUR', rate: 0.8 }), paymentRow({ n: 2, date: SEP, currency: 'EUR', rate: 0.1, status: 'DELETED' })] })
  const read = await walk(deleted)
  assert.ok(read.ok)
  assert.deepEqual(read.value.documents.map((d) => d.id), [uuid(1)])
  assert.equal(read.value.deletedPayments, 1)
  assert.equal(read.value.totals.payments, 2, 'the total Xero reported counts the deleted one')
})

test('what a readable row carries: its kind, date, currency and rate as Xero gave them, and an absent rate as null', async () => {
  const read = await walk(rateDouble({
    invoices: [invoiceRow({ n: 1, date: SEP, currency: 'EUR', rate: 0.8 }), invoiceRow({ n: 2, date: SEP, currency: 'EUR', rate: null, type: 'ACCPAY' })],
    creditNotes: [creditNoteRow({ n: 3, date: SEP, currency: 'USD', rate: 0.76923, type: 'ACCPAYCREDIT' })],
    payments: [paymentRow({ n: 4, date: SEP, currency: 'EUR', rate: 0.8, holder: 'CreditNote' })],
  }))
  assert.ok(read.ok)
  assert.deepEqual(read.value.documents, [
    { readable: true, kind: 'sales-invoice', id: uuid(1), date: SEP, currency: 'EUR', rate: '0.8' },
    { readable: true, kind: 'purchase-bill', id: uuid(2), date: SEP, currency: 'EUR', rate: null },
    { readable: true, kind: 'purchase-cn', id: uuid(3), date: SEP, currency: 'USD', rate: '0.76923' },
    { readable: true, kind: 'payment', id: uuid(4), date: SEP, currency: 'EUR', rate: '0.8' },
  ])
  // A rate with more than twelve places or a string is not a rate.
  for (const rate of [0.1234567890123, '0.8']) {
    const unreadable = await walk(rateDouble({ invoices: [invoiceRow({ n: 1, date: SEP, currency: 'EUR', rate })] }))
    assert.ok(unreadable.ok && !unreadable.value.documents[0]!.readable, String(rate))
  }
  assert.deepEqual(await walk(rateDouble({}, { baseCurrency: 'GBP' }), { budget: 0 }), { ok: false, reason: 'CAP_EXCEEDED' })
  assert.deepEqual(await readXeroRateDocuments(makeXeroWalker(rateDouble({}), { sleep: noSleep }), { from: '2026-10-02', toExclusive: '2026-07-31' }), { ok: false, reason: 'BAD_MODE' })
})
