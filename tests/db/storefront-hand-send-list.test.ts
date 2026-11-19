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
  const { listStorefrontHandSendOrders, renderHandSendList, markStorefrontHandSent } = await import('../../lib/ops/storefront-held-orders-at-w.ts')
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
  const seed = async (label: string, status: string, placedAt: Date, opts: { linked?: boolean; confirmed?: boolean; erased?: boolean; marker?: boolean; refused?: { reason: string; releasedAt?: Date } } = {}) => {
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
    if (opts.refused) await db.activityLog.create({ data: { entityType: 'SALES_ORDER', entityId: order.id, action: 'storefront_confirmation_not_sent_on_release', tag: 'sales', description: 'x', metadata: { reason: opts.refused.reason, paidObserved: opts.refused.releasedAt !== undefined, ...(opts.refused.releasedAt ? { releasedAt: opts.refused.releasedAt.toISOString() } : {}) } } })
    return order.orderNumber!
  }
  const heldBacs = await seed('bacs', 'ON_HOLD', new Date(base - 30 * HOUR), { marker: true })
  const heldPending = await seed('pending', 'PENDING_PAYMENT', new Date(base - 3 * HOUR), { marker: true })
  const heldAllocated = await seed('allocated', 'ALLOCATED', new Date(base - 3 * HOUR), { marker: true })
  const gap = await seed('gap', 'PROCESSING', new Date(base + HOUR))
  // paid after natives-off, placed before the switch-on, refused after the switch-on
  const paid = await seed('paid', 'PROCESSING', new Date(base - 3 * HOUR), { refused: { reason: 'before_switch_on', releasedAt: new Date(base + 3 * HOUR) } })
  // placed before natives-off, paid INSIDE the gap, refused as `disabled` (the switch was still off): must still be listed
  const gapPaid = await seed('gappaid', 'PROCESSING', new Date(base - 30 * HOUR), { refused: { reason: 'disabled', releasedAt: new Date(base + HOUR) } })
  // an IMS user released it, no payment reported: never PAID
  const imsRelease = await seed('imsrelease', 'PROCESSING', new Date(base - 3 * HOUR), { refused: { reason: 'before_switch_on' } })
  // THE HOLE: an IMS user released it BEFORE natives-off (no paid time); the customer may have paid after it, and nobody confirmed that: list it to be checked
  const imsReleaseEarly = await seed('imsearly', 'PROCESSING', new Date(base - 30 * HOUR), { refused: { reason: 'disabled' } })
  // placed AFTER the switch-on, paid while the switch was turned off again (rollback): IMS's own order, never listed (neither as paid nor as released-in-ims)
  await seed('rollbackpaid', 'PROCESSING', new Date(base + 3 * HOUR), { refused: { reason: 'disabled', releasedAt: new Date(base + 4 * HOUR) } })
  await seed('rollbackims', 'PROCESSING', new Date(base + 3 * HOUR), { refused: { reason: 'disabled' } })
  // none of these may be listed:
  await seed('paidbefore', 'PROCESSING', new Date(base - 30 * HOUR), { refused: { reason: 'disabled', releasedAt: new Date(base - HOUR) } }) // paid before natives-off: WooCommerce confirmed it
  await seed('afterstamp-held', 'ON_HOLD', new Date(base + 3 * HOUR), { marker: true }) // IMS confirms it on payment
  await seed('paidthenheld', 'ON_HOLD', new Date(base - 5 * HOUR)) // no marker: WooCommerce confirmed it natively, an operator held it
  await seed('heldconfirmed', 'ON_HOLD', new Date(base - 5 * HOUR), { marker: true, confirmed: true })
  await seed('direct', 'ON_HOLD', new Date(base - 5 * HOUR), { linked: false, marker: true })
  await seed('erased', 'ON_HOLD', new Date(base - 5 * HOUR), { erased: true, marker: true })
  await seed('cancelled', 'CANCELLED', new Date(base + HOUR))
  await seed('afterswitch', 'PROCESSING', new Date(base + 3 * HOUR))
  await seed('beforenatives', 'PROCESSING', new Date(base - HOUR))
  await seed('paidconfirmed', 'PROCESSING', new Date(base - 3 * HOUR), { refused: { reason: 'before_switch_on', releasedAt: new Date(base + 3 * HOUR) }, confirmed: true })
  await seed('toold', 'PROCESSING', new Date(base + 3 * HOUR), { refused: { reason: 'too_old' } }) // not recorded in production; ignored if present
  const mine = async (input: Parameters<typeof listStorefrontHandSendOrders>[0]) => (await listStorefrontHandSendOrders(input)).filter((r) => ids.includes(r.orderId))
  const at = (rows: Awaited<ReturnType<typeof mine>>) => rows.map((r) => [r.reference, r.population]).sort()
  const held = [[heldBacs, 'held-unpaid'], [heldPending, 'held-unpaid'], [heldAllocated, 'held-unpaid']]
  assert.deepEqual(at(await mine({ switchOnAt: switchOn })), held.sort())
  assert.deepEqual(at(await mine({ switchOnAt: switchOn, nativesOffAt: natives })), [...held, [gap, 'gap-paid']].sort())
  const full = await mine({ switchOnAt: switchOn, nativesOffAt: natives, paidSince: natives })
  assert.deepEqual(at(full), [...held, [gap, 'gap-paid'], [paid, 'paid'], [gapPaid, 'paid'], [imsRelease, 'released-in-ims'], [imsReleaseEarly, 'released-in-ims']].sort())
  assert.deepEqual(await mine({ switchOnAt: null, nativesOffAt: natives, paidSince: natives }), [], 'no stamp, nothing can be judged')
  assert.match(renderHandSendList(full), /UNPAID - send nothing now/)
  assert.match(renderHandSendList(full), /CHECK - released in IMS/)
  assert.equal(renderHandSendList([]), 'No storefront order needs a hand-sent confirmation.')

  // The hand-sent mark: audited, idempotent, removes the order from every list, refuses unpaid and IMS-confirmed orders.
  assert.deepEqual((await markStorefrontHandSent([paid], 'Jan')).map((r) => r.outcome), ['marked'])
  assert.deepEqual((await markStorefrontHandSent([paid], 'Jan')).map((r) => r.outcome), ['already-marked'])
  const audit = await db.activityLog.findMany({ where: { action: 'storefront_confirmation_hand_sent', entityId: { in: ids } } })
  assert.equal(audit.length, 1)
  assert.equal((audit[0].metadata as { by: string }).by, 'Jan')
  assert.ok(!(await mine({ switchOnAt: switchOn, nativesOffAt: natives, paidSince: natives })).some((r) => r.reference === paid), 'a marked order is not listed again')
  const refused = await markStorefrontHandSent([heldBacs, 'HS-confirmed-none', 'no-such-order'], 'Jan')
  assert.ok(refused.every((r) => r.outcome === 'refused'))
  assert.match(refused[0].reason!, /unpaid/)
  const confirmedRef = await seed('confirmedpaid', 'PROCESSING', new Date(base - 3 * HOUR), { confirmed: true })
  assert.match((await markStorefrontHandSent([confirmedRef], 'Jan'))[0].reason!, /already queued/)

  // Mark-sent refusals (o3d-qzu8z). An allocated-while-unpaid import (release marker armed) is not paid: refused even though ALLOCATED is not a held status.
  const armed = await markStorefrontHandSent([heldAllocated], 'Jan')
  assert.equal(armed[0].outcome, 'refused')
  assert.match(armed[0].reason!, /marker is still armed/)
  assert.equal(armed[0].order?.status, 'ALLOCATED')
  // An ambiguous number (orderNumber of one order = externalOrderNumber of another) marks nothing.
  const dupRef = `HS-dup-${randomUUID().slice(0, 8)}`
  for (const [label, field] of [['dupa', 'orderNumber'], ['dupb', 'externalOrderNumber']] as const) {
    const ref = await seed(label, 'PROCESSING', new Date(base - 3 * HOUR))
    await db.salesOrder.updateMany({ where: { orderNumber: ref }, data: { [field]: dupRef } })
  }
  const dup = await markStorefrontHandSent([dupRef], 'Jan')
  assert.equal(dup[0].outcome, 'refused')
  assert.match(dup[0].reason!, /matches 2 orders/)
  assert.equal(await db.activityLog.count({ where: { action: 'storefront_confirmation_hand_sent', entityId: { in: ids } } }), 1, 'nothing was marked for the ambiguous number')
  // The dry run judges the same way, shows the matched order and writes nothing.
  const dryRef = await seed('dry', 'PROCESSING', new Date(base - 3 * HOUR))
  const dry = await markStorefrontHandSent([dryRef, heldAllocated], 'Jan', db, { dryRun: true })
  assert.equal(dry[0].outcome, 'would-mark')
  assert.equal(dry[0].order?.number, dryRef)
  assert.equal(dry[0].order?.status, 'PROCESSING')
  assert.ok(dry[0].order?.placedAt instanceof Date && dry[0].order.id)
  assert.equal(dry[1].outcome, 'refused')
  assert.equal(await db.activityLog.count({ where: { action: 'storefront_confirmation_hand_sent', entityId: { in: ids } } }), 1, 'a dry run writes nothing')
  // The free-text actor is validated: no e-mail address, token or control characters reach the audit row.
  for (const bad of ['jan@example.test', 'token=abc123', '', '   ', 'x'.repeat(61), 'Jan\nSmith;']) {
    await assert.rejects(markStorefrontHandSent([dryRef], bad), /--by must be a name/, `rejects ${JSON.stringify(bad)}`)
  }
  assert.deepEqual((await markStorefrontHandSent([dryRef], "  Jan   O'Neil-Smith  ")).map((r) => r.outcome), ['marked'])
  const row = await db.activityLog.findFirst({ where: { action: 'storefront_confirmation_hand_sent', description: { contains: "O'Neil" } } })
  assert.equal((row!.metadata as { by: string }).by, "Jan O'Neil-Smith", 'whitespace normalised')
})

test('hand-send: the mark row is written through the activity log (redaction and sanitising), not a raw insert', async () => {
  const { readFile } = await import('node:fs/promises')
  const src = await readFile(new URL('../../lib/ops/storefront-held-orders-at-w.ts', import.meta.url), 'utf8')
  assert.match(src, /logActivityInTransaction\(/)
  assert.doesNotMatch(src, /activityLog\.create\(/)
})
