import assert from 'node:assert/strict'
import test from 'node:test'

import { buildChargebackRefundLines } from '@/lib/domain/sales/refund-service'
import {
  decideChargebackOrderDiscount,
  readPostedDocumentDiscount,
  resolvePostedOrderDiscount,
  type PostedOrderDiscountClient,
} from '@/lib/domain/accounting/posted-order-discount'

/**
 * o3d-y14 r3 finding 1 — A CHARGEBACK MUST REVERSE THE DOCUMENT, NOT THE ORDER.
 *
 * The shape of the defect, on a legacy WooCommerce order the o3d-y14 backfill corrects:
 *
 *     invoice posted   goods 100 (lines already net of the coupon) − order discount 10  = 90
 *     backfill runs    SalesOrder.discountAmount 10 -> 0, discountModel stamped
 *     payment reversed → chargeback builds its credit note from the LIVE column
 *     credit note      goods 100 − order discount 0                                     = 100
 *                      ^ 10 more AR and revenue reversed than the invoice ever raised
 *
 * Nothing about that is a race, so no freshness check fixes it: after the correction the column is
 * PERMANENTLY not what the invoice said, and a drift check would report the same drift on every
 * corrected order forever. The fix is to read the right source — and, where the right source and the
 * order disagree, to refuse rather than pick one.
 *
 * The doubles below honour their filters. A `findFirst` that returned its fixture regardless of
 * `where` could not tell "the posted document" from "any mirrored event", which is most of what
 * these cases assert; one that ignored `orderBy` could not tell an original invoice from the update
 * that superseded it.
 */

