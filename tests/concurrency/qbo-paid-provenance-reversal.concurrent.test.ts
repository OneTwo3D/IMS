import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * o3d-psrx r3 (Codex HIGH) — A QUICKBOOKS-POLLED SALE MARKED PAID WITHOUT A LEDGER REGISTRATION IS
 * NOT REVERSED, AND A GENUINE QUICKBOOKS CHARGEBACK STILL IS.
 *
 * THE DEFECT. r2 gave the paid flag a provenance column and taught the XERO poller to read it. The
 * QuickBooks reversal candidate query selected neither `unregisteredPaidAt` nor any receipt or
 * registration evidence, so every recently modified balance-due invoice went straight into reversal
 * handling. `markSalesOrderPaid` writes a native order with no shopping link, sets the marker, and by
 * design creates no ledger payment — it satisfied that query exactly, and IMS's deliberate
 * non-registration read as a removed payment: chargeback credit note raised, `paidAt` cleared.
 *
 * WHY THIS NEEDS A REAL DATABASE, AND WHY IT CALLS THE POLLER'S OWN READER. The verdict logic is pure
 * and is pinned by tests/accounting/shared-reversal-classifier.test.ts. What those cannot establish is
 * the WIRING — and the wiring is exactly what was broken: the poller asked a question the row could
 * answer while never selecting the column that answers it. A test that rebuilt the query by hand would
 * have sailed over the whole finding. So this drives `readQboSalesReversalCandidates` — the poller's
 * own query, the poller's own select — and puts the result through `gateQboReversalsOnProvenance`, the
 * same call production makes on the next line.
 *
 * NO QUICKBOOKS CALL IS MADE ANYWHERE IN THIS FILE. The only thing the QBO read contributes is the set
 * of invoice ids that regressed, which the test supplies directly.
 *
 * THE CONTROLS ARE THE POINT. "Withhold everything" would pass the headline and destroy the reversal
 * pass. So the withheld cases are paired with a LEDGER-sourced order — same shape, same absence of a
 * receipt, differing only in the recorded provenance — and with a genuine chargeback whose payment
 * demonstrably reached the ledger. Both must still reverse.
 *
 * Gated behind RUN_DB_CONCURRENCY_TESTS=1: `npm run test:concurrency`.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'

function loadEnv() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
  if (!url.startsWith('postgres://') && !url.startsWith('postgresql://')) {
    throw new Error('o3d-psrx r3 concurrency test requires a Postgres DATABASE_URL')
  }
}

const probeId = () => `PSRX3-${process.pid}-${randomUUID()}`

async function loadDb() {
  loadEnv()
  const { db } = await import('@/lib/db')
  return db
}

async function createPaidOrder(
  db: Awaited<ReturnType<typeof loadDb>>,
  id: string,
  invoiceId: string,
  unregisteredPaidAt: Date | null,
): Promise<void> {
  const paidAt = new Date('2026-08-01T09:00:00.000Z')
  await db.salesOrder.create({
    data: {
      id,
      status: 'SHIPPED',
      currency: 'GBP',
      subtotalForeign: 100,
      totalForeign: 100,
      subtotalBase: 100,
      totalBase: 100,
      accountingInvoiceId: invoiceId,
      paidAt,
      unregisteredPaidAt,
    },
  })
}

