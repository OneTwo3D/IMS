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
function makeEventClient(rows: EventRow[], refundRows: RefundRow[] = [], creditNoteEvents?: CreditNoteEventRow[]) {
  // r8 finding 3: by DEFAULT every refund's credit note is mirrored as one POSTED document naming
  // the id the refund names — "the document still stands as IMS recorded it". Fixtures that are
  // about a retired or re-posted credit note pass their own rows.
  const cnEvents =
    creditNoteEvents ??
    refundRows.map((refund) => ({
      sourceEntityId: refund.id,
      type: 'CREDIT_NOTE',
      status: 'POSTED',
      externalId: refund.accountingCreditNoteId,
    }))
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
        where: {
          sourceEntityType: string
          sourceEntityId: string | { in: string[] }
          type: { in: string[] } | string
          status?: string
        }
        orderBy?: Array<Record<string, 'desc' | 'asc'>>
      }) => {
        // The credit-note read (r8 finding 3): a different entity type, an `in` list of refund ids,
        // a scalar type and NO status filter. Served separately rather than by loosening the invoice
        // branch, so a query of the wrong shape still fails loudly here.
        if (where.sourceEntityType === 'SalesOrderRefund') {
          const ids = typeof where.sourceEntityId === 'string' ? [where.sourceEntityId] : where.sourceEntityId.in
          if (typeof where.type !== 'string') throw new Error('the credit-note read filters on a scalar type')
          return cnEvents.filter((row) => ids.includes(row.sourceEntityId) && row.type === where.type)
        }
        if (typeof where.sourceEntityId !== 'string' || typeof where.type === 'string' || !orderBy) {
          throw new Error('the double only implements the invoice read in this shape')
        }
        const typeIn = where.type.in
        const matched = rows.filter(
          (row) =>
            row.sourceEntityType === where.sourceEntityType &&
            row.sourceEntityId === where.sourceEntityId &&
            typeIn.includes(row.type) &&
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
    // o3d-y14 r7 finding 4: the credit-note side. The double HONOURS `where.id.in` for the same
    // reason the event one honours its filters — a derivation that read every refund in the store
    // regardless of which ids the evidence named would pass while production netted the wrong set.
    salesOrderRefund: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        refundRows.filter((row) => where.id.in.includes(row.id)),
    },
  } as never
}

/**
 * A persisted refund, as `readCreditNoteOrderDiscount` reads it.
 *
 * `chargeback: true` + `totalsBasis: 'NET'` + a credit note in the ledger is the ONE shape whose
 * discount leg is derivable; every fixture that departs from it below departs on exactly one field,
 * so what each refusal is about is a property of the code rather than of the fixture.
 */
type RefundRow = {
  id: string
  chargeback: boolean
  totalsBasis: string | null
  accountingCreditNoteId: string | null
  accountingRetryRequired?: boolean
  accountingWarning?: string | null
  lines: Array<{ salesOrderLineId: string | null; totalBase: number; totalForeign: number; lineKind: string | null }>
}

/** One mirrored CREDIT_NOTE event — the r8 finding 3 evidence that the document still stands. */
type CreditNoteEventRow = { sourceEntityId: string; type: string; status: string; externalId: string | null }

/** A chargeback that MIRRORED the invoice: full goods, and the invoice's discount as a negative leg. */
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

const NO_REFUNDS: RefundEvidence = { disposition: 'NONE', refundIds: [], postedCreditNoteExternalIds: [], unresolvedRefundParkExternalIds: [] }

/** A full refund with its credit note in the ledger: the position the r6 finding is about. */
const FULLY_REFUNDED: RefundEvidence = {
  disposition: 'FULL',
  refundIds: ['refund-1'],
  postedCreditNoteExternalIds: ['CN-501'],
unresolvedRefundParkExternalIds: [],
}

const LINKED_INVOICE: LedgerEvidence = {
  accountingInvoiceId: 'INV-778',
  postedInvoiceExternalIds: [],
  revenueDeferredBatchRef: null,
  refunds: NO_REFUNDS,
}

/** The SAME order, the SAME invoice, refunded. Only the refund evidence differs. */
const LINKED_INVOICE_REFUNDED: LedgerEvidence = { ...LINKED_INVOICE, refunds: FULLY_REFUNDED }

