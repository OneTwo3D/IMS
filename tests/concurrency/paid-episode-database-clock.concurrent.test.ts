import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * o3d-psrx r5 (Codex HIGH 1) — THE PAID-EPISODE FENCE IS MEASURED BY THE DATABASE, WHATEVER THE
 * CALLER SUPPLIES.
 *
 * `registrationBindsToPaidState` orders a registration's DATABASE-minted completion instant against
 * `SalesOrder.unregisteredPaidAt`. Round 4 let the WRITER supply the second value — an application
 * host's `new Date()` in `markSalesOrderPaid`, a shop's `date_paid_gmt` in the WooCommerce importer —
 * so the comparison spanned two machines. Its dangerous direction is a host running AHEAD: the marker
 * lands in the database's future, the registration that legitimately follows completes at an instant
 * BELOW it, and a real posted receipt is unbound for ever, because every recheck repeats the same
 * comparison over the same two immutable values.
 *
 * SKEW CANNOT BE INDUCED HERE — the application and the database are one box — SO THE PROOF IS
 * STRUCTURAL: the column is written with a value an hour in the DATABASE's own future, and what comes
 * back is a `clock_timestamp()` reading taken between two the test asked for by hand. A caller
 * therefore cannot put its clock into this column at all, which is a stronger statement than "the two
 * clocks happened to agree" and is the only one a single-host test can honestly make.
 *
 * Compared as ISO-8601 UTC STRINGS rather than as `Date`s on purpose: `unregistered_paid_at` is
 * TIMESTAMP WITHOUT TIME ZONE holding UTC, and a driver that reads such a column through the client's
 * local zone would make a passing test out of a broken fence. `to_char` moves the whole comparison
 * into the database, where the ordering the fence actually uses lives.
 *
 * r6 (Codex HIGH 1) — AND WHEN A NEW FENCE IS MINTED IS A TRANSITION, NOT A DIFFERENCE.
 *
 * r5 guarded re-minting with `OLD IS DISTINCT FROM NEW` and proved it with the assertion "re-writing
 * the stored value is not a new episode" — which submits the value the DATABASE minted. No production
 * writer does that. `updateExistingWcOrderFromPayload` submits the SHOP's `date_paid_gmt`, and after
 * the first write the shop's value and the database's necessarily differ, so the guard passed on
 * every webhook redelivery and the fence walked forward past registrations that had already completed
 * under it. The rule is now the NULL-to-non-null transition, and the proof below is driven through
 * the real WooCommerce writer rather than through an UPDATE this file spells itself.
 *
 * Gated behind RUN_DB_CONCURRENCY_TESTS=1: `npm run test:concurrency`.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'

function loadEnv() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
  if (!url.startsWith('postgres://') && !url.startsWith('postgresql://')) {
    throw new Error('o3d-psrx r5 concurrency test requires a Postgres DATABASE_URL')
  }
}

async function loadDb() {
  loadEnv()
  const { db } = await import('@/lib/db')
  return db
}

type Db = Awaited<ReturnType<typeof loadDb>>

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`

/** The database's own clock, as an ISO-8601 UTC string — the same expression the fence's ends use. */
async function databaseNow(db: Db): Promise<string> {
  const rows = await db.$queryRawUnsafe<Array<{ v: string }>>(
    `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', ${ISO}) AS v`,
  )
  return rows[0].v
}

/** What the column actually holds, as the same kind of string. */
async function storedEpisode(db: Db, id: string): Promise<string | null> {
  const rows = await db.$queryRawUnsafe<Array<{ v: string | null }>>(
    `SELECT to_char("unregistered_paid_at", ${ISO}) AS v FROM "sales_orders" WHERE id = $1`,
    id,
  )
  return rows[0]?.v ?? null
}

