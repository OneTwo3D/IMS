import assert from 'node:assert/strict'
import test from 'node:test'

import {
  deriveInvoicingState,
  invoicedQuantityOfPayload,
  recomputeInvoicingStateForRow,
  recomputeSalesOrderInvoicingState,
  repairInvoicingStates,
  rowCountsAsInvoice,
  type InvoicingEvidence,
  type InvoicingEvidenceRow,
  type InvoicingState,
} from '@/lib/domain/sales/invoicing-state'
import { HELD_SHADOW_SETTLEMENT_BASIS } from '@/lib/domain/accounting/sync-row-settlement'

/**
 * THE DERIVATION OF SalesOrder.invoicingState, pure (the database-backed write sites are tests/concurrency/invoicing-state.concurrent.test.ts).
 * [mutation: count a FAILED row without a document id, count a shadow, read a CREDIT_NOTE row, or compare against the wrong quantity: red]
 */

const T0 = new Date('2026-11-01T10:00:00Z')
const lines = (...qty: number[]) => ({ lines: qty.map((quantity) => ({ quantity, unitAmount: 1 })) })

function row(over: Partial<InvoicingEvidenceRow> = {}): InvoicingEvidenceRow {
  return { type: 'SALES_INVOICE', status: 'SYNCED', externalTransactionId: 'inv-1', abandonedBeforeRemoteCall: null, settlementBasis: null, createdAt: T0, payload: lines(3), ...over }
}
function evidence(over: Partial<InvoicingEvidence> = {}): InvoicingEvidence {
  return { accountingInvoiceId: null, invoiceNumber: null, linkedConnectors: [], orderedQuantity: 3, rows: [], ...over }
}
const state = (over: Partial<InvoicingEvidence>): InvoicingState => deriveInvoicingState(evidence(over))

test('no invoice evidence at all is NOT_INVOICED', () => {
  assert.equal(state({}), 'NOT_INVOICED')
})

test('a posted IMS invoice covering every unit is FULLY_INVOICED', () => {
  assert.equal(state({ rows: [row()] }), 'FULLY_INVOICED')
})

test('a QUEUED invoice (PENDING or PROCESSING, no document yet) already counts', () => {
  for (const status of ['PENDING', 'PROCESSING']) {
    assert.equal(state({ rows: [row({ status, externalTransactionId: null })] }), 'FULLY_INVOICED', status)
  }
})

test('an invoice that covers fewer units than the order holds is PARTIALLY_INVOICED; more or equal is FULLY_INVOICED', () => {
  assert.equal(state({ orderedQuantity: 5, rows: [row({ payload: lines(2, 1) })] }), 'PARTIALLY_INVOICED')
  assert.equal(state({ orderedQuantity: 3, rows: [row({ payload: lines(2, 1) })] }), 'FULLY_INVOICED')
  assert.equal(state({ orderedQuantity: 2, rows: [row({ payload: lines(2, 1) })] }), 'FULLY_INVOICED')
})

test('the LATEST counted document states the invoiced lines (an update restates the whole invoice)', () => {
  const first = row({ createdAt: T0, payload: lines(2) })
  const update = row({ type: 'SALES_INVOICE_UPDATE', createdAt: new Date(T0.getTime() + 1000), payload: lines(3), externalTransactionId: 'inv-1' })
  assert.equal(state({ orderedQuantity: 3, rows: [first, update] }), 'FULLY_INVOICED')
  assert.equal(state({ orderedQuantity: 3, rows: [update, first] }), 'FULLY_INVOICED', 'row order does not matter')
  assert.equal(state({ orderedQuantity: 4, rows: [first, update] }), 'PARTIALLY_INVOICED')
})

test('a CREDIT NOTE does not un-invoice, and on its own is not an invoice', () => {
  const credit = row({ type: 'CREDIT_NOTE', externalTransactionId: 'cn-1' })
  assert.equal(state({ rows: [credit] }), 'NOT_INVOICED', 'a credit note alone is not an invoice')
  assert.equal(state({ rows: [row(), credit] }), 'FULLY_INVOICED', 'an invoiced order that is credited stays fully invoiced')
  assert.equal(state({ rows: [row({ payload: lines(1) }), credit], orderedQuantity: 3 }), 'PARTIALLY_INVOICED', 'a credit note changes no quantity')
  assert.equal(rowCountsAsInvoice(credit), false)
})

