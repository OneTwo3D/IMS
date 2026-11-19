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
let freshSignIn = true
mock.module('@/lib/auth/server', {
  namedExports: {
    freshAuthFailureResult: (e: { name?: string; message?: string; code?: string; reason?: string } | null) => (e?.name === 'FreshAuthRequiredError' ? { success: false, error: e.message, code: e.code, reason: e.reason } : null),
    requireFreshRole: async (...roles: string[]) => {
      if (!roles.includes(role)) throw new Error('forbidden')
      const gates = await import('@/lib/auth/session-gates')
      return gates.requireFreshAuthSession({ user: { id: userId, role, sessionAuthTime: freshSignIn ? Math.floor(Date.now() / 1000) : 1 } } as never)
    },
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
    await db.customerClusterErasure.deleteMany({ where: { memberIds: { hasSome: customerIds } } })
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
  const indexes = await db.$queryRaw<Array<{ indexname: string }>>`SELECT c.relname AS indexname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE i.indisvalid AND c.relname IN ('customers_identity_key_idx', 'sales_orders_customerId_createdAt_idx', 'customers_loose_identity_key_v2_idx', 'customers_email_lower_btrim_idx', 'sales_orders_external_customer_id_idx')`
  assert.equal(indexes.length, 5, 'every CRM index exists and is VALID (an interrupted CONCURRENTLY build leaves an INVALID one)')
})

test('the SQL fold used to find candidates gives the same key as looseIdentityEmail, on whitespace, NFC/NFD and non-ASCII samples too', { skip }, async () => {
  const { db } = await setup()
  const { looseIdentityEmail } = await import('@/lib/domain/crm/identity-key')
  const { CUSTOMER_LOOSE_EMAIL_KEY_SQL } = await import('@/lib/domain/crm/cluster-resolver')
  const { Prisma } = await import('@/app/generated/prisma/client')
  const samples = [
    'Jane.Doe@Gmail.com', ' jane.doe+shop@googlemail.com ', 'a.b.c@example.com', 'X+tag@Example.COM', 'plain@example.org', 'first.last+a+b@gmail.com',
    // white space: every kind at the ends is trimmed, inside it makes the address unusable (null on both sides)
    '\tjane@example.com\n', '\u00a0jane@example.com\u00a0', '\u3000Jane@Example.com\u2003', '\ufeffjane@example.com', 'jane\u2028@example.com', 'ja ne@example.com', 'jane@exa\tmple.com', '   ',
    // Unicode: NFD and NFC are one key, the Kelvin sign composes to K, a non-ASCII capital is NOT folded (ASCII-only lower on both sides)
    'jose\u0301@example.com', 'jos\u00e9@example.com', 'JOSE\u0301@Example.com', '\u212Aelvin@example.com', 'JOS\u00c9@example.com', 'jos\u00e9+tag@gmail.com', '\u00fcber.user@gmail.com',
    // malformed
    '+tag@example.com', '+tag@gmail.com', '....@gmail.com', 'a@@b.com', 'nobody', '@example.com', 'a@', 'a@b@c.com',
  ]
  for (const email of samples) {
    const rows = await db.$queryRaw<Array<{ k: string | null }>>(Prisma.sql`SELECT ${CUSTOMER_LOOSE_EMAIL_KEY_SQL} AS k FROM (SELECT ${email}::text AS "email") t`)
    assert.equal(rows[0]!.k, looseIdentityEmail(email), JSON.stringify(email))
  }
  // equal keys on one side are equal on the other: the composed and decomposed spellings find each other
  const keyOf = async (email: string) => (await db.$queryRaw<Array<{ k: string | null }>>(Prisma.sql`SELECT ${CUSTOMER_LOOSE_EMAIL_KEY_SQL} AS k FROM (SELECT ${email}::text AS "email") t`))[0]!.k
  assert.equal(await keyOf('jose\u0301@example.com'), await keyOf('JOS\u00e9@example.com'.replace('\u00c9', '\u00e9')))
  assert.equal(await keyOf('\tjane@example.com\n'), await keyOf('jane@example.com'))
})

test('the resolver finds a customer stored with a tab, NBSP or decomposed spelling from a clean seed, and the other way round (an erasure must not miss it)', { skip }, async (t) => {
  const { db, RUN, customer, cleanup } = await setup()
  t.after(cleanup)
  const { clusterOf } = await import('@/lib/domain/crm/cluster-resolver')
  const clean = await customer('clean', `jos\u00e9.${RUN}@example.test`)
  const dirtyTab = await customer('tab', `\tjos\u00e9.${RUN}@example.test\n`)
  const dirtyNfd = await customer('nfd', `jose\u0301.${RUN}+x@example.test`)
  const dirtyNbsp = await customer('nbsp', `\u00a0JOS\u00e9.${RUN}@example.test`) // non-ASCII capital É is not involved: only the NBSP differs
  const expected = [clean, dirtyTab, dirtyNfd, dirtyNbsp].sort()
  for (const seed of [clean, dirtyTab, dirtyNfd, dirtyNbsp]) assert.deepEqual((await clusterOf(db, seed)).ids, expected, `from ${seed}`)
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
  await assert.rejects(actions.mergeCustomersAction(a, b, true), /forbidden/)
  await assert.rejects(actions.unmergeCustomerAction(a, true), /forbidden/)
  role = 'MANAGER'
  assert.deepEqual(await actions.mergeCustomersAction(a, b, true), { success: true })
  assert.deepEqual((await clusterOf(db, a)).ids, [a, b, c].sort())
  assert.equal((await actions.mergeCustomersAction(a, b, true)).success, false, 'already the same person')
  assert.equal((await actions.mergeCustomersAction(a, a, true)).success, false)

  // unmerge a: blocks a from every other member; b and c stay together (b joined to c? no: b was merged with a only)
  assert.deepEqual(await actions.unmergeCustomerAction(a, true), { success: true })
  assert.deepEqual((await clusterOf(db, a)).ids, [a])
  assert.deepEqual((await clusterOf(db, b)).ids, [b])
  assert.deepEqual((await clusterOf(db, c)).ids, [c])
  assert.equal((await actions.unmergeCustomerAction(a, true)).success, false, 'not merged with anyone any more')
  role = 'ADMIN'
  assert.deepEqual(await actions.mergeCustomersAction(a, c, true), { success: true }, 'a later merge beats the earlier unmerge')
  assert.deepEqual((await clusterOf(db, a)).ids, [a, c].sort())

  const events = await db.customerMergeEvent.findMany({ where: { OR: [{ customerId: { in: [a, b, c] } }, { otherCustomerId: { in: [a, b, c] } }] }, orderBy: { seq: 'asc' } })
  assert.ok(events.every((e) => e.source === 'OPERATOR' && e.decidedByUserId === userId))
  assert.deepEqual(events.map((e) => e.kind), ['MERGE', 'UNMERGE', 'UNMERGE', 'MERGE'])
  assert.deepEqual(await db.customer.findMany({ where: { id: { in: [a, b, c] } }, orderBy: { id: 'asc' } }), before, 'no Customer row was changed')
  const logged = await db.activityLog.findMany({ where: { entityId: { in: [a, b, c] }, action: { in: ['customer_merged', 'customer_unmerged'] } } })
  assert.equal(logged.length, 3)
  assert.ok(logged.every((l) => !/@/.test(JSON.stringify(l.metadata)) && !l.description.includes(RUN)))
})

test('merge and unmerge need a fresh sign-in and an explicit confirmation, and the preview names both customers', { skip }, async (t) => {
  const { db, RUN, customer, cleanup } = await setup()
  t.after(cleanup)
  const actions = await import('@/app/actions/customer-identity')
  const { clusterOf } = await import('@/lib/domain/crm/cluster-resolver')
  const a = await customer('a', `${RUN}.fa@example.test`)
  const b = await customer('b', `${RUN}.fb@example.test`)
  role = 'MANAGER'
  const preview = await actions.previewMergeAction(a, b)
  assert.equal(preview.success, true)
  if (preview.success) {
    assert.deepEqual([preview.a.fullName, preview.a.email, preview.b.fullName, preview.b.email], [`a ${RUN}`, `${RUN}.fa@example.test`, `b ${RUN}`, `${RUN}.fb@example.test`])
  }
  assert.equal((await actions.previewMergeAction(a, a)).success, false)
  freshSignIn = false
  try {
    const stale = await actions.mergeCustomersAction(a, b, true)
    assert.equal(stale.success, false)
    assert.equal((stale as { code?: string }).code, 'fresh_auth_required', 'a stale session is asked to sign in again')
    assert.deepEqual((await clusterOf(db, a)).ids, [a], 'nothing was merged')
  } finally {
    freshSignIn = true
  }
  const unconfirmed = await actions.mergeCustomersAction(a, b, false)
  assert.equal(unconfirmed.success, false)
  assert.deepEqual((await clusterOf(db, a)).ids, [a], 'no confirmation, no merge')
  assert.equal((await actions.mergeCustomersAction(a, b, true)).success, true)
  freshSignIn = false
  try {
    assert.equal((await actions.unmergeCustomerAction(a, true) as { code?: string }).code, 'fresh_auth_required')
  } finally {
    freshSignIn = true
  }
  assert.equal((await actions.unmergeCustomerAction(a, false)).success, false)
  assert.deepEqual((await clusterOf(db, a)).ids, [a, b].sort(), 'still merged')
  role = 'WAREHOUSE'
  await assert.rejects(actions.previewMergeAction(a, b), /forbidden/)
  role = 'ADMIN'
})

test('the importer matches an email EXACTLY: an underscore or percent in an address is not a wildcard', { skip }, async (t) => {
  const { db, RUN, customer, cleanup } = await setup()
  t.after(cleanup)
  const { upsertCustomer } = await import('@/lib/connectors/woocommerce/sync/field-mapping')
  const dotted = await customer('dotted', `j.smith.${RUN}@example.test`)
  const dashed = await customer('dashed', `j-smith.${RUN}@example.test`)
  const wcOrder = (email: string) => ({
    customer_id: 0,
    billing: { first_name: 'J', last_name: RUN, email, phone: '', company: '', address_1: '1 High St', address_2: '', city: 'Town', state: '', postcode: 'AB1 2CD', country: 'GB' },
    shipping: { first_name: 'J', last_name: RUN, company: '', phone: '', address_1: '1 High St', address_2: '', city: 'Town', state: '', postcode: 'AB1 2CD', country: 'GB' },
  }) as never
  const underscore = await upsertCustomer(wcOrder(`j_smith.${RUN}@example.test`))
  t.after(async () => { await db.customer.deleteMany({ where: { id: underscore! } }) })
  assert.notEqual(underscore, dotted, 'REGRESSION: j_smith@ used to match j.smith@ (an unescaped ILIKE)')
  assert.notEqual(underscore, dashed)
  const row = await db.customer.findUnique({ where: { id: underscore! }, select: { email: true } })
  assert.equal(row!.email, `j_smith.${RUN}@example.test`)
  const percent = await upsertCustomer(wcOrder(`j%.${RUN}@example.test`))
  t.after(async () => { await db.customer.deleteMany({ where: { id: percent! } }) })
  assert.ok(percent !== dotted && percent !== dashed, 'a percent sign matches nothing but itself')
  // a backslash is an ordinary character: it neither escapes nor misses the true row
  const slash = await customer('slash', `back\\${RUN}@example.test`)
  assert.equal(await upsertCustomer(wcOrder(`BACK\\${RUN}@example.test`)), slash)
  // exact case-insensitive match still works, and the query is served by the expression index
  assert.equal(await upsertCustomer(wcOrder(`  J.SMITH.${RUN}@EXAMPLE.test `)), dotted)
})

test('aliases merge into one person even across DIFFERENT storefront customer ids (owner 2026-11-19)', { skip }, async (t) => {
  const { db, RUN, customer, cleanup } = await setup()
  t.after(cleanup)
  const { clusterOf } = await import('@/lib/domain/crm/cluster-resolver')
  const a = await customer('a', `jane.${RUN}@example.test`)
  const b = await customer('b', `jane.${RUN}+shop@example.test`)
  const guest = await customer('g', `JANE.${RUN}@example.test`)
  await db.shoppingCustomerLink.create({ data: { connector: 'woocommerce', customerId: a, externalCustomerId: `${RUN}-10` } })
  await db.shoppingCustomerLink.create({ data: { connector: 'woocommerce', customerId: b, externalCustomerId: `${RUN}-11` } })
  const expected = [a, b, guest].sort()
  for (const seed of expected) assert.deepEqual((await clusterOf(db, seed)).ids, expected)
})

test('the importer matches an order to its customer by the stored storefront customer id, ahead of the email (owner Q5)', { skip }, async (t) => {
  const { db, RUN, customer, order, cleanup } = await setup()
  t.after(cleanup)
  const { upsertCustomer } = await import('@/lib/connectors/woocommerce/sync/field-mapping')
  const storefrontId = 8_000_000 + Math.floor(Math.random() * 1_000_000)
  const owner = await customer('owner', `old.${RUN}@example.test`)
  const emailTwin = await customer('twin', `new.${RUN}@example.test`)
  const erasedOwner = await customer('erased', null, { gdprAnonymisedAt: new Date() })
  await order('q5', owner, { externalCustomerId: storefrontId })
  await order('q5e', erasedOwner, { externalCustomerId: storefrontId + 1 })
  const wcOrder = (email: string, customerId: number) => ({
    customer_id: customerId,
    billing: { first_name: 'Q', last_name: RUN, email, phone: '', company: '', address_1: '1 High St', address_2: '', city: 'Town', state: '', postcode: 'AB1 2CD', country: 'GB' },
    shipping: { first_name: 'Q', last_name: RUN, company: '', phone: '', address_1: '1 High St', address_2: '', city: 'Town', state: '', postcode: 'AB1 2CD', country: 'GB' },
  }) as never
  // the account changed its email to one another customer already has: the stored id wins
  assert.equal(await upsertCustomer(wcOrder(`new.${RUN}@example.test`, storefrontId)), owner)
  assert.notEqual(owner, emailTwin)
  // an erased customer is never a match target: a fresh customer is created
  const fresh = await upsertCustomer(wcOrder(`fresh.${RUN}@example.test`, storefrontId + 1))
  t.after(async () => { await db.shoppingCustomerLink.deleteMany({ where: { customerId: fresh! } }); await db.customer.deleteMany({ where: { id: fresh! } }) })
  assert.notEqual(fresh, erasedOwner)
  // no stored id anywhere: the email decides, as before
  assert.equal(await upsertCustomer(wcOrder(`NEW.${RUN}@example.test`, 0)), emailTwin)
})

test('the auto-merge audit is bounded: a customer joining a large cluster records at most AUTO_MERGE_AUDIT_MAX_PAIRS pairs', { skip }, async (t) => {
  const { db, RUN, customer, cleanup } = await setup()
  t.after(cleanup)
  const { recordAutoMergeAudit, AUTO_MERGE_AUDIT_MAX_PAIRS } = await import('@/lib/domain/crm/merge-service')
  const members: string[] = []
  for (let i = 0; i < AUTO_MERGE_AUDIT_MAX_PAIRS + 4; i++) members.push(await customer(`m${i}`, `many.${RUN}+${i}@example.test`))
  const newcomer = await customer('new', `many.${RUN}@example.test`)
  const written = await db.$transaction((tx) => recordAutoMergeAudit(tx, newcomer))
  assert.equal(written, AUTO_MERGE_AUDIT_MAX_PAIRS)
  assert.equal(await db.$transaction((tx) => recordAutoMergeAudit(tx, newcomer)), 0, 'idempotent')
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
  assert.equal((await actions.mergeCustomersAction(a, c, true)).success, true)
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

test('a chained cluster erasure that fails part way is FINISHED by running it again from the first member (saved member list)', { skip }, async (t) => {
  const { db, RUN, customer, order, cleanup } = await setup()
  t.after(cleanup)
  const actions = await import('@/app/actions/customer-identity')
  const { eraseCustomerClusterPersonalData } = await import('@/lib/domain/erasure/cluster-erasure')
  const { eraseCustomerPersonalData } = await import('@/lib/domain/erasure/erase-personal-data')
  const { clusterOf } = await import('@/lib/domain/crm/cluster-resolver')
  const { ERASURE_IN_PROGRESS_ERROR } = await import('@/lib/domain/crm/merge-service')
  // chain a - b - c - d: a-b by email (+tag), b-c and c-d by operator merges (different emails). b and c hold the chain together.
  const a = await customer('a', `chain.${RUN}@example.test`, { phone: '1' })
  const b = await customer('b', `chain.${RUN}+x@example.test`, { phone: '2' })
  const c = await customer('c', `second.${RUN}@example.test`, { phone: '3' })
  const d = await customer('d', `third.${RUN}@example.test`, { phone: '4' })
  const stranger = await customer('s', `stranger.${RUN}@example.test`)
  const oc = await order('c', c)
  role = 'ADMIN'
  assert.equal((await actions.mergeCustomersAction(b, c, true)).success, true)
  assert.equal((await actions.mergeCustomersAction(c, d, true)).success, true)
  assert.deepEqual((await clusterOf(db, a)).ids, [a, b, c, d].sort())

  let failOnce = true
  const failingOnC = async (id: string, opts: Parameters<typeof eraseCustomerPersonalData>[1]) => {
    if (id === c && failOnce) { failOnce = false; return { success: false as const, error: 'injected failure' } }
    return eraseCustomerPersonalData(id, opts)
  }
  const first = await eraseCustomerClusterPersonalData(a, { trigger: 'ON_REQUEST', userId }, { eraseCustomer: failingOnC as never })
  assert.equal(first.success, false)
  const request = await db.customerClusterErasure.findFirstOrThrow({ where: { memberIds: { has: a } } })
  assert.equal(request.status, 'PENDING')
  assert.deepEqual([...request.memberIds].sort(), [a, b, c, d].sort(), 'the resolved members are saved')
  assert.equal(request.memberIds.at(-1), a, 'the requested customer is erased at the very end')
  assert.deepEqual(request.memberIds, [d, b, c, a], 'the leaf first, the linking members next, the requested customer last')
  const live = async (id: string) => (await db.customer.findUniqueOrThrow({ where: { id }, select: { gdprAnonymisedAt: true } })).gdprAnonymisedAt === null
  const erasedFirst = request.memberIds.slice(0, request.memberIds.indexOf(c))
  for (const id of erasedFirst) assert.equal(await live(id), false, 'erased before the failure')
  assert.equal(await live(c), true)
  assert.equal(await live(a), true)
  // this is the case the saved list exists for: the erased bridge member has left the cluster, so re-resolving from a finds only a
  assert.deepEqual((await clusterOf(db, a)).ids, [a])
  // while the request is pending, merge and unmerge refuse its members
  assert.equal((await actions.mergeCustomersAction(a, stranger, true) as { error?: string }).error, ERASURE_IN_PROGRESS_ERROR)
  assert.equal((await actions.mergeCustomersAction(stranger, c, true) as { error?: string }).error, ERASURE_IN_PROGRESS_ERROR)
  assert.equal((await actions.unmergeCustomerAction(c, true) as { error?: string }).error, ERASURE_IN_PROGRESS_ERROR)

  const again = await eraseCustomerClusterPersonalData(a, { trigger: 'ON_REQUEST', userId })
  assert.equal(again.success, true, JSON.stringify(again))
  for (const id of [a, b, c, d]) assert.equal(await live(id), false, `${id} erased after the re-run`)
  assert.equal(await live(stranger), true)
  const done = await db.customerClusterErasure.findUniqueOrThrow({ where: { id: request.id } })
  assert.equal(done.status, 'COMPLETE')
  assert.ok(done.completedAt)
  assert.equal((await db.customerClusterErasure.count({ where: { memberIds: { has: a } } })), 1, 'the re-run resumed the saved request, it did not make a second one')
  const erasedOrder = await db.salesOrder.findUniqueOrThrow({ where: { id: oc }, select: { erasedAt: true } })
  assert.ok(erasedOrder.erasedAt, 'the order of the member that failed first is erased')
  // finished: a third request finds nothing to do
  assert.equal((await eraseCustomerClusterPersonalData(a, { trigger: 'ON_REQUEST', userId })).success, false)
  // and merge is possible again for people outside the finished request
  assert.equal((await actions.mergeCustomersAction(stranger, await customer('t', `t.${RUN}@example.test`), true)).success, true)
})

test('re-running from ANY member of a half-finished erasure resumes it, even from one that is already erased', { skip }, async (t) => {
  const { db, RUN, customer, cleanup } = await setup()
  t.after(cleanup)
  const { eraseCustomerClusterPersonalData } = await import('@/lib/domain/erasure/cluster-erasure')
  const { eraseCustomerPersonalData } = await import('@/lib/domain/erasure/erase-personal-data')
  // the review's exact state, written by hand: bridge b already erased, c still live, a (requested) live, saved order [b, c, a]
  const a = await customer('a', `ra.${RUN}@example.test`)
  const b = await customer('b', `ra.${RUN}+bridge@example.test`)
  const c = await customer('c', `ra.${RUN}+c@example.test`)
  assert.equal((await eraseCustomerPersonalData(b, { trigger: 'ON_REQUEST', userId })).success, true)
  const saved = await db.customerClusterErasure.create({ data: { requestedCustomerId: a, memberIds: [b, c, a], requestedByUserId: userId } })
  const result = await eraseCustomerClusterPersonalData(b, { trigger: 'ON_REQUEST', userId }) // from the member that is already erased
  assert.equal(result.success, true, JSON.stringify(result))
  assert.deepEqual((result as { erasedCustomerIds: string[] }).erasedCustomerIds, [c, a])
  for (const id of [a, b, c]) assert.ok((await db.customer.findUniqueOrThrow({ where: { id }, select: { gdprAnonymisedAt: true } })).gdprAnonymisedAt)
  assert.equal((await db.customerClusterErasure.findUniqueOrThrow({ where: { id: saved.id } })).status, 'COMPLETE')
})

test('a cluster erasure refuses when the merged records changed since the operator was shown them, and saves nothing', { skip }, async (t) => {
  const { db, RUN, customer, cleanup } = await setup()
  t.after(cleanup)
  const { eraseCustomerClusterPersonalData, CLUSTER_CHANGED_ERROR } = await import('@/lib/domain/erasure/cluster-erasure')
  const p = await customer('p', `exp.${RUN}@example.test`)
  const q = await customer('q', `exp.${RUN}+q@example.test`)
  const refused = await eraseCustomerClusterPersonalData(p, { trigger: 'ON_REQUEST', userId, expectedMemberIds: [p] })
  assert.deepEqual([refused.success, (refused as { error: string }).error], [false, CLUSTER_CHANGED_ERROR])
  assert.equal(await db.customerClusterErasure.count({ where: { memberIds: { has: p } } }), 0)
  assert.ok((await db.customer.findUniqueOrThrow({ where: { id: q }, select: { gdprAnonymisedAt: true } })).gdprAnonymisedAt === null)
  const ok = await eraseCustomerClusterPersonalData(p, { trigger: 'ON_REQUEST', userId, expectedMemberIds: [q, p] })
  assert.equal(ok.success, true, JSON.stringify(ok))
})

test('merge, unmerge and the erasure snapshot are serialised by one advisory lock', { skip }, async (t) => {
  const { db, RUN, customer, cleanup } = await setup()
  t.after(cleanup)
  const { lockCrmIdentity } = await import('@/lib/domain/crm/identity-lock')
  const { mergeCustomers } = await import('@/lib/domain/crm/merge-service')
  const a = await customer('a', `lock.${RUN}.one@example.test`)
  const b = await customer('b', `lock.${RUN}.two@example.test`)
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  let taken!: () => void
  const lockTaken = new Promise<void>((resolve) => { taken = resolve })
  const holder = db.$transaction(async (tx) => { await lockCrmIdentity(tx); taken(); await held }, { timeout: 30_000 })
  await lockTaken
  let merged = false
  const merging = mergeCustomers(a, b, userId).then((r) => { merged = true; return r })
  await new Promise((resolve) => setTimeout(resolve, 600))
  assert.equal(merged, false, 'a merge waits while the identity lock is held (as the erasure snapshot does)')
  release()
  await holder
  assert.equal((await merging).success, true)
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
  const applied = await applyOrderCustomerIdBackfill(db, { batchSize: 1 })
  assert.equal(applied.orders >= 1 && applied.batches === applied.orders, true, 'one order per batch when the batch size is 1')
  assert.ok(applied.unfillable >= 1, 'the guest order has a link and no delivery that carries a customer id: reported as unfillable')
  const after = new Map((await stamp()).map((r) => [r.id, r]))
  assert.equal(after.get(fill)!.e, 12, 'the NEWEST delivery wins')
  assert.equal(after.get(guest)!.e, null, 'customer_id 0 is no evidence')
  assert.equal(after.get(have)!.e, 99, 'a stored id is never overwritten')
  assert.equal(after.get(erased)!.e, null, 'an erased order is never refilled')
  assert.equal(after.get(unlinked)!.e, null)
  for (const row of before) assert.equal(after.get(row.id)!.u.getTime(), row.u.getTime(), 'updatedAt is not raised')
})
