import test from 'node:test'
import assert from 'node:assert/strict'

import {
  dailyBatchDateKey,
  dailyBatchReferenceWhere,
  findSalesOrderDeleteBlocker,
} from '@/lib/domain/sales/order-delete-guard'

type SyncLogRow = {
  id: string
  connector: string
  type: string
  status: string
  referenceType: string
  referenceId: string
  /** Post evidence. Present once the document exists in the ledger, regardless of status. */
  externalTransactionId?: string | null
}

type WhereNode = Record<string, unknown>

/**
 * Tiny evaluator for the exact `where` shapes order-delete-guard builds: scalar equality,
 * `{ in: [...] }`, `{ startsWith }` and `OR`. Deliberately strict — an unsupported operator
 * throws rather than silently matching, so a future guard change that emits something new
 * fails loudly here instead of quietly passing.
 */
function matches(row: SyncLogRow, where: WhereNode): boolean {
  for (const [key, condition] of Object.entries(where)) {
    if (key === 'OR') {
      const branches = condition as WhereNode[]
      if (!branches.some((branch) => matches(row, branch))) return false
      continue
    }
    if (key === 'AND') {
      const branches = condition as WhereNode[]
      if (!branches.every((branch) => matches(row, branch))) return false
      continue
    }
    const value = (row as unknown as Record<string, unknown>)[key]
    if (condition !== null && typeof condition === 'object') {
      const operators = condition as Record<string, unknown>
      for (const [operator, operand] of Object.entries(operators)) {
        if (operator === 'in') {
          if (!(operand as unknown[]).includes(value)) return false
        } else if (operator === 'startsWith') {
          if (typeof value !== 'string' || !value.startsWith(operand as string)) return false
        } else if (operator === 'not') {
          // Only `{ not: null }` is emitted — "carries an external id, whatever its status".
          if (operand === null) {
            if (value === null || value === undefined) return false
          } else if (value === operand) {
            return false
          }
        } else {
          throw new Error(`unsupported operator in test evaluator: ${operator}`)
        }
      }
      continue
    }
    if (value !== condition) return false
  }
  return true
}

function makeTx(seed: {
  pushLink?: { state: string; externalOrderId: string | null; externalOrderNumber: string | null } | null
  shipments?: string[]
  syncLogs?: SyncLogRow[]
  /** Durable external-document markers on the order itself — these survive log retention. */
  order?: { accountingInvoiceId?: string | null; invoicedAt?: Date | null }
  /** Independent WMS evidence: a status snapshot can exist with no push link. */
  wmsSnapshot?: {
    connectorLabel: string
    externalOrderNumber: string
    externalOrderId: string
    statusLabel: string
  } | null
}) {
  return {
    wmsOrderStatusSnapshot: { findUnique: async () => seed.wmsSnapshot ?? null },
    salesOrder: {
      findUnique: async () => ({
        accountingInvoiceId: seed.order?.accountingInvoiceId ?? null,
        invoicedAt: seed.order?.invoicedAt ?? null,
      }),
    },
    wmsOrderPushLink: { findUnique: async () => seed.pushLink ?? null },
    shipment: { findMany: async () => (seed.shipments ?? []).map((id) => ({ id })) },
    accountingSyncLog: {
      findFirst: async ({ where }: { where: WhereNode }) =>
        (seed.syncLogs ?? []).find((row) => matches(row, where)) ?? null,
      findMany: async ({ where }: { where: WhereNode }) =>
        (seed.syncLogs ?? []).filter((row) => matches(row, where)),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

const STAMPS = { revenueDeferredDate: null, inventoryAllocatedDate: null }
const A2_STAGED_AT = new Date('2026-07-20T23:15:00.000Z')

function syncLog(overrides: Partial<SyncLogRow>): SyncLogRow {
  return {
    id: 'log-1',
    connector: 'xero',
    type: 'SALES_INVOICE',
    status: 'PENDING',
    referenceType: 'SalesOrder',
    referenceId: 'order-1',
    externalTransactionId: null,
    ...overrides,
  }
}

test('dailyBatchDateKey maps a stage stamp to the batch UTC date, and null through', () => {
  assert.equal(dailyBatchDateKey(A2_STAGED_AT), '2026-07-20')
  assert.equal(dailyBatchDateKey('2026-07-20T23:15:00.000Z'), '2026-07-20')
  assert.equal(dailyBatchDateKey(null), null)
  assert.equal(dailyBatchDateKey(new Date('not a date')), null)
})

test('dailyBatchReferenceWhere matches both the bare and digest-suffixed referenceId shapes', () => {
  const where = dailyBatchReferenceWhere('A2', A2_STAGED_AT)
  assert.ok(where)
  // QuickBooks writes the bare `<group>-<date>`; Xero appends an 8-hex entity digest.
  assert.equal(matches(syncLog({ referenceId: 'A2-2026-07-20' }), where as WhereNode), true)
  assert.equal(matches(syncLog({ referenceId: 'A2-2026-07-20-1a2b3c4d' }), where as WhereNode), true)
  // A different day's batch must not match.
  assert.equal(matches(syncLog({ referenceId: 'A2-2026-07-21' }), where as WhereNode), false)
  assert.equal(dailyBatchReferenceWhere('A2', null), null)
})

test('an order with no external documents is deletable', async () => {
  const blocker = await findSalesOrderDeleteBlocker(makeTx({}), 'order-1', STAMPS)
  assert.equal(blocker, null)
})

test('a WMS push link — even a pre-push PENDING_CREATE claim — blocks the delete', async () => {
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({ pushLink: { state: 'PENDING_CREATE', externalOrderId: null, externalOrderNumber: null } }),
    'order-1',
    STAMPS,
  )
  assert.equal(blocker?.code, 'wms_order_push_link')
  assert.match(blocker!.message, /warehouse management system/i)
})

test('a SYNCED WMS link names the external order in the refusal', async () => {
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({ pushLink: { state: 'SYNCED', externalOrderId: 'wms-9', externalOrderNumber: 'WN-9' } }),
    'order-1',
    STAMPS,
  )
  assert.equal(blocker?.code, 'wms_order_push_link')
  assert.match(blocker!.message, /WN-9/)
})

test('a queued (PENDING) invoice blocks the delete — the worker has not posted yet, but will', async () => {
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({ syncLogs: [syncLog({ status: 'PENDING' })] }),
    'order-1',
    STAMPS,
  )
  assert.equal(blocker?.code, 'accounting_sync_live')
  assert.match(blocker!.message, /SALES_INVOICE, PENDING/)
})

