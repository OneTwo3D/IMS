import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { grantXeroWrites } from '../helpers/outbound-grants'

/**
 * A PDF download is built from the connection that answered the lookup, or not sent at all. Driven through the REAL Xero transport
 * (`xeroGetRaw`); only the token resolver, the two policy gates and the socket are replaced. A reconnect between the lookup and the
 * download is simulated by changing what `getAccessToken` answers.
 */
let auth: { accessToken: string; tenantId: string; connectionGeneration: string | null } = { accessToken: 't', tenantId: 'tenant-A', connectionGeneration: 'gen-1' }
const wire: string[] = []

mock.module('@/lib/connectors/xero/auth', {
  namedExports: {
    getAccessToken: async () => { grantXeroWrites(auth.tenantId); return auth },
    getStoredTenantBlockReason: async () => null,
  },
})
mock.module('@/lib/connectors/accounting-posting-intent', { namedExports: { accountingPostingIntentRefusal: () => null } })
mock.module('@/lib/connectors/accounting-egress-authorization', { namedExports: { accountingEgressRefusal: async () => null } })
mock.module('@/lib/security/connector-fetch', {
  namedExports: {
    connectorFetch: async (url: string) => {
      wire.push(url)
      const bytes = Buffer.from('%PDF-1.4 test')
      return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), text: async () => '' } as unknown as Response
    },
  },
})

test('a download under the same organisation and connection is sent and reports which connection served it', async () => {
  auth = { accessToken: 't', tenantId: 'tenant-A', connectionGeneration: 'gen-1' }
  wire.length = 0
  const { xeroGetRaw } = await import('@/lib/connectors/xero/api')
  const res = await xeroGetRaw('Invoices/abc', 'application/pdf', { requireConnection: { tenantId: 'tenant-A', connectionGeneration: 'gen-1' } })
  assert.equal(res.ok, true)
  assert.equal(res.tenantId, 'tenant-A')
  assert.equal(res.connectionGeneration, 'gen-1')
  assert.equal(wire.length, 1)
})

test('a changed generation or organisation between the lookup and the download sends NOTHING', async () => {
  const { xeroGetRaw } = await import('@/lib/connectors/xero/api')
  for (const now of [
    { tenantId: 'tenant-A', connectionGeneration: 'gen-2' },
    { tenantId: 'tenant-B', connectionGeneration: 'gen-1' },
    { tenantId: 'tenant-A', connectionGeneration: null },
  ]) {
    auth = { accessToken: 't', ...now }
    wire.length = 0
    const res = await xeroGetRaw('Invoices/abc', 'application/pdf', { requireConnection: { tenantId: 'tenant-A', connectionGeneration: 'gen-1' } })
    assert.equal(res.ok, false, JSON.stringify(now))
    assert.equal(res.status, 0)
    assert.match(res.error ?? '', /connection changed/i)
    assert.equal(wire.length, 0, 'the request was never built')
  }
})

test('without a required connection the download behaves as before', async () => {
  auth = { accessToken: 't', tenantId: 'tenant-B', connectionGeneration: 'gen-9' }
  const { xeroGetRaw } = await import('@/lib/connectors/xero/api')
  assert.equal((await xeroGetRaw('Invoices/abc')).ok, true)
})
