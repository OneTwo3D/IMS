import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// ---------------------------------------------------------------------------
// o3d-9kek r4 finding 4 — the migration dropped the old guard before the replacement was durable.
//
// The first revision ran DROP INDEX "purchase_invoices_accounting_invoice_id_key" and THEN CREATE
// UNIQUE INDEX for the (id, provenance) pair, with no BEGIN/COMMIT. Prisma 7.8's runner does not
// auto-wrap a migration — this repo already documents that in
// 20260721150000_refund_park_unique_index — so an interrupted deploy, or a CREATE that failed on a
// pre-existing duplicate, left the database with NEITHER uniqueness invariant while the application
// kept writing bill ids. That window is exactly the two-bills-one-ledger-document corruption both
// indexes exist to forbid.
//
// Nothing here can execute against Postgres, so the ORDER and the transaction boundaries are
// asserted against the statement stream with comments stripped — comments in this file legitimately
// contain the words CREATE INDEX and DROP INDEX, and matching them would make this test pass for the
// wrong reason.
// ---------------------------------------------------------------------------

const MIGRATION = 'prisma/migrations/20260816090000_backreference_namespace_and_evidence_lifecycle/migration.sql'

/** The executable statements only — every `--` comment removed. */
function statements(): string {
  return readFileSync(MIGRATION, 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
}

test('[o3d-9kek r4 f4] the namespace migration runs in ONE explicit transaction', () => {
  const sql = statements()
  // Prisma 7.8 does not wrap this for us, so the file has to do it itself or the multi-statement
  // atomicity is imaginary.
  assert.match(sql, /^\s*BEGIN;/m)
  assert.match(sql, /COMMIT;\s*$/)
  assert.equal((sql.match(/\bBEGIN;/g) ?? []).length, 1, 'one transaction, not several')
  assert.equal((sql.match(/\bCOMMIT;/g) ?? []).length, 1)

  // Every statement that changes an invariant must be inside it.
  const begin = sql.indexOf('BEGIN;')
  const commit = sql.lastIndexOf('COMMIT;')
  for (const match of sql.matchAll(/^\s*(ALTER TABLE|CREATE (UNIQUE )?INDEX|DROP INDEX)/gm)) {
    assert.ok(match.index! > begin && match.index! < commit, `statement outside the transaction: ${match[0].trim()}`)
  }
})

test('[o3d-9kek r4 f4] the replacement bill index is CREATED before the old one is dropped', () => {
  const sql = statements()
  const created = sql.indexOf('CREATE UNIQUE INDEX "purchase_invoices_accounting_invoice_id_provenance_key"')
  const dropped = sql.indexOf('DROP INDEX "purchase_invoices_accounting_invoice_id_key"')
  assert.ok(created > 0 && dropped > 0, 'both statements must still exist')
  // The old global index implies pair-uniqueness for the sentinel-backfilled population, so it can
  // stay in place while the compound one is built underneath it. Nothing requires dropping it first,
  // and doing so is what created a moment with no uniqueness at all.
  assert.ok(created < dropped, 'the compound index must exist before the global one is removed')

  // Deliberately NOT concurrent: CREATE INDEX CONCURRENTLY cannot run inside a transaction, which
  // would give back exactly the atomicity this migration was fixed to have.
  assert.doesNotMatch(sql, /CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY/i)
})

test('[o3d-9kek r4 f4] the ACCESS EXCLUSIVE lock that excludes writers is taken first', () => {
  const sql = statements()
  // ALTER TABLE ... ADD COLUMN takes ACCESS EXCLUSIVE on purchase_invoices and holds it to COMMIT,
  // so concurrent writers cannot slip a duplicate in between the create and the drop. That only
  // holds if it comes FIRST.
  const altered = sql.indexOf('ALTER TABLE "purchase_invoices"')
  const created = sql.indexOf('CREATE UNIQUE INDEX "purchase_invoices_accounting_invoice_id_provenance_key"')
  assert.ok(altered > 0 && altered < created)
})
