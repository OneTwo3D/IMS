import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyPersistedRefundLineKind,
  creditNoteDocumentStanding,
  creditNoteLedger,
  readCreditNoteOrderDiscount,
} from '@/lib/domain/accounting/credit-note-order-discount'

/**
 * o3d-y14 r7 finding 4 — WHAT A POSTED CREDIT NOTE REVERSED, and when that is knowable.
 *
 * THE PREMISE THIS FILE SETTLES. Round 6 suppressed every remedy on a refunded order on the stated
 * ground that the credit note's discount leg cannot be identified, "because the refund service
 * mirrors the invoice's discount line as an ordinary NEGATIVE LINE whose kind is not preserved in
 * what IMS recorded". `SalesOrderRefundLine.lineKind` is a persisted column carrying exactly that
 * kind, and for legacy NULLs production's own accounting-retry loader reconstructs it
 * deterministically. So the premise was false, and the suppression it justified was broader than the
 * evidence required.
 *
 * THE FIXTURES DIFFER ON ONE FIELD AT A TIME, and every refusal fixture is the derivable one with
 * exactly one thing changed. A fixture set where "derivable" and "refused" rendered the same answer
 * would prove nothing at all — so each pair is asserted to differ, not merely to individually match.
 */

type RefundRow = {
  id: string
  chargeback: boolean
  totalsBasis: string | null
  accountingCreditNoteId: string | null
  lines: Array<{ salesOrderLineId: string | null; totalBase: number; totalForeign: number; lineKind: string | null }>
}

/**
 * A chargeback that MIRRORED the invoice: the goods at full value, and the invoice's order-level
 * discount as the separate NEGATIVE leg `buildChargebackRefundLines` emits.
 */
function mirroringChargeback(over: Partial<RefundRow> = {}): RefundRow {
  return {
    id: 'refund-1',
    chargeback: true,
    totalsBasis: 'NET',
    accountingCreditNoteId: 'CN-501',
    lines: [
      { salesOrderLineId: 'line-1', totalBase: 100, totalForeign: 100, lineKind: 'sale' },
      { salesOrderLineId: null, totalBase: -10, totalForeign: -10, lineKind: 'discount' },
    ],
    ...over,
  }
}

/**
 * ONE mirrored CREDIT_NOTE event, as the r8 finding 3 standing check reads it.
 *
 * The DEFAULT for every fixture below is a single POSTED event naming the same credit note the
 * refund names — i.e. "the document still stands exactly as IMS recorded it", which is the world
 * r7's premise silently assumed. Every finding-3 fixture departs from it on one field.
 */
type CreditNoteEventRow = {
  sourceEntityId: string
  type: string
  status: string
  externalId: string | null
  /** r9 finding 1: WHICH LEDGER the document was posted to. */
  externalSystem: string | null
}

function standingCreditNote(refund: RefundRow): CreditNoteEventRow {
  return {
    sourceEntityId: refund.id,
    type: 'CREDIT_NOTE',
    status: 'POSTED',
    externalId: refund.accountingCreditNoteId,
    externalSystem: 'xero',
  }
}

/**
 * A client that HONOURS `where.id.in` — a double that returned everything would net the wrong set —
 * and that serves the mirrored CREDIT_NOTE events, filtered the way production filters them.
 */
function makeClient(rows: RefundRow[], events?: CreditNoteEventRow[]) {
  const eventRows = events ?? rows.map(standingCreditNote)
  return {
    salesOrderRefund: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        rows.filter((row) => where.id.in.includes(row.id)),
    },
    accountingEvent: {
      findMany: async ({
        where,
      }: {
        where: { sourceEntityType: string; sourceEntityId: { in: string[] }; type: string }
      }) => {
        if (where.sourceEntityType !== 'SalesOrderRefund') throw new Error('unexpected sourceEntityType')
        return eventRows.filter(
          (row) => where.sourceEntityId.in.includes(row.sourceEntityId) && row.type === where.type,
        )
      },
    },
  } as never
}

