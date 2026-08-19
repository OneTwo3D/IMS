import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * o3d-0m56 round 10 (Codex HIGH x3) — the migration that replaces the round-9 epoch with a fact the
 * ROW carries.
 *
 * The premise `planFollowUpEnqueue` and `authoriseMoneyPost` rest on is that an unstamped money row
 * is proof no remote call ever left it. That is only true of a row nothing but a stamping binary has
 * handled, and round 9 tried to establish it with one global instant — which a clock skew, a cached
 * read and a ROLLBACK could each defeat from outside the row.
 *
 * `attemptStampingCustodyAt` is written by binaries that stamp and TAKEN AWAY by the database from
 * any row claimed by a binary that does not. The trigger is the load-bearing half: it is what a
 * rolled-back binary cannot route around, because it runs its own application code but not its own
 * database.
 *
 * Nothing here can execute against Postgres, so it is asserted against the statement stream with
 * comments stripped — the comments legitimately contain words like UPDATE, NULL and TRIGGER.
 */

const MIGRATION = 'prisma/migrations/20260819090000_accounting_sync_attempt_stamping_custody/migration.sql'
const INDEX_MIGRATION = 'prisma/migrations/20260819091000_accounting_sync_money_uncustodied_index/migration.sql'

/** The executable statements only — every `--` comment removed. */
function statements(file: string): string {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
}

test('the custody column is nullable and undefaulted, which is the whole rollback story (o3d-0m56 r10)', () => {
  const sql = statements(MIGRATION)
  assert.match(sql, /ALTER TABLE "accounting_sync_logs" ADD COLUMN "attemptStampingCustodyAt" TIMESTAMP\(3\);/)
  // A DEFAULT here would hand custody to every row an older binary inserts by omission — which is
  // exactly the population the column exists to identify.
  assert.ok(!/ADD COLUMN "attemptStampingCustodyAt"[^;]*(NOT NULL|DEFAULT)/.test(sql))

  const schema = readFileSync('prisma/schema.prisma', 'utf8')
  const model = schema.slice(schema.indexOf('model AccountingSyncLog'))
  const line = model.slice(model.indexOf('attemptStampingCustodyAt'))
  assert.match(line.slice(0, line.indexOf('\n')), /attemptStampingCustodyAt\s+DateTime\?/)
  assert.ok(!/@default|@updatedAt/.test(line.slice(0, line.indexOf('\n'))))
})

test('custody is granted only AFTER every money row is stamped (o3d-0m56 r10)', () => {
  // ORDER IS THE SAFETY. The blanket grant is sound only because the statement before it has
  // already stamped every money row that could still be hiding an attempt — including everything an
  // older binary created since 20260818090000 ran. Reversed, or interrupted between the two, this
  // migration would hand custody to rows nothing has vouched for.
  const sql = statements(MIGRATION)
  const backfill = sql.indexOf('SET "remoteAttemptedAt" = COALESCE')
  const grant = sql.indexOf('SET "attemptStampingCustodyAt" = "createdAt"')
  assert.ok(backfill !== -1 && grant !== -1, 'both statements must exist')
  assert.ok(backfill < grant, 'the money backfill must precede the custody grant')

  const stamping = sql.slice(backfill, grant)
  for (const type of ['INVOICE_PAYMENT', 'BILL_PAYMENT', 'PURCHASE_CREDIT_NOTE_ALLOCATION']) {
    assert.ok(stamping.includes(`'${type}'`), `${type} rows must be stamped before custody is granted`)
  }
  assert.match(stamping, /"remoteAttemptedAt" IS NULL/, 'a stamp claimed by a real call must never move')
  assert.ok(!/now\(\)|CURRENT_TIMESTAMP/i.test(stamping), 'the stamp is the row\'s own lower bound, never now()')
})

test('the whole migration is ONE transaction (o3d-0m56 r10)', () => {
  const sql = statements(MIGRATION)
  assert.equal((sql.match(/\bBEGIN;/g) ?? []).length, 1)
  assert.equal((sql.match(/\bCOMMIT;/g) ?? []).length, 1)
  const begin = sql.indexOf('BEGIN;')
  const commit = sql.lastIndexOf('COMMIT;')
  for (const match of sql.matchAll(/^\s*(ALTER TABLE|UPDATE|DELETE|CREATE TRIGGER|DROP TRIGGER)/gm)) {
    assert.ok(match.index! > begin && match.index! < commit, `statement outside the transaction: ${match[0]}`)
  }
})

