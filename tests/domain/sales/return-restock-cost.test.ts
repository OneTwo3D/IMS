import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import type { Prisma } from '@/app/generated/prisma/client'

const queued: Array<Record<string, unknown>> = []
mock.module('@/lib/accounting', {
  namedExports: {
    getAccountingSettings: async () => ({ cogsAccount: '5000', inventoryAccount: '1200', connector: 'xero' }),
    queueAccountingSyncTxWithOutcome: async (_tx: unknown, params: Record<string, unknown>) => {
      queued.push(params)
      return { queued: true, connector: 'xero' }
    },
  },
})

const reported: Array<Record<string, unknown>> = []
mock.module('@/lib/domain/accounting/enqueue-outcome', {
  namedExports: {
    postingIsOwed: (o: { queued: boolean }) => !o.queued,
    reportPostingNotQueued: async (params: Record<string, unknown>) => { reported.push(params) },
  },
})

const loadModule = () => import('@/lib/domain/sales/return-restock-cost')
const priceUnpricedReturnRows = async (...args: Parameters<Awaited<ReturnType<typeof loadModule>>['priceUnpricedReturnRows']>) =>
  (await loadModule()).priceUnpricedReturnRows(...args)
const queueReturnRestockValueJournal = async (...args: Parameters<Awaited<ReturnType<typeof loadModule>>['queueReturnRestockValueJournal']>) =>
  (await loadModule()).queueReturnRestockValueJournal(...args)

function client(
  layers: Array<{ warehouseId: string; productId: string; remainingQty: number; receivedQty: number; unitCostBase: number; poLineId?: string | null; adjustmentMovementId?: string | null; isOpeningStock?: boolean }>,
  productType = 'SIMPLE',
  extra: Record<string, unknown> = {},
) {
  return {
    ...extra,
    product: { findUnique: async () => ({ type: productType, sku: 'SKU1', name: 'Thing' }) },
    adjustmentReason: { findUnique: async ({ where }: { where: { id: string } }) => (where.id === 'r1' ? { name: 'Stock gain', accountCode: '4900' } : where.id === 'r0' ? { name: 'No code', accountCode: null } : null) },
    costLayer: {
      count: async ({ where }: { where: { productId: string } }) => layers.filter((l) =>
        l.productId === where.productId
        && l.receivedQty > 0
        && (l.poLineId != null || l.adjustmentMovementId != null || l.isOpeningStock === true)).length,
      findMany: async ({ where }: { where: { productId: string; warehouseId?: string; remainingQty?: unknown } }) =>
        layers.filter((l) =>
          l.productId === where.productId
          && (where.warehouseId == null || l.warehouseId === where.warehouseId)
          && (where.remainingQty == null || l.remainingQty > 0)),
    },
  } as unknown as Prisma.TransactionClient
}

test('an unpriced row takes the warehouse average cost', async () => {
  const tx = client([
    { warehouseId: 'w1', productId: 'p1', remainingQty: 2, receivedQty: 2, unitCostBase: 4 },
    { warehouseId: 'w1', productId: 'p1', remainingQty: 2, receivedQty: 2, unitCostBase: 6 },
  ])
  const rows = await priceUnpricedReturnRows(tx, 'w1', [{ productId: 'p1', qty: 1 }])
  assert.equal(Number(rows[0].unitCostBase), 5)
})

test('with no stock in the warehouse it falls back to the historical average', async () => {
  const tx = client([{ warehouseId: 'w2', productId: 'p1', remainingQty: 0, receivedQty: 3, unitCostBase: 7 }])
  const rows = await priceUnpricedReturnRows(tx, 'w1', [{ productId: 'p1', qty: 1 }])
  assert.equal(Number(rows[0].unitCostBase), 7)
})

test('a row that already carries a cost is left alone', async () => {
  const rows = await priceUnpricedReturnRows(client([]), 'w1', [{ productId: 'p1', qty: 1, unitCostBase: 0 }])
  assert.equal(Number(rows[0].unitCostBase), 0)
})

test('no cost basis anywhere refuses rather than restocking at zero', async () => {
  await assert.rejects(() => priceUnpricedReturnRows(client([]), 'w1', [{ productId: 'p1', qty: 1 }]), /no unit cost could be derived/)
})

