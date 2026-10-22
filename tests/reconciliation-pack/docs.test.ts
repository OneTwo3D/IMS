import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import {
  PACK_CHAIN_CODES, PACK_DOC_BLOCKS, PACK_DOC_BLOCK_CLOSE, PACK_DOC_BLOCK_OPEN, PACK_DOC_PLACEMENTS, PACK_EXIT_CODES, PACK_ITEM_CATALOGUE,
  PACK_OUTCOMES, PACK_REASON_CODE_LIST, PACK_AUDIT_ROWS, PENDING_PERSISTENCE_RUNS, MAX_REPORTS_READ, type PackDocBlockId,
} from '../../lib/reconciliation-pack/constants.ts'

/**
 * DOCS AND CODE AGREE, UNIVERSALLY (same shape as tests/ops/readiness-gate-docs.test.ts): every reconciliation-pack
 * block in every doc equals the constants text; the exit-code table is the code's table row for row; a stale number
 * in the prose of the section is found by an ABSENCE check.
 */

const ROOT = process.cwd()
const OPEN_RE = /<!-- reconciliation-pack:([a-z-]+) -->/g

function blocksIn(text: string): Array<{ id: string; body: string }> {
  const found: Array<{ id: string; body: string }> = []
  for (const match of text.matchAll(OPEN_RE)) {
    const id = match[1]!
    const start = (match.index ?? 0) + match[0].length
    const close = text.indexOf(PACK_DOC_BLOCK_CLOSE(id), start)
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
  const seen = new Map<string, string[]>()
  let examined = 0
  for (const file of files) {
    const rel = file.slice(ROOT.length + 1)
    for (const block of blocksIn(readFileSync(file, 'utf8'))) {
      examined += 1
      assert.ok(block.id in PACK_DOC_BLOCKS, `${rel}: unknown block ${block.id}`)
      assert.equal(block.body, PACK_DOC_BLOCKS[block.id as PackDocBlockId], `${rel}: block ${block.id} differs from the constants module`)
      seen.set(rel, [...(seen.get(rel) ?? []), block.id])
    }
  }
  console.log(`precondition: ${files.length} docs scanned, ${examined} reconciliation-pack blocks compared`)
  const expected = PACK_DOC_PLACEMENTS.reduce((sum, p) => sum + p.blocks.length, 0)
  assert.ok(expected >= 9)
  assert.equal(examined, expected)
  for (const placement of PACK_DOC_PLACEMENTS) assert.deepEqual([...(seen.get(placement.file) ?? [])].sort(), [...placement.blocks].sort(), placement.file)
  assert.deepEqual([...seen.keys()].sort(), PACK_DOC_PLACEMENTS.map((p) => p.file).sort())
  assert.deepEqual([...new Set(PACK_DOC_PLACEMENTS.flatMap((p) => p.blocks))].sort(), Object.keys(PACK_DOC_BLOCKS).sort(), 'every block is placed somewhere')
})

test('marker spelling: no malformed, unclosed or duplicated marker hides', () => {
  for (const placement of PACK_DOC_PLACEMENTS) {
    const text = readFileSync(join(ROOT, placement.file), 'utf8')
    assert.equal((text.match(/<!--\s*reconciliation-pack:/g) ?? []).length, placement.blocks.length)
    assert.equal((text.match(/<!--\s*\/reconciliation-pack:/g) ?? []).length, placement.blocks.length)
    for (const id of placement.blocks) assert.equal(text.split(PACK_DOC_BLOCK_OPEN(id)).length, 2, id)
  }
})

test('the documented exit-code table is the code\'s table, row for row, and the codes are exactly 0,1,5,2,3,4', () => {
  const text = readFileSync(join(ROOT, 'docs/installation.md'), 'utf8')
  const block = blocksIn(text).find((b) => b.id === 'exit-codes')!
  const rows = block.body.split('\n').slice(2)
  assert.equal(rows.length, PACK_EXIT_CODES.length)
  for (const row of PACK_EXIT_CODES) assert.ok(rows.includes(`| ${row.code} | ${row.name} | ${row.meaning} |`), row.name)
  assert.deepEqual(PACK_EXIT_CODES.map((r) => r.code).sort(), [0, 1, 2, 3, 4, 5])
  assert.deepEqual(Object.fromEntries(PACK_EXIT_CODES.map((r) => [r.name, r.code])), { 'all-pass': 0, fail: 1, inconclusive: 5, refused: 2, 'report-not-published': 3, internal: 4 })
})

test('the docs carry every outcome, reason code, refusal code, item and audit row the code defines', () => {
  const text = readFileSync(join(ROOT, 'docs/installation.md'), 'utf8')
  const find = (id: string) => blocksIn(text).find((b) => b.id === id)!.body
  for (const outcome of PACK_OUTCOMES) assert.ok(find('outcomes').includes(`| ${outcome} |`), outcome)
  for (const code of PACK_REASON_CODE_LIST) assert.ok(find('reasons').includes(`| ${code} |`), code)
  for (const code of Object.keys(PACK_CHAIN_CODES)) assert.ok(find('refusals').includes(`| ${code} |`), code)
  for (const spec of PACK_ITEM_CATALOGUE) assert.ok(find('items').includes(`| ${spec.id} |`), spec.id)
  for (const row of PACK_AUDIT_ROWS) assert.ok(find('audit').includes(`| ${row.klass} |`), row.klass)
  assert.ok(find('settling').includes(`${PENDING_PERSISTENCE_RUNS} LATER successful runs`))
  assert.ok(find('chain').includes(`${MAX_REPORTS_READ} reports`))
})
