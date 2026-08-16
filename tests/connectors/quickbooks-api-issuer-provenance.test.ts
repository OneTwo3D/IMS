import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// ---------------------------------------------------------------------------
// o3d-9kek r4 finding 2, the wiring half. The capture mechanism is only worth anything if the HTTP
// client actually reports the realm it used, at the point it uses it — every QuickBooks request
// (document post, contact lookup, PDF download, attachment upload) funnels through performRequest
// holding the auth snapshot the URL was built from, and that is the only place that knows the
// answer without guessing.
//
// getAccessToken is driven to return a DIFFERENT realm on the second call, which is what a
// disconnect + re-auth mid-entry looks like from in here.
// ---------------------------------------------------------------------------

let realmQueue: string[] = []
const requestedUrls: string[] = []

mock.module('@/lib/db', { namedExports: { db: {} } })
mock.module('@/lib/connectors/quickbooks/auth', {
  namedExports: {
    getAccessToken: async () => {
      const realmId = realmQueue.length > 1 ? realmQueue.shift()! : realmQueue[0]
      return { accessToken: 'token', realmId }
    },
  },
})
mock.module('@/lib/connectors/quickbooks/settings', {
  namedExports: { getQuickBooksSettings: async () => ({ quickbooks_use_sandbox: 'false' }) },
})
mock.module('@/lib/security/connector-fetch', {
  namedExports: {
    connectorFetch: async (url: string) => {
      requestedUrls.push(url)
      return { ok: true, status: 200, json: async () => ({ Bill: { Id: '42' } }), text: async () => '' }
    },
  },
})

test('[o3d-9kek r4 f2] the QuickBooks client records the realm each request is actually made against', async () => {
  realmQueue = ['realm-A']
  requestedUrls.length = 0
  const { captureIssuerProvenance } = await import('@/lib/domain/accounting/issuer-provenance')
  const { qboPost } = await import('@/lib/connectors/quickbooks/api')

  const { issuer } = await captureIssuerProvenance(() => qboPost('bill', {}))

  assert.deepEqual(issuer, { outcome: 'single', provenance: 'quickbooks:realm-A' })
  // The recorded realm is the SAME one that went into the URL — not a separate lookup that could
  // disagree with it.
  assert.match(requestedUrls[0], /\/v3\/company\/realm-A\/bill/)
})

test('[o3d-9kek r4 f2] two requests in one entry landing on different realms are reported as a conflict', async () => {
  // The contact resolves against realm A; the operator re-authorises; the document posts to realm B.
  // Nothing about the resulting id can be recorded honestly, and this is where that becomes visible.
  realmQueue = ['realm-A', 'realm-B']
  requestedUrls.length = 0
  const { captureIssuerProvenance } = await import('@/lib/domain/accounting/issuer-provenance')
  const { qboPost } = await import('@/lib/connectors/quickbooks/api')

  const { issuer } = await captureIssuerProvenance(async () => {
    await qboPost('vendor', {})
    await qboPost('bill', {})
  })

  assert.equal(issuer.outcome, 'conflicting')
  assert.deepEqual(issuer.outcome === 'conflicting' ? issuer.observed : [], ['quickbooks:realm-A', 'quickbooks:realm-B'])
  assert.match(requestedUrls[0], /\/company\/realm-A\//)
  assert.match(requestedUrls[1], /\/company\/realm-B\//)
})
