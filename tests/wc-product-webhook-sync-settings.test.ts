import assert from 'node:assert/strict'
import test, { beforeEach, mock } from 'node:test'

/**
 * o3d-hqvrp.107: the product.updated webhook honours wc_sync_product_enabled and wc_sync_product_direction exactly as the hourly
 * poll does. With sync off, or a direction that makes IMS the master (to_wc) or is unrecognised, the delivery is acknowledged and
 * NOTHING is imported. Mocked: no database, no network.
 */
const state = { settings: new Map<string, string>(), imports: 0, activity: [] as Array<Record<string, unknown>> }

mock.module('@/lib/connectors/woocommerce/sync/product-sync', {
  namedExports: { syncWcProductToIms: async () => { state.imports++; return { success: true } } },
})
mock.module('@/lib/activity-log', { namedExports: { logActivity: async (entry: Record<string, unknown>) => { state.activity.push(entry) } } })
mock.module('@/lib/connectors/woocommerce/sync/stock-sync-jobs', {
  namedExports: {
    enqueueAndProcessImmediateWcStockSync: async () => {},
    recordIncomingWcWebhook: async () => {},
    shouldSuppressWcWebhookEcho: async () => false,
  },
})
mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: {
        findUnique: async ({ where }: { where: { key: string } }) => {
          const value = state.settings.get(where.key)
          return value === undefined ? null : { key: where.key, value }
        },
        upsert: async () => ({}),
      },
      product: { findFirst: async () => null },
    },
  },
})

const payload = { id: 42, sku: 'SKU-42', type: 'simple', name: 'Renamed in WooCommerce', status: 'publish' }

function configure(enabled: string | undefined, direction: string | undefined) {
  state.settings = new Map([['wc_url', 'https://shop.example.com']])
  if (enabled !== undefined) state.settings.set('wc_sync_product_enabled', enabled)
  if (direction !== undefined) state.settings.set('wc_sync_product_direction', direction)
}

async function deliver() {
  const { processWcWebhookPayload } = await import('@/lib/connectors/woocommerce/webhooks')
  return processWcWebhookPayload({ resource: 'products', topic: 'product.updated', payload, originAttestation: 'store:shop.example.com' })
}

beforeEach(() => { state.imports = 0; state.activity = [] })

const cases: Array<[string, string | undefined, string | undefined, boolean]> = [
  ['enabled + from_wc imports', 'true', 'from_wc', true],
  ['enabled + both imports', 'true', 'both', true],
  ['enabled + direction unset reads as from_wc and imports', 'true', undefined, true],
  ['enabled + to_wc (IMS is master) does NOT import', 'true', 'to_wc', false],
  ['enabled + unrecognised direction does NOT import', 'true', 'sideways', false],
  ['sync disabled does NOT import (from_wc)', 'false', 'from_wc', false],
  ['sync setting missing does NOT import', undefined, 'from_wc', false],
  ['sync disabled + both does NOT import', 'false', 'both', false],
]
for (const [name, enabled, direction, imports] of cases) {
  test(name, async () => {
    configure(enabled, direction)
    const response = await deliver()
    assert.equal(response.status, 200, 'the delivery is acknowledged either way (no retry storm)')
    assert.equal(state.imports, imports ? 1 : 0)
    if (!imports) assert.ok(state.activity.some((entry) => entry.action === 'wc_product_webhook_import_skipped'), 'the skip is recorded')
    else assert.ok(!state.activity.some((entry) => entry.action === 'wc_product_webhook_import_skipped'))
  })
}
