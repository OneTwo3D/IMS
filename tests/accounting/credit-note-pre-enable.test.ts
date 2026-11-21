import assert from 'node:assert/strict'
import test from 'node:test'
import { toDecimal } from '@/lib/domain/math/decimal'
import {
  decideXeroCreditNoteWitness,
  planCreditNoteSettlement,
  refundPaymentCap,
  settledCashOutFacts,
  withXeroCashOut,
  type CreditNoteSettlementFacts,
  type WitnessCreditNote,
} from '@/lib/domain/accounting/credit-note-allocation'
import {
  CREDIT_NOTE_DUPLICATE_CHECK_SETTING_KEY,
  creditNoteCreateDuplicates,
  creditNotePaidOutCents,
  matchOrderCreditNote,
  orderCreditNoteSearchWhere,
  readOrderCreditNotesFromXero,
} from '@/lib/connectors/xero/order-credit-notes'
import { SYSTEM_SWITCH_KEYS } from '@/lib/domain/settings/system-switches'

/**
 * o3d-0lpnb (sales credit-note refunds before xero_credit_note_allocation_enabled is turned on), the pure parts: the cap, the merge of what Xero shows paid out on the
 * order's other credit notes (MED-3), the duplicate test (o3d-pnc8p note 1), and the order-credit-note reader against a fake Xero.
 */

const facts = (over: Partial<CreditNoteSettlementFacts> = {}): CreditNoteSettlementFacts => ({
  refund: { id: 'r-self', orderId: 'o-1', deleted: false, creditNoteId: 'cn-self', creditNoteConnector: 'xero', shopRefund: true, createdAt: new Date('2026-11-02'), storeCreditRefund: false, storefrontAmountForeign: null },
  order: { id: 'o-1', currency: 'GBP', invoiceId: 'inv-1', invoiceConnector: 'xero', paidAt: new Date('2026-11-01'), fxRateToBase: toDecimal(1), paymentMethod: 'stripe' },
  creditNotePosted: true,
  invoicePosted: true,
  receiptCount: 1,
  receiptTotal: toDecimal(50),
  invoicePaymentRows: 1,
  recordedRefundCash: toDecimal(0),
  refundPaymentMethod: null,
  refundPaymentPaidAt: null,
  originalReceiptMethod: 'stripe',
  refundedViaGateway: true,
  priorCashOut: toDecimal(0),
  siblingSettled: false,
  ...over,
})

// ---------------------------------------------------------------------------------------------------------------------------------------------
// L8: refundPaymentCap had no unit test. L1: AmountPaid is cash receipts only (applied credit is AmountCredited).
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[0lpnb L8] refundPaymentCap: min(IMS receipts, Xero AmountPaid) less the cash already out; unreadable AmountPaid is ZERO, never the IMS figure', () => {
  assert.equal(refundPaymentCap(facts(), 50).toNumber(), 50)
  assert.equal(refundPaymentCap(facts(), 10).toNumber(), 10, 'Xero holds less than IMS recorded: held to Xero')
  assert.equal(refundPaymentCap(facts({ receiptTotal: toDecimal(30) }), 50).toNumber(), 30, 'IMS holds less: held to IMS')
  assert.equal(refundPaymentCap(facts({ priorCashOut: toDecimal(40) }), 50).toNumber(), 10, 'the other refunds\' cash comes off')
  assert.equal(refundPaymentCap(facts({ priorCashOut: toDecimal(60) }), 50).toNumber(), -10, 'and may go negative (the caller refuses)')
  assert.equal(refundPaymentCap(facts(), null).toNumber(), 0)
  assert.equal(refundPaymentCap(facts(), Number.NaN).toNumber(), 0)
  assert.equal(refundPaymentCap(facts(), Number.POSITIVE_INFINITY).toNumber(), 0)
})

test('[0lpnb L1] the cap documents AmountPaid as payments only, and the balances reader no longer calls it "cash receipts and applied credit"', async () => {
  const { readFile } = await import('node:fs/promises')
  const domain = await readFile('lib/domain/accounting/credit-note-allocation.ts', 'utf8')
  const reader = await readFile('lib/connectors/xero/credit-notes.ts', 'utf8')
  assert.match(domain, /sum of payments received for invoice/)
  assert.match(domain, /AmountCredited/)
  assert.doesNotMatch(domain, /AmountPaid also counts credit applied/)
  assert.doesNotMatch(reader, /cash receipts and applied credit/)
})

