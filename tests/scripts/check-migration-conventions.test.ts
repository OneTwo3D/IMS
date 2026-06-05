import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  analyzeMigrationSql,
  MIGRATION_PATTERNS,
  stripSqlCommentsAndLiterals,
} from '@/scripts/check-migration-conventions.mjs'

function messages(sql: string): string[] {
  return analyzeMigrationSql(sql).violations.map((violation) => `${violation.pattern}: ${violation.message}`)
}

function assertClean(sql: string) {
  const result = analyzeMigrationSql(sql)
  assert.deepEqual(result.markerErrors, [])
  assert.deepEqual(result.violations, [])
}

function assertDetects(sql: string, pattern: string) {
  assert.equal(
    analyzeMigrationSql(sql).violations.some((violation) => violation.pattern === pattern),
    true,
    `expected ${pattern} violation`,
  )
}

test('migration convention analyzer ignores comments and string literals', () => {
  assert.equal(
    stripSqlCommentsAndLiterals(`
      -- future RENAME COLUMN cutover
      COMMENT ON COLUMN "products"."name" IS 'DROP COLUMN documentation';
      ALTER TABLE "products" ADD COLUMN "newName" TEXT;
    `).includes('RENAME COLUMN'),
    false,
  )

  assertClean(`
    -- future RENAME COLUMN cutover
    COMMENT ON COLUMN "products"."name" IS 'DROP COLUMN documentation';
    ALTER TABLE "products" ADD COLUMN "newName" TEXT;
  `)
})

test('migration convention analyzer detects renames and drops', () => {
  assertDetects('ALTER TABLE "products" RENAME COLUMN "old" TO "new";', MIGRATION_PATTERNS.RENAME_COLUMN)
  assertDetects('ALTER TABLE "products" DROP COLUMN "old";', MIGRATION_PATTERNS.DROP_COLUMN)
})

test('migration convention analyzer checks each ADD COLUMN clause independently', () => {
  assertDetects(`
    ALTER TABLE "products"
      ADD COLUMN "unsafe" TEXT NOT NULL,
      ADD COLUMN "safe" TEXT NOT NULL DEFAULT '';
  `, MIGRATION_PATTERNS.ADD_COLUMN_NOT_NULL)

  assertClean(`
    ALTER TABLE "products"
      ADD COLUMN "safe" TEXT NOT NULL DEFAULT '',
      ADD COLUMN "alsoSafe" INTEGER;
  `)
})

test('migration convention analyzer tracks NOT VALID constraints by statement', () => {
  assertClean(`
    ALTER TABLE "stock_levels"
      ADD CONSTRAINT "stock-levels.qty.nonnegative" CHECK ("quantity" >= 0) NOT VALID;
    ALTER TABLE "stock_levels"
      VALIDATE CONSTRAINT "stock-levels.qty.nonnegative";
  `)

  const result = analyzeMigrationSql(`
    ALTER TABLE "stock_levels"
      ADD CONSTRAINT "stock_levels_quantity_nonnegative" CHECK ("quantity" >= 0);
    ALTER TABLE "stock_levels"
      ADD CONSTRAINT "stock_levels_reserved_nonnegative" CHECK ("reservedQty" >= 0) NOT VALID;
  `)
  assert.deepEqual(
    result.violations.map((violation) => violation.message),
    ['NOT VALID constraint stock_levels_reserved_nonnegative must be validated in the same migration or carry a marker that names the follow-up migration.'],
  )
})

test('migration convention markers suppress only the named pattern', () => {
  const result = analyzeMigrationSql(`
    -- migration-convention-ok: RENAME COLUMN because not-live tenant reset migration with reviewed checksum impact
    ALTER TABLE "products" RENAME COLUMN "old" TO "new";
    ALTER TABLE "products" ADD COLUMN "unsafe" TEXT NOT NULL;
  `)

  assert.deepEqual(result.markerErrors, [])
  assert.deepEqual(result.acceptedMarkers.map((marker) => marker.pattern), [MIGRATION_PATTERNS.RENAME_COLUMN])
  assert.deepEqual(result.violations.map((violation) => violation.pattern), [MIGRATION_PATTERNS.ADD_COLUMN_NOT_NULL])
})

test('migration convention markers require a pattern and specific rationale', () => {
  const invalidShape = analyzeMigrationSql('-- migration-convention-ok: lgtm')
  assert.match(invalidShape.markerErrors[0]?.message ?? '', /must name one pattern/)

  const shortRationale = analyzeMigrationSql('-- migration-convention-ok: DROP COLUMN because reviewed')
  assert.match(shortRationale.markerErrors[0]?.message ?? '', /too short/)
})

test('migration convention marker can document explicit NOT VALID follow-up validation', () => {
  const result = analyzeMigrationSql(`
    -- migration-convention-ok: NOT VALID because follow-up migration 20260606120000 validates after bounded production cleanup
    ALTER TABLE "stock_levels"
      ADD CONSTRAINT "stock_levels_quantity_nonnegative" CHECK ("quantity" >= 0) NOT VALID;
  `)

  assert.deepEqual(result.markerErrors, [])
  assert.deepEqual(result.violations, [])
})

test('migration convention analyzer keeps violation messages useful', () => {
  assert.match(
    messages('ALTER TABLE "products" ADD COLUMN "unsafe" TEXT NOT NULL;')[0] ?? '',
    /unsafe/,
  )
})
