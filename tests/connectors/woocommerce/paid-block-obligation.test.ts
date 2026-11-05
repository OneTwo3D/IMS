/**
 * A PAID WooCommerce order whose total or currency disagrees with what IMS holds records no receipt. That must never be a silent acknowledgement: the order poll is a modified-after
 * cursor, so correcting IMS later causes no new delivery. The disagreement leaves a DURABLE, BOUNDED retry row (the pending-FX queue row, replayed by the scheduled run) that
 * is retired only when the receipt is recorded or the order is paid by another route, and a finding an operator sees when the bound is spent. Real scratch database, real importer.
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
  s = await startScratch('ims-wc-paid-block')
  await s.sql('truncate fx_rates')
})
after(async () => { await s?.stop() })

async function heldOrder(currency = 'GBP') {
  const n = ++seq
  const o = await s.db.salesOrder.create({ data: { currency, fxRateToBase: '1', subtotalForeign: '100', totalForeign: '100', subtotalBase: '100', totalBase: '100', paidAt: null, externalCreatedAt: new Date('2026-10-01T09:00:00Z'), shoppingLinks: { create: { connector: 'woocommerce', externalOrderId: `8${n}` } } }, select: { id: true } })
  return { id: o.id, wcId: Number(`8${n}`) }
}
const payload = (wcId: number, total: string, currency = 'GBP') => ({
  id: wcId, number: String(wcId), order_key: 'k', status: 'processing', currency, total, date_created_gmt: '2026-10-01T09:00:00', date_paid_gmt: '2026-10-01T10:00:00',
  billing: {}, shipping: {}, coupon_lines: [], fee_lines: [], line_items: [], meta_data: [], payment_method: 'bacs', payment_method_title: 'Bank', transaction_id: 'tx1', customer_note: '',
}) as never
const payments = (id: string) => s.db.payment.findMany({ where: { orderId: id } })
const rows = (wcId: number) => s.db.shoppingSyncLog.findMany({ where: { externalId: String(wcId) }, orderBy: { createdAt: 'asc' } })
const paidBlock = (row: { payload: unknown }) => (row.payload as { paidBlock?: { kind: string; attempts: number } }).paidBlock

// [mutation: return without writing the obligation row / write the row outside the lock-holding transaction / retire it in the caller]
test('a paid delivery whose total differs is ACKNOWLEDGED with a durable pending row; correcting the IMS total with NO further delivery records the receipt on the scheduled retry', async () => {
  const oi = await import('@/lib/connectors/woocommerce/sync/order-import')
  const o = await heldOrder()
  registrations.length = 0
  const delivered = payload(o.wcId, '120.00')
  const first = await oi.importWcOrder(delivered, {})
  assert.equal(first.success, true, 'the delivery itself is acknowledged')
  assert.equal((await payments(o.id)).length, 0)
  const pending = await rows(o.wcId)
  assert.equal(pending.length, 1, 'one obligation row')
  assert.equal(pending[0]!.status, 'PENDING')
  assert.equal(paidBlock(pending[0]!)?.kind, 'total')
  // the same disagreement delivered again does not stack rows
  await oi.importWcOrder(delivered, {})
  assert.equal((await rows(o.wcId)).length, 1)
  // while IMS still disagrees the scheduled retry keeps the row PENDING and counts the attempt
  const still = await oi.retryPendingWcOrdersWaitingForFx(50, { receiptsOnly: true })
  assert.equal(still.stillPending, 1)
  const afterStill = (await rows(o.wcId))[0]!
  assert.equal(afterStill.status, 'PENDING', 'a retry of a still-mismatched order never retires the row')
  assert.equal(paidBlock(afterStill)?.attempts, 1)
  assert.equal((await payments(o.id)).length, 0)
  // IMS is corrected; WooCommerce delivers nothing more
  await s.db.salesOrder.update({ where: { id: o.id }, data: { subtotalForeign: '120', totalForeign: '120' } })
  const done = await oi.retryPendingWcOrdersWaitingForFx(50, { receiptsOnly: true })
  assert.equal(done.imported, 1)
  const pays = await payments(o.id)
  assert.equal(pays.length, 1)
  assert.equal(Number(pays[0]!.amount), 120)
  assert.equal(registrations.length, 1)
  assert.ok((await s.db.salesOrder.findUniqueOrThrow({ where: { id: o.id } })).paidAt)
  assert.equal((await rows(o.wcId)).filter((r) => r.status === 'PENDING').length, 0, 'the obligation is retired only now')
  assert.equal((await rows(o.wcId))[0]!.status, 'SYNCED')
})

// [mutation: let the caller mark the retry row SYNCED after a blocked update]
test('a retry row for a still-mismatched paid order is NOT marked SYNCED by the importer', async () => {
  const oi = await import('@/lib/connectors/woocommerce/sync/order-import')
  const o = await heldOrder()
  const log = await s.db.shoppingSyncLog.create({ data: { connector: 'woocommerce', direction: 'FROM_CONNECTOR', status: 'PENDING', entityType: 'SalesOrder', externalId: String(o.wcId), payload: {} } })
  const r = await oi.importWcOrder(payload(o.wcId, '130.00'), { pendingFxRetryLogId: log.id })
  assert.equal(r.success, false)
  assert.match(r.error ?? '', /kept in the retry queue/)
  const row = await s.db.shoppingSyncLog.findUniqueOrThrow({ where: { id: log.id } })
  assert.equal(row.status, 'PENDING')
  assert.equal(paidBlock(row)?.kind, 'total')
  assert.equal((await rows(o.wcId)).length, 1, 'the retry row is updated in place')
})

// [mutation: skip the currency branch's obligation write]
test('a currency disagreement is durable the same way, and an order paid by another route retires its row without a second receipt', async () => {
  const oi = await import('@/lib/connectors/woocommerce/sync/order-import')
  const o = await heldOrder('EUR')
  await oi.importWcOrder(payload(o.wcId, '100.00', 'USD'), {})
  const r = (await rows(o.wcId))[0]!
  assert.equal(r.status, 'PENDING')
  assert.equal(paidBlock(r)?.kind, 'currency')
  // an operator records the payment by hand and the order is marked paid
  await s.db.payment.create({ data: { orderId: o.id, amount: 100, currency: 'EUR', method: 'Hand' } })
  await s.db.salesOrder.update({ where: { id: o.id }, data: { paidAt: new Date('2026-10-02T10:00:00Z') } })
  await oi.retryPendingWcOrdersWaitingForFx(50, { receiptsOnly: true })
  assert.equal((await rows(o.wcId))[0]!.status, 'SYNCED')
  assert.equal((await payments(o.id)).length, 1, 'no second receipt')
})

// [mutation: remove the bound / compare with > instead of >= / do not retire FAILED / skip the finding]
test('BOUNDED: after the last permitted retry the row is retired FAILED and an ERROR finding names the order', async () => {
  const oi = await import('@/lib/connectors/woocommerce/sync/order-import')
  const o = await heldOrder()
  await oi.importWcOrder(payload(o.wcId, '140.00'), {})
  const row = (await rows(o.wcId))[0]!
  const p = row.payload as Record<string, unknown>
  await s.db.shoppingSyncLog.update({ where: { id: row.id }, data: { payload: { ...p, paidBlock: { kind: 'total', attempts: oi.WC_PAID_BLOCK_MAX_ATTEMPTS - 2, firstAt: '2026-10-01T00:00:00.000Z' } } } })
  await oi.retryPendingWcOrdersWaitingForFx(50, { receiptsOnly: true })
  let now = (await rows(o.wcId))[0]!
  assert.equal(now.status, 'PENDING', 'one retry left')
  assert.equal(paidBlock(now)?.attempts, oi.WC_PAID_BLOCK_MAX_ATTEMPTS - 1)
  assert.equal(await s.db.activityLog.count({ where: { entityId: o.id, action: 'wc_paid_block_retry_gave_up' } }), 0)
  await oi.retryPendingWcOrdersWaitingForFx(50, { receiptsOnly: true })
  now = (await rows(o.wcId))[0]!
  assert.equal(now.status, 'FAILED')
  assert.match(now.errorMessage ?? '', /gave up/)
  const finding = await s.db.activityLog.findMany({ where: { entityId: o.id, action: 'wc_paid_block_retry_gave_up' } })
  assert.equal(finding.length, 1)
  assert.equal(finding[0]!.level, 'ERROR')
  const stamp = (await rows(o.wcId))[0]!.syncedAt?.getTime()
  await oi.retryPendingWcOrdersWaitingForFx(50, { receiptsOnly: true })
  const kept = (await rows(o.wcId))[0]!
  assert.equal(kept.status, 'FAILED', 'a FAILED row is not retried')
  assert.equal(kept.syncedAt?.getTime(), stamp)
})

// [mutation: read the existing row outside the lock / create without looking for the existing row]
test('CONCURRENT deliveries of the same mismatched paid order leave exactly one obligation row', async () => {
  const oi = await import('@/lib/connectors/woocommerce/sync/order-import')
  const o = await heldOrder()
  const delivered = payload(o.wcId, '150.00')
  await Promise.all([1, 2, 3, 4, 5, 6].map(() => oi.importWcOrder(delivered, {})))
  const all = await rows(o.wcId)
  assert.equal(all.length, 1)
  assert.equal(all[0]!.status, 'PENDING')
})
