import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

import {
  ACTIVE_REFUND_PARK_INDEX_NAME,
  HELD_SALES_INVOICE_RECORD_KIND,
  WC_REFUND_PARK_RECORD_KIND,
} from '@/lib/domain/sales/wc-sync-row-families'
import { activeRefundParkWhere } from '@/lib/domain/sales/refund-park-recovery'

/**
 * o3d-272i r2 (Codex HIGH) — THE PARTIAL UNIQUE INDEX IS A READER OF THE REFUND-PARK RULE, AND IT
 * WAS THE ONE READER NO AMOUNT OF APPLICATION CODE COULD CORRECT.
 *
 * THE DEFECT. `shopping_sync_logs_active_refund_park_uq` was built in July (20260721150000) out of
 * the five clauses that were then believed to identify a refund park — connector, direction,
 * `SalesOrder`, an actionable status, a non-null entityId — a month before `recordKind` existed. A
 * HELD SALES INVOICE writes every one of them. So the index treated a hold as a park, and enforced
 * uniqueness of (connector, externalId) ACROSS BOTH FAMILIES.
 *
 * AND THE TWO externalIds COME FROM DIFFERENT WooCOMMERCE ID SPACES. A park carries the REFUND id; a
 * hold carries the ORDER id. Nothing keeps those apart, so the first time some order id equals some
 * refund id the second row to arrive is refused with a 23505 — a legitimate invoice hold that cannot
 * be recorded, or a refund park that cannot be recorded, decided by arrival order. o3d-xnwu r8 fixed
 * this collision in `foreignPark` (which threw on a hold) and in the park resolvers (which settled
 * one to SYNCED); this is its third instance, and an index OVERRIDES both of those fixes rather than
 * merely lagging them.
 *
 * WHY IT HAS TO BE A REAL DATABASE, AND A REAL INDEX. This is a property of shipped DDL. A hand-made
 * table, or a double standing in for Prisma, answers whatever it was built to answer — the earlier
 * finding on this branch was that a fixture which answers more than it was asked proves nothing. So
 * the assertions below are `INSERT` outcomes: the row is accepted, or PostgreSQL raises a unique
 * violation. There is no third answer and nothing here to configure.
 *
 * THREE THINGS ARE ASSERTED, and it takes all three.
 *
 *   1. COEXISTENCE — a held invoice and a refund park sharing connector and externalId both persist.
 *      This is the regression. Against the July index the second INSERT raises 23505.
 *   2. THE INDEX IS STILL ENFORCING — two actionable PARKS sharing connector and externalId still
 *      collide. Without this, (1) would pass just as happily against a database with no index at
 *      all, which is the failure mode a narrowing migration can actually produce.
 *   3. THE SHIPPED PREDICATE AND `activeRefundParkWhere()` AGREE — the index's own WHERE clause is
 *      read back out of `pg_index` and EXECUTED beside the Prisma predicate over one probe matrix.
 *      tests/prisma/refund-park-unique-index-record-kind-migration.test.ts holds the migration text
 *      to the string the shared module renders; this holds the DATABASE to the shared module's
 *      meaning, which a text comparison cannot reach.
 *
 * Gated behind RUN_DB_CONCURRENCY_TESTS=1 (`npm run test:concurrency`), which CI runs against a
 * PostgreSQL built by `prisma migrate deploy` — so what is under test is the shipped migration
 * stream and not a table this file created.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const SKIP = !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1'

function loadEnv() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
  if (!url.startsWith('postgres://') && !url.startsWith('postgresql://')) {
    throw new Error('o3d-272i r2 index test requires a Postgres DATABASE_URL')
  }
}

async function loadDb() {
  loadEnv()
  const { db } = await import('@/lib/db')
  return db
}

type Db = Awaited<ReturnType<typeof loadDb>>

type ProbeRow = {
  id: string
  connector: string
  direction: 'FROM_CONNECTOR' | 'TO_CONNECTOR'
  entityType: string
  entityId: string | null
  externalId: string | null
  status: 'PENDING' | 'FAILED' | 'QUARANTINED' | 'SYNCED'
  recordKind: string | null
}

/** PostgreSQL's unique-violation SQLSTATE, which is the only outcome that matters here. */
const UNIQUE_VIOLATION = '23505'

