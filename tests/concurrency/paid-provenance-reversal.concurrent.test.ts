import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * o3d-psrx r2 (Codex HIGH) — A WOOCOMMERCE-PAID SALE WITH NO `Payment` ROW IS NOT REVERSED.
 *
 * r1 gave the poller a witness for the paid orders that HAVE a local receipt. A WooCommerce order has
 * none: the importer writes `paidAt` straight from `date_paid_gmt`, and (on the update path) nothing
 * ever raises an INVOICE_PAYMENT for it. The witness saw nothing, the verdict fell through to
 * NOTHING_REGISTERED, and a zero-paid Xero snapshot cleared `paidAt` and raised a chargeback credit
 * note against a sale the customer had genuinely paid for.
 *
 * WHY THIS NEEDS A REAL DATABASE, AND WHY IT CALLS `readSalesResidualVerdicts` RATHER THAN THE
 * CLASSIFIER. The verdict logic is pure and is pinned by unit tests in
 * tests/connectors/xero-invoice-delta.test.ts. What those cannot establish is the WIRING — and the
 * wiring is exactly what was broken: the poller asked a question the row could answer while never
 * selecting the column that answers it. A test that rebuilt the query by hand would have sailed over
 * that. So this drives the poller's OWN query, against rows written in the shapes the real writers
 * write, and asserts on the reversal set the reversal pass consumes.
 *
 * THE CONTROL IS THE POINT. "Withhold everything" would pass the headline assertion and destroy the
 * reversal pass. So every case here is paired with a LEDGER-sourced order — same shape, same absence
 * of a receipt, differing only in the recorded provenance — which must still be admitted.
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
    throw new Error('o3d-psrx r2 concurrency test requires a Postgres DATABASE_URL')
  }
}

const probeId = () => `PSRX2-${process.pid}-${randomUUID()}`

async function loadDb() {
  loadEnv()
  const { db } = await import('@/lib/db')
  return db
}

/** An AUTHORISED ACCREC invoice stating a clean zero — the exact snapshot that used to reverse. */
function zeroPaidInvoice(invoiceId: string) {
  return {
    InvoiceID: invoiceId,
    Type: 'ACCREC',
    Status: 'AUTHORISED',
    AmountPaid: 0,
    AmountDue: 100,
    Payments: [],
  }
}

type OrderShape = {
  /** Written by the WooCommerce importer and by markSalesOrderPaid; null for a ledger-sourced flag. */
  unregisteredPaidAt: Date | null
}

async function createPaidOrder(
  db: Awaited<ReturnType<typeof loadDb>>,
  id: string,
  invoiceId: string,
  shape: OrderShape,
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
      unregisteredPaidAt: shape.unregisteredPaidAt,
    },
  })
}

