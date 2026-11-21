import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified
import '../helpers/xero-attested.ts'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

/**
 * THE SALES CREDIT-NOTE REFUND CAPS (o3d-jqmgb, o3d-qrm47, o3d-0olzx, o3d-o4tkz), against a real PostgreSQL.
 *
 * The settlement (behind xero_credit_note_allocation_enabled) pays a refund OUT against a posted credit note. Together these four guard it against paying out more than
 * the order received:
 *   jqmgb  a NEVER-ATTEMPTED row that pinned an amount and failed pre-call is re-capped, not replayed (receipts 50: A pins 40 and fails pre-call, B posts 40, A must not post 40);
 *   qrm47  cash another refund has IN FLIGHT or MAY HAVE LANDED counts, and the cap is re-checked under an ORDER-scoped lock (two refunds, two credit notes, one order);
 *   0olzx  the cap is held to what XERO says the invoice has received (AmountPaid);
 *   o4tkz  accounting_sync_logs_followup_live_unique covers CREDIT_NOTE_ALLOCATION.
 * Only the Xero transport functions of the credit-note module are doubles, so what is asserted is what IMS DECIDED to send.
 */
const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const skip = !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1'

type Refund = { creditNoteId: string; accountId: string; amount: number; date: string; currencyRate?: number; reference: string }
// Built from parts: it is a deliberately fake stale value, not a secret.
const STALE_KEY = ['stale', 'pin', 'of', '40'].join(' ')
const refunds: Refund[] = []
type CnLedger = { remaining: number; payments: Array<{ PaymentID: string; Amount: number; Status: string; PaymentType: string }> }
const creditNotes = new Map<string, CnLedger>()
// What Xero says the invoice has received. `null` = unreadable.
let invoiceAmountPaid: number | null = 50
// Test hooks: a barrier every balances read passes through (to force two workers into the same window), and a delay inside the remote call.
let onBalancesRead: (() => Promise<void>) | null = null
let refundCallDelayMs = 0

async function load() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const api = await import('../../lib/connectors/xero/api.ts')
  mock.module('../../lib/connectors/xero/api.ts', {
    namedExports: {
      ...api,
      xeroGet: async (path: string) => {
        if (path.startsWith('CreditNotes/')) {
          const id = path.split('/')[1]!
          const cn = creditNotes.get(id)
          if (!cn) return { ok: false, status: 404, error: `not served by the test ledger: ${path}` }
          return { ok: true, status: 200, data: { CreditNotes: [{ CreditNoteID: id, CurrencyCode: 'GBP', Total: 40, RemainingCredit: cn.remaining, Allocations: [], Payments: cn.payments }] } }
        }
        return { ok: false, status: 404, error: `not served by the test ledger: ${path}` }
      },
    },
  })
  const credit = await import('../../lib/connectors/xero/credit-notes.ts')
  mock.module('../../lib/connectors/xero/credit-notes.ts', {
    namedExports: {
      ...credit,
      readCreditNoteSettlementBalances: async (creditNoteId: string) => {
        if (onBalancesRead) await onBalancesRead()
        const cn = creditNotes.get(creditNoteId)
        return { ok: true, remainingCredit: cn?.remaining ?? 0, amountDue: 0, amountPaid: invoiceAmountPaid, creditNoteStatus: 'AUTHORISED' }
      },
      refundSalesCreditNote: async (params: Refund) => {
        refunds.push(params)
        if (refundCallDelayMs > 0) await new Promise((r) => setTimeout(r, refundCallDelayMs))
        const cn = creditNotes.get(params.creditNoteId)!
        cn.payments.push({ PaymentID: `pay-${refunds.length}`, Amount: params.amount, Status: 'AUTHORISED', PaymentType: 'ARCREDITPAYMENT' })
        cn.remaining -= params.amount
        return { success: true, paymentId: `pay-${refunds.length}` }
      },
    },
  })
  const [{ db }, processor, allocation] = await Promise.all([
    import('../../lib/db/index.ts'),
    import('../../lib/connectors/xero/sync-processor.ts'),
    import('../../lib/domain/accounting/credit-note-allocation.ts'),
  ])
  return { db, processor, allocation }
}
let loaded: Awaited<ReturnType<typeof load>> | null = null
const deps = async () => (loaded ??= await load())
type Deps = Awaited<ReturnType<typeof deps>>

