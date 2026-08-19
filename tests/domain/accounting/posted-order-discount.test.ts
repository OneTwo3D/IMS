import assert from 'node:assert/strict'
import test from 'node:test'

import { buildChargebackRefundLines } from '@/lib/domain/sales/refund-service'
import { buildDiscountRestatement } from '@/lib/domain/accounting/discount-restatement'
import {
  decideChargebackOrderDiscount,
  readPostedDocumentDiscount,
  readPostedInvoiceOrderDiscount,
  resolvePostedOrderDiscount,
  type PostedOrderDiscountClient,
} from '@/lib/domain/accounting/posted-order-discount'

/**
 * o3d-y14 r3 finding 1 / r4 findings 1-3 — A CHARGEBACK MUST REVERSE THE DOCUMENT, NOT THE ORDER.
 *
 * The shape of the defect, on a legacy WooCommerce order the o3d-y14 backfill corrects:
 *
 *     invoice posted   goods 100 (lines already net of the coupon) − order discount 10  = 90
 *     backfill runs    SalesOrder.discountAmount 10 -> 0, restatement record written
 *     payment reversed → chargeback builds its credit note from the LIVE column
 *     credit note      goods 100 − order discount 0                                     = 100
 *                      ^ 10 more AR and revenue reversed than the invoice ever raised
 *
 * Nothing about that is a race, so no freshness check fixes it: after the correction the column is
 * PERMANENTLY not what the invoice said. The fix is to read the right source — and, where the right
 * source and the order disagree or the source cannot be read, to refuse rather than pick one.
 *
 * THE DOUBLES HONOUR THEIR FILTERS, and throw on any predicate they have not been taught. A double
 * that matched regardless of `where` could not tell "the posted document" from "any mirrored event",
 * which is most of what these cases assert; one that silently ignored an unknown operator would go
 * on passing after production started asking a different question.
 *
 * AND THE FIXTURES SEPARATE REQUESTED FROM POSTED. `linesJson` records the payload IMS ENQUEUED, and
 * Xero appends its negative "Order discount" line only when a discount ACCOUNT CODE came with it —
 * so an event carrying `discount: { amount: 10 }` with no account code describes an invoice that
 * charged NO discount at all. Several cases below use exactly that fixture: a test whose event
 * amount equalled the posted amount could not tell the two readings apart.
 */

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

type SyncLogRow = {
  referenceType: string
  referenceId: string
  type: string
  status: string
  externalTransactionId: string | null
}

type Calls = { eventCount: number; findMany: number; syncLogCount: number }

/** Match ONE `where` value against a row field, refusing any operator this double cannot honour. */
function matches(rowValue: unknown, predicate: unknown, field: string): boolean {
  if (predicate !== null && typeof predicate === 'object' && !Array.isArray(predicate)) {
    const clauses = predicate as Record<string, unknown>
    const keys = Object.keys(clauses)
    const supported = new Set(['in', 'notIn', 'not'])
    for (const key of keys) {
      if (!supported.has(key)) {
        throw new Error(`the double does not implement the "${key}" operator asked for on ${field}`)
      }
    }
    let ok = true
    if ('in' in clauses) ok &&= (clauses.in as unknown[]).includes(rowValue)
    if ('notIn' in clauses) ok &&= !(clauses.notIn as unknown[]).includes(rowValue)
    // The only `not` production uses is `{ not: null }` — "this column is populated".
    if ('not' in clauses) {
      if (clauses.not !== null) throw new Error(`the double only implements { not: null } on ${field}`)
      ok &&= rowValue !== null && rowValue !== undefined
    }
    return ok
  }
  return rowValue === predicate
}

function whereMatches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([field, predicate]) => {
    if (!(field in row)) throw new Error(`the double has no ${field} column to filter on`)
    return matches(row[field], predicate, field)
  })
}

function makeClient(
  store: { events?: EventRow[]; syncLogs?: SyncLogRow[] } = {},
): { client: PostedOrderDiscountClient; calls: Calls } {
  const events = store.events ?? []
  const syncLogs = store.syncLogs ?? []
  const calls: Calls = { eventCount: 0, findMany: 0, syncLogCount: 0 }

  const client = {
    accountingEvent: {
      count: async ({ where }: { where: Record<string, unknown> }) => {
        calls.eventCount += 1
        return events.filter((event) => whereMatches(event as unknown as Record<string, unknown>, where)).length
      },
      findMany: async ({
        where,
        orderBy,
      }: {
        where: Record<string, unknown>
        orderBy: Array<Record<string, 'desc' | 'asc'>>
      }) => {
        calls.findMany += 1
        const matched = events.filter((event) => whereMatches(event as unknown as Record<string, unknown>, where))
        // Honours the ORDER production asks for, so a case that depends on which document is NAMED
        // is a property of the code rather than of the fixture's array order.
        const sorted = [...matched].sort((a, b) => {
          for (const clause of orderBy) {
            const [field, direction] = Object.entries(clause)[0] as ['businessDate' | 'createdAt', 'desc' | 'asc']
            if (a[field] === b[field]) continue
            const compare = a[field] < b[field] ? -1 : 1
            return direction === 'desc' ? -compare : compare
          }
          return 0
        })
        return sorted as never
      },
    },
    accountingSyncLog: {
      count: async ({ where }: { where: Record<string, unknown> }) => {
        calls.syncLogCount += 1
        return syncLogs.filter((log) => whereMatches(log as unknown as Record<string, unknown>, where)).length
      },
    },
  } as unknown as PostedOrderDiscountClient

  return { client, calls }
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
    // accountCode present: this invoice really did carry a negative "Order discount" line of 10.
    linesJson: documentPayload({ discount: { amount: 10, accountCode: '260' } }),
    ...over,
  }
}