// ---------------------------------------------------------------------------------------------------------------------------------------------
// MED-1 / MED-2: the re-checks count only cash that is out or may be
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[0lpnb MED-1] settledCashOutFacts drops the in-flight arm (an older sibling PROCESSING and unattempted) and keeps everything else', () => {
  const f = facts({ priorCashOut: toDecimal(40), priorCashOutSettled: toDecimal(0), cashOutByRefund: new Map([['r-older', toDecimal(40)]]), cashOutSettledByRefund: new Map() })
  const settled = settledCashOutFacts(f)
  assert.equal(settled.priorCashOut.toNumber(), 0)
  assert.equal(settled.cashOutByRefund?.size, 0)
  assert.equal(planCreditNoteSettlement(f).kind, 'REFUND_PAYMENT')
  assert.equal(refundPaymentCap(f, 50).toNumber(), 10, 'the first sizing still sees the claimed 40 ...')
  assert.equal(refundPaymentCap(settled, 50).toNumber(), 50, '... and the order-locked re-check does not')
  // A hand-built fact set without the split reads as before.
  assert.equal(settledCashOutFacts(facts({ priorCashOut: toDecimal(7) })).priorCashOut.toNumber(), 7)
})

test('[0lpnb MED-2] with receipts 40 and an older sibling claiming 40 in flight, the plan is NOT_NOW, but the settled plan is a refund payment: the caller waits rather than retires', () => {
  const f = facts({ receiptTotal: toDecimal(40), priorCashOut: toDecimal(40), priorCashOutSettled: toDecimal(0) })
  const plan = planCreditNoteSettlement(f)
  assert.equal(plan.kind, 'NOT_NOW')
  assert.equal((plan as { reason: string }).reason, 'NO_RECEIPT_CAPACITY')
  assert.equal(planCreditNoteSettlement(settledCashOutFacts(f)).kind, 'REFUND_PAYMENT')
})

// ---------------------------------------------------------------------------------------------------------------------------------------------
// MED-3: Xeroom-era / hand-raised credit notes
// ---------------------------------------------------------------------------------------------------------------------------------------------

const cn = (over: Partial<WitnessCreditNote>): WitnessCreditNote => ({ creditNoteId: 'x', creditNoteNumber: 'CN-1', reference: null, status: 'AUTHORISED', total: 40, byOrder: [], byRefund: [], paidOutCents: 0, ...over })

test('[0lpnb MED-3] 40 + 40 against 50: a Xeroom-era credit note paid out 40 in Xero (invisible to AmountPaid) is counted, so the second refund is held to 10', () => {
  const decision = decideXeroCreditNoteWitness({
    creditNotes: [cn({ creditNoteId: 'xeroom-1', creditNoteNumber: 'CN-11001', reference: '158671-Jane Doe', byOrder: ['158671'], total: 39.5, paidOutCents: 4000 })],
    settlingCreditNoteId: 'cn-self',
    imsCreditNotes: new Map([['cn-self', 'r-self']]),
    self: { externalRefundId: '158700', totalCents: 4000 },
  })
  assert.ok(decision.kind === 'ok')
  const merged = withXeroCashOut(facts(), decision.witness)
  assert.equal(merged.priorCashOut.toNumber(), 40)
  assert.equal(refundPaymentCap(merged, 50).toNumber(), 10)
})

test('[0lpnb MED-3] Xero\'s payments on ANOTHER IMS refund\'s credit note merge per refund (the larger figure), never added on top of IMS\'s own record of the same payment', () => {
  const witness = { paidOutByRefund: new Map([['r-other', toDecimal(30)]]), unattributedPaidOut: toDecimal(5) }
  const f = facts({ priorCashOut: toDecimal(40), priorCashOutSettled: toDecimal(40), cashOutByRefund: new Map([['r-other', toDecimal(40)]]), cashOutSettledByRefund: new Map([['r-other', toDecimal(40)]]) })
  const merged = withXeroCashOut(f, witness)
  assert.equal(merged.priorCashOut.toNumber(), 45, 'max(40, 30) + 5 unattributed')
  assert.equal(merged.priorCashOutSettled!.toNumber(), 45)
  const xeroLarger = withXeroCashOut(facts({ priorCashOut: toDecimal(10), cashOutByRefund: new Map([['r-other', toDecimal(10)]]) }), { paidOutByRefund: new Map([['r-other', toDecimal(30)]]), unattributedPaidOut: toDecimal(0) })
  assert.equal(xeroLarger.priorCashOut.toNumber(), 30, 'an operator\'s manual Xero refund of an IMS credit note is now visible')
})