test('a product whose layers all sit at cost 0 restocks at 0 instead of being blocked', async () => {
  const tx = client([{ warehouseId: 'w1', productId: 'p1', remainingQty: 2, receivedQty: 2, unitCostBase: 0, poLineId: 'pl1' }])
  const rows = await priceUnpricedReturnRows(tx, 'w1', [{ productId: 'p1', qty: 1 }])
  assert.equal(Number(rows[0].unitCostBase), 0)
})

test('a product whose only zero layers are transfer balancing layers or received nothing is refused as cost missing', async () => {
  const tx = client([
    { warehouseId: 'w1', productId: 'p1', remainingQty: 2, receivedQty: 2, unitCostBase: 0 },
    { warehouseId: 'w1', productId: 'p1', remainingQty: 0, receivedQty: 0, unitCostBase: 0, poLineId: 'pl1' },
  ])
  await assert.rejects(() => priceUnpricedReturnRows(tx, 'w1', [{ productId: 'p1', qty: 1 }]), /no unit cost could be derived/)
})

test('a NON_INVENTORY product with no layers restocks at 0', async () => {
  const rows = await priceUnpricedReturnRows(client([], 'NON_INVENTORY'), 'w1', [{ productId: 'p1', qty: 1 }])
  assert.equal(Number(rows[0].unitCostBase), 0)
})

test('the refusal advice names a step that works', async () => {
  await assert.rejects(
    () => priceUnpricedReturnRows(client([]), 'w1', [{ productId: 'p1', qty: 1 }]),
    /unit cost first \(use 0 only for genuinely zero-cost stock\)/,
  )
})

const warehouse = { id: 'w1', code: 'MAIN', name: 'Main' }

test('a newly priced row queues Dr Inventory / Cr the stock-gain reason account (not COGS) at the booked value', async () => {
  queued.length = 0
  const original = [{ productId: 'p1', qty: 3 }]
  const priced = [{ productId: 'p1', qty: 3, unitCostBase: 20 }]
  await queueReturnRestockValueJournal(client([]) as Prisma.TransactionClient, { inboxId: 'inbox1', warehouse, originalRows: original, pricedRows: priced, adjustmentReasonId: 'r1' })
  assert.equal(queued.length, 1)
  assert.equal(queued[0].type, 'INVENTORY_ADJUSTMENT')
  assert.equal(queued[0].referenceId, 'inbox1')
  const lines = (queued[0].payload as { lines: Array<{ accountCode: string; debit?: number; credit?: number }> }).lines
  assert.deepEqual(lines.map((l) => [l.accountCode, l.debit ?? 0, l.credit ?? 0]), [['1200', 60, 0], ['4900', 0, 60]])
})

test('rows an expectation already priced queue no journal here', async () => {
  queued.length = 0
  const rows = [{ productId: 'p1', qty: 1, unitCostBase: 20 }]
  await queueReturnRestockValueJournal(client([]) as Prisma.TransactionClient, { inboxId: 'inbox1', warehouse, originalRows: rows, pricedRows: rows })
  assert.equal(queued.length, 0)
})

test('a zero-cost restock queues no journal', async () => {
  queued.length = 0
  await queueReturnRestockValueJournal(client([]) as Prisma.TransactionClient, {
    inboxId: 'inbox1', warehouse, originalRows: [{ productId: 'p1', qty: 1 }], pricedRows: [{ productId: 'p1', qty: 1, unitCostBase: 0 }],
  })
  assert.equal(queued.length, 0)
})

test('an unmapped reason account queues nothing and reports the owed posting', async () => {
  queued.length = 0
  reported.length = 0
  await queueReturnRestockValueJournal(client([]) as Prisma.TransactionClient, {
    inboxId: 'inbox1', warehouse, originalRows: [{ productId: 'p1', qty: 1 }], pricedRows: [{ productId: 'p1', qty: 1, unitCostBase: 20 }], adjustmentReasonId: 'r0',
  })
  assert.equal(queued.length, 0)
  assert.equal(reported.length, 1)
  assert.equal(reported[0].kind, 'returns_inbox_restock_journal')
})

