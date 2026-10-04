import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

import { applyBackReference, resolvePurchaseOrderBackReference } from '../../lib/domain/accounting/back-reference'

/**
 * o3d-j61p — THE LIVE-ROW FENCE MUST COUNT THE ROW BEING REPAIRED, NOT ANY ROW.
 *
 * resolvePurchaseOrderBackReference asked "how many live rows for this PO name a document?" and
 * required exactly one. It never asked whether that one row names THE document being stamped. So
 * when the row under repair had gone (retention, a cleared id) and one sibling named a DIFFERENT
 * bill, the count was 1, the verdict was `unique`, and the in-memory id of the vanished row was
 * written onto the only unlinked bill while a surviving row said a different bill id had been posted
 * for this PO.
 *
 * DATABASE-BACKED because the rule is a statement over `accounting_sync_logs`; a double that
 * evaluated the predicate would be testing the double. ROLLED BACK, ALWAYS.
 *
 * GATED on RUN_DB_RETENTION_TESTS with the REQUIRE_DB_RETENTION_TESTS tripwire (npm run test:db), for
 * the reason written out in tests/db/reconciliation-unmirrored-sync-logs.test.ts.
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'

if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error(
    'REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1, so every test in '
    + 'tests/db/back-reference-po-live-row-fence.test.ts would have been skipped in an '
    + 'environment that promised a migrated database. Fix the invocation (npm run test:db).',
  )
}

class RollbackProbe extends Error {}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any

async function withRollback<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const { db } = await import('../../lib/db')
  let captured: T | undefined
  try {
    await db.$transaction(async (tx: unknown) => {
      captured = await fn(tx as Tx)
      throw new RollbackProbe()
    }, { timeout: 60_000, maxWait: 30_000 })
  } catch (error) {
    if (!(error instanceof RollbackProbe)) throw error
  }
  return captured as T
}

type SyncRowShape = { externalId: string | null; status?: string; settlementBasis?: string | null }

/** A PO with ONE unlinked bill and the given PURCHASE_INVOICE sync rows naming it. */
async function seedPo(tx: Tx, run: string, rows: SyncRowShape[]) {
  const supplier = await tx.supplier.create({ data: { name: `j61p ${run}`, currency: 'GBP' }, select: { id: true } })
  const po = await tx.purchaseOrder.create({
    data: {
      reference: `J61P-${run}`, supplierId: supplier.id, status: 'PO_SENT', currency: 'GBP', fxRateToBase: '1',
      subtotalForeign: '10', subtotalBase: '10', totalForeign: '10', totalBase: '10',
    },
    select: { id: true },
  })
  const bill = await tx.purchaseInvoice.create({
    data: { poId: po.id, invoiceDate: new Date(), totalForeign: '10', totalBase: '10', fxRateToBase: '1' },
    select: { id: true },
  })
  const syncIds: string[] = []
  for (const [i, row] of rows.entries()) {
    const created = await tx.accountingSyncLog.create({
      data: {
        id: `j61p-${run}-${i}`, connector: 'xero', type: 'PURCHASE_INVOICE', status: row.status ?? 'SYNCED',
        referenceType: 'PurchaseOrder', referenceId: po.id, externalTransactionId: row.externalId,
        settlementBasis: row.settlementBasis ?? null,
      },
      select: { id: true },
    })
    syncIds.push(created.id)
  }
  return { poId: po.id as string, billId: bill.id as string, syncIds }
}

const billLink = async (tx: Tx, billId: string) =>
  (await tx.purchaseInvoice.findUniqueOrThrow({ where: { id: billId }, select: { accountingInvoiceId: true } })).accountingInvoiceId as string | null

test('o3d-j61p control: the row under repair is the one live row -> unique and stamped (the rig CAN find a verdict)', { skip }, async () => {
  const run = randomUUID().slice(0, 8)
  const observed = await withRollback(async (tx) => {
    const { poId, billId, syncIds } = await seedPo(tx, run, [{ externalId: `XB-${run}` }])
    const resolved = await resolvePurchaseOrderBackReference(tx, { connector: 'xero', purchaseOrderId: poId, externalId: `XB-${run}` })
    const applied = await applyBackReference(tx, { connector: 'xero', type: 'PURCHASE_INVOICE', referenceType: 'PurchaseOrder', referenceId: poId, externalId: `XB-${run}` })
    return { resolved, applied, billId, rowsSeeded: syncIds.length, link: await billLink(tx, billId) }
  })
  console.log(`# j61p control: sync rows seeded=${observed.rowsSeeded}, verdict=${observed.resolved.outcome}, apply=${observed.applied.outcome}, link=${observed.link}`)
  assert.equal(observed.rowsSeeded, 1, 'PRECONDITION: exactly one live row for the PO')
  assert.deepEqual(observed.resolved, { outcome: 'unique', purchaseInvoiceId: observed.billId })
  assert.equal(observed.applied.outcome, 'applied')
  assert.equal(observed.link, `XB-${run}`)
})

