import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * o3d-hqvrp.81, the stale-read race, on a real Postgres. The WooCommerce status sync decides from a status it read, then writes through the
 * bypass. If a dispatch commits between the read and the write, the write must be REFUSED against the status under the order lock and the
 * order must stay SHIPPED. Two real connections: the dispatch holds the order lock while the sync's transaction waits on it.
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'

test('a dispatch that commits between the read and the write is not overwritten by on-hold', { skip }, async (t) => {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const { db } = await import('../../lib/db/index.ts')
  const { Prisma } = await import('../../app/generated/prisma/client')
  const { updateSalesOrderStatusUnderLock, lockSalesOrder } = await import('../../lib/domain/sales/allocation-service.ts')
  const { wcStatusSyncRefusal } = await import('../../lib/connectors/woocommerce/sync/order-status.ts')
  const { STATUS_GUARD_REFUSAL_PREFIX } = await import('../../lib/domain/sales/status-transition-errors.ts')
  const D = (v: string) => new Prisma.Decimal(v)
  const order = await db.salesOrder.create({
    data: { orderNumber: `SG-${randomUUID().slice(0, 8)}`, status: 'ALLOCATED', currency: 'GBP', fxRateToBase: D('1'), subtotalForeign: D('1'), totalForeign: D('1'), subtotalBase: D('1'), taxBase: D('0'), totalBase: D('1') },
    select: { id: true },
  })
  t.after(async () => { await db.salesOrder.delete({ where: { id: order.id } }) })

  // 1. The sync's own read, and the pre-write decision from it: ALLOCATED -> ON_HOLD is allowed.
  const read = (await db.salesOrder.findUniqueOrThrow({ where: { id: order.id }, select: { status: true } })).status
  assert.equal(wcStatusSyncRefusal(read, 'ON_HOLD'), null, 'precondition: from the stale read the move looks legal')

  // 2. A dispatch takes the order lock and has not committed yet; the sync's write starts and waits on the lock.
  let releaseDispatch!: () => void
  const dispatchMayCommit = new Promise<void>((resolve) => { releaseDispatch = resolve })
  let dispatchHasLock!: () => void
  const locked = new Promise<void>((resolve) => { dispatchHasLock = resolve })
  const dispatch = db.$transaction(async (tx) => {
    await lockSalesOrder(tx, order.id)
    dispatchHasLock()
    await dispatchMayCommit
    await tx.salesOrder.update({ where: { id: order.id }, data: { status: 'SHIPPED' } })
  })
  await locked
  const sync = db.$transaction((tx) => updateSalesOrderStatusUnderLock(tx, {
    orderId: order.id, targetStatus: 'ON_HOLD', bypass: true,
    guardUnderLock: (current) => wcStatusSyncRefusal(current, 'ON_HOLD'),
  }))
  const syncOutcome = sync.then(() => 'wrote' as const, (e: Error) => e)
  await new Promise((r) => setTimeout(r, 300)) // the sync is queued behind the dispatch's lock
  releaseDispatch()
  await dispatch
  const outcome = await syncOutcome

  assert.notEqual(outcome, 'wrote', 'the write was refused')
  assert.ok(outcome instanceof Error && outcome.message.startsWith(STATUS_GUARD_REFUSAL_PREFIX), String(outcome))
  assert.equal((await db.salesOrder.findUniqueOrThrow({ where: { id: order.id }, select: { status: true } })).status, 'SHIPPED', 'the order stays SHIPPED')

  // CONTROL: without the guard the same bypassed write WOULD have overwritten the dispatch (proves the test can fail).
  await db.$transaction((tx) => updateSalesOrderStatusUnderLock(tx, { orderId: order.id, targetStatus: 'ON_HOLD', bypass: true }))
  assert.equal((await db.salesOrder.findUniqueOrThrow({ where: { id: order.id }, select: { status: true } })).status, 'ON_HOLD', 'CONTROL: the unguarded bypass moves SHIPPED backwards')
})