test('an in-flight (PROCESSING) and an already-posted (SYNCED) invoice both block', async () => {
  for (const status of ['PROCESSING', 'SYNCED']) {
    const blocker = await findSalesOrderDeleteBlocker(
      makeTx({ syncLogs: [syncLog({ status })] }),
      'order-1',
      STAMPS,
    )
    assert.equal(blocker?.code, 'accounting_sync_live', status)
  }
})

test('a CANCELLED sync row does not block — it was deliberately retired', async () => {
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({ syncLogs: [syncLog({ status: 'CANCELLED' })] }),
    'order-1',
    STAMPS,
  )
  assert.equal(blocker, null)
})

test('a FAILED sync row DOES block — it is not proof nothing was posted (o3d-ju8t)', async () => {
  // This test previously asserted the opposite. The accounting processors make the remote call
  // BEFORE persisting SYNCED and the externalTransactionId, and an exception in that persistence
  // window is caught and can later terminalise the row as FAILED — with a real document sitting
  // in the ledger. So FAILED spans "rejected before any remote mutation" and "document exists,
  // writeback failed", and nothing durable tells them apart. Permitting an irreversible delete on
  // that basis reads absence of a success marker as a positive fact about the external system.
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({ syncLogs: [syncLog({ status: 'FAILED' })] }),
    'order-1',
    STAMPS,
  )

  assert.equal(blocker?.code, 'accounting_sync_live')
  assert.match(blocker!.message, /does not prove nothing was posted/)
  assert.match(blocker!.message, /may exist in the ledger/)
})

test('a live sync row for a DIFFERENT order does not block', async () => {
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({ syncLogs: [syncLog({ referenceId: 'order-2' })] }),
    'order-1',
    STAMPS,
  )
  assert.equal(blocker, null)
})

test('a live sync row keyed to one of the order\'s shipments blocks', async () => {
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({
      shipments: ['ship-1'],
      syncLogs: [syncLog({ type: 'COGS_JOURNAL', referenceType: 'Shipment', referenceId: 'ship-1', status: 'SYNCED' })],
    }),
    'order-1',
    STAMPS,
  )
  assert.equal(blocker?.code, 'accounting_sync_live')
})

