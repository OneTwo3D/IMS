import { isLockedPluginSelectionRead, lockedPluginSelectionRows } from '../helpers/plugin-selection-double.ts'
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'

/**
 * A XERO-BOUND SUPPLIER CREDIT AGAINST A BILL WITH REVERSE-CHARGE LINES IS REFUSED, before anything is claimed (the credit stays a draft). Driven through the real server action and
 * the real accounting facade, on the harness of supplier-credit-note-chart-verdict.test.ts. The IMS credit amount is the bill's gross (net plus the self-accounted VAT) while Xero holds the
 * bill's net, so the figures cannot agree yet; the credit is raised in Xero directly. A local-only credit (sync off) and a credit against a bill with no reverse-charge line are unaffected.
 */

let enabledPlugins: string[] = ['xero']
let pluginReads = 0
let flipAfterReads: { reads: number; to: string[] } | null = null
let xeroSync = 'true'

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
      xero_sync_enabled: xeroSync,
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

let CREDIT_NOTE: Record<string, unknown> = {
  id: 'cn-1', poId: 'po-1', supplierId: 'sup-1', currency: 'GBP', fxRateToBase: new Prisma.Decimal('1'),
  amountForeign: new Prisma.Decimal('20'), creditNoteNumber: 'CN-1', reference: null, reason: null, status: 'DRAFT',
  purchaseInvoice: null,
  po: { reference: 'PO-1', type: 'GOODS', supplier: { name: 'Supplier', taxRate: null }, lines: [], freightCostLines: [] },
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
  accountingToken: { findFirst: async () => null, findUnique: async () => null },
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


const baseCredit = (amount: string, lines: Array<Record<string, unknown>>, taxForeign = '20') => ({
  id: 'cn-1', poId: 'po-1', supplierId: 'sup-1', currency: 'GBP', fxRateToBase: new Prisma.Decimal('1'),
  amountForeign: new Prisma.Decimal(amount), creditNoteNumber: 'CN-1', reference: null, reason: null, status: 'DRAFT',
  purchaseInvoice: { subtotalForeign: new Prisma.Decimal('100'), taxForeign: new Prisma.Decimal(taxForeign), accountingInvoiceId: null, accountingInvoiceConnector: null, lines },
  po: { reference: 'PO-1', type: 'GOODS', taxRatePercent: null, taxRateName: null, supplier: { name: 'Supplier', taxRate: null }, lines: [], freightCostLines: [] },
})
const snapshot = (over: Record<string, unknown>) => ({ poLineId: null, costLineId: null, totalForeign: new Prisma.Decimal('100'), taxBookedAt: new Date(), taxType: 'INPUT2', taxRateValue: new Prisma.Decimal('0.2'), taxRateId: 'r-std', taxReverseCharge: false, ...over })
const rcLine = snapshot({ taxType: 'REVERSECHARGES', taxRateId: 'r-rc', taxReverseCharge: true })

function reset() {
  enabledPlugins = ['xero']
  pluginReads = 0
  flipAfterReads = null
  xeroSync = 'true'
  committed.posted = 0
  committed.syncRows = []
  activity.length = 0
}

async function post() {
  const { postSupplierCreditNote } = await import('@/app/actions/purchase-orders')
  return postSupplierCreditNote('cn-1')
}

for (const [label, amount] of [['a FULL credit (the bill gross, net plus the self-accounted VAT)', '120'], ['a PARTIAL credit', '30']] as const) {
  test(`${label} against a reverse-charge bill is refused before anything is claimed: nothing posted, nothing queued, still a draft`, async () => {
    reset()
    CREDIT_NOTE = baseCredit(amount, [rcLine], '0')
    const result = await post()
    assert.equal(result.success, false)
    assert.match(String(result.error), /Supplier credits against reverse-charge bills are not posted from IMS yet: raise this credit in Xero directly/)
    assert.equal(committed.posted, 0, 'the credit note was not claimed')
    assert.equal(committed.syncRows.length, 0, 'nothing was queued')
  })
}

test('a reverse-charge line mixed with another treatment is refused as reverse charge too', async () => {
  reset()
  CREDIT_NOTE = baseCredit('30', [rcLine, snapshot({ taxType: 'NONE', taxRateValue: new Prisma.Decimal('0'), taxRateId: null })], '0')
  const result = await post()
  assert.equal(result.success, false)
  assert.match(String(result.error), /reverse-charge bills are not posted from IMS yet/)
  assert.equal(committed.posted, 0)
})

test('CONTROL: a credit against a NON-reverse-charge bill is unaffected (posted and queued)', async () => {
  reset()
  CREDIT_NOTE = baseCredit('120', [snapshot({})])
  const result = await post()
  assert.equal(result.success, true, JSON.stringify(result))
  assert.equal(committed.posted, 1)
  assert.deepEqual(committed.syncRows, [{ connector: 'xero', type: 'PURCHASE_CREDIT_NOTE' }])
})

test('CONTROL: a LOCAL-ONLY credit (Xero sync off, nothing goes to Xero) against a reverse-charge bill is not refused by this rule', async () => {
  reset()
  xeroSync = 'false'
  CREDIT_NOTE = baseCredit('30', [rcLine], '0')
  const result = await post()
  assert.doesNotMatch(String(result.error ?? ''), /reverse-charge bills are not posted from IMS yet/)
  assert.equal(committed.syncRows.length, 0, 'nothing goes to Xero')
})