test(
  '[o3d-psrx r2] a channel-paid sale with no Payment row and no registration is NOT reversed',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const db = await loadDb()
    const { readSalesResidualVerdicts } = await import('@/lib/connectors/xero/payment-poller')
    const { databaseLedgerFence } = await import('@/lib/connectors/xero/invoice-delta')

    const channelId = probeId()
    const ledgerId = probeId()
    const channelInvoice = `INV-${channelId}`
    const ledgerInvoice = `INV-${ledgerId}`
    t.after(async () => {
      await db.salesOrder.deleteMany({ where: { id: { in: [channelId, ledgerId] } } })
    })

    // The WooCommerce shape: paid, no receipt, no registration, provenance recorded.
    await createPaidOrder(db, channelId, channelInvoice, { unregisteredPaidAt: new Date('2026-08-01T09:00:00.000Z') })
    // The CONTROL — byte-identical but for the provenance. The Xero forward pass marked it paid, so a
    // ledger that now reads zero really has had the payment taken away.
    await createPaidOrder(db, ledgerId, ledgerInvoice, { unregisteredPaidAt: null })

    // Neither order has ANY accounting_sync_logs row and neither has a Payment: this is the state the
    // defect turned on, and the assertion below is worthless if it is not actually reached.
    const registrations = await db.accountingSyncLog.count({
      where: { referenceType: 'SalesOrder', referenceId: { in: [channelId, ledgerId] } },
    })
    assert.equal(registrations, 0, 'the probe must reach the state with NOTHING registered')
    const receipts = await db.payment.count({ where: { orderId: { in: [channelId, ledgerId] } } })
    assert.equal(receipts, 0, 'and with no local receipt for the r1 witness to find')

    const invoices = new Map<string, ReturnType<typeof zeroPaidInvoice>>([
      [channelInvoice, zeroPaidInvoice(channelInvoice)],
      [ledgerInvoice, zeroPaidInvoice(ledgerInvoice)],
    ])
    const [{ now }] = await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`
    const residual = await readSalesResidualVerdicts(
      // The poller passes the delta's own XeroInvoice objects; these carry the fields it reads.
      invoices as never,
      new Set([channelInvoice, ledgerInvoice]),
      databaseLedgerFence(now),
    )

    // THE HEADLINE. The reversal passes act on `zeroPaidReversed` (with `voided` and `provenGone`);
    // an invoice absent from all three has its `paidAt` left alone and no credit note raised.
    assert.ok(
      !residual.zeroPaidReversed.has(channelInvoice),
      'a WooCommerce-paid sale the ledger was never told about must NOT be reversed — the ledger\'s '
      + 'zero is IMS\'s own silence, and acting on it raises a chargeback against a paid customer',
    )
    assert.ok(!residual.provenGone.has(channelInvoice), 'and it is not promoted by the identity route either')
    const withheld = residual.withheld.find((w) => w.doc.id === channelId)
    assert.ok(withheld, 'it must be WITHHELD and reported, not silently dropped')
    assert.equal(withheld.verdict.verdict, 'PAID_WITHOUT_LEDGER_RECEIPT')

    // THE CONTROL. Same absence of every kind of evidence; different recorded provenance. Withholding
    // this one too would pass the headline and disable the reversal pass entirely.
    assert.ok(
      residual.zeroPaidReversed.has(ledgerInvoice),
      'a LEDGER-sourced paid flag over an emptied ledger is still a reversal — that is the pass\'s job',
    )
  },
)

test(
  '[o3d-psrx r2] the same sale IS reversed once its registration has posted (WC chargebacks still work)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    // 6oyu.6 put WooCommerce orders into the reversal pass on purpose: a chargeback on a WC sale must
    // clear paidAt and unwind revenue. If the provenance marker withheld for ever, that would be dead
    // for every WooCommerce order — the fix would have traded one money defect for another.
    const db = await loadDb()
    const { readSalesResidualVerdicts } = await import('@/lib/connectors/xero/payment-poller')
    const { databaseLedgerFence } = await import('@/lib/connectors/xero/invoice-delta')

    const orderId = probeId()
    const invoiceId = `INV-${orderId}`
    t.after(async () => {
      await db.accountingSyncLog.deleteMany({ where: { referenceType: 'SalesOrder', referenceId: orderId } })
      await db.salesOrder.deleteMany({ where: { id: orderId } })
    })

    await createPaidOrder(db, orderId, invoiceId, { unregisteredPaidAt: new Date('2026-08-01T09:00:00.000Z') })

    // A registration that SYNCED, with a ledger payment id, BEFORE the read. The ledger now lists
    // nothing, so the payment IMS put there has been removed: a genuine chargeback.
    //
    // STAMPED THROUGH `stampSyncedAtFromDatabaseClock`, never by supplying the columns: a trigger
    // (migration 20260821090000) REFUSES a `syncedAtDatabaseClock` supplied by an INSERT, precisely so
    // that a writer outside the scheme destroys the provenance rather than forging it. A first draft of
    // this test set both columns directly and the row came back undecidable — which is the trigger
    // doing its job, and worth recording here so the next reader does not "fix" it the wrong way.
    const { stampSyncedAtFromDatabaseClock } = await import('@/lib/connectors/xero/synced-at-clock')
    const registration = await db.accountingSyncLog.create({
      data: {
        connector: 'xero',
        type: 'INVOICE_PAYMENT',
        status: 'SYNCED',
        referenceType: 'SalesOrder',
        referenceId: orderId,
        externalTransactionId: 'PAY-LANDED',
        // o3d-psrx r4: WHICH ledger document this registration settled, exactly as
        // `registerInvoicePaymentWithLedger` writes it. Without it the row names no document, and a row
        // that names no document can discharge nothing — which is the LEGACY arm, not this case.
        //
        // r7 (Codex HIGH 1): AND HOW MUCH, which the enqueue has always written and this fixture used
        // to leave out. It is load-bearing now: the order carries an off-ledger marker, so the
        // coverage guard asks whether the registration that went missing settled the WHOLE GBP 100.
        // It did — that is what makes this a genuine chargeback and not a part payment — and stating
        // the amount is what lets the reader say so. A fixture that omits it is not a smaller fixture,
        // it is a different case (see the part-covered test below, which is that case).
        payload: { accountingInvoiceId: invoiceId, amount: 100, currency: 'GBP', paymentId: 'pay_local_full' },
      },
      select: { id: true },
    })
    await stampSyncedAtFromDatabaseClock(db, registration.id)

    // The fence is read AFTER the stamp, so the registration provably finished before the ledger was
    // asked — the ordering the poller itself relies on (SELECT clock_timestamp(), THEN call Xero).
    const [{ now }] = await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`
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

    const invoices = new Map([[invoiceId, zeroPaidInvoice(invoiceId)]])
    const residual = await readSalesResidualVerdicts(
      invoices as never, new Set([invoiceId]), databaseLedgerFence(now),
    )
    assert.ok(
      residual.zeroPaidReversed.has(invoiceId),
      'once IMS\'s own payment has demonstrably reached the ledger, the ledger\'s list decides — and a '
      + 'WooCommerce chargeback must still be detected',
    )
  },
)

