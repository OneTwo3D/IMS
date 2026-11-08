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
  const merged = await mk('PROCESSING'); const noLink = await mk('DRAFT'); const withShipment = await mk('PROCESSING')
  const confirmedCancel = await mk('PROCESSING'); const notFoundCancel = await mk('PROCESSING'); const legacyNoId = await mk('PROCESSING')
  const partial = await mk('PROCESSING'); const ambiguousA = await mk('PROCESSING'); const ambiguousB = await mk('PROCESSING'); const validationFailed = await mk('PROCESSING')
  const link = (orderId: string, state: string, ext: string | null, num: string | null) =>
    db.wmsOrderPushLink.create({ data: { orderId, connector: 'mintsoft', externalOrderId: ext, externalOrderNumber: num, state } as never })
  await link(despatched.id, 'SYNCED', 'm-1', 'MS-1'); await link(open.id, 'SYNCED', 'm-2', 'MS-2'); await link(cancelled.id, 'CANCELLED', 'm-3', 'MS-3')
  await link(merged.id, 'MERGED', 'm-5', 'MS-5+MS-6'); await link(withShipment.id, 'SYNCED', 'm-7', 'MS-7'); await link(partial.id, 'SYNCED', 'm-8', 'MS-8')
  // A create that was dispatched and whose outcome was never recorded: a state of its own, and a claimed create still in the queue state. Neither has a warehouse id.
  await link(ambiguousA.id, 'AMBIGUOUS_CREATE', null, null)
  await db.wmsOrderPushLink.create({ data: { orderId: ambiguousB.id, connector: 'mintsoft', state: 'PENDING_CREATE', lastAttemptAt: new Date(), firstClaimedAt: new Date() } as never })
  // Cancellations: one the warehouse CONFIRMED (the cancel's audit row says CANCELLED), one it only answered NOT_FOUND to. The plain `cancelled` link above has no audit evidence at all.
  await link(confirmedCancel.id, 'CANCELLED', 'm-10', 'MS-10'); await link(notFoundCancel.id, 'CANCELLED', 'm-11', 'MS-11')
  const cancelEvent = (entityId: string, status: string) => db.wmsMutationEvent.create({ data: { connector: 'mintsoft', direction: 'OUTBOUND', action: 'order_cancel', outcome: 'SUCCEEDED', entityType: 'SALES_ORDER', entityId, summary: 'cancel', after: { state: 'CANCELLED', wmsCancelStatus: status } } as never })
  await cancelEvent(confirmedCancel.id, 'CANCELLED'); await cancelEvent(notFoundCancel.id, 'NOT_FOUND')
  // A legacy or replayed link: no id, every attempt column cleared, in the plain create-queue state. IMS cannot prove nothing was sent.
  await link(legacyNoId.id, 'PENDING_CREATE', null, null)
  // A payload that could not be built: provably never sent.
  await db.wmsOrderPushLink.create({ data: { orderId: validationFailed.id, connector: 'mintsoft', state: 'VALIDATION_FAILED', attempts: 0, lastAttemptAt: new Date() } as never })
  const warehouse = await db.warehouse.create({ data: { code: `HON-${randomUUID().slice(0, 8)}`, name: 'Honesty warehouse', syncToStore: true, availableForSale: true } })
  // A PENDING shipment is not despatch (it is the shape every open order has); a SHIPPED shipment on an order that is not yet SHIPPED is a partial dispatch.
  await db.shipment.create({ data: { orderId: withShipment.id, warehouseId: warehouse.id } })
  await db.shipment.create({ data: { orderId: partial.id, warehouseId: warehouse.id, status: 'SHIPPED', shippedAt: new Date() } as never })
  if (opts.accounting) await db.accountingSyncLog.create({ data: { connector: 'xero', type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: despatched.id, status: 'SYNCED', payload: { contactName: NAME } } as never })
  const orderIds = [despatched.id, open.id, cancelled.id, merged.id, confirmedCancel.id, notFoundCancel.id, legacyNoId.id, noLink.id, withShipment.id, partial.id, ambiguousA.id, ambiguousB.id, validationFailed.id]
  return {
    customerId: customer.id, orderIds, ids: { despatched: despatched.id, open: open.id, merged: merged.id, pendingShipment: withShipment.id, partial: partial.id, ambiguousA: ambiguousA.id, ambiguousB: ambiguousB.id, notFoundCancel: notFoundCancel.id, legacyNoId: legacyNoId.id, cancelledNoEvidence: cancelled.id },
    async cleanup() {
      await db.notification.deleteMany({ where: { title: 'Personal data remains in the warehouse', createdAt: { gte: new Date(Date.now() - 600_000) } } })
      await db.wmsMutationEvent.deleteMany({ where: { entityId: { in: orderIds } } })
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
  return row.metadata as { systems: Record<string, string>; warehouse: { linkedOrders: number; despatched: number; open: number; cancelled: number; notPushed: number; ambiguous: number; merged: number; openOrders: Array<{ orderId: string; warehouseOrderNumber: string | null }>; ambiguousOrders: Array<{ orderId: string; warehouseOrderNumber: string | null }> }; trigger: string }
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
  // The warehouse's copy, order by order: only the SHIPPED order is despatched. The plain processing order, the MERGED one, the order with a PENDING shipment and the
  // partly shipped order (a SHIPPED shipment, order not yet SHIPPED) are all OPEN and listed. The cancelled link is closed. A link that provably never sent holds nothing
  // (never claimed, and the one whose payload could not be built). Two creates whose outcome was never recorded are AMBIGUOUS and listed. The order with no link is not counted.
  assert.deepEqual({ ...p.warehouse, openOrders: undefined, ambiguousOrders: undefined }, { linkedOrders: 8, despatched: 1, open: 4, cancelled: 1, notPushed: 1, ambiguous: 5, merged: 1, openOrders: undefined, ambiguousOrders: undefined })
  assert.deepEqual(p.warehouse.openOrders.map((o) => o.warehouseOrderNumber).sort(), ['MS-2', 'MS-5+MS-6', 'MS-7', 'MS-8'])
  assert.deepEqual(p.warehouse.openOrders.map((o) => o.orderId).sort(), [fx.ids.open, fx.ids.merged, fx.ids.pendingShipment, fx.ids.partial].sort())
  assert.deepEqual(p.warehouse.ambiguousOrders.map((o) => o.orderId).sort(), [fx.ids.ambiguousA, fx.ids.ambiguousB, fx.ids.notFoundCancel, fx.ids.legacyNoId, fx.ids.cancelledNoEvidence].sort())
  assert.ok(p.warehouse.ambiguousOrders.some((o) => o.orderId === fx.ids.notFoundCancel && o.warehouseOrderNumber === 'MS-11'), 'a NOT_FOUND cancellation is listed with its warehouse number')
  assert.equal(p.systems.warehouse, 'refused', 'open orders: IMS wrote nothing to the live warehouse')
  assert.equal(p.systems.accounting, 'refused-pending-legal', 'the Xero contact is left as it is, pending the accountant')
  assert.equal(p.systems.storefront, 'not-attempted', 'an operator-requested erasure does not touch the storefront')
  assert.equal(p.systems.carrierPortal, 'not-attempted')
  assert.equal(net.calls(), 0, 'no external call of any kind')
  // The proof carries no identity.
  assert.doesNotMatch(JSON.stringify(p), new RegExp(`${NAME}|${EMAIL.replace(/[+.]/g, '\\$&')}`))
  // The operator is told at once, with a count and the request id and nothing about the person; the result carries the same count.
  if (result.success) { assert.equal(result.warehouse.open, 4); assert.equal(result.warehouse.ambiguous, 5) }
  const notes = await db.notification.findMany({ where: { title: 'Personal data remains in the warehouse', createdAt: { gte: since } } })
  assert.equal(notes.length, 1)
  assert.match(notes[0]!.message, /^4 open warehouse orders still hold.*5 warehouse orders may exist there/)
  assert.doesNotMatch(JSON.stringify(notes), new RegExp(`${NAME}|${EMAIL.replace(/[+.]/g, '\\$&')}`))
  // THE READ-ONLY VIEW shows the record and carries no erased value.
  const { listErasureRecords } = await import('@/lib/domain/erasure/erasure-record-view')
  const rows = (await listErasureRecords({ onlyObligations: true, limit: 200 })).rows
  const mine = rows.find((r) => r.warehouse?.openOrders.some((o) => o.orderId === fx.ids.open))
  assert.ok(mine, 'the record is listed')
  assert.equal(mine!.systems.accounting, 'refused-pending-legal')
  assert.equal(mine!.warehouse!.open, 4)
  assert.equal(mine!.warehouse!.ambiguousOrders.length, 5)
  assert.equal(mine!.orderCount, 13)
  assert.doesNotMatch(JSON.stringify(rows), new RegExp(`${NAME}|${EMAIL.replace(/[+.]/g, '\\$&')}`), 'the view shows no erased value')
  // The erased orders' own push guard is untouched: the link of an open order is still there and still not sent anywhere.
  assert.equal(await db.wmsOrderPushLink.count({ where: { orderId: { in: fx.orderIds } } }), 12)
})

