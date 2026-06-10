import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildWooCommerceConnectionFingerprint,
  evaluateWooCommerceEnableConnectionGate,
} from '../../../lib/connectors/woocommerce/connection-test-gate.ts'
import {
  getIntegrationConnectionTestState,
  recordIntegrationConnectionTest,
} from '../../../lib/integration-connection-test-gate.ts'

function createSettingsRepository(initialRows: Record<string, string>) {
  const rows = new Map(Object.entries(initialRows))
  const repository = {
    async findMany(args: { where: { key: { in: string[] } } }) {
      return args.where.key.in
        .filter((key) => rows.has(key))
        .map((key) => ({ key, value: rows.get(key)! }))
    },
    async upsert(args: { where: { key: string }; create: { key: string; value: string }; update: { value: string } }) {
      rows.set(args.where.key, rows.has(args.where.key) ? args.update.value : args.create.value)
      return null
    },
  }

  return { rows, repository }
}

test('WooCommerce enablement follows the save gate and connection-test record cycle', async () => {
  const { rows, repository } = createSettingsRepository({
    wc_url: 'https://store.example.test',
    wc_consumer_key: 'ck_test',
    wc_consumer_secret: 'cs_test',
    wc_sync_enabled: 'false',
    wc_stock_sync_enabled: 'false',
  })
  const currentFingerprint = () => buildWooCommerceConnectionFingerprint({
    url: rows.get('wc_url') ?? '',
    key: rows.get('wc_consumer_key') ?? '',
    secret: rows.get('wc_consumer_secret') ?? '',
  })
  const deps = {
    getCurrentSettings: async (keys: readonly string[]) => new Map(
      keys
        .filter((key) => rows.has(key))
        .map((key) => [key, rows.get(key)!]),
    ),
    getCurrentFingerprint: async () => currentFingerprint(),
    getConnectionTestState: () => getIntegrationConnectionTestState('woocommerce', repository),
  }

  assert.deepEqual(
    await evaluateWooCommerceEnableConnectionGate({ wc_sync_enabled: 'true' }, deps),
    { ok: false, error: 'Test the WooCommerce connection successfully before enabling it.' },
  )

  await recordIntegrationConnectionTest('woocommerce', {
    success: true,
    fingerprint: currentFingerprint(),
    message: 'Connection verified against WooCommerce (GBP).',
    testedAt: new Date('2026-06-10T12:00:00.000Z'),
  }, repository)

  assert.deepEqual(
    await evaluateWooCommerceEnableConnectionGate({ wc_sync_enabled: 'true' }, deps),
    { ok: true },
  )
  rows.set('wc_sync_enabled', 'true')

  assert.deepEqual(
    await evaluateWooCommerceEnableConnectionGate({ wc_sync_interval_minutes: '15' }, deps),
    { ok: true },
  )

  rows.set('wc_url', 'https://new-store.example.test')
  assert.deepEqual(
    await evaluateWooCommerceEnableConnectionGate({ wc_sync_interval_minutes: '10' }, deps),
    { ok: false, error: 'Retest the WooCommerce connection because the saved connection settings changed.' },
  )
})
