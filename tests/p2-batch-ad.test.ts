import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { mock } from 'node:test'

import { matchesWhere } from '@/tests/helpers/shopping-sync-log-fake'

/**
 * P2 batch AD: o3d-hgj3w (held release, handled by hand), o3d-dzj3c (TrackShip re-check after tracking edits),
 * o3d-89mc (unreadable order total fails closed), o3d-9u0f (cancellation re-stamps a settled-void mirror).
 * Every collaborator is a double: no network, no database.
 */

// One shared database double for the whole file (a module can be mocked once).
const AT = new Date('2026-08-20T11:00:00.000Z')
const shared = { orders: [] as Array<{ id: string; totalForeign: unknown; currency: string }>, stateUpdates: [] as Array<Record<string, unknown>>, wcMeta: [] as unknown[] }
mock.module('@/lib/db', {
  namedExports: {
    db: {
      accountingSyncLog: { findMany: async () => [{ id: 'log_1', referenceId: 'so-1', status: 'SYNCED', externalTransactionId: 'PAY-1', syncedAt: AT, syncedAtDatabaseClock: AT, abandonedBeforeRemoteCall: null, settlementBasis: null, payload: { amount: 1, currency: 'GBP', accountingInvoiceId: 'inv_1' } }] },
      payment: { findMany: async () => [] },
      setting: { findUnique: async () => null },
      salesOrder: {
        findMany: async () => shared.orders,
        findUnique: async () => ({ orderNumber: 'SO-1', trackingNumber: 'TN-NEW', shippingService: 'UPS Standard', shippedAt: new Date('2026-11-01T10:00:00.000Z'), shoppingLinks: [{ externalOrderId: '501', externalOrderNumber: '501' }], shipments: [] }),
      },
      shoppingSyncLog: { create: async (a: { data: unknown }) => a.data },
      trackshipRefireState: { updateMany: async (args: Record<string, unknown>) => { shared.stateUpdates.push(args); return { count: 1 } } },
    },
  },
})

// ---------------------------------------------------------------- o3d-9u0f
type EventRow = { id: string; type: string; sourceEntityType: string; sourceEntityId: string; status: string; voidBasis: string | null; externalId: string | null }

function mirrorClient(rows: EventRow[]) {
  const logs: Array<Record<string, unknown>> = []
  return {
    logs,
    client: {
      accountingEvent: {
        findMany: async ({ where }: { where: Record<string, unknown> }) => rows.filter((row) => matchesWhere(row as never, where as never)),
        updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          const hit = rows.filter((row) => matchesWhere(row as never, where as never))
          for (const row of hit) Object.assign(row, data)
          return { count: hit.length }
        },
      },
      accountingEventLog: { createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => { logs.push(...data); return { count: data.length } } },
    },
  }
}
const event = (over: Partial<EventRow>): EventRow => ({ id: 'e1', type: 'SALES_INVOICE', sourceEntityType: 'SalesOrder', sourceEntityId: 'so-1', status: 'VOID', voidBasis: 'attempt_settled_not_posted', externalId: null, ...over })

test('o3d-9u0f: a cancellation re-stamps a VOID event an earlier NOT_POSTED settlement left revivable', async () => {
  const { voidMirroredAccountingEventsForOrder } = await import('@/lib/domain/accounting/accounting-event-mirror')
  const rows = [event({})]
  const m = mirrorClient(rows)
  await voidMirroredAccountingEventsForOrder(m.client as never, { types: ['SALES_INVOICE'], referenceType: 'SalesOrder', referenceId: 'so-1' })
  assert.equal(rows[0].status, 'VOID')
  assert.equal(rows[0].voidBasis, 'source_cancelled', 'the cancellation retires the document, whatever one attempt said')
  assert.equal(m.logs.length, 1)
})

