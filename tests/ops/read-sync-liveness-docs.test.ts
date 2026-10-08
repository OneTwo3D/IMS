import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import {
  READ_SYNC_DOC_BLOCKS,
  READ_SYNC_DOC_BLOCK_CLOSE,
  READ_SYNC_DOC_PLACEMENTS,
  READ_SYNC_STATUS_EXIT_CODES,
  READ_SYNC_STREAMS,
  renderReadSyncStatusExitCodeTable,
  type ReadSyncDocBlockId,
} from '../../lib/ops/read-sync-liveness-constants.ts'

/**
 * DOCS AND CODE AGREE, UNIVERSALLY: every marked read-sync block in every placed doc equals the text in
 * lib/ops/read-sync-liveness-constants.ts, each placement is present exactly once, and a stale block
 * beside a correct one fails. Also: every stream and every exit code appears in the rendered docs, and
 * the package script the docs name exists.
 *
 * Mutations (verified red, see the PR): one word changed in a docs block => red; one word changed in the
 * constants module => red.
 */

const ROOT = process.cwd()
const OPEN_RE = /<!-- read-sync-liveness:([a-z-]+) -->/g

function blocksIn(text: string): Array<{ id: string; body: string }> {
  const found: Array<{ id: string; body: string }> = []
  for (const match of text.matchAll(OPEN_RE)) {
    const id = match[1]!
    const start = (match.index ?? 0) + match[0].length
    const close = text.indexOf(READ_SYNC_DOC_BLOCK_CLOSE(id), start)
    assert.ok(close > start, `block ${id} has no closing marker`)
    found.push({ id, body: text.slice(start, close).replace(/^\n/, '').replace(/\n$/, '') })
  }
  return found
}

test('every marked block equals the constants text and each placement holds exactly its blocks', () => {
  let examined = 0
  for (const placement of READ_SYNC_DOC_PLACEMENTS) {
    const text = readFileSync(join(ROOT, placement.file), 'utf8')
    const blocks = blocksIn(text)
    for (const block of blocks) {
      examined += 1
      assert.ok(block.id in READ_SYNC_DOC_BLOCKS, `${placement.file}: unknown block ${block.id}`)
      assert.equal(block.body, READ_SYNC_DOC_BLOCKS[block.id as ReadSyncDocBlockId], `${placement.file}: block ${block.id} differs from the constants module`)
    }
    assert.deepEqual(blocks.map((block) => block.id).sort(), [...placement.blocks].sort(), placement.file)
    const opens = (text.match(/<!--\s*read-sync-liveness:/g) ?? []).length
    const closes = (text.match(/<!--\s*\/read-sync-liveness:/g) ?? []).length
    assert.equal(opens, placement.blocks.length, 'no malformed or unclosed opening marker hides')
    assert.equal(closes, placement.blocks.length)
  }
  console.log(`precondition: ${examined} marked blocks compared across ${READ_SYNC_DOC_PLACEMENTS.length} placed doc(s)`)
  assert.equal(examined, READ_SYNC_DOC_PLACEMENTS.reduce((sum, placement) => sum + placement.blocks.length, 0))
  assert.ok(examined >= 3)
})

test('no doc outside the placements carries a read-sync block', () => {
  
  const hits = execFileSync('grep', ['-rl', '--include=*.md', 'read-sync-liveness:', 'docs', 'help-docs'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)
  console.log(`precondition: files carrying the marker: ${JSON.stringify(hits)}`)
  assert.deepEqual(hits, READ_SYNC_DOC_PLACEMENTS.map((placement) => placement.file))
})

test('the docs table names every stream and every exit code, and the script exists', () => {
  const text = readFileSync(join(ROOT, 'docs/installation.md'), 'utf8')
  for (const def of READ_SYNC_STREAMS) assert.ok(text.includes(`| ${def.label} |`), `docs table is missing ${def.id}`)
  for (const row of READ_SYNC_STATUS_EXIT_CODES) assert.ok(text.includes(`| ${row.code} | ${row.name} | ${row.meaning} |`), `docs omit exit code ${row.code}`)
  assert.ok(renderReadSyncStatusExitCodeTable().split('\n').length === READ_SYNC_STATUS_EXIT_CODES.length + 2)
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
  assert.equal(pkg.scripts['read-sync:status'], 'tsx scripts/read-sync-status.ts')
})

test('the feature adds no environment variable: the new modules read none', () => {
  const files = [
    'lib/ops/read-sync-liveness-constants.ts',
    'lib/ops/read-sync-liveness.ts',
    'lib/ops/read-sync-status.ts',
    'lib/ops/read-sync-liveness-alarm.ts',
    'scripts/read-sync-status.ts',
    'app/api/cron/read-sync-liveness/route.ts',
  ]
  for (const file of files) {
    const text = readFileSync(join(ROOT, file), 'utf8')
    assert.doesNotMatch(text, /process\.env\./, `${file} reads an environment variable that the docs do not list`)
  }
})
