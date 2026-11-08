import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * THE FOLLOW-UP CHAIN AGAINST A REAL DATABASE, THROUGH THE REAL ENQUEUE CODE.
 *
 * The invoice note is raised from the INVOICE_PDF row, which is raised from the posted sales invoice; the bill attachment is raised from the
 * posted purchase invoice. Each follow-up payload carries a `sourceEntryId` and no date of its own, so under the producer-side hold it must
 * inherit the dated ancestor's business-event time (XERO_OBLIGATION_SOURCES). This drives enqueueFollowUpSyncLog itself, with the hold enforced
 * for Xero and WooCommerce and both granted, and reads back what each follow-up became: a live queued row, or a shadow.
 * GATED on RUN_DB_RETENTION_TESTS (npm run test:db).
 *
 * Named mutations (shown red in the PR): a  the walk stops at the INVOICE_PDF row (its payload has no date): the note arm goes red;
 * b  the verdict falls back to the follow-up's own payload date: the broken-chain arm goes red.
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'

if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1: tests/db/xero-obligation-chain.test.ts would have been skipped.')
}

const TENANT = '4f7f0c6e-1111-4222-8333-944455556666'
const SHOP = 'https://shop.example.test'
const ENV_KEYS = ['PRODUCER_HOLD_ENFORCED_DESTINATIONS', 'XERO_WRITE_ALLOWED_TENANT', 'XERO_WRITES_LIVE_FROM', 'WC_WRITEBACK_ALLOWED_ORIGIN', 'WC_WRITES_LIVE_FROM']
const LIVE_ENV = {
  PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'xero,woocommerce',
  XERO_WRITE_ALLOWED_TENANT: TENANT,
  XERO_WRITES_LIVE_FROM: '2026-01-01T00:00:00Z',
  WC_WRITEBACK_ALLOWED_ORIGIN: SHOP,
  WC_WRITES_LIVE_FROM: '2026-01-01T00:00:00Z',
}
const SETTINGS = [['plugin_xero_enabled', 'true'], ['xero_sync_enabled', 'true']] as const

async function deps() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const [{ db }, processor, { createAccountingSyncLogRow }] = await Promise.all([
    import('../../lib/db/index.ts'),
    import('../../lib/connectors/xero/sync-processor.ts'),
    import('../../lib/domain/accounting/sync-log-row.ts'),
  ])
  return { db, enqueueFollowUpSyncLog: processor.enqueueFollowUpSyncLog, createAccountingSyncLogRow }
}

