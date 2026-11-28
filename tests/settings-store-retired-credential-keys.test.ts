import assert from 'node:assert/strict'
import test from 'node:test'

import { RETIRED_CREDENTIAL_SETTING_KEYS, SENSITIVE_SETTING_KEYS } from '@/lib/settings-store'

/**
 * THE RETIRED CONNECTORS' CREDENTIAL KEYS STAY IN THE SENSITIVE SET (the #1146 review: a restored pre-purge dump brings their rows back unmasked until the next migrate deploy re-runs the purge).
 * Pinned as LITERALS, not by iterating the set, so deleting a key from either list is a red test. [mutation: drop one literal from RETIRED_CREDENTIAL_SETTING_KEYS or stop spreading it: red]
 */
test('the seven retired credential keys are listed exactly and every one is in SENSITIVE_SETTING_KEYS', () => {
  assert.deepEqual([...RETIRED_CREDENTIAL_SETTING_KEYS], [
    'quickbooks_client_secret',
    'shiphero_access_token',
    'shiphero_refresh_token',
    'shiphero_webhook_secret',
    'shopify_admin_api_access_token',
    'shopify_invoice_pdf_secret',
    'shopify_webhook_secret',
  ])
  for (const key of ['quickbooks_client_secret', 'shiphero_access_token', 'shiphero_refresh_token', 'shiphero_webhook_secret', 'shopify_admin_api_access_token', 'shopify_invoice_pdf_secret', 'shopify_webhook_secret']) {
    assert.equal(SENSITIVE_SETTING_KEYS.has(key), true, key)
  }
})
