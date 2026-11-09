import assert from 'node:assert/strict'
import test from 'node:test'

import { MAX_DISPATCH_AGE_DAYS, parseTransferDispatchedAt } from '@/lib/domain/import/transfer-dispatch-date'

const NOW = new Date('2026-11-09T09:30:00.000Z')

function ok(raw: string, now: Date = NOW): Date {
  const r = parseTransferDispatchedAt(raw, now)
  assert.equal(r.ok, true, JSON.stringify(r))
  return (r as { value: Date }).value
}
const refused = (raw: string, now: Date = NOW) => {
  const r = parseTransferDispatchedAt(raw, now)
  assert.equal(r.ok, false, `${raw} should be refused`)
  return (r as { error: string }).error
}

test('a date-only value is 12:00 UK time: noon UTC in winter, 11:00 UTC in summer', () => {
  assert.equal(ok('2026-10-20').toISOString(), '2026-10-20T11:00:00.000Z', 'BST')
  assert.equal(ok('2026-11-02').toISOString(), '2026-11-02T12:00:00.000Z', 'GMT')
  assert.equal(ok('2026-03-28').toISOString(), '2026-03-28T12:00:00.000Z', 'the day before the clocks go forward is still GMT')
  assert.equal(ok('2026-03-29').toISOString(), '2026-03-29T11:00:00.000Z', 'the day the clocks go forward is BST at noon')
})

test('today in London whose noon has not arrived is stamped now, not refused', () => {
  assert.equal(ok('2026-11-09').toISOString(), NOW.toISOString())
  assert.equal(ok('2026-11-09', new Date('2026-11-09T13:00:00.000Z')).toISOString(), '2026-11-09T12:00:00.000Z')
})

test('an ISO date-time needs an offset and is taken as that instant', () => {
  assert.equal(ok('2026-10-20T14:30:00Z').toISOString(), '2026-10-20T14:30:00.000Z')
  assert.equal(ok('2026-10-20T14:30:00+01:00').toISOString(), '2026-10-20T13:30:00.000Z')
  assert.equal(ok('2026-10-20T14:30+0100').toISOString(), '2026-10-20T13:30:00.000Z')
  assert.match(refused('2026-10-20T14:30:00'), /must be YYYY-MM-DD/)
})

test('future, ambiguous, unreal and too-old values are refused by name', () => {
  assert.match(refused('2026-11-10'), /in the future/)
  assert.match(refused('2026-11-09T09:31:00Z'), /in the future/)
  assert.match(refused('20/10/2026'), /must be YYYY-MM-DD/)
  assert.match(refused('2026-02-30'), /not a real calendar date/)
  assert.match(refused('tomorrow'), /must be YYYY-MM-DD/)
  assert.equal(MAX_DISPATCH_AGE_DAYS, 366)
  assert.match(refused('2025-11-01'), /more than 366 days/)
  ok('2025-11-10')
})
