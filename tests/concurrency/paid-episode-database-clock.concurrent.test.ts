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