test('a claim that does not re-assert custody FORFEITS it (o3d-0m56 r10)', () => {
  // FINDING 3, in the one place a rolled-back binary cannot route around. The trigger fires on an
  // UPDATE that starts a claim — moves `processingStartedAt` to a new non-null value, or moves the
  // row into PROCESSING — while leaving the custody column exactly as it was. Re-asserting means
  // writing a different value in the same statement, which `stampingCustodyOnClaim` does and a
  // binary without the column cannot.
  const sql = statements(MIGRATION)
  const trigger = sql.slice(sql.indexOf('CREATE TRIGGER accounting_sync_logs_forfeit_stamping_custody'))
  assert.ok(trigger.length > 0, 'the trigger must exist')

  assert.match(trigger, /BEFORE UPDATE ON "accounting_sync_logs"/, 'it must rewrite the row, not react after it')
  assert.match(trigger, /FOR EACH ROW/)
  assert.match(trigger, /NEW\."attemptStampingCustodyAt" IS DISTINCT FROM NEW\."processingStartedAt"/,
    'a claim re-asserts custody by writing it EQUAL to the claim instant — the pair stampingCustodyOnClaim returns')
  // Deliberately not "custody changed in this statement": that would forfeit custody whenever two
  // writes landed on the same millisecond. The test is a property of the statement, not of history.
  assert.ok(!trigger.includes('IS NOT DISTINCT FROM OLD."attemptStampingCustodyAt"'),
    'the forfeit must not depend on the previous custody value')
  assert.match(trigger, /NEW\."processingStartedAt" IS NOT NULL\s*\n?\s*AND NEW\."processingStartedAt" IS DISTINCT FROM OLD\."processingStartedAt"/,
    'a claim is a new non-null processingStartedAt')
  assert.match(trigger, /NEW\."status" = 'PROCESSING' AND OLD\."status" IS DISTINCT FROM NEW\."status"/,
    'and, belt and braces, any move into PROCESSING')

  const body = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION accounting_sync_logs_forfeit_stamping_custody'))
  assert.match(body.slice(0, body.indexOf('$$;')), /NEW\."attemptStampingCustodyAt" := NULL;/,
    'the forfeit is a NULL, which is the untrusted value everywhere else')
})

test('the round-9 settings epoch is deleted, not left behind (o3d-0m56 r10)', () => {
  // Nothing reads it any more and the runbook no longer mentions it. A key left in `settings` is a
  // thing a future operator can find, act on, and be misled by.
  assert.match(statements(MIGRATION),
    /DELETE FROM "settings" WHERE "key" = 'accounting\.money-attempt-stamping-since';/)
})

test('the repair\'s index is partial on the repair\'s own predicate, and concurrent (o3d-0m56 r10)', () => {
  // The repair runs at the top of EVERY sync run, which is what a rollback cannot get underneath.
  // That is only affordable because the indexed set is empty in steady state: every row is created
  // inside custody, so the index fills only after a deploy window, an overlap or a rollback.
  const sql = statements(INDEX_MIGRATION)
  assert.match(sql, /CREATE INDEX CONCURRENTLY IF NOT EXISTS "accounting_sync_logs_money_attempt_uncustodied_idx"/)
  assert.match(sql, /WHERE "remoteAttemptedAt" IS NULL AND "attemptStampingCustodyAt" IS NULL/)
  // CONCURRENTLY cannot run inside a transaction, so this must be its own file with no BEGIN.
  assert.ok(!/\bBEGIN;/.test(sql), 'a concurrent index must not be wrapped in a transaction')

  const repair = readFileSync('lib/domain/accounting/money-attempt-provenance.ts', 'utf8')
  for (const arm of ['"remoteAttemptedAt" IS NULL', '"attemptStampingCustodyAt" IS NULL']) {
    assert.ok(repair.includes(arm), `the repair must filter on ${arm}, or the partial index is dead weight`)
  }
})