async function handoffFor(
  rows: EventRow[],
  keptOrderLevel: number,
  evidence: LedgerEvidence = LINKED_INVOICE,
  refundRows: RefundRow[] = [],
  creditNoteEvents?: CreditNoteEventRow[],
) {
  const { buildWcCouponLedgerHandoff } = await import(
    '@/lib/connectors/woocommerce/sync/coupon-discount-ledger-handoff'
  )
  return await buildWcCouponLedgerHandoff(makeEventClient(rows, refundRows, creditNoteEvents), {
    orderId: 'order-1',
    currency: 'GBP',
    keptOrderLevel,
    evidence,
    // Fixed, so the precondition line a remedy carries is deterministic.
    derivedAt: new Date('2026-08-01T00:00:00.000Z'),
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
  // r7 finding 3: this case says NO FIGURE, not "NO REMEDY IS PRESCRIBED" — because it DOES
  // prescribe, conditionally, and the ladder below names instruments. Calling that "no remedy" was
  // part of how a directional instruction kept surviving a refusal heading. The phrase is now
  // reserved for paths whose `remedy` is genuinely NULL, which the matrix test below asserts.
  assert.equal(handoff.remedy?.kind, 'READ_THEN_CHOOSE')
  assert.match(text, /NO FIGURE IS PRESCRIBED/)
  assert.doesNotMatch(text, /NO REMEDY IS PRESCRIBED/)
  assert.match(text, /Never a credit note/, 'the operator is told the direction rule, not a guess')
  assert.doesNotMatch(text, /Raise a credit note for/, 'and no unconditional instrument is prescribed')
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
    refunds: { disposition: 'PARTIAL', refundIds: ['refund-9'], postedCreditNoteExternalIds: [], unresolvedRefundParkExternalIds: [] },
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
    refunds: { disposition: 'NONE', refundIds: ['refund-2'], postedCreditNoteExternalIds: [], unresolvedRefundParkExternalIds: [] },
  })

  assert.equal(handoff.refunded, true)
  assert.match(handoff.lines.join('\n'), /NO REMEDY IS PRESCRIBED/)
})

