import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * o3d-jit6 — the migration that makes "a create for this row already left" a fact the database keeps.
 *
 * `remoteAttemptedAt` documents itself as set once and never cleared, and that promise is kept by
 * every writer remembering to keep it. This branch exists because a promise like that is broken by
 * the writer who has not heard of it — the previous release still deployed during a rollout, a repair
 * script resetting a stuck row, an operator in `psql` clearing the flags so a job will run again.
 *
 * Nothing here can execute against Postgres, so it is asserted against the statement stream with
 * comments stripped.
 */

const MIGRATION = 'prisma/migrations/20260822090100_accounting_sync_log_create_dispatch_record/migration.sql'

function statements(file: string): string {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
}

test('o3d-jit6: two nullable, undefaulted columns added by separate statements, and no back-fill', () => {
  const sql = statements(MIGRATION)
  assert.match(sql, /ALTER TABLE "accounting_sync_logs" ADD COLUMN "create_dispatched_at" TIMESTAMP\(3\);/)
  assert.match(sql, /ALTER TABLE "accounting_sync_logs" ADD COLUMN "create_dispatch_idempotency_key" TEXT;/)
  assert.ok(!/ADD COLUMN "create_dispatch(ed_at|_idempotency_key)"[^;]*(NOT NULL|DEFAULT)/.test(sql))

  // A back-fill would have to invent a dispatch instant for rows nobody watched dispatch — and every
  // one of them would then be outside the idempotency window and refuse for ever.
  assert.ok(!/\bUPDATE\s+"?accounting_sync_logs"?/i.test(sql), 'the migration must write no row data at all')

  const schema = readFileSync('prisma/schema.prisma', 'utf8')
  const model = schema.slice(schema.indexOf('model AccountingSyncLog'))
  assert.match(model.match(/^\s*createDispatchedAt\s+.*$/m)?.[0] ?? '', /DateTime\?\s+@map\("create_dispatched_at"\)/)
  assert.match(model.match(/^\s*createDispatchIdempotencyKey\s+.*$/m)?.[0] ?? '', /String\?\s+@map\("create_dispatch_idempotency_key"\)/)
})

test('o3d-jit6: the rule ships in the SAME migration as the columns', () => {
  const sql = statements(MIGRATION)
  const column = sql.indexOf('ADD COLUMN "create_dispatched_at"')
  const trigger = sql.indexOf('CREATE TRIGGER accounting_sync_log_create_dispatch_update')
  assert.ok(column !== -1 && trigger !== -1)
  assert.ok(column < trigger, 'no database may hold the columns without the rule that protects them')
})

test('o3d-jit6: the record is PRESERVED against tampering, not cleared — the direction is the safety', () => {
  // The mirror image of the completion-stamp trigger (20260821090000), and getting it the wrong way
  // round would hand a tamperer exactly what they wanted. That marker is a PERMISSION, so tampering
  // must clear it. This one is a PROHIBITION — while it stands, a create past the idempotency window
  // is refused — so tampering must NOT clear it.
  const sql = statements(MIGRATION)
  const fn = sql.slice(
    sql.indexOf('CREATE OR REPLACE FUNCTION accounting_sync_log_hold_create_dispatch'),
    sql.indexOf('$$;') + 3,
  )
  assert.match(fn, /NEW\."create_dispatched_at" := OLD\."create_dispatched_at";/)
  assert.match(fn, /NEW\."create_dispatch_idempotency_key" := OLD\."create_dispatch_idempotency_key";/)

  const trigger = sql.slice(sql.indexOf('CREATE TRIGGER accounting_sync_log_create_dispatch_update'))
  assert.match(trigger, /BEFORE UPDATE ON "accounting_sync_logs"/)
  assert.match(trigger, /FOR EACH ROW/)
  // The WHEN clause is what lets the DISPATCH ITSELF through: it writes onto a row whose OLD value is
  // null, so the trigger does not fire and the record is minted. Drop this guard and nothing could
  // ever record a dispatch at all — the fence would be permanently blind and permanently silent.
  assert.match(trigger, /OLD\."create_dispatched_at" IS NOT NULL/)
  // Both halves are watched, so the key can never end up describing a different dispatch than the
  // instant beside it.
  assert.match(trigger, /NEW\."create_dispatched_at" IS DISTINCT FROM OLD\."create_dispatched_at"/)
  assert.match(trigger, /NEW\."create_dispatch_idempotency_key" IS DISTINCT FROM OLD\."create_dispatch_idempotency_key"/)
})

test('o3d-jit6: a dispatch record arriving with an INSERT is refused', () => {
  // Nothing creates an already-dispatched row — the enqueue happens long before any wire — so a
  // record on an INSERT came from a copy, a seed or a restore, none of which is this database
  // watching a request leave.
  const sql = statements(MIGRATION)
  const trigger = sql.slice(
    sql.indexOf('CREATE TRIGGER accounting_sync_log_create_dispatch_insert'),
    sql.indexOf('DROP TRIGGER IF EXISTS accounting_sync_log_create_dispatch_update'),
  )
  assert.match(trigger, /BEFORE INSERT ON "accounting_sync_logs"/)
  assert.match(trigger, /WHEN \(NEW\."create_dispatched_at" IS NOT NULL OR NEW\."create_dispatch_idempotency_key" IS NOT NULL\)/)

  const fn = statements(MIGRATION)
  assert.match(fn, /IF TG_OP = 'INSERT' THEN\s*\n\s*NEW\."create_dispatched_at" := NULL;/)
})