test('[0lpnb MED-3 / pnc8p note 1] a hand-raised credit note referenced by THIS refund\'s id (CN-11573 \'162752\') is a DUPLICATE: nothing is settled', () => {
  const decision = decideXeroCreditNoteWitness({
    creditNotes: [cn({ creditNoteId: 'hand-1', creditNoteNumber: 'CN-11573', reference: '162752', byRefund: ['162752'] })],
    settlingCreditNoteId: 'cn-self',
    imsCreditNotes: new Map([['cn-self', 'r-self']]),
    self: { externalRefundId: '162752', totalCents: null },
  })
  assert.equal(decision.kind, 'duplicate')
})

test('[0lpnb MED-3] a credit note naming only the order is a duplicate when it credits exactly this credit note\'s total, otherwise another refund\'s credit (its cash counted, unattributed)', () => {
  const base = { settlingCreditNoteId: 'cn-self', imsCreditNotes: new Map([['cn-self', 'r-self']]), self: { externalRefundId: '158700', totalCents: 4000 } }
  assert.equal(decideXeroCreditNoteWitness({ ...base, creditNotes: [cn({ creditNoteId: 'x1', byOrder: ['158671'], total: 40, paidOutCents: 4000 })] }).kind, 'duplicate')
  const other = decideXeroCreditNoteWitness({ ...base, creditNotes: [cn({ creditNoteId: 'x2', byOrder: ['158671'], total: 12.79, paidOutCents: 1279 })] })
  assert.equal(other.kind, 'ok')
  assert.equal((other as { witness: { unattributedPaidOut: { toNumber(): number } } }).witness.unattributedPaidOut.toNumber(), 12.79)
})

test('[pnc8p IOSS case 6] a credit note ALLOCATED to a replacement order\'s invoice (CN-11394 -> 157026) moved no cash: nothing is counted; voided ones (162199\'s CN-11629) are ignored', () => {
  const decision = decideXeroCreditNoteWitness({
    creditNotes: [
      cn({ creditNoteId: 'cn-11394', creditNoteNumber: 'CN-11394', reference: '157021-Name', byOrder: ['157021'], total: 43.16, paidOutCents: 0 }),
      cn({ creditNoteId: 'cn-11629', creditNoteNumber: 'CN-11629', byRefund: ['162199'], status: 'VOIDED', total: 39.71 }),
    ],
    settlingCreditNoteId: 'cn-self',
    imsCreditNotes: new Map([['cn-self', 'r-self']]),
    self: { externalRefundId: '162199', totalCents: 595 },
  })
  assert.equal(decision.kind, 'ok')
  assert.equal((decision as { witness: { unattributedPaidOut: { toNumber(): number } } }).witness.unattributedPaidOut.toNumber(), 0)
})

test('[pnc8p IOSS case 5] Woo double-recorded 157021 (a manual 49.10 "full" refund and a 5.95 gateway refund on a 49.11 order): only the gateway refund is cash; the manual one pays nothing out', () => {
  const manual = planCreditNoteSettlement(facts({ receiptTotal: toDecimal(49.11), refundedViaGateway: false }))
  assert.equal(manual.kind, 'NOT_NOW')
  assert.equal((manual as { reason: string }).reason, 'REFUND_NOT_PAID_BY_GATEWAY')
  const gateway = planCreditNoteSettlement(facts({ receiptTotal: toDecimal(49.11), refundedViaGateway: true }))
  assert.equal(gateway.kind, 'REFUND_PAYMENT')
  assert.equal(refundPaymentCap(facts({ receiptTotal: toDecimal(49.11) }), 49.11).toNumber(), 49.11, 'and it is capped by the money received, not by the refund totals')
})

test('[pnc8p note 1] matchOrderCreditNote: by a whole digit run (order id, any refund id) or SC-<refund id>; never a prefix, never a supplier credit', () => {
  const keys = { orderIds: ['158671'], refundIds: ['161212', '162752'] }
  assert.deepEqual(matchOrderCreditNote({ CreditNoteID: 'a', CreditNoteNumber: 'CN-11453', Reference: '161212', Type: 'ACCRECCREDIT' }, keys)?.byRefund, ['161212'])
  assert.deepEqual(matchOrderCreditNote({ CreditNoteID: 'b', CreditNoteNumber: 'CN-10001', Reference: '158671-Jane Doe' }, keys)?.byOrder, ['158671'])
  assert.deepEqual(matchOrderCreditNote({ CreditNoteID: 'c', CreditNoteNumber: 'SC-162752', Reference: null }, keys)?.byRefund, ['162752'])
  assert.equal(matchOrderCreditNote({ CreditNoteID: 'd', CreditNoteNumber: 'CN-1', Reference: '1586710' }, keys), null, '1586710 is not order 158671')
  assert.equal(matchOrderCreditNote({ CreditNoteID: 'e', CreditNoteNumber: 'CN-2', Reference: '161212', Type: 'ACCPAYCREDIT' }, keys), null)
  assert.equal(matchOrderCreditNote({ CreditNoteNumber: 'CN-3', Reference: '161212' }, keys), null, 'no id: not a document IMS can name')
})

