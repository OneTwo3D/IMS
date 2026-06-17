import assert from 'node:assert/strict'
import test from 'node:test'

import { computeReturnCreditNoteDraft } from '../../../lib/domain/purchasing/return-credit-note.ts'

const bill = (over: Partial<Parameters<typeof computeReturnCreditNoteDraft>[0]['bills'][number]> = {}) => ({
  invoiceId: 'INV1',
  subtotalForeign: 150,
  totalForeign: 180, // 20% VAT
  fxRateToBase: 1,
  alreadyCreditedForeign: 0,
  alreadyReturnCreditedForeign: 0,
  createdAt: 1,
  lines: [{ poLineId: 'L1', qtyBilled: 15, totalForeign: 150 }],
  ...over,
})

test('returns no draft when the PO has no bills', () => {
  assert.deepEqual(
    computeReturnCreditNoteDraft({
      poLines: [{ poLineId: 'L1', qtyReceived: 15, qtyReturned: 3 }],
      bills: [],
    }),
    { draft: null, suppressedForeign: 0 },
  )
})

test('returns no draft when nothing is over-billed (kept >= billed)', () => {
  assert.deepEqual(
    computeReturnCreditNoteDraft({
      poLines: [{ poLineId: 'L1', qtyReceived: 15, qtyReturned: 0 }],
      bills: [bill()],
    }),
    { draft: null, suppressedForeign: 0 },
  )
})

test('credits the grossed-up value of returned billed goods', () => {
  // billed 15 @ £10 net; received 15, returned 3 → 3 units over-billed = £30 net,
  // grossed up by 180/150 = 1.2 → £36 incl-VAT.
  const { draft } = computeReturnCreditNoteDraft({
    poLines: [{ poLineId: 'L1', qtyReceived: 15, qtyReturned: 3 }],
    bills: [bill()],
  })
  assert.deepEqual(draft, { invoiceId: 'INV1', amountForeign: 36, amountBase: 36, fxRateToBase: 1 })
})

test('a no-VAT bill is credited at the net value (gross-up ratio 1)', () => {
  const { draft } = computeReturnCreditNoteDraft({
    poLines: [{ poLineId: 'L1', qtyReceived: 15, qtyReturned: 3 }],
    bills: [bill({ subtotalForeign: 150, totalForeign: 150 })],
  })
  assert.deepEqual(draft, { invoiceId: 'INV1', amountForeign: 30, amountBase: 30, fxRateToBase: 1 })
})

test('converts the credit to base currency via the bill fx rate', () => {
  const { draft } = computeReturnCreditNoteDraft({
    poLines: [{ poLineId: 'L1', qtyReceived: 15, qtyReturned: 3 }],
    bills: [bill({ fxRateToBase: 1.1 })],
  })
  assert.equal(draft?.amountForeign, 36)
  assert.equal(draft?.amountBase, 39.6)
})

test('nets out prior RETURN credit notes so repeated returns only top up', () => {
  // Cumulative returned now 5 → 5 units over-billed = £50 net → £60 gross.
  // £36 already credited by a prior RETURN → incremental £24.
  const { draft } = computeReturnCreditNoteDraft({
    poLines: [{ poLineId: 'L1', qtyReceived: 15, qtyReturned: 5 }],
    bills: [bill({ alreadyCreditedForeign: 36, alreadyReturnCreditedForeign: 36 })],
  })
  assert.equal(draft?.amountForeign, 24)
})

test('returns no draft when the return credit is already fully covered by prior return credits', () => {
  // 3 returned → £36 gross owed, already £36 credited by returns → nothing new.
  assert.deepEqual(
    computeReturnCreditNoteDraft({
      poLines: [{ poLineId: 'L1', qtyReceived: 15, qtyReturned: 3 }],
      bills: [bill({ alreadyCreditedForeign: 36, alreadyReturnCreditedForeign: 36 })],
    }),
    { draft: null, suppressedForeign: 0 },
  )
})

