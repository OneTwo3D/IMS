import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * o3d-psrx — A POLL BETWEEN THE COMMIT AND THE QUEUEING CANNOT SEE A PAID ORDER WITH NO RECEIPT.
 *
 * `addPayment` writes the local `Payment` row and the order's `paidAt` and then, AFTER that
 * transaction commits, queues the INVOICE_PAYMENT registration — with a `revalidatePath` and an
 * awaited `logActivity` in between. A payment poll landing in that gap found no registration, read it
 * as NOTHING_REGISTERED ("IMS never told the ledger about a payment here"), cleared `paidAt` and
 * raised a chargeback credit note against revenue nobody reversed.
 *
 * The registration cannot be moved inside the transaction the way `markBillPaid`'s was: a bill
 * payment is an INSTRUCTION and rolling it back is honest, while a customer receipt is a FACT an
 * operator recorded, and `registerInvoicePaymentWithLedger` must never fail it. So the reader is
 * given a witness that IS in the right transaction — the receipt itself.
 *
 * WHAT THIS TEST PROVES, AND WHY IT IS THE INVARIANT AND NOT THE VERDICT. That the verdict withholds
 * is decided by pure functions and pinned by unit tests. What only a real database can establish is
 * that the witness is ALWAYS THERE TO BE READ: that no concurrent reader, at any interleaving, can
 * observe `paidAt` set and the receipt absent. Two writes in one transaction have that property and
 * two writes in two transactions do not, and no amount of reasoning about a double can tell them
 * apart — the property is PostgreSQL's snapshot isolation.
 *
 * THE READ IS ONE STATEMENT. `paidAt` and the receipt count come from a single SELECT, so they are
 * one snapshot. Reading them as two queries would measure the reader's own interleaving instead of
 * the writer's, and would fail even against a correct writer.
 *
 * Gated behind RUN_DB_CONCURRENCY_TESTS=1: `npm run test:concurrency`.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'

/** How many independent orders the race is run against. One is a coin toss; this is a sweep. */
const ROUNDS = 12
/** Guards a reader whose writer somehow never commits — a genuine failure, not a pass. */
const READER_TIMEOUT_MS = Number.parseInt(process.env.O3D_PSRX_READER_TIMEOUT_MS ?? '15000', 10)

function loadEnv() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
  if (!url.startsWith('postgres://') && !url.startsWith('postgresql://')) {
    throw new Error('o3d-psrx concurrency test requires a Postgres DATABASE_URL')
  }
}

const probeId = () => `PSRX-${process.pid}-${randomUUID()}`

type Observation = { paid: boolean; receipts: number }

async function loadDb() {
  loadEnv()
  const { db } = await import('@/lib/db')
  return db
}

/**
 * ONE snapshot of both facts. The LEFT JOIN keeps the row when there is no receipt yet, so "paid with
 * no receipt" is representable — a test whose query cannot express the failure state proves nothing.
 */
async function observe(db: Awaited<ReturnType<typeof loadDb>>, orderId: string): Promise<Observation | null> {
  const rows = await db.$queryRaw<Array<{ paid: boolean; receipts: bigint | number }>>`
    SELECT (so."paidAt" IS NOT NULL) AS paid,
           count(p.id) AS receipts
      FROM sales_orders so
      LEFT JOIN payments p ON p."orderId" = so.id AND p."refundId" IS NULL
     WHERE so.id = ${orderId}
     GROUP BY so.id, so."paidAt"
  `
  const row = rows[0]
  return row ? { paid: row.paid, receipts: Number(row.receipts) } : null
}

async function createUnpaidOrder(db: Awaited<ReturnType<typeof loadDb>>, id: string): Promise<void> {
  await db.salesOrder.create({
    data: {
      id,
      status: 'PROCESSING',
      currency: 'GBP',
      subtotalForeign: 100,
      totalForeign: 100,
      subtotalBase: 100,
      totalBase: 100,
    },
  })
}

