import assert from 'node:assert/strict'
import test from 'node:test'
import * as cnValidateNs from '../lib/trade/cn-validate.ts'

const cn = 'default' in cnValidateNs
  ? cnValidateNs.default as typeof import('../lib/trade/cn-validate.ts')
  : cnValidateNs

test('isDeclarableCn8 accepts 8-digit codes present in the 2026 CN list', () => {
  assert.equal(cn.isDeclarableCn8('01012100'), true)
  assert.equal(cn.isDeclarableCn8('27073000'), true)
  assert.equal(cn.isDeclarableCn8('85285900'), true)
})

test('isDeclarableCn8 rejects 8-digit codes absent from the 2026 CN list', () => {
  assert.equal(cn.isDeclarableCn8('99999999'), false)
  assert.equal(cn.isDeclarableCn8('00000000'), false)
})

test('isDeclarableCn8 strips separators but requires exactly 8 digits', () => {
  assert.equal(cn.isDeclarableCn8('0101.2100'), true) // dots/spaces stripped -> 01012100
  assert.equal(cn.isDeclarableCn8(' 2707 3000 '), true)
  assert.equal(cn.isDeclarableCn8('010121'), false) // 6 digits, too short
  assert.equal(cn.isDeclarableCn8('0101210'), false) // 7 digits, too short
  assert.equal(cn.isDeclarableCn8('010121000'), false) // overlong -> NOT truncated to a valid prefix
  assert.equal(cn.isDeclarableCn8('0101210A'), false) // alpha char -> only 7 digits remain
  assert.equal(cn.isDeclarableCn8('abcdefgh'), false) // no digits at all
})

test('isDeclarableCn8 treats null / undefined / empty as not declarable', () => {
  assert.equal(cn.isDeclarableCn8(null), false)
  assert.equal(cn.isDeclarableCn8(undefined), false)
  assert.equal(cn.isDeclarableCn8(''), false)
  assert.equal(cn.isDeclarableCn8('   '), false)
})

test('normalizeCn8 strips non-digits and keeps the first 8', () => {
  assert.equal(cn.normalizeCn8('0101.2100'), '01012100')
  assert.equal(cn.normalizeCn8('010121000'), '01012100') // first 8 of an overlong string
  assert.equal(cn.normalizeCn8('abc'), '')
})

test('the 2026 CN reference has the expected code count', () => {
  assert.equal(cn.cn2026CodeCount(), 9791)
})
