import assert from 'node:assert/strict'
import test from 'node:test'
import * as fieldsNs from '../lib/trade/hs-classification-fields.ts'

const hf = 'default' in fieldsNs
  ? fieldsNs.default as typeof import('../lib/trade/hs-classification-fields.ts')
  : fieldsNs

test('same classification-relevant fields produce the same hash (normalised)', () => {
  const a = hf.hsClassificationFieldsHash({ name: 'NEMA 17 Stepper Motor', description: 'For 3D printers', categoryPath: 'Motors' })
  const b = hf.hsClassificationFieldsHash({ name: '  nema 17   stepper motor ', description: 'for 3d printers', categoryPath: 'motors' })
  assert.equal(a, b) // whitespace + case normalised
})

test('changing name, description, or category changes the hash', () => {
  const base = hf.hsClassificationFieldsHash({ name: 'Widget', description: 'A', categoryPath: 'Cat' })
  assert.notEqual(base, hf.hsClassificationFieldsHash({ name: 'Widget X', description: 'A', categoryPath: 'Cat' }))
  assert.notEqual(base, hf.hsClassificationFieldsHash({ name: 'Widget', description: 'B', categoryPath: 'Cat' }))
  assert.notEqual(base, hf.hsClassificationFieldsHash({ name: 'Widget', description: 'A', categoryPath: 'Other' }))
})

test('null/undefined description and category are stable and distinct from empty-ish content', () => {
  const none = hf.hsClassificationFieldsHash({ name: 'Widget' })
  assert.equal(none, hf.hsClassificationFieldsHash({ name: 'Widget', description: null, categoryPath: null }))
  assert.equal(typeof none, 'string')
  assert.equal(none.length, 64) // sha-256 hex
})

test('shouldInvalidateHsProposal: stale when hash differs or is missing (pre-migration heal)', () => {
  assert.equal(hf.shouldInvalidateHsProposal('abc', 'abc'), false) // unchanged
  assert.equal(hf.shouldInvalidateHsProposal('abc', 'def'), true) // fields changed
  assert.equal(hf.shouldInvalidateHsProposal(null, 'def'), true) // pre-migration null baseline
  assert.equal(hf.shouldInvalidateHsProposal(undefined, 'def'), true)
})

test('shouldSkipHsReclassification: skip only a fresh, hashed, non-forced proposal', () => {
  assert.equal(hf.shouldSkipHsReclassification('abc', 'abc', false), true) // fresh -> skip API
  assert.equal(hf.shouldSkipHsReclassification('abc', 'abc', true), false) // force bypasses
  assert.equal(hf.shouldSkipHsReclassification('abc', 'def', false), false) // fields changed -> re-run
  assert.equal(hf.shouldSkipHsReclassification(null, 'def', false), false) // no baseline -> re-run
})
