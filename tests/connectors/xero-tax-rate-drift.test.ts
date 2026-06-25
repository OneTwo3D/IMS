import assert from 'node:assert/strict'
import test from 'node:test'

import {
  computeTaxRateDrift,
  formatDriftLines,
  type ImsTaxRateProfile,
} from '@/lib/connectors/xero/tax-rate-drift'
import type { XeroTaxRate } from '@/lib/connectors/xero/tax-rates'

// IMS rates are decimal fractions (0.07 = 7%); Xero TaxComponents are percent (7).
function ims(name: string, components: Array<{ name: string; rate: number; compound?: boolean }>): ImsTaxRateProfile {
  return { name, components: components.map((c) => ({ name: c.name, rate: c.rate, compoundOnPrevious: c.compound ?? false })) }
}
function xero(name: string, components: Array<{ name: string; rate: number; compound?: boolean }>): XeroTaxRate {
  return { Name: name, TaxComponents: components.map((c) => ({ Name: c.name, Rate: c.rate, IsCompound: c.compound })) }
}

test('equal: identical profiles report no drift and no lines', () => {
  const result = computeTaxRateDrift(
    ims('Canada GST/PST', [{ name: 'GST', rate: 0.05 }, { name: 'PST', rate: 0.07 }]),
    xero('Canada GST/PST', [{ name: 'GST', rate: 5 }, { name: 'PST', rate: 7 }]),
  )
  assert.equal(result.status, 'equal')
  assert.deepEqual(formatDriftLines(result), [])
})

test('mismatched component: a component rate edited in Xero is detected', () => {
  const result = computeTaxRateDrift(
    ims('Canada GST/PST', [{ name: 'GST', rate: 0.05 }, { name: 'PST', rate: 0.07 }]),
    xero('Canada GST/PST', [{ name: 'GST', rate: 5 }, { name: 'PST', rate: 7.5 }]),
  )
  assert.equal(result.status, 'mismatch')
  assert.deepEqual(
    result.status === 'mismatch' ? result.changes : [],
    [{ kind: 'component-rate', component: 'PST', imsPercent: 7, xeroPercent: 7.5 }],
  )
  assert.deepEqual(formatDriftLines(result), ['PST component rate: IMS 7%, Xero 7.5%'])
})

test('mismatched parent: a differing rate name is reported', () => {
  const result = computeTaxRateDrift(
    ims('Standard Rate', [{ name: 'VAT', rate: 0.2 }]),
    xero('Standard Rate (20%)', [{ name: 'VAT', rate: 20 }]),
  )
  assert.equal(result.status, 'mismatch')
  assert.ok(formatDriftLines(result).some((l) => l.includes('Tax rate name')))
})

test('three-way drift: rate change + component added + compound change', () => {
  const result = computeTaxRateDrift(
    ims('Combo', [{ name: 'A', rate: 0.07 }, { name: 'B', rate: 0.02, compound: false }]),
    xero('Combo', [{ name: 'A', rate: 7.5 }, { name: 'B', rate: 2, compound: true }, { name: 'C', rate: 1 }]),
  )
  assert.equal(result.status, 'mismatch')
  const kinds = result.status === 'mismatch' ? result.changes.map((c) => c.kind).sort() : []
  assert.deepEqual(kinds, ['component-added', 'component-compound', 'component-rate'])
})

test('component removed in Xero is detected', () => {
  const result = computeTaxRateDrift(
    ims('Canada', [{ name: 'GST', rate: 0.05 }, { name: 'PST', rate: 0.07 }]),
    xero('Canada', [{ name: 'GST', rate: 5 }]),
  )
  assert.equal(result.status, 'mismatch')
  assert.ok(formatDriftLines(result).some((l) => l.includes('missing in Xero')))
})

test('missing-on-xero when the Xero rate is absent', () => {
  const result = computeTaxRateDrift(ims('Zero Rate', [{ name: 'VAT', rate: 0 }]), null)
  assert.equal(result.status, 'missing-on-xero')
  assert.deepEqual(formatDriftLines(result), ['No matching tax rate found in Xero'])
})

test('missing-on-ims when the IMS rate is absent', () => {
  const result = computeTaxRateDrift(null, xero('Orphan', [{ name: 'VAT', rate: 20 }]))
  assert.equal(result.status, 'missing-on-ims')
  assert.deepEqual(formatDriftLines(result), ['No matching tax rate found in IMS'])
})

test('duplicate component names on a side are flagged, not silently collapsed', () => {
  // Two IMS components both named "PST" — the second would overwrite the first in a
  // by-name map and hide its drift. It must be surfaced instead.
  const result = computeTaxRateDrift(
    ims('Dup', [{ name: 'PST', rate: 0.07 }, { name: 'pst', rate: 0.05 }]),
    xero('Dup', [{ name: 'PST', rate: 7 }]),
  )
  assert.equal(result.status, 'mismatch')
  assert.ok(
    result.status === 'mismatch' && result.changes.some((c) => c.kind === 'duplicate-component' && c.side === 'ims'),
  )
  assert.ok(formatDriftLines(result).some((l) => l.includes('Duplicate component')))
})

test('isolated component-added (only Xero has an extra component)', () => {
  const result = computeTaxRateDrift(
    ims('K', [{ name: 'A', rate: 0.05 }]),
    xero('K', [{ name: 'A', rate: 5 }, { name: 'B', rate: 2 }]),
  )
  assert.deepEqual(
    result.status === 'mismatch' ? result.changes : [],
    [{ kind: 'component-added', component: 'B', xeroPercent: 2 }],
  )
})

test('isolated compound mismatch', () => {
  const result = computeTaxRateDrift(
    ims('K', [{ name: 'A', rate: 0.05, compound: false }]),
    xero('K', [{ name: 'A', rate: 5, compound: true }]),
  )
  assert.deepEqual(
    result.status === 'mismatch' ? result.changes : [],
    [{ kind: 'component-compound', component: 'A', ims: false, xero: true }],
  )
})

test('empty component arrays compare equal; zero rates compare equal', () => {
  assert.equal(computeTaxRateDrift(ims('Empty', []), xero('Empty', [])).status, 'equal')
  assert.equal(
    computeTaxRateDrift(ims('Zero', [{ name: 'VAT', rate: 0 }]), xero('Zero', [{ name: 'VAT', rate: 0 }])).status,
    'equal',
  )
})

test('floating-point noise does not register as drift (0.07*100 vs 7)', () => {
  const result = computeTaxRateDrift(
    ims('FP', [{ name: 'X', rate: 0.07 }]),
    xero('FP', [{ name: 'X', rate: 7 }]),
  )
  assert.equal(result.status, 'equal')
})
