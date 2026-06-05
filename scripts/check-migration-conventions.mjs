#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const MIN_RATIONALE_LENGTH = 24

export const MIGRATION_PATTERNS = {
  RENAME_COLUMN: 'RENAME COLUMN',
  DROP_COLUMN: 'DROP COLUMN',
  ADD_COLUMN_NOT_NULL: 'ADD COLUMN NOT NULL',
  NOT_VALID: 'NOT VALID',
}

const ALLOWED_PATTERN_NAMES = new Set(Object.values(MIGRATION_PATTERNS))
const MARKER_PREFIX_RE = /^[ \t]*--[ \t]*migration-convention-ok:/i
const MARKER_RE = /^[ \t]*--[ \t]*migration-convention-ok:[ \t]*(RENAME COLUMN|DROP COLUMN|ADD COLUMN NOT NULL|NOT VALID)[ \t]+because[ \t]+(.+\S)[ \t]*$/i

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

function readFileAtRef(ref, file) {
  return git(['show', `${ref}:${file}`])
}

function changedFiles(baseRef, headRef) {
  let mergeBase
  try {
    mergeBase = git(['merge-base', baseRef, headRef])
  } catch (error) {
    fail(`Unable to compute merge-base between ${baseRef} and ${headRef}: ${error instanceof Error ? error.message : String(error)}`)
  }

  return git(['diff', '--name-only', '--diff-filter=ACMR', mergeBase, headRef])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function warnIfBaseRefLooksStale(baseRef) {
  if (process.env.CI || !baseRef.startsWith('origin/')) return
  try {
    const timestamp = Number(git(['log', '-1', '--format=%ct', baseRef]))
    if (!Number.isFinite(timestamp)) return
    const ageHours = (Date.now() / 1000 - timestamp) / 3600
    if (ageHours > 24) {
      console.warn(
        `Warning: ${baseRef} appears to be ${Math.floor(ageHours)} hours old. Run \`git fetch origin\` if migration convention results include unrelated files.`,
      )
    }
  } catch {
    // The merge-base check below reports missing refs with the full context.
  }
}

export function stripSqlCommentsAndLiterals(sql) {
  let output = ''
  for (let index = 0; index < sql.length;) {
    const char = sql[index]
    const next = sql[index + 1]

    if (char === '-' && next === '-') {
      while (index < sql.length && sql[index] !== '\n') index += 1
      if (sql[index] === '\n') output += '\n'
      index += 1
      continue
    }

    if (char === '/' && next === '*') {
      index += 2
      while (index < sql.length && !(sql[index] === '*' && sql[index + 1] === '/')) {
        if (sql[index] === '\n') output += '\n'
        index += 1
      }
      index += 2
      continue
    }

    if (char === "'") {
      output += "''"
      index += 1
      while (index < sql.length) {
        if (sql[index] === "'" && sql[index + 1] === "'") {
          index += 2
          continue
        }
        if (sql[index] === "'") {
          index += 1
          break
        }
        index += 1
      }
      continue
    }

    if (char === '$') {
      const tag = sql.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0]
      if (tag) {
        output += tag
        index += tag.length
        const end = sql.indexOf(tag, index)
        if (end === -1) {
          index = sql.length
        } else {
          const body = sql.slice(index, end)
          output += '\n'.repeat((body.match(/\n/g) ?? []).length)
          output += tag
          index = end + tag.length
        }
        continue
      }
    }

    output += char
    index += 1
  }
  return output
}

function splitStatements(sql) {
  return sql
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean)
}

function parseConventionMarkers(source, file) {
  const markersByPattern = new Map()
  const markerErrors = []

  source.split(/\r?\n/).forEach((line, lineIndex) => {
    if (!MARKER_PREFIX_RE.test(line)) return
    const match = line.match(MARKER_RE)
    if (!match) {
      markerErrors.push({
        file,
        line: lineIndex + 1,
        message: 'migration-convention-ok marker must name one pattern and use `because <specific rollout or not-live rationale>`.',
      })
      return
    }

    const pattern = match[1].toUpperCase().replace(/\s+/g, ' ')
    const rationale = match[2].trim()
    if (!ALLOWED_PATTERN_NAMES.has(pattern)) {
      markerErrors.push({
        file,
        line: lineIndex + 1,
        message: `unsupported migration-convention-ok pattern ${pattern}.`,
      })
      return
    }
    if (rationale.length < MIN_RATIONALE_LENGTH) {
      markerErrors.push({
        file,
        line: lineIndex + 1,
        message: `marker rationale for ${pattern} is too short; provide a specific rollout or not-live rationale.`,
      })
      return
    }
    markersByPattern.set(pattern, rationale)
  })

  return { markersByPattern, markerErrors }
}

function addViolation(violations, markersByPattern, pattern, message) {
  const markerRationale = markersByPattern.get(pattern)
  if (markerRationale) return
  violations.push({ pattern, message })
}

