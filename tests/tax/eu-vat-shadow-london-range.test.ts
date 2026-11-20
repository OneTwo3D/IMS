import assert from 'node:assert/strict'
import test from 'node:test'
import { londonDayRange } from '../../lib/tax/eu-vat-shadow-live'
import { renderEuVatShadowUsage } from '../../lib/tax/eu-vat-shadow-cli'

test('--from/--to select LONDON days: a BST range is [23:00Z the evening before, 23:00Z on the last day)', () => {
  const r = londonDayRange('2026-07-01', '2026-07-31')
  assert.equal(r.gte.toISOString(), '2026-06-30T23:00:00.000Z')
  assert.equal(r.lt.toISOString(), '2026-07-31T23:00:00.000Z')
})

test('a GMT range is the UTC range (control), and a single BST day is 24 hours from 23:00Z', () => {
  const winter = londonDayRange('2026-12-01', '2026-12-31')
  assert.equal(winter.gte.toISOString(), '2026-12-01T00:00:00.000Z')
  assert.equal(winter.lt.toISOString(), '2027-01-01T00:00:00.000Z')
  const day = londonDayRange('2026-09-30', '2026-09-30')
  assert.equal(day.gte.toISOString(), '2026-09-29T23:00:00.000Z')
  assert.equal(day.lt.toISOString(), '2026-09-30T23:00:00.000Z')
})

test('the usage text says London dates, not UTC dates', () => {
  const usage = renderEuVatShadowUsage()
  assert.match(usage, /LONDON dates/)
  assert.doesNotMatch(usage, /UTC dates/)
})
