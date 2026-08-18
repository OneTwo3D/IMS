import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-y14 r5 finding 1 — THE OPERATOR HANDOFF MUST FOLLOW THE DERIVATION, NOT ASSERT PAST IT.
 *
 * Every revision up to r5 printed one sentence for every corrected order carrying any accounting
 * document: "those documents still understate and need a manual credit/adjustment." r4's own
 * derivation proves that false for a whole class of them — the Xero adapter appends its negative
 * "Order discount" line only when a discount ACCOUNT CODE came with the payload, so an invoice
 * enqueued without one posted the full goods less the per-line coupon and never carried the
 * duplicate at all. Following the old instruction would credit a correct invoice.
 *
 * THE FIXTURES HERE SEPARATE "CARRIES NO DISCOUNT LINE" FROM "CARRIES THE WRONG AMOUNT", and the
 * separating variable is the ONE field the connector rule tests: `discount.accountCode`. Both
 * fixtures request the same 10; they differ only in whether the account code came with it. A test
 * whose two fixtures rendered the same operator text would prove nothing, so `notDeepEqual` on the
 * rendered lines is asserted directly rather than left implied.
 *
 * AND THE DIRECTION IS ASSERTED, not just the amount. An invoice that discounted MORE than the
 * corrected order charged the customer too LITTLE: its balance has to go UP, and a credit note moves
 * it DOWN. The old sentence named the wrong instrument even in the case it was written for.
 *
 * o3d-y14 r6 finding 1 — AND NONE OF IT MAY BE PRESCRIBED ON A REFUNDED ORDER.
 *
 * Every case above judges the order by its INVOICE. On an order with credit notes against it that
 * is half a position: a fully refunded order's invoice and credit note can already net to nothing,
 * because the credit note that reversed the invoice was computed from the same pre-correction
 * figure. Telling the operator to raise a further invoice for the difference there RE-BILLS A
 * CUSTOMER WHO HAS BEEN REFUNDED, and telling them to credit it refunds the same money twice.
 *
 * THE FIXTURES HERE SEPARATE REFUNDED FROM UNREFUNDED on one field at a time — `refundStatus`
 * alone, a `SalesOrderRefund` row alone, a posted credit note alone — and each pair is asserted to
 * render DIFFERENT text with `notDeepEqual`. A fixture set where the two rendered the same handoff
 * would prove nothing at all, which is the same trap the r5 pair above was written to avoid.
 */

const events: string[] = []

mock.module('@/lib/domain/sales/allocation-service', {
  namedExports: {
    lockSalesOrder: async (_tx: unknown, orderId: string) => {
      events.push(`lock:${orderId}`)
    },
  },
})

type EventRow = {
  sourceEntityType: string
  sourceEntityId: string
  type: string
  status: string
  currency: string
  externalSystem: string | null
  externalId: string | null
  businessDate: string
  createdAt: string
  linesJson: unknown
}

/**
 * A client double that HONOURS its filters and refuses any operator it has not been taught.
 *
 * A double that matched regardless of `where` could not tell a POSTED document from an unsettled
 * SALES_INVOICE_UPDATE — and those two produce OPPOSITE instructions here ("nothing to do" versus
 * "no remedy is prescribed"), which is most of what this file asserts.
 */
function makeEventClient(rows: EventRow[]) {
  return {
    accountingEvent: {
      count: async ({
        where,
      }: {
        where: { sourceEntityType: string; sourceEntityId: string; type: string; status: { notIn: string[] } }
      }) => {
        if (!('notIn' in where.status)) throw new Error('the double only implements { notIn } on status')
        return rows.filter(
          (row) =>
            row.sourceEntityType === where.sourceEntityType &&
            row.sourceEntityId === where.sourceEntityId &&
            row.type === where.type &&
            !where.status.notIn.includes(row.status),
        ).length
      },
      findMany: async ({
        where,
        orderBy,
      }: {
        where: { sourceEntityType: string; sourceEntityId: string; type: { in: string[] }; status: string }
        orderBy: Array<Record<string, 'desc' | 'asc'>>
      }) => {
        const matched = rows.filter(
          (row) =>
            row.sourceEntityType === where.sourceEntityType &&
            row.sourceEntityId === where.sourceEntityId &&
            where.type.in.includes(row.type) &&
            row.status === where.status,
        )
        // Honours the ordering production asks for, so a case that depends on WHICH document is
        // named is a property of the code rather than of this array's order.
        return [...matched].sort((a, b) => {
          for (const clause of orderBy) {
            const [field, direction] = Object.entries(clause)[0] as ['businessDate' | 'createdAt', 'desc' | 'asc']
            const left = String(a[field])
            const right = String(b[field])
            if (left !== right) return (left < right ? -1 : 1) * (direction === 'desc' ? -1 : 1)
          }
          return 0
        })
      },
    },
  } as never
}

