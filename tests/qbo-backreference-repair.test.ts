import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// o3d-0g2n. o3d-v7sy made the order delete guard check SalesOrder.accountingInvoiceId precisely
// because it lives on the order row and SURVIVES the retention purge that deletes AccountingSyncLog
// rows. That only holds if the marker is reliably written — and on QuickBooks it was not.
//
// updateBackReference runs AFTER the row is marked SYNCED and swallows its failure into a WARNING,
// and unlike Xero there was no sweep to notice. A transient failure left a real invoice in
// QuickBooks, a SYNCED row protective only until retention, and NO accountingInvoiceId on the order.
// Once retention deleted the log, an otherwise-eligible order could be hard-deleted with its invoice
// standing.
//
// THESE ARE BEHAVIOURAL TESTS. An earlier revision asserted the source text with regexes, and that
// hid a real defect: a gate that "retained FAILED so the next pass retries" could never retry,
// because once the back-reference is written the probe skips the row forever. Source-shape
// assertions cannot catch an unreachable control path — only running it can.

type SyncRow = {
  id: string
  type: string
  referenceType: string
  referenceId: string
  externalTransactionId: string | null
  status: string
  payload: Record<string, unknown>
  createdAt: Date
}

const CONNECTED_AT = new Date('2026-07-01T00:00:00.000Z')

let orders: Record<string, { accountingInvoiceId: string | null }> = {}
let syncRows: SyncRow[] = []
let token: { createdAt: Date } | null = { createdAt: CONNECTED_AT }
let statusUpdates: Array<{ id: string; data: Record<string, unknown> }> = []
let createdRows: Array<{ type: string; referenceId: string }> = []
/**
 * Every write to a document table, so a test can assert nothing was touched rather than infer it
 * from a counter. A counter-only assertion cannot distinguish "did not write" from "wrote and did
 * not count it".
 */
let documentWrites: Array<{ table: string; id: string }> = []

function row(over: Partial<SyncRow> = {}): SyncRow {
  return {
    id: 'log-1',
    type: 'SALES_INVOICE',
    referenceType: 'SalesOrder',
    referenceId: 'order-1',
    externalTransactionId: 'QBO-101',
    status: 'SYNCED',
    payload: {},
    createdAt: new Date('2026-07-10T00:00:00.000Z'),
    ...over,
  }
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      accountingToken: { findUnique: async () => token },
      accountingSyncLog: {
        findMany: async ({ where, take }: { where: Record<string, unknown>; take: number }) => {
          const gte = (where.createdAt as { gte: Date } | undefined)?.gte
          const statuses = (where.status as { in: string[] } | undefined)?.in ?? []
          const types = (where.type as { in: string[] } | undefined)?.in ?? []
          return syncRows
            .filter((r) => (gte ? r.createdAt >= gte : true))
            .filter((r) => statuses.includes(r.status))
            .filter((r) => types.includes(r.type))
            .slice(0, take)
        },
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          statusUpdates.push({ id: where.id, data })
          return {}
        },
        create: async ({ data }: { data: { type: string; referenceId: string } }) => {
          createdRows.push({ type: data.type, referenceId: data.referenceId })
          return {}
        },
        count: async () => 0,
        findFirst: async () => null,
      },
      salesOrder: {
        findUnique: async ({ where }: { where: { id: string } }) => orders[where.id] ?? null,
        update: async ({ where, data }: { where: { id: string }; data: { accountingInvoiceId: string } }) => {
          documentWrites.push({ table: 'salesOrder', id: where.id })
          orders[where.id] = { ...orders[where.id], accountingInvoiceId: data.accountingInvoiceId }
          return {}
        },
      },
      salesOrderRefund: {
        findUnique: async () => null,
        update: async ({ where }: { where: { id: string } }) => {
          documentWrites.push({ table: 'salesOrderRefund', id: where.id }); return {}
        },
      },
      purchaseInvoice: {
        findUnique: async () => null,
        findFirst: async () => null,
        update: async ({ where }: { where: { id: string } }) => {
          documentWrites.push({ table: 'purchaseInvoice', id: where.id }); return {}
        },
      },
      supplierCreditNote: {
        findUnique: async () => null,
        update: async ({ where }: { where: { id: string } }) => {
          documentWrites.push({ table: 'supplierCreditNote', id: where.id }); return {}
        },
      },
    },
  },
})

mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })

async function runSweep() {
  statusUpdates = []
  createdRows = []
  documentWrites = []
  const { repairQuickBooksBackReferences } = await import('@/lib/connectors/quickbooks/sync-processor')
  return repairQuickBooksBackReferences()
}

test('an order missing its invoice id is repaired from the sync row (o3d-0g2n)', async () => {
  // The whole point: restore the retention-proof marker the delete guard depends on.
  orders = { 'order-1': { accountingInvoiceId: null } }
  syncRows = [row()]
  token = { createdAt: CONNECTED_AT }

  const result = await runSweep()

  assert.equal(orders['order-1'].accountingInvoiceId, 'QBO-101', 'the marker is written back')
  assert.equal(result.repaired, 1)
  assert.equal(result.checked, 1)
})

test('an order that already has its invoice id is left alone (o3d-0g2n)', async () => {
  // The probe must gate the write, or a cron-frequency sweep would rewrite every linked document.
  orders = { 'order-1': { accountingInvoiceId: 'QBO-101' } }
  syncRows = [row()]

  const result = await runSweep()

  assert.equal(result.checked, 0, 'nothing needed repair')
  assert.equal(result.repaired, 0)
  assert.deepEqual(documentWrites, [], 'and no write was issued at all — asserted, not inferred')
  assert.equal(orders['order-1'].accountingInvoiceId, 'QBO-101', 'the existing id is not disturbed')
})