async function withEnv<T>(values: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const)
  for (const key of ENV_KEYS) delete process.env[key]
  Object.assign(process.env, values)
  try { return await fn() } finally {
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
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

async function cleanup(db: Awaited<ReturnType<typeof deps>>['db'], referenceId: string): Promise<void> {
  const rows = await db.accountingSyncLog.findMany({ where: { referenceId }, select: { id: true } })
  for (const row of rows) await db.integrationOutbox.deleteMany({ where: { idempotencyKey: { contains: row.id } } }).catch(() => undefined)
  await db.accountingEvent.deleteMany({ where: { sourceEntityId: referenceId } }).catch(() => undefined)
  await db.outboundShadowWrite.deleteMany({ where: { subjectId: referenceId } })
  await db.accountingSyncLog.deleteMany({ where: { referenceId } })
}

type D = Awaited<ReturnType<typeof deps>>

/** A posted parent row, created through the primitive with the hold OFF (the state it was queued in before enforcement). */
async function postedParent(d: D, type: 'SALES_INVOICE' | 'PURCHASE_INVOICE', referenceType: string, referenceId: string, date: string | undefined) {
  const payload = date === undefined ? {} : { date, contactName: 'Probe' }
  const created = await withEnv({}, () => d.db.$transaction((tx) => d.createAccountingSyncLogRow(tx, {
    connector: 'xero', type, status: 'SYNCED', referenceType, referenceId, payload, externalTransactionId: `ext-${randomUUID()}`, syncedAt: new Date(),
  }), { timeout: 60_000, maxWait: 30_000 }))
  assert.ok(created.row, 'precondition: the parent row exists')
  return { id: created.row!.id, payload }
}

test('WC_INVOICE_NOTE, raised from the real INVOICE_PDF row, inherits the SALES_INVOICE date; BILL_ATTACHMENT inherits the PURCHASE_INVOICE date; a broken chain shadows whatever the follow-up payload says', { skip }, async (t) => {
  const d = await deps()
  const ref = `OBLCHAIN-${randomUUID()}`
  const refs = { liveSales: `${ref}-ls`, earlySales: `${ref}-es`, liveBill: `${ref}-lb`, earlyBill: `${ref}-eb`, broken: `${ref}-br` }
  t.after(async () => { for (const r of Object.values(refs)) await cleanup(d.db, r) })
  await withSettings(d.db, async () => {
    const origin = (payload: unknown) => ({ from: 'postedRow' as const, record: { payload, connectionProvenance: null } })

    // Sales: SALES_INVOICE (dated) -> INVOICE_PDF (no date, sourceEntryId = the invoice row) -> WC_INVOICE_NOTE (no date, sourceEntryId = the PDF row).
    for (const [referenceId, date, expected] of [[refs.liveSales, '2026-05-30', 'live'], [refs.earlySales, '2025-12-31', 'shadow']] as const) {
      const invoice = await postedParent(d, 'SALES_INVOICE', 'SalesOrder', referenceId, date)
      await withEnv(LIVE_ENV, async () => {
        const pdf = await d.enqueueFollowUpSyncLog('INVOICE_PDF', 'SalesOrder', referenceId, { accountingInvoiceId: 'xero-inv', referenceId, invoiceNumber: 'INV-1', sourceEntryId: invoice.id }, origin(invoice.payload))
        assert.ok(pdf, 'the PDF follow-up was enqueued (it is not a write, so the hold never asks)')
        const pdfRow = await d.db.accountingSyncLog.findFirst({ where: { referenceId, type: 'INVOICE_PDF' }, select: { id: true, payload: true } })
        assert.ok(pdfRow, 'precondition: the real enqueue code created the INVOICE_PDF row')
        assert.equal((pdfRow!.payload as Record<string, unknown>).sourceEntryId, invoice.id)
        assert.equal((pdfRow!.payload as Record<string, unknown>).date, undefined, 'precondition: the PDF payload has no date of its own')
        await d.enqueueFollowUpSyncLog('WC_INVOICE_NOTE', 'SalesOrder', referenceId, { referenceId, sourceEntryId: pdfRow!.id }, origin(pdfRow!.payload))
      })
      const note = await d.db.accountingSyncLog.findFirst({ where: { referenceId, type: 'WC_INVOICE_NOTE' }, select: { status: true, settlementBasis: true } })
      console.log(`# note for invoice dated ${date}: ${JSON.stringify(note)}`)
      assert.ok(note, `${referenceId}: a note row or its shadow exists`)
      // MUTATION a: the walk stops at the INVOICE_PDF row => no date => the live arm is a shadow => red.
      if (expected === 'live') assert.equal(note!.status, 'PENDING', 'the note of a post-cutoff invoice is queued')
      else assert.deepEqual([note!.status, note!.settlementBasis], ['CANCELLED', 'HELD_SHADOW'], 'the note of a pre-cutoff invoice is a shadow')
    }

    // Purchases: PURCHASE_INVOICE (dated) -> BILL_ATTACHMENT.
    for (const [referenceId, date, expected] of [[refs.liveBill, '2026-05-30', 'live'], [refs.earlyBill, '2025-12-31', 'shadow']] as const) {
      const bill = await postedParent(d, 'PURCHASE_INVOICE', 'PurchaseInvoice', referenceId, date)
      await withEnv(LIVE_ENV, () => d.enqueueFollowUpSyncLog('BILL_ATTACHMENT', 'PurchaseInvoice', referenceId, { accountingInvoiceId: 'xero-bill', supplierInvoicePath: '/uploads/x.pdf', sourceEntryId: bill.id }, origin(bill.payload)))
      const attachment = await d.db.accountingSyncLog.findFirst({ where: { referenceId, type: 'BILL_ATTACHMENT' }, select: { status: true, settlementBasis: true } })
      assert.ok(attachment, `${referenceId}: an attachment row or its shadow exists`)
      if (expected === 'live') assert.equal(attachment!.status, 'PENDING')
      else assert.deepEqual([attachment!.status, attachment!.settlementBasis], ['CANCELLED', 'HELD_SHADOW'])
    }

    // A broken chain (the named source does not exist) is a shadow even though the follow-up's own payload carries a post-cutoff date.
    // MUTATION b: fall back to the follow-up's own date => PENDING => red.
    await withEnv(LIVE_ENV, () => d.enqueueFollowUpSyncLog('BILL_ATTACHMENT', 'PurchaseInvoice', refs.broken, { accountingInvoiceId: 'xero-bill', supplierInvoicePath: '/uploads/x.pdf', date: '2026-05-31', sourceEntryId: `missing-${randomUUID()}` }, origin({})))
    const broken = await d.db.accountingSyncLog.findFirst({ where: { referenceId: refs.broken, type: 'BILL_ATTACHMENT' }, select: { status: true, settlementBasis: true } })
    assert.ok(broken)
    assert.deepEqual([broken!.status, broken!.settlementBasis], ['CANCELLED', 'HELD_SHADOW'])
  })
})