test('a POSTED A2 batch blocks even though the batch is DailyBatch-keyed, not order-keyed', async () => {
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({
      syncLogs: [syncLog({
        id: 'a2',
        type: 'DAILY_BATCH_INVENTORY_ALLOC',
        status: 'SYNCED',
        referenceType: 'DailyBatch',
        referenceId: 'A2-2026-07-20-1a2b3c4d',
      })],
    }),
    'order-1',
    { revenueDeferredDate: null, inventoryAllocatedDate: A2_STAGED_AT },
  )
  assert.equal(blocker?.code, 'daily_batch_staged')
  assert.match(blocker!.message, /A2 inventory allocation/)
  assert.match(blocker!.message, /A2-2026-07-20-1a2b3c4d/)
})

test('a still-queued A2 batch blocks too — the order value is already inside the journal payload', async () => {
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({
      syncLogs: [syncLog({
        id: 'a2', type: 'DAILY_BATCH_INVENTORY_ALLOC', status: 'PENDING',
        referenceType: 'DailyBatch', referenceId: 'A2-2026-07-20',
      })],
    }),
    'order-1',
    { revenueDeferredDate: null, inventoryAllocatedDate: A2_STAGED_AT },
  )
  assert.equal(blocker?.code, 'daily_batch_staged')
})

test('an A2 stamp with no matching batch log does not block (batch never queued)', async () => {
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({
      syncLogs: [syncLog({
        id: 'a2', type: 'DAILY_BATCH_INVENTORY_ALLOC', status: 'SYNCED',
        referenceType: 'DailyBatch', referenceId: 'A2-2026-07-19',
      })],
    }),
    'order-1',
    { revenueDeferredDate: null, inventoryAllocatedDate: A2_STAGED_AT },
  )
  assert.equal(blocker, null)
})

test('a posted A1 revenue-deferral batch blocks on the same DailyBatch-keyed rule', async () => {
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({
      syncLogs: [syncLog({
        id: 'a1', type: 'DAILY_BATCH_REVENUE_DEFERRAL', status: 'SYNCED',
        referenceType: 'DailyBatch', referenceId: 'A1-2026-07-20-deadbeef',
      })],
    }),
    'order-1',
    { revenueDeferredDate: A2_STAGED_AT, inventoryAllocatedDate: null },
  )
  assert.equal(blocker?.code, 'daily_batch_staged')
  assert.match(blocker!.message, /A1 revenue deferral/)
})

test('an A2 batch log of the right date but wrong TYPE does not block', async () => {
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({
      syncLogs: [syncLog({
        id: 'b', type: 'DAILY_BATCH_GROUP_B', status: 'SYNCED',
        referenceType: 'DailyBatch', referenceId: 'A2-2026-07-20',
      })],
    }),
    'order-1',
    { revenueDeferredDate: null, inventoryAllocatedDate: A2_STAGED_AT },
  )
  assert.equal(blocker, null)
})

// --- o3d-v7sy: evidence that survives log retention ---------------------------

test('an order carrying an accounting invoice id blocks, even with no sync logs left', async () => {
  // Every other check in this guard reads AccountingSyncLog, and purgeExpiredData deletes those
  // rows past the retention window (six months by default). An old order can therefore hold a
  // real invoice in the external ledger, have no retained sync row, and pass every other check —
  // hard-deleted, stranding the document with no IMS order behind it. accountingInvoiceId and
  // invoicedAt live on the order itself and are never purged.
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({ syncLogs: [], order: { accountingInvoiceId: 'INV-2026-0042' } }),
    'order-1',
    STAMPS,
  )

  assert.equal(blocker?.code, 'accounting_document_exists')
  assert.match(blocker!.message, /INV-2026-0042/)
})

test('invoicedAt alone does NOT block — it is a LOCAL invoice number, not an external post', async () => {
  // generateInvoiceNumber sets invoicedAt when it merely assigns a local invoice number
  // (app/actions/sales.ts ~2680), and that action is available even with accounting sync
  // disabled. Treating it as external-post evidence would make an otherwise deletable order
  // with no payments, no sync logs and no accounting document permanently undeletable.
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({ syncLogs: [], order: { invoicedAt: new Date('2025-01-01T00:00:00.000Z') } }),
    'order-1',
    STAMPS,
  )

  assert.equal(blocker, null)
})

