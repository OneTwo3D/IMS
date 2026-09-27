import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PURCHASE_ORDER_FX_OVERRIDE_TOLERANCE,
  resolvePurchaseOrderFxRateToBase,
} from '@/lib/domain/purchasing/purchase-order-fx'
import {
  buildPurchaseOrderFxRebaseUpdates,
  rebasePurchaseOrderStoredBaseAmounts,
  rebasePurchaseOrderStoredBaseAmountsWithParentUpdate,
  type PurchaseOrderFxRebaseTransactionDb,
} from '@/lib/domain/purchasing/purchase-order-fx-rebase'
import { updatePurchaseOrderFxRateOnly } from '@/lib/domain/purchasing/purchase-order-fx-update'

function createClient(rate: number | null) {
  return {
    fxRate: {
      findFirst: async () => rate == null
        ? null
        : { rate, fetchedAt: new Date('2026-06-10T00:00:00.000Z') },
    },
  }
}

test('purchase-order FX resolver defaults to the latest stored rate when input is missing', async () => {
  const resolved = await resolvePurchaseOrderFxRateToBase(createClient(1.18) as never, {
    currency: 'EUR',
    baseCurrency: 'GBP',
    asOf: new Date('2026-06-11T00:00:00.000Z'),
    inputRateToBase: undefined,
  })

  assert.equal(resolved, 1.18)
})

test('purchase-order FX resolver accepts manual overrides inside the tolerance band', async () => {
  const resolved = await resolvePurchaseOrderFxRateToBase(createClient(1.18) as never, {
    currency: 'EUR',
    baseCurrency: 'GBP',
    asOf: new Date('2026-06-11T00:00:00.000Z'),
    inputRateToBase: 1.18 * (1 + PURCHASE_ORDER_FX_OVERRIDE_TOLERANCE - 0.0001),
  })

  assert.equal(resolved, 1.18 * (1 + PURCHASE_ORDER_FX_OVERRIDE_TOLERANCE - 0.0001))
})

test('purchase-order FX resolver rejects stale or mistyped manual overrides outside the tolerance band', async () => {
  await assert.rejects(
    () => resolvePurchaseOrderFxRateToBase(createClient(1.18) as never, {
      currency: 'EUR',
      baseCurrency: 'GBP',
      asOf: new Date('2026-06-11T00:00:00.000Z'),
      inputRateToBase: 1.40,
    }),
    /differs by 18\.64% from the latest GBP rate 1\.18/,
  )
})

test('purchase-order FX resolver requires a stored non-base-currency rate', async () => {
  await assert.rejects(
    () => resolvePurchaseOrderFxRateToBase(createClient(null) as never, {
      currency: 'EUR',
      baseCurrency: 'GBP',
      asOf: new Date('2026-06-11T00:00:00.000Z'),
    }),
    /Missing GBP FX rate for EUR on or before 2026-06-11/,
  )
})

test('purchase-order FX resolver forces base-currency purchase orders to rate 1', async () => {
  const resolved = await resolvePurchaseOrderFxRateToBase(createClient(1.18) as never, {
    currency: 'GBP',
    baseCurrency: 'GBP',
    asOf: new Date('2026-06-11T00:00:00.000Z'),
    inputRateToBase: 1.40,
  })

  assert.equal(resolved, 1)
})

test('purchase-order FX rebase rebuilds stored base totals from persisted foreign values', () => {
  const rebased = buildPurchaseOrderFxRebaseUpdates({
    subtotalForeign: '120',
    taxForeign: '24',
    totalForeign: '156',
    directFreightForeign: '12',
    lines: [
      { id: 'line-1', unitCostForeign: '10', totalForeign: '100', taxForeign: '20' },
      { id: 'line-2', unitCostForeign: '5.555555', totalForeign: '20', taxForeign: '4' },
    ],
    freightCostLines: [
      { id: 'freight-1', amountForeign: '12' },
    ],
  }, 1.2)

  assert.deepEqual(rebased.purchaseOrder, {
    subtotalBase: 100,
    taxBase: 20,
    totalBase: 130,
    directFreightBase: 10,
  })
  assert.deepEqual(rebased.lines, [
    { id: 'line-1', unitCostBase: 8.333333, totalBase: 83.3333, taxBase: 16.6667 },
    { id: 'line-2', unitCostBase: 4.629629, totalBase: 16.6667, taxBase: 3.3333 },
  ])
  assert.deepEqual(rebased.freightCostLines, [
    { id: 'freight-1', amountBase: 10 },
  ])
})

