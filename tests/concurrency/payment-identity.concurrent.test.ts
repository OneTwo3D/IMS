import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

/**
 * PAYMENT IDENTITY AND THE CANCELLATION INSTANT, ON A REAL DATABASE.
 *
 *   1. SAME RECEIPT, TWO ROWS, RACED UNDER THE REAL MONEY-POST LOCK: exactly one posts (D11). The loser is
 *      either refused for the lock or, once the winner's payment is in the ledger, refused as a repeat.
 *   2. DIFFERENT RECEIPTS (a deposit and a balance) raced the same way: the lock lets one through at a time,
 *      and BOTH end up posted - the loser's retry is not refused because the winner's payment is in the ledger.
 *   3. `sales_orders.cancelled_at` is minted by the DATABASE clock whatever the caller supplies, is preserved
 *      while the order stays cancelled, is cleared if the order is reopened, and stays NULL ("unknown") on a
 *      row that was cancelled before the trigger existed.
 *
 * NO NETWORK. `@/lib/connectors/xero/api` is replaced by a transport that answers from `ledger`.
 *
 * Gated behind RUN_DB_CONCURRENCY_TESTS=1: `npm run test:concurrency`.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const RUN_ID = `PAYID-${process.pid}-${randomUUID().slice(0, 8)}`

const ledger = new Map<string, Array<Record<string, unknown>>>()
mock.module('@/lib/connectors/xero/api', {
  namedExports: {
    xeroGet: async (path: string) => {
      const invoiceId = decodeURIComponent(path.replace(/^Invoices\//, ''))
      const payments = ledger.get(invoiceId) ?? []
      const paid = payments.reduce((sum, p) => sum + Number(p.Amount), 0)
      return { ok: true, status: 200, data: { Invoices: [{ InvoiceID: invoiceId, CurrencyCode: 'GBP', Total: 100, AmountPaid: paid, AmountDue: 100 - paid, Payments: payments }] } }
    },
  },
})

function loadEnv(): void {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
}

async function deps() {
  loadEnv()
  const [{ db }, probe, evidence, retry] = await Promise.all([
    import('../../lib/db/index.ts'),
    import('../../lib/connectors/accounting-settlement-probe.ts'),
    import('../../lib/domain/accounting/ledger-settlement-evidence.ts'),
    import('../../lib/domain/accounting/followup-retry-guard.ts'),
  ])
  return { db, postMoneyUnderLedgerFence: probe.postMoneyUnderLedgerFence, settlementMarkerFor: evidence.settlementMarkerFor, effectiveTokenFor: retry.effectiveTokenFor }
}
type Deps = Awaited<ReturnType<typeof deps>>

type Seed = { orderId: string; invoiceId: string; cleanup: () => Promise<void> }

async function seedOrder(d: Deps, label: string): Promise<Seed> {
  const orderId = `${RUN_ID}-${label}`
  const invoiceId = `INV-${orderId}`
  await d.db.salesOrder.create({
    data: {
      id: orderId, status: 'PROCESSING', currency: 'GBP', subtotalForeign: 100, totalForeign: 100, subtotalBase: 100, totalBase: 100,
      taxForeign: 0, accountingInvoiceId: invoiceId, accountingInvoiceConnector: 'xero',
    },
  })
  ledger.set(invoiceId, [])
  return {
    orderId, invoiceId,
    cleanup: async () => {
      await d.db.accountingSyncLog.deleteMany({ where: { referenceType: 'SalesOrder', referenceId: orderId } })
      await d.db.payment.deleteMany({ where: { orderId } })
      await d.db.salesOrder.deleteMany({ where: { id: orderId } })
      ledger.delete(invoiceId)
    },
  }
}

async function receipt(d: Deps, orderId: string, amount: number): Promise<string> {
  return (await d.db.payment.create({ data: { orderId, amount, currency: 'GBP', paidAt: new Date('2026-08-09T12:00:00Z') }, select: { id: true } })).id
}

async function queuedRow(d: Deps, s: Seed, paymentId: string, amount: number, date: string): Promise<{ id: string; payload: Record<string, unknown> }> {
  const payload = { accountingInvoiceId: s.invoiceId, bankAccountId: 'BANK', amount, amountDecimal: String(amount), currency: 'GBP', paymentDate: date, paymentId }
  const row = await d.db.accountingSyncLog.create({
    data: { connector: 'xero', type: 'INVOICE_PAYMENT', status: 'PENDING', referenceType: 'SalesOrder', referenceId: s.orderId, payload },
    select: { id: true },
  })
  return { id: row.id, payload }
}

/** One fenced post attempt for `row`: the "remote call" appends the payment, carrying the row's own mark, to the stub ledger. */
async function attempt(d: Deps, s: Seed, row: { id: string; payload: Record<string, unknown> }, counter: { posted: string[] }) {
  return d.postMoneyUnderLedgerFence({
    connector: 'xero', entryId: row.id, type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: s.orderId,
    payload: row.payload, postingDate: String(row.payload.paymentDate), db: d.db as never,
  }, async () => {
    counter.posted.push(row.id)
    ledger.get(s.invoiceId)!.push({
      PaymentID: `PAY-${row.id}`, Date: row.payload.paymentDate, Amount: row.payload.amount,
      Reference: d.settlementMarkerFor(d.effectiveTokenFor('xero', { id: row.id, payload: row.payload })),
    })
    return { success: true, externalId: `PAY-${row.id}` }
  })
}