function documentPayload(over: Record<string, unknown> = {}) {
  return {
    kind: 'accounting-document',
    schemaVersion: 1,
    documentType: 'SALES_INVOICE',
    contact: { name: 'A Customer' },
    date: '2026-05-02',
    currency: 'GBP',
    lineAmountMode: 'EXCLUSIVE',
    lineAmountsIncludeTax: false,
    lines: [{ description: 'Widget', quantity: 2, unitAmount: 50, accountCode: '200' }],
    ...over,
  }
}

function postedInvoice(over: Partial<EventRow> = {}): EventRow {
  return {
    sourceEntityType: 'SalesOrder',
    sourceEntityId: 'order-1',
    type: 'SALES_INVOICE',
    status: 'POSTED',
    currency: 'GBP',
    externalSystem: 'xero',
    externalId: 'INV-778',
    businessDate: '2026-05-02',
    createdAt: '2026-05-02T09:00:00.000Z',
    linesJson: documentPayload({ discount: { amount: 10, accountCode: '260' } }),
    ...over,
  }
}

/** THE r5 FIXTURE: the same requested 10, with NO account code — Xero appended no discount line. */
function invoiceWithNoDiscountAccount(over: Partial<EventRow> = {}): EventRow {
  return postedInvoice({ linesJson: documentPayload({ discount: { amount: 10 } }), ...over })
}

type LedgerEvidence = import('@/lib/connectors/woocommerce/sync/coupon-discount-ledger-handoff').WcCouponLedgerEvidence

type RefundEvidence = import('@/lib/connectors/woocommerce/sync/coupon-discount-ledger-handoff').WcCouponRefundEvidence

const NO_REFUNDS: RefundEvidence = { disposition: 'NONE', refundIds: [], postedCreditNoteExternalIds: [] }

/** A full refund with its credit note in the ledger: the position the r6 finding is about. */
const FULLY_REFUNDED: RefundEvidence = {
  disposition: 'FULL',
  refundIds: ['refund-1'],
  postedCreditNoteExternalIds: ['CN-501'],
}

const LINKED_INVOICE: LedgerEvidence = {
  accountingInvoiceId: 'INV-778',
  postedInvoiceExternalIds: [],
  revenueDeferredBatchRef: null,
  refunds: NO_REFUNDS,
}

/** The SAME order, the SAME invoice, refunded. Only the refund evidence differs. */
const LINKED_INVOICE_REFUNDED: LedgerEvidence = { ...LINKED_INVOICE, refunds: FULLY_REFUNDED }

async function handoffFor(rows: EventRow[], keptOrderLevel: number, evidence: LedgerEvidence = LINKED_INVOICE) {
  const { buildWcCouponLedgerHandoff } = await import(
    '@/lib/connectors/woocommerce/sync/coupon-discount-ledger-handoff'
  )
  return await buildWcCouponLedgerHandoff(makeEventClient(rows), {
    orderId: 'order-1',
    currency: 'GBP',
    keptOrderLevel,
    evidence,
  })
}

// ---------------------------------------------------------------------------
// The r5 defect itself
// ---------------------------------------------------------------------------

test('a Xero invoice posted with NO discount account code needs NOTHING done to it (o3d-y14 r5 F1)', async () => {
  // The invoice carries only the per-line coupon; the duplicated order-level figure never reached
  // Xero. Clearing the IMS column is the WHOLE fix, and an operator following the old instruction
  // would post an erroneous credit against a correct invoice.
  const handoff = await handoffFor([invoiceWithNoDiscountAccount()], 0)

  assert.equal(handoff.invoice.case, 'DOCUMENT_AGREES')
  assert.equal(handoff.invoice.case === 'DOCUMENT_AGREES' && handoff.invoice.postedDiscount, 0)
  assert.equal(handoff.needsAccountingAction, false)
  const text = handoff.lines.join('\n')
  assert.match(text, /NO ACCOUNTING ACTION for this order/)
  assert.match(text, /Do NOT raise a credit note or an adjustment against it/)
  assert.match(text, /no discount account code/, 'and it says WHY, so the operator can check it')
  assert.doesNotMatch(text, /REMEDY/, 'no remedy is offered for a document that is already right')
})