function isUniqueViolation(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message}${'code' in error ? String((error as { code?: unknown }).code) : ''}` : String(error)
  return text.includes(UNIQUE_VIOLATION) || text.includes('P2002') || /unique constraint/i.test(text)
}

function makeFixture() {
  const probe = `o3d272i-r2-${randomUUID().slice(0, 8)}`
  const rowId = (suffix: string) => `${probe}-${suffix}`
  const base: Omit<ProbeRow, 'id'> = {
    connector: 'woocommerce',
    direction: 'FROM_CONNECTOR',
    entityType: 'SalesOrder',
    entityId: `${probe}-order-a`,
    externalId: `${probe}-e`,
    status: 'PENDING',
    recordKind: WC_REFUND_PARK_RECORD_KIND,
  }
  const row = (suffix: string, overrides: Partial<ProbeRow>): ProbeRow => ({ ...base, id: rowId(suffix), ...overrides })

  /**
   * THE COLLIDING VALUE. In production this is a WooCommerce ORDER id for the hold and a WooCommerce
   * REFUND id for the park; here it is one string, which is the same situation and does not depend on
   * the two id spaces happening to overlap on the day the test runs.
   */
  const colliding = `${probe}-511`

  return { probe, rowId, row, colliding }
}

/** Delete everything a run wrote, whatever it did. Nothing here may outlive the test. */
async function cleanUp(db: Db, probe: string): Promise<void> {
  await db.$executeRawUnsafe('DELETE FROM "shopping_sync_logs" WHERE id LIKE $1', `${probe}-%`)
}

test('o3d-272i r2: a held sales invoice and a refund park may share (connector, externalId)', { skip: SKIP }, async () => {
  const db = await loadDb()
  const { probe, rowId, row, colliding } = makeFixture()

  try {
    // THE HOLD FIRST, on its own order. This is the row order-import writes while an invoice waits
    // for its number, and its externalId is the WooCommerce ORDER id.
    await db.shoppingSyncLog.create({
      data: row('hold', {
        recordKind: HELD_SALES_INVOICE_RECORD_KIND,
        externalId: colliding,
        entityId: `${probe}-order-a`,
      }),
    })

    // AND THEN THE PARK, on a DIFFERENT order, whose externalId is a REFUND id that happens to equal
    // the hold's order id. THIS IS THE INSERT THE JULY INDEX REFUSED. It is also deliberately the
    // second write: the families are symmetrical, and whichever arrived first would win.
    await db.shoppingSyncLog.create({
      data: row('park', {
        recordKind: WC_REFUND_PARK_RECORD_KIND,
        externalId: colliding,
        entityId: `${probe}-order-b`,
      }),
    })

    // READ BACK, not merely "no exception was thrown". A create that silently wrote nothing would
    // satisfy the two statements above.
    const survivors = await db.shoppingSyncLog.findMany({
      where: { id: { in: [rowId('hold'), rowId('park')] } },
      select: { id: true, recordKind: true, externalId: true },
    })
    assert.equal(survivors.length, 2, 'the hold and the park must both persist')
    assert.deepEqual(
      survivors.map((r) => r.recordKind).sort(),
      [HELD_SALES_INVOICE_RECORD_KIND, WC_REFUND_PARK_RECORD_KIND].sort(),
      'one row of each family',
    )
    for (const survivor of survivors) {
      assert.equal(survivor.externalId, colliding, 'precondition: they really do share the key value')
    }
  } finally {
    await cleanUp(db, probe)
  }
})

test('o3d-272i r2: two actionable refund parks on one (connector, externalId) still collide', { skip: SKIP }, async () => {
  // THE NON-VACUITY HALF. The migration NARROWS a unique index, and the way a narrowing goes wrong
  // is by narrowing to nothing — an index that covers no row permits the coexistence above and every
  // duplicate the index was built to stop. So the dedup guarantee o3d-7yf added is re-asserted here
  // against the same shipped DDL.
  const db = await loadDb()
  const { probe, row, colliding } = makeFixture()

  try {
    await db.shoppingSyncLog.create({
      data: row('park-first', { externalId: colliding, entityId: `${probe}-order-a` }),
    })

    let raised: unknown = null
    try {
      await db.shoppingSyncLog.create({
        // A DIFFERENT order, which is the cross-order anomaly the index exists to make impossible:
        // one WooCommerce refund id belongs to exactly one order.
        data: row('park-second', { externalId: colliding, entityId: `${probe}-order-b`, status: 'FAILED' }),
      })
    } catch (error) {
      raised = error
    }

    assert.ok(raised !== null, `a second actionable park on ${colliding} must be refused by ${ACTIVE_REFUND_PARK_INDEX_NAME}`)
    assert.ok(isUniqueViolation(raised), `expected a unique violation, got: ${String(raised)}`)
  } finally {
    await cleanUp(db, probe)
  }
})

test('o3d-272i r2: the index is UNIQUE, partial, and keyed on (connector, externalId)', { skip: SKIP }, async () => {
  // A PLAIN index of the same name would satisfy "the index exists" and enforce nothing, and a
  // non-partial one would enforce far too much. Both are read from the catalogue, not from the file.
  const db = await loadDb()
  const rows = await db.$queryRawUnsafe<Array<{ isunique: boolean; ispartial: boolean; cols: string }>>(
    `SELECT x.indisunique AS isunique,
            (x.indpred IS NOT NULL) AS ispartial,
            pg_get_indexdef(x.indexrelid) AS cols
       FROM pg_index x
       JOIN pg_class i ON i.oid = x.indexrelid
      WHERE i.relname = $1`,
    ACTIVE_REFUND_PARK_INDEX_NAME,
  )
  assert.equal(rows.length, 1, `${ACTIVE_REFUND_PARK_INDEX_NAME} must exist in a database built from the migrations`)
  assert.equal(rows[0]!.isunique, true)
  assert.equal(rows[0]!.ispartial, true)
  assert.match(rows[0]!.cols, /\(connector, "externalId"\)/)
})

test('o3d-272i r2: the SHIPPED index predicate and activeRefundParkWhere() select the same rows', { skip: SKIP }, async () => {
  const db = await loadDb()
  const { probe, rowId, row } = makeFixture()

  /**
   * One row per clause the predicate has, each differing from a matching row in exactly one respect,
   * and each with its OWN externalId so the index cannot refuse the seeding. The two rows that share
   * a value are the coexistence pair, tested above.
   */
  const rows: ProbeRow[] = [
    // --- the three the refund-park rule admits ------------------------------------------------
    row('park-pending', { externalId: `${probe}-e1` }),
    row('park-failed', { status: 'FAILED', externalId: `${probe}-e2` }),
    row('park-quarantined', { status: 'QUARANTINED', externalId: `${probe}-e3` }),
    // --- and one counter-example per clause ----------------------------------------------------
    row('park-synced', { status: 'SYNCED', externalId: `${probe}-e4` }),
    row('park-no-entity', { entityId: null, externalId: `${probe}-e5` }),
    row('unstamped', { recordKind: null, externalId: `${probe}-e6` }),
    row('other-kind', { recordKind: 'WC_SOMETHING_ELSE', externalId: `${probe}-e7` }),
    row('other-connector', { connector: 'shopify', externalId: `${probe}-e8` }),
    row('outbound', { direction: 'TO_CONNECTOR', externalId: `${probe}-e9` }),
    row('other-entity-type', { entityType: 'Product', externalId: `${probe}-e10` }),
    row('hold-pending', { recordKind: HELD_SALES_INVOICE_RECORD_KIND, externalId: `${probe}-e11` }),
    row('hold-failed', { recordKind: HELD_SALES_INVOICE_RECORD_KIND, status: 'FAILED', externalId: `${probe}-e12` }),
    // THE ONE CLAUSE THE INDEX HAS AND THE PREDICATE DOES NOT. A park with no externalId is an
    // actionable park by every rule the application applies, and is simply not indexable: there is
    // no refund id for it to be unique per. Naming it here is what makes the comparison below an
    // assertion about ONE known difference rather than a hope that there is none.
    row('park-no-external', { externalId: null }),
  ]

  try {
    await db.shoppingSyncLog.createMany({ data: rows })
    const ids = rows.map((r) => r.id)

    // THE PREDICATE THE DATABASE ACTUALLY HAS — its own rendering of what the migration built, not
    // the migration's text and not this repository's idea of it.
    const catalogue = await db.$queryRawUnsafe<Array<{ pred: string | null }>>(
      `SELECT pg_get_expr(x.indpred, x.indrelid) AS pred
         FROM pg_index x
         JOIN pg_class i ON i.oid = x.indexrelid
        WHERE i.relname = $1`,
      ACTIVE_REFUND_PARK_INDEX_NAME,
    )
    const predicate = catalogue[0]?.pred ?? null
    assert.ok(predicate && predicate.length > 0, 'precondition: the index is partial and has a readable predicate')

    const indexed = await db.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM "shopping_sync_logs" WHERE id = ANY($1::text[]) AND (${predicate})`,
      ids,
    )
    const viaIndex = indexed.map((r) => r.id).sort()

    const matched = await db.shoppingSyncLog.findMany({
      where: { ...activeRefundParkWhere(), id: { in: ids } },
      select: { id: true },
    })
    const viaPredicate = matched.map((r) => r.id).sort()

    // MEMBERSHIP FIRST. Two predicates that both match everything, or both match nothing, agree
    // perfectly; asserting the expected sets is what makes the agreement mean something.
    assert.deepEqual(
      viaPredicate,
      [rowId('park-pending'), rowId('park-failed'), rowId('park-quarantined'), rowId('park-no-external')].sort(),
      'activeRefundParkWhere() admits the parks in the three actionable statuses, and nothing else',
    )
    assert.deepEqual(
      viaIndex,
      [rowId('park-pending'), rowId('park-failed'), rowId('park-quarantined')].sort(),
      'the shipped index covers exactly those of them that have an externalId to be unique per',
    )

    // AND THE RELATION BETWEEN THE TWO, NAMED. The index set is the predicate set minus the rows
    // with no externalId — nothing more and nothing less. A `recordKind` clause missing from the
    // index would pull `hold-pending` and `hold-failed` (and `unstamped`, and `other-kind`) into
    // viaIndex and this fails naming them.
    assert.deepEqual(
      viaIndex,
      viaPredicate.filter((id) => id !== rowId('park-no-external')),
      'the index and the shared predicate differ by the non-null externalId clause and by nothing else',
    )
  } finally {
    await cleanUp(db, probe)
  }
})
