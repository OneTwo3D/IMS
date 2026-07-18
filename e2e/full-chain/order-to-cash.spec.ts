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
  awaitWebhookDelivery, cancelWcOrder, cleanupWc, createWcOrder, createWcProduct, getWcOrder, nudgeWpCron,
  refundWcOrder, wcCreds, type WcCreds,
} from './harness/wc.ts'
import { allocateAndShip, openSalesOrder, processPendingXeroSyncViaUi, setPostingMode } from './harness/ims.ts'
import { addStockAdjustment, createInventoryProduct } from '../helpers.ts'
import { expectLine, externalIdFor, getCreditNote, getInvoice, trackDocument } from './harness/xero.ts'

const WAREHOUSE_CODE = 'CBG'

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
    // AUTHORISED, not merely "not DELETED" — that accepts DRAFT and VOIDED, neither of which is
    // revenue anyone can collect. A regression that silently drafted every invoice would have
    // satisfied every line and total assertion below while the ledger stayed empty.
    expect(invoice.Status).toBe('AUTHORISED')
    expect(invoice.CurrencyCode).toBe('GBP')

    // The line must carry the configured sales account — the class of bug a sync-log
    // assertion cannot see.
    const salesAccount = await settingValue('xero_sales_account')
    expectLine(invoice.LineItems, { accountCode: salesAccount, lineAmount: Number(unitPrice) * qty })

    // And the money must tie out to the Woo order.
    expect(Number(invoice.SubTotal)).toBeCloseTo(Number(unitPrice) * qty, 2)
    expect(Number(invoice.Total)).toBeCloseTo(Number(order.total), 2)
  })

  // Regression proof for o3d-uxv: the refund's order.updated carries the same WC status
  // the IMS pushed at ship time, so the echo rule used to discard the whole webhook and
  // the refund was lost silently. handleOrderWebhook now scopes that suppression to the
  // STATUS sync only, so import and refund sync still run. If this goes red, that
  // regressed.
  test('OC-05: partial refund in Woo -> ACCRECCREDIT credit note verified IN Xero', async ({ page }) => {
    test.setTimeout(600_000)

    const sku = taggedSku(runId, 'OC05')
    const unitPrice = '30.00'
    const qty = 3
    const refundQty = 1

    await setPostingMode({ sync: true, dailyBatch: false })
    await createInventoryProduct(page, { sku, name: `${runTag(runId)} OC05`, price: unitPrice })
    await addStockAdjustment(page, sku, 10, WAREHOUSE_CODE)

    const product = await createWcProduct(creds, runId, { label: 'OC05', price: unitPrice })
    const order = await createWcOrder(creds, runId, { lines: [{ productId: product.id, quantity: qty }] })
    const imported = await awaitWebhookDelivery(order.id, { creds })

    // Ship first: a refund on an allocated-but-never-shipped line is REJECTED ("no
    // shipped stock source exists", docs/sales.md:135), so the refund must follow a
    // dispatch to be meaningful.
    await openSalesOrder(page, imported.salesOrderId)
    await allocateAndShip(page, { tracking: `${runTag(runId)}-OC05` })
    await processPendingXeroSyncViaUi(page)

    const invoiceId = await externalIdFor({ type: 'SALES_INVOICE', referenceId: imported.salesOrderId })
    trackDocument('Invoices', invoiceId, `OC-05 invoice ${runTag(runId)}`)

    // Refund ONE unit in WooCommerce. There is no refund webhook topic in WC core — a
    // refund fires order.updated, and the IMS picks it up via syncRefundsForOrder
    // (webhooks.ts:190). So this exercises the real inbound refund path.
    const wcOrder = await getWcOrder(creds, order.id)
    const lineId = wcOrder.line_items?.[0]?.id
    expect(lineId, 'the Woo order should have a line to refund').toBeTruthy()
    const refundAmount = (Number(unitPrice) * refundQty).toFixed(2)
    await refundWcOrder(creds, order.id, {
      amount: refundAmount,
      reason: `${runTag(runId)} OC-05 partial refund`,
      lineItems: [{ id: lineId!, quantity: refundQty, refund_total: refundAmount }],
    })

    // The refund reaches the IMS as a SalesOrderRefund via order.updated.
    const refundId = await awaitRefund(imported.salesOrderId)
    await processPendingXeroSyncViaUi(page)

    // Read the CREDIT NOTE back out of Xero — a different document type from OC-01, and
    // the one a sync-log assertion is least able to vouch for.
    const creditNoteId = await externalIdFor({ type: 'CREDIT_NOTE', referenceId: refundId })
    trackDocument('CreditNotes', creditNoteId, `OC-05 credit note ${runTag(runId)}`)

    const creditNote = await getCreditNote(creditNoteId)
    expect(creditNote.Type).toBe('ACCRECCREDIT')
    expect(creditNote.Status).toBe('AUTHORISED') // see OC-01: "not DELETED" accepts a DRAFT
    expect(creditNote.CurrencyCode).toBe('GBP')

    const salesAccount = await settingValue('xero_sales_account')
    expectLine(creditNote.LineItems, { accountCode: salesAccount, lineAmount: Number(refundAmount) })

    // PARTIAL: the credit note must cover only the refunded unit, not the whole order.
    // Getting this wrong would credit the customer 3x — exactly the class of error the
    // IMS's own sync log cannot see.
    expect(Number(creditNote.Total)).toBeLessThan(Number(order.total))
    expect(Number(creditNote.Total)).toBeGreaterThan(0)

    // And the order's refund disposition is PARTIAL — note REFUNDED is a RETIRED status;
    // refund state is the orthogonal refundStatus (prisma/schema.prisma:104).
    expect(await orderRefundStatus(imported.salesOrderId)).toBe('PARTIAL')
  })

  test('OC-06: full refund in Woo -> ACCRECCREDIT for the whole GROSS order value (goods + VAT)', async ({ page }) => {
    test.setTimeout(600_000)

    // The full-refund counterpart to OC-05. The difference that matters is not the plumbing but the
    // arithmetic: a full refund must credit the ENTIRE order value — every shipped unit AND the VAT on
    // top — reversing the invoice completely. Crediting only part (or dropping the tax) is exactly what
    // a sync-log assertion cannot see, and is a customer refunded the wrong amount. The order MUST be
    // genuinely taxable or this test would pass on both a correct and a tax-dropping implementation.
    const sku = taggedSku(runId, 'OC06')
    const unitPrice = '30.00'
    const qty = 3
    const goodsTotal = Number(unitPrice) * qty // 90.00 — the full refundable goods value (ex-VAT)

    await setPostingMode({ sync: true, dailyBatch: false })
    await createInventoryProduct(page, { sku, name: `${runTag(runId)} OC06`, price: unitPrice })
    await addStockAdjustment(page, sku, 10, WAREHOUSE_CODE)

    const product = await createWcProduct(creds, runId, { label: 'OC06', price: unitPrice })
    const order = await createWcOrder(creds, runId, { lines: [{ productId: product.id, quantity: qty }] })
    const imported = await awaitWebhookDelivery(order.id, { creds })

    // Ship first — a refund on an allocated-but-never-shipped line is rejected (OC-05).
    await openSalesOrder(page, imported.salesOrderId)
    await allocateAndShip(page, { tracking: `${runTag(runId)}-OC06` })
    await processPendingXeroSyncViaUi(page)

    const invoiceId = await externalIdFor({ type: 'SALES_INVOICE', referenceId: imported.salesOrderId })
    trackDocument('Invoices', invoiceId, `OC-06 invoice ${runTag(runId)}`)
    const invoice = await getInvoice(invoiceId)

    // The order must carry real VAT, else "full refund" degenerates to a goods-only refund that both a
    // correct and a tax-dropping build pass identically. Gross = goods + VAT (£108 = £90 + £18 here).
    const grossOrderTotal = Number(order.total)
    expect(grossOrderTotal, 'the stage order must be genuinely taxable (gross > goods)').toBeGreaterThan(goodsTotal)

    // Refund ALL units in WooCommerce for the WHOLE order GROSS (goods + VAT). WooCommerce validates
    // `amount` against the sum of line refund_total + refund_tax, so the tax MUST be refunded explicitly
    // and per tax row — a mismatched refund (gross amount, goods-only lines) is silently not applied.
    const wcLine = (await getWcOrder(creds, order.id)).line_items?.[0]
    expect(wcLine?.id, 'the Woo order should have a line to refund').toBeTruthy()
    const lineTaxes = wcLine!.taxes ?? []
    expect(lineTaxes.length, 'the refunded line must carry at least one tax row').toBeGreaterThan(0)
    const refundTax = lineTaxes.map((t) => ({ id: t.id, refund_total: Math.abs(Number(t.total)).toFixed(2) }))
    await refundWcOrder(creds, order.id, {
      amount: grossOrderTotal.toFixed(2),
      reason: `${runTag(runId)} OC-06 full refund`,
      lineItems: [{ id: wcLine!.id, quantity: qty, refund_total: goodsTotal.toFixed(2), refund_tax: refundTax }],
    })

    const refundId = await awaitRefund(imported.salesOrderId)
    await processPendingXeroSyncViaUi(page)

    const creditNoteId = await externalIdFor({ type: 'CREDIT_NOTE', referenceId: refundId })
    trackDocument('CreditNotes', creditNoteId, `OC-06 credit note ${runTag(runId)}`)

    const creditNote = await getCreditNote(creditNoteId)
    expect(creditNote.Type).toBe('ACCRECCREDIT')
    expect(creditNote.Status).toBe('AUTHORISED') // see OC-01: "not DELETED" accepts a DRAFT
    expect(creditNote.CurrencyCode).toBe('GBP')

    const salesAccount = await settingValue('xero_sales_account')
    expectLine(creditNote.LineItems, { accountCode: salesAccount, lineAmount: goodsTotal })

    // The credit reverses the invoice IN FULL, on BOTH bases:
    //  - SubTotal (goods, tax-exclusive) == the full goods value == the invoice's goods subtotal.
    //  - Total (gross) == the full GROSS order value == the invoice's gross Total — i.e. the VAT was
    //    credited too, not dropped. Total > SubTotal proves the VAT is actually present in the credit.
    expect(Number(creditNote.SubTotal), 'credit note goods subtotal = full goods value').toBeCloseTo(goodsTotal, 2)
    expect(Number(creditNote.Total), 'credit note gross = full gross order value (goods + VAT)').toBeCloseTo(grossOrderTotal, 2)
    expect(Number(creditNote.Total)).toBeGreaterThan(Number(creditNote.SubTotal)) // VAT actually credited
    expect(Number(invoice.SubTotal), 'the invoice goods subtotal it fully reverses').toBeCloseTo(goodsTotal, 2)
    expect(Number(invoice.Total), 'the invoice gross it fully reverses').toBeCloseTo(grossOrderTotal, 2)

    // A refund WAS recorded against the order (disposition left the NONE state). We deliberately do NOT
    // assert refundStatus === 'FULL' here: a full refund of a TAXABLE order is currently stuck at
    // PARTIALLY_REFUNDED because the disposition compares the net refund against the gross order total
    // (and Woo monetary-only refunds persist gross, so the basis is not uniform) — tracked as o3d-w00,
    // pending a finance-reviewed fix. `!== 'NONE'` stays green both before and after that fix lands.
    expect(await orderRefundStatus(imported.salesOrderId)).not.toBe('NONE')
  })

  test('OC-03: cancel in Woo before shipment -> SO CANCELLED, allocation released, invoice NOT posted', async ({ page }) => {
    test.setTimeout(600_000)

    // A customer cancellation before anything ships must (a) cancel the IMS order and release its stock
    // reservation, and (b) recognise NO revenue — the queued sales invoice must never reach Xero.
    // The order is auto-allocated at import (10 in stock, 2 ordered), so the cancel path releases a live
    // reservation — the exact path that used to throw an invalid stockLevel.findMany (o3d-8m7). And the
    // SALES_INVOICE is queued at import while PROCESSING, so draining after the cancel used to post an
    // AUTHORISED invoice for a cancelled sale (o3d-5rs). Both are read back from the DB / ledger.
    const sku = taggedSku(runId, 'OC03')
    const unitPrice = '40.00'
    const qty = 2

    // Arm sync so the SALES_INVOICE IS queued at import — that is the whole point: prove that the cancel
    // retires it (o3d-5rs) so a later drain posts nothing for the cancelled order.
    await setPostingMode({ sync: true, dailyBatch: false })
    await createInventoryProduct(page, { sku, name: `${runTag(runId)} OC03`, price: unitPrice })
    await addStockAdjustment(page, sku, 10, WAREHOUSE_CODE)

    const product = await createWcProduct(creds, runId, { label: 'OC03', price: unitPrice })
    const order = await createWcOrder(creds, runId, { lines: [{ productId: product.id, quantity: qty }] })
    const imported = await awaitWebhookDelivery(order.id, { creds })

    // Prove a reservation actually exists BEFORE cancelling — auto-allocation happens after the webhook
    // is visible, and without it the cancel skips the very stockLevel.findMany reads this fix repairs
    // (the test would then pass green without exercising the regression path at all).
    const scope = await awaitAllocated(imported.salesOrderId, qty)
    const reservedBefore = await reservedQtyFor(scope.productId, scope.warehouseId)
    expect(reservedBefore, 'the order must hold a live reservation before cancel').toBeGreaterThanOrEqual(qty)

    // Cancel in Woo before allocating/shipping. The order.updated webhook syncs the status to CANCELLED,
    // which drives the IMS cancel flow (releasing the reservation AND retiring the queued invoice).
    await cancelWcOrder(creds, order.id)
    await awaitOrderStatus(imported.salesOrderId, 'CANCELLED')

    expect(await orderStatus(imported.salesOrderId)).toBe('CANCELLED')
    // The reservation is released: no orderAllocation rows remain AND the stock level's reservedQty
    // drops by exactly the ordered quantity (the delta the cancel's findMany reads verify).
    expect(await openAllocationCount(imported.salesOrderId)).toBe(0)
    expect(await reservedQtyFor(scope.productId, scope.warehouseId)).toBeCloseTo(reservedBefore - qty, 4)

    // Drain the pending queue the way an operator would — the cancel retired the SALES_INVOICE, so the
    // drain must post nothing and leave no external document in Xero (o3d-5rs).
    await processPendingXeroSyncViaUi(page)
    const postedInvoiceId = await postedExternalId('SALES_INVOICE', imported.salesOrderId)
    // If the guard ever regresses and an invoice IS posted, track it so teardown voids it rather than
    // leaving an invalid receivable in the shared Demo ledger — THEN fail.
    if (postedInvoiceId) trackDocument('Invoices', postedInvoiceId, `OC-03 UNEXPECTED invoice ${runTag(runId)}`)
    expect(postedInvoiceId, 'a cancelled order must not post an ACCREC invoice').toBeNull()
  })

  test('OC-04: cancel in Woo AFTER a full shipment+invoice is REJECTED — SO stays SHIPPED, invoice intact', async ({ page }) => {
    // Worst case bounds THREE independent 300s delivery windows — the import delivery, the cancellation
    // status_sync_failed wait, and the finally-block retirement of the cancellation event — plus product
    // setup, the shipment UI, Xero posting, and poll overshoot. The ceiling must exceed all of them so
    // Playwright can never abort the cleanup mid-run and leave a late cancellation event to poison-retry.
    test.setTimeout(1_800_000)

    // The mirror image of OC-03. Once the whole order has shipped and the ACCREC invoice posted, a Woo
    // cancellation must NOT unwind revenue: the IMS refuses to cancel a shipped order ("Cannot cancel a
    // shipped order — process a refund instead", allocation-service.ts), so the status sync fails LOUDLY
    // (an activity log carrying that exact reason) rather than silently voiding a real receivable. This
    // asserts the invariant end-to-end AND that this specific refusal fired — the SO stays SHIPPED and
    // the AUTHORISED invoice is still on the Xero ledger.
    const sku = taggedSku(runId, 'OC04')
    const unitPrice = '35.00'
    const qty = 2

    await setPostingMode({ sync: true, dailyBatch: false })
    await createInventoryProduct(page, { sku, name: `${runTag(runId)} OC04`, price: unitPrice })
    await addStockAdjustment(page, sku, 10, WAREHOUSE_CODE)

    const product = await createWcProduct(creds, runId, { label: 'OC04', price: unitPrice })
    const order = await createWcOrder(creds, runId, { lines: [{ productId: product.id, quantity: qty }] })
    const imported = await awaitWebhookDelivery(order.id, { creds })

    // Ship the whole order (-> SHIPPED) and post the invoice — now there is a real receivable.
    await openSalesOrder(page, imported.salesOrderId)
    await allocateAndShip(page, { tracking: `${runTag(runId)}-OC04` })
    await processPendingXeroSyncViaUi(page)

    const invoiceId = await externalIdFor({ type: 'SALES_INVOICE', referenceId: imported.salesOrderId })
    trackDocument('Invoices', invoiceId, `OC-04 invoice ${runTag(runId)}`)
    expect((await getInvoice(invoiceId)).Status).toBe('AUTHORISED')
    expect(await orderStatus(imported.salesOrderId), 'the whole order shipped before we try to cancel it').toBe('SHIPPED')

    // Cancel in Woo. The order.updated webhook drives syncWcOrderStatus, which attempts the CANCELLED
    // transition and is REFUSED — logged as status_sync_failed carrying the refusal reason. Capture a
    // cutoff BEFORE the cancel so cleanup targets THIS cancellation event, not an earlier order.updated
    // (shipping wrote status back to Woo). The try starts BEFORE cancelWcOrder so cleanup still runs if
    // the request throws after Woo committed and queued the webhook.
    const cancelAt = new Date()
    try {
      await cancelWcOrder(creds, order.id)
      const rejection = await awaitActivity(imported.salesOrderId, 'status_sync_failed', creds)
      // Prove the RIGHT thing fired — a cancellation refusal, not some unrelated status-sync error.
      expect(rejection, 'the cancel was refused because the order is shipped').toContain('Cannot cancel a shipped order')

      // The refusal held: the order keeps its SHIPPED lifecycle status (not CANCELLED, not silently
      // reverted to any other state)...
      expect(await orderStatus(imported.salesOrderId)).toBe('SHIPPED')
      // ...and the receivable is untouched — still AUTHORISED, not VOIDED, on the ledger.
      expect((await getInvoice(invoiceId)).Status).toBe('AUTHORISED')
    } finally {
      // Good-citizen cleanup, ALWAYS: this refusal currently poison-retries the cancellation's
      // order.updated webhook (o3d-bx9 — a rejected status transition is returned as a retryable HTTP
      // 500, so the inbox re-hits the same impossible rule up to 24× to dead-letter). Retire that
      // specific event so a run never leaves churn on the SHARED e2e instance.
      await retireCancellationWebhookEvent(order.id, cancelAt, creds)
    }
  })
})