async function createOrder(db: Db, id: string, unregisteredPaidAt: Date | null): Promise<void> {
  await db.salesOrder.create({
    data: {
      id,
      status: 'SHIPPED',
      currency: 'GBP',
      subtotalForeign: 100,
      totalForeign: 100,
      subtotalBase: 100,
      totalBase: 100,
      paidAt: new Date('2026-08-01T09:00:00.000Z'),
      unregisteredPaidAt,
    },
  })
}

test(
  '[o3d-psrx r5] a caller cannot put its own clock in the paid-episode fence',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const db = await loadDb()
    const id = `PSRX5-${process.pid}-${randomUUID()}`
    t.after(async () => { await db.salesOrder.deleteMany({ where: { id } }) })

    // An hour into the DATABASE's future — the direction that strands a real receipt for ever.
    const AHEAD_MS = 60 * 60 * 1000
    const before = await databaseNow(db)
    const supplied = new Date(Date.parse(before.slice(0, -1) + 'Z') + AHEAD_MS)
    await createOrder(db, id, supplied)
    const after = await databaseNow(db)

    const stored = await storedEpisode(db, id)
    assert.ok(stored, 'the marker must actually have been written')

    const suppliedIso = `${supplied.toISOString().slice(0, -1)}000Z`
    assert.notEqual(stored, suppliedIso,
      'the caller supplied an hour of skew and the column kept it — the fence is back across two clocks')
    assert.ok(stored >= before && stored <= after,
      `the stored fence must be a database clock reading taken during the write: ${before} <= ${stored} <= ${after}`)

    // THE LOAD-BEARING ORDERING. `databaseStampedCompletion` reads `clock_timestamp() AT TIME ZONE
    // 'UTC'` written after the registration's POST returns — i.e. a reading of this same clock, taken
    // after this write. It is therefore STRICTLY GREATER than the fence, and no host's clock can
    // change that, because no host's clock appears on either side.
    const laterCompletion = await databaseNow(db)
    assert.ok(laterCompletion > stored,
      'a completion instant minted after the paid transition must order after its episode fence')
  },
)

test(
  '[o3d-psrx r5] re-marking mints a NEW fence; an unrelated write leaves it exactly where it was',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const db = await loadDb()
    const id = `PSRX5-${process.pid}-${randomUUID()}`
    t.after(async () => { await db.salesOrder.deleteMany({ where: { id } }) })

    await createOrder(db, id, new Date('2020-01-01T00:00:00.000Z'))
    const first = await storedEpisode(db, id)
    assert.ok(first && first > '2026', 'the insert must already have been re-minted, not stored as 2020')

    // AN UNRELATED WRITE MUST NOT MOVE THE FENCE. Re-minting on every UPDATE would push the marker
    // past registrations that had already completed under it — unbinding them, which is the defect
    // this trigger exists to remove, re-created by its own fix.
    await db.salesOrder.update({ where: { id }, data: { status: 'DELIVERED' } })
    assert.equal(await storedEpisode(db, id), first, 'a status change is not a new paid episode')

    // Writing the SAME value is not a new episode either.
    const row = await db.salesOrder.findUnique({ where: { id }, select: { unregisteredPaidAt: true } })
    await db.salesOrder.update({ where: { id }, data: { unregisteredPaidAt: row!.unregisteredPaidAt } })
    assert.equal(await storedEpisode(db, id), first, 're-writing the stored value is not a new episode')

    // r6 — AND NEITHER IS WRITING A DIFFERENT ONE, which is the case r5's `IS DISTINCT FROM` guard
    // could not tell from a new episode and which is the ONLY case production actually produces: no
    // writer re-submits the database's own value, and the WooCommerce importer re-submits the shop's
    // `date_paid_gmt` on every redelivery. Two different wrong answers are tried here — a value in
    // the past and a value in the future — because a comparison, unlike a transition, is direction-
    // sensitive and either direction is a moved fence.
    await db.salesOrder.update({ where: { id }, data: { unregisteredPaidAt: new Date('2019-06-01T00:00:00.000Z') } })
    assert.equal(await storedEpisode(db, id), first, 'a caller supplying an EARLIER value is not a new episode')
    await db.salesOrder.update({ where: { id }, data: { unregisteredPaidAt: new Date(Date.now() + 3_600_000) } })
    assert.equal(await storedEpisode(db, id), first, 'a caller supplying a LATER value is not a new episode either')

    // A GENUINELY NEW EPISODE IS. Paid, reversed, paid again: the second marker must be the database's
    // reading at the second transition, not the caller's and not the first one.
    await db.salesOrder.update({ where: { id }, data: { paidAt: null, unregisteredPaidAt: null } })
    assert.equal(await storedEpisode(db, id), null)
    await db.salesOrder.update({
      where: { id },
      data: { paidAt: new Date(), unregisteredPaidAt: new Date('2020-01-01T00:00:00.000Z') },
    })
    const second = await storedEpisode(db, id)
    assert.ok(second && second > first, 'the second paid episode must carry a later database-minted fence')
  },
)

