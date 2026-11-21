import assert from 'node:assert/strict'
import test from 'node:test'

import { decodeCursor, emailKindLabel, encodeCursor, invoiceEventInstant, loadTimeline, pageEvents, type TimelineEvent } from '@/lib/domain/crm/timeline'

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

// loadTimeline against a fake reader: only the e-mail path matters here, so every other source is empty. The e-mail source is one raw query, so the fake
// receives the tagged SQL (its text and bound values) and applies the same filters, order and limit to its rows. The SQL text is asserted separately (emailSql).
type FakeMail = Record<string, unknown>
function fakeReader(emails: FakeMail[], calls: { outbox: number; sql: Array<{ text: string; values: unknown[] }> } = { outbox: 0, sql: [] }) {
  const none = { findMany: async () => [] as unknown[] }
  const db = {
    salesOrder: none, payment: none, salesOrderRefund: none, returnExpectation: none, wmsReturnsInbox: none,
    $queryRaw: async (q: { text: string; values: unknown[] }) => {
      calls.outbox += 1
      calls.sql.push({ text: q.text, values: q.values })
      const [ids, placeholder, ...rest] = q.values as [string[], string, ...unknown[]]
      const take = rest[rest.length - 1] as number
      const upTo = rest.length > 1 ? (rest[0] as Date) : null
      return emails
        .filter((m) => m.referenceType === 'SalesOrder' && ids.includes(m.customerId as string) && m.orderErasedAt === null && m.toEmail !== placeholder && (!upTo || (m.createdAt as Date).getTime() <= upTo.getTime()))
        .sort((x, y) => (y.createdAt as Date).getTime() - (x.createdAt as Date).getTime() || ((y.id as string) < (x.id as string) ? -1 : 1))
        .slice(0, take)
    },
  }
  return db as unknown as Parameters<typeof loadTimeline>[0]
}
const mail = (id: string, sentAt: string | null, createdAt: string, status = 'SENT', extra: FakeMail = {}) => ({ id, kind: 'DISPATCH', status, sentAt: sentAt ? new Date(sentAt) : null, createdAt: new Date(createdAt), orderId: 'o1', orderNumber: 'SO-1', externalOrderNumber: null, customerId: 'c1', referenceType: 'SalesOrder', orderErasedAt: null, toEmail: 'x@example.test', ...extra })

test('e-mail events are absent while the switch is off, and the outbox is not even read', async () => {
  const calls = { outbox: 0, sql: [] }
  const page = await loadTimeline(fakeReader([mail('m1', '2026-01-02T00:00:00.000Z', '2026-01-01T00:00:00.000Z')], calls), ['c1'])
  assert.equal(page.events.length, 0)
  assert.equal(calls.outbox, 0)
})

test('with the switch on an e-mail shows a human kind label, status and its queued time (createdAt, never sentAt), and no subject, body or address', async () => {
  const page = await loadTimeline(fakeReader([mail('m1', '2026-01-05T00:00:00.000Z', '2026-01-01T00:00:00.000Z'), mail('m2', null, '2026-01-03T00:00:00.000Z', 'PENDING')]), ['c1'], { includeEmails: true })
  assert.deepEqual(page.events.map((e) => [e.key, e.kind, e.reference, e.status, e.at]), [
    ['EMAIL:m2', 'EMAIL', 'Dispatch', 'PENDING', '2026-01-03T00:00:00.000Z'],
    ['EMAIL:m1', 'EMAIL', 'Dispatch', 'SENT', '2026-01-01T00:00:00.000Z'],
  ])
  const text = JSON.stringify(page.events)
  assert.ok(!text.includes('@') && !text.includes('"S"') && !text.includes('"H"'))
})

test('the e-mail query is one bounded, parameterised statement: ANY(ids), SalesOrder only, erased orders and the placeholder address excluded, newest first, limited', async () => {
  const calls = { outbox: 0, sql: [] as Array<{ text: string; values: unknown[] }> }
  const reader = fakeReader([], calls)
  await loadTimeline(reader, ['c1', 'c2'], { includeEmails: true, limit: 7 })
  await loadTimeline(reader, ['c1'], { includeEmails: true, limit: 7, cursor: encodeCursor({ at: '2026-02-01T00:00:00.000Z', key: 'EMAIL:z' }) })
  assert.equal(calls.outbox, 2, 'one query per load, however many orders')
  const [plain, bounded] = calls.sql
  for (const q of [plain!, bounded!]) {
    assert.match(q.text, /m\."referenceType" = 'SalesOrder'/)
    assert.match(q.text, /o\."customerId" = ANY\(\$1::text\[\]\)/)
    assert.match(q.text, /o\."erasedAt" IS NULL/)
    assert.match(q.text, /m\."toEmail" <> \$2/)
    assert.match(q.text, /ORDER BY m\."createdAt" DESC, m\."id" DESC\s+LIMIT/)
    assert.deepEqual(q.values.slice(0, 2), [q === plain ? ['c1', 'c2'] : ['c1'], 'erased@erased.invalid'])
    assert.equal(q.values[q.values.length - 1], 7 + 50 + 1)
  }
  assert.ok(!/m\."createdAt" <=/.test(plain!.text) && plain!.values.length === 3)
  assert.match(bounded!.text, /m\."createdAt" <= \$3/)
  assert.equal((bounded!.values[2] as Date).toISOString(), '2026-02-01T00:00:00.000Z')
})

test('another reference type, an erased order, the placeholder address and another customer are not listed', async () => {
  const t = '2026-02-01T10:00:00.000Z'
  const page = await loadTimeline(fakeReader([
    mail('keep', t, t),
    mail('po', t, t, 'SENT', { referenceType: 'PurchaseOrder' }),
    mail('erased', t, t, 'SENT', { orderErasedAt: new Date() }),
    mail('scrubbed', t, t, 'SENT', { toEmail: 'erased@erased.invalid' }),
    mail('other', t, t, 'SENT', { customerId: 'c9' }),
  ]), ['c1'], { includeEmails: true })
  assert.deepEqual(page.events.map((e) => e.key), ['EMAIL:keep'])
})

test('e-mail kind codes map to labels; a partial-shipment code loses its shipment id; an unknown code reads as words', () => {
  assert.equal(emailKindLabel('SHIPMENT_DISPATCHED'), 'Dispatch notice')
  assert.equal(emailKindLabel('STOREFRONT_ORDER_CONFIRMATION'), 'Order confirmation')
  assert.equal(emailKindLabel('STOREFRONT_PARTIAL_SHIPMENT:cm123abc'), 'Partial shipment notice')
  assert.ok(!emailKindLabel('STOREFRONT_PARTIAL_SHIPMENT:cm123abc').includes('cm123abc'))
  assert.equal(emailKindLabel('SOME_NEW_KIND'), 'Some new kind')
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
