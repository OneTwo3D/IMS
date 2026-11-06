/**
 * A PAID WooCommerce order whose total or currency disagrees with what IMS holds records no receipt. That must never be a silent acknowledgement: the order poll is a modified-after
 * cursor, so correcting IMS later causes no new delivery. The disagreement leaves a DURABLE, BOUNDED retry row (the pending-FX queue row, replayed by the scheduled run) that
 * is retired only when the receipt is recorded or the order is paid by another route, and a finding an operator sees when the bound is spent. Real scratch database, real importer.
 */
import assert from 'node:assert/strict'
import test, { after, before, mock } from 'node:test'
import { startScratch, type Scratch } from '../../first-load/apply-scratch'
import { backendPid, waitUntilParkedBehind } from '../../helpers/lock-wait-observer'

mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('@/lib/shopping', { namedExports: { enqueueStockSync: async () => {} } })
mock.module('@/lib/notifications', { namedExports: { notify: async () => {} } })

const registrations: Array<Record<string, unknown>> = []
mock.module('@/lib/domain/accounting/invoice-payment-enqueue', { namedExports: { registerInvoicePaymentWithLedger: async (p: Record<string, unknown>) => { registrations.push(p); return null } } })

let s: Scratch
let seq = 0
/** Runs once, between the retry's SELECT of the row and its replay of the snapshot: where a newer delivery can land. */
let betweenSelectAndReplay: { wcId: number; run: () => Promise<void> } | null = null
before(async () => {
  s = await startScratch('ims-wc-paid-block')
  const actualWithdrawal = await import('@/lib/connectors/woocommerce/sync/withdrawal')
  mock.module('@/lib/connectors/woocommerce/sync/withdrawal', {
    namedExports: { ...actualWithdrawal, importWcOrderGuarded: async (...a: Parameters<typeof actualWithdrawal.importWcOrderGuarded>) => { const hook = betweenSelectAndReplay; if (hook && (a[0] as { id: number }).id === hook.wcId) { betweenSelectAndReplay = null; await hook.run() } return actualWithdrawal.importWcOrderGuarded(...a) } },
  })
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

// [mutation: drop the snapshot-version comparison under the lock / compare only the status / compute the version from the row id]
test('RACE: the retry selects the row, a NEWER paid delivery rewrites it, the retry resumes: it records NO receipt for the old total; the next run uses the new total', async () => {
  const oi = await import('@/lib/connectors/woocommerce/sync/order-import')
  const o = await heldOrder()
  registrations.length = 0
  await oi.importWcOrder(payload(o.wcId, '120.00'), {})
  // IMS is corrected to the first delivery's total, so replaying THAT snapshot would now record
  await s.db.salesOrder.update({ where: { id: o.id }, data: { subtotalForeign: '120', totalForeign: '120' } })
  betweenSelectAndReplay = { wcId: o.wcId, run: async () => { await oi.importWcOrder(payload(o.wcId, '130.00'), {}) } } // the newer webhook, after the retry's select
  const first = await oi.retryPendingWcOrdersWaitingForFx(50, { receiptsOnly: true })
  assert.equal(first.imported, 0)
  assert.equal((await payments(o.id)).length, 0, 'no receipt for the old total')
  assert.equal(registrations.length, 0)
  assert.equal((await s.db.salesOrder.findUniqueOrThrow({ where: { id: o.id } })).paidAt, null)
  const row = (await rows(o.wcId))[0]!
  assert.equal(row.status, 'PENDING', 'the row is left for the next run')
  assert.equal((row.payload as { order: { total: string } }).order.total, '130.00', 'and it holds the newer snapshot')
  // IMS is corrected to the new total: the next run records THAT
  await s.db.salesOrder.update({ where: { id: o.id }, data: { subtotalForeign: '130', totalForeign: '130' } })
  const next = await oi.retryPendingWcOrdersWaitingForFx(50, { receiptsOnly: true })
  assert.equal(next.imported, 1)
  const pays = await payments(o.id)
  assert.equal(pays.length, 1)
  assert.equal(Number(pays[0]!.amount), 130)
  assert.equal((await rows(o.wcId))[0]!.status, 'SYNCED')
})

// [mutation: rewrite the row in the registration-failure catch from the caller's snapshot alone (marker dropped) / resurrect a FAILED marked row]
test('an UNRELATED failure straight after the mismatch commits (the receipt re-drive throws) leaves the paid-block marker: the scheduled run still replays the row and records the receipt', async () => {
  const oi = await import('@/lib/connectors/woocommerce/sync/order-import')
  const seams = (await import('@/lib/domain/accounting/receipt-registration-sweep')).receiptRegistrationSeams
  const o = await heldOrder()
  registrations.length = 0
  let armed = true
  seams.beforeRedrive = async () => { if (armed) { armed = false; throw new Error('transient read failure after the mismatch committed') } }
  try {
    const first = await oi.importWcOrder(payload(o.wcId, '160.00'), {})
    assert.equal(first.success, false, 'the re-drive failure is reported')
  } finally { seams.beforeRedrive = undefined }
  const row = (await rows(o.wcId))[0]!
  assert.equal(row.status, 'PENDING')
  assert.equal(paidBlock(row)?.kind, 'total', 'the marker survived the rewrite')
  assert.equal((row.payload as { order: { total: string } }).order.total, '160.00')
  assert.equal((await rows(o.wcId)).length, 1)
  await s.db.salesOrder.update({ where: { id: o.id }, data: { subtotalForeign: '160', totalForeign: '160' } })
  const run = await oi.retryPendingWcOrdersWaitingForFx(50, { receiptsOnly: true })
  assert.ok(run.imported >= 1)
  const pays = await payments(o.id)
  assert.equal(pays.length, 1)
  assert.equal(Number(pays[0]!.amount), 160)
  assert.equal((await rows(o.wcId))[0]!.status, 'SYNCED')
})

// [mutation: fail the row on any exception / drop the attempt count]
test('an exception while replaying a marked row keeps it PENDING and counts the attempt; it is failed only when the bound is spent', async () => {
  const oi = await import('@/lib/connectors/woocommerce/sync/order-import')
  const seams = (await import('@/lib/domain/accounting/receipt-registration-sweep')).receiptRegistrationSeams
  const o = await heldOrder()
  await oi.importWcOrder(payload(o.wcId, '170.00'), {})
  const failOnce = async () => { let armed = true; seams.afterPlan = async (orderId: string) => { if (armed && orderId === o.id) { armed = false; throw new Error('boom') } } }
  try {
    await failOnce()
    await oi.retryPendingWcOrdersWaitingForFx(50, { receiptsOnly: true })
  } finally { seams.afterPlan = undefined }
  let row = (await rows(o.wcId))[0]!
  assert.equal(row.status, 'PENDING', 'an unrelated exception does not fail a receipt obligation')
  assert.equal(paidBlock(row)?.attempts, 1)
  assert.match(row.errorMessage ?? '', /boom/)
  // at the last permitted attempt the same exception retires it
  await s.db.shoppingSyncLog.update({ where: { id: row.id }, data: { payload: { ...(row.payload as object), paidBlock: { kind: 'total', attempts: oi.WC_PAID_BLOCK_MAX_ATTEMPTS - 1, firstAt: '2026-10-01T00:00:00.000Z' } } } })
  try {
    await failOnce()
    await oi.retryPendingWcOrdersWaitingForFx(50, { receiptsOnly: true })
  } finally { seams.afterPlan = undefined }
  row = (await rows(o.wcId))[0]!
  assert.equal(row.status, 'FAILED')
  // exhaustion on the exception path goes through the SAME terminal announcement as the mismatch path
  const finding = await s.db.activityLog.findMany({ where: { entityId: o.id, action: 'wc_paid_block_retry_gave_up' } })
  assert.equal(finding.length, 1, 'the operator is told')
  assert.equal(finding[0]!.level, 'ERROR')
  assert.match(row.errorMessage ?? '', /gave up/)
})

async function unmarkedQueueRow(o: { id: string; wcId: number }) {
  const unpaid = { ...(payload(o.wcId, '100.00') as object), date_paid_gmt: null }
  return s.db.shoppingSyncLog.create({ data: { connector: 'woocommerce', direction: 'FROM_CONNECTOR', status: 'PENDING', entityType: 'SalesOrder', externalId: String(o.wcId), payload: { reason: 'missing_fx_rate', connector: 'woocommerce', externalOrderId: String(o.wcId), externalOrderNumber: String(o.wcId), currency: 'GBP', asOf: null, order: unpaid } } })
}

// [mutation: drop the order lock around the queue-row rewrite]
test('RACE (lock): a rewrite of an UNMARKED queue row holds the order lock between its read and its write; a webhook writing the marker waits for it and the marker survives', async () => {
  const oi = await import('@/lib/connectors/woocommerce/sync/order-import')
  const seams = (await import('@/lib/domain/accounting/receipt-registration-sweep')).receiptRegistrationSeams
  const o = await heldOrder()
  const log = await unmarkedQueueRow(o)
  let armed = true
  let webhook: Promise<unknown> | undefined
  seams.beforeRedrive = async () => { throw new Error('re-drive failed, so the row is rewritten') }
  seams.betweenQueueReadAndWrite = async (tx) => {
    if (!armed) return
    armed = false
    const holder = await backendPid(tx as never)
    seams.beforeRedrive = undefined
    webhook = oi.importWcOrder(payload(o.wcId, '120.00'), {}) // a paid delivery that disagrees: writes the marker under the order lock
    await waitUntilParkedBehind(s.db, { holderPid: holder, waitingOn: /sales_orders/i, describe: 'paid-block writer behind the queue-row rewrite\'s order lock' })
  }
  try {
    await oi.importWcOrder({ ...(payload(o.wcId, '100.00') as object), date_paid_gmt: null } as never, { pendingFxRetryLogId: log.id, receiptPaymentId: 'p-x' })
    await webhook
  } finally { seams.beforeRedrive = undefined; seams.betweenQueueReadAndWrite = undefined }
  const all = await rows(o.wcId)
  assert.equal(all.length, 1)
  assert.equal(paidBlock(all[0]!)?.kind, 'total', 'the marker the webhook wrote survived the rewrite')
})

// [mutation: drop the conditional on the rewrite (WHERE the payload is still the one read)]
test('RACE (conditional): a writer that takes NO lock lands the marker between the rewrite\'s read and write; the rewrite re-reads, merges and keeps it', async () => {
  const oi = await import('@/lib/connectors/woocommerce/sync/order-import')
  const seams = (await import('@/lib/domain/accounting/receipt-registration-sweep')).receiptRegistrationSeams
  const o = await heldOrder()
  const log = await unmarkedQueueRow(o)
  let armed = true
  seams.beforeRedrive = async () => { throw new Error('re-drive failed, so the row is rewritten') }
  seams.betweenQueueReadAndWrite = async () => {
    if (!armed) return
    armed = false
    const row = await s.db.shoppingSyncLog.findUniqueOrThrow({ where: { id: log.id } })
    await s.db.shoppingSyncLog.update({ where: { id: log.id }, data: { payload: { ...(row.payload as object), paidBlock: { kind: 'total', attempts: 0, firstAt: '2026-10-01T00:00:00.000Z' } } } })
  }
  try {
    await oi.importWcOrder({ ...(payload(o.wcId, '100.00') as object), date_paid_gmt: null } as never, { pendingFxRetryLogId: log.id, receiptPaymentId: 'p-x' })
  } finally { seams.beforeRedrive = undefined; seams.betweenQueueReadAndWrite = undefined }
  const row = (await rows(o.wcId))[0]!
  assert.equal(paidBlock(row)?.kind, 'total', 'the marker written meanwhile was not overwritten')
  assert.equal(row.status, 'PENDING')
})
