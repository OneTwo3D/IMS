import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { type TestContext } from 'node:test'
import { config } from 'dotenv'

import { backendPid, waitUntilParkedBehind } from '../helpers/lock-wait-observer'

/**
 * THE DRAIN-TIME GUARD OF AN INVOICE'S FOLLOW-UPS FOR A CANCELLED ORDER, against a real PostgreSQL.
 *
 * INVOICE_EMAIL and WC_INVOICE_NOTE rows queued BEFORE the order was cancelled survive the cancellation (it retires the invoice types only). The guard reads the order under the
 * order row lock, the lock cancellation takes first, so for any pair either the cancellation commits first and the guard retires the row, or the guard holds the lock and the
 * cancellation waits (and finds the live claim). INVOICE_PAYMENT is decided by the receipt's time against the database-stamped cancellation instant, at the same post-site guard.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const skip = !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1'
const FOR_UPDATE = /FOR UPDATE/i

async function loadDb() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const { db } = await import('@/lib/db')
  return db
}
type Db = Awaited<ReturnType<typeof loadDb>>

async function makeOrder(db: Db, t: TestContext, status: 'PROCESSING' | 'CANCELLED' = 'PROCESSING') {
  const id = `COF-${process.pid}-${randomUUID()}`
  t.after(async () => {
    await db.accountingSyncLog.deleteMany({ where: { referenceId: id } })
    await db.activityLog.deleteMany({ where: { entityId: id } })
    await db.payment.deleteMany({ where: { orderId: id } })
    await db.salesOrder.deleteMany({ where: { id } })
  })
  await db.salesOrder.create({ data: { id, status, currency: 'GBP', subtotalForeign: 100, totalForeign: 100, subtotalBase: 100, totalBase: 100 } })
  return id
}

async function claimRow(db: Db, orderId: string, type: 'INVOICE_EMAIL' | 'WC_INVOICE_NOTE') {
  const claimedAt = new Date()
  const row = await db.accountingSyncLog.create({ data: { type, referenceType: 'SalesOrder', referenceId: orderId, payload: { referenceId: orderId }, status: 'PROCESSING', processingStartedAt: claimedAt } })
  const { claimHeldFrom } = await import('@/lib/domain/accounting/sync-claim-fence')
  return { row, claim: claimHeldFrom(claimedAt) }
}

for (const type of ['INVOICE_EMAIL', 'WC_INVOICE_NOTE'] as const) {
  test(`[cancelled follow-up] ${type}: a claimed row for a CANCELLED order is retired CANCELLED with the reason; for an active order it is left alone`, { skip }, async (t) => {
    const db = await loadDb()
    const { guardCancelledOrderFollowUp, cancelledOrderFollowUpReason } = await import('@/lib/domain/accounting/cancelled-order-followup')
    const active = await makeOrder(db, t)
    const a = await claimRow(db, active, type)
    assert.deepEqual(await guardCancelledOrderFollowUp({ entryId: a.row.id, claim: a.claim, type, orderId: active }), { refused: false })
    assert.equal((await db.accountingSyncLog.findUniqueOrThrow({ where: { id: a.row.id } })).status, 'PROCESSING')

    const cancelled = await makeOrder(db, t, 'CANCELLED')
    const c = await claimRow(db, cancelled, type)
    const decision = await guardCancelledOrderFollowUp({ entryId: c.row.id, claim: c.claim, type, orderId: cancelled })
    assert.deepEqual(decision, { refused: true, reason: cancelledOrderFollowUpReason(type), retired: true })
    const after = await db.accountingSyncLog.findUniqueOrThrow({ where: { id: c.row.id } })
    assert.equal(after.status, 'CANCELLED')
    assert.equal(after.errorMessage, cancelledOrderFollowUpReason(type))
    assert.equal(after.processingStartedAt, null)
  })
}

test('[cancelled follow-up] the retirement is CLAIM-FENCED: a worker that no longer holds the claim retires nothing', { skip }, async (t) => {
  const db = await loadDb()
  const { guardCancelledOrderFollowUp } = await import('@/lib/domain/accounting/cancelled-order-followup')
  const { claimHeldFrom } = await import('@/lib/domain/accounting/sync-claim-fence')
  const id = await makeOrder(db, t, 'CANCELLED')
  const { row } = await claimRow(db, id, 'INVOICE_EMAIL')
  const decision = await guardCancelledOrderFollowUp({ entryId: row.id, claim: claimHeldFrom(new Date(Date.now() - 3_600_000)), type: 'INVOICE_EMAIL', orderId: id })
  assert.deepEqual([decision.refused, decision.refused && decision.retired], [true, false], 'refused to send, but the row is not this worker\'s to retire')
  assert.equal((await db.accountingSyncLog.findUniqueOrThrow({ where: { id: row.id } })).status, 'PROCESSING')
})

test('[cancelled follow-up] CANCELLATION FIRST: the guard waits for the order lock, then reads CANCELLED and retires the row', { skip }, async (t) => {
  const db = await loadDb()
  const { lockSalesOrder } = await import('@/lib/domain/sales/allocation-service')
  const { guardCancelledOrderFollowUp } = await import('@/lib/domain/accounting/cancelled-order-followup')
  const id = await makeOrder(db, t)
  const { row, claim } = await claimRow(db, id, 'INVOICE_EMAIL')
  let guard: Promise<{ refused: boolean }> | undefined
  let parked: { observedAfterMs: number } | undefined
  await db.$transaction(async (tx) => {
    await lockSalesOrder(tx, id)
    const holder = await backendPid(tx)
    guard = guardCancelledOrderFollowUp({ entryId: row.id, claim, type: 'INVOICE_EMAIL', orderId: id })
    parked = await waitUntilParkedBehind(db, { holderPid: holder, waitingOn: FOR_UPDATE, describe: 'follow-up guard behind the cancellation\'s order lock' })
    await tx.salesOrder.update({ where: { id }, data: { status: 'CANCELLED' } })
  })
  const result = await guard!
  console.log(`PRECONDITION cancellation-first: guard parked behind the lock (${parked!.observedAfterMs}ms), cancellation committed, guard refused=${result.refused}`)
  assert.equal(result.refused, true)
  assert.equal((await db.accountingSyncLog.findUniqueOrThrow({ where: { id: row.id } })).status, 'CANCELLED')
})

test('[cancelled follow-up] GUARD FIRST: while the guard holds the order lock a cancellation cannot commit under it', { skip }, async (t) => {
  const db = await loadDb()
  const { lockSalesOrder } = await import('@/lib/domain/sales/allocation-service')
  const { guardCancelledOrderFollowUp } = await import('@/lib/domain/accounting/cancelled-order-followup')
  const id = await makeOrder(db, t)
  const { row, claim } = await claimRow(db, id, 'WC_INVOICE_NOTE')
  // The guard's decision for an ACTIVE order is "send". A cancellation that wants the order must wait for the guard's lock rather than interleave: observed as the cancel parking behind it.
  let cancel: Promise<unknown> | undefined
  let parked: { observedAfterMs: number } | undefined
  const decision = await db.$transaction(async (tx) => {
    await lockSalesOrder(tx, id)
    const holder = await backendPid(tx)
    cancel = db.$transaction(async (ctx) => { await lockSalesOrder(ctx, id); await ctx.salesOrder.update({ where: { id }, data: { status: 'CANCELLED' } }) })
    parked = await waitUntilParkedBehind(db, { holderPid: holder, waitingOn: FOR_UPDATE, describe: 'cancellation behind the follow-up guard\'s order lock' })
    return (await tx.salesOrder.findUniqueOrThrow({ where: { id }, select: { status: true } })).status
  })
  await cancel!
  assert.equal(decision, 'PROCESSING', 'the order state the lock holder saw cannot change under it')
  console.log(`PRECONDITION guard-first: cancellation parked ${parked!.observedAfterMs}ms`)
  // and the next drain, now after the cancellation, refuses
  const next = await guardCancelledOrderFollowUp({ entryId: row.id, claim, type: 'WC_INVOICE_NOTE', orderId: id })
  assert.equal(next.refused, true)
})

test('[cancelled follow-up] INVOICE_PAYMENT: a receipt dated after the database-stamped cancellation is refused at the post-site guard; one that predates it, or an unknown instant, posts', { skip }, async (t) => {
  const db = await loadDb()
  const { guardInvoicePaymentCapacity } = await import('@/lib/domain/accounting/invoice-payment-capacity')
  const id = await makeOrder(db, t)
  await db.salesOrder.update({ where: { id }, data: { accountingInvoiceId: 'INV-COF' } })
  // cancelled_at is minted by the DATABASE clock when the order becomes CANCELLED
  await db.salesOrder.update({ where: { id }, data: { status: 'CANCELLED' } })
  const cancelledAt = (await db.salesOrder.findUniqueOrThrow({ where: { id }, select: { cancelledAt: true } })).cancelledAt
  assert.ok(cancelledAt, 'the trigger stamped the cancellation instant')
  const payAt = (paidAt: Date) => db.payment.create({ data: { orderId: id, amount: 40, currency: 'GBP', method: 'Bank', paidAt } })
  const after = await payAt(new Date(cancelledAt.getTime() + 3_600_000))
  const before = await payAt(new Date(cancelledAt.getTime() - 3_600_000))
  const params = (paymentId: string) => ({
    connector: 'xero', entryId: `log-${paymentId}`, referenceType: 'SalesOrder', referenceId: id, accountingInvoiceId: 'INV-COF', amount: 40,
    payload: { accountingInvoiceId: 'INV-COF', amount: 40, currency: 'GBP', paymentId },
  })
  const refused = await guardInvoicePaymentCapacity(db, params(after.id))
  assert.equal(refused.post === false && refused.kind === 'refused' && refused.refusal, 'PAID_AFTER_CANCELLATION')
  const ok = await guardInvoicePaymentCapacity(db, params(before.id))
  assert.equal(ok.post, true, 'the credit-note path registers as ever')
})

test('[cancelled follow-up] the processor boundary: a cancelled order is handled (skipped, with a finding), an active one proceeds, an unknown order is left to the send path', { skip }, async (t) => {
  const db = await loadDb()
  const { refuseFollowUpForCancelledOrder } = await import('@/lib/connectors/xero/sync-processor')
  const { cancelledOrderFollowUpReason } = await import('@/lib/domain/accounting/cancelled-order-followup')
  const active = await makeOrder(db, t)
  const a = await claimRow(db, active, 'INVOICE_EMAIL')
  assert.equal(await refuseFollowUpForCancelledOrder({ entryId: a.row.id, lease: a.claim, type: 'INVOICE_EMAIL', orderId: active }), null, 'an active order proceeds to the send')

  const cancelled = await makeOrder(db, t, 'CANCELLED')
  const c = await claimRow(db, cancelled, 'WC_INVOICE_NOTE')
  const result = await refuseFollowUpForCancelledOrder({ entryId: c.row.id, lease: c.claim, type: 'WC_INVOICE_NOTE', orderId: cancelled })
  assert.deepEqual(result, { success: true, skipped: true }, 'terminal and handled, not a failure that burns retries')
  const finding = await db.activityLog.findMany({ where: { entityId: cancelled, action: 'invoice_followup_refused_cancelled_order' } })
  assert.equal(finding.length, 1)
  assert.equal(finding[0]!.level, 'WARNING')
  assert.equal(finding[0]!.description, cancelledOrderFollowUpReason('WC_INVOICE_NOTE'))

  const missing = await refuseFollowUpForCancelledOrder({ entryId: a.row.id, lease: a.claim, type: 'INVOICE_EMAIL', orderId: 'no-such-order' })
  assert.equal(missing, null, 'no order row: nothing to be cancelled here; the send path reports the missing order itself')
})
