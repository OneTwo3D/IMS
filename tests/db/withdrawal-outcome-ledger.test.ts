import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

/**
 * THE WITHDRAWAL OUTCOME LEDGER AGAINST A REAL DATABASE (the storefront is a recorder; nothing leaves the box).
 * Repeated webhooks or polls on an approved, withdrawn, shipped order produce exactly ONE storefront write per (order, request, outcome kind), whatever the
 * order's modified time does; a rejection the storefront cannot carry out is never recorded as written and raises one operator task.
 * GATED on RUN_DB_RETENTION_TESTS with the REQUIRE_DB_RETENTION_TESTS tripwire (npm run test:db).
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'

if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1, so every test in tests/db/withdrawal-outcome-ledger.test.ts would have been skipped. Fix the invocation (npm run test:db).')
}

// Step M live for the whole file: the grant and a live-from in the past (the writer reads the step's own live-from directly).
process.env.WC_WRITEBACK_ALLOWED_ORIGIN = 'https://shop.example.com'
process.env.MINTSOFT_WRITES_LIVE_FROM = '2020-01-01T00:00:00Z'
const posts: string[] = []
let answer = '{"ok":true,"result":"noted"}'
mock.module('@/lib/security/connector-fetch', { namedExports: { connectorFetch: async (_url: string, init?: { body?: string }) => { posts.push(init?.body ?? ''); return new Response(answer, { status: 200 }) } } })
const settings = new Map([['wc_url', 'https://shop.example.com'], ['wc_webhook_secret', 's3cret'], ['wc_withdrawal_outcome_enabled', 'true']])
mock.module('@/lib/settings-store', {
  namedExports: {
    getSettingValues: async (keys: string[]) => new Map(keys.flatMap((k) => (settings.has(k) ? [[k, settings.get(k)!] as const] : []))),
    getSettingValue: async (k: string) => settings.get(k) ?? null,
  },
})

test('[db] one write per (order, request, outcome); a later request or kind is its own; the request id is IMS\'s own record', { skip }, async (t) => {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const { db } = await import('@/lib/db')
  const { writeWithdrawalOutcomeForEvent } = await import('@/lib/connectors/woocommerce/sync/withdrawal-outcome')
  const RUN = `wdo${randomUUID().slice(0, 8)}`
  const order = await db.salesOrder.create({ data: { orderNumber: RUN, status: 'SHIPPED', currency: 'GBP', subtotalForeign: 1, totalForeign: 1, subtotalBase: 1, totalBase: 1, withdrawalHoldGeneration: 2 }, select: { id: true } })
  t.after(async () => { await db.wmsOperatorTask.deleteMany({ where: { orderId: order.id } }); await db.salesOrder.delete({ where: { id: order.id } }) })
  const ev = (action: string, requestId: string | null = null) => ({ orderId: order.id, externalOrderId: '4242', action, description: 'x', requestId })

  posts.length = 0
  for (let i = 0; i < 5; i += 1) await writeWithdrawalOutcomeForEvent(ev('wc_withdrawal_approved_after_dispatch'))
  assert.equal(posts.length, 1, 'five redeliveries, one storefront write')
  assert.equal(JSON.parse(posts[0]!).outcome_key, `wdo:4242:u:${order.id}:wc_withdrawal_approved_after_dispatch`)
  assert.equal(await db.wcWithdrawalOutcome.count({ where: { orderId: order.id } }), 1)

  // The request id of the SAME request is captured later: IMS records it, and the note already written under the unknown key is not written again.
  await writeWithdrawalOutcomeForEvent(ev('wc_withdrawal_approved_after_dispatch', '55'))
  await writeWithdrawalOutcomeForEvent(ev('wc_withdrawal_approved_after_dispatch', '55'))
  assert.equal(posts.length, 1, 'no second note for the same request')
  assert.equal((await db.salesOrder.findUniqueOrThrow({ where: { id: order.id }, select: { withdrawalRequestId: true } })).withdrawalRequestId, '55')
  // The order is touched (a newer modified time) and the webhook comes again: still nothing.
  await db.salesOrder.update({ where: { id: order.id }, data: { externalOrderNumber: `touched-${RUN}` } })
  await writeWithdrawalOutcomeForEvent(ev('wc_withdrawal_approved_after_dispatch'))
  assert.equal(posts.length, 1)
  await writeWithdrawalOutcomeForEvent(ev('wc_withdrawal_approved'))
  assert.equal(posts.length, 2, 'another outcome kind is its own once-only row')

  // A rejected request A, then a newer submission with no new id: never silent, ONE task, nothing re-sent.
  answer = '{"ok":true,"result":"rejected"}'
  await writeWithdrawalOutcomeForEvent(ev('wc_withdrawal_after_dispatch'))
  assert.equal(posts.length, 3)
  await db.salesOrder.update({ where: { id: order.id }, data: { withdrawalHoldGeneration: { increment: 1 } } })
  for (let i = 0; i < 3; i += 1) await writeWithdrawalOutcomeForEvent(ev('wc_withdrawal_after_dispatch'))
  answer = '{"ok":true,"result":"noted"}'
  assert.equal(posts.length, 3, 'not re-sent for a request IMS cannot tell apart')
  assert.equal(await db.wmsOperatorTask.count({ where: { orderId: order.id, reason: 'WITHDRAWAL_REJECT_NOT_WRITTEN' } }), 1, 'but a person is told, once')
  await db.activityLog.deleteMany({ where: { entityId: order.id } })
})

test('[db] REPLAY: no request id, ten webhooks whose date_modified (hold generation) keeps moving, and an HPOS-style save echo: ONE reject attempt, ONE task, ONE terminal row', { skip }, async (t) => {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const { db } = await import('@/lib/db')
  const { writeWithdrawalOutcomeForEvent } = await import('@/lib/connectors/woocommerce/sync/withdrawal-outcome')
  const RUN = `wdr${randomUUID().slice(0, 8)}`
  const order = await db.salesOrder.create({ data: { orderNumber: RUN, status: 'SHIPPED', currency: 'GBP', subtotalForeign: 1, totalForeign: 1, subtotalBase: 1, totalBase: 1, withdrawalHoldGeneration: 1 }, select: { id: true } })
  t.after(async () => { await db.wmsOperatorTask.deleteMany({ where: { orderId: order.id } }); await db.activityLog.deleteMany({ where: { entityId: order.id } }); await db.salesOrder.delete({ where: { id: order.id } }) })
  const ev = (requestId: string | null = null) => ({ orderId: order.id, externalOrderId: '4343', action: 'wc_withdrawal_after_dispatch', description: 'x', requestId })
  posts.length = 0
  answer = '{"ok":true,"result":"no_request"}'
  // (The hold generation no longer moves on the echo of IMS's own writes; replays keep it.)
  for (let i = 0; i < 11; i += 1) await writeWithdrawalOutcomeForEvent(ev())
  assert.equal(posts.length, 1, 'one reject attempt')
  assert.equal(JSON.parse(posts[0]!).outcome_key, `wdo:4343:u:${order.id}:wc_withdrawal_after_dispatch`)
  assert.equal(await db.wmsOperatorTask.count({ where: { orderId: order.id, reason: 'WITHDRAWAL_REJECT_NOT_WRITTEN' } }), 1, 'one task')
  assert.equal(await db.wcWithdrawalOutcome.count({ where: { orderId: order.id, result: 'task_raised' } }), 1, 'one terminal row')
  assert.equal(await db.activityLog.count({ where: { entityId: order.id, action: 'wc_withdrawal_outcome_failed' } }), 1, 'one warning')
  // A genuinely new request id (a capture) is attempted once.
  answer = '{"ok":true,"result":"rejected"}'
  await writeWithdrawalOutcomeForEvent(ev('88'))
  await writeWithdrawalOutcomeForEvent(ev('88'))
  assert.equal(posts.length, 2)
  answer = '{"ok":true,"result":"noted"}'
})

test('[db] R3: a later request B is never swallowed: A rejected under the unknown key, B (new generation, id captured) is rejected; a closed task does not hide a later failure', { skip }, async (t) => {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const { db } = await import('@/lib/db')
  const { writeWithdrawalOutcomeForEvent } = await import('@/lib/connectors/woocommerce/sync/withdrawal-outcome')
  const RUN = `wdb${randomUUID().slice(0, 8)}`
  const order = await db.salesOrder.create({ data: { orderNumber: RUN, status: 'SHIPPED', currency: 'GBP', subtotalForeign: 1, totalForeign: 1, subtotalBase: 1, totalBase: 1, withdrawalHoldGeneration: 1 }, select: { id: true } })
  t.after(async () => { await db.wmsOperatorTask.deleteMany({ where: { orderId: order.id } }); await db.activityLog.deleteMany({ where: { entityId: order.id } }); await db.salesOrder.delete({ where: { id: order.id } }) })
  const ev = (requestId: string | null = null) => ({ orderId: order.id, externalOrderId: '4545', action: 'wc_withdrawal_after_dispatch', description: 'x', requestId })
  const tasks = () => db.wmsOperatorTask.count({ where: { orderId: order.id, reason: 'WITHDRAWAL_REJECT_NOT_WRITTEN' } })

  // Path 1: A rejected under u:, then B arrives with its id. B's rejection reaches the store (it is not aliased to A's row).
  posts.length = 0
  answer = '{"ok":true,"result":"rejected"}'
  await writeWithdrawalOutcomeForEvent(ev())
  await db.salesOrder.update({ where: { id: order.id }, data: { withdrawalHoldGeneration: 2 } })
  await writeWithdrawalOutcomeForEvent(ev('61'))
  assert.equal(posts.length, 2)
  assert.equal(JSON.parse(posts[1]!).request_id, 61)

  // Path 2: B2 fails (no_request), its task is CLOSED by the operator; a later request C on the same order fails too: a NEW task, not a swallowed one.
  answer = '{"ok":true,"result":"no_request"}'
  await db.salesOrder.update({ where: { id: order.id }, data: { withdrawalHoldGeneration: 3 } })
  await writeWithdrawalOutcomeForEvent(ev('62'))
  assert.equal(await tasks(), 1)
  await db.wmsOperatorTask.updateMany({ where: { orderId: order.id }, data: { status: 'DONE', doneAt: new Date(), doneBy: 'test' } })
  await db.salesOrder.update({ where: { id: order.id }, data: { withdrawalHoldGeneration: 4 } })
  await writeWithdrawalOutcomeForEvent(ev('63'))
  assert.equal(await tasks(), 2, 'a later failure on the same order raises its own task')

  // Path 3: A fails under u: (no id), B arrives with the id still unknown: ONE ambiguity task for the generation, nothing re-sent.
  const order2 = await db.salesOrder.create({ data: { orderNumber: `${RUN}b`, status: 'SHIPPED', currency: 'GBP', subtotalForeign: 1, totalForeign: 1, subtotalBase: 1, totalBase: 1, withdrawalHoldGeneration: 1 }, select: { id: true } })
  t.after(async () => { await db.wmsOperatorTask.deleteMany({ where: { orderId: order2.id } }); await db.activityLog.deleteMany({ where: { entityId: order2.id } }); await db.salesOrder.delete({ where: { id: order2.id } }) })
  const ev2 = { orderId: order2.id, externalOrderId: '4546', action: 'wc_withdrawal_after_dispatch', description: 'x', requestId: null }
  posts.length = 0
  await writeWithdrawalOutcomeForEvent(ev2)
  await db.salesOrder.update({ where: { id: order2.id }, data: { withdrawalHoldGeneration: 2 } })
  for (let i = 0; i < 3; i += 1) await writeWithdrawalOutcomeForEvent(ev2)
  assert.equal(posts.length, 1, 'nothing re-sent')
  assert.equal(await db.wmsOperatorTask.count({ where: { orderId: order2.id } }), 2, 'A\'s task and B\'s ambiguity task')
  answer = '{"ok":true,"result":"noted"}'
})

test('[db] R3 LOW: identity() records the id under the order lock: two concurrent events with different ids end with one recorded id and each saw a consistent "previous"', { skip }, async (t) => {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const { db } = await import('@/lib/db')
  const { writeWithdrawalOutcomeForEvent } = await import('@/lib/connectors/woocommerce/sync/withdrawal-outcome')
  const RUN = `wdi${randomUUID().slice(0, 8)}`
  const order = await db.salesOrder.create({ data: { orderNumber: RUN, status: 'SHIPPED', currency: 'GBP', subtotalForeign: 1, totalForeign: 1, subtotalBase: 1, totalBase: 1, withdrawalHoldGeneration: 1 }, select: { id: true } })
  t.after(async () => { await db.activityLog.deleteMany({ where: { entityId: order.id } }); await db.salesOrder.delete({ where: { id: order.id } }) })
  const ev = (requestId: string) => ({ orderId: order.id, externalOrderId: '4547', action: 'wc_withdrawal_hold_applied', description: 'x', requestId })
  posts.length = 0
  await Promise.all([writeWithdrawalOutcomeForEvent(ev('71')), writeWithdrawalOutcomeForEvent(ev('72'))])
  const rows = await db.wcWithdrawalOutcome.findMany({ where: { orderId: order.id }, select: { requestKey: true } })
  assert.deepEqual(rows.map((r) => r.requestKey).sort(), ['r71', 'r72'], 'each id is its own request: two notes, none lost or aliased')
  assert.ok(['71', '72'].includes((await db.salesOrder.findUniqueOrThrow({ where: { id: order.id }, select: { withdrawalRequestId: true } })).withdrawalRequestId ?? ''))
})

test('[db] R3 LOW: the hold generation moves only on a real new submission, not on the echo of IMS\'s own outcome write (HPOS save)', { skip }, async (t) => {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const { db } = await import('@/lib/db')
  const { handleWcWithdrawalStatus } = await import('@/lib/connectors/woocommerce/sync/withdrawal')
  const RUN = `wde${randomUUID().slice(0, 8)}`
  const order = await db.salesOrder.create({ data: { orderNumber: RUN, status: 'SHIPPED', currency: 'GBP', subtotalForeign: 1, totalForeign: 1, subtotalBase: 1, totalBase: 1, withdrawalHoldGeneration: 1 }, select: { id: true } })
  t.after(async () => { await db.wmsOperatorTask.deleteMany({ where: { orderId: order.id } }); await db.activityLog.deleteMany({ where: { entityId: order.id } }); await db.salesOrder.delete({ where: { id: order.id } }) })
  const wc = (modified: string) => ({ id: 4848, status: 'pending-wdraw', date_modified_gmt: modified, meta_data: [] }) as never
  const row = (over: object = {}) => ({ id: order.id, status: 'SHIPPED', externalOrderNumber: null, withdrawalHoldAt: null, withdrawalApprovedAt: null, ...over })
  const generation = async () => (await db.salesOrder.findUniqueOrThrow({ where: { id: order.id }, select: { withdrawalHoldGeneration: true } })).withdrawalHoldGeneration
  const base = Date.now() - 600_000
  const iso = (offsetMs: number) => new Date(base + offsetMs).toISOString().replace('Z', '')
  answer = '{"ok":true,"result":"rejected"}'
  await handleWcWithdrawalStatus(wc(iso(0)), row()) // the customer's submission: generation 2
  const afterSubmission = await generation()
  assert.equal(afterSubmission, 2)
  // IMS's outcome row was written just after the plugin saved the order at +2 s: the webhook for that save is an echo.
  await db.wcWithdrawalOutcome.create({ data: { orderId: order.id, requestKey: `u:${order.id}`, outcomeKind: 'wc_withdrawal_hold_applied', result: 'noted', writtenAt: new Date(base + 3_000), holdGeneration: 2 } })
  await handleWcWithdrawalStatus(wc(iso(2_000)), row())
  assert.equal(await generation(), afterSubmission, 'the echo did not move the generation')
  // A genuinely later submission (no outcome row anywhere near it) does.
  await handleWcWithdrawalStatus(wc(iso(300_000)), row())
  assert.equal(await generation(), afterSubmission + 1)
  answer = '{"ok":true,"result":"noted"}'
})
