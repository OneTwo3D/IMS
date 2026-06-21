import assert from 'node:assert/strict'
import test from 'node:test'

import { XERO_SETTING_KEYS } from '@/lib/connectors/xero/settings'

// scjz.60b: the rounding-difference account must be a recognised setting key so it
// round-trips through the allowlisted save path and is readable by the posting
// logic (scjz.60c). It is intentionally OPTIONAL — not in REQUIRED_ACCOUNTS — so
// leaving it blank never blocks sync. Scoped to Xero (the live connector); the
// QBO equivalent lands with the QBO account-mapping UI, which is not yet wired.

test('Xero settings expose the rounding-difference account key', () => {
  assert.ok(
    XERO_SETTING_KEYS.includes('xero_rounding_difference_account'),
    'xero_rounding_difference_account must be an allowlisted Xero setting key',
  )
})
