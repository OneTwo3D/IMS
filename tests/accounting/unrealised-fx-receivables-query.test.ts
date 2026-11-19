import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { createSyncLogStore, matchesWhere, syncLogRow, type SyncLogRow } from '@/tests/fixtures/accounting-sync-log-store'

// o3d-cr517: these tests drive getOpenReceivables itself and read the ARGUMENTS the order query receives, so a change to the query (the population dropped back to
// accountingInvoiceId alone, every non-deleted refund netted again) fails here, not only a change to an exported constant.

type Call = { where: Record<string, unknown>; select: Record<string, unknown> }
const orderCalls: Call[] = []
let orders: Array<Record<string, unknown>> = []
let syncRows: SyncLogRow[] = []
let refusals: Array<Record<string, unknown>> = []
const refusalCalls: Array<{ where: Record<string, unknown> }> = []

mock.module('@/lib/db', {
  namedExports: {
    db: {
      salesOrder: { findMany: async (args: Call) => { orderCalls.push(args); return orders } },
      accountingSyncLog: { findMany: async ({ where }: { where: Record<string, unknown> }) => createSyncLogStore(syncRows).rows.filter((row) => matchesWhere(row, where)) },
      accountingPostingRefusal: {
        findMany: async (args: { where: Record<string, unknown> }) => {
          refusalCalls.push(args)
          const { type, referenceType, referenceId, resolution } = args.where as { type: string; referenceType: string; referenceId?: { in: string[] }; resolution: string }
          return refusals.filter((r) => r.type === type && r.referenceType === referenceType && r.resolution === resolution && (!referenceId || referenceId.in.includes(r.referenceId as string)))
        },
      },
    },
  },
})

const reset = (): void => { orderCalls.length = 0; refusalCalls.length = 0; orders = []; syncRows = []; refusals = [] }
const refund = (id: string, totalForeign: string, accountingCreditNoteId: string | null) => ({ id, totalForeign, accountingCreditNoteId, totalBase: totalForeign, totalsBasis: null, lines: [] })
const baseOrder = (over: Record<string, unknown> = {}) => ({
  id: 'so-1', orderNumber: 'SO-1', externalOrderNumber: null, invoiceNumber: 'INV-1', accountingInvoiceId: 'XI-1', shoppingLinks: [], currency: 'EUR', totalForeign: '100', totalBase: '80', fxRateToBase: '0.8', payments: [], refunds: [], ...over,
})

test('getOpenReceivables nets a refund whose credit note was posted by hand or asserted, never one still queued, and asks the ledger-basis questions of the database', async () => {
  reset()
  const { getOpenReceivables, RECEIVABLE_NETTING_REFUND_WHERE } = await import('@/lib/accounting-fx-revaluation')
  orders = [baseOrder({ refunds: [refund('r-posted', '30', 'CN-1'), refund('r-queued', '25', null), refund('r-hand', '20', null), refund('r-asserted', '10', null)] })]
  refusals = [{ type: 'CREDIT_NOTE', referenceType: 'SalesOrderRefund', referenceId: 'r-hand', resolution: 'handled_manually' }]
  syncRows = [
    syncLogRow({ id: 'a-1', type: 'CREDIT_NOTE', status: 'SYNCED', referenceType: 'SalesOrderRefund', referenceId: 'r-asserted', externalTransactionId: 'CN-A', settlementBasis: 'OPERATOR_ASSERTION' }),
    // Negative controls: a CANCELLED shadow and a plain connector-SYNCED row (whose back-reference was never written) are not operator assertions and must NOT net.
    syncLogRow({ id: 'a-shadow', type: 'CREDIT_NOTE', status: 'CANCELLED', referenceType: 'SalesOrderRefund', referenceId: 'r-queued', externalTransactionId: null, settlementBasis: 'HELD_SHADOW' }),
    syncLogRow({ id: 'a-plain', type: 'CREDIT_NOTE', status: 'SYNCED', referenceType: 'SalesOrderRefund', referenceId: 'r-queued', externalTransactionId: 'CN-P', settlementBasis: null }),
  ]
  const open = await getOpenReceivables('GBP')
  // 100 - 30 (back-referenced) - 20 (handled by hand) - 10 (asserted); the 25 still queued is not subtracted.
  assert.equal(open.length, 1)
  assert.equal(open[0]!.outstandingForeign, 40)
  // The arguments the query really received.
  const orderQuery = orderCalls.at(-1)!
  const refundsArg = (orderQuery.select as { refunds: { where: unknown; select: Record<string, unknown> } }).refunds
  assert.deepEqual(refundsArg.where, RECEIVABLE_NETTING_REFUND_WHERE)
  assert.equal(refundsArg.select.accountingCreditNoteId, true, 'the back-reference is read, so a queued refund can be told from a posted one')
  assert.equal(refundsArg.select.id, true)
  // The hand-posted lookup is for exactly the refunds with no back-reference, and only for the resolved-by-hand arm.
  const creditNoteLookup = refusalCalls.find((call) => call.where.type === 'CREDIT_NOTE')!
  assert.deepEqual(creditNoteLookup.where, { type: 'CREDIT_NOTE', referenceType: 'SalesOrderRefund', referenceId: { in: ['r-queued', 'r-hand', 'r-asserted'] }, resolution: 'handled_manually' })
})

