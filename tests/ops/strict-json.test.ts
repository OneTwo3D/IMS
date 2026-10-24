import assert from 'node:assert/strict'
import test from 'node:test'

import { parseAcceptanceFile } from '../../lib/ops/readiness-gate.ts'
import { DuplicateMemberError, parseJsonNoDuplicates } from '../../lib/ops/strict-json.ts'
import { NOW, acceptanceText, validAcceptance } from '../helpers/readiness-gate-fixtures.ts'

/** THE DUPLICATE-AWARE PARSER and the readiness gate's use of it. Mutations are listed in the PR. */

const dup = (text: string) => assert.throws(() => parseJsonNoDuplicates(text), DuplicateMemberError, text)
const same = (text: string) => assert.deepEqual(parseJsonNoDuplicates(text), JSON.parse(text), text)

// [mutation: the top-level / nested / array-element tracking removed, or the name set shared across objects]
test('a member named twice is refused at any depth, in arrays of objects too; the same name in two different objects is fine', () => {
  dup('{"a":1,"a":2}')
  dup('{"a":{"b":1,"b":2}}')
  dup('{"list":[{"x":1},{"y":1,"y":2}]}')
  dup('[[{"k":1,"k":1}]]')
  dup('{"a":1,"b":{"a":1},"a":3}')
  same('{"a":1,"b":{"a":1},"c":[{"a":1},{"a":2}]}')
  same('{"a":{"a":{"a":1}}}')
  same('[{"a":1},{"a":1}]')
  same('{}')
  same('[]')
  same(' { "a" : [ 1 , 2.5e3 , true , false , null , "s\\n" ] } ')
})

// [mutation: the name compared undecoded / without NFC]
test('names are compared decoded and under NFC: an escaped spelling is the same member, and so are precomposed and decomposed forms', () => {
  dup('{"a":1,"\\u0061":2}')
  dup('{"\\u0061":1,"a":2}')
  dup('{"a\\"b":1,"a\\u0022b":2}')
  dup('{"café":1,"café":2}')
  dup('{"caf\\u00e9":1,"cafe\\u0301":2}')
  same('{"a":1,"A":2,"a ":3}')
})

// [mutation: the scan's own syntax errors let through / the final JSON.parse removed]
test('anything that is not JSON is refused (a SyntaxError, not a duplicate), and what is returned is exactly JSON.parse\'s value', () => {
  for (const text of ['', '{', '{"a"}', '{"a":1,}', '[1,]', '{"a":1} x', "{'a':1}", '{"a":01}', '{"a":tru}', '"abc', '{"a":1 "b":2}', '{a:1}']) {
    assert.throws(() => parseJsonNoDuplicates(text), (e) => !(e instanceof DuplicateMemberError) && e instanceof SyntaxError, text)
  }
  assert.throws(() => parseJsonNoDuplicates(`${'['.repeat(100)}${']'.repeat(100)}`), SyntaxError)
  assert.deepEqual(parseJsonNoDuplicates('{"__proto__":{"x":1}}'), JSON.parse('{"__proto__":{"x":1}}'))
})

// [mutation: parseAcceptanceFile back on JSON.parse]
test('THE GATE: a warning acceptance with expiresAt named twice (expired and current, either order) accepts nothing and the file is rejected', () => {
  const good = JSON.stringify(validAcceptance('w-1'))
  const expired = new Date(NOW.getTime() - 86_400_000).toISOString()
  const current = new Date(NOW.getTime() + 30 * 86_400_000).toISOString()
  const withTwo = (first: string, second: string) => {
    const base = JSON.stringify({ ...validAcceptance('w-1'), expiresAt: 'PLACEHOLDER' })
    const entry = base.replace('"expiresAt":"PLACEHOLDER"', `"expiresAt":"${first}","expiresAt":"${second}"`)
    assert.notEqual(entry, base)
    return `{"schemaVersion":1,"acceptances":[${entry}]}`
  }
  assert.equal(parseAcceptanceFile(acceptanceText([validAcceptance('w-1')])).status, 'ok')
  assert.ok(good.length > 0)
  for (const text of [withTwo(expired, current), withTwo(current, expired), withTwo(current, current)]) {
    const parsed = parseAcceptanceFile(text)
    assert.equal(parsed.status, 'rejected')
    assert.equal(parsed.entries.length, 0)
  }
  // nested at the file level too, and a repeated top-level member
  assert.equal(parseAcceptanceFile('{"schemaVersion":1,"schemaVersion":1,"acceptances":[]}').status, 'rejected')
  assert.equal(parseAcceptanceFile('{"schemaVersion":1,"acceptances":[],"acceptances":[]}').status, 'rejected')
})
