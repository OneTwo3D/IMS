import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const skip = !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1'

let mocked = false
async function loadDb() {
  if (!mocked) {
    const actual = await import('@/lib/auth/server')
    const session = { user: { id: undefined as unknown as string, role: 'ADMIN', name: 'Test Admin', email: 'admin@example.test' } }
    const guards = Object.fromEntries(Object.keys(actual).filter((k) => k.startsWith('require')).map((k) => [k, async () => session]))
    mock.module('@/lib/auth/server', { namedExports: { ...actual, ...guards } })
    mock.module('next/cache', { namedExports: { revalidatePath: () => undefined, revalidateTag: () => undefined } })
    mocked = true
  }
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const { db } = await import('@/lib/db')
  return db
}

const NAME = 'Zebediah Quillfeather'
const EMAIL = `zebediah.${randomUUID().slice(0, 8)}@example.test`

type Db = Awaited<ReturnType<typeof loadDb>>
async function seed(db: Db, opts: { accounting: boolean }) {
  const customer = await db.customer.create({ data: { firstName: 'Zebediah', lastName: 'Quillfeather', email: EMAIL } })
  const mk = (status: string) => db.salesOrder.create({ data: { orderNumber: `HON-${randomUUID().slice(0, 8)}`, status, currency: 'GBP', customerId: customer.id, customerName: NAME, customerEmail: EMAIL, subtotalForeign: 1, totalForeign: 1, subtotalBase: 1, totalBase: 1 } as never })
  const despatched = await mk('SHIPPED'); const open = await mk('PROCESSING'); const cancelled = await mk('PROCESSING')
  const notPushed = await mk('PROCESSING'); const merged = await mk('PROCESSING'); const noLink = await mk('DRAFT'); const withShipment = await mk('PROCESSING')
  const link = (orderId: string, state: string, ext: string | null, num: string | null) =>
    db.wmsOrderPushLink.create({ data: { orderId, connector: 'mintsoft', externalOrderId: ext, externalOrderNumber: num, state } as never })
  await link(despatched.id, 'SYNCED', 'm-1', 'MS-1'); await link(open.id, 'SYNCED', 'm-2', 'MS-2'); await link(cancelled.id, 'CANCELLED', 'm-3', 'MS-3')
  await link(notPushed.id, 'PENDING_CREATE', null, null); await link(merged.id, 'MERGED', 'm-5', 'MS-5+MS-6'); await link(withShipment.id, 'SYNCED', 'm-7', 'MS-7')
  const warehouse = await db.warehouse.create({ data: { code: `HON-${randomUUID().slice(0, 8)}`, name: 'Honesty warehouse', syncToStore: true, availableForSale: true } })
  await db.shipment.create({ data: { orderId: withShipment.id, warehouseId: warehouse.id } })
  if (opts.accounting) await db.accountingSyncLog.create({ data: { connector: 'xero', type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: despatched.id, status: 'SYNCED', payload: { contactName: NAME } } as never })
  const orderIds = [despatched.id, open.id, cancelled.id, notPushed.id, merged.id, noLink.id, withShipment.id]
  return {
    customerId: customer.id, orderIds, ids: { despatched: despatched.id, open: open.id, merged: merged.id },
    async cleanup() {
      await db.notification.deleteMany({ where: { title: 'Personal data remains in the warehouse', createdAt: { gte: new Date(Date.now() - 600_000) } } })
      await db.accountingSyncLog.deleteMany({ where: { referenceId: { in: orderIds } } })
      await db.shipment.deleteMany({ where: { orderId: { in: orderIds } } })
      await db.wmsOrderPushLink.deleteMany({ where: { orderId: { in: orderIds } } })
      await db.activityLog.deleteMany({ where: { entityId: { in: [...orderIds, customer.id] } } })
      await db.salesOrder.deleteMany({ where: { id: { in: orderIds } } })
      await db.customer.deleteMany({ where: { id: customer.id } })
      await db.warehouse.deleteMany({ where: { id: warehouse.id } })
    },
  }
}

