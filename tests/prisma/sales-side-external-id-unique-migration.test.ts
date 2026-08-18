import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// ---------------------------------------------------------------------------
// o3d-9kek r6 finding 3 — the sales-side external-id uniqueness migration.
//
// Three invariants, one file, and nothing here can execute against Postgres — so what is asserted is
// the statement stream, with `--` comments stripped. The comments legitimately contain the words
// CREATE UNIQUE INDEX and the reverted provenance design, and matching those would make this test
// pass, or fail, for the wrong reason.
//
// WHY THE TRANSACTION MATTERS HERE SPECIFICALLY. Prisma 7.8's runner does NOT wrap a migration file
// (documented in 20260721150000_refund_park_unique_index and 20260816090000). Three separate
// CREATE UNIQUE INDEX statements can therefore apply partially: the second failing on a duplicate
// leaves sales_orders constrained, sales_order_refunds constrained and supplier_credit_notes not —
// a half-enforced invariant, which is the state hardest to reason about afterwards.
// ---------------------------------------------------------------------------

const MIGRATION = 'prisma/migrations/20260816120000_sales_side_external_id_unique/migration.sql'

/** The executable statements only — every `--` comment removed. */
function statements(): string {
  return readFileSync(MIGRATION, 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
}

test('[o3d-9kek r6 f3] all three sales-side external-id indexes are created, and are UNIQUE', () => {
  const sql = statements()

  // Names follow Prisma's own `<table>_<column>_key` convention for a field-level @unique, which is
  // what keeps the drift check green without an allowlist entry.
  for (const [index, table, column] of [
    ['sales_orders_accounting_invoice_id_key', 'sales_orders', 'accounting_invoice_id'],
    ['sales_order_refunds_accounting_credit_note_id_key', 'sales_order_refunds', 'accounting_credit_note_id'],
    ['supplier_credit_notes_accounting_credit_note_id_key', 'supplier_credit_notes', 'accounting_credit_note_id'],
  ] as const) {
    const pattern = new RegExp(`CREATE UNIQUE INDEX "${index}"\\s*\n?\\s*ON "${table}"\\("${column}"\\);`)
    assert.match(sql, pattern, `${table}.${column} must be globally unique`)
  }

  // UNIQUE, not a plain index: a non-unique index would satisfy a naive "the index exists" check
  // while enforcing nothing at all.
  assert.equal((sql.match(/CREATE UNIQUE INDEX/g) ?? []).length, 3)
  assert.equal((sql.match(/CREATE INDEX/g) ?? []).length, 0)
})

test('[o3d-9kek r6 f3] the three indexes are created in ONE transaction', () => {
  const sql = statements()
  assert.match(sql, /^\s*BEGIN;/m)
  assert.match(sql, /COMMIT;\s*$/)
  assert.equal((sql.match(/\bBEGIN;/g) ?? []).length, 1, 'one transaction, not three')
  assert.equal((sql.match(/\bCOMMIT;/g) ?? []).length, 1)

  const begin = sql.indexOf('BEGIN;')
  const commit = sql.lastIndexOf('COMMIT;')
  const changes = [...sql.matchAll(/^\s*(ALTER TABLE|CREATE (UNIQUE )?INDEX|DROP INDEX)/gm)]
  assert.equal(changes.length, 3, 'a migration that changes nothing would make this test vacuous')
  for (const match of changes) {
    assert.ok(match.index! > begin && match.index! < commit, `statement outside the transaction: ${match[0].trim()}`)
  }

  // CONCURRENTLY is mutually exclusive with a transaction, and is deliberately not used: a UNIQUE
  // index built concurrently that meets a duplicate is left behind INVALID and must be dropped by
  // hand before the migration can be retried — the worst outcome for a constraint whose whole point
  // is to fail loudly and resolvably.
  assert.doesNotMatch(sql, /CONCURRENTLY/)
})

test('[o3d-9kek r6 f3] schema.prisma declares the same three constraints as the SQL', () => {
  // The SQL is what the database gets; schema.prisma is what Prisma's client and the drift check
  // believe. Disagreement is silent here (the drift check needs a live database, which this suite
  // has none of) and shows up as a P2002 nobody's types predicted, so the two are pinned together.
  const schema = readFileSync('prisma/schema.prisma', 'utf8')
  for (const line of [
    'accountingInvoiceId     String?    @unique @map("accounting_invoice_id")',
    'accountingCreditNoteId String?   @unique @map("accounting_credit_note_id")',
    'accountingCreditNoteId String?                 @unique @map("accounting_credit_note_id")',
  ]) {
    assert.ok(schema.includes(line), `schema.prisma must declare: ${line}`)
  }
  // The bill index from 20260815140000 is still there — this migration extends it, never replaces it.
  assert.ok(schema.includes('accountingInvoiceId String?  @unique @map("accounting_invoice_id")'))
})

test('[o3d-9kek r6 f3] the indexes are on the VALUE alone — the reverted namespace is not reintroduced', () => {
  // Pairing the id with the connection that issued it was implemented and reverted: it PERMITS the
  // collision, and these three models have no provenance column to disambiguate with even in
  // principle. A re-merge of that branch would silently restore the compound form and nothing else
  // in the suite would notice.
  const sql = statements()
  assert.doesNotMatch(sql, /provenance/)
  assert.doesNotMatch(sql, /,\s*"accounting_/, 'no compound index over a second column')
})
