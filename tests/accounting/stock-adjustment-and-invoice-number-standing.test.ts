import assert from 'node:assert/strict'
import test from 'node:test'

import { ledgerStanding, type LedgerStanding, type LedgerStandingRow } from '@/lib/domain/accounting/ledger-standing'
import { countSalesInvoiceRowsThatMayHavePosted } from '@/lib/connectors/woocommerce/sync/invoice-number'
import { adjustmentJournalMayHaveReachedLedger } from '@/lib/domain/inventory/stock-adjustment-edit'
import { matchesWhere } from '@/tests/helpers/shopping-sync-log-fake'

/**
 * o3d-1e7sl (G3 and G4, slice 1c of o3d-f709) - TWO GUARDS 1a CONVERTED, NOW PROVED PER STANDING.
 *
 *   G3  editing a stock adjustment in place is refused once its INVENTORY_ADJUSTMENT journal MAY HAVE REACHED
 *       THE LEDGER (`adjustmentJournalMayHaveReachedLedger`, called by app/actions/stock.ts).
 *   G4  the WooCommerce importer refuses to correct an order's stored invoice number while a sales-invoice sync
 *       row MAY HAVE REACHED THE LEDGER (`countSalesInvoiceRowsThatMayHavePosted`, called by order-import.ts).
 *
 * Both took `...MAY_HAVE_REACHED_LEDGER_WHERE` in slice 1a with no behavioural test; the doubles below evaluate
 * the real `where` against one row per standing (the standing asserted first), so a query that stopped asking the
 * module - or asked it wrongly - changes an answer here.
 */
type Row = LedgerStandingRow & { referenceType: string; referenceId: string; type: string }

function tx(rows: Row[]) {
  return {
    accountingSyncLog: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        rows.find((row) => matchesWhere(row as unknown as Record<string, unknown>, where)) ?? null,
      count: async ({ where }: { where: Record<string, unknown> }) =>
        rows.filter((row) => matchesWhere(row as unknown as Record<string, unknown>, where)).length,
    },
  } as never
}

const STANDINGS: Array<{ name: string; standing: LedgerStanding; row: Partial<LedgerStandingRow>; mayHavePosted: boolean }> = [
  { name: 'CONFIRMED_POSTED', standing: 'CONFIRMED_POSTED', row: { status: 'SYNCED', externalTransactionId: 'J-1' }, mayHavePosted: true },
  { name: 'ASSERTED_POSTED', standing: 'ASSERTED_POSTED', row: { status: 'SYNCED', externalTransactionId: 'J-T', settlementBasis: 'OPERATOR_ASSERTION' }, mayHavePosted: true },
  { name: 'ASSERTED_NOT_POSTED (an operator\'s claim is not proof, C1)', standing: 'ASSERTED_NOT_POSTED', row: { status: 'CANCELLED', settlementBasis: 'OPERATOR_ASSERTION' }, mayHavePosted: true },
  { name: 'PROVEN_NOT_POSTED (retired pre-call, stamped)', standing: 'PROVEN_NOT_POSTED', row: { status: 'CANCELLED', abandonedBeforeRemoteCall: true }, mayHavePosted: false },
  { name: 'UNKNOWN (FAILED)', standing: 'UNKNOWN', row: { status: 'FAILED' }, mayHavePosted: true },
  { name: 'UNKNOWN (CANCELLED, nothing recorded)', standing: 'UNKNOWN', row: { status: 'CANCELLED' }, mayHavePosted: true },
  { name: 'LIVE_WORK (PENDING)', standing: 'LIVE_WORK', row: { status: 'PENDING' }, mayHavePosted: true },
]

function fixture(c: (typeof STANDINGS)[number], over: Partial<Row>): Row {
  return {
    status: 'PENDING', externalTransactionId: null, settlementBasis: null, abandonedBeforeRemoteCall: null,
    referenceType: 'x', referenceId: 'x', type: 'x', ...c.row, ...over,
  }
}