async function proof(db: Db, customerId: string) {
  const row = await db.activityLog.findFirstOrThrow({ where: { entityType: 'CUSTOMER', entityId: customerId, action: 'gdpr_erasure_recorded' } })
  return row.metadata as { systems: Record<string, string>; warehouse: { linkedOrders: number; despatched: number; open: number; cancelled: number; notPushed: number; merged: number; openOrders: Array<{ orderId: string; warehouseOrderNumber: string | null }> }; trigger: string }
}

function noNetwork() {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => { calls += 1; throw new Error('an erasure test must make no network call') }) as typeof fetch
  return { calls: () => calls, restore: () => { globalThis.fetch = original } }
}

test('[erasure record] the per-system verdicts and the warehouse enumeration are real, and nothing is written to any external system', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await seed(db, { accounting: true })
  const net = noNetwork()
  t.after(async () => { net.restore(); await fx.cleanup() })
  const { eraseCustomerPersonalData } = await import('@/lib/domain/erasure/erase-personal-data')
  const since = new Date()
  const result = await eraseCustomerPersonalData(fx.customerId, { trigger: 'ON_REQUEST', userId: null })
  assert.equal(result.success, true, JSON.stringify(result))
  const p = await proof(db, fx.customerId)
  // The warehouse's copy, order by order: SHIPPED and the order with a shipment are despatched, the cancelled link is closed, an unpushed link holds nothing,
  // the plain processing order and the MERGED one are OPEN. The order with no link at all is not counted anywhere.
  assert.deepEqual({ ...p.warehouse, openOrders: undefined }, { linkedOrders: 5, despatched: 2, open: 2, cancelled: 1, notPushed: 1, merged: 1, openOrders: undefined })
  assert.deepEqual(p.warehouse.openOrders.map((o) => o.warehouseOrderNumber).sort(), ['MS-2', 'MS-5+MS-6'])
  assert.deepEqual(p.warehouse.openOrders.map((o) => o.orderId).sort(), [fx.ids.open, fx.ids.merged].sort())
  assert.equal(p.systems.warehouse, 'refused', 'open orders: IMS wrote nothing to the live warehouse')
  assert.equal(p.systems.accounting, 'refused-pending-legal', 'the Xero contact is left as it is, pending the accountant')
  assert.equal(p.systems.storefront, 'not-attempted', 'an operator-requested erasure does not touch the storefront')
  assert.equal(p.systems.carrierPortal, 'not-attempted')
  assert.equal(net.calls(), 0, 'no external call of any kind')
  // The proof carries no identity.
  assert.doesNotMatch(JSON.stringify(p), new RegExp(`${NAME}|${EMAIL.replace(/[+.]/g, '\\$&')}`))
  // The operator is told at once, with a count and the request id and nothing about the person; the result carries the same count.
  if (result.success) assert.equal(result.warehouse.open, 2)
  const notes = await db.notification.findMany({ where: { title: 'Personal data remains in the warehouse', createdAt: { gte: since } } })
  assert.equal(notes.length, 1)
  assert.match(notes[0]!.message, /^2 open warehouse orders still hold/)
  assert.doesNotMatch(JSON.stringify(notes), new RegExp(`${NAME}|${EMAIL.replace(/[+.]/g, '\\$&')}`))
  // THE READ-ONLY VIEW shows the record and carries no erased value.
  const { listErasureRecords } = await import('@/lib/domain/erasure/erasure-record-view')
  const rows = await listErasureRecords()
  const mine = rows.find((r) => r.warehouse?.openOrders.some((o) => o.orderId === fx.ids.open))
  assert.ok(mine, 'the record is listed')
  assert.equal(mine!.systems.accounting, 'refused-pending-legal')
  assert.equal(mine!.warehouse!.open, 2)
  assert.equal(mine!.orderCount, 7)
  assert.doesNotMatch(JSON.stringify(rows), new RegExp(`${NAME}|${EMAIL.replace(/[+.]/g, '\\$&')}`), 'the view shows no erased value')
  // The erased orders' own push guard is untouched: the link of an open order is still there and still not sent anywhere.
  assert.equal(await db.wmsOrderPushLink.count({ where: { orderId: { in: fx.orderIds } } }), 6)
})

