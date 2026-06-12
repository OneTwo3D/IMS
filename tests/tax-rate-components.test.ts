import assert from 'node:assert/strict'
import test from 'node:test'

import {
  effectiveTaxRateFromComponents,
  normalizeTaxRateComponents,
  taxRateIsCompoundProfile,
} from '@/lib/tax/tax-rate-components'
import { pickTaxRate, type TaxRateCandidate } from '@/lib/tax/resolve-rate'

const baseCandidate = {
  id: 'tax-gb-standard',
  name: 'GB Compound Standard',
  rate: 0.155,
  accountingTaxType: 'OUTPUT2',
  countryCode: 'gb',
  taxCategory: 'STANDARD',
  usedFor: 'SALES',
  isCompound: true,
  reverseCharge: false,
  reportingCategory: 'DOMESTIC',
  components: [
    {
      name: 'Federal',
      rate: 0.1,
      compoundOnPrevious: false,
      accountingTaxType: 'OUTPUT-FED',
      sortOrder: 0,
    },
    {
      name: 'Provincial',
      rate: 0.05,
      compoundOnPrevious: true,
      accountingTaxType: 'OUTPUT-PROV',
      sortOrder: 1,
    },
  ],
} satisfies TaxRateCandidate

test('effectiveTaxRateFromComponents calculates ordered compound-on-previous totals', () => {
  assert.equal(effectiveTaxRateFromComponents(baseCandidate.components), 0.155)
  assert.equal(taxRateIsCompoundProfile(baseCandidate.components), true)
})

test('normalizeTaxRateComponents sorts and drops invalid component rows', () => {
  assert.deepEqual(normalizeTaxRateComponents([
    { name: '  Provincial ', rate: 0.05, compoundOnPrevious: true, sortOrder: 2, accountingTaxType: ' PROV ' },
    { name: '', rate: 0.2 },
    { name: 'Federal', rate: 0.1, sortOrder: 1 },
    { name: 'Invalid', rate: Number.NaN },
  ]), [
    {
      name: 'Federal',
      rate: 0.1,
      compoundOnPrevious: false,
      accountingTaxType: null,
      sortOrder: 1,
      active: true,
    },
    {
      name: 'Provincial',
      rate: 0.05,
      compoundOnPrevious: true,
      accountingTaxType: 'PROV',
      sortOrder: 2,
      active: true,
    },
  ])
})

test('pickTaxRate returns component and reporting metadata for compound profiles', () => {
  const resolved = pickTaxRate({
    productCategory: 'STANDARD',
    destinationCountry: 'GB',
    usedFor: 'SALES',
    rates: [baseCandidate],
    orderDefault: {
      id: 'fallback',
      name: 'Fallback',
      rate: 0.2,
      accountingTaxType: 'OUTPUT2',
    },
  })

  assert.equal(resolved.taxRateId, 'tax-gb-standard')
  assert.equal(resolved.taxRateValue, 0.155)
  assert.equal(resolved.isCompound, true)
  assert.equal(resolved.reverseCharge, false)
  assert.equal(resolved.reportingCategory, 'DOMESTIC')
  assert.deepEqual(resolved.components, baseCandidate.components)
})

test('pickTaxRate can represent reverse-charge and OSS reporting tax profiles', () => {
  const reverseChargeRate = {
    ...baseCandidate,
    id: 'tax-eu-rc',
    name: 'EU Reverse Charge',
    rate: 0,
    accountingTaxType: 'OUTPUTREVERSE',
    countryCode: 'de',
    isCompound: false,
    reverseCharge: true,
    reportingCategory: 'REVERSE_CHARGE',
    components: [],
  } satisfies TaxRateCandidate

  const resolved = pickTaxRate({
    productCategory: 'STANDARD',
    destinationCountry: 'DE',
    usedFor: 'SALES',
    rates: [reverseChargeRate],
    orderDefault: {
      id: 'fallback',
      name: 'Fallback',
      rate: 0.2,
      accountingTaxType: 'OUTPUT2',
    },
  })

  assert.equal(resolved.taxRateId, 'tax-eu-rc')
  assert.equal(resolved.taxRateValue, 0)
  assert.equal(resolved.reverseCharge, true)
  assert.equal(resolved.reportingCategory, 'REVERSE_CHARGE')
  assert.equal(resolved.accountingTaxType, 'OUTPUTREVERSE')
})
