import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * o3d-zvec.14, AGAINST A REAL POSTGRES: the rows the double-postage flag is written to and read from.
 *
 *   A (survivor, postage)  + B (absorbed, postage)  -> B is flagged, naming both
 *   A (survivor, postage)  + C (absorbed, free)     -> nothing
 *   A (free)               + D (absorbed, postage)  -> nothing (one payer)
 *   a flag already standing is kept (no second write), and a cleared one can be raised again by a NEW merge
 *
 * Fixtures carry a unique tag and are removed afterwards. No Mintsoft or WooCommerce call is made.
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'

function loadEnv() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
}

test('the double-postage flag is raised only for a merge where more than one order paid postage', { skip }, async (t) => {
  loadEnv()
  const { db } = await import('../../lib/db/index.ts')
  const { Prisma } = await import('../../app/generated/prisma/client.ts')
  const { flagDoublePostageForMergedLink } = await import('../../lib/domain/wms/double-postage.ts')
  const tag = randomUUID().slice(0, 8)
  const orderIds: string[] = []

  const makeOrder = async (name: string, shipping: string) => {
    const order = await db.salesOrder.create({
      data: {
        orderNumber: `DP-${name}-${tag}`,
        externalOrderNumber: `DP${name}${tag}`,
        status: 'PROCESSING',
        currency: 'GBP',
        fxRateToBase: new Prisma.Decimal('1'),
        subtotalForeign: new Prisma.Decimal('20'),
        shippingForeign: new Prisma.Decimal(shipping),
        totalForeign: new Prisma.Decimal('20'),
        subtotalBase: new Prisma.Decimal('20'),
        shippingBase: new Prisma.Decimal(shipping),
        taxBase: new Prisma.Decimal('0'),
        totalBase: new Prisma.Decimal('20'),
      },
      select: { id: true },
    })
    orderIds.push(order.id)
    return order.id
  }
  const makeLink = (orderId: string, externalOrderId: string, state: 'SYNCED' | 'MERGED') =>
    db.wmsOrderPushLink.create({
      data: { orderId, connector: 'mintsoft', state, externalOrderId, externalOrderNumber: `${externalOrderId}-NUM` },
      select: { id: true },
    })
  t.after(async () => {
    await db.wmsOrderPushLink.deleteMany({ where: { orderId: { in: orderIds } } })
    await db.activityLog.deleteMany({ where: { entityId: { in: orderIds } } }).catch(() => undefined)
    await db.salesOrder.deleteMany({ where: { id: { in: orderIds } } })
  })

  // Merge 1: survivor A and absorbed B both paid postage.
  const a = await makeOrder('A', '4.95')
  const b = await makeOrder('B', '4.95')
  const linkA = await makeLink(a, `M1-${tag}`, 'SYNCED')
  const linkB = await makeLink(b, `M1-${tag}`, 'MERGED')
  // Merge 2: survivor A2 paid, absorbed C did not.
  const a2 = await makeOrder('A2', '4.95')
  const c = await makeOrder('C', '0')
  await makeLink(a2, `M2-${tag}`, 'SYNCED')
  const linkC = await makeLink(c, `M2-${tag}`, 'MERGED')
  // Merge 3: survivor A3 paid nothing, absorbed D paid.
  const a3 = await makeOrder('A3', '0')
  const d = await makeOrder('D', '4.95')
  await makeLink(a3, `M3-${tag}`, 'SYNCED')
  const linkD = await makeLink(d, `M3-${tag}`, 'MERGED')

  assert.equal(await flagDoublePostageForMergedLink(linkC.id), false, 'absorbed order paid nothing')
  assert.equal(await flagDoublePostageForMergedLink(linkD.id), false, 'only one order of the merge paid')
  assert.equal(await flagDoublePostageForMergedLink(linkB.id), true, 'two payers: flagged')

  const flagged = await db.wmsOrderPushLink.findMany({ where: { orderId: { in: orderIds }, doublePostageAt: { not: null } }, select: { orderId: true, doublePostageDetail: true } })
  assert.deepEqual(flagged.map((row) => row.orderId), [b], 'exactly the absorbed paying order carries the flag; the survivor does not')
  assert.match(flagged[0].doublePostageDetail ?? '', new RegExp(`#DPA${tag} \\(GBP 4\\.95\\)`))
  assert.match(flagged[0].doublePostageDetail ?? '', new RegExp(`#DPB${tag} \\(GBP 4\\.95\\)`))
  assert.equal((await db.wmsOrderPushLink.findUnique({ where: { id: linkA.id }, select: { doublePostageAt: true } }))?.doublePostageAt, null)

  // A standing flag is kept as it was (not rewritten), and the exception inbox's own selection finds it.
  const firstStamp = (await db.wmsOrderPushLink.findUnique({ where: { id: linkB.id }, select: { doublePostageAt: true } }))?.doublePostageAt
  assert.equal(await flagDoublePostageForMergedLink(linkB.id), false, 'already flagged: nothing written')
  assert.equal((await db.wmsOrderPushLink.findUnique({ where: { id: linkB.id }, select: { doublePostageAt: true } }))?.doublePostageAt?.getTime(), firstStamp?.getTime())
  assert.equal(await db.wmsOrderPushLink.count({ where: { orderId: { in: orderIds }, doublePostageAt: { not: null } } }), 1)

  // An operator clear (what clearDoublePostageFlag writes), after which only a NEW merge can raise it again.
  await db.wmsOrderPushLink.updateMany({ where: { id: linkB.id }, data: { doublePostageAt: null, doublePostageDetail: null } })
  assert.equal(await db.wmsOrderPushLink.count({ where: { orderId: { in: orderIds }, doublePostageAt: { not: null } } }), 0)
  assert.equal(await flagDoublePostageForMergedLink(linkB.id), true, 'a fresh merge evaluation raises it again')

  // A cancelled payer does not count.
  await db.salesOrder.update({ where: { id: a }, data: { status: 'CANCELLED' } })
  await db.wmsOrderPushLink.updateMany({ where: { id: linkB.id }, data: { doublePostageAt: null, doublePostageDetail: null } })
  assert.equal(await flagDoublePostageForMergedLink(linkB.id), false, 'the survivor was cancelled: only one live payer')
})
