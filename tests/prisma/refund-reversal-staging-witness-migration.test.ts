import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  REVERSAL_STAGING_NOT_STAGED,
  REVERSAL_STAGING_STAGED,
  reversalRecordVerdict,
} from '@/lib/domain/sales/refund-reversal-record'

/**
 * o3d-2sm1 round 2 (Codex HIGH) — THE DEPLOY WINDOW, WHICH THE APPLICATION WRITES CANNOT COVER.
 *
 * `reversalRecordVerdict` reads a NULL `reversal_staging_state` as "this row predates the column".
 * Round 1 earned that reading by writing the value from `createSalesOrderRefund` and from
 * `stageRefundAccountingReversals` — but a migration is applied BEFORE the build that knows about it
 * is serving, so between the two the OLD binary is inserting refunds into the new schema and omitting
 * the column entirely. Those rows are NULL too, they are minted by the code that still has the
 * two-commit bug, and no application write can reach them: the old binary runs its own code, not its
 * own database.
 *
 * So the rule is in the database, in the same migration as the column, and this file is the check
 * that it stayed there. Nothing here can execute against Postgres, so the trigger is asserted against
 * the statement stream with comments stripped — the comments legitimately contain words like INSERT,
 * NULL and STAGED — and the verdict tests below feed `reversalRecordVerdict` the value the trigger
 * function is READ OUT OF THIS FILE as assigning, so a trigger that stopped stamping, or stamped
 * something else, fails them rather than passing on a hardcoded string.
 */

const MIGRATION = 'prisma/migrations/20260822090000_refund_reversal_staging_state/migration.sql'

/** The executable statements only — every `--` comment removed. */
function statements(file: string): string {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
}

/** The literal a trigger function assigns to the witness column, read out of the migration. */
function assignedState(sql: string, functionName: string): string {
  const body = sql.slice(sql.indexOf(`CREATE OR REPLACE FUNCTION ${functionName}()`))
  const assignment = body.slice(0, body.indexOf('$$;')).match(/NEW\."reversal_staging_state"\s*:=\s*'([A-Z_]+)'/)
  assert.ok(assignment, `${functionName} must assign a literal to the witness column`)
  return assignment![1]
}

/** The WHEN clause of a trigger, read out of the migration. */
function whenClause(sql: string, triggerName: string): string {
  const create = sql.slice(sql.lastIndexOf(`CREATE TRIGGER ${triggerName}`))
  const clause = create.slice(0, create.indexOf('EXECUTE FUNCTION')).match(/WHEN\s*\(([\s\S]+)\)\s*$/)
  assert.ok(clause, `${triggerName} must carry a WHEN clause`)
  return clause![1].replace(/\s+/g, ' ').trim()
}

test('the column and the rule that fills it ship in ONE migration (o3d-2sm1 r2)', () => {
  // There must be no ordering in which a database holds the column without the rule — a database
  // that had the column for even one release would hold rows nothing spoke for, and nothing later
  // could tell those from the legacy ones.
  const sql = statements(MIGRATION)
  assert.match(sql, /ALTER TABLE "sales_order_refunds" ADD COLUMN "reversal_staging_state" TEXT;/)
  assert.match(sql, /CREATE TRIGGER sales_order_refund_witness_birth\s+BEFORE INSERT ON "sales_order_refunds"/)
  assert.match(sql, /CREATE TRIGGER sales_order_refund_witness_staging\s+BEFORE UPDATE ON "sales_order_refunds"/)
  // BEFORE, not AFTER: the value has to be on the row on its way in, not corrected afterwards.
  assert.ok(!/AFTER (INSERT|UPDATE) ON "sales_order_refunds"/.test(sql))
  // The column stays nullable and undefaulted — a DEFAULT would be the database vouching for
  // stagings it never witnessed, on every row already there.
  assert.ok(!/ADD COLUMN "reversal_staging_state"[^;]*(NOT NULL|DEFAULT)/.test(sql))
  // The house marker, because Prisma's schema cannot represent a trigger.
  assert.match(readFileSync(MIGRATION, 'utf8'), /^--\s*prisma-schema-scope-ok:\s*db-native\b.{20,}$/m)
})

