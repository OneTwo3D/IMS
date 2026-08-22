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
  /**
   * The primary key (o3d-y14 r13 finding 2). REQUIRED, because the posted read is ordered by it as
   * a last resort and a fixture without one would let a clause this double cannot honour look
   * honoured — the ordering would test as total while no fixture ever exercised the tie.
   */
  id: string
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
            const [field, direction] = Object.entries(clause)[0] as [keyof EventRow, 'desc' | 'asc']
            // r13 finding 2. A clause this double cannot honour must fail LOUDLY: silently skipping
            // one would make the ordering look total while the tie-break was never applied at all,
            // which is precisely the state the finding is about.
            if (!(field in a) || !(field in b)) {
              throw new Error(`the double has no ${String(field)} column to order by`)
            }
            const left = a[field] as string
            const right = b[field] as string
            if (left === right) continue
            const compare = left < right ? -1 : 1
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
  const row = {
    id: '',
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
  // r13 finding 2. DISTINCT by default, derived from what distinguishes the fixture, because
  // `AccountingEvent.id` is a primary key: two fixture rows sharing one would model a state the
  // database cannot hold, and would hide the very tie-break the ordering now depends on. Two rows
  // that differ in NOTHING — the o3d-9kek pair, no external id, mirrored at the same instant — do
  // collide, which is the residual the derivation's own header states rather than rounds away.
  return { ...row, id: row.id || `evt-${row.type}-${row.externalId ?? row.createdAt}` }
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

test('the recovered figure names EVERY posted document, not the newest (o3d-y14 r10 F2)', async () => {
  // `externalId` is the NEWEST document's, and naming it is right for a REFUSAL, which prescribes
  // nothing. It is not right for anything an operator is told to go and do: with two agreeing
  // documents the duplicate is held twice, and an instruction naming one leaves the other standing.
  const { client } = makeClient({
    events: [postedInvoice(), postedInvoice({ externalId: 'INV-779', createdAt: '2026-05-03T09:00:00.000Z' })],
  })

  const read = await readPostedInvoiceOrderDiscount(client, { id: 'order-1', currency: 'GBP' })

  assert.deepEqual(read.ok && read.externalIds, ['INV-779', 'INV-778'], 'newest first, and BOTH of them')
  assert.equal(read.ok && read.externalId, 'INV-779', 'the presentational newest is unchanged')
})

test('a posted document with NO external id is counted but not named (o3d-y14 r10 F2)', async () => {
  // The id write-back can fail after the post succeeds (o3d-9kek). `documentCount` minus the ids is
  // the number of documents that exist and cannot be named — a fact the caller has to state rather
  // than round away.
  const { client } = makeClient({
    events: [postedInvoice(), postedInvoice({ externalId: null, createdAt: '2026-05-01T09:00:00.000Z' })],
  })

  const read = await readPostedInvoiceOrderDiscount(client, { id: 'order-1', currency: 'GBP' })

  assert.equal(read.ok && read.documentCount, 2)
  assert.deepEqual(read.ok && read.externalIds, ['INV-778'])
})

test('one posted document reports a count of one — the pair differs on the count alone', async () => {
  const { client } = makeClient({ events: [postedInvoice()] })

  const read = await readPostedInvoiceOrderDiscount(client, { id: 'order-1', currency: 'GBP' })

  assert.equal(read.ok, true)
  assert.equal(read.ok && read.documentCount, 1)
  assert.deepEqual(read.ok && read.externalIds, ['INV-778'])
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

// ---------------------------------------------------------------------------
// o3d-y14 r11 finding 3 — a refusal about SEVERAL documents has to name them
// ---------------------------------------------------------------------------

/**
 * r10 made the SUCCESS variant's reference plural, on the argument that a REFUSAL prescribes nothing
 * so naming the newest document was harmless. That argument does not survive the disagreeing case:
 * the whole of what an operator can do with "2 posted documents carry different order-level
 * discounts" is open them, and the refusal told them how many there were and not which.
 */

test('a refusal because posted documents DISAGREE names every one of them (o3d-y14 r11 F3)', async () => {
  // The NEWEST document carries the LARGER discount, so the amounts arrive in descending order —
  // which is what makes the sorted refusal message below a property rather than a coincidence.
  const { client } = makeClient({
    events: [
      postedInvoice({
        externalId: 'INV-A',
        linesJson: documentPayload({ discount: { amount: 3, accountCode: '260' } }),
      }),
      postedInvoice({ externalId: 'INV-B', businessDate: '2026-05-03', createdAt: '2026-05-03T09:00:00.000Z' }),
    ],
  })

  const read = await readPostedInvoiceOrderDiscount(client, { id: 'order-1', currency: 'GBP' })

  assert.equal(read.ok, false)
  assert.equal(!read.ok && read.reason, 'UNRECOVERABLE')
  assert.deepEqual(
    !read.ok && read.reason === 'UNRECOVERABLE' ? read.externalIds : null,
    ['INV-B', 'INV-A'],
    'newest first, and BOTH of them — the count alone is not actionable',
  )
  const detail = !read.ok && read.reason === 'UNRECOVERABLE' ? read.detail : ''
  assert.match(detail, /INV-B, INV-A/, 'and the message itself names them')
  assert.match(detail, /2 posted documents exist for this order/)
  // The amounts are sorted, so the same rows read twice produce the same sentence. The r11 F1
  // re-validation compares these refusals as values; a message in row order would report a ledger
  // that "moved" whenever the query came back the other way round.
  assert.match(detail, /\(3, 10 GBP\)/)
})

test('a disagreeing document with NO external id is counted, not silently dropped (o3d-y14 r11 F3)', async () => {
  // The write-back can fail after the post succeeds (o3d-9kek). "2 documents, 1 of which cannot be
  // named" is the fact; naming one of two and saying nothing about the other is the r10 defect
  // reintroduced on the refusal side.
  const { client } = makeClient({
    events: [
      postedInvoice({ externalId: 'INV-A' }),
      postedInvoice({
        externalId: null,
        businessDate: '2026-05-03',
        createdAt: '2026-05-03T09:00:00.000Z',
        linesJson: documentPayload({ discount: { amount: 3, accountCode: '260' } }),
      }),
    ],
  })

  const read = await readPostedInvoiceOrderDiscount(client, { id: 'order-1', currency: 'GBP' })

  assert.equal(!read.ok && read.reason === 'UNRECOVERABLE' && read.documentCount, 2)
  assert.deepEqual(!read.ok && read.reason === 'UNRECOVERABLE' ? read.externalIds : null, ['INV-A'])
  assert.match(
    !read.ok && read.reason === 'UNRECOVERABLE' ? read.detail : '',
    /INV-A, and 1 that record NO external id and cannot be named from here/,
  )
})

test('a refusal that established NO document set reports no ids at all (o3d-y14 r11 F3)', async () => {
  // The pair. `externalIds` is absent, not empty-because-there-are-none: an unsettled invoice UPDATE
  // refuses without ever establishing which documents the refusal is about, and a caller that read
  // [] as "no documents exist" would print a reference to nothing.
  const { client } = makeClient({
    events: [
      postedInvoice(),
      postedInvoice({ type: 'SALES_INVOICE_UPDATE', status: 'PENDING', externalId: null }),
    ],
  })

  const read = await readPostedInvoiceOrderDiscount(client, { id: 'order-1', currency: 'GBP' })

  assert.equal(!read.ok && read.reason, 'UNRECOVERABLE')
  assert.equal(!read.ok && read.reason === 'UNRECOVERABLE' && read.externalIds, undefined)
  assert.equal(!read.ok && read.reason === 'UNRECOVERABLE' && read.documentCount, undefined)
})

// ---------------------------------------------------------------------------
// o3d-y14 r12 finding 1 — a refusal has to fingerprint the rows it happened over
// ---------------------------------------------------------------------------

/**
 * r11 finding 1 made the backfill's re-validation compare the invoice position as a VALUE, refusal
 * text included, and r11 removed one source of non-determinism from that text so the comparison
 * could mean something. This is the other half.
 *
 * A REFUSAL DESCRIBES A FAILURE, NOT THE ROWS IT FAILED OVER. Every fixture pair below is two
 * DIFFERENT document sets that produce the SAME refusal, byte for byte, with the same
 * `documentCount` and the same `externalIds` — so a comparison over what the refusal SAYS sees a
 * ledger that never moved, and leaves a live instruction standing against documents that are gone.
 * Each pair is asserted to be identical in all of that and to differ ONLY in `documentSet`, which is
 * what makes it a test of the fingerprint rather than of some other field that came along with it.
 */

/** A POSTED event whose payload is not an accounting document at all. */
function unreadableInvoice(over: Partial<EventRow> = {}): EventRow {
  return postedInvoice({ linesJson: { kind: 'something-else' }, ...over })
}

function refusalFacts(read: Awaited<ReturnType<typeof readPostedInvoiceOrderDiscount>>) {
  return {
    reason: read.ok ? 'ok' : read.reason,
    detail: !read.ok && read.reason === 'UNRECOVERABLE' ? read.detail : null,
    documentCount: !read.ok && read.reason === 'UNRECOVERABLE' ? read.documentCount : undefined,
    externalIds: !read.ok && read.reason === 'UNRECOVERABLE' ? read.externalIds : undefined,
  }
}

function documentSetOf(read: Awaited<ReturnType<typeof readPostedInvoiceOrderDiscount>>): string[] {
  return read.ok ? read.documentSet : read.documentSet
}

test('an UNSETTLED-UPDATE refusal fingerprints the posted documents it never read (o3d-y14 r12 F1)', async () => {
  // The worst of them: this branch returns BEFORE the posted documents are consulted, so its
  // sentence is a count of unsettled updates and nothing else. The whole posted set can be replaced
  // underneath it — here a second invoice is raised for the order, which is r10 finding 2's defect
  // arriving through r7 finding 2's window — and every field the re-validation compares is equal.
  const update = postedInvoice({ type: 'SALES_INVOICE_UPDATE', status: 'PENDING', externalId: null })
  const before = makeClient({ events: [postedInvoice(), update] })
  const after = makeClient({
    events: [
      postedInvoice(),
      postedInvoice({ externalId: 'INV-779', businessDate: '2026-05-03', createdAt: '2026-05-03T09:00:00.000Z' }),
      update,
    ],
  })

  const first = await readPostedInvoiceOrderDiscount(before.client, { id: 'order-1', currency: 'GBP' })
  const second = await readPostedInvoiceOrderDiscount(after.client, { id: 'order-1', currency: 'GBP' })

  assert.deepEqual(refusalFacts(first), refusalFacts(second), 'the refusal itself is word-for-word the same')
  assert.notDeepEqual(documentSetOf(first), documentSetOf(second), 'and the ledger it is about is not')
  assert.equal(documentSetOf(first).length, 2, 'one posted document and the unsettled update')
  assert.equal(documentSetOf(second).length, 3)
  assert.ok(
    documentSetOf(second).some((entry) => entry.includes('INV-779')),
    'the document that appeared is named, so a withdrawal can say what moved',
  )
})

test('an UNSETTLED-UPDATE refusal fingerprints the updates themselves too (o3d-y14 r12 F1)', async () => {
  // The count is what the sentence states, so one update settling to VOID while another arrives
  // leaves it identical — while an update is now in flight against the document the operator is
  // being sent to read.
  const before = makeClient({
    events: [
      postedInvoice(),
      postedInvoice({ type: 'SALES_INVOICE_UPDATE', status: 'PENDING', externalId: 'UPD-1' }),
    ],
  })
  const after = makeClient({
    events: [
      postedInvoice(),
      postedInvoice({ type: 'SALES_INVOICE_UPDATE', status: 'VOID', externalId: 'UPD-1' }),
      postedInvoice({ type: 'SALES_INVOICE_UPDATE', status: 'PENDING', externalId: 'UPD-2' }),
    ],
  })

  const first = await readPostedInvoiceOrderDiscount(before.client, { id: 'order-1', currency: 'GBP' })
  const second = await readPostedInvoiceOrderDiscount(after.client, { id: 'order-1', currency: 'GBP' })

  assert.deepEqual(refusalFacts(first), refusalFacts(second), 'still "1 SALES_INVOICE_UPDATE event(s)"')
  assert.notDeepEqual(documentSetOf(first), documentSetOf(second))
  assert.ok(documentSetOf(second).some((entry) => entry.includes('UPD-2')))
  // VOID is a SETTLED status, so the retired update is not in the set at all — the fingerprint is
  // the rows the derivation consulted, not every row that exists.
  assert.equal(documentSetOf(second).some((entry) => entry.includes('UPD-1')), false)
})

test('an UNREADABLE-payload refusal fingerprints WHICH document it was (o3d-y14 r12 F1)', async () => {
  // That sentence names a TYPE and a reason. The same one covers INV-778 today and the invoice that
  // replaced it after a void-and-re-raise tomorrow — a movement that leaves the remedy naming a
  // document the ledger no longer holds.
  const before = makeClient({ events: [unreadableInvoice({ externalId: 'INV-778' })] })
  const after = makeClient({ events: [unreadableInvoice({ externalId: 'INV-900' })] })

  const first = await readPostedInvoiceOrderDiscount(before.client, { id: 'order-1', currency: 'GBP' })
  const second = await readPostedInvoiceOrderDiscount(after.client, { id: 'order-1', currency: 'GBP' })

  assert.match(
    refusalFacts(first).detail ?? '',
    /a SALES_INVOICE was posted for this order but the mirrored event does not carry a document payload/,
  )
  assert.deepEqual(refusalFacts(first), refusalFacts(second))
  assert.notDeepEqual(documentSetOf(first), documentSetOf(second))
  assert.deepEqual(documentSetOf(second), [
    'POSTED SALES_INVOICE xero/INV-900 mirrored 2026-05-02T09:00:00.000Z GBP UNREADABLE: the mirrored ' +
      'event does not carry a document payload',
  ])
})

test('EVERY posted document is read, so a change behind the first failure moves the set (r12 F1)', async () => {
  // The loop used to RETURN on the first unreadable document, so nothing after it was ever looked
  // at. Here the newest document is unreadable in both worlds — it is what the refusal names — and
  // the one behind it fails for a DIFFERENT reason in each. Same sentence, same ids, same count.
  const newest = { externalId: 'INV-A', businessDate: '2026-05-03', createdAt: '2026-05-03T09:00:00.000Z' }
  const before = makeClient({
    events: [
      unreadableInvoice(newest),
      postedInvoice({ externalId: 'INV-B', linesJson: documentPayload({ currency: 'USD', discount: { amount: 10, accountCode: '260' } }) }),
    ],
  })
  const after = makeClient({
    events: [
      unreadableInvoice(newest),
      postedInvoice({ externalId: 'INV-B', linesJson: documentPayload({ discount: { amount: 'ten', accountCode: '260' } }) }),
    ],
  })

  const first = await readPostedInvoiceOrderDiscount(before.client, { id: 'order-1', currency: 'GBP' })
  const second = await readPostedInvoiceOrderDiscount(after.client, { id: 'order-1', currency: 'GBP' })

  assert.deepEqual(refusalFacts(first), refusalFacts(second), 'the refusal still names INV-A and its reason')
  assert.notDeepEqual(documentSetOf(first), documentSetOf(second))
  assert.ok(documentSetOf(first).some((entry) => entry.includes('the posted document is in USD but the order is in GBP')))
  assert.ok(documentSetOf(second).some((entry) => entry.includes('is not a usable number')))
})

test('a SUCCESSFUL read fingerprints its documents too — agreement is not identity (o3d-y14 r12 F1)', async () => {
  // The success variant's hole. Two POSTED documents that never recorded an external id (o3d-9kek)
  // agree on the amount, the count, the ledger, the basis and the (empty) id list, so replacing one
  // of them with another moves nothing the r11 comparison looks at.
  const before = makeClient({
    events: [
      postedInvoice({ externalId: null }),
      postedInvoice({ externalId: null, businessDate: '2026-05-01', createdAt: '2026-05-01T09:00:00.000Z' }),
    ],
  })
  const after = makeClient({
    events: [
      postedInvoice({ externalId: null }),
      postedInvoice({ externalId: null, businessDate: '2026-06-01', createdAt: '2026-06-01T09:00:00.000Z' }),
    ],
  })

  const first = await readPostedInvoiceOrderDiscount(before.client, { id: 'order-1', currency: 'GBP' })
  const second = await readPostedInvoiceOrderDiscount(after.client, { id: 'order-1', currency: 'GBP' })

  assert.equal(first.ok && second.ok, true)
  assert.equal(first.ok && first.amount, second.ok && second.amount)
  assert.equal(first.ok && first.documentCount, second.ok && second.documentCount)
  assert.deepEqual(first.ok ? first.externalIds : null, second.ok ? second.externalIds : null)
  assert.equal(first.ok && first.taxBasis, second.ok && second.taxBasis)
  assert.notDeepEqual(documentSetOf(first), documentSetOf(second), 'and the documents are different documents')
})

test('the fingerprint is SORTED, not in row order — and the row order is now fixed (r12 F1, r13 F2)', async () => {
  // r12's version of this asserted that two TIED documents come back either way round and
  // fingerprint the same. r13 finding 2 removed the premise rather than the property: the read is
  // ordered by the primary key as a last resort, so a tie decides nothing and the SAME rows present
  // identically however the store holds them. Both halves are asserted, because a fingerprint that
  // merely inherited row order would now look correct for the wrong reason.
  const tied = { businessDate: '2026-05-02', createdAt: '2026-05-02T09:00:00.000Z' }
  const oneWay = makeClient({
    events: [postedInvoice({ ...tied, externalId: 'INV-A' }), postedInvoice({ ...tied, externalId: 'INV-B' })],
  })
  const otherWay = makeClient({
    events: [postedInvoice({ ...tied, externalId: 'INV-B' }), postedInvoice({ ...tied, externalId: 'INV-A' })],
  })

  const first = await readPostedInvoiceOrderDiscount(oneWay.client, { id: 'order-1', currency: 'GBP' })
  const second = await readPostedInvoiceOrderDiscount(otherWay.client, { id: 'order-1', currency: 'GBP' })

  // r13 finding 2: the presentation no longer depends on which way the store held them.
  assert.deepEqual(
    first.ok ? first.externalIds : null,
    second.ok ? second.externalIds : null,
    'a tie on businessDate and createdAt no longer decides which document is named',
  )
  assert.deepEqual(documentSetOf(first), documentSetOf(second))
  // r12 finding 1: and the fingerprint is in SORTED order, which is NOT the presentational one —
  // otherwise "sorted" would be an untested word.
  assert.deepEqual(first.ok ? first.externalIds : null, ['INV-B', 'INV-A'], 'newest-first, id desc')
  assert.ok(
    documentSetOf(first)[0].includes('INV-A'),
    'the fingerprint does not inherit the row order it was built from',
  )
})

test('NO_POSTED_EVENT reports an EMPTY set, and it is empty because nothing was there (r12 F1)', async () => {
  // The pair for the branch that has nothing to fingerprint. It is carried rather than left absent
  // so no caller has to distinguish "no documents" from "the field does not exist on this variant".
  const { client } = makeClient({ events: [] })

  const read = await readPostedInvoiceOrderDiscount(client, { id: 'order-1', currency: 'GBP' })

  assert.equal(!read.ok && read.reason, 'NO_POSTED_EVENT')
  assert.deepEqual(documentSetOf(read), [])
})

test('every fingerprint entry is a SENTENCE, not a digest (o3d-y14 r12 F1)', async () => {
  // A withdrawal has to be able to say WHAT moved — an operator told only that "something changed"
  // learns to re-run rather than to look — so the entries are printed, and they name the connector,
  // the external id, when the event was mirrored and what this derivation read out of it.
  const { client } = makeClient({ events: [postedInvoice()] })

  const read = await readPostedInvoiceOrderDiscount(client, { id: 'order-1', currency: 'GBP' })

  assert.deepEqual(documentSetOf(read), [
    'POSTED SALES_INVOICE xero/INV-778 mirrored 2026-05-02T09:00:00.000Z GBP carries 10 GBP (EXCLUSIVE)',
  ])
})

test('a document that records NO connector or id still fingerprints as itself (o3d-y14 r12 F1)', async () => {
  // o3d-9kek and the un-replayable connector, in one row. Neither is a reason to drop it from the
  // set: an unnameable document is exactly the one nothing else in the position distinguishes.
  const { client } = makeClient({
    events: [postedInvoice({ externalSystem: null, externalId: null })],
  })

  const read = await readPostedInvoiceOrderDiscount(client, { id: 'order-1', currency: 'GBP' })

  assert.equal(!read.ok && read.reason, 'UNRECOVERABLE')
  assert.deepEqual(documentSetOf(read), [
    'POSTED SALES_INVOICE NO-SYSTEM/NO-EXTERNAL-ID mirrored 2026-05-02T09:00:00.000Z GBP UNREADABLE: ' +
      'the mirrored event names no connector whose posting rule can be replayed (externalSystem null), ' +
      'so whether the document carried the 10 it requested is unknown',
  ])
})

// ---------------------------------------------------------------------------
// o3d-y14 r13 finding 2 — a NON-TOTAL ordering manufactures a withdrawal
// ---------------------------------------------------------------------------

/**
 * `businessDate desc, createdAt desc` does not order two documents that tie on BOTH columns, and
 * Postgres is free to return them either way round on two reads of rows that never moved. That
 * ordering decides which document every refusal and every success NAMES — and since r11 finding 1
 * those names are part of a VALUE compared before a remedy is printed, so the swap presents as a
 * SPURIOUS WITHDRAWAL: exactly the noise this module argues teaches an operator to ignore the
 * withdrawal that matters.
 *
 * Each fixture below is ONE set of tied rows, read from two stores that differ only in the order
 * they hold them. Every assertion is `deepEqual` on what a withdrawal compares.
 */
const TIED = { businessDate: '2026-05-02', createdAt: '2026-05-02T09:00:00.000Z' }

test('two documents tied on businessDate AND createdAt name the same refusal (o3d-y14 r13 F2)', async () => {
  // The sharpest shape: both documents are unreadable, for DIFFERENT reasons, so the refusal's own
  // words are whichever one the ordering happened to put first.
  const a = () => unreadableInvoice({ ...TIED, externalId: 'INV-A' })
  const b = () =>
    postedInvoice({
      ...TIED,
      externalId: 'INV-B',
      linesJson: documentPayload({ currency: 'USD', discount: { amount: 10, accountCode: '260' } }),
    })
  const oneWay = makeClient({ events: [a(), b()] })
  const otherWay = makeClient({ events: [b(), a()] })

  const first = await readPostedInvoiceOrderDiscount(oneWay.client, { id: 'order-1', currency: 'GBP' })
  const second = await readPostedInvoiceOrderDiscount(otherWay.client, { id: 'order-1', currency: 'GBP' })

  assert.equal(!first.ok && first.reason, 'UNRECOVERABLE')
  assert.deepEqual(refusalFacts(first), refusalFacts(second), 'the refusal is the same refusal both ways')
  assert.deepEqual(documentSetOf(first), documentSetOf(second), 'over the same rows, said the same way')
})

test('two DISAGREEING documents tied on both columns name them in one order (o3d-y14 r13 F2)', async () => {
  // The refusal that lists its documents. Its ids are deliberately in ROW order — newest first, the
  // same order the success variant reports — so a tie put them in the sentence either way round,
  // and the compared `detail` and `externalIds` both moved while the ledger stood still.
  const a = () => postedInvoice({ ...TIED, externalId: 'INV-A' })
  const b = () =>
    postedInvoice({
      ...TIED,
      externalId: 'INV-B',
      linesJson: documentPayload({ discount: { amount: 3, accountCode: '260' } }),
    })
  const oneWay = makeClient({ events: [a(), b()] })
  const otherWay = makeClient({ events: [b(), a()] })

  const first = await readPostedInvoiceOrderDiscount(oneWay.client, { id: 'order-1', currency: 'GBP' })
  const second = await readPostedInvoiceOrderDiscount(otherWay.client, { id: 'order-1', currency: 'GBP' })

  assert.equal(!first.ok && first.reason === 'UNRECOVERABLE' && first.documentCount, 2)
  assert.deepEqual(refusalFacts(first), refusalFacts(second))
  assert.deepEqual(
    !first.ok && first.reason === 'UNRECOVERABLE' ? first.externalIds : null,
    ['INV-B', 'INV-A'],
    'and the one order they are named in is the total one',
  )
})

test('two AGREEING documents tied on both columns report the same document (o3d-y14 r13 F2)', async () => {
  // The success variant names the newest document's TYPE and CONNECTOR, and both travel in the
  // compared position. Two tied documents posted to different connectors — an order invoiced in
  // Xero and re-raised in QuickBooks, which `connector-orphans.ts` exists for — swapped which
  // ledger the whole handoff claimed to be about.
  const a = () => postedInvoice({ ...TIED, externalId: 'INV-A' })
  const b = () => postedInvoice({ ...TIED, externalId: 'INV-B', externalSystem: 'quickbooks' })
  const oneWay = makeClient({ events: [a(), b()] })
  const otherWay = makeClient({ events: [b(), a()] })

  const first = await readPostedInvoiceOrderDiscount(oneWay.client, { id: 'order-1', currency: 'GBP' })
  const second = await readPostedInvoiceOrderDiscount(otherWay.client, { id: 'order-1', currency: 'GBP' })

  assert.equal(first.ok && second.ok, true)
  assert.equal(first.ok && first.externalId, second.ok && second.externalId)
  assert.equal(first.ok && first.externalSystem, second.ok && second.externalSystem)
  assert.deepEqual(first.ok ? first.externalIds : null, second.ok ? second.externalIds : null)
  assert.equal(first.ok && first.detail, second.ok && second.detail)
})

// ---------------------------------------------------------------------------
// o3d-y14 r13 finding 1 — every refusal says HOW MANY posted documents it is about
// ---------------------------------------------------------------------------

test('an UNREADABLE-payload refusal carries the posted document set, not a disagreement (r13 F1)', async () => {
  // `documentCount` stays NULL — nothing here established that these documents disagree, and saying
  // so would be a false statement about the ledger — while `postedDocuments` says there are two of
  // them and names both, which is what stops a caller prescribing against "the document".
  const { client } = makeClient({
    events: [
      unreadableInvoice({ externalId: 'INV-A' }),
      unreadableInvoice({ externalId: 'INV-B', businessDate: '2026-05-01', createdAt: '2026-05-01T09:00:00.000Z' }),
    ],
  })

  const read = await readPostedInvoiceOrderDiscount(client, { id: 'order-1', currency: 'GBP' })

  assert.equal(!read.ok && read.reason, 'UNRECOVERABLE')
  assert.equal(!read.ok && read.reason === 'UNRECOVERABLE' && read.documentCount, undefined)
  assert.deepEqual(!read.ok && read.reason === 'UNRECOVERABLE' ? read.externalIds : 'set', undefined)
  assert.deepEqual(
    !read.ok && read.reason === 'UNRECOVERABLE' ? read.postedDocuments : null,
    { count: 2, externalIds: ['INV-A', 'INV-B'] },
  )
})

test('an UNSETTLED-UPDATE refusal counts the posted documents it never read (o3d-y14 r13 F1)', async () => {
  // The worst of them for this purpose: the refusal returns BEFORE the posted documents decide
  // anything, so nothing in its own words says whether the ledger holds one invoice or five.
  const { client } = makeClient({
    events: [
      postedInvoice({ externalId: 'INV-A' }),
      postedInvoice({ externalId: null, businessDate: '2026-05-01', createdAt: '2026-05-01T09:00:00.000Z' }),
      postedInvoice({ type: 'SALES_INVOICE_UPDATE', status: 'PENDING', externalId: 'UPD-1' }),
    ],
  })

  const read = await readPostedInvoiceOrderDiscount(client, { id: 'order-1', currency: 'GBP' })

  assert.match(!read.ok && read.reason === 'UNRECOVERABLE' ? read.detail : '', /never reached POSTED/)
  assert.deepEqual(
    !read.ok && read.reason === 'UNRECOVERABLE' ? read.postedDocuments : null,
    // Two posted documents, one of which recorded no external id (o3d-9kek): the count and the
    // names are separate facts, exactly as on the success variant.
    { count: 2, externalIds: ['INV-A'] },
  )
})

test('a DISAGREEMENT carries both the claim and the evidence, and they agree (o3d-y14 r13 F1)', async () => {
  // The one refusal where the two coincide. They are still two different statements — a renderer
  // that says "DISAGREEING" must read the claim — so this pins that the evidence is populated here
  // too, and that nothing had to be inferred from the claim's presence.
  const { client } = makeClient({
    events: [
      postedInvoice({ externalId: 'INV-A' }),
      postedInvoice({
        externalId: 'INV-B',
        businessDate: '2026-05-01',
        createdAt: '2026-05-01T09:00:00.000Z',
        linesJson: documentPayload({ discount: { amount: 3, accountCode: '260' } }),
      }),
    ],
  })

  const read = await readPostedInvoiceOrderDiscount(client, { id: 'order-1', currency: 'GBP' })

  assert.equal(!read.ok && read.reason === 'UNRECOVERABLE' && read.documentCount, 2)
  assert.deepEqual(
    !read.ok && read.reason === 'UNRECOVERABLE' ? read.postedDocuments : null,
    { count: 2, externalIds: ['INV-A', 'INV-B'] },
  )
})