test('a VOIDED (retired, never posted) invoice returns the order to NOT_INVOICED', () => {
  const retired = row({ status: 'CANCELLED', externalTransactionId: null, abandonedBeforeRemoteCall: true })
  assert.equal(state({ rows: [row({ status: 'PENDING', externalTransactionId: null })] }), 'FULLY_INVOICED')
  assert.equal(state({ rows: [retired] }), 'NOT_INVOICED')
  const settledNotPosted = row({ status: 'CANCELLED', externalTransactionId: null, settlementBasis: 'OPERATOR_ASSERTION' })
  assert.equal(state({ rows: [settledNotPosted] }), 'NOT_INVOICED')
})

test('a FAILED row counts only when it names a document (nothing reached the ledger otherwise)', () => {
  assert.equal(state({ rows: [row({ status: 'FAILED', externalTransactionId: null })] }), 'NOT_INVOICED')
  assert.equal(state({ rows: [row({ status: 'FAILED', externalTransactionId: 'inv-9' })] }), 'FULLY_INVOICED')
})

test('a shadow (recorded instead of queued while writes are held) is not an invoice', () => {
  const shadow = row({ status: 'CANCELLED', externalTransactionId: null, settlementBasis: HELD_SHADOW_SETTLEMENT_BASIS, abandonedBeforeRemoteCall: true })
  assert.equal(state({ rows: [shadow] }), 'NOT_INVOICED')
})

test('XEROOM-FOUND: the incumbent\'s number on a storefront-linked order is an invoice; on any other order it is IMS-minted and is not', () => {
  assert.equal(state({ invoiceNumber: 'INWC-1001', linkedConnectors: ['woocommerce'] }), 'FULLY_INVOICED')
  assert.equal(state({ invoiceNumber: 'INV-0001', linkedConnectors: [] }), 'NOT_INVOICED')
  assert.equal(state({ invoiceNumber: '   ', linkedConnectors: ['woocommerce'] }), 'NOT_INVOICED')
  assert.equal(state({ invoiceNumber: null, linkedConnectors: ['woocommerce'] }), 'NOT_INVOICED')
})

test('a linked ledger document (accountingInvoiceId) is an invoice whatever happened to its row', () => {
  assert.equal(state({ accountingInvoiceId: 'xero-1' }), 'FULLY_INVOICED')
  assert.equal(state({ accountingInvoiceId: 'xero-1', rows: [row({ status: 'CANCELLED', externalTransactionId: null, abandonedBeforeRemoteCall: true })] }), 'FULLY_INVOICED')
})

test('what a link-only or Xeroom invoice covers is not readable, so it reads FULLY_INVOICED, never a guessed shortfall', () => {
  assert.equal(state({ accountingInvoiceId: 'xero-1', orderedQuantity: 50 }), 'FULLY_INVOICED')
  assert.equal(state({ orderedQuantity: 50, rows: [row({ payload: null })] }), 'FULLY_INVOICED')
  assert.equal(state({ orderedQuantity: 50, rows: [row({ payload: { lines: 'compacted' } })] }), 'FULLY_INVOICED')
})

test('invoicedQuantityOfPayload reads the line quantities and refuses anything it cannot read', () => {
  assert.equal(invoicedQuantityOfPayload(lines(1, 2.5)), 3.5)
  assert.equal(invoicedQuantityOfPayload({ lines: [] }), 0)
  assert.equal(invoicedQuantityOfPayload({ lines: [{ quantity: 'x' }] }), null)
  assert.equal(invoicedQuantityOfPayload(null), null)
  assert.equal(invoicedQuantityOfPayload('lines'), null)
})

test('the derivation has no input for the order status: a cancelled order keeps the state it had', () => {
  // The evidence type carries no status, so no caller can hand one in; what a cancelled order's rows say is what counts.
  const posted = evidence({ rows: [row()] })
  assert.equal(deriveInvoicingState(posted), 'FULLY_INVOICED')
  assert.equal(Object.keys(posted).includes('status'), false)
})

// ---- the writer, against an in-memory client -----------------------------------------------------------------------------------------

type Order = { id: string; invoicingState: InvoicingState; accountingInvoiceId: string | null; invoiceNumber: string | null; shoppingLinks: { connector: string }[]; lines: { qty: number }[] }

