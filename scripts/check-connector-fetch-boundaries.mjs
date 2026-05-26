#!/usr/bin/env node

/**
 * Static guard: blocks raw fetch() calls in connector/server-integration paths
 * so outbound HTTP keeps the URL, DNS, timeout, redirect, and response-size
 * protections in lib/security/connector-fetch.ts.
 *
 * Scanned paths: lib/connectors/**, lib/shopping.ts, app/api/cron/**, and
 * app/actions/** files with a sync path segment or filename.
 *
 * Waiver: add `// connector-fetch-boundary-ok: <ticket-or-date>: <reason>` on
 * the same line as fetch() or the line immediately above it. Blank lines and
 * multi-line block comments intentionally break the association.
 *
 * Run from `npm run check:connector-fetch-boundaries`; invoked by
 * `npm run validate`.
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, relative, sep } from 'node:path'

const ROOT = process.cwd()
const ALLOW_COMMENT = /^\s*(?:(?:\/\/|\/\*|\*)\s*)connector-fetch-boundary-ok:\s*[^:\s]+:\s*\S+/
const RAW_FETCH_RE = /(^|[\s;,(=&|!?:])fetch\s*\(/
const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])
const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.next',
  '__fixtures__',
  '__mocks__',
  '__tests__',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'playwright-report',
  'test-results',
])
const SYNC_SEGMENT_RE = /(^|[-_.])sync($|[-_.])/i

const TARGETS = [
  'lib/connectors',
  'lib/shopping.ts',
  'app/api/cron',
]

const args = new Set(process.argv.slice(2))
const reportArg = process.argv.slice(2).find((arg) => arg === '--report' || arg.startsWith('--report='))
const reportPath = reportArg === '--report'
  ? 'reports/connector-fetch-boundaries.json'
  : reportArg?.slice('--report='.length)
const listWaived = args.has('--list-waived')

function isScannedFile(file) {
  const extension = extname(file)
  if (!SCANNED_EXTENSIONS.has(extension)) return false
  return !basename(file).match(/\.(test|spec)\.[cm]?[jt]sx?$/)
}

function listFiles(path) {
  const fullPath = join(ROOT, path)
  let stats
  try {
    stats = statSync(fullPath)
  } catch {
    return []
  }

  if (stats.isFile()) return isScannedFile(fullPath) ? [fullPath] : []
  if (!stats.isDirectory()) return []

  const files = []
  for (const entry of readdirSync(fullPath)) {
    if (SKIPPED_DIRECTORIES.has(entry)) continue
    files.push(...listFiles(join(path, entry)))
  }
  return files
}

function isSyncActionFile(file) {
  const relativePath = relative(join(ROOT, 'app/actions'), file).split(sep).join('/')
  return relativePath
    .split('/')
    .map((segment) => segment.slice(0, segment.length - extname(segment).length) || segment)
    .some((segment) => SYNC_SEGMENT_RE.test(segment))
}

function listActionSyncFiles() {
  return listFiles('app/actions').filter(isSyncActionFile)
}

function hasBoundaryWaiver(lines, lineIndex) {
  const currentLine = lines[lineIndex] ?? ''
  const previousLine = lines[lineIndex - 1] ?? ''
  return hasWaiverComment(currentLine) || hasWaiverComment(previousLine)
}

function commentPortions(line) {
  const portions = []
  const trimmedStart = line.trimStart()
  if (trimmedStart.startsWith('*')) portions.push(trimmedStart)

  let quote = null
  let escape = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    const next = line[index + 1]

    if (quote) {
      if (escape) escape = false
      else if (char === '\\') escape = true
      else if (char === quote) quote = null
      continue
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }
    if (char === '/' && (next === '/' || next === '*')) {
      portions.push(line.slice(index).trimStart())
      index += 1
    }
  }

  return portions
}

function hasWaiverComment(line) {
  return commentPortions(line).some((comment) => ALLOW_COMMENT.test(comment))
}

function stripCommentsAndStrings(line, state) {
  let output = ''

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    const next = line[index + 1]

    if (state.blockComment) {
      if (char === '*' && next === '/') {
        state.blockComment = false
        index += 1
      }
      output += ' '
      continue
    }

    if (state.quote) {
      if (state.escape) {
        state.escape = false
      } else if (char === '\\') {
        state.escape = true
      } else if (char === state.quote) {
        state.quote = null
      }
      output += ' '
      continue
    }

    if (char === '/' && next === '/') break
    if (char === '/' && next === '*') {
      state.blockComment = true
      output += ' '
      index += 1
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      state.quote = char
      output += ' '
      continue
    }

    output += char
  }

  return output
}

function findRawFetches(file) {
  const text = readFileSync(file, 'utf8')
  const lines = text.split(/\r?\n/)
  const findings = []
  const waived = []
  const stripState = { blockComment: false, quote: null, escape: false }

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]
    const strippedLine = stripCommentsAndStrings(line, stripState)
    if (!RAW_FETCH_RE.test(strippedLine)) continue
    const entry = {
      path: relative(ROOT, file).split(sep).join('/'),
      line: lineIndex + 1,
      text: line.trim(),
    }
    if (hasBoundaryWaiver(lines, lineIndex)) {
      waived.push(entry)
      continue
    }

    findings.push(entry)
  }

  return { findings, waived }
}

const files = [
  ...TARGETS.flatMap(listFiles),
  ...listActionSyncFiles(),
]

const uniqueFiles = [...new Set(files)]
const results = uniqueFiles.map(findRawFetches)
const findings = results.flatMap((result) => result.findings)
const waived = results.flatMap((result) => result.waived)

if (reportPath) {
  const absoluteReportPath = join(ROOT, reportPath)
  mkdirSync(dirname(absoluteReportPath), { recursive: true })
  writeFileSync(absoluteReportPath, `${JSON.stringify({ findings, waived }, null, 2)}\n`)
}

if (listWaived) {
  if (waived.length === 0) {
    console.log('No connector fetch boundary waivers found.')
  } else {
    for (const waiver of waived) {
      console.log(`${waiver.path}:${waiver.line}: ${waiver.text}`)
    }
  }
}

if (findings.length > 0) {
  console.error('Raw fetch() is not allowed in connector/server integration paths.')
  console.error('Use lib/security/connector-fetch.ts, or add a local waiver comment:')
  console.error('// connector-fetch-boundary-ok: <ticket-or-date>: <reason>')
  console.error('')
  for (const finding of findings) {
    console.error(`${finding.path}:${finding.line}: ${finding.text}`)
  }
  process.exit(1)
}
