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

/**
 * o3d-2sm1 round 4 (Codex CRITICAL) — THE ACTOR IN THE WINDOW IS THE PREDECESSOR, AND IT CLEARS THE
 * FLAG EVERYTHING ELSE IS BOUNDED BY.
 *
 * Round 3 signed off with "rows minted in the window are undecidable, refused by the retry and named
 * by the invariant". Both of those live in the NEW binary. The one that is serving while the window
 * is open is the predecessor, whose retry reads the nulled deferral as "nothing was owed", reports
 * success having queued nothing, and whose caller then writes exactly `PREDECESSOR_CLEAR` below.
 * `accounting_retry_required` is the accounting invariant's only bound, so that statement does not
 * merely fail to fix the row — it makes a row this branch's own witness had ACCUSED unfindable.
 *
 * These tests run the predecessor's statement against the migration's own rules: the guard's WHEN
 * clause is read out of the file and EVALUATED against (OLD, NEW) row pairs, so a clause that is
 * removed, narrowed to the wrong column, or keyed on NEW where it must read OLD fails them rather
 * than passing on a hardcoded string.
 */

const REFUND_SERVICE = 'lib/domain/sales/refund-service.ts'

type DbRow = Record<string, unknown>

/** The guard trigger's WHEN clause, exactly as the migration declares it — or null if it is gone. */
function guardWhenClause(sql: string): string | null {
  const create = /CREATE TRIGGER sales_order_refund_guard_witnessed_clear\s+BEFORE UPDATE ON "sales_order_refunds"[\s\S]*?WHEN\s*\(([\s\S]+?)\)\s*EXECUTE FUNCTION sales_order_refund_guard_witnessed_clear\(\)/
    .exec(sql)
  if (!create) return null
  const dropIndex = sql.lastIndexOf('DROP TRIGGER IF EXISTS sales_order_refund_guard_witnessed_clear ON')
  if (dropIndex > sql.indexOf('CREATE TRIGGER sales_order_refund_guard_witnessed_clear')) return null
  return create[1].replace(/\s+/g, ' ').trim()
}

/** The guard trigger function's body, up to its terminator. */
function guardFunctionBody(sql: string): string | null {
  const marker = 'CREATE OR REPLACE FUNCTION sales_order_refund_guard_witnessed_clear()'
  if (!sql.includes(marker)) return null
  const body = sql.slice(sql.indexOf(marker))
  return body.slice(0, body.indexOf('$$;'))
}

/**
 * Does the guard fire on this statement? Evaluates the migration's own WHEN clause — every term of
 * it — against the row before and after. A term shape this cannot evaluate fails loudly rather than
 * being skipped, so the clause cannot quietly grow a condition the test does not police.
 */
function guardFires(clause: string, before: DbRow, after: DbRow): boolean {
  return clause.split(' AND ').every((term) => {
    const parsed = /^(OLD|NEW)\."([a-z_]+)" (?:IS (NOT NULL|NULL|TRUE|FALSE)|= '([A-Z_]+)')$/.exec(term.trim())
    assert.ok(parsed, `the guard's WHEN clause carries a term this test cannot evaluate: ${term}`)
    const row = parsed![1] === 'OLD' ? before : after
    const value = row[parsed![2]]
    switch (parsed![3]) {
      case 'NULL': return value == null
      case 'NOT NULL': return value != null
      case 'TRUE': return value === true
      case 'FALSE': return value === false
      default: return value === parsed![4]
    }
  })
}

/** One refund in the two vocabularies these tests need: the database's, and the module's. */
function refundRow(input: { retryRequired: boolean; syncs: unknown; witness: string | null }) {
  return {
    db: {
      accounting_retry_required: input.retryRequired,
      accounting_retry_syncs: input.syncs,
      reversal_staging_state: input.witness,
    } as DbRow,
    domain: {
      accountingRetryRequired: input.retryRequired,
      accountingRetrySyncs: input.syncs,
      reversalStagingState: input.witness,
    },
  }
}

/**
 * The clearing UPDATE in `retryRefundAccounting` (app/actions/sales.ts), which is the same statement
 * in the predecessor as in this build: the flag off, the warning gone, the retry list nulled — and
 * nothing recorded in their place.
 */
