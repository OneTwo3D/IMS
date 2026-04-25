#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { config as loadDotenv } from 'dotenv'

loadDotenv({ path: '.env.local', override: false, quiet: true })
loadDotenv({ path: '.env', override: false, quiet: true })

const schemaPath = process.env.PRISMA_SCHEMA_PATH ?? 'prisma/schema.prisma'
const allowlistPath = process.env.PRISMA_DRIFT_ALLOWLIST ?? 'prisma/unsupported-schema-drift-allowlist.json'

function fail(message, details = '', code = 1) {
  console.error(message)
  if (details.trim()) console.error(`\n${details.trim()}`)
  process.exit(code)
}

function runPrismaDiff() {
  const result = spawnSync(
    'npx',
    ['prisma', 'migrate', 'diff', '--from-config-datasource', '--to-schema', schemaPath],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        CHECKPOINT_DISABLE: '1',
        PRISMA_HIDE_UPDATE_MESSAGE: '1',
      },
    },
  )

  if (result.error) {
    fail(`Failed to execute Prisma drift check: ${result.error.message}`)
  }

  return result
}

function loadAllowlist() {
  if (!existsSync(allowlistPath)) return { blocks: [] }

  try {
    const parsed = JSON.parse(readFileSync(allowlistPath, 'utf8'))
    return Array.isArray(parsed.blocks) ? parsed : { blocks: [] }
  } catch (error) {
    fail(`Unable to parse ${allowlistPath}.`, error instanceof Error ? error.message : String(error))
  }
}

function stripDiagnostics(output) {
  return output
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim()
      if (!trimmed) return false
      if (trimmed.startsWith('Loaded Prisma config from ')) return false
      if (trimmed.startsWith('Prisma schema loaded from ')) return false
      if (trimmed.startsWith('Datasource "')) return false
      if (trimmed === 'No difference detected.') return false
      return true
    })
}

function parseBlocks(lines) {
  const blocks = []
  let current = null

  for (const line of lines) {
    if (!line.startsWith('  ')) {
      current = { header: line.trim(), details: [] }
      blocks.push(current)
      continue
    }

    if (!current) {
      current = { header: '(unscoped output)', details: [] }
      blocks.push(current)
    }

    current.details.push(line.trim())
  }

  return blocks
}

function blockMatchesAllowlist(block, entry) {
  if (!entry || typeof entry.headerIncludes !== 'string') return false
  if (!block.header.includes(entry.headerIncludes)) return false

  const detailPatterns = Array.isArray(entry.detailIncludes) ? entry.detailIncludes : []
  if (block.details.length === 0) return true

  return block.details.every((detail) => detailPatterns.some((pattern) => detail.includes(pattern)))
}

function formatBlock(block) {
  return [block.header, ...block.details.map((detail) => `  ${detail}`)].join('\n')
}

const result = runPrismaDiff()
const combinedOutput = [result.stdout, result.stderr].filter(Boolean).join('\n')

if ((result.status ?? 0) !== 0) {
  fail('Prisma drift check failed unexpectedly.', combinedOutput, result.status ?? 1)
}

const driftLines = stripDiagnostics(combinedOutput)
if (driftLines.length === 0) {
  console.log(`Database schema matches ${schemaPath}.`)
  process.exit(0)
}

const allowlist = loadAllowlist()
const blocks = parseBlocks(driftLines)
const unmatchedBlocks = []
const allowlistedBlocks = []

for (const block of blocks) {
  const match = allowlist.blocks.find((entry) => blockMatchesAllowlist(block, entry))
  if (match) {
    allowlistedBlocks.push({ block, reason: match.reason ?? 'No reason provided.' })
  } else {
    unmatchedBlocks.push(block)
  }
}

if (unmatchedBlocks.length > 0) {
  fail(
    [
      'Database/schema drift detected.',
      `If this is an intentional unsupported database feature, isolate it in a dedicated manual migration and document it in ${allowlistPath}.`,
    ].join(' '),
    unmatchedBlocks.map(formatBlock).join('\n\n'),
  )
}

console.warn('Only allowlisted unsupported database differences remain:')
for (const { block, reason } of allowlistedBlocks) {
  console.warn(`\n${formatBlock(block)}\n  Reason: ${reason}`)
}