test('the SAME requested figure WITH an account code is the opposite job (o3d-y14 r5 F1)', async () => {
  // Same 10 in the payload. The account code is the only difference, and it is the field the Xero
  // adapter branches on — so this document really did carry the duplicate.
  const handoff = await handoffFor([postedInvoice()], 0)

  assert.equal(handoff.invoice.case, 'DOCUMENT_DISCOUNTS_MORE')
  assert.equal(handoff.invoice.case === 'DOCUMENT_DISCOUNTS_MORE' && handoff.invoice.difference, 10)
  assert.equal(handoff.needsAccountingAction, true)
  const text = handoff.lines.join('\n')
  assert.match(text, /charged 10 GBP TOO LITTLE/)
  assert.match(text, /a credit note is\s+the wrong instrument|credit note is the wrong instrument/)
  assert.match(text, /raise a further invoice to the same contact for 10 GBP/)
})

test('the two render DIFFERENT operator text — the fixture pair proves the classification (o3d-y14 r5 F1)', async () => {
  // The property the whole finding turns on. If "no discount line" and "wrong amount" rendered the
  // same paragraph, every other assertion in this file would be passing on a coincidence.
  const noLine = await handoffFor([invoiceWithNoDiscountAccount()], 0)
  const wrongAmount = await handoffFor([postedInvoice()], 0)

  assert.notDeepEqual(noLine.lines, wrongAmount.lines)
  assert.notEqual(noLine.needsAccountingAction, wrongAmount.needsAccountingAction)
  assert.notEqual(noLine.invoice.case, wrongAmount.invoice.case)
})

// ---------------------------------------------------------------------------
// Direction, and the residual cases
// ---------------------------------------------------------------------------

test('a PARTIAL residual is compared against the document, not against zero', async () => {
  // An unmodelled coupon shape: 10 requested, 4 survives the correction. The invoice carried the
  // whole 10, so it is short by 6 — not by 10, and not by nothing.
  const handoff = await handoffFor([postedInvoice()], 4)

  assert.equal(handoff.invoice.case, 'DOCUMENT_DISCOUNTS_MORE')
  assert.equal(handoff.invoice.case === 'DOCUMENT_DISCOUNTS_MORE' && handoff.invoice.difference, 6)
  const text = handoff.lines.join('\n')
  assert.match(text, /charged 6 GBP TOO LITTLE/)
  assert.match(text, /set its "Order discount" line to 4 GBP/, 'the edit target is the residual, not 0')
})

test('a document that discounts LESS than the corrected order is credited, and only that case is', async () => {
  // The other direction, and the one case where a credit note IS the right instrument: no account
  // code, so the invoice carried no discount at all, while the corrected order retains 4.
  const handoff = await handoffFor([invoiceWithNoDiscountAccount()], 4)

  assert.equal(handoff.invoice.case, 'DOCUMENT_DISCOUNTS_LESS')
  assert.equal(handoff.invoice.case === 'DOCUMENT_DISCOUNTS_LESS' && handoff.invoice.difference, 4)
  const text = handoff.lines.join('\n')
  assert.match(text, /charged 4 GBP TOO MUCH/)
  assert.match(text, /Raise a credit note for 4 GBP/)
  assert.match(text, /Add Credit Note/, 'named as an operation Xero actually has')
})

test('QuickBooks always posts its discount line, and its remedy names QuickBooks steps', async () => {
  // The QBO adapter pushes DiscountLineDetail on a positive amount alone — the account ref is
  // optional — so the recorded figure IS the posted one even with no account code. A handoff that
  // replayed Xero's rule for every connector would tell the operator to do nothing here.
  const handoff = await handoffFor(
    [invoiceWithNoDiscountAccount({ externalSystem: 'quickbooks', externalId: 'QBO-42' })],
    0,
  )

  assert.equal(handoff.invoice.case, 'DOCUMENT_DISCOUNTS_MORE')
  const text = handoff.lines.join('\n')
  assert.match(text, /QuickBooks Online/)
  assert.match(text, /Receive Payment screen/)
  assert.doesNotMatch(text, /Xero|Remove & Redo/, 'no Xero-only step is offered for a QuickBooks document')
})

// ---------------------------------------------------------------------------
// Refusals — where no remedy may be invented
// ---------------------------------------------------------------------------

test('an unsettled invoice UPDATE prescribes NO remedy (o3d-y14 r4 F2)', async () => {
  // Under @@unique([externalSystem, externalId]) this is exactly what a SUCCESSFUL update leaves
  // behind, so the original invoice's event cannot be trusted to describe the document as it stands.
  const handoff = await handoffFor(
    [
      postedInvoice(),
      postedInvoice({ type: 'SALES_INVOICE_UPDATE', status: 'PENDING', externalId: null }),
    ],
    0,
  )

  assert.equal(handoff.invoice.case, 'DOCUMENT_UNVERIFIED')
  assert.equal(handoff.needsAccountingAction, true, 'a document nobody can read still needs a human')
  const text = handoff.lines.join('\n')
  assert.match(text, /NO REMEDY IS PRESCRIBED/)
  assert.match(text, /Never a credit note/, 'the operator is told the direction rule, not a guess')
  assert.doesNotMatch(text, /Raise a credit note for/, 'and no instrument is actually prescribed')
})