/**
 * o3d-psrx r6 (Codex HIGH 1) — THE REAL WOOCOMMERCE WRITER, REPEATEDLY, AGAINST A REAL DATABASE.
 *
 * The two tests above are about the RULE. This one is about the writer that broke it, and it drives
 * `updateExistingWcOrderFromPayload` — the function `importWcOrder` calls for every order IMS already
 * holds — rather than an UPDATE spelt here. That distinction is the finding: r5's test re-submitted
 * the value the database had minted, which no production writer does, and the writer that matters
 * re-submits the SHOP's `date_paid_gmt` on every webhook redelivery and every `modified_after` poll
 * that sees the order again.
 *
 * WHAT IS BEING PROVED IS NOT "THE COLUMN DID NOT CHANGE". It is that an INVOICE_PAYMENT registration
 * which completed under this episode STILL BINDS to it after the redeliveries — measured through
 * `registrationBindsToPaidState`, the function the reversal classifier actually asks. A fence that
 * walks past a completed registration unbinds it permanently (the comparison is over two immutable
 * values), the order parks on PAID_WITHOUT_LEDGER_RECEIPT, and a genuine chargeback against it is
 * never recognised.
 *
 * No WooCommerce call is made: the payload is a literal, and a payload carrying no PDF-invoice meta
 * returns out of the writer immediately after its transaction.
 */
function wcPaidPayload(externalId: number, datePaidGmt: string) {
  const address = {
    first_name: 'A', last_name: 'Customer', company: '', address_1: '1 Test Street', address_2: '',
    city: 'Cambridge', state: '', postcode: 'CB1 1AA', country: 'GB', email: 'ops@example.com', phone: '',
  }
  return {
    id: externalId,
    parent_id: 0,
    number: String(externalId),
    order_key: `wc_order_${externalId}`,
    created_via: 'checkout',
    version: '9.0.0',
    status: 'processing',
    currency: 'GBP',
    date_created: '2026-08-01T09:00:00',
    date_created_gmt: '2026-08-01T09:00:00',
    date_modified: '2026-08-01T09:00:00',
    date_modified_gmt: '2026-08-01T09:00:00',
    discount_total: '0.00', discount_tax: '0.00', shipping_total: '0.00', shipping_tax: '0.00',
    cart_tax: '0.00', total: '100.00', total_tax: '0.00', prices_include_tax: true,
    customer_id: 0, customer_ip_address: '', customer_note: '',
    billing: address, shipping: address,
    payment_method: 'stripe', payment_method_title: 'Card', transaction_id: 'ch_1',
    date_paid: datePaidGmt, date_paid_gmt: datePaidGmt,
    date_completed: null, date_completed_gmt: null,
    cart_hash: '',
    // NO PDF-invoice meta: the writer's post-transaction half returns immediately, so this test
    // touches the paid columns and nothing else.
    meta_data: [],
    line_items: [], tax_lines: [], shipping_lines: [], fee_lines: [], coupon_lines: [], refunds: [],
  }
}