// ---------------------------------------------------------------------------
// o3d-psrx r4 (Codex HIGH) — A REGISTRATION ANSWERS ONLY FOR THE DOCUMENT AND THE PAID EPISODE IT
// WAS RAISED IN.
//
// r2/r3 read the registrations for a document by `referenceId` alone, and any one of them that had
// posted before the fence made `posted` non-empty. `posted` being non-empty is precisely what stops
// `unregisteredPaidAt` being consulted — so a registration about a payment that no longer exists, or
// about a ledger document this order no longer has, discharged a marker it knows nothing about.
//
// Both cases below are real database rows, read through the poller's OWN query, and both are paired
// with a control that must still reverse. "Withhold everything" passes the headline and destroys the
// pass, which is the mistake these controls exist to catch.
// ---------------------------------------------------------------------------

/** A SYNCED INVOICE_PAYMENT with a ledger payment id, stamped by the database like the processor's. */
async function postedRegistration(
  db: Awaited<ReturnType<typeof loadDb>>,
  orderId: string,
  registeredAgainstInvoiceId: string,
  externalTransactionId: string,
  /**
   * o3d-psrx r7 (Codex HIGH 1) — WHAT THIS REGISTRATION TOLD THE LEDGER IT WAS SENDING.
   *
   * Defaulted to the whole order (every order in this file is GBP 100), because that is what every
   * case here was implicitly about: a receipt that SETTLED the order, registered, and then removed.
   * It is not a detail any more — the reversal reader now refuses to treat a PART-covering
   * registration's absence as a reversal of the whole order while the off-ledger marker stands, so a
   * fixture that omits the amount is no longer a smaller fixture, it is the part-covered case.
   */
  amount: number = 100,
  /** The local receipt this registration names, when the case has one — see `unregisteredLocalReceipts`. */
  paymentId: string | null = null,
): Promise<string> {
  const { stampSyncedAtFromDatabaseClock } = await import('@/lib/connectors/xero/synced-at-clock')
  const row = await db.accountingSyncLog.create({
    data: {
      connector: 'xero',
      type: 'INVOICE_PAYMENT',
      status: 'SYNCED',
      referenceType: 'SalesOrder',
      referenceId: orderId,
      externalTransactionId,
      // The payload every production enqueue writes. It is the ONLY durable record of which ledger
      // document the call was about — the order's own column answers "which document NOW" — and (r7)
      // of how much of that document it settled.
      payload: paymentId == null
        ? { accountingInvoiceId: registeredAgainstInvoiceId, amount, currency: 'GBP' }
        : { accountingInvoiceId: registeredAgainstInvoiceId, amount, currency: 'GBP', paymentId },
    },
    select: { id: true },
  })
  // The trigger in 20260821090000 REFUSES a `syncedAtDatabaseClock` supplied by an INSERT, so the
  // stamp has to go through the same helper the processor uses or the row comes back undecidable.
  await stampSyncedAtFromDatabaseClock(db, row.id)
  const stamped = await db.accountingSyncLog.findUniqueOrThrow({
    where: { id: row.id }, select: { syncedAt: true, syncedAtDatabaseClock: true },
  })
  assert.ok(
    stamped.syncedAt != null && stamped.syncedAtDatabaseClock != null
    && stamped.syncedAt.getTime() === stamped.syncedAtDatabaseClock.getTime(),
    'the registration must be database-stamped, or the classifier calls it UNDECIDED and every '
    + 'assertion below passes for a reason that has nothing to do with the binding',
  )
  return row.id
}