test('a linked invoice with no mirrored event is UNVERIFIED, never assumed correct', async () => {
  // Reading "no event" as "no discount line" would be the r5 defect inverted: it would silently
  // clear a real understatement off the operator's list.
  const handoff = await handoffFor([], 0)

  assert.equal(handoff.invoice.case, 'DOCUMENT_UNVERIFIED')
  assert.equal(handoff.needsAccountingAction, true)
  assert.match(
    handoff.lines.join('\n'),
    /the ledger holds invoice INV-778 for this order but no posted accounting event records what it charged/,
  )
})

test('a posted-but-UNLINKED invoice with no mirrored event is UNVERIFIED too (o3d-9kek)', async () => {
  const handoff = await handoffFor([], 0, {
    accountingInvoiceId: null,
    postedInvoiceExternalIds: ['INV-999'],
    revenueDeferredBatchRef: null,
    refunds: NO_REFUNDS,
  })

  assert.equal(handoff.invoice.case, 'DOCUMENT_UNVERIFIED')
  assert.match(handoff.lines.join('\n'), /INV-999/)
})

test('two posted documents that disagree prescribe no remedy either', async () => {
  const handoff = await handoffFor(
    [
      postedInvoice({ externalId: 'INV-A' }),
      postedInvoice({
        externalId: 'INV-B',
        businessDate: '2026-05-03',
        linesJson: documentPayload({ discount: { amount: 3, accountCode: '260' } }),
      }),
    ],
    0,
  )

  assert.equal(handoff.invoice.case, 'DOCUMENT_UNVERIFIED')
  assert.match(handoff.lines.join('\n'), /carry different\s+order-level discounts/)
})

// ---------------------------------------------------------------------------
// o3d-y14 r6 finding 1 — a refunded order is judged on its NET position
// ---------------------------------------------------------------------------

test('a FULLY REFUNDED order is NEVER told to raise a further invoice (o3d-y14 r6 F1)', async () => {
  // THE FINDING. The invoice discounted 10 more than the corrected order retains, so the unrefunded
  // handoff says "raise a further invoice for 10 GBP". This customer has already been refunded in
  // full — and the credit note that reversed this invoice was computed from the same pre-correction
  // figure, so the two errors cancel and the net owed is nothing. Billing them again is real money
  // moving in the wrong direction.
  const handoff = await handoffFor([postedInvoice()], 0, LINKED_INVOICE_REFUNDED)

  assert.equal(handoff.refunded, true)
  assert.equal(handoff.invoice.case, 'DOCUMENT_DISCOUNTS_MORE', 'the invoice FINDING is still reported')
  const text = handoff.lines.join('\n')
  assert.match(text, /charged 10 GBP TOO LITTLE/, 'the operator still gets the figure')
  assert.match(text, /NO REMEDY IS PRESCRIBED/)
  assert.match(text, /RECREATES A RECEIVABLE against a customer\s+who has already been refunded/)
  assert.doesNotMatch(text, /Otherwise raise a further invoice to the same contact/)
  assert.doesNotMatch(text, /re-approve/, 'nor the edit-it-up alternative, which moves the balance the same way')
  assert.match(text, /FULLY REFUNDED/)
  assert.match(text, /CN-501/, 'and the credit note it must be netted against is named')
})

test('the refunded and unrefunded handoffs for the SAME invoice differ (o3d-y14 r6 F1)', async () => {
  // The property the whole finding turns on, asserted the way the r5 pair is: one field apart, and
  // if the two rendered the same paragraph every other assertion here would pass on a coincidence.
  const unrefunded = await handoffFor([postedInvoice()], 0, LINKED_INVOICE)
  const refunded = await handoffFor([postedInvoice()], 0, LINKED_INVOICE_REFUNDED)

  assert.notDeepEqual(unrefunded.lines, refunded.lines)
  assert.equal(unrefunded.invoice.case, refunded.invoice.case, 'the invoice-side FACT is unchanged')
  assert.match(unrefunded.lines.join('\n'), /raise a further invoice to the same contact for 10 GBP/)
  assert.doesNotMatch(refunded.lines.join('\n'), /raise a further invoice to the same contact for 10 GBP/)
})

