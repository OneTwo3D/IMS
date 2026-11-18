import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { findPostedSalesInvoiceSync } from '@/lib/domain/accounting/cancel-order-invoice-sync'

const dailySync = readFileSync('lib/connectors/xero/daily-sync.ts', 'utf8')
const salesActions = readFileSync('app/actions/sales.ts', 'utf8')

test('Group B row-locks every order of its window BEFORE it locks cost layers, the order refund staging uses', () => {
  const groupB = dailySync.slice(dailySync.indexOf('const runGroupB = async'))
  const orderLock = groupB.indexOf('await lockSalesOrders(tx,')
  const layerLock = groupB.indexOf('await lockCostLayersForGroupBWindow(')
  const realRead = groupB.indexOf('const shipmentRows = await tx.shipment.findMany')
  assert.ok(orderLock > 0, 'Group B takes the sales-order lock')
  assert.ok(orderLock < layerLock, 'order lock first, then cost layers (refund staging takes the order first too: no lock cycle)')
  assert.ok(layerLock < realRead, 'and everything is read after the locks')
})

test('every automated cancel is marked automated; only an operator cancel is refused for a posted invoice', () => {
  assert.match(salesActions, /automated: bypassPermission \|\| authOnly/)
})

type FindFirstArgs = { where: Record<string, unknown> }

function stubTx(rows: { sync?: { id: string; connector: string; type: string } | null; order?: unknown }) {
  const calls: FindFirstArgs[] = []
  return {
    calls,
    tx: {
      accountingSyncLog: { findFirst: async (args: FindFirstArgs) => { calls.push(args); return rows.sync ?? null } },
      salesOrder: { findUnique: async () => rows.order ?? null },
    } as never,
  }
}

test('posted-invoice detection selects asserted and id-less SYNCED rows and carves out only a verified reversal', async () => {
  const { tx, calls } = stubTx({ sync: { id: 's1', connector: 'xero', type: 'SALES_INVOICE' } })
  const found = await findPostedSalesInvoiceSync(tx, 'order-1')
  assert.equal(found?.id, 's1')
  const where = JSON.stringify(calls[0].where)
  // No settlement-basis restriction on the claim itself (an OPERATOR_ASSERTION row with a typed id is a claim to have posted) ...
  assert.doesNotMatch(where, /"settlementBasis":"OPERATOR_RELEASE"/)
  assert.match(where, /"status":"SYNCED"/)
  // ... and a row whose cancellation the connector verified is excluded.
  assert.match(where, /"settlementBasis":\{"not":"VERIFIED_REVERSAL"\}/)
})

test('a WooCommerce invoice number is never read as a posted invoice; only the proven-ledger-fact predicate decides', async () => {
  const { tx, calls } = stubTx({ order: { invoiceNumber: 'INV-7', shoppingLinks: [{ connector: 'woocommerce' }] } })
  assert.equal(await findPostedSalesInvoiceSync(tx, 'order-1'), null)
  assert.equal(calls.length, 1, 'one ledger query and no order-number fallback')
  const where = JSON.stringify(calls[0].where)
  assert.match(where, /"settlementBasis":"OPERATOR_RELEASE"/, 'proven-ledger-fact basis (connector or release)')
  assert.doesNotMatch(where, /"OPERATOR_ASSERTION"/)
})

test('the Group B transaction carries explicit maxWait/timeout options', () => {
  assert.match(dailySync, /\}, GROUP_B_TX_OPTIONS\)\n    if \(groupBCount > 0\)/)
})
