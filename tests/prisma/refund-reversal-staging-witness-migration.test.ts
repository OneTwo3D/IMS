import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  REVERSAL_STAGING_NOT_STAGED,
  REVERSAL_STAGING_STAGED,
  reversalRecordVerdict,
} from '@/lib/domain/sales/refund-reversal-record'

/**
 * o3d-2sm1 — THE MIGRATION IS A PLAIN NULLABLE COLUMN, AND THAT IS THE DECISION BEING PINNED.
 *
 * Rounds 2, 3 and 4 of this branch each put a rule for this column into the database — a BEFORE
 * INSERT mint, a BEFORE UPDATE mint, then a BEFORE UPDATE trigger refusing the predecessor's
 * clearing statement — and each was right about the hole and wrong about where the rule could live.
 * A trigger can only witness what the writer in front of it actually does, and the binary serving
 * across this migration's window writes nothing to `sales_order_refunds` while staging. A refusal
 * needs an escape for a legitimate manual settle, and a GUC escape is reachable from restore SQL.
 * And the migration outlives a rollback, so the rows such a guard falsely accuses are not bounded by
 * the deploy window either.
 *
 * Every round was one problem in new clothes: a witness trying to make a guarantee that spans a
 * DEPLOY WINDOW. That is a deployment change (o3d-2sm1.1), not a schema one. So the mechanism is
 * gone and the sound core stays — two writes in one transaction, `[]` rather than NULL for an empty
 * stage, a tri-state verdict, a retry that refuses what it cannot decide, and an invariant with no
 * status filter and no retention window.
 *
 * THE TESTS THAT PINNED TRIGGER BEHAVIOUR ARE GONE WITH THE TRIGGERS. What replaces them pins the
 * ABSENCE — that this file adds a column and does nothing else — because "no mechanism" is a
 * decision that can be silently reversed by anyone who reads the rounds above and tries a fourth
 * time. Nothing here can execute against Postgres, so it reads the file; the comments legitimately
 * contain the words TRIGGER, INSERT and NULL, so they are stripped first.
 */

const MIGRATION = 'prisma/migrations/20260822090000_refund_reversal_staging_state/migration.sql'
const SCHEMA = 'prisma/schema.prisma'
const RESTORE_ROUTE = 'app/api/backup/restore/route.ts'

/** The executable statements only — every `--` comment removed. */
function statements(file: string): string {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
}

