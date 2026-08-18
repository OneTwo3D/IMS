import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// ---------------------------------------------------------------------------
// o3d-9kek r4 finding 4 — this migration must run in ONE explicit transaction.
//
// Prisma 7.8's runner does NOT auto-wrap a migration file (this repo already documents that in
// 20260721150000_refund_park_unique_index), so a multi-statement migration that changes an invariant
// can be interrupted half-applied. The file currently holds a single ADD COLUMN and would be atomic
// either way; the BEGIN/COMMIT is what makes that still true the moment a second statement is added,
// which is exactly when nobody would think to check.
//
// Nothing here can execute against Postgres, so the boundaries are asserted against the statement
// stream with comments stripped — the comments in the migration legitimately contain the words
// CREATE INDEX and DROP INDEX (they explain the reverted namespace design), and matching those would
// make this test pass, or fail, for the wrong reason.
// ---------------------------------------------------------------------------

const MIGRATION = 'prisma/migrations/20260816090000_backreference_evidence_lifecycle/migration.sql'

/** The executable statements only — every `--` comment removed. */
function statements(): string {
  return readFileSync(MIGRATION, 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
}

test('[o3d-9kek r4 f4] the evidence-lifecycle migration runs in ONE explicit transaction', () => {
  const sql = statements()
  assert.match(sql, /^\s*BEGIN;/m)
  assert.match(sql, /COMMIT;\s*$/)
  assert.equal((sql.match(/\bBEGIN;/g) ?? []).length, 1, 'one transaction, not several')
  assert.equal((sql.match(/\bCOMMIT;/g) ?? []).length, 1)

  // Every statement that changes the schema must be inside it.
  const begin = sql.indexOf('BEGIN;')
  const commit = sql.lastIndexOf('COMMIT;')
  const changes = [...sql.matchAll(/^\s*(ALTER TABLE|CREATE (UNIQUE )?INDEX|DROP INDEX)/gm)]
  assert.ok(changes.length > 0, 'a migration that changes nothing would make this test vacuous')
  for (const match of changes) {
    assert.ok(match.index! > begin && match.index! < commit, `statement outside the transaction: ${match[0].trim()}`)
  }
})

test('[o3d-9kek] the reverted realm namespace is NOT reintroduced by this migration', () => {
  // The compound (accounting_invoice_id, accounting_invoice_provenance) index and the sync-row
  // provenance column were implemented here and REVERTED: namespacing an external id per connection
  // lets two local bills hold one integer, and ~190 call sites read a naked accountingInvoiceId on
  // models that have no provenance column at all. The global index from 20260815140000 stands
  // instead, so a realm collision is a refused write rather than a confusable pair. o3d-gt8r.
  //
  // A re-merge of the reverted branch would silently restore it, and nothing else in the suite would
  // notice — the schema and the code would simply agree again, wrongly.
  const sql = statements()
  assert.doesNotMatch(sql, /accounting_invoice_provenance/)
  assert.doesNotMatch(sql, /DROP INDEX "purchase_invoices_accounting_invoice_id_key"/)
  assert.doesNotMatch(sql, /ALTER TABLE "accounting_sync_logs" ADD COLUMN "provenance"/)
})