test('purchase-order FX rebase updates persisted line and freight base amounts', async () => {
  const lineUpdates: unknown[] = []
  const freightUpdates: unknown[] = []
  const findManyCalls: unknown[] = []
  const db = {
    purchaseOrderLine: {
      findMany: async (args: unknown) => {
        findManyCalls.push(args)
        return [
          { id: 'line-1', unitCostForeign: '10', totalForeign: '100', taxForeign: '20' },
          { id: 'line-2', unitCostForeign: '5.555555', totalForeign: '20', taxForeign: '4' },
        ]
      },
      update: async (args: unknown) => {
        lineUpdates.push(args)
        return {}
      },
    },
    freightCostLine: {
      findMany: async (args: unknown) => {
        findManyCalls.push(args)
        return [
          { id: 'freight-1', amountForeign: '12' },
        ]
      },
      update: async (args: unknown) => {
        freightUpdates.push(args)
        return {}
      },
    },
  }

  const purchaseOrderUpdates = await rebasePurchaseOrderStoredBaseAmounts(db, 'po-1', {
    subtotalForeign: '120',
    taxForeign: '24',
    totalForeign: '156',
    directFreightForeign: '12',
  }, 1.2)

  assert.deepEqual(findManyCalls, [
    {
      where: { poId: 'po-1' },
      select: { id: true, unitCostForeign: true, totalForeign: true, taxForeign: true },
    },
    {
      where: { poId: 'po-1' },
      select: { id: true, amountForeign: true },
    },
  ])
  assert.deepEqual(purchaseOrderUpdates, {
    subtotalBase: 100,
    taxBase: 20,
    totalBase: 130,
    directFreightBase: 10,
  })
  assert.deepEqual(lineUpdates, [
    {
      where: { id: 'line-1' },
      data: { unitCostBase: 8.333333, totalBase: 83.3333, taxBase: 16.6667 },
    },
    {
      where: { id: 'line-2' },
      data: { unitCostBase: 4.629629, totalBase: 16.6667, taxBase: 3.3333 },
    },
  ])
  assert.deepEqual(freightUpdates, [
    {
      where: { id: 'freight-1' },
      data: { amountBase: 10 },
    },
  ])
})

type RebaseTestState = {
  purchaseOrder: {
    currency: string
    fxRateToBase: number
    subtotalBase: number
    taxBase: number
    totalBase: number
    directFreightBase: number
  }
  lines: Array<{
    id: string
    unitCostForeign: string
    totalForeign: string
    taxForeign: string
    unitCostBase: number
    totalBase: number
    taxBase: number
  }>
  freightCostLines: Array<{
    id: string
    amountForeign: string
    amountBase: number
  }>
}

function cloneRebaseState(state: RebaseTestState): RebaseTestState {
  return {
    purchaseOrder: { ...state.purchaseOrder },
    lines: state.lines.map((line) => ({ ...line })),
    freightCostLines: state.freightCostLines.map((line) => ({ ...line })),
  }
}

/**
 * The ORDER in which the transaction touched things, so a test can assert the parent lock came before
 * any child write (o3d-6nd55 r3). Round 3 of o3d-6nd55 found three writers of `purchase_orders` and its
 * two cost-row children taking the CHILDREN FIRST, which deadlocks against the WMS alignment's
 * parent-then-children order. This one — the fx rebase — is fixed by
 * `lockPurchaseOrdersWithCostRows` inside `rebasePurchaseOrderStoredBaseAmountsWithParentUpdate`, and
 * this trace is what stops the fix being removed silently.
 */
