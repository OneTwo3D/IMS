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

/**
 * o3d-psrx r8 (Codex HIGH 2) — WHAT QUICKBOOKS SAID IT STILL HOLDS ON EACH DOCUMENT.
 *
 * The gate now requires this, and requiring it is the fix: `zeroPaidIsProvenReversal` decides whether
 * a ZERO-PAID document may clear `paidAt`, and this poller used to hand it documents selected only by
 * `Balance > 0` — under which a payment PART of which was removed is indistinguishable from one that
 * is entirely gone.
 *
 * The r3/r4 probes below are all about the REGISTRATION half of the gate, so each is given the reading
 * that actually reaches it: the payment was removed in full and QuickBooks holds nothing. Saying so is
 * compulsory now, which is the point — before r8 these tests were asserting about a precondition they
 * had never established, and so was production.
 */
const fullyRemoved = (invoiceIds: Iterable<string>, total = 100) =>
  new Map([...invoiceIds].map((id) => [id, { paid: 0, total }] as const))

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
        ledgerAmounts: fullyRemoved(regressed),
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
        // o3d-psrx r4 — THE PAYLOAD NAMES THE DOCUMENT, BECAUSE EVERY PRODUCTION ENQUEUE WRITES IT.
        //
        // `registerInvoicePaymentWithLedger` puts `accountingInvoiceId` in the INVOICE_PAYMENT payload
        // at enqueue time (invoice-payment-enqueue.ts), and r4 made the reversal reader weigh it: a
        // registration that names no document is UNBINDABLE, and an unbindable row is undecided rather
        // than evidence. `payload: {}` therefore modelled a LEGACY row — one written before the field
        // existed, or retention-compacted (o3d-m5qk) — and this test would have asserted the legacy
        // arm while claiming to assert the self-discharge. Xero's fixtures were aligned in e0e71513;
        // this one is the sibling that was missed, and it is the case that would have shipped a
        // withheld verdict for every genuine QuickBooks chargeback.
        //
        // r7 (Codex HIGH 1) — AND IT NAMES THE AMOUNT, for the same reason and by the same argument.
        // The enqueue writes `amount` and `currency` beside the document id, and the reversal reader
        // now weighs them: while the off-ledger marker stands, a registration that settled only PART
        // of the order cannot have its absence read as a reversal of the whole order. This order is
        // GBP 100 and this registration settled all of it — which is what makes the chargeback below
        // a genuine one — so a fixture that omits the amount is not a smaller fixture, it is the
        // part-covered case, and this test would again have asserted a different arm than it claims.
        payload: { accountingInvoiceId: invoiceId, amount: 100, currency: 'GBP' },
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
      {
        registrationType: 'INVOICE_PAYMENT',
        referenceType: 'SalesOrder',
        ledgerObservedBefore,
        ledgerAmounts: fullyRemoved([invoiceId]),
      },
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
        // Named for the same reason as the sales fixture above, though nothing here turns on it today:
        // PENDING never reaches the SYNCED branch where the binding is weighed, so this row is
        // undecided by status alone. Naming it keeps the fixture a production shape, so that a later
        // edit to the status cannot silently move this test onto the legacy-row arm.
        payload: { accountingInvoiceId: inFlight },
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
        ledgerAmounts: fullyRemoved([inFlight, control]),
      },
    )

    assert.deepEqual(gate.withheld.map((w) => [w.doc.id, w.verdict.verdict]), [[bills[0].id, 'REGISTRATION_UNDECIDED']],
      'a bill whose payment IMS has queued but not posted must keep paidAt — clearing it re-arms Mark '
      + 'Paid over a payment in flight, and QuickBooks refuses nothing downstream')
    // THE CONTROL: the same bill with no registration at all is still reversed.
    assert.deepEqual(gate.admitted.map((d) => d.id), [bills[1].id])
  },
)

