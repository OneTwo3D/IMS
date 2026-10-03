import assert from 'node:assert/strict'
import test from 'node:test'

import {
  allocationDebitForeignLedgerReports,
  foreignJournalStateOf,
  type AllocationDebitForeignPass,
  type ForeignJournalState,
} from '@/lib/domain/accounting/allocation-debit-passes'
import { ledgerStanding, type LedgerStanding, type LedgerStandingRow } from '@/lib/domain/accounting/ledger-standing'

/**
 * o3d-1e7sl (G15, D2, slice 1c of o3d-f709) - WHAT THE DAILY-BATCH RECREATE SWEEP KNOWS ABOUT A FOREIGN PASS'S JOURNAL.
 *
 * The status-only reading called every PENDING / PROCESSING / SYNCED row `live` ("nothing owed", silent). A SYNCED
 * row an OPERATOR typed a document id into is live for the question "may I rebuild this?" (no: it would post the
 * pounds twice - EXISTENCE counts, D2) but the pounds are in the books on somebody's word, so it is REPORTED. One
 * row per standing; the standing is asserted before the state.
 */
function row(over: Partial<LedgerStandingRow>): LedgerStandingRow {
  return { status: 'SYNCED', externalTransactionId: 'J-1', abandonedBeforeRemoteCall: null, settlementBasis: null, ...over }
}

const CASES: Array<{ name: string; standing: LedgerStanding; row: LedgerStandingRow | undefined; state: ForeignJournalState }> = [
  { name: 'no row at all', standing: 'UNKNOWN', row: undefined, state: 'absent' },
  { name: 'CONFIRMED_POSTED (SYNCED, connector id)', standing: 'CONFIRMED_POSTED', row: row({}), state: 'live' },
  { name: 'LIVE_WORK (PENDING)', standing: 'LIVE_WORK', row: row({ status: 'PENDING', externalTransactionId: null }), state: 'live' },
  { name: 'LIVE_WORK (PROCESSING)', standing: 'LIVE_WORK', row: row({ status: 'PROCESSING', externalTransactionId: null }), state: 'live' },
  { name: 'ASSERTED_POSTED (SYNCED, typed id)', standing: 'ASSERTED_POSTED', row: row({ settlementBasis: 'OPERATOR_ASSERTION' }), state: 'asserted' },
  { name: 'UNKNOWN (FAILED)', standing: 'UNKNOWN', row: row({ status: 'FAILED', externalTransactionId: null }), state: 'unsettled' },
  { name: 'PROVEN_NOT_POSTED (CANCELLED, pre-call proof)', standing: 'PROVEN_NOT_POSTED', row: row({ status: 'CANCELLED', externalTransactionId: null, abandonedBeforeRemoteCall: true }), state: 'unsettled' },
  { name: 'ASSERTED_NOT_POSTED (CANCELLED, operator)', standing: 'ASSERTED_NOT_POSTED', row: row({ status: 'CANCELLED', externalTransactionId: null, settlementBasis: 'OPERATOR_ASSERTION' }), state: 'unsettled' },
]

test('[o3d-1e7sl G15] the foreign journal state per standing: only an operator-typed SYNCED row is "asserted"', () => {
  let asserted = 0
  for (const c of CASES) {
    if (c.row) {
      const standing = ledgerStanding(c.row)
      console.log(`# G15 precondition: ${c.name}: standing ${standing}`)
      assert.equal(standing, c.standing, `fixture is not the standing it names: ${c.name}`)
    }
    assert.equal(foreignJournalStateOf(c.row), c.state, c.name)
    if (c.state === 'asserted') asserted += 1
  }
  console.log(`# G15 cases: ${CASES.length}; asserted: ${asserted}`)
  assert.equal(asserted, 1)
})

const PASS: AllocationDebitForeignPass = {
  order: 'SO-1001', amount: 12.5, syncLogId: 'J-1', connector: 'other', accountCode: '631',
} as AllocationDebitForeignPass

function reports(state: ForeignJournalState, scheduled: string | null = 'xero'): string[] {
  return allocationDebitForeignLedgerReports({
    referenceId: 'A2-2026-07-20',
    foreign: [PASS],
    journalState: () => state,
    scheduledSweepConnector: scheduled,
  })
}

test('[o3d-1e7sl G15] an ASSERTED foreign journal is REPORTED as existing-but-unconfirmed; a live one stays silent; an absent/unsettled one keeps its report', () => {
  assert.deepEqual(reports('live'), [], 'the connector\'s own live journal: nothing owed, nothing to say')
  const asserted = reports('asserted')
  assert.equal(asserted.length, 1)
  assert.match(asserted[0]!, /OPERATOR recorded that journal as posted/)
  assert.match(asserted[0]!, /counts it as existing/)
  assert.match(asserted[0]!, /UNCONFIRMED/)
  // It is NOT the "post it by hand" report: that would tell the operator to double the debit.
  assert.doesNotMatch(asserted[0]!, /Post it in other by hand|NOT on record/)
  const unsettled = reports('unsettled')
  assert.equal(unsettled.length, 1)
  assert.match(unsettled[0]!, /CHECK other FIRST/)
  assert.doesNotMatch(unsettled[0]!, /UNCONFIRMED/)
  const absent = reports('absent')
  assert.match(absent[0]!, /NOT on record/)
  // The scheduled sweep's own connector is rebuilt by that sweep, whatever the state.
  assert.deepEqual(reports('asserted', 'other'), [])
  console.log(`# G15 report cases: live ${reports('live').length}, asserted ${asserted.length}, unsettled ${unsettled.length}, absent ${absent.length}`)
})

test('[o3d-1e7sl G15] an asserted journal beside an abandoned one yields both reports, each with its own remedy', () => {
  const second: AllocationDebitForeignPass = { ...PASS, order: 'SO-1002', syncLogId: 'J-2' }
  const out = allocationDebitForeignLedgerReports({
    referenceId: 'A2-2026-07-20',
    foreign: [PASS, second],
    journalState: (id) => (id === 'J-1' ? 'asserted' : 'unsettled'),
    scheduledSweepConnector: 'xero',
  })
  assert.equal(out.length, 2)
  assert.ok(out.some((text) => /UNCONFIRMED/.test(text) && /SO-1001/.test(text) && !/SO-1002/.test(text)))
  assert.ok(out.some((text) => /CHECK other FIRST/.test(text) && /SO-1002/.test(text) && !/UNCONFIRMED/.test(text)))
})
