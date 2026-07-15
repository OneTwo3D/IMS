/**
 * Order-to-cash, full chain (o3d-lgo.5).
 *
 * The spine the rest of Phase 2 hangs off: a real order placed in WooCommerce, imported
 * by WOO'S OWN WEBHOOK, allocated and shipped through the real IMS UI, posted to the
 * real Xero Demo ledger, and asserted by READING THE INVOICE BACK OUT OF XERO.
 *
 * That last step is the whole reason this tier exists. Every pre-existing "Xero" test in
 * e2e/ stops at the IMS's own accountingSyncLog row or a UI table row
 * (e2e/xero.spec.ts:57 expectXeroLogRow), which proves we SENT something — not that the
 * right document exists in the ledger. A wrong account code, tax type or line amount
 * passes those tests silently.
 *
 * Posting is armed per-test and disarmed after: the rig sits disarmed so it can never
 * post to the shared Demo ledger by accident.
 */
import { expect, test } from '@playwright/test'
import { currentRunId } from './harness/global-setup.ts'
import { runTag, taggedSku } from './harness/tag.ts'
import {
  awaitWebhookDelivery, cleanupWc, createWcOrder, createWcProduct, wcCreds, type WcCreds,
} from './harness/wc.ts'
import { allocateAndShip, openSalesOrder, processPendingXeroSyncViaUi, setPostingMode } from './harness/ims.ts'
import { addStockAdjustment, createInventoryProduct } from '../helpers.ts'
import { expectLine, externalIdFor, getInvoice, trackDocument } from './harness/xero.ts'

const WAREHOUSE_CODE = 'CBG'
const WAREHOUSE_LABEL = 'CBG — Cambridge'

test.describe.serial('@full-chain @wc @xero order to cash', () => {
  let creds: WcCreds
  let runId: string

  test.beforeAll(async () => {
    runId = currentRunId()
    creds = await wcCreds()
  })

  test.afterAll(async () => {
    // Leave the rig disarmed regardless of outcome; Xero documents are voided by the
    // global teardown via the trackDocument registry.
    await setPostingMode({ sync: false, dailyBatch: false }).catch(() => {})
    if (creds && runId) await cleanupWc(creds, runId)
  })

  test('OC-01: paid Woo order -> ship in IMS -> ACCREC invoice verified IN Xero', async ({ page }) => {
    test.setTimeout(600_000)

    const sku = taggedSku(runId, 'OC01')
    const unitPrice = '25.00'
    const qty = 2

    // 0. ARM POSTING FIRST — before the order is imported, not after it ships.
    //    The SALES_INVOICE is queued at IMPORT time (order-import.ts:751), and
    //    queueAccountingSync is a NO-OP when xero_sync_enabled is not 'true'
    //    (getAccountingPostingContext, accounting.ts:172, returns null). Arming later
    //    does not retroactively queue anything: the order ships, no sync log is ever
    //    created, and the test fails looking for an invoice that was never requested.
    await setPostingMode({ sync: true, dailyBatch: false })

    // 1. The IMS needs the product, or the order imports with productId=null and cannot
    //    be allocated. mapWcLineItems resolves WC lines to IMS products BY SKU
    //    (field-mapping.ts:188), so the two must match exactly.
    await createInventoryProduct(page, { sku, name: `${runTag(runId)} OC01`, price: unitPrice })
    await addStockAdjustment(page, sku, 10, WAREHOUSE_CODE)

    // 2. Place the order in Woo for real.
    const product = await createWcProduct(creds, runId, { label: 'OC01', price: unitPrice })
    expect(product.sku).toBe(sku)
    const order = await createWcOrder(creds, runId, { lines: [{ productId: product.id, quantity: qty }] })
    expect(order.status).toBe('processing')

    // 3. Woo's own webhook delivers it. Nothing is hand-posted.
    const imported = await awaitWebhookDelivery(order.id, { creds })
    expect(imported.salesOrderId).toBeTruthy()

    // 4. Fulfil it the way an operator does.
    await openSalesOrder(page, imported.salesOrderId)
    await allocateAndShip(page, { tracking: `${runTag(runId)}-OC01` })

    // 5. Post the queued invoice through the connector page — the button an operator
    //    actually clicks. Also avoids importing the sync module into the Playwright
    //    process: its graph pulls in CJS-only packages (pdfkit/sharp via invoice-pdf)
    //    and dies with "Cannot use import statement outside a module". Driving the UI
    //    runs it inside the app, where those resolve, and is the more faithful path.
    await processPendingXeroSyncViaUi(page)

    // 6. THE POINT: read the invoice back out of Xero and assert on what the ledger
    //    actually holds, not on what the IMS thinks it sent.
    const invoiceId = await externalIdFor({ type: 'SALES_INVOICE', referenceId: imported.salesOrderId })
    trackDocument('Invoices', invoiceId, `OC-01 ${runTag(runId)}`)

    const invoice = await getInvoice(invoiceId)
    expect(invoice.Type).toBe('ACCREC')
    expect(invoice.Status).not.toBe('DELETED')
    expect(invoice.CurrencyCode).toBe('GBP')

    // The line must carry the configured sales account — the class of bug a sync-log
    // assertion cannot see.
    const salesAccount = await settingValue('xero_sales_account')
    expectLine(invoice.LineItems, { accountCode: salesAccount, lineAmount: Number(unitPrice) * qty })

    // And the money must tie out to the Woo order.
    expect(Number(invoice.SubTotal)).toBeCloseTo(Number(unitPrice) * qty, 2)
    expect(Number(invoice.Total)).toBeCloseTo(Number(order.total), 2)
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
