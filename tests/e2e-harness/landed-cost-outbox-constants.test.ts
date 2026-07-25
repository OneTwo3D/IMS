import assert from 'node:assert/strict'
import test from 'node:test'

import {
  LANDED_COST_OUTBOX_CONNECTOR,
  LANDED_COST_OUTBOX_OPERATION,
} from '@/lib/domain/purchasing/landed-cost-journal-outbox'

/**
 * drainLandedCostOutboxNow (e2e/full-chain/harness/ims.ts) hardcodes these two strings rather than importing
 * them, because importing that module into the Playwright worker poisons it with a CJS-only dependency. This
 * test is the safety net for that copy: a rename would otherwise leave the harness selecting ZERO outbox
 * rows, and X-06 would report a vacuous "nothing to drain" instead of failing.
 */
test('the outbox selectors the full-chain harness hardcodes still match the module', () => {
  assert.equal(LANDED_COST_OUTBOX_CONNECTOR, 'accounting')
  assert.equal(LANDED_COST_OUTBOX_OPERATION, 'landed-cost.adjustment-journal')
})
