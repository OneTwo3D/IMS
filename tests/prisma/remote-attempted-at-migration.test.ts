import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * o3d-0m56 round 3 (Codex, critical) — the migration that adds `remoteAttemptedAt` must also STAMP
 * every money row that already exists.
 *
 * The column is what makes a row able to say "I have been sent before", and the posting guard only
 * demands ledger evidence when it is set. Leaving pre-existing rows NULL hands every one of them a
 * free first post: a PENDING row mid-retry, a stale PROCESSING row, or a historical FAILED row may
 * already have reached the ledger, and its first execution after deploy would claim the NULL stamp
 * and send again without asking. The duplicate this whole issue exists to stop, at rollout.
 *
 * Nothing here can execute against Postgres, so it is asserted against the statement stream with
 * comments stripped — the comments legitimately contain words like UPDATE and NULL.
 */

const MIGRATION = 'prisma/migrations/20260818090000_accounting_sync_remote_attempted_at/migration.sql'

/** The executable statements only — every `--` comment removed. */
function statements(): string {
  return readFileSync(MIGRATION, 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
}

test('the column is added and every existing money row is stamped (o3d-0m56)', () => {
  const sql = statements()
  assert.match(sql, /ALTER TABLE "accounting_sync_logs" ADD COLUMN "remoteAttemptedAt" TIMESTAMP\(3\);/)

  const update = sql.slice(sql.indexOf('UPDATE "accounting_sync_logs"'))
  assert.ok(update.length > 0, 'the backfill must exist at all')
  for (const type of ['INVOICE_PAYMENT', 'BILL_PAYMENT', 'PURCHASE_CREDIT_NOTE_ALLOCATION']) {
    assert.ok(update.includes(`'${type}'`), `${type} rows must be stamped, or they get a free first post`)
  }
  // Never now(): a row that may have been attempted months ago must not be recorded as attempted at
  // deploy time — the value feeds nothing but "has this been sent", and inventing one is a lie in
  // the audit trail.
  assert.match(update, /COALESCE\("syncedAt", "processingStartedAt", "createdAt"\)/)
  assert.ok(!/now\(\)|CURRENT_TIMESTAMP/i.test(update), 'the stamp must be the row\'s own best lower bound')

  // NULLABLE: "no remote call has been attempted from this row" has to remain expressible, or every
  // new row would look like a repeat and pay for a ledger read it does not need.
  assert.ok(!/ADD COLUMN "remoteAttemptedAt"[^;]*NOT NULL/.test(sql))
})

test('the column and its backfill are ONE transaction (o3d-0m56)', () => {
  // Prisma's runner does not wrap a migration file. Interrupted between the two statements, this
  // would leave the column added and every existing money row unstamped — a completed-looking
  // migration that has reintroduced the hole it was written to close.
  const sql = statements()
  assert.equal((sql.match(/\bBEGIN;/g) ?? []).length, 1)
  assert.equal((sql.match(/\bCOMMIT;/g) ?? []).length, 1)
  const begin = sql.indexOf('BEGIN;')
  const commit = sql.lastIndexOf('COMMIT;')
  for (const match of sql.matchAll(/^\s*(ALTER TABLE|UPDATE)/gm)) {
    assert.ok(match.index! > begin && match.index! < commit, `statement outside the transaction: ${match[0]}`)
  }
})

test('the schema keeps the column nullable and undefaulted (o3d-0m56)', () => {
  const schema = readFileSync('prisma/schema.prisma', 'utf8')
  const model = schema.slice(schema.indexOf('model AccountingSyncLog'))
  const field = model.slice(model.indexOf('remoteAttemptedAt'), model.indexOf('\n', model.indexOf('remoteAttemptedAt')))
  assert.match(field, /remoteAttemptedAt\s+DateTime\?/)
  assert.ok(!/@default|@updatedAt/.test(field),
    'it is claimed by an explicit conditional write, never by the database')
})
