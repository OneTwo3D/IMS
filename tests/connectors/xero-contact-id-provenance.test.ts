import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * `Customer.accountingContactId` / `Supplier.accountingContactId` cache a Xero ContactID so that posting
 * an invoice does not re-search for the contact every time. o3d-6nd added a provenance column so an id
 * cached under one organisation is not served to another — and then sampled that provenance from the
 * DATABASE after the API call that issued the id had already returned (the RACE(o3d-gfh) marker).
 *
 * That is the bug these pin: a disconnect and reconnect to a different organisation landing during the
 * in-flight call stamped the NEW organisation onto an id the OLD one issued, and the read guard is an
 * exact match, so it then trusted the false provenance for good. A stale id that is REJECTED costs one
 * lookup; a foreign id that is BELIEVED puts an invoice on the wrong contact in the wrong ledger.
 *
 * There was no test over this file at all before o3d-s36z — items.ts had one and contacts.ts, which
 * carries the same code and the same marker, had none.
 */

type ContactRow = { accountingContactId: string | null; accountingContactProvenance?: string | null } | null

let storedCustomer: ContactRow = null
let storedSupplier: ContactRow = null
/** What the token row says when the provenance is written — i.e. what a resample would pick up. */
let activeTenantId: string | null = 'tenant-A'
/** What the API layer reports each REQUEST went out to. The two differ exactly in the race. */
let issuingTenantId: string | null = 'tenant-A'

const customerUpdates: Array<{ where: unknown; data: unknown }> = []
const supplierUpdates: Array<{ where: unknown; data: unknown }> = []
const getPaths: string[] = []
const postPaths: string[] = []
let getResponses: unknown[] = []
let postResponse: unknown = null

const noContacts = { ok: true, status: 200, data: { Contacts: [] } }

function withIssuer(response: unknown): unknown {
  if (typeof response !== 'object' || response === null) return response
  return { ...(response as Record<string, unknown>), tenantId: issuingTenantId ?? undefined }
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      accountingToken: {
        findUnique: async () => (activeTenantId === null ? null : { tenantId: activeTenantId }),
      },
      customer: {
        findUnique: async () => storedCustomer,
        update: async (args: { where: unknown; data: unknown }) => { customerUpdates.push(args); return {} },
      },
      supplier: {
        findUnique: async () => storedSupplier,
        update: async (args: { where: unknown; data: unknown }) => { supplierUpdates.push(args); return {} },
      },
    },
  },
})
mock.module('@/lib/connectors/xero/api', {
  namedExports: {
    xeroGet: async (path: string) => {
      getPaths.push(path)
      return withIssuer(getResponses.length > 1 ? getResponses.shift() : (getResponses[0] ?? noContacts))
    },
    xeroPost: async (path: string) => { postPaths.push(path); return withIssuer(postResponse) },
  },
})

type FindOrCreateContact = (
  name: string,
  email?: string,
  isSupplier?: boolean,
  ref?: { customerId?: string } | { supplierId?: string },
) => Promise<{ success: boolean; contactId?: string; error?: string }>

let impl: FindOrCreateContact | null = null
const findOrCreateContact: FindOrCreateContact = async (...args) => {
  if (!impl) {
    const m = await import('@/lib/connectors/xero/contacts')
    impl = m.findOrCreateContact as FindOrCreateContact
  }
  return impl(...args)
}

function reset() {
  storedCustomer = null
  storedSupplier = null
  activeTenantId = 'tenant-A'
  issuingTenantId = 'tenant-A'
  customerUpdates.length = 0
  supplierUpdates.length = 0
  getPaths.length = 0
  postPaths.length = 0
  getResponses = [noContacts]
  postResponse = { ok: true, status: 200, data: { Contacts: [{ ContactID: 'created-contact', Name: 'Acme' }] } }
}

test('a stored contact id with matching provenance costs ZERO Xero calls', async () => {
  reset()
  storedCustomer = { accountingContactId: 'contact-123', accountingContactProvenance: 'xero:tenant-A' }

  const res = await findOrCreateContact('Acme', undefined, false, { customerId: 'cust-1' })

  assert.deepEqual(res, { success: true, contactId: 'contact-123' })
  assert.equal(getPaths.length, 0)
})