test('a POSTED document says it needs a REVERSAL, not a cancel (o3d-v7sy)', async () => {
  // cancelOrderInvoiceSync retires PENDING / FAILED / stale-PROCESSING rows and explicitly
  // leaves SYNCED alone, because a cancel-after-post needs an explicit reversal. Telling an
  // operator to cancel a posted invoice leaves a live receivable against a CANCELLED order.
  const posted = await findSalesOrderDeleteBlocker(
    makeTx({ syncLogs: [syncLog({ status: 'SYNCED' })] }),
    'order-1',
    STAMPS,
  )
  assert.equal(posted?.code, 'accounting_sync_live')
  assert.match(posted!.message, /explicit reversal or credit note/)
  assert.match(posted!.message, /does NOT reverse a posted document/)

  // A merely QUEUED document is genuinely retired by cancelling, so that advice stays.
  const queued = await findSalesOrderDeleteBlocker(
    makeTx({ syncLogs: [syncLog({ status: 'PENDING' })] }),
    'order-1',
    STAMPS,
  )
  assert.match(queued!.message, /Cancel the order instead/)
})

test('an order with neither marker nor logs is still deletable', async () => {
  const blocker = await findSalesOrderDeleteBlocker(makeTx({ syncLogs: [] }), 'order-1', STAMPS)
  assert.equal(blocker, null)
})

test('a PENDING row that already carries an external id is treated as POSTED (o3d-v7sy)', async () => {
  // Status is not a proxy for post evidence. Xero reverts an already-posted row to PENDING when
  // follow-up work fails, KEEPING externalTransactionId — and cancelOrderInvoiceSync excludes
  // such rows. Branching on status alone would tell an operator to cancel a document that is
  // already in the ledger, leaving a live receivable against a CANCELLED order.
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({ syncLogs: [syncLog({ status: 'PENDING', externalTransactionId: 'INV-999' })] }),
    'order-1',
    STAMPS,
  )

  assert.equal(blocker?.code, 'accounting_sync_live')
  assert.match(blocker!.message, /already POSTED as INV-999/)
  assert.match(blocker!.message, /does NOT reverse a posted document/)
  assert.doesNotMatch(blocker!.message, /Cancel the order instead/)
})

test('an in-flight PROCESSING row asks the operator to WAIT, not to cancel (o3d-v7sy)', async () => {
  // A freshly claimed PROCESSING row is deliberately excluded from cancellation — the remote
  // call may be in flight — so promising a cancel retires it is wrong here too.
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({ syncLogs: [syncLog({ status: 'PROCESSING' })] }),
    'order-1',
    STAMPS,
  )

  assert.match(blocker!.message, /IN FLIGHT/)
  assert.doesNotMatch(blocker!.message, /Cancel the order instead/)
})


test('a CANCELLED row that still carries an external id BLOCKS (o3d-v7sy)', async () => {
  // The status filter used to run first, so this row was never even selected. Xero can revert a
  // posted row to PENDING when the back-reference fails, keeping the external id, and
  // cancelOrphanedAccountingSyncRows then moves it to CANCELLED without clearing that id. If the
  // back-reference failed there is no accountingInvoiceId either — so nothing would have blocked,
  // and the posted invoice would have been stranded.
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({ syncLogs: [syncLog({ status: 'CANCELLED', externalTransactionId: 'INV-777' })] }),
    'order-1',
    STAMPS,
  )

  assert.equal(blocker?.code, 'accounting_sync_live')
  assert.match(blocker!.message, /already POSTED as INV-777/)
})

test('a POSTED row wins over a QUEUED one when both exist (o3d-v7sy)', async () => {
  // findFirst could return whichever row the database happened to yield, so a queued row could
  // mask a posted one and the operator would be told to cancel a document already in the ledger.
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({
      syncLogs: [
        syncLog({ id: 'log-queued', status: 'PENDING', type: 'COGS_JOURNAL' }),
        syncLog({ id: 'log-posted', status: 'SYNCED', externalTransactionId: 'INV-888' }),
      ],
    }),
    'order-1',
    STAMPS,
  )

  assert.match(blocker!.message, /already POSTED as INV-888/, 'the most severe remedy wins')
  assert.doesNotMatch(blocker!.message, /Cancel the order instead/)
})

test('a CANCELLED row with NO external id still does not block', async () => {
  // The widened match must not turn every retired row into a blocker.
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({ syncLogs: [syncLog({ status: 'CANCELLED' })] }),
    'order-1',
    STAMPS,
  )
  assert.equal(blocker, null)
})



