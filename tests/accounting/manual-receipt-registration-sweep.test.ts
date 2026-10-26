/**
 * o3d-rcg31: a receipt committed by `addPayment` on an invoice that has ALREADY posted is registered by the next sweep when the inline registration did not reach the record, exactly once,
 * and a registered receipt is left alone. Real scratch database and real actions; the ledger call is a recording double (there is no live accounting connector in a scratch database), and the
 * "on record" probe reads the sync rows the double writes. Every arm names the mutation that turns it red.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { after, before, mock } from 'node:test'
import { startScratch, type Scratch } from '../first-load/apply-scratch'

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireInternalUser: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireRole: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('@/lib/shopping', { namedExports: { enqueueStockSync: async () => {} } })
mock.module('@/lib/notifications', { namedExports: { notify: async () => {} } })

const calls: Array<{ paymentId: string; orderId: string }> = []
let mode: 'fail' | 'record' = 'fail'
let s: Scratch
let seq = 0

before(async () => {
  s = await startScratch('ims-manual-receipt-sweep')
  const actual = await import('@/lib/domain/accounting/invoice-payment-enqueue')
  mock.module('@/lib/domain/accounting/invoice-payment-enqueue', {
    namedExports: {
      ...actual,
      registerInvoicePaymentWithLedger: async (p: { paymentId: string; orderId: string }) => {
        calls.push({ paymentId: p.paymentId, orderId: p.orderId })
        // 'fail' = the swallowed failure of the real function: nothing recorded. 'record' = the enqueue wrote its INVOICE_PAYMENT row (idempotent per receipt, like invoicePaymentEnqueueKey).
        if (mode === 'record' && (await s.db.accountingSyncLog.count({ where: { type: 'INVOICE_PAYMENT', referenceId: p.orderId, payload: { path: ['paymentId'], equals: p.paymentId } } })) === 0) {
          await s.db.accountingSyncLog.create({ data: { type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: p.orderId, status: 'PENDING', payload: { paymentId: p.paymentId } } })
        }
        return null
      },
    },
  })
})
after(async () => { await s?.stop() })

const rowsFor = (orderId: string, paymentId: string) => s.db.accountingSyncLog.count({ where: { type: 'INVOICE_PAYMENT', referenceId: orderId, payload: { path: ['paymentId'], equals: paymentId } } })

async function postedOrder() {
  const n = ++seq
  return s.db.salesOrder.create({ data: { currency: 'GBP', fxRateToBase: 1, subtotalForeign: '100', totalForeign: '100', subtotalBase: '100', totalBase: '100', accountingInvoiceId: `INV-RCG-${n}`, status: 'PROCESSING' }, select: { id: true } })
}
const age = (paymentId: string, minutes: number) => s.sql(`update payments set "createdAt" = now() - ($2 || ' minutes')::interval where id = $1`, [paymentId, String(minutes)])

// [mutation: drop the sweep from the cron route; select by notes prefix again; drop the posted-invoice requirement]
test('an enqueue failure after the manual receipt commit is registered by the next sweep, once; a registered receipt is left alone', async () => {
  const { addPayment } = await import('@/app/actions/sales')
  const { sweepUnregisteredReceipts, receiptRegistrationSeams } = await import('@/lib/domain/accounting/receipt-registration-sweep')
  const order = await postedOrder()
  mode = 'fail'
  calls.length = 0
  const added = await addPayment({ orderId: order.id, amount: 40, currency: 'GBP', method: 'Bank' })
  assert.equal(added.success, true, added.error)
  const payment = await s.db.payment.findFirstOrThrow({ where: { orderId: order.id } })
  assert.equal(calls.length, 1, 'the inline registration ran once and left nothing on record')
  assert.equal(await rowsFor(order.id, payment.id), 0)
  const registered = await postedOrder()
  const done = await s.db.payment.create({ data: { orderId: registered.id, amount: 10, currency: 'GBP', method: 'Hand' } })
  await s.db.accountingSyncLog.create({ data: { type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: registered.id, status: 'SYNCED', payload: { paymentId: done.id } } })
  await age(done.id, 60)

  receiptRegistrationSeams.registrationsAreOwed = async () => true
  receiptRegistrationSeams.obligationIsOnRecord = async (o, pid) => (await rowsFor(o, pid)) > 0
  try {
    const young = await sweepUnregisteredReceipts()
    assert.equal(calls.length, 1, 'a receipt younger than 5 minutes is left to its inline registration')
    assert.equal(young.registered, 0)
    await age(payment.id, 10)
    mode = 'record'
    const first = await sweepUnregisteredReceipts()
    assert.equal(first.registered >= 1, true)
    assert.equal(await rowsFor(order.id, payment.id), 1, 'registered by the sweep')
    assert.equal(calls.filter((c) => c.paymentId === done.id).length, 0, 'the already-registered receipt was left alone')
    const again = await sweepUnregisteredReceipts()
    assert.equal(again.registered, 0)
    assert.equal(await rowsFor(order.id, payment.id), 1, 'and not registered again')
  } finally {
    receiptRegistrationSeams.registrationsAreOwed = undefined
    receiptRegistrationSeams.obligationIsOnRecord = (await import('@/lib/domain/accounting/receipt-registration-sweep')).receiptObligationIsOnRecord
  }
  assert.match(readFileSync('app/api/cron/fx-rates/route.ts', 'utf8'), /sweepUnregisteredReceipts\(50\)/, 'the scheduled cron runs the sweep every run')
})

// [mutation: skip the on-record probe before registering]
test('the inline registration and the sweep race: whichever lands second sees the record and registers nothing more', async () => {
  const { sweepUnregisteredReceipts, receiptRegistrationSeams, registerReceiptAndProveObligation } = await import('@/lib/domain/accounting/receipt-registration-sweep')
  const order = await postedOrder()
  const payment = await s.db.payment.create({ data: { orderId: order.id, amount: 25, currency: 'GBP', method: 'Hand' } })
  await age(payment.id, 30)
  calls.length = 0
  mode = 'record'
  receiptRegistrationSeams.registrationsAreOwed = async () => true
  receiptRegistrationSeams.obligationIsOnRecord = async (o, pid) => (await rowsFor(o, pid)) > 0
  // the sweep has selected the receipt; at that moment the inline call lands
  receiptRegistrationSeams.beforeSweepRegisters = async (pid) => {
    if (pid !== payment.id) return
    receiptRegistrationSeams.beforeSweepRegisters = undefined
    await registerReceiptAndProveObligation(order.id, 'ref', { id: payment.id, amount: 25, currency: 'GBP', method: 'Hand', reference: null, paidAt: new Date(), settlementRateToBase: null })
  }
  try {
    await sweepUnregisteredReceipts()
  } finally {
    receiptRegistrationSeams.beforeSweepRegisters = undefined
    receiptRegistrationSeams.registrationsAreOwed = undefined
    receiptRegistrationSeams.obligationIsOnRecord = (await import('@/lib/domain/accounting/receipt-registration-sweep')).receiptObligationIsOnRecord
  }
  assert.equal(await rowsFor(order.id, payment.id), 1)
  assert.equal(calls.filter((c) => c.paymentId === payment.id).length, 1, 'registered exactly once: the sweep saw the inline record')
  // the real enqueue is idempotent per receipt and document on top of this (invoicePaymentEnqueueKey), pinned from source
  const src = readFileSync('lib/domain/accounting/invoice-payment-enqueue.ts', 'utf8')
  assert.match(src, /idempotencyKey: invoicePaymentEnqueueKey\(params\.paymentId, accountingInvoiceId\)/)
})

// [mutation: select registered receipts (drop the anti-joins), drop the age floor, drop the pending-follow-up exclusion, order newest first]
test('selection: refunds, young receipts, unposted invoices, registered receipts and orders still owing SALES_INVOICE follow-ups are not candidates; the oldest, least-recently-failed comes first', async () => {
  const { sweepUnregisteredReceipts, receiptRegistrationSeams } = await import('@/lib/domain/accounting/receipt-registration-sweep')
  const seen: string[] = []
  const mk = async (opts: { posted?: boolean; minutes?: number; refund?: boolean; pendingFollowUps?: boolean } = {}) => {
    const o = opts.posted === false
      ? await s.db.salesOrder.create({ data: { currency: 'GBP', fxRateToBase: 1, subtotalForeign: '9', totalForeign: '9', subtotalBase: '9', totalBase: '9' }, select: { id: true } })
      : await postedOrder()
    const refund = opts.refund ? await s.db.salesOrderRefund.create({ data: { orderId: o.id, subtotalForeign: '1', totalForeign: '1', subtotalBase: '1', totalBase: '1' } as never }).catch(() => null) : null
    if (opts.refund && !refund) return null
    const p = await s.db.payment.create({ data: { orderId: o.id, amount: 5, currency: 'GBP', method: 'Hand', ...(refund ? { refundId: refund.id } : {}) } })
    await age(p.id, opts.minutes ?? 60)
    if (opts.pendingFollowUps) await s.db.accountingSyncLog.create({ data: { type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: o.id, status: 'SYNCED', backReferenceFollowUpsPendingAt: new Date() } })
    return p
  }
  const unposted = await mk({ posted: false })
  const young = await mk({ minutes: 1 })
  const pending = await mk({ pendingFollowUps: true })
  const older = await mk({ minutes: 600 })
  const newer = await mk({ minutes: 100 })
  const failedBefore = await mk({ minutes: 900 })
  await s.db.activityLog.create({ data: { entityType: 'SALES_ORDER', entityId: failedBefore!.orderId, action: 'receipt_sweep_attempt_failed', description: 'earlier failed attempt', tag: 'sync', metadata: { paymentId: failedBefore!.id } } as never })
  receiptRegistrationSeams.registrationsAreOwed = async () => true
  receiptRegistrationSeams.obligationIsOnRecord = async () => false
  receiptRegistrationSeams.beforeSweepRegisters = async (pid) => { seen.push(pid) }
  mode = 'fail'
  try { await sweepUnregisteredReceipts(250) } finally {
    receiptRegistrationSeams.beforeSweepRegisters = undefined
    receiptRegistrationSeams.registrationsAreOwed = undefined
    receiptRegistrationSeams.obligationIsOnRecord = (await import('@/lib/domain/accounting/receipt-registration-sweep')).receiptObligationIsOnRecord
  }
  for (const excluded of [unposted, young, pending]) assert.ok(!seen.includes(excluded!.id), 'not a candidate')
  const order = seen.filter((id) => [older!.id, newer!.id, failedBefore!.id].includes(id))
  assert.deepEqual(order, [older!.id, newer!.id, failedBefore!.id], 'oldest first, the recently failed one behind the others')
})

// [mutation: apply the limit before the "no record" filter (drop the INVOICE_PAYMENT anti-join)]
test('starvation: 55 newer registered receipts do not hide an older unresolved one from a batch of 50', async () => {
  const { sweepUnregisteredReceipts, receiptRegistrationSeams } = await import('@/lib/domain/accounting/receipt-registration-sweep')
  const order = await postedOrder()
  const unresolved = await s.db.payment.create({ data: { orderId: order.id, amount: 1, currency: 'GBP', method: 'Hand' } })
  const registered: string[] = []
  for (let i = 0; i < 55; i++) {
    const p = await s.db.payment.create({ data: { orderId: order.id, amount: 1, currency: 'GBP', method: 'Hand' } })
    registered.push(p.id)
    await s.db.accountingSyncLog.create({ data: { type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: order.id, status: 'SYNCED', payload: { paymentId: p.id } } })
  }
  await age(unresolved.id, 100)
  await s.sql(`update payments set "createdAt" = now() - interval '1000 minutes' where id = any($1::text[])`, [registered])
  calls.length = 0
  mode = 'record'
  receiptRegistrationSeams.registrationsAreOwed = async () => true
  receiptRegistrationSeams.obligationIsOnRecord = async (o, pid) => (await rowsFor(o, pid)) > 0
  try { await sweepUnregisteredReceipts(50) } finally {
    receiptRegistrationSeams.registrationsAreOwed = undefined
    receiptRegistrationSeams.obligationIsOnRecord = (await import('@/lib/domain/accounting/receipt-registration-sweep')).receiptObligationIsOnRecord
  }
  assert.equal(await rowsFor(order.id, unresolved.id), 1, 'registered within one run')
  assert.equal(calls.filter((c) => registered.includes(c.paymentId)).length, 0)
})

// [mutation: drop the "registrations are owed" guard at the top of the sweep]
test('no connector posts INVOICE_PAYMENT: the sweep returns at once, examines nothing and registers nothing', async () => {
  const { sweepUnregisteredReceipts, receiptRegistrationSeams } = await import('@/lib/domain/accounting/receipt-registration-sweep')
  const order = await postedOrder()
  const orphan = await s.db.payment.create({ data: { orderId: order.id, amount: 3, currency: 'GBP', method: 'Hand' } })
  await age(orphan.id, 90)
  calls.length = 0
  mode = 'record'
  receiptRegistrationSeams.registrationsAreOwed = async () => false
  receiptRegistrationSeams.obligationIsOnRecord = async () => false
  try {
    const r = await sweepUnregisteredReceipts(250)
    assert.deepEqual(r, { examined: 0, registered: 0, failed: 0 })
  } finally {
    receiptRegistrationSeams.registrationsAreOwed = undefined
    receiptRegistrationSeams.obligationIsOnRecord = (await import('@/lib/domain/accounting/receipt-registration-sweep')).receiptObligationIsOnRecord
  }
  assert.equal(calls.filter((c) => c.paymentId === orphan.id).length, 0)
  assert.equal(await rowsFor(order.id, orphan.id), 0)
})