test('a PARTIAL refund suppresses the remedy too — the apportionment is not derivable (o3d-y14 r6 F1)', async () => {
  // A partial refund is MORE ambiguous, not less: how much of the order-level discount the credit
  // note reversed depends on what it credited, and nothing IMS recorded says.
  const handoff = await handoffFor([postedInvoice()], 0, {
    ...LINKED_INVOICE,
    refunds: { disposition: 'PARTIAL', refundIds: ['refund-9'], postedCreditNoteExternalIds: [] },
  })

  assert.equal(handoff.refunded, true)
  const text = handoff.lines.join('\n')
  assert.match(text, /PARTLY REFUNDED/)
  assert.match(text, /NO REMEDY IS PRESCRIBED/)
  assert.doesNotMatch(text, /Otherwise raise a further invoice/)
})

test('a refund row alone is enough, even with refundStatus NONE (o3d-y14 r6 F1)', async () => {
  // The status is written by the refund workflow; the row's existence does not write it. Reading
  // only the column would let a real credit note through as "not refunded".
  const handoff = await handoffFor([postedInvoice()], 0, {
    ...LINKED_INVOICE,
    refunds: { disposition: 'NONE', refundIds: ['refund-2'], postedCreditNoteExternalIds: [] },
  })

  assert.equal(handoff.refunded, true)
  assert.match(handoff.lines.join('\n'), /NO REMEDY IS PRESCRIBED/)
})

test('a posted credit note alone is enough, with no refund row and no status (o3d-y14 r6 F1)', async () => {
  // The o3d-9kek shape on the refund side: the document is in the ledger and IMS's own rows are
  // silent about it.
  const handoff = await handoffFor([postedInvoice()], 0, {
    ...LINKED_INVOICE,
    refunds: { disposition: 'NONE', refundIds: [], postedCreditNoteExternalIds: ['CN-777'] },
  })

  assert.equal(handoff.refunded, true)
  const text = handoff.lines.join('\n')
  assert.match(text, /NO REMEDY IS PRESCRIBED/)
  assert.match(text, /CN-777/)
})

test('a refunded order whose invoice discounts LESS is NOT told to credit it (o3d-y14 r6 F1)', async () => {
  // The other direction, and the other real-money error: crediting an invoice that has already been
  // credited away refunds the same money twice, and Xero will happily allocate it.
  const handoff = await handoffFor([invoiceWithNoDiscountAccount()], 4, LINKED_INVOICE_REFUNDED)

  assert.equal(handoff.invoice.case, 'DOCUMENT_DISCOUNTS_LESS')
  const text = handoff.lines.join('\n')
  assert.match(text, /charged 4 GBP TOO MUCH/)
  assert.match(text, /NO REMEDY IS PRESCRIBED/)
  assert.match(text, /refunds the same money a second time/)
  assert.doesNotMatch(text, /Add Credit Note/, 'the pre-filled credit note is NOT offered')
  assert.doesNotMatch(text, /Raise a credit note for 4 GBP\./)
})

test('DOCUMENT_AGREES on a refunded order stops claiming the ledger is already right (o3d-y14 r6 F1)', async () => {
  // The invoice IS right — and the old text went on to say the ledger was, which is a claim about
  // credit notes nobody has read. It still prescribes nothing against the invoice, which is the part
  // that was true.
  const refunded = await handoffFor([invoiceWithNoDiscountAccount()], 0, LINKED_INVOICE_REFUNDED)
  const unrefunded = await handoffFor([invoiceWithNoDiscountAccount()], 0, LINKED_INVOICE)

  assert.equal(refunded.invoice.case, 'DOCUMENT_AGREES')
  assert.notDeepEqual(refunded.lines, unrefunded.lines)
  const text = refunded.lines.join('\n')
  assert.match(text, /NOTHING IS OWED ON THE INVOICE/)
  assert.match(text, /Do NOT raise a credit note or an adjustment/)
  assert.doesNotMatch(text, /the ledger is already right/, 'that claim is not available on a refunded order')
  assert.equal(refunded.needsAccountingAction, true, 'the credit-note side still has to be read')
  assert.equal(unrefunded.needsAccountingAction, false)
})

test('UNVERIFIED on a refunded order drops the read-it-off-the-document ladder (o3d-y14 r6 F1)', async () => {
  // Every branch of that ladder ends in an instrument ("raise a further invoice for it", "credit the
  // difference"), so printing it on a refunded order prescribes exactly what this refuses.
  const rows = [postedInvoice(), postedInvoice({ type: 'SALES_INVOICE_UPDATE', status: 'PENDING', externalId: null })]
  const refunded = await handoffFor(rows, 4, LINKED_INVOICE_REFUNDED)
  const unrefunded = await handoffFor(rows, 4, LINKED_INVOICE)

  assert.equal(refunded.invoice.case, 'DOCUMENT_UNVERIFIED')
  assert.notDeepEqual(refunded.lines, unrefunded.lines)
  assert.match(unrefunded.lines.join('\n'), /credit the difference/)
  assert.doesNotMatch(refunded.lines.join('\n'), /credit the difference/)
  assert.doesNotMatch(refunded.lines.join('\n'), /raise a further invoice for the difference/)
  assert.match(refunded.lines.join('\n'), /TWO unknowns here, not one/)
})

