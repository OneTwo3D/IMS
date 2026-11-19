import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/** Runbook step W hand-send list (o3d-3634b): open unpaid held storefront orders, and orders placed between natives-off and the switch-on, with no confirmation queued. Read-only. */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'
const HOUR = 3_600_000

test('hand-send list: held orders and the natives-off gap without a confirmation; confirmed, direct, erased, cancelled and out-of-window orders are not listed', { skip }, async (t) => {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const { db } = await import('../../lib/db/index.ts')
  const { Prisma } = await import('../../app/generated/prisma/client')
  const { listStorefrontHandSendOrders, renderHandSendList } = await import('../../lib/ops/storefront-held-orders-at-w.ts')
  const D = (v: string) => new Prisma.Decimal(v)
  const ids: string[] = []
  t.after(async () => {
    await db.emailOutbox.deleteMany({ where: { referenceId: { in: ids } } })
    await db.shoppingOrderLink.deleteMany({ where: { orderId: { in: ids } } })
    await db.salesOrder.deleteMany({ where: { id: { in: ids } } })
  })
  const base = Date.now() + 5 * 365 * 24 * HOUR // far future: no real order of this database falls in the window
  const natives = new Date(base)
  const switchOn = new Date(base + 2 * HOUR)
  const w = new Date(base + 2 * HOUR)
  const seed = async (label: string, status: string, placedAt: Date, opts: { linked?: boolean; confirmed?: boolean; erased?: boolean; marker?: boolean; refusedOnRelease?: boolean } = {}) => {
    const order = await db.salesOrder.create({
      data: {
        orderNumber: `HS-${label}-${randomUUID().slice(0, 8)}`, status: status as never, currency: 'GBP', fxRateToBase: D('1'), subtotalForeign: D('1'), totalForeign: D('1'), subtotalBase: D('1'), taxBase: D('0'), totalBase: D('1'),
        customerEmail: 'buyer@example.test', customerName: 'Buyer', externalCreatedAt: placedAt, ...(opts.erased ? { erasedAt: new Date() } : {}), ...(opts.marker ? { confirmationOnReleasePendingAt: placedAt } : {}),
      },
      select: { id: true, orderNumber: true },
    })
    ids.push(order.id)
    if (opts.linked !== false) await db.shoppingOrderLink.create({ data: { orderId: order.id, connector: 'woocommerce', externalOrderId: `${order.id}-ext` } })
    if (opts.confirmed) await db.emailOutbox.create({ data: { kind: 'STOREFRONT_ORDER_CONFIRMATION', toEmail: 'buyer@example.test', subject: 's', html: 'queued', referenceType: 'SalesOrder', referenceId: order.id } })
    if (opts.refusedOnRelease) await db.activityLog.create({ data: { entityType: 'SALES_ORDER', entityId: order.id, action: 'storefront_confirmation_not_sent_on_release', tag: 'sales', description: 'x', metadata: { reason: 'before_switch_on' }, createdAt: new Date(base + 3 * HOUR) } })
    return order.orderNumber!
  }
  const heldBacs = await seed('bacs', 'ON_HOLD', new Date(base - 30 * HOUR), { marker: true })
  const heldPending = await seed('pending', 'PENDING_PAYMENT', new Date(base - 3 * HOUR), { marker: true })
  const gap = await seed('gap', 'PROCESSING', new Date(base + HOUR))
  const paid = await seed('paid', 'PROCESSING', new Date(base - 3 * HOUR), { marker: false, refusedOnRelease: true })
  // none of these may be listed:
  await seed('afterstamp-held', 'ON_HOLD', new Date(base + 3 * HOUR), { marker: true }) // IMS confirms it on payment
  await seed('paidthenheld', 'ON_HOLD', new Date(base - 5 * HOUR)) // no marker: WooCommerce confirmed it natively, an operator held it
  await seed('heldconfirmed', 'ON_HOLD', new Date(base - 5 * HOUR), { marker: true, confirmed: true })
  await seed('direct', 'ON_HOLD', new Date(base - 5 * HOUR), { linked: false, marker: true })
  await seed('erased', 'ON_HOLD', new Date(base - 5 * HOUR), { erased: true, marker: true })
  await seed('cancelled', 'CANCELLED', new Date(base + HOUR))
  await seed('afterswitch', 'PROCESSING', new Date(base + 3 * HOUR))
  await seed('beforenatives', 'PROCESSING', new Date(base - HOUR))
  await seed('paidconfirmed', 'PROCESSING', new Date(base - 3 * HOUR), { refusedOnRelease: true, confirmed: true })
  const mine = async (input: Parameters<typeof listStorefrontHandSendOrders>[0]) => (await listStorefrontHandSendOrders(input)).filter((r) => ids.includes(r.orderId))
  const at = (rows: Awaited<ReturnType<typeof mine>>) => rows.map((r) => [r.reference, r.population]).sort()
  // default: only the unpaid held list (information; send nothing)
  assert.deepEqual(at(await mine({ switchOnAt: switchOn })), [[heldBacs, 'held-unpaid'], [heldPending, 'held-unpaid']].sort())
  assert.deepEqual(at(await mine({ switchOnAt: switchOn, nativesOffAt: natives })), [[gap, 'gap-paid'], [heldBacs, 'held-unpaid'], [heldPending, 'held-unpaid']].sort())
  assert.deepEqual(at(await mine({ switchOnAt: switchOn, paidSince: w })), [[heldBacs, 'held-unpaid'], [heldPending, 'held-unpaid'], [paid, 'paid-since']].sort())
  assert.deepEqual(await mine({ switchOnAt: null, nativesOffAt: natives, paidSince: w }), [], 'no stamp, nothing can be judged')
  assert.match(renderHandSendList(await mine({ switchOnAt: switchOn, paidSince: w })), /UNPAID - send nothing now/)
  assert.equal(renderHandSendList([]), 'No storefront order needs a hand-sent confirmation.')
})
