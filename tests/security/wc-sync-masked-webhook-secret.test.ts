import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { createRecordingDb, type QueryContext } from './recording-db'

/** SEC-M8: a masked wc_webhook_secret skips the step-up gate, so it must not be written either. */
process.env.SETTINGS_ENCRYPTION_KEY = 'wc_webhook_mask_test_key_______'
delete process.env.ENCRYPTION_KEY

mock.module('@/lib/auth', {
  namedExports: {
    auth: async () => ({ user: { id: 'u1', email: 'u@example.test', name: 'U', role: 'ADMIN', sessionAuthTime: Date.now() } }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, unstable_rethrow: () => {} } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })

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

test('saveWcSyncSettings never writes a masked wc_webhook_secret, and still writes a real one', async () => {
  const { saveWcSyncSettings } = await import('@/app/actions/wc-sync')

  upserts.length = 0
  const masked = await saveWcSyncSettings({ wc_webhook_secret: 'abcd****' })
  assert.equal(masked.success, true)
  assert.equal(upserts.length, 0, 'a masked secret must not be stored')

  upserts.length = 0
  const real = await saveWcSyncSettings({ wc_webhook_secret: 'a-real-new-secret' })
  if (real.success) {
    assert.deepEqual(upserts.map((u) => u.key), ['wc_webhook_secret'])
    assert.notEqual(upserts[0]!.value, 'a-real-new-secret', 'stored encrypted')
  } else {
    // A stale/absent fresh-auth session in the harness is a refusal, never a write.
    assert.equal(upserts.length, 0)
  }
})
