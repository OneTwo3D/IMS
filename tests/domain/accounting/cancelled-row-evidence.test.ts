import assert from 'node:assert/strict'
import test from 'node:test'

import {
  LEDGER_STANDING_SELECT,
  MAY_HAVE_REACHED_LEDGER_WHERE,
  mayHaveReachedLedger,
  type LedgerStandingRow,
} from '@/lib/domain/accounting/cancelled-row-evidence'
import { OPERATOR_ASSERTION_SETTLEMENT_BASIS } from '@/lib/domain/accounting/sync-row-settlement'
import { matchesWhere } from '@/tests/helpers/shopping-sync-log-fake'

/**
 * o3d-f709 — THE RULE, AND THE PROOF THAT ITS TWO RENDERINGS ARE ONE RULE.
 *
 * `mayHaveReachedLedger` (TypeScript) and `MAY_HAVE_REACHED_LEDGER_WHERE` (Prisma) are the two
 * languages the ten readers ask this question in. A shared TypeScript helper with a hand-written
 * query beside it is the original defect with better ergonomics, so the population below is run
 * through BOTH and the two answers are asserted EQUAL on every row — not merely each asserted
 * against its own expectation, which is how two renderings drift while both tests stay green.
 */

const SHAPES: Array<{ name: string; row: LedgerStandingRow; mayHaveReached: boolean }> = [
  // ── Not CANCELLED at all. Every one of these may have reached the ledger, including FAILED
  //    (o3d-ju8t: the remote call happens before the result is written back).
  {
    name: 'PENDING',
    row: { status: 'PENDING', externalTransactionId: null, abandonedBeforeRemoteCall: null, settlementBasis: null },
    mayHaveReached: true,
  },
  {
    name: 'PROCESSING',
    row: { status: 'PROCESSING', externalTransactionId: null, abandonedBeforeRemoteCall: null, settlementBasis: null },
    mayHaveReached: true,
  },
  {
    name: 'FAILED, nothing else on the row',
    row: { status: 'FAILED', externalTransactionId: null, abandonedBeforeRemoteCall: null, settlementBasis: null },
    mayHaveReached: true,
  },
  {
    name: 'SYNCED with a connector-confirmed id',
    row: { status: 'SYNCED', externalTransactionId: 'INV-1', abandonedBeforeRemoteCall: null, settlementBasis: null },
    mayHaveReached: true,
  },
  {
    name: 'shape (a): SYNCED with an OPERATOR-TYPED id',
    row: {
      status: 'SYNCED',
      externalTransactionId: 'INV-TYPED-IN',
      abandonedBeforeRemoteCall: null,
      settlementBasis: OPERATOR_ASSERTION_SETTLEMENT_BASIS,
    },
    mayHaveReached: true,
  },

  // ── CANCELLED, and NOTHING on the row resolves it. THE CORRECTION: every hand-written
  //    `status !== 'CANCELLED'` drops these, and they are the majority of cancelled rows —
  //    cancelPendingSalesInvoiceSyncForOrder, the post-time retirement of a claimed row, and every
  //    row cancelled before either marker column existed.
  {
    name: 'CANCELLED by a canceller that knew nothing',
    row: { status: 'CANCELLED', externalTransactionId: null, abandonedBeforeRemoteCall: null, settlementBasis: null },
    mayHaveReached: true,
  },
  {
    name: 'CANCELLED with the pre-call flag explicitly FALSE',
    row: { status: 'CANCELLED', externalTransactionId: null, abandonedBeforeRemoteCall: false, settlementBasis: null },
    mayHaveReached: true,
  },
  {
    name: 'CANCELLED carrying a settlement basis that is not an assertion',
    row: {
      status: 'CANCELLED',
      externalTransactionId: null,
      abandonedBeforeRemoteCall: null,
      settlementBasis: 'OPERATOR_RELEASE',
    },
    mayHaveReached: true,
  },

  // ── CANCELLED and RESOLVED. Only these two shapes carry a proof that no remote call is
  //    unaccounted for, and only these two may be read as "nothing posted".
  {
    name: 'CANCELLED by the orphan sweep, which matched PENDING and so proved the row was pre-call',
    row: { status: 'CANCELLED', externalTransactionId: null, abandonedBeforeRemoteCall: true, settlementBasis: null },
    mayHaveReached: false,
  },
  {
    name: 'shape (b): CANCELLED by an operator asserting NOT_POSTED, no document id',
    row: {
      status: 'CANCELLED',
      externalTransactionId: null,
      abandonedBeforeRemoteCall: null,
      settlementBasis: OPERATOR_ASSERTION_SETTLEMENT_BASIS,
    },
    mayHaveReached: false,
  },

  // ── The external-id veto. A document id exists only because a remote call returned, so it
  //    outranks either proof whichever way the proof points.
  {
    name: 'shape (c): CANCELLED sale settlement — an operator assertion AND a document id',
    row: {
      status: 'CANCELLED',
      externalTransactionId: 'INV-TYPED-IN',
      abandonedBeforeRemoteCall: null,
      settlementBasis: OPERATOR_ASSERTION_SETTLEMENT_BASIS,
    },
    mayHaveReached: true,
  },
  {
    name: 'CANCELLED, flagged pre-call, but naming a document anyway',
    row: { status: 'CANCELLED', externalTransactionId: 'INV-9', abandonedBeforeRemoteCall: true, settlementBasis: null },
    mayHaveReached: true,
  },
]

