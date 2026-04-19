#!/usr/bin/env node

import { execFileSync } from 'node:child_process'

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

function fail(message) {
  console.error(message)
  process.exit(1)
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
  fail([
    'Schema guard failed: files under `prisma/migrations/` changed without a matching `prisma/schema.prisma` update.',
    'Every migration-bearing PR must keep the Prisma schema in sync with the actual database changes.',
    '',
    'Changed migration files:',
    ...migrationFiles.map((file) => `- ${file}`),
  ].join('\n'))
}

console.log('Migration/schema scope check passed.')
