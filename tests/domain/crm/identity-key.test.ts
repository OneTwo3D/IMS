import assert from 'node:assert/strict'
import test from 'node:test'

import { looseIdentityEmail, normaliseIdentityEmail } from '@/lib/domain/crm/identity-key'

test('strict key lower-cases and trims', () => {
  assert.equal(normaliseIdentityEmail('  Jane.Doe@Example.COM \n'), 'jane.doe@example.com')
})

test('strict key NFC-normalises', () => {
  const decomposed = 'josé@example.com'
  assert.equal(normaliseIdentityEmail(decomposed), 'josé@example.com')
  assert.equal(normaliseIdentityEmail(decomposed), normaliseIdentityEmail('JOSÉ@example.com'))
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