test('the sweep NEVER changes a row status or regenerates follow-ups (o3d-0g2n)', async () => {
  // Two earlier revisions terminalised FAILED -> SYNCED and re-enqueued follow-ups, mirroring Xero.
  // Both were unsafe here:
  //
  //   - the retry the gate promised was UNREACHABLE: once applyBackReference has run,
  //     backReferenceIsMissing returns false and the probe skips the row on every later pass, so a
  //     row retained as FAILED for retry would stay FAILED forever with its follow-ups missing;
  //   - re-enqueueing a FAILED payment creates a NEW row, and the QuickBooks requestid is derived
  //     from that row's id, so a payment QuickBooks had already committed could be accepted a
  //     second time (o3d-h2wx).
  //
  // So the sweep restores the back-reference and nothing else. A FAILED row stays FAILED: visible,
  // still blocking deletion, still retryable through the normal operator path.
  orders = { 'order-1': { accountingInvoiceId: null } }
  syncRows = [row({ status: 'FAILED' })]

  const result = await runSweep()

  assert.equal(orders['order-1'].accountingInvoiceId, 'QBO-101', 'the marker is still restored')
  assert.equal(result.repaired, 1)
  assert.deepEqual(statusUpdates, [], 'but no row status is touched')
  assert.deepEqual(createdRows, [], 'and no follow-up rows are regenerated')
})

test('a FAILED row carrying an external id IS a candidate (o3d-0g2n)', async () => {
  // o3d-ju8t: the remote call happens BEFORE the result is written, so a FAILED row with an external
  // id posted successfully and then lost its writeback — the rows MOST likely to need repair.
  orders = { 'order-1': { accountingInvoiceId: null } }
  syncRows = [row({ status: 'FAILED' })]

  const result = await runSweep()
  assert.equal(result.repaired, 1, 'FAILED rows are swept, not skipped')
  assert.deepEqual(documentWrites, [{ table: 'salesOrder', id: 'order-1' }], 'and the write really happened')
})

test('rows predating the current connection are NOT repaired (o3d-0g2n)', async () => {
  // AccountingSyncLog has no realm provenance, and reconnecting can change realm while historical
  // rows survive. Repairing those could write a realm-A id into a realm-B document. Until rows are
  // stamped (o3d-s36z), only rows newer than the current connection are eligible.
  orders = { 'order-1': { accountingInvoiceId: null } }
  syncRows = [row({ createdAt: new Date('2026-06-01T00:00:00.000Z') })]
  token = { createdAt: CONNECTED_AT }

  const result = await runSweep()

  assert.equal(result.repaired, 0, 'a pre-connection row is not touched')
  assert.equal(orders['order-1'].accountingInvoiceId, null, 'and the order is unchanged')
})

test('with no connection at all, nothing is repaired (o3d-0g2n)', async () => {
  // Failing open here would repair every historical row under no known realm — the worst case.
  orders = { 'order-1': { accountingInvoiceId: null } }
  syncRows = [row()]
  token = null

  const result = await runSweep()

  assert.deepEqual(result, { checked: 0, repaired: 0, failed: 0, skippedAmbiguous: 0 })
  assert.equal(orders['order-1'].accountingInvoiceId, null)
  token = { createdAt: CONNECTED_AT }
})

test('a PO with several unlinked sync rows is skipped, not guessed at (o3d-0g2n)', async () => {
  // A PURCHASE_INVOICE row references the PO, not a specific bill, so with several candidates the
  // "newest unlinked invoice" fallback could stamp one bill's id onto another. A wrong external id
  // is worse than a missing one, because it looks correct.
  orders = {}
  syncRows = [
    row({ id: 'log-a', type: 'PURCHASE_INVOICE', referenceType: 'PurchaseOrder', referenceId: 'po-1', externalTransactionId: 'QBO-201' }),
    row({ id: 'log-b', type: 'PURCHASE_INVOICE', referenceType: 'PurchaseOrder', referenceId: 'po-1', externalTransactionId: 'QBO-202' }),
  ]

  const result = await runSweep()

  assert.equal(result.skippedAmbiguous, 2, 'both ambiguous rows are skipped')
  assert.equal(result.repaired, 0, 'and neither is attributed by guesswork')
  assert.deepEqual(documentWrites, [], 'no bill was written — a wrong id is worse than a missing one')
})

test('the sweep cannot write a type QuickBooks\' own writer would not (o3d-0g2n)', async () => {
  // The divergence hazard of reusing the SHARED applyBackReference from a connector whose writer
  // duplicates that logic: the shared helper handles PURCHASE_CREDIT_NOTE / SupplierCreditNote and
  // QuickBooks' updateBackReference does not. Sweeping it would make the repair path and the live
  // path silently disagree.
  orders = {}
  syncRows = [row({ type: 'PURCHASE_CREDIT_NOTE', referenceType: 'SupplierCreditNote', referenceId: 'scn-1' })]

  const result = await runSweep()

  assert.equal(result.checked, 0, 'the type is not a candidate at all')
  assert.equal(result.repaired, 0)
  assert.deepEqual(
    documentWrites,
    [],
    'and crucially no supplierCreditNote write — the counter alone could not prove that',
  )
})