function createTransactionalRebaseDb(
  state: RebaseTestState,
  options: { throwOnParentUpdate?: boolean } = {},
) {
  const trace: string[] = []
  return {
    trace,
    $transaction: async <T>(fn: (tx: PurchaseOrderFxRebaseTransactionDb<RebaseTestState['purchaseOrder']>) => Promise<T>) => {
      const txState = cloneRebaseState(state)
      const tx: PurchaseOrderFxRebaseTransactionDb<RebaseTestState['purchaseOrder']> = {
        // The lock statements the helper issues. Recorded, not just accepted: `$queryRaw` became a
        // REQUIRED member of this type precisely so the lock is taken inside the writing function, and a
        // double that swallowed it would hide the fix being deleted.
        $queryRaw: (async (strings: unknown, ...values: unknown[]) => {
          const sql = Array.isArray(strings) ? (strings as string[]).join('?') : String(strings)
          const table = /purchase_order_lines/.test(sql)
            ? 'purchase_order_lines'
            : /freight_cost_lines/.test(sql)
              ? 'freight_cost_lines'
              : /purchase_orders/.test(sql)
                ? 'purchase_orders'
                : 'other'
          trace.push(`lock:${table}`)
          void values
          return []
        }) as PurchaseOrderFxRebaseTransactionDb<RebaseTestState['purchaseOrder']>['$queryRaw'],
        purchaseOrderLine: {
          findMany: async () => txState.lines.map((line) => ({
            id: line.id,
            unitCostForeign: line.unitCostForeign,
            totalForeign: line.totalForeign,
            taxForeign: line.taxForeign,
          })),
          update: async ({ where, data }) => {
            trace.push('write:purchase_order_lines')
            const line = txState.lines.find((candidate) => candidate.id === where.id)
            assert.ok(line)
            Object.assign(line, data)
            return {}
          },
        },
        freightCostLine: {
          findMany: async () => txState.freightCostLines.map((line) => ({
            id: line.id,
            amountForeign: line.amountForeign,
          })),
          update: async ({ where, data }) => {
            trace.push('write:freight_cost_lines')
            const line = txState.freightCostLines.find((candidate) => candidate.id === where.id)
            assert.ok(line)
            Object.assign(line, data)
            return {}
          },
        },
        purchaseOrder: {
          update: async ({ data }) => {
            trace.push('write:purchase_orders')
            if (options.throwOnParentUpdate) {
              throw new Error('parent update failed')
            }
            Object.assign(txState.purchaseOrder, data)
            return txState.purchaseOrder
          },
        },
      }

      const result = await fn(tx)
      Object.assign(state.purchaseOrder, txState.purchaseOrder)
      state.lines = txState.lines
      state.freightCostLines = txState.freightCostLines
      return result
    },
  }
}

test('purchase-order FX rebase commits child and parent base updates in one transaction', async () => {
  const state: RebaseTestState = {
    purchaseOrder: {
      currency: 'GBP',
      fxRateToBase: 1,
      subtotalBase: 120,
      taxBase: 24,
      totalBase: 156,
      directFreightBase: 12,
    },
    lines: [
      {
        id: 'line-1',
        unitCostForeign: '10',
        totalForeign: '100',
        taxForeign: '20',
        unitCostBase: 10,
        totalBase: 100,
        taxBase: 20,
      },
    ],
    freightCostLines: [
      { id: 'freight-1', amountForeign: '12', amountBase: 12 },
    ],
  }

  const transactionalDb = createTransactionalRebaseDb(state)
  const po = await rebasePurchaseOrderStoredBaseAmountsWithParentUpdate(
    transactionalDb,
    'po-1',
    {
      subtotalForeign: '120',
      taxForeign: '24',
      totalForeign: '156',
      directFreightForeign: '12',
    },
    1.2,
    { data: { currency: 'EUR', fxRateToBase: 1.2 } },
  )

  assert.deepEqual(po, {
    currency: 'EUR',
    fxRateToBase: 1.2,
    subtotalBase: 100,
    taxBase: 20,
    totalBase: 130,
    directFreightBase: 10,
  })
  assert.equal(state.lines[0]?.unitCostBase, 8.333333)
  assert.equal(state.lines[0]?.totalBase, 83.3333)
  assert.equal(state.lines[0]?.taxBase, 16.6667)
  assert.equal(state.freightCostLines[0]?.amountBase, 10)

  // ─── o3d-6nd55 r3: THE PARENT IS LOCKED BEFORE ANY CHILD IS WRITTEN ───
  //
  // This rebase used to write the lines and the freight cost lines and only then update the parent
  // order, i.e. it acquired the CHILDREN and then wanted the PARENT. The WMS stock-sync alignment
  // takes them the other way round — it must, since it has to hold the parent before it can trust
  // what its cost rows say — so the pair was a deadlock: PostgreSQL aborts one side, failing either an
  // operator's fx edit or a SKU's alignment. Found by the writer census in
  // lib/domain/wms/transfer-asn-lock-order.ts, which round 3 required after two examples turned out
  // not to be every participant.
  //
  // WHAT THIS ASSERTS, AND WHAT IT DOES NOT. It asserts the ACQUISITION ORDER inside this function
  // against a recording double: the three lock statements come first, `purchase_orders` first of all,
  // and every write follows them. It does NOT prove the absence of a deadlock against a real
  // PostgreSQL — that is what
  // tests/concurrency/mintsoft-align-up-stock-receipt-journal.concurrent.test.ts's interleaving arm
  // does, on real row locks, for the freight-cost-edit path. This one is the cheap universal check
  // that the lock has not simply been deleted.
  const trace = transactionalDb.trace
  console.log(`[o3d-6nd55 r3] fx rebase acquisition trace: ${JSON.stringify(trace)}`)
  const firstWrite = trace.findIndex((entry) => entry.startsWith('write:'))
  const parentLock = trace.indexOf('lock:purchase_orders')
  assert.notEqual(parentLock, -1, 'the parent order must be locked at all — the lock statement is absent')
  assert.notEqual(firstWrite, -1, 'PRECONDITION: the rebase must have written something, or this proves nothing')
  assert.ok(
    parentLock < firstWrite,
    `the parent lock must precede every child write; trace was ${JSON.stringify(trace)}`,
  )
  assert.deepEqual(
    trace.slice(0, 3),
    ['lock:purchase_orders', 'lock:purchase_order_lines', 'lock:freight_cost_lines'],
    'and the three locks must be taken in the one documented order, parent first',
  )
})

