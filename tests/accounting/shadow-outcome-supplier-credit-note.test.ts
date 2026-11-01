import { isLockedPluginSelectionRead, lockedPluginSelectionRows } from '../helpers/plugin-selection-double.ts'
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'

/**
 * A SHADOWED SUPPLIER CREDIT-NOTE ENQUEUE IS NOT A QUEUED POSTING.
 *
 * The producer-side hold records a shadow INSTEAD of queuing the ACCPAYCREDIT. The enqueue used to answer `queued: true`
 * for it, so `postSupplierCreditNote` took the transit-subledger movement guard (`if (queued)`) as passed and wrote a
 * transit row (-net) for a journal the ledger will never receive from IMS, then logged an unqualified "Posted".
 *
 * DRIVEN THROUGH THE REAL SERVER ACTION AND THE REAL IN-TRANSACTION ENQUEUE. Only the row-creating primitive is a double,
 * because it is the thing that says "shadow" (the producer seam itself is covered in tests/db/xero-producer-seam.test.ts).
 * The transit-subledger writer is a RECORDER, so "no transit row" is an observed zero and the control arm observes one.
 */

let enabledPlugins: string[] = ['xero']
let pluginReads = 0
let flipAfterReads: { reads: number; to: string[] } | null = null
let qboSyncEnabled = 'true'

mock.module('@/lib/integration-plugins', {
  namedExports: {
    isIntegrationPluginEnabled: async (id: string) => {
      const answer = enabledPlugins.includes(id)
      pluginReads++
      if (flipAfterReads && pluginReads >= flipAfterReads.reads) enabledPlugins = flipAfterReads.to
      return answer
    },
  },
})
mock.module('@/lib/connectors/xero/settings', {
  namedExports: {
    getXeroSettings: async () => ({
      xero_sync_enabled: 'true',
      xero_sync_purchase_credit_note: 'submitted',
      xero_transit_account: 'X-TRANSIT',
      xero_inventory_account: 'X-INV',
    }),
  },
})
// o3d-j625 r12 (merging o3d-remove-parked-connectors): the SECOND CONNECTOR'S SETTINGS MOCK WAS HERE, and
// removing it is not cosmetic — `mock.module` RESOLVES its specifier, so a mock of an archived module makes
// the whole file fail to load with ERR_MODULE_NOT_FOUND. Every case that needed the second connector's
// chart is adapted or removed above/below, each saying which.
mock.module('@/lib/auth', {
  namedExports: {
    auth: async () => ({ user: { id: 'u1', email: 'u@example.test', name: 'U', role: 'ADMIN', supplierId: null, sessionInvalidReason: null, totpEnabled: false, totpVerified: false } }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => undefined, revalidateTag: () => undefined } })
const activity: Array<{ action: string; description?: string; metadata?: Record<string, unknown> }> = []
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: { action: string; description?: string; metadata?: Record<string, unknown> }) => { activity.push(entry) },
    logActivityPersisted: async () => true,
  },
})
// The facade's in-transaction enqueue collaborators — doubled exactly as chart-connector-routing.test.ts
// doubles them, so a refusal is attributable to the chart check and not to an order-lock guard.
mock.module('@/lib/domain/accounting/enqueue-order-guard', {
  namedExports: {
    resolveAccountingEnqueueOrderScope: async () => ({ scope: 'none' as const }),
    lockOrderForAccountingEnqueue: async () => false,
    findStaleOrderLevelDiscount: async () => null,
    logStaleOrderDiscountEnqueue: async () => undefined,
  },
})
mock.module('@/lib/connectors/accounting-id-provenance', { namedExports: { activeAccountingIdProvenance: async () => ({}) } })
mock.module('@/lib/connectors/accounting-connection-provenance', {
  namedExports: {
    stampAccountingPayloadConnection: (payload: Record<string, unknown>) => payload,
    mintAccountingConnectionProvenanceColumn: () => null,
  },
})
mock.module('@/lib/domain/accounting/accounting-event-mirror', { namedExports: { mirrorAccountingSyncLogToEvent: async () => undefined } })
mock.module('@/lib/connectors/xero/outbox', { namedExports: { scheduleXeroAccountingOutbox: async () => undefined } })
mock.module('@/lib/domain/accounting/followup-scope-lock', { namedExports: { lockFollowUpScope: async () => undefined } })
mock.module('@/lib/db/savepoint', { namedExports: { withSavepoint: async <T>(_tx: unknown, fn: () => Promise<T>): Promise<T> => fn() } })
const transitRows: unknown[] = []
mock.module('@/lib/domain/accounting/transit-subledger-movement', { namedExports: { recordTransitSubledgerMovement: async (_tx: unknown, row: unknown) => { transitRows.push(row) } } })
let rowMode: 'live' | 'shadow' = 'live'
mock.module('@/lib/domain/accounting/sync-log-row', {
  namedExports: {
    createAccountingSyncLogRow: async (_tx: unknown, data: { connector: string; type: string }) => {
      if (rowMode === 'shadow') return { row: null, suppressed: null, shadowed: { id: 'shadow-1' } }
      committed.syncRows.push({ connector: data.connector, type: data.type })
      return { row: { id: 'log-1' }, suppressed: null }
    },
  },
})

