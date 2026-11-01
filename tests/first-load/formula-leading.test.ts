import assert from 'node:assert/strict'
import test from 'node:test'

import { FORMULA_LEADING } from '../../lib/first-load/validate.ts'

test('every leading = @ + - tab and carriage return is formula-capable, whatever follows it', () => {
  for (const cell of ['=1+1', '@SUM(A1)', '+1', '+1+1', '+.5', '-1', '-1+1', '-.5', '-5V cable', '- Spacer', '-cmd|x', '+cmd|x', '\tx', '\rx']) {
    assert.equal(FORMULA_LEADING.test(cell), true, JSON.stringify(cell))
  }
})

test('text with a sign, equals or at-sign anywhere but the first character is not formula-capable', () => {
  for (const cell of ['', 'a-1', 'a+1', 'x=1', 'name@host', ' -1', '1-1', '5V', '.5']) {
    assert.equal(FORMULA_LEADING.test(cell), false, JSON.stringify(cell))
  }
})
