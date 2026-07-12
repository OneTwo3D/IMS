import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveConsumedCogsOffsetAccount } from '@/lib/domain/purchasing/landed-cost-service'

// scjz.34: a retrospective COGS correction on CONSUMED qty (goods already sold)
// offsets to the transit/clearing account so the freight bill's transit debit
// drains in full (DR COGS / CR transit on an increase). This reverses the prior
// audit-o3yb routing to the inventory-revaluation P&L account, which left the sold
// units' freight share permanently in transit.

test('consumed-portion COGS correction offsets to the transit/clearing account', () => {
  assert.equal(
    resolveConsumedCogsOffsetAccount({ transitAccount: '1250' }),
    '1250',
  )
})

test('uses whatever transit account is configured', () => {
  assert.equal(
    resolveConsumedCogsOffsetAccount({ transitAccount: 'TRANSIT' }),
    'TRANSIT',
  )
})
