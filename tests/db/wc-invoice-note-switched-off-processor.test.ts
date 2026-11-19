import '../helpers/xero-attested.ts'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

/**
 * A WC_INVOICE_NOTE ROW WHOSE SWITCH WAS TURNED OFF AFTER IT WAS QUEUED IS SETTLED BY THE PROCESSOR, not merely skipped by the writer.
 *
 * `skipped` from the handler means the row is already terminal. The writer used to return it without retiring the row, so the row stayed PROCESSING, was re-taken
 * after the stale window, wrote another WARNING each time, and sent the note late once the switch came back on. Driven through the REAL drains (the outbox runner and
 * the direct runner) over a real database; only the WooCommerce transport and the switch are mocked. GATED on RUN_DB_RETENTION_TESTS (npm run test:db).
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'
if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1: tests/db/wc-invoice-note-switched-off-processor.test.ts would have been skipped.')
}

const wcCalls: string[] = []
let switchOn = false
mock.module('@/lib/connectors/woocommerce/api', {
  namedExports: {
    wcFetch: async (path: string) => { wcCalls.push(path); return { data: [], totalPages: 1 } },
    wcPost: async (path: string) => { wcCalls.push(path); return { data: { id: 1 } } },
    wcPut: async (path: string) => { wcCalls.push(path); return { data: {} } },
  },
})
mock.module('@/lib/connectors/woocommerce/sync/invoice-note-switch', {
  namedExports: { isInvoiceNoteEnabled: async () => switchOn, WC_INVOICE_NOTE_ENABLED_SETTING: 'wc_invoice_note_enabled' },
})


async function load() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const [{ db }, processor] = await Promise.all([
    import('../../lib/db/index.ts'),
    import('../../lib/connectors/xero/sync-processor.ts'),
  ])
  return { db, processor }
}

for (const runner of ['outbox', 'direct'] as const) {
  test(`[db] ${runner} runner: a WC_INVOICE_NOTE queued before the switch went off ends terminal after ONE pass, is not re-claimed after the stale window, writes ONE warning, and does not come back when the switch is turned on`, { skip }, async (t) => {
    const { db, processor } = await load()
    const saved = process.env.XERO_ACCOUNTING_OUTBOX_ENABLED
    process.env.XERO_ACCOUNTING_OUTBOX_ENABLED = runner === 'outbox' ? 'true' : 'false'
    const tag = `wnp${randomUUID().slice(0, 8)}`
    const order = await db.salesOrder.create({ data: { orderNumber: tag, status: 'PROCESSING', currency: 'GBP', subtotalForeign: 1, totalForeign: 1, subtotalBase: 1, totalBase: 1 }, select: { id: true } })
    const row = await db.accountingSyncLog.create({
      data: { connector: 'xero', type: 'WC_INVOICE_NOTE', status: 'PENDING', referenceType: 'SalesOrder', referenceId: order.id, payload: { referenceId: order.id }, attemptStampingCustodyAt: new Date() } as never,
      select: { id: true },
    })
    t.after(async () => {
      if (saved === undefined) delete process.env.XERO_ACCOUNTING_OUTBOX_ENABLED; else process.env.XERO_ACCOUNTING_OUTBOX_ENABLED = saved
      await db.integrationOutbox.deleteMany({ where: { idempotencyKey: { contains: row.id } } }).catch(() => undefined)
      await db.activityLog.deleteMany({ where: { entityId: order.id } })
      await db.accountingSyncLog.deleteMany({ where: { id: row.id } })
      await db.salesOrder.delete({ where: { id: order.id } })
    })
    wcCalls.length = 0
    switchOn = false
    const state = () => db.accountingSyncLog.findUniqueOrThrow({ where: { id: row.id }, select: { status: true, processingStartedAt: true, retryCount: true, errorMessage: true } })
    const warnings = () => db.activityLog.count({ where: { entityId: order.id, action: 'wc_invoice_note_skipped_switched_off', level: 'WARNING' } })

    await processor.processPendingXeroSync()
    const after = await state()
    assert.equal(after.status, 'CANCELLED', 'terminal after one pass')
    assert.equal(after.processingStartedAt, null, 'not left claimed')
    assert.match(after.errorMessage ?? '', /switch is off/)
    assert.equal(await warnings(), 1)

    // The stale window passes: nothing re-takes a terminal row. (Both clocks the selectors use are pushed back.)
    const longAgo = new Date(Date.now() - 24 * 3_600_000)
    // (A row left PROCESSING would now look abandoned and be re-taken; a terminal row matches nothing here.)
    await db.accountingSyncLog.updateMany({ where: { id: row.id, status: 'PROCESSING' }, data: { processingStartedAt: longAgo } })
    await db.integrationOutbox.updateMany({ where: { idempotencyKey: { contains: row.id } }, data: { nextAttemptAt: longAgo, lockedAt: null } }).catch(() => undefined)
    await processor.processPendingXeroSync()
    await processor.processPendingXeroSync()
    assert.equal((await state()).status, 'CANCELLED')
    assert.equal(await warnings(), 1, 'a single warning, not one per pass')

    // Turning the switch on again does NOT resurrect it.
    switchOn = true
    await processor.processPendingXeroSync()
    assert.equal((await state()).status, 'CANCELLED')
    assert.deepEqual(wcCalls, [], 'no note was ever sent to the storefront')
    assert.equal(await warnings(), 1)
  })
}
