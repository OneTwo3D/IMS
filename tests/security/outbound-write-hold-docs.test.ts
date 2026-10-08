import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import {
  OUTBOUND_DOC_BLOCKS,
  OUTBOUND_DOC_BLOCK_CLOSE,
  OUTBOUND_DOC_BLOCK_OPEN,
  OUTBOUND_DOC_PLACEMENTS,
  OUTBOUND_GRANT_ENV,
  OUTBOUND_STATUS_EXIT_CODES,
  renderOutboundStatusExitCodeTable,
  type OutboundDocBlockId,
} from '../../lib/security/outbound-write-hold-constants.ts'

/**
 * DOCS AND CODE AGREE, UNIVERSALLY.
 *
 * Every statement of the outbound-write hold in the docs is a marked block whose body must equal the
 * text in lib/security/outbound-write-hold-constants.ts. The checks are over ALL blocks and ALL names
 * found, not "does the file contain the sentence": a stale block sitting beside a correct one fails,
 * and so does an environment variable name the code does not define.
 *
 * Mutation (recorded in the PR): change one word in a docs block => red; change one word in the
 * constants module => red.
 */

const ROOT = process.cwd()
const OPEN_RE = /<!-- outbound-write-hold:([a-z-]+) -->/g

function blocksIn(text: string): Array<{ id: string; body: string }> {
  const found: Array<{ id: string; body: string }> = []
  for (const match of text.matchAll(OPEN_RE)) {
    const id = match[1]!
    const start = (match.index ?? 0) + match[0].length
    const close = text.indexOf(OUTBOUND_DOC_BLOCK_CLOSE(id), start)
    assert.ok(close > start, `block ${id} has no closing marker`)
    found.push({ id, body: text.slice(start, close).replace(/^\n/, '').replace(/\n$/, '') })
  }
  return found
}

function markdownFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    const stat = statSync(full, { throwIfNoEntry: false })
    if (!stat) return []
    if (stat.isDirectory()) return entry === 'archive' || entry === 'completed' ? [] : markdownFiles(full)
    return entry.endsWith('.md') ? [full] : []
  })
}

test('every marked block in every doc equals the constants text, and each placement is present exactly once', () => {
  const files = markdownFiles(join(ROOT, 'docs'))
  let examined = 0
  const seen = new Map<string, OutboundDocBlockId[]>()
  for (const file of files) {
    const rel = file.slice(ROOT.length + 1)
    for (const block of blocksIn(readFileSync(file, 'utf8'))) {
      examined += 1
      assert.ok(block.id in OUTBOUND_DOC_BLOCKS, `${rel}: unknown block id ${block.id}`)
      assert.equal(block.body, OUTBOUND_DOC_BLOCKS[block.id as OutboundDocBlockId], `${rel}: block ${block.id} differs from the constants module`)
      seen.set(rel, [...(seen.get(rel) ?? []), block.id as OutboundDocBlockId])
    }
  }
  console.log(`precondition (docs): ${files.length} docs scanned, ${examined} marked blocks compared`)
  const expectedTotal = OUTBOUND_DOC_PLACEMENTS.reduce((sum, p) => sum + p.blocks.length, 0)
  assert.equal(examined, expectedTotal, 'the number of marked blocks in docs/ equals the number placed by the constants module')
  for (const placement of OUTBOUND_DOC_PLACEMENTS) {
    assert.deepEqual([...(seen.get(placement.file) ?? [])].sort(), [...placement.blocks].sort(), placement.file)
  }
  assert.deepEqual([...seen.keys()].sort(), OUTBOUND_DOC_PLACEMENTS.map((p) => p.file).sort(), 'no other doc carries a block')
})

test('every opening marker has the exact marker spelling (no malformed, unclosed or nested block hides)', () => {
  for (const placement of OUTBOUND_DOC_PLACEMENTS) {
    const text = readFileSync(join(ROOT, placement.file), 'utf8')
    const opens = (text.match(/<!--\s*outbound-write-hold:/g) ?? []).length
    const closes = (text.match(/<!--\s*\/outbound-write-hold:/g) ?? []).length
    const exactOpens = placement.blocks.filter((id) => text.split(OUTBOUND_DOC_BLOCK_OPEN(id)).length === 2).length
    assert.equal(opens, placement.blocks.length, `${placement.file}: marker count`)
    assert.equal(closes, placement.blocks.length, `${placement.file}: closing marker count`)
    assert.equal(exactOpens, placement.blocks.length, `${placement.file}: each marker appears once, exactly spelled`)
  }
})

test('the exit-code table in the docs is generated from the code table (every row, universally)', () => {
  const doc = readFileSync(join(ROOT, 'docs/installation.md'), 'utf8')
  const block = blocksIn(doc).find((b) => b.id === 'status-command')
  assert.ok(block)
  const rows = block.body.split('\n').filter((line) => /^\| \d+ \|/.test(line))
  console.log(`precondition (exit codes): ${rows.length} rows in the docs table, ${OUTBOUND_STATUS_EXIT_CODES.length} in the code table`)
  assert.equal(rows.length, OUTBOUND_STATUS_EXIT_CODES.length)
  assert.ok(block.body.includes(renderOutboundStatusExitCodeTable()))
  for (const row of OUTBOUND_STATUS_EXIT_CODES) {
    assert.ok(rows.some((line) => line.startsWith(`| ${row.code} | ${row.name} | `)), `exit code ${row.code}`)
  }
  assert.equal(new Set(OUTBOUND_STATUS_EXIT_CODES.map((r) => r.code)).size, OUTBOUND_STATUS_EXIT_CODES.length, 'exit codes are unique')
})

const GRANT_NAME_RE = /\b[A-Z][A-Z0-9_]*(?:WRITEBACK_ALLOWED|WRITE_ALLOWED)[A-Z0-9_]*\b/g

test('absence: no grant-shaped variable name in the docs, .env.example or source other than the three the constants module defines', () => {
  const defined = new Set(Object.values(OUTBOUND_GRANT_ENV))
  const sources: string[] = [join(ROOT, '.env.example'), ...markdownFiles(join(ROOT, 'docs')), join(ROOT, 'CLAUDE.md')]
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.next' || entry === 'generated') continue
      const full = join(dir, entry)
      const stat = statSync(full)
      if (stat.isDirectory()) walk(full)
      else if (/\.(ts|tsx|mjs)$/.test(entry)) sources.push(full)
    }
  }
  for (const dir of ['lib', 'app', 'scripts']) walk(join(ROOT, dir))
  let mentions = 0
  const stray: string[] = []
  for (const file of sources) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(GRANT_NAME_RE)) {
      mentions += 1
      if (!defined.has(match[0])) stray.push(`${file.slice(ROOT.length + 1)}: ${match[0]}`)
    }
  }
  console.log(`precondition (absence): ${sources.length} files scanned, ${mentions} grant-shaped names found, ${defined.size} defined`)
  assert.ok(mentions >= 6, 'the scan must find the names it is looking for')
  assert.deepEqual(stray, [])
})

test('.env.example carries each grant variable exactly once, commented out (the default is no grant)', () => {
  const text = readFileSync(join(ROOT, '.env.example'), 'utf8')
  for (const name of Object.values(OUTBOUND_GRANT_ENV)) {
    const uncommented = text.split('\n').filter((line) => line.startsWith(`${name}=`))
    const commented = text.split('\n').filter((line) => line.trim() === `# ${name}=`)
    assert.equal(uncommented.length, 0, `${name} must not be set by default`)
    assert.equal(commented.length, 1, `${name} must appear once as "# ${name}="`)
  }
})
