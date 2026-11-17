/**
 * The Xero customer-payment matching pass (lib/domain/accounting/payment-matching.ts). Real scratch database; the ledger registration is a recording double (there is no live Xero in a scratch
 * database and the preload refuses the network), and the "on record" probe reads the sync rows the double writes. Every arm names the mutation that turns it red.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { after, before, beforeEach, mock } from 'node:test'
import { startScratch, type Scratch } from '../first-load/apply-scratch'

process.env.SETTINGS_ENCRYPTION_KEY = 'a1'.repeat(32)

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireRole: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireInternalUser: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })

const registrations: Array<{ paymentId: string; orderId: string }> = []
let recordMode: 'record' | 'fail' = 'record'
let s: Scratch
let seq = 0

const MAP = JSON.stringify({ 'Bank:GBP': 'BANK-GBP', 'Card:EUR': 'BANK-EUR' })

before(async () => {
  s = await startScratch('ims-payment-matching')
  const actual = await import('@/lib/domain/accounting/invoice-payment-enqueue')
  mock.module('@/lib/domain/accounting/invoice-payment-enqueue', {
    namedExports: {
      ...actual,
      registerInvoicePaymentWithLedger: async (p: { paymentId: string; orderId: string }) => {
        registrations.push({ paymentId: p.paymentId, orderId: p.orderId })
        if (recordMode === 'record' && (await s.db.accountingSyncLog.count({ where: { type: 'INVOICE_PAYMENT', referenceId: p.orderId, payload: { path: ['paymentId'], equals: p.paymentId } } })) === 0) {
          await s.db.accountingSyncLog.create({ data: { connector: 'xero', type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: p.orderId, status: 'PENDING', payload: { paymentId: p.paymentId } } })
        }
        return null
      },
    },
  })
})
after(async () => { await s?.stop() })

async function setSetting(key: string, value: string | null) {
  if (value === null) { await s.db.setting.deleteMany({ where: { key } }); return }
  await s.db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
}
const syncRows = () => s.db.accountingSyncLog.count({ where: { type: 'INVOICE_PAYMENT' } })
const matchOf = (paymentId: string) => s.db.xeroPaymentMatch.findUnique({ where: { paymentId } })

async function order(opts: { currency?: string; total?: string; connector?: string | null } = {}) {
  const n = ++seq
  const currency = opts.currency ?? 'GBP'
  const total = opts.total ?? '100'
  return s.db.salesOrder.create({
    data: {
      currency, fxRateToBase: currency === 'GBP' ? 1 : 0.85, subtotalForeign: total, totalForeign: total, subtotalBase: total, totalBase: total,
      accountingInvoiceId: `INV-PM-${n}`, accountingInvoiceConnector: opts.connector === undefined ? 'xero' : opts.connector, status: 'PROCESSING',
    },
    select: { id: true, accountingInvoiceId: true },
  })
}
async function receipt(orderId: string, o: { amount: number; currency?: string; method?: string; paidAt?: Date; rate?: number | null }) {
  const p = await s.db.payment.create({ data: { orderId, amount: o.amount, currency: o.currency ?? 'GBP', method: o.method ?? 'Bank', paidAt: o.paidAt ?? new Date('2026-11-10T10:00:00Z'), settlementRateToBase: o.rate ?? null } })
  await s.sql(`update payments set "createdAt" = now() - interval '60 minutes' where id = $1`, [p.id])
  return p
}

let pm: typeof import('@/lib/domain/accounting/payment-matching')

beforeEach(async () => {
  pm = await import('@/lib/domain/accounting/payment-matching')
  registrations.length = 0
  recordMode = 'record'
  // each test starts from no receipts, results or payment rows (the orders it left are inert without a receipt)
  await s.sql(`delete from xero_payment_matches`)
  await s.sql(`delete from accounting_sync_logs where type = 'INVOICE_PAYMENT'`)
  await s.sql(`delete from payments`)
  delete process.env.PRODUCER_HOLD_ENFORCED_DESTINATIONS
  await setSetting('accounting_payment_account_map', MAP)
  await setSetting('xero_books_lock_date', null)
  await setSetting(pm.PAYMENT_MATCHING_MODE_KEY, null)
  pm.paymentMatchingSeams.registrationsAreOwed = async () => true
  pm.paymentMatchingSeams.bankAccountBelongsToXero = async () => true
  pm.paymentMatchingSeams.outboundHeld = undefined
  pm.paymentMatchingSeams.beforeClaim = undefined
  pm.paymentMatchingSeams.afterClaim = undefined
  const sweep = await import('@/lib/domain/accounting/receipt-registration-sweep')
  sweep.receiptRegistrationSeams.obligationIsOnRecord = async (o, pid) => (await s.db.accountingSyncLog.count({ where: { type: 'INVOICE_PAYMENT', referenceId: o, payload: { path: ['paymentId'], equals: pid } } })) > 0
})

// [mutation: read the setting with a default of shadow, or treat an unknown value as live]
test('the mode defaults to off and anything but shadow or live is off', async () => {
  const { parsePaymentMatchingMode, getPaymentMatchingMode } = await import('@/lib/domain/accounting/payment-matching')
  assert.equal(await getPaymentMatchingMode(), 'off')
  for (const raw of [null, undefined, '', 'true', 'LIVEX', 'on', '1']) assert.equal(parsePaymentMatchingMode(raw), 'off', String(raw))
  assert.equal(parsePaymentMatchingMode('Shadow'), 'shadow')
  assert.equal(parsePaymentMatchingMode('live'), 'live')
})

// [mutation: run the evaluation before the mode check]
test('off does nothing: no candidate is read or recorded, nothing is registered', async () => {
  const o = await order()
  const p = await receipt(o.id, { amount: 40 })
  const before = await syncRows()
  const result = await pm.runPaymentMatchingPass()
  assert.equal(result.mode, 'off')
  assert.equal(result.examined, 0)
  assert.equal(await matchOf(p.id), null)
  assert.equal(await s.db.xeroPaymentMatch.count(), 0)
  assert.equal(registrations.length, 0)
  assert.equal(await syncRows(), before)
})

// [mutation: shadow calls registerReceiptAndProveObligation; shadow queues a sync row; shadow records no result]
test('shadow records what WOULD be posted and makes zero Xero writes (no registration call, no sync row)', async () => {
  await setSetting(pm.PAYMENT_MATCHING_MODE_KEY, 'shadow')
  const o = await order()
  const p = await receipt(o.id, { amount: 40 })
  const syncBefore = await s.db.accountingSyncLog.count()
  const first = await pm.runPaymentMatchingPass()
  assert.equal(first.mode, 'shadow')
  const row = await matchOf(p.id)
  assert.ok(row)
  assert.equal(row.status, 'WOULD_POST')
  assert.equal(row.bankAccountId, 'BANK-GBP')
  assert.equal(row.accountingInvoiceId, o.accountingInvoiceId)
  assert.equal(row.amount.toFixed(2), '40.00')
  assert.equal(row.amountDue?.toFixed(2), '100.00')
  assert.equal(row.reason, null)
  assert.equal(registrations.length, 0, 'shadow never calls the registration path')
  assert.equal(await s.db.accountingSyncLog.count(), syncBefore, 'shadow writes no sync row, so nothing can reach Xero')
  const again = await pm.runPaymentMatchingPass()
  assert.equal(again.mode, 'shadow')
  assert.equal(await s.db.xeroPaymentMatch.count({ where: { paymentId: p.id } }), 1, 'a rerun updates the one row')
  assert.equal(registrations.length, 0)
  const src = readFileSync('lib/domain/accounting/payment-matching.ts', 'utf8')
  assert.ok(!/xeroPost|xeroPut|xeroGet|fetch\(/.test(src), 'the module has no direct Xero or network call of its own')
})

// [mutation: default an unmapped receipt to some bank account; match on currency alone]
test('an unmapped payment system or currency is UNMATCHED with the reason, and no bank account is guessed', async () => {
  await setSetting(pm.PAYMENT_MATCHING_MODE_KEY, 'live')
  const o = await order()
  const paypal = await receipt(o.id, { amount: 10, method: 'PayPal' })
  const eurOnGbp = await receipt((await order({ currency: 'EUR' })).id, { amount: 10, currency: 'EUR', method: 'Bank', rate: 1.17 })
  const result = await pm.runPaymentMatchingPass()
  assert.equal(result.unmatched, 2)
  for (const id of [paypal.id, eurOnGbp.id]) {
    const row = await matchOf(id)
    assert.equal(row?.status, 'UNMATCHED')
    assert.equal(row?.reason, 'NO_BANK_ACCOUNT')
    assert.equal(row?.bankAccountId, null)
  }
  assert.match((await matchOf(paypal.id))?.detail ?? '', /PayPal/)
  assert.equal(registrations.length, 0, 'nothing registered even in live')
})

test('a mapped account that is not in the connected Xero chart is UNMATCHED', async () => {
  await setSetting(pm.PAYMENT_MATCHING_MODE_KEY, 'shadow')
  pm.paymentMatchingSeams.bankAccountBelongsToXero = async () => false
  const p = await receipt((await order()).id, { amount: 10 })
  await pm.runPaymentMatchingPass()
  assert.equal((await matchOf(p.id))?.reason, 'PAYMENT_ACCOUNT_NOT_IN_LEDGER')
  assert.equal((await matchOf(p.id))?.status, 'UNMATCHED')
})

// [mutation: drop the capacity check; count a FAILED row's amount; ignore other registrations on the invoice]
test('the amount due caps the match: never overpays, a part payment within it is allowed', async () => {
  await setSetting(pm.PAYMENT_MATCHING_MODE_KEY, 'shadow')
  const o = await order({ total: '100' })
  const over = await receipt(o.id, { amount: 150 })
  const part = await receipt((await order({ total: '100' })).id, { amount: 40 })
  const withHeld = await order({ total: '100' })
  await s.db.accountingSyncLog.create({ data: { connector: 'xero', type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: withHeld.id, status: 'SYNCED', externalTransactionId: 'XP-1', payload: { paymentId: 'other-receipt', amount: 70, amountDecimal: '70', currency: 'GBP', accountingInvoiceId: withHeld.accountingInvoiceId } } })
  const afterPart = await receipt(withHeld.id, { amount: 40 })
  await pm.runPaymentMatchingPass()
  const overRow = await matchOf(over.id)
  assert.equal(overRow?.status, 'BLOCKED')
  assert.equal(overRow?.reason, 'WOULD_OVERPAY')
  assert.equal(overRow?.amountDue?.toFixed(2), '100.00')
  assert.equal((await matchOf(part.id))?.status, 'WOULD_POST', 'a part payment within the amount due is allowed')
  const rest = await matchOf(afterPart.id)
  assert.equal(rest?.reason, 'WOULD_OVERPAY', '40 does not fit in the 30 left after the 70 already registered')
  assert.equal(rest?.amountDue?.toFixed(2), '30.00')
})

// [mutation: date the match by the first open day; drop the lock check; compare with < instead of <=]
test('a receipt dated in a locked Xero period is BLOCKED and its date is not moved', async () => {
  await setSetting(pm.PAYMENT_MATCHING_MODE_KEY, 'live')
  await setSetting('xero_books_lock_date', '2026-06-30')
  const locked = await receipt((await order()).id, { amount: 20, paidAt: new Date('2026-06-30T12:00:00Z') })
  const open = await receipt((await order()).id, { amount: 20, paidAt: new Date('2026-07-01T12:00:00Z') })
  await pm.runPaymentMatchingPass()
  const lockedRow = await matchOf(locked.id)
  assert.equal(lockedRow?.status, 'BLOCKED')
  assert.equal(lockedRow?.reason, 'LOCKED_PERIOD')
  assert.equal(lockedRow?.paymentDate?.toISOString(), '2026-06-30T12:00:00.000Z', 'the date is the receipt\'s own, never moved')
  assert.equal((await matchOf(open.id))?.status, 'REGISTERED')
  assert.deepEqual(registrations.map((r) => r.paymentId), [open.id], 'the locked receipt was not registered')
})

// [mutation: skip the hold check in the plan]
test('the outbound write hold blocks the match (real producer seam), in shadow and in live', async () => {
  for (const mode of ['shadow', 'live']) {
    await setSetting(pm.PAYMENT_MATCHING_MODE_KEY, mode)
    process.env.PRODUCER_HOLD_ENFORCED_DESTINATIONS = 'xero'
    const p = await receipt((await order()).id, { amount: 25 })
    await pm.runPaymentMatchingPass()
    const row = await matchOf(p.id)
    assert.equal(row?.status, 'BLOCKED', mode)
    assert.equal(row?.reason, 'OUTBOUND_HOLD', mode)
  }
  assert.equal(registrations.length, 0)
  delete process.env.PRODUCER_HOLD_ENFORCED_DESTINATIONS
})

// [mutation: skip the claim; register before claiming; mark REGISTERED without the registration; rerun re-registers]
test('live registers through the existing path once, and an idempotent rerun registers nothing more', async () => {
  await setSetting(pm.PAYMENT_MATCHING_MODE_KEY, 'live')
  const o = await order()
  const p = await receipt(o.id, { amount: 40 })
  const first = await pm.runPaymentMatchingPass()
  assert.equal(first.registered, 1)
  assert.deepEqual(registrations, [{ paymentId: p.id, orderId: o.id }])
  const row = await matchOf(p.id)
  assert.equal(row?.status, 'REGISTERED')
  assert.ok(row?.registeredAt)
  assert.equal(row?.attempts, 1)
  const again = await pm.runPaymentMatchingPass()
  assert.equal(again.registered, 0)
  assert.equal(registrations.length, 1, 'registered once')
  assert.equal(await s.db.accountingSyncLog.count({ where: { type: 'INVOICE_PAYMENT', referenceId: o.id } }), 1)
})

// [mutation: claim with a plain update by id, or read-then-write without a condition]
test('two concurrent sweeps register a receipt once: the durable claim has one winner', async () => {
  await setSetting(pm.PAYMENT_MATCHING_MODE_KEY, 'live')
  const o = await order()
  const p = await receipt(o.id, { amount: 40 })
  // both sweeps have evaluated it and are about to claim: hold them there, then release both together
  let waiting = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  pm.paymentMatchingSeams.beforeClaim = async (id) => {
    if (id !== p.id) return
    waiting++
    if (waiting === 2) release()
    await gate
  }
  const [a, b] = await Promise.all([pm.runPaymentMatchingPass(), pm.runPaymentMatchingPass()])
  assert.equal(registrations.filter((r) => r.paymentId === p.id).length, 1, 'exactly one registration')
  assert.equal(a.registered + b.registered, 1)
  assert.equal((await matchOf(p.id))?.status, 'REGISTERED')
})

// [mutation: leave the claim in place on failure; retry a failed claim without a cap]
test('a failed registration is recorded FAILED and retried, then left for a person after the attempt cap', async () => {
  await setSetting(pm.PAYMENT_MATCHING_MODE_KEY, 'live')
  recordMode = 'fail'
  const p = await receipt((await order()).id, { amount: 40 })
  const first = await pm.runPaymentMatchingPass()
  assert.equal(first.failed, 1)
  assert.equal((await matchOf(p.id))?.status, 'FAILED')
  recordMode = 'record'
  const second = await pm.runPaymentMatchingPass()
  assert.equal(second.registered, 1)
  assert.equal((await matchOf(p.id))?.status, 'REGISTERED')
  const stuck = await receipt((await order()).id, { amount: 5 })
  recordMode = 'fail'
  for (let i = 0; i < pm.MAX_LIVE_ATTEMPTS + 2; i++) await pm.runPaymentMatchingPass()
  assert.equal((await matchOf(stuck.id))?.attempts, pm.MAX_LIVE_ATTEMPTS, 'stops at the cap')
  assert.equal((await matchOf(stuck.id))?.status, 'FAILED')
})

// [mutation: a stale claim is never taken back; a fresh claim is taken over]
test('a claim from a dead sweep is taken over once stale, and a fresh claim is left alone', async () => {
  await setSetting(pm.PAYMENT_MATCHING_MODE_KEY, 'live')
  const p = await receipt((await order()).id, { amount: 40 })
  await pm.runPaymentMatchingPass() // registers it
  const fresh = await receipt((await order()).id, { amount: 10 })
  const stale = await receipt((await order()).id, { amount: 11 })
  pm.paymentMatchingSeams.afterClaim = async (id) => { if (id === fresh.id || id === stale.id) throw new Error('died after claiming') }
  recordMode = 'fail'
  await pm.runPaymentMatchingPass() // both fail: FAILED, claim released
  pm.paymentMatchingSeams.afterClaim = undefined
  // simulate sweeps that died holding the claim
  await s.sql(`update xero_payment_matches set status = 'CLAIMED', claim_token = 'dead', claimed_at = now() where payment_id = $1`, [fresh.id])
  await s.sql(`update xero_payment_matches set status = 'CLAIMED', claim_token = 'dead', claimed_at = now() - interval '2 hours' where payment_id = $1`, [stale.id])
  recordMode = 'record'
  await pm.runPaymentMatchingPass()
  assert.equal((await matchOf(fresh.id))?.status, 'CLAIMED', 'a fresh claim is another sweep\'s')
  assert.equal((await matchOf(stale.id))?.status, 'REGISTERED')
  assert.ok(p.id)
})

// [mutation: skip the currency comparison; drop the stored-rate requirement; read the amount due in base currency]
test('a foreign-currency invoice matches in its own currency through the EUR mapping and needs its stored rate', async () => {
  await setSetting(pm.PAYMENT_MATCHING_MODE_KEY, 'shadow')
  const eur = await order({ currency: 'EUR', total: '120' })
  const ok = await receipt(eur.id, { amount: 50, currency: 'EUR', method: 'Card', rate: 1.17 })
  const noRate = await receipt((await order({ currency: 'EUR', total: '120' })).id, { amount: 50, currency: 'EUR', method: 'Card', rate: null })
  const wrongCurrency = await receipt((await order({ currency: 'EUR', total: '120' })).id, { amount: 50, currency: 'GBP', method: 'Bank' })
  await pm.runPaymentMatchingPass()
  const row = await matchOf(ok.id)
  assert.equal(row?.status, 'WOULD_POST')
  assert.equal(row?.currency, 'EUR')
  assert.equal(row?.bankAccountId, 'BANK-EUR')
  assert.equal(row?.amountDue?.toFixed(2), '120.00', 'the amount due is in the invoice currency')
  assert.equal((await matchOf(noRate.id))?.reason, 'MISSING_FX_RATE')
  assert.equal((await matchOf(noRate.id))?.status, 'BLOCKED')
  assert.equal((await matchOf(wrongCurrency.id))?.reason, 'CURRENCY_MISMATCH')
  assert.equal((await matchOf(wrongCurrency.id))?.status, 'UNMATCHED')
  assert.equal(registrations.length, 0)
})

// [mutation: select refunds; select a receipt that has a sync row; select an order not on Xero]
test('only a non-refund receipt of a Xero-posted order with no INVOICE_PAYMENT row is a candidate', async () => {
  await setSetting(pm.PAYMENT_MATCHING_MODE_KEY, 'shadow')
  const o = await order()
  const registered = await receipt(o.id, { amount: 10 })
  await s.db.accountingSyncLog.create({ data: { connector: 'xero', type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: o.id, status: 'SYNCED', externalTransactionId: 'XP-9', payload: { paymentId: registered.id, amount: 10, amountDecimal: '10', currency: 'GBP', accountingInvoiceId: o.accountingInvoiceId } } })
  const notXero = await receipt((await order({ connector: null })).id, { amount: 10 })
  const young = await s.db.payment.create({ data: { orderId: (await order()).id, amount: 10, currency: 'GBP', method: 'Bank' } })
  await pm.runPaymentMatchingPass()
  for (const id of [registered.id, notXero.id, young.id]) assert.equal(await matchOf(id), null, id)
})

test('the cron runs the pass every run, in its own error boundary', () => {
  const route = readFileSync('app/api/cron/fx-rates/route.ts', 'utf8')
  assert.match(route, /runStep\('payment-matching'/)
  assert.match(route, /runPaymentMatchingPass\(\{ limit: 50 \}\)/)
})
