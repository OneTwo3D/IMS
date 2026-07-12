import assert from 'node:assert/strict'
import test from 'node:test'
import * as sweepNs from '../lib/trade/hs-classification-sweep.ts'
import { ProductLifecycleStatus, ProductType } from '../app/generated/prisma/client.ts'

const sweep = 'default' in sweepNs
  ? sweepNs.default as typeof import('../lib/trade/hs-classification-sweep.ts')
  : sweepNs

test('hsSweepCandidateWhere targets eligible, live, uncoded, never-proposed products', () => {
  const where = sweep.hsSweepCandidateWhere()
  // Only sellable/inventory product types, not archived.
  assert.deepEqual(where.type, {
    in: [ProductType.SIMPLE, ProductType.VARIANT, ProductType.KIT, ProductType.BOM],
  })
  assert.deepEqual(where.lifecycleStatus, { not: ProductLifecycleStatus.ARCHIVED })
  // No HS code yet, and no existing proposal of any status (proposed at most once by the sweep).
  assert.equal(where.hsCode, null)
  assert.deepEqual(where.hsCodeProposals, { none: {} })
})

test('a positive default batch limit is exported', () => {
  assert.ok(sweep.HS_SWEEP_DEFAULT_LIMIT > 0)
})
