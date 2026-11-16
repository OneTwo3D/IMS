import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * ACC-H6 — A PAYMENT REMOVED IN XERO TO BE RE-APPLIED MUST NOT RAISE A CHARGEBACK.
 *
 * Removing a payment to re-match it leaves the invoice AUTHORISED with a clean zero for a few minutes.
 * That used to be admitted as a reversal at once and a chargeback credit note was raised. The reading
 * now withholds a zero whose invoice was revised inside the grace window and admits it only once it
 * has STOOD. Runs the poller's own `readSalesResidualVerdicts` against real rows.
 *
 * Gated behind RUN_DB_CONCURRENCY_TESTS=1: `npm run test:concurrency`.
 */
const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'

async function loadDb() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const url = process.env.DATABASE_URL
  if (!url || !(url.startsWith('postgres://') || url.startsWith('postgresql://'))) {
    throw new Error('requires a Postgres DATABASE_URL')
  }
  const { db } = await import('@/lib/db')
  return db
}

const xeroDate = (d: Date) => `/Date(${d.getTime()}+0000)/`

function zeroPaid(invoiceId: string, updated?: Date) {
  return {
    InvoiceID: invoiceId, Type: 'ACCREC', Status: 'AUTHORISED', AmountPaid: 0, AmountDue: 100, Payments: [],
    ...(updated ? { UpdatedDateUTC: xeroDate(updated) } : {}),
  }
}

test(
  '[ACC-H6] a payment removed minutes ago is withheld (no chargeback); one that has stood is admitted',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const db = await loadDb()
    const { readSalesResidualVerdicts, XERO_PAYMENT_REMOVAL_GRACE_MS } = await import('@/lib/connectors/xero/payment-poller')
    const { databaseLedgerFence } = await import('@/lib/connectors/xero/invoice-delta')

    const fresh = `ACCH6-${randomUUID()}`
    const aged = `ACCH6-${randomUUID()}`
    const unstamped = `ACCH6-${randomUUID()}`
    const ids = [fresh, aged, unstamped]
    t.after(async () => { await db.salesOrder.deleteMany({ where: { id: { in: ids } } }) })
    for (const id of ids) {
      await db.salesOrder.create({
        data: {
          id, status: 'SHIPPED', currency: 'GBP', subtotalForeign: '100', totalForeign: '100', subtotalBase: '100',
          totalBase: '100', accountingInvoiceId: `INV-${id}`, paidAt: new Date('2026-08-01T09:00:00.000Z'),
          unregisteredPaidAt: null,
        },
      })
    }

    const now = new Date()
    const invoices = new Map([
      [`INV-${fresh}`, zeroPaid(`INV-${fresh}`, new Date(now.getTime() - 5 * 60_000))],
      [`INV-${aged}`, zeroPaid(`INV-${aged}`, new Date(now.getTime() - XERO_PAYMENT_REMOVAL_GRACE_MS - 60_000))],
      [`INV-${unstamped}`, zeroPaid(`INV-${unstamped}`)],
    ])
    const [{ now: dbNow }] = await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`
    const residual = await readSalesResidualVerdicts(invoices as never, new Set(invoices.keys()), databaseLedgerFence(dbNow), now)

    assert.ok(!residual.zeroPaidReversed.has(`INV-${fresh}`), 'a removal seconds old must not be a reversal (re-apply in progress)')
    const held = residual.withheld.find((w) => w.doc.id === fresh)
    assert.ok(held, 'it must be withheld and reported, not dropped')
    assert.equal(held.reason, 'removal-grace')
    assert.ok(residual.zeroPaidReversed.has(`INV-${aged}`), 'a zero that has stood past the window IS a reversal (chargeback path intact)')
    assert.ok(residual.zeroPaidReversed.has(`INV-${unstamped}`), 'an unreadable revision stamp does not withhold (previous behaviour)')

    // The recheck: the SAME invoice read again after the window has elapsed is admitted.
    const later = new Date(now.getTime() + XERO_PAYMENT_REMOVAL_GRACE_MS + 60_000)
    const again = await readSalesResidualVerdicts(
      new Map([[`INV-${fresh}`, invoices.get(`INV-${fresh}`)!]]) as never, new Set([`INV-${fresh}`]), databaseLedgerFence(dbNow), later,
    )
    assert.ok(again.zeroPaidReversed.has(`INV-${fresh}`), 'still unpaid after the window: now a genuine reversal')
  },
)