// ---------------------------------------------------------------------------
// o3d-psrx r8 (Codex HIGH 2) — A BALANCE DUE IS NOT PROOF THE PAYMENTS ARE GONE.
//
// THE FINDING. `zeroPaidIsProvenReversal` decides whether a ZERO-PAID document may clear `paidAt`;
// two of its three admitting arms say so in as many words ("the zero is the whole story", "it STATED
// a zero total"). Xero establishes that precondition upstream — `partitionPaymentReversals` splits on
// `AmountPaid` and only `zeroPaid` is asked the registration question. THIS POLLER NEVER DID. Its
// candidates were documents with `Balance > 0`, it enumerates no payment ids, and so a document
// carrying a posted registration landed on `LEDGER_DID_NOT_LIST_PAYMENTS`, which ADMITS.
//
// Put together: an order settled by TWO registrations, ONE of whose payments is removed, shows a
// balance due. The classifier sums both historical registrations as full coverage, cannot identify
// which payment survived, and the gate admitted a FULL chargeback — `paidAt` cleared and a credit
// note raised over the whole sale — while QuickBooks was still holding the other payment. r3 named
// this residual in the poller's own header and filed it as a different defect; it was not a different
// defect, it was the precondition the gate was missing.
//
// NO QUICKBOOKS CALL IS MADE ANYWHERE IN THIS FILE, r8 included. The evidence the gate now requires
// is `TotalAmt - Balance`, which `SELECT *` already returns in the very responses the reversal reads
// take — so the fix adds no call, and the tests supply that reading directly, exactly as they have
// always supplied the set of regressed ids.
//
// THE CONTROLS ARE THE POINT, as everywhere else in this file. "Withhold whenever there is a balance
// due" would pass the headline and switch the QuickBooks reversal pass off entirely, so the subject
// is paired with an order IDENTICAL IN EVERY RESPECT — same total, same two registrations, same
// absent listing — differing only in what QuickBooks says it still holds.
// ---------------------------------------------------------------------------

/**
 * TWO RECEIPTS OF 50 ON ONE 100 ORDER, BOTH REGISTERED AND BOTH POSTED — the shape Codex names.
 *
 * Together they cover the order, which is why `addPayment` left `unregisteredPaidAt` NULL on it, and
 * singly they do not, which is what makes "one of them removed" a state at all.
 *
 * A LOCAL `Payment` ROW PER REGISTRATION, and each registration NAMES its own receipt. Both halves are
 * load-bearing and neither is decoration:
 *
 *   the receipts     without them the order is paid with nothing recorded behind it, which is a
 *                    different population (r2's marker) and not the one this test is about. With them
 *                    and unnamed, every verdict would be RECEIPT_NOT_REGISTERED — IMS's own silence —
 *                    and the test would withhold for a reason that has nothing to do with the amount.
 *   `paymentId`      `accounting_sync_logs_followup_live_unique` keys live rows on the document AND
 *                    the receipt, so two registrations against one invoice are only a legal state
 *                    when they settle DIFFERENT receipts. Omitting it does not make a smaller
 *                    fixture; it makes an impossible one, and the database says so.
 */
async function twoPostedHalves(
  db: Awaited<ReturnType<typeof loadDb>>,
  orderId: string,
  invoiceId: string,
): Promise<void> {
  const { stampSyncedAtFromDatabaseClock } = await import('@/lib/connectors/xero/synced-at-clock')
  for (const half of ['A', 'B']) {
    const receipt = await db.payment.create({
      data: { orderId, amount: 50, currency: 'GBP', method: 'Card', paidAt: new Date('2026-08-02T09:00:00.000Z') },
      select: { id: true },
    })
    const row = await db.accountingSyncLog.create({
      data: {
        connector: 'quickbooks',
        type: 'INVOICE_PAYMENT',
        status: 'SYNCED',
        referenceType: 'SalesOrder',
        referenceId: orderId,
        externalTransactionId: `QBO-PAY-${half}-${orderId}`,
        // The production payload shape, for the reason the r3/r7 fixture above gives at length: a row
        // that names no document is UNBINDABLE, a row that names no amount is the part-covered case,
        // and a row that names no receipt leaves that receipt reading as unregistered — any of the
        // three would move this test onto an arm it does not claim to be testing.
        payload: { accountingInvoiceId: invoiceId, amount: 50, currency: 'GBP', paymentId: receipt.id },
      },
      select: { id: true },
    })
    // Never by supplying the columns — migration 20260821090000's trigger refuses a supplied
    // `syncedAtDatabaseClock`, so a writer outside the scheme destroys provenance rather than forging it.
    await stampSyncedAtFromDatabaseClock(db, row.id)
  }
}

