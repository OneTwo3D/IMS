import { test } from 'node:test'
import assert from 'node:assert/strict'

import { clampCustomsDescription, CUSTOMS_DESCRIPTION_MAX } from '@/lib/trade/customs-description'

test('short descriptions pass through unchanged', () => {
  assert.equal(clampCustomsDescription('brass nozzle, 3D printer extruder'), 'brass nozzle, 3D printer extruder')
})

test('nullish/blank input returns empty string', () => {
  assert.equal(clampCustomsDescription(null), '')
  assert.equal(clampCustomsDescription(undefined), '')
  assert.equal(clampCustomsDescription('   '), '')
})

test('long descriptions are clamped to <= 50 chars on a word boundary', () => {
  const long = 'linear stepper motor with integrated leadscrew, 42mm frame, 1.68A'
  const clamped = clampCustomsDescription(long)
  assert.ok(clamped.length <= CUSTOMS_DESCRIPTION_MAX, `len=${clamped.length}`)
  // prefix of the original, cut at a non-alphanumeric boundary (no mid-word cut)
  assert.ok(long.startsWith(clamped))
  const boundaryChar = long.charAt(clamped.length)
  assert.ok(!/[A-Za-z0-9]/.test(boundaryChar), `boundary char was '${boundaryChar}'`)
})

test('no trailing separator is left after clamping', () => {
  const clamped = clampCustomsDescription('electrical connector, up to 1000 volts, panel-mount housing')
  assert.equal(clamped, clamped.replace(/[\s,;:-]+$/, ''))
  assert.ok(clamped.length <= CUSTOMS_DESCRIPTION_MAX)
})

test('internal whitespace is collapsed', () => {
  assert.equal(clampCustomsDescription('brass   nozzle'), 'brass nozzle')
})