function memoryClient(orders: Order[], syncRows: (InvoicingEvidenceRow & { referenceId: string; referenceType: string })[]) {
  let updates = 0
  const client = {
    salesOrder: {
      findUnique: async ({ where }: { where: { id: string } }) => orders.find((o) => o.id === where.id) ?? null,
      findMany: async ({ where, take }: { where: { id?: { gt: string } }; take: number }) =>
        orders.filter((o) => !where.id || o.id > where.id.gt).sort((a, b) => a.id.localeCompare(b.id)).slice(0, take),
      updateMany: async ({ where, data }: { where: { id: string; invoicingState: { not: InvoicingState } }; data: { invoicingState: InvoicingState } }) => {
        const o = orders.find((x) => x.id === where.id)
        if (!o || o.invoicingState === where.invoicingState.not) return { count: 0 }
        o.invoicingState = data.invoicingState
        updates += 1
        return { count: 1 }
      },
    },
    accountingSyncLog: {
      findMany: async ({ where }: { where: { referenceId?: string; AND?: unknown[] } }) => syncRows.filter((r) => r.referenceId === where.referenceId),
    },
  }
  return { client, updates: () => updates }
}

const order = (id: string, over: Partial<Order> = {}): Order => ({ id, invoicingState: 'NOT_INVOICED', accountingInvoiceId: null, invoiceNumber: null, shoppingLinks: [], lines: [{ qty: 3 }], ...over })

test('recompute writes the derived value, and writes nothing when it is already right (idempotent)', async () => {
  const o = order('o1')
  const m = memoryClient([o], [{ ...row(), referenceId: 'o1', referenceType: 'SalesOrder' }])
  assert.deepEqual(await recomputeSalesOrderInvoicingState(m.client as never, 'o1'), { state: 'FULLY_INVOICED', changed: true })
  assert.equal(o.invoicingState, 'FULLY_INVOICED')
  assert.deepEqual(await recomputeSalesOrderInvoicingState(m.client as never, 'o1'), { state: 'FULLY_INVOICED', changed: false })
  assert.equal(m.updates(), 1)
})

test('recompute of an order that is gone is a no-op', async () => {
  const m = memoryClient([], [])
  assert.deepEqual(await recomputeSalesOrderInvoicingState(m.client as never, 'ghost'), { state: null, changed: false })
})

test('the write-site entry ignores every row that is not a sales invoice, and a client with no order delegate', async () => {
  const o = order('o1')
  const m = memoryClient([o], [{ ...row(), referenceId: 'o1', referenceType: 'SalesOrder' }])
  await recomputeInvoicingStateForRow(m.client, { type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: 'o1' })
  await recomputeInvoicingStateForRow(m.client, { type: 'SALES_INVOICE', referenceType: 'PurchaseOrder', referenceId: 'o1' })
  await recomputeInvoicingStateForRow({ accountingSyncLog: {} }, { type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: 'o1' })
  assert.equal(o.invoicingState, 'NOT_INVOICED')
  await recomputeInvoicingStateForRow(m.client, { type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: 'o1' })
  assert.equal(o.invoicingState, 'FULLY_INVOICED')
})

test('the repair makes drifted rows right, pages through them, and a second run changes nothing', async () => {
  const orders = [
    order('a', { invoicingState: 'FULLY_INVOICED' }),                                   // stale: no invoice evidence
    order('b', { invoicingState: 'NOT_INVOICED' }),                                     // stale: posted invoice
    order('c', { invoicingState: 'NOT_INVOICED', invoiceNumber: 'INWC-9', shoppingLinks: [{ connector: 'woocommerce' }] }), // Xeroom
    order('d', { invoicingState: 'NOT_INVOICED', lines: [{ qty: 5 }] }),                // stale: partial
    order('e'),                                                                         // already right
  ]
  const syncRows = [
    { ...row(), referenceId: 'b', referenceType: 'SalesOrder' },
    { ...row({ payload: lines(2) }), referenceId: 'd', referenceType: 'SalesOrder' },
  ]
  const m = memoryClient(orders, syncRows)
  let after: string | null = null
  let changed = 0
  let examined = 0
  do {
    const page = await repairInvoicingStates(m.client as never, { limit: 2, after })
    changed += page.changed
    examined += page.examined
    after = page.nextCursor
  } while (after)
  assert.equal(examined, 5)
  assert.equal(changed, 4)
  assert.deepEqual(orders.map((o) => o.invoicingState), ['NOT_INVOICED', 'FULLY_INVOICED', 'FULLY_INVOICED', 'PARTIALLY_INVOICED', 'NOT_INVOICED'])
  const second = await repairInvoicingStates(m.client as never, { limit: 100 })
  assert.deepEqual([second.examined, second.changed], [5, 0])
})

test('a dry run reports what it would change and writes nothing', async () => {
  const o = order('a')
  const m = memoryClient([o], [{ ...row(), referenceId: 'a', referenceType: 'SalesOrder' }])
  const dry = await repairInvoicingStates(m.client as never, { dryRun: true })
  assert.deepEqual([dry.examined, dry.changed], [1, 1])
  assert.equal(o.invoicingState, 'NOT_INVOICED')
})