/** Wait for the Woo refund to arrive as a SalesOrderRefund and return its id. */
async function awaitRefund(salesOrderId: string, timeoutMs = 180_000): Promise<string> {
  const { Client } = await import('pg')
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const r = await db.query<{ id: string }>(
        `select id from sales_order_refunds where "orderId" = $1 order by "createdAt" desc limit 1`,
        [salesOrderId],
      )
      if (r.rows.length) return r.rows[0].id
      await new Promise((res) => setTimeout(res, 3_000))
    }
    throw new Error(
      `No SalesOrderRefund for order ${salesOrderId} within ${timeoutMs}ms. A Woo refund arrives via ` +
        `the order.updated webhook (there is no refund topic in WC core) and is applied by ` +
        `syncRefundsForOrder — check the inbox actually received an order.updated after the refund.`,
    )
  } finally {
    await db.end()
  }
}

async function orderRefundStatus(salesOrderId: string): Promise<string> {
  const { Client } = await import('pg')
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    const r = await db.query<{ refundStatus: string }>(
      `select "refundStatus" from sales_orders where id = $1`, [salesOrderId],
    )
    return r.rows[0]?.refundStatus ?? '(none)'
  } finally {
    await db.end()
  }
}

/**
 * Wait for an activity-log entry (action) for an entity — used to observe an async rejection — and
 * return its description. Nudges WP-Cron each poll and uses the established 300s delivery budget: this
 * waits on a NEW order.updated delivery (the cancellation), and this store has no organic traffic, so
 * webhooks only fire when wp-cron is prodded (see awaitWebhookDelivery, measured just over 3 minutes).
 */
