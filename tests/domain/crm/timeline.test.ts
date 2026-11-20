import assert from 'node:assert/strict'
import test from 'node:test'

import { decodeCursor, encodeCursor, invoiceEventInstant, pageEvents, type TimelineEvent } from '@/lib/domain/crm/timeline'

const ev = (key: string, at: string): TimelineEvent => ({ key, kind: 'PAYMENT', at, orderId: 'o', orderNumber: '1', customerId: 'c', reference: null, amount: '1', currency: 'GBP', status: null })

test('events are newest first, and ties on the same instant order by key descending', () => {
  const page = pageEvents([ev('A:1', '2026-01-01T00:00:00.000Z'), ev('B:1', '2026-01-03T00:00:00.000Z'), ev('A:2', '2026-01-03T00:00:00.000Z')], null, 10)
  assert.deepEqual(page.events.map((e) => e.key), ['B:1', 'A:2', 'A:1'])
  assert.equal(page.nextCursor, null)
})

test('keyset pages neither repeat nor skip an event, including a run of events on one instant', () => {
  const all = [
    ev('X:1', '2026-02-01T10:00:00.000Z'), ev('X:2', '2026-02-01T10:00:00.000Z'), ev('X:3', '2026-02-01T10:00:00.000Z'), ev('X:4', '2026-02-01T10:00:00.000Z'),
    ev('Y:1', '2026-01-01T10:00:00.000Z'), ev('Y:2', '2026-03-01T10:00:00.000Z'),
  ]
  const seen: string[] = []
  let cursor: string | null = null
  for (let i = 0; i < 10; i++) {
    const page = pageEvents(all, decodeCursor(cursor), 2)
    seen.push(...page.events.map((e) => e.key))
    if (!page.nextCursor) break
    cursor = page.nextCursor
  }
  assert.deepEqual(seen, ['Y:2', 'X:4', 'X:3', 'X:2', 'X:1', 'Y:1'])
})

test('a cursor round-trips and a malformed one is ignored', () => {
  const e = ev('PAYMENT:abc:def', '2026-02-01T10:00:00.000Z')
  assert.deepEqual(decodeCursor(encodeCursor(e)), { atMs: new Date(e.at).getTime(), key: 'PAYMENT:abc:def' })
  assert.equal(decodeCursor('garbage'), null)
  assert.equal(decodeCursor(null), null)
})

test('an invoice dated the day the order was placed sorts AFTER the order placed (it is shown at the order instant and ranks later), never before it', () => {
  // invoicedAt is the document day (UTC midnight); the order was placed at 10:00 the same London day.
  const createdAt = new Date('2026-09-30T09:00:00.000Z')
  const invoicedAt = new Date('2026-09-30T00:00:00.000Z')
  const shown = invoiceEventInstant(invoicedAt, createdAt)
  assert.equal(shown.toISOString(), createdAt.toISOString())
  const placed = ev('ORDER_PLACED:o1', createdAt.toISOString())
  const invoice = ev('INVOICE:o1', shown.toISOString())
  const page = pageEvents([placed, invoice], null, 10)
  assert.deepEqual(page.events.map((e) => e.key), ['INVOICE:o1', 'ORDER_PLACED:o1'], 'newest first: the invoice is the later event')
  // The raw instants would have put the invoice below the order (older): that is the defect.
  assert.deepEqual(pageEvents([placed, ev('INVOICE:o1', invoicedAt.toISOString())], null, 10).events.map((e) => e.key), ['ORDER_PLACED:o1', 'INVOICE:o1'])
})

test('an invoice dated a LATER day, or an earlier London day than the order, keeps its own instant', () => {
  const createdAt = new Date('2026-09-30T09:00:00.000Z')
  assert.equal(invoiceEventInstant(new Date('2026-10-01T00:00:00.000Z'), createdAt).toISOString(), '2026-10-01T00:00:00.000Z')
  assert.equal(invoiceEventInstant(new Date('2026-09-29T00:00:00.000Z'), createdAt).toISOString(), '2026-09-29T00:00:00.000Z')
  assert.equal(invoiceEventInstant(new Date('2026-09-30T00:00:00.000Z'), null).toISOString(), '2026-09-30T00:00:00.000Z')
})

test('the same-instant rank keeps keyset pages stable: a cursor on the invoice resumes at the order placed, once', () => {
  const t = '2026-09-30T09:00:00.000Z'
  const all = [ev('ORDER_PLACED:o1', t), ev('INVOICE:o1', t), ev('PAYMENT:p1', '2026-09-29T09:00:00.000Z')]
  const first = pageEvents(all, null, 1)
  assert.deepEqual(first.events.map((e) => e.key), ['INVOICE:o1'])
  const second = pageEvents(all, decodeCursor(first.nextCursor), 5)
  assert.deepEqual(second.events.map((e) => e.key), ['ORDER_PLACED:o1', 'PAYMENT:p1'])
})