test('NO_INVOICE_IN_LEDGER with a credit note is reported, but still prescribes nothing (o3d-y14 r6 F1)', async () => {
  const handoff = await handoffFor([], 0, {
    accountingInvoiceId: null,
    postedInvoiceExternalIds: [],
    revenueDeferredBatchRef: null,
    refunds: { disposition: 'FULL', refundIds: ['refund-3'], postedCreditNoteExternalIds: ['CN-900'] },
  })

  assert.equal(handoff.invoice.case, 'NO_INVOICE_IN_LEDGER')
  assert.equal(handoff.needsAccountingAction, true, 'a credit note IS a ledger document derived from the old amount')
  const text = handoff.lines.join('\n')
  assert.match(text, /nothing to do on the invoice side/)
  assert.match(text, /CN-900/)
  assert.doesNotMatch(text, /raise a further invoice/)
})

test('a refunded order with NOTHING in the ledger is not put on the must-fix list (o3d-y14 r6 F1)', async () => {
  // The one refunded shape that stays non-actionable. Inventing work here — "there is nothing to
  // look at, go look at it" — is the r5 defect in a new place.
  const handoff = await handoffFor([], 0, {
    accountingInvoiceId: null,
    postedInvoiceExternalIds: [],
    revenueDeferredBatchRef: null,
    refunds: { disposition: 'FULL', refundIds: ['refund-4'], postedCreditNoteExternalIds: [] },
  })

  assert.equal(handoff.invoice.case, 'NO_INVOICE_IN_LEDGER')
  assert.equal(handoff.needsAccountingAction, false)
})

test('no refund evidence leaves every r5 remedy exactly as it was (o3d-y14 r6 F1)', async () => {
  // The regression guard for rounds 1-5: the refusal must be reachable ONLY through refund
  // evidence, or this round has quietly removed the remedies the last one derived.
  const more = await handoffFor([postedInvoice()], 0)
  const less = await handoffFor([invoiceWithNoDiscountAccount()], 4)

  assert.equal(more.refunded, false)
  assert.equal(less.refunded, false)
  assert.match(more.lines.join('\n'), /Otherwise raise a further invoice to the same contact for 10 GBP/)
  assert.match(less.lines.join('\n'), /Raise a credit note for 4 GBP/)
  assert.doesNotMatch(more.lines.join('\n'), /NO REMEDY IS PRESCRIBED/)
})

// ---------------------------------------------------------------------------
// The revenue-deferral journal — a different document with an EMPTY remedy
// ---------------------------------------------------------------------------

test('the Group A1 deferral journal is reported and explicitly NOT to be adjusted (o3d-y14 r5 F1)', async () => {
  // IMS recognises back out the SAME stamped unearnedRevenueAmount, so the deferral/recognition pair
  // nets to zero on its own figure. A manual journal against one half of it would strand the
  // difference in unearned revenue permanently — so the honest instruction is to leave it alone.
  const handoff = await handoffFor([], 0, {
    accountingInvoiceId: null,
    postedInvoiceExternalIds: [],
    revenueDeferredBatchRef: 'A1-2026-07-01-abcd1234',
    unearnedRevenueAmount: 90,
    refunds: NO_REFUNDS,
  })

  assert.equal(handoff.invoice.case, 'NO_INVOICE_IN_LEDGER')
  assert.equal(handoff.needsAccountingAction, false, 'a deferral alone is not work for an operator')
  const text = handoff.lines.join('\n')
  assert.match(text, /DO NOT ADJUST THAT JOURNAL/)
  assert.match(text, /strand the difference in the unearned-revenue account/)
  assert.match(text, /A1-2026-07-01-abcd1234/)
  assert.match(text, /nothing to do on the invoice side/)
})

test('an order with BOTH an understating invoice and a deferral gets both paragraphs', async () => {
  const handoff = await handoffFor([postedInvoice()], 0, {
    accountingInvoiceId: 'INV-778',
    postedInvoiceExternalIds: [],
    revenueDeferredBatchRef: 'A1-2026-07-01-abcd1234',
    unearnedRevenueAmount: 90,
    refunds: NO_REFUNDS,
  })

  assert.equal(handoff.invoice.case, 'DOCUMENT_DISCOUNTS_MORE')
  assert.equal(handoff.needsAccountingAction, true)
  const text = handoff.lines.join('\n')
  assert.match(text, /TOO LITTLE/)
  assert.match(text, /DO NOT ADJUST THAT JOURNAL/)
})

