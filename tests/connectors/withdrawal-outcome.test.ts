import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test, { mock } from 'node:test'

import { PRODUCER_HOLD_ENFORCED_ENV } from '@/lib/security/producer-disposition-constants'

/** THE WITHDRAWAL OUTCOME WRITER: off by default, held until step M is live, one signed POST, a closed vocabulary. The transport is a recorder. */
const ORIGIN = 'https://shop.example.com'
const SECRET = 'shared-secret'
const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = []
let answer: () => Response = () => new Response('{"ok":true,"result":"noted"}', { status: 200 })
let settings = new Map<string, string>()
const logged: Array<{ action: string }> = []

mock.module('@/lib/security/connector-fetch', {
  namedExports: { connectorFetch: async (url: string, init?: { headers?: Record<string, string>; body?: string }) => { calls.push({ url: String(url), headers: init?.headers ?? {}, body: init?.body ?? '' }); return answer() } },
})
mock.module('@/lib/settings-store', {
  namedExports: {
    getSettingValues: async (keys: string[]) => new Map(keys.flatMap((key) => (settings.has(key) ? [[key, settings.get(key)!] as const] : []))),
    getSettingValue: async (key: string) => settings.get(key) ?? null,
  },
})
mock.module('@/lib/activity-log', { namedExports: { logActivity: async (input: { action: string }) => { logged.push(input) } } })

const on = () => { settings = new Map([['wc_url', ORIGIN], ['wc_webhook_secret', SECRET], ['wc_withdrawal_outcome_enabled', 'true']]); calls.length = 0; logged.length = 0 }
const input = { outcome: 'rejected' as const, outcomeKey: 'wc_withdrawal_after_dispatch:42:1', note: 'IMS: gone', rejectReason: 'order already dispatched' }

test('OFF BY DEFAULT: with the setting unset, empty or anything but "true", nothing is sent', async () => {
  const { postWithdrawalOutcome } = await import('@/lib/connectors/woocommerce/sync/withdrawal-outcome')
  for (const value of [undefined, '', 'false', 'yes', '1', 'TRUE']) {
    on()
    if (value === undefined) settings.delete('wc_withdrawal_outcome_enabled'); else settings.set('wc_withdrawal_outcome_enabled', value)
    assert.deepEqual(await postWithdrawalOutcome('42', input), { kind: 'skipped', why: 'switch-off' }, String(value))
    assert.equal(calls.length, 0)
  }
})

test('held until step M is live: with enforcement on and no live-from instant, the switch being on still sends nothing', async () => {
  const { postWithdrawalOutcome } = await import('@/lib/connectors/woocommerce/sync/withdrawal-outcome')
  const saved = process.env[PRODUCER_HOLD_ENFORCED_ENV]
  process.env[PRODUCER_HOLD_ENFORCED_ENV] = 'all'
  try {
    on()
    assert.deepEqual(await postWithdrawalOutcome('42', input), { kind: 'skipped', why: 'held' })
    assert.equal(calls.length, 0)
  } finally { if (saved === undefined) delete process.env[PRODUCER_HOLD_ENFORCED_ENV]; else process.env[PRODUCER_HOLD_ENFORCED_ENV] = saved }
})

