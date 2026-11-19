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

/** Step M live: the WooCommerce grant and a live-from instant in the past. The tests that need it held unset these. */
const GRANT_ENV = { WC_WRITEBACK_ALLOWED_ORIGIN: ORIGIN, MINTSOFT_WRITES_LIVE_FROM: '2020-01-01T00:00:00Z' }
const setStepM = (live: boolean) => { for (const [k, v] of Object.entries(GRANT_ENV)) { if (live) process.env[k] = v; else delete process.env[k] } }
const on = () => { setStepM(true); settings = new Map([['wc_url', ORIGIN], ['wc_webhook_secret', SECRET], ['wc_withdrawal_outcome_enabled', 'true']]); calls.length = 0; logged.length = 0 }
const input = { outcome: 'rejected' as const, outcomeKey: 'wc_withdrawal_after_dispatch:42:1', note: 'IMS: gone', rejectReason: 'order already dispatched' }

test('held until step M is live EVEN WITH THE PRODUCER ENFORCEMENT VARIABLE UNSET: the step\'s own live-from is read directly', async () => {
  const { postWithdrawalOutcome, withdrawalOutcomeStepMHeld } = await import('@/lib/connectors/woocommerce/sync/withdrawal-outcome')
  const saved = process.env[PRODUCER_HOLD_ENFORCED_ENV]
  delete process.env[PRODUCER_HOLD_ENFORCED_ENV]
  try {
    on()
    assert.equal(withdrawalOutcomeStepMHeld(), false, 'grant + live-from in the past: step M is live')
    setStepM(false)
    assert.equal(withdrawalOutcomeStepMHeld(), true, 'no live-from, no grant')
    delete process.env.MINTSOFT_WRITES_LIVE_FROM
    process.env.WC_WRITEBACK_ALLOWED_ORIGIN = ORIGIN
    assert.equal(withdrawalOutcomeStepMHeld(), true, 'grant but no live-from')
    process.env.MINTSOFT_WRITES_LIVE_FROM = '2999-01-01T00:00:00Z'
    assert.equal(withdrawalOutcomeStepMHeld(), true, 'a live-from in the future')
    calls.length = 0
    assert.deepEqual(await postWithdrawalOutcome('42', input), { kind: 'skipped', why: 'held' })
    assert.equal(calls.length, 0)
  } finally { setStepM(false); if (saved !== undefined) process.env[PRODUCER_HOLD_ENFORCED_ENV] = saved }
})

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
    setStepM(false)
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

type Store = import('@/lib/connectors/woocommerce/sync/withdrawal-outcome').WithdrawalOutcomeStore
function memoryStore(order: { requestId?: string | null; generation?: number } = {}) {
  const written = new Set<string>()
  const rows = new Map<string, { result: string; generation: number | null }>()
  const tasks: Array<{ basis: string; kind: string; queryText: string }> = []
  const state = { requestId: order.requestId ?? null, generation: order.generation ?? 1 }
  const store: Store = {
    identity: async (_orderId, incoming) => {
      const previousRequestId = state.requestId
      if (incoming) state.requestId = incoming
      return { requestId: state.requestId, previousRequestId, generation: state.generation }
    },
    findRow: async (orderId, key, kind) => rows.get(`${orderId}|${key}|${kind}`) ?? null,
    markWritten: async (orderId, key, kind, result, generation) => { written.add(`${orderId}|${key}|${kind}`); rows.set(`${orderId}|${key}|${kind}`, { result, generation }) },
    // One task per order, kind, request key and generation, as the database dedupe does.
    raiseTask: async (input) => { const basis = `${input.kind}:${input.requestKey}:g${input.generation}`; if (!tasks.some((t) => t.basis === basis)) tasks.push({ basis, kind: input.kind, queryText: input.queryText }) },
  }
  return { store, written, rows, tasks, state }
}
const event = (action: string, over: Record<string, unknown> = {}) => ({ orderId: 'o1', externalOrderId: '42', action, description: 'held', ...over })