test(
  '[o3d-psrx r6] a WooCommerce REDELIVERY of an unchanged paid order does not move the fence',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const db = await loadDb()
    loadEnv()
    const { updateExistingWcOrderFromPayload } = await import('@/lib/connectors/woocommerce/sync/order-import')
    const { registrationBindsToPaidState } = await import('@/lib/connectors/xero/invoice-delta')

    const id = `PSRX6-${process.pid}-${randomUUID()}`
    const externalId = Math.floor(Math.random() * 2_000_000_000)
    t.after(async () => { await db.salesOrder.deleteMany({ where: { id } }) })

    // The order as IMS holds it before the payment: imported, linked, UNPAID. Nothing to fence yet.
    await db.salesOrder.create({
      data: {
        id,
        status: 'SHIPPED',
        currency: 'GBP',
        subtotalForeign: 100, totalForeign: 100, subtotalBase: 100, totalBase: 100,
        accountingInvoiceId: 'inv_1',
        shoppingLinks: {
          create: { connector: 'woocommerce', externalOrderId: String(externalId), externalOrderNumber: String(externalId) },
        },
      },
    })
    assert.equal(await storedEpisode(db, id), null, 'an unpaid order has no episode')

    // DELIVERY 1: the shop reports the order paid. NULL -> non-null, so a fence is minted.
    const payload = wcPaidPayload(externalId, '2026-08-02T10:00:00')
    await updateExistingWcOrderFromPayload(id, payload as never)
    const fence = await storedEpisode(db, id)
    assert.ok(fence, 'the paid delivery must have minted an episode')
    assert.ok(fence > '2026-08-02T10:00:00.000000Z',
      'and it must be the DATABASE\'s reading, not the shop\'s date_paid_gmt')

    // A REGISTRATION COMPLETES UNDER THAT EPISODE. Its instant is a reading of the same clock, taken
    // after the fence, exactly as `stampSyncedAtFromDatabaseClock` takes it.
    const completedIso = await databaseNow(db)
    const completedAt = new Date(completedIso)
    const registration = { registeredAgainstInvoiceId: 'inv_1', externalTransactionId: 'PAY-1' }
    const boundBefore = registrationBindsToPaidState(
      registration, completedAt, { accountingInvoiceId: 'inv_1', unregisteredPaidAt: new Date(fence) },
    )
    assert.equal(boundBefore, true, 'PRECONDITION: the registration must bind before the redeliveries')

    // DELIVERIES 2..4: the SAME payload, the way a retried webhook and the modified_after poll send
    // it. Nothing about the order has changed; the shop's date_paid_gmt is simply re-sent.
    for (let i = 0; i < 3; i += 1) await updateExistingWcOrderFromPayload(id, payload as never)

    assert.equal(await storedEpisode(db, id), fence,
      'THE FINDING: the redelivery re-minted the fence, so it now sits past registrations that '
      + 'completed under the episode it is supposed to be the start of')
    const fenceNow = await storedEpisode(db, id)
    assert.ok(fenceNow)
    assert.equal(
      registrationBindsToPaidState(
        registration, completedAt, { accountingInvoiceId: 'inv_1', unregisteredPaidAt: new Date(fenceNow) },
      ),
      true,
      'and the registration that legitimately followed the paid transition is still bound to it',
    )

    // AND THE ORDER'S OWN PAID DATE IS UNTOUCHED BY THE RULE: `paidAt` still carries the shop's
    // instant, which is what an operator reads. Only the fence is the database's.
    const row = await db.salesOrder.findUnique({ where: { id }, select: { paidAt: true } })
    assert.equal(row?.paidAt?.toISOString(), new Date('2026-08-02T10:00:00').toISOString())
  },
)
