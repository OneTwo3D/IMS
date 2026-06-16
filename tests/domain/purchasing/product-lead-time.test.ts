import assert from 'node:assert/strict'
import test from 'node:test'

import { planObservedLeadTimeUpdates } from '@/lib/domain/purchasing/product-lead-time'

// audit-n7wd: the recompute's decision logic — which products to update vs clear when
// refreshing Product.observedLeadTimeDays from the trailing-365-day P95 map.

test('updates new and changed values, skips unchanged, rounds, ignores non-positive', () => {
  const observed = new Map<string, number>([
    ['new', 12],        // no current observed -> update
    ['changed', 30],    // current 20 -> update
    ['same', 18],       // current 18 -> skip
    ['fractional', 9.6],// rounds to 10 -> update
    ['zero', 0],        // non-positive -> ignored
  ])
  const current = [
    { id: 'changed', observedLeadTimeDays: 20 },
    { id: 'same', observedLeadTimeDays: 18 },
  ]
  const { updates, clears } = planObservedLeadTimeUpdates(observed, current)
  assert.deepEqual(updates.sort((a, b) => a.id.localeCompare(b.id)), [
    { id: 'changed', days: 30 },
    { id: 'fractional', days: 10 },
    { id: 'new', days: 12 },
  ])
  assert.deepEqual(clears, [])
})

test('clears products that hold an observed value but have no receipts in the window', () => {
  const observed = new Map<string, number>([['still-bought', 14]])
  const current = [
    { id: 'still-bought', observedLeadTimeDays: 14 },  // in map -> not cleared (and unchanged)
    { id: 'aged-out', observedLeadTimeDays: 25 },       // not in map -> cleared
  ]
  const { updates, clears } = planObservedLeadTimeUpdates(observed, current)
  assert.deepEqual(updates, [])
  assert.deepEqual(clears, ['aged-out'])
})