function restatement(
  over: Partial<Parameters<typeof buildDiscountRestatement>[0]['ledger']> = {},
  amounts: { from?: number; to?: number } = {},
) {
  return buildDiscountRestatement({
    reason: 'o3d-y14-wc-coupon',
    at: new Date('2026-06-01T10:00:00.000Z'),
    from: amounts.from ?? 10,
    to: amounts.to ?? 0,
    currency: 'GBP',
    ledger: {
      accountingInvoiceId: 'INV-778',
      postedInvoiceExternalIds: [],
      revenueDeferredBatchRef: null,
      ...over,
    },
  })
}

/** The corrected state: the backfill cleared the duplicated coupon and recorded the restatement. */
const RESTATED_ORDER = {
  id: 'order-1',
  currency: 'GBP',
  discountAmount: 0,
  discountRestatement: restatement() as unknown,
  accountingInvoiceId: 'INV-778' as string | null,
}

// ---------------------------------------------------------------------------
// Which orders are consulted at all (r4 finding 1)
// ---------------------------------------------------------------------------

test('an order with NO restatement record reads its own column and never queries the ledger (o3d-y14 r4 F1)', async () => {
  // The gate that keeps this change off every native, manual and pre-column order: the backfill
  // writes the amount and the record in ONE update, so an unmarked row is one it never restated.
  const { client, calls } = makeClient({ events: [postedInvoice()] })

  const resolved = await resolvePostedOrderDiscount(client, {
    id: 'order-1',
    currency: 'GBP',
    discountAmount: 12.5,
    discountRestatement: null,
    accountingInvoiceId: 'INV-778',
  })

  assert.equal(resolved.source, 'ORDER')
  assert.equal(resolved.source === 'ORDER' && resolved.amount, 12.5)
  assert.deepEqual(calls, { eventCount: 0, findMany: 0, syncLogCount: 0 }, 'no ledger lookup for an unrestated order')
})

test('a row the backfill only STAMPED as already-correct is not consulted either (o3d-y14 r4 F1)', async () => {
  // stampWcCouponDiscountModel writes discountModel and NO restatement record, because it changes no
  // amount. Gating on discountModel — as the first revision did — made the fixed importer's own
  // brand-new orders depend on a mirrored event existing, for a column that was never rewritten.
  const { client, calls } = makeClient({ events: [] })

  const resolved = await resolvePostedOrderDiscount(client, {
    id: 'order-1',
    currency: 'GBP',
    discountAmount: 6,
    discountRestatement: null,
    accountingInvoiceId: 'INV-778',
  })

  assert.equal(resolved.source, 'ORDER')
  assert.equal(resolved.source === 'ORDER' && resolved.amount, 6)
  assert.equal(calls.findMany, 0)
})

test('a restatement record that cannot be READ is unrecoverable, never read as "never restated" (o3d-y14 r4 F1)', async () => {
  for (const damaged of [
    'not-json',
    42,
    {},
    { kind: 'something-else', version: 1 },
    { ...restatement(), version: 2 },
    { ...restatement(), reason: 'someone-elses-backfill' },
    { ...restatement(), at: 'not-a-date' },
    { ...restatement(), from: 'ten' },
    { ...restatement(), ledger: undefined },
    { ...restatement(), ledger: { accountingInvoiceId: 7, postedInvoiceExternalIds: [], revenueDeferredBatchRef: null } },
    { ...restatement(), ledger: { accountingInvoiceId: null, postedInvoiceExternalIds: 'INV-1', revenueDeferredBatchRef: null } },
  ]) {
    const { client } = makeClient()
    const resolved = await resolvePostedOrderDiscount(client, {
      ...RESTATED_ORDER,
      accountingInvoiceId: null,
      discountRestatement: damaged,
    })
    assert.equal(
      resolved.source,
      'UNRECOVERABLE',
      `${JSON.stringify(damaged)} must not be read as an absent record`,
    )
  }
})

// ---------------------------------------------------------------------------
// Recovering the posted figure
// ---------------------------------------------------------------------------

