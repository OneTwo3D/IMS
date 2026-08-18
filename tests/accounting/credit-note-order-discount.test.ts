import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyPersistedRefundLineKind,
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

/** A client that HONOURS `where.id.in` — a double that returned everything would net the wrong set. */
function makeClient(rows: RefundRow[]) {
  return {
    salesOrderRefund: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        rows.filter((row) => where.id.in.includes(row.id)),
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

async function read(rows: RefundRow[], evidence: Partial<typeof FULLY_REVERSED> = {}) {
  return await readCreditNoteOrderDiscount(makeClient(rows), { ...FULLY_REVERSED, ...evidence })
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
  const client = {
    salesOrderRefund: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        asked.push(where.id.in)
        return [
          mirroringChargeback(),
          mirroringChargeback({
            id: 'refund-2',
            accountingCreditNoteId: 'CN-502',
            lines: [{ salesOrderLineId: null, totalBase: -4, totalForeign: -4, lineKind: 'discount' }],
          }),
        ].filter((row) => where.id.in.includes(row.id))
      },
    },
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
