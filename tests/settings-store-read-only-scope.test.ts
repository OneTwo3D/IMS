import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * READ-ONLY SETTINGS SCOPE (the EU VAT shadow report). A plaintext `xero_client_secret` is re-encrypted by an ordinary read (`setting.updateMany`); inside `withoutSettingMigration` no read, however
 * it is made, writes anything.
 */
process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || 'a'.repeat(64)
const writes: string[] = []
const row = { key: 'xero_client_secret', value: 'plaintext-legacy-secret' }
mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: {
        findMany: async () => [row],
        findUnique: async () => row,
        updateMany: async () => { writes.push('updateMany'); return { count: 1 } },
        update: async () => { writes.push('update'); return row },
        create: async () => { writes.push('create'); return row },
        upsert: async () => { writes.push('upsert'); return row },
      },
    },
  },
})

test('control: an ordinary read of a plaintext secret migrates it', async () => {
  const { getSettingValues } = await import('../lib/settings-store')
  writes.length = 0
  await getSettingValues(['xero_client_secret'])
  assert.deepEqual(writes, ['updateMany'])
})

test('inside withoutSettingMigration neither getSettingValues nor getSettingValue writes, and the value is still returned', async () => {
  const { getSettingValues, getSettingValue, withoutSettingMigration } = await import('../lib/settings-store')
  writes.length = 0
  const [many, one] = await withoutSettingMigration(async () => [await getSettingValues(['xero_client_secret']), await getSettingValue('xero_client_secret')] as const)
  assert.deepEqual(writes, [])
  assert.equal(many.get('xero_client_secret'), 'plaintext-legacy-secret')
  assert.equal(one, 'plaintext-legacy-secret')
  await getSettingValues(['xero_client_secret'])
  assert.deepEqual(writes, ['updateMany'], 'the scope ends with the callback')
})