test('a posted credit note alone is enough, with no refund row and no status (o3d-y14 r6 F1)', async () => {
  // The o3d-9kek shape on the refund side: the document is in the ledger and IMS's own rows are
  // silent about it.
  const handoff = await handoffFor([postedInvoice()], 0, {
    ...LINKED_INVOICE,
    refunds: { disposition: 'NONE', refundIds: [], postedCreditNoteExternalIds: ['CN-777'], unresolvedRefundParkExternalIds: [] },
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
    refunds: { disposition: 'FULL', refundIds: ['refund-3'], postedCreditNoteExternalIds: ['CN-900'], unresolvedRefundParkExternalIds: [] },
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
    refunds: { disposition: 'FULL', refundIds: ['refund-4'], postedCreditNoteExternalIds: [], unresolvedRefundParkExternalIds: [] },
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
  refunds: { disposition: 'NONE', refundIds: [], postedCreditNoteExternalIds: [], unresolvedRefundParkExternalIds: [] } as RefundEvidence,
  nearCutoff: false,
}

function makeTx(store: {
  orders: OrderRow[]
  eventRows: EventRow[]
  activity: Array<{ description: string; metadata: Record<string, unknown> }>
  parks?: Array<{ entityId: string; externalId: string }>
  refundRows?: RefundRow[]
}) {
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
    // r7 finding 1: the PARK read the correction now does under its own lock. Honours entityId, so
    // a park belonging to another order can never be counted for this one.
    shoppingSyncLog: {
      findMany: async ({ where }: { where: { entityId: string } }) =>
        (store.parks ?? []).filter((park) => park.entityId === where.entityId),
    },
    salesOrderRefund: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        (store.refundRows ?? []).filter((row) => where.id.in.includes(row.id)),
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

function correctionStore(
  eventRows: EventRow[],
  order: Partial<OrderRow> = {},
  extra: { parks?: Array<{ entityId: string; externalId: string }>; refundRows?: RefundRow[] } = {},
) {
  return {
    ...extra,
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
    { ...ENTRY, refunds: { disposition: 'FULL', refundIds: ['refund-1'], postedCreditNoteExternalIds: ['CN-501'], unresolvedRefundParkExternalIds: [] } },
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

// ---------------------------------------------------------------------------
// o3d-y14 r7 finding 4 — the net IS derivable where the credit notes MIRROR the invoice
// ---------------------------------------------------------------------------

/** The refund evidence for a fully-reversed order: one chargeback, its credit note in the ledger. */
const FULLY_REVERSED: RefundEvidence = {
  disposition: 'FULL',
  refundIds: ['refund-1'],
  postedCreditNoteExternalIds: ['CN-501'],
  unresolvedRefundParkExternalIds: [],
}

const FULLY_REVERSED_INVOICE: LedgerEvidence = { ...LINKED_INVOICE, refunds: FULLY_REVERSED }

/** A mirroring chargeback whose discount leg reversed `reversed`. */
function chargebackReversing(reversed: number): RefundRow {
  return mirroringChargeback({
    lines: [
      { salesOrderLineId: 'line-1', totalBase: 100, totalForeign: 100, lineKind: 'sale' },
      ...(reversed
        ? [{ salesOrderLineId: null, totalBase: -reversed, totalForeign: -reversed, lineKind: 'discount' }]
        : []),
    ],
  })
}

test('a credit note that reversed the SAME wrong discount nets to ZERO — and needs nothing (o3d-y14 r7 F4)', async () => {
  // THE CASE r6 COULD ONLY REACH BY ASKING A HUMAN. The invoice discounted 10 where the corrected
  // order retains 0, and the chargeback that reversed it mirrored the same 10. Both documents are
  // wrong by the same figure, so what survives is 10 - 10 = 0: this customer is square, and r6 put
  // the order on the must-fix list to have a person establish exactly that by hand.
  const handoff = await handoffFor([postedInvoice()], 0, FULLY_REVERSED_INVOICE, [chargebackReversing(10)])

  assert.equal(handoff.refunded, true)
  assert.equal(handoff.reversal.ok, true)
  assert.equal(handoff.remedy, null, 'nothing to do is not a remedy')
  assert.equal(handoff.needsAccountingAction, false)
  const text = handoff.lines.join('\n')
  assert.match(text, /THE POSITION NETS: 10 - 10 = 0 GBP/)
  assert.match(text, /THE TWO ERRORS CANCEL/)
  assert.doesNotMatch(text, /raise a further invoice/)
})

test('a credit note that reversed LESS leaves the customer owing, and says so (o3d-y14 r7 F4)', async () => {
  // The chargeback ran after some of the correction had reached it: the invoice discounted 10, the
  // credit note reversed only 6. The customer paid 90 and got 94 back... no: they were UNDER-charged
  // by more than they were UNDER-credited, so 4 is still owed TO the business.
  const handoff = await handoffFor([postedInvoice()], 0, FULLY_REVERSED_INVOICE, [chargebackReversing(6)])

  assert.equal(handoff.remedy?.kind, 'INCREASE_RECEIVABLE')
  assert.equal(handoff.remedy?.amount, 4)
  assert.equal(handoff.needsAccountingAction, true)
  const text = handoff.lines.join('\n')
  assert.match(text, /THE CUSTOMER STILL OWES 4 GBP/)
  assert.match(text, /Raise a further invoice to the same contact for 4 GBP/)
  // A credit note is allocated to that invoice, so Xero will not let it be edited — offering the
  // edit would send the operator to an operation the UI refuses.
  assert.doesNotMatch(text, /Remove & Redo/)
  assert.doesNotMatch(text, /re-approve/)
})

test('a credit note that reversed MORE leaves the customer OWED — the other direction (o3d-y14 r7 F4)', async () => {
  // THE DIRECTION THAT HAS BEEN WRONG THREE ROUNDS RUNNING. The credit note reversed 14 of a
  // discount the invoice only charged 10 of, so the business took 4 too much off this customer and
  // owes it back. r6's own refusal text told the operator to "settle THAT figure as an ordinary
  // receivable" — which bills them for money they are owed.
  const handoff = await handoffFor([postedInvoice()], 0, FULLY_REVERSED_INVOICE, [chargebackReversing(14)])

  assert.equal(handoff.remedy?.kind, 'DECREASE_RECEIVABLE')
  assert.equal(handoff.remedy?.amount, 4)
  const text = handoff.lines.join('\n')
  assert.match(text, /THE CUSTOMER IS OWED 4 GBP/)
  assert.match(text, /Raise a credit note for 4 GBP/)
  assert.doesNotMatch(text, /raise a further invoice/i)
  assert.doesNotMatch(text, /receivable/i, 'the word that pointed the wrong way is not here at all')
})

test('the two netted directions are OPPOSITE, on one field of the fixture (o3d-y14 r7 F4)', async () => {
  // The pair the finding turns on. Same invoice, same evidence, same everything except how much the
  // credit note reversed — and if they rendered the same instruction, every assertion above would be
  // passing on a coincidence.
  const owes = await handoffFor([postedInvoice()], 0, FULLY_REVERSED_INVOICE, [chargebackReversing(6)])
  const owed = await handoffFor([postedInvoice()], 0, FULLY_REVERSED_INVOICE, [chargebackReversing(14)])

  assert.notDeepEqual(owes.lines, owed.lines)
  assert.notEqual(owes.remedy?.kind, owed.remedy?.kind)
  assert.equal(owes.remedy?.amount, owed.remedy?.amount, 'the same magnitude — only the direction differs')
})

test('a WooCommerce-mirrored refund still suppresses every remedy (o3d-y14 r7 F4)', async () => {
  // The dominant shape on these orders, and the one r6's blanket refusal was actually right about:
  // `refund-sync.ts` emits no discount leg at all, so the absence proves nothing and there is no
  // subtraction to make. What CHANGES is the reason given — a named condition instead of a false
  // claim that IMS recorded nothing.
  const handoff = await handoffFor([postedInvoice()], 0, FULLY_REVERSED_INVOICE, [
    mirroringChargeback({ chargeback: false }),
  ])

  assert.equal(handoff.reversal.ok, false)
  assert.equal(handoff.remedy, null)
  const text = handoff.lines.join('\n')
  assert.match(text, /NO REMEDY IS PRESCRIBED/)
  assert.match(text, /not built by mirroring the invoice/)
  assert.doesNotMatch(text, /kind is not preserved/, 'the false r6 justification is gone')
})

test('the derivable and non-derivable refunded orders render DIFFERENT text (o3d-y14 r7 F4)', async () => {
  const derivable = await handoffFor([postedInvoice()], 0, FULLY_REVERSED_INVOICE, [chargebackReversing(10)])
  const not = await handoffFor([postedInvoice()], 0, FULLY_REVERSED_INVOICE, [
    mirroringChargeback({ chargeback: false }),
  ])

  assert.notDeepEqual(derivable.lines, not.lines)
  assert.notEqual(derivable.needsAccountingAction, not.needsAccountingAction)
  assert.notEqual(derivable.reversal.ok, not.reversal.ok)
})

test('an UNVERIFIED invoice is never netted, however derivable the credit-note side is', async () => {
  // Half a position is not a position. The credit notes derive perfectly here; the invoice does not,
  // so there is no subtraction to do and no remedy to prescribe.
  const handoff = await handoffFor(
    [postedInvoice(), postedInvoice({ type: 'SALES_INVOICE_UPDATE', status: 'PENDING', externalId: null })],
    0,
    FULLY_REVERSED_INVOICE,
    [chargebackReversing(10)],
  )

  assert.equal(handoff.invoice.case, 'DOCUMENT_UNVERIFIED')
  assert.equal(handoff.reversal.ok, true, 'the credit-note side really is derivable')
  assert.equal(handoff.remedy, null, 'and it still prescribes nothing')
  // AND IT IS NOT "SETTLED". `remedy === null` plus a readable credit-note side is exactly the
  // shape of the netted-to-zero case, and reading this one as that would take an order whose
  // invoice nobody can read OFF the must-fix list — the r5 defect in a new place.
  assert.equal(handoff.needsAccountingAction, true)
})

test('a NO_INVOICE refunded order with a readable credit-note side is not "settled" either', async () => {
  const handoff = await handoffFor([], 0, { ...LINKED_INVOICE, accountingInvoiceId: null, refunds: FULLY_REVERSED }, [
    chargebackReversing(10),
  ])

  assert.equal(handoff.invoice.case, 'NO_INVOICE_IN_LEDGER')
  assert.equal(handoff.remedy, null)
  assert.equal(handoff.needsAccountingAction, true, 'a credit note is a ledger document derived from the old amount')
})

test('an order with NO refunds never reads the credit-note side at all', async () => {
  let asked = 0
  const { buildWcCouponLedgerHandoff } = await import(
    '@/lib/connectors/woocommerce/sync/coupon-discount-ledger-handoff'
  )
  const client = {
    ...(makeEventClient([postedInvoice()]) as never as Record<string, unknown>),
    salesOrderRefund: {
      findMany: async () => {
        asked += 1
        return []
      },
    },
  } as never

  const handoff = await buildWcCouponLedgerHandoff(client, {
    orderId: 'order-1',
    currency: 'GBP',
    keptOrderLevel: 0,
    evidence: LINKED_INVOICE,
  })

  assert.equal(asked, 0, 'nearly every order is unrefunded; it must cost them nothing')
  assert.equal(handoff.remedy?.kind, 'INCREASE_RECEIVABLE')
})

// ---------------------------------------------------------------------------
// o3d-y14 r7 finding 1 — a PARKED refund is a refund
// ---------------------------------------------------------------------------

const PARKED_ONLY: RefundEvidence = {
  disposition: 'NONE',
  refundIds: [],
  postedCreditNoteExternalIds: [],
  unresolvedRefundParkExternalIds: ['9001'],
}

// ---------------------------------------------------------------------------
// o3d-y14 r8 findings 1, 2 and 3 — when the SUBTRACTION itself is not defined
// ---------------------------------------------------------------------------

/**
 * THE THREE WAYS r7's NETTING NETTED THE WRONG THING.
 *
 * Every fixture below is the netted-to-zero fixture — `postedInvoice()` at 10, one mirroring
 * chargeback that reversed 10, a corrected residual of 0 — with exactly ONE thing changed, and each
 * is asserted to render DIFFERENT text and a DIFFERENT `needsAccountingAction` from it. A fixture
 * set where the suppressed and the netted cases looked alike would prove nothing, which is the trap
 * the r5 and r6 pairs in this file were already written to avoid.
 */
const NETTED_TO_ZERO = () => handoffFor([postedInvoice()], 0, FULLY_REVERSED_INVOICE, [chargebackReversing(10)])

/** The SAME invoice, enqueued TAX-INCLUSIVE: its order-discount line is a GROSS figure. */
function inclusiveInvoice(over: Partial<EventRow> = {}): EventRow {
  return postedInvoice({
    linesJson: documentPayload({
      lineAmountMode: 'INCLUSIVE',
      lineAmountsIncludeTax: true,
      discount: { amount: 10, accountCode: '260' },
    }),
    ...over,
  })
}

test('a TAX-INCLUSIVE invoice is NOT netted against NET refund lines (o3d-y14 r8 F1)', async () => {
  // The invoice's 10 is GROSS; the credit note's 10 is NET (the chargeback divides by 1 + the tax
  // rate before storing the mirrored leg, and the credit note posts lineAmountsIncludeTax: false).
  // Their difference is not a number, and r7 printed it as "THE POSITION NETS: 10 - 10 = 0" —
  // declaring an order square whose two figures had never been compared at all.
  const inclusive = await handoffFor([inclusiveInvoice()], 0, FULLY_REVERSED_INVOICE, [chargebackReversing(10)])
  const exclusive = await NETTED_TO_ZERO()

  assert.equal(inclusive.reversal.ok, true, 'the credit-note side is still perfectly derivable')
  assert.equal(inclusive.remedy, null)
  assert.equal(inclusive.needsAccountingAction, true, 'and it is NOT settled')
  const text = inclusive.lines.join('\n')
  assert.doesNotMatch(text, /THE POSITION NETS/)
  assert.match(text, /enqueued TAX-INCLUSIVE, so its order-level discount is a GROSS figure/)
  assert.match(text, /IMS CANNOT NET THE TWO FOR YOU here/)
  // The pair differs on `lineAmountsIncludeTax` ALONE, and the two answers are opposite.
  assert.equal(exclusive.needsAccountingAction, false)
  assert.notDeepEqual(inclusive.lines, exclusive.lines)
})

test('a tax-inclusive invoice would otherwise have PRESCRIBED a fabricated receivable (o3d-y14 r8 F1)', async () => {
  // The dangerous shape, not merely the mislabelled one: a gross 12 against a net 10 reads as "the
  // customer still owes 2" and prescribes an invoice for it, against a fully refunded customer.
  const handoff = await handoffFor(
    [inclusiveInvoice({ linesJson: documentPayload({ lineAmountsIncludeTax: true, lineAmountMode: 'INCLUSIVE', discount: { amount: 12, accountCode: '260' } }) })],
    0,
    FULLY_REVERSED_INVOICE,
    [chargebackReversing(10)],
  )

  assert.equal(handoff.remedy, null)
  const text = handoff.lines.join('\n')
  assert.doesNotMatch(text, /THE CUSTOMER STILL OWES/)
  assert.doesNotMatch(text, /Raise a further invoice/)
  // The invoice finding itself is still reported — it is a fact and the operator needs it.
  assert.match(text, /carries an order-level discount of 12 GBP/)
})

test('a payload that states NEITHER tax field is not read as EXCLUSIVE (o3d-y14 r8 F1)', async () => {
  const bare = documentPayload({ discount: { amount: 10, accountCode: '260' } }) as Record<string, unknown>
  delete bare.lineAmountsIncludeTax
  delete bare.lineAmountMode
  const handoff = await handoffFor([postedInvoice({ linesJson: bare })], 0, FULLY_REVERSED_INVOICE, [
    chargebackReversing(10),
  ])

  assert.equal(handoff.remedy, null)
  assert.equal(handoff.needsAccountingAction, true)
  assert.match(handoff.lines.join('\n'), /tax basis of that invoice's order-level discount is UNKNOWN/)
})

test('TWO AGREEING posted invoices are not collapsed into one netting leg (o3d-y14 r8 F2)', async () => {
  // The agreement rule was built for the RESOLVER: a mirroring credit note reverses this figure
  // whichever document it reverses. It is not a statement that there is ONE document — the ledger
  // holds that discount twice here — so netting one credit-note total against one of them is
  // arithmetic over a set that is not the ledger's.
  const two = await handoffFor(
    [postedInvoice(), postedInvoice({ externalId: 'INV-779', createdAt: '2026-05-03T09:00:00.000Z' })],
    0,
    FULLY_REVERSED_INVOICE,
    [chargebackReversing(10)],
  )
  const one = await NETTED_TO_ZERO()

  // Both documents carry 10 against a corrected residual of 0, so the CASE is the same one the
  // netted fixture produces — the difference is purely that there are two of them.
  assert.equal(two.invoice.case, 'DOCUMENT_DISCOUNTS_MORE')
  assert.equal(one.invoice.case, 'DOCUMENT_DISCOUNTS_MORE', 'the pair differs only in the document count')
  assert.equal(two.reversal.ok, true)
  assert.equal(two.remedy, null)
  assert.equal(two.needsAccountingAction, true)
  const text = two.lines.join('\n')
  assert.doesNotMatch(text, /THE POSITION NETS/)
  assert.match(text, /2 posted sales-invoice documents exist for this order and they AGREE/)
  // The pair differs on the NUMBER of posted documents alone.
  assert.equal(one.needsAccountingAction, false)
  assert.notDeepEqual(two.lines, one.lines)
})

test('a VOIDED credit note stops the position netting (o3d-y14 r8 F3)', async () => {
  // r7's premise — the persisted lines ARE what the document carried — holds at posting time and
  // says nothing about a document retired afterwards. Here the mirror says it was.
  const voided = await handoffFor([postedInvoice()], 0, FULLY_REVERSED_INVOICE, [chargebackReversing(10)], [
    { sourceEntityId: 'refund-1', type: 'CREDIT_NOTE', status: 'VOID', externalId: 'CN-501' },
  ])
  const live = await NETTED_TO_ZERO()

  assert.equal(voided.reversal.ok, false)
  assert.equal(voided.remedy, null)
  assert.equal(voided.needsAccountingAction, true)
  assert.match(voided.lines.join('\n'), /status VOID — a credit note that was retired or re-posted/)
  assert.notDeepEqual(voided.lines, live.lines)
  assert.notEqual(voided.needsAccountingAction, live.needsAccountingAction)
})

test('a netted remedy NAMES the credit notes it depends on and says IMS cannot watch them (r8 F3)', async () => {
  const handoff = await handoffFor([postedInvoice()], 0, FULLY_REVERSED_INVOICE, [chargebackReversing(6)])

  assert.equal(handoff.remedy?.kind, 'INCREASE_RECEIVABLE')
  assert.deepEqual(handoff.remedy?.nettedAgainst, ['CN-501'])
  const text = handoff.lines.join('\n')
  assert.match(text, /THIS FIGURE IS THE INVOICE NETTED AGAINST CREDIT NOTE\(S\) CN-501/)
  assert.match(text, /voided or edited by hand there writes nothing back to IMS/)
})

test('a NON-netted remedy names no credit note to confirm — it depends on none (r8 F3)', async () => {
  const handoff = await handoffFor([postedInvoice()], 0)

  assert.equal(handoff.remedy?.kind, 'INCREASE_RECEIVABLE')
  assert.deepEqual(handoff.remedy?.nettedAgainst, [])
  assert.doesNotMatch(handoff.lines.join('\n'), /NETTED AGAINST CREDIT NOTE/)
})

test('the refusal prose says WHICH half failed, and never denies a half it just derived (r8)', async () => {
  // A sentence an operator can see is wrong is a sentence they start discounting. Two cases used to
  // assert flatly that the credit-note side was unreadable, on orders where it had just been read.
  const agreesInclusive = await handoffFor([inclusiveInvoice()], 10, FULLY_REVERSED_INVOICE, [chargebackReversing(10)])
  assert.equal(agreesInclusive.invoice.case, 'DOCUMENT_AGREES')
  assert.equal(agreesInclusive.reversal.ok, true)
  const agreesText = agreesInclusive.lines.join('\n')
  assert.doesNotMatch(agreesText, /what they carry could not be established here/)
  assert.match(agreesText, /what could not be established is the NET/)

  const unverified = await handoffFor(
    [postedInvoice(), postedInvoice({ type: 'SALES_INVOICE_UPDATE', status: 'PENDING', externalId: null })],
    0,
    FULLY_REVERSED_INVOICE,
    [chargebackReversing(10)],
  )
  assert.equal(unverified.invoice.case, 'DOCUMENT_UNVERIFIED')
  assert.equal(unverified.reversal.ok, true)
  const unverifiedText = unverified.lines.join('\n')
  assert.doesNotMatch(unverifiedText, /TWO unknowns here/)
  assert.match(unverifiedText, /the half of the position that CAN be read is printed below/)

  // And where the credit-note side really IS unreadable, the original wording stands.
  const opaque = await handoffFor([postedInvoice()], 10, FULLY_REVERSED_INVOICE, [
    mirroringChargeback({ chargeback: false }),
  ])
  assert.equal(opaque.reversal.ok, false)
  assert.match(opaque.lines.join('\n'), /what they carry could not be established here/)
})

test('a PARKED WooCommerce refund suppresses the remedy on its own (o3d-y14 r7 F1)', async () => {
  // THE FINDING. A refund that arrived and could not be recorded writes no SalesOrderRefund, no
  // status change and no credit note — so all three r6 signals read "not refunded" and the order
  // used to receive the full "raise a further invoice" remedy. The money has already left.
  const handoff = await handoffFor([postedInvoice()], 0, { ...LINKED_INVOICE, refunds: PARKED_ONLY })

  assert.equal(handoff.refunded, true)
  assert.equal(handoff.remedy, null)
  const text = handoff.lines.join('\n')
  assert.match(text, /NO REMEDY IS PRESCRIBED/)
  assert.match(text, /9001 ARRIVED AND COULD NOT BE RECORDED/)
  assert.doesNotMatch(text, /Otherwise raise a further invoice/)
})

test('a parked refund and NO refund are DIFFERENT classifications (o3d-y14 r7 F1)', async () => {
  // The fixture pair the finding turns on: identical in every field but the park list. If the two
  // rendered the same handoff this file would prove nothing about parks at all.
  const parked = await handoffFor([postedInvoice()], 0, { ...LINKED_INVOICE, refunds: PARKED_ONLY })
  const clean = await handoffFor([postedInvoice()], 0, LINKED_INVOICE)

  assert.notDeepEqual(parked.lines, clean.lines)
  assert.notEqual(parked.refunded, clean.refunded)
  assert.equal(parked.remedy, null)
  assert.equal(clean.remedy?.kind, 'INCREASE_RECEIVABLE')
})

test('a parked refund is named in the operator text where a recorded one would be', async () => {
  // It is reported LAST and separately, because it is not a statement about IMS's records: it says
  // money left the business and IMS holds nothing for it.
  for (const externalId of ['9001', '9002', '9003']) {
    const handoff = await handoffFor([postedInvoice()], 0, {
      ...LINKED_INVOICE,
      refunds: { ...PARKED_ONLY, unresolvedRefundParkExternalIds: [externalId] },
    })
    assert.match(handoff.lines.join('\n'), new RegExp(`refund\\(s\\) ${externalId} ARRIVED`))
  }
})

// ---------------------------------------------------------------------------
// o3d-y14 r7 finding 3 — NO REMEDY REACHES AN OPERATOR EXCEPT THROUGH THE CLASSIFIER
// ---------------------------------------------------------------------------

/**
 * Phrases that tell an operator to MOVE MONEY. Anything here, in a line that is not part of a
 * rendered `WcCouponRemedy`, is a remedy that escaped the classifier — which is what r7 finding 3
 * is, and what rounds 4, 5 and 6 each shipped a fresh instance of.
 */
const INSTRUMENT =
  /raise a further invoice|raise a credit note|raise a credit memo|credit the difference|receivable|Add Credit Note|Remove & Redo|Receive Payment screen|delete that line|edit it down|re-approve|delete its |set its .* line to/i

/**
 * A clause that FORBIDS rather than instructs. "Do NOT raise a credit note" is not a remedy.
 *
 * AND IT MUST COME FIRST. A prohibition that appears AFTER the instrument does not govern it: r6's
 * defect line — "settle THAT figure as an ordinary receivable, with both documents in front of you —
 * never the figure above" — carries both, and the "never" forbids a different thing entirely. A
 * lexicon test that merely asked whether the two co-occur passed that line unchanged, so the rule is
 * positional.
 */
const PROHIBITION = /\bdo not\b|\bnever\b|NO REMEDY IS PRESCRIBED|RECREATES|refunds the same money|the wrong instrument/i

/** Does a prohibition GOVERN the first instrument in this line — i.e. precede it? */
function instrumentIsForbidden(line: string): boolean {
  const instrument = line.search(INSTRUMENT)
  const prohibition = line.search(PROHIBITION)
  return prohibition >= 0 && prohibition < instrument
}

/** Every shape the handoff can take, as (name, builder) — enumerated so none can be forgotten. */
const MATRIX: Array<[string, () => Promise<{ lines: string[]; remedy: unknown }>]> = [
  ['unrefunded / no invoice', () => handoffFor([], 0, { ...LINKED_INVOICE, accountingInvoiceId: null })],
  ['unrefunded / agrees', () => handoffFor([invoiceWithNoDiscountAccount()], 0)],
  ['unrefunded / discounts more', () => handoffFor([postedInvoice()], 0)],
  ['unrefunded / discounts less', () => handoffFor([invoiceWithNoDiscountAccount()], 4)],
  [
    'unrefunded / unverified',
    () =>
      handoffFor(
        [postedInvoice(), postedInvoice({ type: 'SALES_INVOICE_UPDATE', status: 'PENDING', externalId: null })],
        4,
      ),
  ],
  ['refunded / no invoice', () => handoffFor([], 0, { ...LINKED_INVOICE, accountingInvoiceId: null, refunds: FULLY_REVERSED })],
  ['refunded / agrees', () => handoffFor([invoiceWithNoDiscountAccount()], 0, FULLY_REVERSED_INVOICE)],
  ['refunded / discounts more', () => handoffFor([postedInvoice()], 0, FULLY_REVERSED_INVOICE)],
  ['refunded / discounts less', () => handoffFor([invoiceWithNoDiscountAccount()], 4, FULLY_REVERSED_INVOICE)],
  [
    'refunded / unverified',
    () =>
      handoffFor(
        [postedInvoice(), postedInvoice({ type: 'SALES_INVOICE_UPDATE', status: 'PENDING', externalId: null })],
        4,
        FULLY_REVERSED_INVOICE,
      ),
  ],
  ['parked refund only', () => handoffFor([postedInvoice()], 0, { ...LINKED_INVOICE, refunds: PARKED_ONLY })],
  [
    'partial refund',
    () =>
      handoffFor([postedInvoice()], 0, {
        ...LINKED_INVOICE,
        refunds: { disposition: 'PARTIAL', refundIds: ['refund-9'], postedCreditNoteExternalIds: [], unresolvedRefundParkExternalIds: [] },
      }),
  ],
  ['netted / settled', () => handoffFor([postedInvoice()], 0, FULLY_REVERSED_INVOICE, [chargebackReversing(10)])],
  ['netted / customer owes', () => handoffFor([postedInvoice()], 0, FULLY_REVERSED_INVOICE, [chargebackReversing(6)])],
  ['netted / customer owed', () => handoffFor([postedInvoice()], 0, FULLY_REVERSED_INVOICE, [chargebackReversing(14)])],
]

test('NO instrument reaches an operator except through a WcCouponRemedy (o3d-y14 r7 F3)', async () => {
  // THE PROPERTY, asserted over the whole matrix rather than case by case. Three rounds of
  // case-by-case review each let exactly one wrong-direction instruction through; this cannot be
  // satisfied by fixing the case that was found, because it checks every case at once.
  const { wcCouponRemedySteps } = await import('@/lib/connectors/woocommerce/sync/coupon-discount-ledger-handoff')

  for (const [name, build] of MATRIX) {
    const handoff = await build()
    const remedyLines = new Set(
      handoff.remedy ? wcCouponRemedySteps(handoff.remedy as never) : [],
    )
    // Every remedy step the classifier produced is actually IN the output — otherwise "the remedy
    // is a value" would be true and irrelevant.
    for (const step of remedyLines) {
      assert.ok(handoff.lines.includes(step), `${name}: a remedy step was built and never printed`)
    }
    for (const line of handoff.lines) {
      if (remedyLines.has(line)) continue
      if (!INSTRUMENT.test(line)) continue
      assert.ok(
        instrumentIsForbidden(line),
        `${name}: an instrument reached the operator outside the remedy, and nothing before it ` +
          `forbids it:\n  ${line}`,
      )
    }
  }
})

test('"NO REMEDY IS PRESCRIBED" is only ever said when there is none (o3d-y14 r7 F3)', async () => {
  // r6 printed that heading and then prescribed a receivable four lines later. Making the claim
  // checkable against the value is what stops the two drifting apart again.
  for (const [name, build] of MATRIX) {
    const handoff = await build()
    const claims = handoff.lines.some((line) => /NO REMEDY IS PRESCRIBED/.test(line))
    if (claims) assert.equal(handoff.remedy, null, `${name}: claimed no remedy while carrying one`)
  }
})

test('the suppressed fallback names no receivable and no instrument at all (o3d-y14 r7 F3)', async () => {
  // The exact defect: "if something is genuinely outstanding, settle THAT figure as an ordinary
  // receivable" — a DIRECTION, and the wrong one whenever the customer is the party owed, printed
  // under a "NO REMEDY IS PRESCRIBED" heading.
  const handoff = await handoffFor([postedInvoice()], 0, FULLY_REVERSED_INVOICE)

  assert.equal(handoff.remedy, null)
  const text = handoff.lines.join('\n')
  assert.doesNotMatch(text, /ordinary receivable/)
  assert.doesNotMatch(text, /settle THAT figure/)
  assert.match(text, /record WHICH WAY the difference goes/)
  assert.match(text, /whether this customer still owes\s+money or is owed it/)
  assert.match(text, /naming no instrument for\s+either direction/)
})

test('with NO posted credit note the fallback does not send the operator to open one (o3d-y14 r7 F3)', async () => {
  // The refund-row-only case. The old text said "open the invoice and every credit note above" —
  // naming a document that does not exist, and leaving the refund unestablishable from the ones it
  // does name.
  const handoff = await handoffFor([postedInvoice()], 0, {
    ...LINKED_INVOICE,
    refunds: { disposition: 'PARTIAL', refundIds: ['refund-9'], postedCreditNoteExternalIds: [], unresolvedRefundParkExternalIds: [] },
  })

  const text = handoff.lines.join('\n')
  assert.match(text, /THERE IS NO POSTED CREDIT NOTE TO OPEN/)
  assert.match(text, /Establish it from the WooCommerce order\s+and the payment provider first/)
  assert.doesNotMatch(text, /every credit note above/)
})

test('every remedy carries the refund position it depends on, and says to re-check it (o3d-y14 r7 F2)', async () => {
  // r7 finding 2: the correction's lock proves the position at the moment the amount was rewritten
  // and nothing about the moment a human reads the line. The precondition is printed FIRST and by
  // the same function that prints the instrument, so no remedy can be rendered without it.
  for (const [name, build] of MATRIX) {
    const handoff = await build()
    if (!handoff.remedy) continue
    const first = handoff.lines.find((line) => /^REMEDY \(/.test(line))
    assert.ok(first, `${name}: a remedy with no precondition line`)
    assert.match(first, /VALID ONLY WHILE this order's refund position is/, name)
    assert.match(first, /RE-CHECK THAT IMMEDIATELY BEFORE POSTING/, name)
  }
})
