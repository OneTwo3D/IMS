import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test, { type TestContext } from 'node:test'

const SCRIPT = join(process.cwd(), 'scripts/check-prisma-schema-scope.mjs')

function createRepo(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'prisma-schema-scope-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  git(root, ['init'])
  git(root, ['config', 'user.name', 'Schema Scope Test'])
  git(root, ['config', 'user.email', 'schema-scope@example.test'])
  return root
}

function git(root: string, args: string[]) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

function writeFixture(root: string, filePath: string, source: string) {
  const fullPath = join(root, filePath)
  mkdirSync(dirname(fullPath), { recursive: true })
  writeFileSync(fullPath, source)
}

function commit(root: string, message: string) {
  git(root, ['add', '.'])
  git(root, ['commit', '-m', message])
}

function runGuard(root: string, base: string, head: string) {
  return spawnSync(process.execPath, [SCRIPT, base, head], {
    cwd: root,
    env: { ...process.env, NODE_OPTIONS: '' },
    encoding: 'utf8',
  })
}

test('schema scope guard rejects migration-only schema-visible changes', (t) => {
  const root = createRepo(t)
  writeFixture(root, 'prisma/schema.prisma', 'model Product { id String @id }\n')
  commit(root, 'base')
  const base = git(root, ['rev-parse', 'HEAD'])

  writeFixture(root, 'prisma/migrations/20260601000000_add_column/migration.sql', 'ALTER TABLE "Product" ADD COLUMN name text;\n')
  commit(root, 'add migration')

  const result = runGuard(root, base, 'HEAD')

  assert.equal(result.status, 1)
  assert.match(result.stderr, /changed without a matching `prisma\/schema\.prisma` update/)
  assert.match(result.stderr, /20260601000000_add_column\/migration\.sql/)
})

test('schema scope guard accepts migration-only DB-native changes with explicit rationale', (t) => {
  const root = createRepo(t)
  writeFixture(root, 'prisma/schema.prisma', 'model Product { id String @id }\n')
  commit(root, 'base')
  const base = git(root, ['rev-parse', 'HEAD'])

  writeFixture(root, 'prisma/migrations/20260601000000_add_trigger/migration.sql', [
    '-- prisma-schema-scope-ok: db-native trigger | reason: Prisma schema cannot represent this trigger',
    'CREATE TRIGGER example AFTER INSERT ON "Product" EXECUTE FUNCTION example();',
    '',
  ].join('\n'))
  commit(root, 'add migration')

  const result = runGuard(root, base, 'HEAD')

  assert.equal(result.status, 0)
  assert.match(result.stdout, /Accepted schema-invisible migration/)
  assert.match(result.stdout, /Migration\/schema scope check passed/)
})

test('schema scope guard rejects empty or short schema-invisible rationales', (t) => {
  const root = createRepo(t)
  writeFixture(root, 'prisma/schema.prisma', 'model Product { id String @id }\n')
  commit(root, 'base')
  const base = git(root, ['rev-parse', 'HEAD'])

  writeFixture(root, 'prisma/migrations/20260601000000_add_trigger/migration.sql', [
    '-- prisma-schema-scope-ok: x',
    'CREATE TRIGGER example AFTER INSERT ON "Product" EXECUTE FUNCTION example();',
    '',
  ].join('\n'))
  commit(root, 'add migration')

  const result = runGuard(root, base, 'HEAD')

  assert.equal(result.status, 1)
  assert.match(result.stderr, /rationale starts with `db-native`/)
})

