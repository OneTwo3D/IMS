/**
 * Procure-to-pay, full chain (o3d-lgo.6).
 *
 * PO -> receive -> supplier bill, driven through the real IMS UI, posted to the real
 * Xero Demo ledger, and asserted by READING THE BILL BACK OUT OF XERO.
 *
 * No WooCommerce here: this half of the chain starts in the IMS, so it needs no webhook
 * and runs faster than order-to-cash.
 *
 * Like OC-01, the value is in the read-back. e2e/xero.spec.ts:126 already checks that a
 * PURCHASE INVOICE log row appears — which proves the IMS SENT something, not that Xero
 * holds an ACCPAY bill with the right account, supplier and amount.
 */
import { expect, test } from '@playwright/test'
import { currentRunId } from './harness/global-setup.ts'
import { runTag, taggedSku } from './harness/tag.ts'
import { createAndSendPo, createBill, processPendingXeroSyncViaUi, receiveGoods, setPostingMode } from './harness/ims.ts'
import { createInventoryProduct } from '../helpers.ts'
import {
  expectJournalLine, expectLine, externalIdFor, getInvoice, getManualJournal, trackDocument,
} from './harness/xero.ts'

test.describe.serial('@full-chain @xero procure to pay', () => {
  let runId: string

  test.beforeAll(async () => {
    runId = currentRunId()
  })

  test.afterAll(async () => {
    // Leave the rig disarmed whatever happened; Xero documents are voided globally.
    await setPostingMode({ sync: false, dailyBatch: false }).catch(() => {})
  })

  test('PP-01: PO -> full receipt -> bill -> ACCPAY bill verified IN Xero', async ({ page }) => {
    test.setTimeout(600_000)

    const sku = taggedSku(runId, 'PP01')
    const reference = `${runTag(runId)}-PP01`
    const qty = 4
    const unitCost = '12.50'
    const expectedNet = Number(unitCost) * qty // 50.00

    // Arm BEFORE the bill is created: queueAccountingSync no-ops while disarmed
    // (accounting.ts:172), so a bill entered first would never queue and the test would
    // hunt a document that was never requested. Same trap as OC-01.
    await setPostingMode({ sync: true, dailyBatch: false })

    await createInventoryProduct(page, { sku, name: `${runTag(runId)} PP01`, price: '18.00' })

    const { poId } = await createAndSendPo(page, { sku, qty: String(qty), unitCost })
    await receiveGoods(page, { expectStatus: 'Received' })
    await createBill(page, { reference })

    await processPendingXeroSyncViaUi(page)

    // THE POINT: the bill as Xero actually holds it.
    const billId = await externalIdFor({ type: 'PURCHASE_INVOICE', referenceId: poId })
    trackDocument('Invoices', billId, `PP-01 bill ${runTag(runId)}`)

    const bill = await getInvoice(billId)
    expect(bill.Type).toBe('ACCPAY') // a payable, not a receivable — the mirror of OC-01
    expect(bill.Status).not.toBe('DELETED')
    expect(bill.CurrencyCode).toBe('GBP')
    // Assert the ACTUAL figure, not merely "> 0". The first run of this test posted a
    // £0 bill to Xero because the PO line had no cost, and every structural assertion
    // still passed — a zero-value document is exactly the kind of thing that sails
    // through a "did it sync?" check.
    expect(Number(bill.SubTotal)).toBeCloseTo(expectedNet, 2)

    // Goods received but not yet consumed sit in the transit/clearing account, not
    // straight to COGS — the bill posts EXCLUSIVE of tax against it
    // (transit-gl-reconciliation.ts enumerates PURCHASE_BILL as a transit debit).
    const transitAccount = await settingValue('xero_transit_account')
    expectLine(bill.LineItems, { accountCode: transitAccount, lineAmount: expectedNet })

    // The supplier reference must survive to Xero, or nobody can tie the bill back to
    // the PO from the accounting side.
    expect(bill.Reference ?? '').toContain(reference)

    // --- the STOCK_RECEIPT journal (closes the e2e/xero.spec.ts:134 fixme) -------------
    //
    // That fixme blamed the demo tenant for never surfacing a successful STOCK RECEIPT.
    // It was not the tenant: the journal's Idempotency-Key was 156 chars and Xero 400'd
    // EVERY one, so stock receipt journals never posted on any instance. The 400 body was
    // being discarded, so it only ever read as "HTTP 400".
    //
    // Assert the journal is IN the ledger and balances, so a regression cannot hide as a
    // vague sync error again.
    const journalId = await externalIdFor({ type: 'STOCK_RECEIPT', referenceId: poId })
    trackDocument('ManualJournals', journalId, `PP-01 stock receipt ${runTag(runId)}`)

    const journal = await getManualJournal(journalId)
    expect(journal.Status).not.toBe('DELETED')

    // Goods received: stock ASSET up, stock-in-transit down. Receipt and bill are separate
    // events, so the transit account is the hinge between them — get this backwards and
    // inventory and transit both drift, silently.
    const inventoryAccount = await settingValue('xero_inventory_account')
    expectJournalLine(journal.JournalLines, { accountCode: inventoryAccount, debit: expectedNet })
    expectJournalLine(journal.JournalLines, { accountCode: transitAccount, credit: expectedNet })
  })
})

/** Read a setting from this instance (account codes are per-instance config). */
async function settingValue(key: string): Promise<string> {
  const { Client } = await import('pg')
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    const r = await db.query<{ value: string }>(`select value from settings where key = $1`, [key])
    if (!r.rows.length || !r.rows[0].value) throw new Error(`Setting ${key} is not configured on this instance.`)
    return r.rows[0].value
  } finally {
    await db.end()
  }
}
