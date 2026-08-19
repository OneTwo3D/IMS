import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-512h — action-level control on the generic settings read.
 *
 * app/actions/settings.ts:getSetting is a `'use server'` export taking an
 * arbitrary key, and lib/settings-store.ts:deserializeSettingValue DECRYPTS the
 * keys in SENSITIVE_SETTING_KEYS. Guarded only by requireAuth, it therefore
 * returned stored credentials in clear to ANY authenticated principal.
 *
 * This is the case that shows a page gate is not a substitute for an action
 * gate: the settings pages are now permission-gated, and this endpoint was
 * still reachable without going near them.
 */

type Role = 'ADMIN' | 'WAREHOUSE' | 'READONLY' | 'SUPPLIER'
let currentRole: Role = 'WAREHOUSE'

mock.module('@/lib/auth', {
  namedExports: {
    auth: async () => ({
      user: { id: 'u1', email: 'u@example.test', name: 'U', role: currentRole },
    }),
  },
})

// NOTE: '@/lib/settings-store' must be imported DYNAMICALLY, below the mocks.
// A static import is hoisted, so it would evaluate settings-store — and with it
// its own '@/lib/db' import — before mock.module registers, and the tests would
// open a real Postgres connection.
mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: {
        findUnique: async () => null,
        findMany: async () => [],
      },
    },
  },
})

test('SENSITIVE_SETTING_KEYS still contains the credentials this test is about', async () => {
  const { SENSITIVE_SETTING_KEYS } = await import('@/lib/settings-store')
  // If a key is renamed out of the set the gate silently stops covering it, so
  // pin the ones that motivated the fix.
  for (const key of ['email_smtp_pass', 'wc_consumer_secret', 'xero_client_secret', 'mintsoft_api_key']) {
    assert.ok(SENSITIVE_SETTING_KEYS.has(key), `${key} must be treated as sensitive`)
  }
})

for (const role of ['WAREHOUSE', 'READONLY', 'SUPPLIER'] as const) {
  test(`getSetting refuses a ${role} session reading the decrypted SMTP password, naming the settings permission`, async () => {
    currentRole = role
    const { getSetting } = await import('@/app/actions/settings')
    await assert.rejects(
      () => getSetting('email_smtp_pass'),
      (error: unknown) => {
        assert.equal((error as { permission?: string }).permission, 'settings')
        assert.match(String((error as Error).message), /Forbidden: missing permission settings/)
        return true
      },
    )
  })
}

test('getSetting refuses a WAREHOUSE session for every sensitive key, not just the sampled ones', async () => {
  currentRole = 'WAREHOUSE'
  const { SENSITIVE_SETTING_KEYS } = await import('@/lib/settings-store')
  const { getSetting } = await import('@/app/actions/settings')
  for (const key of SENSITIVE_SETTING_KEYS) {
    await assert.rejects(
      () => getSetting(key),
      (error: unknown) => (error as { permission?: string }).permission === 'settings',
      `sensitive key ${key} must not be readable by WAREHOUSE`,
    )
  }
})

test('getSetting still serves a NON-sensitive key to a WAREHOUSE session', async () => {
  // The gate must be scoped to secrets. Ordinary settings (timezone, FX
  // schedule, retention windows) are read by pages every role can see, so
  // over-gating here would be an outage, not a fix.
  currentRole = 'WAREHOUSE'
  const { getSetting } = await import('@/app/actions/settings')
  assert.equal(await getSetting('financial_year_start'), null)
})

test('getSetting serves a sensitive key to ADMIN', async () => {
  currentRole = 'ADMIN'
  const { getSetting } = await import('@/app/actions/settings')
  assert.equal(await getSetting('email_smtp_pass'), null)
})