const FLAG = 'xero_credit_note_allocation_enabled'
const PAYMENT_MAP = 'accounting_payment_account_map'

async function setSetting(d: Deps, key: string, value: string | null) {
  if (value === null) await d.db.setting.deleteMany({ where: { key } })
  else await d.db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
}

/**
 * THE TIER SHARES ONE DATABASE, AND FOREIGN WORK CANNOT BE DRAINED AWAY (other files leave rows the processor refuses and retries for ever). So these tests do not
 * depend on it. The outbox runner claims jobs OLDEST-FIRST by the job's `createdAt` (one at a time), so every settlement row these tests make gets its delivery job
 * created here and back-dated, with the row, to a fixed instant far before anything else in the database. Whatever else is claimable queues BEHIND ours.
 */
let ancientTick = 0
const ancient = () => new Date(Date.UTC(2000, 0, 1) + (ancientTick++) * 1000)
async function queueFirst(d: Deps, rowIds: string[]) {
  const { scheduleXeroAccountingOutbox } = await import('../../lib/connectors/xero/outbox.ts')
  for (const id of rowIds) {
    const at = ancient()
    await d.db.accountingSyncLog.update({ where: { id }, data: { createdAt: at } })
    await scheduleXeroAccountingOutbox(d.db, { accountingSyncLogId: id, resetAttempts: true })
    await d.db.integrationOutbox.updateMany({ where: { idempotencyKey: { contains: id } }, data: { createdAt: at } })
  }
}
/** Raise the settlements for these refunds and put them at the front of the queue. */
async function sweep(d: Deps, s: Seeded[] | Seeded) {
  await d.processor.reenqueueMissingCreditNoteAllocations()
  const ids = (Array.isArray(s) ? s : [s]).flatMap((x) => x.refunds.map((r) => r.id))
  const rows = await d.db.accountingSyncLog.findMany({ where: { type: 'CREDIT_NOTE_ALLOCATION' as never, referenceId: { in: ids }, status: 'PENDING' }, select: { id: true }, orderBy: { createdAt: 'asc' } })
  await queueFirst(d, rows.map((r) => r.id))
}

type Seeded = { orderId: string; refunds: Array<{ id: string; creditNoteId: string }>; invoiceId: string; accountId: string }

