#!/usr/bin/env node

import { execFileSync } from 'node:child_process'

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

const SCHEMA_SCOPE_MARKER = 'prisma-schema-scope-ok:'
// Exact lowercase SQL line comments only. DB-native migrations must explain
// why Prisma cannot model the change; block comments and short markers fail.
const SCHEMA_INVISIBLE_MIGRATION_RE = /^--[ \t]*prisma-schema-scope-ok:[ \t]*(db-native\b.{20,})$/m

function readFileAtRef(ref, file) {
  return git(['show', `${ref}:${file}`])
}

function schemaInvisibleMigrationReason(file, headRef) {
  const source = readFileAtRef(headRef, file)
  const markerLines = source
    .split(/\r?\n/)
    .filter((line) => line.includes(SCHEMA_SCOPE_MARKER))

  if (markerLines.length > 0 && !markerLines.some((line) => SCHEMA_INVISIBLE_MIGRATION_RE.test(line))) {
    return {
      reason: null,
      error: 'schema-scope marker must be an exact lowercase SQL line comment whose rationale starts with `db-native` and explains the Prisma limitation',
    }
  }

  const match = source.match(SCHEMA_INVISIBLE_MIGRATION_RE)
  return { reason: match?.[1]?.trim() ?? null, error: null }
}

const baseRef =
  process.argv[2]
  ?? process.env.SCHEMA_CHECK_BASE_REF
  ?? (process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : null)
const headRef = process.argv[3] ?? process.env.SCHEMA_CHECK_HEAD_REF ?? 'HEAD'

if (!baseRef) {
  console.log('No base ref provided; skipping migration/schema scope check.')
  process.exit(0)
}

let mergeBase
try {
  mergeBase = git(['merge-base', baseRef, headRef])
} catch (error) {
  fail(`Unable to compute merge-base between ${baseRef} and ${headRef}: ${error instanceof Error ? error.message : String(error)}`)
}

const changedFiles = git(['diff', '--name-only', '--diff-filter=ACMR', mergeBase, headRef])
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)

const migrationFiles = changedFiles.filter((file) => file.startsWith('prisma/migrations/'))
const schemaChanged = changedFiles.includes('prisma/schema.prisma')

if (migrationFiles.length > 0 && !schemaChanged) {
  const migrationFileReasons = migrationFiles
    .filter((file) => file.endsWith('/migration.sql'))
    .map((file) => {
      const result = schemaInvisibleMigrationReason(file, headRef)
      return {
        file,
        reason: result.reason,
        error: result.error,
      }
    })
  const uncheckedMigrationFiles = migrationFileReasons.filter((entry) => entry.reason === null)
  const accepted = migrationFileReasons.filter((entry) => entry.reason !== null)

  if (uncheckedMigrationFiles.length > 0) {
    const details = uncheckedMigrationFiles.flatMap((entry) => [
      `- ${entry.file}`,
      ...(entry.error ? [`  ${entry.error}`] : []),
    ])

    fail([
      'Schema guard failed: files under `prisma/migrations/` changed without a matching `prisma/schema.prisma` update.',
      'Every schema-visible migration-bearing PR must keep the Prisma schema in sync with the actual database changes.',
      'For DB-native features Prisma cannot model, add a migration comment like:',
      '-- prisma-schema-scope-ok: db-native trigger | reason: Prisma schema cannot represent triggers or CHECK predicates with subqueries',
      '',
      'Changed migration SQL files without schema update or schema-invisible rationale:',
      ...details,
      '',
      'All changed migration files:',
      ...migrationFiles.map((file) => `- ${file}`),
    ].join('\n'))
  }

  for (const { file, reason } of accepted) {
    console.log(`Accepted schema-invisible migration ${file}: ${reason}`)
  }
}

console.log('Migration/schema scope check passed.')
