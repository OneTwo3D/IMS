import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { OUTBOUND_GRANT_ENV } from '@/lib/security/outbound-write-hold-constants'
import { PRODUCER_CUTOFF_ENV, PRODUCER_HOLD_ENFORCED_ENV } from '@/lib/security/producer-disposition-constants'

/**
 * THE LAST BARRIER, WITH A COUNTER THAT CAN SEE A WRITE.
 *
 * The transport boundary (@/lib/security/connector-fetch) is replaced by a counter, so "no write" is an observed zero rather
 * than the absence of a log line, and the CONTROL arms prove the counter moves: with the producer hold not enforced the very
 * same call reaches it. The outbound-write grant for the store is SET in every arm (the transport hold would let the write
 * through), so what stops a write in the ON arms is the producer hold alone. No request leaves the box in any arm.
 *
 * This is the layer that a producer which slipped past every seam still meets: it is exercised here with NO seam in front of it
 * (wcPost and wcPut called directly, as a script or a new caller would call them).
 */

const ORIGIN = 'https://shop.example.com'
const ENV_KEYS = [PRODUCER_HOLD_ENFORCED_ENV, OUTBOUND_GRANT_ENV.woocommerce, PRODUCER_CUTOFF_ENV.woocommerce]
const seen: string[] = []

mock.module('@/lib/security/connector-fetch', {
  namedExports: {
    connectorFetch: async (url: string, init?: { method?: string }) => {
      seen.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`)
      return new Response('{"id":1}', { status: 200, headers: { 'content-type': 'application/json' } })
    },
  },
})
mock.module('@/lib/settings-store', {
  namedExports: {
    getSettingValues: async (keys: string[]) => new Map(keys.flatMap((key) => (({ wc_url: ORIGIN, wc_webhook_secret: 's', wc_fx_push_enabled: 'true' } as Record<string, string>)[key] ? [[key, ({ wc_url: ORIGIN, wc_webhook_secret: 's', wc_fx_push_enabled: 'true' } as Record<string, string>)[key]!] as const] : []))),
    getSettingValue: async () => null,
  },
})
mock.module('@/lib/db', { namedExports: { db: { shoppingOrderLink: { findFirst: async () => ({ externalOrderId: '42' }) }, setting: { findUnique: async () => null } } } })

async function withEnv<T>(values: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const)
  for (const key of ENV_KEYS) delete process.env[key]
  for (const [key, value] of Object.entries(values)) if (value !== undefined) process.env[key] = value
  seen.length = 0
  try { return await fn() } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

const creds = { url: ORIGIN, key: 'ck_x', secret: 'cs_x' }
const GRANTED = { [OUTBOUND_GRANT_ENV.woocommerce]: ORIGIN }
const HELD = { ...GRANTED, [PRODUCER_HOLD_ENFORCED_ENV]: 'woocommerce' }
const LIVE = { ...HELD, [PRODUCER_CUTOFF_ENV.woocommerce]: '2020-01-01T00:00:00Z' }

async function everyWrite() {
  const { wcPost, wcPut } = await import('@/lib/connectors/woocommerce/api')
  const { pushFxRatesToWc, probeFxHelperPlugin } = await import('@/lib/connectors/woocommerce/fx-rates')
  const { pushPartialShipmentToWc } = await import('@/lib/connectors/woocommerce/sync/partial-shipment')
  return [
    await wcPost('/webhooks', {}, creds),
    await wcPut('/orders/1', { status: 'completed' }, creds),
    await pushFxRatesToWc([{ currency: 'USD', rate: 1.2 } as never]),
    await probeFxHelperPlugin(),
    await pushPartialShipmentToWc('o-1', { part: 1, totalParts: 2, items: [{ sku: 'A', qty: 1 }] }),
  ]
}

test('CONTROL: producer hold not enforced and the transport allowed: every one of the five writers reaches the transport', async () => {
  await withEnv(GRANTED, async () => {
    await everyWrite()
    console.log(`# control: ${JSON.stringify(seen)}`)
    assert.equal(seen.length, 5, 'the counter sees all five writers')
    assert.ok(seen.every((entry) => entry.startsWith('POST ') || entry.startsWith('PUT ')))
  })
})

test('ON and no live-from instant, transport allowed: not one write reaches the transport from any of the five writers', async () => {
  await withEnv(HELD, async () => {
    const results = await everyWrite()
    console.log(`# held: transport calls=${seen.length}`)
    assert.deepEqual(seen, [])
    for (const result of results.slice(0, 1)) assert.equal((result as { held?: boolean }).held, true)
  })
})

test('ON, grant and an instant in the FUTURE: still nothing reaches the transport', async () => {
  await withEnv({ ...HELD, [PRODUCER_CUTOFF_ENV.woocommerce]: '2999-01-01T00:00:00Z' }, async () => {
    await everyWrite()
    assert.deepEqual(seen, [])
  })
})

test('ON, grant and an instant that has passed (the live phase): the writes reach the transport again', async () => {
  await withEnv(LIVE, async () => {
    await everyWrite()
    assert.equal(seen.length, 5)
  })
})

test('ON for another destination only: WooCommerce writers are untouched', async () => {
  await withEnv({ ...GRANTED, [PRODUCER_HOLD_ENFORCED_ENV]: 'xero' }, async () => {
    await everyWrite()
    assert.equal(seen.length, 5)
  })
})

test('a READ is never held by the producer hold: wcFetch reaches the transport when the hold is ON', async () => {
  const { wcFetch } = await import('@/lib/connectors/woocommerce/api')
  await withEnv(HELD, async () => {
    await wcFetch('/orders', {}, creds)
    assert.deepEqual(seen, ['GET /wp-json/wc/v3/orders'])
  })
})
