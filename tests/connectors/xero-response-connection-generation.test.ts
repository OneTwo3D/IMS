import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-llyw — A XERO RESPONSE CARRIES THE CONNECTION GENERATION OF THE TOKEN ITS REQUEST WAS BUILT FROM.
 *
 * The operator-ledger-check rule binds a check to the Xero connection that served the probe the operator
 * was shown, and to nothing looser: tenant AND generation (re-minted at every binding, so A->B->A is
 * visible). That identity has to come from the REQUEST, not from a database read after the call — a read
 * after is a resample (the r5 defect). So `getAccessToken` returns the generation from the same token row
 * it returns the tenant from, and every response the transport builds after resolving auth carries both.
 */

let auth: { accessToken: string; tenantId: string; connectionGeneration: string | null } | null
let status = 200

mock.module('@/lib/connectors/xero/auth', {
  namedExports: {
    getAccessToken: async () => auth,
    getStoredTenantBlockReason: async () => null,
  },
})
mock.module('@/lib/connectors/accounting-posting-intent', { namedExports: { accountingPostingIntentRefusal: () => null } })
mock.module('@/lib/connectors/accounting-egress-authorization', { namedExports: { accountingEgressRefusal: async () => null } })
mock.module('@/lib/security/connector-fetch', {
  namedExports: {
    connectorFetch: async () => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      json: async () => ({ Invoices: [] }),
      text: async () => '{"Message":"nope"}',
    }) as unknown as Response,
  },
})

test('[o3d-llyw] a successful GET carries the tenant AND the connection generation its request was built from', async () => {
  const { xeroGet } = await import('@/lib/connectors/xero/api')
  auth = { accessToken: 'tok', tenantId: `tenant-${process.pid}-a`, connectionGeneration: 'gen-7' }
  status = 200
  const res = await xeroGet('Invoices/INV-1')
  console.log(`[precondition] ok=${res.ok} tenant=${res.tenantId} generation=${res.connectionGeneration}`)
  assert.equal(res.ok, true, 'precondition: the request was made and answered')
  assert.equal(res.tenantId, auth.tenantId)
  assert.equal(res.connectionGeneration, 'gen-7')
})

test('[o3d-llyw] a connection that predates the generation column says so (null), and so does a failed read', async () => {
  const { xeroGet } = await import('@/lib/connectors/xero/api')
  auth = { accessToken: 'tok', tenantId: `tenant-${process.pid}-b`, connectionGeneration: null }
  status = 200
  const legacy = await xeroGet('Invoices/INV-2')
  assert.equal(legacy.ok, true)
  assert.equal(legacy.connectionGeneration, null)
  auth = { accessToken: 'tok', tenantId: `tenant-${process.pid}-c`, connectionGeneration: 'gen-8' }
  status = 404
  const failed = await xeroGet('Invoices/INV-3')
  assert.equal(failed.ok, false)
  assert.equal(failed.connectionGeneration, 'gen-8', 'a failed read is still a fact about one connection')
})

test('[o3d-llyw] no connection, no identity: nothing was requested', async () => {
  const { xeroGet } = await import('@/lib/connectors/xero/api')
  auth = null
  const res = await xeroGet('Invoices/INV-4')
  assert.equal(res.ok, false)
  assert.equal(res.tenantId, undefined)
  assert.equal(res.connectionGeneration, undefined)
})