test('[erasure record] anonymiseCustomer returns the count and a warning for open warehouse orders, and no warning when there are none', { skip }, async (t) => {
  const db = await loadDb()
  const withOpen = await seed(db, { accounting: false })
  t.after(() => withOpen.cleanup())
  const { anonymiseCustomer } = await import('@/app/actions/customers')
  const first = await anonymiseCustomer(withOpen.customerId)
  assert.equal(first.success, true)
  assert.equal(first.openWarehouseOrders, 2)
  assert.match(first.warning ?? '', /2 open warehouse orders/)
  assert.match(first.warning ?? '', /by hand in Mintsoft/)
  assert.doesNotMatch(JSON.stringify(first), new RegExp(`${NAME}|${EMAIL.replace(/[+.]/g, '\\$&')}`))
  assert.equal((await proof(db, withOpen.customerId)).systems.accounting, 'not-applicable', 'no ledger rows: nothing held there')
  // CONTROL: a customer whose orders are all despatched gets no warning and no notification.
  const customer = await db.customer.create({ data: { firstName: 'Zebediah', lastName: 'Quillfeather', email: `${randomUUID().slice(0, 8)}@example.test` } })
  const order = await db.salesOrder.create({ data: { orderNumber: `HON-${randomUUID().slice(0, 8)}`, status: 'DELIVERED', currency: 'GBP', customerId: customer.id, customerName: NAME, subtotalForeign: 1, totalForeign: 1, subtotalBase: 1, totalBase: 1 } as never })
  await db.wmsOrderPushLink.create({ data: { orderId: order.id, connector: 'mintsoft', externalOrderId: 'm-9', externalOrderNumber: 'MS-9', state: 'SYNCED' } as never })
  t.after(async () => { await db.wmsOrderPushLink.deleteMany({ where: { orderId: order.id } }); await db.activityLog.deleteMany({ where: { entityId: { in: [order.id, customer.id] } } }); await db.salesOrder.deleteMany({ where: { id: order.id } }); await db.customer.deleteMany({ where: { id: customer.id } }) })
  const before = await db.notification.count({ where: { title: 'Personal data remains in the warehouse' } })
  const second = await anonymiseCustomer(customer.id)
  assert.deepEqual(second, { success: true })
  assert.equal((await proof(db, customer.id)).systems.warehouse, 'not-technically-possible', 'despatched only: the warehouse cannot be made to erase it')
  assert.equal(await db.notification.count({ where: { title: 'Personal data remains in the warehouse' } }), before)
})

test('[erasure record] the trigger decides the storefront verdict: a mirrored erasure is erased-at-source', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await seed(db, { accounting: false })
  t.after(() => fx.cleanup())
  const { eraseOrderPersonalData } = await import('@/lib/domain/erasure/erase-personal-data')
  const result = await eraseOrderPersonalData(fx.ids.open, { trigger: 'MIRRORED_FROM_STOREFRONT', userId: null })
  assert.equal(result.success, true)
  const row = await db.activityLog.findFirstOrThrow({ where: { entityType: 'SALES_ORDER', entityId: fx.ids.open, action: 'gdpr_erasure_recorded' } })
  const meta = row.metadata as { systems: Record<string, string>; warehouse: { open: number } }
  assert.equal(meta.systems.storefront, 'erased-at-source')
  assert.equal(meta.systems.warehouse, 'refused')
  assert.equal(meta.warehouse.open, 1)
  // The mirror path tells the operator too.
  assert.ok(await db.notification.count({ where: { title: 'Personal data remains in the warehouse', createdAt: { gte: new Date(Date.now() - 60_000) } } }) >= 1)
})