test(
  '[o3d-psrx r4] a registration from an EARLIER paid episode does not discharge the current marker',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    // THE CASE THAT MOTIVATES THE WHOLE FINDING: paid, registered, REFUNDED, PAID AGAIN off-ledger.
    //
    //   1. the order was paid and IMS registered the payment with Xero (SYNCED, PAY-EPISODE-1).
    //   2. the payment was reversed in Xero. `paidAt` was cleared; the SYNCED row stayed — nothing
    //      retires a sales registration, and a reversal Xero performed that IMS never polled would
    //      leave it in place regardless.
    //   3. an operator marked the order paid again by hand. `markSalesOrderPaid` stamps
    //      `unregisteredPaidAt`, records no receipt and queues nothing: this paid state was never
    //      going to have a ledger receipt.
    //
    // Before r4 the stale row made `posted` non-empty, the marker was never consulted, the zero-paid
    // invoice read as a removal, and IMS raised a chargeback credit note against the SECOND payment.
    const db = await loadDb()
    const { readSalesResidualVerdicts } = await import('@/lib/connectors/xero/payment-poller')
    const { databaseLedgerFence } = await import('@/lib/connectors/xero/invoice-delta')

    const staleId = probeId()
    const currentId = probeId()
    const staleInvoice = `INV-${staleId}`
    const currentInvoice = `INV-${currentId}`
    t.after(async () => {
      await db.accountingSyncLog.deleteMany({ where: { referenceType: 'SalesOrder', referenceId: { in: [staleId, currentId] } } })
      await db.salesOrder.deleteMany({ where: { id: { in: [staleId, currentId] } } })
    })

    await createPaidOrder(db, staleId, staleInvoice, { unregisteredPaidAt: null })
    // THE CONTROL. Its marker is stamped BEFORE its registration posts, so that registration belongs
    // to the paid state the marker describes and is allowed to discharge it — this is the 6oyu.6
    // WooCommerce chargeback, and withholding it would trade one money defect for another.
    await createPaidOrder(db, currentId, currentInvoice, { unregisteredPaidAt: null })
    const [{ before }] = await db.$queryRaw<Array<{ before: Date }>>`SELECT clock_timestamp() AS before`
    await db.salesOrder.update({ where: { id: currentId }, data: { paidAt: before, unregisteredPaidAt: before } })

    await postedRegistration(db, staleId, staleInvoice, 'PAY-EPISODE-1')
    await postedRegistration(db, currentId, currentInvoice, 'PAY-THIS-EPISODE')

    // ...and only NOW is the stale order's second paid state entered, AFTER its episode-1 registration
    // completed. That ordering is the whole fact this test is about, so it is asserted rather than
    // assumed: a fixture that got it backwards would pass for the control's reason.
    const [{ after }] = await db.$queryRaw<Array<{ after: Date }>>`SELECT clock_timestamp() AS after`
    await db.salesOrder.update({ where: { id: staleId }, data: { paidAt: after, unregisteredPaidAt: after } })
    const staleRow = await db.accountingSyncLog.findFirstOrThrow({
      where: { referenceId: staleId }, select: { syncedAtDatabaseClock: true },
    })
    assert.ok(staleRow.syncedAtDatabaseClock != null && staleRow.syncedAtDatabaseClock.getTime() < after.getTime(),
      'the stale registration must have completed BEFORE the current paid state was entered')

    const [{ now }] = await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`
    const invoices = new Map([
      [staleInvoice, zeroPaidInvoice(staleInvoice)],
      [currentInvoice, zeroPaidInvoice(currentInvoice)],
    ])
    const residual = await readSalesResidualVerdicts(
      invoices as never, new Set([staleInvoice, currentInvoice]), databaseLedgerFence(now),
    )

    // THE HEADLINE.
    assert.ok(!residual.zeroPaidReversed.has(staleInvoice),
      'a registration about a payment that was taken away BEFORE this paid state began must not be '
      + 'read as "IMS told the ledger about this one" — acting on it charges back a customer who paid')
    assert.ok(!residual.provenGone.has(staleInvoice), 'and it is not promoted by the identity route either')
    const withheld = residual.withheld.find((w) => w.doc.id === staleId)
    assert.ok(withheld, 'it must be WITHHELD and reported, not silently dropped')
    assert.equal(withheld.verdict.verdict, 'PAID_WITHOUT_LEDGER_RECEIPT',
      'and for the RIGHT reason: this paid flag came from an operator and no registration belongs to '
      + 'it. REGISTRATION_UNDECIDED would also withhold, and would send the operator hunting for a '
      + 'sync row that has nothing to do with the flag they set.')

    // THE CONTROL. Identical in every respect except which side of the marker its registration posted.
    assert.ok(residual.zeroPaidReversed.has(currentInvoice),
      'a registration raised DURING this paid state still discharges the marker — the marker is '
      + 'self-discharging by design, and a WooCommerce chargeback must still be detected (6oyu.6)')
  },
)

test(
  '[o3d-psrx r4] a registration against a DIFFERENT ledger document does not discharge this one',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    // The delete-and-re-post shape. The invoice IMS settled was deleted in the ledger and re-posted,
    // so the order now points at a NEW `accountingInvoiceId` while the SYNCED registration still names
    // the old one. o3d-hbgo already states this rule for settlement — "a row against a document the
    // order no longer has must not be read as bearing on the replacement" — and the reversal reader
    // was the sibling that did not.
    //
    // Both orders here are LEDGER-sourced (`unregisteredPaidAt: null`), so nothing in this test can
    // pass by way of the marker: the only difference between the two is which document the payload
    // names.
    const db = await loadDb()
    const { readSalesResidualVerdicts } = await import('@/lib/connectors/xero/payment-poller')
    const { databaseLedgerFence } = await import('@/lib/connectors/xero/invoice-delta')

    const movedId = probeId()
    const sameId = probeId()
    const replacementInvoice = `INV-NEW-${movedId}`
    const deletedInvoice = `INV-OLD-${movedId}`
    const sameInvoice = `INV-${sameId}`
    t.after(async () => {
      await db.accountingSyncLog.deleteMany({ where: { referenceType: 'SalesOrder', referenceId: { in: [movedId, sameId] } } })
      await db.salesOrder.deleteMany({ where: { id: { in: [movedId, sameId] } } })
    })

    await createPaidOrder(db, movedId, replacementInvoice, { unregisteredPaidAt: null })
    await createPaidOrder(db, sameId, sameInvoice, { unregisteredPaidAt: null })
    const strandedEntryId = await postedRegistration(db, movedId, deletedInvoice, 'PAY-AGAINST-DELETED')
    await postedRegistration(db, sameId, sameInvoice, 'PAY-AGAINST-THIS')

    const [{ now }] = await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`
    const invoices = new Map([
      [replacementInvoice, zeroPaidInvoice(replacementInvoice)],
      [sameInvoice, zeroPaidInvoice(sameInvoice)],
    ])
    const residual = await readSalesResidualVerdicts(
      invoices as never, new Set([replacementInvoice, sameInvoice]), databaseLedgerFence(now),
    )

    // THE HEADLINE. Note which direction the danger runs in: the stranded row must not be counted as
    // `posted` (it would answer for a document it never touched) and must not be DROPPED either — a
    // document whose only registration vanished reads as NOTHING_REGISTERED, which is an ADMITTED
    // reversal. Undecided is the only honest answer, and it withholds.
    assert.ok(!residual.zeroPaidReversed.has(replacementInvoice),
      'a payment IMS registered against a document that no longer exists says nothing about the '
      + 'replacement, in either direction — the ledger may still be holding that money')
    assert.ok(!residual.provenGone.has(replacementInvoice))
    const withheld = residual.withheld.find((w) => w.doc.id === movedId)
    assert.ok(withheld, 'it must be WITHHELD and reported')
    assert.equal(withheld.verdict.verdict, 'REGISTRATION_UNDECIDED')
    assert.deepEqual(
      withheld.verdict.verdict === 'REGISTRATION_UNDECIDED' ? withheld.verdict.entryIds : null,
      [strandedEntryId],
      'and it NAMES the stranded entry, because that row is what a human has to look at')

    // THE CONTROL. Same shape, same fence, same zero — the payload names the document the order
    // actually points at, so the ledger's list decides and the reversal is admitted.
    assert.ok(residual.zeroPaidReversed.has(sameInvoice),
      'a registration against THIS document is still evidence about it — the binding narrows the '
      + 'evidence, it does not switch the pass off')
  },
)

