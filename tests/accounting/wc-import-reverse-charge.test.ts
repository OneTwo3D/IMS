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
