import assert from 'node:assert/strict'
import test from 'node:test'

import { ledgerStanding, type LedgerStanding, type LedgerStandingRow } from '@/lib/domain/accounting/ledger-standing'
import {
  describeDocumentIdClaim,
  describeLedgerStanding,
  documentIdText,
} from '@/lib/domain/accounting/ledger-standing-display'

/**
 * o3d-1e7sl (D1-D4, slice 1c of o3d-f709) - THE SENTENCES AN OPERATOR READS ABOUT A ROW'S STANDING.
 *
 * A display test asserts that the BASIS / standing is shown, and that nothing more is claimed than the standing
 * proves. The invariant pinned for every standing: ONLY PROVEN_NOT_POSTED is described as "unsent"; an
 * asserted NOT_POSTED and an unknown retirement say UNPROVEN and send the reader to the accounting system.
 */
function row(over: Partial<LedgerStandingRow>): LedgerStandingRow {
  return { status: 'CANCELLED', externalTransactionId: null, abandonedBeforeRemoteCall: null, settlementBasis: null, ...over }
}

const CASES: Array<{
  name: string
  standing: LedgerStanding
  row: LedgerStandingRow
  tone: string
  label: string | null
  detail: RegExp
  idClaim: RegExp | null
}> = [
  {
    name: 'CONFIRMED_POSTED', standing: 'CONFIRMED_POSTED', row: row({ status: 'SYNCED', externalTransactionId: 'INV-1' }),
    tone: 'confirmed', label: null, detail: /Confirmed by the connector/, idClaim: /^posted as INV-1$/,
  },
  {
    name: 'ASSERTED_POSTED', standing: 'ASSERTED_POSTED', row: row({ status: 'SYNCED', externalTransactionId: 'T-1', settlementBasis: 'OPERATOR_ASSERTION' }),
    tone: 'asserted', label: 'asserted', detail: /Recorded by an OPERATOR, not confirmed[\s\S]*typed in/, idClaim: /typed in by an operator \(asserted, not confirmed\)/,
  },
  {
    name: 'ASSERTED_NOT_POSTED', standing: 'ASSERTED_NOT_POSTED', row: row({ settlementBasis: 'OPERATOR_ASSERTION' }),
    tone: 'unproven', label: 'asserted: not posted', detail: /claim, not proof[\s\S]*UNPROVEN[\s\S]*check the accounting system/, idClaim: null,
  },
  {
    name: 'PROVEN_NOT_POSTED', standing: 'PROVEN_NOT_POSTED', row: row({ abandonedBeforeRemoteCall: true }),
    tone: 'proven', label: 'never sent', detail: /Never sent \(recorded before the remote call\)/, idClaim: null,
  },
  {
    name: 'PROVEN_NOT_POSTED (verified reversal, id kept)', standing: 'PROVEN_NOT_POSTED', row: row({ externalTransactionId: 'PAY-1', settlementBasis: 'VERIFIED_REVERSAL' }),
    tone: 'proven', label: 'verified reversed', detail: /Verified reversed in the ledger; no longer present there\. It may have been posted earlier/, idClaim: /verified reversed in the ledger; no longer present - it may have been posted earlier/,
  },
  {
    name: 'UNKNOWN (CANCELLED, no proof)', standing: 'UNKNOWN', row: row({}),
    tone: 'unproven', label: 'unproven', detail: /UNPROVEN - check the accounting system/, idClaim: null,
  },
  {
    name: 'UNKNOWN (a basis this build does not recognise, with an id)', standing: 'UNKNOWN', row: row({ status: 'SYNCED', externalTransactionId: 'X-1', settlementBasis: 'SOMETHING_NEWER' }),
    tone: 'unproven', label: 'unproven', detail: /UNPROVEN/, idClaim: /how this id got here is not recognised/,
  },
  {
    name: 'LIVE_WORK', standing: 'LIVE_WORK', row: row({ status: 'PENDING' }),
    tone: 'work', label: null, detail: /Queued or in flight/, idClaim: null,
  },
]

test('[o3d-1e7sl D1-D4] every standing is described by its basis, and only a recorded pre-call proof says "never sent" - the standing is asserted first', () => {
  let labelled = 0
  for (const c of CASES) {
    const standing = ledgerStanding(c.row)
    console.log(`# display precondition: ${c.name}: ${JSON.stringify(c.row)} => ${standing}`)
    assert.equal(standing, c.standing, `fixture is not the standing it names: ${c.name}`)
    const shown = describeLedgerStanding(c.row)
    assert.equal(shown.standing, c.standing, c.name)
    assert.equal(shown.tone, c.tone, c.name)
    assert.equal(shown.label, c.label, c.name)
    assert.match(shown.detail, c.detail, c.name)
    if (shown.label !== null) labelled += 1
    const claim = describeDocumentIdClaim(c.row)
    if (c.idClaim === null) assert.equal(claim, null, c.name)
    else assert.match(String(claim), c.idClaim, c.name)
    // THE RULE: an unproven standing never reads as "never sent".
    // THE RULE: only a RECORDED PRE-CALL proof may say "never sent". A verified reversal can keep the id of a payment
    // that DID reach the ledger, so it must never say so (Codex round 1, HIGH).
    if (shown.cause !== 'RECORDED_PRE_CALL') {
      assert.doesNotMatch(`${shown.label ?? ''} ${shown.detail} ${claim ?? ''}`, /never sent|unsent|nothing was sent|nothing was posted/i, `${c.name}: must not claim the ledger is clear`)
    }
  }
  console.log(`# display cases: ${CASES.length}; labelled: ${labelled}`)
  assert.deepEqual(
    [...new Set(CASES.map((c) => c.standing))].sort(),
    ['ASSERTED_NOT_POSTED', 'ASSERTED_POSTED', 'CONFIRMED_POSTED', 'LIVE_WORK', 'PROVEN_NOT_POSTED', 'UNKNOWN'],
    'every standing is exercised',
  )
})