test('payment identity on a real database', { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' }, async (t) => {
  const d = await deps()

  await t.test('1. the SAME receipt: one row raced by two workers posts once; a second row for it (the first FAILED after its payment landed) is refused (3 rounds)', async (tt) => {
    for (let round = 0; round < 3; round++) {
      const s = await seedOrder(d, `same-${round}`)
      tt.after(s.cleanup)
      const pay = await receipt(d, s.orderId, 100)
      // (the live-unique index admits ONE live row per receipt and document, so the race that exists is
      // two workers on the SAME row - the processor and the outbox worker - and a replacement row queued
      // after the first went FAILED)
      const a = await queuedRow(d, s, pay, 100, '2026-08-09')
      const counter = { posted: [] as string[] }
      await Promise.all([attempt(d, s, a, counter), attempt(d, s, a, counter)])
      if (counter.posted.length === 0) await attempt(d, s, a, counter)
      assert.equal(counter.posted.length, 1, 'one real payment, however the two workers interleaved')
      assert.equal(ledger.get(s.invoiceId)!.length, 1)
      // The first row's response is lost: FAILED, its payment IS in the ledger. A replacement row for the same receipt.
      await d.db.accountingSyncLog.update({ where: { id: a.id }, data: { status: 'FAILED' } })
      const b = await queuedRow(d, s, pay, 100, '2026-08-09')
      const repeat = await attempt(d, s, b, counter)
      console.log(`[D11] round ${round}: posted=${counter.posted.length} replacement=${JSON.stringify(repeat).slice(0, 150)}`)
      assert.equal(repeat.success, false, 'the replacement row for the same receipt is refused')
      assert.equal(counter.posted.length, 1)
      assert.equal(ledger.get(s.invoiceId)!.length, 1)
    }
  })

  await t.test('2. a deposit and a balance (different receipts) raced the same way BOTH post; the loser\'s retry is not refused by the winner (3 rounds)', async (tt) => {
    for (let round = 0; round < 3; round++) {
      const s = await seedOrder(d, `diff-${round}`)
      tt.after(s.cleanup)
      const dep = await receipt(d, s.orderId, 40)
      const bal = await receipt(d, s.orderId, 60)
      const a = await queuedRow(d, s, dep, 40, '2026-08-09')
      const b = await queuedRow(d, s, bal, 60, '2026-08-09')
      const counter = { posted: [] as string[] }
      await Promise.all([attempt(d, s, a, counter), attempt(d, s, b, counter)])
      for (const row of [a, b]) if (!counter.posted.includes(row.id)) {
        const retry = await attempt(d, s, row, counter)
        assert.equal(retry.success, true, `the second payment is not refused: ${JSON.stringify(retry)}`)
      }
      console.log(`[P-race] round ${round}: posted=${counter.posted.length} ledger=${ledger.get(s.invoiceId)!.length}`)
      assert.equal(counter.posted.length, 2)
      assert.equal(ledger.get(s.invoiceId)!.length, 2)
    }
  })

  await t.test('3. a 50/50 split on one day posts both (the deposit is attributed by its mark, not matched by amount and date)', async (tt) => {
    const s = await seedOrder(d, 'split')
    tt.after(s.cleanup)
    const dep = await receipt(d, s.orderId, 50)
    const bal = await receipt(d, s.orderId, 50)
    const a = await queuedRow(d, s, dep, 50, '2026-08-09')
    const b = await queuedRow(d, s, bal, 50, '2026-08-09')
    const counter = { posted: [] as string[] }
    assert.equal((await attempt(d, s, a, counter)).success, true)
    const second = await attempt(d, s, b, counter)
    console.log(`[P2] ${JSON.stringify(second)}`)
    assert.equal(second.success, true)
    assert.equal(counter.posted.length, 2)
  })

  await t.test('5. capacity is rechecked UNDER the money-post lock: two receipts that both passed the unlocked guard cannot both reach the wire over the invoice total', async (tt) => {
    const { guardInvoicePaymentCapacity } = await import('../../lib/domain/accounting/invoice-payment-capacity.ts')
    for (const countInFlight of [true, false]) {
      const s = await seedOrder(d, `cap-${countInFlight}`)
      tt.after(s.cleanup)
      // an invoice of 100, two DIFFERENT receipts of 60 each: only one fits.
      const r1 = await receipt(d, s.orderId, 60)
      const r2 = await receipt(d, s.orderId, 60)
      const a = await queuedRow(d, s, r1, 60, '2026-08-09')
      const b = await queuedRow(d, s, r2, 60, '2026-08-10')
      const guard = (row: { id: string; payload: Record<string, unknown> }, inFlight: boolean) => guardInvoicePaymentCapacity(d.db as never, {
        connector: 'xero', entryId: row.id, referenceType: 'SalesOrder', referenceId: s.orderId, accountingInvoiceId: s.invoiceId,
        amount: Number(row.payload.amount), payload: row.payload, countInFlight: inFlight,
      })
      // Both pass the UNLOCKED look: nothing has posted yet. This is the window the finding names.
      assert.equal((await guard(a, false)).post, true)
      assert.equal((await guard(b, false)).post, true)
      const counter = { posted: [] as string[] }
      const run = (row: { id: string; payload: Record<string, unknown> }) => d.postMoneyUnderLedgerFence({
        connector: 'xero', entryId: row.id, type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: s.orderId,
        payload: row.payload, postingDate: String(row.payload.paymentDate), db: d.db as never,
        recheckUnderLock: async () => {
          const again = await guard(row, countInFlight)
          return again.post ? { ok: true } : { ok: false, error: `Not sent: ${again.message}` }
        },
      }, async () => {
        counter.posted.push(row.id)
        // The processor marks the row PROCESSING while it works and SYNCED only AFTER the fence returns:
        // leave it PROCESSING, which is the window in which the next receipt takes the lock.
        await d.db.accountingSyncLog.update({ where: { id: row.id }, data: { status: 'PROCESSING' } })
        ledger.get(s.invoiceId)!.push({ PaymentID: `PAY-${row.id}`, Date: row.payload.paymentDate, Amount: row.payload.amount,
          Reference: d.settlementMarkerFor(d.effectiveTokenFor('xero', { id: row.id, payload: row.payload })) })
        return { success: true, externalId: `PAY-${row.id}` }
      })
      // ORDER IS FORCED, NOT SLEPT FOR: B starts only after A's fence call has returned (lock released), while
      // A's row is still PROCESSING and not yet SYNCED.
      const first = await run(a)
      const status = await d.db.accountingSyncLog.findUnique({ where: { id: a.id }, select: { status: true } })
      const second = await run(b)
      console.log(`[cap] countInFlight=${countInFlight}: A=${first.success} (A is ${status?.status}) B=${JSON.stringify(second).slice(0, 140)} posted=${counter.posted.length}`)
      assert.equal(first.success, true)
      assert.equal(status?.status, 'PROCESSING', 'precondition: A is on the wire/just returned but not SYNCED')
      if (countInFlight) {
        assert.equal(second.success, false, 'the second receipt is refused under the lock')
        assert.equal(counter.posted.length, 1)
      } else {
        // the control: without counting the in-flight row the SAME state lets the over-cap payment through.
        assert.equal(counter.posted.length, 2, 'control: the recheck counting in-flight rows is what stops the second')
      }
    }
  })

  await t.test('4. cancelled_at is minted by the database clock, preserved, cleared on reopen, and NULL where it was never known', async (tt) => {
    const id = `${RUN_ID}-cancel`
    tt.after(async () => { await d.db.salesOrder.deleteMany({ where: { id } }) })
    const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`
    const dbNow = async () => (await d.db.$queryRawUnsafe<Array<{ v: string }>>(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', ${ISO}) AS v`))[0]!.v
    const stored = async () => (await d.db.$queryRawUnsafe<Array<{ v: string | null }>>(`SELECT to_char("cancelled_at", ${ISO}) AS v FROM "sales_orders" WHERE id = $1`, id))[0]!.v
    await d.db.salesOrder.create({ data: { id, status: 'PROCESSING', currency: 'GBP', subtotalForeign: 1, totalForeign: 1, subtotalBase: 1, totalBase: 1 } })
    assert.equal(await stored(), null, 'an active order has no cancellation instant')

    // A caller supplying an hour in the DATABASE's future cannot put its clock in the column.
    const before = await dbNow()
    const ahead = new Date(Date.parse(before.slice(0, -1) + 'Z') + 3_600_000)
    await d.db.salesOrder.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: ahead } })
    const after = await dbNow()
    const first = await stored()
    console.log(`[cancelled_at] ${before} <= ${first} <= ${after}`)
    assert.ok(first && first >= before && first <= after, 'the instant is a database clock reading taken during the write')

    // Preserved while the order stays cancelled, even when a statement names another value.
    await d.db.salesOrder.update({ where: { id }, data: { notes: 'touched', cancelledAt: new Date('2001-01-01T00:00:00Z') } })
    assert.equal(await stored(), first, 'a writer cannot move the instant')

    // Reopened by a bypass: the episode ends.
    await d.db.salesOrder.update({ where: { id }, data: { status: 'PROCESSING' } })
    assert.equal(await stored(), null)
    // A later cancellation is a NEW instant.
    await d.db.salesOrder.update({ where: { id }, data: { status: 'CANCELLED' } })
    const second = await stored()
    assert.ok(second && second > first!, 'a new cancellation is a new instant')

    // A row cancelled before the trigger existed (simulated by suspending it) stays NULL = unknown.
    await d.db.$executeRawUnsafe('ALTER TABLE "sales_orders" DISABLE TRIGGER sales_order_stamp_cancelled_at_trigger')
    try {
      await d.db.$executeRawUnsafe(`UPDATE "sales_orders" SET "cancelled_at" = NULL WHERE id = $1`, id)
    } finally {
      await d.db.$executeRawUnsafe('ALTER TABLE "sales_orders" ENABLE TRIGGER sales_order_stamp_cancelled_at_trigger')
    }
    await d.db.salesOrder.update({ where: { id }, data: { notes: 'again' } })
    assert.equal(await stored(), null, 'unknown stays unknown: no instant is invented for an order already cancelled')

    // Inserted as cancelled: stamped.
    const id2 = `${id}-ins`
    tt.after(async () => { await d.db.salesOrder.deleteMany({ where: { id: id2 } }) })
    await d.db.salesOrder.create({ data: { id: id2, status: 'CANCELLED', currency: 'GBP', subtotalForeign: 1, totalForeign: 1, subtotalBase: 1, totalBase: 1 } })
    const row = (await d.db.$queryRawUnsafe<Array<{ n: boolean }>>(`SELECT ("cancelled_at" IS NOT NULL) AS n FROM "sales_orders" WHERE id = $1`, id2))[0]!
    assert.equal(row.n, true)
  })
})
