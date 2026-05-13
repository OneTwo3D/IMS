#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const repoRoot = process.cwd()
const configPath = path.join(repoRoot, 'scripts/decimal-boundary-targets.json')

const ALLOWED_RATIONALES = new Set([
  'display-only',
  'report-only',
  'server-action-boundary',
  'legacy-pre-stage-4',
])
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'])
const IMPORT_RE = /import\s*\{[^}]*\}\s*from\s*['"]@\/lib\/decimal['"]/g
const BOUNDARY_COMMENT_RE = /decimal-boundary-ok:\s*([a-z0-9-]+)(?:[\s,.;:]|$|\()/

function loadConfig() {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch (error) {
    console.error(`Failed to read ${path.relative(repoRoot, configPath)}.`)
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }

  if (!Array.isArray(parsed.targets) || parsed.targets.length === 0) {
    console.error('scripts/decimal-boundary-targets.json must define a non-empty "targets" array.')
    process.exit(1)
  }

  for (const [index, target] of parsed.targets.entries()) {
    const hasPath = typeof target.path === 'string' && target.path.length > 0
    const hasGlob = typeof target.glob === 'string' && target.glob.length > 0
    if (hasPath === hasGlob) {
      console.error(`Decimal boundary target #${index + 1} must define exactly one of "path" or "glob".`)
      process.exit(1)
    }
  }

  return parsed.targets
}

function isSourceFile(filePath) {
  return SOURCE_EXTENSIONS.has(path.extname(filePath))
}

function shouldIgnore(filePath) {
  const normalized = filePath.split(path.sep).join('/')
  return normalized.includes('/node_modules/') ||
    normalized.includes('/.next/') ||
    normalized.includes('/app/generated/prisma/')
}

function collectPathFiles(target) {
  const absoluteTarget = path.join(repoRoot, target)
  const stat = statSync(absoluteTarget)
  if (stat.isFile()) return isSourceFile(absoluteTarget) && !shouldIgnore(absoluteTarget) ? [absoluteTarget] : []
  if (!stat.isDirectory()) return []

  const results = []
  const stack = [absoluteTarget]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current || shouldIgnore(current)) continue
    const stat = statSync(current)
    if (stat.isDirectory()) {
      for (const entry of readdirSync(current)) stack.push(path.join(current, entry))
      continue
    }
    if (stat.isFile() && isSourceFile(current)) results.push(current)
  }
  return results
}

function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
}

function globToRegExp(glob) {
  return new RegExp(`^${glob.split('*').map(escapeRegExp).join('[^/]*')}$`)
}

function collectGlobFiles(glob) {
  const firstWildcard = glob.indexOf('*')
  const staticPrefix = firstWildcard === -1 ? glob : glob.slice(0, firstWildcard)
  const baseDir = path.dirname(staticPrefix)
  const matcher = globToRegExp(glob)
  const absoluteBaseDir = path.join(repoRoot, baseDir)

  const results = []
  const stack = [absoluteBaseDir]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current || shouldIgnore(current)) continue
    const stat = statSync(current)
    if (stat.isDirectory()) {
      for (const entry of readdirSync(current)) stack.push(path.join(current, entry))
      continue
    }
    const relativePath = path.relative(repoRoot, current).split(path.sep).join('/')
    if (stat.isFile() && isSourceFile(current) && matcher.test(relativePath)) results.push(current)
  }
  return results
}

function collectTargetFiles(target) {
  if (target.path) return collectPathFiles(target.path)
  return collectGlobFiles(target.glob)
}

function lineNumberAt(source, index) {
  let line = 1
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (source.charCodeAt(cursor) === 10) line += 1
  }
  return line
}

function findBoundaryComment(source) {
  const match = source.match(BOUNDARY_COMMENT_RE)
  if (!match) return null
  return {
    rationale: match[1],
  }
}

const targets = loadConfig()
const configErrors = []
const filesByTarget = targets.map((target) => {
  const label = target.path ?? target.glob
  try {
    const files = collectTargetFiles(target)
    if (files.length === 0) {
      configErrors.push(`Decimal boundary target "${label}" matched zero source files.`)
    }
    return files
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    configErrors.push(`Decimal boundary target "${label}" could not be scanned: ${detail}`)
    return []
  }
})

if (configErrors.length > 0) {
  console.error('decimalToNumber boundary check configuration failed.')
  for (const error of configErrors) console.error(`- ${error}`)
  process.exit(1)
}

const files = [...new Set(filesByTarget.flat())]
const violations = []

for (const file of files) {
  const source = readFileSync(file, 'utf8')
  const boundaryComment = findBoundaryComment(source)
  for (const match of source.matchAll(IMPORT_RE)) {
    const importText = match[0]
    if (!/\bdecimalToNumber\b/.test(importText)) continue
    const importStartLine = lineNumberAt(source, match.index ?? 0)
    if (!boundaryComment) {
      violations.push({
        file: path.relative(repoRoot, file).split(path.sep).join('/'),
        line: importStartLine,
        reason: 'missing decimal-boundary-ok comment',
      })
      continue
    }
    if (!ALLOWED_RATIONALES.has(boundaryComment.rationale)) {
      violations.push({
        file: path.relative(repoRoot, file).split(path.sep).join('/'),
        line: importStartLine,
        reason: `unsupported rationale "${boundaryComment.rationale}"`,
      })
    }
  }
}

if (violations.length > 0) {
  console.error('decimalToNumber boundary check failed.')
  console.error('Guarded domain/accounting paths must not import decimalToNumber from @/lib/decimal without an explicit exception comment.')
  console.error('Add a file-scope comment with one of these leading rationale tokens:')
  console.error(`  ${[...ALLOWED_RATIONALES].join(', ')}`)
  console.error('For example:')
  console.error('  // decimal-boundary-ok: display-only (UI serialization)')
  console.error('')
  for (const violation of violations) {
    console.error(`- ${violation.file}:${violation.line} ${violation.reason}`)
  }
  process.exit(1)
}