test(
  '[o3d-psrx r8] a QuickBooks document with a payment still on it is NOT reversed by its balance due',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const db = await loadDb()
    const { readQboSalesReversalCandidates, gateQboReversalsOnProvenance } =
      await import('@/lib/connectors/quickbooks/payment-poller')
    const { detectPaymentReversals, readDatabaseLedgerFence } =
      await import('@/lib/domain/accounting/payment-reversal')

    const halfId = probeId()   // QuickBooks removed ONE of the two payments
    const goneId = probeId()   // QuickBooks removed BOTH
    const ids = [halfId, goneId]
    const invoiceOf = new Map(ids.map((id) => [id, `QBO-INV-${id}`]))
    t.after(async () => {
      await db.accountingSyncLog.deleteMany({ where: { referenceType: 'SalesOrder', referenceId: { in: ids } } })
      await db.payment.deleteMany({ where: { orderId: { in: ids } } })
      await db.salesOrder.deleteMany({ where: { id: { in: ids } } })
    })

    // NO off-ledger marker on either: this is the population r3's header said the residual was "written
    // about", and Codex's own note — "The same occurs without a marker". With no marker the r7 coverage
    // guard cannot run, so the ONLY thing between a balance due and a full chargeback is the amount.
    for (const id of ids) {
      await createPaidOrder(db, id, invoiceOf.get(id)!, null)
      await twoPostedHalves(db, id, invoiceOf.get(id)!)
    }

    // PRECONDITIONS. Both orders must be in the state the finding is about — two registrations that
    // together cover the total, both database-stamped before the read, neither carrying a marker.
    const stamped = await db.accountingSyncLog.findMany({
      where: { referenceType: 'SalesOrder', referenceId: { in: ids } },
      select: { referenceId: true, syncedAt: true, syncedAtDatabaseClock: true },
    })
    assert.equal(stamped.length, 4, 'each order must carry BOTH registrations, or "one removed" is not a state')
    for (const row of stamped) {
      assert.ok(
        row.syncedAt != null && row.syncedAtDatabaseClock != null
        && row.syncedAt.getTime() === row.syncedAtDatabaseClock.getTime(),
        'every registration must be database-stamped, or the verdict is REGISTRATION_UNDECIDED and '
        + 'both arms would withhold for a reason this test is not about',
      )
    }

    const ledgerObservedBefore = await readDatabaseLedgerFence()
    assert.ok(ledgerObservedBefore != null, 'a null fence decides nothing and this test would be vacuous')

    // THE POLLER'S OWN QUERY, then the gate production feeds on the next line.
    const candidates = (await readQboSalesReversalCandidates()).filter((c) => ids.includes(c.id))
    assert.equal(candidates.length, 2, 'both probes must be selected, or the controls prove nothing')

    // WHAT QUICKBOOKS SAID. Both documents show a balance due — the predicate that selected them — and
    // they differ in NOTHING ELSE but the amount still applied to them.
    const gate = await gateQboReversalsOnProvenance(
      detectPaymentReversals(candidates, new Set(invoiceOf.values())),
      {
        registrationType: 'INVOICE_PAYMENT',
        referenceType: 'SalesOrder',
        ledgerObservedBefore,
        ledgerAmounts: new Map([
          // TotalAmt 100, Balance 50: one payment gone, one still applied.
          [invoiceOf.get(halfId)!, { paid: 50, total: 100 }],
          // TotalAmt 100, Balance 100: nothing is applied to it any more.
          [invoiceOf.get(goneId)!, { paid: 0, total: 100 }],
        ]),
      },
    )

    // THE HEADLINE.
    const withheld = gate.withheld.find((w) => w.doc.id === halfId)
    assert.ok(withheld,
      'THE FINDING: QuickBooks is still holding half of this order and the gate reversed the whole of '
      + 'it — paidAt cleared and a chargeback credit note raised over money the ledger never gave back')
    assert.deepEqual(withheld.verdict, {
      verdict: 'LEDGER_NOT_PROVEN_ZERO_PAID', paidAmount: 50, documentTotal: 100,
    }, 'and it must say WHICH fact was missing, with the figures an operator has to reconcile against')
    assert.ok(!gate.admitted.some((d) => d.id === halfId))

    // THE CONTROL. Same order, same two registrations, same absent listing, same balance due — and
    // QuickBooks holds nothing on it. A genuine chargeback must still reverse, or this fix has
    // disabled the QuickBooks reversal pass rather than narrowed it.
    assert.ok(gate.admitted.some((d) => d.id === goneId),
      'a document QuickBooks states it holds NOTHING on is still a proven reversal — the gate narrows '
      + 'the evidence it demands, it does not switch the pass off')
    assert.ok(!gate.withheld.some((w) => w.doc.id === goneId))

    // AND NOTHING WAS WRITTEN BY THE GATE ITSELF: it decides, the caller acts.
    const after = await db.salesOrder.findMany({ where: { id: { in: ids } }, select: { id: true, paidAt: true } })
    for (const row of after) assert.ok(row.paidAt != null, `${row.id} must still be held as paid by the gate`)
  },
)

