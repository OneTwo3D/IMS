import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  REVERSAL_STAGING_NOT_STAGED,
  REVERSAL_STAGING_STAGED,
  reversalRecordVerdict,
} from '@/lib/domain/sales/refund-reversal-record'

/**
 * o3d-2sm1 round 3 (Codex CRITICAL + HIGH) — WHAT THE DATABASE CAN AND CANNOT WITNESS ACROSS A
 * DEPLOY, CHECKED AGAINST THE MIGRATION ITSELF.
 *
 * Round 2 put two BEFORE triggers in the migration and argued they closed the window between
 * `prisma migrate deploy` and the new build serving: 'NOT_STAGED' minted at INSERT, 'STAGED' minted
 * when `accounting_allocated_relief_amount` moves, on the grounds that "old binaries stage through
 * that same statement". THEY DO NOT. That column arrived with o3d-o97 (#635), merged 2026-08-21 and
 * undeployed, so the binary serving during this migration's window PREDATES it and writes nothing at
 * all to `sales_order_refunds` while staging — only the un-stage of `sales_orders`. The UPDATE mint
 * cannot fire for it, and the INSERT mint, which fired for exactly the writers whose staging is
 * invisible here, stamped its rows 'NOT_STAGED' — which `reversalRecordVerdict` reads as
 * `nothing-lost`. A reversal staged and lost mid-window came out certified fine.
 *
 * So the INSERT mint is gone and the guarantee is stated in two halves: STRUCTURAL for a #635-era
 * predecessor, OPERATIONAL and weaker for a pre-#635 one, whose rows are undecidable rather than
 * decided. Nothing here can execute against Postgres, so the triggers are SIMULATED off the
 * statement stream — the file's comments legitimately contain the words INSERT, NULL and STAGED, so
 * they are stripped first — and the simulated rows are fed to the real `reversalRecordVerdict`. A
 * trigger that came back, stopped stamping, or stamped something else fails these rather than
 * passing on a hardcoded string.
 */

const MIGRATION = 'prisma/migrations/20260822090000_refund_reversal_staging_state/migration.sql'
const RESTORE_ROUTE = 'app/api/backup/restore/route.ts'

/** The executable statements only — every `--` comment removed. */
function statements(file: string): string {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
}

/** The literal a trigger function assigns to the witness column, read out of the migration. */
function assignedState(sql: string, functionName: string): string | null {
  const marker = `CREATE OR REPLACE FUNCTION ${functionName}()`
  if (!sql.includes(marker)) return null
  const body = sql.slice(sql.indexOf(marker))
  const assignment = body.slice(0, body.indexOf('$$;')).match(/NEW\."reversal_staging_state"\s*:=\s*'([A-Z_]+)'/)
  return assignment ? assignment[1] : null
}

/** The name of the function a live trigger on `sales_order_refunds` executes for an event. */
function triggerFunctionFor(sql: string, event: 'INSERT' | 'UPDATE'): string | null {
  const create = new RegExp(
    `CREATE TRIGGER (\\w+)\\s+BEFORE ${event} ON "sales_order_refunds"[\\s\\S]*?EXECUTE FUNCTION (\\w+)\\(\\)`,
  ).exec(sql)
  if (!create) return null
  // A trigger dropped further down the file is not a trigger. `DROP ... IF EXISTS` immediately
  // before a `CREATE` of the same name is the file's own idempotency guard, so only a drop that
  // comes AFTER the create counts as a removal.
  const dropIndex = sql.lastIndexOf(`DROP TRIGGER IF EXISTS ${create[1]} ON`)
  if (dropIndex > sql.indexOf(`CREATE TRIGGER ${create[1]}`)) return null
  return create[2]
}

/**
 * What the database leaves on the row after an INSERT that supplies NEITHER the witness nor a relief
 * amount — the shape every writer outside this build produces. Returns the value the migration's own
 * INSERT trigger would stamp, or `null` when there is no such trigger.
 */
function stateAfterForeignInsert(sql: string): string | null {
  const fn = triggerFunctionFor(sql, 'INSERT')
  return fn ? assignedState(sql, fn) : null
}

/** What the database leaves on the row after a statement that MOVES the relief amount. */
function stateAfterReliefMove(sql: string, priorState: string | null): string | null {
  const fn = triggerFunctionFor(sql, 'UPDATE')
  return fn ? assignedState(sql, fn) : priorState
}