test('only the withdrawal events that have an outcome write one; a failure is logged and never thrown', async () => {
  const mod = await import('@/lib/connectors/woocommerce/sync/withdrawal-outcome')
  assert.deepEqual(Object.keys(mod.WITHDRAWAL_OUTCOME_BY_ACTION).sort(), ['wc_withdrawal_after_dispatch', 'wc_withdrawal_approval_failed', 'wc_withdrawal_approved', 'wc_withdrawal_approved_after_dispatch', 'wc_withdrawal_hold_applied', 'wc_withdrawal_hold_failed'])
  assert.deepEqual(mod.WITHDRAWAL_OUTCOME_BY_ACTION.wc_withdrawal_after_dispatch, { outcome: 'rejected', reject: true }, 'a request after despatch is rejected, as the bridge did')
  assert.equal(mod.WITHDRAWAL_OUTCOME_BY_ACTION.wc_withdrawal_approved_after_dispatch!.outcome, 'noted', 'an approval after despatch is never turned into a rejection')
  on()
  const m = memoryStore()
  await mod.writeWithdrawalOutcomeForEvent(event('wc_withdrawal_already_cancelled'), m.store)
  assert.equal(calls.length, 0, 'an action without an outcome sends nothing')
  answer = () => new Response('{}', { status: 500 })
  await mod.writeWithdrawalOutcomeForEvent(event('wc_withdrawal_hold_applied'), m.store)
  assert.equal(calls.length, 1)
  assert.deepEqual(logged.map((l) => l.action), ['wc_withdrawal_outcome_failed'])
  assert.equal(m.written.size, 0, 'a failed write is not recorded as written, so it is tried again')
  answer = () => new Response('{"ok":true,"result":"noted"}', { status: 200 })
})

test('REPEATED webhooks or polls on an approved, withdrawn, shipped order write exactly ONE outcome: the identity is order + request + kind, never a modified time', async () => {
  const mod = await import('@/lib/connectors/woocommerce/sync/withdrawal-outcome')
  on()
  const m = memoryStore({ requestId: '9' })
  // Ten redeliveries, each with a later "modified time" (the old key): the call no longer takes one, and the key it sends is the same every time.
  for (let i = 0; i < 10; i += 1) await mod.writeWithdrawalOutcomeForEvent(event('wc_withdrawal_approved_after_dispatch', { description: 'approved after dispatch' }), m.store)
  assert.equal(calls.length, 1, 'one POST, then the ledger answers')
  assert.equal(JSON.parse(calls[0]!.body).outcome_key, 'wdo:42:r9:wc_withdrawal_approved_after_dispatch')
  assert.deepEqual([...m.written], ['o1|r9|wc_withdrawal_approved_after_dispatch'])
  // A different outcome kind for the same request is its own once-only row.
  await mod.writeWithdrawalOutcomeForEvent(event('wc_withdrawal_approved'), m.store)
  assert.equal(calls.length, 2)
  // A NEW request of the same order is a new identity.
  const m2 = memoryStore({ requestId: '9' })
  await mod.writeWithdrawalOutcomeForEvent(event('wc_withdrawal_approved_after_dispatch', { requestId: '10' }), m2.store)
  assert.equal(JSON.parse(calls[2]!.body).outcome_key, 'wdo:42:r10:wc_withdrawal_approved_after_dispatch')
})

test('the plugin-save echo does not loop: the key does not move when only the order\'s modified time does, and "already_done" from the storefront is recorded as written', async () => {
  const mod = await import('@/lib/connectors/woocommerce/sync/withdrawal-outcome')
  on()
  const m = memoryStore({ generation: 3 })
  answer = () => new Response('{"ok":true,"result":"already_done"}', { status: 200 })
  await mod.writeWithdrawalOutcomeForEvent(event('wc_withdrawal_hold_applied'), m.store)
  await mod.writeWithdrawalOutcomeForEvent(event('wc_withdrawal_hold_applied'), m.store)
  assert.equal(calls.length, 1)
  assert.equal(JSON.parse(calls[0]!.body).outcome_key, 'wdo:42:u:o1:wc_withdrawal_hold_applied', 'with no request id known, the fixed per-order key is the identity')
  answer = () => new Response('{"ok":true,"result":"noted"}', { status: 200 })
})

test('after S a rejection sends IMS\'s own request_id, and a storefront that cannot carry it out is a FAILURE with an operator task, never "written"', async () => {
  const mod = await import('@/lib/connectors/woocommerce/sync/withdrawal-outcome')
  on()
  const ok = memoryStore({ requestId: '9' })
  await mod.writeWithdrawalOutcomeForEvent(event('wc_withdrawal_after_dispatch'), ok.store)
  assert.equal(JSON.parse(calls[0]!.body).request_id, 9)
  assert.equal(ok.tasks.length, 0)
  for (const result of ['no_request', 'no_withdrawal_plugin']) {
    on()
    const bad = memoryStore({ requestId: '9' })
    answer = () => new Response(JSON.stringify({ ok: true, result }), { status: 200 })
    await mod.writeWithdrawalOutcomeForEvent(event('wc_withdrawal_after_dispatch'), bad.store)
    assert.deepEqual([...bad.rows.values()].map((r) => r.result), ['task_raised'], `${result} is recorded as a terminal row, never as written`)
    assert.equal(bad.tasks.length, 1, `${result} raises an operator task`)
    assert.match(bad.tasks[0]!.queryText, /Reject the request in WooCommerce by hand/)
    assert.deepEqual(logged.map((l) => l.action), ['wc_withdrawal_outcome_failed'])
    await mod.writeWithdrawalOutcomeForEvent(event('wc_withdrawal_after_dispatch'), bad.store)
    assert.equal(calls.length, 1, 'terminal: not sent again')
    assert.equal(bad.tasks.length, 1)
    assert.equal(logged.length, 1, 'and not warned again')
  }
  // A mere note that fails raises no task: there is no request to reject.
  on()
  const note = memoryStore()
  answer = () => new Response('{}', { status: 500 })
  await mod.writeWithdrawalOutcomeForEvent(event('wc_withdrawal_hold_applied'), note.store)
  assert.equal(note.tasks.length, 0)
  answer = () => new Response('{"ok":true,"result":"noted"}', { status: 200 })
})

