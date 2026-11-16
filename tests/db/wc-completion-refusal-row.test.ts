import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * o3d-ymgc, AGAINST A REAL POSTGRES: a permanently refused WooCommerce completion is a QUARANTINED shopping_sync_logs row on the order.
 *
 *   * one open row per order, refreshed (not stacked) by a second refusal
 *   * listed while the order is unfulfilled; resolved by an explicit resolve
 *   * settled (SYNCED, and not listed) once the order is shipped / completed / cancelled by ANY route
 *   * an OPEN row survives the real retention sweep however old it is; a resolved one expires like any other row
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'

function loadEnv() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
}

test('a refused completion row is raised once, listed, cleared by fulfilment, and survives retention while open', { skip }, async (t) => {
  loadEnv()
  const { db } = await import('../../lib/db/index.ts')
  const { Prisma } = await import('../../app/generated/prisma/client.ts')
  const { recordWcCompletionRefusal, resolveWcCompletionRefusal, loadOpenWcCompletionRefusals } = await import('../../lib/connectors/woocommerce/sync/completion-refusal.ts')
  const { purgeExpiredData } = await import('../../lib/data-retention.ts')
  const tag = randomUUID().slice(0, 8)
  const orderIds: string[] = []
  const makeOrder = async (name: string) => {
    const order = await db.salesOrder.create({
      data: {
        orderNumber: `CR-${name}-${tag}`, externalOrderNumber: `CR${name}${tag}`, status: 'PROCESSING', currency: 'GBP',
        fxRateToBase: new Prisma.Decimal('1'), subtotalForeign: new Prisma.Decimal('20'), totalForeign: new Prisma.Decimal('20'),
        subtotalBase: new Prisma.Decimal('20'), taxBase: new Prisma.Decimal('0'), totalBase: new Prisma.Decimal('20'),
      },
      select: { id: true },
    })
    orderIds.push(order.id)
    return order.id
  }
  t.after(async () => {
    await db.shoppingSyncLog.deleteMany({ where: { entityId: { in: orderIds } } })
    await db.salesOrder.deleteMany({ where: { id: { in: orderIds } } })
  })

  const open = await makeOrder('OPEN')
  const shipped = await makeOrder('SHIPPED')
  const resolved = await makeOrder('RESOLVED')
  const refusal = (orderId: string, externalOrderId: number) => recordWcCompletionRefusal({
    orderId, externalOrderId, wcStatus: 'completed', refusal: 'coverage_shortfall', error: 'WIDGET (4 of 10 uncovered)',
  })

  await refusal(open, 9001)
  await refusal(open, 9001)
  const rows = await db.shoppingSyncLog.findMany({ where: { entityId: open }, select: { status: true, recordKind: true, externalId: true, payload: true } })
  assert.equal(rows.length, 1, 'a second refusal refreshes the open row')
  assert.equal(rows[0].status, 'QUARANTINED')
  assert.equal(rows[0].recordKind, 'WC_COMPLETION_REFUSAL')
  assert.equal(rows[0].externalId, '9001')
  assert.equal((rows[0].payload as { occurrences: number }).occurrences, 2)

  await refusal(shipped, 9002)
  await refusal(resolved, 9003)
  assert.deepEqual((await loadOpenWcCompletionRefusals()).filter((row) => orderIds.includes(row.orderId)).map((row) => row.orderId).sort(), [open, shipped, resolved].sort())

  // Resolved explicitly (the completion later succeeded).
  assert.equal(await resolveWcCompletionRefusal(resolved), 1)
  assert.equal(await resolveWcCompletionRefusal(resolved), 0, 'idempotent')
  // Fulfilled by another route (a WMS dispatch, an operator): the read settles it and does not list it.
  await db.salesOrder.update({ where: { id: shipped }, data: { status: 'SHIPPED' } })
  const listed = (await loadOpenWcCompletionRefusals()).filter((row) => orderIds.includes(row.orderId))
  assert.deepEqual(listed.map((row) => row.orderId), [open])
  assert.equal(listed[0].orderNumber, `CR${'OPEN'}${tag}`)
  assert.equal((await db.shoppingSyncLog.findFirst({ where: { entityId: shipped }, select: { status: true } }))?.status, 'SYNCED')

  // Retention: five-year-old rows. The OPEN one survives; the resolved ones expire like any other row.
  const old = new Date(Date.now() - 5 * 365 * 24 * 3600 * 1000)
  await db.shoppingSyncLog.updateMany({ where: { entityId: { in: orderIds } }, data: { createdAt: old } })
  await purgeExpiredData()
  const left = new Map((await db.shoppingSyncLog.findMany({ where: { entityId: { in: orderIds } }, select: { entityId: true, status: true } })).map((row) => [row.entityId, row.status]))
  assert.equal(left.get(open), 'QUARANTINED', 'an open refusal is the order\'s only record and is never purged')
  assert.equal(left.has(resolved), false, 'a resolved row expires by age as before')
  assert.equal(left.has(shipped), false, 'and so does a settled one')
})
