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
    tone: 'proven-unsent', label: 'proven unsent', detail: /never sent/, idClaim: null,
  },
  {
    name: 'PROVEN_NOT_POSTED (verified reversal, id kept)', standing: 'PROVEN_NOT_POSTED', row: row({ externalTransactionId: 'PAY-1', settlementBasis: 'VERIFIED_REVERSAL' }),
    tone: 'proven-unsent', label: 'proven unsent', detail: /reported the document gone/, idClaim: /the accounting system reported it gone/,
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

test('[o3d-1e7sl D1-D4] every standing is described by its basis, and only PROVEN_NOT_POSTED says "never sent" - the standing is asserted first', () => {
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
    if (c.standing !== 'PROVEN_NOT_POSTED') {
      assert.doesNotMatch(`${shown.label ?? ''} ${shown.detail}`, /never sent|proven unsent|nothing was sent|nothing was posted/i, `${c.name}: must not claim the ledger is clear`)
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
