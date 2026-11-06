import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

/**
 * THE MONEY-POST LOCK DIES WITH ITS CONNECTION; THE CONNECTOR'S IDEMPOTENCY KEY IS WHAT STOPS THE SECOND PAYMENT.
 *
 * The real lock, the real fence, the real database. Worker A takes the per-document lock, reads an empty ledger, passes the held-check and is
 * "in flight" to the accounting system. Its lock connection is then terminated (pg_terminate_backend: a dropped socket, a failover, an idle
 * killer) - PostgreSQL frees the lock - and worker B, a DIFFERENT sync row for the SAME receipt (queued in another scope: the live-unique index admits one live row per scope, which is exactly why the lock is keyed on the document), takes it, reads the same empty ledger and posts.
 * A's request then reaches the remote system too. No lock can undo that: the question is whether the remote system sees one request or two.
 *
 *   arm 1  the key the Xero processor sends (xeroMoneyPostIdempotencyKey): both requests carry one key; the remote answers the second with
 *          the first's result; ONE payment exists
 *   arm 2  CONTROL, the key as it was (derived from the row): the same interleaving creates TWO payments - the harness reproduces the bug
 *   arm 3  a deposit and a balance (two receipts, one invoice) through the same interleaving: BOTH post (the key does not swallow a real second payment)
 *
 * No network: the remote system is a double that implements Idempotency-Key replay. Mutation: derive the key from the row again -> arm 1 sees two payments.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const RUN_ID = `LLI-${process.pid}-${randomUUID().slice(0, 8)}`

// the remote accounting system: payments on invoices, and Xero-style Idempotency-Key replay
const ledger = new Map<string, Array<Record<string, unknown>>>()
const replay = new Map<string, { PaymentID: string }>()
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

function remotePost(invoiceId: string, key: string, amount: number, reference: string): { PaymentID: string } {
  const seen = replay.get(key)
  if (seen) return seen
  const created = { PaymentID: `PAY-${randomUUID().slice(0, 8)}` }
  ledger.get(invoiceId)!.push({ ...created, Amount: amount, Reference: reference, Date: '2026-08-09' })
  replay.set(key, created)
  return created
}

function loadEnv(): void {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
}

async function deps() {
  loadEnv()
  const [{ db }, probe, evidence, retry, doc, lockIds, processor] = await Promise.all([
    import('../../lib/db/index.ts'),
    import('../../lib/connectors/accounting-settlement-probe.ts'),
    import('../../lib/domain/accounting/ledger-settlement-evidence.ts'),
    import('../../lib/domain/accounting/followup-retry-guard.ts'),
    import('../../lib/domain/accounting/money-post-document.ts'),
    import('../../lib/db/advisory-locks.ts'),
    import('../../lib/connectors/xero/sync-processor.ts'),
  ])
  return {
    db, postMoneyUnderLedgerFence: probe.postMoneyUnderLedgerFence, settlementMarkerFor: evidence.settlementMarkerFor,
    effectiveTokenFor: retry.effectiveTokenFor, moneyPostDocumentLockId: doc.moneyPostDocumentLockId, settlementDocumentKey: doc.settlementDocumentKey,
    namespace: lockIds.ACCOUNTING_MONEY_POST_LOCK_NAMESPACE, buildXeroIdempotencyKey: processor.buildXeroIdempotencyKey,
    resolveXeroMoneyPostIdempotencyKey: processor.resolveXeroMoneyPostIdempotencyKey,
  }
}
type Deps = Awaited<ReturnType<typeof deps>>
type Row = { id: string; referenceId: string; payload: Record<string, unknown> }
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
      await d.db.accountingSyncLog.deleteMany({ where: { referenceType: 'SalesOrder', referenceId: { in: [orderId, `${orderId}-b`] } } })
      await d.db.payment.deleteMany({ where: { orderId } })
      await d.db.salesOrder.deleteMany({ where: { id: orderId } })
      ledger.delete(invoiceId)
    },
  }
}

async function receipt(d: Deps, orderId: string, amount: number): Promise<string> {
  return (await d.db.payment.create({ data: { orderId, amount, currency: 'GBP', paidAt: new Date('2026-08-09T12:00:00Z') }, select: { id: true } })).id
}

/** A queued INVOICE_PAYMENT row. `generation` gives each row its own follow-up token, as two rows for one receipt have. */
async function queuedRow(d: Deps, s: Seed, paymentId: string, amount: number, generation: string, referenceId = s.orderId): Promise<Row> {
  const payload = {
    accountingInvoiceId: s.invoiceId, bankAccountId: 'BANK', amount, amountDecimal: String(amount), currency: 'GBP', paymentDate: '2026-08-09', paymentId,
    _followUpIdempotencyKey: `followup:xero:INVOICE_PAYMENT:SalesOrder:${s.orderId}:${generation}`,
  }
  const row = await d.db.accountingSyncLog.create({
    data: { connector: 'xero', type: 'INVOICE_PAYMENT', status: 'PENDING', referenceType: 'SalesOrder', referenceId, payload, attemptStampingCustodyAt: new Date() },
    select: { id: true },
  })
  return { id: row.id, referenceId, payload }
}

type KeyOf = (d: Deps, row: Row) => string | Promise<string>

