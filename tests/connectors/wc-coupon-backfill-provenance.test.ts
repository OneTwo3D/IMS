import assert from 'node:assert/strict'
import test from 'node:test'

import {
  WC_COUPON_DISCOUNT_MODEL,
  classifyWcCouponProvenance,
  decideWcCouponBackfill,
  type WcCouponBackfillRow,
} from '@/lib/connectors/woocommerce/sync/coupon-discount-backfill'

/**
 * o3d-9te. The o3d-y14 backfill subtracts the line discounts from the order-level slot. That is only
 * true arithmetic on a PRE-FIX row: on a row the fixed importer already wrote, the same subtraction
 * eats a residual that was correct on purpose, and the correction marker then hides it forever.
 *
 * So the whole safety of this backfill rests on one question — which importer wrote this amount — and
 * the answer must come from evidence about the WRITE, not from a field that merely correlates.
 * `SalesOrder.createdAt` correlates and then stops: the WooCommerce initial import BACKDATES it to
 * the historical Woo order date (importWcOrder's useWcDateAsCreatedAt), so an order imported after
 * the fix can sort before any deployment cutoff.
 */

const CUTOFF = new Date('2026-07-25T14:00:00.000Z')

/** A legacy row: coupon 10, all of it also on the lines, imported well before the fix. */
function row(over: Partial<WcCouponBackfillRow> = {}): WcCouponBackfillRow {
  return {
    orderId: 'order-1',
    orderNumber: 'WC-1001',
    externalOrderNumber: '1001',
    currency: 'GBP',
    storedOrderDiscount: 10,
    lineDiscountTotal: 10,
    accountingInvoiceId: null,
    postedInvoiceExternalIds: [],
    discountModel: null,
    importedAt: new Date('2026-05-01T00:00:00.000Z'),
    alreadyBackfilled: false,
    liveInvoiceJobs: 0,
    revenueDeferredBatchRef: null,
    refunds: { disposition: 'NONE', refundIds: [], postedCreditNoteExternalIds: [] },
    liveBatchDeferralJobs: 0,
    ...over,
  }
}

// ---------------------------------------------------------------------------
// The failure o3d-9te is about
// ---------------------------------------------------------------------------

test('an order BACKDATED before the cutoff but IMPORTED after it is left alone (o3d-9te)', () => {
  // THE case. A historical Woo order (date_created 2024) imported by the initial import AFTER the
  // fix shipped. Its SalesOrder.createdAt is 2024, so a createdAt cutoff calls it legacy; its
  // discountAmount is the residual the FIXED importer stored on purpose, so "correcting" it
  // subtracts the line discounts a second time and destroys a genuine discount. The ActivityLog
  // marker cannot save it either — a post-fix import has never been corrected, so it carries none.
  const decision = decideWcCouponBackfill(
    row({
      storedOrderDiscount: 6, // the residual the fixed importer computed: 10 coupon - 4 on lines
      lineDiscountTotal: 4,
      importedAt: new Date('2026-08-01T00:00:00.000Z'), // AFTER the fix — the link row, not the order
      alreadyBackfilled: false,
    }),
    { importedBefore: CUTOFF },
  )

  assert.equal(decision.action, 'SKIP')
  assert.equal(decision.action === 'SKIP' && decision.reason, 'POST_FIX_IMPORT')
})

test('the erosion that makes the guard load-bearing is real, not hypothetical (o3d-9te)', () => {
  // The SAME row, differing only in when it was imported. Dated before the fix, the arithmetic
  // happily takes the correct 6 down to 2 — which is exactly what the test above prevents. Pinned so
  // nobody removes the provenance gate believing the arithmetic is self-correcting.
  const eroded = decideWcCouponBackfill(
    row({
      storedOrderDiscount: 6,
      lineDiscountTotal: 4,
      importedAt: new Date('2026-05-01T00:00:00.000Z'),
    }),
    { importedBefore: CUTOFF },
  )

  assert.equal(eroded.action, 'CORRECT')
  assert.equal(eroded.action === 'CORRECT' && eroded.keptOrderLevel, 2)
})

test('the decision cannot see SalesOrder.createdAt at all (o3d-9te)', () => {
  // Structural, not behavioural: the input type carries no order createdAt, so no future edit can
  // quietly start scoping by it again. importedAt is documented as ShoppingOrderLink.createdAt.
  assert.ok(!Object.prototype.hasOwnProperty.call(row(), 'createdAt'))
  assert.ok(Object.prototype.hasOwnProperty.call(row(), 'importedAt'))
})

