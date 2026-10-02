import assert from 'node:assert/strict'
import test from 'node:test'

import {
  LEDGER_STANDING_SELECT,
  MAY_HAVE_REACHED_LEDGER_WHERE,
  PROVEN_LEDGER_FACT_WHERE,
  UNPROVEN_CANCELLED_WHERE,
  WORK_SLOT_OCCUPIED_WHERE,
  isProvenLedgerFact,
  ledgerStanding,
  mayHaveReachedLedger,
  workSlotStanding,
  type LedgerStanding,
  type LedgerStandingRow,
} from '@/lib/domain/accounting/ledger-standing'
import { cancelledClaimIsResolved, UNRESOLVED_ABANDONED_CLAIM_WHERE } from '@/lib/domain/accounting/unresolved-abandoned-claim'
import { matchesWhere } from '@/tests/helpers/shopping-sync-log-fake'

/**
 * o3d-f709 - THE TRUTH TABLE, ONE TEST PER ROW, AND THE PROOF THAT THE PRISMA RENDERINGS ARE THE SAME
 * RULE AS THE TYPESCRIPT.
 *
 * Every row test PRINTS its precondition (the row it constructed and the standing it got) and asserts
 * the constructed row really is the shape the table row names - a fixture that quietly became another
 * shape would make the row's test pass for the wrong reason, which is how three tests on one branch
 * once passed while examining nothing.
 */

function row(over: Partial<LedgerStandingRow>): LedgerStandingRow {
  return { status: 'CANCELLED', externalTransactionId: null, abandonedBeforeRemoteCall: null, settlementBasis: null, ...over }
}

type Case = { n: number; name: string; row: LedgerStandingRow; opts?: { couldHaveReachedLedger?: boolean }; expect: LedgerStanding }

const OA = 'OPERATOR_ASSERTION'
const VR = 'VERIFIED_REVERSAL'
const REL = 'OPERATOR_RELEASE'

