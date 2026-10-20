import assert from 'node:assert/strict'
import test from 'node:test'

import { canonicalKey, digest8, identityToken, isSafeTokenShape, keyToken, type SafeToken } from '../../lib/reconciliation-pack/identity.ts'

// Credential-shaped canaries are assembled at run time so the repository holds no literal that a secret scanner would flag.
const STRIPE_SHAPED = ['sk', 'live', 'abcdef123456'].join('_')
const BEARER_SHAPED = ['Bear', 'er abcdef0123456789'].join('')

const CUID = 'cmabcdefghijklmnopqrstuvw'

test('a cuid, a numeric vendor id, a validated SKU and a warehouse code are kept as they are', () => {
  assert.equal(identityToken('ims-id', CUID), CUID)
  assert.equal(identityToken('vendor-id', '123456'), '123456')
  assert.equal(identityToken('vendor-id', 987), '987')
  assert.equal(identityToken('sku', 'ABC-100/x.2_y'), 'ABC-100/x.2_y')
  assert.equal(identityToken('warehouse', 'MAIN_1'), 'MAIN_1')
})

test('everything else is a digest, never the raw string', () => {
  const hostile = [
    'victim@example.com', 'https://evil.example/path?token=abc', BEARER_SHAPED, STRIPE_SHAPED,
    'password=hunter2', 'has space', 'x'.repeat(41), 'eyJhbGciOiJIUzI1NiJ9', 'a'.repeat(32), '', 'line\nbreak', 'ünïcode',
  ]
  for (const raw of hostile) {
    const token = identityToken('sku', raw)
    assert.equal(token, `sku#${digest8(raw)}`, raw)
    assert.ok(!token.includes(raw) || raw === '', raw)
    assert.ok(isSafeTokenShape(token), token)
  }
  assert.equal(identityToken('ims-id', 'not-a-cuid@x'), `ims-id#${digest8('not-a-cuid@x')}`)
  assert.equal(identityToken('vendor-id', '12ab'), `vendor-id#${digest8('12ab')}`)
  assert.equal(identityToken('vendor-id', '1'.repeat(19)), `vendor-id#${digest8('1'.repeat(19))}`)
  assert.equal(identityToken('warehouse', 'main'), `warehouse#${digest8('main')}`)
})

test('a non-string, non-integer value is unreadable, not stringified', () => {
  for (const raw of [null, undefined, {}, [], -1, 1.5, NaN, Symbol.iterator]) assert.equal(identityToken('sku', raw), 'sku#unreadable')
})

test('a composite key joins sanitised parts; the internal canonical key cannot collide across part boundaries', () => {
  assert.equal(keyToken([{ kind: 'sku', raw: 'A1' }, { kind: 'warehouse', raw: 'MAIN' }]), 'A1|MAIN')
  assert.equal(keyToken([{ kind: 'sku', raw: 'a@b' }, { kind: 'warehouse', raw: 'MAIN' }]), `sku#${digest8('a@b')}|MAIN`)
  assert.equal(keyToken([]), 'key#empty')
  assert.notEqual(canonicalKey([{ kind: 'sku', raw: 'a' }, { kind: 'sku', raw: 'bc' }]), canonicalKey([{ kind: 'sku', raw: 'ab' }, { kind: 'sku', raw: 'c' }]))
  assert.notEqual(canonicalKey([{ kind: 'sku', raw: 'a' }]), canonicalKey([{ kind: 'warehouse', raw: 'a' }]))
})

test('a token read back from a file is re-validated: shape and the secret screen both apply', () => {
  assert.ok(isSafeTokenShape('A1|MAIN'))
  assert.ok(isSafeTokenShape('key#empty'))
  assert.ok(isSafeTokenShape(`sku#${digest8('x')}`))
  for (const bad of ['a@b', 'https://x', STRIPE_SHAPED, 'a b', '', 'sku#XYZ', 'sku#1234567', 'A1||B', 'A1|', 'x'.repeat(41), 42, null]) assert.equal(isSafeTokenShape(bad), false, String(bad))
})

test('a plain string is not assignable to SafeToken (compile-time guard)', () => {
  // @ts-expect-error a raw string must not be usable where a sanitised token is required
  const forged: SafeToken = 'victim@example.com'
  assert.equal(typeof forged, 'string')
})