test('[pnc8p note 1] the search asks Xero by the order id, every refund id and SC-<refund id> in ONE where-clause', () => {
  const where = orderCreditNoteSearchWhere({ orderIds: ['158671'], refundIds: ['161212', '162752'] })
  for (const term of ['Reference.Contains("158671")', 'Reference.Contains("161212")', 'Reference.Contains("162752")', 'CreditNoteNumber == "SC-161212"', 'CreditNoteNumber == "SC-162752"', 'Type == "ACCRECCREDIT"']) {
    assert.ok(where.includes(term), term)
  }
})

test('[0lpnb MED-3] creditNotePaidOutCents counts live payments only and is unreadable on a malformed one', () => {
  assert.equal(creditNotePaidOutCents(undefined), 0)
  assert.equal(creditNotePaidOutCents([{ Amount: 10, Status: 'AUTHORISED' }, { Amount: 5.95, Status: 'DELETED' }, { Amount: 0.05 }]), 1005)
  assert.equal(creditNotePaidOutCents([{ Amount: '10' }]), null)
  assert.equal(creditNotePaidOutCents('x'), null)
})

function fakeXero(search: unknown[] | { error: string } | 'full', docs: Record<string, unknown>) {
  const calls: string[] = []
  return {
    calls,
    get: async <T,>(path: string) => {
      calls.push(path)
      if (path.startsWith('CreditNotes?where=')) {
        if (search === 'full') return { ok: true, status: 200, data: { CreditNotes: Array.from({ length: 100 }, (_, i) => ({ CreditNoteID: `f${i}` })) } as T }
        if (!Array.isArray(search)) return { ok: false, status: 500, error: search.error }
        return { ok: true, status: 200, data: { CreditNotes: search } as T }
      }
      const id = decodeURIComponent(path.split('/')[1] ?? '')
      if (docs[id]) return { ok: true, status: 200, data: { CreditNotes: [docs[id]] } as T }
      return { ok: false, status: 404, error: 'not found' }
    },
  }
}

test('[0lpnb MED-3] readOrderCreditNotesFromXero: one search, then each live match read on its own for its payments; voided matches are not read', async () => {
  const xero = fakeXero(
    [
      { CreditNoteID: 'x1', CreditNoteNumber: 'CN-11001', Reference: '158671-Jane', Status: 'PAID', Type: 'ACCRECCREDIT', CurrencyCode: 'GBP', Total: 40 },
      { CreditNoteID: 'x2', CreditNoteNumber: 'CN-11629', Reference: '161212', Status: 'VOIDED', Type: 'ACCRECCREDIT', CurrencyCode: 'GBP', Total: 39.71 },
      { CreditNoteID: 'x3', CreditNoteNumber: 'CN-9', Reference: 'unrelated 999', Status: 'AUTHORISED', Type: 'ACCRECCREDIT' },
    ],
    { x1: { CreditNoteID: 'x1', CurrencyCode: 'GBP', Total: 40, Status: 'PAID', Payments: [{ Amount: 40, Status: 'AUTHORISED' }] } },
  )
  const read = await readOrderCreditNotesFromXero({ orderIds: ['158671'], refundIds: ['161212'] }, 'GBP', xero)
  assert.equal(read.ok, true)
  const notes = (read as { creditNotes: Array<{ creditNoteId: string; paidOutCents: number }> }).creditNotes
  assert.deepEqual(notes.map((n) => [n.creditNoteId, n.paidOutCents]).sort(), [['x1', 4000], ['x2', 0]])
  assert.deepEqual(xero.calls.filter((c) => !c.startsWith('CreditNotes?')), ['CreditNotes/x1'], 'only the live match is read on its own')
})