const FULLY_REVERSED: {
  disposition: 'NONE' | 'PARTIAL' | 'FULL'
  refundIds: string[]
  postedCreditNoteExternalIds: string[]
  unresolvedRefundParkExternalIds: string[]
} = {
  disposition: 'FULL',
  refundIds: ['refund-1'],
  postedCreditNoteExternalIds: ['CN-501'],
  unresolvedRefundParkExternalIds: [] as string[],
}

async function read(
  rows: RefundRow[],
  evidence: Partial<typeof FULLY_REVERSED> = {},
  events?: CreditNoteEventRow[],
) {
  return await readCreditNoteOrderDiscount(makeClient(rows, events), { ...FULLY_REVERSED, ...evidence })
}

// ---------------------------------------------------------------------------
// The premise: the kind IS persisted, and the legacy rule IS production's
// ---------------------------------------------------------------------------

test('the persisted lineKind identifies the discount leg — r6 said it could not (o3d-y14 r7 F4)', async () => {
  const result = await read([mirroringChargeback()])

  assert.equal(result.ok, true)
  assert.equal(result.ok && result.amount, 10)
  assert.equal(result.legs.length, 1)
  assert.equal(result.legs[0].amount, 10)
  assert.match(result.legs[0].detail, /CN-501 reversed 10 of order-level discount/)
})

test('a legacy NULL lineKind is reconstructed by production\'s own rule (o3d-y14 r7 F4)', async () => {
  // `reconstructReplayLine` in refund-service.ts: no salesOrderLineId and a NEGATIVE total is a
  // discount leg. That is the discriminator r6 said did not exist, and it is the one an accounting
  // RETRY would post the credit note from — so reading it here posts nothing new, it reads back what
  // the retry loader would.
  const legacy = mirroringChargeback({
    lines: [
      { salesOrderLineId: 'line-1', totalBase: 100, totalForeign: 100, lineKind: null },
      { salesOrderLineId: null, totalBase: -10, totalForeign: -10, lineKind: null },
    ],
  })

  const result = await read([legacy])

  assert.equal(result.ok, true)
  assert.equal(result.ok && result.amount, 10)
})

test('the kind classifier is exactly the production rule, in both directions', () => {
  assert.equal(classifyPersistedRefundLineKind({ salesOrderLineId: null, totalBase: -10, totalForeign: -10, lineKind: 'discount' }), 'discount')
  assert.equal(classifyPersistedRefundLineKind({ salesOrderLineId: 'l', totalBase: 5, totalForeign: 5, lineKind: null }), 'sale')
  assert.equal(classifyPersistedRefundLineKind({ salesOrderLineId: null, totalBase: -1, totalForeign: -1, lineKind: null }), 'discount')
  // A monetary-only line: null product, POSITIVE total. The persisted kind wins, which is the whole
  // point of the column (o3d-w00 #4) — the inference alone would call this 'shipping'.
  assert.equal(classifyPersistedRefundLineKind({ salesOrderLineId: null, totalBase: 5, totalForeign: 5, lineKind: 'sale' }), 'sale')
  assert.equal(classifyPersistedRefundLineKind({ salesOrderLineId: null, totalBase: 5, totalForeign: 5, lineKind: null }), 'shipping')
})

test('a mirroring chargeback with NO discount leg reversed NONE, and says so as a fact', async () => {
  // The invoice posted no order-level discount (a Xero invoice enqueued with no discount account
  // code), so the mirror emitted no leg. That IS a zero — the credit note demonstrably carried
  // nothing — and it is not the same statement as "we cannot tell", which the next test is.
  const result = await read([
    mirroringChargeback({ lines: [{ salesOrderLineId: 'line-1', totalBase: 100, totalForeign: 100, lineKind: 'sale' }] }),
  ])

  assert.equal(result.ok, true)
  assert.equal(result.ok && result.amount, 0)
  assert.match(result.legs[0].detail, /carries NO order-level discount line, so it reversed none/)
})