test(
  '[o3d-psrx r8] an amount QuickBooks would not state, and a document it did not answer about, both withhold',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    // The two ways the evidence can be ABSENT rather than positive, and the one case that needs no
    // arithmetic at all. Absence is not zero — the same reading `LEDGER_DID_NOT_LIST_PAYMENTS` gives a
    // missing `Payments[]` and `databaseStampedCompletion` gives an unvouched timestamp.
    const db = await loadDb()
    const { readQboSalesReversalCandidates, gateQboReversalsOnProvenance } =
      await import('@/lib/connectors/quickbooks/payment-poller')
    const { detectPaymentReversals, readDatabaseLedgerFence } =
      await import('@/lib/domain/accounting/payment-reversal')

    const unreadableId = probeId()  // QuickBooks answered, but not with a figure IMS can read
    const unaskedId = probeId()     // QuickBooks did not answer about this document at all
    const voidedId = probeId()      // QuickBooks ZEROED the document
    const ids = [unreadableId, unaskedId, voidedId]
    const invoiceOf = new Map(ids.map((id) => [id, `QBO-INV-${id}`]))
    t.after(async () => {
      await db.accountingSyncLog.deleteMany({ where: { referenceType: 'SalesOrder', referenceId: { in: ids } } })
      await db.payment.deleteMany({ where: { orderId: { in: ids } } })
      await db.salesOrder.deleteMany({ where: { id: { in: ids } } })
    })
    for (const id of ids) {
      await createPaidOrder(db, id, invoiceOf.get(id)!, null)
      await twoPostedHalves(db, id, invoiceOf.get(id)!)
    }

    const ledgerObservedBefore = await readDatabaseLedgerFence()
    assert.ok(ledgerObservedBefore != null, 'a null fence decides nothing and this test would be vacuous')
    const candidates = (await readQboSalesReversalCandidates()).filter((c) => ids.includes(c.id))
    assert.equal(candidates.length, 3)

    const gate = await gateQboReversalsOnProvenance(
      detectPaymentReversals(candidates, new Set(invoiceOf.values())),
      {
        registrationType: 'INVOICE_PAYMENT',
        referenceType: 'SalesOrder',
        ledgerObservedBefore,
        ledgerAmounts: new Map([
          // A payload whose figures `parseLedgerAmount` cannot read — `qboLedgerAmount` answers null.
          [invoiceOf.get(unreadableId)!, { paid: null, total: null }],
          // `unaskedId` is deliberately ABSENT from this map.
          // VOIDED: `qboVoidedAmount`, a fact about the document rather than a subtraction.
          [invoiceOf.get(voidedId)!, { paid: 0, total: 0 }],
        ]),
      },
    )

    const withheld = new Map(gate.withheld.map((w) => [w.doc.id, w.verdict]))
    assert.deepEqual(withheld.get(unreadableId),
      { verdict: 'LEDGER_NOT_PROVEN_ZERO_PAID', paidAmount: null, documentTotal: null },
      'a figure that could not be read is not a figure of zero, and coverage that cannot be '
      + 'established cannot be established in either direction')
    assert.deepEqual(withheld.get(unaskedId),
      { verdict: 'LEDGER_NOT_PROVEN_ZERO_PAID', paidAmount: null, documentTotal: null },
      'a document this read said NOTHING about is not a document with nothing on it — the same '
      + 'fail-closed reading an absent verdict and a null fence already get')
    for (const id of [unreadableId, unaskedId]) {
      assert.ok(!gate.admitted.some((d) => d.id === id))
    }

    // THE CONTROL, and it is the one this rule could most easily have broken by accident: a VOIDED
    // document is zeroed, so there is nothing left on it for a payment to be applied to, and IMS's
    // handling of it (clear paidAt, raise NO chargeback — QBO already reversed the AR) must be
    // untouched by an amount rule written about balance-due documents.
    assert.ok(gate.admitted.some((d) => d.id === voidedId),
      'a voided document must still reverse — it is the one reading that needs no arithmetic')
    assert.ok(!gate.withheld.some((w) => w.doc.id === voidedId))
  },
)