test('an old binary inserting AFTER the migration is stamped by the database, not left undecidable (o3d-2sm1 r2)', () => {
  const sql = statements(MIGRATION)
  const when = whenClause(sql, 'sales_order_refund_witness_birth')
  // The old binary's INSERT supplies NEITHER column — it has never heard of the witness, and a
  // relief amount is only ever written later, by staging. Both tests hold, so the trigger fires on
  // exactly the statement the application writes cannot reach.
  assert.match(when, /NEW\."reversal_staging_state" IS NULL/)
  assert.match(when, /NEW\."accounting_allocated_relief_amount" IS NULL/)

  // The row that INSERT leaves behind, with the state the trigger function itself says it writes.
  const oldBinaryRefund = {
    accountingRetryRequired: true,
    accountingRetrySyncs: null,
    reversalStagingState: assignedState(sql, 'sales_order_refund_witness_birth'),
  }
  assert.equal(oldBinaryRefund.reversalStagingState, REVERSAL_STAGING_NOT_STAGED)
  // Decidable: this refund owes accounting and demonstrably never staged, so the retry may proceed
  // and the invariant says nothing about it.
  assert.equal(reversalRecordVerdict(oldBinaryRefund), 'nothing-lost')
  // ...and this is what it would have been WITHOUT the trigger: a refund created minutes ago,
  // permanently unreadable, refused by the retry and reported as a standing warning for a human.
  assert.equal(
    reversalRecordVerdict({ ...oldBinaryRefund, reversalStagingState: null }),
    'undecidable',
  )
})

test('an old binary that STAGES mid-deploy and loses the record is a critical, not a warning (o3d-2sm1 r2)', () => {
  const sql = statements(MIGRATION)
  const when = whenClause(sql, 'sales_order_refund_witness_staging')
  // Keyed on the relief amount MOVING, because that statement IS the staging — it has exactly one
  // writer, one statement before the un-stage and inside its transaction. The old binary stages
  // through that same statement, which is why the database catches it.
  assert.match(when, /NEW\."accounting_allocated_relief_amount" IS NOT NULL/)
  assert.match(when, /NEW\."accounting_allocated_relief_amount" IS DISTINCT FROM OLD\."accounting_allocated_relief_amount"/)

  const stagedByOldBinary = {
    accountingRetryRequired: true,
    accountingRetrySyncs: null,
    reversalStagingState: assignedState(sql, 'sales_order_refund_witness_staging'),
  }
  assert.equal(stagedByOldBinary.reversalStagingState, REVERSAL_STAGING_STAGED)
  // The old binary crashed between the staging transaction and the statement that records what it
  // produced — the case this whole issue is about. Named as a confirmed loss instead of dissolving
  // into "cannot tell".
  assert.equal(reversalRecordVerdict(stagedByOldBinary), 'staged-never-recorded')
})

test('the triggers only ever MINT, and only where nothing was said (o3d-2sm1 r2)', () => {
  // DIRECTION, and it is the opposite of 20260821090000 / 20260819210000 — both of which only ever
  // CLEAR, because both vouch for an event the trigger did not execute. These two stamp the
  // statement they are running inside, so they may mint; what they may never do is overwrite.
  const sql = statements(MIGRATION)
  assert.ok(!/NEW\."reversal_staging_state"\s*:=\s*NULL/.test(sql), 'the witness is never cleared')

  const birth = whenClause(sql, 'sales_order_refund_witness_birth')
  // 'NOT_STAGED' only where there is no state at all, so it can never land on top of 'STAGED'.
  assert.match(birth, /NEW\."reversal_staging_state" IS NULL/)

  const staging = whenClause(sql, 'sales_order_refund_witness_staging')
  // Stands down the moment the statement has an opinion of its own — the new build's explicit
  // write wins, and the trigger is a no-op for it.
  assert.match(staging, /NEW\."reversal_staging_state" IS NOT DISTINCT FROM OLD\."reversal_staging_state"/)
})

test('a reload of a pre-migration row is not laundered into "nothing was staged" (o3d-2sm1 r2)', () => {
  // A `pg_restore`/COPY of a pre-migration dump presents historical rows to the INSERT trigger. A
  // genuine birth cannot carry a relief amount, so a row that does is being reloaded, not created —
  // and stamping 'NOT_STAGED' on it would erase the exact accusation the critical exists to make.
  const sql = statements(MIGRATION)
  assert.match(
    whenClause(sql, 'sales_order_refund_witness_birth'),
    /NEW\."accounting_allocated_relief_amount" IS NULL/,
  )
  // Which is what that row reads as with the state left NULL: undecidable, and reported as such.
  assert.equal(
    reversalRecordVerdict({
      accountingRetryRequired: true,
      accountingRetrySyncs: null,
      reversalStagingState: null,
    }),
    'undecidable',
  )
})

test('the forward window only — the migration still backfills nothing (o3d-2sm1 r2)', () => {
  // Rows written before the migration are legitimately unknown. Any UPDATE here would be the
  // database vouching for events it never saw, which is the defect the column exists to end.
  const sql = statements(MIGRATION)
  assert.ok(!/^\s*UPDATE\s/m.test(sql), 'no backfill statement may be added to this migration')
})
