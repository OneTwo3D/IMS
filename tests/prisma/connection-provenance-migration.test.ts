import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * o3d-dzip — the migration that gives the origin record a home retention cannot reach.
 *
 * Nothing here can execute against Postgres, so it is asserted against the statement stream with
 * comments stripped — the comments legitimately contain the words UPDATE, NULL, TRIGGER and BACKFILL.
 */

const MIGRATION = 'prisma/migrations/20260822090000_accounting_sync_log_connection_provenance/migration.sql'

/** The executable statements only — every `--` comment removed. */
function statements(file: string): string {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
}

test('o3d-dzip: the column is nullable, undefaulted and NEVER back-filled from the payload', () => {
  const sql = statements(MIGRATION)
  assert.match(sql, /ALTER TABLE "accounting_sync_logs" ADD COLUMN "connection_provenance" TEXT;/)
  assert.ok(!/ADD COLUMN "connection_provenance"[^;]*(NOT NULL|DEFAULT)/.test(sql))

  // THE CONSTRAINT o3d-s36z SET. `UPDATE ... SET connection_provenance = payload ->> '...'` is the
  // obvious one line and it is the database vouching for every historical stamp at once — promoting
  // values it did not witness into the column whose whole authority is that only the enqueue that
  // observed the connection can write it. A CLEARING backfill would be legitimate; a vouching one is
  // the defect wearing the fix's clothes.
  assert.ok(!/\bUPDATE\s+"?accounting_sync_logs"?/i.test(sql), 'the migration must write no row data at all')
  assert.ok(!/connection_provenance"?\s*=\s*[^;]*payload/i.test(sql))

  const schema = readFileSync('prisma/schema.prisma', 'utf8')
  const model = schema.slice(schema.indexOf('model AccountingSyncLog'))
  // The declaration, not the first mention of the name — the doc comment above it says the word too.
  const decl = model.match(/^\s*connectionProvenance\s+.*$/m)?.[0] ?? ''
  assert.match(decl, /connectionProvenance\s+String\?\s+@map\("connection_provenance"\)/)
  assert.ok(!/@default/.test(decl))
})

test('o3d-dzip: the rule ships in the SAME migration as the column, so no database can hold one without the other', () => {
  // The o3d-clxw property. If the trigger arrived in a later migration there would be a window in
  // which the column exists and anything may write it — and a value written in that window is
  // indistinguishable afterwards from one the enqueue minted.
  const sql = statements(MIGRATION)
  const column = sql.indexOf('ADD COLUMN "connection_provenance"')
  const trigger = sql.indexOf('CREATE TRIGGER accounting_sync_log_connection_provenance_update')
  assert.ok(column !== -1 && trigger !== -1, 'both must be in this file')
  assert.ok(column < trigger)
})

test('o3d-dzip: an UPDATE that changes the column CLEARS it — provenance is lost by what a writer touched', () => {
  const sql = statements(MIGRATION)
  const fn = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION accounting_sync_log_clear_connection_provenance'))
  // It can only ever NARROW: the function assigns NULL and nothing else, so no path through this
  // trigger can create provenance a writer did not supply.
  assert.match(fn, /NEW\."connection_provenance" := NULL;/)
  assert.ok(!/:=\s*OLD\./.test(fn.slice(0, fn.indexOf('$$;'))), 'it must not restore a value either')

  const trigger = sql.slice(sql.indexOf('CREATE TRIGGER accounting_sync_log_connection_provenance_update'))
  assert.match(trigger, /BEFORE UPDATE ON "accounting_sync_logs"/, 'the value is changed on its way in')
  assert.match(trigger, /FOR EACH ROW/)
  assert.match(trigger, /WHEN \(NEW\."connection_provenance" IS DISTINCT FROM OLD\."connection_provenance"\)/)
})

test('o3d-dzip: INSERT is left alone, because the INSERT is what mints an ORIGIN', () => {
  // The deliberate difference from the completion-stamp trigger (20260821090000), which refuses a
  // marker supplied by an INSERT. A completion time is stamped by an UPDATE, so one arriving with an
  // INSERT can only be a copy. An origin is established BY the INSERT — refusing it there would
  // refuse the only writer entitled to write it, and the column would always be null.
  const sql = statements(MIGRATION)
  assert.ok(!/BEFORE INSERT ON "accounting_sync_logs"/.test(sql))
})

test('o3d-dzip: retention still compacts the payload, and does not touch the column', () => {
  // The whole reason the column exists. `backReferenceEvidenceTombstone` is the one writer that
  // deliberately destroys the payload-side record; if it ever named this column the fix would be
  // undone by the very statement it was written for.
  const sweep = readFileSync('lib/domain/accounting/back-reference-sweep.ts', 'utf8')
  const tombstone = sweep.slice(sweep.indexOf('export function backReferenceEvidenceTombstone'))
  const body = tombstone.slice(0, tombstone.indexOf('\n}\n'))
  assert.match(body, /payload: \{\}/)
  assert.ok(!/connectionProvenance/.test(body), 'compaction must leave the durable record standing')
})