test('the column and the rule that fills it ship in ONE migration (o3d-2sm1 r2)', () => {
  // There must be no ordering in which a database holds the column without the rule — a database
  // that had the column for even one release would hold rows nothing spoke for, and nothing later
  // could tell those from the legacy ones.
  const sql = statements(MIGRATION)
  assert.match(sql, /ALTER TABLE "sales_order_refunds" ADD COLUMN "reversal_staging_state" TEXT;/)
  assert.match(sql, /CREATE TRIGGER sales_order_refund_witness_staging\s+BEFORE UPDATE ON "sales_order_refunds"/)
  // BEFORE, not AFTER: the value has to be on the row on its way in, not corrected afterwards.
  assert.ok(!/AFTER (INSERT|UPDATE) ON "sales_order_refunds"/.test(sql))
  // The column stays nullable and undefaulted — a DEFAULT would be the database vouching for
  // stagings it never witnessed, on every row already there.
  assert.ok(!/ADD COLUMN "reversal_staging_state"[^;]*(NOT NULL|DEFAULT)/.test(sql))
  // The house marker, because Prisma's schema cannot represent a trigger.
  assert.match(readFileSync(MIGRATION, 'utf8'), /^--\s*prisma-schema-scope-ok:\s*db-native\b.{20,}$/m)
})

test('o3d-2sm1 Codex r3: a binary that NEVER WRITES THE RELIEF AMOUNT loses a reversal and is not laundered', () => {
  // THE CRITICAL. The binary serving while this migration is applied predates o3d-o97 (#635), so
  // `accounting_allocated_relief_amount` does not exist for it and it writes NOTHING to this table
  // inside the staging transaction. Both of round 2's triggers were keyed on writes it does not
  // perform, so the database sees this whole sequence and can witness none of it.
  const sql = statements(MIGRATION)

  //  1. it INSERTs a refund, supplying neither the witness nor a relief amount;
  const born = stateAfterForeignInsert(sql)
  //  2. it stages: computes the three reversals, un-stages `sales_orders` — and touches no column
  //     on this row, so there is no relief move for the UPDATE trigger to fire on;
  const afterStaging = born
  //  3. it dies before the statement that records what staging produced.
  const lostRow = {
    accountingRetryRequired: true,
    accountingRetrySyncs: null,
    reversalStagingState: afterStaging,
  }

  // THE ROW MUST NOT COME OUT CERTIFIED FINE. This is the exact assertion round 2 failed: its
  // INSERT trigger stamped 'NOT_STAGED' here, `reversalRecordVerdict` reads that as `nothing-lost`,
  // and a lost reversal was waved through by the mechanism built to catch it.
  assert.notEqual(
    reversalRecordVerdict(lostRow),
    'nothing-lost',
    'a reversal this database could not witness must never be reported as no loss',
  )
  assert.equal(born, null, 'no INSERT mint may exist: it can only ever fire for writers whose staging is invisible here')
  assert.equal(
    reversalRecordVerdict(lostRow),
    'undecidable',
    'the honest answer — the retry refuses it and the invariant names it for a human',
  )
})

test('o3d-2sm1 Codex r3: the removed INSERT mint is dropped by name, not merely left uncreated', () => {
  // A database that had an earlier revision of this file applied to it must LOSE the trigger, not
  // keep a stamp nothing in this repository stands behind any more.
  const sql = statements(MIGRATION)
  assert.match(sql, /DROP TRIGGER IF EXISTS sales_order_refund_witness_birth ON "sales_order_refunds";/)
  assert.match(sql, /DROP FUNCTION IF EXISTS sales_order_refund_witness_birth\(\);/)
  assert.ok(
    !/CREATE OR REPLACE FUNCTION sales_order_refund_witness_birth\(\)/.test(sql),
    'and it is not recreated below the drop',
  )
})

