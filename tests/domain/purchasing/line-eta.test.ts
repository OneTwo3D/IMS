import assert from 'node:assert/strict'
import { test } from 'node:test'
import { effectiveLineEta, lineEtaDiffersFromHeader, parseLineEtaInput } from '@/lib/domain/purchasing/line-eta'

const HEADER = new Date('2026-12-01T00:00:00.000Z')
const LINE = new Date('2026-12-15T00:00:00.000Z')

test('a line with its own date uses it, whatever the header says', () => {
  assert.equal(effectiveLineEta(LINE, HEADER)?.toISOString(), LINE.toISOString())
  assert.equal(effectiveLineEta(LINE, null)?.toISOString(), LINE.toISOString())
})

test('a line with no date inherits the header; with neither the result is null', () => {
  assert.equal(effectiveLineEta(null, HEADER)?.toISOString(), HEADER.toISOString())
  assert.equal(effectiveLineEta(undefined, HEADER)?.toISOString(), HEADER.toISOString())
  assert.equal(effectiveLineEta(null, null), null)
  assert.equal(effectiveLineEta(undefined, undefined), null)
})

test('ISO strings are accepted and an unparseable value counts as unset', () => {
  assert.equal(effectiveLineEta('2026-12-15T00:00:00.000Z', HEADER)?.toISOString(), LINE.toISOString())
  assert.equal(effectiveLineEta('', '2026-12-01T00:00:00.000Z')?.toISOString(), HEADER.toISOString())
  assert.equal(effectiveLineEta('not a date', HEADER)?.toISOString(), HEADER.toISOString())
})

test('lineEtaDiffersFromHeader is true only for an own date on another day', () => {
  assert.equal(lineEtaDiffersFromHeader(null, HEADER), false)
  assert.equal(lineEtaDiffersFromHeader(new Date('2026-12-01T09:30:00.000Z'), HEADER), false)
  assert.equal(lineEtaDiffersFromHeader(LINE, HEADER), true)
  assert.equal(lineEtaDiffersFromHeader(LINE, null), true)
})

test('parseLineEtaInput: blank inherits, a date parses, garbage throws', () => {
  assert.equal(parseLineEtaInput(undefined), null)
  assert.equal(parseLineEtaInput(null), null)
  assert.equal(parseLineEtaInput('  '), null)
  assert.equal(parseLineEtaInput('2026-12-15')?.toISOString(), LINE.toISOString())
  assert.throws(() => parseLineEtaInput('soon'), /Invalid line delivery date/)
})