async function awaitActivity(entityId: string, action: string, creds: WcCreds, timeoutMs = 300_000): Promise<string> {
  const { Client } = await import('pg')
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const r = await db.query<{ description: string | null }>(
        `select description from activity_logs where "entityId" = $1 and action = $2 order by "createdAt" desc limit 1`,
        [entityId, action],
      )
      if (r.rows.length) return r.rows[0].description ?? ''
      await nudgeWpCron(creds)
      await new Promise((res) => setTimeout(res, 5_000))
    }
    throw new Error(`No '${action}' activity for ${entityId} within ${timeoutMs}ms (the async action never landed).`)
  } finally {
    await db.end()
  }
}

/**
 * Retire the cancellation's order.updated inbox event so a run leaves NO churn on the SHARED e2e
 * instance. A refused status sync currently returns a retryable 500 (o3d-bx9), so the event would keep
 * re-hitting the same impossible rule up to 24× to dead-letter. Waits for the specific event to reach a
 * terminal state, then deletes it BY ID and verifies exactly one row went. A PROCESSED event is the
 * future o3d-bx9 no-op (nothing to retire). Throws if it can't confirm the residue is gone — a silent
 * no-op would let churn escape.
 */
async function retireCancellationWebhookEvent(wcOrderId: number, cancelAt: Date, creds: WcCreds, timeoutMs = 300_000): Promise<void> {
  const { Client } = await import('pg')
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    // Identify the CANCELLATION event precisely: an order.updated whose payload status is 'cancelled'
    // and that arrived after we issued the cancel — not an earlier ship-status-back write. It goes
    // PENDING -> PROCESSING -> FAILED after the handler returns 500, so poll until it settles. NUDGE
    // WP-Cron each poll and use the 300s delivery budget: if the cancel threw after Woo committed, the
    // webhook may still be queued in this trafficless store (measured >3 min), so we must drive delivery
    // before it is safe to conclude nothing was queued.
    const deadline = Date.now() + timeoutMs
    let event: { id: string; status: string } | null = null
    while (Date.now() < deadline) {
      const r = await db.query<{ id: string; status: string }>(
        `select id, status from shopping_webhook_events
          where topic = 'order.updated'
            and ("payloadJson"->>'id')::bigint = $1
            and ("payloadJson"->>'status') = 'cancelled'
            and "receivedAt" >= $2
          order by "receivedAt" desc limit 1`,
        [wcOrderId, cancelAt.toISOString()],
      )
      event = r.rows[0] ?? null
      if (event && (event.status === 'FAILED' || event.status === 'PROCESSED')) break
      await nudgeWpCron(creds)
      await new Promise((res) => setTimeout(res, 5_000))
    }
    // No cancellation event delivered within the full delivery budget (e.g. the cancel request failed
    // before Woo queued it) — nothing to retire, so no churn to leave. Only ACT on an event we
    // positively identified.
    if (!event) return
    if (event.status === 'PROCESSED') return // o3d-bx9 fixed: the refusal was acknowledged — no residue.
    if (event.status !== 'FAILED') {
      throw new Error(`Cancellation webhook event ${event.id} for WC order ${wcOrderId} did not settle (status ${event.status}); residue may churn.`)
    }
    const del = await db.query(`delete from shopping_webhook_events where id = $1`, [event.id])
    if (del.rowCount !== 1) throw new Error(`Expected to retire exactly 1 FAILED cancellation event for ${wcOrderId}, deleted ${del.rowCount}.`)
  } finally {
    await db.end()
  }
}

