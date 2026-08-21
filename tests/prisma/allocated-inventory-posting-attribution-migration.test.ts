import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import test from 'node:test'

// ---------------------------------------------------------------------------
// o3d-o97 r4 finding 1 — THE MIGRATION THAT MAKES THE RECORDS EXIST ON PRODUCTION.
//
// Round 3 added seven columns to schema.prisma and wrote no migration for any of them. That is not
// a missing file, it is a silent revert: `prisma migrate deploy` applies MIGRATIONS, not
// schema.prisma, so on production none of the columns exist, the drift check fails the deploy, and
// forced through, every read of them returns undefined — which every reader on this branch treats
// as "a row written before the column existed, fall back to the old inference". The durable records
// would degrade back into the absent ones they were written to replace, on the code path that
// credits a real ledger account.
//
// Nothing here executes against Postgres. What is asserted is the two-way parity — the model
// DECLARES the column and a migration CREATES it — plus the rollout shape of the concurrent index.
// `--` comments are stripped before matching, because the comments in these files legitimately
// contain the words ADD COLUMN and CREATE INDEX CONCURRENTLY and matching those would make this
// test pass for the wrong reason.
// ---------------------------------------------------------------------------

const SCHEMA = 'prisma/schema.prisma'
const MIGRATIONS_DIR = 'prisma/migrations'
const INDEX_MIGRATION = `${MIGRATIONS_DIR}/20260821090100_refund_allocation_basis_unresolved_index/migration.sql`
const VALIDATE_MIGRATION = `${MIGRATIONS_DIR}/20260821090200_refund_allocation_basis_unresolved_index_validate/migration.sql`

/** Every column o3d-o97 introduced, as (prisma model, table, column). */
const COLUMNS: Array<{ model: string; table: string; column: string }> = [
  { model: 'SalesOrder', table: 'sales_orders', column: 'accounting_allocation_batch_sync_log_id' },
  { model: 'SalesOrder', table: 'sales_orders', column: 'accounting_allocation_batch_connector' },
  { model: 'SalesOrder', table: 'sales_orders', column: 'accounting_allocation_batch_account_code' },
  { model: 'OrderAllocation', table: 'order_allocations', column: 'accounting_allocation_batch_amount' },
  { model: 'Shipment', table: 'shipments', column: 'accounting_allocated_relief_amount' },
  { model: 'Shipment', table: 'shipments', column: 'accounting_allocated_relief_sync_log_id' },
  { model: 'Shipment', table: 'shipments', column: 'accounting_allocated_relief_connector' },
  { model: 'Shipment', table: 'shipments', column: 'accounting_allocated_relief_account_code' },
  { model: 'SalesOrderRefund', table: 'sales_order_refunds', column: 'accounting_allocated_relief_amount' },
  { model: 'SalesOrderRefund', table: 'sales_order_refunds', column: 'accounting_allocation_basis_unresolved' },
]

/** The executable statements of every migration, `--` comments removed. */
function allMigrationSql(): string {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      try {
        return readFileSync(`${MIGRATIONS_DIR}/${entry.name}/migration.sql`, 'utf8')
      } catch {
        return ''
      }
    })
    .join('\n')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
}

function statements(file: string): string {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
}

/** The body of one `model X { ... }` block in schema.prisma. */
function modelBlock(model: string): string {
  const schema = readFileSync(SCHEMA, 'utf8')
  const start = schema.indexOf(`\nmodel ${model} {`)
  assert.notEqual(start, -1, `schema.prisma declares model ${model}`)
  const end = schema.indexOf('\n}\n', start)
  return schema.slice(start, end)
}

