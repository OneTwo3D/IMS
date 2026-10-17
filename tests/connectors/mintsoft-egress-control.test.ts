import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { OUTBOUND_GRANT_ENV, isOutboundWriteHeldText } from '@/lib/security/outbound-write-hold-constants'
import { PRODUCER_CUTOFF_ENV, PRODUCER_HOLD_ENFORCED_ENV } from '@/lib/security/producer-disposition-constants'

/**
 * THE LAST BARRIER IN FRONT OF MINTSOFT, WITH A COUNTER THAT CAN SEE A WRITE.
 *
 * The transport boundary (@/lib/security/connector-fetch) is replaced by a counter, so "no write" is an observed zero rather than
 * the absence of a log line, and the CONTROL arm proves the counter moves: with the producer hold not enforced the very same calls
 * reach it. The outbound-write grant for Mintsoft is SET in every arm (the transport hold would let the write through), so what
 * stops a write in the ON arms is the producer hold alone. Mintsoft is LIVE: no request leaves the box in any arm, and the key
 * lookup is a counter too, because a held write must not even reach for a key (in credentials mode that would mint a new tenant key).
 *
 * This layer is exercised with NO seam in front of it (mintsoftRequest called directly, as a script or a new caller would), which
 * is what "a producer that slipped past every seam still sends nothing" means.
 *
 * Named mutation (shown red in the PR): c  egress-barrier-removed: mintsoftRequest stops asking mintsoftEgressHold.
 */

const BASE = 'https://wms.example.test'
const ENV_KEYS = [PRODUCER_HOLD_ENFORCED_ENV, OUTBOUND_GRANT_ENV.mintsoft, PRODUCER_CUTOFF_ENV.mintsoft, 'SETTINGS_ENCRYPTION_KEY']
const seen: string[] = []
let keyLookups = 0
let configReads = 0

mock.module('@/lib/security/connector-fetch', {
  namedExports: {
    connectorFetch: async (url: URL | string, init?: { method?: string }) => {
      const parsed = new URL(String(url))
      seen.push(`${init?.method ?? 'GET'} ${parsed.pathname}`)
      return new Response('{"Success":true}', { status: 200, headers: { 'content-type': 'application/json' } })
    },
    connectorFetchRedirectsFollowed: () => 0,
  },
})
mock.module('@/lib/connectors/mintsoft/api/auth', {
  namedExports: {
    getMintsoftApiConfiguration: async () => {
      configReads += 1
      return { baseUrl: BASE, authMode: 'api_key', staticApiKey: 'k', username: '', password: '', webhookSecret: '', clientId: '89', orderLookupConnector: null }
    },
    getMintsoftAccessToken: async () => { keyLookups += 1; return 'k' },
    invalidateMintsoftAccessToken: async () => undefined,
  },
})

async function withEnv<T>(values: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const)
  for (const key of ENV_KEYS) delete process.env[key]
  for (const [key, value] of Object.entries(values)) if (value !== undefined) process.env[key] = value
  seen.length = 0
  keyLookups = 0
  configReads = 0
  try { return await fn() } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

const GRANTED = { [OUTBOUND_GRANT_ENV.mintsoft]: `${BASE}|89` }
const HELD = { ...GRANTED, [PRODUCER_HOLD_ENFORCED_ENV]: 'mintsoft', SETTINGS_ENCRYPTION_KEY: 'a1'.repeat(32) }
const LIVE = { ...HELD, [PRODUCER_CUTOFF_ENV.mintsoft]: '2020-01-01T00:00:00Z' }

/** Every WRITE shape the connector uses, including the two that MUTATE THROUGH GET (cancel, mark awaiting confirmation). */
const WRITES: Array<[string, RequestInit | undefined]> = [
  ['/api/Order', { method: 'PUT', body: '{}' }],
  ['/api/Order/5', { method: 'POST', body: '{}' }],
  ['/api/Order/5/Items/9', { method: 'DELETE' }],
  ['/api/Order/5/Comments', { method: 'POST', body: '{}' }],
  ['/api/Order/5/Cancel', undefined],
  ['/api/Order/5/MarkAwaitingConfirmation', undefined],
  ['/api/Product', { method: 'POST', body: '{}' }],
  ['/api/Product/Bundle', { method: 'PUT', body: '{}' }],
  ['/api/ASN', { method: 'PUT', body: '{}' }],
]

