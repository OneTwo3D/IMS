import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  SALES_INVOICE_QUEUE_FAILED_NOT_HELD,
  heldOrderInvoiceObligation,
  type HeldOrderInvoiceObligationClient,
} from '../../lib/connectors/woocommerce/sync/held-order-invoice-obligation.ts'

/**
 * An import whose sales invoice enqueue threw parks the payload it built as a held sales invoice (the reconcile's release sweep enqueues it: the existing release tests in
 * wc-held-release-sweep.test.ts cover the release itself, with the (order, number) idempotency key and the ledger-row confirmation) and fails. A redelivery of the order takes the
 * existing-order branch, which must not read as success while a failure is on record and nothing stands for the invoice. The importer cannot be driven end to end here, so the
 * obligation check is tested on its own and its wiring is asserted at the source.
 */

type Row = { id: string }
function client(state: { marker: boolean; held: boolean; ledger: boolean }): HeldOrderInvoiceObligationClient & { asked: object[] } {
  const asked: object[] = []
  return {
    asked,
    shoppingSyncLog: {
      findFirst: async ({ where }): Promise<Row | null> => {
        asked.push(where)
        const w = where as { errorMessage?: unknown; recordKind?: unknown }
        if (w.errorMessage) return state.marker ? { id: 'failed-row' } : null
        return state.held ? { id: 'held-row' } : null
      },
    },
    accountingSyncLog: {
      findFirst: async ({ where }): Promise<Row | null> => {
        asked.push(where)
        return state.ledger ? { id: 'ledger-row' } : null
      },
    },
  }
}
const order = { orderId: 'so-1', wcOrderId: 4242 }

test('no enqueue failure on record: the redelivery is handled as before', async () => {
  assert.equal(await heldOrderInvoiceObligation(client({ marker: false, held: false, ledger: false }), order), 'met')
})

test('a failure with the invoice HELD (the normal case: released by the next reconcile) is met, so the retry row can be marked synced', async () => {
  assert.equal(await heldOrderInvoiceObligation(client({ marker: true, held: true, ledger: false }), order), 'met')
})

test('a failure and a SALES_INVOICE row in ANY status is met, and nothing is re-queued from here (the check never queues)', async () => {
  const c = client({ marker: true, held: false, ledger: true })
  assert.equal(await heldOrderInvoiceObligation(c, order), 'met')
  const ledgerQuery = c.asked.find((where) => (where as { type?: string }).type === 'SALES_INVOICE') as Record<string, unknown>
  assert.ok(ledgerQuery, 'the ledger row is looked up')
  assert.equal('status' in ledgerQuery, false, 'in any status: an attempt that exists is never replaced')
})

test('a failure that could not even be held, with no held invoice and no ledger row, is UNMET: the redelivery fails and the retry row is not marked synced', async () => {
  assert.equal(await heldOrderInvoiceObligation(client({ marker: true, held: false, ledger: false }), order), 'unmet')
})

test('the importer wires it: park the built payload and fail on an enqueue failure; a redelivery checks the obligation before marking the retry row synced', () => {
  const src = readFileSync('lib/connectors/woocommerce/sync/order-import.ts', 'utf8')
  // the enqueue's catch parks the SAME payload the held branch would park, then throws into the failure handling
  assert.ok(src.includes('const parkedPayload: Record<string, unknown> = withRegimePolicy('), 'one shared parked payload')
  assert.ok(src.includes('accountingPayload: parkedPayload,'), 'the hold and the retry park use it')
  const catchAt = src.indexOf("action: 'sales_invoice_accounting_queue_failed'")
  const catchBlock = src.slice(catchAt, src.indexOf('\n    }\n', catchAt))
  assert.ok(catchBlock.includes('await parkForRetry()'), 'the catch parks the invoice')
  assert.ok(catchBlock.includes('SALES_INVOICE_QUEUE_FAILED_NOT_HELD'), 'and marks the failure when even the park failed')
  assert.ok(catchBlock.includes('throw new Error('), 'and still fails the import')
  // the existing-order branch checks the obligation BEFORE marking the pending row synced
  const update = src.slice(src.indexOf('const updateHeldOrder = async'), src.indexOf('// THE SINGLE PIVOT'))
  const check = update.indexOf('heldOrderInvoiceObligation(')
  const synced = update.indexOf('markPendingFxRetryLogSynced(')
  assert.ok(check > 0 && synced > check, 'the obligation is checked before the retry row can be marked synced')
  assert.ok(!/queueAccountingSync/.test(update), 'the existing-order branch never queues an invoice itself')
  assert.ok(SALES_INVOICE_QUEUE_FAILED_NOT_HELD.length > 10)
})
