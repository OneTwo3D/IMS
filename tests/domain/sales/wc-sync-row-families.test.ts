import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { type TestContext } from 'node:test'

import { parse as parseDotenv } from 'dotenv'

import { Prisma } from '@/app/generated/prisma/client'
import {
  HELD_SALES_INVOICE_RECORD_KIND,
  UNRESOLVED_WC_ORDER_ROW_DESCRIPTIONS,
  UNRESOLVED_WC_ORDER_ROW_FAMILIES,
  WC_REFUND_PARK_RECORD_KIND,
  unresolvedWcOrderRowSql,
  unresolvedWcOrderRowWhere,
} from '@/lib/domain/sales/wc-sync-row-families'
import {
  UNRESOLVED_WC_ORDER_ROW_MATRIX_MEMBERS,
  makeWcSyncRowMatrix,
} from '@/tests/helpers/wc-sync-row-matrix'

/**
 * o3d-272i — THE TWO SPELLINGS OF ONE RULE, ASKED OF A REAL DATABASE.
 *
 * `unresolvedWcOrderRowWhere()` and `unresolvedWcOrderRowSql()` describe the same set — an
 * unresolved WooCommerce sync row that names an IMS sales order — because one of the four readers
 * o3d-272i consolidated is a bulk `DELETE ... WHERE NOT (...)` in lib/data-retention.ts and cannot
 * use a Prisma `where` at all.
 *
 * TWO SPELLINGS ARE THE DEFECT UNLESS SOMETHING HOLDS THEM TOGETHER. Both renderers read their
 * literals from one `UNRESOLVED_WC_ORDER_ROW` object, so they cannot disagree about WHAT the rule
 * is — but they can still disagree about how to write it, and SQL is where that happens: a NULL
 * `recordKind` silently fails `= ANY(...)`, `IS NOT NULL` and `<> NULL` are different questions, and
 * an enum cast can be wrong in a way that only a server notices. So the test below puts rows that
 * differ in EVERY clause the predicate has into a real table, runs both spellings over exactly those
 * rows, and asserts the two id sets are identical AND are the expected six.
 *
 * IT ASSERTS THE SET, NOT ONLY THE AGREEMENT. Two predicates that both match everything, or both
 * match nothing, agree perfectly. The membership assertion is what makes the agreement mean
 * something.
 *
 * AND SINCE r3 IT ASSERTS THE COMPLEMENT TOO. The SQL renderer's only negating reader is retention,
 * and a predicate that is right read positively and wrong read negatively is the same two-meanings
 * defect this module exists to remove. See the partition test below; the decisive database-backed
 * version, against a schema built from the migrations, is in
 * tests/concurrency/refund-park-index-family-scope.concurrent.test.ts.
 *
 * The probe matrix is tests/helpers/wc-sync-row-matrix.ts — shared with that concurrency test,
 * because a fixture written out twice drifts exactly the way a predicate written out twice does.
 *
 * Everything is written inside a transaction that is rolled back, so the seeded rows never exist for
 * any other reader and nothing is left behind. The test SKIPS when no PostgreSQL is reachable.
 */

const { rowId, rows: ROWS, ids: IDS } = makeWcSyncRowMatrix(`o3d272i-${Math.random().toString(36).slice(2, 10)}`)

const EXPECTED = UNRESOLVED_WC_ORDER_ROW_MATRIX_MEMBERS.map(rowId).sort()

class Rollback extends Error {}

/**
 * `npm run test:unit` does not load `.env`, so the live tests in this repository read it themselves
 * — the same helper tests/db/connection-schema-pinning.test.ts uses. Node's test runner gives each
 * FILE its own process, so setting the variable here cannot reach another test.
 */
function configuredDatabaseUrl(): string | null {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  for (const file of ['../../../.env.local', '../../../.env']) {
    try {
      const parsed = parseDotenv(readFileSync(new URL(file, import.meta.url)))
      if (parsed.DATABASE_URL) return parsed.DATABASE_URL
    } catch {
      // absent or unreadable: try the next one
    }
  }
  return null
}

type Answers = {
  viaPrisma: string[]
  viaSql: string[]
  /** `NOT (fragment)` — the shape lib/data-retention.ts deletes by. */
  viaSqlComplement: string[]
  /** Rows for which the fragment answers neither TRUE nor FALSE. Must always be empty. */
  undecided: string[]
}

