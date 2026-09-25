import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// o3d-6nd: the QuickBooks payment/follow-up paths read a cached contact id via a join, NOT through
// getStoredContactId, so they need the provenance guard applied there too — otherwise a former realm's
// id is sent to the active company as CustomerRef/VendorRef. This pins that the shared guard yields the
// id only when its provenance matches the active connection, and null (=> clean missing-reference
// failure) otherwise.

let activeTenantId: string | null = 'realm-A'

mock.module('@/lib/db', {
  namedExports: {
    db: {
      accountingToken: {
        findUnique: async () => (activeTenantId === null ? null : { tenantId: activeTenantId }),
      },
    },
  },
})

let impl: ((c: unknown) => Promise<string | null>) | null = null
async function guard(contact: unknown): Promise<string | null> {
  if (!impl) {
    const m = await import('@/lib/connectors/quickbooks/sync-processor')
    impl = m.customerContactIdIfCurrent as (c: unknown) => Promise<string | null>
  }
  return impl(contact)
}

test('a matching-realm contact id is used', async () => {
  activeTenantId = 'realm-A'
  assert.equal(await guard({ accountingContactId: '42', accountingContactProvenance: 'quickbooks:realm-A' }), '42')
})

test('a former-realm contact id is NOT used (the core leak)', async () => {
  activeTenantId = 'realm-B'
  assert.equal(await guard({ accountingContactId: '42', accountingContactProvenance: 'quickbooks:realm-A' }), null)
})

test('a legacy NULL-provenance contact id is NOT used', async () => {
  activeTenantId = 'realm-A'
  assert.equal(await guard({ accountingContactId: '42', accountingContactProvenance: null }), null)
})

test('a missing contact or id is null, not a throw', async () => {
  activeTenantId = 'realm-A'
  assert.equal(await guard(null), null)
  assert.equal(await guard({ accountingContactId: null, accountingContactProvenance: 'quickbooks:realm-A' }), null)
})

test('no live token trusts nothing', async () => {
  activeTenantId = null
  assert.equal(await guard({ accountingContactId: '42', accountingContactProvenance: 'quickbooks:realm-A' }), null)
})
