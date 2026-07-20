import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// o3d-e2j: xeroGetCached serves Xero REFERENCE data (tax rates, organisation) from a TTL cache so the
// same reference GET is not re-fetched on every invoice/UI read, against Xero's 1,000-call/24h cap. It
// must (a) only cache an explicit allowlist, (b) never cache a failure, (c) key by tenant, (d) honour TTL.

let tenantId: string | null = 'tenant-A'
let fetchCalls = 0
let nextStatus = 200
let nextBody: unknown = { TaxRates: [{ TaxType: 'OUTPUT2', Name: 'Standard', EffectiveRate: 20, Status: 'ACTIVE' }] }
let nowMs = 1_000_000

function fakeResponse() {
  const status = nextStatus
  const body = JSON.stringify(nextBody)
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => JSON.parse(body),
    text: async () => body,
  } as unknown as Response
}

mock.module('@/lib/security/connector-fetch', {
  namedExports: {
    connectorFetch: async () => { fetchCalls += 1; return fakeResponse() },
  },
})
mock.module('@/lib/connectors/xero/auth', {
  namedExports: {
    getAccessToken: async () => (tenantId === null ? null : { accessToken: 'tok', tenantId }),
  },
})
// Date.now is used for TTL; make it controllable.
const realNow = Date.now
mock.method(Date, 'now', () => nowMs)

type Api = typeof import('@/lib/connectors/xero/api')
let api: Api | null = null
async function load(): Promise<Api> {
  if (!api) api = await import('@/lib/connectors/xero/api')
  return api
}

function reset() {
  tenantId = 'tenant-A'
  fetchCalls = 0
  nextStatus = 200
  nextBody = { TaxRates: [{ TaxType: 'OUTPUT2' }] }
  nowMs = 1_000_000
}

test('a non-allowlisted path is refused, never cached or fetched', async () => {
  reset()
  const { xeroGetCached } = await load()
  await assert.rejects(() => xeroGetCached('Invoices?where=Status=="AUTHORISED"', 1000), /refused/)
  assert.equal(fetchCalls, 0)
})

test('allowlist is EXACT — a dot-segment or query that resolves to a live endpoint is refused (o3d-e2j)', async () => {
  reset()
  const { xeroGetCached } = await load()
  // These normalise to /Invoices downstream; a head-only guard would have passed them. Exact match rejects.
  for (const evil of [
    'TaxRates/../Invoices/abc',
    'Organisation/%2e%2e/Invoices',
    'TaxRates?where=Name!="x"',
    'TaxRatesFoo',
    '/Organisation',
  ]) {
    await assert.rejects(() => xeroGetCached(evil, 1000), /refused/, evil)
  }
  assert.equal(fetchCalls, 0, 'nothing crafted should have reached the network')
})

test('a disconnected call neither serves nor populates the cache (o3d-e2j #4)', async () => {
  reset()
  const { xeroGetCached, clearXeroReferenceCache } = await load()
  clearXeroReferenceCache()
  await xeroGetCached('TaxRates', 60_000)
  assert.equal(fetchCalls, 1)
  tenantId = null
  const res = await xeroGetCached('TaxRates', 60_000)
  assert.equal(res.ok, false)
  assert.equal(res.status, 0)
  assert.equal(fetchCalls, 1, 'disconnected read must not fetch either')
  tenantId = 'tenant-A'
  await xeroGetCached('TaxRates', 60_000)
  assert.equal(fetchCalls, 1, 'reconnect still serves the original tenant entry')
})

test('a second read within TTL is served from cache — zero extra Xero calls', async () => {
  reset()
  const { xeroGetCached, clearXeroReferenceCache } = await load()
  clearXeroReferenceCache()
  await xeroGetCached('TaxRates', 60_000)
  await xeroGetCached('TaxRates', 60_000)
  assert.equal(fetchCalls, 1, 'the second read must hit the cache')
})

test('the cache expires after ttlMs', async () => {
  reset()
  const { xeroGetCached, clearXeroReferenceCache } = await load()
  clearXeroReferenceCache()
  await xeroGetCached('TaxRates', 60_000)
  nowMs += 60_001
  await xeroGetCached('TaxRates', 60_000)
  assert.equal(fetchCalls, 2, 'past the TTL it must re-fetch')
})

test('a failed response is NOT cached — the next read retries', async () => {
  reset()
  const { xeroGetCached, clearXeroReferenceCache } = await load()
  clearXeroReferenceCache()
  nextStatus = 500
  await xeroGetCached('Organisation', 60_000)
  await xeroGetCached('Organisation', 60_000)
  assert.equal(fetchCalls, 2, 'an error must never be pinned for the TTL')
})

test('cache is keyed by tenant — a different org never serves the previous org data', async () => {
  reset()
  const { xeroGetCached, clearXeroReferenceCache } = await load()
  clearXeroReferenceCache()
  tenantId = 'tenant-A'
  await xeroGetCached('TaxRates', 60_000)
  tenantId = 'tenant-B'
  await xeroGetCached('TaxRates', 60_000)
  assert.equal(fetchCalls, 2, 'tenant B must not read tenant A cache')
})

test('clearXeroReferenceCache forces a re-fetch', async () => {
  reset()
  const { xeroGetCached, clearXeroReferenceCache } = await load()
  clearXeroReferenceCache()
  await xeroGetCached('TaxRates', 60_000)
  clearXeroReferenceCache()
  await xeroGetCached('TaxRates', 60_000)
  assert.equal(fetchCalls, 2)
})

test.after(() => { Date.now = realNow })