test('a corrected legacy order recovers what the INVOICE charged, not what it now carries (o3d-y14 r3 F1)', async () => {
  const { client } = makeClient({ events: [postedInvoice()] })

  const resolved = await resolvePostedOrderDiscount(client, RESTATED_ORDER)

  assert.equal(resolved.source, 'POSTED_DOCUMENT')
  assert.equal(resolved.source === 'POSTED_DOCUMENT' && resolved.amount, 10)
  assert.equal(resolved.source === 'POSTED_DOCUMENT' && resolved.externalId, 'INV-778')
})

test('a document that posted NO discount leg is 0, which is an answer and not a failure', async () => {
  // Without this case, "returns 0" would be indistinguishable from "could not read it", and every
  // ordinary restated order without a discount would refuse its chargeback.
  const { client } = makeClient({ events: [postedInvoice({ linesJson: documentPayload() })] })

  const resolved = await resolvePostedOrderDiscount(client, { ...RESTATED_ORDER, discountAmount: 0 })

  assert.equal(resolved.source, 'POSTED_DOCUMENT')
  assert.equal(resolved.source === 'POSTED_DOCUMENT' && resolved.amount, 0)
})

test('an event that has NOT posted is not evidence of what the ledger holds', async () => {
  // PENDING means queued, FAILED means it never landed. Reading either would attribute to the
  // ledger a figure no document carries. (Both are SALES_INVOICE here — an unsettled
  // SALES_INVOICE_UPDATE is a refusal in its own right, asserted below.)
  const { client } = makeClient({
    events: [
      postedInvoice({ status: 'PENDING', linesJson: documentPayload({ discount: { amount: 99, accountCode: '260' } }) }),
      postedInvoice({ status: 'FAILED', linesJson: documentPayload({ discount: { amount: 77, accountCode: '260' } }) }),
    ],
  })

  const resolved = await resolvePostedOrderDiscount(client, {
    ...RESTATED_ORDER,
    discountAmount: 4,
    accountingInvoiceId: null,
    discountRestatement: restatement({ accountingInvoiceId: null }),
  })

  assert.equal(resolved.source, 'ORDER')
  assert.equal(resolved.source === 'ORDER' && resolved.amount, 4)
})

test("another order's posted invoice is never read for this one", async () => {
  const { client } = makeClient({ events: [postedInvoice({ sourceEntityId: 'order-2' })] })

  const resolved = await resolvePostedOrderDiscount(client, {
    ...RESTATED_ORDER,
    discountAmount: 6,
    accountingInvoiceId: null,
    discountRestatement: restatement({ accountingInvoiceId: null }),
  })

  assert.equal(resolved.source, 'ORDER')
  assert.equal(resolved.source === 'ORDER' && resolved.amount, 6)
})

// ---------------------------------------------------------------------------
// r4 finding 3 — the mirror records the REQUEST; the document is derived from it
// ---------------------------------------------------------------------------

test('a Xero invoice enqueued with a discount but NO discount account posted no discount line (o3d-y14 r4 F3)', async () => {
  // The event says `discount: { amount: 10 }`. Xero appended nothing, because
  // `buildInvoicePayload` requires a discount account code. The posted figure is 0, not 10 — and a
  // fixture whose requested and posted amounts were equal could not tell those two readings apart.
  const { client } = makeClient({
    events: [postedInvoice({ linesJson: documentPayload({ discount: { amount: 10 } }) })],
  })

  const resolved = await resolvePostedOrderDiscount(client, { ...RESTATED_ORDER, discountAmount: 0 })

  assert.equal(resolved.source, 'POSTED_DOCUMENT')
  assert.equal(resolved.source === 'POSTED_DOCUMENT' && resolved.amount, 0, 'the document carried no discount leg')
})

test('and a credit note is NOT auto-raised for the discount that invoice never charged (o3d-y14 r4 F3)', async () => {
  // The order still carries the 10 it was invoiced with; the invoice charged the full goods. Reading
  // the REQUESTED figure would agree with the column and auto-raise a credit note 10 short of the
  // document — under-crediting the customer by the whole discount.
  const { client } = makeClient({
    events: [postedInvoice({ linesJson: documentPayload({ discount: { amount: 10 } }) })],
  })
  const posted = await resolvePostedOrderDiscount(client, { ...RESTATED_ORDER, discountAmount: 10 })

  const decision = decideChargebackOrderDiscount({ posted, orderDiscountAmount: 10 })

  assert.equal(decision.action, 'MANUAL')
  assert.equal(decision.action === 'MANUAL' && decision.reason, 'RESTATED_AFTER_POSTING')
  assert.equal(decision.action === 'MANUAL' && decision.postedAmount, 0)
})

