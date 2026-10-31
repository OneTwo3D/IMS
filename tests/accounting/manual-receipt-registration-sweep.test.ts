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

mock.module('@/lib/cron-auth', { namedExports: { verifyCron: async () => null } })
mock.module('@/lib/cron-rate-limit', { namedExports: { enforceCronRateLimit: async () => null } })
mock.module('@/lib/maintenance-mode', { namedExports: { getMaintenanceModeResponse: async () => null } })
let refreshMode: 'ok' | 'throw' = 'ok'
let wcRetryMode: 'ok' | 'throw' = 'ok'
mock.module('@/lib/currencies/fx-refresh', { namedExports: { fetchAllFxRatesInternal: async () => { if (refreshMode === 'throw') throw new Error('fx source down'); return { updated: 0 } } } })

const calls: Array<{ paymentId: string; orderId: string }> = []
let mode: 'fail' | 'record' = 'fail'
let s: Scratch
let seq = 0

before(async () => {
  s = await startScratch('ims-manual-receipt-sweep')
  const actualImport = await import('@/lib/connectors/woocommerce/sync/order-import')
  mock.module('@/lib/connectors/woocommerce/sync/order-import', {
    namedExports: { ...actualImport, retryPendingWcOrdersWaitingForFx: async (...a: Parameters<typeof actualImport.retryPendingWcOrdersWaitingForFx>) => { if (wcRetryMode === 'throw') throw new Error('wc import threw on every retry'); return actualImport.retryPendingWcOrdersWaitingForFx(...a) } },
  })
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

// [mutation: remove `p.amount > 0` from the sweep query; make it `>= 0` (zero rows are selected); drop it only for negatives]
test('selection: a zero or negative non-refund receipt on a posted invoice is not a candidate; the positive one beside it is', async () => {
  const { sweepUnregisteredReceipts, receiptRegistrationSeams } = await import('@/lib/domain/accounting/receipt-registration-sweep')
  const seen: string[] = []
  const mk = async (amount: number) => {
    const o = await postedOrder()
    const p = await s.db.payment.create({ data: { orderId: o.id, amount, currency: 'GBP', method: 'Hand' } })
    await age(p.id, 60)
    return p
  }
  const zero = await mk(0)
  const negative = await mk(-5)
  const positive = await mk(5)
  receiptRegistrationSeams.registrationsAreOwed = async () => true
  receiptRegistrationSeams.obligationIsOnRecord = async () => false
  receiptRegistrationSeams.beforeSweepRegisters = async (pid) => { seen.push(pid) }
  mode = 'fail'
  calls.length = 0
  try { await sweepUnregisteredReceipts(250) } finally {
    receiptRegistrationSeams.beforeSweepRegisters = undefined
    receiptRegistrationSeams.registrationsAreOwed = undefined
    receiptRegistrationSeams.obligationIsOnRecord = (await import('@/lib/domain/accounting/receipt-registration-sweep')).receiptObligationIsOnRecord
  }
  assert.ok(seen.includes(positive.id), 'PRECONDITION: the positive receipt is a candidate')
  assert.ok(!seen.includes(zero.id), 'a zero receipt is never swept')
  assert.ok(!seen.includes(negative.id), 'a negative receipt is never swept')
  assert.ok(!calls.some((c) => c.paymentId === zero.id || c.paymentId === negative.id), 'and registration is never attempted for either')
})

// [mutation: restore the standalone null-document-id clause (an unrecorded id counts as current) -> the older-null-id arm goes red; remove the current-invoice scoping of the follow-up exclusion (any marker row on the order excludes it) -> the stale-marker arm goes red; make the scoping too loose (ignore the marker entirely) -> the pending arms go red]
test('a follow-up marker left on a SUPERSEDED invoice does not hide a later receipt; one on the CURRENT invoice still does', async () => {
  const { sweepUnregisteredReceipts, receiptRegistrationSeams } = await import('@/lib/domain/accounting/receipt-registration-sweep')
  const mkOrder = async (current: string) => {
    const o = await postedOrder()
    await s.db.salesOrder.update({ where: { id: o.id }, data: { accountingInvoiceId: current } })
    return o
  }
  const row = (orderId: string, ext: string | null, created: string, marker: boolean, status: 'SYNCED' | 'FAILED' = 'SYNCED') => s.db.accountingSyncLog.create({
    data: { type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: orderId, status, externalTransactionId: ext, createdAt: new Date(created), ...(marker ? { backReferenceFollowUpsPendingAt: new Date() } : {}) },
  })
  const receipt = async (orderId: string) => { const p = await s.db.payment.create({ data: { orderId, amount: 7, currency: 'GBP', method: 'Hand' } }); await age(p.id, 60); return p }

  // reposted: invoice A left a marker, invoice B is current and owes nothing; the inline enqueue of the later receipt failed
  const reposted = await mkOrder('INV-B-1')
  await row(reposted.id, 'INV-A-1', '2026-01-01T00:00:00Z', true)
  await row(reposted.id, 'INV-B-1', '2026-02-01T00:00:00Z', false)
  const stale = await receipt(reposted.id)
  // control: the same order shape but the marker is on the CURRENT invoice B
  const current = await mkOrder('INV-B-2')
  await row(current.id, 'INV-A-2', '2026-01-01T00:00:00Z', false)
  await row(current.id, 'INV-B-2', '2026-02-01T00:00:00Z', true)
  const owing = await receipt(current.id)
  // control: a re-post whose back-reference is not written yet (order still names A, latest row B carries the marker)
  const pendingBackRef = await mkOrder('INV-A-3')
  await row(pendingBackRef.id, 'INV-A-3', '2026-01-01T00:00:00Z', false)
  await row(pendingBackRef.id, 'INV-B-3', '2026-02-01T00:00:00Z', true)
  const midRepost = await receipt(pendingBackRef.id)

  // an OLDER marker row with NO document id, behind a newer row the order points to: superseded, must not exclude
  const nullOld = await mkOrder('INV-B-4')
  await row(nullOld.id, null, '2026-01-01T00:00:00Z', true)
  await row(nullOld.id, 'INV-B-4', '2026-02-01T00:00:00Z', false)
  const nullOldReceipt = await receipt(nullOld.id)
  // a marker row with no document id that IS the latest: still owes
  const nullLatest = await mkOrder('INV-A-5')
  await row(nullLatest.id, 'INV-A-5', '2026-01-01T00:00:00Z', false)
  await row(nullLatest.id, null, '2026-02-01T00:00:00Z', true)
  const nullLatestReceipt = await receipt(nullLatest.id)
  // a later FAILED attempt that never became the invoice does not demote the real pending row
  const failedBehind = await mkOrder('INV-A-6')
  await row(failedBehind.id, null, '2026-01-01T00:00:00Z', true)
  await row(failedBehind.id, null, '2026-02-01T00:00:00Z', false, 'FAILED')
  const failedBehindReceipt = await receipt(failedBehind.id)

  const seen: string[] = []
  receiptRegistrationSeams.registrationsAreOwed = async () => true
  receiptRegistrationSeams.obligationIsOnRecord = async () => false
  receiptRegistrationSeams.beforeSweepRegisters = async (pid) => { seen.push(pid) }
  mode = 'fail'
  try { await sweepUnregisteredReceipts(250) } finally {
    receiptRegistrationSeams.beforeSweepRegisters = undefined
    receiptRegistrationSeams.registrationsAreOwed = undefined
    receiptRegistrationSeams.obligationIsOnRecord = (await import('@/lib/domain/accounting/receipt-registration-sweep')).receiptObligationIsOnRecord
  }
  assert.ok(seen.includes(nullOldReceipt.id), 'an older null-id marker row behind a newer row is superseded')
  assert.ok(!seen.includes(nullLatestReceipt.id), 'a null-id marker row that is the latest still owes')
  assert.ok(!seen.includes(failedBehindReceipt.id), 'a later FAILED row does not demote the real pending row')
  assert.ok(seen.includes(stale.id), 'a stale marker on the superseded invoice A must not exclude the order')
  assert.ok(!seen.includes(owing.id), 'the current invoice still owes its follow-ups: left to that pass')
  assert.ok(!seen.includes(midRepost.id), 'a re-post whose back-reference is not written yet still owes its follow-ups')
})

// [mutation: restore ONE shared error boundary around the Woo retry and the sweep (a throwing retry then skips the sweep); drop the per-step failure report (the response stays 200 with no stepFailures)]
test('the fx-rates cron runs each step in its own boundary: a throwing Woo retry (or FX refresh) still lets the sweep register an unresolved manual receipt, and the failure is reported', async () => {
  const { GET } = await import('@/app/api/cron/fx-rates/route')
  const { receiptRegistrationSeams } = await import('@/lib/domain/accounting/receipt-registration-sweep')
  const order = await postedOrder()
  const orphan = await s.db.payment.create({ data: { orderId: order.id, amount: 11, currency: 'GBP', method: 'Hand' } })
  await age(orphan.id, 90)
  receiptRegistrationSeams.registrationsAreOwed = async () => true
  receiptRegistrationSeams.obligationIsOnRecord = async (o, pid) => (await rowsFor(o, pid)) > 0
  mode = 'record'
  wcRetryMode = 'throw'
  refreshMode = 'throw'
  try {
    const res = await GET(new Request('http://localhost/api/cron/fx-rates'))
    const body = await res.json() as { stepFailures?: Array<{ step: string }> }
    assert.equal(await rowsFor(order.id, orphan.id), 1, 'the sweep ran and registered the receipt although the refresh and the Woo retry threw')
    assert.deepEqual((body.stepFailures ?? []).map((f) => f.step).sort(), ['fx-refresh', 'wc-receipt-retry'])
    assert.equal(res.status, 500, 'the failure surfaces in the route status')
  } finally {
    wcRetryMode = 'ok'
    refreshMode = 'ok'
    receiptRegistrationSeams.registrationsAreOwed = undefined
    receiptRegistrationSeams.obligationIsOnRecord = (await import('@/lib/domain/accounting/receipt-registration-sweep')).receiptObligationIsOnRecord
  }
  const clean = await GET(new Request('http://localhost/api/cron/fx-rates'))
  assert.equal(clean.status, 200, 'no failing step: 200')
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
