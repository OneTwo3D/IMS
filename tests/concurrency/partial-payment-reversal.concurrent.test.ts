import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * o3d-cdhl — A PART OF THE PAYMENT IS GONE FROM XERO: MEASURED, RECORDED ONCE, NEVER POSTED.
 *
 * Drives the poller's OWN residual reading and reconciliation over rows written in the shapes the real writers write,
 * against a real PostgreSQL. Nothing is sent to Xero: the poller's `xeroGet` is never reached by these entry points,
 * and the process loads tests/no-outbound-network.cjs besides.
 *
 * What it pins:
 *   - a part removal is measured from the ledger's own amounts, recorded on the order, and the order stops reading as fully paid;
 *   - the revenue is NOT touched: no credit note, no sync row, no journal. The unwind is the order owner's decision and the
 *     operator is told the exact figures (warning row + notification);
 *   - a recheck of the same ledger state measures zero and writes nothing (idempotent);
 *   - a further removal adds, a payment that comes back subtracts, and a PAID invoice clears;
 *   - a full removal (zero paid) is NOT touched by this path;
 *   - IMS's own silence (a channel-paid order) is never read as a removal.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'

function loadEnv() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
}

const probeId = () => `CDHL-${process.pid}-${randomUUID()}`

async function loadDb() {
  loadEnv()
  const { db } = await import('@/lib/db')
  return db
}

function invoice(invoiceId: string, over: Record<string, unknown> = {}) {
  return {
    InvoiceID: invoiceId, Type: 'ACCREC', Status: 'AUTHORISED', CurrencyCode: 'GBP',
    AmountPaid: 60, AmountDue: 40, AmountCredited: 0, Payments: [{ PaymentID: 'LEDGER-PAY-A' }],
    ...over,
  }
}

async function createPaidOrder(db: Awaited<ReturnType<typeof loadDb>>, id: string, invoiceId: string, over: Record<string, unknown> = {}) {
  await db.salesOrder.create({
    data: {
      id, status: 'SHIPPED', currency: 'GBP',
      subtotalForeign: '100', totalForeign: '100', subtotalBase: '100', totalBase: '100',
      accountingInvoiceId: invoiceId, paidAt: new Date('2026-08-01T09:00:00.000Z'), unregisteredPaidAt: null,
      ...over,
    },
  })
}

function pollResult() {
  return { salesPaid: 0, billsPaid: 0, salesReversed: 0, billsReversed: 0, salesReversalsWithheld: 0, billReversalsWithheld: 0, withheldRechecked: 0, withheldResolved: 0, errors: [] as string[] }
}