// ---------------------------------------------------------------------------
// Where it genuinely CANNOT be derived — one field at a time
// ---------------------------------------------------------------------------

test('a WooCommerce-mirrored refund REFUSES — its missing leg is not a zero (o3d-y14 r7 F4)', async () => {
  // `refund-sync.ts` only ever emits 'sale' and 'shipping' kinds, because it reverses what
  // WooCommerce actually refunded rather than what the invoice charged. Its credit note therefore
  // has no relationship to the order-level discount, and reading the absent leg as 0 — which is what
  // an unguarded sum would do — would net the invoice's whole discount against nothing.
  const wooMirrored = mirroringChargeback({
    chargeback: false,
    lines: [{ salesOrderLineId: 'line-1', totalBase: 40, totalForeign: 40, lineKind: 'sale' }],
  })
  const derivable = mirroringChargeback({
    lines: [{ salesOrderLineId: 'line-1', totalBase: 40, totalForeign: 40, lineKind: 'sale' }],
  })

  const refused = await read([wooMirrored])
  const allowed = await read([derivable])

  assert.equal(refused.ok, false)
  assert.equal(refused.legs[0].amount, null)
  assert.match(refused.detail, /not built by mirroring the invoice/)
  // The pair differs on `chargeback` ALONE, and the two answers are opposite. Without this the
  // refusal above could be passing because of some other field of the fixture.
  assert.equal(allowed.ok, true)
  assert.notEqual(refused.ok, allowed.ok)
})

test('a PARTIAL position REFUSES even when every leg derives (o3d-y14 r7 F4)', async () => {
  const result = await read([mirroringChargeback()], { disposition: 'PARTIAL' })

  assert.equal(result.ok, false)
  assert.equal(result.legs[0].amount, 10, 'the leg is still reported as a fact')
  assert.match(result.detail, /reverse only PART of it needs an apportionment/)
})

test('an unrecorded refund PARK REFUSES the net (o3d-y14 r7 F1 + F4)', async () => {
  // Money left the business that no refund row or credit note accounts for, so the two documents
  // this would subtract are not the whole position.
  const result = await read([mirroringChargeback()], { unresolvedRefundParkExternalIds: ['9001'] })

  assert.equal(result.ok, false)
  assert.match(result.detail, /9001 arrived and could NOT be recorded/)
})

test('GROSS legacy totals REFUSE — they are not the unit the invoice discount is in', async () => {
  const result = await read([mirroringChargeback({ totalsBasis: null })])

  assert.equal(result.ok, false)
  assert.match(result.detail, /stores GROSS totals/)
})

test('a leg whose base and foreign amounts disagree REFUSES rather than picking one', async () => {
  // The credit-note staging posts `orderCurrency === baseCurrency ? totalBase : totalForeign`. When
  // the two agree, both branches name the same number and the choice cannot change the answer; when
  // they do not, which one was posted decides the figure and this cannot tell.
  const result = await read([
    mirroringChargeback({
      lines: [
        { salesOrderLineId: 'line-1', totalBase: 100, totalForeign: 118, lineKind: 'sale' },
        { salesOrderLineId: null, totalBase: -10, totalForeign: -11.8, lineKind: 'discount' },
      ],
    }),
  ])

  assert.equal(result.ok, false)
  assert.match(result.detail, /base \(-10\) and foreign \(-11.8\) amounts differ/)
})

test('a refund whose credit note is NOT in the ledger REFUSES', async () => {
  const result = await read([mirroringChargeback({ accountingCreditNoteId: null })], {
    postedCreditNoteExternalIds: [],
  })

  assert.equal(result.ok, false)
  assert.match(result.detail, /names no credit note in the ledger/)
})