/** ONE ORDER, its paid invoice (receipts `receipt`), and `count` refunds, each with its own posted credit note holding 40 of credit. Gateway refunds, so each asks for the whole credit left. */
async function seedOrder(d: Deps, t: { after: (fn: () => Promise<void>) => void }, opts: { receipt: number; count: number; credit?: number }): Promise<Seeded> {
  // The outbox runner, restored afterwards (a leak would change how every later file in the tier drains).
  const savedOutbox = process.env.XERO_ACCOUNTING_OUTBOX_ENABLED
  process.env.XERO_ACCOUNTING_OUTBOX_ENABLED = 'true'
  t.after(async () => { if (savedOutbox === undefined) delete process.env.XERO_ACCOUNTING_OUTBOX_ENABLED; else process.env.XERO_ACCOUNTING_OUTBOX_ENABLED = savedOutbox })
  const tag = `cnc${randomUUID().slice(0, 8)}`
  const invoiceId = `inv-${tag}`
  const priorMap = (await d.db.setting.findUnique({ where: { key: PAYMENT_MAP } }))?.value ?? null
  await setSetting(d, PAYMENT_MAP, JSON.stringify({ 'stripe:GBP': `bank-${tag}` }))
  await setSetting(d, FLAG, 'true')
  const account = await d.db.accountingAccount.create({ data: { connector: 'xero', externalAccountId: `ext-${tag}`, code: `bank-${tag}`, name: 'Stripe GBP', type: 'BANK' } })
  const order = await d.db.salesOrder.create({
    data: {
      orderNumber: tag, status: 'PROCESSING', currency: 'GBP', fxRateToBase: 1,
      subtotalForeign: 100, totalForeign: 120, subtotalBase: 100, totalBase: 120, taxForeign: 20, taxBase: 20,
      paymentMethod: 'stripe', accountingInvoiceId: invoiceId, accountingInvoiceConnector: 'xero', paidAt: new Date(),
    } as never,
    select: { id: true },
  })
  await d.db.payment.create({ data: { orderId: order.id, amount: opts.receipt, currency: 'GBP', method: 'stripe' } })
  await d.db.accountingSyncLog.create({
    data: { connector: 'xero', type: 'SALES_INVOICE', status: 'SYNCED', referenceType: 'SalesOrder', referenceId: order.id, externalTransactionId: invoiceId, payload: {}, attemptStampingCustodyAt: new Date() } as never,
  })
  const made: Seeded['refunds'] = []
  for (let i = 0; i < opts.count; i++) {
    const creditNoteId = `cn-${tag}-${i}`
    const refund = await d.db.salesOrderRefund.create({
      data: {
        orderId: order.id, totalForeign: 40, totalBase: 40, accountingCreditNoteId: creditNoteId, accountingCreditNoteConnector: 'xero',
        externalRefundId: Math.floor(Math.random() * 1_000_000_000) + 1, refundedViaGateway: true,
      } as never,
      select: { id: true },
    })
    await d.db.accountingSyncLog.create({
      data: { connector: 'xero', type: 'CREDIT_NOTE', status: 'SYNCED', referenceType: 'SalesOrderRefund', referenceId: refund.id, externalTransactionId: creditNoteId, payload: { date: '2026-11-02' }, attemptStampingCustodyAt: new Date() } as never,
    })
    creditNotes.set(creditNoteId, { remaining: opts.credit ?? 40, payments: [] })
    made.push({ id: refund.id, creditNoteId })
  }
  const refundIds = made.map((r) => r.id)
  t.after(async () => {
    const ids = (await d.db.accountingSyncLog.findMany({ where: { OR: [{ referenceId: { in: refundIds } }, { referenceId: order.id }] }, select: { id: true } })).map((r) => r.id)
    if (ids.length > 0) await d.db.integrationOutbox.deleteMany({ where: { OR: ids.map((id) => ({ idempotencyKey: { contains: id } })) } }).catch(() => undefined)
    await d.db.activityLog.deleteMany({ where: { entityId: { in: [order.id, ...refundIds] } } })
    await d.db.accountingSyncLog.deleteMany({ where: { id: { in: ids } } })
    await d.db.payment.deleteMany({ where: { orderId: order.id } })
    await d.db.salesOrderRefund.deleteMany({ where: { id: { in: refundIds } } })
    await d.db.salesOrder.deleteMany({ where: { id: order.id } })
    await d.db.accountingAccount.delete({ where: { id: account.id } })
    await setSetting(d, PAYMENT_MAP, priorMap)
    await setSetting(d, FLAG, null)
  })
  return { orderId: order.id, refunds: made, invoiceId, accountId: account.externalAccountId }
}

function reset() {
  refunds.length = 0
  creditNotes.clear()
  invoiceAmountPaid = 50
  onBalancesRead = null
  refundCallDelayMs = 0
}

const settlementRows = (d: Deps, refundId: string) => d.db.accountingSyncLog.findMany({
  where: { type: 'CREDIT_NOTE_ALLOCATION' as never, referenceId: refundId },
  select: { id: true, status: true, payload: true, remoteAttemptedAt: true, errorMessage: true },
  orderBy: { createdAt: 'asc' },
})

/** Why a row was not sent: the outbox job's last error under the outbox runner, the row's own message otherwise. */
async function whyNotSent(d: Deps, rowId: string): Promise<string> {
  const job = await d.db.integrationOutbox.findFirst({ where: { idempotencyKey: { contains: rowId } }, select: { lastError: true } })
  const row = await d.db.accountingSyncLog.findUniqueOrThrow({ where: { id: rowId }, select: { errorMessage: true } })
  return `${job?.lastError ?? ''} ${row.errorMessage ?? ''}`.trim()
}

