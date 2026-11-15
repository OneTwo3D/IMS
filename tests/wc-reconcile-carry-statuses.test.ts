import assert from 'node:assert/strict'
import test from 'node:test'
import { statusListCovers } from '@/lib/connectors/woocommerce/sync/read-cursor'

// A reconcile's position may be carried to the poll cursor only if the reconcile read everything the poll would.
test('statusListCovers: reconcile (poll + completed) covers poll; a narrower list does not', () => {
  assert.equal(statusListCovers(['processing', 'completed'], ['processing']), true)
  assert.equal(statusListCovers(['processing'], ['processing']), true)
  assert.equal(statusListCovers(['completed'], ['processing']), false)
  assert.equal(statusListCovers(['processing'], ['processing', 'on-hold']), false)
  assert.equal(statusListCovers(['processing'], []), false, 'an empty poll list proves nothing')
})