test('[0lpnb MED-3] the reader FAILS CLOSED: a failed or full search, an unreadable match, cash in another currency, a non-numeric id', async () => {
  const keys = { orderIds: ['158671'], refundIds: ['161212'] }
  assert.equal((await readOrderCreditNotesFromXero(keys, 'GBP', fakeXero({ error: 'boom' }, {}))).ok, false)
  assert.equal((await readOrderCreditNotesFromXero(keys, 'GBP', fakeXero('full', {}))).ok, false)
  const match = [{ CreditNoteID: 'x1', Reference: '161212', Status: 'AUTHORISED' }]
  assert.equal((await readOrderCreditNotesFromXero(keys, 'GBP', fakeXero(match, {}))).ok, false, 'the match cannot be read on its own')
  assert.equal((await readOrderCreditNotesFromXero(keys, 'GBP', fakeXero(match, { x1: { CreditNoteID: 'x1', CurrencyCode: 'EUR', Payments: [{ Amount: 5 }] } }))).ok, false)
  assert.equal((await readOrderCreditNotesFromXero({ orderIds: ['15867"1'], refundIds: [] }, 'GBP', fakeXero([], {}))).ok, false)
  const none = await readOrderCreditNotesFromXero({ orderIds: [], refundIds: [] }, 'GBP', fakeXero({ error: 'never asked' }, {}))
  assert.deepEqual(none, { ok: true, creditNotes: [] }, 'an order with no storefront ids has nothing Xeroom could have raised: nothing is asked')
})

// ---------------------------------------------------------------------------------------------------------------------------------------------
// pnc8p note 1: before IMS CREATES a credit note
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[pnc8p note 1] before a create: 162199\'s hand-raised CN-11573 (reference = refund id) is found; IMS\'s own number counts only when no earlier attempt could have made it', () => {
  const read = (over: Record<string, unknown>) => ({ creditNoteId: 'x', creditNoteNumber: 'CN-11573', reference: '162199', status: 'AUTHORISED', currency: 'GBP', total: 39.71, byOrder: [], byRefund: ['162199'], paidOutCents: 0, ...over })
  const base = { imsCreditNotes: new Map<string, string>(), selfExternalRefundId: '162199', creditNoteNumber: 'CN-00077', totalCents: 3971, attemptedBefore: false }
  assert.equal(creditNoteCreateDuplicates({ ...base, creditNotes: [read({})] }).length, 1)
  assert.equal(creditNoteCreateDuplicates({ ...base, creditNotes: [read({ status: 'VOIDED' })] }).length, 0)
  const own = read({ creditNoteNumber: 'CN-00077', byRefund: [], reference: 'order 158671', byOrder: ['158671'] })
  assert.equal(creditNoteCreateDuplicates({ ...base, creditNotes: [own] }).length, 1, 'a document already under IMS\'s number, before IMS ever sent it, is not IMS\'s')
  assert.equal(creditNoteCreateDuplicates({ ...base, attemptedBefore: true, creditNotes: [own] }).length, 0, 'after an attempt it may be IMS\'s own, landed: the re-post converges')
  assert.equal(creditNoteCreateDuplicates({ ...base, creditNotes: [read({ byRefund: [], byOrder: ['158671'], total: 12.79 })] }).length, 0, 'another refund\'s credit')
})

test('[pnc8p note 1] the create-time duplicate check is its own system switch, held equal to the literal in the registry', () => {
  assert.equal(CREDIT_NOTE_DUPLICATE_CHECK_SETTING_KEY, 'xero_credit_note_duplicate_check_enabled')
  assert.ok(SYSTEM_SWITCH_KEYS.includes(CREDIT_NOTE_DUPLICATE_CHECK_SETTING_KEY))
})

// ---------------------------------------------------------------------------------------------------------------------------------------------
// MED-5 / L5: the waits hand the row back without spending a retry
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[0lpnb MED-5 / L5] awaiting-receipt and awaiting-sibling are handed back unsent without spending a retry, after a delay; the settled reasons keep their own handling', async () => {
  const { handsBackUnsentWithoutAttempt, unsentHandBackDelayMs, AWAITING_RECEIPT_RETRY_DELAY_MS, AWAITING_SIBLING_RETRY_DELAY_MS } = await import('@/lib/connectors/xero/sync-processor')
  for (const reason of ['awaiting-receipt', 'awaiting-sibling', 'producer-held', 'transport-refused'] as const) assert.equal(handsBackUnsentWithoutAttempt(reason), true, reason)
  for (const reason of ['claim-lost', 'lease-expired', 'dispatch-unrecorded', 'producer-shadowed', 'before-cutoff'] as const) assert.equal(handsBackUnsentWithoutAttempt(reason), false, reason)
  assert.equal(unsentHandBackDelayMs('awaiting-receipt'), AWAITING_RECEIPT_RETRY_DELAY_MS)
  assert.equal(unsentHandBackDelayMs('awaiting-sibling'), AWAITING_SIBLING_RETRY_DELAY_MS)
  assert.ok(AWAITING_RECEIPT_RETRY_DELAY_MS >= 60_000 && AWAITING_SIBLING_RETRY_DELAY_MS >= 30_000, 'a wait is never re-offered every tick')
  assert.equal(unsentHandBackDelayMs('transport-refused'), 0)
})
