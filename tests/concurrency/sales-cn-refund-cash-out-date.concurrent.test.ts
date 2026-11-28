import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified
import '../helpers/xero-attested.ts'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

/**
 * o3d-l9gej: A RECORDED REFUND PAYMENT IS DATED AND RATED ON THE DAY ITS CASH WENT OUT, against a real PostgreSQL.
 *
 * The credit note is dated 2 November; the operator recorded the refund payment on 9 November. The currency (XFX, made by this file) has a rate on each of the
 * two days. With `xero_refund_payment_cash_out_date_enabled` on, the refund payment IMS sends is dated 9 November and carries the 9 November rate; off (the
 * default) it is dated and rated on the credit note's day, exactly as before. Only the Xero transport functions are doubles, so what is asserted is what IMS
 * DECIDED to send. Robust to rows other files leave: the currency's rates are this file's own, and every row it makes is queued first and removed afterwards.
 */
const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const skip = !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1'

const CCY = 'XFX'
const CN_DATE = '2026-11-02'
const CASH_DATE = '2026-11-09'
const RATE_CN_DAY = 1.1
const RATE_CASH_DAY = 1.2

type Refund = { creditNoteId: string; accountId: string; amount: number; date: string; currencyRate?: number; reference: string }
const refunds: Refund[] = []
const allocations: Array<{ creditNoteId: string; amount: number; date: string }> = []
let amountDue = 0
const creditNotes = new Map<string, { remaining: number; payments: Array<{ PaymentID: string; Amount: number; Status: string; PaymentType: string }> }>()

async function load() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const api = await import('../../lib/connectors/xero/api.ts')
  mock.module('../../lib/connectors/xero/api.ts', {
    namedExports: {
      ...api,
      xeroGet: async (path: string) => {
        if (path.startsWith('CreditNotes?where=')) return { ok: true, status: 200, data: { CreditNotes: [] } }
        if (path.startsWith('CreditNotes/')) {
          const id = decodeURIComponent(path.split('/')[1]!)
          const cn = creditNotes.get(id)
          if (!cn) return { ok: false, status: 404, error: `not served by the test ledger: ${path}` }
          return { ok: true, status: 200, data: { CreditNotes: [{ CreditNoteID: id, CurrencyCode: CCY, Total: 40, RemainingCredit: cn.remaining, Allocations: [], Payments: cn.payments }] } }
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
        const cn = creditNotes.get(creditNoteId)
        return { ok: true, remainingCredit: cn?.remaining ?? 0, amountDue, amountPaid: 50, creditNoteStatus: 'AUTHORISED', creditNoteTotal: 40, invoiceStatus: 'PAID' }
      },
      allocatePurchaseCreditNote: async (params: { creditNoteId: string; amount: number; date: string }) => {
        allocations.push(params)
        return { success: true }
      },
      refundSalesCreditNote: async (params: Refund) => {
        refunds.push(params)
        const cn = creditNotes.get(params.creditNoteId)!
        cn.payments.push({ PaymentID: `pay-${refunds.length}`, Amount: params.amount, Status: 'AUTHORISED', PaymentType: 'ARCREDITPAYMENT' })
        cn.remaining -= params.amount
        return { success: true, paymentId: `pay-${refunds.length}` }
      },
    },
  })
  const [{ db }, processor] = await Promise.all([import('../../lib/db/index.ts'), import('../../lib/connectors/xero/sync-processor.ts')])
  return { db, processor }
}
let loaded: Awaited<ReturnType<typeof load>> | null = null
const deps = async () => (loaded ??= await load())
type Deps = Awaited<ReturnType<typeof deps>>

const FLAG = 'xero_credit_note_allocation_enabled'
const CASH_OUT_FLAG = 'xero_refund_payment_cash_out_date_enabled'
const PAYMENT_MAP = 'accounting_payment_account_map'

async function setSetting(d: Deps, key: string, value: string | null) {
  if (value === null) await d.db.setting.deleteMany({ where: { key } })
  else await d.db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
}

// The outbox runner claims oldest-first, so every row this file makes is back-dated before anything another file left behind.
let ancientTick = 0
const ancient = () => new Date(Date.UTC(2000, 0, 1) + (ancientTick++) * 1000)
async function queueFirst(d: Deps, id: string) {
  const { scheduleXeroAccountingOutbox } = await import('../../lib/connectors/xero/outbox.ts')
  const at = ancient()
  await d.db.accountingSyncLog.update({ where: { id }, data: { createdAt: at } })
  await scheduleXeroAccountingOutbox(d.db, { accountingSyncLogId: id, resetAttempts: true })
  await d.db.integrationOutbox.updateMany({ where: { idempotencyKey: { contains: id } }, data: { createdAt: at } })
}