test('o3d-2sm1 Codex r3: the surviving mint witnesses a build that DOES move the relief amount', () => {
  // The one writer the database can still speak for, and the honest scope of the structural claim:
  // a #635-era build, which has `accounting_allocated_relief_amount` but has never heard of this
  // column. Since #635 is merged and undeployed, that build is a real possible predecessor.
  const sql = statements(MIGRATION)
  const when = /CREATE TRIGGER sales_order_refund_witness_staging[\s\S]*?WHEN\s*\(([\s\S]+?)\)\s*EXECUTE FUNCTION/
    .exec(sql)?.[1].replace(/\s+/g, ' ').trim()
  assert.ok(when, 'the staging trigger must carry a WHEN clause')
  // MOVEMENT, not the stored value: firing on "this row has a relief amount" would inherit a claim
  // from a value the trigger never saw written, on any unrelated later UPDATE.
  assert.match(when!, /NEW\."accounting_allocated_relief_amount" IS NOT NULL/)
  assert.match(when!, /NEW\."accounting_allocated_relief_amount" IS DISTINCT FROM OLD\."accounting_allocated_relief_amount"/)
  // Stands down the moment the statement has an opinion of its own, so this build's explicit write
  // wins and the trigger is a no-op for it.
  assert.match(when!, /NEW\."reversal_staging_state" IS NOT DISTINCT FROM OLD\."reversal_staging_state"/)

  // Born unwitnessed (it does not know the column), then staged through a statement that moves the
  // relief amount, then dead before the syncs were recorded.
  const staged = {
    accountingRetryRequired: true,
    accountingRetrySyncs: null,
    reversalStagingState: stateAfterReliefMove(sql, stateAfterForeignInsert(sql)),
  }
  assert.equal(staged.reversalStagingState, REVERSAL_STAGING_STAGED)
  assert.equal(reversalRecordVerdict(staged), 'staged-never-recorded', 'a named loss, not a warning')
})

test('o3d-2sm1 Codex r3: the surviving mint can only ever ACCUSE, never exonerate', () => {
  // DIRECTION is what makes minting admissible at all, against two precedents (20260821090000,
  // 20260819210000) that only ever CLEAR. This one moves a row from `undecidable` towards an
  // accusation, so a wrong mint costs an investigation. Round 2's INSERT mint moved rows the other
  // way, towards `nothing-lost`, so a wrong mint there cost a reversal.
  const sql = statements(MIGRATION)
  assert.ok(!/NEW\."reversal_staging_state"\s*:=\s*NULL/.test(sql), 'the witness is never cleared')
  const minted = new Set(
    [...sql.matchAll(/NEW\."reversal_staging_state"\s*:=\s*'([A-Z_]+)'/g)].map((m) => m[1]),
  )
  assert.deepEqual([...minted], [REVERSAL_STAGING_STAGED], 'STAGED is the only value the database mints')
  assert.ok(
    !minted.has(REVERSAL_STAGING_NOT_STAGED),
    'NOT_STAGED reads as nothing-lost, so no trigger may write it — only the INSERT that witnesses the birth',
  )
})

test('o3d-2sm1 Codex r3: a restore declares itself, and its rows stay unwitnessed', () => {
  // THE HIGH. Round 2 tried to keep reloads out of the mint by testing the row's contents
  // (`accounting_allocated_relief_amount IS NULL`) — and this branch's own `sm1PreWitnessLostRow`
  // is a genuinely staged, genuinely LOST row with a NULL relief amount, so it passed that test and
  // would have been stamped. Provenance is DECLARED by the operation instead, never inferred.
  const sql = statements(MIGRATION)
  const fn = triggerFunctionFor(sql, 'UPDATE')!
  const body = sql.slice(sql.indexOf(`CREATE OR REPLACE FUNCTION ${fn}()`))
  const guard = /current_setting\('([a-z_.]+)',\s*true\)\s*=\s*'on'[\s\S]{0,80}?RETURN NEW;/.exec(body)
  assert.ok(guard, 'the mint must stand down for a write that declares itself unwitnessed')
  // The guard returns BEFORE the assignment, or it is not a guard.
  assert.ok(
    body.indexOf(guard![0]) < body.indexOf('NEW."reversal_staging_state" :='),
    'the escape must precede the assignment it suppresses',
  )
  // And the application's own restore is one of those operations, under the SAME setting name — a
  // guard nothing sets is a guard that does nothing.
  const route = readFileSync(RESTORE_ROUTE, 'utf8')
  assert.match(route, /PGOPTIONS/)
  assert.ok(
    route.includes(`-c ${guard![1]}=on`),
    `the restore must set ${guard![1]} for its psql session`,
  )
  // A reloaded pre-migration row therefore reads as what it is.
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