test('the backfill script does not scope its query by SalesOrder.createdAt (o3d-9te)', async () => {
  // Asserted against the source because the alternative is a live database. The `where` of the
  // candidate query is where the original bug lived: `createdAt: { lt: before }`.
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const src = readFileSync(join(process.cwd(), 'scripts/backfill-wc-coupon-order-discount.ts'), 'utf8')

  // Anchored on the candidate query itself, wherever it lives — it is now inside the keyset-paging
  // helper (o3d-y14 r2 F3), and an anchor tied to the old single-statement shape would have silently
  // matched nothing and asserted against an empty string.
  const start = src.indexOf('db.salesOrder.findMany(')
  assert.ok(start > 0, 'the candidate query must still be findable, or this test asserts about nothing')
  const query = src.slice(start)
  const where = query.slice(query.indexOf('where: {'), query.indexOf('select: {'))

  assert.match(where, /shoppingLinks: \{ some: \{ connector: 'woocommerce' \} \}/)
  assert.doesNotMatch(where, /createdAt/, 'scoping candidates by SalesOrder.createdAt IS the o3d-9te bug')
})

// ---------------------------------------------------------------------------
// classifyWcCouponProvenance — every branch
// ---------------------------------------------------------------------------

test('a recorded discountModel settles it WITHOUT any cutoff (o3d-9te)', () => {
  // The durable answer: the importer wrote down what it stored. No operator-supplied timestamp, no
  // deployment archaeology, and it survives a re-import.
  const provenance = classifyWcCouponProvenance({
    discountModel: WC_COUPON_DISCOUNT_MODEL,
    importedAt: new Date('2020-01-01T00:00:00.000Z'),
    importedBefore: null,
  })

  assert.equal(provenance.verdict, 'POST_FIX')
  assert.equal(provenance.reason, 'DISCOUNT_MODEL_RECORDED')
})

test('a marked row is skipped even when it was imported before the cutoff (o3d-9te)', () => {
  // Precedence matters: the recorded fact beats the timestamp inference. A row corrected by an
  // earlier run of this backfill is stamped, and an old import date must not un-stamp it.
  const decision = decideWcCouponBackfill(
    row({ discountModel: WC_COUPON_DISCOUNT_MODEL, importedAt: new Date('2020-01-01T00:00:00.000Z') }),
    { importedBefore: CUTOFF },
  )

  assert.equal(decision.action, 'SKIP')
  assert.equal(decision.action === 'SKIP' && decision.reason, 'POST_FIX_IMPORT')
})

test('a discount model this build does not understand is UNPROVEN, not assumed legacy (o3d-9te)', () => {
  const provenance = classifyWcCouponProvenance({
    discountModel: 'SOME_FUTURE_MODEL',
    importedAt: new Date('2020-01-01T00:00:00.000Z'),
    importedBefore: CUTOFF,
  })

  assert.equal(provenance.verdict, 'UNPROVEN')
  assert.equal(provenance.reason, 'UNRECOGNISED_DISCOUNT_MODEL')
})

test('a row with NO import timestamp is EXCLUDED, not reconstructed (o3d-9te)', () => {
  // Nothing says when IMS wrote this amount, so nothing says what it means. Reinterpreting it would
  // be a guess that silently destroys a discount if it is wrong.
  const decision = decideWcCouponBackfill(row({ importedAt: null }), { importedBefore: CUTOFF })

  assert.equal(decision.action, 'UNPROVEN')
  assert.equal(decision.action === 'UNPROVEN' && decision.reason, 'NO_IMPORT_TIMESTAMP')
  assert.notEqual(decision.action, 'CORRECT')
})

test('an unmarked row with NO cutoff is UNPROVEN rather than swept in (o3d-9te)', () => {
  const decision = decideWcCouponBackfill(row(), { importedBefore: null })

  assert.equal(decision.action, 'UNPROVEN')
  assert.equal(decision.action === 'UNPROVEN' && decision.reason, 'NO_CUTOFF')
})

// ---------------------------------------------------------------------------
// The arithmetic, once provenance permits it
// ---------------------------------------------------------------------------

test('a fully allocated coupon is cleared from the order-level slot', () => {
  const decision = decideWcCouponBackfill(row(), { importedBefore: CUTOFF })

  assert.equal(decision.action, 'CORRECT')
  assert.equal(decision.action === 'CORRECT' && decision.keptOrderLevel, 0)
  assert.equal(decision.action === 'CORRECT' && decision.clearedBy, 10)
  assert.equal(decision.action === 'CORRECT' && decision.partial, false)
})

test('a partially allocated coupon keeps its residual and reports PARTIAL', () => {
  // Only 4 reached the lines, so 6 is genuine order-level money and must survive.
  const decision = decideWcCouponBackfill(row({ lineDiscountTotal: 4 }), { importedBefore: CUTOFF })

  assert.equal(decision.action === 'CORRECT' && decision.keptOrderLevel, 6)
  assert.equal(decision.action === 'CORRECT' && decision.clearedBy, 4)
  assert.equal(decision.action === 'CORRECT' && decision.partial, true)
})

test('an order the lines carry nothing of is left completely alone', () => {
  // A native-shaped order-level discount. Nothing is duplicated; touching it would erase real money.
  const decision = decideWcCouponBackfill(row({ lineDiscountTotal: 0 }), { importedBefore: CUTOFF })

  assert.equal(decision.action, 'SKIP')
  assert.equal(decision.action === 'SKIP' && decision.reason, 'NOTHING_DUPLICATED')
})

