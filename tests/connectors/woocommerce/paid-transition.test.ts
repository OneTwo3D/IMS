/**
 * An order IMS already holds that was imported UNPAID and is paid in WooCommerce later (the pending-FX retry and the ordinary update both reach this) goes through the
 * SAME receipt rule as an order imported paid: settlement rate, one Payment, one ledger registration, idempotently; a missing payment-day rate leaves it unpaid and the
 * pending-FX row pending. Real scratch database, real importer. Every arm names the mutation that turns it red.
 */
import assert from 'node:assert/strict'
import test, { after, before, mock } from 'node:test'
import { startScratch, type Scratch } from '../../first-load/apply-scratch'

mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('@/lib/shopping', { namedExports: { enqueueStockSync: async () => {} } })
mock.module('@/lib/notifications', { namedExports: { notify: async () => {} } })

const registrations: Array<Record<string, unknown>> = []
mock.module('@/lib/domain/accounting/invoice-payment-enqueue', { namedExports: { registerInvoicePaymentWithLedger: async (p: Record<string, unknown>) => { registrations.push(p); return null } } })

let s: Scratch
let seq = 0
before(async () => {
  s = await startScratch('ims-wc-paid-transition')
  await s.sql('truncate fx_rates')
  await s.db.fxRate.create({ data: { fromCurrency: 'GBP', toCurrency: 'EUR', rate: '1.10', fetchedAt: new Date('2026-10-01T06:00:00Z') } })
})
after(async () => { await s?.stop() })

async function heldOrder(opts: { currency?: string; paidAt?: Date | null } = {}) {
  const n = ++seq
  const o = await s.db.salesOrder.create({ data: { currency: opts.currency ?? 'EUR', fxRateToBase: '1.1', subtotalForeign: '100', totalForeign: '100', subtotalBase: '90.9091', totalBase: '90.9091', paidAt: opts.paidAt ?? null, shoppingLinks: { create: { connector: 'woocommerce', externalOrderId: `9${n}` } } }, select: { id: true } })
  return { id: o.id, wcId: Number(`9${n}`) }
}
const payload = (wcId: number, paid: string | null, created = '2026-10-01T09:00:00') => ({
  id: wcId, number: String(wcId), order_key: 'k', status: 'processing', currency: 'EUR', total: '100.00', date_created_gmt: created, date_paid_gmt: paid,
  billing: {}, shipping: {}, coupon_lines: [], fee_lines: [], line_items: [], meta_data: [], payment_method: 'bacs', payment_method_title: 'Bank', transaction_id: 'tx1', customer_note: '',
}) as never
const payments = async (id: string) => s.db.payment.findMany({ where: { orderId: id } })

// [mutation: leave the paid flag set by the update (no receipt), or skip the Payment, or skip the registration]
test('unpaid import then paid update, rate present: ONE Payment with the settlement rate and ONE registration; the order is paid', async () => {
  const { updateExistingWcOrderFromPayload } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const o = await heldOrder()
  registrations.length = 0
  await updateExistingWcOrderFromPayload(o.id, payload(Number(o.wcId), '2026-10-01T10:00:00'))
  const pays = await payments(o.id)
  assert.equal(pays.length, 1)
  assert.equal(Number(pays[0]!.settlementRateToBase), 1.1, 'same day as the order: the order\'s own rate')
  assert.equal(Number(pays[0]!.amount), 100)
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0]!.paymentId, pays[0]!.id)
  assert.equal(registrations[0]!.settlementRateToBase, 1.1)
  assert.ok((await s.db.salesOrder.findUniqueOrThrow({ where: { id: o.id } })).paidAt)
})

// [mutation: drop the paidAt-null claim (a duplicate creates a second Payment), or register on every delivery]
test('a duplicate or retried delivery creates no second Payment and no second registration', async () => {
  const { updateExistingWcOrderFromPayload } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const o = await heldOrder()
  registrations.length = 0
  const p = payload(Number(o.wcId), '2026-10-01T10:00:00')
  await Promise.all([updateExistingWcOrderFromPayload(o.id, p), updateExistingWcOrderFromPayload(o.id, p)])
  await updateExistingWcOrderFromPayload(o.id, p)
  assert.equal((await payments(o.id)).length, 1)
  assert.equal(registrations.length, 1)
})

// [mutation: fall back to the order's rate (or 1) when the payment day has no rate; mark the pending row synced anyway; set paidAt anyway]
test('payment on a later day with NO rate for that day: no Payment, no registration, the order stays unpaid and the pending-FX row stays PENDING; with the rate present the retry records it', async () => {
  const { importWcOrder } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const o = await heldOrder()
  registrations.length = 0
  const log = await s.db.shoppingSyncLog.create({ data: { connector: 'woocommerce', direction: 'FROM_CONNECTOR', status: 'PENDING', entityType: 'SalesOrder', externalId: String(o.wcId), payload: {} } })
  const late = payload(Number(o.wcId), '2026-09-25T10:00:00', '2026-09-20T09:00:00') // the only stored rate is dated 2026-10-01: none on or before the payment day
  const r1 = await importWcOrder(late, { pendingFxRetryLogId: log.id })
  assert.equal(r1.success, false)
  assert.equal((await payments(o.id)).length, 0)
  assert.equal(registrations.length, 0)
  assert.equal((await s.db.salesOrder.findUniqueOrThrow({ where: { id: o.id } })).paidAt, null)
  assert.equal((await s.db.shoppingSyncLog.findUniqueOrThrow({ where: { id: log.id } })).status, 'PENDING')
  await s.db.fxRate.create({ data: { fromCurrency: 'GBP', toCurrency: 'EUR', rate: '1.20', fetchedAt: new Date('2026-09-25T06:00:00Z') } })
  const r2 = await importWcOrder(late, { pendingFxRetryLogId: log.id })
  assert.equal(r2.success, true)
  const pays = await payments(o.id)
  assert.equal(pays.length, 1)
  assert.equal(Number(pays[0]!.settlementRateToBase), 1.2, 'the central rate at the end of the payment day')
  assert.equal(registrations.length, 1)
  assert.equal((await s.db.shoppingSyncLog.findUniqueOrThrow({ where: { id: log.id } })).status, 'SYNCED')
  await importWcOrder(late, {})
  assert.equal((await payments(o.id)).length, 1, 'a duplicate delivery after the retry adds nothing')
})