async function everyWrite() {
  const { mintsoftRequest } = await import('@/lib/connectors/mintsoft/api/client')
  const results = []
  for (const [path, init] of WRITES) results.push(await mintsoftRequest(path, init))
  return results
}

test('CONTROL: producer hold not enforced and the transport allowed: every write shape reaches the transport', async () => {
  await withEnv(GRANTED, async () => {
    const results = await everyWrite()
    console.log(`# control: ${JSON.stringify(seen)}`)
    assert.equal(seen.length, WRITES.length, 'the counter sees all of them')
    assert.ok(results.every((result) => !result.held))
    assert.equal(keyLookups, WRITES.length)
  })
})

test('ON and no live-from instant, transport allowed: not one write shape reaches the transport, none looks up a key, and every refusal is a hold text', async () => {
  await withEnv(HELD, async () => {
    const results = await everyWrite()
    console.log(`# held: transport calls=${seen.length} key lookups=${keyLookups} config reads=${configReads}`)
    assert.deepEqual(seen, [])
    assert.equal(keyLookups, 0, 'a held write must not reach for a key (in credentials mode that mints a new tenant key)')
    assert.equal(configReads, 0, 'nor read the configuration')
    for (const result of results) {
      assert.equal(result.held, true)
      assert.equal(result.status, 500)
      assert.equal(result.data, null)
      assert.match(result.error ?? '', /^Outbound write HELD \(Mintsoft\)/)
      assert.equal(isOutboundWriteHeldText(result.error), true, 'a queue that recognises a hold spends no attempt on it')
    }
  })
})

test('ON, grant and an instant in the FUTURE, and an UNREADABLE instant: still nothing reaches the transport', async () => {
  for (const instant of ['2999-01-01T00:00:00Z', '2020-01-01']) {
    await withEnv({ ...HELD, [PRODUCER_CUTOFF_ENV.mintsoft]: instant }, async () => {
      await everyWrite()
      assert.deepEqual(seen, [], instant)
    })
  }
})

test('ON, grant and an instant that has passed (the live phase): the writes reach the transport again', async () => {
  await withEnv(LIVE, async () => {
    await everyWrite()
    assert.equal(seen.length, WRITES.length)
  })
})

test('ON for another destination only, or for all: only "all" and "mintsoft" hold Mintsoft; a misspelling holds it too', async () => {
  await withEnv({ ...GRANTED, [PRODUCER_HOLD_ENFORCED_ENV]: 'xero,woocommerce' }, async () => {
    await everyWrite()
    assert.equal(seen.length, WRITES.length)
  })
  for (const value of ['all', 'mintsoft', 'mintsof']) {
    await withEnv({ ...GRANTED, SETTINGS_ENCRYPTION_KEY: 'a1'.repeat(32), [PRODUCER_HOLD_ENFORCED_ENV]: value }, async () => {
      await everyWrite()
      assert.deepEqual(seen, [], value)
    })
  }
})

test('a READ is never held by the producer hold: every allow-listed read reaches the transport when the hold is ON', async () => {
  const { mintsoftRequest } = await import('@/lib/connectors/mintsoft/api/client')
  await withEnv(HELD, async () => {
    for (const path of ['/api/Warehouse', '/api/Order/Search?OrderNumber=1', '/api/Order/5', '/api/Order/5/Items', '/api/Product/StockLevels?WarehouseId=1', '/api/ASN/List']) {
      const result = await mintsoftRequest(path)
      assert.equal(result.held, undefined, path)
    }
    assert.equal(seen.length, 6)
    assert.ok(seen.every((entry) => entry.startsWith('GET ')))
  })
})