const OUTBOX_BEFORE_THIS_FILE = process.env.XERO_ACCOUNTING_OUTBOX_ENABLED
test.after(() => { if (OUTBOX_BEFORE_THIS_FILE === undefined) delete process.env.XERO_ACCOUNTING_OUTBOX_ENABLED; else process.env.XERO_ACCOUNTING_OUTBOX_ENABLED = OUTBOX_BEFORE_THIS_FILE })

type Seeded = { orderId: string; refundId: string; creditNoteId: string; invoiceId: string; accountId: string }

/** One XFX order (booked at 1.05), its paid invoice (50 received), one refund of 40 with its posted credit note, and the refund payment the operator recorded. */
async function seed(d: Deps, t: { after: (fn: () => Promise<void>) => void }, opts: { cashOutFlag: string | null; refundPaidAt: Date; gateway?: boolean; refundPayments?: Array<{ amount: number; paidAt: Date }> }): Promise<Seeded> {
  process.env.XERO_ACCOUNTING_OUTBOX_ENABLED = 'true'
  await d.db.$executeRaw`DELETE FROM "xero_settlement_call_budget"`
  const tag = `cnd${randomUUID().slice(0, 8)}`
  const invoiceId = `inv-${tag}`
  const creditNoteId = `cn-${tag}`
  const priorMap = (await d.db.setting.findUnique({ where: { key: PAYMENT_MAP } }))?.value ?? null
  const priorCashOut = (await d.db.setting.findUnique({ where: { key: CASH_OUT_FLAG } }))?.value ?? null
  await setSetting(d, PAYMENT_MAP, JSON.stringify({ [`stripe:${CCY}`]: `bank-${tag}` }))
  await setSetting(d, FLAG, 'true')
  await setSetting(d, CASH_OUT_FLAG, opts.cashOutFlag)
  // This file's own currency and its two rates (whatever an earlier run left is removed first).
  await d.db.currency.upsert({ where: { code: CCY }, create: { code: CCY, name: 'Test currency (cash-out date)', symbol: 'X' }, update: {} })
  await d.db.fxRate.deleteMany({ where: { toCurrency: CCY } })
  await d.db.fxRate.createMany({
    data: [
      { fromCurrency: 'GBP', toCurrency: CCY, rate: RATE_CN_DAY, fetchedAt: new Date(`${CN_DATE}T08:00:00Z`), source: 'manual', manualOverride: true },
      { fromCurrency: 'GBP', toCurrency: CCY, rate: RATE_CASH_DAY, fetchedAt: new Date(`${CASH_DATE}T08:00:00Z`), source: 'manual', manualOverride: true },
    ],
  })
  const account = await d.db.accountingAccount.create({ data: { connector: 'xero', externalAccountId: `ext-${tag}`, code: `bank-${tag}`, name: `Stripe ${CCY}`, type: 'BANK' } })
  const order = await d.db.salesOrder.create({
    data: {
      orderNumber: tag, status: 'PROCESSING', currency: CCY, fxRateToBase: 1.05,
      subtotalForeign: 100, totalForeign: 120, subtotalBase: 95.24, totalBase: 114.29, taxForeign: 20, taxBase: 19.05,
      paymentMethod: 'stripe', accountingInvoiceId: invoiceId, accountingInvoiceConnector: 'xero', paidAt: new Date(`${CN_DATE}T09:00:00Z`),
    } as never,
    select: { id: true },
  })
  await d.db.payment.create({ data: { orderId: order.id, amount: 50, currency: CCY, method: 'stripe', paidAt: new Date('2026-10-30T09:00:00Z'), settlementRateToBase: 1.05 } })
  await d.db.accountingSyncLog.create({
    data: { connector: 'xero', type: 'SALES_INVOICE', status: 'SYNCED', referenceType: 'SalesOrder', referenceId: order.id, externalTransactionId: invoiceId, payload: {}, attemptStampingCustodyAt: new Date() } as never,
  })
  const refund = await d.db.salesOrderRefund.create({
    data: {
      orderId: order.id, totalForeign: 40, totalBase: 38.1, accountingCreditNoteId: creditNoteId, accountingCreditNoteConnector: 'xero',
      ...(opts.gateway ? { externalRefundId: Math.floor(Math.random() * 1_000_000_000) + 1, refundedViaGateway: true } : {}),
    } as never,
    select: { id: true },
  })
  if (!opts.gateway) {
    // The refund payment as the Payments dialog records a picked date: midnight UTC, no explicit instant.
    for (const p of opts.refundPayments ?? [{ amount: 40, paidAt: opts.refundPaidAt }]) {
      await d.db.payment.create({ data: { orderId: order.id, refundId: refund.id, amount: p.amount, currency: CCY, method: 'stripe', paidAt: p.paidAt, paidAtExplicitInstant: null } })
    }
  }
  await d.db.accountingSyncLog.create({
    data: { connector: 'xero', type: 'CREDIT_NOTE', status: 'SYNCED', referenceType: 'SalesOrderRefund', referenceId: refund.id, externalTransactionId: creditNoteId, payload: { date: CN_DATE }, attemptStampingCustodyAt: new Date() } as never,
  })
  creditNotes.set(creditNoteId, { remaining: 40, payments: [] })
  t.after(async () => {
    const ids = (await d.db.accountingSyncLog.findMany({ where: { OR: [{ referenceId: refund.id }, { referenceId: order.id }] }, select: { id: true } })).map((r) => r.id)
    if (ids.length > 0) await d.db.integrationOutbox.deleteMany({ where: { OR: ids.map((id) => ({ idempotencyKey: { contains: id } })) } }).catch(() => undefined)
    await d.db.activityLog.deleteMany({ where: { entityId: { in: [order.id, refund.id] } } })
    await d.db.accountingSyncLog.deleteMany({ where: { id: { in: ids } } })
    await d.db.payment.deleteMany({ where: { orderId: order.id } })
    await d.db.salesOrderRefund.deleteMany({ where: { id: refund.id } })
    await d.db.salesOrder.deleteMany({ where: { id: order.id } })
    await d.db.accountingAccount.delete({ where: { id: account.id } })
    await d.db.fxRate.deleteMany({ where: { toCurrency: CCY } })
    await d.db.currency.deleteMany({ where: { code: CCY } }).catch(() => undefined)
    await setSetting(d, PAYMENT_MAP, priorMap)
    await setSetting(d, FLAG, null)
    await setSetting(d, CASH_OUT_FLAG, priorCashOut)
  })
  return { orderId: order.id, refundId: refund.id, creditNoteId, invoiceId, accountId: account.externalAccountId }
}

