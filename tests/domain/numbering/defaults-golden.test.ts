import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { DOCUMENT_TYPE_SPECS, NUMBERED_DOCUMENT_TYPES, type NumberedDocumentType } from '../../../lib/domain/numbering/document-types.ts'
import { effectiveParsedPattern, patternText } from '../../../lib/domain/numbering/mint.ts'
import { renderPattern } from '../../../lib/domain/numbering/pattern.ts'

/**
 * DEFAULTS ARE BYTE-IDENTICAL TO TODAY, PER TYPE. Each case is rendered three ways that must agree: the new default
 * pattern, the frozen golden file, and the formula the old code used (copied here verbatim, so the comparison is with
 * what really shipped and not with a restatement of the new code).
 */

type Case = { type: NumberedDocumentType; prefix: string; isoDate: string; seq?: number; stem?: string; expected?: string | null; patternText: string | null }
const golden = JSON.parse(readFileSync(new URL('../../fixtures/document-numbering-defaults.golden.json', import.meta.url), 'utf8')) as { cases: Case[] }

/** sales.ts and purchase-orders.ts, before patterns: the date is the UTC date, the tail is four random base-36 characters. */
function legacyDatedRandom(prefix: string, now: Date, rand: string): string {
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, '')
  return `${prefix}${ymd}-${rand}`
}
/** refund-service.ts nextCreditNoteNumber, before patterns: the year is the local year. */
function legacyCreditNote(prefix: string, date: Date, next: number): string {
  const year = date.getFullYear()
  return `${prefix}${year}-${String(next).padStart(5, '0')}`
}

test('the golden file covers every document type', () => {
  assert.deepEqual([...new Set(golden.cases.map((c) => c.type))].sort(), [...NUMBERED_DOCUMENT_TYPES].sort())
})

for (const c of golden.cases) {
  test(`default ${c.type} with prefix "${c.prefix}" on ${c.isoDate}`, () => {
    const date = new Date(c.isoDate)
    const parsed = effectiveParsedPattern(c.type, null, c.prefix)
    const spec = DOCUMENT_TYPE_SPECS[c.type]
    if (c.patternText === null) {
      assert.equal(parsed, null, 'a type with no default number mints none')
      return
    }
    assert.ok(parsed)
    assert.equal(patternText(parsed.segments), c.patternText)
    const rendered = renderPattern(parsed, { date, basis: spec.basis, seq: c.seq })

    if (c.type === 'credit_note') {
      assert.equal(rendered, c.expected)
      assert.equal(rendered, legacyCreditNote(c.prefix, date, c.seq!), 'the old formula gives the same bytes')
    } else {
      assert.ok(rendered.startsWith(c.stem!), `${rendered} starts with ${c.stem}`)
      assert.match(rendered.slice(c.stem!.length), /^[0-9A-Z]{4}$/)
      const old = legacyDatedRandom(c.prefix, date, 'A7X2')
      assert.equal(rendered.slice(0, -4), old.slice(0, -4), 'everything but the random tail is what the old code wrote')
      assert.equal(rendered.length, old.length)
    }
  })
}

test('the default of a type tracks the prefix of Settings > Company > Numbering, so editing a prefix still works', () => {
  const a = effectiveParsedPattern('purchase_order', null, 'PO-')!
  const b = effectiveParsedPattern('purchase_order', null, 'BUY-')!
  assert.equal(patternText(a.segments), 'PO-{YYYY}{MM}{DD}-{RAND:4}')
  assert.equal(patternText(b.segments), 'BUY-{YYYY}{MM}{DD}-{RAND:4}')
})

test('an operator pattern replaces the default, prefix included', () => {
  const p = effectiveParsedPattern('purchase_order', 'PUR{SEQ:4}', 'PO-')!
  assert.equal(patternText(p.segments), 'PUR{SEQ:4}')
})
