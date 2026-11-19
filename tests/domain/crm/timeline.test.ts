import assert from 'node:assert/strict'
import test from 'node:test'

import { decodeCursor, encodeCursor, pageEvents, type TimelineEvent } from '@/lib/domain/crm/timeline'

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
