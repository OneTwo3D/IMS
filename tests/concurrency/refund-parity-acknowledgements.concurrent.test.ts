import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { loadEnv } from './po-landed-fixtures'

/**
 * o3d-pnc8p: THE TWO ACKNOWLEDGEMENTS that close refund-parity records, against a real PostgreSQL.
 *   "Settled outside IMS"  closes a parity hold (a QUARANTINED park carrying PARITY_NO_MANUAL_RECORD): creates nothing, records who and why, and is refused for
 *                          any other park. Two operators at once: exactly one closes it.
 *   "Repayment applied"    the ONLY way an open fee repayment (a refund with eas_fee_gap_foreign > 0) is cleared, as o3d-ioss-xero 0.2.6 keeps
 *                          `_o3d_ioss_fee_open`; closing the repayment's own park does NOT clear it. Two at once: exactly one.
 * Every row this file writes is back-dated and named by a random tag, so leftovers from other files (or earlier runs) cannot be confused with them.
 */
const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const SKIP = { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' } as const

const session = { user: { id: '', name: 'Ack Tester', email: 'ack@example.test', role: 'ADMIN' } }
mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => session,
    requireInternalUser: async () => session,
    requireRole: async () => session,
    requireFreshPermission: async () => session,
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })

const LONG_AGO = new Date(Date.UTC(2001, 0, 1))

async function fixtures(t: { after: (fn: () => Promise<void>) => void }) {
  loadEnv()
  const { db } = await import('@/lib/db')
  const { PARITY_NO_MANUAL_RECORD } = await import('@/lib/domain/sales/refund-cn-parity')
  const tag = `ack${randomUUID().slice(0, 8)}`
  const user = await db.user.create({ data: { email: `${tag}@example.test`, name: 'Ack Tester', passwordHash: 'x' }, select: { id: true } })
  session.user.id = user.id
  const order = await db.salesOrder.create({
    data: { orderNumber: tag, status: 'PROCESSING', currency: 'EUR', fxRateToBase: 1, subtotalForeign: 20.86, totalForeign: 20.86, subtotalBase: 20.86, totalBase: 20.86, taxForeign: 3.10, taxBase: 3.10, createdAt: LONG_AGO } as never,
    select: { id: true },
  })
  const park = (externalId: string, message: string) => db.shoppingSyncLog.create({
    data: { connector: 'woocommerce', direction: 'FROM_CONNECTOR', entityType: 'SalesOrder', entityId: order.id, recordKind: 'WC_REFUND_PARK', status: 'QUARANTINED', externalId, errorMessage: message, createdAt: LONG_AGO } as never,
    select: { id: true },
  })
  const parityHold = await park(`${Date.now()}1`, `WooCommerce refund 166130 refunds no goods.${PARITY_NO_MANUAL_RECORD}`)
  const ordinary = await park(`${Date.now()}2`, 'This refund is monetary-only and the VAT basis could not be determined.')
  const refund = await db.salesOrderRefund.create({
    data: { orderId: order.id, totalForeign: 17.08, totalBase: 17.08, creditNoteNumber: `CN-${tag}`, externalRefundId: Math.floor(Math.random() * 1_000_000_000) + 1, easFeeGapForeign: 3, storefrontAmountForeign: 17.86, createdAt: LONG_AGO } as never,
    select: { id: true },
  })
  t.after(async () => {
    await db.activityLog.deleteMany({ where: { OR: [{ entityId: order.id }, { userId: user.id }] } })
    await db.shoppingSyncLog.deleteMany({ where: { entityId: order.id } })
    await db.salesOrderRefund.deleteMany({ where: { orderId: order.id } })
    await db.salesOrder.deleteMany({ where: { id: order.id } })
    await db.user.deleteMany({ where: { id: user.id } })
  })
  return { db, order, parityHold, ordinary, refund }
}

