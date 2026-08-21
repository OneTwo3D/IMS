// o3d-clxw round 4 — THE WRITING END OF THE REVERSAL FENCE.
//
// The payment poller decides whether a supplier payment was REMOVED by asking whether the
// registration IMS holds had already posted when the Xero snapshot was taken. Round 3 answered that
// by comparing `AccountingSyncLog.syncedAt` — `new Date()` on whichever app instance ran the sync
// processor — against `new Date()` on whichever instance ran the poll. Two machines, two free-running
// clocks, and one of the two skew directions clears `paidAt` over a payment that is still in flight,
// which re-arms Mark Paid and pays the supplier twice.
//
// The comparison now happens between two readings of ONE clock: the database's. These tests pin the
// writing end — that the stamp comes from the database, from the right function, and that no SYNCED
// write in the Xero sync processor can quietly go back to stamping a host clock.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { stampSyncedAtFromDatabaseClock } from '@/lib/connectors/xero/synced-at-clock'

type Captured = { sql: string; values: unknown[] }

function captureStatement(): { tx: Parameters<typeof stampSyncedAtFromDatabaseClock>[0]; issued: Captured[] } {
  const issued: Captured[] = []
  const tx = {
    $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      issued.push({ sql: strings.join('?'), values })
      return Promise.resolve(1)
    },
  } as unknown as Parameters<typeof stampSyncedAtFromDatabaseClock>[0]
  return { tx, issued }
}

test('the registration completion stamp is read from the DATABASE clock, at statement time', async () => {
  const { tx, issued } = captureStatement()

  await stampSyncedAtFromDatabaseClock(tx, 'log_1')

  assert.equal(issued.length, 1)
  const { sql, values } = issued[0]!
  assert.match(sql, /UPDATE accounting_sync_logs/)
  assert.match(sql, /clock_timestamp\(\)/,
    'the stamp must come from the database, not from any application host')
  assert.match(sql, /"syncedAt"\s*=\s*(clock_timestamp\(\)|[A-Za-z0-9_]+\.[A-Za-z0-9_]+)/,
    'syncedAt is assigned from the database clock — directly, or from the single reading of it this '
    + 'statement takes so both columns get the same instant (round 5) — never from a bound value')
  assert.doesNotMatch(sql, /=\s*now\(\)/,
    "now() is TRANSACTION-START time: it can report an instant before the payment this row's POST created")
  assert.match(sql, /AT TIME ZONE 'UTC'/,
    'the column is TIMESTAMP WITHOUT TIME ZONE and Prisma reads it back as UTC, so the cast must be explicit')
  assert.deepEqual(values, ['log_1'], 'the row id is bound, never interpolated into the statement')
})

test('the stamp writes BOTH columns from ONE reading of the clock (o3d-clxw r5, finding 1)', async () => {
  // The provenance marker is the two columns holding the SAME instant, so a build that writes
  // `syncedAt` without knowing about the marker is visible as one. Two calls to `clock_timestamp()`
  // in one statement return two different instants — the equality would never hold, and EVERY
  // registration this process stamps would read as undecidable to the reversal fence. A total,
  // silent loss of the reversal path, from a statement that looks correct.
  const { tx, issued } = captureStatement()

  await stampSyncedAtFromDatabaseClock(tx, 'log_1')

  const { sql } = issued[0]!
  assert.match(sql, /"syncedAtDatabaseClock"\s*=/,
    'without the marker the row cannot say which clock produced its completion time')
  assert.equal((sql.match(/clock_timestamp\(\)/g) ?? []).length, 1,
    'clock_timestamp() is evaluated PER CALL: a second call means the two columns can never be equal')
  const assignments = [...sql.matchAll(/"(syncedAt|syncedAtDatabaseClock)"\s*=\s*([A-Za-z0-9_.]+)/g)]
  assert.equal(assignments.length, 2)
  assert.equal(assignments[0]![2], assignments[1]![2],
    'both columns must be assigned the SAME single reading, not two expressions that happen to agree')
})

