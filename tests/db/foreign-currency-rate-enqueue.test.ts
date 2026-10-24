import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * o3d-q0x56.2 / .3 AGAINST A REAL DATABASE: A FOREIGN POSTING WITHOUT AN IMS RATE IS NEVER QUEUED, AND IMS QUEUES NO REALISED-FX JOURNAL FOR XERO.
 *
 * Drives the REAL enqueue entry points (the facade `queueAccountingSync` and the in-transaction `queueAccountingSyncTxWithOutcome`) with the base
 * currency GBP, and reads back the sync rows and the exception-inbox rows each call leaves. Fixtures are unique per run and removed afterwards.
 * GATED on RUN_DB_RETENTION_TESTS (npm run test:db).
 *
 * Named mutations (each shown red, restored from a copy, md5-verified):
 *  a  tx-guard-removed          the foreign-rate refusal in queueAccountingSyncTx is deleted: the Tx arms go red
 *  b  facade-guard-removed      the same in queueAccountingSync: the facade arms go red
 *  c  payment-types-unguarded   INVOICE_PAYMENT / BILL_PAYMENT dropped from the guard's type set: the payment arms go red
 *  d  fx-suppression-removed    isFxGainLossJournalSuppressed returns false for REALISED_FX_JOURNAL: the "no realised-FX journal" arms go red
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'

if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1: tests/db/foreign-currency-rate-enqueue.test.ts would have been skipped.')
}

const SETTINGS = [['plugin_xero_enabled', 'true'], ['xero_sync_enabled', 'true']] as const

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any

async function deps() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const [{ db }, accounting] = await Promise.all([import('../../lib/db/index.ts'), import('../../lib/accounting.ts')])
  return { db, accounting }
}

async function withSettings<T>(db: Awaited<ReturnType<typeof deps>>['db'], fn: () => Promise<T>): Promise<T> {
  const before = await db.setting.findMany({ where: { key: { in: SETTINGS.map(([key]) => key) } } })
  for (const [key, value] of SETTINGS) await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
  try { return await fn() } finally {
    for (const [key] of SETTINGS) {
      const prior = before.find((row: { key: string }) => row.key === key)
      if (prior) await db.setting.update({ where: { key }, data: { value: prior.value } })
      else await db.setting.deleteMany({ where: { key } })
    }
  }
}

async function readBack(db: Awaited<ReturnType<typeof deps>>['db'], referenceId: string) {
  const rows = await db.accountingSyncLog.findMany({ where: { referenceId }, select: { id: true, status: true, type: true, payload: true } })
  const inbox = await db.accountingPostingRefusal.findMany({ where: { referenceId }, select: { type: true, reason: true, remedy: true, resolvedAt: true, refusedCount: true } })
  return { rows, inbox }
}

async function cleanup(db: Awaited<ReturnType<typeof deps>>['db'], referenceIds: string[]): Promise<void> {
  for (const referenceId of referenceIds) {
    const rows = await db.accountingSyncLog.findMany({ where: { referenceId }, select: { id: true } })
    for (const row of rows) await db.integrationOutbox.deleteMany({ where: { idempotencyKey: { contains: row.id } } }).catch(() => undefined)
    await db.accountingEvent.deleteMany({ where: { sourceEntityId: referenceId } }).catch(() => undefined)
    await db.accountingPostingRefusal.deleteMany({ where: { referenceId } })
    await db.accountingSyncLog.deleteMany({ where: { referenceId } })
  }
}

const bill = (extra: Record<string, unknown>) => ({
  contactName: 'Supplier', date: '2026-06-01', reference: 'PO-1',
  lines: [{ description: 'Goods', quantity: 1, unitAmount: 10, accountCode: '630' }],
  ...extra,
})
const billPayment = (extra: Record<string, unknown>) => ({
  accountingInvoiceId: 'XERO-BILL-1', bankAccountId: 'BANK-1', paymentDate: '2026-06-02', amount: 10, ...extra,
})

type Case = { label: string; type: 'PURCHASE_INVOICE' | 'BILL_PAYMENT'; payload: Record<string, unknown>; expectQueued: boolean }

