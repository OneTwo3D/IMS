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
        payload: {},
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
