import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test, { mock } from 'node:test'

import { OUTBOUND_GRANT_ENV } from '@/lib/security/outbound-write-hold-constants'
import { PRODUCER_HOLD_ENFORCED_ENV } from '@/lib/security/producer-disposition-constants'

/**
 * THE TRACKSHIP RE-FIRE TRANSPORT AND ITS PURE PARTS. The transport boundary is replaced by a recorder, so "nothing was sent" is an observed zero and
 * the arms that do send prove the recorder moves. No request leaves the box.
 */

const ORIGIN = 'https://shop.example.com'
const SECRET = 'shared-secret'
const calls: Array<{ method: string; url: string; headers: Record<string, string>; body: string }> = []
let answer: () => Response = () => new Response('{"ok":true,"result":"covered","missing":0}', { status: 200, headers: { 'content-type': 'application/json' } })
let throwOnSend: Error | null = null

mock.module('@/lib/security/connector-fetch', {
  namedExports: {
    connectorFetch: async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
      if (throwOnSend) throw throwOnSend
      calls.push({ method: init?.method ?? 'GET', url: String(url), headers: init?.headers ?? {}, body: init?.body ?? '' })
      return answer()
    },
  },
})
let settings = new Map<string, string>([['wc_url', ORIGIN], ['wc_webhook_secret', SECRET]])
mock.module('@/lib/settings-store', {
  namedExports: {
    getSettingValues: async (keys: string[]) => new Map(keys.flatMap((key) => (settings.has(key) ? [[key, settings.get(key)!] as const] : []))),
    getSettingValue: async (key: string) => settings.get(key) ?? null,
  },
})

const ENV_KEYS = [PRODUCER_HOLD_ENFORCED_ENV, OUTBOUND_GRANT_ENV.woocommerce]
async function withEnv<T>(values: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const)
  for (const key of ENV_KEYS) delete process.env[key]
  Object.assign(process.env, values)
  calls.length = 0
  throwOnSend = null
  settings = new Map([['wc_url', ORIGIN], ['wc_webhook_secret', SECRET]])
  answer = () => new Response('{"ok":true,"result":"covered","missing":0}', { status: 200, headers: { 'content-type': 'application/json' } })
  try { return await fn() } finally {
    for (const key of ENV_KEYS) delete process.env[key]
    for (const [key, value] of saved) if (value !== undefined) process.env[key] = value
  }
}
const GRANTED = { [OUTBOUND_GRANT_ENV.woocommerce]: ORIGIN }
const HELD = { ...GRANTED, [PRODUCER_HOLD_ENFORCED_ENV]: 'woocommerce' }

test('back-off: 5 minutes, doubling, capped at 24 hours, and never overflowing', async () => {
  const { trackshipRefireBackoffMs, TRACKSHIP_REFIRE_BACKOFF_MAX_MS } = await import('@/lib/connectors/woocommerce/sync/trackship-refire')
  const minutes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => trackshipRefireBackoffMs(n) / 60_000)
  assert.deepEqual(minutes, [5, 10, 20, 40, 80, 160, 320, 640, 1280, 1440])
  assert.equal(trackshipRefireBackoffMs(11), TRACKSHIP_REFIRE_BACKOFF_MAX_MS, 'the cap holds')
  assert.equal(trackshipRefireBackoffMs(500), TRACKSHIP_REFIRE_BACKOFF_MAX_MS, 'a huge count cannot overflow past the cap')
  assert.equal(trackshipRefireBackoffMs(0), 5 * 60_000, 'a count below one reads as the first look')
})

test('the storefront answer maps to a closed outcome vocabulary', async () => {
  const { classifyTrackshipRefireResponse: c } = await import('@/lib/connectors/woocommerce/sync/trackship-refire')
  assert.deepEqual(c(200, { result: 'covered' }), { kind: 'covered' })
  assert.deepEqual(c(200, { result: 'fired', missing: 2 }), { kind: 'fired', missing: 2 })
  assert.deepEqual(c(200, { result: 'not_eligible', missing: 1 }), { kind: 'not-eligible', missing: 1 })
  assert.deepEqual(c(200, { result: 'no_tracking' }), { kind: 'no-tracking' })
  assert.deepEqual(c(200, { result: 'outside_window' }), { kind: 'outside-window' })
  assert.deepEqual(c(404, { code: 'oti_ts_not_found' }), { kind: 'order-gone' })
  assert.equal(c(200, { result: 'something-new' }).kind, 'failed', 'an unknown result is never recorded as done')
  assert.equal(c(200, null).kind, 'failed')
  const missingRoute = c(404, { code: 'rest_no_route' })
  assert.equal(missingRoute.kind, 'failed', 'a missing route is a failure, not "the order is gone"')
  assert.match(missingRoute.kind === 'failed' ? missingRoute.error : '', /1\.4\.0/)
  for (const status of [401, 409, 500, 503]) assert.equal(c(status, { result: 'trackship_inactive' }).kind, 'failed', `HTTP ${status}`)
})