test('every SYNCED write in the Xero sync processor stamps from the database clock (o3d-clxw r4)', () => {
  // A source invariant rather than a behavioural one on purpose: the defect is a write site that
  // FORGETS the stamp, and a new one can be added at any time. Four sites exist today, all inside the
  // transaction that sets the status, and each of them is where a host clock used to be written.
  const source = readFileSync(
    path.join(process.cwd(), 'lib/connectors/xero/sync-processor.ts'),
    'utf8',
  )
  const marker = "status: 'SYNCED',"
  const sites = source.split(marker).slice(1)
  assert.equal(sites.length, 4, 'the number of SYNCED write sites changed — check each one still stamps')

  for (const [index, tail] of sites.entries()) {
    const window = tail.split('\n').slice(0, 30).join('\n')
    assert.match(window, /await stampSyncedAtFromDatabaseClock\(tx, entry\.id\)/,
      `SYNCED write site ${index + 1} does not stamp syncedAt from the database clock; the payment `
      + `poller's reversal fence would be comparing this host's wall clock against the poll host's`)
  }
})

// ---------------------------------------------------------------------------
// o3d-clxw ROUND 6 — EQUALITY IS NOT PROOF UNLESS THE DATABASE ENFORCES IT (Codex finding 1)
//
// Round 5 accepted a completion time when `syncedAt` and `syncedAtDatabaseClock` hold the same stored
// millisecond, on the ground that only the stamping statement can produce that pair. It is not: the
// column is TIMESTAMP(3), so any writer landing on the same millisecond satisfies the equality, and
// the previous release's completion write is a read-modify-write that can carry the database's own
// stamp forward onto a registration that finished later. A laundered pair is bit-identical to a
// minted one, so no reader can tell them apart — the rule has to run at WRITE time, and it has to
// bind writers this repository does not contain. That is a trigger, for the same reason o3d-9tbz put
// the release-receipt rule on one.
// ---------------------------------------------------------------------------

const STAMP_MIGRATION = path.join(
  process.cwd(),
  'prisma/migrations/20260821090000_accounting_sync_log_synced_at_database_clock/migration.sql',
)

