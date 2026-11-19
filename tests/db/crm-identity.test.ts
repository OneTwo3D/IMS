import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

/**
 * CRM CUSTOMER IDENTITY AGAINST A REAL DATABASE (o3d-t6lg8): the migration's guarantees (insert-only audit table, pair order, actor shape, the expression
 * index), the SQL twin of the identity fold, the importer's case-insensitive match and auto-merge audit, merge and unmerge with their audit, the timeline,
 * the whole-cluster erasure, and the stored-payload backfill of the storefront customer id. GATED on RUN_DB_RETENTION_TESTS (npm run test:db).
 * No WooCommerce, Xero or warehouse call is made: nothing here reaches the network.
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'
if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1, so every test in tests/db/crm-identity.test.ts would have been skipped')
}

let role = 'ADMIN'
let userId = 'crm-user'
mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: userId, role } }),
    requireRole: async (...roles: string[]) => {
      if (!roles.includes(role)) throw new Error('forbidden')
      return { user: { id: userId, role } }
    },
    requireApiAuth: async () => ({ user: { id: 'u', role } }),
    requireInternalUser: async () => ({ user: { id: 'u', role } }),
  },
})
mock.module('@/lib/auth', { namedExports: { auth: async () => null } })
mock.module('next/cache', { namedExports: { revalidatePath: () => undefined, revalidateTag: () => undefined } })

async function setup() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const { db } = await import('@/lib/db')
  const RUN = `crm${randomUUID().slice(0, 8)}`
  // The activity log keeps a foreign key to the acting user, so the signed-in user the mocked session names is a real row.
  const actor = await db.user.create({ data: { email: `${RUN}@example.test`, name: RUN, passwordHash: 'x', role: 'ADMIN' }, select: { id: true } })
  userId = actor.id
  const customerIds: string[] = []
  const orderIds: string[] = []
  const customer = async (label: string, email: string | null, extra: Record<string, unknown> = {}) => {
    const row = await db.customer.create({ data: { firstName: label, lastName: RUN, email, ...extra }, select: { id: true } })
    customerIds.push(row.id)
    return row.id
  }
  const order = async (label: string, customerId: string | null, extra: Record<string, unknown> = {}) => {
    const row = await db.salesOrder.create({
      data: { orderNumber: `${RUN}-${label}`, status: 'PROCESSING', currency: 'GBP', customerId, customerName: `${label} ${RUN}`, customerEmail: `${label}.${RUN}@example.test`, subtotalForeign: 10, totalForeign: 12, subtotalBase: 10, totalBase: 12, ...extra },
      select: { id: true },
    })
    orderIds.push(row.id)
    return row.id
  }
  const cleanup = async () => {
    await db.activityLog.deleteMany({ where: { OR: [{ entityId: { in: [...orderIds, ...customerIds] } }, { description: { contains: RUN } }] } })
    await db.payment.deleteMany({ where: { orderId: { in: orderIds } } })
    await db.returnExpectation.deleteMany({ where: { orderId: { in: orderIds } } })
    await db.salesOrderRefundLine.deleteMany({ where: { refund: { orderId: { in: orderIds } } } })
    await db.salesOrderRefund.deleteMany({ where: { orderId: { in: orderIds } } })
    await db.shoppingOrderLink.deleteMany({ where: { orderId: { in: orderIds } } })
    await db.shoppingWebhookEvent.deleteMany({ where: { payloadHash: { startsWith: RUN } } })
    await db.salesOrder.deleteMany({ where: { id: { in: orderIds } } })
    await db.shoppingCustomerLink.deleteMany({ where: { customerId: { in: customerIds } } })
    await db.customer.deleteMany({ where: { id: { in: customerIds } } })
    await db.activityLog.deleteMany({ where: { userId: actor.id } })
    await db.user.deleteMany({ where: { id: actor.id } })
  }
  return { db, RUN, customer, order, cleanup }
}

test('the audit table is insert-only, stores the pair once, and names the actor', { skip }, async (t) => {
  const { db, RUN, customer, cleanup } = await setup()
  t.after(cleanup)
  const a = await customer('a', `${RUN}.a@example.test`)
  const b = await customer('b', `${RUN}.b@example.test`)
  const [lo, hi] = a < b ? [a, b] : [b, a]
  const row = await db.customerMergeEvent.create({ data: { kind: 'MERGE', source: 'OPERATOR', customerId: lo, otherCustomerId: hi, decidedByUserId: 'u1' } })
  await assert.rejects(db.customerMergeEvent.update({ where: { id: row.id }, data: { kind: 'UNMERGE' } }), /insert-only/)
  await assert.rejects(db.customerMergeEvent.delete({ where: { id: row.id } }), /insert-only/)
  await assert.rejects(db.$executeRawUnsafe('TRUNCATE "customer_merge_events"'), /insert-only/)
  await assert.rejects(db.customerMergeEvent.create({ data: { kind: 'MERGE', source: 'OPERATOR', customerId: hi, otherCustomerId: lo, decidedByUserId: 'u1' } }), /customer_merge_events_pair_ordered/)
  await assert.rejects(db.customerMergeEvent.create({ data: { kind: 'MERGE', source: 'OPERATOR', customerId: lo, otherCustomerId: hi } }), /customer_merge_events_actor_matches_source/)
  await assert.rejects(db.customerMergeEvent.create({ data: { kind: 'UNMERGE', source: 'AUTO_EMAIL', customerId: lo, otherCustomerId: hi } }), /customer_merge_events_actor_matches_source/)
  const indexes = await db.$queryRaw<Array<{ indexname: string }>>`SELECT indexname FROM pg_indexes WHERE indexname IN ('customers_identity_key_idx', 'sales_orders_customerId_createdAt_idx')`
  assert.equal(indexes.length, 2, 'the expression index and the timeline index exist')
})

test('the SQL fold used to find candidates gives the same key as looseIdentityEmail', { skip }, async () => {
  const { db } = await setup()
  const { looseIdentityEmail } = await import('@/lib/domain/crm/identity-key')
  const { CUSTOMER_LOOSE_EMAIL_KEY_SQL } = await import('@/lib/domain/crm/cluster-resolver')
  const { Prisma } = await import('@/app/generated/prisma/client')
  const samples = ['Jane.Doe@Gmail.com', ' jane.doe+shop@googlemail.com ', 'a.b.c@example.com', 'X+tag@Example.COM', 'plain@example.org', 'first.last+a+b@gmail.com']
  for (const email of samples) {
    const rows = await db.$queryRaw<Array<{ k: string }>>(Prisma.sql`SELECT ${CUSTOMER_LOOSE_EMAIL_KEY_SQL} AS k FROM (SELECT ${email}::text AS "email") t`)
    assert.equal(rows[0]!.k, looseIdentityEmail(email), email)
  }
})

test('the importer matches an email case-insensitively and records the audit link for a +tag variant, once', { skip }, async (t) => {
  const { db, RUN, customer, cleanup } = await setup()
  t.after(cleanup)
  const { upsertCustomer } = await import('@/lib/connectors/woocommerce/sync/field-mapping')
  const existing = await customer('Existing', `jane.${RUN}@example.test`)
  const wcOrder = (email: string, customerId = 0) => ({
    customer_id: customerId,
    billing: { first_name: 'Jane', last_name: RUN, email, phone: '', company: '', address_1: '1 High St', address_2: '', city: 'Town', state: '', postcode: 'AB1 2CD', country: 'GB' },
    shipping: { first_name: 'Jane', last_name: RUN, company: '', phone: '', address_1: '1 High St', address_2: '', city: 'Town', state: '', postcode: 'AB1 2CD', country: 'GB' },
  }) as never
  // REGRESSION: a different-case address used to create a second customer.
  const same = await upsertCustomer(wcOrder(` Jane.${RUN}@Example.TEST `))
  assert.equal(same, existing, 'matched the existing customer ignoring case and surrounding whitespace')
  // A +tag variant is a new row, joined by the cluster, with ONE audit row however often it is seen.
  const variant = await db.$transaction(async (tx) => {
    const id = await upsertCustomer(wcOrder(`jane.${RUN}+shop@example.test`), tx)
    await (await import('@/lib/domain/crm/merge-service')).recordAutoMergeAudit(tx, id!)
    return id!
  })
  t.after(async () => { await db.customer.deleteMany({ where: { id: variant } }) })
  assert.notEqual(variant, existing)
  const [lo, hi] = existing < variant ? [existing, variant] : [variant, existing]
  const rows = await db.customerMergeEvent.findMany({ where: { customerId: lo, otherCustomerId: hi } })
  assert.equal(rows.length, 1)
  assert.deepEqual([rows[0]!.kind, rows[0]!.source, rows[0]!.decidedByUserId], ['MERGE', 'AUTO_EMAIL', null])
  const { clusterOf } = await import('@/lib/domain/crm/cluster-resolver')
  assert.deepEqual((await clusterOf(db, existing)).ids, [existing, variant].sort())
})

test('merge and unmerge are audited, restricted to MANAGER and ADMIN, and never touch the customer rows', { skip }, async (t) => {
  const { db, RUN, customer, cleanup } = await setup()
  t.after(cleanup)
  const actions = await import('@/app/actions/customer-identity')
  const { clusterOf } = await import('@/lib/domain/crm/cluster-resolver')
  const a = await customer('a', `${RUN}.one@example.test`)
  const b = await customer('b', `${RUN}.two@example.test`)
  const c = await customer('c', `${RUN}.one+x@example.test`)
  assert.deepEqual((await clusterOf(db, a)).ids, [a, c].sort(), 'the +tag variant is the same person without anyone acting')
  const before = await db.customer.findMany({ where: { id: { in: [a, b, c] } }, orderBy: { id: 'asc' } })

  role = 'WAREHOUSE'
  await assert.rejects(actions.mergeCustomersAction(a, b), /forbidden/)
  await assert.rejects(actions.unmergeCustomerAction(a), /forbidden/)
  role = 'MANAGER'
  assert.deepEqual(await actions.mergeCustomersAction(a, b), { success: true })
  assert.deepEqual((await clusterOf(db, a)).ids, [a, b, c].sort())
  assert.equal((await actions.mergeCustomersAction(a, b)).success, false, 'already the same person')
  assert.equal((await actions.mergeCustomersAction(a, a)).success, false)

  // unmerge a: blocks a from every other member; b and c stay together (b joined to c? no: b was merged with a only)
  assert.deepEqual(await actions.unmergeCustomerAction(a), { success: true })
  assert.deepEqual((await clusterOf(db, a)).ids, [a])
  assert.deepEqual((await clusterOf(db, b)).ids, [b])
  assert.deepEqual((await clusterOf(db, c)).ids, [c])
  assert.equal((await actions.unmergeCustomerAction(a)).success, false, 'not merged with anyone any more')
  role = 'ADMIN'
  assert.deepEqual(await actions.mergeCustomersAction(a, c), { success: true }, 'a later merge beats the earlier unmerge')
  assert.deepEqual((await clusterOf(db, a)).ids, [a, c].sort())

  const events = await db.customerMergeEvent.findMany({ where: { OR: [{ customerId: { in: [a, b, c] } }, { otherCustomerId: { in: [a, b, c] } }] }, orderBy: { seq: 'asc' } })
  assert.ok(events.every((e) => e.source === 'OPERATOR' && e.decidedByUserId === userId))
  assert.deepEqual(events.map((e) => e.kind), ['MERGE', 'UNMERGE', 'UNMERGE', 'MERGE'])
  assert.deepEqual(await db.customer.findMany({ where: { id: { in: [a, b, c] } }, orderBy: { id: 'asc' } }), before, 'no Customer row was changed')
  const logged = await db.activityLog.findMany({ where: { entityId: { in: [a, b, c] }, action: { in: ['customer_merged', 'customer_unmerged'] } } })
  assert.equal(logged.length, 3)
  assert.ok(logged.every((l) => !/@/.test(JSON.stringify(l.metadata)) && !l.description.includes(RUN)))
})

test('the timeline lists orders, invoices, payments, credit notes and returns of the whole cluster, newest first, and nothing of anyone else', { skip }, async (t) => {
  const { db, RUN, customer, order, cleanup } = await setup()
  t.after(cleanup)
  const { loadTimeline } = await import('@/lib/domain/crm/timeline')
  const { Prisma } = await import('@/app/generated/prisma/client')
  const a = await customer('a', `${RUN}.t@example.test`)
  const b = await customer('b', `${RUN}.t+two@example.test`)
  const other = await customer('o', `${RUN}.other@example.test`)
  const day = (n: number) => new Date(Date.UTC(2026, 0, n, 12))
  const o1 = await order('1', a, { createdAt: day(1), invoicedAt: day(2), invoiceNumber: `INV-${RUN}` })
  const o2 = await order('2', b, { createdAt: day(5), status: 'CANCELLED' })
  // The database stamps cancelled_at itself (now), so the cancellation is the newest event.
  const oOther = await order('9', other, { createdAt: day(3) })
  await db.payment.create({ data: { orderId: o1, amount: new Prisma.Decimal('12'), currency: 'GBP', method: 'Card', paidAt: day(3) } })
  await db.payment.create({ data: { orderId: oOther, amount: new Prisma.Decimal('12'), currency: 'GBP', method: 'Card', paidAt: day(3) } })
  const refund = await db.salesOrderRefund.create({ data: { orderId: o1, creditNoteNumber: `CN-${RUN}`, totalForeign: new Prisma.Decimal('5'), totalBase: new Prisma.Decimal('5'), createdAt: day(4) } })
  await db.payment.create({ data: { orderId: o1, refundId: refund.id, amount: new Prisma.Decimal('-5'), currency: 'GBP', method: 'Card', paidAt: day(4) } })
  await db.wmsReturnsInbox.create({ data: { connector: 'mintsoft', externalReturnId: `${RUN}-r`, orderId: o2, createdAt: day(7) } })
  const ids = [a, b]
  const page = await loadTimeline(db, ids)
  assert.deepEqual(page.events.map((e) => e.kind), ['ORDER_CANCELLED', 'WAREHOUSE_RETURN', 'ORDER_PLACED', 'REFUND_PAYMENT', 'CREDIT_NOTE', 'PAYMENT', 'INVOICE', 'ORDER_PLACED'])
  assert.ok(page.events.every((e) => e.orderId !== oOther), 'another customer’s events are never listed')
  assert.ok(!JSON.stringify(page.events).includes('@'), 'no email in a timeline event')
  // pagination: page size 3 walks the same list with no repeat and no gap
  const seen: string[] = []
  let cursor: string | null = null
  for (let i = 0; i < 10; i++) {
    const p = await loadTimeline(db, ids, { limit: 3, cursor })
    seen.push(...p.events.map((e) => e.key))
    if (!p.nextCursor) break
    cursor = p.nextCursor
  }
  assert.deepEqual(seen, page.events.map((e) => e.key))
  const mine = await loadTimeline(db, [b])
  assert.deepEqual(mine.events.map((e) => e.kind), ['ORDER_CANCELLED', 'WAREHOUSE_RETURN', 'ORDER_PLACED'])
})

test('erasing one customer erases the whole cluster, keeps the audit rows, and leaves other customers alone', { skip }, async (t) => {
  const { db, RUN, customer, order, cleanup } = await setup()
  t.after(cleanup)
  const actions = await import('@/app/actions/customer-identity')
  const customers = await import('@/app/actions/customers')
  const a = await customer('a', `${RUN}.e@example.test`, { phone: '0123' })
  const b = await customer('b', `${RUN}.e+shop@example.test`, { phone: '0456' })
  const c = await customer('c', `${RUN}.different@example.test`) // merged by an operator, different email
  const bystander = await customer('x', `${RUN}.bystander@example.test`)
  role = 'ADMIN'
  assert.equal((await actions.mergeCustomersAction(a, c)).success, true)
  const oa = await order('a', a, { externalCustomerId: 4242 })
  const ob = await order('b', b, { externalCustomerId: 4242 }) // same storefront account as a: still one person
  const oc = await order('c', c)
  const ox = await order('x', bystander, { externalCustomerId: 4244 })

  const result = await customers.anonymiseCustomer(b)
  assert.equal(result.success, true, JSON.stringify(result))
  assert.equal(result.erasedRecords, 3)
  const rows = await db.customer.findMany({ where: { id: { in: [a, b, c, bystander] } }, select: { id: true, email: true, phone: true, gdprAnonymisedAt: true } })
  const byId = new Map(rows.map((r) => [r.id, r]))
  for (const id of [a, b, c]) {
    assert.ok(byId.get(id)!.gdprAnonymisedAt, `${id} anonymised`)
    assert.equal(byId.get(id)!.email, null)
    assert.equal(byId.get(id)!.phone, null)
  }
  assert.equal(byId.get(bystander)!.gdprAnonymisedAt, null)
  assert.ok(byId.get(bystander)!.email)
  const orders = await db.salesOrder.findMany({ where: { id: { in: [oa, ob, oc, ox] } }, select: { id: true, erasedAt: true, customerEmail: true, externalCustomerId: true } })
  for (const o of orders) {
    if (o.id === ox) assert.deepEqual([o.erasedAt === null, o.externalCustomerId], [true, 4244])
    else assert.deepEqual([o.erasedAt !== null, o.customerEmail, o.externalCustomerId], [true, null, null], 'erased order lost its identity and its storefront customer id')
  }
  assert.ok((await db.customerMergeEvent.count({ where: { OR: [{ customerId: { in: [a, b, c] } }, { otherCustomerId: { in: [a, b, c] } }] } })) >= 1, 'the audit rows are kept')
  assert.equal((await customers.anonymiseCustomer(a)).success, false, 'a second request refuses')
})

test('the stored-payload backfill fills the storefront customer id from a delivery already on file, and never from WooCommerce', { skip }, async (t) => {
  const { db, RUN, customer, order, cleanup } = await setup()
  t.after(cleanup)
  const { applyOrderCustomerIdBackfill, countBackfillableOrders } = await import('@/lib/domain/crm/order-customer-id-backfill')
  const c = await customer('bf', `${RUN}.bf@example.test`)
  const link = async (orderId: string, wcId: string) => db.shoppingOrderLink.create({ data: { orderId, connector: 'woocommerce', externalOrderId: wcId } })
  const delivery = (wcId: string, payload: Record<string, unknown>, suffix: string, receivedAt: Date) => db.shoppingWebhookEvent.create({
    data: { connector: 'woocommerce', resource: 'orders', payloadHash: `${RUN}-${suffix}`, payloadJson: { id: Number(wcId), ...payload }, status: 'PROCESSED', receivedAt },
  })
  const base = 7_000_000 + Math.floor(Math.random() * 1_000_000)
  const fill = await order('fill', c)
  const guest = await order('guest', c)
  const have = await order('have', c, { externalCustomerId: 99 })
  const erased = await order('erased', c, { erasedAt: new Date() })
  const unlinked = await order('unlinked', c)
  await link(fill, String(base)); await link(guest, String(base + 1)); await link(have, String(base + 2)); await link(erased, String(base + 3))
  await delivery(String(base), { customer_id: 11 }, 'old', new Date('2026-01-01'))
  await delivery(String(base), { customer_id: 12 }, 'new', new Date('2026-02-01'))
  await delivery(String(base + 1), { customer_id: 0 }, 'guest', new Date('2026-01-01'))
  await delivery(String(base + 2), { customer_id: 55 }, 'have', new Date('2026-01-01'))
  await delivery(String(base + 3), { customer_id: 66 }, 'erased', new Date('2026-01-01'))
  const stamp = async () => (await db.$queryRaw<Array<{ id: string; u: Date; e: number | null }>>`SELECT "id", "updatedAt" AS u, "external_customer_id" AS e FROM "sales_orders" WHERE "id" IN (${fill}, ${guest}, ${have}, ${erased}, ${unlinked}) ORDER BY "id"`)
  const before = await stamp()
  const dry = await db.$transaction((tx) => countBackfillableOrders(tx))
  assert.equal(dry.orders >= 1, true)
  assert.deepEqual(await stamp(), before, 'a dry run writes nothing')
  await db.$transaction((tx) => applyOrderCustomerIdBackfill(tx))
  const after = new Map((await stamp()).map((r) => [r.id, r]))
  assert.equal(after.get(fill)!.e, 12, 'the NEWEST delivery wins')
  assert.equal(after.get(guest)!.e, null, 'customer_id 0 is no evidence')
  assert.equal(after.get(have)!.e, 99, 'a stored id is never overwritten')
  assert.equal(after.get(erased)!.e, null, 'an erased order is never refilled')
  assert.equal(after.get(unlinked)!.e, null)
  for (const row of before) assert.equal(after.get(row.id)!.u.getTime(), row.u.getTime(), 'updatedAt is not raised')
})