/** The production post, minus the transport: the fence with the real lock, the request keyed by `keyOf`, answered by the remote double. */
async function attempt(d: Deps, s: Seed, row: Row, keyOf: KeyOf, inFlight?: { entered: () => void; gate: Promise<void> }) {
  // resolved before the fence, as the processor does
  const key = await keyOf(d, row)
  return d.postMoneyUnderLedgerFence({
    connector: 'xero', entryId: row.id, type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: row.referenceId,
    payload: row.payload, postingDate: String(row.payload.paymentDate), db: d.db as never,
  }, async () => {
    if (inFlight) { inFlight.entered(); await inFlight.gate }
    const mark = d.settlementMarkerFor(d.effectiveTokenFor('xero', { id: row.id, payload: row.payload }))
    const res = remotePost(s.invoiceId, key, Number(row.payload.amount), mark)
    return { success: true, externalId: res.PaymentID }
  })
}

const documentKeyOf: KeyOf = (d, row) => d.resolveXeroMoneyPostIdempotencyKey(d.db as never, { entryId: row.id, type: 'INVOICE_PAYMENT', payload: row.payload, operation: 'invoice-payment' })
const rowKeyOf: KeyOf = (d, row) => d.buildXeroIdempotencyKey(row.id, 'invoice-payment')

/** Terminate the backend holding `row`'s document lock - exactly what a dropped connection does to a session advisory lock. */
async function killLockHolder(d: Deps, row: Row): Promise<void> {
  const lockId = d.moneyPostDocumentLockId({
    connector: 'xero', type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: 'x',
    documentKey: d.settlementDocumentKey('INVOICE_PAYMENT', row.payload),
  })
  const holders = await d.db.$queryRaw<Array<{ pid: number }>>`
    SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted AND classid = ${d.namespace >>> 0}::oid AND objid = ${lockId >>> 0}::oid`
  assert.equal(holders.length, 1, 'PRECONDITION: exactly one backend holds the document lock')
  await d.db.$queryRaw`SELECT pg_terminate_backend(${holders[0]!.pid}::int)`
  for (let i = 0; i < 100; i++) {
    const left = await d.db.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND granted AND classid = ${d.namespace >>> 0}::oid AND objid = ${lockId >>> 0}::oid`
    if (Number(left[0]!.n) === 0) return
    await new Promise((r) => setTimeout(r, 50))
  }
  assert.fail('the terminated backend still holds the lock')
}

/** A in flight, its lock connection killed, B (a second row) posts; then A's request reaches the remote. */
async function lostLockInterleaving(d: Deps, s: Seed, a: Row, b: Row, keyOf: KeyOf) {
  let entered: () => void = () => {}
  const aInFlight = new Promise<void>((resolve) => { entered = resolve })
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  const workerA = attempt(d, s, a, keyOf, { entered, gate })
  await aInFlight
  await killLockHolder(d, a)
  const outcomeB = await attempt(d, s, b, keyOf)
  release()
  const outcomeA = await workerA.catch((error) => ({ success: false as const, error: String(error) }))
  return { outcomeA, outcomeB }
}

test('a lost money-post lock does not make a second payment when the connector key is the settlement\'s', { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' }, async (t) => {
  const d = await deps()

  await t.test('1. same receipt, two rows, lock lost mid-call: both requests carry one key and ONE payment exists (3 rounds)', async (tt) => {
    for (let round = 0; round < 3; round++) {
      const s = await seedOrder(d, `doc-${round}`)
      tt.after(s.cleanup)
      const pay = await receipt(d, s.orderId, 100)
      const a = await queuedRow(d, s, pay, 100, `A${round}`)
      const b = await queuedRow(d, s, pay, 100, `B${round}`, `${s.orderId}-b`)
      assert.equal(await documentKeyOf(d, a), await documentKeyOf(d, b), 'PRECONDITION: the two rows send one key')
      const { outcomeA, outcomeB } = await lostLockInterleaving(d, s, a, b, documentKeyOf)
      assert.equal(outcomeB.success, true, `B posts: ${JSON.stringify(outcomeB)}`)
      assert.equal(ledger.get(s.invoiceId)!.length, 1, `round ${round}: the remote holds ONE payment (A: ${JSON.stringify(outcomeA).slice(0, 160)})`)
    }
  })

  await t.test('2. CONTROL: the same interleaving with the key derived from the row creates TWO payments', async (tt) => {
    const s = await seedOrder(d, 'row')
    tt.after(s.cleanup)
    const pay = await receipt(d, s.orderId, 100)
    const a = await queuedRow(d, s, pay, 100, 'A')
    const b = await queuedRow(d, s, pay, 100, 'B', `${s.orderId}-b`)
    await lostLockInterleaving(d, s, a, b, rowKeyOf)
    assert.equal(ledger.get(s.invoiceId)!.length, 2, 'the harness reproduces the duplicate when the key is the row\'s')
  })

  await t.test('3. a deposit and a balance through the same interleaving BOTH post: the key does not swallow a real second payment', async (tt) => {
    const s = await seedOrder(d, 'two')
    tt.after(s.cleanup)
    const dep = await receipt(d, s.orderId, 40)
    const bal = await receipt(d, s.orderId, 60)
    const a = await queuedRow(d, s, dep, 40, 'A')
    const b = await queuedRow(d, s, bal, 60, 'B', `${s.orderId}-b`)
    assert.notEqual(await documentKeyOf(d, a), await documentKeyOf(d, b))
    const { outcomeB } = await lostLockInterleaving(d, s, a, b, documentKeyOf)
    assert.equal(outcomeB.success, true, JSON.stringify(outcomeB))
    assert.equal(ledger.get(s.invoiceId)!.length, 2)
    assert.deepEqual(ledger.get(s.invoiceId)!.map((p) => Number(p.Amount)).sort((x, y) => x - y), [40, 60])
  })
})
