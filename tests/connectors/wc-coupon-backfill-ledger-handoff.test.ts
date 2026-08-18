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

const LINKED_INVOICE: LedgerEvidence = {
  accountingInvoiceId: 'INV-778',
  postedInvoiceExternalIds: [],
  revenueDeferredBatchRef: null,
}

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

function correctionStore(eventRows: EventRow[]) {
  return {
    orders: [
      {
        id: 'order-1',
        discountAmount: 10,
        discountModel: null,
        lines: [{ discountAmount: 10 }],
        importedAt: IMPORTED_AT,
        accountingInvoiceId: 'INV-778',
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
