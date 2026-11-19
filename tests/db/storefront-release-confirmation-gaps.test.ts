import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

/**
 * Follow-ups to the storefront release confirmation, on a real Postgres. Only the edges are doubles (session, Next cache); a confirmation is a row in
 * the e-mail outbox, nothing is sent and no network is touched.
 *   (1) an import auto-allocated while still unpaid (PENDING_PAYMENT -> ALLOCATED, marker still armed) is released by WooCommerce `processing`: one confirmation;
 *       a later hold + release of that order never fires the marker; two racing releases queue one e-mail.
 *   (3) the release claim is in the status transaction: when the e-mail cannot be queued the move rolls back whole and the marker stays armed.
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'

mock.module('@/lib/auth/server', { namedExports: { requirePermission: async () => ({ user: { id: 'u', role: 'ADMIN' } }), requireInternalUser: async () => ({ user: { id: 'u', role: 'ADMIN' } }), requireRole: async () => ({ user: { id: 'u', role: 'ADMIN' } }) } })
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })

const HOUR = 3_600_000

test('o3d-3634b: release of an allocated-while-unpaid import, hold/release never fires it late, and the claim is atomic with the status move', { skip }, async (t) => {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const { db } = await import('../../lib/db/index.ts')
  const { Prisma } = await import('../../app/generated/prisma/client')
  const { applySalesOrderStatusTransition } = await import('../../app/actions/sales.ts')
  const { syncWcOrderStatus } = await import('../../lib/connectors/woocommerce/sync/order-status.ts')
  const { releaseStorefrontConfirmationOnPaid } = await import('../../lib/storefront-customer-email.ts')
  const { INTERNAL_STATUS_TRANSITION_BYPASS, INTERNAL_STATUS_TRANSITION_AUTH_ONLY } = await import('../../lib/sales/status-transition-bypass.ts')
  const D = (v: string) => new Prisma.Decimal(v)
  const keys = ['storefront_customer_email_enabled', 'storefront_customer_email_enabled_at']
  const saved = await db.setting.findMany({ where: { key: { in: keys } } })
  const enabledAt = new Date(Date.now() - 2 * HOUR)
  for (const [key, value] of [[keys[0], 'true'], [keys[1], enabledAt.toISOString()]] as const) await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
  const ids: string[] = []
  t.after(async () => {
    await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS o3d_3634b_block ON email_outbox')
    await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS o3d_3634b_block()')
    await db.emailOutbox.deleteMany({ where: { referenceId: { in: ids } } })
    await db.shoppingOrderLink.deleteMany({ where: { orderId: { in: ids } } })
    await db.salesOrder.deleteMany({ where: { id: { in: ids } } })
    for (const key of keys) {
      const row = saved.find((s) => s.key === key)
      if (row) await db.setting.update({ where: { key }, data: { value: row.value } })
      else await db.setting.deleteMany({ where: { key } })
    }
  })
  const externalIds = new Map<string, number>()
  const seed = async (label: string, status: 'PENDING_PAYMENT' | 'ALLOCATED' | 'ON_HOLD', placedAt: Date) => {
    const order = await db.salesOrder.create({
      data: {
        orderNumber: `RG-${label}-${randomUUID().slice(0, 8)}`, status, currency: 'GBP', fxRateToBase: D('1'), subtotalForeign: D('1'), totalForeign: D('1'), subtotalBase: D('1'), taxBase: D('0'), totalBase: D('1'),
        customerEmail: 'buyer@example.test', customerName: 'Buyer', externalCreatedAt: placedAt, confirmationOnReleasePendingAt: placedAt,
      },
      select: { id: true },
    })
    ids.push(order.id)
    const wcId = 910_000_000 + Math.floor(Math.random() * 80_000_000)
    externalIds.set(order.id, wcId)
    await db.shoppingOrderLink.create({ data: { orderId: order.id, connector: 'woocommerce', externalOrderId: String(wcId) } })
    return order.id
  }
  const mails = (id: string) => db.emailOutbox.count({ where: { referenceId: id, kind: 'STOREFRONT_ORDER_CONFIRMATION' } })
  const marker = async (id: string) => (await db.salesOrder.findUniqueOrThrow({ where: { id }, select: { confirmationOnReleasePendingAt: true } })).confirmationOnReleasePendingAt
  const move = (id: string, status: string, token: symbol | null = INTERNAL_STATUS_TRANSITION_BYPASS) => applySalesOrderStatusTransition(id, status as never, undefined, { internalBypassToken: token ?? undefined, pushStatusToWooCommerce: false })
  const wcStatus = (id: string, status: string, paidAt: Date | null) => ({ id: externalIds.get(id)!, number: String(externalIds.get(id)), status, date_paid_gmt: paidAt ? paidAt.toISOString().slice(0, 19) : null, date_modified_gmt: new Date().toISOString().slice(0, 19) }) as never
  const wcProcessing = (id: string, paidAt: Date) => ({ id: externalIds.get(id)!, number: String(externalIds.get(id)), status: 'processing', date_paid_gmt: paidAt.toISOString().slice(0, 19), date_modified_gmt: paidAt.toISOString().slice(0, 19) }) as never

  // (1a) The import allocated an unpaid order (status ALLOCATED, marker still armed); WooCommerce then reports `processing` (paid): ONE confirmation, marker consumed.
  const allocated = await seed('alloc', 'ALLOCATED', new Date(Date.now() - HOUR))
  assert.equal((await syncWcOrderStatus(wcProcessing(allocated, new Date()))).success, true)
  assert.equal(await mails(allocated), 1, 'the paid allocated import is confirmed')
  assert.equal(await marker(allocated), null)
  assert.equal((await db.salesOrder.findUniqueOrThrow({ where: { id: allocated }, select: { status: true } })).status, 'ALLOCATED', 'IMS never moves it back to processing')
  assert.equal((await syncWcOrderStatus(wcProcessing(allocated, new Date()))).success, true)
  assert.equal(await mails(allocated), 1, 'a redelivered processing sends nothing more')

  // (1b) The leftover marker cannot fire at an unrelated moment: allocated-while-unpaid, put on hold and released: nothing, marker disarmed by the hold.
  const held = await seed('hold', 'ALLOCATED', new Date(Date.now() - HOUR))
  assert.equal((await move(held, 'ON_HOLD', null)).success, true)
  assert.equal(await marker(held), null, 'an operator hold (no internal token) disarms the unconsumed marker')
  assert.equal((await move(held, 'ALLOCATED', null)).success, true)
  assert.equal(await mails(held), 0, 'a hold-release of an allocated-while-unpaid import confirms nothing')

  // (1e) An EU-withdrawal hold (AUTH_ONLY) is not an operator hold: the marker stays armed, and the payment that follows confirms once.
  const withdrawal = await seed('withdrawal', 'ALLOCATED', new Date(Date.now() - HOUR))
  assert.equal((await move(withdrawal, 'ON_HOLD', INTERNAL_STATUS_TRANSITION_AUTH_ONLY)).success, true)
  assert.notEqual(await marker(withdrawal), null, 'a withdrawal hold keeps the marker armed')
  assert.equal((await syncWcOrderStatus(wcProcessing(withdrawal, new Date()))).success, true)
  assert.equal(await mails(withdrawal), 1)

  // (1d) A hold the STORE reports (gateway review / bank transfer on-hold) keeps the marker armed: pending import, auto-allocated, WC on-hold, WC processing (paid)
  // => exactly ONE confirmation.
  const storeHold = await seed('storehold', 'ALLOCATED', new Date(Date.now() - HOUR))
  assert.equal((await syncWcOrderStatus(wcStatus(storeHold, 'on-hold', null))).success, true)
  assert.equal((await db.salesOrder.findUniqueOrThrow({ where: { id: storeHold }, select: { status: true } })).status, 'ON_HOLD')
  assert.notEqual(await marker(storeHold), null, 'a store-reported hold keeps the marker armed')
  assert.equal(await mails(storeHold), 0, 'nothing is sent while it is on hold')
  assert.equal((await syncWcOrderStatus(wcStatus(storeHold, 'processing', new Date()))).success, true)
  assert.equal(await mails(storeHold), 1, 'the payment that follows confirms exactly once')
  assert.equal((await syncWcOrderStatus(wcStatus(storeHold, 'processing', new Date()))).success, true)
  assert.equal(await mails(storeHold), 1, 'a redelivery sends nothing more')

  // (2) A pre-switch-on held order released after the switch-on: no confirmation, but the refusal is recorded durably (the source of the hand-send lists).
  // With a store paid time it records the paid time; an IMS-side release records NO payment (it is never listed as paid).
  const refusalOf = async (id: string) => (await db.activityLog.findMany({ where: { entityId: id, action: 'storefront_confirmation_not_sent_on_release' } })).map((r) => r.metadata as { reason: string; paidObserved: boolean; releasedAt?: string })
  const preStore = await seed('prestore', 'PENDING_PAYMENT', new Date(enabledAt.getTime() - HOUR))
  const paidAt = new Date()
  assert.equal((await applySalesOrderStatusTransition(preStore, 'PROCESSING' as never, undefined, { internalBypassToken: INTERNAL_STATUS_TRANSITION_BYPASS, pushStatusToWooCommerce: false, releasedAt: paidAt })).success, true)
  assert.equal(await mails(preStore), 0)
  assert.deepEqual(await refusalOf(preStore), [{ reason: 'before_switch_on', paidObserved: true, releasedAt: paidAt.toISOString() }])
  const preIms = await seed('preims', 'PENDING_PAYMENT', new Date(enabledAt.getTime() - HOUR))
  assert.equal((await move(preIms, 'PROCESSING', null)).success, true)
  assert.deepEqual(await refusalOf(preIms), [{ reason: 'before_switch_on', paidObserved: false }])
  // The switch still OFF at the release (paid between natives-off and the switch-on): recorded as `disabled`, with the paid time.
  await db.setting.update({ where: { key: keys[0] }, data: { value: 'false' } })
  const preOff = await seed('preoff', 'ON_HOLD', new Date(enabledAt.getTime() - 30 * HOUR))
  assert.equal((await applySalesOrderStatusTransition(preOff, 'PROCESSING' as never, undefined, { internalBypassToken: INTERNAL_STATUS_TRANSITION_BYPASS, pushStatusToWooCommerce: false, releasedAt: paidAt })).success, true)
  await db.setting.update({ where: { key: keys[0] }, data: { value: 'true' } })
  assert.deepEqual(await refusalOf(preOff), [{ reason: 'disabled', paidObserved: true, releasedAt: paidAt.toISOString() }])

  // (1c) Two racing releases queue exactly one e-mail (the claim is one atomic update).
  const race = await seed('race', 'ALLOCATED', new Date(Date.now() - HOUR))
  await Promise.all([releaseStorefrontConfirmationOnPaid(race, { releasedAt: new Date() }), releaseStorefrontConfirmationOnPaid(race, { releasedAt: new Date() }), releaseStorefrontConfirmationOnPaid(race)])
  assert.equal(await mails(race), 1)

  // (3) ATOMIC WITH THE STATUS MOVE: the e-mail cannot be queued (a trigger refuses the outbox insert). The status move rolls back whole: still PENDING_PAYMENT,
  // marker still armed, nothing queued. (Before: the status committed, the marker was consumed on its own, and the confirmation was lost.)
  await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION o3d_3634b_block() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'o3d-3634b test: outbox insert refused'; END $$ LANGUAGE plpgsql`)
  await db.$executeRawUnsafe(`CREATE TRIGGER o3d_3634b_block BEFORE INSERT ON email_outbox FOR EACH ROW WHEN (NEW.kind = 'STOREFRONT_ORDER_CONFIRMATION') EXECUTE FUNCTION o3d_3634b_block()`)
  const atomic = await seed('atomic', 'PENDING_PAYMENT', new Date(Date.now() - HOUR))
  const refused = await move(atomic, 'PROCESSING')
  assert.equal(refused.success, false, 'the move fails with the queue')
  assert.equal((await db.salesOrder.findUniqueOrThrow({ where: { id: atomic }, select: { status: true } })).status, 'PENDING_PAYMENT', 'the status did not move')
  assert.notEqual(await marker(atomic), null, 'the marker is still armed')
  assert.equal(await mails(atomic), 0)
  // The refusal-branch release (allocated-while-unpaid, WC processing) that cannot queue FAILS the webhook (so WooCommerce retries) and keeps the marker armed.
  const retry = await seed('retry', 'ALLOCATED', new Date(Date.now() - HOUR))
  const failed = await syncWcOrderStatus(wcProcessing(retry, new Date()))
  assert.equal(failed.success, false, 'the delivery is not acknowledged')
  assert.notEqual(await marker(retry), null)
  await db.$executeRawUnsafe('DROP TRIGGER o3d_3634b_block ON email_outbox')
  assert.equal((await syncWcOrderStatus(wcProcessing(retry, new Date()))).success, true, 'the retry succeeds')
  assert.equal(await mails(retry), 1)
  // The same order, retried once the queue works: the status moves and the confirmation is queued, exactly once.
  assert.equal((await move(atomic, 'PROCESSING')).success, true)
  assert.equal(await mails(atomic), 1)
  assert.equal(await marker(atomic), null)
})