type EventRow = {
  sourceEntityType: string
  sourceEntityId: string
  type: string
  status: string
  currency: string
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

type Calls = { findFirst: number; count: number }

function makeClient(
  store: { events?: EventRow[]; syncLogs?: SyncLogRow[] } = {},
): { client: PostedOrderDiscountClient; calls: Calls } {
  const events = store.events ?? []
  const syncLogs = store.syncLogs ?? []
  const calls: Calls = { findFirst: 0, count: 0 }

  const client = {
    accountingEvent: {
      findFirst: async ({
        where,
        orderBy,
      }: {
        where: { sourceEntityType: string; sourceEntityId: string; type: { in: string[] }; status: string }
        orderBy: Array<Record<string, 'desc' | 'asc'>>
      }) => {
        calls.findFirst += 1
        const matched = events.filter(
          (event) =>
            event.sourceEntityType === where.sourceEntityType &&
            event.sourceEntityId === where.sourceEntityId &&
            where.type.in.includes(event.type) &&
            event.status === where.status,
        )
        // Honours the ORDER the production code asks for, so "the latest posted document wins" is a
        // property of the code rather than of the fixture's array order.
        const sorted = [...matched].sort((a, b) => {
          for (const clause of orderBy) {
            const [field, direction] = Object.entries(clause)[0] as ['businessDate' | 'createdAt', 'desc' | 'asc']
            if (a[field] === b[field]) continue
            const compare = a[field] < b[field] ? -1 : 1
            return direction === 'desc' ? -compare : compare
          }
          return 0
        })
        return (sorted[0] ?? null) as never
      },
    },
    accountingSyncLog: {
      count: async ({
        where,
      }: {
        where: {
          referenceType: string
          referenceId: string
          type: { in: string[] }
          status: { in: string[] }
          externalTransactionId: { not: null }
        }
      }) => {
        calls.count += 1
        return syncLogs.filter(
          (log) =>
            log.referenceType === where.referenceType &&
            log.referenceId === where.referenceId &&
            where.type.in.includes(log.type) &&
            where.status.in.includes(log.status) &&
            (!('externalTransactionId' in where) || !!log.externalTransactionId),
        ).length
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
    externalId: 'INV-778',
    businessDate: '2026-05-02',
    createdAt: '2026-05-02T09:00:00.000Z',
    linesJson: documentPayload({ discount: { amount: 10, accountCode: '260' } }),
    ...over,
  }
}

const STAMPED_ORDER = {
  id: 'order-1',
  currency: 'GBP',
  // The corrected state: the backfill cleared the duplicated coupon and stamped the row.
  discountAmount: 0,
  discountModel: 'LINE_ALLOCATED',
  accountingInvoiceId: 'INV-778' as string | null,
}

// ---------------------------------------------------------------------------
// Which orders are consulted at all
// ---------------------------------------------------------------------------

test('an UNSTAMPED order reads its own column and never queries the ledger (o3d-y14 r3 F1)', async () => {
  // The gate that keeps this change off every native, manual and pre-column order: the backfill
  // writes the amount and the stamp in ONE update, so an unstamped row is one it never touched.
  // Without this, a chargeback on any order would depend on the accounting-event mirror existing.
  const { client, calls } = makeClient({ events: [postedInvoice()] })

  const resolved = await resolvePostedOrderDiscount(client, {
    id: 'order-1',
    currency: 'GBP',
    discountAmount: 12.5,
    discountModel: null,
    accountingInvoiceId: 'INV-778',
  })

  assert.equal(resolved.source, 'ORDER')
  assert.equal(resolved.source === 'ORDER' && resolved.amount, 12.5)
  assert.deepEqual(calls, { findFirst: 0, count: 0 }, 'no ledger lookup happens for an unstamped order')
})

// ---------------------------------------------------------------------------
// Recovering the posted figure
// ---------------------------------------------------------------------------

test('a corrected legacy order recovers what the INVOICE charged, not what it now carries (o3d-y14 r3 F1)', async () => {
  const { client } = makeClient({ events: [postedInvoice()] })

  const resolved = await resolvePostedOrderDiscount(client, STAMPED_ORDER)

  assert.equal(resolved.source, 'POSTED_DOCUMENT')
  assert.equal(resolved.source === 'POSTED_DOCUMENT' && resolved.amount, 10)
  assert.equal(resolved.source === 'POSTED_DOCUMENT' && resolved.externalId, 'INV-778')
})

test('a document that posted NO discount leg is 0, which is an answer and not a failure', async () => {
  // Without this case, "returns 0" would be indistinguishable from "could not read it", and every
  // ordinary stamped order (the fixed importer stamps too) would refuse its chargeback.
  const { client } = makeClient({ events: [postedInvoice({ linesJson: documentPayload() })] })

  const resolved = await resolvePostedOrderDiscount(client, { ...STAMPED_ORDER, discountAmount: 0 })

  assert.equal(resolved.source, 'POSTED_DOCUMENT')
  assert.equal(resolved.source === 'POSTED_DOCUMENT' && resolved.amount, 0)
})

test('the LATEST posted document wins, so an update supersedes the invoice it replaced', async () => {
  // A SALES_INVOICE_UPDATE pushed after a correction carries the corrected figure and is what the
  // ledger now holds. Mirroring the original invoice there would reverse a superseded document.
  const { client } = makeClient({
    events: [
      postedInvoice(),
      postedInvoice({
        type: 'SALES_INVOICE_UPDATE',
        externalId: 'INV-778',
        businessDate: '2026-06-01',
        createdAt: '2026-06-01T09:00:00.000Z',
        linesJson: documentPayload({ documentType: 'SALES_INVOICE_UPDATE', discount: { amount: 3 } }),
      }),
    ],
  })

  const resolved = await resolvePostedOrderDiscount(client, { ...STAMPED_ORDER, discountAmount: 3 })

  assert.equal(resolved.source === 'POSTED_DOCUMENT' && resolved.amount, 3)
  assert.equal(resolved.source === 'POSTED_DOCUMENT' && resolved.documentType, 'SALES_INVOICE_UPDATE')
})

test('an event that has NOT posted is not evidence of what the ledger holds', async () => {
  // PENDING means queued, FAILED means it never landed. Reading either would attribute to the
  // ledger a figure no document carries — and the order here also has no invoice link, so the
  // correct answer is the order's own column.
  const { client } = makeClient({
    events: [
      postedInvoice({ status: 'PENDING', linesJson: documentPayload({ discount: { amount: 99 } }) }),
      postedInvoice({ status: 'FAILED', linesJson: documentPayload({ discount: { amount: 77 } }) }),
    ],
  })

  const resolved = await resolvePostedOrderDiscount(client, {
    ...STAMPED_ORDER,
    discountAmount: 4,
    accountingInvoiceId: null,
  })

  assert.equal(resolved.source, 'ORDER')
  assert.equal(resolved.source === 'ORDER' && resolved.amount, 4)
})

test("another order's posted invoice is never read for this one", async () => {
  const { client } = makeClient({ events: [postedInvoice({ sourceEntityId: 'order-2' })] })

  const resolved = await resolvePostedOrderDiscount(client, {
    ...STAMPED_ORDER,
    discountAmount: 6,
    accountingInvoiceId: null,
  })

  assert.equal(resolved.source, 'ORDER')
  assert.equal(resolved.source === 'ORDER' && resolved.amount, 6)
})

// ---------------------------------------------------------------------------
// When it cannot be recovered
// ---------------------------------------------------------------------------

test('a linked invoice with no posted event is UNRECOVERABLE, never assumed to be the column', async () => {
  const { client } = makeClient()

  const resolved = await resolvePostedOrderDiscount(client, STAMPED_ORDER)

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

  const resolved = await resolvePostedOrderDiscount(client, { ...STAMPED_ORDER, accountingInvoiceId: null })

  assert.equal(resolved.source, 'UNRECOVERABLE')
  assert.match(resolved.detail, /no accountingInvoiceId/)
})

test('a SYNCED row with NO external id is not a posted document, so the column stands', async () => {
  // The other side of the same predicate. Without it, the case above would pass on a check that
  // refused whenever any SYNCED row existed — which would strand every ordinary stamped order.
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
    ...STAMPED_ORDER,
    discountAmount: 5,
    accountingInvoiceId: null,
  })

  assert.equal(resolved.source, 'ORDER')
  assert.equal(resolved.source === 'ORDER' && resolved.amount, 5)
})

test('a stamped order with nothing posted at all reads its own column', async () => {
  const { client } = makeClient()

  const resolved = await resolvePostedOrderDiscount(client, {
    ...STAMPED_ORDER,
    discountAmount: 7,
    accountingInvoiceId: null,
  })

  assert.equal(resolved.source, 'ORDER')
  assert.equal(resolved.source === 'ORDER' && resolved.amount, 7)
})

// ---------------------------------------------------------------------------
// Reading one payload
// ---------------------------------------------------------------------------

test('a foreign-currency document is refused rather than read as a bare number', async () => {
  const read = readPostedDocumentDiscount(
    { currency: 'EUR', linesJson: documentPayload({ currency: 'EUR', discount: { amount: 10 } }) },
    'GBP',
  )

  assert.equal(read.ok, false)
  assert.match(!read.ok ? read.detail : '', /EUR/)
})

test('a payload that is not a document payload is refused, not read as zero', () => {
  for (const linesJson of [null, 'not-json', [], { kind: 'journal', lines: [] }]) {
    const read = readPostedDocumentDiscount({ currency: 'GBP', linesJson }, 'GBP')
    assert.equal(read.ok, false, `${JSON.stringify(linesJson)} must not read as a discount of 0`)
  }
})

test('an unusable discount amount is refused, not coerced', () => {
  for (const amount of [-1, Number.NaN, Number.POSITIVE_INFINITY, '10', null]) {
    const read = readPostedDocumentDiscount(
      { currency: 'GBP', linesJson: documentPayload({ discount: { amount } }) },
      'GBP',
    )
    assert.equal(read.ok, false, `${String(amount)} must not be accepted as a posted discount`)
  }
})

// ---------------------------------------------------------------------------
// What the chargeback does with it
// ---------------------------------------------------------------------------

test('a corrected legacy order does NOT auto-raise a credit note, and the refusal names both figures (o3d-y14 r3 F1)', async () => {
  const { client } = makeClient({ events: [postedInvoice()] })
  const posted = await resolvePostedOrderDiscount(client, STAMPED_ORDER)

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
  const posted = await resolvePostedOrderDiscount(client, { ...STAMPED_ORDER, discountAmount: 10 })

  const decision = decideChargebackOrderDiscount({ posted, orderDiscountAmount: 10 })

  assert.equal(decision.action, 'MIRROR')
  assert.equal(decision.action === 'MIRROR' && decision.amount, 10)
})

test('an unstamped order with a discount is auto-raised from its own column (control)', async () => {
  const { client } = makeClient()
  const posted = await resolvePostedOrderDiscount(client, {
    id: 'order-1',
    currency: 'GBP',
    discountAmount: 15,
    discountModel: null,
    accountingInvoiceId: 'INV-778',
  })

  const decision = decideChargebackOrderDiscount({ posted, orderDiscountAmount: 15 })

  assert.equal(decision.action, 'MIRROR')
  assert.equal(decision.action === 'MIRROR' && decision.amount, 15)
})

test('an unrecoverable posted figure goes to manual handling, not to a guessed zero', async () => {
  const { client } = makeClient()
  const posted = await resolvePostedOrderDiscount(client, STAMPED_ORDER)

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