test(
  '[o3d-psrx r3] a QuickBooks-polled sale marked paid with no ledger registration is NOT reversed',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const db = await loadDb()
    const { readQboSalesReversalCandidates, gateQboReversalsOnProvenance } =
      await import('@/lib/connectors/quickbooks/payment-poller')
    const { detectPaymentReversals, readDatabaseLedgerFence } =
      await import('@/lib/domain/accounting/payment-reversal')

    const humanId = probeId()      // markSalesOrderPaid: the marker, no receipt, no registration
    const ledgerId = probeId()     // the QBO forward pass marked it paid: no marker
    const receiptId = probeId()    // addPayment committed a receipt; its registration is not raised yet
    const ids = [humanId, ledgerId, receiptId]
    const invoiceOf = new Map(ids.map((id) => [id, `QBO-INV-${id}`]))
    t.after(async () => {
      await db.payment.deleteMany({ where: { orderId: { in: ids } } })
      await db.salesOrder.deleteMany({ where: { id: { in: ids } } })
    })

    await createPaidOrder(db, humanId, invoiceOf.get(humanId)!, new Date('2026-08-01T09:00:00.000Z'))
    await createPaidOrder(db, ledgerId, invoiceOf.get(ledgerId)!, null)
    await createPaidOrder(db, receiptId, invoiceOf.get(receiptId)!, null)
    await db.payment.create({
      data: { orderId: receiptId, amount: 100, currency: 'GBP', method: 'Bank Transfer' },
    })

    // The state the defect turned on, asserted rather than assumed: NOTHING registered for any of them.
    const registrations = await db.accountingSyncLog.count({
      where: { referenceType: 'SalesOrder', referenceId: { in: ids } },
    })
    assert.equal(registrations, 0, 'the probe must reach the state with NOTHING registered')

    // THE POLLER'S OWN QUERY. Not a reconstruction of it.
    const candidates = await readQboSalesReversalCandidates()
    const mine = candidates.filter((c) => ids.includes(c.id))
    assert.equal(mine.length, 3, 'all three probes must be selected as reversal candidates, or nothing below is reached')
    for (const row of mine) {
      assert.ok('unregisteredPaidAt' in row,
        'THE WIRING ASSERTION. The reversal candidate query must SELECT the provenance — without it '
        + 'every verdict below falls through to NOTHING_REGISTERED and the reversal proceeds.')
    }

    // QuickBooks reported a balance due on all three. This is the only thing the QBO read contributes.
    const regressed = new Set(ids.map((id) => invoiceOf.get(id)!))
    const gate = await gateQboReversalsOnProvenance(
      detectPaymentReversals(mine, regressed),
      {
        registrationType: 'INVOICE_PAYMENT',
        referenceType: 'SalesOrder',
        ledgerObservedBefore: await readDatabaseLedgerFence(),
      },
    )

    const withheld = new Map(gate.withheld.map((w) => [w.doc.id, w.verdict.verdict]))
    const admitted = new Set(gate.admitted.map((d) => d.id))

    // THE HEADLINE.
    assert.equal(withheld.get(humanId), 'PAID_WITHOUT_LEDGER_RECEIPT',
      'a sale an operator marked paid by hand must NOT be reversed — QuickBooks showing a balance due '
      + 'is IMS\'s own silence, and acting on it raises a chargeback credit note against a paid customer')
    assert.ok(!admitted.has(humanId))

    // The r1 shape, now reached through the QuickBooks door as well.
    assert.equal(withheld.get(receiptId), 'RECEIPT_NOT_REGISTERED',
      'a receipt IMS has recorded and not yet registered is IMS\'s own lag, not a removed payment')
    assert.ok(!admitted.has(receiptId))

    // THE CONTROL. Same absence of every kind of evidence; different recorded provenance. Withholding
    // this one too would pass the headline and disable the reversal pass entirely.
    assert.ok(admitted.has(ledgerId),
      'a LEDGER-sourced paid flag over a QuickBooks balance due is still a reversal — that is the pass\'s job')
    assert.ok(!withheld.has(ledgerId))

    // And `paidAt` is untouched on the withheld ones: the gate decides, it does not write.
    const after = await db.salesOrder.findMany({
      where: { id: { in: [humanId, receiptId] } },
      select: { id: true, paidAt: true },
    })
    for (const row of after) assert.ok(row.paidAt != null, `${row.id} must still be held as paid`)
  },
)

test(
  '[o3d-psrx r3] a genuine QuickBooks chargeback still reverses once the registration has posted',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    // The marker is SELF-DISCHARGING or the fix has traded one money defect for another: the moment an
    // INVOICE_PAYMENT is proved to have reached QuickBooks before the read, the ledger decides again.
    const db = await loadDb()
    const { readQboSalesReversalCandidates, gateQboReversalsOnProvenance } =
      await import('@/lib/connectors/quickbooks/payment-poller')
    const { detectPaymentReversals, readDatabaseLedgerFence } =
      await import('@/lib/domain/accounting/payment-reversal')
    const { stampSyncedAtFromDatabaseClock } = await import('@/lib/connectors/xero/synced-at-clock')

    const orderId = probeId()
    const invoiceId = `QBO-INV-${orderId}`
    t.after(async () => {
      await db.accountingSyncLog.deleteMany({ where: { referenceType: 'SalesOrder', referenceId: orderId } })
      await db.salesOrder.deleteMany({ where: { id: orderId } })
    })

    // The marked-by-hand shape — the one the previous test proves is withheld while nothing has posted.
    await createPaidOrder(db, orderId, invoiceId, new Date('2026-08-01T09:00:00.000Z'))

    // STAMPED THROUGH `stampSyncedAtFromDatabaseClock`, never by supplying the columns: a trigger
    // (migration 20260821090000) REFUSES a `syncedAtDatabaseClock` supplied by an INSERT, precisely so
    // that a writer outside the scheme destroys the provenance rather than forging it.
    const registration = await db.accountingSyncLog.create({
      data: {
        connector: 'quickbooks',
        type: 'INVOICE_PAYMENT',
        status: 'SYNCED',
        referenceType: 'SalesOrder',
        referenceId: orderId,
        externalTransactionId: 'QBO-PAY-LANDED',
        payload: {},
      },
      select: { id: true },
    })
    await stampSyncedAtFromDatabaseClock(db, registration.id)
    const stamped = await db.accountingSyncLog.findUniqueOrThrow({
      where: { id: registration.id },
      select: { syncedAt: true, syncedAtDatabaseClock: true },
    })
    assert.ok(
      stamped.syncedAt != null && stamped.syncedAtDatabaseClock != null
      && stamped.syncedAt.getTime() === stamped.syncedAtDatabaseClock.getTime(),
      'the registration must be database-stamped, or the classifier calls it UNDECIDED and this test '
      + 'would pass for the wrong reason',
    )

    // The fence is read AFTER the stamp, so the registration provably finished before the ledger was
    // asked — the ordering the poller relies on (SELECT clock_timestamp(), THEN call QuickBooks).
    const ledgerObservedBefore = await readDatabaseLedgerFence()
    assert.ok(ledgerObservedBefore != null, 'a null fence decides nothing and this test would be vacuous')

    const candidates = (await readQboSalesReversalCandidates()).filter((c) => c.id === orderId)
    assert.equal(candidates.length, 1)
    const gate = await gateQboReversalsOnProvenance(
      detectPaymentReversals(candidates, new Set([invoiceId])),
      { registrationType: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', ledgerObservedBefore },
    )
    assert.deepEqual(gate.withheld, [], 'nothing is withheld once IMS\'s own payment has demonstrably landed')
    assert.deepEqual(gate.admitted.map((d) => d.id), [orderId],
      'a genuine QuickBooks chargeback must still be detected — the provenance marker withholds only '
      + 'while no registration has been proved to reach the ledger')
  },
)