test('[erasure record] anonymiseCustomer returns the count and a warning for open warehouse orders, and no warning when there are none', { skip }, async (t) => {
  const db = await loadDb()
  const withOpen = await seed(db, { accounting: false })
  t.after(() => withOpen.cleanup())
  const { anonymiseCustomer } = await import('@/app/actions/customers')
  const first = await anonymiseCustomer(withOpen.customerId)
  assert.equal(first.success, true)
  assert.equal(first.openWarehouseOrders, 4)
  assert.equal(first.ambiguousWarehouseOrders, 5)
  assert.match(first.warning ?? '', /4 open warehouse orders/)
  assert.match(first.warning ?? '', /5 warehouse orders may exist there/)
  assert.match(first.warning ?? '', /by hand in the warehouse system/)
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

test('[erasure record] an ambiguous create alone is never "nothing held"; a retained credit-note id alone is "refused-pending-legal"', { skip }, async (t) => {
  const db = await loadDb()
  const { eraseCustomerPersonalData } = await import('@/lib/domain/erasure/erase-personal-data')
  const customer = await db.customer.create({ data: { firstName: 'Zebediah', lastName: 'Quillfeather', email: `${randomUUID().slice(0, 8)}@example.test` } })
  const order = await db.salesOrder.create({ data: { orderNumber: `HON-${randomUUID().slice(0, 8)}`, status: 'PROCESSING', currency: 'GBP', customerId: customer.id, customerName: NAME, subtotalForeign: 1, totalForeign: 1, subtotalBase: 1, totalBase: 1 } as never })
  await db.wmsOrderPushLink.create({ data: { orderId: order.id, connector: 'mintsoft', state: 'AMBIGUOUS_CREATE' } as never })
  // The ledger holds only a retained credit note id (the sync rows are long purged).
  const refund = await db.salesOrderRefund.create({ data: { orderId: order.id, reason: 'damaged', totalForeign: 1, totalBase: 1, accountingCreditNoteId: `cn-${randomUUID()}` } as never })
  t.after(async () => { await db.wmsOrderPushLink.deleteMany({ where: { orderId: order.id } }); await db.salesOrderRefund.deleteMany({ where: { id: refund.id } }); await db.notification.deleteMany({ where: { title: 'Personal data remains in the warehouse', createdAt: { gte: new Date(Date.now() - 600_000) } } }); await db.activityLog.deleteMany({ where: { entityId: { in: [order.id, customer.id] } } }); await db.salesOrder.deleteMany({ where: { id: order.id } }); await db.customer.deleteMany({ where: { id: customer.id } }) })
  assert.equal((await eraseCustomerPersonalData(customer.id, { trigger: 'ON_REQUEST', userId: null })).success, true)
  const p = await proof(db, customer.id)
  assert.equal(p.warehouse.ambiguous, 1)
  assert.deepEqual(p.warehouse.ambiguousOrders, [{ orderId: order.id, warehouseOrderNumber: null }])
  assert.equal(p.systems.warehouse, 'refused', 'an ambiguous create is never read as "nothing held"')
  assert.equal(p.systems.accounting, 'refused-pending-legal', 'a retained credit note id alone still means the ledger holds the document and its contact')
})

test('[erasure record] an order erasure whose customer stays live still sees the customer\'s ledger contact: contact-only is refused-pending-legal', { skip }, async (t) => {
  const db = await loadDb()
  const { eraseOrderPersonalData } = await import('@/lib/domain/erasure/erase-personal-data')
  const customer = await db.customer.create({ data: { firstName: 'Zebediah', lastName: 'Quillfeather', email: `${randomUUID().slice(0, 8)}@example.test`, accountingContactId: `contact-${randomUUID()}` } as never })
  const mk = () => db.salesOrder.create({ data: { orderNumber: `HON-${randomUUID().slice(0, 8)}`, status: 'DELIVERED', currency: 'GBP', customerId: customer.id, customerName: NAME, subtotalForeign: 1, totalForeign: 1, subtotalBase: 1, totalBase: 1 } as never })
  const target = await mk(); const other = await mk()
  t.after(async () => { await db.activityLog.deleteMany({ where: { entityId: { in: [target.id, other.id, customer.id] } } }); await db.salesOrder.deleteMany({ where: { id: { in: [target.id, other.id] } } }); await db.customer.deleteMany({ where: { id: customer.id } }) })
  const result = await eraseOrderPersonalData(target.id, { trigger: 'ON_REQUEST', userId: null })
  assert.equal(result.success, true)
  if (result.success && !result.already) assert.equal(result.customerErased, false, 'PRECONDITION: the customer stays live (another live order)')
  const row = await db.activityLog.findFirstOrThrow({ where: { entityType: 'SALES_ORDER', entityId: target.id, action: 'gdpr_erasure_recorded' } })
  assert.equal((row.metadata as { systems: Record<string, string> }).systems.accounting, 'refused-pending-legal', 'a contact the ledger holds for the live customer is never "nothing held"')
})

test('[erasure record view] a record beyond 200 newer ones is reachable by paging, by the obligations filter and by request id; it lists the IMS order numbers', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await seed(db, { accounting: false })
  const uid = randomUUID().slice(0, 8)
  t.after(async () => { await db.activityLog.deleteMany({ where: { id: { startsWith: `pgrec-${uid}-` } } }); await fx.cleanup() })
  const { eraseCustomerPersonalData } = await import('@/lib/domain/erasure/erase-personal-data')
  const { listErasureRecords } = await import('@/lib/domain/erasure/erasure-record-view')
  assert.equal((await eraseCustomerPersonalData(fx.customerId, { trigger: 'ON_REQUEST', userId: null })).success, true)
  const real = await db.activityLog.findFirstOrThrow({ where: { entityType: 'CUSTOMER', entityId: fx.customerId, action: 'gdpr_erasure_recorded' } })
  const realRequestId = (real.metadata as { requestId: string }).requestId
  // 210 NEWER records (nothing outstanding in them): the real one is now the 211th, past any 200-row list.
  const N = 210
  await db.$executeRaw`
    INSERT INTO "activity_logs" ("id", "entityType", "entityId", "action", "tag", "level", "description", "metadata", "createdAt")
    SELECT ${`pgrec-${uid}-`} || g, 'CUSTOMER', 'pgrec-' || g, 'gdpr_erasure_recorded', 'sales', 'INFO', 'Personal data erased (see metadata for the request, scope and per-system verdicts)',
           jsonb_build_object('requestId', ${`pgrec-${uid}-`} || g, 'erasedAt', now(), 'trigger', 'ON_REQUEST', 'orderIds', '[]'::jsonb, 'counts', '{}'::jsonb, 'systems', '{}'::jsonb,
                              'warehouse', jsonb_build_object('linkedOrders', 0, 'open', 0, 'ambiguous', 0, 'despatched', 0, 'cancelled', 0, 'notPushed', 0, 'merged', 0, 'openOrders', '[]'::jsonb, 'ambiguousOrders', '[]'::jsonb)),
           now() + (g || ' seconds')::interval
      FROM generate_series(1, ${N}) g`
  // PAGING: the real record is reached by following the cursor, and only after more than 200 newer rows.
  let cursor: string | undefined
  let seen = 0; let pages = 0; let found = false
  for (let i = 0; i < 20 && !found; i += 1) {
    const page = await listErasureRecords({ cursor, limit: 50 })
    pages += 1
    for (const r of page.rows) { if (r.requestId === realRequestId) found = true; else seen += 1 }
    if (!page.nextCursor) break
    cursor = page.nextCursor
  }
  assert.ok(found, 'the record is reachable by paging')
  assert.ok(seen >= N, `it sits beyond ${N} newer rows (saw ${seen} first, in ${pages} pages)`)
  // FILTER: the obligations filter shows it on the first page.
  const filtered = await listErasureRecords({ onlyObligations: true, limit: 50 })
  const mine = filtered.rows.find((r) => r.requestId === realRequestId)
  assert.ok(mine, 'the obligations filter shows it on the first page')
  assert.ok(filtered.rows.every((r) => (r.warehouse?.open ?? 0) > 0 || (r.warehouse?.ambiguous ?? 0) > 0), 'the filter shows only records with something outstanding')
  // LOOKUP: by request id, exactly that record.
  const looked = await listErasureRecords({ requestId: realRequestId })
  assert.deepEqual(looked.rows.map((r) => r.requestId), [realRequestId])
  assert.equal(looked.nextCursor, null)
  // The IMS order numbers of the listed warehouse orders come with the record, so an order with no warehouse number is still identifiable by its IMS order.
  const open = await db.salesOrder.findUniqueOrThrow({ where: { id: fx.ids.open }, select: { orderNumber: true } })
  assert.equal(mine!.orderNumbers[fx.ids.open], open.orderNumber)
  assert.doesNotMatch(JSON.stringify([...filtered.rows, ...looked.rows]), new RegExp(`${NAME}|${EMAIL.replace(/[+.]/g, '\\$&')}`), 'identity-free')
})

test('[erasure record] a cancellation the warehouse confirmed is NOT proof once a reconcile found the order still active: open finding = ambiguous, resolved = closed', { skip }, async (t) => {
  const db = await loadDb()
  const { eraseCustomerPersonalData } = await import('@/lib/domain/erasure/erase-personal-data')
  const make = async (resolved: boolean) => {
    const customer = await db.customer.create({ data: { firstName: 'Zebediah', lastName: 'Quillfeather', email: `${randomUUID().slice(0, 8)}@example.test` } })
    const order = await db.salesOrder.create({ data: { orderNumber: `HON-${randomUUID().slice(0, 8)}`, status: 'CANCELLED', currency: 'GBP', customerId: customer.id, customerName: NAME, subtotalForeign: 1, totalForeign: 1, subtotalBase: 1, totalBase: 1 } as never })
    await db.wmsOrderPushLink.create({ data: { orderId: order.id, connector: 'mintsoft', externalOrderId: 'm-20', externalOrderNumber: 'MS-20', state: 'CANCELLED' } as never })
    await db.wmsMutationEvent.create({ data: { connector: 'mintsoft', direction: 'OUTBOUND', action: 'order_cancel', outcome: 'SUCCEEDED', entityType: 'SALES_ORDER', entityId: order.id, summary: 'cancel', after: { state: 'CANCELLED', wmsCancelStatus: 'CANCELLED' } } as never })
    await db.wmsOrderDiscrepancy.create({ data: { connector: 'mintsoft', orderId: order.id, category: 'ACTIVE_AFTER_CANCEL', status: resolved ? 'RESOLVED' : 'OPEN', externalOrderNumber: 'MS-20', resolvedAt: resolved ? new Date() : null } as never })
    t.after(async () => { await db.wmsOrderDiscrepancy.deleteMany({ where: { orderId: order.id } }); await db.wmsMutationEvent.deleteMany({ where: { entityId: order.id } }); await db.wmsOrderPushLink.deleteMany({ where: { orderId: order.id } }); await db.notification.deleteMany({ where: { title: 'Personal data remains in the warehouse', createdAt: { gte: new Date(Date.now() - 600_000) } } }); await db.activityLog.deleteMany({ where: { entityId: { in: [order.id, customer.id] } } }); await db.salesOrder.deleteMany({ where: { id: order.id } }); await db.customer.deleteMany({ where: { id: customer.id } }) })
    return { customerId: customer.id, orderId: order.id }
  }
  const active = await make(false)
  assert.equal((await eraseCustomerPersonalData(active.customerId, { trigger: 'ON_REQUEST', userId: null })).success, true)
  const a = await proof(db, active.customerId)
  assert.equal(a.warehouse.cancelled, 0)
  assert.equal(a.warehouse.ambiguous, 1)
  assert.deepEqual(a.warehouse.ambiguousOrders, [{ orderId: active.orderId, warehouseOrderNumber: 'MS-20' }])
  assert.equal(a.systems.warehouse, 'refused')
  // CONTROL: the same order with the finding RESOLVED is closed.
  const resolved = await make(true)
  assert.equal((await eraseCustomerPersonalData(resolved.customerId, { trigger: 'ON_REQUEST', userId: null })).success, true)
  const r = await proof(db, resolved.customerId)
  assert.equal(r.warehouse.cancelled, 1)
  assert.equal(r.warehouse.ambiguous, 0)
  assert.equal(r.systems.warehouse, 'not-technically-possible')
})

test('[erasure record] the operator notice commits WITH the erasure: a failed notice insert rolls the erasure back; the normal path writes exactly one notice per erasure', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await seed(db, { accounting: false })
  t.after(async () => { await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS zz_fail_notice ON "notifications"`); await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS zz_fail_notice()`); await fx.cleanup() })
  const { eraseCustomerPersonalData } = await import('@/lib/domain/erasure/erase-personal-data')
  const since = new Date()
  await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION zz_fail_notice() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."title" = 'Personal data remains in the warehouse' THEN RAISE EXCEPTION 'injected notice failure'; END IF; RETURN NEW; END $$`)
  await db.$executeRawUnsafe(`CREATE TRIGGER zz_fail_notice BEFORE INSERT ON "notifications" FOR EACH ROW EXECUTE FUNCTION zz_fail_notice()`)
  const failed = await eraseCustomerPersonalData(fx.customerId, { trigger: 'ON_REQUEST', userId: null })
  assert.equal(failed.success, false, 'the erasure fails rather than committing without its alert')
  assert.equal((await db.customer.findUniqueOrThrow({ where: { id: fx.customerId } })).gdprAnonymisedAt, null, 'rolled back: the customer is not erased')
  assert.equal((await db.salesOrder.findUniqueOrThrow({ where: { id: fx.ids.open } })).erasedAt, null)
  assert.equal(await db.activityLog.count({ where: { entityType: 'CUSTOMER', entityId: fx.customerId, action: 'gdpr_erasure_recorded' } }), 0, 'no record without the alert')
  assert.equal(await db.notification.count({ where: { title: 'Personal data remains in the warehouse', createdAt: { gte: since } } }), 0)
  // The failure is visible (an ERROR activity row for the failed erasure).
  assert.ok(await db.activityLog.count({ where: { entityType: 'CUSTOMER', entityId: fx.customerId, action: 'gdpr_erasure_failed', level: 'ERROR' } }) >= 1)
  // The fault is removed: the retry commits the erasure and exactly ONE notice.
  await db.$executeRawUnsafe(`DROP TRIGGER zz_fail_notice ON "notifications"`)
  const ok = await eraseCustomerPersonalData(fx.customerId, { trigger: 'ON_REQUEST', userId: null })
  assert.equal(ok.success, true)
  const notes = await db.notification.findMany({ where: { title: 'Personal data remains in the warehouse', createdAt: { gte: since } } })
  assert.equal(notes.length, 1)
  assert.equal(notes[0]!.userId, null, 'a broadcast: every user sees it')
  assert.equal(notes[0]!.actionUrl, '/settings/erasure?filter=obligations')
  if (ok.success) assert.match(notes[0]!.message, new RegExp(ok.requestId))
})