test('getOpenReceivables: a fully refunded unpaid order whose credit note was handled by hand is not a phantom receivable; one whose credit note is queued still is', async () => {
  reset()
  const { getOpenReceivables } = await import('@/lib/accounting-fx-revaluation')
  orders = [
    baseOrder({ id: 'so-hand', refunds: [refund('r-1', '100', null)] }),
    baseOrder({ id: 'so-queued', refunds: [refund('r-2', '100', null)] }),
  ]
  refusals = [{ type: 'CREDIT_NOTE', referenceType: 'SalesOrderRefund', referenceId: 'r-1', resolution: 'handled_manually' }]
  const open = await getOpenReceivables('GBP')
  assert.deepEqual(open.map((o) => [o.id, o.outstandingForeign]), [['so-queued', 100]])
})

test('getOpenReceivables: the population query carries the invoiced-basis arms and the hand-posted / asserted invoices, and drops nothing keyed on accountingInvoiceId alone', async () => {
  reset()
  const { getOpenReceivables } = await import('@/lib/accounting-fx-revaluation')
  refusals = [{ type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: 'so-hand', resolution: 'handled_manually' }]
  syncRows = [
    syncLogRow({ id: 'a-2', type: 'SALES_INVOICE', status: 'SYNCED', referenceType: 'SalesOrder', referenceId: 'so-asserted', externalTransactionId: 'INV-A', settlementBasis: 'OPERATOR_ASSERTION' }),
    syncLogRow({ id: 'a-shadow', type: 'SALES_INVOICE', status: 'CANCELLED', referenceType: 'SalesOrder', referenceId: 'so-shadow', externalTransactionId: null, settlementBasis: 'HELD_SHADOW' }),
    syncLogRow({ id: 'a-plain', type: 'SALES_INVOICE', status: 'SYNCED', referenceType: 'SalesOrder', referenceId: 'so-plain', externalTransactionId: 'INV-P', settlementBasis: null }),
  ]
  await getOpenReceivables('GBP')
  const where = orderCalls.at(-1)!.where as { OR: Array<Record<string, unknown>>; accountingInvoiceId?: unknown; status: unknown }
  assert.equal('accountingInvoiceId' in where, false, 'not keyed on the back-reference alone')
  const arms = where.OR
  assert.ok(arms.some((arm) => JSON.stringify(arm) === JSON.stringify({ accountingInvoiceId: { not: null } })), 'IMS-posted invoice')
  assert.ok(arms.some((arm) => 'invoiceNumber' in arm && 'shoppingLinks' in arm), 'Xeroom-era invoice number')
  const idArm = arms.find((arm) => 'id' in arm) as { id: { in: string[] } } | undefined
  assert.deepEqual([...(idArm?.id.in ?? [])].sort(), ['so-asserted', 'so-hand'], 'hand-posted and asserted invoices')
  assert.deepEqual(where.status, { notIn: ['CANCELLED', 'DRAFT'] })
})

test('getOpenReceivables: an order admitted only through the Xeroom arm nets every live refund (Xeroom posts the credit notes); an IMS-posted order still needs ledger evidence', async () => {
  reset()
  const { getOpenReceivables } = await import('@/lib/accounting-fx-revaluation')
  const xeroom = { accountingInvoiceId: null, invoiceNumber: 'WC-1', shoppingLinks: [{ connector: 'woocommerce' }] }
  orders = [
    baseOrder({ id: 'so-xeroom', totalForeign: '1000', totalBase: '800', ...xeroom, refunds: [refund('x-1', '300', null)] }),
    // Control: the same unreferenced refund on an IMS-posted invoice is not netted.
    baseOrder({ id: 'so-ims', totalForeign: '1000', totalBase: '800', refunds: [refund('i-1', '300', null)] }),
    // Both an IMS back-reference and a Xeroom-style number: the IMS-posted rule wins.
    baseOrder({ id: 'so-both', totalForeign: '1000', totalBase: '800', accountingInvoiceId: 'XI-9', invoiceNumber: 'WC-2', shoppingLinks: [{ connector: 'woocommerce' }], refunds: [refund('b-1', '300', null)] }),
  ]
  const open = await getOpenReceivables('GBP')
  assert.deepEqual(open.map((o) => [o.id, o.outstandingForeign]), [['so-xeroom', 700], ['so-ims', 1000], ['so-both', 1000]])
})
