import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { createRecordingDb, type QueryContext } from './security/recording-db'

/** o3d-hqvrp.91: saving a NEW webhook secret keeps the replaced one for a grace window; Setup Webhooks pushes the new one to existing hooks. */
process.env.SETTINGS_ENCRYPTION_KEY = 'a1'.repeat(32)
delete process.env.ENCRYPTION_KEY

const stored = new Map<string, string>([['wc_webhook_secret', 'old-secret'], ['wc_url', 'https://shop.example.test']])
mock.module('@/lib/auth', {
  namedExports: { auth: async () => ({ user: { id: 'u1', email: 'u@example.test', name: 'U', role: 'ADMIN', sessionAuthTime: Math.floor(Date.now() / 1000) } }) },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, unstable_rethrow: () => {} } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })
let settingsMocked = false
async function mockSettings() {
  if (settingsMocked) return
  const realSettings = await import('@/lib/settings-store')
  mock.module('@/lib/settings-store', { namedExports: { ...realSettings, getSettingValue: async (key: string) => stored.get(key) ?? null } })
  settingsMocked = true
}
const upserts: Array<{ key: string; value: string }> = []
const recorder = createRecordingDb((ctx: QueryContext) => {
  if (ctx.model === 'setting' && ctx.op === 'upsert') {
    const a = ctx.args[0] as { where: { key: string }; update: { value: string } }
    upserts.push({ key: a.where.key, value: a.update.value })
    return {}
  }
  if (ctx.model === 'setting' && ctx.op === 'findMany') return []
  return null
})
mock.module('@/lib/db', { namedExports: { db: recorder.db } })

const puts: Array<{ path: string; body: unknown }> = []
mock.module('@/lib/connectors/woocommerce/api', {
  namedExports: {
    wcFetch: async () => ({ data: [{ id: 41, topic: 'order.created', delivery_url: 'https://ims.example.test/api/webhooks/shopping/woocommerce/orders' }], totalPages: 1, totalItems: 1 }),
    wcPost: async () => ({ data: {} }),
    wcPut: async (path: string, body: unknown) => { puts.push({ path, body }); return { data: {} } },
  },
})

test('a rotated secret is kept as the previous one with an expiry; the key stays encrypted at rest', async () => {
  await mockSettings()
  const { saveWcSyncSettings } = await import('@/app/actions/wc-sync')
  upserts.length = 0
  const result = await saveWcSyncSettings({ wc_webhook_secret: 'brand-new-secret' })
  assert.equal(result.success, true, JSON.stringify(result))
  const keys = upserts.map((u) => u.key)
  assert.ok(keys.includes('wc_webhook_secret_previous') && keys.includes('wc_webhook_secret_previous_until'), `previous + expiry written, got ${keys}`)
  const previous = upserts.find((u) => u.key === 'wc_webhook_secret_previous')!
  assert.notEqual(previous.value, 'old-secret', 'stored encrypted')
  const until = Number(upserts.find((u) => u.key === 'wc_webhook_secret_previous_until')!.value)
  assert.ok(until > Date.now() + 47 * 3_600_000 && until < Date.now() + 49 * 3_600_000, 'about 48 hours')
})

test('re-saving the same secret, or a masked one, starts no grace window', async () => {
  await mockSettings()
  const { saveWcSyncSettings } = await import('@/app/actions/wc-sync')
  upserts.length = 0
  await saveWcSyncSettings({ wc_webhook_secret: 'old-secret' })
  await saveWcSyncSettings({ wc_webhook_secret: 'abcd****' })
  assert.equal(upserts.filter((u) => u.key.startsWith('wc_webhook_secret_previous')).length, 0)
})

test('Setup Webhooks pushes the current secret to a hook that already exists', async () => {
  await mockSettings()
  stored.set('wc_webhook_secret', 'current-secret')
  stored.set('public_app_url', 'https://ims.example.test')
  const { createWcWebhooks } = await import('@/app/actions/wc-sync')
  puts.length = 0
  try { await createWcWebhooks() } catch { /* the harness may lack the app URL or shadow seam; the PUT is what is asserted */ }
  assert.equal(puts.length, 1, 'the existing hook was updated')
  assert.deepEqual(puts[0], { path: '/webhooks/41', body: { secret: 'current-secret' } })
})