test('an order corrected by an earlier run is skipped before anything else is considered', () => {
  const decision = decideWcCouponBackfill(row({ alreadyBackfilled: true }), { importedBefore: CUTOFF })

  assert.equal(decision.action, 'SKIP')
  assert.equal(decision.action === 'SKIP' && decision.reason, 'ALREADY_BACKFILLED')
})

// ---------------------------------------------------------------------------
// o3d-5ct at the reporting layer
// ---------------------------------------------------------------------------

test('an order with unposted invoice work is BLOCKED, not corrected (o3d-5ct)', () => {
  // The queued SALES_INVOICE carries a payload SNAPSHOT the processors post from, and a worker may
  // already be holding it. Recording this order as corrected would hide an understated invoice on
  // its way to the ledger.
  const decision = decideWcCouponBackfill(row({ liveInvoiceJobs: 1 }), { importedBefore: CUTOFF })

  assert.equal(decision.action, 'BLOCKED')
  assert.equal(decision.action === 'BLOCKED' && decision.reason, 'LIVE_INVOICE_QUEUED')
})

test('BLOCKED is decided after provenance, so it never resurrects a post-fix row (o3d-5ct/o3d-9te)', () => {
  // Ordering check: a post-fix row with a queued invoice is SKIPPED as post-fix, not reported as
  // blocked work waiting to be done.
  const decision = decideWcCouponBackfill(
    row({ discountModel: WC_COUPON_DISCOUNT_MODEL, liveInvoiceJobs: 3 }),
    { importedBefore: CUTOFF },
  )

  assert.equal(decision.action, 'SKIP')
})

// ---------------------------------------------------------------------------
// o3d-y14 r2 finding 1 at the REPORTING layer — the other producer
// ---------------------------------------------------------------------------

test('an order whose daily revenue-deferral journal is still unposted is BLOCKED (o3d-y14 r2 F1)', () => {
  // The proposal must not even OFFER this order. `applyWcCouponCorrection` declines it a second time
  // under the lock, but that is the last line of defence: a row that reaches the reviewer looks like
  // approved work, and the reviewer has no way to see that a worker is holding a GL journal derived
  // from the amount they are being asked to change.
  const decision = decideWcCouponBackfill(
    row({ revenueDeferredBatchRef: 'A1-2026-07-01-aaaabbbb', liveBatchDeferralJobs: 1 }),
    { importedBefore: CUTOFF },
  )

  assert.equal(decision.action, 'BLOCKED')
  assert.equal(decision.action === 'BLOCKED' && decision.reason, 'LIVE_BATCH_QUEUED')
  assert.match(
    decision.action === 'BLOCKED' ? decision.detail : '',
    /A1-2026-07-01-aaaabbbb/,
    'and names the batch, so the operator knows what to wait for',
  )
})

test('a POSTED deferral batch is a CANDIDATE, not a block (o3d-y14 r2 F1)', () => {
  // The control, and the case that actually matters at volume: nearly every legacy order already has
  // a SYNCED Group A1 journal. A block keyed on "has a batch reference" rather than on "has an
  // unposted journal" would decline the entire population and the backfill would correct nothing.
  const decision = decideWcCouponBackfill(
    row({ revenueDeferredBatchRef: 'A1-2026-07-01-aaaabbbb', liveBatchDeferralJobs: 0 }),
    { importedBefore: CUTOFF },
  )

  assert.equal(decision.action, 'CORRECT')
})

test('a live BATCH blocks even when no invoice job does (o3d-y14 r2 F1)', () => {
  // The two counts are independent producers, and this is the shape the invoice-only fence missed:
  // zero live invoice jobs is TRUE and still insufficient, because a Group A1 row is keyed on its
  // batch and no order-scoped count can see it.
  const decision = decideWcCouponBackfill(
    row({ liveInvoiceJobs: 0, revenueDeferredBatchRef: 'A1-2026-07-01-aaaabbbb', liveBatchDeferralJobs: 2 }),
    { importedBefore: CUTOFF },
  )

  assert.equal(decision.action === 'BLOCKED' && decision.reason, 'LIVE_BATCH_QUEUED')
})

test('the batch block is decided after provenance too, so a post-fix row stays SKIPPED (o3d-y14 r2 F1)', () => {
  const decision = decideWcCouponBackfill(
    row({
      discountModel: WC_COUPON_DISCOUNT_MODEL,
      revenueDeferredBatchRef: 'A1-2026-07-01-aaaabbbb',
      liveBatchDeferralJobs: 1,
    }),
    { importedBefore: CUTOFF },
  )

  assert.equal(decision.action, 'SKIP')
  assert.equal(decision.action === 'SKIP' && decision.reason, 'POST_FIX_IMPORT')
})