// ---------------------------------------------------------------------------
// End to end, through the correction that writes the durable record
// ---------------------------------------------------------------------------

type OrderRow = {
  id: string
  discountAmount: number
  discountModel: string | null
  discountRestatement?: unknown
  lines: Array<{ discountAmount: number }>
  importedAt: string | null
  accountingInvoiceId?: string | null
  /** o3d-y14 r6: the two refund signals the correction reads under its own lock. */
  refundStatus?: 'NONE' | 'PARTIAL' | 'FULL'
  refunds?: Array<{ id: string; accountingCreditNoteId: string | null }>
}

const IMPORTED_AT = '2026-05-01T00:00:00.000Z'

const ENTRY = {
  orderId: 'order-1',
  orderNumber: 'WC-1001',
  externalOrderNumber: '1001',
  currency: 'GBP',
  storedOrderDiscount: 10,
  lineDiscountTotal: 10,
  importedAt: IMPORTED_AT,
  keptOrderLevel: 0,
  clearedBy: 10,
  partial: false,
  accountingInvoiceId: 'INV-778' as string | null,
  postedInvoiceExternalIds: [] as string[],
  revenueDeferredBatchRef: null as string | null,
  refunds: { disposition: 'NONE', refundIds: [], postedCreditNoteExternalIds: [] } as RefundEvidence,
  nearCutoff: false,
}

function makeTx(store: { orders: OrderRow[]; eventRows: EventRow[]; activity: Array<{ description: string; metadata: Record<string, unknown> }> }) {
  const eventClient = makeEventClient(store.eventRows) as unknown as {
    accountingEvent: Record<string, (args: never) => Promise<unknown>>
  }
  return {
    salesOrder: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const found = store.orders.find((order) => order.id === where.id)
        return found
          ? {
              id: found.id,
              discountAmount: found.discountAmount,
              discountModel: found.discountModel,
              accountingInvoiceId: found.accountingInvoiceId ?? null,
              revenueDeferredBatchRef: null,
              unearnedRevenueAmount: null,
              refundStatus: found.refundStatus ?? 'NONE',
              refunds: found.refunds ?? [],
              lines: found.lines.map((line) => ({ ...line })),
              shoppingLinks: found.importedAt ? [{ createdAt: new Date(found.importedAt) }] : [],
            }
          : null
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; discountAmount?: number; discountModel?: null }
        data: { discountAmount?: number; discountModel: string; discountRestatement?: unknown }
      }) => {
        const target = store.orders.find(
          (order) =>
            order.id === where.id &&
            (!('discountAmount' in where) || order.discountAmount === where.discountAmount) &&
            (!('discountModel' in where) || order.discountModel === where.discountModel),
        )
        if (!target) return { count: 0 }
        if ('discountAmount' in data && data.discountAmount !== undefined) target.discountAmount = data.discountAmount
        target.discountModel = data.discountModel
        if ('discountRestatement' in data) target.discountRestatement = data.discountRestatement
        return { count: 1 }
      },
    },
    accountingSyncLog: {
      count: async () => 0,
      findMany: async () => [],
    },
    accountingEvent: eventClient.accountingEvent,
    activityLog: {
      create: async ({ data }: { data: { description: string; metadata: Record<string, unknown> } }) => {
        store.activity.push(data)
        return data
      },
    },
  } as never
}

function correctionStore(eventRows: EventRow[], order: Partial<OrderRow> = {}) {
  return {
    orders: [
      {
        id: 'order-1',
        discountAmount: 10,
        discountModel: null,
        lines: [{ discountAmount: 10 }],
        importedAt: IMPORTED_AT,
        accountingInvoiceId: 'INV-778',
        ...order,
      } as OrderRow,
    ],
    eventRows,
    activity: [] as Array<{ description: string; metadata: Record<string, unknown> }>,
  }
}