const committed = { posted: 0, syncRows: [] as Array<{ connector: string; type: string }> }

const CREDIT_NOTE = {
  id: 'cn-1', poId: 'po-1', supplierId: 'sup-1', currency: 'GBP', fxRateToBase: new Prisma.Decimal('1'),
  amountForeign: new Prisma.Decimal('20'), creditNoteNumber: 'CN-1', reference: null, reason: null, status: 'DRAFT',
  purchaseInvoice: null,
  po: { reference: 'PO-1', type: 'GOODS', supplier: { name: 'Supplier', taxRate: null }, lines: [] },
}

function transactionClient(pending: Array<() => void>) {
  // Any model the enqueue reads that this file does not model answers "nothing there" — a missing
  // delegate would otherwise throw and the control case would fail for a reason unrelated to the gate.
  const empty = { findFirst: async () => null, findUnique: async () => null, findMany: async () => [], count: async () => 0 }
  const modelled = {
    supplierCreditNote: {
      updateMany: async () => { pending.push(() => { committed.posted++ }); return { count: 1 } },
    },
    accountingSyncLog: {
      findMany: async () => [],
      findFirst: async () => null,
      create: async () => ({ id: 'log-1' }),
    },
    activityLog: { create: async () => ({ id: 'a-1' }) },
    $executeRaw: async () => 1,
    // o3d-j625 r13: the selection FENCE now runs on every enqueue (see tests/helpers/plugin-selection-double.ts).
    // Answered from `enabledPlugins`, the same source the `isIntegrationPluginEnabled` mock above answers
    // from, so this fixture cannot hold two disagreeing notions of which connector is active.
    $queryRaw: async (query: TemplateStringsArray) => (
      isLockedPluginSelectionRead(query) ? lockedPluginSelectionRows(enabledPlugins) : []
    ),
  }
  return new Proxy(modelled as Record<string, unknown>, {
    get: (target, key: string) => (key in target ? target[key] : empty),
  })
}

const dbModelled: Record<string, unknown> = {
  supplierCreditNote: { findUnique: async () => CREDIT_NOTE },
  setting: { findUnique: async () => null },
  accountingToken: { findFirst: async () => null },
  $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const pending: Array<() => void> = []
    const result = await fn(transactionClient(pending))
    for (const apply of pending) apply()
    return result
  },
}
mock.module('@/lib/db', {
  namedExports: {
    // Unmodelled models answer "nothing there", for the reason given on the transaction client.
    db: new Proxy(dbModelled, {
      get: (target, key: string) => (key in target
        ? target[key]
        : { findFirst: async () => null, findUnique: async () => null, findMany: async () => [], count: async () => 0 }),
    }),
  },
})

function reset(flip: { reads: number; to: string[] } | null, qboSync = 'true') {
  enabledPlugins = ['xero']
  pluginReads = 0
  flipAfterReads = flip
  qboSyncEnabled = qboSync
  committed.posted = 0
  committed.syncRows = []
  activity.length = 0
  transitRows.length = 0
  rowMode = 'live'
}

async function post() {
  const { postSupplierCreditNote } = await import('@/app/actions/purchase-orders')
  return postSupplierCreditNote('cn-1')
}


test('CONTROL: a live enqueue queues the ACCPAYCREDIT, writes the transit row and logs a plain "Posted"', async () => {
  reset(null)
  const result = await post()
  assert.equal(result.success, true, JSON.stringify(result))
  assert.equal(committed.posted, 1)
  assert.deepEqual(committed.syncRows, [{ connector: 'xero', type: 'PURCHASE_CREDIT_NOTE' }])
  assert.equal(transitRows.length, 1, 'PRECONDITION: the rig sees a transit row when the posting is really queued')
  const record = activity.find((a) => a.action === 'supplier_credit_note_posted')
  assert.equal(record?.metadata?.accountingShadowed, false)
})

test('THE FINDING: a SHADOWED enqueue writes NO transit subledger row, is not rolled back to DRAFT, and is logged as IMS-only', async () => {
  reset(null)
  rowMode = 'shadow'
  const result = await post()
  assert.equal(result.success, true, `nothing is owed, so the credit note is not refused: ${JSON.stringify(result)}`)
  assert.equal(committed.posted, 1, 'the credit note stands POSTED in IMS')
  assert.equal(committed.syncRows.length, 0, 'nothing was queued')
  assert.deepEqual(transitRows, [], 'a transit movement mirrors a QUEUED journal; a shadow is not one')
  const record = activity.find((a) => a.action === 'supplier_credit_note_posted')
  assert.equal(record?.metadata?.accountingShadowed, true)
  assert.match(String(record?.description ?? ''), /IMS ONLY/)
  assert.equal(activity.some((a) => a.action === 'supplier_credit_note_not_posted'), false)
})