async function fence(db: Awaited<ReturnType<typeof loadDb>>) {
  const { databaseLedgerFence } = await import('@/lib/connectors/xero/invoice-delta')
  const [{ now }] = await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`
  return databaseLedgerFence(now)
}

async function read(db: Awaited<ReturnType<typeof loadDb>>, inv: ReturnType<typeof invoice>) {
  const { readSalesResidualVerdicts } = await import('@/lib/connectors/xero/payment-poller')
  const zero = inv.AmountPaid === 0
  return readSalesResidualVerdicts(
    new Map([[inv.InvoiceID, inv]]) as never,
    new Set(zero ? [inv.InvoiceID] : []),
    await fence(db),
  )
}

async function nothingPostedFor(db: Awaited<ReturnType<typeof loadDb>>, orderId: string) {
  assert.equal(await db.accountingSyncLog.count({ where: { referenceId: orderId } }), 0, 'nothing may be queued for the ledger')
  assert.equal(await db.salesOrderRefund.count({ where: { orderId } }), 0, 'no credit note, chargeback or refund may be raised')
}

test('[o3d-cdhl] a part removal is measured, recorded, reported once, and the order stops reading as fully paid', { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' }, async (t) => {
  const db = await loadDb()
  const { reconcilePartialRemovals } = await import('@/lib/connectors/xero/payment-poller')
  const { isFullyPaid } = await import('@/lib/domain/sales/paid-state')
  const id = probeId()
  const invId = `INV-${id}`
  t.after(async () => { await db.activityLog.deleteMany({ where: { entityId: id } }); await db.salesOrder.deleteMany({ where: { id } }) })
  await createPaidOrder(db, id, invId)

  const inv = invoice(invId)
  const residual = await read(db, inv)
  assert.equal(residual.withheld.length, 0, 'a measured removal is not withheld')
  const found = residual.partialRemoved.get(invId)
  assert.ok(found, 'it is routed to the partial-removal bucket')
  assert.equal(found.measurement.kind, 'REMOVED')
  assert.equal(found.measurement.kind === 'REMOVED' && found.measurement.removed.toString(), '40')
  assert.equal(residual.zeroPaidReversed.size, 0, 'a part removal is never a full reversal')
  assert.equal(residual.provenGone.size, 0)

  const result = pollResult()
  await reconcilePartialRemovals(residual as never, result as never)
  assert.deepEqual(result.errors, [])

  const order = await db.salesOrder.findUniqueOrThrow({ where: { id }, select: { paidAt: true, paymentRemovedForeign: true, paymentRemovedAt: true } })
  assert.equal(order.paymentRemovedForeign?.toString(), '40')
  assert.ok(order.paidAt, 'paidAt stays: revenue was recognised on it and the unwind is the operator\'s decision')
  assert.equal(isFullyPaid(order), false, 'the order no longer reads as fully paid')
  assert.ok(order.paymentRemovedAt)

  const rows = await db.paymentRemovalReconciliation.findMany({ where: { orderId: id } })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].kind, 'REMOVED')
  assert.equal(rows[0].amountForeign.toString(), '40')
  assert.equal(rows[0].recordedPaidForeign.toString(), '100')
  assert.equal(rows[0].ledgerPaidForeign.toString(), '60')
  assert.equal(rows[0].documentTotalForeign.toString(), '100')
  assert.equal(rows[0].ledgerAction, 'OPERATOR_DECISION')

  const warnings = await db.activityLog.findMany({ where: { entityId: id, action: 'payment_partially_removed' } })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0].description, /40\.00 GBP of the payment is no longer in Xero/)
  assert.match(warnings[0].description, /NO credit note was raised/)
  assert.match(warnings[0].description, /order owner/)

  // Revenue: nothing was unwound, nothing was posted. The journals that exist for this order are none, so they balance trivially.
  await nothingPostedFor(db, id)

  // The balance reads the reduced paid amount.
  const { receivableBalance } = await import('@/lib/domain/sales/receivable-balance')
  const full = await db.salesOrder.findUniqueOrThrow({ where: { id }, select: { totalBase: true, totalForeign: true, currency: true, paidAt: true, paymentRemovedForeign: true, paymentRemovedAt: true, payments: true } })
  const bal = receivableBalance({ ...full, payments: [] }, new Date())
  assert.equal(bal.balance, 40, 'the removed part is owed again')
  assert.equal(bal.status, 'outstanding')
})

test('[o3d-cdhl] a recheck of the same ledger state is idempotent', { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' }, async (t) => {
  const db = await loadDb()
  const { reconcilePartialRemovals } = await import('@/lib/connectors/xero/payment-poller')
  const id = probeId()
  const invId = `INV-${id}`
  t.after(async () => { await db.activityLog.deleteMany({ where: { entityId: id } }); await db.salesOrder.deleteMany({ where: { id } }) })
  await createPaidOrder(db, id, invId)
  const inv = invoice(invId)

  const first = await read(db, inv)
  await reconcilePartialRemovals(first as never, pollResult() as never)

  for (let i = 0; i < 3; i++) {
    const again = await read(db, inv)
    assert.equal(again.partialRemoved.size, 0, 'the removal is already recorded: nothing left to measure')
    assert.equal(again.withheld.length, 0, 'and nothing left to warn about every poll')
    await reconcilePartialRemovals(again as never, pollResult() as never)
  }
  assert.equal(await db.paymentRemovalReconciliation.count({ where: { orderId: id } }), 1)
  assert.equal(await db.activityLog.count({ where: { entityId: id, action: 'payment_partially_removed' } }), 1)
  const order = await db.salesOrder.findUniqueOrThrow({ where: { id }, select: { paymentRemovedForeign: true } })
  assert.equal(order.paymentRemovedForeign?.toString(), '40')

  // Applying the SAME stale measurement twice (a racing reader) records it once.
  const { recordPaymentRemoval } = await import('@/lib/domain/accounting/payment-removal-reconciliation')
  const m = first.partialRemoved.get(invId)!.measurement
  const raced = await recordPaymentRemoval({ orderId: id, connector: 'xero', accountingInvoiceId: invId, shortfallBefore: null, measurement: m, matchedPaymentIds: [] })
  assert.equal(raced.outcome, 'raced')
  assert.equal(await db.paymentRemovalReconciliation.count({ where: { orderId: id } }), 1)
})

test('[o3d-cdhl] a further removal adds, a payment that comes back subtracts, a PAID invoice clears', { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' }, async (t) => {
  const db = await loadDb()
  const { reconcilePartialRemovals, restorePaidAgainOrders } = await import('@/lib/connectors/xero/payment-poller')
  const id = probeId()
  const invId = `INV-${id}`
  t.after(async () => { await db.activityLog.deleteMany({ where: { entityId: id } }); await db.salesOrder.deleteMany({ where: { id } }) })
  await createPaidOrder(db, id, invId)
  const shortfall = async () => (await db.salesOrder.findUniqueOrThrow({ where: { id }, select: { paymentRemovedForeign: true } })).paymentRemovedForeign?.toString() ?? null

  await reconcilePartialRemovals(await read(db, invoice(invId)) as never, pollResult() as never)
  assert.equal(await shortfall(), '40')

  await reconcilePartialRemovals(await read(db, invoice(invId, { AmountPaid: 30, AmountDue: 70 })) as never, pollResult() as never)
  assert.equal(await shortfall(), '70', 'a second removal adds to the first')

  await reconcilePartialRemovals(await read(db, invoice(invId, { AmountPaid: 80, AmountDue: 20 })) as never, pollResult() as never)
  assert.equal(await shortfall(), '20', 'a payment that came back subtracts')

  const result = pollResult()
  // PAID because a CREDIT settled it (AmountPaid still 80): the shortfall stays and the operator is warned, once per removal.
  await restorePaidAgainOrders(new Map([[invId, invoice(invId, { Status: 'PAID', AmountPaid: 80, AmountDue: 0, AmountCredited: 20 })]]) as never, result as never)
  await restorePaidAgainOrders(new Map([[invId, invoice(invId, { Status: 'PAID', AmountPaid: 80, AmountDue: 0, AmountCredited: 20 })]]) as never, result as never)
  assert.deepEqual(result.errors, [])
  assert.equal(await shortfall(), '20', 'a credit settling the invoice is not the payment coming back')
  const credited = await db.activityLog.findMany({ where: { entityId: id, action: 'payment_removal_credit_settled' } })
  assert.equal(credited.length, 1, 'warned once')
  assert.match(credited[0].description, /20\.00 GBP of allocated credit/)
  assert.match(credited[0].description, /order owner/)
  // PAID with the payments covering it clears.
  await restorePaidAgainOrders(new Map([[invId, invoice(invId, { Status: 'PAID', AmountPaid: 100, AmountDue: 0 })]]) as never, result as never)
  assert.deepEqual(result.errors, [])
  assert.equal(await shortfall(), null, 'a PAID invoice settles the whole balance')
  const history = await db.paymentRemovalReconciliation.findMany({ where: { orderId: id }, orderBy: { createdAt: 'asc' } })
  assert.deepEqual(history.map((r) => r.kind), ['REMOVED', 'REMOVED', 'RESTORED', 'RESTORED'])

  // The history alone reproduces the shortfall at every past instant, so AR as of an earlier date does not move.
  const { shortfallAsOf } = await import('@/lib/domain/sales/paid-state')
  const at = (n: number) => new Date(history[n].createdAt.getTime())
  assert.equal(shortfallAsOf(history, at(0)).toString(), '40')
  assert.equal(shortfallAsOf(history, at(1)).toString(), '70')
  assert.equal(shortfallAsOf(history, at(2)).toString(), '20')
  assert.equal(shortfallAsOf(history, at(3)).toString(), '0')
  assert.equal(shortfallAsOf(history, new Date(history[0].createdAt.getTime() - 1)).toString(), '0')
  await nothingPostedFor(db, id)
})

test('[o3d-cdhl] every writer that clears the shortfall appends a CLEARED history row', { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' }, async (t) => {
  const db = await loadDb()
  const { reconcilePartialRemovals } = await import('@/lib/connectors/xero/payment-poller')
  const { appendShortfallCleared } = await import('@/lib/domain/accounting/payment-removal-reconciliation')
  const { shortfallAsOf } = await import('@/lib/domain/sales/paid-state')
  const id = probeId()
  const invId = `INV-${id}`
  t.after(async () => { await db.activityLog.deleteMany({ where: { entityId: id } }); await db.salesOrder.deleteMany({ where: { id } }) })
  await createPaidOrder(db, id, invId)
  await reconcilePartialRemovals(await read(db, invoice(invId)) as never, pollResult() as never)
  await new Promise((r) => setTimeout(r, 20))
  await db.$transaction(async (tx) => {
    await appendShortfallCleared(tx, id)
    await tx.salesOrder.update({ where: { id }, data: { paidAt: null, unregisteredPaidAt: null, paymentRemovedForeign: null, paymentRemovedAt: null } })
  })
  const history = await db.paymentRemovalReconciliation.findMany({ where: { orderId: id }, orderBy: { createdAt: 'asc' } })
  assert.deepEqual(history.map((r) => r.kind), ['REMOVED', 'CLEARED'])
  assert.equal(shortfallAsOf(history, history[0].createdAt).toString(), '40', 'an earlier date still shows it after the clear')
  assert.equal(shortfallAsOf(history, new Date()).toString(), '0')
})

test('[o3d-cdhl] a removed IMS-registered payment is named when it accounts for the removal', { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' }, async (t) => {
  const db = await loadDb()
  const { reconcilePartialRemovals } = await import('@/lib/connectors/xero/payment-poller')
  const { stampSyncedAtFromDatabaseClock } = await import('@/lib/connectors/xero/synced-at-clock')
  const id = probeId()
  const invId = `INV-${id}`
  t.after(async () => {
    await db.activityLog.deleteMany({ where: { entityId: id } })
    await db.accountingSyncLog.deleteMany({ where: { referenceId: id } })
    await db.salesOrder.deleteMany({ where: { id } })
  })
  await createPaidOrder(db, id, invId)
  for (const [ledgerId, amount] of [['LEDGER-PAY-A', 60], ['LEDGER-PAY-B', 40]] as const) {
    const row = await db.accountingSyncLog.create({
      data: { connector: 'xero', type: 'INVOICE_PAYMENT', status: 'SYNCED', referenceType: 'SalesOrder', referenceId: id, externalTransactionId: ledgerId, payload: { accountingInvoiceId: invId, amount, currency: 'GBP', paymentId: `local_${ledgerId}` } },
      select: { id: true },
    })
    await stampSyncedAtFromDatabaseClock(db, row.id)
  }
  // Let the database clock pass every registration stamp, so the fence can speak for them.
  await new Promise((r) => setTimeout(r, 50))

  const residual = await read(db, invoice(invId)) // the ledger lists A only
  const found = residual.partialRemoved.get(invId)
  assert.ok(found, `measured removal expected (withheld: ${JSON.stringify(residual.withheld.map((w) => w.verdict.verdict))})`)
  assert.equal(found.verdict.verdict, 'STILL_HELD')
  await reconcilePartialRemovals(residual as never, pollResult() as never)
  const row = await db.paymentRemovalReconciliation.findFirstOrThrow({ where: { orderId: id } })
  assert.deepEqual(row.matchedPaymentIds, ['LEDGER-PAY-B'])
  const warning = await db.activityLog.findFirstOrThrow({ where: { entityId: id, action: 'payment_partially_removed' } })
  assert.match(warning.description, /LEDGER-PAY-B/)
  // The registered payments are untouched: IMS did not re-post, cancel or edit anything.
  assert.equal(await db.accountingSyncLog.count({ where: { referenceId: id } }), 2)
})

test('[o3d-cdhl] a FULL removal is unchanged, and IMS\'s own silence is never read as a removal', { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' }, async (t) => {
  const db = await loadDb()
  const fullId = probeId()
  const channelId = probeId()
  const noteId = probeId()
  t.after(async () => { await db.activityLog.deleteMany({ where: { entityId: { in: [fullId, channelId, noteId] } } }); await db.salesOrder.deleteMany({ where: { id: { in: [fullId, channelId, noteId] } } }) })
  await createPaidOrder(db, fullId, `INV-${fullId}`)
  await createPaidOrder(db, channelId, `INV-${channelId}`, { unregisteredPaidAt: new Date('2026-08-01T09:00:00.000Z') })
  await createPaidOrder(db, noteId, `INV-${noteId}`)

  // Full removal: the zero-paid proof path, exactly as before.
  const full = await read(db, invoice(`INV-${fullId}`, { AmountPaid: 0, AmountDue: 100, Payments: [] }))
  assert.ok(full.zeroPaidReversed.has(`INV-${fullId}`), 'a stated zero is still a reversal')
  assert.equal(full.partialRemoved.size, 0)

  // A channel-paid order: the shortfall is IMS's silence, so it stays withheld and is never recorded.
  const channel = await read(db, invoice(`INV-${channelId}`))
  assert.equal(channel.partialRemoved.size, 0)
  assert.equal(channel.withheld.length, 1)
  assert.equal(channel.withheld[0].reason, 'part-payment')

  // A ledger that also holds a credit cannot attribute the shortfall to a payment: left to the operator, as before.
  const credited = await read(db, invoice(`INV-${noteId}`, { AmountCredited: 10 }))
  assert.equal(credited.partialRemoved.size, 0)
  assert.equal(credited.withheld.length, 1)

  // An ordinary fully-paid document (paid == total) is not a part removal at all.
  const ok = await read(db, invoice(`INV-${noteId}`, { AmountPaid: 100, AmountDue: 0 }))
  assert.equal(ok.partialRemoved.size, 0)

  assert.equal(await db.paymentRemovalReconciliation.count({ where: { orderId: { in: [fullId, channelId, noteId] } } }), 0)
})
