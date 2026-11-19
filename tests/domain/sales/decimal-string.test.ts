import assert from 'node:assert/strict'
import test from 'node:test'
import { decimalStringSign, roundDecimalString, sumDecimalStrings } from '@/lib/domain/sales/decimal-string'

test('exact sums carry every digit (o3d-0868)', () => {
  assert.equal(sumDecimalStrings(['90071992547409.971', '90071992547409.971']), '180143985094819.942')
  assert.equal(sumDecimalStrings(['0.1', '0.2']), '0.3')
  assert.equal(sumDecimalStrings(['5', '-7.25']), '-2.25')
  assert.equal(sumDecimalStrings([]), '0')
  assert.equal(sumDecimalStrings(['0.5', '-0.5']), '0')
})

test('directional rounding to cents is exact', () => {
  assert.equal(roundDecimalString('90071992547409.971', 'ceil'), '90071992547409.98')
  assert.equal(roundDecimalString('90071992547409.971', 'floor'), '90071992547409.97')
  assert.equal(roundDecimalString('0.014', 'ceil'), '0.02')
  assert.equal(roundDecimalString('0.014', 'nearest'), '0.01')
  assert.equal(roundDecimalString('0.015', 'nearest'), '0.02')
  assert.equal(roundDecimalString('-0.015', 'nearest'), '-0.02')
  assert.equal(roundDecimalString('-0.011', 'ceil'), '-0.01')
  assert.equal(roundDecimalString('-0.011', 'floor'), '-0.02')
  assert.equal(roundDecimalString('-0.001', 'ceil'), '0.00')
  assert.equal(roundDecimalString('3', 'ceil'), '3.00')
  assert.equal(roundDecimalString('0.14', 'ceil'), '0.14')
})

test('sign', () => {
  assert.equal(decimalStringSign('-0.0'), 0)
  assert.equal(decimalStringSign('-1'), -1)
  assert.equal(decimalStringSign('2.5'), 1)
})