test('[pnc8p] "Settled outside IMS" closes a parity hold, creates nothing, records who and why; refused for any other park and without a reason; two at once close it once', SKIP, async (t) => {
  const f = await fixtures(t)
  const actions = await import('@/app/actions/sync-exceptions')
  const { SETTLED_OUTSIDE_IMS_NOTE_PREFIX } = await import('@/lib/domain/sales/refund-cn-parity')

  assert.equal((await actions.acknowledgeRefundParkSettledOutsideIms(f.parityHold.id, '   ')).success, false, 'a reason is required')
  const other = await actions.acknowledgeRefundParkSettledOutsideIms(f.ordinary.id, 'done in Xero')
  assert.equal(other.success, false)
  assert.match(String(other.error), /Only a refund held by the storefront refund parity checks/)
  assert.equal((await f.db.shoppingSyncLog.findUniqueOrThrow({ where: { id: f.ordinary.id } })).status, 'QUARANTINED', 'the ordinary park is untouched')

  const refundsBefore = await f.db.salesOrderRefund.count({ where: { orderId: f.order.id } })
  const [a, b] = await Promise.all([
    actions.acknowledgeRefundParkSettledOutsideIms(f.parityHold.id, 'CN-11629 raised in Xero by the accountant'),
    actions.acknowledgeRefundParkSettledOutsideIms(f.parityHold.id, 'CN-11629 raised in Xero by the accountant'),
  ])
  assert.equal([a, b].filter((r) => r.success).length, 1, `exactly one closes it: ${JSON.stringify([a, b])}`)
  const closed = await f.db.shoppingSyncLog.findUniqueOrThrow({ where: { id: f.parityHold.id } })
  assert.equal(closed.status, 'SYNCED')
  assert.ok(closed.errorMessage?.startsWith(SETTLED_OUTSIDE_IMS_NOTE_PREFIX))
  assert.match(closed.errorMessage ?? '', /Ack Tester: CN-11629 raised in Xero by the accountant/)
  assert.match(closed.errorMessage ?? '', /The hold it closed: WooCommerce refund 166130 refunds no goods/)
  assert.equal(await f.db.salesOrderRefund.count({ where: { orderId: f.order.id } }), refundsBefore, 'nothing was created')
  const logs = await f.db.activityLog.findMany({ where: { entityId: f.order.id, action: 'refund_park_settled_outside_ims' }, select: { userId: true, metadata: true } })
  assert.equal(logs.length, 1)
  assert.equal(logs[0]!.userId, session.user.id)
  assert.equal((logs[0]!.metadata as { reason?: string }).reason, 'CN-11629 raised in Xero by the accountant')
  // It no longer blocks the order: it is not an active park.
  const { activeRefundParkWhere } = await import('@/lib/domain/sales/refund-park-recovery')
  assert.equal(await f.db.shoppingSyncLog.count({ where: { ...activeRefundParkWhere(), id: f.parityHold.id } }), 0)
  // The open fee repayment on the earlier refund is a record of its own: closing the repayment's park did NOT clear it.
  assert.equal((await f.db.salesOrderRefund.findUniqueOrThrow({ where: { id: f.refund.id } })).feeRepaymentAppliedAt, null)
})

test('[pnc8p case 8] "Repayment applied" is the only way an open fee repayment is cleared: it records who, when and what; a second (or concurrent) acknowledgement changes nothing', SKIP, async (t) => {
  const f = await fixtures(t)
  const actions = await import('@/app/actions/sync-exceptions')
  assert.equal((await actions.acknowledgeFeeRepaymentApplied(f.refund.id, '')).success, false)
  const [a, b] = await Promise.all([
    actions.acknowledgeFeeRepaymentApplied(f.refund.id, '3.00 repayment applied to the credit note in Xero'),
    actions.acknowledgeFeeRepaymentApplied(f.refund.id, '3.00 repayment applied to the credit note in Xero'),
  ])
  assert.equal([a, b].filter((r) => r.success).length, 1, `exactly one: ${JSON.stringify([a, b])}`)
  const row = await f.db.salesOrderRefund.findUniqueOrThrow({ where: { id: f.refund.id } })
  assert.ok(row.feeRepaymentAppliedAt)
  assert.equal(row.feeRepaymentAppliedBy, session.user.id)
  assert.equal(row.feeRepaymentAppliedNote, 'Ack Tester: 3.00 repayment applied to the credit note in Xero')
  assert.equal(Number(row.easFeeGapForeign), 3, 'the fee-gap figures stay as recorded')
  assert.equal(await f.db.activityLog.count({ where: { entityId: f.order.id, action: 'refund_fee_repayment_applied' } }), 1)
  const again = await actions.acknowledgeFeeRepaymentApplied(f.refund.id, 'again')
  assert.equal(again.success, false)
  assert.match(String(again.error), /no longer open/)
})