test(
  '[o3d-psrx r3] a QuickBooks BILL whose registration this read cannot speak for is not reversed',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    // A bill carries no provenance column (markBillPaid queues its registration inside the paid
    // transaction — o3d-a3wx). What the gate adds on the purchase side is the REGISTRATION FENCE, and
    // getting it wrong pays the supplier twice: clearing paidAt re-arms Mark Paid over money on its way.
    const db = await loadDb()
    const { readQboBillReversalCandidates, gateQboReversalsOnProvenance } =
      await import('@/lib/connectors/quickbooks/payment-poller')
    const { detectPaymentReversals, readDatabaseLedgerFence } =
      await import('@/lib/domain/accounting/payment-reversal')

    const supplier = await db.supplier.create({
      data: { name: `PSRX3 probe ${randomUUID()}` }, select: { id: true },
    })
    const po = await db.purchaseOrder.create({
      data: {
        reference: `PSRX3-${randomUUID()}`.slice(0, 40),
        supplierId: supplier.id,
        status: 'RECEIVED',
        currency: 'GBP',
        fxRateToBase: 1,
        subtotalForeign: 100,
        subtotalBase: 100,
        totalForeign: 100,
        totalBase: 100,
      },
      select: { id: true },
    })
    const inFlight = `QBO-BILL-${randomUUID()}`
    const control = `QBO-BILL-${randomUUID()}`
    const bills = await Promise.all([inFlight, control].map((accountingInvoiceId) =>
      db.purchaseInvoice.create({
        data: {
          poId: po.id,
          invoiceNumber: accountingInvoiceId,
          invoiceDate: new Date('2026-08-01T00:00:00.000Z'),
          fxRateToBase: 1,
          totalForeign: 100,
          totalBase: 100,
          accountingInvoiceId,
          paidAt: new Date('2026-08-01T09:00:00.000Z'),
        },
        select: { id: true, accountingInvoiceId: true },
      })))
    t.after(async () => {
      await db.accountingSyncLog.deleteMany({ where: { referenceType: 'PurchaseInvoice', referenceId: { in: bills.map((b) => b.id) } } })
      await db.purchaseInvoice.deleteMany({ where: { id: { in: bills.map((b) => b.id) } } })
      await db.purchaseOrder.deleteMany({ where: { id: po.id } })
      await db.supplier.deleteMany({ where: { id: supplier.id } })
    })

    // A payment IMS has queued and not yet posted. PENDING is undecidable to any read.
    await db.accountingSyncLog.create({
      data: {
        connector: 'quickbooks',
        type: 'BILL_PAYMENT',
        status: 'PENDING',
        referenceType: 'PurchaseInvoice',
        referenceId: bills[0].id,
        payload: {},
      },
    })

    const candidates = (await readQboBillReversalCandidates()).filter((c) => bills.some((b) => b.id === c.id))
    assert.equal(candidates.length, 2, 'both probe bills must be selected, or the controls prove nothing')
    const gate = await gateQboReversalsOnProvenance(
      detectPaymentReversals(candidates, new Set([inFlight, control])),
      {
        registrationType: 'BILL_PAYMENT',
        referenceType: 'PurchaseInvoice',
        ledgerObservedBefore: await readDatabaseLedgerFence(),
      },
    )

    assert.deepEqual(gate.withheld.map((w) => [w.doc.id, w.verdict.verdict]), [[bills[0].id, 'REGISTRATION_UNDECIDED']],
      'a bill whose payment IMS has queued but not posted must keep paidAt — clearing it re-arms Mark '
      + 'Paid over a payment in flight, and QuickBooks refuses nothing downstream')
    // THE CONTROL: the same bill with no registration at all is still reversed.
    assert.deepEqual(gate.admitted.map((d) => d.id), [bills[1].id])
  },
)