// ---------------------------------------------------------------------------
// o3d-psrx r7 (Codex HIGH 1) — A GBP 1 RECEIPT DISAPPEARING DOES NOT REVERSE A GBP 100 ORDER.
//
// THE FINDING, END TO END. r6 made `addPayment` keep `SalesOrder.unregisteredPaidAt` through a
// PARTIAL receipt: a GBP 1 receipt on a GBP 100 order marked paid off-ledger no longer erased the
// provenance of the other GBP 99. The READER consulted that marker only when nothing had posted — so
// the moment the GBP 1 receipt's registration posted and bound, the marker was silent. Retire that
// registration, read a zero-paid invoice, and the classifier returned GONE:
// `zeroPaidIsProvenReversal` admitted it, the poller cleared `paidAt`, and
// `raiseChargebackForReversedOrder` unwound the WHOLE GBP 100 against a customer who paid.
//
// WHY THIS IS HERE AND NOT ONLY IN THE UNIT FILE. The unit tests pin the DECISION. This pins the
// WIRING — the order's total and currency being read at all, the registration's payload amount being
// read through the same helper the enqueue writes it with, and both arriving at the classifier — and
// wiring is what every finding in this branch has actually been. It drives the poller's OWN query
// (`readSalesResidualVerdicts`) against real rows and asserts on the set the reversal pass consumes.
//
// THE CONTROL IS PAIRED, as everywhere else in this file: the same order, the same missing
// registration, differing only in the amount that registration told the ledger about. "Withhold
// whenever a marker is present" would pass the headline and disable chargeback detection for every
// hand-marked and channel-paid order in the system.
// ---------------------------------------------------------------------------

