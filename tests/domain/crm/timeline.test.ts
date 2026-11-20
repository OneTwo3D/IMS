import assert from 'node:assert/strict'
import test from 'node:test'

import { decodeCursor, encodeCursor, invoiceEventInstant, loadTimeline, pageEvents, type TimelineEvent } from '@/lib/domain/crm/timeline'

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

// loadTimeline against a fake reader: only the e-mail path matters here, so every other source is empty.
function fakeReader(emails: Array<Record<string, unknown>>, calls: { outbox: number } = { outbox: 0 }) {
  const none = { findMany: async () => [] as unknown[] }
  const orders = [{ id: 'o1', orderNumber: 'SO-1', externalOrderNumber: null, customerId: 'c1' }]
  const db = {
    salesOrder: { findMany: async (a: { select: Record<string, boolean> }) => (a.select.createdAt || a.select.cancelledAt || a.select.invoicedAt ? [] : orders) },
    payment: none, salesOrderRefund: none, returnExpectation: none, wmsReturnsInbox: none,
    emailOutbox: {
      findMany: async (a: { where: { sentAt: unknown } }) => {
        calls.outbox += 1
        const wantSent = a.where.sentAt !== null
        return emails.filter((m) => (m.sentAt !== null) === wantSent)
      },
    },
  }
  return db as unknown as Parameters<typeof loadTimeline>[0]
}
const mail = (id: string, sentAt: string | null, createdAt: string, status = 'SENT') => ({ id, kind: 'DISPATCH', status, sentAt: sentAt ? new Date(sentAt) : null, createdAt: new Date(createdAt), referenceId: 'o1', subject: 'S', html: 'H', toEmail: 'x@example.test' })

test('e-mail events are absent while the switch is off, and the outbox is not even read', async () => {
  const calls = { outbox: 0 }
  const page = await loadTimeline(fakeReader([mail('m1', '2026-01-02T00:00:00.000Z', '2026-01-01T00:00:00.000Z')], calls), ['c1'])
  assert.equal(page.events.length, 0)
  assert.equal(calls.outbox, 0)
})

test('with the switch on an e-mail shows kind, status and time (sentAt, else createdAt), and no subject, body or address', async () => {
  const page = await loadTimeline(fakeReader([mail('m1', '2026-01-05T00:00:00.000Z', '2026-01-01T00:00:00.000Z'), mail('m2', null, '2026-01-03T00:00:00.000Z', 'PENDING')]), ['c1'], { includeEmails: true })
  assert.deepEqual(page.events.map((e) => [e.key, e.kind, e.reference, e.status, e.at]), [
    ['EMAIL:m1', 'EMAIL', 'DISPATCH', 'SENT', '2026-01-05T00:00:00.000Z'],
    ['EMAIL:m2', 'EMAIL', 'DISPATCH', 'PENDING', '2026-01-03T00:00:00.000Z'],
  ])
  const text = JSON.stringify(page.events)
  assert.ok(!text.includes('@') && !text.includes('"S"') && !text.includes('"H"'))
})

test('keyset pages stay stable with e-mail events sharing an instant with each other', async () => {
  const t = '2026-02-01T10:00:00.000Z'
  const reader = fakeReader([mail('m1', t, t), mail('m2', t, t), mail('m3', null, t, 'PENDING')])
  const all = (await loadTimeline(reader, ['c1'], { includeEmails: true })).events.map((e) => e.key)
  assert.deepEqual(all, ['EMAIL:m3', 'EMAIL:m2', 'EMAIL:m1'])
  const seen: string[] = []
  let cursor: string | null = null
  for (let i = 0; i < 10; i++) {
    const p = await loadTimeline(reader, ['c1'], { includeEmails: true, limit: 1, cursor })
    seen.push(...p.events.map((e) => e.key))
    if (!p.nextCursor) break
    cursor = p.nextCursor
  }
  assert.deepEqual(seen, all)
})