test('REPLAY: no request id, ten webhooks with a changing date_modified and an HPOS-style save echo: ONE reject attempt, ONE note, ONE task', async () => {
  const mod = await import('@/lib/connectors/woocommerce/sync/withdrawal-outcome')
  on()
  const m = memoryStore({ generation: 1 })
  answer = () => new Response('{"ok":true,"result":"no_request"}', { status: 200 })
  // The hold generation no longer moves on the echo of IMS's own writes (withdrawal.ts isOutcomeEcho), so replays and the plugin's own save echo keep it.
  for (let i = 0; i < 10; i += 1) await mod.writeWithdrawalOutcomeForEvent(event('wc_withdrawal_after_dispatch'), m.store)
  await mod.writeWithdrawalOutcomeForEvent(event('wc_withdrawal_after_dispatch'), m.store)
  assert.equal(calls.length, 1, 'one reject attempt')
  assert.equal(m.tasks.length, 1, 'one task')
  assert.equal(logged.length, 1, 'one warning')
  assert.equal(JSON.parse(calls[0]!.body).outcome_key, 'wdo:42:u:o1:wc_withdrawal_after_dispatch')
  // A genuinely NEW request id (a capture) is a new identity and is attempted; the same id again is not.
  answer = () => new Response('{"ok":true,"result":"rejected"}', { status: 200 })
  await mod.writeWithdrawalOutcomeForEvent(event('wc_withdrawal_after_dispatch', { requestId: '77' }), m.store)
  await mod.writeWithdrawalOutcomeForEvent(event('wc_withdrawal_after_dispatch', { requestId: '77' }), m.store)
  assert.equal(calls.length, 2)
  assert.equal(JSON.parse(calls[1]!.body).request_id, 77)
  answer = () => new Response('{"ok":true,"result":"noted"}', { status: 200 })
})

test('a note written under the unknown key is not written again when the same request\'s id is captured later', async () => {
  const mod = await import('@/lib/connectors/woocommerce/sync/withdrawal-outcome')
  on()
  const m = memoryStore()
  await mod.writeWithdrawalOutcomeForEvent(event('wc_withdrawal_hold_applied'), m.store)
  await mod.writeWithdrawalOutcomeForEvent(event('wc_withdrawal_hold_applied', { requestId: '5' }), m.store)
  await mod.writeWithdrawalOutcomeForEvent(event('wc_withdrawal_hold_applied', { requestId: '5' }), m.store)
  assert.equal(calls.length, 1, 'one note for the one request')
})

test('a stale request id: a rejected request A, then a newer submission with no new id, raises ONE task and sends nothing; a new id is rejected', async () => {
  const mod = await import('@/lib/connectors/woocommerce/sync/withdrawal-outcome')
  on()
  const m = memoryStore({ requestId: '9', generation: 1 })
  answer = () => new Response('{"ok":true,"result":"rejected"}', { status: 200 })
  await mod.writeWithdrawalOutcomeForEvent(event('wc_withdrawal_after_dispatch'), m.store)
  assert.equal(calls.length, 1)
  m.state.generation = 2 // request B filed; the capture for B did not run, so the id still reads 9
  for (let i = 0; i < 3; i += 1) await mod.writeWithdrawalOutcomeForEvent(event('wc_withdrawal_after_dispatch', { requestId: '9' }), m.store)
  assert.equal(calls.length, 1, 'IMS does not resend for the request it cannot tell apart')
  assert.equal(m.tasks.length, 1, 'but it is never silent: one task')
  assert.match(m.tasks[0]!.queryText, /cannot tell whether/)
  await mod.writeWithdrawalOutcomeForEvent(event('wc_withdrawal_after_dispatch', { requestId: '10' }), m.store)
  assert.equal(calls.length, 2, 'a different id is request B: rejected')
  answer = () => new Response('{"ok":true,"result":"noted"}', { status: 200 })
})

