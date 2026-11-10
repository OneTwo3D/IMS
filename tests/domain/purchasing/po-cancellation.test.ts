import assert from 'node:assert/strict'
import test from 'node:test'

import type { PurchaseOrderStatus } from '@/app/generated/prisma/client'
import {
  cancelPurchaseOrderService,
  type CancelPurchaseOrderServiceDeps,
} from '@/lib/domain/purchasing/cancellation-service'
import {
  assertPurchaseOrderCancellationHasNoInvoices,
  isPurchaseOrderCancellationNoop,
} from '@/lib/domain/purchasing/po-cancellation'
import type { RetireOutcome } from '@/lib/domain/purchasing/po-close-short'

test('assertPurchaseOrderCancellationHasNoInvoices rejects billed purchase orders', () => {
  assert.doesNotThrow(() => assertPurchaseOrderCancellationHasNoInvoices(0))
  assert.throws(
    () => assertPurchaseOrderCancellationHasNoInvoices(1),
    /Cannot cancel a purchase order after supplier invoices have been recorded/,
  )
})

test('isPurchaseOrderCancellationNoop treats already cancelled purchase orders as idempotent', () => {
  assert.equal(isPurchaseOrderCancellationNoop('CANCELLED'), true)
  assert.equal(isPurchaseOrderCancellationNoop('PO_SENT'), false)
  assert.equal(isPurchaseOrderCancellationNoop('RECEIVED'), false)
})

type Po = {
  status: PurchaseOrderStatus
  reference: string
  type?: 'GOODS' | 'FREIGHT'
  invoices?: Array<{ id: string; totalBase: number }>
  creditNotes?: unknown[]
}

type UpdatableTx = { purchaseOrder: { update: (args: { data: { status: PurchaseOrderStatus } }) => Promise<unknown> } }

function makeDeps(po: Po, overrides: Partial<CancelPurchaseOrderServiceDeps> = {}) {
  const logs: Array<{ action: string; description: string; entityId?: string | null; metadata?: unknown; level?: string }> = []
  const calls = { transactions: 0, retire: 0, recalc: 0 }
  const tx = {
    $queryRaw: async () => [],
    purchaseOrder: {
      findUnique: async () => ({
        status: po.status,
        reference: po.reference,
        type: po.type ?? 'GOODS',
        invoices: po.invoices ?? [],
        supplierCreditNotes: po.creditNotes ?? [],
      }),
      update: async ({ data }: { data: { status: PurchaseOrderStatus } }) => {
        po.status = data.status
        return { id: 'po' }
      },
    },
  }
  const deps: CancelPurchaseOrderServiceDeps = {
    findPurchaseOrderFast: async () => ({ status: po.status, reference: po.reference }),
    transaction: async (fn) => {
      calls.transactions += 1
      return fn(tx as never)
    },
    logActivity: async (input) => {
      logs.push({ action: input.action, description: input.description, entityId: input.entityId, metadata: input.metadata, level: input.level })
    },
    // Nothing landed, no billed-ahead: runs the caller's gate, then writes CANCELLED like the real function.
    retirePurchaseOrderLocked: async (txArg, _id, _intent, beforeWrite) => {
      calls.retire += 1
      beforeWrite?.({ keptReceivedStock: false })
      await (txArg as unknown as UpdatableTx).purchaseOrder.update({ data: { status: 'CANCELLED' } })
      return {
        reference: po.reference,
        previousStatus: 'DRAFT',
        newStatus: 'CANCELLED',
        keptReceivedStock: false,
        landedQty: 0,
        droppedQty: 5,
        billedAhead: [],
        landedCostRecalc: null,
      } satisfies RetireOutcome
    },
    // Not invoked for GOODS POs (type !== 'FREIGHT'); counts so a test can prove it.
    recalculateLandedCosts: (async () => { calls.recalc += 1; return {} as never }) as never,
    queueLandedCostAdjustmentJournals: async () => ({ owed: 0 }),
    ...overrides,
  }
  return { deps, logs, calls }
}

function closeShortRetire(outcome: Partial<RetireOutcome> & { reference: string }): CancelPurchaseOrderServiceDeps['retirePurchaseOrderLocked'] {
  return async (txArg, _id, _intent, beforeWrite) => {
    beforeWrite?.({ keptReceivedStock: true })
    await (txArg as unknown as UpdatableTx).purchaseOrder.update({ data: { status: 'CLOSED' } })
    return {
      previousStatus: 'PARTIALLY_RECEIVED',
      newStatus: 'CLOSED',
      keptReceivedStock: true,
      landedQty: 60,
      droppedQty: 40,
      billedAhead: [],
      landedCostRecalc: null,
      ...outcome,
    } satisfies RetireOutcome
  }
}

