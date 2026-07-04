import assert from 'node:assert/strict'
import test from 'node:test'

import {
  planMissingTaxRateCreations,
  taxComponentsForCreation,
  type ImsRateForGeneration,
  type ExternalRateLite,
} from '@/lib/tax/generate-missing-tax-rates'

// onetwo3d-ims-30tg: pure planner for "generate + map missing accounting tax rates".

const imsRate = (over: Partial<ImsRateForGeneration> = {}): ImsRateForGeneration => ({
  id: 'r1',
  name: 'UK Standard',
  rate: 0.2,
  usedFor: 'SALES',
  reportingCategory: 'DOMESTIC',
  accountingTaxType: null,
  active: true,
  components: [],
  ...over,
})

const ext = (name: string, ratePct: number): ExternalRateLite => ({ name, ratePct })

test('active + unmapped + no name-match becomes a create candidate', () => {
  const plan = planMissingTaxRateCreations([imsRate()], [])
  assert.deepEqual(plan.toCreate.map((r) => r.id), ['r1'])
  assert.equal(plan.alreadyMapped.length, 0)
  assert.equal(plan.skippedExisting.length, 0)
})

test('already-mapped rates (accountingTaxType set) are never re-created', () => {
  const plan = planMissingTaxRateCreations([imsRate({ accountingTaxType: 'OUTPUT2' })], [])
  assert.equal(plan.toCreate.length, 0)
  assert.deepEqual(plan.alreadyMapped.map((r) => r.id), ['r1'])
})

test('blank/whitespace accountingTaxType counts as unmapped', () => {
  const plan = planMissingTaxRateCreations([imsRate({ accountingTaxType: '   ' })], [])
  assert.deepEqual(plan.toCreate.map((r) => r.id), ['r1'])
})

test('name-match against an existing external rate is skipped (left for auto-link)', () => {
  const plan = planMissingTaxRateCreations([imsRate({ name: 'UK Standard' })], [ext('uk standard', 20)])
  assert.equal(plan.toCreate.length, 0)
  assert.deepEqual(plan.skippedExisting.map((r) => r.id), ['r1'])
})

test('name-match uses the same normalization as the matcher (case/punctuation insensitive)', () => {
  const plan = planMissingTaxRateCreations([imsRate({ name: 'UK-Standard Rate' })], [ext('uk standard rate', 20)])
  assert.equal(plan.toCreate.length, 0)
  assert.deepEqual(plan.skippedExisting.map((r) => r.id), ['r1'])
})

test('two same-named unmapped IMS rates: only the first is queued, the rest skipped (no collision)', () => {
  const plan = planMissingTaxRateCreations(
    [
      imsRate({ id: 'first', name: 'Reduced Rate' }),
      imsRate({ id: 'dup', name: 'reduced-rate' }), // normalizes to the same name
    ],
    [],
  )
  assert.deepEqual(plan.toCreate.map((r) => r.id), ['first'])
  assert.deepEqual(plan.skippedExisting.map((r) => r.id), ['dup'])
})

test('inactive rates are ignored entirely', () => {
  const plan = planMissingTaxRateCreations([imsRate({ active: false })], [])
  assert.equal(plan.toCreate.length, 0)
  assert.equal(plan.alreadyMapped.length, 0)
  assert.equal(plan.skippedExisting.length, 0)
})

test('mixed set is partitioned correctly', () => {
  const plan = planMissingTaxRateCreations(
    [
      imsRate({ id: 'create', name: 'Reverse Charge', reportingCategory: 'REVERSE_CHARGE' }),
      imsRate({ id: 'mapped', name: 'Zero', accountingTaxType: 'ZERORATEDOUTPUT' }),
      imsRate({ id: 'skip', name: 'Standard' }),
      imsRate({ id: 'inactive', name: 'Old', active: false }),
    ],
    [ext('Standard', 20)],
  )
  assert.deepEqual(plan.toCreate.map((r) => r.id), ['create'])
  assert.deepEqual(plan.alreadyMapped.map((r) => r.id), ['mapped'])
  assert.deepEqual(plan.skippedExisting.map((r) => r.id), ['skip'])
})

test('taxComponentsForCreation passes multi-component rates through unchanged', () => {
  const components = [
    { name: 'GST', rate: 0.1, compoundOnPrevious: false },
    { name: 'PST', rate: 0.07, compoundOnPrevious: true },
  ]
  const rate = imsRate({ components })
  assert.deepEqual(taxComponentsForCreation(rate), components)
})

test('taxComponentsForCreation synthesises a single component for single-rate rates', () => {
  const rate = imsRate({ name: 'UK Standard', rate: 0.2, components: [] })
  assert.deepEqual(taxComponentsForCreation(rate), [
    { name: 'UK Standard', rate: 0.2, compoundOnPrevious: false },
  ])
})
