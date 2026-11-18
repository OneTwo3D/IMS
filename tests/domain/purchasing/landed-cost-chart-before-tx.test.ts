import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import type { PurchaseOrderStatus } from '@/app/generated/prisma/client'
import { cancelPurchaseOrderService, type CancelPurchaseOrderServiceDeps } from '@/lib/domain/purchasing/cancellation-service'

/**
 * o3d-d0gog: the revaluation inside a landed-cost / cancellation transaction must not read the chart over the pool
 * (a second connection while the transaction holds one, errors swallowed as "no chart"). The caller reads it BEFORE
 * the transaction and passes it down.
 */

test('freight cancellation reads the chart before the transaction opens and hands it to the recalculation', async () => {
  const order: string[] = []
  const chart = { connector: 'xero', inventoryAccount: '630', cogsAccount: '500', transitAccount: '620' }
  let seenOptions: { accountingSettings?: unknown } | null = null
  const po = { status: 'PO_SENT' as PurchaseOrderStatus, reference: 'FRT-1' }
  const tx = {
    $queryRaw: async () => [],
    purchaseOrder: {
      findUnique: async () => ({ status: po.status, reference: po.reference, type: 'FREIGHT', invoices: [], supplierCreditNotes: [] }),
      update: async () => ({ id: 'frt-1' }),
    },
  }
  const deps = {
    findPurchaseOrderFast: async () => ({ status: po.status, reference: po.reference }),
    transaction: async (fn: (t: never) => unknown) => { order.push('tx-open'); return fn(tx as never) },
    logActivity: async () => undefined,
    retirePurchaseOrderLocked: async () => { throw new Error('not a goods order') },
    recalculateLandedCosts: async (_tx: unknown, _id: string, _deps: unknown, options: { accountingSettings?: unknown }) => {
      seenOptions = options
      return { revalidatePoIds: [], auditRunIds: [], cogsAdjustments: [], inventoryTransitAdjustments: [], warnings: [] }
    },
    queueLandedCostAdjustmentJournals: async () => ({ owed: 0 }),
    readAccountingChart: async () => { order.push('chart-read'); return chart },
  } as unknown as CancelPurchaseOrderServiceDeps

  const result = await cancelPurchaseOrderService('frt-1', deps)

  assert.equal(result.success, true)
  assert.deepEqual(order, ['chart-read', 'tx-open'], 'the pooled read happens while no transaction connection is held')
  assert.equal(seenOptions!.accountingSettings, chart, 'the recalculation is handed that chart, not left to read its own')
})

test('an UNREADABLE chart fails closed: the cancellation is refused before any transaction or write, so no delta can post twice', async () => {
  let txOpened = false
  let recalculated = false
  const deps = {
    findPurchaseOrderFast: async () => ({ status: 'PO_SENT', reference: 'FRT-1' }),
    transaction: async () => { txOpened = true; return {} },
    logActivity: async () => undefined,
    retirePurchaseOrderLocked: async () => { throw new Error('unused') },
    recalculateLandedCosts: async () => { recalculated = true; return {} },
    queueLandedCostAdjustmentJournals: async () => ({ owed: 0 }),
    readAccountingChart: async () => { throw new Error('connection terminated') },
  } as unknown as CancelPurchaseOrderServiceDeps

  const result = await cancelPurchaseOrderService('frt-1', deps)

  assert.equal(result.success, false)
  assert.match(String(result.error), /connection terminated|could not be read/)
  assert.equal(txOpened, false, 'nothing is written')
  assert.equal(recalculated, false)
})

test('the pre-transaction chart read throws a named error instead of returning null', () => {
  const service = readFileSync('lib/domain/purchasing/landed-cost-service.ts', 'utf8')
  const body = service.slice(service.indexOf('export async function readLandedCostChartBeforeTx'), service.indexOf('export async function readLandedCostChartBeforeTx') + 300)
  assert.match(body, /throw new LandedCostChartUnreadableError\(error\)/)
  assert.doesNotMatch(body, /catch\(\(\) => null\)/)
})

test('census: every in-transaction revaluation caller supplies the chart, and the walk never reads it over the pool when given one', () => {
  const actions = readFileSync('app/actions/purchase-orders.ts', 'utf8')
  assert.equal((actions.match(/readLandedCostChartBeforeTx\(\)/g) ?? []).length, 3, 'createFreightPo, updateFreightPoCosts and the close action')
  assert.match(actions, /reason: 'freight_purchase_order_created',[^}]*accountingSettings: landedChart/)
  assert.match(actions, /reason: 'freight_purchase_order_costs_updated',[^}]*accountingSettings: landedChart/)
  assert.match(actions, /retirePurchaseOrderLocked\(tx, id, 'close', undefined, closeChart\)/)

  const service = readFileSync('lib/domain/purchasing/landed-cost-service.ts', 'utf8')
  assert.equal((service.match(/options\.accountingSettings/g) ?? []).length >= 6, true, 'both recalculation paths forward the chart to propagation and to every shipment refresh')
  assert.match(service, /\.\.\.\(chart !== undefined \? \{ accountingSettings: chart \} : \{\}\)/, 'a chart that could not be read (null) is still handed down, never re-read')

  const layers = readFileSync('lib/cost-layers.ts', 'utf8')
  assert.match(layers, /options\.accountingSettings !== undefined \? options\.accountingSettings : await getAccountingSettings\(\)/, 'null from the caller means "could not read", not "read it again over the pool"')
})
