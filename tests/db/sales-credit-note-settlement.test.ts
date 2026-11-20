import '../helpers/xero-attested.ts'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

/**
 * o3d-hqvrp.39 - A POSTED SALES CREDIT NOTE IS SETTLED IN XERO: allocated to its invoice, or refunded in cash.
 *
 * Driven through the REAL drains (the outbox runner and the direct runner) over a real database. Only the Xero transport functions of the credit-note module are
 * doubles, so what is asserted is what IMS DECIDED to send. GATED on RUN_DB_RETENTION_TESTS (npm run test:db).
 *
 * What #1039 R2 found, and the arm that holds each: the allocation never ran from the outbox runner (both runners below); it fenced on a claim already released
 * (the claim-fence test); and the receipt gate was check-then-act (the receipt-after-queue test: the reading is taken in the claim, so a receipt that arrives
 * after the row was queued changes the settlement it decides).
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'
if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1: tests/db/sales-credit-note-settlement.test.ts would have been skipped.')
}

type Allocate = { creditNoteId: string; invoiceId: string; amount: number; date: string }
type Refund = { creditNoteId: string; accountId: string; amount: number; date: string; currencyRate?: number; reference: string }
const allocations: Allocate[] = []
const refunds: Refund[] = []

// A ONE-DOCUMENT LEDGER. The processor's own decision reads it (balances), the ledger fence's probe reads it (the credit note's allocations and refund
// payments), and a settlement that "lands" writes to it, so a retry after a lost response sees what the first attempt did.
type Ledger = {
  currency: string
  total: number
  remaining: number
  amountDue: number
  status: string
  allocations: Array<{ Amount: number; Date: string; Invoice: { InvoiceID: string } }>
  payments: Array<{ PaymentID: string; Amount: number; Status: string; PaymentType: string }>
}
let ledger: Ledger = freshLedger()
function freshLedger(): Ledger {
  return { currency: 'GBP', total: 24, remaining: 24, amountDue: 120, status: 'AUTHORISED', allocations: [], payments: [] }
}
let pushedCreditNoteId = 'cn-pushed'
let onBalancesRead: (() => Promise<void>) | null = null
// `landed`: whether a settlement whose call reports FAILURE (a lost response) actually reached the ledger.
let allocateOutcome: { success: boolean; error?: string; landed: boolean } = { success: true, landed: true }
let refundOutcome: { success: boolean; paymentId?: string; error?: string; landed: boolean } = { success: true, paymentId: 'pay-1', landed: true }

async function load() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const api = await import('../../lib/connectors/xero/api.ts')
  mock.module('../../lib/connectors/xero/api.ts', {
    namedExports: {
      ...api,
      xeroGet: async (path: string) => {
        if (path.startsWith('CreditNotes/')) {
          return { ok: true, status: 200, data: { CreditNotes: [{ CreditNoteID: path.split('/')[1], CurrencyCode: ledger.currency, Total: ledger.total, RemainingCredit: ledger.remaining, Allocations: ledger.allocations, Payments: ledger.payments }] } }
        }
        return { ok: false, status: 404, error: `not served by the test ledger: ${path}` }
      },
    },
  })
  const creditNotes = await import('../../lib/connectors/xero/credit-notes.ts')
  mock.module('../../lib/connectors/xero/credit-notes.ts', {
    namedExports: {
      ...creditNotes,
      readCreditNoteSettlementBalances: async () => {
        if (onBalancesRead) await onBalancesRead()
        return { ok: true, remainingCredit: ledger.remaining, amountDue: ledger.amountDue, creditNoteStatus: ledger.status }
      },
      pushCreditNote: async () => ({ success: true, creditNoteId: pushedCreditNoteId }),
      allocatePurchaseCreditNote: async (params: Allocate) => {
        allocations.push(params)
        if (allocateOutcome.landed) {
          ledger.allocations.push({ Amount: params.amount, Date: params.date, Invoice: { InvoiceID: params.invoiceId } })
          ledger.remaining -= params.amount
        }
        return { success: allocateOutcome.success, error: allocateOutcome.error }
      },
      refundSalesCreditNote: async (params: Refund) => {
        refunds.push(params)
        if (refundOutcome.landed) {
          ledger.payments.push({ PaymentID: refundOutcome.paymentId ?? 'pay-1', Amount: params.amount, Status: 'AUTHORISED', PaymentType: 'ARCREDITPAYMENT' })
          ledger.remaining -= params.amount
        }
        return { success: refundOutcome.success, paymentId: refundOutcome.paymentId, error: refundOutcome.error }
      },
    },
  })
  const [{ db }, processor] = await Promise.all([
    import('../../lib/db/index.ts'),
    import('../../lib/connectors/xero/sync-processor.ts'),
  ])
  return { db, processor }
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

type Seed = { orderId: string; refundId: string; invoiceId: string; creditNoteId: string; tag: string }
async function seed(d: Deps, opts: { paid: boolean; shopRefund: boolean; currency?: string; fxRateToBase?: number }): Promise<Seed> {
  const tag = `cna${randomUUID().slice(0, 8)}`
  const currency = opts.currency ?? 'GBP'
  const invoiceId = `inv-${tag}`
  const creditNoteId = `cn-${tag}`
  const order = await d.db.salesOrder.create({
    data: {
      orderNumber: tag, status: 'PROCESSING', currency, fxRateToBase: opts.fxRateToBase ?? 1,
      subtotalForeign: 100, totalForeign: 120, subtotalBase: 100, totalBase: 120, taxForeign: 20, taxBase: 20,
      paymentMethod: 'stripe', accountingInvoiceId: invoiceId, accountingInvoiceConnector: 'xero',
      paidAt: opts.paid ? new Date() : null,
    } as never,
    select: { id: true },
  })
  const refund = await d.db.salesOrderRefund.create({
    data: {
      orderId: order.id, totalForeign: 20, totalBase: 20, accountingCreditNoteId: creditNoteId, accountingCreditNoteConnector: 'xero',
      externalRefundId: opts.shopRefund ? Math.floor(Math.random() * 1_000_000_000) + 1 : null,
    } as never,
    select: { id: true },
  })
  await d.db.accountingSyncLog.create({
    data: { connector: 'xero', type: 'SALES_INVOICE', status: 'SYNCED', referenceType: 'SalesOrder', referenceId: order.id, externalTransactionId: invoiceId, payload: {}, attemptStampingCustodyAt: new Date() } as never,
  })
  await d.db.accountingSyncLog.create({
    data: { connector: 'xero', type: 'CREDIT_NOTE', status: 'SYNCED', referenceType: 'SalesOrderRefund', referenceId: refund.id, externalTransactionId: creditNoteId, payload: { date: '2026-11-02' }, attemptStampingCustodyAt: new Date() } as never,
  })
  if (opts.paid) {
    await d.db.payment.create({
      data: { orderId: order.id, amount: 120, currency, method: 'stripe', settlementRateToBase: currency === 'GBP' ? null : opts.fxRateToBase ?? null },
    })
  }
  return { orderId: order.id, refundId: refund.id, invoiceId, creditNoteId, tag }
}

async function cleanup(d: Deps, s: Seed) {
  await d.db.integrationOutbox.deleteMany({ where: { idempotencyKey: { contains: s.refundId } } }).catch(() => undefined)
  const ids = (await d.db.accountingSyncLog.findMany({ where: { OR: [{ referenceId: s.refundId }, { referenceId: s.orderId }] }, select: { id: true } })).map((r) => r.id)
  await d.db.integrationOutbox.deleteMany({ where: { OR: ids.map((id) => ({ idempotencyKey: { contains: id } })) } }).catch(() => undefined)
  await d.db.activityLog.deleteMany({ where: { entityId: { in: [s.orderId, s.refundId] } } })
  await d.db.accountingSyncLog.deleteMany({ where: { id: { in: ids } } })
  await d.db.payment.deleteMany({ where: { orderId: s.orderId } })
  await d.db.salesOrderRefund.deleteMany({ where: { id: s.refundId } })
  await d.db.salesOrder.deleteMany({ where: { id: s.orderId } })
}

const settlementRows = (d: Deps, s: Seed) => d.db.accountingSyncLog.findMany({
  where: { type: 'CREDIT_NOTE_ALLOCATION' as never, referenceId: s.refundId },
  select: { id: true, status: true, payload: true, retryCount: true, remoteAttemptedAt: true },
})

function reset() {
  allocations.length = 0
  refunds.length = 0
  ledger = freshLedger()
  onBalancesRead = null
  allocateOutcome = { success: true, landed: true }
  refundOutcome = { success: true, paymentId: 'pay-1', landed: true }
}

for (const runner of ['outbox', 'direct'] as const) {
  test(`[db] ${runner} runner: an UNPAID invoice's credit note is ALLOCATED to it, once, and the row ends SYNCED`, { skip }, async (t) => {
    const d = await deps()
    const saved = process.env.XERO_ACCOUNTING_OUTBOX_ENABLED
    process.env.XERO_ACCOUNTING_OUTBOX_ENABLED = runner === 'outbox' ? 'true' : 'false'
    reset()
    await setSetting(d, FLAG, 'true')
    const s = await seed(d, { paid: false, shopRefund: false })
    t.after(async () => {
      if (saved === undefined) delete process.env.XERO_ACCOUNTING_OUTBOX_ENABLED; else process.env.XERO_ACCOUNTING_OUTBOX_ENABLED = saved
      await setSetting(d, FLAG, null)
      await cleanup(d, s)
    })

    const swept = await d.processor.reenqueueMissingCreditNoteAllocations()
    assert.ok(swept.enqueued >= 1, 'the sweep queued the settlement')
    const queued = await settlementRows(d, s)
    assert.equal(queued.length, 1)
    assert.equal(queued[0]!.status, 'PENDING')

    await d.processor.processPendingXeroSync()
    const after = await settlementRows(d, s)
    assert.equal(after.length, 1)
    assert.equal(after[0]!.status, 'SYNCED', `the ${runner} runner processed the type`)
    assert.equal((after[0]!.payload as { operation?: string }).operation, 'ALLOCATE')
    assert.deepEqual(allocations.map((a) => ({ creditNoteId: a.creditNoteId, invoiceId: a.invoiceId, amount: a.amount })), [{ creditNoteId: s.creditNoteId, invoiceId: s.invoiceId, amount: 24 }])
    assert.equal(refunds.length, 0, 'an unpaid invoice is never refunded')

    // A second tick finds nothing owed: no second row, no second allocation.
    await d.processor.reenqueueMissingCreditNoteAllocations()
    await d.processor.processPendingXeroSync()
    assert.equal((await settlementRows(d, s)).length, 1)
    assert.equal(allocations.length, 1)
  })

  test(`[db] ${runner} runner: a PAID foreign-currency invoice's credit note is REFUNDED from the receipt's mapped account at IMS's rate, never allocated`, { skip }, async (t) => {
    const d = await deps()
    const saved = process.env.XERO_ACCOUNTING_OUTBOX_ENABLED
    process.env.XERO_ACCOUNTING_OUTBOX_ENABLED = runner === 'outbox' ? 'true' : 'false'
    reset()
    const priorMap = (await d.db.setting.findUnique({ where: { key: PAYMENT_MAP } }))?.value ?? null
    await setSetting(d, FLAG, 'true')
    await setSetting(d, PAYMENT_MAP, JSON.stringify({ 'stripe:EUR': 'bank-eur' }))
    const hadEur = (await d.db.currency.findUnique({ where: { code: 'EUR' } })) !== null
    if (!hadEur) await d.db.currency.create({ data: { code: 'EUR', name: 'Euro', symbol: 'EUR' } })
    const fx = await d.db.fxRate.create({ data: { fromCurrency: 'GBP', toCurrency: 'EUR', rate: 1.25, source: 'manual', manualOverride: true, fetchedAt: new Date('2026-11-01T00:00:00Z') } })
    const account = await d.db.accountingAccount.create({ data: { connector: 'xero', externalAccountId: `ext-${randomUUID().slice(0, 8)}`, code: 'bank-eur', name: 'Stripe EUR', type: 'BANK' } })
    // The credit note was booked at 1.2 (1 GBP = 1.2 EUR); the refund settles at today's 1.25: a realised FX difference.
    const s = await seed(d, { paid: true, shopRefund: true, currency: 'EUR', fxRateToBase: 1.2 })
    t.after(async () => {
      if (saved === undefined) delete process.env.XERO_ACCOUNTING_OUTBOX_ENABLED; else process.env.XERO_ACCOUNTING_OUTBOX_ENABLED = saved
      await setSetting(d, FLAG, null)
      await setSetting(d, PAYMENT_MAP, priorMap)
      await d.db.fxRate.delete({ where: { id: fx.id } })
      if (!hadEur) await d.db.currency.delete({ where: { code: 'EUR' } })
      await d.db.accountingAccount.delete({ where: { id: account.id } })
      await cleanup(d, s)
    })
    ledger = { ...freshLedger(), currency: 'EUR', amountDue: 0 }

    await d.processor.reenqueueMissingCreditNoteAllocations()
    await d.processor.processPendingXeroSync()
    const rows = await settlementRows(d, s)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.status, 'SYNCED', `the ${runner} runner processed the type`)
    const payload = rows[0]!.payload as { operation?: string; amount?: number; bankAccountId?: string; settlementRateToBase?: number }
    assert.equal(payload.operation, 'REFUND_PAYMENT')
    assert.equal(allocations.length, 0, 'a paid invoice\'s credit note is NOT allocated to the invoice')
    assert.equal(refunds.length, 1)
    assert.equal(refunds[0]!.creditNoteId, s.creditNoteId)
    assert.equal(refunds[0]!.accountId, account.externalAccountId, 'from the account the original receipt\'s method maps to')
    assert.equal(refunds[0]!.amount, 24, 'the credit left on the note (a shop refund is paid back whole)')
    assert.equal(refunds[0]!.currencyRate, 0.8, 'IMS\'s settlement rate (1 / 1.25) is the payment\'s CurrencyRate, so Xero books the realised FX')
    assert.equal(payload.settlementRateToBase, 1.25)
  })
}

test('[db] a RECEIPT recorded after the row was queued changes the settlement: the reading is taken in the claim, not at the enqueue', { skip }, async (t) => {
  const d = await deps()
  reset()
  await setSetting(d, FLAG, 'true')
  const s = await seed(d, { paid: false, shopRefund: true })
  t.after(async () => { await setSetting(d, FLAG, null); await cleanup(d, s) })
  await d.processor.reenqueueMissingCreditNoteAllocations()
  assert.equal((await settlementRows(d, s)).length, 1)
  // The customer paid the invoice AFTER the settlement was queued (as an ALLOCATE) and before it was claimed.
  await d.db.payment.create({ data: { orderId: s.orderId, amount: 120, currency: 'GBP', method: 'stripe' } })
  // No bank mapping exists for stripe:GBP in this scratch database, so the refund is refused before anything is sent - and, crucially, it is NOT allocated.
  await d.processor.processPendingXeroSync()
  assert.equal(allocations.length, 0, 'the stale queue-time reading was not acted on')
  const row = (await settlementRows(d, s))[0]!
  assert.notEqual(row.status, 'SYNCED')
})

test('[db] a claim LOST before the wire call sends nothing: the fence is the last thing proven, on a claim that is still held', { skip }, async (t) => {
  const d = await deps()
  reset()
  await setSetting(d, FLAG, 'true')
  const s = await seed(d, { paid: false, shopRefund: false })
  t.after(async () => { await setSetting(d, FLAG, null); await cleanup(d, s) })
  await d.processor.reenqueueMissingCreditNoteAllocations()
  // Another worker takes the row while this one is reading the balances (between the decision and the call).
  onBalancesRead = async () => {
    await d.db.accountingSyncLog.updateMany({
      where: { type: 'CREDIT_NOTE_ALLOCATION' as never, referenceId: s.refundId },
      data: { processingStartedAt: new Date(Date.now() + 60_000) },
    })
  }
  await d.processor.processPendingXeroSync()
  assert.equal(allocations.length, 0, 'nothing was sent on a claim this worker no longer held')
  assert.notEqual((await settlementRows(d, s))[0]!.status, 'SYNCED')
})

test('[db] a retry after a lost response does not allocate twice: the ledger is asked first, finds the allocation, and the row is not sent again', { skip }, async (t) => {
  const d = await deps()
  reset()
  await setSetting(d, FLAG, 'true')
  const s = await seed(d, { paid: false, shopRefund: false })
  t.after(async () => { await setSetting(d, FLAG, null); await cleanup(d, s) })
  await d.processor.reenqueueMissingCreditNoteAllocations()
  allocateOutcome = { success: false, error: 'socket hang up', landed: true }
  await d.processor.processPendingXeroSync()
  assert.equal(allocations.length, 1, 'the first attempt went out')
  const afterFirst = (await settlementRows(d, s))[0]!
  assert.notEqual(afterFirst.status, 'SYNCED')
  assert.ok(afterFirst.remoteAttemptedAt, 'the attempt is stamped, so the retry knows it may have landed')
  // The row is due again. The first attempt DID land (only its response was lost): the retry reads the ledger, finds the allocation, and refuses to send a
  // second one - the operator settles the row as posted.
  const longAgo = new Date(Date.now() - 24 * 3_600_000)
  await d.db.accountingSyncLog.updateMany({ where: { id: afterFirst.id }, data: { status: 'PENDING', processingStartedAt: longAgo } })
  await d.db.integrationOutbox.updateMany({ where: { idempotencyKey: { contains: afterFirst.id } }, data: { status: 'PENDING', nextAttemptAt: longAgo, lockedAt: null } }).catch(() => undefined)
  await d.processor.processPendingXeroSync()
  assert.equal(allocations.length, 1, 'no second allocation on the retry')
  assert.equal(ledger.allocations.length, 1, 'the ledger holds exactly one allocation')
  const afterRetry = await d.db.accountingSyncLog.findUniqueOrThrow({ where: { id: afterFirst.id }, select: { status: true, errorMessage: true } })
  assert.notEqual(afterRetry.status, 'SYNCED')
  assert.equal((await settlementRows(d, s)).length, 1, 'and no second row')
})

test('[db] with the switch OFF nothing is queued, and a row queued before it went off is retired unsent (behaviour as on development)', { skip }, async (t) => {
  const d = await deps()
  reset()
  await setSetting(d, FLAG, null)
  const s = await seed(d, { paid: false, shopRefund: false })
  t.after(async () => { await setSetting(d, FLAG, null); await cleanup(d, s) })
  const swept = await d.processor.reenqueueMissingCreditNoteAllocations()
  const salesRows = await settlementRows(d, s)
  assert.equal(salesRows.length, 0, 'the sweep queues no settlement while the switch is off')
  assert.ok(swept.failed === 0)

  // A row that exists anyway (queued while the switch was on, then switched off): retired, nothing sent.
  const row = await d.db.accountingSyncLog.create({
    data: {
      connector: 'xero', type: 'CREDIT_NOTE_ALLOCATION', status: 'PENDING', referenceType: 'SalesOrderRefund', referenceId: s.refundId,
      payload: { creditNoteId: s.creditNoteId, accountingInvoiceId: s.invoiceId, refundId: s.refundId, orderId: s.orderId, date: '2026-11-02', sourceEntryId: 'test' },
      attemptStampingCustodyAt: new Date(),
    } as never,
    select: { id: true },
  })
  await d.processor.processPendingXeroSync()
  const after = await d.db.accountingSyncLog.findUniqueOrThrow({ where: { id: row.id }, select: { status: true, errorMessage: true } })
  assert.equal(after.status, 'CANCELLED')
  assert.match(after.errorMessage ?? '', /switch is off/)
  assert.equal(allocations.length + refunds.length, 0)
})

test('[db] a retry after a lost REFUND response does not refund twice: the ledger shows the refund payment on the credit note and the row is not sent again', { skip }, async (t) => {
  const d = await deps()
  reset()
  const priorMap = (await d.db.setting.findUnique({ where: { key: PAYMENT_MAP } }))?.value ?? null
  await setSetting(d, FLAG, 'true')
  await setSetting(d, PAYMENT_MAP, JSON.stringify({ 'stripe:GBP': 'bank-gbp' }))
  const account = await d.db.accountingAccount.create({ data: { connector: 'xero', externalAccountId: `ext-${randomUUID().slice(0, 8)}`, code: 'bank-gbp', name: 'Stripe GBP', type: 'BANK' } })
  const s = await seed(d, { paid: true, shopRefund: true })
  t.after(async () => {
    await setSetting(d, FLAG, null)
    await setSetting(d, PAYMENT_MAP, priorMap)
    await d.db.accountingAccount.delete({ where: { id: account.id } })
    await cleanup(d, s)
  })
  ledger = { ...freshLedger(), amountDue: 0 }
  await d.processor.reenqueueMissingCreditNoteAllocations()
  refundOutcome = { success: false, error: 'socket hang up', landed: true }
  await d.processor.processPendingXeroSync()
  assert.equal(refunds.length, 1, 'the first attempt went out')
  assert.equal(refunds[0]!.currencyRate, undefined, 'a base-currency refund carries no rate')
  const first = (await settlementRows(d, s))[0]!
  assert.notEqual(first.status, 'SYNCED')
  const longAgo = new Date(Date.now() - 24 * 3_600_000)
  await d.db.accountingSyncLog.updateMany({ where: { id: first.id }, data: { status: 'PENDING', processingStartedAt: longAgo } })
  await d.db.integrationOutbox.updateMany({ where: { idempotencyKey: { contains: first.id } }, data: { status: 'PENDING', nextAttemptAt: longAgo, lockedAt: null } }).catch(() => undefined)
  await d.processor.processPendingXeroSync()
  assert.equal(refunds.length, 1, 'no second refund on the retry')
  assert.equal(ledger.payments.length, 1, 'the ledger holds exactly one refund payment')
  assert.equal(allocations.length, 0)
})

for (const runner of ['outbox', 'direct'] as const) {
  for (const on of [true, false]) {
    test(`[db] ${runner} runner: posting a credit note queues its settlement only with the switch ON (${on ? 'ON' : 'OFF: nothing queued, as on development'})`, { skip }, async (t) => {
      const d = await deps()
      const saved = process.env.XERO_ACCOUNTING_OUTBOX_ENABLED
      process.env.XERO_ACCOUNTING_OUTBOX_ENABLED = runner === 'outbox' ? 'true' : 'false'
      reset()
      await setSetting(d, FLAG, on ? 'true' : null)
      const s = await seed(d, { paid: false, shopRefund: false })
      t.after(async () => {
        if (saved === undefined) delete process.env.XERO_ACCOUNTING_OUTBOX_ENABLED; else process.env.XERO_ACCOUNTING_OUTBOX_ENABLED = saved
        await setSetting(d, FLAG, null)
        await cleanup(d, s)
      })
      // The credit note has NOT posted yet: a PENDING CREDIT_NOTE row, no ledger id on the refund.
      pushedCreditNoteId = `cn-pushed-${s.tag}`
      await d.db.accountingSyncLog.deleteMany({ where: { type: 'CREDIT_NOTE', referenceId: s.refundId } })
      await d.db.salesOrderRefund.update({ where: { id: s.refundId }, data: { accountingCreditNoteId: null, accountingCreditNoteConnector: null } })
      await d.db.accountingSyncLog.create({
        data: {
          connector: 'xero', type: 'CREDIT_NOTE', status: 'PENDING', referenceType: 'SalesOrderRefund', referenceId: s.refundId,
          payload: { creditNoteNumber: `CN-${s.tag}`, date: '2026-11-02', currency: 'GBP', lines: [], reference: s.tag }, attemptStampingCustodyAt: new Date(),
        } as never,
      })
      await d.processor.processPendingXeroSync()
      const refund = await d.db.salesOrderRefund.findUniqueOrThrow({ where: { id: s.refundId }, select: { accountingCreditNoteId: true } })
      assert.equal(refund.accountingCreditNoteId, pushedCreditNoteId, 'the credit note posted and was linked')
      const queued = await settlementRows(d, s)
      assert.equal(queued.length, on ? 1 : 0, on ? 'the post queued the settlement' : 'nothing was queued')
      if (on) assert.equal((queued[0]!.payload as { creditNoteId?: string }).creditNoteId, pushedCreditNoteId)
    })
  }
}
