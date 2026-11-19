import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

/**
 * The storefront order confirmation on RELEASE of a held order, driven through the REAL status transition on a real Postgres (the claim marker is a
 * column consumed by the first move to a despatch-pending status). Only the edges are doubles: the session, the Next cache and the storefront facade.
 * A confirmation is a row in the e-mail outbox; nothing is sent and no network is touched.
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'

mock.module('@/lib/auth/server', { namedExports: { requirePermission: async () => ({ user: { id: 'u', role: 'ADMIN' } }), requireInternalUser: async () => ({ user: { id: 'u', role: 'ADMIN' } }), requireRole: async () => ({ user: { id: 'u', role: 'ADMIN' } }) } })
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })

const HOUR = 3_600_000

test('release confirmation: genuine held order once; old order hold/release, a too_old order and a pre-switch-on order never', { skip }, async (t) => {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const { db } = await import('../../lib/db/index.ts')
  const { Prisma } = await import('../../app/generated/prisma/client')
  const { applySalesOrderStatusTransition } = await import('../../app/actions/sales.ts')
  const { INTERNAL_STATUS_TRANSITION_BYPASS, INTERNAL_STATUS_TRANSITION_AUTH_ONLY } = await import('../../lib/sales/status-transition-bypass.ts')
  const D = (v: string) => new Prisma.Decimal(v)
  const keys = ['storefront_customer_email_enabled', 'storefront_customer_email_enabled_at']
  const saved = await db.setting.findMany({ where: { key: { in: keys } } })
  const enabledAt = new Date(Date.now() - 2 * HOUR)
  for (const [key, value] of [[keys[0], 'true'], [keys[1], enabledAt.toISOString()]] as const) await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
  const ids: string[] = []
  t.after(async () => {
    await db.emailOutbox.deleteMany({ where: { referenceId: { in: ids } } })
    await db.shoppingOrderLink.deleteMany({ where: { orderId: { in: ids } } })
    await db.salesOrder.deleteMany({ where: { id: { in: ids } } })
    for (const key of keys) {
      const row = saved.find((s) => s.key === key)
      if (row) await db.setting.update({ where: { key }, data: { value: row.value } })
      else await db.setting.deleteMany({ where: { key } })
    }
  })
  const seed = async (label: string, status: 'PENDING_PAYMENT' | 'PROCESSING', placedAt: Date, held: boolean) => {
    const order = await db.salesOrder.create({
      data: {
        orderNumber: `RC-${label}-${randomUUID().slice(0, 8)}`, status, currency: 'GBP', fxRateToBase: D('1'), subtotalForeign: D('1'), totalForeign: D('1'), subtotalBase: D('1'), taxBase: D('0'), totalBase: D('1'),
        customerEmail: 'buyer@example.test', customerName: 'Buyer', externalCreatedAt: placedAt, ...(held ? { confirmationOnReleasePendingAt: placedAt } : {}),
      },
      select: { id: true },
    })
    ids.push(order.id)
    await db.shoppingOrderLink.create({ data: { orderId: order.id, connector: 'woocommerce', externalOrderId: `${order.id}-ext` } })
    return order.id
  }
  const mails = (id: string) => db.emailOutbox.count({ where: { referenceId: id, kind: 'STOREFRONT_ORDER_CONFIRMATION' } })
  const move = (id: string, status: string, token: symbol, releasedAt?: Date) =>
    applySalesOrderStatusTransition(id, status as never, undefined, { internalBypassToken: token, pushStatusToWooCommerce: false, ...(releasedAt ? { releasedAt } : {}) })

  // (1) A genuine pending-payment order, placed after the switch-on, paid after it: confirmed ONCE.
  const genuine = await seed('genuine', 'PENDING_PAYMENT', new Date(Date.now() - HOUR), true)
  assert.equal((await move(genuine, 'PROCESSING', INTERNAL_STATUS_TRANSITION_BYPASS, new Date())).success, true)
  assert.equal(await mails(genuine), 1, 'the genuine release is confirmed')
  // ... and a later hold + release of the same order sends nothing more (the claim is consumed).
  assert.equal((await move(genuine, 'ON_HOLD', INTERNAL_STATUS_TRANSITION_BYPASS)).success, true)
  assert.equal((await move(genuine, 'PROCESSING', INTERNAL_STATUS_TRANSITION_BYPASS, new Date())).success, true)
  assert.equal(await mails(genuine), 1, 'still one')

  // (2) The reviewer scenario: an old, already-confirmed order (no marker) put on hold and released after the switch-on: nothing, by an operator-style move or the bypass.
  for (const token of [INTERNAL_STATUS_TRANSITION_AUTH_ONLY, INTERNAL_STATUS_TRANSITION_BYPASS]) {
    const old = await seed('old', 'PROCESSING', new Date(Date.now() - 21 * 24 * HOUR), false)
    assert.equal((await move(old, 'ON_HOLD', token)).success, true)
    assert.equal((await move(old, 'PROCESSING', token, new Date())).success, true)
    assert.equal(await mails(old), 0, 'an old order put on hold and released after the switch-on sends nothing')
  }

  // (3) An order whose import confirmation was refused as too_old (imported processing, no marker) is put on hold and released: nothing.
  const tooOld = await seed('tooold', 'PROCESSING', new Date(Date.now() - HOUR - 49 * HOUR), false)
  assert.equal((await move(tooOld, 'ON_HOLD', INTERNAL_STATUS_TRANSITION_BYPASS)).success, true)
  assert.equal((await move(tooOld, 'PROCESSING', INTERNAL_STATUS_TRANSITION_BYPASS, new Date())).success, true)
  assert.equal(await mails(tooOld), 0)

  // (4) Imported held but PLACED before the switch-on: released after it, nothing (WooCommerce confirmed or owed it before).
  const before = await seed('before', 'PENDING_PAYMENT', new Date(enabledAt.getTime() - HOUR), true)
  assert.equal((await move(before, 'PROCESSING', INTERNAL_STATUS_TRANSITION_BYPASS, new Date())).success, true)
  assert.equal(await mails(before), 0)

  // (5) An IMS-side release (no paid time) of a held order placed after the switch-on is judged on its placement: confirmed once.
  const ims = await seed('ims', 'PENDING_PAYMENT', new Date(Date.now() - HOUR), true)
  assert.equal((await move(ims, 'PROCESSING', INTERNAL_STATUS_TRANSITION_AUTH_ONLY)).success, true)
  assert.equal(await mails(ims), 1)
})
