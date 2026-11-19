import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

/**
 * AN INVOICE NOTE QUEUED WHILE THE SWITCH WAS ON, SENT AFTER IT WAS TURNED OFF: a clean terminal outcome (skipped, nothing sent, one operator notice),
 * never a failure that retries until FAILED. The storefront is a recorder that must never be called.
 * GATED on RUN_DB_RETENTION_TESTS with the REQUIRE_DB_RETENTION_TESTS tripwire (npm run test:db).
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'

if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1, so every test in tests/db/wc-invoice-note-switched-off.test.ts would have been skipped. Fix the invocation (npm run test:db).')
}

const wcCalls: string[] = []
mock.module('@/lib/connectors/woocommerce/api', {
  namedExports: {
    wcFetch: async (path: string) => { wcCalls.push(path); return { data: [] } },
    wcPost: async (path: string) => { wcCalls.push(path); return { ok: true } },
    wcPut: async (path: string) => { wcCalls.push(path); return { ok: true } },
  },
})
mock.module('@/lib/connectors/woocommerce/sync/invoice-note-switch', {
  namedExports: { isInvoiceNoteEnabled: async () => false, WC_INVOICE_NOTE_ENABLED_SETTING: 'wc_invoice_note_enabled' },
})

test('[db] a note queued before the switch went off ends SKIPPED (success + skipped), sends nothing, and leaves one operator notice', { skip }, async (t) => {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const { db } = await import('@/lib/db')
  const { pushInvoiceNoteToWc } = await import('@/lib/connectors/woocommerce/sync/invoice-note')
  const order = await db.salesOrder.create({ data: { orderNumber: `INS${randomUUID().slice(0, 8)}`, status: 'PROCESSING', currency: 'GBP', subtotalForeign: 1, totalForeign: 1, subtotalBase: 1, totalBase: 1 }, select: { id: true } })
  t.after(async () => { await db.activityLog.deleteMany({ where: { entityId: order.id } }); await db.salesOrder.delete({ where: { id: order.id } }) })
  const result = await pushInvoiceNoteToWc(order.id)
  assert.deepEqual(result, { success: true, skipped: 'switched-off' })
  assert.deepEqual(wcCalls, [], 'nothing was sent to the storefront')
  assert.equal(await db.activityLog.count({ where: { entityId: order.id, action: 'wc_invoice_note_skipped_switched_off', level: 'WARNING' } }), 1)
})
