import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildDriftSnapshot,
  sweepTaxRateDrift,
  type DriftSweepItem,
  type TaxRateDriftSweepDeps,
} from '@/lib/connectors/xero/tax-rate-drift-sweeper'
import type { ImsTaxRateProfile } from '@/lib/connectors/xero/tax-rate-drift'
import type { XeroTaxRate } from '@/lib/connectors/xero/tax-rates'

function imsProfile(taxRateId: string, name: string, components: Array<{ name: string; rate: number }>) {
  const profile: ImsTaxRateProfile = {
    name,
    components: components.map((c) => ({ name: c.name, rate: c.rate, compoundOnPrevious: false })),
  }
  return { taxRateId, profile }
}
function xeroRate(name: string, components: Array<{ name: string; rate: number }>): XeroTaxRate {
  return { Name: name, TaxComponents: components.map((c) => ({ Name: c.name, Rate: c.rate })) }
}

function makeDeps(
  imsProfiles: Array<{ taxRateId: string; profile: ImsTaxRateProfile }>,
  xeroRates: XeroTaxRate[],
): { deps: TaxRateDriftSweepDeps; recorded: DriftSweepItem[]; checkedAt: Date[] } {
  const recorded: DriftSweepItem[] = []
  const checkedAt: Date[] = []
  const deps: TaxRateDriftSweepDeps = {
    loadImsProfiles: async () => imsProfiles,
    fetchXeroTaxRates: async () => xeroRates,
    recordDrift: async (item) => { recorded.push(item) },
    recordCheckedAt: async (at) => { checkedAt.push(at) },
    now: () => new Date('2026-06-25T00:00:00.000Z'),
  }
  return { deps, recorded, checkedAt }
}

test('equal rates: no drift recorded, checked count is right', async () => {
  const { deps, recorded } = makeDeps(
    [imsProfile('t1', 'Canada GST/PST', [{ name: 'GST', rate: 0.05 }, { name: 'PST', rate: 0.07 }])],
    [xeroRate('Canada GST/PST', [{ name: 'GST', rate: 5 }, { name: 'PST', rate: 7 }])],
  )
  const result = await sweepTaxRateDrift(deps)
  assert.equal(result.checked, 1)
  assert.equal(result.drifted, 0)
  assert.equal(recorded.length, 0)
})

test('component rate edited in Xero: drift recorded with mismatch status', async () => {
  const { deps, recorded } = makeDeps(
    [imsProfile('t1', 'Canada GST/PST', [{ name: 'GST', rate: 0.05 }, { name: 'PST', rate: 0.07 }])],
    [xeroRate('Canada GST/PST', [{ name: 'GST', rate: 5 }, { name: 'PST', rate: 7.5 }])],
  )
  const result = await sweepTaxRateDrift(deps)
  assert.equal(result.drifted, 1)
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0].taxRateId, 't1')
  assert.equal(recorded[0].result.status, 'mismatch')
  assert.ok(recorded[0].lines.length > 0)
})

test('IMS rate with no Xero match: recorded as missing-on-xero', async () => {
  const { deps, recorded } = makeDeps(
    [imsProfile('t1', 'UK Standard', [{ name: 'VAT', rate: 0.2 }])],
    [xeroRate('Some Other Rate', [{ name: 'VAT', rate: 20 }])],
  )
  const result = await sweepTaxRateDrift(deps)
  assert.equal(result.drifted, 1)
  assert.equal(recorded[0].result.status, 'missing-on-xero')
})

test('pairs by trimmed name: surrounding whitespace is not drift', async () => {
  const { deps, recorded } = makeDeps(
    [imsProfile('t1', 'Canada GST/PST', [{ name: 'GST', rate: 0.05 }])],
    [xeroRate('  Canada GST/PST  ', [{ name: 'GST', rate: 5 }])],
  )
  const result = await sweepTaxRateDrift(deps)
  assert.equal(result.drifted, 0)
  assert.equal(recorded.length, 0)
})

test('pairs case-insensitively, but a name case difference is reported as drift (not missing)', async () => {
  const { deps, recorded } = makeDeps(
    [imsProfile('t1', 'Canada GST/PST', [{ name: 'GST', rate: 0.05 }])],
    [xeroRate('canada gst/pst', [{ name: 'GST', rate: 5 }])],
  )
  const result = await sweepTaxRateDrift(deps)
  // Matched (not missing-on-xero), but the casing difference surfaces as a mismatch.
  assert.equal(result.drifted, 1)
  assert.equal(recorded[0].result.status, 'mismatch')
})

test('mixed batch: only drifted rates are recorded; counts are correct', async () => {
  const { deps, recorded } = makeDeps(
    [
      imsProfile('t1', 'Equal Rate', [{ name: 'VAT', rate: 0.2 }]),
      imsProfile('t2', 'Drifted Rate', [{ name: 'VAT', rate: 0.2 }]),
      imsProfile('t3', 'Absent Rate', [{ name: 'VAT', rate: 0.1 }]),
    ],
    [
      xeroRate('Equal Rate', [{ name: 'VAT', rate: 20 }]),
      xeroRate('Drifted Rate', [{ name: 'VAT', rate: 17.5 }]),
    ],
  )
  const result = await sweepTaxRateDrift(deps)
  assert.equal(result.checked, 3)
  assert.equal(result.drifted, 2)
  assert.deepEqual(recorded.map((r) => r.taxRateId).sort(), ['t2', 't3'])
})

test('records the checked-at timestamp once per sweep', async () => {
  const { deps, checkedAt } = makeDeps(
    [imsProfile('t1', 'UK Standard', [{ name: 'VAT', rate: 0.2 }])],
    [xeroRate('UK Standard', [{ name: 'VAT', rate: 20 }])],
  )
  await sweepTaxRateDrift(deps)
  assert.equal(checkedAt.length, 1)
  assert.equal(checkedAt[0].toISOString(), '2026-06-25T00:00:00.000Z')
})

test('empty IMS set: no fetch-derived drift, checked is 0', async () => {
  const { deps, recorded } = makeDeps([], [xeroRate('UK Standard', [{ name: 'VAT', rate: 20 }])])
  const result = await sweepTaxRateDrift(deps)
  assert.equal(result.checked, 0)
  assert.equal(result.drifted, 0)
  assert.equal(recorded.length, 0)
})

test('buildDriftSnapshot keeps only non-equal items with the right shape', async () => {
  const { deps } = makeDeps(
    [
      imsProfile('t1', 'Equal Rate', [{ name: 'VAT', rate: 0.2 }]),
      imsProfile('t2', 'Drifted Rate', [{ name: 'VAT', rate: 0.2 }]),
      imsProfile('t3', 'Absent Rate', [{ name: 'VAT', rate: 0.1 }]),
    ],
    [
      xeroRate('Equal Rate', [{ name: 'VAT', rate: 20 }]),
      xeroRate('Drifted Rate', [{ name: 'VAT', rate: 17.5 }]),
    ],
  )
  const result = await sweepTaxRateDrift(deps)
  const snapshot = buildDriftSnapshot(result)
  assert.deepEqual(snapshot.map((s) => s.taxRateId).sort(), ['t2', 't3'])
  const drifted = snapshot.find((s) => s.taxRateId === 't2')!
  assert.equal(drifted.status, 'mismatch')
  assert.ok(drifted.lines.length > 0)
  assert.equal(snapshot.find((s) => s.taxRateId === 't3')!.status, 'missing-on-xero')
})
