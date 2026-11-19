import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ALIGNMENT_DRY_RUN_MAX_AGE_MS,
  alignmentConfirmationSurvivesSave,
  alignmentThresholdsKey,
  alignmentDryRunEvidenceQuery,
} from '@/lib/domain/wms/alignment-dry-run'

const same = {
  wasAlignToWms: true,
  willBeAlignToWms: true,
  pointsAtSameTarget: true,
  previousThresholds: { absolute: 5, percent: 10 },
  nextThresholds: { percent: 10, absolute: 5 },
}

test('a confirmation survives a save that changes neither pairing nor thresholds (key order is irrelevant)', () => {
  assert.equal(alignmentConfirmationSurvivesSave(same), true)
  assert.equal(alignmentConfirmationSurvivesSave({ ...same, previousThresholds: null, nextThresholds: undefined }), true)
})

test('changing the write-off thresholds, the target or the mode drops the confirmation', () => {
  assert.equal(alignmentConfirmationSurvivesSave({ ...same, nextThresholds: { absolute: 500, percent: 10 } }), false)
  assert.equal(alignmentConfirmationSurvivesSave({ ...same, previousThresholds: null }), false)
  assert.equal(alignmentConfirmationSurvivesSave({ ...same, pointsAtSameTarget: false }), false)
  assert.equal(alignmentConfirmationSurvivesSave({ ...same, willBeAlignToWms: false }), false)
  assert.equal(alignmentConfirmationSurvivesSave({ ...same, wasAlignToWms: false }), false)
})

test('dry-run evidence has an age limit', () => {
  const now = new Date('2026-11-18T12:00:00Z')
  const q = alignmentDryRunEvidenceQuery({
    connector: 'mintsoft', warehouseId: 'w', externalWarehouseId: 'e', connectionId: 'c',
    pairingChangedAt: new Date('2026-01-01T00:00:00Z'), discrepancyThresholds: null, now,
  })
  const gt = (q.where.finishedAt as { gt: Date }).gt
  assert.equal(gt.getTime(), now.getTime() - ALIGNMENT_DRY_RUN_MAX_AGE_MS)
})

// o3d-zz37l (1): a dry run previewed the write-offs of the thresholds it ran under. Evidence is matched on that stamp, so a run made under the OLD
// thresholds does not satisfy a confirmation given for the new ones.
test('dry-run evidence is matched on the write-off thresholds it ran under (key order and null/undefined are irrelevant)', () => {
  const base = { connector: 'mintsoft', warehouseId: 'w', externalWarehouseId: 'e', connectionId: 'c', pairingChangedAt: new Date('2026-01-01T00:00:00Z') }
  const stampOf = (thresholds: unknown) => {
    const clause = alignmentDryRunEvidenceQuery({ ...base, discrepancyThresholds: thresholds }).where.AND.find((c) => (c.summary as { path: string[] }).path[0] === 'thresholdsKey')
    return (clause?.summary as { equals: string } | undefined)?.equals
  }
  assert.equal(stampOf({ absolute: 5, percent: 10 }), stampOf({ percent: 10, absolute: 5 }))
  assert.notEqual(stampOf({ absolute: 5, percent: 10 }), stampOf({ absolute: 500, percent: 10 }))
  assert.equal(stampOf(null), stampOf(undefined))
  assert.notEqual(stampOf(null), stampOf({ absolute: 5 }))
  assert.equal(stampOf({ absolute: 5 }), alignmentThresholdsKey({ absolute: 5 }))
})