/** The settlement row as the sweep raises it (no decision yet), or with an earlier, unsent decision of its own (`extra`). */
async function writeRow(d: Deps, s: Seeded, extra: Record<string, unknown> = {}, row: { remoteAttemptedAt?: Date } = {}) {
  const created = await d.db.accountingSyncLog.create({
    data: {
      ...row,
      connector: 'xero', type: 'CREDIT_NOTE_ALLOCATION', status: 'PENDING', referenceType: 'SalesOrderRefund', referenceId: s.refundId,
      payload: { creditNoteId: s.creditNoteId, accountingInvoiceId: s.invoiceId, refundId: s.refundId, orderId: s.orderId, date: CN_DATE, sourceEntryId: `test-${randomUUID().slice(0, 6)}`, ...extra },
      attemptStampingCustodyAt: new Date(), createdAt: ancient(),
    } as never,
    select: { id: true },
  })
  await queueFirst(d, created.id)
  return created
}

function reset() {
  refunds.length = 0
  allocations.length = 0
  amountDue = 0
  creditNotes.clear()
}

async function sentFor(d: Deps, s: Seeded, rowId: string) {
  await d.processor.processPendingXeroSync()
  const sent = refunds.filter((r) => r.creditNoteId === s.creditNoteId)
  const row = await d.db.accountingSyncLog.findUniqueOrThrow({ where: { id: rowId }, select: { status: true, payload: true, errorMessage: true } })
  return { sent, row, payload: row.payload as Record<string, unknown> }
}