test(
  '[o3d-psrx r7] a part-covering registration going missing does NOT reverse the whole off-ledger order',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const db = await loadDb()
    const { readSalesResidualVerdicts } = await import('@/lib/connectors/xero/payment-poller')
    const { databaseLedgerFence } = await import('@/lib/connectors/xero/invoice-delta')

    const partId = probeId()
    const fullId = probeId()
    const partInvoice = `INV-${partId}`
    const fullInvoice = `INV-${fullId}`
    t.after(async () => {
      await db.payment.deleteMany({ where: { orderId: { in: [partId, fullId] } } })
      await db.accountingSyncLog.deleteMany({ where: { referenceType: 'SalesOrder', referenceId: { in: [partId, fullId] } } })
      await db.salesOrder.deleteMany({ where: { id: { in: [partId, fullId] } } })
    })

    // BOTH orders: GBP 100, held as paid on evidence the ledger was never given. Identical rows.
    // The control carries the marker TOO: the two arms must differ in the amount and in nothing else,
    // or this proves the marker matters rather than that the coverage does.
    await createPaidOrder(db, partId, partInvoice, { unregisteredPaidAt: new Date('2026-08-01T09:00:00.000Z') })
    await createPaidOrder(db, fullId, fullInvoice, { unregisteredPaidAt: new Date('2026-08-01T09:00:00.000Z') })

    // The receipts IMS recorded. One covers a penny of the order; one covers all of it.
    const partReceipt = await db.payment.create({
      data: { orderId: partId, amount: 1, currency: 'GBP', method: 'Card', paidAt: new Date('2026-08-02T09:00:00.000Z') },
      select: { id: true },
    })
    const fullReceipt = await db.payment.create({
      data: { orderId: fullId, amount: 100, currency: 'GBP', method: 'Card', paidAt: new Date('2026-08-02T09:00:00.000Z') },
      select: { id: true },
    })

    // Their registrations POSTED — SYNCED, with a ledger payment id, database-stamped before the read.
    await postedRegistration(db, partId, partInvoice, 'PAY-PENNY', 1, partReceipt.id)
    await postedRegistration(db, fullId, fullInvoice, 'PAY-WHOLE', 100, fullReceipt.id)

    // PRECONDITIONS, because both assertions below are worthless if the rows are undecidable for some
    // unrelated reason. The classifier must be reaching the coverage arm, not the fence arm.
    const stamped = await db.accountingSyncLog.findMany({
      where: { referenceType: 'SalesOrder', referenceId: { in: [partId, fullId] } },
      select: { syncedAt: true, syncedAtDatabaseClock: true },
    })
    assert.equal(stamped.length, 2)
    for (const row of stamped) {
      assert.ok(
        row.syncedAt != null && row.syncedAtDatabaseClock != null
        && row.syncedAt.getTime() === row.syncedAtDatabaseClock.getTime(),
        'each registration must be database-stamped, or the verdict is REGISTRATION_UNDECIDED and '
        + 'both arms would pass for the wrong reason',
      )
    }
    const markers = await db.salesOrder.findMany({
      where: { id: { in: [partId, fullId] } },
      select: { id: true, unregisteredPaidAt: true },
    })
    assert.ok(markers.every((m) => m.unregisteredPaidAt != null),
      'PRECONDITION: both orders must still carry the off-ledger marker — the guard is gated on it')

    const [{ now }] = await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`
    const invoices = new Map([
      [partInvoice, zeroPaidInvoice(partInvoice)],
      [fullInvoice, zeroPaidInvoice(fullInvoice)],
    ])
    const residual = await readSalesResidualVerdicts(
      invoices as never, new Set([partInvoice, fullInvoice]), databaseLedgerFence(now),
    )

    // THE HEADLINE.
    assert.ok(!residual.zeroPaidReversed.has(partInvoice),
      'THE FINDING: the GBP 1 payment IMS registered is gone from the ledger, and r6 read that as the '
      + 'whole GBP 100 order being reversed — a chargeback credit note against a customer who paid')
    assert.ok(!residual.provenGone.has(partInvoice), 'and it is not promoted by the identity route either')
    const withheld = residual.withheld.find((w) => w.doc.id === partId)
    assert.ok(withheld, 'it must be WITHHELD and reported, not silently dropped')
    assert.equal(withheld.verdict.verdict, 'PART_COVERED_OFF_LEDGER')
    assert.deepEqual(
      withheld.verdict.verdict === 'PART_COVERED_OFF_LEDGER'
        ? { registeredTotal: withheld.verdict.registeredTotal, documentTotal: withheld.verdict.documentTotal }
        : null,
      { registeredTotal: 1, documentTotal: 100 },
      'and it carries BOTH numbers, read from the registration\'s own payload and from the order — '
      + 'which is the wiring this test exists for',
    )

    // THE CONTROL. Same order shape, same standing marker, same emptied ledger. The registration that
    // went missing settled the WHOLE order, so its absence really is a reversal of the whole order.
    assert.ok(residual.zeroPaidReversed.has(fullInvoice),
      'a registration that covered the order and is now absent from a list IMS could read in full is '
      + 'still a proven reversal — the guard narrows the evidence, it does not switch the pass off')
  },
)