/** A settlement row written directly: the state the sweep or an earlier attempt would have left. */
async function writeRow(d: Deps, s: Seeded, which: number, over: { status: string; amount?: number; attempted?: boolean; pinned?: boolean; processing?: boolean; extra?: Record<string, unknown>; createdAt?: Date }) {
  const r = s.refunds[which]!
  const payload: Record<string, unknown> = {
    creditNoteId: r.creditNoteId, accountingInvoiceId: s.invoiceId, refundId: r.id, orderId: s.orderId, date: '2026-11-02', sourceEntryId: `test-${randomUUID().slice(0, 6)}`,
    ...(over.amount !== undefined ? { operation: 'REFUND_PAYMENT', amount: over.amount, currency: 'GBP', bankAccountId: s.accountId, paymentMethod: 'stripe', cashEvidence: 'GATEWAY', rateDecided: true } : {}),
    ...(over.extra ?? {}),
  }
  const now = new Date()
  const created = await d.db.accountingSyncLog.create({
    data: {
      connector: 'xero', type: 'CREDIT_NOTE_ALLOCATION', status: over.status, referenceType: 'SalesOrderRefund', referenceId: r.id, payload,
      attemptStampingCustodyAt: now, createdAt: over.createdAt ?? ancient(), ...(over.attempted ? { remoteAttemptedAt: now } : {}), ...(over.processing ? { processingStartedAt: now } : {}),
      ...(over.status === 'SYNCED' ? { externalTransactionId: `pay-${randomUUID().slice(0, 6)}`, syncedAt: now } : {}),
    } as never,
    select: { id: true },
  })
  if (over.status === 'PENDING' && !over.createdAt) await queueFirst(d, [created.id])
  return created
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// o3d-qrm47: what the cap counts
// ---------------------------------------------------------------------------------------------------------------------------------------------

for (const [label, build, counted] of [
  ['an other refund\'s PROCESSING row at its pinned amount (as the sweep reads it: no row of its own to be ordered against)', { status: 'PROCESSING', amount: 40, processing: true }, 40],
  ['an other refund\'s PROCESSING row whose call has begun (stamped)', { status: 'PROCESSING', amount: 40, processing: true, attempted: true }, 40],
  ['an other refund\'s FAILED row whose call was ATTEMPTED (a lost response may have landed)', { status: 'FAILED', amount: 40, attempted: true }, 40],
  ['an other refund\'s PENDING row that already ATTEMPTED once (revived after a lost response)', { status: 'PENDING', amount: 40, attempted: true }, 40],
  ['an other refund\'s SYNCED row (proven posted)', { status: 'SYNCED', amount: 40, attempted: true }, 40],
  ['NOT an other refund\'s FAILED row that never attempted a call (it holds no cash)', { status: 'FAILED', amount: 40, attempted: false }, 0],
  ['NOT an other refund\'s merely QUEUED pinned row', { status: 'PENDING', amount: 40, attempted: false }, 0],
] as const) {
  test(`[refund caps] priorCashOut counts ${label}`, { skip }, async (t) => {
    const d = await deps()
    reset()
    const s = await seedOrder(d, t, { receipt: 50, count: 2 })
    await writeRow(d, s, 1, build)
    const facts = await d.allocation.readCreditNoteSettlementFacts(d.db, s.refunds[0]!.id, null)
    assert.ok(facts)
    assert.equal(facts!.priorCashOut.toNumber(), counted)
    assert.equal(facts!.receiptTotal.toNumber(), 50)
  })
}

test('[refund caps] two refunds PROCESSING together are ORDERED, not both refused: a PROCESSING row counts only against a row created AFTER it', { skip }, async (t) => {
  const d = await deps()
  reset()
  const s = await seedOrder(d, t, { receipt: 50, count: 2 })
  const base = Date.now() - 60_000
  const older = await writeRow(d, s, 1, { status: 'PROCESSING', amount: 40, processing: true, createdAt: new Date(base) })
  const younger = await writeRow(d, s, 0, { status: 'PROCESSING', amount: 40, processing: true, createdAt: new Date(base + 1000) })
  const priorFor = async (entryId: string, refundId: string) => (await d.allocation.readCreditNoteSettlementFacts(d.db, refundId, entryId))!.priorCashOut.toNumber()
  assert.equal(await priorFor(younger.id, s.refunds[0]!.id), 40, 'the younger row counts the older one\'s pinned 40')
  assert.equal(await priorFor(older.id, s.refunds[1]!.id), 0, 'the older row does not count the younger one, so exactly one of the two proceeds')
})

test('[refund caps] a refund is NOT_NOW (no receipt capacity) once the other refund\'s attempted cash covers the receipts', { skip }, async (t) => {
  const d = await deps()
  reset()
  const s = await seedOrder(d, t, { receipt: 40, count: 2 })
  await writeRow(d, s, 1, { status: 'FAILED', amount: 40, attempted: true })
  const facts = (await d.allocation.readCreditNoteSettlementFacts(d.db, s.refunds[0]!.id, null))!
  const plan = d.allocation.planCreditNoteSettlement(facts)
  assert.equal(plan.kind, 'NOT_NOW')
  assert.equal((plan as { reason: string }).reason, 'NO_RECEIPT_CAPACITY')
})

// ---------------------------------------------------------------------------------------------------------------------------------------------
// o3d-jqmgb: a never-attempted pinned row is re-capped
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[refund caps] a NEVER-ATTEMPTED row that pinned 40 and failed pre-call is RE-CAPPED when another refund has since posted 40 (receipts 50): it pays 10, not 80 out in all', { skip }, async (t) => {
  const d = await deps()
  reset()
  const s = await seedOrder(d, t, { receipt: 50, count: 2 })
  // B posted 40 (its credit note holds the payment); A pinned 40 earlier, failed before any call, and has a stale stored Idempotency-Key from that decision.
  creditNotes.get(s.refunds[1]!.creditNoteId)!.remaining = 0
  await writeRow(d, s, 1, { status: 'SYNCED', amount: 40, attempted: true })
  const a = await writeRow(d, s, 0, { status: 'PENDING', amount: 40, attempted: false, extra: { _moneyPostIdempotencyKey: STALE_KEY } })
  await d.processor.processPendingXeroSync()
  assert.equal(refunds.length, 1, 'A went out once')
  assert.equal(refunds[0]!.creditNoteId, s.refunds[0]!.creditNoteId)
  assert.equal(refunds[0]!.amount, 10, 'held to receipts 50 less the 40 already out, not the stale 40')
  const row = await d.db.accountingSyncLog.findUniqueOrThrow({ where: { id: a.id }, select: { payload: true, status: true } })
  assert.equal((row.payload as { amount?: number }).amount, 10, 'the new decision is what is pinned')
  assert.notEqual((row.payload as { _moneyPostIdempotencyKey?: string })._moneyPostIdempotencyKey, STALE_KEY, 'the key derived from the 40 decision is not reused for a 10 request')
  assert.equal(row.status, 'SYNCED')
})