test('[l9gej] switch OFF (the default): the recorded refund payment is dated and rated on the credit note\'s day, exactly as before', { skip }, async (t) => {
  const d = await deps()
  reset()
  const s = await seed(d, t, { cashOutFlag: null, refundPaidAt: new Date(`${CASH_DATE}T00:00:00Z`) })
  const row = await writeRow(d, s)
  const { sent, row: after, payload } = await sentFor(d, s, row.id)
  assert.equal(sent.length, 1, `one refund payment went out (${after.errorMessage ?? ''})`)
  assert.equal(sent[0]!.date, CN_DATE)
  assert.equal(payload.date, CN_DATE)
  assert.equal(payload.settlementRateToBase, RATE_CN_DAY)
  assert.equal('creditNoteDate' in payload, false, 'off, nothing new is written on the row')
  assert.equal(after.status, 'SYNCED')
})

test('[l9gej] switch ON: the recorded refund payment paid a week later is dated on its Paid date and carries that day\'s rate, pinned before the call', { skip }, async (t) => {
  const d = await deps()
  reset()
  const s = await seed(d, t, { cashOutFlag: 'true', refundPaidAt: new Date(`${CASH_DATE}T00:00:00Z`) })
  const row = await writeRow(d, s)
  const { sent, row: after, payload } = await sentFor(d, s, row.id)
  assert.equal(sent.length, 1, `one refund payment went out (${after.errorMessage ?? ''})`)
  assert.equal(sent[0]!.date, CASH_DATE, 'the bank date is the day the cash went out')
  assert.equal(sent[0]!.amount, 40)
  assert.equal(payload.date, CASH_DATE)
  assert.equal(payload.settlementRateToBase, RATE_CASH_DAY, 'the realised FX is measured at the cash-out day\'s rate')
  assert.ok(typeof sent[0]!.currencyRate === 'number' && Math.abs(sent[0]!.currencyRate - RATE_CASH_DAY) < 1e-6, `CurrencyRate is the cash-out rate as is, never its inverse (${sent[0]!.currencyRate})`)
  assert.equal(payload.creditNoteDate, CN_DATE, 'the credit note\'s own date is kept on the row')
  assert.equal(after.status, 'SYNCED')
})

test('[l9gej] switch ON: a GATEWAY refund (no recorded payment) keeps the credit note\'s date and rate', { skip }, async (t) => {
  const d = await deps()
  reset()
  const s = await seed(d, t, { cashOutFlag: 'true', refundPaidAt: new Date(`${CASH_DATE}T00:00:00Z`), gateway: true })
  const row = await writeRow(d, s)
  const { sent, row: after, payload } = await sentFor(d, s, row.id)
  assert.equal(sent.length, 1, `one refund payment went out (${after.errorMessage ?? ''})`)
  assert.equal(sent[0]!.date, CN_DATE)
  assert.equal(payload.settlementRateToBase, RATE_CN_DAY)
})

test('[l9gej] switch ON: a recorded payment dated BEFORE the credit note keeps the credit note\'s date (Xero never dates a payment before its document)', { skip }, async (t) => {
  const d = await deps()
  reset()
  const s = await seed(d, t, { cashOutFlag: 'true', refundPaidAt: new Date('2026-11-01T00:00:00Z') })
  const row = await writeRow(d, s)
  const { sent, row: after, payload } = await sentFor(d, s, row.id)
  assert.equal(sent.length, 1, `one refund payment went out (${after.errorMessage ?? ''})`)
  assert.equal(sent[0]!.date, CN_DATE)
  assert.equal(payload.settlementRateToBase, RATE_CN_DAY)
})

test('[l9gej] switched OFF again: an UNSENT row that was re-dated goes back to the credit note\'s date and rate', { skip }, async (t) => {
  const d = await deps()
  reset()
  const s = await seed(d, t, { cashOutFlag: 'false', refundPaidAt: new Date(`${CASH_DATE}T00:00:00Z`) })
  // An earlier claim decided under the switch, then failed before any call (no remoteAttemptedAt): the decision is taken again.
  const row = await writeRow(d, s, {
    date: CASH_DATE, creditNoteDate: CN_DATE, operation: 'REFUND_PAYMENT', amount: 40, currency: CCY, bankAccountId: s.accountId, paymentMethod: 'stripe',
    cashEvidence: 'RECORDED', rateDecided: true, settlementRateToBase: RATE_CASH_DAY,
  })
  const { sent, row: after, payload } = await sentFor(d, s, row.id)
  assert.equal(sent.length, 1, `one refund payment went out (${after.errorMessage ?? ''})`)
  assert.equal(sent[0]!.date, CN_DATE)
  assert.equal(payload.date, CN_DATE)
  assert.equal(payload.settlementRateToBase, RATE_CN_DAY)
})