const CASES: Case[] = [
  // documents
  { label: 'foreign bill, rate missing', type: 'PURCHASE_INVOICE', payload: bill({ currency: 'EUR' }), expectQueued: false },
  { label: 'foreign bill, rate zero', type: 'PURCHASE_INVOICE', payload: bill({ currency: 'EUR', currencyRateToBase: 0 }), expectQueued: false },
  { label: 'foreign bill, rate negative', type: 'PURCHASE_INVOICE', payload: bill({ currency: 'EUR', currencyRateToBase: -1.17 }), expectQueued: false },
  { label: 'foreign bill, rate NaN', type: 'PURCHASE_INVOICE', payload: bill({ currency: 'EUR', currencyRateToBase: Number.NaN }), expectQueued: false },
  { label: 'foreign bill, rate Infinity', type: 'PURCHASE_INVOICE', payload: bill({ currency: 'EUR', currencyRateToBase: Number.POSITIVE_INFINITY }), expectQueued: false },
  { label: 'foreign bill, rate a boolean', type: 'PURCHASE_INVOICE', payload: bill({ currency: 'EUR', currencyRateToBase: true }), expectQueued: false },
  { label: 'foreign bill, lower-case currency code, rate missing', type: 'PURCHASE_INVOICE', payload: bill({ currency: ' eur ' }), expectQueued: false },
  { label: 'foreign bill WITH a rate', type: 'PURCHASE_INVOICE', payload: bill({ currency: 'EUR', currencyRateToBase: 1.17 }), expectQueued: true },
  { label: 'base-currency bill, no rate (unchanged)', type: 'PURCHASE_INVOICE', payload: bill({ currency: 'GBP' }), expectQueued: true },
  { label: 'base-currency bill, rate 1 (unchanged)', type: 'PURCHASE_INVOICE', payload: bill({ currency: 'GBP', currencyRateToBase: 1 }), expectQueued: true },
  // payments
  { label: 'foreign bill payment, settlement rate missing', type: 'BILL_PAYMENT', payload: billPayment({ currency: 'EUR' }), expectQueued: false },
  { label: 'foreign bill payment, settlement rate zero', type: 'BILL_PAYMENT', payload: billPayment({ currency: 'EUR', settlementRateToBase: 0 }), expectQueued: false },
  { label: 'foreign bill payment WITH a settlement rate', type: 'BILL_PAYMENT', payload: billPayment({ currency: 'EUR', settlementRateToBase: 1.2 }), expectQueued: true },
  { label: 'base-currency bill payment, no rate (unchanged)', type: 'BILL_PAYMENT', payload: billPayment({ currency: 'GBP' }), expectQueued: true },
  // the document rate is not the payment rate: a payment must carry ITS OWN settlement rate
  { label: 'foreign bill payment carrying only a DOCUMENT rate', type: 'BILL_PAYMENT', payload: billPayment({ currency: 'EUR', currencyRateToBase: 1.17 }), expectQueued: false },
]

const REFERENCE_TYPE = 'PurchaseInvoice'

test('the IN-TRANSACTION enqueue: every foreign posting without a usable IMS rate is refused by name, writes no sync row and leaves an inbox row; the rest queue', { skip }, async (t) => {
  const d = await deps()
  const ids = CASES.map(() => `FXRATE-tx-${randomUUID()}`)
  t.after(() => cleanup(d.db, ids))
  await withSettings(d.db, async () => {
    for (const [index, c] of CASES.entries()) {
      const referenceId = ids[index]!
      let outcome: Awaited<ReturnType<typeof d.accounting.queueAccountingSyncTxWithOutcome>> | null = null
      await d.db.$transaction(async (tx: Tx) => {
        outcome = await d.accounting.queueAccountingSyncTxWithOutcome(tx, {
          type: c.type, referenceType: REFERENCE_TYPE, referenceId, payload: c.payload, chartConnector: 'xero', connector: 'xero', documentConnector: 'xero',
          recordRefusalAsOutstanding: true,
        })
      }, { timeout: 60_000, maxWait: 30_000 })
      const back = await readBack(d.db, referenceId)
      const o = outcome!
      if (c.expectQueued) {
        assert.equal(o.queued, true, `${c.label}: queued`)
        assert.equal(back.rows.length, 1, `${c.label}: one sync row`)
        assert.equal(back.inbox.length, 0, `${c.label}: nothing in the inbox`)
      } else {
        assert.equal(o.queued, false, `${c.label}: not queued`)
        assert.equal(o.reason, 'refused', `${c.label}: refused (owed), not not-configured (settled)`)
        assert.equal(back.rows.length, 0, `${c.label}: NO sync row`)
        assert.equal(back.inbox.length, 1, `${c.label}: exactly one inbox row`)
        assert.equal(back.inbox[0]!.reason, c.type === 'BILL_PAYMENT' ? 'foreign_payment_missing_rate' : 'foreign_document_missing_rate', `${c.label}: named reason`)
        assert.equal(back.inbox[0]!.resolvedAt, null, `${c.label}: outstanding`)
        assert.match(back.inbox[0]!.remedy, /rate/i)
      }
    }
  })
})