test('a WMS status snapshot blocks even with NO push link (o3d-eu0r)', async () => {
  // WmsOrderStatusSnapshot is populated by looking storefront-linked orders up in the WMS, so it
  // can carry a confirmed externalOrderId for an order this IMS never pushed. Its FK is
  // onDelete: Cascade, so deleting would silently erase the only local record that the remote
  // order exists — leaving a live warehouse order nothing in IMS points at.
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({
      pushLink: null,
      wmsSnapshot: {
        connectorLabel: 'Mintsoft',
        externalOrderNumber: 'WMS-4321',
        externalOrderId: '4321',
        statusLabel: 'Processing',
      },
    }),
    'order-1',
    STAMPS,
  )

  assert.equal(blocker?.code, 'wms_order_status_snapshot')
  assert.match(blocker!.message, /WMS-4321/)
  assert.match(blocker!.message, /erase the only local record/)
})

test('the snapshot falls back to the external id when it has no order number (o3d-eu0r)', async () => {
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({
      pushLink: null,
      wmsSnapshot: {
        connectorLabel: 'ShipHero',
        externalOrderNumber: '',
        externalOrderId: 'sh-99',
        statusLabel: 'Allocated',
      },
    }),
    'order-1',
    STAMPS,
  )

  assert.match(blocker!.message, /sh-99/)
})

test('a PLACEHOLDER snapshot (WMS lookup found nothing) does NOT block (o3d-eu0r)', async () => {
  // order-status-sweep deliberately upserts a placeholder with an EMPTY externalOrderId,
  // statusLabel 'Unknown' and lastError 'Order not found in WMS' when an authoritative lookup
  // finds no order — and again after a lookup error. Nothing ever removes those rows. Treating
  // any snapshot as proof would make a storefront-linked order that never reached the WMS
  // permanently undeletable, while the refusal claimed a remote order exists.
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({
      pushLink: null,
      wmsSnapshot: {
        connectorLabel: 'Mintsoft',
        externalOrderNumber: 'SO-1',
        externalOrderId: '',
        statusLabel: 'Unknown',
      },
    }),
    'order-1',
    STAMPS,
  )

  assert.equal(blocker, null, 'positive evidence only — an empty externalOrderId proves nothing')
})

test('an in-flight accounting document outranks WMS evidence (o3d-eu0r)', async () => {
  // Several blockers can apply at once, and their remedies are NOT interchangeable. Returning
  // the WMS one first told the operator to cancel while an accounting call was still in flight —
  // which is exactly how a cancelled IMS order ends up with a live invoice in the ledger.
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({
      wmsSnapshot: {
        connectorLabel: 'Mintsoft',
        externalOrderNumber: 'WMS-1',
        externalOrderId: '1',
        statusLabel: 'Processing',
      },
      syncLogs: [syncLog({ status: 'PROCESSING' })],
    }),
    'order-1',
    STAMPS,
  )

  assert.equal(blocker?.code, 'accounting_sync_live')
  assert.match(blocker!.message, /IN FLIGHT/)
})

test('a POSTED accounting document outranks everything else (o3d-eu0r)', async () => {
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({
      pushLink: { state: 'SYNCED', externalOrderId: 'w-1', externalOrderNumber: 'WMS-1' },
      wmsSnapshot: {
        connectorLabel: 'Mintsoft',
        externalOrderNumber: 'WMS-1',
        externalOrderId: '1',
        statusLabel: 'Processing',
      },
      order: { accountingInvoiceId: 'INV-1' },
      syncLogs: [syncLog({ status: 'PENDING' })],
    }),
    'order-1',
    STAMPS,
  )

  assert.equal(blocker?.code, 'accounting_document_exists', 'a finance reversal is the most binding remedy')
})

test('with only WMS evidence, the WMS remedy is still surfaced (o3d-eu0r)', async () => {
  // Ranking must not bury the only applicable blocker.
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({
      pushLink: null,
      wmsSnapshot: {
        connectorLabel: 'Mintsoft',
        externalOrderNumber: 'WMS-7',
        externalOrderId: '7',
        statusLabel: 'Processing',
      },
    }),
    'order-1',
    STAMPS,
  )

  assert.equal(blocker?.code, 'wms_order_status_snapshot')
})