test('o3d-9u0f: VOID events whose basis is not revivable, and an attempt-only void, are left alone', async () => {
  const { voidMirroredAccountingEventsForOrder } = await import('@/lib/domain/accounting/accounting-event-mirror')
  const rows = [event({ id: 'a', voidBasis: 'held_shadow' }), event({ id: 'b', voidBasis: null }), event({ id: 'c', voidBasis: 'document_deleted' })]
  const m = mirrorClient(rows)
  await voidMirroredAccountingEventsForOrder(m.client as never, { types: ['SALES_INVOICE'], referenceType: 'SalesOrder', referenceId: 'so-1' })
  assert.deepEqual(rows.map((row) => row.voidBasis), ['held_shadow', null, 'document_deleted'])
  const attempt = [event({ id: 'd' })]
  const m2 = mirrorClient(attempt)
  await voidMirroredAccountingEventsForOrder(m2.client as never, { types: ['SALES_INVOICE'], referenceType: 'SalesOrder', referenceId: 'so-1', attemptOnly: true })
  assert.equal(m2.logs.length, 0, 'an attempt-only void adds nothing over an existing attempt void')
})

// ---------------------------------------------------------------- o3d-89mc
test('o3d-89mc: a SALES document whose total cannot be read is WITHHELD, not admitted as a reversal', async () => {
  const { classifyRegisteredPaymentAgainstListing, databaseLedgerFence, zeroPaidIsProvenReversal } = await import('@/lib/connectors/xero/invoice-delta')
  const { toDecimal } = await import('@/lib/domain/math/decimal')
  const at = new Date('2026-08-20T11:00:00.000Z')
  const row = {
    id: 'log_1', status: 'SYNCED' as const, abandonedBeforeRemoteCall: null, settlementBasis: null, externalTransactionId: 'PAY-1',
    syncedAt: at, syncedAtDatabaseClock: at, registeredAgainstInvoiceId: 'inv_1', registeredAmount: toDecimal(1),
  }
  const fence = databaseLedgerFence(new Date('2026-08-20T12:00:00.000Z'))
  const binding = { accountingInvoiceId: 'inv_1', unregisteredPaidAt: new Date('2026-08-20T10:00:00.000Z') }
  // A ledger that cannot list payments: the listing is hard-null. Before the fix this was LEDGER_DID_NOT_LIST_PAYMENTS, which is ADMITTED.
  const before = classifyRegisteredPaymentAgainstListing(null, [row], fence, [], true, binding, null)
  assert.equal(zeroPaidIsProvenReversal(before), true, 'precondition: "not asking" keeps the round-6 answer')
  const verdict = classifyRegisteredPaymentAgainstListing(null, [row], fence, [], true, binding, null, true)
  assert.equal(verdict.verdict, 'REGISTRATION_UNDECIDED')
  assert.equal(zeroPaidIsProvenReversal(verdict), false)
  // The Xero shape (the ledger listed nothing): GONE before, withheld now.
  const gone = classifyRegisteredPaymentAgainstListing(new Set<string>(), [row], fence, [], true, binding, null, true)
  assert.equal(zeroPaidIsProvenReversal(gone), false)
  // No marker: the unreadable total is irrelevant, as before.
  const unmarked = classifyRegisteredPaymentAgainstListing(new Set<string>(), [row], fence, [], false, { ...binding, unregisteredPaidAt: null }, null, true)
  assert.equal(zeroPaidIsProvenReversal(unmarked), true)
})

test('o3d-89mc: the shared reader flags a sales document whose order row did not come back as unreadable', async () => {
  const { readPaidProvenanceVerdicts } = await import('@/lib/domain/accounting/payment-reversal')
  const { databaseLedgerFence, zeroPaidIsProvenReversal } = await import('@/lib/connectors/xero/invoice-delta')
  const docs = [{ id: 'so-1', accountingInvoiceId: 'inv_1', unregisteredPaidAt: new Date('2026-08-20T10:00:00.000Z') }]
  const run = async () => (await readPaidProvenanceVerdicts(docs as never, {
    connector: 'xero', registrationType: 'INVOICE_PAYMENT', referenceType: 'SalesOrder',
    ledgerObservedBefore: databaseLedgerFence(new Date('2026-08-20T12:00:00.000Z')),
    ledgerListedPaymentIds: () => null,
  })).get('so-1')!
  shared.orders = []
  const missing = await run()
  assert.equal(zeroPaidIsProvenReversal(missing), false, `an unreadable total must withhold, got ${missing.verdict}`)
})

