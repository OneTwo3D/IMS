import assert from 'node:assert/strict'
import test from 'node:test'

import { withoutX04DriftEntries } from '../../e2e/full-chain/harness/x04-drift-snapshot.ts'

const real = { taxRateId: 'clive123', name: 'VAT on Expenses', status: 'RATE_MISMATCH', lines: ['20 vs 17.5'] }
const seeded = { taxRateId: 'e2e-x04-abc', name: 'E2E mirror', status: 'RATE_MISMATCH', lines: ['20 vs 18'] }

test('a snapshot left by a crashed run drops its X-04 entry and keeps the operator\'s', () => {
  // THE crash-recovery case: a prior run died after Phase B, so the live snapshot names an e2e-x04 rate that
  // this run is about to delete. Capturing it unfiltered would make the dangling entry the restore target.
  const purged = withoutX04DriftEntries(JSON.stringify([real, seeded]))
  assert.deepEqual(JSON.parse(purged!), [real])
})

test('a snapshot that was entirely X-04\'s collapses to absent, not an empty array', () => {
  // null means "delete the setting", restoring the clean rig's absent state rather than leaving [] behind
  // for the operator UI to interpret.
  assert.equal(withoutX04DriftEntries(JSON.stringify([seeded])), null)
})

test('a snapshot with no X-04 entries is returned byte-identical', () => {
  const raw = JSON.stringify([real])
  assert.equal(withoutX04DriftEntries(raw), raw, 'unchanged input must not be rewritten (no needless write)')
})

test('absent, unparseable or non-array settings are left alone', () => {
  // Conservative by design: this value is operator-visible, and a shape we do not understand is not ours to
  // rewrite. Erasing someone else's drift entry is worse than leaving one of ours.
  assert.equal(withoutX04DriftEntries(null), null)
  assert.equal(withoutX04DriftEntries('not json'), 'not json')
  assert.equal(withoutX04DriftEntries('{"taxRateId":"e2e-x04-abc"}'), '{"taxRateId":"e2e-x04-abc"}')
})

test('entries without a string taxRateId are kept — they cannot be proven to be ours', () => {
  const odd = JSON.stringify([{ name: 'no id' }, { taxRateId: 42 }, seeded])
  assert.deepEqual(JSON.parse(withoutX04DriftEntries(odd)!), [{ name: 'no id' }, { taxRateId: 42 }])
})