const PREDECESSOR_CLEAR: DbRow = {
  accounting_retry_required: false,
  accounting_warning: null,
  accounting_retry_syncs: null,
}

const applyStatement = (before: DbRow, patch: DbRow): DbRow => ({ ...before, ...patch })

test('o3d-2sm1 Codex r4: the predecessor\'s retry cannot exonerate a row the witness has accused', () => {
  const sql = statements(MIGRATION)

  // The row the CRITICAL is about, built the way the database builds it: born unwitnessed under a
  // #635-era binary, then staged through a statement that MOVES the relief amount — which is what
  // the surviving mint fires on — then dead before the syncs were recorded.
  const lost = refundRow({
    retryRequired: true,
    syncs: null,
    witness: stateAfterReliefMove(sql, stateAfterForeignInsert(sql)),
  })
  assert.equal(lost.domain.reversalStagingState, REVERSAL_STAGING_STAGED)
  assert.equal(reversalRecordVerdict(lost.domain), 'staged-never-recorded', 'the witness accuses it')

  // Now the predecessor's retry runs against this schema. It has none of this build's refusals: it
  // reports success having queued nothing, and issues the clear.
  const clause = guardWhenClause(sql)
  assert.ok(clause, 'the migration must carry a rule the predecessor cannot bypass')
  assert.ok(
    guardFires(clause!, lost.db, applyStatement(lost.db, PREDECESSOR_CLEAR)),
    'the exonerating clear must be caught by the database, because the code that would catch it is not deployed yet',
  )

  // And caught means REFUSED, not observed. A function that fell through to RETURN NEW would let the
  // write land and the row would leave the invariant's bound for good.
  const body = guardFunctionBody(sql)
  assert.ok(body, 'the guard trigger needs a function')
  assert.match(body!, /RAISE EXCEPTION/)
  assert.equal(
    (body!.match(/RETURN NEW/g) ?? []).length,
    1,
    'exactly one RETURN NEW — the declared manual settle. Any other is a hole',
  )
  assert.ok(
    body!.indexOf('RETURN NEW') < body!.indexOf('RAISE EXCEPTION'),
    'and it is the declared escape, which must precede the refusal it bypasses',
  )

  // So the flag survives the window, which is the whole point: the row is still inside
  // `where: { accountingRetryRequired: true }` when the new build's invariant finally runs.
  assert.equal(reversalRecordVerdict(lost.domain), 'staged-never-recorded')
})

test('o3d-2sm1 Codex r4: the guard refuses exactly `staged-never-recorded`, and no ordinary clear', () => {
  // A guard that blocked a legitimate clear would strand rows an operator then has to clear by hand,
  // so every statement in THIS build that clears the flag is run through it here.
  const sql = statements(MIGRATION)
  const clause = guardWhenClause(sql)!

  const cases: Array<{ name: string; before: ReturnType<typeof refundRow>; patch: DbRow; fires: boolean }> = [
    {
      name: 'the predecessor exonerating a witnessed loss — the CRITICAL',
      before: refundRow({ retryRequired: true, syncs: null, witness: REVERSAL_STAGING_STAGED }),
      patch: PREDECESSOR_CLEAR,
      fires: true,
    },
    {
      name: 'the `nothing-lost` short-circuit: witnessed birth, staging demonstrably never committed',
      before: refundRow({ retryRequired: true, syncs: null, witness: REVERSAL_STAGING_NOT_STAGED }),
      patch: PREDECESSOR_CLEAR,
      fires: false,
    },
    {
      name: 'a legacy row with no witness — nothing to accuse on, so nothing to refuse',
      before: refundRow({ retryRequired: true, syncs: null, witness: null }),
      patch: PREDECESSOR_CLEAR,
      fires: false,
    },
    {
      name: 'an ordinary successful retry that RE-STAGED: its own transaction recorded the list first',
      before: refundRow({ retryRequired: true, syncs: [], witness: REVERSAL_STAGING_STAGED }),
      patch: PREDECESSOR_CLEAR,
      fires: false,
    },
    {
      name: 'an ordinary successful retry that re-queued syncs already on the row',
      before: refundRow({ retryRequired: true, syncs: [{ type: 'COGS_REVERSAL' }], witness: REVERSAL_STAGING_STAGED }),
      patch: PREDECESSOR_CLEAR,
      fires: false,
    },
    {
      name: 'createSalesOrderRefund clearing the flag in the SAME statement that records the list',
      before: refundRow({ retryRequired: true, syncs: null, witness: REVERSAL_STAGING_STAGED }),
      patch: { accounting_retry_required: false, accounting_retry_syncs: [] },
      fires: false,
    },
    {
      name: 'any later write to a row whose flag is already clear — the guard tests movement',
      before: refundRow({ retryRequired: false, syncs: null, witness: REVERSAL_STAGING_STAGED }),
      patch: PREDECESSOR_CLEAR,
      fires: false,
    },
  ]

  for (const scenario of cases) {
    assert.equal(
      guardFires(clause, scenario.before.db, applyStatement(scenario.before.db, scenario.patch)),
      scenario.fires,
      scenario.name,
    )
  }

  // THE SAME RULE, NOT A SECOND ONE. For the statement that records nothing in place of what it
  // clears, the database's answer and `reversalRecordVerdict`'s must agree term for term — otherwise
  // the guard is a database-flavoured rule of its own, free to drift from the application's.
  for (const scenario of cases) {
    if (scenario.patch !== PREDECESSOR_CLEAR) continue
    if (scenario.before.domain.accountingRetryRequired !== true) continue
    assert.equal(
      guardFires(clause, scenario.before.db, applyStatement(scenario.before.db, scenario.patch)),
      reversalRecordVerdict(scenario.before.domain) === 'staged-never-recorded',
      `the database and reversalRecordVerdict must not disagree about: ${scenario.name}`,
    )
  }
})