test('an allowed send is ONE signed POST to the companion plugin route for that order', async () => {
  await withEnv(GRANTED, async () => {
    const { postTrackshipRefire } = await import('@/lib/connectors/woocommerce/sync/trackship-refire')
    const outcome = await postTrackshipRefire('4242')
    assert.deepEqual(outcome, { kind: 'covered' })
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.method, 'POST')
    assert.equal(calls[0]!.url, `${ORIGIN}/wp-json/oti/v1/order/4242/trackship-refire`)
    const sent = JSON.parse(calls[0]!.body) as { order_id: number; ts: number; nonce: string }
    assert.equal(sent.order_id, 4242, 'the body names the order')
    assert.match(sent.nonce, /^[0-9a-f]{32}$/)
    assert.equal(calls[0]!.headers['X-OTI-Timestamp'], String(sent.ts))
    assert.equal(
      calls[0]!.headers['X-OTI-Signature'],
      createHmac('sha256', SECRET).update(`${sent.ts}\nPOST\n/wp-json/oti/v1/order/4242/trackship-refire\n${calls[0]!.body}`).digest('hex'),
      'HMAC-SHA256 of timestamp, method, path (the order id) and the raw body',
    )
    assert.ok(Math.abs(sent.ts - Date.now() / 1000) < 5)
  })
})

test('REGRESSION: the signature binds the order id, the method, the timestamp and the body, so a captured request cannot be pointed at another order', async () => {
  const { signTrackshipRefire } = await import('@/lib/connectors/woocommerce/sync/trackship-refire')
  const base = { timestamp: 1_700_000_000, orderId: '4242', body: '{"order_id":4242,"ts":1700000000,"nonce":"aa"}' }
  const sig = signTrackshipRefire(base, SECRET)
  assert.notEqual(sig, signTrackshipRefire({ ...base, orderId: '4243' }, SECRET), 'another order id (path) signs differently')
  assert.notEqual(sig, signTrackshipRefire({ ...base, timestamp: base.timestamp + 1 }, SECRET), 'another timestamp signs differently')
  assert.notEqual(sig, signTrackshipRefire({ ...base, body: '{}' }, SECRET), 'another body signs differently')
  assert.notEqual(signTrackshipRefire(base, SECRET), signTrackshipRefire(base, 'other-secret'))
})

test('two sends of the same order carry different nonces', async () => {
  await withEnv(GRANTED, async () => {
    const { postTrackshipRefire } = await import('@/lib/connectors/woocommerce/sync/trackship-refire')
    await postTrackshipRefire('7'); await postTrackshipRefire('7')
    assert.notEqual((JSON.parse(calls[0]!.body) as { nonce: string }).nonce, (JSON.parse(calls[1]!.body) as { nonce: string }).nonce)
  })
})

test('a storefront order id that is not a positive integer is never put in a signed path', async () => {
  await withEnv(GRANTED, async () => {
    const { postTrackshipRefire } = await import('@/lib/connectors/woocommerce/sync/trackship-refire')
    for (const id of ['', '0', '12/../9', '1;2', '-5', 'abc']) assert.equal((await postTrackshipRefire(id)).kind, 'failed', id)
    assert.equal(calls.length, 0)
  })
})

test('a held destination sends nothing: the egress barrier answers held and the transport is never reached', async () => {
  await withEnv(HELD, async () => {
    const { postTrackshipRefire } = await import('@/lib/connectors/woocommerce/sync/trackship-refire')
    const outcome = await postTrackshipRefire('4242')
    assert.equal(outcome.kind, 'failed')
    assert.equal(outcome.kind === 'failed' && outcome.held, true)
    assert.equal(calls.length, 0, 'nothing left IMS')
  })
})

test('no URL or no secret: nothing is sent', async () => {
  await withEnv(GRANTED, async () => {
    const { postTrackshipRefire } = await import('@/lib/connectors/woocommerce/sync/trackship-refire')
    settings.delete('wc_webhook_secret')
    assert.equal((await postTrackshipRefire('1')).kind, 'failed')
    settings.set('wc_webhook_secret', SECRET)
    settings.delete('wc_url')
    assert.equal((await postTrackshipRefire('1')).kind, 'failed')
    assert.equal(calls.length, 0)
  })
})

test('a transport error is a failure outcome (never thrown, never a success)', async () => {
  await withEnv(GRANTED, async () => {
    const { postTrackshipRefire } = await import('@/lib/connectors/woocommerce/sync/trackship-refire')
    throwOnSend = new Error('socket hang up with a secret in it: ck_live_abc')
    const outcome = await postTrackshipRefire('1')
    assert.equal(outcome.kind, 'failed')
    assert.doesNotMatch(outcome.kind === 'failed' ? outcome.error : '', /ck_live_abc/, 'the error text of the transport is not copied into the result')
  })
})

test('the switch is off unless it is exactly "true"', async () => {
  const { isTrackshipRefireEnabled, TRACKSHIP_REFIRE_ENABLED_SETTING } = await import('@/lib/connectors/woocommerce/sync/trackship-refire')
  assert.equal(TRACKSHIP_REFIRE_ENABLED_SETTING, 'trackship_refire_enabled')
  for (const [value, expected] of [[undefined, false], ['', false], ['false', false], ['1', false], ['TRUE', false], ['true', true]] as const) {
    settings = new Map(value === undefined ? [] : [[TRACKSHIP_REFIRE_ENABLED_SETTING, value]])
    assert.equal(await isTrackshipRefireEnabled(), expected, `value ${String(value)}`)
  }
})
