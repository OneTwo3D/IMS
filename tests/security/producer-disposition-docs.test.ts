import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { producerAgreementText } from '../../lib/security/producer-disposition-constants.ts'
import { OUTBOUND_CONNECTORS } from '../../lib/security/outbound-write-hold-constants.ts'
import {
  PRODUCER_CUTOFF_ENV,
  PRODUCER_HOLD_ENFORCED_ENV,
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

test('the enforcement variable is documented exactly once, in a table row, and the only *_ENFORCED_DESTINATIONS variable documented', () => {
  const text = readFileSync(join(ROOT, 'docs/installation.md'), 'utf8')
  const rows = text.split('\n').filter((line) => line.startsWith(`| \`${PRODUCER_HOLD_ENFORCED_ENV}\` |`))
  console.log(`# docs: ${PRODUCER_HOLD_ENFORCED_ENV} rows=${rows.length}`)
  assert.equal(rows.length, 1, `${PRODUCER_HOLD_ENFORCED_ENV} must have exactly one table row`)
  const documented = new Set([...text.matchAll(/^\| `([A-Z0-9_]+_ENFORCED_DESTINATIONS)` \|/gm)].map((match) => match[1]))
  assert.deepEqual([...documented], [PRODUCER_HOLD_ENFORCED_ENV])
})

/**
 * THE PARTLY WIRED HOLD IS DESCRIBED TRUTHFULLY. Only the Xero producers consult the decision, and only where the
 * enforcement variable names the destination: operator text must say so, must not claim behaviour that only a later
 * change delivers (the outbound:status report, the writer-side cut-off, the other destinations), and may use "will"
 * only for a later change.
 */
test('operator text for the producer hold says it is enforced only where named and only for Xero, claims no behaviour of a later change, and uses "will" only for later changes', () => {
  const texts = [...Object.values(PRODUCER_DOC_BLOCKS)]
  for (const connector of OUTBOUND_CONNECTORS) {
    for (const detail of ['agreed_held', 'agreed_live', 'cutoff_without_grant', 'grant_without_cutoff', 'unreadable'] as const) texts.push(producerAgreementText(connector, detail))
  }
  assert.ok(PRODUCER_DOC_BLOCKS.overview.startsWith('THE PRODUCER-SIDE HOLD IS ENFORCED ONLY FOR THE DESTINATIONS NAMED IN'))
  assert.match(PRODUCER_DOC_BLOCKS.overview, /WHICH IS UNSET BY DEFAULT\. Unset, every producer queues work exactly as it did before/)
  assert.match(PRODUCER_DOC_BLOCKS.overview, /Today only the Xero producers consult the decision/)
  assert.match(PRODUCER_DOC_BLOCKS.overview, /`npm run outbound:status` does not report on the decision/)
  const forbidden = [/nothing is delivered/i, /both are reported/i, /cannot deliver/i, /is reported by/i, /sends nothing/i, /does not start any writer/i, /keeps the destination in shadow/i, /mintsoft (producers )?(queue|record|shadow)s? nothing/i]
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
  assert.ok(willSentences >= 2, 'precondition: the rule examined sentences that use "will"')
  // Rule can fail: an unconditional sentence is caught.
  assert.throws(() => assert.match('Nothing will be queued.', /later (change|slice)/i))
  // No text claims outbound:status reports the inconsistency today.
  for (const text of texts) assert.ok(!/outbound:status` (reports|shows|prints)/.test(text))
})

test('the .env.example comment for the producer-side hold is true today: enforced only where named, only for Xero, and no claims of a later change', () => {
  const lines = readFileSync(join(ROOT, '.env.example'), 'utf8').split('\n')
  const start = lines.findIndex((line) => line.startsWith('# PRODUCER-SIDE HOLD'))
  assert.ok(start > 0, 'precondition: the comment block exists')
  let end = start
  while (end < lines.length && lines[end]!.startsWith('#')) end += 1
  const block = lines.slice(start, end).map((line) => line.replace(/^#\s?/, '')).join(' ')
  console.log(`# env.example: ${end - start} comment lines examined`)
  assert.match(block, /ENFORCED ONLY FOR THE DESTINATIONS NAMED BELOW; UNSET BY DEFAULT/)
  assert.match(block, /a grant alone permits the outbound writes through the transport/)
  assert.match(block, /Today only the Xero producers consult the decision/)
  assert.ok(block.includes(PRODUCER_HOLD_ENFORCED_ENV) || lines.some((line) => line.startsWith(`# ${PRODUCER_HOLD_ENFORCED_ENV}=`)), 'the enforcement variable is listed')
  for (const pattern of [/needs BOTH/i, /nothing is delivered/i, /sends nothing/i, /outbound:status/i]) assert.ok(!pattern.test(block), `forbidden claim ${pattern}`)
  for (const sentence of block.split(/(?<=[.;])\s+/)) {
    if (/\bwill\b/i.test(sentence)) assert.match(sentence, /later (change|slice)/i, sentence.slice(0, 100))
  }
})

test('no source comment or constant outside the docs claims the producer-side hold is enforced today', () => {
  const files = ['lib/security/producer-disposition.ts', 'lib/security/producer-disposition-constants.ts', 'lib/security/writer-ownership-map.ts']
  const forbidden = [/\bis the only place that decides whether a unit of IMS work\b[^.]*\bis (queued|produced)\b/i, /decides, one step earlier, whether a piece of IMS work should be queued/i, /it produces LIVE work only/i]
  let examined = 0
  for (const file of files) {
    const text = readFileSync(join(ROOT, file), 'utf8')
    examined += 1
    for (const pattern of forbidden) assert.ok(!pattern.test(text), `${file}: ${pattern}`)
  }
  console.log(`# source wording: ${examined} files`)
  assert.equal(examined, 3)
})
