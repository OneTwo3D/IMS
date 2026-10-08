import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { OUTBOUND_CONNECTORS } from '../../lib/security/outbound-write-hold-constants.ts'
import {
  PRODUCER_CUTOFF_ENV,
  PRODUCER_DOC_BLOCKS,
  PRODUCER_DOC_BLOCK_CLOSE,
  PRODUCER_DOC_PLACEMENTS,
  type ProducerDocBlockId,
} from '../../lib/security/producer-disposition-constants.ts'

/**
 * DOCS AND CODE AGREE, UNIVERSALLY (same pattern as outbound-write-hold-docs.test.ts).
 *
 * Every marked block in docs/installation.md equals the constants text byte for byte, each placement is
 * present exactly once, and every cut-off variable the code defines is documented exactly once, in the
 * variable table of its block (the documented-env-vars check then proves each one is read by code).
 *
 * Mutation (recorded in the PR): change one word in the docs block => red; change one word in the constants => red.
 */

const ROOT = process.cwd()
const OPEN_RE = /<!-- producer-disposition:([a-z-]+) -->/g

function blocksIn(text: string): Array<{ id: string; body: string }> {
  const found: Array<{ id: string; body: string }> = []
  for (const match of text.matchAll(OPEN_RE)) {
    const id = match[1]!
    const start = (match.index ?? 0) + match[0].length
    const close = text.indexOf(PRODUCER_DOC_BLOCK_CLOSE(id), start)
    assert.ok(close > start, `block ${id} has no closing marker`)
    found.push({ id, body: text.slice(start, close).replace(/^\n/, '').replace(/\n$/, '') })
  }
  return found
}

test('every marked block equals the constants text and each placement is present exactly once', () => {
  let examined = 0
  for (const placement of PRODUCER_DOC_PLACEMENTS) {
    const text = readFileSync(join(ROOT, placement.file), 'utf8')
    const blocks = blocksIn(text)
    console.log(`# docs: ${placement.file} has ${blocks.length} producer-disposition blocks`)
    assert.deepEqual(blocks.map((block) => block.id).sort(), [...placement.blocks].sort())
    for (const block of blocks) {
      examined += 1
      assert.equal(block.body, PRODUCER_DOC_BLOCKS[block.id as ProducerDocBlockId], `${placement.file}: block ${block.id} is stale`)
    }
  }
  assert.ok(examined >= 2, 'precondition: blocks were examined')
})

test('each cut-off variable is documented exactly once, in a table row, and no unknown *_WRITES_LIVE_FROM variable is documented', () => {
  const text = readFileSync(join(ROOT, 'docs/installation.md'), 'utf8')
  for (const connector of OUTBOUND_CONNECTORS) {
    const name = PRODUCER_CUTOFF_ENV[connector]
    const rows = text.split('\n').filter((line) => line.startsWith(`| \`${name}\` |`))
    console.log(`# docs: ${name} rows=${rows.length}`)
    assert.equal(rows.length, 1, `${name} must have exactly one table row`)
  }
  const documented = new Set([...text.matchAll(/^\| `([A-Z0-9_]+_WRITES_LIVE_FROM)` \|/gm)].map((match) => match[1]))
  assert.deepEqual([...documented].sort(), Object.values(PRODUCER_CUTOFF_ENV).sort())
})