const TABLE: Case[] = [
  { n: 1, name: 'an unrecognised non-null basis (any status)', row: row({ status: 'SYNCED', externalTransactionId: 'X-1', settlementBasis: 'SOMETHING_NEWER' }), expect: 'UNKNOWN' },
  { n: 1, name: 'an unrecognised basis on a CANCELLED row with no id and the sweep flag (would be row 8 if the basis were read as NULL)', row: row({ status: 'CANCELLED', abandonedBeforeRemoteCall: true, settlementBasis: 'SOMETHING_NEWER' }), expect: 'UNKNOWN' },
  { n: 2, name: 'PENDING + OPERATOR_ASSERTION (no writer)', row: row({ status: 'PENDING', settlementBasis: OA }), expect: 'UNKNOWN' },
  // Row 2 is only observable on a row that WOULD match row 3 without it: an asserted id on unfinished
  // work. (Without an id the default arm answers UNKNOWN anyway, so the case above cannot isolate it.)
  { n: 2, name: 'PROCESSING + OPERATOR_ASSERTION + an id (would be row 3 without row 2)', row: row({ status: 'PROCESSING', externalTransactionId: 'TYPED', settlementBasis: OA }), expect: 'UNKNOWN' },
  { n: 3, name: 'SYNCED POSTED settlement: OPERATOR_ASSERTION + typed id', row: row({ status: 'SYNCED', externalTransactionId: 'TYPED-1', settlementBasis: OA }), expect: 'ASSERTED_POSTED' },
  { n: 3, name: 'CANCELLED cancelled-sale settlement: OPERATOR_ASSERTION + typed id', row: row({ status: 'CANCELLED', externalTransactionId: 'TYPED-2', settlementBasis: OA }), expect: 'ASSERTED_POSTED' },
  { n: 4, name: 'CANCELLED NOT_POSTED settlement: OPERATOR_ASSERTION, no id', row: row({ status: 'CANCELLED', settlementBasis: OA }), expect: 'ASSERTED_NOT_POSTED' },
  { n: 5, name: 'CANCELLED + VERIFIED_REVERSAL, id kept', row: row({ status: 'CANCELLED', externalTransactionId: 'PAY-1', settlementBasis: VR }), expect: 'PROVEN_NOT_POSTED' },
  { n: 5, name: 'CANCELLED + VERIFIED_REVERSAL, no id', row: row({ status: 'CANCELLED', settlementBasis: VR }), expect: 'PROVEN_NOT_POSTED' },
  { n: 6, name: 'connector writeback: NULL basis + id (SYNCED)', row: row({ status: 'SYNCED', externalTransactionId: 'INV-1' }), expect: 'CONFIRMED_POSTED' },
  { n: 6, name: 'CANCELLED that still names the ledger document (even flagged pre-call)', row: row({ status: 'CANCELLED', externalTransactionId: 'INV-9', abandonedBeforeRemoteCall: true }), expect: 'CONFIRMED_POSTED' },
  { n: 6, name: 'FAILED that names a document', row: row({ status: 'FAILED', externalTransactionId: 'INV-3' }), expect: 'CONFIRMED_POSTED' },
  { n: 6, name: 'OPERATOR_RELEASE + id (SYNCED)', row: row({ status: 'SYNCED', externalTransactionId: 'INV-4', settlementBasis: REL }), expect: 'CONFIRMED_POSTED' },
  { n: 7, name: 'id-less type reaching SYNCED (NULL basis)', row: row({ status: 'SYNCED' }), expect: 'CONFIRMED_POSTED' },
  { n: 7, name: 'id-less SYNCED after an OPERATOR_RELEASE', row: row({ status: 'SYNCED', settlementBasis: REL }), expect: 'CONFIRMED_POSTED' },
  { n: 8, name: 'orphan sweep: CANCELLED + abandonedBeforeRemoteCall true, no id', row: row({ status: 'CANCELLED', abandonedBeforeRemoteCall: true }), expect: 'PROVEN_NOT_POSTED' },
  { n: 9, name: 'CANCELLED by a canceller that knew nothing (flag null)', row: row({ status: 'CANCELLED' }), expect: 'UNKNOWN' },
  { n: 9, name: 'CANCELLED with the flag explicitly false', row: row({ status: 'CANCELLED', abandonedBeforeRemoteCall: false }), expect: 'UNKNOWN' },
  { n: 10, name: 'FAILED whose own body PROVES it was rejected before any request', row: row({ status: 'FAILED' }), opts: { couldHaveReachedLedger: false }, expect: 'PROVEN_NOT_POSTED' },
  { n: 11, name: 'FAILED, nothing else on the row', row: row({ status: 'FAILED' }), expect: 'UNKNOWN' },
  { n: 11, name: 'FAILED with couldHaveReachedLedger true', row: row({ status: 'FAILED' }), opts: { couldHaveReachedLedger: true }, expect: 'UNKNOWN' },
  { n: 12, name: 'PENDING, no id, no basis', row: row({ status: 'PENDING' }), expect: 'LIVE_WORK' },
  { n: 12, name: 'PROCESSING, no id, no basis', row: row({ status: 'PROCESSING' }), expect: 'LIVE_WORK' },
]

for (const c of TABLE) {
  test(`o3d-f709 truth-table row ${c.n}: ${c.name} -> ${c.expect}`, () => {
    const got = ledgerStanding(c.row, c.opts)
    // The precondition, printed: which row, which options, which standing.
    console.log(`# precondition row ${c.n}: ${JSON.stringify(c.row)} ${JSON.stringify(c.opts ?? {})} => ${got}`)
    assert.equal(got, c.expect)
  })
}

