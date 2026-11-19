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
  const seed = async (label: string, status: string, placedAt: Date, opts: { linked?: boolean; confirmed?: boolean; erased?: boolean } = {}) => {
    const order = await db.salesOrder.create({
      data: {
        orderNumber: `HS-${label}-${randomUUID().slice(0, 8)}`, status: status as never, currency: 'GBP', fxRateToBase: D('1'), subtotalForeign: D('1'), totalForeign: D('1'), subtotalBase: D('1'), taxBase: D('0'), totalBase: D('1'),
        customerEmail: 'buyer@example.test', customerName: 'Buyer', externalCreatedAt: placedAt, ...(opts.erased ? { erasedAt: new Date() } : {}),
      },
      select: { id: true, orderNumber: true },
    })
    ids.push(order.id)
    if (opts.linked !== false) await db.shoppingOrderLink.create({ data: { orderId: order.id, connector: 'woocommerce', externalOrderId: `${order.id}-ext` } })
    if (opts.confirmed) await db.emailOutbox.create({ data: { kind: 'STOREFRONT_ORDER_CONFIRMATION', toEmail: 'buyer@example.test', subject: 's', html: 'queued', referenceType: 'SalesOrder', referenceId: order.id } })
    return order.orderNumber!
  }
  const heldBacs = await seed('bacs', 'ON_HOLD', new Date(base - 30 * HOUR))
  const heldPending = await seed('pending', 'PENDING_PAYMENT', new Date(base - 3 * HOUR))
  const gap = await seed('gap', 'PROCESSING', new Date(base + HOUR))
  await seed('heldconfirmed', 'ON_HOLD', new Date(base - 5 * HOUR), { confirmed: true })
  await seed('direct', 'ON_HOLD', new Date(base - 5 * HOUR), { linked: false })
  await seed('erased', 'ON_HOLD', new Date(base - 5 * HOUR), { erased: true })
  await seed('cancelled', 'CANCELLED', new Date(base + HOUR))
  await seed('afterswitch', 'PROCESSING', new Date(base + 3 * HOUR))
  await seed('beforenatives', 'PROCESSING', new Date(base - HOUR))
  const rows = (await listStorefrontHandSendOrders({ nativesOffAt: natives, switchOnAt: switchOn })).filter((r) => ids.includes(r.orderId))
  assert.deepEqual(rows.map((r) => [r.reference, r.population]).sort(), [[gap, 'gap'], [heldBacs, 'held'], [heldPending, 'held']].sort())
  // without the gap bounds only the held list is produced
  const heldOnly = (await listStorefrontHandSendOrders({ nativesOffAt: null, switchOnAt: null })).filter((r) => ids.includes(r.orderId))
  assert.deepEqual(heldOnly.map((r) => r.reference).sort(), [heldBacs, heldPending].sort())
  assert.match(renderHandSendList(rows), /3 storefront order\(s\) to confirm by hand/)
  assert.equal(renderHandSendList([]), 'No storefront order needs a hand-sent confirmation.')
})