function refundClient(opts: { refundRestocked?: number; expected?: Array<{ qty: number; qtyWrittenOff: number }>; priorInbox?: number }) {
  return client([], 'SIMPLE', {
    salesOrderRefund: { findMany: async () => [{ id: 'rf1' }] },
    returnExpectationLine: { findMany: async () => opts.expected ?? [] },
    wmsReturnsInbox: { findMany: async () => (opts.priorInbox ? [{ id: 'inboxPrev' }] : []) },
    stockMovement: {
      aggregate: async ({ where }: { where: { referenceType: string } }) => ({
        _sum: { qty: where.referenceType === 'SalesOrderRefund' ? (opts.refundRestocked ?? 0) : (opts.priorInbox ?? 0) },
      }),
    },
  })
}
const netRows = async (tx: Prisma.TransactionClient, rows: Array<{ productId: string; qty: number; unitCostBase?: number }>) =>
  (await loadModule()).netUnpricedReturnRowsAgainstRefunds(tx, { inboxId: 'inbox1', orderId: 'o1', rows })

test('scenario A: a refund that already restocked the unit leaves nothing to value or journal', async () => {
  const result = await netRows(refundClient({ refundRestocked: 1 }), [{ productId: 'p1', qty: 1 }])
  assert.equal(result.coveredQty, 1)
  assert.deepEqual(result.rows, [])
})

test('scenario A: a part-covered arrival keeps only the uncovered remainder', async () => {
  const result = await netRows(refundClient({ refundRestocked: 1 }), [{ productId: 'p1', qty: 3 }])
  assert.equal(result.coveredQty, 1)
  assert.deepEqual(result.rows, [{ productId: 'p1', qty: 2 }])
})

test('units an earlier inbox restock already used are not covered twice', async () => {
  const result = await netRows(refundClient({ refundRestocked: 1, priorInbox: 1 }), [{ productId: 'p1', qty: 1 }])
  assert.equal(result.coveredQty, 0)
  assert.deepEqual(result.rows, [{ productId: 'p1', qty: 1 }])
})

test('an order with no refund covers nothing, and expectation-priced rows are untouched', async () => {
  const result = await netRows(refundClient({}), [{ productId: 'p1', qty: 2 }, { productId: 'p1', qty: 1, unitCostBase: 5 }])
  assert.equal(result.coveredQty, 0)
  assert.equal(result.rows.length, 2)
})

test('units held by an expectation (net of write-offs) count as covered', async () => {
  const result = await netRows(refundClient({ expected: [{ qty: 2, qtyWrittenOff: 1 }] }), [{ productId: 'p1', qty: 2 }])
  assert.equal(result.coveredQty, 1)
  assert.deepEqual(result.rows, [{ productId: 'p1', qty: 1 }])
})

// ---- o3d-iil0b round 1: the ledger side of an adoption --------------------------------------------------
const adoptionTx = (opts: { journals?: Array<{ referenceId: string; lines: Array<{ accountCode: string; credit?: number; debit?: number }> }>; movements?: Record<string, number> }) => ({
  stockMovement: { groupBy: async () => Object.entries(opts.movements ?? { ib1: 2 }).map(([referenceId, qty]) => ({ referenceId, _sum: { qty } })) },
  accountingSyncLog: { findMany: async () => (opts.journals ?? []).map((j) => ({ referenceId: j.referenceId, payload: { lines: j.lines } })) },
}) as unknown as Prisma.TransactionClient
const adoptionRun = async (tx: Prisma.TransactionClient, adoptions: Array<{ inboxId: string; qty: number }>, rows: Array<{ productId: string; qty: number; unitCostBase?: number }>) =>
  (await loadModule()).queueAdoptionReclassJournal(tx, { refundId: 'rf1', orderId: 'o1', orderRef: 'SO-1', adoptions, rows })

