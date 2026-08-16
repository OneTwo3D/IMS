import assert from 'node:assert/strict'
import test from 'node:test'

import {
  captureIssuerProvenance,
  issuedProvenanceOrNull,
  issuerProvenanceRefusal,
  noteIssuerProvenance,
  summariseIssuerProvenance,
} from '@/lib/domain/accounting/issuer-provenance'

// ---------------------------------------------------------------------------
// o3d-9kek r4 finding 2 — provenance sampled AFTER the post is not provenance.
//
// The sync processor used to post the document and then ask "which realm is connected?". A
// disconnect and re-auth to a different company in between stamped realm A's id as realm B, and
// every guard r3 added — the sweep's namespace match, the (id, provenance) unique index, the
// resolver's holder lookup — then reasoned impeccably about a lie.
//
// This module's contract is that the value comes from the auth snapshot the REQUEST used, and that
// two entries in flight at once cannot see each other's.
// ---------------------------------------------------------------------------

test('[o3d-9kek r4 f2] the provenance recorded is the one the request used, not one read afterwards', async () => {
  let connectedRealm = 'quickbooks:realm-A'

  const { result, issuer } = await captureIssuerProvenance(async () => {
    // Stands in for the HTTP client: it notes the realm it is ABOUT to talk to...
    noteIssuerProvenance(connectedRealm)
    // ...and then the operator disconnects and re-authorises to another company while the post is
    // in flight. Everything sampled from here on says realm B.
    connectedRealm = 'quickbooks:realm-B'
    return 'BILL-42'
  })

  assert.equal(result, 'BILL-42')
  assert.deepEqual(issuer, { outcome: 'single', provenance: 'quickbooks:realm-A' })
  assert.equal(issuedProvenanceOrNull(issuer), 'quickbooks:realm-A')
  assert.equal(connectedRealm, 'quickbooks:realm-B', 'the race really did happen')
})

test('[o3d-9kek r4 f2] a connection change MID-ENTRY is a refusal, not "take the last one"', async () => {
  // One logical entry makes several requests — resolve the contact, resolve the account, post the
  // document. If they did not all go to the same company then the id belongs to one company and
  // half the references inside it to another. There is no correct single value to record, so none
  // is recorded.
  const { issuer } = await captureIssuerProvenance(async () => {
    noteIssuerProvenance('quickbooks:realm-B')
    noteIssuerProvenance('quickbooks:realm-A')
    return null
  })

  assert.equal(issuer.outcome, 'conflicting')
  assert.deepEqual(issuer.outcome === 'conflicting' ? issuer.observed : [], ['quickbooks:realm-A', 'quickbooks:realm-B'])
  assert.equal(issuedProvenanceOrNull(issuer), null)
  assert.match(issuerProvenanceRefusal(issuer), /connection changed/)
})

test('[o3d-9kek r4 f2] repeated requests to the SAME realm are one observation, so a token refresh is not a conflict', async () => {
  // Refreshing an access token keeps the tenantId, so every request in the entry still reports the
  // same provenance string. If this collapsed by identity rather than by value, an ordinary refresh
  // would look like a realm switch and fail perfectly good work.
  const { issuer } = await captureIssuerProvenance(async () => {
    noteIssuerProvenance('quickbooks:realm-A')
    noteIssuerProvenance('quickbooks:realm-A')
    noteIssuerProvenance('quickbooks:realm-A')
    return null
  })
  assert.deepEqual(issuer, { outcome: 'single', provenance: 'quickbooks:realm-A' })
})

test('[o3d-9kek r4 f2] a post that reached no connector records nothing, and that is a refusal too', async () => {
  const { issuer } = await captureIssuerProvenance(async () => null)
  assert.deepEqual(issuer, { outcome: 'none' })
  assert.equal(issuedProvenanceOrNull(issuer), null)
  assert.match(issuerProvenanceRefusal(issuer), /no connection at all/)
  assert.equal(issuerProvenanceRefusal({ outcome: 'single', provenance: 'x' }), '')
})

test('[o3d-9kek r4 f2] concurrent entries do not see each other\'s realm', async () => {
  // A module-level "last realm used" would attribute one entry's realm to the other whenever a cron
  // sweep and a server action overlap in one process — which is the same corruption by another
  // route. The async context is what makes the capture per-entry.
  const [first, second] = await Promise.all([
    captureIssuerProvenance(async () => {
      noteIssuerProvenance('quickbooks:realm-A')
      await new Promise((resolve) => setTimeout(resolve, 5))
      return 'a'
    }),
    captureIssuerProvenance(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1))
      noteIssuerProvenance('quickbooks:realm-B')
      return 'b'
    }),
  ])

  assert.deepEqual(first.issuer, { outcome: 'single', provenance: 'quickbooks:realm-A' })
  assert.deepEqual(second.issuer, { outcome: 'single', provenance: 'quickbooks:realm-B' })
})

test('[o3d-9kek r4 f2] noting outside a capture is a no-op, not a crash or a leak', async () => {
  // Read paths and background lookups go through the same HTTP client. They must cost nothing and,
  // more importantly, must not seed the NEXT capture with a stale realm.
  noteIssuerProvenance('quickbooks:realm-Z')
  const { issuer } = await captureIssuerProvenance(async () => null)
  assert.deepEqual(issuer, { outcome: 'none' })
})

test('[o3d-9kek r4 f2] the outcome rule itself', () => {
  assert.deepEqual(summariseIssuerProvenance([]), { outcome: 'none' })
  assert.deepEqual(summariseIssuerProvenance(['x']), { outcome: 'single', provenance: 'x' })
  assert.deepEqual(summariseIssuerProvenance(['y', 'x']), { outcome: 'conflicting', observed: ['x', 'y'] })
})
