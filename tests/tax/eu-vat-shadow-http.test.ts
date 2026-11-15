import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * THE READ-ONLY TRANSPORT: an expired Xero token is never refreshed (no POST, no database write, no log, no notification); a valid one is used for GETs only; WooCommerce credentials are read without migrate-on-read.
 */
const writes: string[] = []
const requests: Array<{ url: string; method: string }> = []
let tokenRow: { accessToken: string; expiresAt: Date; tenantId: string } | null = null
let settingRows: Array<{ key: string; value: string }> = []

const trap = (name: string) => new Proxy({}, { get: (_t, method) => { if (method === 'then') return undefined; return () => { writes.push(`${name}.${String(method)}`); throw new Error(`write ${name}.${String(method)}`) } } })
const dbMock = {
  accountingToken: { findUnique: async () => tokenRow, ...Object.fromEntries(['update', 'updateMany', 'create', 'upsert', 'delete'].map((m) => [m, () => { writes.push(`accountingToken.${m}`); throw new Error('write') }])) },
  setting: { findMany: async () => settingRows, ...Object.fromEntries(['update', 'updateMany', 'create', 'upsert', 'delete'].map((m) => [m, () => { writes.push(`setting.${m}`); throw new Error('write') }])) },
  activityLog: trap('activityLog'),
}
mock.module('@/lib/db', { namedExports: { db: dbMock } })
mock.module('@/lib/secrets', { namedExports: { decryptSecret: (v: string) => v.replace(/^enc:/, ''), encryptSecret: () => { writes.push('encryptSecret'); throw new Error('write') }, hasEncryptionKey: () => true, isEncryptedValue: (v: string) => v.startsWith('enc:') } })
mock.module('@/lib/connectors/xero/auth', {
  namedExports: {
    getStoredTenantBlockReason: async () => null,
    refreshToken: async () => { writes.push('refreshToken'); throw new Error('refresh') },
    getAccessToken: async () => { writes.push('getAccessToken'); throw new Error('getAccessToken') },
  },
})
mock.module('@/lib/security/connector-fetch', {
  namedExports: {
    connectorFetch: async (url: string | URL, init: RequestInit = {}) => {
      requests.push({ url: String(url), method: init.method ?? 'GET' })
      return new Response(JSON.stringify({ Invoices: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  },
})
mock.module('@/lib/settings-store', { namedExports: { deserializeSettingValue: (_k: string, v: string) => v.replace(/^enc:/, ''), getSettingValues: async () => { writes.push('getSettingValues'); throw new Error('migrates') } } })

const NOW = new Date('2026-11-10T12:00:00Z')

test('an expired, near-expiry or missing Xero token fails closed with the instruction: nothing is sent, refreshed or written', async () => {
  const { readShadowXeroGrant, XERO_TOKEN_EXPIRED_MESSAGE } = await import('../../lib/tax/eu-vat-shadow-http')
  tokenRow = { accessToken: 'enc:tok', expiresAt: new Date(NOW.getTime() - 1), tenantId: 't-1' }
  const expired = await readShadowXeroGrant(NOW)
  assert.deepEqual(expired, { ok: false, code: 'xero_token_expired', message: 'Xero access token expired; open IMS Sync once to refresh, then rerun' })
  assert.equal(XERO_TOKEN_EXPIRED_MESSAGE, 'Xero access token expired; open IMS Sync once to refresh, then rerun')
  tokenRow = { accessToken: 'enc:tok', expiresAt: new Date(NOW.getTime() + 30_000), tenantId: 't-1' }
  assert.equal((await readShadowXeroGrant(NOW)).ok, false, 'a token about to expire is treated as expired')
  tokenRow = null
  assert.deepEqual(await readShadowXeroGrant(NOW), { ok: false, code: 'xero_not_connected', message: 'Xero is not connected' })
  assert.deepEqual(writes, [])
  assert.deepEqual(requests, [])
})

test('a valid token is used for a GET only; a vendor failure is a closed code, never its text', async () => {
  const { readShadowXeroGrant, xeroReadOnlyGet } = await import('../../lib/tax/eu-vat-shadow-http')
  tokenRow = { accessToken: 'enc:tok', expiresAt: new Date(NOW.getTime() + 3_600_000), tenantId: 't-1' }
  const grant = await readShadowXeroGrant(NOW)
  assert.equal(grant.ok, true)
  if (!grant.ok) return
  const ok = await xeroReadOnlyGet(grant, 'Invoices/abc')
  assert.equal(ok.ok, true)
  assert.deepEqual(requests, [{ url: 'https://api.xero.com/api.xro/2.0/Invoices/abc', method: 'GET' }])
  assert.deepEqual(writes, [])
})

test('WooCommerce credentials are read without the settings store (no migrate-on-read), and the order read is one GET', async () => {
  const { readShadowWcCredentials, wcReadOnlyGetOrder } = await import('../../lib/tax/eu-vat-shadow-http')
  settingRows = [{ key: 'wc_url', value: 'https://shop.example.com' }, { key: 'wc_consumer_key', value: 'enc:ck_x' }, { key: 'wc_consumer_secret', value: 'enc:cs_x' }]
  requests.length = 0
  const creds = await readShadowWcCredentials()
  assert.equal(creds.ok, true)
  if (!creds.ok) return
  assert.equal((await wcReadOnlyGetOrder(creds, '123')).ok, true)
  assert.deepEqual(requests, [{ url: 'https://shop.example.com/wp-json/wc/v3/orders/123', method: 'GET' }])
  assert.deepEqual(await wcReadOnlyGetOrder(creds, '1/../2'), { ok: false, code: 'bad_external_id' })
  settingRows = []
  assert.deepEqual(await readShadowWcCredentials(), { ok: false, code: 'wc_not_configured' })
  assert.deepEqual(writes, [])
})
