import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { type TestContext } from 'node:test'
import { config } from 'dotenv'

import { backendPid, waitUntilParkedBehind } from '../helpers/lock-wait-observer'

/**
 * THE POSTING-TIME ORDER-STATE FENCE for store-credit review (Codex round 8), against a real PostgreSQL.
 *
 * An order-scoped posting (sales invoice create / update, credit note, payment registration, ...) decides under the
 * order's row lock, then releases it and goes on to the remote call. A WooCommerce delivery that flags the order
 * REVIEW_REQUIRED must therefore be ordered against it, in BOTH directions:
 *
 *   REVIEW FIRST:  the review commits while the posting's guard is waiting for the order lock; the guard then reads
 *                  REVIEW_REQUIRED and REFUSES. (Fails if the guard reads without the lock: it never parks.)
 *   GUARD FIRST:   the guard holds the lock; the review transition waits for it, then finds the posting's live
 *                  PROCESSING claim and DEFERS instead of committing between authorisation and dispatch.
 *                  (Fails if the transition does not look for the claim: it flags the order.)
 *
 * Nothing is ordered by sleeping: the parked side is observed in pg_stat_activity / pg_locks.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const skip = !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1'

async function loadDb() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const { db } = await import('@/lib/db')
  return db
}

function creditPayload(externalId: number) {
  const address = { first_name: 'A', last_name: 'B', company: '', address_1: '1 St', address_2: '', city: 'Leeds', state: '', postcode: 'LS1', country: 'GB', email: 'a@b.c', phone: '' }
  return {
    id: externalId, number: String(externalId), order_key: `wc_order_${externalId}`, status: 'processing', currency: 'GBP',
    customer_note: '', date_paid_gmt: null, date_created: '2026-08-01T09:00:00', date_created_gmt: '2026-08-01T09:00:00',
    billing: address, shipping: address, meta_data: [],
    coupon_lines: [{ id: 1, code: 'sc', discount: '5.00', discount_tax: '0.00', meta_data: [{ id: 9, key: 'coupon_info', value: '[1,"sc","smart_coupon","50"]' }] }],
    line_items: [], tax_lines: [], shipping_lines: [], fee_lines: [], refunds: [],
  }
}

type Db = Awaited<ReturnType<typeof loadDb>>

async function makeOrder(db: Db, t: TestContext) {
  const id = `SCF-${process.pid}-${randomUUID()}`
  const externalId = Math.floor(Math.random() * 2_000_000_000)
  const refundId = `SCFR-${randomUUID()}`
  t.after(async () => {
    await db.accountingSyncLog.deleteMany({ where: { OR: [{ referenceId: id }, { referenceId: refundId }, { payload: { path: ['referenceId'], equals: id } }] } })
    await db.activityLog.deleteMany({ where: { entityId: id } })
    await db.salesOrderRefund.deleteMany({ where: { orderId: id } })
    await db.salesOrder.deleteMany({ where: { id } })
  })
  await db.salesOrder.create({
    data: {
      id, status: 'PROCESSING', currency: 'GBP', subtotalForeign: 100, totalForeign: 100, subtotalBase: 100, totalBase: 100,
      shoppingLinks: { create: { connector: 'woocommerce', externalOrderId: String(externalId), externalOrderNumber: String(externalId) } },
    },
  })
  await db.salesOrderRefund.create({ data: { id: refundId, orderId: id, totalForeign: 10, totalBase: 10 } })
  return { id, externalId, refundId }
}

async function assessment(db: Db, id: string) {
  return (await db.salesOrder.findUniqueOrThrow({ where: { id }, select: { storeCreditAssessment: true } })).storeCreditAssessment
}

const FOR_UPDATE = /FOR UPDATE/i

// ------------------------------------------------------------------------------------------------------
// REVIEW FIRST: each posting guard is serialised behind the review transition's lock and then refuses.
// ------------------------------------------------------------------------------------------------------

type GuardArm = { name: string; run: (ids: { id: string; refundId: string }) => Promise<{ refused: boolean }> }
const GUARDS: GuardArm[] = [
  {
    name: 'sales invoice (create / update guard)',
    run: async ({ id }) => {
      const { guardCancelledSalesOrderInvoice } = await import('@/lib/connectors/xero/sync-processor')
      const { claimHeldFrom } = await import('@/lib/domain/accounting/sync-claim-fence')
      const r = await guardCancelledSalesOrderInvoice({ id: 'sync-x', attemptRevision: 1 } as never, 'SalesOrder', id, claimHeldFrom(new Date()))
      return { refused: !r.post }
    },
  },
  {
    name: 'credit note',
    run: async ({ refundId }) => {
      const { guardStoreCreditCreditNote } = await import('@/lib/connectors/xero/sync-processor')
      return { refused: (await guardStoreCreditCreditNote('SalesOrderRefund', refundId)) !== null }
    },
  },
  {
    name: 'payment registration (follow-up guard)',
    run: async ({ id }) => {
      const { guardStoreCreditFollowUp } = await import('@/lib/connectors/xero/sync-processor')
      return { refused: (await guardStoreCreditFollowUp(id, 'payment registration')) !== null }
    },
  },
]

for (const arm of GUARDS) {
  test(`[posting fence] REVIEW FIRST: the ${arm.name} guard waits for the order lock and then REFUSES an order flagged meanwhile`, { skip }, async (t) => {
    const db = await loadDb()
    const { lockSalesOrder } = await import('@/lib/domain/sales/allocation-service')
    const ids = await makeOrder(db, t)
    // Control: with the order unflagged and the lock free the guard lets it through (the rig can say yes).
    const control = await arm.run(ids)
    assert.equal(control.refused, false, 'control: an unflagged order is authorised')

    let guardResult: Promise<{ refused: boolean }> | undefined
    let parked: { observedAfterMs: number } | undefined
    await db.$transaction(async (tx) => {
      await lockSalesOrder(tx, ids.id)
      const holder = await backendPid(tx)
      guardResult = arm.run(ids)
      parked = await waitUntilParkedBehind(db, { holderPid: holder, waitingOn: FOR_UPDATE, describe: `${arm.name} guard behind the review transition's order lock` })
      await tx.salesOrder.update({ where: { id: ids.id }, data: { storeCreditAssessment: 'REVIEW_REQUIRED' } })
    })
    const result = await guardResult!
    // eslint-disable-next-line no-console
    console.log(`PRECONDITION review-first (${arm.name}): guard parked behind the lock (${parked!.observedAfterMs}ms), review committed, guard refused=${result.refused}`)
    assert.equal(result.refused, true, 'the guard read the committed REVIEW_REQUIRED and refused')
    assert.equal(await assessment(db, ids.id), 'REVIEW_REQUIRED')
  })
}

// ------------------------------------------------------------------------------------------------------
// GUARD FIRST: the review transition waits for the lock, finds the live posting claim and DEFERS.
// ------------------------------------------------------------------------------------------------------

type ClaimArm = { name: string; claim: (ids: { id: string; refundId: string }) => { type: string; referenceType: string; referenceId: string; payload?: Record<string, unknown> } }
const CLAIMS: ClaimArm[] = [
  { name: 'SALES_INVOICE', claim: ({ id }) => ({ type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: id }) },
  { name: 'SALES_INVOICE_UPDATE', claim: ({ id }) => ({ type: 'SALES_INVOICE_UPDATE', referenceType: 'SalesOrder', referenceId: id }) },
  { name: 'INVOICE_PAYMENT', claim: ({ id }) => ({ type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: id }) },
  { name: 'CREDIT_NOTE (keyed by the refund)', claim: ({ refundId }) => ({ type: 'CREDIT_NOTE', referenceType: 'SalesOrderRefund', referenceId: refundId }) },
  { name: 'INVOICE_EMAIL (order only in the payload)', claim: ({ id }) => ({ type: 'INVOICE_EMAIL', referenceType: 'SalesOrder', referenceId: `other-${randomUUID()}`, payload: { referenceId: id } }) },
]

async function insertClaim(db: Db, c: ReturnType<ClaimArm['claim']>, over: { status?: 'PROCESSING' | 'SYNCED'; startedMinutesAgo?: number } = {}) {
  return db.accountingSyncLog.create({
    data: {
      type: c.type as never, referenceType: c.referenceType, referenceId: c.referenceId,
      payload: (c.payload ?? {}) as never,
      status: over.status ?? 'PROCESSING',
      processingStartedAt: (over.status ?? 'PROCESSING') === 'PROCESSING' ? new Date(Date.now() - (over.startedMinutesAgo ?? 0) * 60_000) : null,
    },
  })
}

for (const arm of CLAIMS) {
  test(`[posting fence] GUARD FIRST: with a live ${arm.name} claim the review DEFERS; once it settles the review commits`, { skip }, async (t) => {
    const db = await loadDb()
    const { lockSalesOrder } = await import('@/lib/domain/sales/allocation-service')
    const { updateExistingWcOrderFromPayload } = await import('@/lib/connectors/woocommerce/sync/order-import')
    const { StoreCreditReviewDeferredError } = await import('@/lib/domain/accounting/store-credit-posting-fence')
    const ids = await makeOrder(db, t)
    const claim = await insertClaim(db, arm.claim(ids))

    // The "guard" holds the order lock (as every posting guard does while it reads), the review transition arrives.
    let transition: Promise<unknown> | undefined
    let parked: { observedAfterMs: number } | undefined
    await db.$transaction(async (tx) => {
      await lockSalesOrder(tx, ids.id)
      const holder = await backendPid(tx)
      transition = updateExistingWcOrderFromPayload(ids.id, creditPayload(ids.externalId) as never).then(() => null, (e: unknown) => e)
      parked = await waitUntilParkedBehind(db, { holderPid: holder, waitingOn: FOR_UPDATE, describe: `review transition (${arm.name}) behind the guard's order lock` })
    })
    const outcome = await transition!
    // eslint-disable-next-line no-console
    console.log(`PRECONDITION guard-first (${arm.name}): claim ${claim.id} PROCESSING, transition parked ${parked!.observedAfterMs}ms, outcome=${outcome instanceof Error ? outcome.name : 'committed'}`)
    assert.ok(outcome instanceof StoreCreditReviewDeferredError, 'the transition deferred instead of committing mid-posting')
    assert.equal(await assessment(db, ids.id), null, 'the order was NOT flagged while the posting is in flight')
    assert.equal(await db.activityLog.count({ where: { entityId: ids.id, action: 'wc_store_credit_review_required' } }), 0)

    // The posting settles; the redelivered update now records the review.
    await db.accountingSyncLog.update({ where: { id: claim.id }, data: { status: 'SYNCED', processingStartedAt: null } })
    await updateExistingWcOrderFromPayload(ids.id, creditPayload(ids.externalId) as never)
    assert.equal(await assessment(db, ids.id), 'REVIEW_REQUIRED', 'after the posting settled the review committed')
  })
}

// ------------------------------------------------------------------------------------------------------
// ISOLATING arms: the fence defers ONLY for a fresh PROCESSING claim of THIS order.
// ------------------------------------------------------------------------------------------------------

test('[posting fence] a STALE claim, a SETTLED claim and ANOTHER order\'s claim do not defer the review', { skip }, async (t) => {
  const db = await loadDb()
  const { updateExistingWcOrderFromPayload } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const cases: Array<[string, (ids: { id: string; refundId: string }) => Promise<unknown>]> = [
    ['stale (30 min) PROCESSING', (ids) => insertClaim(db, CLAIMS[0].claim(ids), { startedMinutesAgo: 30 })],
    ['settled SYNCED', (ids) => insertClaim(db, CLAIMS[0].claim(ids), { status: 'SYNCED' })],
    ['another order', () => insertClaim(db, { type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: `other-${randomUUID()}` })],
  ]
  for (const [label, seed] of cases) {
    const ids = await makeOrder(db, t)
    await seed(ids)
    await updateExistingWcOrderFromPayload(ids.id, creditPayload(ids.externalId) as never)
    // eslint-disable-next-line no-console
    console.log(`PRECONDITION isolating (${label}): review committed`)
    assert.equal(await assessment(db, ids.id), 'REVIEW_REQUIRED', label)
  }
})
