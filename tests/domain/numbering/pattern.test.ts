import assert from 'node:assert/strict'
import test from 'node:test'
import { parsePattern, renderPattern, scopeKeyFor, seqMatcherFor, literalPrefixFor, randomText } from '../../../lib/domain/numbering/pattern.ts'

/**
 * The numbering grammar: tokens, explicit padding (never implicit), validation, the counter's period and how a
 * number is read back to find the highest counter in use.
 */

function parse(pattern: string) {
  const r = parsePattern(pattern)
  assert.ok(r.ok, `expected "${pattern}" to parse: ${r.ok ? '' : r.error}`)
  return r.parsed
}
const D = new Date(Date.UTC(2026, 10, 7, 9, 30)) // 2026-11-07

test('every token renders, and {SEQ} is NOT padded unless the width is written', () => {
  assert.equal(renderPattern(parse('{YYYY}/{YY}/{MM}/{DD}-{SEQ}'), { date: D, basis: 'utc', seq: 7 }), '2026/26/11/07-7')
  assert.equal(renderPattern(parse('INV-{SEQ}'), { date: D, basis: 'utc', seq: 42 }), 'INV-42', 'no implicit leading zeros')
  assert.equal(renderPattern(parse('INV-{SEQ:6}'), { date: D, basis: 'utc', seq: 42 }), 'INV-000042')
  assert.equal(renderPattern(parse('{SEQ:3}'), { date: D, basis: 'utc', seq: 123456 }), '123456', 'a wider number is never truncated')
  assert.equal(renderPattern(parse('{SEQ:1}'), { date: D, basis: 'utc', seq: 5 }), '5')
})

test('{RAND:n} draws n characters from 0-9A-Z', () => {
  const out = renderPattern(parse('X-{RAND:4}'), { date: D, basis: 'utc' })
  assert.match(out, /^X-[0-9A-Z]{4}$/)
  assert.equal(randomText(3, () => 0), '000')
  assert.equal(randomText(3, () => 0.999999), 'ZZZ')
})

test('the date tokens read the clock the type was written against (utc or local)', () => {
  const nearMidnight = new Date(Date.UTC(2026, 11, 31, 23, 30))
  assert.equal(renderPattern(parse('{YYYY}{MM}{DD}-{SEQ}'), { date: nearMidnight, basis: 'utc', seq: 1 }), '20261231-1')
  // local differs only where the process TZ is not UTC: assert it equals the local getters, whatever they are
  const local = renderPattern(parse('{YYYY}-{MM}-{DD}-{SEQ}'), { date: nearMidnight, basis: 'local', seq: 1 })
  assert.equal(local, `${nearMidnight.getFullYear()}-${String(nearMidnight.getMonth() + 1).padStart(2, '0')}-${String(nearMidnight.getDate()).padStart(2, '0')}-1`)
})

test('a pattern is refused unless it can give every document a different number', () => {
  for (const bad of ['', 'PO-', '{YYYY}-{MM}', 'PO-{SEQ}-{SEQ}']) assert.equal(parsePattern(bad).ok, false, bad)
})

test('malformed tokens, bad widths and forbidden characters are refused with a reason', () => {
  const cases: Array<[string, RegExp]> = [
    ['PO-{SEQ', /no closing/],
    ['PO-SEQ}', /no opening/],
    ['PO-{FOO}', /not a token/],
    ['PO-{seq}', /not a token/],
    ['PO-{SEQ:0}', /between/],
    ['PO-{SEQ:13}', /between/],
    ['PO-{RAND:0}', /between/],
    ['PO-{RAND:9}', /between/],
    ['PO-{SEQ:x}', /not a token/],
    ['PO {SEQ}', /not allowed/],
    ['PO,{SEQ}', /not allowed/],
    ['PO"{SEQ}', /not allowed/],
    ['x'.repeat(70) + '{SEQ}', /longer than/],
  ]
  for (const [pattern, message] of cases) {
    const r = parsePattern(pattern)
    assert.equal(r.ok, false, pattern)
    if (!r.ok) assert.match(r.error, message, pattern)
  }
})

test('the counter restarts with the finest date token: year, month, day, or never', () => {
  assert.equal(parse('{SEQ}').scope, 'none')
  assert.equal(parse('{YYYY}-{SEQ}').scope, 'year')
  assert.equal(parse('{YY}{MM}-{SEQ}').scope, 'month')
  assert.equal(parse('{YYYY}{MM}{DD}-{SEQ}').scope, 'day')
  assert.equal(scopeKeyFor(parse('{SEQ}'), D, 'utc'), '')
  assert.equal(scopeKeyFor(parse('{YYYY}-{SEQ}'), D, 'utc'), '2026')
  assert.equal(scopeKeyFor(parse('{YY}{MM}-{SEQ}'), D, 'utc'), '26-11')
  assert.notEqual(scopeKeyFor(parse('{YYYY}{MM}-{SEQ}'), D, 'utc'), scopeKeyFor(parse('{YYYY}{MM}-{SEQ}'), new Date(Date.UTC(2026, 11, 1)), 'utc'))
})

test('a number is read back to its counter inside one period, padded or not, and nothing else matches', () => {
  const p = parse('CN-{YYYY}-{SEQ:5}')
  const m = seqMatcherFor(p, '2026')!
  assert.equal(m.exec('CN-2026-00042')?.[1], '00042')
  assert.equal(m.exec('CN-2026-7')?.[1], '7', 'a number written without padding still reads back')
  assert.equal(m.exec('CN-2025-00042'), null, 'another year is another period')
  assert.equal(m.exec('XCN-2026-00042'), null)
  assert.equal(m.exec('CN-2026-00042X'), null)
  assert.equal(literalPrefixFor(p, '2026'), 'CN-2026-')
  assert.equal(seqMatcherFor(parse('A-{RAND:4}'), ''), null, 'no counter, nothing to read back')
  const dotted = seqMatcherFor(parse('A.{SEQ}/{YY}'), '26')!
  assert.equal(dotted.exec('A.9/26')?.[1], '9')
  assert.equal(dotted.exec('AX9/26'), null, 'a dot in a pattern is a dot, not a wildcard')
})