test('o3d-f709: the rule answers every shape the writers can produce', () => {
  for (const shape of SHAPES) {
    assert.equal(
      mayHaveReachedLedger(shape.row),
      shape.mayHaveReached,
      `mayHaveReachedLedger disagrees about: ${shape.name}`,
    )
  }
})

test('o3d-f709: the Prisma rendering and the TypeScript rendering are the SAME rule', () => {
  for (const shape of SHAPES) {
    assert.equal(
      matchesWhere(shape.row as unknown as Record<string, unknown>, MAY_HAVE_REACHED_LEDGER_WHERE),
      shape.mayHaveReached,
      `MAY_HAVE_REACHED_LEDGER_WHERE disagrees about: ${shape.name}`,
    )
  }
})

test('o3d-f709: the population is not one-sided, so neither assertion above is vacuous', () => {
  // A truth table every row of which answers the same way would be passed by
  // `() => true`, and by the hand-written `status !== 'CANCELLED'` this rule replaces.
  const admitted = SHAPES.filter((s) => s.mayHaveReached)
  const refused = SHAPES.filter((s) => !s.mayHaveReached)
  assert.ok(admitted.length >= 2, 'population must contain rows the rule admits')
  assert.ok(refused.length >= 2, 'population must contain rows the rule refuses')

  // AND IT MUST SEPARATE THE RULE FROM THE ONE IT REPLACES. At least one shape has to be a row
  // that `status !== 'CANCELLED'` and `mayHaveReachedLedger` answer DIFFERENTLY, or the whole
  // table could be satisfied by the predicate this issue exists to remove.
  const disagreements = SHAPES.filter((s) => (s.row.status !== 'CANCELLED') !== s.mayHaveReached)
  assert.ok(
    disagreements.length >= 3,
    `the table must contain rows where the old predicate is wrong; found ${disagreements.length}`,
  )
})

test('o3d-f709: the select constant names exactly the columns the row type requires', () => {
  // The `select` and the row type are two statements of the same list, and a reader that spreads
  // the select but is handed a row type missing a column would compile while answering from
  // `undefined`. Held equal here so neither can grow without the other.
  const selected = Object.keys(LEDGER_STANDING_SELECT).sort()
  const required: Array<keyof LedgerStandingRow> = [
    'status', 'externalTransactionId', 'abandonedBeforeRemoteCall', 'settlementBasis',
  ]
  assert.deepEqual(selected, [...required].sort())
  for (const column of selected) {
    assert.equal(
      LEDGER_STANDING_SELECT[column as keyof typeof LEDGER_STANDING_SELECT],
      true,
      `${column} must be selected, not merely named`,
    )
  }
})