test('purchase-order FX rebase rolls back child base updates when parent update fails', async () => {
  const state: RebaseTestState = {
    purchaseOrder: {
      currency: 'GBP',
      fxRateToBase: 1,
      subtotalBase: 120,
      taxBase: 24,
      totalBase: 156,
      directFreightBase: 12,
    },
    lines: [
      {
        id: 'line-1',
        unitCostForeign: '10',
        totalForeign: '100',
        taxForeign: '20',
        unitCostBase: 10,
        totalBase: 100,
        taxBase: 20,
      },
    ],
    freightCostLines: [
      { id: 'freight-1', amountForeign: '12', amountBase: 12 },
    ],
  }

  await assert.rejects(
    () => rebasePurchaseOrderStoredBaseAmountsWithParentUpdate(
      createTransactionalRebaseDb(state, { throwOnParentUpdate: true }),
      'po-1',
      {
        subtotalForeign: '120',
        taxForeign: '24',
        totalForeign: '156',
        directFreightForeign: '12',
      },
      1.2,
      { data: { currency: 'EUR', fxRateToBase: 1.2 } },
    ),
    /parent update failed/,
  )

  assert.deepEqual(state, {
    purchaseOrder: {
      currency: 'GBP',
      fxRateToBase: 1,
      subtotalBase: 120,
      taxBase: 24,
      totalBase: 156,
      directFreightBase: 12,
    },
    lines: [
      {
        id: 'line-1',
        unitCostForeign: '10',
        totalForeign: '100',
        taxForeign: '20',
        unitCostBase: 10,
        totalBase: 100,
        taxBase: 20,
      },
    ],
    freightCostLines: [
      { id: 'freight-1', amountForeign: '12', amountBase: 12 },
    ],
  })
})

test('purchase-order rate-only update re-resolves stored FX rate and persists rebased values', async () => {
  const asOf = new Date('2026-06-11T12:00:00.000Z')
  const fxRateQueries: unknown[] = []
  const state: RebaseTestState = {
    purchaseOrder: {
      currency: 'GBP',
      fxRateToBase: 1,
      subtotalBase: 120,
      taxBase: 24,
      totalBase: 156,
      directFreightBase: 12,
    },
    lines: [
      {
        id: 'line-1',
        unitCostForeign: '10',
        totalForeign: '100',
        taxForeign: '20',
        unitCostBase: 10,
        totalBase: 100,
        taxBase: 20,
      },
    ],
    freightCostLines: [
      { id: 'freight-1', amountForeign: '12', amountBase: 12 },
    ],
  }
  const db = {
    ...createTransactionalRebaseDb(state),
    fxRate: {
      findFirst: async (args: unknown) => {
        fxRateQueries.push(args)
        return { rate: 1.18, fetchedAt: new Date('2026-06-11T00:00:00.000Z') }
      },
    },
  }

  const po = await updatePurchaseOrderFxRateOnly(
    db,
    'po-1',
    {
      currency: 'GBP',
      subtotalForeign: '120',
      taxForeign: '24',
      totalForeign: '156',
      directFreightForeign: '12',
    },
    { currency: 'EUR' },
    {
      baseCurrency: 'GBP',
      asOf,
      parentUpdate: { data: {} },
    },
  )

  assert.deepEqual(fxRateQueries, [
    {
      where: {
        fromCurrency: 'GBP',
        toCurrency: 'EUR',
        fetchedAt: { lte: asOf },
      },
      orderBy: { fetchedAt: 'desc' },
      select: { rate: true, fetchedAt: true },
    },
  ])
  assert.deepEqual(po, {
    currency: 'EUR',
    fxRateToBase: 1.18,
    subtotalBase: 101.6949,
    taxBase: 20.339,
    totalBase: 132.2034,
    directFreightBase: 10.1695,
  })
  assert.equal(state.lines[0]?.unitCostBase, 8.474576)
  assert.equal(state.lines[0]?.totalBase, 84.7458)
  assert.equal(state.lines[0]?.taxBase, 16.9492)
  assert.equal(state.freightCostLines[0]?.amountBase, 10.1695)
})
