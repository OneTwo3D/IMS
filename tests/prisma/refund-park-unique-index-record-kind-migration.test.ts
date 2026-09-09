import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  ACTIVE_REFUND_PARK_INDEX_COLUMNS,
  ACTIVE_REFUND_PARK_INDEX_NAME,
  WC_REFUND_PARK_RECORD_KIND,
  activeRefundParkIndexPredicateSql,
} from '@/lib/domain/sales/wc-sync-row-families'

/**
 * o3d-272i r2 (Codex HIGH) — THE MIGRATION THAT MAKES THE INDEX ASK `recordKind`, AND THE ONLY
 * MECHANISM THAT CAN HOLD DDL TO A TYPESCRIPT DEFINITION.
 *
 * `unresolvedWcOrderRowWhere` and `unresolvedWcOrderRowSql` are two RENDERERS of one object, so they
 * cannot disagree about what the rule is. The database is a third reader of the refund-park rule and
 * it CANNOT be a renderer: Prisma applies a static, checksummed .sql file, so nothing in this
 * repository can generate the predicate at deploy time. That is the honest limit, and it is why this
 * file exists — what the DDL cannot be GENERATED from, it can be CHECKED against.
 *
 * SO THE CHECK IS TEXTUAL, AND DELIBERATELY EXACT. The migration must CONTAIN, character for
 * character, the string `activeRefundParkIndexPredicateSql()` renders from `ACTIVE_REFUND_PARK_ROW`
 * — the same object `activeRefundParkWhere()` reads. Editing either side alone turns this red:
 * change a literal in the shared object and the file no longer contains the new text; edit the .sql
 * and it no longer contains the old.
 *
 * WHAT IT IS NOT. It is not proof that the index BEHAVES as the shared predicate does — a rendered
 * string could be exactly reproduced in a file and still be wrong SQL. That assertion needs a
 * server, and tests/concurrency/refund-park-index-family-scope.concurrent.test.ts makes it against a
 * database built from these migrations: it reads the SHIPPED predicate back out of `pg_index` and
 * executes it beside the Prisma `where` over one probe matrix.
 *
 * COMMENTS ARE STRIPPED BEFORE ANYTHING IS MATCHED. This migration's header quotes parts of its own
 * predicate, in prose, to explain what changed; a test that could be satisfied by that prose would
 * pass over a file that executes nothing.
 */

const MIGRATION = 'prisma/migrations/20260909090000_refund_park_unique_index_record_kind/migration.sql'
/** The July index this one replaces. Applied everywhere, and therefore immutable. */
const PREDECESSOR = 'prisma/migrations/20260721150000_refund_park_unique_index/migration.sql'

/** The executable statements only — every `--` comment line removed. */
function statements(path: string): string {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
}

test('[o3d-272i r2] the shipped index predicate IS the string the shared definition renders', () => {
  const sql = statements(MIGRATION)
  const rendered = activeRefundParkIndexPredicateSql()

  // PRECONDITION: the file has executable content at all. An empty or renamed migration would
  // satisfy several of the assertions below by having nothing to contradict them.
  assert.match(sql, /CREATE UNIQUE INDEX/, 'precondition: the migration builds an index')

  assert.ok(
    sql.includes(`WHERE ${rendered};`),
    `the migration's WHERE clause must be exactly what activeRefundParkIndexPredicateSql() renders:\n${rendered}`,
  )

  // The name and the key columns come from the shared module too, so a rename cannot leave the
  // application talking about an index that is no longer there.
  assert.ok(sql.includes(`CREATE UNIQUE INDEX "${ACTIVE_REFUND_PARK_INDEX_NAME}"`))
  assert.ok(sql.includes(`ON "shopping_sync_logs" (${ACTIVE_REFUND_PARK_INDEX_COLUMNS})`))
})

test('[o3d-272i r2] the predicate asks the row which family it belongs to', () => {
  // THE SUBSTANCE, stated separately from the agreement. Two spellings that agree perfectly can
  // both be wrong: dropping the clause from ACTIVE_REFUND_PARK_ROW and from the .sql together would
  // keep the assertion above green and reintroduce the entire defect.
  const rendered = activeRefundParkIndexPredicateSql()
  assert.ok(
    rendered.includes(`"recordKind" = '${WC_REFUND_PARK_RECORD_KIND}'`),
    'the index must be scoped to the refund-park family, or a held sales invoice collides with it',
  )
  assert.ok(statements(MIGRATION).includes(`"recordKind" = '${WC_REFUND_PARK_RECORD_KIND}'`))
})

test('[o3d-272i r2] the July index is the one being replaced, and is left untouched', () => {
  // The DEFECT, asserted as a historical fact about the file that shipped it. This is also what
  // makes the test above mean something: if 20260721150000 had always carried `recordKind` there
  // would be nothing here to fix, and this assertion would fail rather than quietly agree.
  const predecessor = statements(PREDECESSOR)
  assert.match(predecessor, new RegExp(`CREATE UNIQUE INDEX "${ACTIVE_REFUND_PARK_INDEX_NAME}"`))
  assert.ok(
    !predecessor.includes('recordKind'),
    'precondition: the July index predicate never carried recordKind — that is the bug this migration closes',
  )

  // AND IT MUST STAY THAT WAY. An applied migration is checksummed by Prisma; editing this one in
  // place to add the clause would leave every deployed database with the old index and every
  // `migrate status` reporting a modified migration. The fix has to be a NEW file, which is why
  // this test asserts the old one still reads as it did.
  assert.ok(predecessor.includes('DELETE FROM "shopping_sync_logs" a'), 'the July dedup is still there')
})

test('[o3d-272i r2] the drop and the rebuild are one transaction, and not CONCURRENTLY', () => {
  const sql = statements(MIGRATION)

  assert.equal((sql.match(/\bBEGIN;/g) ?? []).length, 1)
  assert.equal((sql.match(/\bCOMMIT;/g) ?? []).length, 1)
  assert.equal((sql.match(/DROP INDEX/g) ?? []).length, 1)
  assert.equal((sql.match(/CREATE UNIQUE INDEX/g) ?? []).length, 1)

  const begin = sql.indexOf('BEGIN;')
  const drop = sql.indexOf('DROP INDEX')
  const create = sql.indexOf('CREATE UNIQUE INDEX')
  const commit = sql.lastIndexOf('COMMIT;')
  assert.ok(begin < drop && drop < create && create < commit, 'drop, then rebuild, inside one transaction')

  // Outside a transaction the drop would leave the table with NO uniqueness on this key for as long
  // as the rebuild takes, which is the window the July migration went to some length to avoid.
  assert.doesNotMatch(sql, /CONCURRENTLY/)

  // IF EXISTS would turn "the predecessor never ran" into a silent success that creates an index
  // over data neither migration's collision gate has ever inspected.
  assert.doesNotMatch(sql, /DROP INDEX IF EXISTS/)
})