/** The migration with its comment lines removed, so a rule can never be "asserted" from prose. */
function stampMigrationStatements(): string {
  return readFileSync(STAMP_MIGRATION, 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
}

/** The UPDATE trigger's firing condition, read out of the migration itself. */
function updateTriggerWhen(): string {
  const sql = stampMigrationStatements()
  const start = sql.indexOf('CREATE TRIGGER accounting_sync_log_stamp_provenance_update')
  assert.ok(start >= 0, 'the UPDATE trigger is what makes the marker mean anything')
  const end = sql.indexOf('EXECUTE FUNCTION', start)
  assert.ok(end > start, 'the trigger has to be wired to the function that clears the marker')
  return sql.slice(start, end)
}

/**
 * The columns the trigger treats as this row's completion facts — parsed from the migration, not
 * restated here. A model of a rule that is written down twice is a model that can drift; read from
 * the SQL, deleting the trigger deletes the model with it and every test below fails.
 */
function guardedColumns(): string[] {
  const columns = [...updateTriggerWhen().matchAll(/NEW\."(\w+)" IS DISTINCT FROM OLD\."(\w+)"/g)]
    .filter(([, left, right]) => left === right)
    .map(([, column]) => column!)
  assert.ok(columns.length > 0, 'a trigger that guards no column clears nothing')
  return columns
}

type SyncLogRow = Record<string, unknown> & { syncedAtDatabaseClock: Date | null }

const sameValue = (a: unknown, b: unknown): boolean =>
  (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b)

/**
 * What the row looks like after `write` lands on it IN THE DATABASE — i.e. with the trigger applied.
 *
 * A model of the SQL, pinned to the SQL: the guarded column list is read out of the migration, and
 * the rest of the rule ("the marker survives only a statement that assigns it") is asserted textually
 * beside these tests. Postgres is not available to this suite, and the rule cannot be exercised any
 * other way.
 */
function underTheTrigger(before: SyncLogRow, write: Record<string, unknown>): SyncLogRow {
  const next = { ...before, ...write } as SyncLogRow
  // The statement assigned a marker of its own — that is the stamp, and the stamp is exempt.
  if (!sameValue(next.syncedAtDatabaseClock, before.syncedAtDatabaseClock)) return next
  const touched = guardedColumns().some((column) => !sameValue(next[column], before[column]))
  return touched ? { ...next, syncedAtDatabaseClock: null } : next
}

test('an old build landing on the SAME MILLISECOND still cannot leave the marker vouching for it (r6)', async () => {
  const { databaseStampedCompletion } = await import('@/lib/connectors/xero/invoice-delta')
  const stamped = new Date('2026-08-21T10:00:00.123Z')

  // The database stamps the registration: both columns, one reading of clock_timestamp().
  const minted: SyncLogRow = {
    status: 'SYNCED',
    externalTransactionId: 'PAY-OURS-1',
    processingStartedAt: null,
    syncedAt: stamped,
    syncedAtDatabaseClock: stamped,
  }
  assert.deepEqual(databaseStampedCompletion(minted as never), stamped,
    'the pair the stamp writes is the one the fence is allowed to order against')

  // Now a worker still on the PREVIOUS release re-syncs this row. It claims it first — no re-sync
  // reaches a POST without claiming — and then writes the completion back from its own host clock.
  const claimed = underTheTrigger(minted, { status: 'PROCESSING', processingStartedAt: new Date('2026-08-21T10:04:00.000Z') })
  // THE VALUE IT WRITES IS EXACTLY THE MILLISECOND THE DATABASE HAD STAMPED — the coincidence round 5
  // assumed impossible, and the one an old read-modify-write does not even need luck to produce. The
  // registration it is recording actually completed four minutes later.
  const rewritten = underTheTrigger(claimed, {
    status: 'SYNCED',
    syncedAt: new Date(stamped.getTime()),
    externalTransactionId: 'PAY-OURS-1',
    processingStartedAt: null,
  })

  assert.equal((rewritten.syncedAt as Date).getTime(), stamped.getTime(),
    'the completion time in the row is bit-identical to the database stamp — that is the whole problem')
  assert.equal(rewritten.syncedAtDatabaseClock, null,
    'and the database has taken the provenance away, because of what the write TOUCHED')
  assert.equal(databaseStampedCompletion(rewritten as never), null,
    'so the row decides nothing: the reversal is withheld instead of clearing paidAt over a payment '
    + 'that may still be in flight')

  // What the same row reads as WITHOUT the rule, which is the finding: two equal timestamps, a
  // decidable registration, and a fence ordered against a host clock nobody can identify.
  const laundered = { ...rewritten, syncedAtDatabaseClock: stamped }
  assert.deepEqual(databaseStampedCompletion(laundered as never), stamped,
    'equality alone is satisfied by the old build; it is the trigger that makes it mean something')
})

test('the trigger leaves rows alone when the write records no completion (r6)', () => {
  // The scoping is not tidiness. `releaseFollowUpObligation` updates the row moments after the stamp,
  // and a rule of "any update clears the marker" would therefore make EVERY registration in the
  // system undecidable — the reversal verdict withheld for ever, and nothing anywhere saying so.
  // Safe-direction breakage is still breakage when it is total and silent.
  const stamped = new Date('2026-08-21T10:00:00.123Z')
  const minted: SyncLogRow = {
    status: 'SYNCED',
    externalTransactionId: 'PAY-OURS-1',
    processingStartedAt: null,
    syncedAt: stamped,
    syncedAtDatabaseClock: stamped,
    backReferenceFollowUpsPendingAt: new Date('2026-08-21T09:59:00.000Z'),
  }

  const released = underTheTrigger(minted, { backReferenceFollowUpsPendingAt: null })

  assert.deepEqual(released.syncedAtDatabaseClock, stamped,
    'the follow-up obligation is not a completion fact, and clearing it says nothing about the stamp')
  assert.deepEqual(
    underTheTrigger(minted, { status: 'SYNCED', errorMessage: null }).syncedAtDatabaseClock,
    stamped,
    'a write that re-states the same status changes nothing for the marker to answer for')
})

test('the stamping statement is exempt, and only because it assigns the marker itself (r6)', () => {
  const stamped = new Date('2026-08-21T10:00:00.123Z')
  const claimed: SyncLogRow = {
    status: 'PROCESSING',
    externalTransactionId: null,
    processingStartedAt: new Date('2026-08-21T09:59:00.000Z'),
    syncedAt: null,
    syncedAtDatabaseClock: null,
  }

  // The processor's two statements, in the order the transaction runs them.
  const synced = underTheTrigger(claimed, {
    status: 'SYNCED', externalTransactionId: 'PAY-OURS-1', syncedAt: new Date('2026-08-21T09:00:00.000Z'), processingStartedAt: null,
  })
  assert.equal(synced.syncedAtDatabaseClock, null, 'the Prisma write carries no marker, so it leaves none')

  const finished = underTheTrigger(synced, { syncedAt: stamped, syncedAtDatabaseClock: stamped })
  assert.deepEqual(finished.syncedAtDatabaseClock, stamped,
    'the stamp assigns the marker in the same statement, so the trigger does not fire on it — which '
    + 'is why the stamp must run LAST of the two')
})

test('the provenance rule is a DATABASE trigger, and it arrives with the column it guards (r6)', () => {
  const sql = stampMigrationStatements()

  assert.match(sql, /ALTER TABLE "accounting_sync_logs" ADD COLUMN "syncedAtDatabaseClock"/,
    'the rule lives in the SAME migration as the column: there is no ordering in which a database has '
    + 'the marker and not the rule that makes it mean anything')
  assert.match(sql, /CREATE OR REPLACE FUNCTION accounting_sync_log_clear_stamp_provenance\(\)/)
  assert.match(sql, /NEW\."syncedAtDatabaseClock" := NULL/,
    'the only thing the rule may do is take provenance away — it can never create it')

  const update = updateTriggerWhen()
  assert.match(update, /BEFORE UPDATE ON "accounting_sync_logs"\s*\nFOR EACH ROW/,
    'BEFORE, because the value has to be changed on the way in rather than reported afterwards')
  assert.match(update, /NEW\."syncedAtDatabaseClock" IS NOT DISTINCT FROM OLD\."syncedAtDatabaseClock"/,
    'a statement that assigns the marker itself is the stamp; everything else is a foreign write')
  assert.deepEqual(guardedColumns().sort(), ['externalTransactionId', 'processingStartedAt', 'status', 'syncedAt'],
    'the completion facts the marker vouches for — the old build cannot record a completion without '
    + 'touching one of them, and its claim alone already touches two')

  const insert = sql.slice(sql.indexOf('CREATE TRIGGER accounting_sync_log_stamp_provenance_insert'))
  assert.match(insert, /BEFORE INSERT ON "accounting_sync_logs"/,
    'nothing creates an already-stamped row, so a marker arriving with an INSERT came from a copy, a '
    + 'seed or a restore — none of which is this database minting a completion time')
  assert.match(insert, /WHEN \(NEW\."syncedAtDatabaseClock" IS NOT NULL\)/,
    'and the ordinary insert of a PENDING queue row pays one NULL test')
})

test('the stamp is the LAST statement of the SYNCED transaction, or it erases itself (r6)', () => {
  // With the trigger in place the order of the two statements is load-bearing: the Prisma write
  // changes the status without carrying a marker, so it trips the trigger; the stamp then mints the
  // new pair. Reversed, the transaction would clear the marker it had just written and every
  // registration would be undecidable.
  const source = readFileSync(path.join(process.cwd(), 'lib/connectors/xero/sync-processor.ts'), 'utf8')
  const sites = source.split("status: 'SYNCED',").slice(1)
  assert.equal(sites.length, 4, 'the number of SYNCED write sites changed — check each one still stamps LAST')

  for (const [index, tail] of sites.entries()) {
    const window = tail.split('\n').slice(0, 30).join('\n')
    const stamp = window.indexOf('await stampSyncedAtFromDatabaseClock(tx, entry.id)')
    const closesPrismaWrite = window.indexOf('})')
    assert.ok(stamp > closesPrismaWrite && closesPrismaWrite >= 0,
      `SYNCED write site ${index + 1} stamps before its own status write, which the trigger would `
      + `then clear — the registration would never be decidable`)
  }
})