test('a MANUAL credit does NOT suppress the return credit (audit-rz6e)', () => {
  // £36 owed for the return; £36 already on the bill but as a MANUAL allowance
  // (alreadyReturnCreditedForeign = 0). The return credit must still be created
  // in full — the bill has capacity (180 - 36 = 144) — and nothing is suppressed.
  const { draft, suppressedForeign } = computeReturnCreditNoteDraft({
    poLines: [{ poLineId: 'L1', qtyReceived: 15, qtyReturned: 3 }],
    bills: [bill({ alreadyCreditedForeign: 36, alreadyReturnCreditedForeign: 0 })],
  })
  assert.equal(draft?.amountForeign, 36)
  assert.equal(suppressedForeign, 0)
})

test('a MANUAL credit that consumes most capacity caps the draft and reports the suppressed remainder', () => {
  // Whole order returned → £180 gross owed. A £170 MANUAL credit leaves only £10
  // of capacity, so £10 is drafted and £170 is reported suppressed for finance.
  const { draft, suppressedForeign } = computeReturnCreditNoteDraft({
    poLines: [{ poLineId: 'L1', qtyReceived: 15, qtyReturned: 15 }],
    bills: [bill({ alreadyCreditedForeign: 170, alreadyReturnCreditedForeign: 0 })],
  })
  assert.equal(draft?.amountForeign, 10)
  assert.equal(suppressedForeign, 170)
})

test('a MANUAL credit that fully consumes capacity suppresses the whole return credit (no draft)', () => {
  // £36 owed for the return but a £180 MANUAL credit already uses the entire bill
  // → no draft, and the full £36 is reported suppressed.
  const { draft, suppressedForeign } = computeReturnCreditNoteDraft({
    poLines: [{ poLineId: 'L1', qtyReceived: 15, qtyReturned: 3 }],
    bills: [bill({ alreadyCreditedForeign: 180, alreadyReturnCreditedForeign: 0 })],
  })
  assert.equal(draft, null)
  assert.equal(suppressedForeign, 36)
})

test('never credits more than the bill gross (cap), netting prior return credits', () => {
  // Whole order returned → £180 gross owed = the full bill; £170 already credited
  // by returns → only £10 more, never exceeding the bill total.
  const { draft } = computeReturnCreditNoteDraft({
    poLines: [{ poLineId: 'L1', qtyReceived: 15, qtyReturned: 15 }],
    bills: [bill({ alreadyCreditedForeign: 170, alreadyReturnCreditedForeign: 170 })],
  })
  assert.equal(draft?.amountForeign, 10)
})

test('multi-bill over-billed line falls back to manual (no draft)', () => {
  const older = bill({ invoiceId: 'INV_OLD', createdAt: 1 })
  const newer = bill({ invoiceId: 'INV_NEW', createdAt: 2 })
  const { draft } = computeReturnCreditNoteDraft({
    poLines: [{ poLineId: 'L1', qtyReceived: 15, qtyReturned: 3 }],
    // L1 is billed on BOTH bills (mixed tax/FX can't be split from a PO-level
    // average), so no draft is auto-created — finance handles it manually.
    bills: [older, newer],
  })
  assert.equal(draft, null)
})

test('a second contributing bill on a DIFFERENT line still allows single-bill auto-credit', () => {
  // L1 billed only on INV1 (returned), L2 billed only on INV2 (kept) → only INV1
  // is a contributing (over-billed) bill, so the credit is created against it.
  const { draft } = computeReturnCreditNoteDraft({
    poLines: [
      { poLineId: 'L1', qtyReceived: 15, qtyReturned: 3 },
      { poLineId: 'L2', qtyReceived: 10, qtyReturned: 0 },
    ],
    bills: [
      bill({ invoiceId: 'INV1', createdAt: 1, lines: [{ poLineId: 'L1', qtyBilled: 15, totalForeign: 150 }] }),
      bill({ invoiceId: 'INV2', createdAt: 2, subtotalForeign: 100, totalForeign: 120, lines: [{ poLineId: 'L2', qtyBilled: 10, totalForeign: 100 }] }),
    ],
  })
  assert.equal(draft?.invoiceId, 'INV1')
  assert.equal(draft?.amountForeign, 36)
})

test('clamps a corrupt qtyReturned > qtyReceived to zero net (no negative credit)', () => {
  const { draft } = computeReturnCreditNoteDraft({
    poLines: [{ poLineId: 'L1', qtyReceived: 5, qtyReturned: 99 }],
    bills: [bill()],
  })
  // netReceived clamps to 0 → over-billed = 15 units → full bill gross £180.
  assert.equal(draft?.amountForeign, 180)
})