// [mutation: give a base-currency order a settlement rate, or skip the receipt for it]
test('a base-currency order is unchanged by the rule: one Payment, no settlement rate', async () => {
  const { updateExistingWcOrderFromPayload } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const o = await heldOrder({ currency: 'GBP' })
  registrations.length = 0
  await updateExistingWcOrderFromPayload(o.id, { ...(payload(Number(o.wcId), '2026-10-09T10:00:00') as object), currency: 'GBP' } as never)
  const pays = await payments(o.id)
  assert.equal(pays.length, 1)
  assert.equal(pays[0]!.settlementRateToBase, null)
  assert.equal(registrations[0]!.settlementRateToBase, null)
})

test('an order already paid in IMS, or an unpaid payload, gets no receipt from the update', async () => {
  const { updateExistingWcOrderFromPayload } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const paid = await heldOrder({ paidAt: new Date('2026-10-01T10:00:00Z') })
  const unpaid = await heldOrder()
  registrations.length = 0
  await updateExistingWcOrderFromPayload(paid.id, payload(Number(paid.wcId), '2026-10-01T10:00:00'))
  await updateExistingWcOrderFromPayload(unpaid.id, payload(Number(unpaid.wcId), null))
  assert.equal((await payments(paid.id)).length + (await payments(unpaid.id)).length, 0)
  assert.equal(registrations.length, 0)
})

const addReceipt = (orderId: string, amount: number, currency = 'EUR') => s.db.payment.create({ data: { orderId, amount, currency, method: 'Hand' } })

// [mutation: record the full total regardless of earlier receipts, or sum outside the lock / not at all]
test('partial receipts: an existing 20 on a 100 order leaves ONE new Payment of 80, total exactly 100, marker minted; a duplicate adds nothing', async () => {
  const { updateExistingWcOrderFromPayload } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const o = await heldOrder()
  await addReceipt(o.id, 20)
  registrations.length = 0
  const p = payload(Number(o.wcId), '2026-10-01T10:00:00')
  await Promise.all([updateExistingWcOrderFromPayload(o.id, p), updateExistingWcOrderFromPayload(o.id, p)])
  await updateExistingWcOrderFromPayload(o.id, p)
  const pays = await payments(o.id)
  assert.deepEqual(pays.map((x) => Number(x.amount)).sort((a, b) => a - b), [20, 80])
  assert.equal(registrations.length, 1)
  assert.equal(Number(registrations[0]!.amount), 80)
  const row = await s.db.salesOrder.findUniqueOrThrow({ where: { id: o.id } })
  assert.ok(row.paidAt)
  assert.ok(row.unregisteredPaidAt, 'the receipts do not cover the total before this one, so the episode is minted as the update always did')
})

// [mutation: create a Payment when receipts already cover the total, or skip minting the episode]
test('existing receipts that already cover the total: no new Payment, paid recorded, a new paid episode is minted as before', async () => {
  const { updateExistingWcOrderFromPayload } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const o = await heldOrder()
  await addReceipt(o.id, 60)
  await addReceipt(o.id, 40)
  registrations.length = 0
  await updateExistingWcOrderFromPayload(o.id, payload(Number(o.wcId), '2026-10-01T10:00:00'))
  assert.equal((await payments(o.id)).length, 2)
  assert.equal(registrations.length, 0)
  const row = await s.db.salesOrder.findUniqueOrThrow({ where: { id: o.id } })
  assert.ok(row.paidAt)
  assert.ok(row.unregisteredPaidAt, 'the paid episode starts here whatever receipts exist; only addPayment clears the marker')
})

// [mutation: sum receipts of another currency as if they were the order's]
test('a receipt in another currency is ambiguous: paid recorded, NO new Payment, a named warning', async () => {
  const { updateExistingWcOrderFromPayload } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const o = await heldOrder()
  await addReceipt(o.id, 100, 'GBP')
  registrations.length = 0
  await updateExistingWcOrderFromPayload(o.id, payload(Number(o.wcId), '2026-10-01T10:00:00'))
  assert.equal((await payments(o.id)).length, 1)
  assert.equal(registrations.length, 0)
  assert.ok((await s.db.salesOrder.findUniqueOrThrow({ where: { id: o.id } })).paidAt)
  assert.equal(await s.db.activityLog.count({ where: { entityId: o.id, action: 'wc_paid_transition_ambiguous_receipts' } }), 1)
})