test('an allowed send is ONE signed POST to the withdrawal-outcome route of that order, carrying the key, the outcome and the reason', async () => {
  on()
  const { postWithdrawalOutcome, signWithdrawalOutcome } = await import('@/lib/connectors/woocommerce/sync/withdrawal-outcome')
  assert.deepEqual(await postWithdrawalOutcome('42', input), { kind: 'written', result: 'noted' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.url, `${ORIGIN}/wp-json/oti/v1/order/42/withdrawal-outcome`)
  const body = JSON.parse(calls[0]!.body) as Record<string, unknown>
  assert.equal(body.order_id, 42)
  assert.equal(body.outcome, 'rejected')
  assert.equal(body.outcome_key, input.outcomeKey)
  assert.equal(body.reject_reason, 'order already dispatched')
  assert.match(String(body.nonce), /^[0-9a-f]{32}$/)
  assert.equal(calls[0]!.headers['X-OTI-Signature'], createHmac('sha256', SECRET).update(`${body.ts}\nPOST\n/wp-json/oti/v1/order/42/withdrawal-outcome\n${calls[0]!.body}`).digest('hex'))
  assert.equal(calls[0]!.headers['X-OTI-Signature'], signWithdrawalOutcome({ timestamp: body.ts as number, orderId: '42', body: calls[0]!.body }, SECRET))
})

test('a storefront order id that is not a positive integer is never put in a signed path', async () => {
  on()
  const { postWithdrawalOutcome } = await import('@/lib/connectors/woocommerce/sync/withdrawal-outcome')
  for (const id of ['', '0', '1/../2', 'abc', '-3']) assert.equal((await postWithdrawalOutcome(id, input)).kind, 'failed', id)
  assert.equal(calls.length, 0)
})

test('the answer maps to a closed vocabulary; a missing route is a failure naming the plugin version, not "order gone"', async () => {
  const { classifyWithdrawalOutcomeResponse: c } = await import('@/lib/connectors/woocommerce/sync/withdrawal-outcome')
  assert.deepEqual(c(200, { result: 'rejected' }), { kind: 'written', result: 'rejected' })
  assert.deepEqual(c(200, { result: 'already_done' }), { kind: 'written', result: 'already_done' })
  assert.deepEqual(c(200, { result: 'no_request' }), { kind: 'written', result: 'no_request' })
  assert.equal(c(200, { result: 'novel' }).kind, 'failed')
  assert.equal(c(200, null).kind, 'failed')
  assert.deepEqual(c(404, { code: 'oti_wo_not_found' }), { kind: 'order-gone' })
  const route = c(404, { code: 'rest_no_route' })
  assert.equal(route.kind, 'failed')
  assert.match(route.kind === 'failed' ? route.error : '', /1\.5\.0/)
  for (const status of [401, 409, 500, 502, 503]) assert.equal(c(status, {}).kind, 'failed')
})

test('only the withdrawal events that have an outcome write one; a failure is logged and never thrown', async () => {
  const mod = await import('@/lib/connectors/woocommerce/sync/withdrawal-outcome')
  assert.deepEqual(Object.keys(mod.WITHDRAWAL_OUTCOME_BY_ACTION).sort(), ['wc_withdrawal_after_dispatch', 'wc_withdrawal_approval_failed', 'wc_withdrawal_approved', 'wc_withdrawal_approved_after_dispatch', 'wc_withdrawal_hold_applied', 'wc_withdrawal_hold_failed'])
  assert.deepEqual(mod.WITHDRAWAL_OUTCOME_BY_ACTION.wc_withdrawal_after_dispatch, { outcome: 'rejected', reject: true }, 'a request after despatch is rejected, as the bridge did')
  assert.equal(mod.WITHDRAWAL_OUTCOME_BY_ACTION.wc_withdrawal_approved_after_dispatch!.outcome, 'noted', 'an approval after despatch is never turned into a rejection')
  on()
  await mod.writeWithdrawalOutcomeForEvent({ orderId: 'o1', externalOrderId: '42', action: 'wc_withdrawal_already_cancelled', description: 'x', eventKey: 'k' })
  assert.equal(calls.length, 0, 'an action without an outcome sends nothing')
  answer = () => new Response('{}', { status: 500 })
  await mod.writeWithdrawalOutcomeForEvent({ orderId: 'o1', externalOrderId: '42', action: 'wc_withdrawal_hold_applied', description: 'held', eventKey: 'k' })
  assert.equal(calls.length, 1)
  assert.deepEqual(logged.map((l) => l.action), ['wc_withdrawal_outcome_failed'])
  answer = () => new Response('{"ok":true,"result":"noted"}', { status: 200 })
})
