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
  assert.equal(JSON.parse(posts[0]!).outcome_key, `wdo:4242:g2:wc_withdrawal_approved_after_dispatch`)
  assert.equal(await db.wcWithdrawalOutcome.count({ where: { orderId: order.id } }), 1)

  // The request id arrives (plugin 1.5.0 meta): IMS records it and keys on it from then on, so the generation-keyed row is not the same identity.
  await writeWithdrawalOutcomeForEvent(ev('wc_withdrawal_approved_after_dispatch', '55'))
  await writeWithdrawalOutcomeForEvent(ev('wc_withdrawal_approved_after_dispatch', '55'))
  assert.equal(posts.length, 2)
  assert.equal((await db.salesOrder.findUniqueOrThrow({ where: { id: order.id }, select: { withdrawalRequestId: true } })).withdrawalRequestId, '55')
  // The order is touched (a newer modified time) and the webhook comes again: still nothing.
  await db.salesOrder.update({ where: { id: order.id }, data: { externalOrderNumber: `touched-${RUN}` } })
  await writeWithdrawalOutcomeForEvent(ev('wc_withdrawal_approved_after_dispatch'))
  assert.equal(posts.length, 2)
  await writeWithdrawalOutcomeForEvent(ev('wc_withdrawal_approved'))
  assert.equal(posts.length, 3, 'another outcome kind is its own once-only row')

  // A rejection the storefront cannot carry out: never recorded as written, ONE operator task however often it is retried.
  answer = '{"ok":true,"result":"no_request"}'
  await writeWithdrawalOutcomeForEvent(ev('wc_withdrawal_after_dispatch'))
  await writeWithdrawalOutcomeForEvent(ev('wc_withdrawal_after_dispatch'))
  answer = '{"ok":true,"result":"noted"}'
  assert.equal(posts.length, 5, 'tried again each time: it was never written')
  assert.equal(await db.wcWithdrawalOutcome.count({ where: { orderId: order.id, outcomeKind: 'wc_withdrawal_after_dispatch' } }), 0)
  assert.equal(await db.wmsOperatorTask.count({ where: { orderId: order.id, reason: 'WITHDRAWAL_REJECT_NOT_WRITTEN' } }), 1)
  await db.activityLog.deleteMany({ where: { entityId: order.id } })
})