test('QuickBooks posts its DiscountLineDetail with or without an account, so the amount stands (o3d-y14 r4 F3)', async () => {
  // The opposite adapter rule, and the reason this is connector-aware rather than a blanket "no
  // account code means no line": QBO resolves the account from the payload OR the connector setting
  // and simply leaves the ref undefined when neither resolves. The line is always there.
  const { client } = makeClient({
    events: [
      postedInvoice({
        externalSystem: 'quickbooks',
        linesJson: documentPayload({ discount: { amount: 10 } }),
      }),
    ],
  })

  const resolved = await resolvePostedOrderDiscount(client, { ...RESTATED_ORDER, discountAmount: 10 })

  assert.equal(resolved.source, 'POSTED_DOCUMENT')
  assert.equal(resolved.source === 'POSTED_DOCUMENT' && resolved.amount, 10)
})

test('a mirrored event naming no connector is refused — no posting rule can be replayed (o3d-y14 r4 F3)', async () => {
  for (const externalSystem of [null, 'sage']) {
    const { client } = makeClient({
      events: [postedInvoice({ externalSystem, linesJson: documentPayload({ discount: { amount: 10 } }) })],
    })

    const resolved = await resolvePostedOrderDiscount(client, { ...RESTATED_ORDER, discountAmount: 10 })

    assert.equal(resolved.source, 'UNRECOVERABLE', `${String(externalSystem)} must not be guessed at`)
  }
})