test('a stored id from a DIFFERENT organisation is re-resolved, not served', async () => {
  reset()
  storedCustomer = { accountingContactId: 'stale-other-org', accountingContactProvenance: 'xero:tenant-OLD' }
  getResponses = [{ ok: true, status: 200, data: { Contacts: [{ ContactID: 'fresh-contact', Name: 'Acme' }] } }]

  const res = await findOrCreateContact('Acme', undefined, false, { customerId: 'cust-1' })

  assert.deepEqual(res, { success: true, contactId: 'fresh-contact' })
  assert.deepEqual(customerUpdates, [{
    where: { id: 'cust-1' },
    data: { accountingContactId: 'fresh-contact', accountingContactProvenance: 'xero:tenant-A' },
  }])
})

test('o3d-gfh: the stamp is the tenant that ISSUED the id, not the one connected when it came back', async () => {
  // The search goes out to tenant-A; the instance is reconnected to tenant-B while it is in flight; the
  // ContactID comes back. Sampling the database HERE — which is what the reverted code did — writes
  // 'xero:tenant-B' onto a contact that only exists in tenant-A, and the exact-match read guard then
  // hands that id straight to an invoice posted into tenant-B.
  reset()
  issuingTenantId = 'tenant-A'
  activeTenantId = 'tenant-B'
  getResponses = [{ ok: true, status: 200, data: { Contacts: [{ ContactID: 'issued-by-A', Name: 'Acme' }] } }]

  const res = await findOrCreateContact('Acme', undefined, false, { customerId: 'cust-1' })

  assert.deepEqual(res, { success: true, contactId: 'issued-by-A' })
  assert.deepEqual(customerUpdates, [{
    where: { id: 'cust-1' },
    data: { accountingContactId: 'issued-by-A', accountingContactProvenance: 'xero:tenant-A' },
  }], 'the issuer is recorded, so the next read against tenant-B rejects it instead of trusting it')
})

test('o3d-gfh: a CREATED contact is stamped with the organisation that created it', async () => {
  reset()
  issuingTenantId = 'tenant-A'
  activeTenantId = 'tenant-B'

  const res = await findOrCreateContact('Acme', undefined, true, { supplierId: 'sup-1' })

  assert.deepEqual(res, { success: true, contactId: 'created-contact' })
  assert.equal(postPaths.length, 1)
  assert.deepEqual(supplierUpdates, [{
    where: { id: 'sup-1' },
    data: { accountingContactId: 'created-contact', accountingContactProvenance: 'xero:tenant-A' },
  }])
})

test('o3d-gfh: the id recovered after a "name already exists" collision keeps its issuer too', async () => {
  reset()
  issuingTenantId = 'tenant-A'
  activeTenantId = 'tenant-B'
  postResponse = { ok: false, status: 400, error: 'Contact name already exists' }
  getResponses = [
    noContacts,
    { ok: true, status: 200, data: { Contacts: [{ ContactID: 'raced-contact', Name: 'Acme' }] } },
  ]

  const res = await findOrCreateContact('Acme', undefined, false, { customerId: 'cust-1' })

  assert.deepEqual(res, { success: true, contactId: 'raced-contact' })
  assert.deepEqual(customerUpdates, [{
    where: { id: 'cust-1' },
    data: { accountingContactId: 'raced-contact', accountingContactProvenance: 'xero:tenant-A' },
  }])
})

test('o3d-gfh: a response with no issuer stamps NULL rather than inventing one', async () => {
  reset()
  issuingTenantId = null
  getResponses = [{ ok: true, status: 200, data: { Contacts: [{ ContactID: 'unattributed', Name: 'Acme' }] } }]

  await findOrCreateContact('Acme', undefined, false, { customerId: 'cust-1' })

  assert.deepEqual(customerUpdates, [{
    where: { id: 'cust-1' },
    data: { accountingContactId: 'unattributed', accountingContactProvenance: null },
  }])
})