test('the correction records NO ACCOUNTING ACTION for an invoice that never carried the duplicate (o3d-y14 r5 F1)', async () => {
  // The ActivityLog entry is what anyone reads back months later. "Needs a manual credit" written
  // against an invoice that was always correct is the r5 defect made permanent.
  const { applyWcCouponCorrection } = await import(
    '@/lib/connectors/woocommerce/sync/coupon-discount-backfill'
  )
  const store = correctionStore([invoiceWithNoDiscountAccount()])

  const result = await applyWcCouponCorrection(makeTx(store), ENTRY)

  assert.equal(result.outcome, 'CORRECTED')
  assert.equal(result.outcome === 'CORRECTED' && result.handoff?.invoice.case, 'DOCUMENT_AGREES')
  assert.equal(result.outcome === 'CORRECTED' && result.handoff?.needsAccountingAction, false)
  assert.match(store.activity[0].description, /NO ACCOUNTING ACTION REQUIRED/)
  assert.doesNotMatch(store.activity[0].description, /still understate/)
  assert.equal(store.activity[0].metadata.ledgerCase, 'DOCUMENT_AGREES')
  assert.equal(store.activity[0].metadata.needsAccountingAction, false)
  assert.match(
    (store.activity[0].metadata.handoffLines as string[]).join('\n'),
    /NO ACCOUNTING ACTION for this order/,
    'the durable record keeps the whole instruction, not just the headline',
  )
})

test('the durable record of a REFUNDED order carries the refusal, not a remedy (o3d-y14 r6 F1)', async () => {
  // The ActivityLog entry is what anyone reads back months later, and it is also where an operator
  // working the list gets their instruction. "Raise a further invoice for 10 GBP" written against a
  // fully refunded order is the r6 defect made permanent.
  const { applyWcCouponCorrection } = await import(
    '@/lib/connectors/woocommerce/sync/coupon-discount-backfill'
  )
  const store = correctionStore([postedInvoice()], {
    refundStatus: 'FULL',
    refunds: [{ id: 'refund-1', accountingCreditNoteId: 'CN-501' }],
  })

  const result = await applyWcCouponCorrection(
    makeTx(store),
    { ...ENTRY, refunds: { disposition: 'FULL', refundIds: ['refund-1'], postedCreditNoteExternalIds: ['CN-501'] } },
  )

  assert.equal(result.outcome, 'CORRECTED', 'the AMOUNT is still corrected — the coupon is duplicated either way')
  assert.equal(result.outcome === 'CORRECTED' && result.handoff?.refunded, true)
  assert.equal(store.activity[0].metadata.refundDisposition, 'FULL')
  assert.deepEqual(store.activity[0].metadata.postedCreditNoteExternalIds, ['CN-501'])
  assert.equal(store.activity[0].metadata.refunded, true)
  const lines = (store.activity[0].metadata.handoffLines as string[]).join('\n')
  assert.match(lines, /NO REMEDY IS PRESCRIBED/)
  assert.doesNotMatch(lines, /Otherwise raise a further invoice to the same contact/)
  assert.match(store.activity[0].description, /credit note\(s\) CN-501/)
})

test('a refund that appeared since the review is REFUSED, not silently re-classified (o3d-y14 r6 F1)', async () => {
  // The reviewer approved a row whose operator instruction was "raise a further invoice"; on the
  // refunded version of that row the honest instruction is that no remedy may be prescribed at all.
  // Those are different decisions, so the reviewer makes the second one — and nothing is written.
  const { applyWcCouponCorrection } = await import(
    '@/lib/connectors/woocommerce/sync/coupon-discount-backfill'
  )
  const store = correctionStore([postedInvoice()], {
    refundStatus: 'FULL',
    refunds: [{ id: 'refund-1', accountingCreditNoteId: 'CN-501' }],
  })

  const result = await applyWcCouponCorrection(makeTx(store), ENTRY)

  assert.equal(result.outcome, 'DECLINED')
  assert.equal(result.outcome === 'DECLINED' && result.reason, 'POSTING_CHANGED')
  assert.match(
    result.outcome === 'DECLINED' ? result.detail : '',
    /refund position for this order is now refundStatus=FULL/,
  )
  assert.equal(store.orders[0].discountAmount, 10, 'and nothing was written')
  assert.equal(store.activity.length, 0)
})

test('and it records ACCOUNTING ACTION REQUIRED for one that did (o3d-y14 r5 F1)', async () => {
  const { applyWcCouponCorrection } = await import(
    '@/lib/connectors/woocommerce/sync/coupon-discount-backfill'
  )
  const store = correctionStore([postedInvoice()])

  const result = await applyWcCouponCorrection(makeTx(store), ENTRY)

  assert.equal(result.outcome === 'CORRECTED' && result.handoff?.invoice.case, 'DOCUMENT_DISCOUNTS_MORE')
  assert.match(store.activity[0].description, /ACCOUNTING ACTION REQUIRED/)
  assert.match(store.activity[0].description, /TOO LITTLE/)
  assert.equal(store.activity[0].metadata.ledgerCase, 'DOCUMENT_DISCOUNTS_MORE')
  assert.match(
    (store.activity[0].metadata.handoffLines as string[]).join('\n'),
    /Otherwise raise a further invoice to the same contact for 10 GBP/,
    'the remedy itself survives in the log, where the description only carries the headline',
  )
})