// ─── #1130 review MED-4 ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A full decision as a claim under the switch pinned it (`date` and the rate of that day), for a row replayed as it is. */
const fullPin = (s: Seeded, date: string, rate: number, extra: Record<string, unknown> = {}) => ({
  date, operation: 'REFUND_PAYMENT', amount: 40, currency: CCY, bankAccountId: s.accountId, paymentMethod: 'stripe', cashEvidence: 'RECORDED', rateDecided: true,
  settlementRateToBase: rate, ...extra,
})
const ATTEMPTED = { remoteAttemptedAt: new Date('2026-11-10T10:00:00Z') }

test('[#1130 MED-4] an ATTEMPTED row decided with the switch ON, then the switch turned OFF: replayed exactly on its cash-out date, never restored', { skip }, async (t) => {
  const d = await deps()
  reset()
  const s = await seed(d, t, { cashOutFlag: 'false', refundPaidAt: new Date(`${CASH_DATE}T00:00:00Z`) })
  const row = await writeRow(d, s, fullPin(s, CASH_DATE, RATE_CASH_DAY, { creditNoteDate: CN_DATE }), ATTEMPTED)
  const { sent, row: after, payload } = await sentFor(d, s, row.id)
  assert.equal(sent.length, 1, `the replay went out (${after.errorMessage ?? ''})`)
  assert.equal(sent[0]!.date, CASH_DATE, 'its call may have landed on that date: the ledger fence and the replay keep it')
  assert.equal(payload.date, CASH_DATE)
  assert.equal(payload.settlementRateToBase, RATE_CASH_DAY)
})

test('[#1130 MED-4] an ATTEMPTED row decided with the switch OFF, then the switch turned ON: replayed exactly on the credit note\'s date, never re-dated', { skip }, async (t) => {
  const d = await deps()
  reset()
  const s = await seed(d, t, { cashOutFlag: 'true', refundPaidAt: new Date(`${CASH_DATE}T00:00:00Z`) })
  const row = await writeRow(d, s, fullPin(s, CN_DATE, RATE_CN_DAY), ATTEMPTED)
  const { sent, row: after, payload } = await sentFor(d, s, row.id)
  assert.equal(sent.length, 1, `the replay went out (${after.errorMessage ?? ''})`)
  assert.equal(sent[0]!.date, CN_DATE)
  assert.equal(payload.date, CN_DATE)
  assert.equal(payload.settlementRateToBase, RATE_CN_DAY)
  assert.equal('creditNoteDate' in payload, false)
})

test('[#1130 MED-1] an ATTEMPTED row pinned before rateDecided existed (so not replayed), switch ON: decided again but NOT re-dated', { skip }, async (t) => {
  const d = await deps()
  reset()
  const s = await seed(d, t, { cashOutFlag: 'true', refundPaidAt: new Date(`${CASH_DATE}T00:00:00Z`) })
  const row = await writeRow(d, s, { operation: 'REFUND_PAYMENT', amount: 40, currency: CCY, bankAccountId: s.accountId, paymentMethod: 'stripe' }, ATTEMPTED)
  const { sent, row: after, payload } = await sentFor(d, s, row.id)
  assert.equal(sent.length, 1, `one refund payment went out (${after.errorMessage ?? ''})`)
  assert.equal(sent[0]!.date, CN_DATE, 'the date its earlier call may have landed on: the ledger fence looks there')
  assert.equal(payload.date, CN_DATE)
  assert.equal('creditNoteDate' in payload, false, 'no re-date was pinned')
})

