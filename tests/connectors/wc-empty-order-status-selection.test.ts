import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-tj6v follow-up (o3d-5tf-adjacent): `saveWcSyncSettings` must refuse to STORE an empty
 * order-status selection.
 *
 * `wc_sync_order_statuses` becomes a `?status=<list>` query against the WooCommerce REST API,
 * and an empty `status=` there means ANY status — so a stored `[]` did not mean "import
 * nothing", it imported the whole store. Reading `[]` as "import nothing" fixes that half,
 * but then every sweep run reports a configuration error for a state the settings form was
 * happy to save. The refusal belongs at the persistence boundary.
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

const state = {
  settings: [] as Array<{ key: string; value: string }>,
  transactions: 0,
  upserts: [] as Array<{ key: string; value: string }>,
}

const settingDelegate = {
  findMany: async () => state.settings.map((row) => ({ ...row })),
  findUnique: async ({ where }: { where: { key: string } }) =>
    state.settings.find((row) => row.key === where.key) ?? null,
  updateMany: async () => ({ count: 0 }),
  upsert: ({ where, update }: { where: { key: string }; update: { value: string } }) => {
    // Prisma delegates return a thenable that only executes inside $transaction; recording
    // at build time is enough to prove a write was PREPARED, and `transactions` proves
    // whether it was ever executed.
    state.upserts.push({ key: where.key, value: update.value })
    return { key: where.key }
  },
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: settingDelegate,
      $transaction: async (ops: unknown) => {
        state.transactions += 1
        return Array.isArray(ops) ? ops : []
      },
    },
  },
})

// The connection gate and the currency probe are not what these tests are about: they must
// simply never be the reason an empty selection is refused.
mock.module('@/lib/connectors/woocommerce/connection-test-gate', {
  namedExports: {
    buildWooCommerceConnectionFingerprint: () => 'fingerprint',
    evaluateWooCommerceEnableConnectionGate: async () => ({ ok: true }),
  },
})
mock.module('@/lib/integration-connection-test-gate', {
  namedExports: {
    getIntegrationConnectionTestState: async () => ({ status: 'passed' }),
    recordIntegrationConnectionTest: async () => {},
  },
})

async function loadAction() {
  return (await import('@/app/actions/wc-sync')).saveWcSyncSettings
}

function reset() {
  state.settings = [{ key: 'wc_sync_order_statuses', value: '["processing"]' }]
  state.transactions = 0
  state.upserts = []
}

test('unticking every order status is refused, and nothing is written', async () => {
  reset()
  const saveWcSyncSettings = await loadAction()

  const result = await saveWcSyncSettings({ wc_sync_order_statuses: '[]' })

  assert.equal(result.success, false)
  assert.equal(result.code, 'wc_no_order_statuses_selected')
  assert.match(result.error ?? '', /Select at least one WooCommerce order status/)
  // The remedy has to be named, or the operator's only route to "import nothing" is the one
  // that silently imported everything.
  assert.match(result.error ?? '', /Enable order sync/)
  assert.equal(state.transactions, 0, 'no settings transaction may run for a refused save')
  assert.deepEqual(state.upserts, [])
})

test('an array of blank strings is the same empty selection, not a selection of blanks', async () => {
  reset()
  const saveWcSyncSettings = await loadAction()

  const result = await saveWcSyncSettings({ wc_sync_order_statuses: '["", "  "]' })

  assert.equal(result.code, 'wc_no_order_statuses_selected')
  assert.equal(state.transactions, 0)
})

test('a real selection still saves', async () => {
  reset()
  const saveWcSyncSettings = await loadAction()

  const result = await saveWcSyncSettings({ wc_sync_order_statuses: '["processing","on-hold"]' })

  assert.deepEqual(result, { success: true })
  assert.equal(state.transactions, 1)
  assert.deepEqual(state.upserts, [
    { key: 'wc_sync_order_statuses', value: '["processing","on-hold"]' },
  ])
})

test('a save that does not touch the status selection is not judged on it', async () => {
  reset()
  const saveWcSyncSettings = await loadAction()

  const result = await saveWcSyncSettings({ wc_sync_product_enabled: 'true' })

  assert.deepEqual(result, { success: true })
  assert.equal(state.transactions, 1)
})

test('a blank value means "unset", which readers resolve to the default — not an empty selection', async () => {
  reset()
  const saveWcSyncSettings = await loadAction()

  const result = await saveWcSyncSettings({ wc_sync_order_statuses: '' })

  assert.deepEqual(result, { success: true })
  assert.equal(state.transactions, 1)
})

test('a malformed value is a corrupt row, not an expressed choice, and is not refused here', async () => {
  reset()
  const saveWcSyncSettings = await loadAction()

  for (const raw of ['not json', '{"processing":true}']) {
    state.transactions = 0
    const result = await saveWcSyncSettings({ wc_sync_order_statuses: raw })
    assert.deepEqual(result, { success: true }, `unexpected refusal for ${raw}`)
    assert.equal(state.transactions, 1)
  }
})