test('[refund caps] an ATTEMPTED row replays its pinned request exactly (same amount, same account) when nothing has changed', { skip }, async (t) => {
  const d = await deps()
  reset()
  const s = await seedOrder(d, t, { receipt: 50, count: 1 })
  await writeRow(d, s, 0, { status: 'PENDING', amount: 30, attempted: true })
  await d.processor.processPendingXeroSync()
  assert.equal(refunds.length, 1)
  assert.equal(refunds[0]!.amount, 30, 'the pinned 30 is replayed although 40 of credit is left')
  assert.equal(refunds[0]!.accountId, s.accountId)
})

test('[refund caps] an ATTEMPTED row is not replayed past the cap either: the order-locked re-check refuses it and sends nothing', { skip }, async (t) => {
  const d = await deps()
  reset()
  const s = await seedOrder(d, t, { receipt: 50, count: 2 })
  creditNotes.get(s.refunds[1]!.creditNoteId)!.remaining = 0
  await writeRow(d, s, 1, { status: 'SYNCED', amount: 40, attempted: true })
  const a = await writeRow(d, s, 0, { status: 'PENDING', amount: 40, attempted: true })
  await d.processor.processPendingXeroSync()
  assert.equal(refunds.length, 0, 'nothing sent: 40 + 40 would be 80 out against 50 in')
  const row = await d.db.accountingSyncLog.findUniqueOrThrow({ where: { id: a.id }, select: { status: true, errorMessage: true } })
  assert.notEqual(row.status, 'SYNCED')
  assert.match(await whyNotSent(d, a.id), /more than was received/)
})

