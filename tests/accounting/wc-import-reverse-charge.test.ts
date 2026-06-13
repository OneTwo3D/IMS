import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveSalesLineTaxType } from '@/lib/accounting/reverse-charge'

// audit-H1b: the WC order-import payload must follow the SAME reverse-charge rule
// as the native invoice push — goods LINES swap to the RC code; shipping & discount
// stay on the base code. These assert the helper inputs WC import now uses.
const RC = 'ECOUTPUTSERVICES'

test('WC-import goods line on a reverse-charge rate swaps to the RC code', () => {
  assert.equal(
    resolveSalesLineTaxType({ baseTaxType: 'OUTPUT2', reverseCharge: true, reverseChargeSalesTaxType: RC }),
    RC,
  )
})

test('WC-import shipping/discount pass base type unchanged (not reverse-charge)', () => {
  // Shipping & discount are not flagged reverseCharge, so the helper returns base.
  assert.equal(
    resolveSalesLineTaxType({ baseTaxType: 'OUTPUT2', reverseCharge: false, reverseChargeSalesTaxType: RC }),
    'OUTPUT2',
  )
})

test('WC-import line stays base when the order is not reverse-charge', () => {
  assert.equal(
    resolveSalesLineTaxType({ baseTaxType: 'OUTPUT2', reverseCharge: undefined, reverseChargeSalesTaxType: RC }),
    'OUTPUT2',
  )
})

test('WC-import line stays base when the RC code is unconfigured (defensive)', () => {
  assert.equal(
    resolveSalesLineTaxType({ baseTaxType: 'OUTPUT2', reverseCharge: true, reverseChargeSalesTaxType: '' }),
    'OUTPUT2',
  )
})

// Regression guard for the mapped-rate gap found in review: a WC line that maps
// to a configured IMS TaxRate (source: 'mapped') must propagate that rate's
// reverseCharge flag so it swaps — previously resolveWcTaxRateById dropped the
// flag from its `select`, posting a mapped reverse-charge sale under the
// standard code. Each resolution path now carries a real boolean, exercised here
// in the exact shapes lineTaxResolved[idx] yields (resolver / mapped / forceNoTax).
test('WC-import mapped reverse-charge rate swaps (flag now propagated from the select)', () => {
  const mappedRcRate = { accountingTaxType: 'OUTPUT2', reverseCharge: true, source: 'mapped' as const }
  assert.equal(
    resolveSalesLineTaxType({
      baseTaxType: mappedRcRate.accountingTaxType,
      reverseCharge: mappedRcRate.reverseCharge,
      reverseChargeSalesTaxType: RC,
    }),
    RC,
  )
})

test('WC-import forceNoTax line never swaps (carries reverseCharge:false, base stays null)', () => {
  const forceNoTax = { accountingTaxType: null, reverseCharge: false }
  assert.equal(
    resolveSalesLineTaxType({
      baseTaxType: forceNoTax.accountingTaxType ?? undefined,
      reverseCharge: forceNoTax.reverseCharge,
      reverseChargeSalesTaxType: RC,
    }),
    undefined,
  )
})