test('o3d-j61p: the row under repair is GONE and ONE sibling names a DIFFERENT bill -> refused, nothing stamped', { skip }, async () => {
  const run = randomUUID().slice(0, 8)
  const observed = await withRollback(async (tx) => {
    // The sibling is the ONLY row; the id being repaired ("GONE") has no row any more.
    const { poId, billId, syncIds } = await seedPo(tx, run, [{ externalId: `XB-OTHER-${run}` }])
    const ownRows = await tx.accountingSyncLog.count({ where: { referenceId: poId, externalTransactionId: `XB-GONE-${run}` } })
    const resolved = await resolvePurchaseOrderBackReference(tx, { connector: 'xero', purchaseOrderId: poId, externalId: `XB-GONE-${run}` })
    const applied = await applyBackReference(tx, { connector: 'xero', type: 'PURCHASE_INVOICE', referenceType: 'PurchaseOrder', referenceId: poId, externalId: `XB-GONE-${run}` })
    return { resolved, applied, ownRows, siblings: syncIds.length, link: await billLink(tx, billId) }
  })
  console.log(`# j61p: siblings=${observed.siblings}, rows naming the repaired id=${observed.ownRows}, verdict=${JSON.stringify(observed.resolved)}, apply=${observed.applied.outcome}, link=${observed.link}`)
  assert.equal(observed.siblings, 1, 'PRECONDITION: one live sibling that names a different document')
  assert.equal(observed.ownRows, 0, 'PRECONDITION: no row names the id being repaired')
  assert.equal(observed.resolved.outcome, 'ambiguous')
  assert.equal(observed.resolved.outcome === 'ambiguous' && observed.resolved.reason, 'NO_LIVE_SYNC_ROW')
  assert.equal(observed.applied.outcome, 'ambiguous')
  assert.equal(observed.link, null, 'the unlinked bill must not have been stamped with the vanished row\'s id')
})

test('o3d-j61p: the repaired row is live AND a sibling names a different bill -> still MULTIPLE_SYNC_ROWS (C1: an asserted sibling counts)', { skip }, async () => {
  const run = randomUUID().slice(0, 8)
  const observed = await withRollback(async (tx) => {
    const { poId, billId, syncIds } = await seedPo(tx, run, [
      { externalId: `XB-${run}` },
      { externalId: `XB-ASSERTED-${run}`, status: 'SYNCED', settlementBasis: 'OPERATOR_ASSERTION' },
      { externalId: `XB-CANCELLED-${run}`, status: 'CANCELLED' },
    ])
    const resolved = await resolvePurchaseOrderBackReference(tx, { connector: 'xero', purchaseOrderId: poId, externalId: `XB-${run}` })
    return { resolved, rows: syncIds.length, link: await billLink(tx, billId) }
  })
  console.log(`# j61p competitors: rows=${observed.rows}, verdict=${JSON.stringify(observed.resolved)}`)
  assert.equal(observed.rows, 3, 'PRECONDITION: own row + asserted sibling + cancelled-with-id sibling')
  assert.equal(observed.resolved.outcome, 'ambiguous')
  assert.equal(observed.resolved.outcome === 'ambiguous' && observed.resolved.reason, 'MULTIPLE_SYNC_ROWS')
  assert.equal(observed.link, null)
})

test('o3d-j61p isolating arm: the row under repair gone and TWO other rows -> refused as the evidence being absent, not as a count of two', { skip }, async () => {
  const run = randomUUID().slice(0, 8)
  const observed = await withRollback(async (tx) => {
    const { poId, syncIds } = await seedPo(tx, run, [{ externalId: `XB-A-${run}` }, { externalId: `XB-B-${run}` }])
    const resolved = await resolvePurchaseOrderBackReference(tx, { connector: 'xero', purchaseOrderId: poId, externalId: `XB-GONE-${run}` })
    return { resolved, rows: syncIds.length }
  })
  assert.equal(observed.rows, 2, 'PRECONDITION: two siblings, none naming the repaired id')
  assert.equal(observed.resolved.outcome, 'ambiguous')
  assert.equal(observed.resolved.outcome === 'ambiguous' && observed.resolved.reason, 'NO_LIVE_SYNC_ROW')
})