// ---------------------------------------------------------------------------------------------------------------------------------------------
// o3d-0olzx: the Xero side of the cap
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[refund caps] IMS holds receipts of 50 but Xero shows only 10 paid on the invoice (the INVOICE_PAYMENT never posted): the refund is held to 10', { skip }, async (t) => {
  const d = await deps()
  reset()
  invoiceAmountPaid = 10
  const s = await seedOrder(d, t, { receipt: 50, count: 1 })
  await sweep(d, s)
  await d.processor.processPendingXeroSync()
  assert.equal(refunds.length, 1)
  assert.equal(refunds[0]!.amount, 10, 'min(IMS receipts 50, Xero AmountPaid 10, credit 40)')
  assert.equal((await settlementRows(d, s.refunds[0]!.id))[0]!.status, 'SYNCED')
})

test('[refund caps] Xero shows NOTHING paid on the invoice: no bank refund goes out, and the row says why', { skip }, async (t) => {
  const d = await deps()
  reset()
  invoiceAmountPaid = 0
  const s = await seedOrder(d, t, { receipt: 50, count: 1 })
  await sweep(d, s)
  await d.processor.processPendingXeroSync()
  assert.equal(refunds.length, 0)
  const row = (await settlementRows(d, s.refunds[0]!.id))[0]!
  assert.notEqual(row.status, 'SYNCED')
  assert.match(await whyNotSent(d, row.id), /Xero shows only 0\.00 paid/)
})

test('[refund caps] an UNREADABLE invoice AmountPaid refuses the refund: unknown is never read as the IMS-only figure', { skip }, async (t) => {
  const d = await deps()
  reset()
  invoiceAmountPaid = null
  const s = await seedOrder(d, t, { receipt: 50, count: 1 })
  await sweep(d, s)
  await d.processor.processPendingXeroSync()
  assert.equal(refunds.length, 0)
  assert.match(await whyNotSent(d, (await settlementRows(d, s.refunds[0]!.id))[0]!.id), /no readable AmountPaid/)
})

test('[refund caps] the other refunds\' cash is taken off Xero\'s AmountPaid too (Xero 50 paid, 40 already refunded: 10 left)', { skip }, async (t) => {
  const d = await deps()
  reset()
  invoiceAmountPaid = 50
  const s = await seedOrder(d, t, { receipt: 80, count: 2 })
  creditNotes.get(s.refunds[1]!.creditNoteId)!.remaining = 0
  await writeRow(d, s, 1, { status: 'SYNCED', amount: 40, attempted: true })
  await sweep(d, s)
  await d.processor.processPendingXeroSync()
  assert.equal(refunds.length, 1)
  assert.equal(refunds[0]!.amount, 10, 'IMS receipts would allow 40; Xero shows 50 paid less 40 refunded')
})