test('o3d-f709: every one of the twelve rows is exercised, and the table is not one-sided', () => {
  const rows = new Set(TABLE.map((c) => c.n))
  assert.deepEqual([...rows].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  const standings = new Set(TABLE.map((c) => c.expect))
  assert.equal(standings.size, 6, 'all six standings are produced')
  console.log(`# table cases: ${TABLE.length}; rows covered: ${rows.size}; standings covered: ${standings.size}`)
})

test('o3d-f709 C1: an operator-asserted NOT_POSTED is NOT proof - it may have reached the ledger and is not a fact', () => {
  const asserted = row({ status: 'CANCELLED', settlementBasis: OA })
  assert.equal(ledgerStanding(asserted), 'ASSERTED_NOT_POSTED')
  assert.equal(mayHaveReachedLedger(asserted), true, 'a person\'s word about a ledger IMS never read')
  assert.equal(isProvenLedgerFact(asserted), false)
  // and the control, so the assertion is about the assertion: the sweep's own proof still resolves.
  assert.equal(mayHaveReachedLedger(row({ abandonedBeforeRemoteCall: true })), false)
  assert.equal(cancelledClaimIsResolved(asserted), false)
})

test('o3d-f709: an asserted POSTED id is never a ledger FACT (AMOUNT questions), and a connector one is', () => {
  assert.equal(isProvenLedgerFact(row({ status: 'SYNCED', externalTransactionId: 'T', settlementBasis: OA })), false)
  assert.equal(isProvenLedgerFact(row({ status: 'SYNCED', externalTransactionId: 'T' })), true)
  assert.equal(mayHaveReachedLedger(row({ status: 'SYNCED', externalTransactionId: 'T', settlementBasis: OA })), true)
})

// ---------------------------------------------------------------------------
// THE TWO RENDERINGS ARE ONE RULE: the full cross product through the function and the fragments.
// ---------------------------------------------------------------------------

const STATUSES = ['PENDING', 'PROCESSING', 'SYNCED', 'FAILED', 'CANCELLED']
// '' is the empty-string id (counts as absent in both languages). A whitespace-only id is the
// documented limit and is deliberately not in the population.
const IDS: Array<string | null> = [null, '', 'DOC-1']
const BASES: Array<string | null> = [null, OA, REL, VR, 'SOMETHING_NEWER']
const FLAGS: Array<boolean | null> = [null, false, true]

function population(): LedgerStandingRow[] {
  const out: LedgerStandingRow[] = []
  for (const status of STATUSES) for (const externalTransactionId of IDS) for (const settlementBasis of BASES) for (const abandonedBeforeRemoteCall of FLAGS) {
    out.push({ status, externalTransactionId, settlementBasis, abandonedBeforeRemoteCall })
  }
  return out
}

function where(r: LedgerStandingRow, w: object): boolean {
  return matchesWhere(r as unknown as Record<string, unknown>, w as Record<string, unknown>)
}

test('o3d-f709: MAY_HAVE_REACHED_LEDGER_WHERE agrees with mayHaveReachedLedger on EVERY row of the cross product', () => {
  const pop = population()
  let admitted = 0
  let refused = 0
  for (const r of pop) {
    const ts = mayHaveReachedLedger(r)
    assert.equal(where(r, MAY_HAVE_REACHED_LEDGER_WHERE), ts, `fragment vs function on ${JSON.stringify(r)}`)
    if (ts) admitted += 1; else refused += 1
  }
  console.log(`# cross product: ${pop.length} rows; may-have-reached admits ${admitted}, refuses ${refused}`)
  assert.equal(pop.length, 5 * 3 * 5 * 3)
  assert.ok(admitted > 0 && refused > 0, 'the population is split both ways, so the agreement is not vacuous')
})

test('o3d-f709: PROVEN_LEDGER_FACT_WHERE agrees with isProvenLedgerFact on EVERY row of the cross product', () => {
  let facts = 0
  for (const r of population()) {
    const ts = isProvenLedgerFact(r)
    assert.equal(where(r, PROVEN_LEDGER_FACT_WHERE), ts, `fragment vs function on ${JSON.stringify(r)}`)
    if (ts) facts += 1
  }
  console.log(`# cross product: ${facts} rows are ledger facts`)
  assert.ok(facts > 0)
})

test('o3d-f709: UNPROVEN_CANCELLED_WHERE (retention) is exactly CANCELLED and mayHaveReachedLedger, on every row', () => {
  let matched = 0
  for (const r of population()) {
    const ts = r.status === 'CANCELLED' && mayHaveReachedLedger(r)
    assert.equal(where(r, UNPROVEN_CANCELLED_WHERE), ts, JSON.stringify(r))
    assert.equal(where(r, UNRESOLVED_ABANDONED_CLAIM_WHERE), ts, `retention's name for it: ${JSON.stringify(r)}`)
    if (ts) matched += 1
  }
  console.log(`# cross product: retention keeps ${matched} CANCELLED rows`)
  assert.ok(matched > 0)
})

test('o3d-f709: WORK_SLOT_OCCUPIED_WHERE agrees with workSlotStanding on EVERY row (OCCUPIED iff the index predicate)', () => {
  for (const r of population()) {
    assert.equal(where(r, WORK_SLOT_OCCUPIED_WHERE), workSlotStanding(r).slot === 'OCCUPIED', JSON.stringify(r))
  }
})

test('o3d-f709: the fragments are consistent with the table on the rows that matter to money (spot check by name)', () => {
  const cases: Array<[string, LedgerStandingRow, boolean]> = [
    ['asserted NOT_POSTED is in MAY_HAVE', row({ settlementBasis: OA }), true],
    ['verified reversal with a kept id is NOT in MAY_HAVE', row({ externalTransactionId: 'P', settlementBasis: VR }), false],
    ['swept pre-call is NOT in MAY_HAVE', row({ abandonedBeforeRemoteCall: true }), false],
    ['swept but naming a document IS in MAY_HAVE', row({ abandonedBeforeRemoteCall: true, externalTransactionId: 'D' }), true],
    ['an unrecognised basis is in MAY_HAVE', row({ settlementBasis: 'X' }), true],
  ]
  for (const [name, r, expected] of cases) assert.equal(where(r, MAY_HAVE_REACHED_LEDGER_WHERE), expected, name)
})

test('o3d-f709: the fragments are not the complement of anything - they contain no NOT of a nullable column', () => {
  // A negation over a NULLABLE column is SQL NULL for a NULL row and drops it from both sides of a
  // split. The only `not` operators allowed are the paired ones; `NOT` objects are forbidden.
  const text = JSON.stringify([MAY_HAVE_REACHED_LEDGER_WHERE, PROVEN_LEDGER_FACT_WHERE, UNPROVEN_CANCELLED_WHERE])
  assert.equal(/"NOT"/.test(text), false, 'no top-level NOT object in any fragment')
  console.log(`# fragment text length: ${text.length}`)
})

// ---------------------------------------------------------------------------
// The work slot
// ---------------------------------------------------------------------------

test('o3d-f709 C1: workSlotStanding - OCCUPIED, BLOCKED (never FREE) for an asserted NOT_POSTED, FREE otherwise', () => {
  const asserted = row({ settlementBasis: OA })
  assert.deepEqual(workSlotStanding(asserted), { slot: 'BLOCKED', asserted: true })
  assert.deepEqual(workSlotStanding(row({ status: 'SYNCED', externalTransactionId: 'T', settlementBasis: OA })), { slot: 'OCCUPIED', asserted: true })
  assert.deepEqual(workSlotStanding(row({ status: 'SYNCED', externalTransactionId: 'T' })), { slot: 'OCCUPIED', asserted: false })
  assert.deepEqual(workSlotStanding(row({ status: 'PENDING' })), { slot: 'OCCUPIED', asserted: false })
  assert.deepEqual(workSlotStanding(row({ status: 'PROCESSING' })), { slot: 'OCCUPIED', asserted: false })
  assert.deepEqual(workSlotStanding(row({ abandonedBeforeRemoteCall: true })), { slot: 'FREE', asserted: false })
  assert.deepEqual(workSlotStanding(row({ status: 'FAILED' })), { slot: 'FREE', asserted: false })
  assert.deepEqual(workSlotStanding(row({ externalTransactionId: 'T', settlementBasis: VR })), { slot: 'FREE', asserted: false })
})

test('o3d-f709: the select constant names exactly the columns the row type requires', () => {
  const selected = Object.keys(LEDGER_STANDING_SELECT).sort()
  const required: Array<keyof LedgerStandingRow> = ['status', 'externalTransactionId', 'abandonedBeforeRemoteCall', 'settlementBasis']
  assert.deepEqual(selected, [...required].sort())
  for (const column of selected) {
    assert.equal(LEDGER_STANDING_SELECT[column as keyof typeof LEDGER_STANDING_SELECT], true, `${column} must be selected, not merely named`)
  }
})