test('cancelPurchaseOrderService is idempotent when called twice', async () => {
  const po: Po = { status: 'DRAFT', reference: 'PO-1' }
  const { deps, logs, calls } = makeDeps(po)

  const first = await cancelPurchaseOrderService('po-1', deps)
  assert.equal(first.success, true)
  assert.equal(po.status, 'CANCELLED')
  assert.equal(first.closedShort, undefined)

  assert.deepEqual(await cancelPurchaseOrderService('po-1', deps), { success: true })

  assert.equal(calls.transactions, 1)
  assert.equal(calls.retire, 1)
  assert.deepEqual(logs.map((log) => log.action), ['cancelled', 'cancelled_noop'])
})

test('cancelling a part-received PO closes it short: the order ends CLOSED, the result says so, nothing is reversed or posted', async () => {
  const po: Po = { status: 'PARTIALLY_RECEIVED', reference: 'PO-9' }
  const { deps, logs } = makeDeps(po, { retirePurchaseOrderLocked: closeShortRetire({ reference: 'PO-9' }) })
  const result = await cancelPurchaseOrderService('po-9', deps)
  assert.equal(result.success, true)
  assert.equal(result.closedShort, true)
  assert.equal(po.status, 'CLOSED')
  assert.match(result.notice ?? '', /closed short/)
  assert.match(result.notice ?? '', /40 unit\(s\) still due were dropped/)
  assert.match(result.notice ?? '', /60 unit\(s\) received stay in stock/)
  assert.equal('reversedCostLayers' in result, false)
  const log = logs.find((l) => l.action === 'cancelled_closed_short')
  assert.ok(log, 'the close-short is logged under its own action')
  assert.equal((log!.metadata as { keptReceivedStock: boolean }).keptReceivedStock, true)
})

test('the supplier-bill gate applies only when nothing landed: a billed order with nothing received is refused, a billed part-received one closes short', async () => {
  const billed = [{ id: 'inv-1', totalBase: 100 }]
  const nothingLanded: Po = { status: 'PO_SENT', reference: 'PO-B1', invoices: billed }
  const refused = await cancelPurchaseOrderService('po-b1', makeDeps(nothingLanded, {
    retirePurchaseOrderLocked: async (_tx, _id, _intent, beforeWrite) => {
      beforeWrite?.({ keptReceivedStock: false })
      throw new Error('the bill gate did not throw')
    },
  }).deps)
  assert.equal(refused.success, false)
  assert.match(refused.error ?? '', /Cannot cancel a purchase order after supplier invoices have been recorded/)
  assert.equal(nothingLanded.status, 'PO_SENT')

  const partReceived: Po = { status: 'PARTIALLY_RECEIVED', reference: 'PO-B2', invoices: billed }
  const ok = await cancelPurchaseOrderService('po-b2', makeDeps(partReceived, {
    retirePurchaseOrderLocked: closeShortRetire({ reference: 'PO-B2', landedQty: 3, droppedQty: 2 }),
  }).deps)
  assert.equal(ok.success, true)
  assert.equal(partReceived.status, 'CLOSED')
})

test('a billed-ahead-of-receipt close warns and logs a WARNING, and does not refuse', async () => {
  const po: Po = { status: 'PARTIALLY_RECEIVED', reference: 'PO-W' }
  const { deps, logs } = makeDeps(po, {
    retirePurchaseOrderLocked: closeShortRetire({
      reference: 'PO-W',
      billedAhead: [{ poLineId: 'l1', sku: 'SKU-1', billedQty: 100, landedQty: 60, excessQty: 40, excessValueBase: 200 }],
    }),
  })
  const result = await cancelPurchaseOrderService('po-w', deps)
  assert.equal(result.success, true)
  assert.equal(result.warnings?.length, 1)
  assert.match(result.warnings![0]!, /SKU-1: billed 100, received 60/)
  assert.equal(logs.find((l) => l.action === 'closed_billed_ahead_of_receipt')?.level, 'WARNING')
})

test('a refusal from the retire step (live ASN) is returned and nothing is logged as cancelled', async () => {
  const po: Po = { status: 'PO_SENT', reference: 'PO-A' }
  const { deps, logs } = makeDeps(po, {
    retirePurchaseOrderLocked: async () => { throw new Error('Cannot cancel PO-A: SKU-1 (ASN 55, OPEN) has an open warehouse ASN.') },
  })
  const result = await cancelPurchaseOrderService('po-a', deps)
  assert.equal(result.success, false)
  assert.match(result.error ?? '', /open warehouse ASN/)
  assert.equal(po.status, 'PO_SENT')
  assert.deepEqual(logs.map((l) => `${l.action}:${l.level}`), ['cancelled:ERROR'])
})