test('[o3d-1e7sl D1] "posted as <id>" is only ever said of a CONNECTOR-confirmed id', () => {
  for (const c of CASES) {
    const claim = describeDocumentIdClaim(c.row)
    if (claim === null) continue
    assert.equal(/^posted as /.test(claim), c.standing === 'CONFIRMED_POSTED', c.name)
  }
})

test('[o3d-1e7sl] documentIdText trims and never throws on a missing id', () => {
  assert.equal(documentIdText(row({ externalTransactionId: '  INV-9  ' })), 'INV-9')
  assert.equal(documentIdText(row({ externalTransactionId: null })), '')
})

// ---------------------------------------------------------------------------------------------
// Codex round 1 (HIGH): the three causes of PROVEN_NOT_POSTED are worded apart.
// ---------------------------------------------------------------------------------------------
const CAUSES: Array<{ name: string; cause: string; row: LedgerStandingRow; opts?: { couldHaveReachedLedger?: boolean }; label: string; detail: RegExp; neverSent: boolean }> = [
  { name: 'recorded pre-call abandonment (orphan sweep / supersession stamp)', cause: 'RECORDED_PRE_CALL', row: row({ abandonedBeforeRemoteCall: true }), label: 'never sent', detail: /never sent \(recorded before the remote call\)/i, neverSent: true },
  { name: 'VERIFIED_REVERSAL, no id', cause: 'VERIFIED_REVERSAL', row: row({ settlementBasis: 'VERIFIED_REVERSAL' }), label: 'verified reversed', detail: /may have been posted earlier/, neverSent: false },
  { name: 'VERIFIED_REVERSAL keeping a CONNECTOR-issued id (a payment that did reach the ledger)', cause: 'VERIFIED_REVERSAL', row: row({ externalTransactionId: 'PAY-REAL-7', settlementBasis: 'VERIFIED_REVERSAL', abandonedBeforeRemoteCall: null }), label: 'verified reversed', detail: /audit trail/, neverSent: false },
  { name: 'VERIFIED_REVERSAL that also carries the sweep flag (both proofs present: the reversal wins, the id is real)', cause: 'VERIFIED_REVERSAL', row: row({ externalTransactionId: 'PAY-REAL-8', settlementBasis: 'VERIFIED_REVERSAL', abandonedBeforeRemoteCall: true }), label: 'verified reversed', detail: /may have been posted earlier/, neverSent: false },
  { name: 'FAILED whose own body proves rejection before any request (row 10)', cause: 'REJECTED_BEFORE_POSTING', row: row({ status: 'FAILED' }), opts: { couldHaveReachedLedger: false }, label: 'rejected before posting', detail: /Rejected before posting/, neverSent: false },
]

test('[o3d-1e7sl Codex r1] each PROVEN_NOT_POSTED cause has its own label; only a recorded pre-call proof says "never sent"', () => {
  let neverSentCount = 0
  for (const c of CAUSES) {
    assert.equal(ledgerStanding(c.row, c.opts), 'PROVEN_NOT_POSTED', `precondition: ${c.name}`)
    const shown = describeLedgerStanding(c.row, c.opts)
    console.log(`# cause precondition: ${c.name} => ${shown.cause} / ${shown.label}`)
    assert.equal(shown.cause, c.cause, c.name)
    assert.equal(shown.label, c.label, c.name)
    assert.match(shown.detail, c.detail, c.name)
    const claim = describeDocumentIdClaim(c.row, c.opts) ?? ''
    const text = `${shown.label} ${shown.detail} ${claim}`
    assert.equal(/never sent/i.test(text), c.neverSent, `${c.name}: "never sent" iff recorded pre-call: ${text}`)
    if (c.neverSent) neverSentCount += 1
  }
  assert.equal(neverSentCount, 1)
  // The sync-log, stranded-row and orphan-banner consumers all pass the whole row (status, id, basis, flag) to these
  // two functions; a stranded/sync-log row that is a verified reversal with a connector id must read the same way.
  const stranded = { status: 'CANCELLED', externalTransactionId: 'PAY-REAL-7', settlementBasis: 'VERIFIED_REVERSAL', abandonedBeforeRemoteCall: null }
  assert.match(String(describeDocumentIdClaim(stranded)), /verified reversed in the ledger; no longer present/)
  assert.doesNotMatch(String(describeDocumentIdClaim(stranded)), /posted as|never sent/)
  assert.equal(describeLedgerStanding(stranded).label, 'verified reversed')
})

test('[o3d-1e7sl Codex r1] the mark-handled blocking-row wording names the cause too: a verified reversal is never "never sent"', async () => {
  const { describeSyncRowStanding } = await import('@/lib/domain/accounting/posting-mark-handled')
  const pre = describeSyncRowStanding(row({ abandonedBeforeRemoteCall: true }))
  const vr = describeSyncRowStanding(row({ externalTransactionId: 'PAY-REAL-7', settlementBasis: 'VERIFIED_REVERSAL' }))
  const rejected = describeSyncRowStanding(row({ status: 'FAILED' }), )
  assert.match(pre, /never sent \(recorded before the remote call\)/)
  assert.match(vr, /verified reversed in the ledger \(it may have been posted earlier\)/)
  assert.doesNotMatch(vr, /never sent/)
  assert.doesNotMatch(rejected, /never sent|rejected before posting/, 'a bare FAILED row is UNKNOWN: nothing proves it')
})
