import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  analyzeMigrationSql,
  MIGRATION_PATTERNS,
  stripSqlCommentsAndLiterals,
} from '@/scripts/check-migration-conventions.mjs'

import { createTempDirSync } from './temp-dir.ts'

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

// ---- o3d-ok6hk: the BASE-RESOLUTION paths, run end to end against a throwaway git repo ---------------
// On a push to development the job used to compare origin/development with a HEAD that already was
// development: identical commits, zero files scanned, a vacuous pass. These run the real script as a
// subprocess for both event shapes, and for the vacuous shape, so a regression cannot pass by examining nothing.
const SCRIPT = join(process.cwd(), 'scripts/check-migration-conventions.mjs')

function repoWithMigration(t: import('node:test').TestContext, sql: string) {
  const dir = createTempDirSync('ims-migconv-', t)
  const g = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' }).trim()
  g('init', '-q', '-b', 'development')
  writeFileSync(join(dir, 'README'), 'x')
  g('add', '.')
  g('commit', '-q', '-m', 'base')
  const base = g('rev-parse', 'HEAD')
  mkdirSync(join(dir, 'prisma/migrations/20990101000000_x'), { recursive: true })
  writeFileSync(join(dir, 'prisma/migrations/20990101000000_x/migration.sql'), sql)
  g('add', '.')
  g('commit', '-q', '-m', 'migration')
  return { dir, base, head: g('rev-parse', 'HEAD'), g }
}

function run(dir: string, env: Record<string, string>) {
  const r = spawnSync('node', [SCRIPT], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: '/nonexistent', ...env } as unknown as NodeJS.ProcessEnv })
  return { status: r.status, out: `${r.stdout}${r.stderr}` }
}

const RISKY = 'ALTER TABLE "products" DROP COLUMN "old";\n'

test('migration conventions: PULL-REQUEST path (origin/<base> vs HEAD) rejects a risky migration', (t) => {
  const { dir, base, g } = repoWithMigration(t, RISKY)
  g('update-ref', 'refs/remotes/origin/development', base)
  const r = run(dir, { CI: 'true', GITHUB_BASE_REF: 'development' })
  assert.equal(r.status, 1, r.out)
  assert.match(r.out, /DROP COLUMN/)
})

test('migration conventions: PUSH path (event.before as base) rejects a risky migration, and prints what it examined', (t) => {
  const { dir, base, g } = repoWithMigration(t, RISKY)
  g('update-ref', 'refs/remotes/origin/development', g('rev-parse', 'HEAD')) // the trap: origin/development == HEAD
  const r = run(dir, { CI: 'true', MIGRATION_CONVENTION_BASE_REF: base })
  assert.equal(r.status, 1, r.out)
  assert.match(r.out, /DROP COLUMN/)
  const clean = repoWithMigration(t, 'ALTER TABLE "products" ADD COLUMN "n" TEXT;\n')
  const ok = run(clean.dir, { CI: 'true', MIGRATION_CONVENTION_BASE_REF: clean.base })
  assert.equal(ok.status, 0, ok.out)
  assert.match(ok.out, /\(1 migration file\(s\) examined/, 'the pass must say how many migration files it examined')
})

test('migration conventions: the VACUOUS shape (base == head) fails loudly in CI instead of passing', (t) => {
  const { dir, head, g } = repoWithMigration(t, RISKY)
  g('update-ref', 'refs/remotes/origin/development', head)
  const r = run(dir, { CI: 'true' }) // exactly what the push job did before: default base origin/development
  assert.equal(r.status, 1, r.out)
  assert.match(r.out, /comparison range .* is empty/)
})

test('migration conventions: an all-zero before SHA falls back to the parent commit; an unresolvable base fails', (t) => {
  const { dir } = repoWithMigration(t, RISKY)
  const zero = run(dir, { CI: 'true', MIGRATION_CONVENTION_BASE_REF: '0'.repeat(40) })
  assert.equal(zero.status, 1, zero.out)
  assert.match(zero.out, /DROP COLUMN/)
  const bad = run(dir, { CI: 'true', MIGRATION_CONVENTION_BASE_REF: 'deadbeef'.repeat(5) })
  assert.equal(bad.status, 1, bad.out)
  assert.match(bad.out, /Cannot resolve the comparison range|Unable to compute merge-base/)
})
