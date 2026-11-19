import assert from 'node:assert/strict'
import test from 'node:test'

import { looseIdentityEmail, normaliseIdentityEmail } from '@/lib/domain/crm/identity-key'

test('strict key lower-cases and trims', () => {
  assert.equal(normaliseIdentityEmail('  Jane.Doe@Example.COM \n'), 'jane.doe@example.com')
})

test('strict key NFC-normalises (decomposed and composed spellings are one key)', () => {
  const decomposed = 'jose\u0301@example.com'
  const composed = 'jos\u00e9@example.com'
  assert.equal(normaliseIdentityEmail(decomposed), composed)
  assert.equal(normaliseIdentityEmail(decomposed), normaliseIdentityEmail(composed))
  assert.equal(normaliseIdentityEmail('\u212Aelvin@example.com'), 'kelvin@example.com', 'the Kelvin sign composes to K, then lower-cases')
})

test('lower-casing is ASCII only (the SQL twin lower-cases ASCII only), so a non-ASCII capital is NOT folded', () => {
  assert.equal(normaliseIdentityEmail('JOS\u00c9@Example.com'), 'jos\u00c9@example.com')
  assert.notEqual(normaliseIdentityEmail('JOS\u00c9@example.com'), normaliseIdentityEmail('jos\u00e9@example.com'))
})

test('strict key trims every Unicode white-space character at the ends, and rejects internal white space', () => {
  for (const ws of ['\t', '\n', '\r', '\v', '\f', '\u00a0', '\u2003', '\u3000', '\ufeff', '\u2028']) {
    assert.equal(normaliseIdentityEmail(`${ws}jane@example.com${ws}`), 'jane@example.com', JSON.stringify(ws))
    assert.equal(normaliseIdentityEmail(`ja${ws}ne@example.com`), null, JSON.stringify(ws))
  }
})

test('strict key is null for null, undefined, empty and blank', () => {
  for (const v of [null, undefined, '', '   ']) assert.equal(normaliseIdentityEmail(v), null)
})

test('strict key is null for placeholders', () => {
  assert.equal(normaliseIdentityEmail('deleted@site.invalid'), null)
  assert.equal(normaliseIdentityEmail('Erased@Erased.INVALID'), null)
})

test('strict key is null without exactly one @', () => {
  for (const v of ['nobody', 'a@b@c.com', '@example.com', 'a@', '@']) assert.equal(normaliseIdentityEmail(v), null)
})

test('strict key is null with internal whitespace', () => {
  assert.equal(normaliseIdentityEmail('jane doe@example.com'), null)
  assert.equal(normaliseIdentityEmail('jane@exa\tmple.com'), null)
})

test('strict key keeps plus tags and gmail dots', () => {
  assert.equal(normaliseIdentityEmail('Jane+Shop@Example.com'), 'jane+shop@example.com')
  assert.equal(normaliseIdentityEmail('j.a.n.e+x@gmail.com'), 'j.a.n.e+x@gmail.com')
})

test('loose key drops the plus tag', () => {
  assert.equal(looseIdentityEmail('Jane+Shop@Example.com'), 'jane@example.com')
})

test('loose key keeps dots on non-gmail domains', () => {
  assert.equal(looseIdentityEmail('j.ane@example.com'), 'j.ane@example.com')
})

test('loose key folds gmail dots, plus tags and the googlemail alias', () => {
  assert.equal(looseIdentityEmail('J.a.N.e+x@Gmail.com'), 'jane@gmail.com')
  assert.equal(looseIdentityEmail('ja.ne@googlemail.com'), 'jane@gmail.com')
})

test('loose key is null where the strict key is null or the local part vanishes', () => {
  assert.equal(looseIdentityEmail(null), null)
  assert.equal(looseIdentityEmail('x@site.invalid'), null)
  assert.equal(looseIdentityEmail('+tag@example.com'), null)
})
