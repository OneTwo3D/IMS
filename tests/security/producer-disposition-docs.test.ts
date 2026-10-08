import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { producerAgreementText } from '../../lib/security/producer-disposition-constants.ts'
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

/**
 * THE UNWIRED MODULE IS DESCRIBED TRUTHFULLY. While no production code calls the decision, operator text must
 * say so, must not claim behaviour that only a later change delivers, and may use "will" only for a later change.
 */
test('operator text for the unwired producer hold says it is not enforced, claims no present effect, and uses "will" only for later changes', () => {
  const texts = [...Object.values(PRODUCER_DOC_BLOCKS)]
  for (const connector of OUTBOUND_CONNECTORS) {
    for (const detail of ['agreed_held', 'agreed_live', 'cutoff_without_grant', 'grant_without_cutoff', 'unreadable'] as const) texts.push(producerAgreementText(connector, detail))
  }
  assert.ok(PRODUCER_DOC_BLOCKS.overview.startsWith('THE PRODUCER-SIDE HOLD IS NOT YET ENFORCED.'))
  assert.match(PRODUCER_DOC_BLOCKS.overview, /grant is set permits the existing outbound writes through the transport/)
  const forbidden = [/nothing is delivered/i, /both are reported/i, /cannot deliver/i, /is reported by/i, /records what it would have written/i, /sends nothing/i, /does not start any writer/i, /keeps the destination in shadow/i]
  let sentences = 0
  let willSentences = 0
  for (const text of texts) {
    for (const pattern of forbidden) assert.ok(!pattern.test(text), `forbidden claim ${pattern}: ${text.slice(0, 80)}`)
    for (const sentence of text.split(/(?<=[.;])\s+/)) {
      sentences += 1
      if (/\bwill\b/i.test(sentence)) {
        willSentences += 1
        assert.match(sentence, /later (change|slice)/i, `"will" without naming a later change: ${sentence.slice(0, 100)}`)
      }
    }
  }
  console.log(`# docs wording: texts=${texts.length} sentences=${sentences} will-sentences=${willSentences}`)
  assert.ok(willSentences >= 3, 'precondition: the rule examined sentences that use "will"')
  // Rule can fail: an unconditional sentence is caught.
  assert.throws(() => assert.match('Nothing will be queued.', /later (change|slice)/i))
  // No text claims outbound:status reports the inconsistency today.
  for (const text of texts) assert.ok(!/outbound:status` (reports|shows|prints)/.test(text))
})