test('audit-C3: cancelling a FREIGHT PO recalculates landed costs and surfaces the COGS corrections', async () => {
  const po: Po = { status: 'DRAFT', reference: 'FRT-1', type: 'FREIGHT' }
  let recalcCalledWithFreightPoId: string | null = null
  let recalcRanAfterStatusFlip = false
  let statusFlipped = false
  let journalsQueued = false
  const base = makeDeps(po)
  const flipTx = {
    $queryRaw: async () => [],
    purchaseOrder: {
      findUnique: async () => ({ status: po.status, reference: po.reference, type: 'FREIGHT', invoices: [], supplierCreditNotes: [] }),
      update: async ({ data }: { data: { status: PurchaseOrderStatus } }) => {
        po.status = data.status
        statusFlipped = true
        return { id: 'frt-1' }
      },
    },
  }
  const deps: CancelPurchaseOrderServiceDeps = {
    ...base.deps,
    transaction: async (fn) => fn(flipTx as never),
    recalculateLandedCosts: (async (_tx: unknown, freightPoId: string) => {
      recalcCalledWithFreightPoId = freightPoId
      recalcRanAfterStatusFlip = statusFlipped
      return {
        revalidatePoIds: ['primary-1'],
        auditRunIds: ['audit-1'],
        cogsAdjustments: [{ primaryPoId: 'primary-1', primaryPoRef: 'PO-1', totalDelta: -12.5 }],
        inventoryTransitAdjustments: [],
        warnings: [],
      }
    }) as never,
    queueLandedCostAdjustmentJournals: async () => { journalsQueued = true; return { owed: 0 } },
  }

  const result = await cancelPurchaseOrderService('frt-1', deps)
  assert.equal(result.success, true)
  // Recalc was invoked for the freight PO, AFTER its status was flipped to CANCELLED (so the recalc excludes it).
  assert.equal(recalcCalledWithFreightPoId, 'frt-1')
  assert.equal(recalcRanAfterStatusFlip, true)
  assert.ok(result.landedCostRecalc, 'expected landedCostRecalc on the result')
  assert.equal(result.landedCostRecalc?.cogsAdjustments.length, 1)
  assert.equal(journalsQueued, true)
  const cogsLog = base.logs.find((log) => log.action === 'cogs_adjusted')
  assert.ok(cogsLog, 'expected a cogs_adjusted log for the primary PO')
  assert.equal(cogsLog?.entityId, 'primary-1')
  // The goods-order retire step is never used for a freight order.
  assert.equal(base.calls.retire, 0)
})

test('audit-C3: cancelling a GOODS PO does NOT trigger a landed-cost recalc', async () => {
  const po: Po = { status: 'DRAFT', reference: 'PO-2' }
  const { deps, calls } = makeDeps(po)
  const result = await cancelPurchaseOrderService('po-2', deps)
  assert.equal(result.success, true)
  assert.equal(calls.recalc, 0)
  assert.equal(result.landedCostRecalc, undefined)
})

test('audit-g5u2.4: an invoiced FREIGHT PO fully offset by POSTED credit notes can be cancelled; uncredited is blocked', async () => {
  const mk = (creditBase: number) => {
    const po: Po = {
      status: 'PARTIALLY_RECEIVED',
      reference: 'FRT-CN',
      type: 'FREIGHT',
      invoices: [{ id: 'inv-1', totalBase: 100 }],
      creditNotes: creditBase > 0 ? [{ purchaseInvoiceId: 'inv-1', amountBase: creditBase }] : [],
    }
    return {
      po,
      ...makeDeps(po, {
        recalculateLandedCosts: (async () => ({ revalidatePoIds: [], auditRunIds: [], cogsAdjustments: [], inventoryTransitAdjustments: [], warnings: [] })) as never,
      }),
    }
  }

  // Fully credited (100 base == bill 100 base) -> cancel allowed.
  const credited = mk(100)
  const ok = await cancelPurchaseOrderService('frt-cn', credited.deps)
  assert.equal(ok.success, true)
  assert.equal(credited.po.status, 'CANCELLED')

  // Uncredited freight bill -> blocked (service catches and returns success:false).
  const uncredited = mk(0)
  const blocked = await cancelPurchaseOrderService('frt-cn', uncredited.deps)
  assert.equal(blocked.success, false)
  assert.match(blocked.error ?? '', /not fully offset by posted credit notes/)
  assert.equal(uncredited.po.status, 'PARTIALLY_RECEIVED') // unchanged
})