test(
  '[o3d-psrx] no reader ever sees a paid order whose receipt has not committed',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const db = await loadDb()
    const orderIds: string[] = []
    t.after(async () => {
      await db.payment.deleteMany({ where: { orderId: { in: orderIds } } })
      await db.salesOrder.deleteMany({ where: { id: { in: orderIds } } })
    })

    /** Every observation across every round, so the assertions can also prove the race was REACHED. */
    const observations: Observation[] = []

    for (let round = 0; round < ROUNDS; round++) {
      const orderId = probeId()
      orderIds.push(orderId)
      await createUnpaidOrder(db, orderId)

      let committed = false
      const startedAt = Date.now()
      // The reader spins on its own connection from the pool while the writer's transaction runs, and
      // keeps going for one more pass AFTER the commit so the post-commit state is always sampled.
      const reader = (async () => {
        let sawCommitted = false
        while (!sawCommitted) {
          if (Date.now() - startedAt > READER_TIMEOUT_MS) {
            throw new Error('the writer never committed — the race was never run')
          }
          const observation = await observe(db, orderId)
          if (observation) observations.push(observation)
          sawCommitted = committed
        }
      })()

      // THE WRITER: `addPayment`'s shape exactly — the receipt and the paid flag in ONE transaction.
      const writer = db.$transaction(async (tx) => {
        await tx.payment.create({
          data: { orderId, amount: 100, currency: 'GBP', method: 'Bank Transfer', paidAt: new Date() },
        })
        await tx.salesOrder.update({ where: { id: orderId }, data: { paidAt: new Date() } })
      }).then(() => { committed = true })

      await Promise.all([writer, reader])
    }

    // THE INVARIANT. Not "usually", not "in the fixtures we happened to write" — never, at any
    // interleaving this sweep reached.
    //
    // MUTATION ROUTE: split the writer into two transactions with the `paidAt` update committed
    // FIRST (which is what `markBillPaid` did before o3d-a3wx, and what any later refactor that
    // "just moves the flag out of the hot transaction" would produce) and this fails immediately:
    // the reader lands between the two commits and records { paid: true, receipts: 0 } — the exact
    // state the poller read as NOTHING_REGISTERED.
    const blind = observations.filter((o) => o.paid && o.receipts === 0)
    assert.deepEqual(blind, [],
      'a paid order with no receipt is the window in which a poll raises a chargeback against a real payment')

    // AND THE SWEEP ACTUALLY REACHED BOTH SIDES. Without these the assertion above is satisfied by a
    // reader that only ever saw the unpaid state — a guard that never met its own precondition.
    assert.ok(observations.some((o) => !o.paid && o.receipts === 0), 'the before state must have been sampled')
    assert.ok(observations.some((o) => o.paid && o.receipts > 0), 'and so must the after state')
    assert.ok(observations.length >= ROUNDS * 2, `too few samples to have raced anything (${observations.length})`)
  },
)

test(
  '[o3d-psrx] the witness is what the poller reads: a committed receipt with no registration withholds',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    // The invariant above says the receipt is always visible. This says the visible receipt is
    // actually CONSULTED — against real rows, through the real pairing helper, so a fix that made the
    // witness durable and then never read it could not pass both.
    const db = await loadDb()
    const { unregisteredLocalReceipts } = await import('@/lib/connectors/xero/invoice-delta')
    const { payloadPaymentId } = await import('@/lib/domain/accounting/invoice-payment-enqueue')

    const orderId = probeId()
    t.after(async () => {
      await db.accountingSyncLog.deleteMany({ where: { referenceId: orderId } })
      await db.payment.deleteMany({ where: { orderId } })
      await db.salesOrder.deleteMany({ where: { id: orderId } })
    })
    await createUnpaidOrder(db, orderId)

    const receipt = await db.$transaction(async (tx) => {
      const payment = await tx.payment.create({
        data: { orderId, amount: 100, currency: 'GBP', paidAt: new Date() },
        select: { id: true },
      })
      await tx.salesOrder.update({ where: { id: orderId }, data: { paidAt: new Date() } })
      return payment
    })

    const readRegistrations = async () => (await db.accountingSyncLog.findMany({
      where: { connector: 'xero', type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: orderId },
      select: { status: true, payload: true },
    })).map((row) => ({ status: row.status, paymentId: payloadPaymentId(row.payload) }))

    const receiptIds = (await db.payment.findMany({
      where: { orderId, refundId: null }, select: { id: true },
    })).map((row) => row.id)

    // INSIDE the window: committed receipt, nothing queued.
    assert.deepEqual(unregisteredLocalReceipts(receiptIds, await readRegistrations()), [receipt.id])

    // One step later, exactly as `registerInvoicePaymentWithLedger` leaves it.
    await db.accountingSyncLog.create({
      data: {
        connector: 'xero',
        type: 'INVOICE_PAYMENT',
        status: 'PENDING',
        referenceType: 'SalesOrder',
        referenceId: orderId,
        payload: { paymentId: receipt.id, accountingInvoiceId: 'INV-PROBE', amount: 100 },
        attemptStampingCustodyAt: new Date(),
      },
    })
    assert.deepEqual(unregisteredLocalReceipts(receiptIds, await readRegistrations()), [],
      'once the registration names the receipt the window is closed and the poll decides normally again')
  },
)