test('o3d-2sm1 Codex r4: the guard reads OLD for every accusation, and tests the flag MOVING', () => {
  const clause = guardWhenClause(statements(MIGRATION))!
  // Movement, not the stored value — the same reason the mint tests a move: a rule keyed on "this
  // row has the flag clear" would fire on every later write to a settled refund.
  assert.match(clause, /OLD\."accounting_retry_required" IS TRUE/)
  assert.match(clause, /NEW\."accounting_retry_required" IS FALSE/)
  // The accusation is read from the row as it stood BEFORE the statement. Reading the witness from
  // NEW would let the mint, firing on the very same statement, manufacture the accusation the guard
  // then refuses.
  assert.match(clause, /OLD\."reversal_staging_state" = 'STAGED'/)
  assert.match(clause, /OLD\."accounting_retry_syncs" IS NULL/)
  assert.ok(
    !/NEW\."reversal_staging_state"/.test(clause),
    'the guard must not read the witness the mint may have just written',
  )
  // And it stands down for a statement that records something in place of what it clears.
  assert.match(clause, /NEW\."accounting_retry_syncs" IS NULL/)
})

test('o3d-2sm1 Codex r4: a deliberate manual clear declares itself, under a setting a restore cannot use', () => {
  const sql = statements(MIGRATION)
  const body = guardFunctionBody(sql)!
  const escape = /current_setting\('([a-z_.]+)',\s*true\)\s*=\s*'on'/.exec(body)
  assert.ok(escape, 'both refusal messages tell an operator to clear the flag by hand, so a declared clear must be possible')

  // NOT the mint's setting. `ims.unwitnessed_write` says "this write is not an event anyone
  // witnessed" and the restore endpoint sets it for a whole psql session; this one says "a human has
  // settled these reversals against the ledger". A restore must never be able to make that claim.
  const mintBody = sql.slice(sql.indexOf(`CREATE OR REPLACE FUNCTION ${triggerFunctionFor(sql, 'UPDATE')}()`))
  const mintEscape = /current_setting\('([a-z_.]+)',\s*true\)\s*=\s*'on'/.exec(mintBody)!
  assert.notEqual(
    escape![1],
    mintEscape[1],
    'a restore declaring itself unwitnessed must not thereby be able to exonerate a witnessed loss',
  )

  // And the refusal the application raises for the same row names the same setting, so an operator
  // reading the error is told the one thing that unblocks them.
  assert.ok(
    readFileSync(REFUND_SERVICE, 'utf8').includes(escape![1]),
    `retrySalesOrderRefundAccounting's refusal must name ${escape![1]}`,
  )
})