test('an adopting refund reclassifies the restock: Dr the stock-gain account, Dr the cost difference to Inventory, Cr COGS at the original cost', async () => {
  queued.length = 0
  reported.length = 0
  // The restock (2 units, booked at the average 30 = 60) credited 4900; the original shipment cost was 40 a unit and one unit is adopted.
  const tx = adoptionTx({ journals: [{ referenceId: 'ib1', lines: [{ accountCode: '1200', debit: 60 }, { accountCode: '4900', credit: 60 }] }] })
  const result = await adoptionRun(tx, [{ inboxId: 'ib1', qty: 1 }], [{ productId: 'p1', qty: 1, unitCostBase: 40 }])
  assert.equal(result.queued, true)
  assert.equal(queued.length, 1)
  assert.equal(queued[0].type, 'INVENTORY_ADJUSTMENT')
  assert.equal(queued[0].referenceType, 'SalesOrderRefund')
  assert.equal(queued[0].referenceId, 'rf1')
  const lines = (queued[0].payload as { lines: Array<{ accountCode: string; debit?: number; credit?: number }> }).lines
  assert.deepEqual(lines.map((l) => [l.accountCode, l.debit ?? 0, l.credit ?? 0]), [['4900', 30, 0], ['1200', 10, 0], ['5000', 0, 40]])
  // Net with the restock (Dr 1200 30 / Cr 4900 30 for the unit): Inventory +40, COGS -40, the reason account nets to nil.
  assert.equal(lines.reduce((s, l) => s + (l.debit ?? 0) - (l.credit ?? 0), 0), 0, 'balanced')
  assert.equal(reported.length, 0)
})

test('when the restock was dearer than the original cost the difference is credited to Inventory', async () => {
  queued.length = 0
  const tx = adoptionTx({ journals: [{ referenceId: 'ib1', lines: [{ accountCode: '1200', debit: 100 }, { accountCode: '4900', credit: 100 }] }], movements: { ib1: 2 } })
  await adoptionRun(tx, [{ inboxId: 'ib1', qty: 1 }], [{ productId: 'p1', qty: 1, unitCostBase: 40 }])
  const lines = (queued[0].payload as { lines: Array<{ accountCode: string; debit?: number; credit?: number }> }).lines
  assert.deepEqual(lines.map((l) => [l.accountCode, l.debit ?? 0, l.credit ?? 0]), [['4900', 50, 0], ['1200', 0, 10], ['5000', 0, 40]])
})

test('a restock that booked NO journal (no reason account) queues nothing and reports the owed posting with the whole entry', async () => {
  queued.length = 0
  reported.length = 0
  const result = await adoptionRun(adoptionTx({}), [{ inboxId: 'ib1', qty: 1 }], [{ productId: 'p1', qty: 1, unitCostBase: 40 }])
  assert.equal(queued.length, 0)
  assert.equal(result.queued, false)
  assert.equal(result.owedValueBase, 40)
  assert.equal(reported.length, 1)
  assert.equal(reported[0].kind, 'refund_adoption_reclass_journal')
  assert.match(String(reported[0].remedy), /Dr Inventory \/ Cr COGS 40\.00/)
})

test('a part journaled, part unjournaled adoption splits the original cost by quantity: the journaled share is reclassed, the rest is owed', async () => {
  queued.length = 0
  reported.length = 0
  const tx = adoptionTx({ journals: [{ referenceId: 'ib1', lines: [{ accountCode: '1200', debit: 40 }, { accountCode: '4900', credit: 40 }] }], movements: { ib1: 1, ib2: 1 } })
  const result = await adoptionRun(tx, [{ inboxId: 'ib1', qty: 1 }, { inboxId: 'ib2', qty: 1 }], [{ productId: 'p1', qty: 2, unitCostBase: 40 }])
  assert.equal(result.queued, true)
  assert.equal(result.owedValueBase, 40)
  const lines = (queued[0].payload as { lines: Array<{ accountCode: string; debit?: number; credit?: number }> }).lines
  assert.deepEqual(lines.map((l) => [l.accountCode, l.debit ?? 0, l.credit ?? 0]), [['4900', 40, 0], ['5000', 0, 40]])
  assert.equal(reported.length, 1)
})

test('nothing to reverse (no shipped cost) books and reports nothing', async () => {
  queued.length = 0
  reported.length = 0
  const result = await adoptionRun(adoptionTx({}), [{ inboxId: 'ib1', qty: 1 }], [])
  assert.deepEqual(result, { queued: false, owedValueBase: 0 })
  assert.equal(queued.length + reported.length, 0)
})
