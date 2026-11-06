import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * WHICH IDEMPOTENCY KEY A MONEY ROW USES, DECIDED ONCE AND WRITTEN DOWN (resolveXeroMoneyPostIdempotencyKey), ON A REAL DATABASE.
 *
 *   1. a row proven never to have attempted gets the settlement-derived key, stored on the row; every later call returns the stored key
 *   2. two fresh rows of one settlement resolve one key; two concurrent resolutions of one row agree
 *   3. MIXED VERSION: a row that has attempted (or whose attempts no stamping build can vouch for) and has no stored key keeps the legacy row-token key, and keeps it
 *   4. a stored key wins over everything, including a later reversal
 *   5. REPAY AFTER A PROVEN REVERSAL: a fresh row for the same bill and amount, once a registration of it was cancelled with a verified reversal, resolves a NEW key;
 *      retries of the repayment resolve that same key; an unrelated bill's, or another receipt's, reversal changes nothing
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const RUN_ID = `MKR-${process.pid}-${randomUUID().slice(0, 8)}`

function loadEnv(): void {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
}

test('money-post key resolution on a real database', { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' }, async (t) => {
  loadEnv()
  const { db } = await import('../../lib/db/index.ts')
  const proc = await import('../../lib/connectors/xero/sync-processor.ts')
  const { MONEY_POST_KEY_FIELD } = await import('../../lib/domain/accounting/money-post-document.ts')
  const created: string[] = []
  t.after(async () => { await db.accountingSyncLog.deleteMany({ where: { id: { in: created } } }) })

  type Opts = { type?: 'BILL_PAYMENT' | 'INVOICE_PAYMENT'; invoice: string; paymentId?: string; amount?: number; attempted?: boolean; custody?: boolean; status?: 'PENDING' | 'CANCELLED'; basis?: string; token?: string; ref?: string }
  async function row(o: Opts) {
    const type = o.type ?? 'BILL_PAYMENT'
    const payload: Record<string, unknown> = { accountingInvoiceId: o.invoice, bankAccountId: 'BANK', amount: o.amount ?? 250, amountDecimal: String(o.amount ?? 250), paymentDate: '2026-08-09' }
    if (o.paymentId) payload.paymentId = o.paymentId
    if (o.token) payload._followUpIdempotencyKey = o.token
    const r = await db.accountingSyncLog.create({
      data: {
        connector: 'xero', type, status: o.status ?? 'PENDING', referenceType: type === 'BILL_PAYMENT' ? 'PurchaseInvoice' : 'SalesOrder', referenceId: o.ref ?? `${RUN_ID}-${randomUUID().slice(0, 6)}`,
        payload: payload as never,
        attemptStampingCustodyAt: o.custody === false ? null : new Date(),
        remoteAttemptedAt: o.attempted ? new Date() : null,
        settlementBasis: o.basis ?? null,
      },
      select: { id: true, payload: true },
    })
    created.push(r.id)
    return { id: r.id, payload: r.payload as Record<string, unknown>, type }
  }
  const resolve = (r: { id: string; payload: Record<string, unknown>; type: 'BILL_PAYMENT' | 'INVOICE_PAYMENT' }) =>
    proc.resolveXeroMoneyPostIdempotencyKey(db as never, { entryId: r.id, type: r.type, payload: r.payload, operation: r.type === 'BILL_PAYMENT' ? 'bill-payment' : 'invoice-payment' })
  const stored = async (id: string) => ((await db.accountingSyncLog.findUniqueOrThrow({ where: { id }, select: { payload: true } })).payload as Record<string, unknown>)[MONEY_POST_KEY_FIELD]

  await t.test('1. a never-attempted row gets the derived key, stored; later calls return the stored key', async () => {
    const r = await row({ invoice: `${RUN_ID}-b1` })
    const key = await resolve(r)
    assert.match(key, /^ims-bill-payment-doc-[0-9a-f]{64}$/)
    assert.equal(await stored(r.id), key)
    assert.equal(await resolve(r), key)
  })

  await t.test('2. two fresh rows of one settlement share a key; concurrent resolutions of one row agree', async () => {
    const a = await row({ invoice: `${RUN_ID}-b2`, token: 'followup:A' })
    const b = await row({ invoice: `${RUN_ID}-b2`, token: 'followup:B' })
    const [ka, kb] = await Promise.all([resolve(a), resolve(b)])
    assert.equal(ka, kb)
    const c = await row({ invoice: `${RUN_ID}-b2c` })
    const keys = await Promise.all(Array.from({ length: 6 }, () => resolve(c)))
    assert.equal(new Set(keys).size, 1)
    assert.equal(await stored(c.id), keys[0])
  })

  await t.test('3. mixed version: an attempted row, or one no stamping build vouches for, keeps the legacy key; a fresh row gets the derived one', async () => {
    const attempted = await row({ invoice: `${RUN_ID}-b3`, attempted: true })
    const legacy = proc.buildXeroIdempotencyKey(attempted.id, 'bill-payment')
    assert.equal(await resolve(attempted), legacy)
    assert.equal(await stored(attempted.id), legacy, 'and it is written down')
    const unvouched = await row({ invoice: `${RUN_ID}-b3u`, custody: false })
    assert.equal(await resolve(unvouched), proc.buildXeroIdempotencyKey(unvouched.id, 'bill-payment'))
    const tokened = await row({ invoice: `${RUN_ID}-b3t`, attempted: true, token: 'followup:tok' })
    assert.equal(await resolve(tokened), proc.buildXeroIdempotencyKey('followup:tok', 'bill-payment'))
    const fresh = await row({ invoice: `${RUN_ID}-b3f` })
    assert.notEqual(await resolve(fresh), proc.buildXeroIdempotencyKey(fresh.id, 'bill-payment'))
  })

  await t.test('4. a stored key wins, even after a reversal appears', async () => {
    const invoice = `${RUN_ID}-b4`
    const r = await row({ invoice })
    const key = await resolve(r)
    await row({ invoice, status: 'CANCELLED', basis: 'VERIFIED_REVERSAL', attempted: true })
    assert.equal(await resolve(r), key)
  })

  await t.test('5. repay after a proven reversal is a new key; its retries share it; unrelated reversals change nothing', async () => {
    const invoice = `${RUN_ID}-b5`
    const first = await row({ invoice })
    const k0 = await resolve(first)
    await row({ invoice: `${RUN_ID}-other`, status: 'CANCELLED', basis: 'VERIFIED_REVERSAL', attempted: true })
    await row({ invoice, status: 'CANCELLED', basis: 'OPERATOR_ASSERTION', attempted: true })
    const sameEpisode = await row({ invoice })
    assert.equal(await resolve(sameEpisode), k0, 'neither another bill\'s reversal nor a non-verified cancellation starts an episode')
    await row({ invoice, status: 'CANCELLED', basis: 'VERIFIED_REVERSAL', attempted: true })
    const repay = await row({ invoice })
    const k1 = await resolve(repay)
    assert.notEqual(k1, k0)
    assert.equal(await resolve(repay), k1)
    const retryRow = await row({ invoice })
    assert.equal(await resolve(retryRow), k1, 'a replacement row of the repayment resolves the repayment\'s key')
  })

  await t.test('6. invoice payment: another receipt\'s reversal is not this receipt\'s episode', async () => {
    const invoice = `${RUN_ID}-i6`
    const mine = await row({ type: 'INVOICE_PAYMENT', invoice, paymentId: 'PAY-MINE', amount: 50 })
    const k0 = await resolve(mine)
    await row({ type: 'INVOICE_PAYMENT', invoice, paymentId: 'PAY-OTHER', amount: 50, status: 'CANCELLED', basis: 'VERIFIED_REVERSAL', attempted: true })
    assert.equal(await resolve(await row({ type: 'INVOICE_PAYMENT', invoice, paymentId: 'PAY-MINE', amount: 50 })), k0)
    await row({ type: 'INVOICE_PAYMENT', invoice, paymentId: 'PAY-MINE', amount: 50, status: 'CANCELLED', basis: 'VERIFIED_REVERSAL', attempted: true })
    assert.notEqual(await resolve(await row({ type: 'INVOICE_PAYMENT', invoice, paymentId: 'PAY-MINE', amount: 50 })), k0)
  })
})