/** Every executable statement in the file, `;`-separated and stripped of blank lines. */
function statementList(file: string): string[] {
  return statements(file)
    .split(';')
    .map((chunk) => chunk.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

test('o3d-2sm1: the migration adds ONE nullable column and nothing else', () => {
  // The whole file, as executable SQL. A single statement is the assertion — a second one is either
  // a trigger, a backfill, or a rule, and all three are what this branch deliberately gave up.
  const list = statementList(MIGRATION)
  assert.deepEqual(
    list,
    ['ALTER TABLE "sales_order_refunds" ADD COLUMN "reversal_staging_state" TEXT'],
    'the migration is a plain nullable ADD COLUMN; anything else is mechanism this branch removed on purpose',
  )
})

test('o3d-2sm1: the column stays nullable, undefaulted and un-backfilled', () => {
  const sql = statements(MIGRATION)
  // A DEFAULT would be the database vouching for stagings it never witnessed, on every row already
  // there — which is exactly how `reversal_staged BOOLEAN NOT NULL DEFAULT false` became useless for
  // this question.
  assert.ok(
    !/ADD COLUMN "reversal_staging_state"[^;]*(NOT NULL|DEFAULT)/.test(sql),
    'nullable with no default: NULL has to be able to mean "nobody spoke for this row"',
  )
  // The pre-fix set cannot be reconstructed, only named. The invariant names it.
  assert.ok(!/^\s*UPDATE\s/mi.test(sql), 'no backfill statement may be added to this migration')
  assert.ok(!/^\s*INSERT\s/mi.test(sql), 'and nothing may be inserted either')
})

test('o3d-2sm1: no trigger, no function and no session setting — the mechanism is gone, deliberately', () => {
  // ROUNDS 2-4 ARE NOT TO BE RE-ADDED WITHOUT THE DEPLOY CHANGE. A trigger here can only witness
  // what the writer in front of it does, and the writer this window is about writes nothing to this
  // table while staging. A refusal here needs a GUC escape for a legitimate manual settle, and a GUC
  // is reachable from restore SQL. Both failures are structural, not fixable by a better clause.
  const sql = statements(MIGRATION)
  assert.ok(!/CREATE\s+(OR REPLACE\s+)?TRIGGER/i.test(sql), 'no trigger is created')
  assert.ok(!/CREATE\s+(OR REPLACE\s+)?FUNCTION/i.test(sql), 'and no trigger function')
  assert.ok(!/DROP\s+(TRIGGER|FUNCTION)/i.test(sql), 'nor a drop of one, since none was ever applied anywhere')
  assert.ok(!/current_setting\s*\(/i.test(sql), 'nothing reads a session setting')
  assert.ok(!/\bims\./.test(sql), 'and no `ims.` GUC is referenced at all')

  // The escapes had to be SET by somebody to mean anything, and the restore endpoint was where the
  // mint's was set. With no rule to escape, it is gone from there too — a setting nothing reads is
  // worse than none, because the next reader assumes something still honours it.
  const route = readFileSync(RESTORE_ROUTE, 'utf8')
  assert.ok(!/\bims\.unwitnessed_write\b/.test(route), 'the restore declares no provenance for this column')
  assert.ok(!/reversal_settled_manually/.test(route), 'and cannot claim a human settled a reversal')

  // The house marker exists for migrations Prisma's schema cannot represent. This one is a plain
  // column, so the schema carries it and the marker must not be left behind claiming otherwise.
  assert.ok(
    !/prisma-schema-scope-ok/.test(readFileSync(MIGRATION, 'utf8')),
    'a db-native rationale on a migration with nothing db-native in it is a false claim',
  )
  assert.match(readFileSync(SCHEMA, 'utf8'), /reversalStagingState\s+String\?\s+@map\("reversal_staging_state"\)/)
})

test('o3d-2sm1: a row no writer spoke for is UNDECIDABLE, which is what makes the plain column safe', () => {
  // THE CORE FIX, AT THE SEAM THE MIGRATION EXISTS FOR. With no trigger, a row written by any binary
  // that does not set the column lands NULL. That is the whole cost of removing the mechanism, and
  // it is only acceptable because NULL is a THIRD state rather than a "no": the retry refuses it and
  // the invariant reports it under its own warning code. The failure this branch started from was a
  // predicate that answered `false` here and let the caller clear the flag.
  const unwitnessed = {
    accountingRetryRequired: true,
    accountingRetrySyncs: null,
    reversalStagingState: null,
  }
  assert.equal(reversalRecordVerdict(unwitnessed), 'undecidable')
  assert.notEqual(
    reversalRecordVerdict(unwitnessed),
    'nothing-lost',
    'an unwitnessed row must never be reported as no loss — that is the bug, not the fix',
  )

  // And the two values the APPLICATION writes still decide what they are written to decide, so the
  // tri-state is not quietly collapsed by the removal.
  assert.equal(
    reversalRecordVerdict({ ...unwitnessed, reversalStagingState: REVERSAL_STAGING_STAGED }),
    'staged-never-recorded',
  )
  assert.equal(
    reversalRecordVerdict({ ...unwitnessed, reversalStagingState: REVERSAL_STAGING_NOT_STAGED }),
    'nothing-lost',
  )
  // `[]` is a written value: staging ran and staged nothing. It decides the row BEFORE the witness
  // is consulted, so a legacy row carrying a recorded list is not swept into `undecidable`.
  assert.equal(
    reversalRecordVerdict({ ...unwitnessed, accountingRetrySyncs: [] }),
    'nothing-lost',
  )
})

test('o3d-2sm1: the residual is stated in the migration rather than papered over', () => {
  // An honest weaker guarantee beats a false stronger one — the judgement this branch already made
  // once when it split its guarantee in two. The file has to SAY that a predecessor's own retry can
  // clear the flag on an unwitnessed row and that such a row is then unrecoverable, and it has to
  // name where that gets closed. A future reader who deletes the caveat has deleted the only place
  // the limitation is written down.
  const prose = readFileSync(MIGRATION, 'utf8')
  assert.match(prose, /UNRECOVERABLE/)
  assert.match(prose, /o3d-2sm1\.1/, 'the deploy-order work is named, not dropped')
})
