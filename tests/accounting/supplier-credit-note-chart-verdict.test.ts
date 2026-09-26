import { isLockedPluginSelectionRead, lockedPluginSelectionRows } from '../helpers/plugin-selection-double.ts'
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'

/**
 * o3d-j625 r4 (Codex HIGH 2) — THE SUPPLIER CREDIT NOTE'S POSTING GATE, DRIVEN THROUGH THE REAL SERVER
 * ACTION AND THE REAL ACCOUNTING FACADE.
 *
 * `postSupplierCreditNote` read the chart (`getAccountingSettings()`), then asked
 * `isAccountingSyncTypeEnabled('PURCHASE_CREDIT_NOTE')` — which resolves the active connector AGAIN. If
 * the active connector changed or was disabled in between, that answered `false`, `shouldQueueXero` was
 * `false`, the enqueue and its chart guard were never reached, and the transaction still claimed
 * DRAFT→POSTED: a posted supplier credit with no ledger entry.
 *
 * NOTHING ABOUT THE DECISION IS STUBBED. The plugin selection and both connectors' settings are the
 * inputs; `getAccountingSettings`, `accountingPostingVerdictForChart` and the in-transaction enqueue are
 * the real ones. The selection flips after the chart read, which is the interleaving in the finding. The
 * database double commits a transaction's writes only if its callback resolves.
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
const activity: Array<{ action: string; metadata?: Record<string, unknown> }> = []
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: { action: string; metadata?: Record<string, unknown> }) => { activity.push(entry) },
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
mock.module('@/lib/domain/accounting/transit-subledger-movement', { namedExports: { recordTransitSubledgerMovement: async () => undefined } })

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
      create: async ({ data }: { data: { connector: string; type: string } }) => {
        pending.push(() => committed.syncRows.push({ connector: data.connector, type: data.type }))
        return { id: 'log-1', ...data }
      },
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
}

async function post() {
  const { postSupplierCreditNote } = await import('@/app/actions/purchase-orders')
  return postSupplierCreditNote('cn-1')
}

test('[o3d-j625 r4 HIGH 2] PRECONDITION: with no switch the credit note is POSTED and its Xero row is written — the rig can see a posting', async () => {
  reset(null)
  const result = await post()
  assert.equal(result.success, true, JSON.stringify(result))
  assert.equal(committed.posted, 1)
  assert.deepEqual(committed.syncRows, [{ connector: 'xero', type: 'PURCHASE_CREDIT_NOTE' }])
})

// o3d-j625 r12 (merging o3d-remove-parked-connectors): the matrix had a second row — "the active
// connector SWITCHES to a QuickBooks with sync off after the chart read". An unregistered plugin flag
// resolves to NO active connector now, so that row became a duplicate of the first rather than a second
// state, and a duplicate row dressed as a matrix is how a test comes to look broader than it is. One row,
// and the state it drives is the one that remains: the chart is retired because nothing is active.
for (const [label, flip, qboSync] of [
  ['the active connector is DISABLED after the chart read', { reads: 1, to: [] as string[] }, 'true'],
] as const) {
  test(`[o3d-j625 r4 HIGH 2] ${label}: the credit note is NOT posted with no ledger entry — it is refused and stays DRAFT`, async () => {
    reset({ reads: flip.reads, to: [...flip.to] }, qboSync)
    const result = await post()
    assert.ok(pluginReads >= 2, `PRECONDITION: the selection was read again after the chart (reads: ${pluginReads})`)
    assert.equal(committed.syncRows.length, 0, 'no ledger row exists for this credit note')
    assert.equal(committed.posted, 0, 'THE FINDING: a POSTED credit note with no ledger entry must not be committed')
    assert.equal(result.success, false)
    const record = activity.find((a) => a.action === 'supplier_credit_note_not_posted')
    assert.equal(record?.metadata?.declineReason, 'chart-retired', 'reported as a refusal, not as posting switched off')
  })
}

// o3d-j625 r12 (merging o3d-remove-parked-connectors) — REMOVED, no subject.
//
// '[o3d-j625 r4 HIGH 2] CONTROL: an AGREEING QuickBooks chart still posts LOCALLY — the no-poster escape
// valve is untouched' needed a connector that has NO ACCPAYCREDIT poster, so that an agreeing chart posts
// in IMS and queues nothing. The one registered connector HAS that poster, so the escape valve cannot be
// exercised at all. It was a control for the refusals above — it showed they were refusals and not the
// escape valve firing — and losing it is a real weakening, recorded in o3d-5ktph. Verbatim at
// `git show da093f85:tests/accounting/supplier-credit-note-chart-verdict.test.ts`.