// ---------------------------------------------------------------- o3d-dzj3c
test('o3d-dzj3c: pushing CHANGED tracking re-opens a COVERED TrackShip state, and an unchanged push does not', async () => {
  const state = shared
  const at = new Date('2026-11-01T10:00:00.000Z')
  mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })
  mock.module('@/lib/connectors/woocommerce/api', {
    namedExports: {
      wcFetch: async () => ({ data: { status: 'completed', meta_data: state.wcMeta }, error: null }),
      wcPut: async () => ({ data: { date_modified_gmt: '2026-11-01T10:00:01' }, error: null }),
    },
  })
  mock.module('@/lib/connectors/woocommerce/attempt-fence', { namedExports: { assertWcAttemptMayStillSend: async () => {} } })
  const ns = await import('@/lib/connectors/woocommerce/sync/tracking-sync')
  const { pushImsTrackingToWc } = ('default' in ns ? (ns as unknown as { default: typeof ns }).default : ns)

  const result = await pushImsTrackingToWc('so-1')
  assert.equal(result.success, true)
  assert.equal(state.stateUpdates.length, 1, 'changed tracking re-opens the re-fire state')
  const args = state.stateUpdates[0] as { where: Record<string, unknown>; data: Record<string, unknown> }
  assert.deepEqual(args.where, { orderId: 'so-1', status: 'COVERED' })
  assert.equal(args.data.status, 'ACTIVE')
  assert.equal(args.data.attempts, 0)
  assert.ok((args.data.nextAttemptAt as Date).getTime() > Date.now(), 'TrackShip is given its grace before the first look')

  // Unchanged tracking: the storefront already holds exactly what IMS would write, so nothing is pushed and the state stays.
  state.stateUpdates = []
  state.wcMeta = [{ id: 1, key: '_wc_shipment_tracking_items', value: [{ tracking_provider: 'UPS Standard', custom_tracking_provider: 'UPS Standard', custom_tracking_link: '', tracking_number: 'TN-NEW', date_shipped: String(Math.floor(at.getTime() / 1000)) }] }]
  const again = await pushImsTrackingToWc('so-1')
  assert.equal(again.skipped, true)
  assert.equal(state.stateUpdates.length, 0)
})

// ---------------------------------------------------------------- o3d-hgj3w
test('o3d-hgj3w: a held release answered handled-by-hand closes the hold instead of raising NOTHING-will-post for ever', () => {
  const src = readFileSync(new URL('../lib/connectors/woocommerce/sync/order-import.ts', import.meta.url), 'utf8')
  const release = src.slice(src.indexOf('async function releaseHeldWcSalesInvoice'))
  const handled = release.indexOf("enqueueOutcome.outcome?.reason === 'handled-by-hand'")
  const reread = release.indexOf('releasedSalesInvoiceQueueWhere({')
  const refusal = release.indexOf('noteHeldReleaseFailure(\n      row.id,\n      `WooCommerce numbered this invoice ${invoiceNumber}, but queueing the held sales invoice produced no')
  assert.ok(handled > 0, 'the release reads the enqueue answer handled-by-hand')
  assert.ok(handled < reread && handled < refusal, 'and does so BEFORE the re-read that finds no row and before the NOTHING-will-post note')
  const branch = release.slice(handled, reread)
  assert.match(branch, /status: 'SYNCED'/, 'the hold reaches a terminal state')
  assert.match(branch, /return 'handled'/)
  assert.match(src, /outcome === 'unreadable' \|\| outcome === 'shadowed' \|\| outcome === 'handled'\) result\.closed\+\+/, 'the sweep counts it as closed, not stuck')
})
