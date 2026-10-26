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

async function heldOrder(opts: { currency?: string; paidAt?: Date | null; externalCreatedAt?: Date | null } = {}) {
  const n = ++seq
  const o = await s.db.salesOrder.create({ data: { currency: opts.currency ?? 'EUR', fxRateToBase: '1.1', subtotalForeign: '100', totalForeign: '100', subtotalBase: '90.9091', totalBase: '90.9091', paidAt: opts.paidAt ?? null, externalCreatedAt: opts.externalCreatedAt === undefined ? new Date('2026-10-01T09:00:00Z') : opts.externalCreatedAt, shoppingLinks: { create: { connector: 'woocommerce', externalOrderId: `9${n}` } } }, select: { id: true } })
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

// The registration obligation is durable: a registration that does not reach the record is retried, once, and the pending-FX row is not retired meanwhile.
// [mutation: mark the pending row synced without the proof; skip the redrive for an already-paid order; drop the throw]
test('registration not on record: the pending-FX row stays PENDING, a later delivery registers the SAME receipt again (one Payment), and only then is the row synced', async () => {
  const oi = await import('@/lib/connectors/woocommerce/sync/order-import')
  const o = await heldOrder()
  registrations.length = 0
  const log = await s.db.shoppingSyncLog.create({ data: { connector: 'woocommerce', direction: 'FROM_CONNECTOR', status: 'PENDING', entityType: 'SalesOrder', externalId: String(o.wcId), payload: {} } })
  const p = payload(Number(o.wcId), '2026-10-01T10:00:00')
  const real = oi.wcReceiptRegistrationSeams.obligationIsOnRecord
  oi.wcReceiptRegistrationSeams.obligationIsOnRecord = async () => false
  try {
    const r1 = await oi.importWcOrder(p, { pendingFxRetryLogId: log.id })
    assert.equal(r1.success, false)
    assert.equal((await s.db.shoppingSyncLog.findUniqueOrThrow({ where: { id: log.id } })).status, 'PENDING', 'not retired while the obligation is not on record')
    assert.equal((await payments(o.id)).length, 1, 'the receipt is stored once')
    assert.equal(registrations.length, 1)
    const r2 = await oi.importWcOrder(p, { pendingFxRetryLogId: log.id })
    assert.equal(r2.success, false, 'the order is already paid, yet the redelivery re-attempts the registration')
    assert.equal(registrations.length, 2)
    assert.equal(registrations[1]!.paymentId, registrations[0]!.paymentId, 'the SAME receipt, so the enqueue key makes it once')
  } finally { oi.wcReceiptRegistrationSeams.obligationIsOnRecord = real }
  // evidence appears (here: the real probe finds nothing owed because the test order has no posted invoice)
  const r3 = await oi.importWcOrder(p, { pendingFxRetryLogId: log.id })
  assert.equal(r3.success, true)
  assert.equal((await s.db.shoppingSyncLog.findUniqueOrThrow({ where: { id: log.id } })).status, 'SYNCED')
  assert.equal((await payments(o.id)).length, 1)
  assert.equal(registrations.length, 2, 'once the obligation is on record nothing is registered again')
})

// [mutation: treat an order with no posted invoice as owing evidence]
test('the evidence probe: an order with no posted invoice owes nothing yet (the invoice post\'s deferred pass registers its receipts)', async () => {
  const oi = await import('@/lib/connectors/woocommerce/sync/order-import')
  const o = await heldOrder()
  assert.equal(await oi.wcReceiptRegistrationSeams.obligationIsOnRecord(o.id, 'any'), true)
})

// ONCE A PAYMENT IS COMMITTED, ANY failure of the registration or its proof is a retryable receipt obligation: the row stays PENDING (never FAILED), names the paymentId, and the
// scheduled FX-refresh retry (lib/currencies/fx-refresh.ts -> retryPendingWcOrdersWaitingForFx, run by app/api/cron/fx-rates) re-drives that receipt once.
// [mutation: let a generic error reach the FAILED catch; drop the paymentId from the queue row; drop the by-id redrive]
test('a GENERIC failure in the proof keeps the pending-FX row PENDING with the paymentId; the scheduled retry registers that receipt exactly once', async () => {
  const oi = await import('@/lib/connectors/woocommerce/sync/order-import')
  const o = await heldOrder()
  registrations.length = 0
  const log = await s.db.shoppingSyncLog.create({ data: { connector: 'woocommerce', direction: 'FROM_CONNECTOR', status: 'PENDING', entityType: 'SalesOrder', externalId: String(o.wcId), payload: {} } })
  const p = payload(Number(o.wcId), '2026-10-01T10:00:00')
  const real = oi.wcReceiptRegistrationSeams.obligationIsOnRecord
  oi.wcReceiptRegistrationSeams.obligationIsOnRecord = async () => { throw new Error('transient database read failure') }
  try {
    const r1 = await oi.importWcOrder(p, { pendingFxRetryLogId: log.id })
    assert.equal(r1.success, false)
  } finally { oi.wcReceiptRegistrationSeams.obligationIsOnRecord = real }
  const pays = await payments(o.id)
  assert.equal(pays.length, 1)
  const row = await s.db.shoppingSyncLog.findUniqueOrThrow({ where: { id: log.id } })
  assert.equal(row.status, 'PENDING', 'never FAILED')
  assert.equal((row.payload as { receiptPaymentId?: string }).receiptPaymentId, pays[0]!.id)
  const before = registrations.filter((r) => r.paymentId === pays[0]!.id).length
  // the evidence appears once the receipt has been registered a second time (the retry)
  oi.wcReceiptRegistrationSeams.obligationIsOnRecord = async (_order: string, paymentId: string) => registrations.filter((r) => r.paymentId === paymentId).length >= before + 1
  const swept = await oi.retryPendingWcOrdersWaitingForFx()
  assert.ok(swept.attempted >= 1)
  assert.equal((await s.db.shoppingSyncLog.findUniqueOrThrow({ where: { id: log.id } })).status, 'SYNCED')
  assert.equal((await payments(o.id)).length, 1, 'still one Payment')
  assert.equal(registrations.filter((r) => r.paymentId === pays[0]!.id).length, before + 1, 'the scheduled retry registered the receipt once')
  await oi.retryPendingWcOrdersWaitingForFx()
  assert.equal(registrations.filter((r) => r.paymentId === pays[0]!.id).length, before + 1, 'and not again')
  oi.wcReceiptRegistrationSeams.obligationIsOnRecord = real
})

// [mutation: drop the receiptsOnly retry from the cron route / ignore the receipt filter]
test('the scheduled fx-rates run retries a receipt obligation even when NO currency updated, and leaves rate-waiting rows alone', async () => {
  const oi = await import('@/lib/connectors/woocommerce/sync/order-import')
  const o = await heldOrder()
  registrations.length = 0
  const log = await s.db.shoppingSyncLog.create({ data: { connector: 'woocommerce', direction: 'FROM_CONNECTOR', status: 'PENDING', entityType: 'SalesOrder', externalId: String(o.wcId), payload: {} } })
  const waiting = await s.db.shoppingSyncLog.create({ data: { connector: 'woocommerce', direction: 'FROM_CONNECTOR', status: 'PENDING', entityType: 'SalesOrder', externalId: '8888888', payload: { reason: 'missing_fx_rate', connector: 'woocommerce', externalOrderId: '8888888', externalOrderNumber: '8888888', currency: 'EUR', asOf: null, order: { id: 8888888 } } } })
  const p = payload(Number(o.wcId), '2026-10-01T10:00:00')
  const real = oi.wcReceiptRegistrationSeams.obligationIsOnRecord
  oi.wcReceiptRegistrationSeams.obligationIsOnRecord = async () => { throw new Error('transient') }
  try { await oi.importWcOrder(p, { pendingFxRetryLogId: log.id }) } finally { oi.wcReceiptRegistrationSeams.obligationIsOnRecord = real }
  assert.equal((await s.db.shoppingSyncLog.findUniqueOrThrow({ where: { id: log.id } })).status, 'PENDING')
  const paymentId = (await payments(o.id))[0]!.id
  const before = registrations.filter((r) => r.paymentId === paymentId).length
  oi.wcReceiptRegistrationSeams.obligationIsOnRecord = async (_o: string, pid: string) => registrations.filter((r) => r.paymentId === pid).length >= before + 1
  // The cron route runs this on EVERY run, independent of the rate refresh's outcome (pinned from source: the route's run() calls it unconditionally after the refresh).
  const { readFileSync } = await import('node:fs')
  const route = readFileSync('app/api/cron/fx-rates/route.ts', 'utf8')
  assert.match(route, /retryPendingWcOrdersWaitingForFx\(50, \{ receiptsOnly: true \}\)/)
  assert.ok(route.indexOf('fetchAllFxRatesInternal()') < route.indexOf('receiptsOnly'), 'after the refresh, not inside a branch of it')
  assert.ok(!/if \([^)]*updated/.test(route.slice(route.indexOf('receiptsOnly') - 600, route.indexOf('receiptsOnly'))), 'not conditional on a rate update')
  const result = await oi.retryPendingWcOrdersWaitingForFx(50, { receiptsOnly: true })
  oi.wcReceiptRegistrationSeams.obligationIsOnRecord = real
  assert.equal(result.attempted, 1, 'only the receipt obligation, not the rate-waiting row')
  assert.equal((await s.db.shoppingSyncLog.findUniqueOrThrow({ where: { id: log.id } })).status, 'SYNCED')
  assert.equal((await s.db.shoppingSyncLog.findUniqueOrThrow({ where: { id: waiting.id } })).status, 'PENDING')
  assert.equal(registrations.filter((r) => r.paymentId === paymentId).length, before + 1)
})

// Two retries both plan unpaid -> paid. A commits the Payment and its registration fails (the row names the receipt); B (planned before A committed) loses the locked claim.
// B must NOT retire the row on a receipt that has no obligation on record. [mutation: skip the redrive after a lost claim; mark SYNCED without the proof]
test('A/B interleaving: B loses the claim after A recorded a failed registration; the row stays PENDING until the receipt is proven, then a sweep registers it exactly once', async () => {
  const oi = await import('@/lib/connectors/woocommerce/sync/order-import')
  const o = await heldOrder()
  registrations.length = 0
  const log = await s.db.shoppingSyncLog.create({ data: { connector: 'woocommerce', direction: 'FROM_CONNECTOR', status: 'PENDING', entityType: 'SalesOrder', externalId: String(o.wcId), payload: {} } })
  const p = payload(Number(o.wcId), '2026-10-01T10:00:00')
  const real = oi.wcReceiptRegistrationSeams.obligationIsOnRecord
  const everFalse = async () => false
  let ranA = false
  oi.wcReceiptRegistrationSeams.afterPlan = async () => {
    if (ranA) return
    ranA = true
    // A runs completely (plan, claim, Payment, a registration that does not reach the record) in the window between B's plan and B's claim.
    oi.wcReceiptRegistrationSeams.obligationIsOnRecord = everFalse
    await oi.importWcOrder(p, { pendingFxRetryLogId: log.id })
  }
  try {
    // B: its plan said 'record'; by its claim A has committed. The proof is still false (A's registration is not on record): B must not retire the row.
    const b = await oi.importWcOrder(p, { pendingFxRetryLogId: log.id })
    assert.equal(b.success, false)
  } finally { oi.wcReceiptRegistrationSeams.afterPlan = undefined }
  assert.equal((await payments(o.id)).length, 1, 'one Payment: B lost the claim')
  const row = await s.db.shoppingSyncLog.findUniqueOrThrow({ where: { id: log.id } })
  assert.equal(row.status, 'PENDING')
  const paymentId = (await payments(o.id))[0]!.id
  assert.equal((row.payload as { receiptPaymentId?: string }).receiptPaymentId, paymentId)
  // the evidence appears once the receipt has been registered again: the next sweep does that, exactly once
  const before = registrations.filter((r) => r.paymentId === paymentId).length
  oi.wcReceiptRegistrationSeams.obligationIsOnRecord = async (_o: string, pid: string) => registrations.filter((r) => r.paymentId === pid).length > before
  await oi.retryPendingWcOrdersWaitingForFx()
  assert.equal((await s.db.shoppingSyncLog.findUniqueOrThrow({ where: { id: log.id } })).status, 'SYNCED')
  assert.equal(registrations.filter((r) => r.paymentId === paymentId).length, before + 1)
  await oi.retryPendingWcOrdersWaitingForFx()
  assert.equal(registrations.filter((r) => r.paymentId === paymentId).length, before + 1)
  oi.wcReceiptRegistrationSeams.obligationIsOnRecord = real
})

// A process that stops after the Payment commits must leave the obligation with it. [mutation: write the obligation row outside the transaction / not at all]
test('crash between the Payment commit and the registration: the obligation row was written by the Payment\'s own transaction', async () => {
  const oi = await import('@/lib/connectors/woocommerce/sync/order-import')
  const o = await heldOrder()
  registrations.length = 0
  oi.wcReceiptRegistrationSeams.afterReceiptCommit = async () => { throw new Error('process stopped') }
  try { await assert.rejects(oi.updateExistingWcOrderFromPayload(o.id, payload(Number(o.wcId), '2026-10-01T10:00:00')), /process stopped/) } finally { oi.wcReceiptRegistrationSeams.afterReceiptCommit = undefined }
  const pays = await payments(o.id)
  assert.equal(pays.length, 1)
  assert.equal(registrations.length, 0, 'nothing registered: the crash came first')
  const row = await s.db.shoppingSyncLog.findFirst({ where: { connector: 'woocommerce', externalId: String(o.wcId), status: 'PENDING', entityId: null } })
  assert.ok(row, 'a PENDING obligation row exists, no catch ever ran')
  assert.equal((row!.payload as { receiptPaymentId?: string }).receiptPaymentId, pays[0]!.id)
  // and the scheduled retry then registers it once and retires the row
  const before = registrations.length
  await oi.retryPendingWcOrdersWaitingForFx(50, { receiptsOnly: true })
  assert.equal((await s.db.shoppingSyncLog.findUniqueOrThrow({ where: { id: row!.id } })).status, 'SYNCED')
  assert.ok(registrations.length >= before)
})

// [mutation: create the row after the transaction]
test('the obligation row and the Payment are ONE transaction: a failure inside it leaves neither, and the order unpaid', async () => {
  const oi = await import('@/lib/connectors/woocommerce/sync/order-import')
  const o = await heldOrder()
  oi.wcReceiptRegistrationSeams.insideReceiptTransaction = async () => { throw new Error('abort inside') }
  try { await assert.rejects(oi.updateExistingWcOrderFromPayload(o.id, payload(Number(o.wcId), '2026-10-01T10:00:00')), /abort inside/) } finally { oi.wcReceiptRegistrationSeams.insideReceiptTransaction = undefined }
  assert.equal((await payments(o.id)).length, 0)
  assert.equal(await s.db.shoppingSyncLog.count({ where: { externalId: String(o.wcId) } }), 0)
  assert.equal((await s.db.salesOrder.findUniqueOrThrow({ where: { id: o.id } })).paidAt, null)
})

// [mutation: drop the sweep from the cron route / select receipts regardless of the posted invoice / ignore the on-record probe]
test('the scheduled orphan sweep finds a stored WooCommerce receipt with no obligation on record and registers it exactly once', async () => {
  const oi = await import('@/lib/connectors/woocommerce/sync/order-import')
  const o = await heldOrder()
  await s.db.salesOrder.update({ where: { id: o.id }, data: { accountingInvoiceId: `INV-${o.id}`, paidAt: new Date('2026-10-01T10:00:00Z') } })
  const orphan = await s.db.payment.create({ data: { orderId: o.id, amount: 100, currency: 'EUR', method: 'Bank', notes: 'Recorded from WooCommerce (the order was imported unpaid and paid later)', settlementRateToBase: 1.1 } })
  const noInvoice = await heldOrder()
  const early = await s.db.payment.create({ data: { orderId: noInvoice.id, amount: 100, currency: 'EUR', notes: 'Recorded from WooCommerce (x)' } })
  await s.sql(`update payments set "createdAt" = now() - interval '1 hour' where id = $1`, [orphan.id])
  await s.sql(`update payments set "createdAt" = now() - interval '1 hour' where id = $1`, [early.id])
  registrations.length = 0
  const real = oi.wcReceiptRegistrationSeams.obligationIsOnRecord
  oi.wcReceiptRegistrationSeams.obligationIsOnRecord = async (_o: string, pid: string) => registrations.filter((r) => r.paymentId === pid).length > 0
  oi.wcReceiptRegistrationSeams.registrationsAreOwed = async () => true
  try {
    const r1 = await (await import('@/lib/domain/accounting/receipt-registration-sweep')).sweepUnregisteredReceipts()
    assert.ok(r1.registered >= 1)
    assert.equal(registrations.filter((r) => r.paymentId === orphan.id).length, 1)
    assert.equal(registrations.filter((r) => r.paymentId === early.id).length, 0, 'an order with no posted invoice is not the sweep\'s (the invoice post registers it)')
    await (await import('@/lib/domain/accounting/receipt-registration-sweep')).sweepUnregisteredReceipts()
    assert.equal(registrations.filter((r) => r.paymentId === orphan.id).length, 1, 'not again')
  } finally { oi.wcReceiptRegistrationSeams.obligationIsOnRecord = real; oi.wcReceiptRegistrationSeams.registrationsAreOwed = undefined }
  const route = (await import('node:fs')).readFileSync('app/api/cron/fx-rates/route.ts', 'utf8')
  assert.match(route, /sweepUnregisteredReceipts\(50\)/)
})

// STARVATION: a bounded batch must not be filled by rows that cannot make progress or need nothing.
// [mutation: apply the limit before the filter (newest 50 eligible); order the batch without the last-attempt rotation]
test('the sweep selects only unrecorded receipts BEFORE the limit: 50 registered newer receipts do not hide an older unresolved one', async () => {
  const oi = await import('@/lib/connectors/woocommerce/sync/order-import')
  const holder = await heldOrder()
  await s.db.salesOrder.update({ where: { id: holder.id }, data: { accountingInvoiceId: `INV-${holder.id}`, paidAt: new Date('2026-10-01T10:00:00Z') } })
  const unresolved = await s.db.payment.create({ data: { orderId: holder.id, amount: 1, currency: 'EUR', notes: 'Recorded from WooCommerce (x)' } })
  const registered: string[] = []
  for (let i = 0; i < 55; i++) {
    const p = await s.db.payment.create({ data: { orderId: holder.id, amount: 1, currency: 'EUR', notes: 'Recorded from WooCommerce (y)' } })
    registered.push(p.id)
    await s.db.accountingSyncLog.create({ data: { type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: holder.id, status: 'SYNCED', payload: { paymentId: p.id } } })
  }
  await s.sql(`update payments set "createdAt" = now() - interval '2 hours' where id = $1`, [unresolved.id])
  await s.sql(`update payments set "createdAt" = now() - interval '1 hour' where id = any($1::text[])`, [registered])
  registrations.length = 0
  oi.wcReceiptRegistrationSeams.registrationsAreOwed = async () => true
  oi.wcReceiptRegistrationSeams.obligationIsOnRecord = async (_o: string, pid: string) => registrations.filter((r) => r.paymentId === pid).length > 0
  try {
    const r = await (await import('@/lib/domain/accounting/receipt-registration-sweep')).sweepUnregisteredReceipts(50)
    assert.equal(registrations.filter((x) => x.paymentId === unresolved.id).length, 1, 'registered within one run')
    assert.ok(r.examined <= 50)
    assert.equal(registrations.filter((x) => registered.includes(x.paymentId as string)).length, 0, 'registered receipts took no slot')
  } finally { oi.wcReceiptRegistrationSeams.registrationsAreOwed = undefined; oi.wcReceiptRegistrationSeams.obligationIsOnRecord = oi.wcReceiptRegistrationSeams.obligationIsOnRecord }
})

test('rotation: the batch is the rows attempted LEAST recently; a row just attempted goes behind a never-attempted newer one', async () => {
  const oi = await import('@/lib/connectors/woocommerce/sync/order-import')
  await s.sql(`update shopping_sync_logs set status = 'FAILED' where status = 'PENDING'`)
  const mk = async (n: number, extra: Record<string, unknown>) => s.db.shoppingSyncLog.create({ data: { connector: 'woocommerce', direction: 'FROM_CONNECTOR', status: 'PENDING', entityType: 'SalesOrder', externalId: `77${n}`, payload: { reason: 'missing_fx_rate', connector: 'woocommerce', externalOrderId: `77${n}`, externalOrderNumber: `77${n}`, currency: 'EUR', asOf: null, order: { id: 770 + n, status: 'processing', currency: 'EUR', date_created_gmt: '2026-10-01T09:00:00', line_items: [], meta_data: [] }, receiptPaymentId: `p${n}`, ...extra } } })
  const old = await mk(1, {})
  const attemptedAt = new Date()
  await s.db.shoppingSyncLog.update({ where: { id: old.id }, data: { syncedAt: attemptedAt } })
  await new Promise((r) => setTimeout(r, 20))
  const fresh = await mk(2, {})
  await oi.retryPendingWcOrdersWaitingForFx(1, { receiptsOnly: true })
  const after = async (id: string) => (await s.db.shoppingSyncLog.findUniqueOrThrow({ where: { id } }))
  const touched = (row: Awaited<ReturnType<typeof after>>, prior: Date | null) => row.status !== 'PENDING' || (row.syncedAt?.getTime() ?? null) !== (prior?.getTime() ?? null)
  assert.equal(touched(await after(fresh.id), null), true, 'the never-attempted row was attempted first')
  assert.equal(touched(await after(old.id), attemptedAt), false, 'the row attempted most recently was left for later, though it is older')
})

// The update delivery refreshes addresses and notes, NOT lines or the total, so a total edited in WooCommerce before payment is not in IMS. [mutation: remove the total comparison]
test('paid payload whose total differs from the total IMS holds: no Payment, not paid, ONE review notice; once the totals agree the full amount is recorded', async () => {
  const { updateExistingWcOrderFromPayload } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const o = await heldOrder()
  registrations.length = 0
  const edited = { ...(payload(Number(o.wcId), '2026-10-01T10:00:00') as object), total: '120.00' } as never
  await updateExistingWcOrderFromPayload(o.id, edited)
  await updateExistingWcOrderFromPayload(o.id, edited)
  assert.equal((await payments(o.id)).length, 0)
  assert.equal(registrations.length, 0)
  assert.equal((await s.db.salesOrder.findUniqueOrThrow({ where: { id: o.id } })).paidAt, null)
  const notices = await s.db.activityLog.findMany({ where: { entityId: o.id, action: 'wc_paid_total_differs' } })
  assert.equal(notices.length, 1, 'idempotent per order and total pair')
  assert.deepEqual([(notices[0]!.metadata as { imsTotal: string }).imsTotal, (notices[0]!.metadata as { paidTotal: string }).paidTotal], ['100.00', '120.00'])
  // resync: the order now holds 120
  await s.db.salesOrder.update({ where: { id: o.id }, data: { subtotalForeign: '120', totalForeign: '120' } })
  await updateExistingWcOrderFromPayload(o.id, edited)
  const pays = await payments(o.id)
  assert.equal(pays.length, 1)
  assert.equal(Number(pays[0]!.amount), 120)
  assert.ok((await s.db.salesOrder.findUniqueOrThrow({ where: { id: o.id } })).paidAt)
  assert.equal(registrations.length, 1)
})


// The same-day test uses the order date the IMPORT persisted (externalCreatedAt), never IMS's createdAt. [mutation: fall back to the IMS createdAt / assume same-day when unknown]
test('order created Oct 1 (no creation instant in the paid payload), imported unpaid and paid Oct 3: the payment-date central rate, not the booked rate; a real same-day payment keeps the order rate', async () => {
  const { updateExistingWcOrderFromPayload } = await import('@/lib/connectors/woocommerce/sync/order-import')
  await s.db.fxRate.create({ data: { fromCurrency: 'GBP', toCurrency: 'EUR', rate: '1.33', fetchedAt: new Date('2026-10-03T06:00:00Z') } })
  const noDate = async (o: { id: string; wcId: number }, paid: string) => updateExistingWcOrderFromPayload(o.id, { ...(payload(o.wcId, paid) as object), date_created_gmt: '', date_created: '' } as never)
  // persisted creation instant Oct 1; the order row's own createdAt is "now" (imported Oct 3 or later)
  const late = await heldOrder()
  await noDate(late, '2026-10-03T10:00:00')
  assert.equal(Number((await payments(late.id))[0]!.settlementRateToBase), 1.33, 'payment-date central rate')
  // same real day: the order's booked rate
  const same = await heldOrder()
  await noDate(same, '2026-10-01T15:00:00')
  assert.equal(Number((await payments(same.id))[0]!.settlementRateToBase), 1.1)
  // no persisted creation instant at all: never assumed same-day
  const unknown = await heldOrder({ externalCreatedAt: null })
  await noDate(unknown, '2026-10-03T11:00:00')
  assert.equal(Number((await payments(unknown.id))[0]!.settlementRateToBase), 1.33)
  const unknownSameDay = await heldOrder({ externalCreatedAt: null })
  await noDate(unknownSameDay, '2026-10-01T11:00:00')
  assert.equal(Number((await payments(unknownSameDay.id))[0]!.settlementRateToBase), 1.1, 'the central rate on Oct 1 happens to be the same feed row (1.10): proves a lookup, not an assumption')
})
