import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ALIGNMENT_DRY_RUN_MAX_AGE_MS,
  alignmentConfirmationSurvivesSave,
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
    pairingChangedAt: new Date('2026-01-01T00:00:00Z'), now,
  })
  const gt = (q.where.finishedAt as { gt: Date }).gt
  assert.equal(gt.getTime(), now.getTime() - ALIGNMENT_DRY_RUN_MAX_AGE_MS)
})