test('R3 MEDIUM 1a: a rejection of request A under the unknown key is NEVER aliased to request B\'s key; B\'s rejection is sent', async () => {
  const mod = await import('@/lib/connectors/woocommerce/sync/withdrawal-outcome')
  on()
  const m = memoryStore({ generation: 1 })
  answer = () => new Response('{"ok":true,"result":"rejected"}', { status: 200 })
  await mod.writeWithdrawalOutcomeForEvent(event('wc_withdrawal_after_dispatch'), m.store) // A, no id: u: row 'rejected' at gen 1
  assert.equal(calls.length, 1)
  m.state.generation = 2 // the customer files B, and its id is captured
  await mod.writeWithdrawalOutcomeForEvent(event('wc_withdrawal_after_dispatch', { requestId: '31' }), m.store)
  assert.equal(calls.length, 2, 'B\'s rejection reached the storefront')
  assert.equal(JSON.parse(calls[1]!.body).request_id, 31)
  assert.equal(m.rows.get('o1|r31|wc_withdrawal_after_dispatch')?.result, 'rejected')
  answer = () => new Response('{"ok":true,"result":"noted"}', { status: 200 })
})

test('R3 MEDIUM 1b: the alias of a NOTE needs the same generation; a later submission\'s note under a new id is its own', async () => {
  const mod = await import('@/lib/connectors/woocommerce/sync/withdrawal-outcome')
  on()
  const same = memoryStore({ generation: 4 })
  await mod.writeWithdrawalOutcomeForEvent(event('wc_withdrawal_hold_applied'), same.store)
  await mod.writeWithdrawalOutcomeForEvent(event('wc_withdrawal_hold_applied', { requestId: '8' }), same.store)
  assert.equal(calls.length, 1, 'same submission: aliased, no second note')
  const later = memoryStore({ generation: 4 })
  calls.length = 0
  await mod.writeWithdrawalOutcomeForEvent(event('wc_withdrawal_hold_applied'), later.store)
  later.state.generation = 5
  await mod.writeWithdrawalOutcomeForEvent(event('wc_withdrawal_hold_applied', { requestId: '9' }), later.store)
  assert.equal(calls.length, 2, 'a newer submission with its own id is not aliased to the earlier note')
})

test('R3 MEDIUM 1c: the ambiguity check covers the unknown key: A failed under u:, then B arrives with its id still unknown: ONE task per generation, nothing re-sent', async () => {
  const mod = await import('@/lib/connectors/woocommerce/sync/withdrawal-outcome')
  on()
  const m = memoryStore({ generation: 1 })
  answer = () => new Response('{"ok":true,"result":"no_request"}', { status: 200 })
  await mod.writeWithdrawalOutcomeForEvent(event('wc_withdrawal_after_dispatch'), m.store)
  assert.equal(m.tasks.length, 1)
  m.state.generation = 2
  for (let i = 0; i < 3; i += 1) await mod.writeWithdrawalOutcomeForEvent(event('wc_withdrawal_after_dispatch'), m.store)
  assert.equal(calls.length, 1, 'nothing re-sent')
  assert.equal(m.tasks.length, 2, 'B raised its own task (once)')
  assert.match(m.tasks[1]!.queryText, /cannot tell whether/)
  m.state.generation = 3
  await mod.writeWithdrawalOutcomeForEvent(event('wc_withdrawal_after_dispatch'), m.store)
  assert.equal(m.tasks.length, 3, 'and a third submission its own')
  answer = () => new Response('{"ok":true,"result":"noted"}', { status: 200 })
})

test('R3 MEDIUM 2: the task is raised with the request key and the hold generation in its basis, so a later failure on the same order is never swallowed by an earlier task', async () => {
  const mod = await import('@/lib/connectors/woocommerce/sync/withdrawal-outcome')
  on()
  const m = memoryStore({ requestId: '9', generation: 1 })
  const raised: Array<{ requestKey: string; generation: number }> = []
  const store: Store = { ...m.store, raiseTask: async (input) => { raised.push({ requestKey: input.requestKey, generation: input.generation }); await m.store.raiseTask(input) } }
  answer = () => new Response('{"ok":true,"result":"no_request"}', { status: 200 })
  await mod.writeWithdrawalOutcomeForEvent(event('wc_withdrawal_after_dispatch'), store)
  m.state.generation = 2
  await mod.writeWithdrawalOutcomeForEvent(event('wc_withdrawal_after_dispatch', { requestId: '10' }), store)
  assert.deepEqual(raised, [{ requestKey: 'r9', generation: 1 }, { requestKey: 'r10', generation: 2 }])
  assert.equal(m.tasks.length, 2, 'two requests on one order, two distinct dedupe bases')
  answer = () => new Response('{"ok":true,"result":"noted"}', { status: 200 })
})