function addAddColumnNotNullViolations(statements, violations, markersByPattern) {
  const clauseRe = /\bADD\s+COLUMN\b(?:\s+IF\s+NOT\s+EXISTS\b)?[\s\S]*?(?=,\s*(?:ADD|DROP|ALTER)\b|$)/gi
  for (const statement of statements) {
    for (const match of statement.matchAll(clauseRe)) {
      const clause = match[0]
      if (/\bNOT\s+NULL\b/i.test(clause) && !/\bDEFAULT\b/i.test(clause)) {
        addViolation(
          violations,
          markersByPattern,
          MIGRATION_PATTERNS.ADD_COLUMN_NOT_NULL,
          `ADD COLUMN ... NOT NULL must include a DEFAULT or be split into nullable add, backfill, validate, then NOT NULL: ${clause.replace(/\s+/g, ' ').trim()}`,
        )
      }
    }
  }
}

function parseAddedNotValidConstraintNames(statements) {
  const names = []
  for (const statement of statements) {
    if (!/\bADD\s+CONSTRAINT\b/i.test(statement) || !/\bNOT\s+VALID\b/i.test(statement)) continue
    const match = statement.match(/\bADD\s+CONSTRAINT\s+(?:"([^"]+)"|([^\s,)]+))/i)
    if (match) names.push(match[1] ?? match[2])
  }
  return names
}

function parseValidatedConstraintNames(statements) {
  const names = new Set()
  for (const statement of statements) {
    const match = statement.match(/\bVALIDATE\s+CONSTRAINT\s+(?:"([^"]+)"|([^\s,)]+))/i)
    if (match) names.add(match[1] ?? match[2])
  }
  return names
}

export function analyzeMigrationSql(source, file = 'migration.sql') {
  const { markersByPattern, markerErrors } = parseConventionMarkers(source, file)
  const strippedSource = stripSqlCommentsAndLiterals(source)
  const statements = splitStatements(strippedSource)
  const violations = []

  for (const statement of statements) {
    if (/\bRENAME\s+COLUMN\b/i.test(statement)) {
      addViolation(
        violations,
        markersByPattern,
        MIGRATION_PATTERNS.RENAME_COLUMN,
        'RENAME COLUMN requires a 3-phase expand/backfill/cutover/drop deployment plan.',
      )
    }
    if (/\bDROP\s+COLUMN\b/i.test(statement)) {
      addViolation(
        violations,
        markersByPattern,
        MIGRATION_PATTERNS.DROP_COLUMN,
        'DROP COLUMN requires proof that deployed app code no longer reads or writes the column.',
      )
    }
  }

  addAddColumnNotNullViolations(statements, violations, markersByPattern)

  const validatedConstraintNames = parseValidatedConstraintNames(statements)
  for (const constraintName of parseAddedNotValidConstraintNames(statements)) {
    if (!validatedConstraintNames.has(constraintName)) {
      addViolation(
        violations,
        markersByPattern,
        MIGRATION_PATTERNS.NOT_VALID,
        `NOT VALID constraint ${constraintName} must be validated in the same migration or carry a marker that names the follow-up migration.`,
      )
    }
  }

  const acceptedMarkers = [...markersByPattern.entries()].map(([pattern, rationale]) => ({
    file,
    pattern,
    rationale,
  }))

  return { file, violations, markerErrors, acceptedMarkers }
}

function formatFailures(results) {
  const markerErrors = results.flatMap((result) => result.markerErrors)
  const violations = results.flatMap((result) => (
    result.violations.map((violation) => ({ ...violation, file: result.file }))
  ))

  const sections = []
  if (markerErrors.length > 0) {
    sections.push(
      'Invalid migration convention markers:',
      ...markerErrors.map((error) => `- ${error.file}:${error.line} ${error.message}`),
      '',
    )
  }
  if (violations.length > 0) {
    sections.push(
      'Changed migration SQL uses risky rollout patterns without an explicit per-pattern review marker.',
      'Prefer the conventions in docs/migration-conventions.md. If a pattern is intentionally safe for this PR, add a SQL line comment:',
      '-- migration-convention-ok: RENAME COLUMN because <specific rollout or not-live rationale>',
      '',
      ...violations.flatMap(({ file, pattern, message }) => [
        `- ${file}`,
        `  ${pattern}: ${message}`,
      ]),
    )
  }

  return [
    'Migration convention guard failed.',
    ...sections,
  ].join('\n')
}

function main() {
  const baseRef =
    process.argv[2]
    ?? process.env.MIGRATION_CONVENTION_BASE_REF
    ?? process.env.SCHEMA_SCOPE_BASE_REF
    ?? (process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : 'origin/development')
  const headRef =
    process.argv[3]
    ?? process.env.MIGRATION_CONVENTION_HEAD_REF
    ?? process.env.SCHEMA_SCOPE_HEAD_REF
    ?? 'HEAD'

  warnIfBaseRefLooksStale(baseRef)

  const migrationSqlFiles = changedFiles(baseRef, headRef)
    .filter((file) => /^prisma\/migrations\/[^/]+\/migration\.sql$/.test(file))

  const results = migrationSqlFiles.map((file) => analyzeMigrationSql(readFileAtRef(headRef, file), file))
  const hasFailures = results.some((result) => result.violations.length > 0 || result.markerErrors.length > 0)

  if (hasFailures) {
    fail(formatFailures(results))
  }

  for (const marker of results.flatMap((result) => result.acceptedMarkers)) {
    console.log(`Accepted migration convention marker in ${marker.file}: ${marker.pattern} because ${marker.rationale}`)
  }
  console.log('Migration convention check passed.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
