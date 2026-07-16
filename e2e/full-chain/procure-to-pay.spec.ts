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

  test('PP-02: PARTIAL receipt -> Partially Received -> bill the RECEIVED qty only, transit nets to zero', async ({ page }) => {
    test.setTimeout(600_000)

    // Order 4, receive 2. The whole point is that everything downstream follows the RECEIVED
    // quantity, not the ordered one.
    const sku = taggedSku(runId, 'PP02')
    const reference = `${runTag(runId)}-PP02`
    const orderedQty = 4
    const receivedQty = 2
    const unitCost = '12.50'
    const receivedNet = Number(unitCost) * receivedQty // 25.00
    const orderedNet = Number(unitCost) * orderedQty // 50.00 — must NOT appear anywhere

    await setPostingMode({ sync: true, dailyBatch: false })
    await createInventoryProduct(page, { sku, name: `${runTag(runId)} PP02`, price: '18.00' })

    const { poId } = await createAndSendPo(page, { sku, qty: String(orderedQty), unitCost })

    // A short receipt must land PARTIALLY_RECEIVED, not RECEIVED. receiveGoods asserts the
    // status itself, so a partial that silently books as complete fails here rather than
    // surfacing later as an inexplicable accounting gap.
    await receiveGoods(page, { expectStatus: 'Partially Received', qty: String(receivedQty) })

    await createBill(page, { reference })
    await processPendingXeroSyncViaUi(page)

    // --- the bill: RECEIVED value, never the ordered value.
    //
    // Billing the full order against a part receipt is the classic over-accrual: the supplier
    // has not delivered 2 of the 4, so debiting transit for all 4 leaves 25.00 of goods the
    // ledger believes are in transit and which no receipt will ever clear.
    //
    // TWO defences, and it is worth knowing which is which. The UI merely DEFAULTS the bill to
    // the received qty (po-detail-client.tsx:790-798 — billableCap is bounded by qtyRemaining,
    // which is NET RECEIVED despite the name, not the outstanding order). The real guarantee is
    // SERVER-SIDE: I proved it by breaking the client to demand the ordered qty, and the action
    // refused with "exceeds net received qty 2 — only received, un-returned goods can be billed".
    // So this assertion pins the default; the server is what makes over-accrual impossible.
    const billId = await externalIdFor({ type: 'PURCHASE_INVOICE', referenceId: poId })
    trackDocument('Invoices', billId, `PP-02 bill ${runTag(runId)}`)

    const bill = await getInvoice(billId)
    expect(bill.Type).toBe('ACCPAY')
    expect(bill.Status).not.toBe('DELETED')
    expect(Number(bill.SubTotal)).toBeCloseTo(receivedNet, 2)
    expect(Number(bill.SubTotal)).not.toBeCloseTo(orderedNet, 2) // the over-accrual, named explicitly

    const transitAccount = await settingValue('xero_transit_account')
    const inventoryAccount = await settingValue('xero_inventory_account')
    expectLine(bill.LineItems, { accountCode: transitAccount, lineAmount: receivedNet })

    // --- the receipt journal: also the received value only.
    const journalId = await externalIdFor({ type: 'STOCK_RECEIPT', referenceId: poId })
    trackDocument('ManualJournals', journalId, `PP-02 stock receipt ${runTag(runId)}`)

    const journal = await getManualJournal(journalId)
    expect(journal.Status).not.toBe('DELETED')
    expectJournalLine(journal.JournalLines, { accountCode: inventoryAccount, debit: receivedNet })
    expectJournalLine(journal.JournalLines, { accountCode: transitAccount, credit: receivedNet })

    // --- THE POINT: transit nets to ZERO across the pair.
    //
    // The receipt CREDITS transit and the bill DEBITS it, so for goods both received and
    // billed the account must drain completely. A non-zero residue here is exactly what the
    // transit GL reconciliation sweep would later flag as a material gap — and asserting the
    // two documents separately would not catch a sign error or an ordered/received mismatch
    // that happens to balance each document on its own.
    const journalTransitLines = journal.JournalLines.filter((l) => l.AccountCode === transitAccount)
    const billTransitLines = bill.LineItems.filter((l) => l.AccountCode === transitAccount)

    // Prove the filters MATCHED before trusting their sum. Two empty arrays reduce to 0 + 0 = 0
    // and would sail through the balance assertion below — a wrong account code, or a renamed
    // setting, would then read as perfect books. A test that cannot fail is worse than no test.
    expect(journalTransitLines.length, 'the receipt journal must touch transit').toBeGreaterThan(0)
    expect(billTransitLines.length, 'the bill must touch transit').toBeGreaterThan(0)

    const transitFromJournal = journalTransitLines.reduce((sum, l) => sum + l.LineAmount, 0) // Xero signs credits negative
    const transitFromBill = billTransitLines.reduce((sum, l) => sum + (l.LineAmount ?? 0), 0)
    expect(transitFromJournal + transitFromBill).toBeCloseTo(0, 2)
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