// ---------------------------------------------------------------------------------------------------------------------------------------------
// o3d-qrm47: two refunds of one order, processed at the SAME TIME, pay out no more than was received
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[refund caps] TWO REFUNDS OF ONE ORDER, drained concurrently with both workers INSIDE the pre-lock window, never pay out more than the receipts', { skip }, async (t) => {
  const d = await deps()
  reset()
  const s = await seedOrder(d, t, { receipt: 50, count: 2 })
  await sweep(d, s)
  assert.equal((await settlementRows(d, s.refunds[0]!.id)).length + (await settlementRows(d, s.refunds[1]!.id)).length, 2, 'both settlements queued')

  // A BARRIER, so the race is real and not a lucky schedule: neither worker proceeds past its Xero balance read (the last step before it pins and posts) until BOTH have
  // read. Both therefore decided on the same, empty picture of the order's cash-out; only the order lock and its re-check can keep them from paying 40 + 40 against 50.
  let arrived = 0
  let release!: () => void
  const both = new Promise<void>((resolve) => { release = resolve })
  onBalancesRead = async () => {
    arrived++
    if (arrived >= 2) release()
    await Promise.race([both, new Promise((r) => setTimeout(r, 15_000))])
  }
  refundCallDelayMs = 400 // the holder is mid-call while the other contends for the lock
  await Promise.all([d.processor.processPendingXeroSync(), d.processor.processPendingXeroSync()])
  assert.ok(arrived >= 2, 'both workers were in the window together (the race happened)')
  onBalancesRead = null

  const out = () => refunds.reduce((sum, r) => sum + r.amount, 0)
  assert.ok(out() <= 50, `paid out ${out()} against receipts of 50 in the race`)
  assert.ok(refunds.length <= 1, 'at most one of the two went out in the race: the other was held back (by the order lock or by the cap), not sent')

  // Whatever was refused comes back later, one tick at a time, and is held to what is left: 40 then 10, never more than the 50 received, at any point.
  const longAgo = new Date(Date.now() - 24 * 3_600_000)
  refundCallDelayMs = 0
  for (let round = 0; round < 6 && out() < 50; round++) {
    const rows = (await Promise.all(s.refunds.map((r) => settlementRows(d, r.id)))).flat().filter((r) => r.status !== 'SYNCED')
    for (const row of rows) {
      await d.db.accountingSyncLog.updateMany({ where: { id: row.id }, // Time passing, with stamping custody kept (a real reclaim re-asserts it; writing processingStartedAt alone would forfeit it and the repair would then stamp the row as attempted).
      data: { status: 'PENDING', processingStartedAt: longAgo, attemptStampingCustodyAt: longAgo } })
      await d.db.integrationOutbox.updateMany({ where: { idempotencyKey: { contains: row.id } }, data: { status: 'PENDING', nextAttemptAt: longAgo, lockedAt: null } }).catch(() => undefined)
    }
    await d.processor.processPendingXeroSync()
    assert.ok(out() <= 50, `paid out ${out()} against receipts of 50 after retry round ${round}`)
  }
  const state = async () => JSON.stringify(await Promise.all((await Promise.all(s.refunds.map((r) => settlementRows(d, r.id)))).flat().map(async (r) => ({ status: r.status, attempted: r.remoteAttemptedAt, amount: (r.payload as { amount?: number }).amount, why: await whyNotSent(d, r.id) }))))
  assert.equal(out(), 50, `the receipts are returned in full across the two refunds, 40 then 10, and not a penny more: ${await state()}`)
  assert.deepEqual(refunds.map((r) => r.amount).sort((x, y) => y - x), [40, 10])
})

// ---------------------------------------------------------------------------------------------------------------------------------------------
// o3d-o4tkz: the unique index
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[refund caps] accounting_sync_logs_followup_live_unique rejects a SECOND live CREDIT_NOTE_ALLOCATION row for one refund and credit note, and allows a retry once the first is cancelled', { skip }, async (t) => {
  const d = await deps()
  reset()
  const s = await seedOrder(d, t, { receipt: 50, count: 1 })
  const first = await writeRow(d, s, 0, { status: 'PENDING' })
  await assert.rejects(() => writeRow(d, s, 0, { status: 'PENDING' }), (error: unknown) => {
    const e = error as { code?: string; message?: string }
    return e.code === 'P2002' || /unique|duplicate/i.test(String(e.message))
  }, 'a second PENDING row is refused by the database')
  await assert.rejects(() => writeRow(d, s, 0, { status: 'SYNCED' }), /unique|duplicate|P2002/i, 'and a SYNCED twin is a live row too')
  // CANCELLED / FAILED are outside the predicate: a retired or failed settlement can be raised again.
  await d.db.accountingSyncLog.update({ where: { id: first.id }, data: { status: 'CANCELLED' } })
  await writeRow(d, s, 0, { status: 'PENDING' })
  // A different refund (its own credit note) is its own slot.
  const s2 = await seedOrder(d, t, { receipt: 50, count: 1 })
  await writeRow(d, s2, 0, { status: 'PENDING' })
})