test('the adapter rules this derivation replays are pinned to the adapters themselves (o3d-y14 r4 F3)', async () => {
  // The derivation is only sound while the connectors keep the conditions it mirrors. Nothing else
  // in the suite fails if someone makes Xero post the discount unconditionally, or gives QuickBooks
  // an account-code guard — the recovered "posted" figure would just quietly become wrong.
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')

  const xero = readFileSync(join(process.cwd(), 'lib/connectors/xero/invoices.ts'), 'utf8')
  assert.match(
    xero,
    /if \(data\.discountAmount && data\.discountAmount > 0 && data\.discountAccountCode\) \{/,
    'Xero must still omit the order-discount line when no discount account code is supplied',
  )

  const qbo = readFileSync(join(process.cwd(), 'lib/connectors/quickbooks/invoices.ts'), 'utf8')
  const orderLevel = qbo.slice(qbo.indexOf('// Order-level discount'))
  assert.match(
    orderLevel.slice(0, orderLevel.indexOf('const invoiceBody')),
    /if \(data\.discountAmount && data\.discountAmount > 0\) \{/,
    'QuickBooks must still post its order-level discount on the amount alone',
  )
})

// ---------------------------------------------------------------------------
// r4 finding 2 — what the (externalSystem, externalId) constraint makes representable
// ---------------------------------------------------------------------------

test('an unsettled SALES_INVOICE_UPDATE refuses, even beside a posted invoice (o3d-y14 r4 F2)', async () => {
  // AccountingEvent is unique on (externalSystem, externalId), and a Xero invoice update returns the
  // ORIGINAL InvoiceID — so an update that really did modify the ledger document cannot mark its own
  // event POSTED. A non-POSTED update event is therefore exactly what success looks like, and the
  // original invoice's event can no longer be trusted to describe the document.
  const { client } = makeClient({
    events: [
      postedInvoice(),
      postedInvoice({
        type: 'SALES_INVOICE_UPDATE',
        status: 'PENDING',
        externalId: null,
        linesJson: documentPayload({ documentType: 'SALES_INVOICE_UPDATE', discount: { amount: 3, accountCode: '260' } }),
      }),
    ],
  })

  const resolved = await resolvePostedOrderDiscount(client, RESTATED_ORDER)

  assert.equal(resolved.source, 'UNRECOVERABLE')
  assert.match(resolved.detail, /SALES_INVOICE_UPDATE/)
})

test('a FAILED invoice update refuses too — the local failure is what a remote success looks like', async () => {
  const { client } = makeClient({
    events: [
      postedInvoice(),
      postedInvoice({ type: 'SALES_INVOICE_UPDATE', status: 'FAILED', externalId: null }),
    ],
  })

  const resolved = await resolvePostedOrderDiscount(client, RESTATED_ORDER)

  assert.equal(resolved.source, 'UNRECOVERABLE')
})

test('a VOIDed invoice update does NOT refuse — it is a statement that nothing was posted', async () => {
  // voidMirroredAccountingEventsForOrder only ever voids PENDING/FAILED work for a cancelled order,
  // so VOID is positive evidence. Without this the refusal above would be "any update at all",
  // which would strand orders whose update was retired.
  const { client } = makeClient({
    events: [
      postedInvoice(),
      postedInvoice({ type: 'SALES_INVOICE_UPDATE', status: 'VOID', externalId: null }),
    ],
  })

  const resolved = await resolvePostedOrderDiscount(client, RESTATED_ORDER)

  assert.equal(resolved.source, 'POSTED_DOCUMENT')
  assert.equal(resolved.source === 'POSTED_DOCUMENT' && resolved.amount, 10)
})

test('a POSTED invoice update is read as a document like any other', async () => {
  // The state that IS representable: the original invoice never mirrored (or never took the id), so
  // the update owns it. One posted document, read normally.
  const { client } = makeClient({
    events: [
      postedInvoice({
        type: 'SALES_INVOICE_UPDATE',
        businessDate: '2026-06-01',
        createdAt: '2026-06-01T09:00:00.000Z',
        linesJson: documentPayload({ documentType: 'SALES_INVOICE_UPDATE', discount: { amount: 3, accountCode: '260' } }),
      }),
    ],
  })

  const resolved = await resolvePostedOrderDiscount(client, { ...RESTATED_ORDER, discountAmount: 3 })

  assert.equal(resolved.source === 'POSTED_DOCUMENT' && resolved.amount, 3)
  assert.equal(resolved.source === 'POSTED_DOCUMENT' && resolved.documentType, 'SALES_INVOICE_UPDATE')
})

test('several posted documents that AGREE answer the question whichever one is reversed', async () => {
  const { client } = makeClient({
    events: [
      postedInvoice({ externalId: null }),
      postedInvoice({
        externalId: 'INV-901',
        businessDate: '2026-05-09',
        createdAt: '2026-05-09T09:00:00.000Z',
      }),
    ],
  })

  const resolved = await resolvePostedOrderDiscount(client, RESTATED_ORDER)

  assert.equal(resolved.source, 'POSTED_DOCUMENT')
  assert.equal(resolved.source === 'POSTED_DOCUMENT' && resolved.amount, 10)
})

test('several posted documents that DISAGREE are refused — no ordering here says which is current', async () => {
  // The old code took the newest by businessDate. Under the uniqueness constraint two POSTED rows
  // are two different DOCUMENTS, not two revisions of one, so "newest" names nothing about which the
  // credit note now reverses.
  const { client } = makeClient({
    events: [
      postedInvoice({ externalId: null }),
      postedInvoice({
        externalId: 'INV-901',
        businessDate: '2026-05-09',
        createdAt: '2026-05-09T09:00:00.000Z',
        linesJson: documentPayload({ discount: { amount: 4, accountCode: '260' } }),
      }),
    ],
  })

  const resolved = await resolvePostedOrderDiscount(client, RESTATED_ORDER)

  assert.equal(resolved.source, 'UNRECOVERABLE')
  assert.match(resolved.detail, /different order-level discounts/)
})

// ---------------------------------------------------------------------------
// When it cannot be recovered
// ---------------------------------------------------------------------------

test('a linked invoice with no posted event is UNRECOVERABLE, never assumed to be the column', async () => {
  const { client } = makeClient()

  const resolved = await resolvePostedOrderDiscount(client, RESTATED_ORDER)

  assert.equal(resolved.source, 'UNRECOVERABLE')
  assert.match(resolved.detail, /INV-778/)
})

test('a posted-but-UNLINKED invoice is UNRECOVERABLE too — the column denies a real document (o3d-9kek)', async () => {
  // accountingInvoiceId is NULL, so a check on the column alone would call this order unposted and
  // read its (restated) figure as what the ledger holds.
  const { client } = makeClient({
    syncLogs: [
      {
        referenceType: 'SalesOrder',
        referenceId: 'order-1',
        type: 'SALES_INVOICE',
        status: 'SYNCED',
        externalTransactionId: 'INV-999',
      },
    ],
  })

  const resolved = await resolvePostedOrderDiscount(client, {
    ...RESTATED_ORDER,
    accountingInvoiceId: null,
    discountRestatement: restatement({ accountingInvoiceId: null }),
  })

  assert.equal(resolved.source, 'UNRECOVERABLE')
  assert.match(resolved.detail, /no accountingInvoiceId/)
})

test('a SYNCED row with NO external id is not a posted document, so the column stands', async () => {
  // The other side of the same predicate. Without it, the case above would pass on a check that
  // refused whenever any SYNCED row existed — which would strand every restated order.
  const { client } = makeClient({
    syncLogs: [
      {
        referenceType: 'SalesOrder',
        referenceId: 'order-1',
        type: 'SALES_INVOICE',
        status: 'SYNCED',
        externalTransactionId: null,
      },
    ],
  })

  const resolved = await resolvePostedOrderDiscount(client, {
    ...RESTATED_ORDER,
    discountAmount: 5,
    accountingInvoiceId: null,
    discountRestatement: restatement({ accountingInvoiceId: null }),
  })

  assert.equal(resolved.source, 'ORDER')
  assert.equal(resolved.source === 'ORDER' && resolved.amount, 5)
})

test('EVIDENCE-FREE is not UNPOSTED: a row restated while an invoice existed refuses (o3d-y14 r4 F1)', async () => {
  // The state that made this necessary: a legacy invoice posted before AccountingEvent mirroring,
  // whose back-reference write failed (o3d-9kek) and whose SYNCED sync log retention has since
  // DELETED. All three live traces are silent, and the invoice is still in Xero. Reading that
  // silence as "nothing posted" hands the restated column to a real credit note.
  const { client } = makeClient()

  const resolved = await resolvePostedOrderDiscount(client, {
    ...RESTATED_ORDER,
    discountAmount: 0,
    accountingInvoiceId: null,
    discountRestatement: restatement({ accountingInvoiceId: null, postedInvoiceExternalIds: ['INV-555'] }),
  })

  assert.equal(resolved.source, 'UNRECOVERABLE')
  assert.match(resolved.detail, /INV-555/)
  assert.match(resolved.detail, /restated/)
})

test('the same shape with the LINK recorded rather than the sync log also refuses (o3d-y14 r4 F1)', async () => {
  const { client } = makeClient()

  const resolved = await resolvePostedOrderDiscount(client, {
    ...RESTATED_ORDER,
    discountAmount: 0,
    // The live column has since been cleared — a re-import, a repair, anything. The RECORD of the
    // moment of the restatement is what decides, and nothing prunes it.
    accountingInvoiceId: null,
    discountRestatement: restatement({ accountingInvoiceId: 'INV-778' }),
  })

  assert.equal(resolved.source, 'UNRECOVERABLE')
  assert.match(resolved.detail, /INV-778/)
})

test('a row restated while NOTHING was in the ledger reads its own column (o3d-y14 r4 F1)', async () => {
  // The only route back to the column for a restated row, and it is a positive statement rather than
  // an absence: the backfill looked, under its own lock, and there was no document. Anything posted
  // afterwards was built from the restated figure — the enqueue fence refuses a payload snapshot
  // that disagrees with the locked row — so no earlier document carries a different one.
  const { client } = makeClient()

  const resolved = await resolvePostedOrderDiscount(client, {
    ...RESTATED_ORDER,
    discountAmount: 7,
    accountingInvoiceId: null,
    discountRestatement: restatement({ accountingInvoiceId: null }),
  })

  assert.equal(resolved.source, 'ORDER')
  assert.equal(resolved.source === 'ORDER' && resolved.amount, 7)
})

test('a revenue-deferral batch alone does not refuse — it is not a document with a discount line', async () => {
  // Recorded on the marker for the operator's manual-adjustment handoff, deliberately not gating:
  // a Group A1 journal carries no order-discount line for a credit note to mirror.
  const { client } = makeClient()

  const resolved = await resolvePostedOrderDiscount(client, {
    ...RESTATED_ORDER,
    discountAmount: 7,
    accountingInvoiceId: null,
    discountRestatement: restatement({ accountingInvoiceId: null, revenueDeferredBatchRef: 'batch-2026-05-02' }),
  })

  assert.equal(resolved.source, 'ORDER')
})

// ---------------------------------------------------------------------------
// Reading one payload
// ---------------------------------------------------------------------------

test('a foreign-currency document is refused rather than read as a bare number', async () => {
  const read = readPostedDocumentDiscount(
    {
      currency: 'EUR',
      externalSystem: 'xero',
      linesJson: documentPayload({ currency: 'EUR', discount: { amount: 10, accountCode: '260' } }),
    },
    'GBP',
  )

  assert.equal(read.ok, false)
  assert.match(!read.ok ? read.detail : '', /EUR/)
})

test('a payload that is not a document payload is refused, not read as zero', () => {
  for (const linesJson of [null, 'not-json', [], { kind: 'journal', lines: [] }]) {
    const read = readPostedDocumentDiscount({ currency: 'GBP', externalSystem: 'xero', linesJson }, 'GBP')
    assert.equal(read.ok, false, `${JSON.stringify(linesJson)} must not read as a discount of 0`)
  }
})

test('an unusable discount amount is refused, not coerced', () => {
  for (const amount of [-1, Number.NaN, Number.POSITIVE_INFINITY, '10', null]) {
    const read = readPostedDocumentDiscount(
      {
        currency: 'GBP',
        externalSystem: 'xero',
        linesJson: documentPayload({ discount: { amount, accountCode: '260' } }),
      },
      'GBP',
    )
    assert.equal(read.ok, false, `${String(amount)} must not be accepted as a posted discount`)
  }
})

test('a blank discount account code is no account code at all', () => {
  const read = readPostedDocumentDiscount(
    { currency: 'GBP', externalSystem: 'xero', linesJson: documentPayload({ discount: { amount: 10, accountCode: '  ' } }) },
    'GBP',
  )

  assert.deepEqual(read, { ok: true, amount: 0, taxBasis: 'EXCLUSIVE' })
})

test('QuickBooks rounds its discount line to 2dp, and so does the figure recovered for it', () => {
  const read = readPostedDocumentDiscount(
    { currency: 'GBP', externalSystem: 'quickbooks', linesJson: documentPayload({ discount: { amount: 10.005 } }) },
    'GBP',
  )

  assert.deepEqual(read, { ok: true, amount: 10.01, taxBasis: 'EXCLUSIVE' })
})

// ---------------------------------------------------------------------------
// What the chargeback does with it
// ---------------------------------------------------------------------------

test('a corrected legacy order does NOT auto-raise a credit note, and the refusal names both figures (o3d-y14 r3 F1)', async () => {
  const { client } = makeClient({ events: [postedInvoice()] })
  const posted = await resolvePostedOrderDiscount(client, RESTATED_ORDER)

  const decision = decideChargebackOrderDiscount({ posted, orderDiscountAmount: 0 })

  assert.equal(decision.action, 'MANUAL')
  assert.equal(decision.action === 'MANUAL' && decision.reason, 'RESTATED_AFTER_POSTING')
  assert.equal(decision.action === 'MANUAL' && decision.postedAmount, 10, 'what the invoice charged')
  assert.equal(decision.action === 'MANUAL' && decision.orderAmount, 0, 'what the order now says')
  assert.equal(decision.action === 'MANUAL' && decision.externalId, 'INV-778')
})

test('the over-reversal is what MIRROR would have produced — the arithmetic, end to end (o3d-y14 r3 F1)', async () => {
  // The number the defect is worth, computed through the real line builder rather than asserted in
  // prose: reversing the order's post-correction figure credits the FULL goods, ten pounds more than
  // the invoice ever raised. This is what the refusal above prevents.
  const overReversed = buildChargebackRefundLines({
    lines: [{ lineId: 'line-1', productId: 'p1', description: 'Widget', qty: 2, totalBase: 100 }],
    discount: undefined,
  })
  const mirroringTheInvoice = buildChargebackRefundLines({
    lines: [{ lineId: 'line-1', productId: 'p1', description: 'Widget', qty: 2, totalBase: 100 }],
    discount: { totalBase: 10 },
  })

  const total = (lines: Array<{ totalBase: number }>) => lines.reduce((sum, line) => sum + line.totalBase, 0)
  assert.equal(total(overReversed), 100)
  assert.equal(total(mirroringTheInvoice), 90, 'the invoice raised 90, so a full reversal is 90')
  assert.equal(total(overReversed) - total(mirroringTheInvoice), 10)
})

test('an order whose posted document AGREES with it is auto-raised exactly as before (control)', async () => {
  // Without this, "refuses corrected orders" would pass on a rule that refuses every chargeback —
  // far worse than the defect, since it would stop every automatic payment-reversal credit note.
  const { client } = makeClient({ events: [postedInvoice()] })
  const posted = await resolvePostedOrderDiscount(client, { ...RESTATED_ORDER, discountAmount: 10 })

  const decision = decideChargebackOrderDiscount({ posted, orderDiscountAmount: 10 })

  assert.equal(decision.action, 'MIRROR')
  assert.equal(decision.action === 'MIRROR' && decision.amount, 10)
})

test('an unrestated order with a discount is auto-raised from its own column (control)', async () => {
  const { client } = makeClient()
  const posted = await resolvePostedOrderDiscount(client, {
    id: 'order-1',
    currency: 'GBP',
    discountAmount: 15,
    discountRestatement: null,
    accountingInvoiceId: 'INV-778',
  })

  const decision = decideChargebackOrderDiscount({ posted, orderDiscountAmount: 15 })

  assert.equal(decision.action, 'MIRROR')
  assert.equal(decision.action === 'MIRROR' && decision.amount, 15)
})

test('an unrecoverable posted figure goes to manual handling, not to a guessed zero', async () => {
  const { client } = makeClient()
  const posted = await resolvePostedOrderDiscount(client, RESTATED_ORDER)

  const decision = decideChargebackOrderDiscount({ posted, orderDiscountAmount: 0 })

  assert.equal(decision.action, 'MANUAL')
  assert.equal(decision.action === 'MANUAL' && decision.reason, 'POSTED_FIGURE_UNRECOVERABLE')
  assert.equal(decision.action === 'MANUAL' && decision.postedAmount, null)
})

test('the chargeback path actually CONSUMES this decision — it does not read the column directly', async () => {
  // A source assertion, for the one thing the unit tests above structurally cannot see: they prove
  // the rule, not that `raiseChargebackForReversedOrder` obeys it. Reverting that function to
  // `decimalToNumber(order.discountAmount)` would leave every test above green while restoring the
  // over-reversal, and the alternative — driving a 'use server' action through a mocked db, auth,
  // settings and the whole refund service — tests the plumbing rather than the rule.
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const src = readFileSync(join(process.cwd(), 'app/actions/sales.ts'), 'utf8')
  const chargeback = src.slice(src.indexOf('export async function raiseChargebackForReversedOrder'))
  const body = chargeback.slice(0, chargeback.indexOf('\nexport async function '))

  assert.match(body, /resolvePostedOrderDiscount\(/, 'the posted figure is resolved')
  assert.match(body, /discountRestatement: order\.discountRestatement/, 'from the restatement record')
  assert.match(body, /decideChargebackOrderDiscount\(/, 'and the mirror/manual rule is applied to it')
  assert.match(body, /discountDecision\.action === 'MANUAL'/, 'and a MANUAL decision returns without raising')
  assert.match(
    body,
    /const mirroredDiscount = discountDecision\.amount/,
    'and the amount that reaches buildChargebackRefundLines comes from the decision',
  )
  assert.doesNotMatch(
    body.slice(body.indexOf('const mirroredDiscount')),
    /decimalToNumber\(order\.discountAmount\)/,
    'the live column must not be what the credit note mirrors',
  )
})

// ---------------------------------------------------------------------------
// o3d-y14 r8 findings 1 and 2 — what the recovered figure does NOT establish
// ---------------------------------------------------------------------------

/**
 * The figure this function recovers answers the RESOLVER's question: a mirroring credit note
 * reverses it whichever posted document it reverses. Two things a NETTING caller needs are not the
 * same question, and neither was reported at all before r8 — so both now travel with the amount.
 */
test('the recovered figure reports HOW MANY documents agreed on it (o3d-y14 r8 F2)', async () => {
  const { client } = makeClient({
    events: [postedInvoice(), postedInvoice({ externalId: 'INV-779', createdAt: '2026-05-03T09:00:00.000Z' })],
  })

  const read = await readPostedInvoiceOrderDiscount(client, { id: 'order-1', currency: 'GBP' })

  assert.equal(read.ok, true)
  assert.equal(read.ok && read.amount, 10, 'agreement still resolves the amount, exactly as before')
  assert.equal(read.ok && read.documentCount, 2, 'and it no longer implies there is only one of them')
})

test('one posted document reports a count of one — the pair differs on the count alone', async () => {
  const { client } = makeClient({ events: [postedInvoice()] })

  const read = await readPostedInvoiceOrderDiscount(client, { id: 'order-1', currency: 'GBP' })

  assert.equal(read.ok, true)
  assert.equal(read.ok && read.documentCount, 1)
})

test('the recovered figure reports the TAX BASIS it is denominated in (o3d-y14 r8 F1)', async () => {
  const inclusive = makeClient({
    events: [
      postedInvoice({
        linesJson: documentPayload({
          lineAmountMode: 'INCLUSIVE',
          lineAmountsIncludeTax: true,
          discount: { amount: 10, accountCode: '260' },
        }),
      }),
    ],
  })
  const exclusive = makeClient({ events: [postedInvoice()] })

  const gross = await readPostedInvoiceOrderDiscount(inclusive.client, { id: 'order-1', currency: 'GBP' })
  const net = await readPostedInvoiceOrderDiscount(exclusive.client, { id: 'order-1', currency: 'GBP' })

  assert.equal(gross.ok && gross.taxBasis, 'INCLUSIVE')
  assert.equal(net.ok && net.taxBasis, 'EXCLUSIVE')
  // The two carry the SAME amount and mean different things by it — which is the finding.
  assert.equal(gross.ok && gross.amount, net.ok && net.amount)
})

test('a payload stating neither tax field reports UNKNOWN, never EXCLUSIVE (o3d-y14 r8 F1)', () => {
  const bare = documentPayload({ discount: { amount: 10, accountCode: '260' } }) as Record<string, unknown>
  delete bare.lineAmountsIncludeTax
  delete bare.lineAmountMode

  const read = readPostedDocumentDiscount({ currency: 'GBP', externalSystem: 'xero', linesJson: bare }, 'GBP')

  assert.equal(read.ok, true)
  assert.equal(read.ok && read.taxBasis, 'UNKNOWN')
})

test('documents whose bases disagree report MIXED (o3d-y14 r8 F1)', async () => {
  const { client } = makeClient({
    events: [
      postedInvoice(),
      postedInvoice({
        externalId: 'INV-779',
        createdAt: '2026-05-03T09:00:00.000Z',
        linesJson: documentPayload({
          lineAmountMode: 'INCLUSIVE',
          lineAmountsIncludeTax: true,
          discount: { amount: 10, accountCode: '260' },
        }),
      }),
    ],
  })

  const read = await readPostedInvoiceOrderDiscount(client, { id: 'order-1', currency: 'GBP' })

  assert.equal(read.ok, true)
  assert.equal(read.ok && read.taxBasis, 'MIXED')
})

test('a document that carries NO discount still reports its basis — 0 is a figure with a unit', () => {
  const read = readPostedDocumentDiscount(
    {
      currency: 'GBP',
      externalSystem: 'xero',
      linesJson: documentPayload({ lineAmountsIncludeTax: true, lineAmountMode: 'INCLUSIVE' }),
    },
    'GBP',
  )

  assert.deepEqual(read, { ok: true, amount: 0, taxBasis: 'INCLUSIVE' })
})
