import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { shoppingSyncLogFake, type ShoppingSyncLogRow } from '../helpers/shopping-sync-log-fake'

/**
 * o3d-272i — THE STORE-URL REBIND GUARD COUNTS TWO FAMILIES AND NAMES BOTH.
 *
 * o3d-7yf finding 2 refuses a store-CHANGING rebind while unresolved WooCommerce rows exist: order
 * links and parks carry the OLD store's externalOrderId with no store-identity binding, so retrying
 * one after the switch fetches the NEW store by that id — stranding it, or misapplying a different
 * store's refund to the old IMS order.
 *
 * WHAT WAS WRONG. The count was a hand-written copy of the pre-`recordKind` refund-park predicate,
 * so it also counted HELD SALES INVOICES (o3d-k26m.6) — which it SHOULD, and for exactly the same
 * reason with the same force — but it reported every one of them to the operator as an "unresolved
 * refund" and offered an inbox that does not list holds. The set was right; the sentence was false.
 *
 * These tests drive the real server action with a fake `shopping_sync_logs` delegate that EVALUATES
 * the predicate it is handed, so the assertions are about what the guard asks for, not about what a
 * stub was told to answer.
 */

mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })
mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'admin' } }),
    requireFreshPermission: async () => ({ user: { id: 'admin' } }),
    freshAuthFailureResult: () => null,
  },
})
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })
mock.module('@/lib/security/encrypted-settings', {
  namedExports: { decryptSettingValue: (_key: string, value: string) => value },
})
mock.module('@/lib/base-currency', { namedExports: { getBaseCurrencyCode: async () => 'GBP' } })
mock.module('@/lib/connectors/woocommerce/api', {
  namedExports: {
    wcFetch: async () => ({ data: { id: 'woocommerce_currency', value: 'GBP' }, error: null }),
  },
})
mock.module('@/lib/integration-connection-test-gate', {
  namedExports: {
    getIntegrationConnectionTestState: async () => ({ status: 'passed' }),
    recordIntegrationConnectionTest: async () => {},
  },
})
mock.module('@/lib/connectors/woocommerce/connection-test-gate', {
  namedExports: {
    buildWooCommerceConnectionFingerprint: () => 'fingerprint',
    evaluateWooCommerceEnableConnectionGate: async () => ({ ok: true }),
  },
})
mock.module('@/lib/settings-store', {
  namedExports: {
    getActiveSettingEnvOverrides: async () => ({}),
    getSettingValue: async () => null,
    getSettingValues: async () => ({}),
    maskSettingSecret: (value: string) => value,
    serializeSettingValue: (_key: string, value: string) => value,
  },
})

/** The store the connection currently points at — changing it is what arms the guard. */
const CURRENT_STORE = 'https://old-store.example.com'

const state = {
  syncRows: [] as ShoppingSyncLogRow[],
  wipedMappings: 0,
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({
        $executeRaw: async () => 0,
        setting: {
          findMany: async () => [
            { key: 'wc_url', value: CURRENT_STORE },
            { key: 'wc_consumer_key', value: 'ck_old' },
            { key: 'wc_consumer_secret', value: 'cs_old' },
          ],
          findUnique: async () => null,
          upsert: async () => ({}),
        },
        shoppingSyncLog: shoppingSyncLogFake(state.syncRows),
        product: { updateMany: async () => ({ count: (state.wipedMappings += 1, 0) }) },
      }),
    },
  },
})

async function rebindTo(newStore: string, syncRows: ShoppingSyncLogRow[]) {
  state.syncRows = syncRows
  const { saveWcCredentials } = await import('@/app/actions/wc-sync')
  return saveWcCredentials(newStore, 'ck_new', 'cs_new')
}

test('o3d-272i: a rebind is refused, and a held invoice is counted as an invoice not a refund', async () => {
  // MUTATION ROUTE: give the guard one blocker sentence for the whole set again. The invoice hold is
  // reported as an "unresolved refund" and the `/invoice/` assertion fails.
  const result = await rebindTo('https://new-store.example.com', [
    { id: 'park-1', recordKind: 'WC_REFUND_PARK' },
    { id: 'park-2', recordKind: 'WC_REFUND_PARK', status: 'QUARANTINED' },
    { id: 'hold-1', recordKind: 'WC_HELD_SALES_INVOICE' },
  ])

  assert.equal(result.success, false)
  assert.equal(result.code, 'unresolved_refund_parks')
  const error = result.error ?? ''
  assert.match(error, /2 unresolved refund\(s\) parked for review/, 'the two parks are counted as refunds')
  assert.match(error, /1 sales invoice\(s\) held for a missing invoice number/, 'and the hold as an invoice')
  // The whole point: the operator is not sent to an inbox that will not show them the hold.
  assert.match(error, /held invoice releases once WooCommerce issues its number/)
})

test('o3d-272i: the rebind guard asks the row what it IS — an unstamped row does not block it', async () => {
  // THE DECISIVE MUTATION FOR THIS READER: drop `recordKind` from `unresolvedWcOrderRowWhere()`.
  // Both rows below are admitted again, the rebind is refused, and this test goes red — as it must
  // at every other reader of the same predicate.
  const result = await rebindTo('https://another-store.example.com', [
    { id: 'unstamped', recordKind: null },
    { id: 'unknown-family', recordKind: 'WC_SOMETHING_ELSE' },
  ])

  assert.notEqual(result.code, 'unresolved_refund_parks', `the rebind must proceed: ${result.error ?? ''}`)
  assert.equal(result.success, true)
})

test('o3d-272i: resolved, outbound and other-connector rows never block a rebind', async () => {
  // PRECONDITION FOR THE TWO TESTS ABOVE: the fake really evaluates the predicate rather than
  // returning whatever it was seeded with.
  const result = await rebindTo('https://third-store.example.com', [
    { id: 'settled', status: 'SYNCED' },
    { id: 'outbound', direction: 'TO_CONNECTOR' },
    { id: 'shopify', connector: 'shopify' },
    { id: 'no-order', entityId: null },
    { id: 'product-row', entityType: 'Product' },
  ])

  assert.equal(result.success, true, result.error ?? '')
})
