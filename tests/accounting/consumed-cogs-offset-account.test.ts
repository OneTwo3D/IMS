import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveConsumedCogsOffsetAccount } from '@/lib/domain/purchasing/landed-cost-service'

// audit-o3yb: a retrospective COGS correction on CONSUMED qty (goods already sold)
// must offset to the inventory-revaluation P&L account when configured, and fall
// back to the transit/clearing account otherwise (prior behaviour, safe rollout).

test('uses the inventory-revaluation account when configured', () => {
  assert.equal(
    resolveConsumedCogsOffsetAccount({ inventoryRevaluationAccount: '8100', transitAccount: '1250' }),
    '8100',
  )
})

test('falls back to the transit account when revaluation is unset', () => {
  assert.equal(
    resolveConsumedCogsOffsetAccount({ inventoryRevaluationAccount: '', transitAccount: '1250' }),
    '1250',
  )
})

test('treats a whitespace-free empty string as unset (falls back)', () => {
  // The setting default is '' — confirm the OR fallback engages.
  assert.equal(
    resolveConsumedCogsOffsetAccount({ inventoryRevaluationAccount: '', transitAccount: 'TRANSIT' }),
    'TRANSIT',
  )
})