async function bothSpellings(t: TestContext): Promise<Answers | null> {
  const databaseUrl = configuredDatabaseUrl()
  if (!databaseUrl) {
    t.skip('no DATABASE_URL configured; the SQL/Prisma agreement check needs a reachable PostgreSQL')
    return null
  }
  process.env.DATABASE_URL = databaseUrl
  const { db } = await import('@/lib/db')
  let captured: Answers | null = null
  try {
    await db.$transaction(async (tx) => {
      await tx.shoppingSyncLog.createMany({ data: ROWS })
      const prismaRows = await tx.shoppingSyncLog.findMany({
        // Scoped to this run's rows so a development database's real content cannot decide the
        // answer either way.
        where: { ...unresolvedWcOrderRowWhere(), id: { in: IDS } },
        select: { id: true },
      })
      const sqlRows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id
          FROM "shopping_sync_logs"
         WHERE "shopping_sync_logs".id = ANY(${IDS}::text[])
           AND (${unresolvedWcOrderRowSql()})
      `)
      // THE COMPLEMENT, WRITTEN THE WAY THE RETENTION SWEEP WRITES IT. Not `IS NOT TRUE`, and not
      // any other locally-corrected spelling: the obvious `NOT (...)` is what a reader writes, and
      // the fragment has to be safe under it.
      const complementRows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id
          FROM "shopping_sync_logs"
         WHERE "shopping_sync_logs".id = ANY(${IDS}::text[])
           AND NOT (${unresolvedWcOrderRowSql()})
      `)
      // AND THE PROPERTY ITSELF, INDEPENDENT OF EITHER QUERY: no row may make the fragment NULL.
      const undecidedRows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id
          FROM "shopping_sync_logs"
         WHERE "shopping_sync_logs".id = ANY(${IDS}::text[])
           AND (${unresolvedWcOrderRowSql()}) IS NULL
      `)
      captured = {
        viaPrisma: prismaRows.map((probe) => probe.id).sort(),
        viaSql: sqlRows.map((probe) => probe.id).sort(),
        viaSqlComplement: complementRows.map((probe) => probe.id).sort(),
        undecided: undecidedRows.map((probe) => probe.id).sort(),
      }
      // Nothing this test wrote may survive it.
      throw new Rollback()
    })
  } catch (error) {
    if (!(error instanceof Rollback)) {
      t.skip(`no usable PostgreSQL for the agreement check (${error instanceof Error ? error.message : String(error)})`)
      return null
    }
  }
  return captured
}

test('o3d-272i: the SQL spelling and the Prisma spelling select the same rows (live)', async (t) => {
  const result = await bothSpellings(t)
  if (!result) return

  // PRECONDITION: the seeding and both queries really ran over the whole matrix. Without this an
  // empty answer on both sides would satisfy the agreement assertion perfectly.
  assert.equal(ROWS.length, 13, 'precondition: every clause has a counter-example row')
  assert.deepEqual(
    result.viaPrisma,
    EXPECTED,
    'the Prisma predicate admits the two families in the three actionable statuses, and nothing else',
  )

  // MUTATION ROUTE: change the SQL spelling on its own — drop the `"recordKind" = ANY(...)` line
  // from unresolvedWcOrderRowSql, or make it `IS DISTINCT FROM NULL`, or drop the entityId clause.
  // Each admits a row the Prisma side excludes, and this assertion names the difference.
  assert.deepEqual(
    result.viaSql,
    result.viaPrisma,
    'the raw-SQL renderer must select exactly what the Prisma renderer selects',
  )
})

test('o3d-272i: an unstamped row is admitted by neither spelling', async (t) => {
  // Stated on its own because it is the one BEHAVIOUR CHANGE the consolidation makes, and the one
  // the readers depend on: a row with a NULL recordKind no longer blocks a delete, no longer blocks
  // a store rebind and is no longer exempt from retention. Migration 20260822120000 stamps every
  // pre-existing actionable row and its cutover gate refuses to start while any is left NULL.
  //
  // MUTATION ROUTE: drop the recordKind clause from UNRESOLVED_WC_ORDER_ROW / either renderer.
  // `unstamped` and `other-kind` join both answers and both assertions below fail.
  const result = await bothSpellings(t)
  if (!result) return
  for (const spelling of [result.viaPrisma, result.viaSql]) {
    assert.ok(!spelling.includes(rowId('unstamped')), 'a NULL recordKind is not a family membership')
    assert.ok(!spelling.includes(rowId('other-kind')), 'an unknown recordKind is not a family membership')
  }
})

test('o3d-272i r3: the SQL fragment partitions the table, so NOT (...) is its exact complement', async (t) => {
  // THE FINDING (Codex r3 MEDIUM). `recordKind` is nullable, so before r3 the fragment answered
  // UNKNOWN for the `unstamped` row: not admitted by `WHERE (fragment)`, and — because `NOT UNKNOWN`
  // is UNKNOWN — not admitted by `WHERE NOT (fragment)` either. It fell out of both halves, and the
  // half it fell out of at the only negating reader is lib/data-retention.ts, where "not in the
  // complement" means EXEMPT FROM RETENTION. `unresolvedWcOrderRowSql()` now renders
  // `COALESCE((...), FALSE)`.
  //
  // ASSERTED FROM BOTH ENDS ON PURPOSE. A test that only checked the positive side passes against
  // the unfixed code; so does one that only checked that the complement is non-empty.
  //
  // MUTATION ROUTE: remove the `COALESCE(( ... ), FALSE)` wrapper from unresolvedWcOrderRowSql.
  // `unstamped` leaves the complement, the partition assertion fails naming it, and `undecided`
  // stops being empty.
  const result = await bothSpellings(t)
  if (!result) return

  assert.deepEqual(result.undecided, [], 'the fragment must answer TRUE or FALSE for every row, never NULL')

  // THE UNSTAMPED ROW, BOTH WAYS. Neither of these holds on its own.
  assert.ok(
    !result.viaSql.includes(rowId('unstamped')),
    'a NULL recordKind must not be ADMITTED by the predicate',
  )
  assert.ok(
    result.viaSqlComplement.includes(rowId('unstamped')),
    'a NULL recordKind must not be EXEMPTED by the complement the retention sweep deletes by',
  )

  // AND THE GENERAL PROPERTY: every row of the matrix is in exactly one of the two halves.
  assert.deepEqual(
    [...result.viaSql, ...result.viaSqlComplement].sort(),
    [...IDS].sort(),
    'the predicate and its negation must cover the table between them',
  )
  assert.deepEqual(
    result.viaSql.filter((id) => result.viaSqlComplement.includes(id)),
    [],
    'and must not overlap',
  )
})

test('o3d-272i: a held sales invoice is not described to an operator as a refund', () => {
  // THE HALF OF o3d-272i THAT IS NOT ABOUT QUERIES. The four copies matched a defensible set; what
  // was wrong was that the delete guard said "this order has an unresolved WooCommerce refund parked
  // for review" about an invoice waiting for a number, and sent the operator to the refund recovery
  // inbox, which does not list holds.
  //
  // Written as a property of the WORDING rather than a comparison against a fixed string, so
  // rewording either message keeps the guarantee.
  const park = UNRESOLVED_WC_ORDER_ROW_DESCRIPTIONS[WC_REFUND_PARK_RECORD_KIND]
  const hold = UNRESOLVED_WC_ORDER_ROW_DESCRIPTIONS[HELD_SALES_INVOICE_RECORD_KIND]

  assert.match(park.deleteMessage, /refund/i, 'precondition: the park is still described as a refund')
  assert.match(park.countNoun, /refund/i)
  assert.ok(
    !/\brefund/i.test(hold.deleteMessage),
    `a held sales invoice must not be called a refund: ${hold.deleteMessage}`,
  )
  assert.ok(
    !/\brefund/i.test(hold.countNoun),
    `a held sales invoice must not be counted as a refund: ${hold.countNoun}`,
  )
  assert.match(hold.deleteMessage, /invoice/i, 'and it must say what it actually is')
  assert.notEqual(park.deleteBlockerCode, hold.deleteBlockerCode, 'two families, two blocker codes')

  // Every family has a description, and every description belongs to a family. The `Record` type
  // gives the first direction at compile time; this gives the second, and proves the table was not
  // reached through a stale import.
  assert.deepEqual(
    Object.keys(UNRESOLVED_WC_ORDER_ROW_DESCRIPTIONS).sort(),
    [...UNRESOLVED_WC_ORDER_ROW_FAMILIES].sort(),
  )
})
