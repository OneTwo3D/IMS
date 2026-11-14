import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  heldOrderInvoiceObligation,
  type HeldOrderInvoiceObligationClient,
} from '../../lib/connectors/woocommerce/sync/held-order-invoice-obligation.ts'

/**
 * The first import OWES a sales invoice (`SalesOrder.salesInvoiceOwedAt`) from the transaction that commits the order until the transaction that queues the invoice, or parks it
 * as a held invoice, clears it. A redelivery takes the existing-order branch, which must not read as success while the mark is set and nothing stands for the invoice, however
 * the first attempt failed (enqueue, park and failure log all failing leaves no marker at all, only this mark). The importer cannot be driven end to end here, so the check is
 * tested on its own and its wiring is asserted at the source. The release of a parked invoice is covered by wc-held-release-sweep.test.ts.
 */

type Row = { id: string }
type State = { owed: boolean; held: boolean; ledger: boolean; cleared: number }
function client(state: State): HeldOrderInvoiceObligationClient & { asked: object[] } {
  const asked: object[] = []
  return {
    asked,
    salesOrder: {
      findUnique: async () => ({ salesInvoiceOwedAt: state.owed ? new Date() : null }),
      updateMany: async () => { state.cleared += 1; state.owed = false; return { count: 1 } },
    },
    shoppingSyncLog: { findFirst: async ({ where }): Promise<Row | null> => { asked.push(where); return state.held ? { id: 'held-row' } : null } },
    accountingSyncLog: { findFirst: async ({ where }): Promise<Row | null> => { asked.push(where); return state.ledger ? { id: 'ledger-row' } : null } },
  }
}
const order = { orderId: 'so-1' }

test('nothing owed (every order imported before the column, and orders that are not invoiced): the redelivery is handled as before', async () => {
  const state = { owed: false, held: false, ledger: false, cleared: 0 }
  assert.equal(await heldOrderInvoiceObligation(client(state), order), 'met')
  assert.equal(state.cleared, 0)
})

test('owed with a HELD invoice standing (the park succeeded): met, and the mark is cleared', async () => {
  const state = { owed: true, held: true, ledger: false, cleared: 0 }
  assert.equal(await heldOrderInvoiceObligation(client(state), order), 'met')
  assert.equal(state.cleared, 1)
})

test('owed with a SALES_INVOICE row in ANY status: met, the lookup carries no status filter, and nothing is queued from here', async () => {
  const state = { owed: true, held: false, ledger: true, cleared: 0 }
  const c = client(state)
  assert.equal(await heldOrderInvoiceObligation(c, order), 'met')
  const ledgerQuery = c.asked.find((where) => (where as { type?: string }).type === 'SALES_INVOICE') as Record<string, unknown>
  assert.ok(ledgerQuery)
  assert.equal('status' in ledgerQuery, false, 'in any status: an attempt that exists is never replaced')
})

test('enqueue, park and failure log all failed (only the owed mark remains): every redelivery is UNMET and clears nothing; once a later attempt creates a held invoice it is met', async () => {
  const state = { owed: true, held: false, ledger: false, cleared: 0 }
  const c = client(state)
  assert.equal(await heldOrderInvoiceObligation(c, order), 'unmet')
  assert.equal(await heldOrderInvoiceObligation(c, order), 'unmet', 'and again: it does not clear itself')
  assert.equal(state.cleared, 0)
  state.held = true
  assert.equal(await heldOrderInvoiceObligation(c, order), 'met')
  assert.equal(state.cleared, 1)
  assert.equal(await heldOrderInvoiceObligation(c, order), 'met')
})

test('the importer wires it: park the built payload and fail on an enqueue failure; a redelivery checks the obligation before marking the retry row synced', () => {
  const src = readFileSync('lib/connectors/woocommerce/sync/order-import.ts', 'utf8')
  // the enqueue's catch parks the SAME payload the held branch would park, then throws into the failure handling
  assert.ok(src.includes('const parkedPayload: Record<string, unknown> = withRegimePolicy('), 'one shared parked payload')
  assert.ok(src.includes('accountingPayload: parkedPayload,'), 'the hold and the retry park use it')
  const catchAt = src.indexOf("action: 'sales_invoice_accounting_queue_failed'")
  const catchBlock = src.slice(catchAt, src.indexOf('\n    }\n', catchAt))
  assert.ok(catchBlock.includes('await parkForRetry()'), 'the catch parks the invoice')
  assert.ok(catchBlock.includes('throw new Error('), 'and still fails the import')
  // the existing-order branch checks the obligation BEFORE marking the pending row synced
  const update = src.slice(src.indexOf('const updateHeldOrder = async'), src.indexOf('// THE SINGLE PIVOT'))
  const check = update.indexOf('heldOrderInvoiceObligation(')
  const synced = update.indexOf('markPendingFxRetryLogSynced(')
  assert.ok(check > 0 && synced > check, 'the obligation is checked before the retry row can be marked synced')
  assert.ok(!/queueAccountingSync/.test(update), 'the existing-order branch never queues an invoice itself')
  // the owed mark: set in the order create, cleared in the enqueue transaction and in the park transaction
  assert.ok(src.includes("...(imsStatus === 'PROCESSING' && !options.skipAccounting ? { salesInvoiceOwedAt: new Date() } : {}),"), 'set with the order create, on the enqueue predicate')
  const enqueueTx = src.slice(src.indexOf('const queued = await queueAccountingSyncTxWithOutcome(tx, {'), src.indexOf('return queued'))
  assert.ok(enqueueTx.includes('data: { salesInvoiceOwedAt: null }'), 'cleared in the same transaction as the enqueue')
  const park = src.slice(src.indexOf('async function holdWcSalesInvoiceForMissingNumber('), src.indexOf('Queue the sales invoice that was held back'))
  assert.ok(park.includes('salesInvoiceOwedAt: null'), 'cleared in the park transaction')
})