test('[o3d-1e7sl G3] the stock-adjustment edit guard, one INVENTORY_ADJUSTMENT row per standing', async () => {
  let refused = 0
  for (const c of STANDINGS) {
    const row = fixture(c, { referenceType: 'StockMovement', referenceId: 'mv-1', type: 'INVENTORY_ADJUSTMENT' })
    const standing = ledgerStanding(row)
    console.log(`# G3 precondition: ${c.name}: standing ${standing}`)
    assert.equal(standing, c.standing, `fixture is not the standing it names: ${c.name}`)
    const blocked = await adjustmentJournalMayHaveReachedLedger(tx([row]), 'mv-1')
    assert.equal(blocked, c.mayHavePosted, c.name)
    if (blocked) refused += 1
  }
  console.log(`# G3 cases: ${STANDINGS.length}; edit refused for ${refused}`)
  assert.ok(refused > 0 && refused < STANDINGS.length)
})

test('[o3d-1e7sl G3] the guard is scoped to THIS movement and the journal type - another movement\'s or type\'s row never blocks', async () => {
  const confirmed = STANDINGS[0]!
  assert.equal(await adjustmentJournalMayHaveReachedLedger(tx([fixture(confirmed, { referenceType: 'StockMovement', referenceId: 'mv-OTHER', type: 'INVENTORY_ADJUSTMENT' })]), 'mv-1'), false)
  assert.equal(await adjustmentJournalMayHaveReachedLedger(tx([fixture(confirmed, { referenceType: 'StockMovement', referenceId: 'mv-1', type: 'COGS_JOURNAL' })]), 'mv-1'), false)
  assert.equal(await adjustmentJournalMayHaveReachedLedger(tx([fixture(confirmed, { referenceType: 'PurchaseOrder', referenceId: 'mv-1', type: 'INVENTORY_ADJUSTMENT' })]), 'mv-1'), false)
  assert.equal(await adjustmentJournalMayHaveReachedLedger(tx([]), 'mv-1'), false, 'no row at all: the edit may proceed')
})

test('[o3d-1e7sl G4] the WooCommerce invoice-number correction count, one sales-invoice row per standing', async () => {
  let counted = 0
  for (const c of STANDINGS) {
    for (const type of ['SALES_INVOICE', 'SALES_INVOICE_UPDATE']) {
      const row = fixture(c, { referenceType: 'SalesOrder', referenceId: 'so-1', type })
      assert.equal(ledgerStanding(row), c.standing, `precondition: ${c.name}`)
      const n = await countSalesInvoiceRowsThatMayHavePosted(tx([row]), 'so-1')
      assert.equal(n, c.mayHavePosted ? 1 : 0, `${c.name} / ${type}`)
      if (n > 0) counted += 1
    }
    console.log(`# G4 precondition: ${c.name}: standing ${c.standing}`)
  }
  console.log(`# G4 cases: ${STANDINGS.length * 2}; counted ${counted}`)
  assert.ok(counted > 0 && counted < STANDINGS.length * 2)
})

test('[o3d-1e7sl G4] the count is scoped to this order and to the two sales-invoice types, and counts rows (not 1)', async () => {
  const live = STANDINGS[6]!
  const rows = [
    fixture(live, { referenceType: 'SalesOrder', referenceId: 'so-1', type: 'SALES_INVOICE' }),
    fixture(live, { referenceType: 'SalesOrder', referenceId: 'so-1', type: 'SALES_INVOICE_UPDATE' }),
    fixture(live, { referenceType: 'SalesOrder', referenceId: 'so-OTHER', type: 'SALES_INVOICE' }),
    fixture(live, { referenceType: 'SalesOrder', referenceId: 'so-1', type: 'INVOICE_PAYMENT' }),
    fixture(live, { referenceType: 'SalesOrderRefund', referenceId: 'so-1', type: 'SALES_INVOICE' }),
  ]
  assert.equal(await countSalesInvoiceRowsThatMayHavePosted(tx(rows), 'so-1'), 2)
})