test('[o3d-o97 r4 f1] every column the schema declares for the allocated-inventory records is CREATED by a migration', () => {
  // The parity that was missing. A column present in schema.prisma and absent from every migration
  // is a column production does not have — and this branch's readers cannot tell that apart from a
  // legacy row, so it fails open into the exact inference the round exists to remove.
  const sql = allMigrationSql()
  for (const { model, table, column } of COLUMNS) {
    assert.match(
      modelBlock(model),
      new RegExp(`@map\\("${column}"\\)`),
      `${model} must declare ${column} — the list in this test is the contract, not a copy of it`,
    )
    assert.match(
      sql,
      new RegExp(`ALTER TABLE "${table}" ADD COLUMN "${column}"`),
      `no migration creates ${table}.${column}, so prisma migrate deploy would never add it`,
    )
  }
})

test('[o3d-o97 r4 f1] every one of those columns is nullable with no DEFAULT, so no historical row is backfilled', () => {
  // Nullable and defaultless is what makes the ALTER catalogue-only on PG11+ (no rewrite, no long
  // lock) AND what makes a legacy row say "not on record" instead of claiming a value. A DEFAULT
  // here would manufacture exactly the confidence these columns exist to stop being assumed, and it
  // would do it on the rows least entitled to it.
  const sql = allMigrationSql()
  for (const { table, column } of COLUMNS) {
    const clause = sql.match(new RegExp(`ALTER TABLE "${table}" ADD COLUMN "${column}"[^;]*;`))?.[0]
    assert.ok(clause, `${table}.${column} must be added by a single ALTER`)
    assert.doesNotMatch(clause, /\bNOT\s+NULL\b/i, `${column} must be nullable`)
    assert.doesNotMatch(clause, /\bDEFAULT\b/i, `${column} must carry no DEFAULT`)
  }
})

test('[o3d-o97 r4 f1] the refusal index is built CONCURRENTLY, partial, and alone in its file', () => {
  // sales_order_refunds grows with daily operations, so a plain CREATE INDEX would take a SHARE
  // lock and block every refund INSERT for the length of the build — on a money path, during a
  // deploy. CONCURRENTLY cannot run inside a transaction block, and Postgres wraps a multi-statement
  // simple-query string in an implicit one, so a second statement in this file would make the
  // migration fail outright with "cannot run inside a transaction block".
  const sql = statements(INDEX_MIGRATION)
  const parts = sql.split(';').map((part) => part.trim()).filter(Boolean)
  assert.equal(parts.length, 1, 'exactly one statement: CREATE INDEX CONCURRENTLY cannot share a transaction')
  assert.match(parts[0], /^CREATE INDEX CONCURRENTLY "sales_order_refunds_allocation_basis_unresolved_idx"/)
  assert.match(
    parts[0],
    /WHERE "accounting_allocation_basis_unresolved" IS NOT NULL/,
    'partial: the column is NULL on every refund that could account for its debit, so a plain index would be one dead entry per refund',
  )
  assert.doesNotMatch(
    sql,
    /IF NOT EXISTS/i,
    'IF NOT EXISTS would silently no-op against the INVALID index an interrupted concurrent build leaves behind, making that state permanent and invisible',
  )
  assert.doesNotMatch(sql, /\bBEGIN\b|\bCOMMIT\b/i)
})

test('[o3d-o97 r4 f1] a follow-up migration fails the deploy if that concurrent build did not complete', () => {
  // An interrupted concurrent build leaves the index behind marked INVALID: the planner refuses to
  // use it, so the invariant report goes back to scanning every refund ever issued, while every
  // refund write still pays to maintain it. Nothing about that is visible from the application, so
  // it is asserted at deploy time instead of hoped for.
  const sql = statements(VALIDATE_MIGRATION)
  assert.match(sql, /indisvalid/, 'the check must read pg_index, not merely that a relation exists')
  assert.match(sql, /RAISE EXCEPTION/)
  assert.match(sql, /sales_order_refunds_allocation_basis_unresolved_idx/)
  assert.match(
    sql,
    /DROP INDEX CONCURRENTLY IF EXISTS/,
    'and it must name the remediation, which itself must not take the lock the build avoided',
  )
  assert.doesNotMatch(sql, /CREATE\s+INDEX/i, 'this file asserts; it does not build')
})