test('a credit note in the ledger that NO refund row accounts for REFUSES (o3d-9kek)', async () => {
  // The back-reference was never written for one of them, so the ledger holds a document this
  // arithmetic would silently leave out of the sum.
  const result = await read([mirroringChargeback()], {
    postedCreditNoteExternalIds: ['CN-501', 'CN-777'],
  })

  assert.equal(result.ok, false)
  assert.match(result.detail, /are not the set this order's refunds name/)
})

test('a refund id the evidence names but the table does not hold REFUSES', async () => {
  const result = await read([mirroringChargeback()], { refundIds: ['refund-1', 'refund-gone'] })

  assert.equal(result.ok, false)
  assert.match(result.detail, /refund-gone could not be read back/)
})

test('no refund rows at all is a refusal, not a derived zero', async () => {
  const result = await read([], { refundIds: [], postedCreditNoteExternalIds: [] })

  assert.equal(result.ok, false)
  assert.deepEqual(result.legs, [])
  assert.match(result.detail, /no SalesOrderRefund row is recorded/)
})

test('two mirroring chargebacks SUM, and the query asks for exactly the ids named', async () => {
  const asked: string[][] = []
  const rows = [
    mirroringChargeback(),
    mirroringChargeback({
      id: 'refund-2',
      accountingCreditNoteId: 'CN-502',
      lines: [{ salesOrderLineId: null, totalBase: -4, totalForeign: -4, lineKind: 'discount' }],
    }),
  ]
  const inner = makeClient(rows) as unknown as {
    salesOrderRefund: { findMany: (args: { where: { id: { in: string[] } } }) => Promise<RefundRow[]> }
    accountingEvent: unknown
  }
  const client = {
    salesOrderRefund: {
      findMany: async (args: { where: { id: { in: string[] } } }) => {
        asked.push(args.where.id.in)
        return await inner.salesOrderRefund.findMany(args)
      },
    },
    accountingEvent: inner.accountingEvent,
  } as never

  const result = await readCreditNoteOrderDiscount(client, {
    disposition: 'FULL',
    refundIds: ['refund-1', 'refund-2'],
    postedCreditNoteExternalIds: ['CN-501', 'CN-502'],
    unresolvedRefundParkExternalIds: [],
  })

  assert.equal(result.ok, true)
  assert.equal(result.ok && result.amount, 14)
  assert.deepEqual(asked, [['refund-1', 'refund-2']])
})

// ---------------------------------------------------------------------------
// r8 finding 3 — the rows describe a document that must still STAND
// ---------------------------------------------------------------------------

/**
 * The premise r7 established is about POSTING TIME: the persisted lines are what the credit note
 * carried, because neither adapter omits one. It says nothing about a document retired or re-posted
 * afterwards, and the whole netting rests on it — so every fixture below is the derivable one with
 * exactly ONE thing changed about what the mirror says now, and each is asserted to differ from it.
 */
test('a VOIDED credit note is not treated as still carrying its persisted lines (o3d-y14 r8 F3)', async () => {
  const refund = mirroringChargeback()
  const voided = await read([refund], {}, [{ ...standingCreditNote(refund), status: 'VOID' }])
  const live = await read([refund])

  assert.equal(voided.ok, false)
  assert.equal(voided.legs[0].amount, null)
  assert.match(voided.detail, /status VOID — a credit note that was retired or re-posted/)
  // The pair differs on the mirrored STATUS alone, and the two answers are opposite.
  assert.equal(live.ok, true)
  assert.equal(live.ok && live.amount, 10)
  assert.notEqual(voided.ok, live.ok)
})

test('a REVERSED credit note refuses for the same reason a voided one does (o3d-y14 r8 F3)', async () => {
  const refund = mirroringChargeback()
  const result = await read([refund], {}, [{ ...standingCreditNote(refund), status: 'REVERSED' }])

  assert.equal(result.ok, false)
  assert.match(result.detail, /status REVERSED/)
})

test('a credit note being RE-POSTED (an unsettled event beside it) refuses (o3d-y14 r8 F3)', async () => {
  // Under `@@unique([externalSystem, externalId])` a re-post of the SAME document cannot reach
  // POSTED a second time, so a PENDING/FAILED event sitting beside a refund that already names a
  // credit note is exactly the trace of a document that was changed after it was first written.
  const refund = mirroringChargeback()
  const result = await read([refund], {}, [
    standingCreditNote(refund),
    { ...standingCreditNote(refund), status: 'FAILED', externalId: null },
  ])

  assert.equal(result.ok, false)
  assert.match(result.detail, /status FAILED/)
})

test('TWO posted credit notes for one refund refuse — netting one leaves the other out', async () => {
  const refund = mirroringChargeback()
  const result = await read([refund], {}, [
    standingCreditNote(refund),
    { ...standingCreditNote(refund), externalId: 'CN-999' },
  ])

  assert.equal(result.ok, false)
  assert.match(result.detail, /mirrors 2 POSTED credit notes/)
})

test('NO mirrored credit-note event at all is a refusal, not a pass (o3d-y14 r8 F3)', async () => {
  // The mirror is best-effort, so its silence is not proof the document is wrong — and it is equally
  // not the confirmation this arithmetic needs. Suppressing and reporting is the safe fallback.
  const result = await read([mirroringChargeback()], {}, [])

  assert.equal(result.ok, false)
  assert.match(result.detail, /no mirrored CREDIT_NOTE event exists for refund refund-1/)
})

test('the mirrored document naming a DIFFERENT credit note refuses (o3d-y14 r8 F3)', async () => {
  const refund = mirroringChargeback()
  const result = await read([refund], {}, [{ ...standingCreditNote(refund), externalId: 'CN-OTHER' }])

  assert.equal(result.ok, false)
  assert.match(result.detail, /but the mirrored document is CN-OTHER/)
})

test('a refund flagged for an accounting RETRY refuses — its staging did not complete', async () => {
  const result = await read([{ ...mirroringChargeback(), accountingRetryRequired: true } as never])

  assert.equal(result.ok, false)
  assert.match(result.detail, /flagged for an accounting RETRY/)
})

test('a refund carrying an accounting WARNING refuses', async () => {
  const result = await read([{ ...mirroringChargeback(), accountingWarning: 'credit note failed' } as never])

  assert.equal(result.ok, false)
  assert.match(result.detail, /carries an accounting warning \(credit note failed\)/)
})

test('the standing check is PURE and reachable from a plain value, in both directions', () => {
  const refund = { id: 'refund-1', accountingCreditNoteId: 'CN-501' }
  assert.deepEqual(
    creditNoteDocumentStanding(refund, [
      { sourceEntityId: 'refund-1', status: 'POSTED', externalId: 'CN-501', externalSystem: 'xero' },
    ]),
    { ok: true, externalSystem: 'xero' },
  )
  // A POSTED event with a NULL external id is still the document IMS named: the back-reference can
  // be written where the mirror's id was not (o3d-9kek), and refusing that would suppress the very
  // shape the rest of this file is careful to keep derivable.
  assert.deepEqual(
    creditNoteDocumentStanding(refund, [
      { sourceEntityId: 'refund-1', status: 'POSTED', externalId: null, externalSystem: 'xero' },
    ]),
    { ok: true, externalSystem: 'xero' },
  )
  assert.equal(creditNoteDocumentStanding(refund, []).ok, false)
})

// ---------------------------------------------------------------------------
// r9 finding 1 — WHICH SET OF BOOKS these documents are in
// ---------------------------------------------------------------------------

/**
 * THE FIXTURES DISTINGUISH TWO LEDGERS FROM ONE, and nothing else.
 *
 * Every fixture below is the derivable two-chargeback position with exactly ONE field changed —
 * `externalSystem` on a mirrored credit-note event — because the whole finding is that a figure was
 * being subtracted from another without either document saying which books it belonged to. A fixture
 * set where one ledger and two rendered the same answer would prove nothing, so each is asserted to
 * differ from the one-ledger case rather than merely to individually refuse.
 */
function secondChargeback(over: Partial<RefundRow> = {}): RefundRow {
  return mirroringChargeback({
    id: 'refund-2',
    accountingCreditNoteId: 'CN-502',
    lines: [{ salesOrderLineId: null, totalBase: -4, totalForeign: -4, lineKind: 'discount' }],
    ...over,
  })
}

const TWO_CREDIT_NOTES = {
  refundIds: ['refund-1', 'refund-2'],
  postedCreditNoteExternalIds: ['CN-501', 'CN-502'],
}

test('the derived leg carries the LEDGER its credit note was posted to (o3d-y14 r9 F1)', async () => {
  const result = await read([mirroringChargeback()])

  assert.equal(result.ok, true)
  assert.equal(result.ok && result.externalSystem, 'xero')
  assert.equal(result.legs[0].externalSystem, 'xero')
})

test('TWO credit notes in DIFFERENT accounting systems do not jointly reverse one invoice (r9 F1)', async () => {
  // The connector-switch shape. `connector-orphans.ts` exists because the active accounting
  // connector CAN be switched (Xero → QuickBooks), and IMS keeps each historical document under the
  // connector that posted it — so these two credit notes reduce balances in two separate sets of
  // books and their totals do not add up to a reversal of anything.
  const rows = [mirroringChargeback(), secondChargeback()]
  const split = await read(rows, TWO_CREDIT_NOTES, [
    standingCreditNote(rows[0]),
    { ...standingCreditNote(rows[1]), externalSystem: 'quickbooks' },
  ])
  const oneLedger = await read(rows, TWO_CREDIT_NOTES)

  assert.equal(split.ok, false)
  assert.match(split.detail, /posted by DIFFERENT accounting systems \(quickbooks, xero\)/)
  // Both legs still DERIVED — this is a refusal of the SUBTRACTION, not of the facts.
  assert.deepEqual(
    split.legs.map((leg) => leg.amount),
    [10, 4],
  )
  // The pair differs on `externalSystem` alone, and the two answers are opposite.
  assert.equal(oneLedger.ok, true)
  assert.equal(oneLedger.ok && oneLedger.amount, 14)
  assert.notEqual(split.ok, oneLedger.ok)
  assert.notEqual(split.detail, oneLedger.detail)
})

test('a mirrored credit note that names NO accounting system establishes no ledger (r9 F1)', async () => {
  const refund = mirroringChargeback()
  const unnamed = await read([refund], {}, [{ ...standingCreditNote(refund), externalSystem: null }])
  const named = await read([refund])

  assert.equal(unnamed.ok, false)
  assert.match(unnamed.detail, /record NO accounting system/)
  assert.equal(unnamed.legs[0].amount, 10, 'the leg is still a fact and is still reported')
  assert.equal(unnamed.legs[0].externalSystem, null)
  assert.equal(named.ok, true)
  assert.notEqual(unnamed.ok, named.ok)
})

test('the ledger check is PURE and reachable from plain legs, in every direction (r9 F1)', () => {
  const leg = (over: Partial<import('@/lib/domain/accounting/credit-note-order-discount').CreditNoteDiscountLeg>) => ({
    refundId: 'refund-1',
    externalCreditNoteId: 'CN-501',
    chargeback: true,
    externalSystem: 'xero' as string | null,
    amount: 10 as number | null,
    detail: '',
    ...over,
  })

  assert.deepEqual(creditNoteLedger([leg({})]), { ok: true, externalSystem: 'xero' })
  assert.equal(creditNoteLedger([leg({}), leg({ externalSystem: 'quickbooks' })]).ok, false)
  assert.equal(creditNoteLedger([leg({ externalSystem: null })]).ok, false)
  // A leg that REFUSED contributes no ledger, so a position made only of refusals establishes none.
  assert.equal(creditNoteLedger([leg({ amount: null })]).ok, false)
  // ...and a refused leg does not drag a derived one into a false disagreement either.
  assert.deepEqual(creditNoteLedger([leg({}), leg({ amount: null, externalSystem: null })]), {
    ok: true,
    externalSystem: 'xero',
  })
})
