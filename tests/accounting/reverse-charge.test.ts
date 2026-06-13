import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveSalesLineTaxType } from '@/lib/accounting/reverse-charge'

test('swaps to the reverse-charge tax type when the rate is reverse-charge and the setting is set', () => {
  assert.equal(
    resolveSalesLineTaxType({
      baseTaxType: 'OUTPUT2',
      reverseCharge: true,
      reverseChargeSalesTaxType: 'ECOUTPUTSERVICES',
    }),
    'ECOUTPUTSERVICES',
  )
})

test('keeps the base tax type when the rate is not reverse-charge', () => {
  assert.equal(
    resolveSalesLineTaxType({
      baseTaxType: 'OUTPUT2',
      reverseCharge: false,
      reverseChargeSalesTaxType: 'ECOUTPUTSERVICES',
    }),
    'OUTPUT2',
  )
})

test('keeps the base tax type when reverse-charge but the setting is empty (defensive default)', () => {
  assert.equal(
    resolveSalesLineTaxType({
      baseTaxType: 'OUTPUT2',
      reverseCharge: true,
      reverseChargeSalesTaxType: '',
    }),
    'OUTPUT2',
  )
})

test('returns undefined when there is no base tax type and no swap applies', () => {
  assert.equal(
    resolveSalesLineTaxType({
      baseTaxType: null,
      reverseCharge: false,
      reverseChargeSalesTaxType: '',
    }),
    undefined,
  )
})

test('swap wins even when the base tax type is missing', () => {
  // A reverse-charge line with no own accountingTaxType still gets tagged.
  assert.equal(
    resolveSalesLineTaxType({
      baseTaxType: undefined,
      reverseCharge: true,
      reverseChargeSalesTaxType: 'ECOUTPUTSERVICES',
    }),
    'ECOUTPUTSERVICES',
  )
})

test('handles null reverseCharge as not reverse-charge', () => {
  assert.equal(
    resolveSalesLineTaxType({
      baseTaxType: 'OUTPUT2',
      reverseCharge: null,
      reverseChargeSalesTaxType: 'ECOUTPUTSERVICES',
    }),
    'OUTPUT2',
  )
})