test('[refund caps] the migration refuses (and drops nothing) when live CREDIT_NOTE_ALLOCATION duplicates already exist, and rebuilds the index once they are resolved', { skip }, async (t) => {
  const d = await deps()
  reset()
  const s = await seedOrder(d, t, { receipt: 50, count: 1 })
  const sql = readFileSync('prisma/migrations/20261122000400_followup_live_unique_add_credit_note_allocation/migration.sql', 'utf8')
  const oldIndex = `CREATE UNIQUE INDEX "accounting_sync_logs_followup_live_unique" ON "accounting_sync_logs" ("connector","type","referenceType","referenceId",(COALESCE("payload" ->> 'accountingInvoiceId', '')),(COALESCE("payload" ->> 'creditNoteId', '')),(COALESCE("payload" ->> 'paymentId', ''))) WHERE "status" IN ('PENDING','PROCESSING','SYNCED') AND "type" IN ('INVOICE_PAYMENT','BILL_PAYMENT','BILL_ATTACHMENT','INVOICE_PDF','INVOICE_EMAIL','WC_INVOICE_NOTE','PURCHASE_CREDIT_NOTE_ALLOCATION')`
  const { Client } = await import('pg')
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  const indexDef = async () => (await client.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'accounting_sync_logs_followup_live_unique'`)).rows[0]?.indexdef as string | undefined
  t.after(async () => {
    // Whatever happened, leave the database with the migration's index.
    await client.query('ROLLBACK').catch(() => undefined)
    if (!(await indexDef())?.includes("'CREDIT_NOTE_ALLOCATION'")) {
      await d.db.accountingSyncLog.deleteMany({ where: { referenceId: s.refunds[0]!.id, type: 'CREDIT_NOTE_ALLOCATION' as never } })
      await client.query(sql)
    }
    await client.end()
  })
  // Put the PREVIOUS definition back (20260819120000), create two live duplicates the old index cannot see, and run the migration.
  await client.query('DROP INDEX "accounting_sync_logs_followup_live_unique"')
  await client.query(oldIndex)
  assert.ok(!(await indexDef())!.includes("'CREDIT_NOTE_ALLOCATION'"), 'the old definition is in place')
  const one = await writeRow(d, s, 0, { status: 'PENDING' })
  const two = await writeRow(d, s, 0, { status: 'PENDING' })
  await assert.rejects(() => client.query(sql), /Refusing to rebuild accounting_sync_logs_followup_live_unique: 1 group/)
  await client.query('ROLLBACK').catch(() => undefined)
  assert.ok(!(await indexDef())!.includes("'CREDIT_NOTE_ALLOCATION'"), 'the refusal left the old index in place')
  assert.equal(await d.db.accountingSyncLog.count({ where: { id: { in: [one.id, two.id] } } }), 2, 'and deleted no row')
  // Resolve (CANCEL the superseded row, as the message says) and re-run.
  await d.db.accountingSyncLog.update({ where: { id: two.id }, data: { status: 'CANCELLED' } })
  await client.query(sql)
  assert.ok((await indexDef())!.includes("'CREDIT_NOTE_ALLOCATION'"), 'the index now covers CREDIT_NOTE_ALLOCATION')
  await assert.rejects(() => writeRow(d, s, 0, { status: 'PENDING' }), /unique|duplicate|P2002/i)
})
