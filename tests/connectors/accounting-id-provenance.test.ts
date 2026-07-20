import assert from 'node:assert/strict'
import test from 'node:test'

import { accountingIdProvenanceMatches } from '@/lib/connectors/accounting-id-provenance'

// The guard that decides whether a cached accounting id may be trusted (o3d-6nd). It is the safety-
// critical direction: a false positive serves one connection's id to another; a false negative merely
// re-resolves, which is always safe. So only an EXACT match may pass.
test('an exact provenance match is trusted', () => {
  assert.equal(accountingIdProvenanceMatches('xero:tenant-A', 'xero:tenant-A'), true)
})

test('a different tenant/org is NOT trusted (re-auth to another Xero org)', () => {
  assert.equal(accountingIdProvenanceMatches('xero:tenant-A', 'xero:tenant-B'), false)
})

test('a different connector is NOT trusted (Xero id, QuickBooks connection)', () => {
  assert.equal(accountingIdProvenanceMatches('xero:tenant-A', 'quickbooks:tenant-A'), false)
})

test('a legacy NULL stored provenance is never trusted — it re-resolves and backfills', () => {
  assert.equal(accountingIdProvenanceMatches(null, 'xero:tenant-A'), false)
})

test('a NULL active provenance (no live token) trusts nothing', () => {
  assert.equal(accountingIdProvenanceMatches('xero:tenant-A', null), false)
  assert.equal(accountingIdProvenanceMatches(null, null), false)
})