test('[#1130 MED-4] switch ON, the cash-out day\'s rate is unusable: refused, nothing pinned, nothing sent', { skip }, async (t) => {
  const d = await deps()
  reset()
  const s = await seed(d, t, { cashOutFlag: 'true', refundPaidAt: new Date(`${CASH_DATE}T00:00:00Z`) })
  // The latest row as of the cash-out day is a bad one (zero): the lookup refuses rather than fall back to an older rate.
  await d.db.fxRate.create({ data: { fromCurrency: 'GBP', toCurrency: CCY, rate: 0, fetchedAt: new Date(`${CASH_DATE}T10:00:00Z`), source: 'manual', manualOverride: true } })
  const row = await writeRow(d, s)
  const { sent, row: after, payload } = await sentFor(d, s, row.id)
  assert.equal(sent.length, 0, 'nothing went out')
  assert.notEqual(after.status, 'SYNCED')
  // The refusal is the outbox delivery's error (retried later), not a decision written on the row.
  const delivery = await d.db.integrationOutbox.findMany({ where: { idempotencyKey: { contains: row.id } }, select: { lastError: true } })
  assert.ok(delivery.some((o) => /Refund payment not sent: .*FX rate/.test(o.lastError ?? '')), `refused on the cash-out day's rate: ${JSON.stringify(delivery)}`)
  assert.equal(payload.date, CN_DATE, 'the row keeps the credit note\'s date')
  for (const key of ['creditNoteDate', 'rateDecided', 'amount', 'settlementRateToBase']) assert.equal(key in payload, false, `${key} is not pinned`)
})

test('[#1130 MED-4] several recorded refund payments: the LATEST paidAt is the cash-out day', { skip }, async (t) => {
  const d = await deps()
  reset()
  const s = await seed(d, t, {
    cashOutFlag: 'true', refundPaidAt: new Date(`${CASH_DATE}T00:00:00Z`),
    refundPayments: [{ amount: 20, paidAt: new Date(`${CASH_DATE}T00:00:00Z`) }, { amount: 20, paidAt: new Date('2026-11-05T00:00:00Z') }],
  })
  const row = await writeRow(d, s)
  const { sent, row: after, payload } = await sentFor(d, s, row.id)
  assert.equal(sent.length, 1, `one refund payment went out (${after.errorMessage ?? ''})`)
  assert.equal(sent[0]!.amount, 40, 'their sum')
  assert.equal(sent[0]!.date, CASH_DATE, 'the later of the two, whatever order they were recorded in')
  assert.equal(payload.settlementRateToBase, RATE_CASH_DAY)
})

test('[#1130 MED-4] the refund payment\'s paidAt is edited after an unsent decision: the row is decided again on the new day', { skip }, async (t) => {
  const d = await deps()
  reset()
  const s = await seed(d, t, { cashOutFlag: 'true', refundPaidAt: new Date(`${CASH_DATE}T00:00:00Z`) })
  const row = await writeRow(d, s, fullPin(s, CASH_DATE, RATE_CASH_DAY, { creditNoteDate: CN_DATE }))
  await d.db.payment.updateMany({ where: { refundId: s.refundId }, data: { paidAt: new Date('2026-11-12T00:00:00Z') } })
  const { sent, row: after, payload } = await sentFor(d, s, row.id)
  assert.equal(sent.length, 1, `one refund payment went out (${after.errorMessage ?? ''})`)
  assert.equal(sent[0]!.date, '2026-11-12')
  assert.equal(payload.date, '2026-11-12')
  assert.equal(payload.creditNoteDate, CN_DATE)
})

test('[#1130 LOW-1] an unsent row re-dated under the switch that now needs an ALLOCATE goes back to the credit note\'s date', { skip }, async (t) => {
  const d = await deps()
  reset()
  const s = await seed(d, t, { cashOutFlag: 'true', refundPaidAt: new Date(`${CASH_DATE}T00:00:00Z`) })
  // The receipts are removed after the decision: IMS now holds no receipt evidence for the invoice, so the settlement is an ALLOCATE.
  await d.db.payment.deleteMany({ where: { orderId: s.orderId } })
  await d.db.salesOrder.update({ where: { id: s.orderId }, data: { paidAt: null } })
  amountDue = 40
  const row = await writeRow(d, s, fullPin(s, CASH_DATE, RATE_CASH_DAY, { creditNoteDate: CN_DATE }))
  await d.processor.processPendingXeroSync()
  const after = await d.db.accountingSyncLog.findUniqueOrThrow({ where: { id: row.id }, select: { payload: true, errorMessage: true } })
  const payload = after.payload as Record<string, unknown>
  assert.equal(payload.operation, 'ALLOCATE', `decided again as an allocation (${after.errorMessage ?? ''})`)
  const sent = allocations.filter((a) => a.creditNoteId === s.creditNoteId)
  assert.equal(sent.length, 1, 'the allocation went out')
  assert.equal(sent[0]!.date, CN_DATE, 'the stale cash-out date did not carry into the allocation')
  assert.equal(payload.date, CN_DATE)
})