test('schema scope guard rejects mixed marked and unmarked migration SQL', (t) => {
  const root = createRepo(t)
  writeFixture(root, 'prisma/schema.prisma', 'model Product { id String @id }\n')
  commit(root, 'base')
  const base = git(root, ['rev-parse', 'HEAD'])

  writeFixture(root, 'prisma/migrations/20260601000000_add_trigger/migration.sql', [
    '-- prisma-schema-scope-ok: db-native trigger | reason: Prisma schema cannot represent this trigger',
    'CREATE TRIGGER example AFTER INSERT ON "Product" EXECUTE FUNCTION example();',
    '',
  ].join('\n'))
  writeFixture(root, 'prisma/migrations/20260601010000_add_column/migration.sql', 'ALTER TABLE "Product" ADD COLUMN name text;\n')
  commit(root, 'add migrations')

  const result = runGuard(root, base, 'HEAD')

  assert.equal(result.status, 1)
  assert.match(result.stderr, /20260601010000_add_column\/migration\.sql/)
})

test('schema scope guard marker is case-sensitive and line-comment-only', (t) => {
  const root = createRepo(t)
  writeFixture(root, 'prisma/schema.prisma', 'model Product { id String @id }\n')
  commit(root, 'base')
  const base = git(root, ['rev-parse', 'HEAD'])

  writeFixture(root, 'prisma/migrations/20260601000000_add_trigger/migration.sql', [
    '/* prisma-schema-scope-ok: db-native trigger | reason: Prisma schema cannot represent this trigger */',
    '-- PRISMA-SCHEMA-SCOPE-OK: db-native trigger | reason: Prisma schema cannot represent this trigger',
    'CREATE TRIGGER example AFTER INSERT ON "Product" EXECUTE FUNCTION example();',
    '',
  ].join('\n'))
  commit(root, 'add migration')

  const result = runGuard(root, base, 'HEAD')

  assert.equal(result.status, 1)
  assert.match(result.stderr, /changed without a matching `prisma\/schema\.prisma` update/)
})

test('schema scope guard allows non-SQL notes in migration directories', (t) => {
  const root = createRepo(t)
  writeFixture(root, 'prisma/schema.prisma', 'model Product { id String @id }\n')
  commit(root, 'base')
  const base = git(root, ['rev-parse', 'HEAD'])

  writeFixture(root, 'prisma/migrations/20260601000000_notes/README.md', 'Operational notes only.\n')
  commit(root, 'add migration notes')

  const result = runGuard(root, base, 'HEAD')

  assert.equal(result.status, 0)
  assert.match(result.stdout, /Migration\/schema scope check passed/)
})

test('schema scope guard reports the first valid marker when multiple markers exist', (t) => {
  const root = createRepo(t)
  writeFixture(root, 'prisma/schema.prisma', 'model Product { id String @id }\n')
  commit(root, 'base')
  const base = git(root, ['rev-parse', 'HEAD'])

  writeFixture(root, 'prisma/migrations/20260601000000_add_trigger/migration.sql', [
    '-- prisma-schema-scope-ok: db-native trigger | reason: Prisma schema cannot represent this trigger',
    '-- prisma-schema-scope-ok: db-native check | reason: Prisma schema cannot represent this check',
    'CREATE TRIGGER example AFTER INSERT ON "Product" EXECUTE FUNCTION example();',
    '',
  ].join('\n'))
  commit(root, 'add migration')

  const result = runGuard(root, base, 'HEAD')

  assert.equal(result.status, 0)
  assert.match(result.stdout, /db-native trigger/)
  assert.doesNotMatch(result.stdout, /db-native check/)
})

test('schema scope guard accepts migration changes with Prisma schema changes', (t) => {
  const root = createRepo(t)
  writeFixture(root, 'prisma/schema.prisma', 'model Product { id String @id }\n')
  commit(root, 'base')
  const base = git(root, ['rev-parse', 'HEAD'])

  writeFixture(root, 'prisma/schema.prisma', 'model Product { id String @id\n  name String? }\n')
  writeFixture(root, 'prisma/migrations/20260601000000_add_column/migration.sql', 'ALTER TABLE "Product" ADD COLUMN name text;\n')
  commit(root, 'add migration and schema')

  const result = runGuard(root, base, 'HEAD')

  assert.equal(result.status, 0)
  assert.match(result.stdout, /Migration\/schema scope check passed/)
})