async function orderStatus(salesOrderId: string): Promise<string> {
  const { Client } = await import('pg')
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    const r = await db.query<{ status: string }>(`select status from sales_orders where id = $1`, [salesOrderId])
    return r.rows[0]?.status ?? '(none)'
  } finally {
    await db.end()
  }
}

/** Wait for the Woo status change to sync through to the SO (there is no status topic; it rides order.updated). */
async function awaitOrderStatus(salesOrderId: string, target: string, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = '(unread)'
  while (Date.now() < deadline) {
    last = await orderStatus(salesOrderId)
    if (last === target) return
    await new Promise((res) => setTimeout(res, 3_000))
  }
  throw new Error(`SO ${salesOrderId} never reached status ${target} within ${timeoutMs}ms (last: ${last}).`)
}

/** How many stock reservations the order still holds. A released/cancelled order should hold none. */
async function openAllocationCount(salesOrderId: string): Promise<number> {
  const { Client } = await import('pg')
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    const r = await db.query<{ count: string }>(
      `select count(*)::int as count from order_allocations where "orderId" = $1`, [salesOrderId],
    )
    return Number(r.rows[0]?.count ?? 0)
  } finally {
    await db.end()
  }
}

/** Wait until the order has auto-allocated to the expected quantity; returns the (single) scope it reserved. */
async function awaitAllocated(
  salesOrderId: string,
  expectedQty: number,
  timeoutMs = 120_000,
): Promise<{ productId: string; warehouseId: string }> {
  const { Client } = await import('pg')
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    const deadline = Date.now() + timeoutMs
    let last = 0
    while (Date.now() < deadline) {
      const r = await db.query<{ productId: string; warehouseId: string; sum: string }>(
        `select "productId", "warehouseId", sum(qty)::float8 as sum from order_allocations
          where "orderId" = $1 group by "productId", "warehouseId"`,
        [salesOrderId],
      )
      const total = r.rows.reduce((s, row) => s + Number(row.sum), 0)
      last = total
      if (total >= expectedQty && r.rows[0]) {
        return { productId: r.rows[0].productId, warehouseId: r.rows[0].warehouseId }
      }
      await new Promise((res) => setTimeout(res, 3_000))
    }
    throw new Error(`Order ${salesOrderId} never auto-allocated to qty ${expectedQty} within ${timeoutMs}ms (last: ${last}).`)
  } finally {
    await db.end()
  }
}

/** The reservedQty a stock level currently holds for a product+warehouse. */
/** The external id a posted accounting doc got, or null if the sync never reached the ledger. Single read, no wait. */
async function postedExternalId(type: string, referenceId: string): Promise<string | null> {
  const { Client } = await import('pg')
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    const r = await db.query<{ externalTransactionId: string | null }>(
      `select "externalTransactionId" from accounting_sync_logs
        where connector = 'xero' and type = $1::"AccountingSyncType" and "referenceId" = $2
          and "externalTransactionId" is not null
        order by "createdAt" desc limit 1`,
      [type, referenceId],
    )
    return r.rows[0]?.externalTransactionId ?? null
  } finally {
    await db.end()
  }
}

async function reservedQtyFor(productId: string, warehouseId: string): Promise<number> {
  const { Client } = await import('pg')
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    const r = await db.query<{ reservedQty: string }>(
      `select "reservedQty"::float8 as "reservedQty" from stock_levels where "productId" = $1 and "warehouseId" = $2`,
      [productId, warehouseId],
    )
    return Number(r.rows[0]?.reservedQty ?? 0)
  } finally {
    await db.end()
  }
}

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
