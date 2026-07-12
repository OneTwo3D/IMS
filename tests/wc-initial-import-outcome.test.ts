import assert from 'node:assert/strict'
import test from 'node:test'
import { decideInitialImportOutcome } from '../lib/connectors/woocommerce/sync/initial-import.ts'

test('a pass that imported nothing and errored on everything is FAILED (no false-complete)', () => {
  // The reported bug: 6 orders, all errored ("no storefront-synced warehouse"),
  // 0 imported. Must NOT count as complete — otherwise live sync silently stays
  // off with a dead-end "completed" and no retry.
  assert.equal(decideInitialImportOutcome({ imported: 0, skipped: 0, errorCount: 6 }), 'failed')
  assert.equal(decideInitialImportOutcome({ imported: 0, skipped: 0, errorCount: 1 }), 'failed')
})

test('no active orders to import is COMPLETE (legitimately ready for live sync)', () => {
  assert.equal(decideInitialImportOutcome({ imported: 0, skipped: 0, errorCount: 0 }), 'complete')
})

test('any real progress makes it COMPLETE even with some per-order errors', () => {
  assert.equal(decideInitialImportOutcome({ imported: 4, skipped: 0, errorCount: 2 }), 'complete') // partial import
  assert.equal(decideInitialImportOutcome({ imported: 0, skipped: 3, errorCount: 2 }), 'complete') // all already imported
  assert.equal(decideInitialImportOutcome({ imported: 5, skipped: 0, errorCount: 0 }), 'complete') // clean import
})