test('the FACADE enqueue refuses the same way and records the inbox row; a queued posting later clears it', { skip }, async (t) => {
  const d = await deps()
  const ids = CASES.map(() => `FXRATE-fa-${randomUUID()}`)
  t.after(() => cleanup(d.db, ids))
  await withSettings(d.db, async () => {
    for (const [index, c] of CASES.entries()) {
      const referenceId = ids[index]!
      const o = await d.accounting.queueAccountingSync({
        type: c.type, referenceType: REFERENCE_TYPE, referenceId, payload: c.payload, chartConnector: 'xero', documentConnector: 'xero',
      })
      const back = await readBack(d.db, referenceId)
      if (c.expectQueued) {
        assert.equal(o.queued, true, `${c.label}: queued`)
        assert.equal(back.rows.length, 1, `${c.label}: one sync row`)
        assert.equal(back.inbox.length, 0)
      } else {
        assert.equal(o.queued, false, `${c.label}: not queued`)
        assert.equal(o.reason, 'refused')
        assert.equal(back.rows.length, 0, `${c.label}: NO sync row`)
        assert.equal(back.inbox.length, 1, `${c.label}: exactly one inbox row`)
        assert.equal(back.inbox[0]!.resolvedAt, null)
      }
    }
    // The refusal row CLEARS when the same posting is later queued with a rate.
    const referenceId = ids[0]!
    const refused = CASES[0]!
    assert.equal((await readBack(d.db, referenceId)).inbox[0]!.resolvedAt, null)
    const again = await d.accounting.queueAccountingSync({
      type: refused.type, referenceType: REFERENCE_TYPE, referenceId, payload: { ...refused.payload, currencyRateToBase: 1.17 }, chartConnector: 'xero',
    })
    assert.equal(again.queued, true)
    const after = await readBack(d.db, referenceId)
    assert.equal(after.rows.length, 1)
    assert.ok(after.inbox[0]!.resolvedAt, 'the inbox row is resolved once the posting is queued')
  })
})

test('a foreign posting is NOT refused when the connector would not post that type at all (nothing is owed, so no inbox debt is created)', { skip }, async (t) => {
  const d = await deps()
  const referenceId = `FXRATE-off-${randomUUID()}`
  t.after(() => cleanup(d.db, [referenceId]))
  await withSettings(d.db, async () => {
    await d.db.setting.upsert({ where: { key: 'xero_sync_purchase_invoice' }, create: { key: 'xero_sync_purchase_invoice', value: 'off' }, update: { value: 'off' } })
    try {
      const o = await d.accounting.queueAccountingSync({
        type: 'PURCHASE_INVOICE', referenceType: REFERENCE_TYPE, referenceId, payload: bill({ currency: 'EUR' }), chartConnector: 'xero',
      })
      const back = await readBack(d.db, referenceId)
      assert.equal(o.queued, false)
      assert.equal(o.reason, 'not-configured')
      assert.equal(back.inbox.length, 0)
    } finally {
      await d.db.setting.deleteMany({ where: { key: 'xero_sync_purchase_invoice' } })
    }
  })
})

test('NO realised-FX journal is queued for Xero, by either enqueue, even for a foreign payment with a rate', { skip }, async (t) => {
  const d = await deps()
  const ids = { facade: `FXRATE-fx-f-${randomUUID()}`, tx: `FXRATE-fx-t-${randomUUID()}` }
  t.after(() => cleanup(d.db, Object.values(ids)))
  const journal = {
    date: '2026-06-02', reference: 'SO-1', narration: 'Realised FX', side: 'receivable', currency: 'EUR', settlementRateToBase: 1.2,
    lines: [{ description: 'AR', accountCode: '610', debit: 1 }, { description: 'FX', accountCode: '810', credit: 1 }],
  }
  await withSettings(d.db, async () => {
    const viaFacade = await d.accounting.queueAccountingSync({
      type: 'REALISED_FX_JOURNAL', referenceType: 'Payment', referenceId: ids.facade, payload: journal, chartConnector: 'xero',
    })
    let viaTx: Awaited<ReturnType<typeof d.accounting.queueAccountingSyncTxWithOutcome>> | null = null
    await d.db.$transaction(async (tx: Tx) => {
      viaTx = await d.accounting.queueAccountingSyncTxWithOutcome(tx, {
        type: 'REALISED_FX_JOURNAL', referenceType: 'Payment', referenceId: ids.tx, payload: journal, chartConnector: 'xero',
      })
    })
    assert.equal(viaFacade.queued, false)
    assert.equal(viaFacade.reason, 'not-configured')
    assert.equal(viaTx!.queued, false)
    assert.equal(viaTx!.reason, 'not-configured')
    // 'not-configured' is the answer that means nothing is OWED: the callers' reportPostingNotQueued does not fire, so no inbox debt either.
    const { postingIsOwed } = await import('../../lib/domain/accounting/enqueue-outcome.ts')
    assert.equal(postingIsOwed(viaFacade), false)
    assert.equal(postingIsOwed(viaTx!), false)
    assert.equal((await d.db.accountingPostingRefusal.count({ where: { referenceId: { in: [ids.facade, ids.tx] } } })), 0)
    assert.equal((await readBack(d.db, ids.facade)).rows.length, 0)
    assert.equal((await readBack(d.db, ids.tx)).rows.length, 0)
  })
})
