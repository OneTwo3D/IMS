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
  refundWcOrder, updateWcOrder, wcCreds, type WcCreds,
} from './harness/wc.ts'
import { allocateAndShip, openSalesOrder, processPendingXeroSyncViaUi, runWcOrderReconcile, setPostingMode } from './harness/ims.ts'
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

      // ...and the refusal is ACKNOWLEDGED, not retried: a stable business rule will refuse the identical
      // payload every time, so the cancellation's order.updated event settles PROCESSED instead of
      // churning to a dead letter (o3d-bx9). This is the live proof of that classification.
      expect(await cancellationWebhookStatus(order.id, cancelAt, creds)).toBe('PROCESSED')
    } finally {
      // Safety net only: if the classification ever regresses the event lands FAILED and would retry, so
      // retire it rather than leave churn on the SHARED e2e instance. A PROCESSED event is left alone.
      await retireCancellationWebhookEvent(order.id, cancelAt, creds)
    }
  })

  test('OC-02: under-stocked order dispatches only the available units, and invoices the FULL order', async ({ page }) => {
    // The ceiling must exceed the worst-case body (webhook delivery ~300s + allocate/ship + drain +
    // external-id lookup) AND leave room for the finally-block cleanup poll (up to 90s), so Playwright's
    // overall timeout can never pre-empt the failure-safe invoice registration and strand a document.
    test.setTimeout(1_800_000)

    // A part shipment driven by short stock: the order asks for 3 but only 2 are in stock, so
    // auto-allocation covers 2 and the shipment dispatches 2 — a genuinely partial fulfilment (shipped <
    // ordered). Two things must hold. Inventory: exactly the in-stock quantity leaves, and the order
    // reaches SHIPPED once its (single) shipment dispatches — the lifecycle flips on all SHIPMENTS
    // shipping, not on every ordered unit (allocation-service.ts:400). Ledger: the ACCREC is raised for
    // the WHOLE customer order at import (invoiced at order — the payload carries the ordered qty), so it
    // posts the full goods value even though only part shipped. Read both back from the DB / Xero.
    const sku = taggedSku(runId, 'OC02')
    const unitPrice = '20.00'
    const orderedQty = 3
    const stockQty = 2 // only 2 in stock -> a partial shipment of 2, 1 unit short
    const fullGoods = Number(unitPrice) * orderedQty // 60.00 — the invoice covers all 3

    await setPostingMode({ sync: true, dailyBatch: false })
    await createInventoryProduct(page, { sku, name: `${runTag(runId)} OC02`, price: unitPrice })
    await addStockAdjustment(page, sku, stockQty, WAREHOUSE_CODE)

    const product = await createWcProduct(creds, runId, { label: 'OC02', price: unitPrice })
    const order = await createWcOrder(creds, runId, { lines: [{ productId: product.id, quantity: orderedQty }] })
    const imported = await awaitWebhookDelivery(order.id, { creds })

    // Auto-allocation can only cover 2 of 3, so this dispatches a partial shipment of the in-stock units.
    await openSalesOrder(page, imported.salesOrderId)
    await allocateAndShip(page, { tracking: `${runTag(runId)}-OC02` })

    try {
      await processPendingXeroSyncViaUi(page)

      // GENUINELY partial: exactly the in-stock quantity shipped, and it is strictly fewer than ordered
      // (so the test can't pass on a full-stock full ship). The order reaches SHIPPED (its one shipment
      // dispatched); the short unit had no stock to allocate.
      const shipped = await shippedQtyFor(imported.salesOrderId)
      expect(shipped, 'only the in-stock units shipped').toBe(stockQty)
      expect(shipped, 'this must be a real partial fulfilment, not a full ship').toBeLessThan(orderedQty)
      expect(await orderStatus(imported.salesOrderId)).toBe('SHIPPED')

      // The ACCREC is raised for the WHOLE customer order at import, so it posts the full goods value
      // even though only 2 of 3 units shipped — the LINE carries the ordered quantity at the unit price,
      // not a collapsed qty-1 or the shipped qty.
      const invoiceId = await externalIdFor({ type: 'SALES_INVOICE', referenceId: imported.salesOrderId })
      const invoice = await getInvoice(invoiceId)
      expect(invoice.Type).toBe('ACCREC')
      expect(invoice.Status).toBe('AUTHORISED')
      const salesAccount = await settingValue('xero_sales_account')
      const line = expectLine(invoice.LineItems, { accountCode: salesAccount, lineAmount: fullGoods })
      expect(line.Quantity, 'the line carries the full ORDERED quantity, not the shipped quantity').toBe(orderedQty)
      expect(line.UnitAmount, 'at the ordered unit price').toBeCloseTo(Number(unitPrice), 2)
      expect(Number(invoice.SubTotal), 'the invoice covers the FULL ordered quantity, not just the shipped units').toBeCloseTo(fullGoods, 2)
    } finally {
      // Failure-safe: register any invoice that actually posted for teardown even if a lookup/assertion
      // above threw. POLL (not a single read): if the drain's server action timed out here it may still
      // be finishing the post, persisting the external id shortly after — so wait a bounded window before
      // concluding nothing posted, or a post-then-fail could strand an AUTHORISED invoice in the shared
      // Demo ledger.
      const posted = await awaitPostedExternalId('SALES_INVOICE', imported.salesOrderId, 90_000)
      if (posted) trackDocument('Invoices', posted, `OC-02 invoice ${runTag(runId)}`)
    }
  })

  test('OC-07: refund WITH restock -> returned units physically re-enter the return warehouse (RETURN_INBOUND, on-hand)', async ({ page }) => {
    test.setTimeout(600_000)

    // OC-05/06 proved the ACCOUNTING side of a Woo refund (the credit note read back from Xero). OC-07
    // proves the INVENTORY side of the SAME inbound path: a refund carrying a line QUANTITY restocks, and
    // the returned units must physically re-enter the correct warehouse, exactly once. That restock only
    // happens when a default return warehouse exists (refund-sync.ts:176 resolves `defaultReturnWarehouse:
    // true`); with none, a qty-refund silently degrades to cash-only and NOTHING here would fire. So we set
    // one for this test and restore it after — deliberately NOT in beforeAll, so OC-05/06's established
    // cash-only assertions upstream in this file are untouched.
    //
    // We return to the SAME warehouse the units shipped from (CBG), so on-hand simply goes down at ship
    // and back up at refund — the cleanest possible before/after on the same stock level.
    //
    // SCOPE — why this stops at the physical re-entry and does NOT assert the returned-stock VALUATION or a
    // recreated cost LAYER: posting mode is a branch. This runs SYNC mode, and a return re-enters at the
    // shipped COGS basis (recreating a valued cost layer) ONLY when the source shipment has been JOURNALED
    // — accounting_shipment_journal_date is set solely by the daily batch (daily-sync.ts). In sync mode the
    // shipment is never journaled, so stageRefundAccountingReversals finds no cost snapshot and the restock
    // falls back to buildRefundFallbackReturnRows, which carries QUANTITY ONLY (no cost) by design: the
    // units re-enter physically, valuation deferred. PRODUCTION runs the daily batch (stage has
    // xero_daily_batch_enabled), so there it re-enters at posted COGS with a recreated layer — that VALUED
    // path plus the COGS_REVERSAL journal are the batch-mode tests' job (OC-08 / X-01, which drive
    // runDailyBatchSync). Asserting a £10 layer here would either fail (sync mode) or force this test to run
    // the GLOBAL daily batch, which would journal the ~90 unrelated unjournaled shipments accumulated in the
    // shared e2e DB and strand their journals in the Demo ledger. So OC-07 owns the sync-mode restock PATH.
    const sku = taggedSku(runId, 'OC07')
    const unitPrice = '30.00'
    const qty = 3
    const refundQty = 1

    await setPostingMode({ sync: true, dailyBatch: false })
    const priorReturnWh = await setDefaultReturnWarehouse(WAREHOUSE_CODE, true)
    try {
      await createInventoryProduct(page, { sku, name: `${runTag(runId)} OC07`, price: unitPrice })
      await addStockAdjustment(page, sku, 10, WAREHOUSE_CODE)

      const product = await createWcProduct(creds, runId, { label: 'OC07', price: unitPrice })
      const order = await createWcOrder(creds, runId, { lines: [{ productId: product.id, quantity: qty }] })
      const imported = await awaitWebhookDelivery(order.id, { creds })

      // Ship the whole order from CBG — a refund needs a shipped stock source to restock against
      // (docs/sales.md:135), the same precondition OC-05 documents.
      await openSalesOrder(page, imported.salesOrderId)
      await allocateAndShip(page, { tracking: `${runTag(runId)}-OC07` })
      await processPendingXeroSyncViaUi(page)

      const invoiceId = await externalIdFor({ type: 'SALES_INVOICE', referenceId: imported.salesOrderId })
      trackDocument('Invoices', invoiceId, `OC-07 invoice ${runTag(runId)}`)

      const productId = await productIdBySku(sku)
      const warehouseId = await warehouseIdByCode(WAREHOUSE_CODE)
      // On-hand AFTER the ship, BEFORE the refund — the baseline the restock must move by exactly refundQty.
      // (Seeded 10, shipped 3, so this reads 7; asserting the delta rather than the absolute keeps the test
      // robust to the seed quantity.)
      const onHandAfterShip = await onHandFor(productId, warehouseId)

      // Refund ONE unit in Woo, carrying a line QUANTITY — that quantity (not the amount) is what makes
      // refund-sync treat it as a restock (refund-sync.ts:72 hasQtyRefund). Mirrors OC-05's refund shape.
      const wcOrder = await getWcOrder(creds, order.id)
      const lineId = wcOrder.line_items?.[0]?.id
      expect(lineId, 'the Woo order should have a line to refund').toBeTruthy()
      const refundAmount = (Number(unitPrice) * refundQty).toFixed(2)
      await refundWcOrder(creds, order.id, {
        amount: refundAmount,
        reason: `${runTag(runId)} OC-07 refund with restock`,
        lineItems: [{ id: lineId!, quantity: refundQty, refund_total: refundAmount }],
      })

      const refundId = await awaitRefund(imported.salesOrderId)
      await processPendingXeroSyncViaUi(page)

      // NB posting mode is a BRANCH (ims.ts:setPostingMode). This test runs SYNC mode, where the revenue
      // side (the credit note) posts but COGS does not — a shipment's COGS journal, and hence a refund's
      // COGS_REVERSAL, only post via the daily batch's Group B. So the restock queues a COGS_REVERSAL that
      // stays PENDING here (global teardown cancels the leftover queued log — nothing reaches the ledger).
      // The COGS-reversal JOURNAL read back from Xero is OC-08's assertion, run in batch mode; OC-07 proves
      // the INVENTORY subledger, which createRefund writes synchronously regardless of posting mode.

      // --- ACCOUNTING: the full chain still reaches the Xero ledger (as OC-05) ---
      const creditNoteId = await externalIdFor({ type: 'CREDIT_NOTE', referenceId: refundId })
      trackDocument('CreditNotes', creditNoteId, `OC-07 credit note ${runTag(runId)}`)
      const creditNote = await getCreditNote(creditNoteId)
      expect(creditNote.Type).toBe('ACCRECCREDIT')
      expect(creditNote.Status).toBe('AUTHORISED') // see OC-01: "not DELETED" would accept a DRAFT
      const salesAccount = await settingValue('xero_sales_account')
      expectLine(creditNote.LineItems, { accountCode: salesAccount, lineAmount: Number(refundAmount) })
      expect(Number(creditNote.Total)).toBeGreaterThan(0)
      expect(Number(creditNote.Total)).toBeLessThan(Number(order.total)) // partial, one of three units

      // --- INVENTORY SUBLEDGER: the distinct claim of OC-07 ---
      // 1) This ONE refund delivery produced EXACTLY ONE RETURN_INBOUND movement at the return warehouse —
      //    not zero (no restock) and not two (a single delivery double-writing the movement). This is a
      //    per-delivery correctness check, NOT an idempotency-under-duplicates proof: that requires a
      //    SECOND delivery of the same refund, which is OC-16's dedicated scope (webhook replay
      //    idempotency). The movement's own guard (idempotencyKey on refundId+refundLineId+warehouseId,
      //    docs/sales.md "Warehouse-scoped idempotency") is what would dedup such a replay — exercised there.
      const movements = await returnInboundMovementsFor('SalesOrderRefund', refundId, warehouseId)
      expect(movements.length, 'one refund delivery -> exactly one RETURN_INBOUND movement').toBe(1)
      const mv = movements[0]
      expect(mv.productId).toBe(productId)
      expect(mv.qty).toBeCloseTo(refundQty, 4)

      // 2) The movement is SELF-CONSISTENT: totalValueBase == qty * unitCostBase, the invariant the schema
      //    names (stock_movements.totalValueBase). We do NOT assert the ABSOLUTE cost — see the SCOPE note
      //    above: in sync mode the return re-enters quantity-only (deferred valuation), so a hardcoded £10
      //    would be wrong here and belongs to the batch-mode tests. Self-consistency still catches a
      //    corrupt movement whose stated value contradicts its own qty×unit-cost.
      expect(Number(mv.totalValueBase)).toBeCloseTo(Number(mv.unitCostBase ?? 0) * refundQty, 4)

      // 3) On-hand at the return warehouse rose by EXACTLY the returned quantity — the units are physically
      //    back (and by the delta, not over- or under-counted for this delivery).
      const onHandAfterRefund = await onHandFor(productId, warehouseId)
      expect(onHandAfterRefund).toBeCloseTo(onHandAfterShip + refundQty, 4)

      // 4) And the order records a PARTIAL refund (one of three units) — the same disposition OC-05 asserts.
      expect(await orderRefundStatus(imported.salesOrderId)).toBe('PARTIAL')
    } finally {
      // Restore the default-return-warehouse flag to whatever it was, so a later run (or OC-05/06 on a
      // re-run) sees the store exactly as it found it. Runs even if an assertion above threw.
      await setDefaultReturnWarehouse(WAREHOUSE_CODE, false, priorReturnWh)
    }
  })

  test('OC-13: an UNPAID (on-hold) Woo order imports as a non-processing SO and recognises NO revenue', async ({ page }) => {
    // The ceiling must exceed the SUM of the sequential bounded waits in the worst case, or Playwright can
    // kill the test mid-wait before a helper emits its diagnostic: awaitWebhookDelivery (300s) +
    // awaitWebhookEventProcessed (300s, a late delivery then a retryable FAILED) + skipAccountingLogFor
    // (60s), plus product setup and the Xero drain. 600s was under that sum; 1,800s clears it (matches OC-02/04).
    test.setTimeout(1_800_000)

    // Order-to-cash must not recognise revenue before it is due. An order placed but not paid arrives in
    // WooCommerce as 'on-hold'; IMS maps that to a NON-processing lifecycle (shopping_status_mappings:
    // on-hold -> ON_HOLD) and queues a SALES_INVOICE only when the mapped status is PROCESSING
    // (order-import.ts:710, shouldInvoice). So the order is still IMPORTED — it is a real customer order to
    // fulfil once payment clears — but NO invoice is raised and nothing posts to Xero. Arming posting is the
    // whole point: it proves the skip is the STATUS gate, not a disarmed connector. A regression that
    // invoiced an unpaid order would post an AUTHORISED receivable for money never collected — exactly the
    // class of error a sync-log assertion cannot see, caught here by reading the ledger back.
    const sku = taggedSku(runId, 'OC13')
    const unitPrice = '22.00'
    const qty = 2

    await setPostingMode({ sync: true, dailyBatch: false })
    await createInventoryProduct(page, { sku, name: `${runTag(runId)} OC13`, price: unitPrice })
    await addStockAdjustment(page, sku, 10, WAREHOUSE_CODE)

    const product = await createWcProduct(creds, runId, { label: 'OC13', price: unitPrice })
    // 'on-hold' + set_paid:false is an unpaid order. createWcOrder defaults to a paid 'processing' order,
    // so both must be set explicitly.
    const order = await createWcOrder(creds, runId, {
      lines: [{ productId: product.id, quantity: qty }],
      status: 'on-hold',
      setPaid: false,
    })
    expect(order.status).toBe('on-hold')

    // It still imports (a real order awaiting payment), so the webhook DOES create a SO link.
    const imported = await awaitWebhookDelivery(order.id, { creds })
    expect(imported.salesOrderId).toBeTruthy()

    // BARRIER before any negative assertion. awaitWebhookDelivery returns as soon as the SO LINK is visible,
    // but importWcOrder creates that link and only THEN reaches the invoice queue/skip decision — so an
    // immediate "no invoice" check could read a half-finished import and pass even if a regressed status
    // guard were about to queue one. Waiting for the import inbox event to reach its terminal PROCESSED
    // state proves importWcOrder ran to completion, so the queue/skip decision is committed.
    await awaitWebhookEventProcessed(order.id, creds)

    // Imported as a NON-processing lifecycle status (ON_HOLD), never PROCESSING.
    const status = await orderStatus(imported.salesOrderId)
    expect(status, 'an unpaid order must not import as PROCESSING').not.toBe('PROCESSING')
    expect(status).toBe('ON_HOLD')

    // POSITIVE proof the accounting gate was actually REACHED and took the skip path — not merely that no
    // invoice exists. The import writes a durable "skipped accounting sync" shopping_sync_logs row ONLY at
    // the !shouldInvoice branch, AFTER the gate (order-import.ts:711-735). Inbox PROCESSED alone can't prove
    // this: if a first attempt failed after creating the SO link, its retry returns via the existing-order
    // shortcut WITHOUT revisiting the gate, so ON_HOLD + zero invoice logs could otherwise pass while the
    // skip branch never ran. Asserting the skip evidence closes that false positive.
    const skipEvidence = await skipAccountingLogFor(imported.salesOrderId)
    expect(skipEvidence, 'the accounting gate must have run and skipped the sync for an unpaid order').not.toBeNull()
    expect(skipEvidence, 'the skip evidence names the non-processing status it skipped for').toContain('ON_HOLD')

    // NO SALES_INVOICE was queued at import — the status gate skipped the accounting sync entirely, so there
    // is not even a PENDING row (distinct from "queued but not yet posted").
    expect(
      await accountingLogCountFor('SALES_INVOICE', imported.salesOrderId),
      'no SALES_INVOICE queued for an unpaid order',
    ).toBe(0)

    // Drain the queue the way an operator would; with nothing queued for this order, nothing reaches Xero.
    await processPendingXeroSyncViaUi(page)

    // The authoritative check is the QUEUE, not a ledger scan. The gate under test lives at QUEUE time
    // (shouldInvoice), and an invoice CANNOT reach Xero without first being written as a SALES_INVOICE sync
    // row — the connector always persists that row before/around the Xero call. So the post-barrier
    // "SALES_INVOICE count == 0" assertion above already proves nothing could have posted, and this confirms
    // none carries an external id. We deliberately do NOT scan the shared Demo ledger by a fuzzy reference:
    // a digit-substring match is not ownership-safe (the Invoices endpoint also holds stage's ACCPAY bills)
    // and could VOID an unrelated shared-org document in teardown — a cure worse than the theoretical gap.
    const posted = await postedExternalId('SALES_INVOICE', imported.salesOrderId)
    // Failure-safe: if the gate ever regresses and an invoice DID post, track it so teardown voids OUR own
    // document (keyed on our sales order) rather than leaving an invalid receivable — THEN fail.
    if (posted) trackDocument('Invoices', posted, `OC-13 UNEXPECTED invoice ${runTag(runId)}`)
    expect(posted, 'an unpaid order must never post an ACCREC invoice').toBeNull()
  })

  test('OC-11: shipping and fee lines each post to their own Xero account (not lumped into revenue)', async ({ page }) => {
    test.setTimeout(600_000)

    // An order is more than its goods: WooCommerce carries a shipping charge and ad-hoc fees, and each must
    // land on the RIGHT account in the invoice. Shipping booked to the sales account overstates product
    // revenue; the invoices.ts builder posts shipping as its OWN line on the shipping account and fees as
    // ordinary lines on the sales account. This posts a taxable order with both and reads the invoice back
    // from Xero, asserting the per-line account codes and that the gross ties out to the Woo order.
    //
    // Discount (coupon) lines are deliberately NOT covered here: a cart coupon is captured BOTH per-line
    // (mapWcLineItems: subtotal-total) AND order-level (mapWcOrderDiscount from coupon_lines), and which one
    // the invoice posts — and whether they can double-count — needs its own analysis before a test can
    // assert the right answer. Tracked as an OC-11 follow-up.
    const sku = taggedSku(runId, 'OC11')
    const unitPrice = '40.00'
    const qty = 2
    const goods = Number(unitPrice) * qty // 80.00
    const shippingNet = '8.00'
    const feeNet = '5.00'

    await setPostingMode({ sync: true, dailyBatch: false })
    await createInventoryProduct(page, { sku, name: `${runTag(runId)} OC11`, price: unitPrice })
    await addStockAdjustment(page, sku, 10, WAREHOUSE_CODE)

    const product = await createWcProduct(creds, runId, { label: 'OC11', price: unitPrice })
    const order = await createWcOrder(creds, runId, {
      lines: [{ productId: product.id, quantity: qty }],
      shipping: { method_title: 'Flat Rate', total: shippingNet },
      feeLines: [{ name: 'Gift wrap', total: feeNet }],
    })

    const imported = await awaitWebhookDelivery(order.id, { creds })

    await openSalesOrder(page, imported.salesOrderId)
    await allocateAndShip(page, { tracking: `${runTag(runId)}-OC11` })
    await processPendingXeroSyncViaUi(page)

    const invoiceId = await externalIdFor({ type: 'SALES_INVOICE', referenceId: imported.salesOrderId })
    trackDocument('Invoices', invoiceId, `OC-11 invoice ${runTag(runId)}`)
    const invoice = await getInvoice(invoiceId)
    expect(invoice.Type).toBe('ACCREC')
    expect(invoice.Status).toBe('AUTHORISED')
    expect(invoice.CurrencyCode).toBe('GBP')

    const salesAccount = await settingValue('xero_sales_account')
    const shippingAccount = await settingValue('xero_shipping_account')
    // The two accounts must actually differ, or "posts to its own account" is vacuously true.
    expect(shippingAccount, 'shipping and sales accounts must be distinct for this test to mean anything').not.toBe(salesAccount)

    // Goods on the SALES account, at the full ex-VAT goods value.
    expectLine(invoice.LineItems, { accountCode: salesAccount, lineAmount: goods })
    // Shipping on the SHIPPING account — a separate line, NOT folded into sales.
    expectLine(invoice.LineItems, { accountCode: shippingAccount, lineAmount: Number(shippingNet) })
    // The fee is an ordinary line on the SALES account (there is no dedicated fee account).
    expectLine(invoice.LineItems, { accountCode: salesAccount, lineAmount: Number(feeNet) })

    // The gross Total ties out to the Woo order (goods + shipping + fee + VAT). This is the end-to-end
    // proof that nothing was dropped or mis-added across the chain.
    expect(Number(invoice.Total)).toBeCloseTo(Number(order.total), 2)
  })

  test('OC-16: replaying an order webhook is idempotent — one SO, one invoice, no duplicates', async ({ page }) => {
    // Worst case chains two full delivery windows (the import, then the forced replay) plus setup, so the
    // ceiling must clear their sum the way OC-13 does.
    test.setTimeout(1_800_000)

    // WooCommerce and its retries deliver the same order more than once — measured against the live store,
    // a single order arrives as order.updated TWICE. A redelivery must be absorbed idempotently:
    // importWcOrder takes the existing-order path (updateExistingWcOrderFromPayload) and must NOT fork a
    // second sales order or re-queue the SALES_INVOICE. We do NOT drain to Xero here — the property under
    // test is the import/queue side, not a ledger post — and the finally CANCELS the order's own pending
    // invoice so a LATER test's whole-queue drain can never post it (see the finally).
    const sku = taggedSku(runId, 'OC16')
    const unitPrice = '25.00'
    const qty = 2

    await setPostingMode({ sync: true, dailyBatch: false })
    await createInventoryProduct(page, { sku, name: `${runTag(runId)} OC16`, price: unitPrice })
    await addStockAdjustment(page, sku, 10, WAREHOUSE_CODE)

    const product = await createWcProduct(creds, runId, { label: 'OC16', price: unitPrice })
    const order = await createWcOrder(creds, runId, { lines: [{ productId: product.id, quantity: qty }] })
    try {
      await awaitWebhookDelivery(order.id, { creds })
      // Settle ALL initial deliveries (the natural duplicates included) before the baseline. requireAllProcessed
      // makes idempotency the bar: if any duplicate DEAD_LETTERED (i.e. was not absorbed gracefully) this fails
      // rather than passing on the unique-constrained link count. This baseline alone already proves
      // natural-duplicate idempotency: N deliveries, still one SO and one invoice, none dead-lettered.
      await awaitWebhookEventProcessed(order.id, creds, { requireAllProcessed: true })

      // Oracle reads sales_orders directly (not the unique-capped link table), and counts invoices across
      // EVERY sales order carrying this WC number — so a duplicate order (and its separately-keyed invoice)
      // cannot hide.
      const soIdsAfterImport = await salesOrderIdsForWcOrderNumber(order.number)
      expect(soIdsAfterImport.length, 'exactly one sales order for the WC order after import').toBe(1)
      expect(
        await salesInvoiceLogCountForOrders(soIdsAfterImport),
        'exactly one SALES_INVOICE queued at import, however many times it was delivered',
      ).toBe(1)

      // Force a DETERMINISTIC extra replay: a benign note edit fires a fresh order.updated (payload differs, so
      // the inbox does not dedupe it by hash — the import path actually runs again). The note carries a UNIQUE
      // marker so the barrier waits for THIS exact delivery, correlated by payload — not a wall-clock cutoff a
      // late original delivery could satisfy first.
      const replayMarker = `OC16-replay-${runId}`
      await updateWcOrder(creds, order.id, { customer_note: `${runTag(runId)} ${replayMarker}` })
      // Wait for the marked replay delivery specifically, and require it to PROCESS (fail if it dead-letters) —
      // a redelivery that dead-letters is exactly the non-idempotent handling this test must catch.
      await awaitWebhookEventProcessed(order.id, creds, { noteContains: replayMarker, requireAllProcessed: true })
      // Then let ALL of the order's deliveries (not only the marked one) quiesce, so a late ORIGINAL delivery
      // cannot land after the assertions and mutate state unseen.
      await awaitWebhookEventProcessed(order.id, creds, { requireAllProcessed: true })

      // Idempotent: still exactly one SO and one SALES_INVOICE (across ALL SOs for this WC order) — the
      // redelivery neither forked the order nor re-queued the invoice.
      const soIdsAfterReplay = await salesOrderIdsForWcOrderNumber(order.number)
      expect(soIdsAfterReplay.length, 'still exactly one sales order after the replay').toBe(1)
      expect(
        await salesInvoiceLogCountForOrders(soIdsAfterReplay),
        'still exactly one SALES_INVOICE after the replay — the re-import did not re-queue',
      ).toBe(1)
    } finally {
      // OC-16 intentionally never drains its invoice, so it sits PENDING. processPendingXeroSync drains the
      // WHOLE queue, so ANY later test's drain would post this invoice into the shared Demo ledger UNTRACKED
      // (global teardown cancels leftover pending rows, but only AFTER any later drain). Cancel our own
      // pending SALES_INVOICE now so the order is self-contained regardless of suite ordering.
      const soIds = await salesOrderIdsForWcOrderNumber(order.number)
      await cancelPendingSalesInvoicesForOrders(soIds)
    }
  })

  test('OC-14: an order mixing a standard-rated and a zero-rated product posts each line at its own tax', async ({ page }) => {
    // Clears the composed worst case: awaitWebhookDelivery (300s) + the import barrier (300s) + setup + ship
    // + drain — 600s was under that sum. Matches OC-13/OC-16.
    test.setTimeout(1_800_000)

    // A single order can carry lines at DIFFERENT VAT rates, and each must keep its own tax treatment all
    // the way into the Xero invoice — collapsing them to one rate, or dropping a zero-rating, is a VAT-return
    // error a sync-log assertion cannot see. Product A is standard-rated (the store's GB standard rate, ~20%
    // as OC-06 established); product B is in WooCommerce's built-in 'zero-rate' class, so WC charges it no
    // tax. We read the invoice back and assert the two goods lines carry DIFFERENT Xero tax types and that
    // only the standard line's tax reached the ledger — grounded in WooCommerce's OWN per-line tax figures
    // so the test is not hostage to a hardcoded rate.
    const skuA = taggedSku(runId, 'OC14A')
    const skuB = taggedSku(runId, 'OC14B')
    const priceA = '50.00'
    const priceB = '30.00'

    await setPostingMode({ sync: true, dailyBatch: false })
    await createInventoryProduct(page, { sku: skuA, name: `${runTag(runId)} OC14A`, price: priceA })
    await addStockAdjustment(page, skuA, 10, WAREHOUSE_CODE)
    await createInventoryProduct(page, { sku: skuB, name: `${runTag(runId)} OC14B`, price: priceB })
    await addStockAdjustment(page, skuB, 10, WAREHOUSE_CODE)

    const productA = await createWcProduct(creds, runId, { label: 'OC14A', price: priceA }) // '' => standard
    const productB = await createWcProduct(creds, runId, { label: 'OC14B', price: priceB, taxClass: 'zero-rate' })
    const order = await createWcOrder(creds, runId, {
      lines: [{ productId: productA.id, quantity: 1 }, { productId: productB.id, quantity: 1 }],
    })
    const imported = await awaitWebhookDelivery(order.id, { creds })
    // Barrier before draining: awaitWebhookDelivery returns when the SO link appears, but the SALES_INVOICE
    // is queued slightly later in the same import. Without this, a slow import could let the whole-queue drain
    // below run BEFORE the invoice is queued — externalIdFor would then time out and the mixed-tax assertions
    // would never run (same lesson as OC-13/OC-16).
    await awaitWebhookEventProcessed(order.id, creds, { requireAllProcessed: true })

    await openSalesOrder(page, imported.salesOrderId)
    await allocateAndShip(page, { tracking: `${runTag(runId)}-OC14` })
    try {
      await processPendingXeroSyncViaUi(page)

      const invoiceId = await externalIdFor({ type: 'SALES_INVOICE', referenceId: imported.salesOrderId })
      const invoice = await getInvoice(invoiceId)
      expect(invoice.Type).toBe('ACCREC')
      expect(invoice.Status).toBe('AUTHORISED')

      // Ground truth from WooCommerce's own tax computation (matched by SKU): standard line taxed, zero not.
      const wcOrder = await getWcOrder(creds, order.id)
      const wcLineA = wcOrder.line_items?.find((l) => l.sku === skuA)
      const wcLineB = wcOrder.line_items?.find((l) => l.sku === skuB)
      expect(wcLineA, 'the standard product is on the order').toBeTruthy()
      expect(wcLineB, 'the zero-rate product is on the order').toBeTruthy()
      const taxA = Number(wcLineA!.total_tax ?? 0)
      const taxB = Number(wcLineB!.total_tax ?? 0)
      expect(taxA, 'the standard product is taxed in WooCommerce').toBeGreaterThan(0)
      expect(taxB, 'the zero-rate product is NOT taxed in WooCommerce').toBeCloseTo(0, 2)

      const salesAccount = await settingValue('xero_sales_account')
      const lineA = expectLine(invoice.LineItems, { accountCode: salesAccount, lineAmount: Number(priceA) })
      const lineB = expectLine(invoice.LineItems, { accountCode: salesAccount, lineAmount: Number(priceB) })
      // Pin the EXACT UK output-VAT codes, not merely "present and different". invoices.ts substitutes 'NONE'
      // for a missing tax type, so a regression that DROPPED the zero-rating would still yield a different,
      // truthy value ('NONE') and sail through a weaker check while the VAT return is misclassified. The
      // standard line must post standard-rated output VAT (OUTPUT2); the zero-rate line must post a GENUINE
      // zero-rated code (ZERORATEDOUTPUT) — explicitly not 'NONE' (untaxed) and not the standard code.
      // The expected values are the store's own mappings, confirmed against shopping_tax_rate_mappings +
      // tax_rates: GB standard 20% -> OUTPUT2, zero-rate -> ZERORATEDOUTPUT. If the Woo zero-rate class had no
      // resolvable mapping, IMS would fall back to NONE and this assertion would (correctly) fail.
      const expectedStandardTaxType = await taxTypeForRateName('UK Standard Rate (20%)')
      const expectedZeroTaxType = await taxTypeForRateName('Zero Rated VAT')
      expect(expectedStandardTaxType, 'store maps its standard rate to a real output-VAT code').toBe('OUTPUT2')
      expect(expectedZeroTaxType, 'store maps its zero rate to a real zero-rated code').toBe('ZERORATEDOUTPUT')
      expect(lineA.TaxType, 'standard line posts standard-rated output VAT').toBe(expectedStandardTaxType)
      expect(lineB.TaxType, 'zero-rate line posts a GENUINE zero-rated code, not NONE or the standard rate').toBe(expectedZeroTaxType)

      // Only the standard line's tax reached Xero — the zero-rate line added none. Grounded in WC's figures.
      expect(Number(invoice.TotalTax), 'invoice tax equals the standard line tax alone').toBeCloseTo(taxA, 2)
      expect(Number(invoice.SubTotal), 'net goods = both lines ex-VAT').toBeCloseTo(Number(priceA) + Number(priceB), 2)
      expect(Number(invoice.Total), 'gross ties out to the Woo order').toBeCloseTo(Number(order.total), 2)
    } finally {
      // Failure-safe registration (OC-02's pattern): if the drain's action timed out or a lookup/assertion
      // threw AFTER Xero accepted the invoice, register whatever actually posted so teardown voids it rather
      // than stranding an AUTHORISED receivable in the shared Demo ledger. POLL, since a timed-out action may
      // still be finishing the post.
      const posted = await awaitPostedExternalId('SALES_INVOICE', imported.salesOrderId, 90_000)
      if (posted) trackDocument('Invoices', posted, `OC-14 invoice ${runTag(runId)}`)
    }
  })

  test('OC-10: a EUR order imports at the seeded FX rate and posts a genuine EUR invoice to Xero', async ({ page }) => {
    // Composed worst case as OC-14: awaitWebhookDelivery (300s) + import barrier (300s) + setup + ship + drain.
    test.setTimeout(1_800_000)

    // WHY: every other OC case is GBP (the base currency), so the FX boundary is otherwise unproven —
    // both order-import's foreign->base conversion (the single /fxRate boundary, divideRoundedNumber in
    // order-import.ts) and Xero's multicurrency invoice. A EUR order also proves the rig's load-bearing
    // FX precondition: with fx_rates EMPTY, getFxRateToGbp throws MissingFxRateError and the import
    // QUARANTINES the order in the pending-FX queue instead of posting (field-mapping.ts refuses to
    // silently fall back to 1:1). So the rate MUST be seeded BEFORE the order's webhook is imported;
    // seeding afterwards would let the order dead-letter and the invoice would never exist.
    const sku = taggedSku(runId, 'OC10')
    const unitPriceEur = '25.00'
    const qty = 2
    const goodsEur = Number(unitPriceEur) * qty // 50.00 EUR net goods (mirrors OC-01's untaxed shape)
    // 1 GBP = 1.15 EUR. Stored fromCurrency=GBP toCurrency=EUR rate=1.15; getFxRateToGbp reads that GBP->EUR
    // row and order-import converts base = foreign / rate. A deliberately non-unit rate is what makes the
    // conversion assertable: a 1:1 fallback regression would leave base == foreign and fail totalBase below.
    const fxRate = 1.15

    await setPostingMode({ sync: true, dailyBatch: false })

    // Seed the rate FIRST, with fetchedAt in the past so it satisfies getFxRateToGbp's fetchedAt <= orderedAt
    // bound against the order created moments later. Removed in the outer finally to restore the rig's
    // empty-fx_rates baseline — OC-17's pending-FX hazard and any later run both assume no seeded rate lingers.
    const fxRateId = await seedGbpFxRate('EUR', fxRate)
    let imported: { salesOrderId: string } | undefined
    try {
      await createInventoryProduct(page, { sku, name: `${runTag(runId)} OC10`, price: unitPriceEur })
      await addStockAdjustment(page, sku, 10, WAREHOUSE_CODE)

      const product = await createWcProduct(creds, runId, { label: 'OC10', price: unitPriceEur })
      const order = await createWcOrder(creds, runId, { lines: [{ productId: product.id, quantity: qty }], currency: 'EUR' })
      expect(order.currency, 'the Woo order is denominated in EUR').toBe('EUR')

      imported = await awaitWebhookDelivery(order.id, { creds })
      // A truthy SO id here already carries weight: a missing rate would have quarantined the order and
      // awaitWebhookDelivery would have timed out with no SO link at all.
      expect(imported.salesOrderId, 'the EUR order imported rather than quarantining for a missing rate').toBeTruthy()
      // Barrier before draining (OC-14's lesson): the SO link appears slightly before the SALES_INVOICE is
      // queued in the same import, so wait for the import event to settle or the drain could beat the queue.
      await awaitWebhookEventProcessed(order.id, creds, { requireAllProcessed: true })

      // --- IMS side: the foreign->base conversion actually happened at the /fxRate boundary ---
      const fx = await salesOrderFx(imported.salesOrderId)
      expect(fx.currency).toBe('EUR')
      expect(Number(fx.fxRateToBase), 'the SO recorded the seeded GBP->EUR rate').toBeCloseTo(fxRate, 4)
      expect(Number(fx.totalForeign), 'foreign total is the EUR order value').toBeCloseTo(Number(order.total), 2)
      // base = foreign / rate. This is the assertion a GBP order cannot make — it is the proof the rate was
      // applied, not ignored. A 1:1 fallback would make totalBase == totalForeign and fail here.
      expect(Number(fx.totalBase), 'base total is the EUR value converted at the seeded rate').toBeCloseTo(Number(order.total) / fxRate, 2)
      // Internal consistency of the conversion, independent of whether the order was taxed: net converts by
      // the same rate as gross.
      expect(Number(fx.subtotalBase), 'net converts by the same rate').toBeCloseTo(Number(fx.subtotalForeign) / fxRate, 2)

      await openSalesOrder(page, imported.salesOrderId)
      await allocateAndShip(page, { tracking: `${runTag(runId)}-OC10` })
      try {
        await processPendingXeroSyncViaUi(page)

        // --- Xero side: the ledger holds a EUR receivable, not a GBP one at the same numeric amount ---
        const invoiceId = await externalIdFor({ type: 'SALES_INVOICE', referenceId: imported.salesOrderId })
        const invoice = await getInvoice(invoiceId)
        expect(invoice.Type).toBe('ACCREC')
        expect(invoice.Status).toBe('AUTHORISED') // see OC-01: "not DELETED" would accept a DRAFT
        expect(invoice.CurrencyCode, 'Xero recorded the invoice in EUR, not the base currency').toBe('EUR')
        // THE RATE actually crossed into Xero, not just the currency label. IMS stamps CurrencyRate =
        // 1/fxRateToBase (lib/connectors/xero/fx.ts) precisely so Xero does NOT substitute its own daily XE
        // rate. Without this assertion a dropped, inverted, or Xero-substituted rate would still post an
        // AUTHORISED EUR invoice at the right EUR face value — every other assertion here would pass while
        // the GBP ledger value silently diverged. Xero's CurrencyRate is the inverse (1 EUR = X GBP).
        expect(invoice.CurrencyRate, 'Xero echoes a CurrencyRate for the EUR invoice').toBeDefined()
        expect(Number(invoice.CurrencyRate), 'Xero held the seeded rate (its inverse), not its own daily rate').toBeCloseTo(1 / fxRate, 5)

        const salesAccount = await settingValue('xero_sales_account')
        // Xero invoice lines are denominated in the invoice currency, so the EUR line value stands unconverted.
        expectLine(invoice.LineItems, { accountCode: salesAccount, lineAmount: goodsEur })
        expect(Number(invoice.SubTotal), 'EUR net ties out to the goods value').toBeCloseTo(goodsEur, 2)
        expect(Number(invoice.Total), 'EUR gross ties out to the Woo order').toBeCloseTo(Number(order.total), 2)
      } finally {
        // Failure-safe registration (OC-14's pattern): if the drain's action timed out or an assertion threw
        // AFTER Xero accepted the invoice, register whatever posted so teardown voids it rather than stranding
        // an AUTHORISED EUR receivable in the shared Demo ledger. POLL — a timed-out action may still be posting.
        const posted = await awaitPostedExternalId('SALES_INVOICE', imported.salesOrderId, 90_000).catch(() => null)
        if (posted) trackDocument('Invoices', posted, `OC-10 invoice ${runTag(runId)}`)
      }
    } finally {
      await deleteFxRate(fxRateId)
    }
  })

  test('OC-19: an order the webhook never delivered is ingested by the reconcile sweep', async ({ page }) => {
    test.setTimeout(600_000)

    // Every other OC case rides the realtime webhook. OC-19 proves the SAFETY NET: syncNewWcOrders(reconcile)
    // polls WooCommerce and imports an order the webhook missed. We create the order but DELIBERATELY never
    // nudge WP-Cron, so Woo never delivers its webhook (this store fires deliveries only when WP-Cron is
    // prodded — see awaitWebhookDelivery). Then we run the reconcile directly. The order must import anyway,
    // and provably via reconcile: the shopping_webhook_events inbox holds NO event for it.
    const sku = taggedSku(runId, 'OC19')
    const unitPrice = '22.00'
    const qty = 2

    await createInventoryProduct(page, { sku, name: `${runTag(runId)} OC19`, price: unitPrice })
    await addStockAdjustment(page, sku, 10, WAREHOUSE_CODE)

    const product = await createWcProduct(creds, runId, { label: 'OC19', price: unitPrice })
    // Bound the reconcile window to JUST this order: set the cursor AFTER the product setup and right before
    // creating the order, so the shared store's pre-existing (stage) orders AND an earlier test's order are not
    // re-swept. The -10s buffer absorbs any clock skew between this box and the WooCommerce server, whose time
    // modified_after is compared against. existingOrder is truthy mid-run, so the cursor is honoured.
    await setSetting('last_wc_order_reconcile_at', new Date(Date.now() - 10_000).toISOString())
    const order = await createWcOrder(creds, runId, { lines: [{ productId: product.id, quantity: qty }] })
    expect(order.status).toBe('processing')

    // No awaitWebhookDelivery / nudgeWpCron — the whole point is that the webhook never fires.
    const rec = await runWcOrderReconcile(page)
    expect(rec.synced, 'the reconcile reported importing the order').toBeGreaterThanOrEqual(1)

    // The reconcile is awaited, but the SO + link writes settle just after, so poll briefly.
    const ids = await awaitReconciledSalesOrder(order.number, 60_000)
    expect(ids.length, 'the reconcile sweep imported the order the webhook never delivered — exactly one SO').toBe(1)
    // Proof it came from RECONCILE, not a webhook that snuck in: the inbox has no event for this order.
    expect(await inboxEventCountForWcOrder(order.id), 'no webhook was delivered — the import is purely reconcile').toBe(0)
    // And it is a real processing sale, not a parked one: import auto-allocates a processing order, so it lands
    // PROCESSING or (once stock is allocated) ALLOCATED — either way a genuine sale, unlike OC-20's on-hold
    // order which the status filter never even fetches.
    expect(['PROCESSING', 'ALLOCATED'], 'imported as a genuine processing sale').toContain(await orderStatus(ids[0]))
  })

  test('OC-20: the reconcile sweep does NOT import an order whose status is not configured for sync', async ({ page }) => {
    test.setTimeout(600_000)

    // The counterpart to OC-13 (which proved the WEBHOOK path imports an on-hold order as a non-processing SO).
    // The reconcile/poll path instead honours wc_sync_order_statuses at the WooCommerce FETCH (status=
    // processing,completed in reconcile mode), so an on-hold order is never returned and never imported. Create
    // an on-hold order, never nudge WP-Cron (no webhook delivers), run the reconcile, and assert NO SO exists.
    const sku = taggedSku(runId, 'OC20')
    const unitPrice = '19.00'

    await createInventoryProduct(page, { sku, name: `${runTag(runId)} OC20`, price: unitPrice })
    await addStockAdjustment(page, sku, 10, WAREHOUSE_CODE)

    const product = await createWcProduct(creds, runId, { label: 'OC20', price: unitPrice })
    // Cursor set right before the order (not at test start), so the window holds ONLY this on-hold order — an
    // earlier test's processing order is not re-swept, which keeps the synced==0 assertion below exact. -10s
    // buffer for WC-server clock skew.
    await setSetting('last_wc_order_reconcile_at', new Date(Date.now() - 10_000).toISOString())
    const order = await createWcOrder(creds, runId, { lines: [{ productId: product.id, quantity: 1 }], status: 'on-hold', setPaid: false })
    expect(order.status).toBe('on-hold')

    // runWcOrderReconcile throws unless the sweep completed with NO result errors, so reaching here proves the
    // reconcile actually ran against a reachable WooCommerce (a fetch/auth/rate-limit failure would throw, not
    // silently import nothing). The order-specific proof is below: the sweep does not create an SO for the
    // on-hold order — the status filter excludes it at the WooCommerce fetch. (We assert on THIS order's number,
    // not the aggregate synced count: the sweep legitimately re-syncs other recently-modified store orders.)
    await runWcOrderReconcile(page)

    // No SO exists for it. (No webhook delivered it either — we never nudged WP-Cron. And OC-19 proves this same
    // sweep DOES import a processing order under identical conditions, so a green OC-20 is a real skip.)
    expect(await salesOrderIdsForWcOrderNumber(order.number), 'a non-configured status must not be imported by reconcile').toHaveLength(0)
    expect(await inboxEventCountForWcOrder(order.id), 'and no webhook delivered it either').toBe(0)
  })
})

/**
 * Seed a base(GBP)->foreign FX rate so a foreign-currency order can import. The rig keeps fx_rates EMPTY
 * by design (getFxRateToGbp then quarantines a foreign order rather than falling back to 1:1), so OC-10
 * seeds exactly the one rate it needs and deletes it in finally. fetchedAt is set an hour in the past so it
 * satisfies getFxRateToGbp's `fetchedAt <= orderedAt` bound against an order created immediately after.
 */
async function seedGbpFxRate(toCurrency: string, rate: number): Promise<string> {
  const { Client } = await import('pg')
  const { randomUUID } = await import('node:crypto')
  const id = `e2e-fc-fx-${randomUUID()}`
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    await db.query(
      `insert into fx_rates (id, "fromCurrency", "toCurrency", rate, "fetchedAt", source, "manualOverride")
       values ($1, 'GBP', $2, $3, now() - interval '1 hour', 'e2e-fc-seed', false)`,
      [id, toCurrency.toUpperCase(), rate],
    )
    return id
  } finally {
    await db.end()
  }
}

/**
 * Remove a seeded FX rate to restore the rig's empty-fx_rates baseline. Never throws (it runs in a
 * finally and must not mask a test result), but it is NOT silent: a missed delete leaves an eligible
 * EUR rate that would let a LATER foreign order import at this artificial rate instead of exercising
 * the missing-rate quarantine, so a rowCount != 1 or a failure is surfaced loudly. global-setup's
 * sweepSeededFxRates() is the recovery net that clears any such residue before the next run.
 */
async function deleteFxRate(id: string): Promise<void> {
  const { Client } = await import('pg')
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    const r = await db.query(`delete from fx_rates where id = $1`, [id])
    if (r.rowCount !== 1) {
      console.warn(`[OC-10] deleteFxRate(${id}) removed ${r.rowCount} row(s), expected 1 — a seeded FX rate may persist; global-setup will sweep it next run`)
    }
  } catch (e) {
    console.warn(`[OC-10] deleteFxRate(${id}) failed: ${e instanceof Error ? e.message : String(e)} — global-setup will sweep it next run`)
  } finally {
    await db.end()
  }
}

/** Read a sales order's stored foreign/base FX figures to prove the import-time conversion. */
async function salesOrderFx(salesOrderId: string): Promise<{
  currency: string
  fxRateToBase: string
  subtotalForeign: string
  subtotalBase: string
  totalForeign: string
  totalBase: string
}> {
  const { Client } = await import('pg')
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    const r = await db.query(
      `select currency, "fxRateToBase", "subtotalForeign", "subtotalBase", "totalForeign", "totalBase"
       from sales_orders where id = $1`,
      [salesOrderId],
    )
    if (!r.rows.length) throw new Error(`No sales_orders row for ${salesOrderId}`)
    return r.rows[0]
  } finally {
    await db.end()
  }
}

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

/** The terminal status of the cancellation's own order.updated inbox event (PROCESSED once acknowledged). */
async function cancellationWebhookStatus(wcOrderId: number, cancelAt: Date, creds: WcCreds, timeoutMs = 300_000): Promise<string> {
  const { Client } = await import('pg')
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    const deadline = Date.now() + timeoutMs
    let last = '(none)'
    while (Date.now() < deadline) {
      const r = await db.query<{ status: string }>(
        `select status from shopping_webhook_events
          where topic = 'order.updated'
            and ("payloadJson"->>'id')::bigint = $1
            and ("payloadJson"->>'status') = 'cancelled'
            and "receivedAt" >= $2
          order by "receivedAt" desc limit 1`,
        [wcOrderId, cancelAt.toISOString()],
      )
      last = r.rows[0]?.status ?? '(none)'
      if (last === 'PROCESSED' || last === 'FAILED' || last === 'DEAD_LETTER') return last
      await nudgeWpCron(creds)
      await new Promise((res) => setTimeout(res, 5_000))
    }
    return last
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

/** Total quantity actually dispatched for an order — summed over its SHIPPED shipments' lines. */
async function shippedQtyFor(salesOrderId: string): Promise<number> {
  const { Client } = await import('pg')
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    const r = await db.query<{ qty: string }>(
      `select coalesce(sum(sl.qty), 0)::float8 as qty
         from shipment_lines sl
         join shipments s on s.id = sl."shipmentId"
        where s."orderId" = $1 and s.status = 'SHIPPED'`,
      [salesOrderId],
    )
    return Number(r.rows[0]?.qty ?? 0)
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

/**
 * Wait for EVERY inbound import delivery of an order to settle — the barrier that proves importWcOrder ran
 * to completion (SO link AND the invoice queue/skip decision), not just that the SO link became visible.
 *
 * Waiting for the newest row alone is NOT enough: a REST-created order can arrive as duplicate deliveries
 * (measured: an on-hold order came through as order.updated twice), and importWcOrder creates the SO link
 * BEFORE it reaches the accounting gate. A duplicate can take the fast existing-order path and reach
 * PROCESSED while the ORIGINAL delivery is still PROCESSING — so "newest is PROCESSED" can return before the
 * queue/skip decision commits. So we require that NO delivery is still in flight.
 *
 * FAILED is treated as in-flight, not terminal: the inbox retries FAILED rows after nextAttemptAt, so a
 * transient error must NOT fail the run — only a permanent DEAD_LETTER (with nothing PROCESSED) does.
 * Topic-agnostic (order.created OR order.updated) and connector-scoped. Nudges WP-Cron each poll (this store
 * has no organic traffic).
 *
 * `opts.noteContains` scopes the barrier to the ONE delivery whose payload customer_note carries a unique
 * marker — needed to wait on a specific REPLAY (a freshly triggered order.updated) by CORRELATING on its
 * payload, not on a wall-clock cutoff. A cutoff was unsafe: a late ORIGINAL order.updated arriving after the
 * cutoff could satisfy the barrier before the replay ever landed. Matching the marker pins it to the exact
 * event we caused.
 */
async function awaitWebhookEventProcessed(
  wcOrderId: number,
  creds: WcCreds,
  opts: { noteContains?: string; requireAllProcessed?: boolean; timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 300_000
  const { Client } = await import('pg')
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    const deadline = Date.now() + timeoutMs
    let snapshot = '(no events yet)'
    // Quiescence — the hard part, and one with a KNOWN limit worth stating plainly. IMS can only see events
    // it has RECEIVED; a duplicate still queued upstream in Woo's Action Scheduler creates no row here, so no
    // in-test check can prove "Woo will deliver nothing further" without either Woo-side scheduler
    // introspection (out of scope) or an unbounded wait. What IS deterministic — and is this test's
    // authoritative assertion — is the DELIVERED replay: we trigger it, wait for its marker-matched event to
    // PROCESS, then assert. Woo does not re-deliver a 2xx-acked event (its retries fire only on a non-2xx),
    // so a minute-late duplicate of an already-processed delivery is not part of the model. Against the
    // near-simultaneous duplicates that DO occur (measured: two order.updated seconds apart), we require the
    // settled set to hold a STABLE row count across NUM_STABLE_POLLS further polls (~10s of no new delivery,
    // nudging WP-Cron each time) before concluding the order has quiesced.
    const NUM_STABLE_POLLS = 2
    let settledCount = -1
    let stableHits = 0
    while (Date.now() < deadline) {
      const r = await db.query<{ status: string; attempts: number; lastError: string | null; nextAttemptAt: Date | null }>(
        `select status, attempts, "lastError", "nextAttemptAt" from shopping_webhook_events
          where connector = 'woocommerce' and topic in ('order.created', 'order.updated')
            and ("payloadJson"->>'id')::bigint = $1
            and ($2::text is null or ("payloadJson"->>'customer_note') like '%' || $2 || '%')
          order by "receivedAt"`,
        [wcOrderId, opts.noteContains ?? null],
      )
      const rows = r.rows
      snapshot = rows.length
        ? rows.map((x) => `${x.status}${x.attempts ? ` (attempt ${x.attempts}${x.lastError ? `, last: ${x.lastError}` : ''}${x.nextAttemptAt ? `, next ${x.nextAttemptAt.toISOString()}` : ''})` : ''}`).join('; ')
        : '(no events yet)'
      // PROCESSED / DEAD_LETTER are terminal; PENDING / PROCESSING / FAILED (retryable) are still in flight.
      const inFlight = rows.filter((x) => x.status === 'PENDING' || x.status === 'PROCESSING' || x.status === 'FAILED')
      // requireAllProcessed = idempotency mode: EVERY matched delivery must succeed. A DEAD_LETTERED
      // duplicate means the redelivery was NOT absorbed gracefully — fail immediately rather than let the
      // (unique-constrained) link count and un-re-queued invoice count mask it as a false green.
      if (opts.requireAllProcessed && rows.some((x) => x.status === 'DEAD_LETTER')) {
        throw new Error(`A matched import webhook for WC order ${wcOrderId} DEAD_LETTERED — a duplicate delivery was not absorbed idempotently. State: ${snapshot}`)
      }
      if (rows.length > 0 && inFlight.length === 0) {
        // Settled this poll. In requireAllProcessed mode any dead-letter already threw, so all rows PROCESSED.
        if (opts.requireAllProcessed || rows.some((x) => x.status === 'PROCESSED')) {
          stableHits = settledCount === rows.length ? stableHits + 1 : 0
          settledCount = rows.length
          if (stableHits >= NUM_STABLE_POLLS) return // count held stable across the quiet window -> quiesced
        } else {
          throw new Error(`Every import webhook for WC order ${wcOrderId} settled DEAD_LETTER with none PROCESSED — the import failed permanently. State: ${snapshot}`)
        }
      } else {
        settledCount = -1 // something back in flight -> the quiet window restarts
        stableHits = 0
      }
      await nudgeWpCron(creds)
      await new Promise((res) => setTimeout(res, 5_000))
    }
    throw new Error(`Import webhook(s) for WC order ${wcOrderId} did not all settle within ${timeoutMs}ms. Last: ${snapshot}.`)
  } finally {
    await db.end()
  }
}

/**
 * The "skipped accounting sync" shopping_sync_logs message the WC import writes at its !shouldInvoice
 * branch, AFTER the accounting gate (order-import.ts:711-735). Its presence is durable proof the gate was
 * reached and the sync deliberately skipped — as opposed to never having run. Polls briefly (the barrier
 * has already settled the import, but the row is written near the end of it). Returns null on timeout.
 */
async function skipAccountingLogFor(salesOrderId: string, timeoutMs = 60_000): Promise<string | null> {
  const { Client } = await import('pg')
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const r = await db.query<{ errorMessage: string | null }>(
        `select "errorMessage" from shopping_sync_logs
          where connector = 'woocommerce' and "entityType" = 'ORDER' and "entityId" = $1
            and "errorMessage" ilike '%skipped accounting sync%'
          order by "createdAt" desc limit 1`,
        [salesOrderId],
      )
      if (r.rows.length) return r.rows[0].errorMessage
      await new Promise((res) => setTimeout(res, 2_000))
    }
    return null
  } finally {
    await db.end()
  }
}

/**
 * The ids of every IMS sales order carrying a WC order's number. Reads sales_orders directly (by
 * externalOrderNumber), NOT the shopping_order_links table — that table is unique on
 * (connector, externalOrderId), so counting links is tautologically capped at one and could never observe
 * an ORPHAN duplicate order (one created without a link). Returning the full id set lets the caller both
 * assert exactly one order AND count invoices across all of them, so a duplicate order's invoice (keyed to
 * a different sales-order id) cannot slip past.
 */
async function salesOrderIdsForWcOrderNumber(wcOrderNumber: string): Promise<string[]> {
  const { Client } = await import('pg')
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    const r = await db.query<{ id: string }>(
      `select id from sales_orders where "externalOrderNumber" = $1`, [wcOrderNumber],
    )
    return r.rows.map((row) => row.id)
  } finally {
    await db.end()
  }
}

/** Poll for the SO(s) a reconcile sweep created for a WC order number (import + link writes settle just after). */
async function awaitReconciledSalesOrder(wcOrderNumber: string, timeoutMs = 60_000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs
  let ids = await salesOrderIdsForWcOrderNumber(wcOrderNumber)
  while (ids.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3_000))
    ids = await salesOrderIdsForWcOrderNumber(wcOrderNumber)
  }
  return ids
}

/** How many webhook inbox events reference this WC order — 0 proves an import was NOT webhook-delivered. */
async function inboxEventCountForWcOrder(wcOrderId: number): Promise<number> {
  const { Client } = await import('pg')
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    // Query the JSON value, NOT a text LIKE: payloadJson is JSONB and its text form renders "id": 123 (with a
    // space), so a `%"id":123%` LIKE never matches and would silently report 0 events even when one exists —
    // making the "no webhook delivered" proof a false pass (Codex).
    const r = await db.query<{ n: string }>(
      `select count(*)::text as n from shopping_webhook_events
        where connector = 'woocommerce' and ("payloadJson"->>'id')::bigint = $1`,
      [wcOrderId],
    )
    return Number(r.rows[0]?.n ?? '0')
  } finally {
    await db.end()
  }
}

/** Upsert a settings value (mirrors setPostingMode's shape). */
async function setSetting(key: string, value: string): Promise<void> {
  const { Client } = await import('pg')
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    await db.query(
      `insert into settings (key, value, "updatedAt") values ($1, $2, now())
        on conflict (key) do update set value = excluded.value, "updatedAt" = now()`,
      [key, value],
    )
  } finally {
    await db.end()
  }
}

/**
 * Cancel an order's still-UNPOSTED SALES_INVOICE sync rows (CANCELLED, as the global teardown abandons rows).
 * Lets a test that deliberately leaves an invoice queued dispose of it itself, so a LATER test's whole-queue
 * drain cannot post it into the shared ledger untracked.
 *
 * SAFE BY CONSTRUCTION: only status='PENDING' with externalTransactionId IS NULL — a row never claimed by a
 * worker and never posted. It deliberately does NOT touch a PROCESSING (mid-post) row: flipping its status
 * would not cancel the in-flight Xero call, so an active post could still land or the worker could overwrite
 * CANCELLED. This matches the production primitive cancelOrphanedAccountingSyncRows, which leaves live claims
 * to finish. (In OC-16's own flow nothing ever drains this queue, so the row is always PENDING regardless.)
 * Like that primitive AND the global teardown, it intentionally leaves the mirrored accounting_event as-is —
 * the reconciliation that would read it runs only in batch mode, which this sync-mode suite never triggers.
 */
async function cancelPendingSalesInvoicesForOrders(salesOrderIds: string[]): Promise<void> {
  if (salesOrderIds.length === 0) return
  const url = process.env.DATABASE_URL
  if (!url || url.includes('onetwo3d_ims_dev')) return // never touch stage's queue
  const { Client } = await import('pg')
  const db = new Client({ connectionString: url })
  await db.connect()
  try {
    await db.query(
      `update accounting_sync_logs set status = 'CANCELLED',
              "errorMessage" = 'Cancelled by the OC-16 self-cleanup so a later queue drain cannot post it.'
        where connector = 'xero' and type = 'SALES_INVOICE'::"AccountingSyncType"
          and status = 'PENDING' and "externalTransactionId" is null and "referenceId" = ANY($1)`,
      [salesOrderIds],
    )
  } finally {
    await db.end()
  }
}

/** Total SALES_INVOICE sync logs across a set of sales orders (0 if the set is empty). */
async function salesInvoiceLogCountForOrders(salesOrderIds: string[]): Promise<number> {
  if (salesOrderIds.length === 0) return 0
  const { Client } = await import('pg')
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    const r = await db.query<{ count: string }>(
      `select count(*)::int as count from accounting_sync_logs
        where connector = 'xero' and type = 'SALES_INVOICE'::"AccountingSyncType" and "referenceId" = ANY($1)`,
      [salesOrderIds],
    )
    return Number(r.rows[0]?.count ?? 0)
  } finally {
    await db.end()
  }
}

/** How many accounting sync logs of a type exist for a reference (0 == the sync was never even queued). */
async function accountingLogCountFor(type: string, referenceId: string): Promise<number> {
  const { Client } = await import('pg')
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    const r = await db.query<{ count: string }>(
      `select count(*)::int as count from accounting_sync_logs
        where connector = 'xero' and type = $1::"AccountingSyncType" and "referenceId" = $2`,
      [type, referenceId],
    )
    return Number(r.rows[0]?.count ?? 0)
  } finally {
    await db.end()
  }
}

/** The reservedQty a stock level currently holds for a product+warehouse. */
/** Poll (bounded) for a posted external id — for failure-safe teardown registration when a server action may still be finishing. */
async function awaitPostedExternalId(type: string, referenceId: string, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const id = await postedExternalId(type, referenceId)
    if (id) return id
    if (Date.now() >= deadline) return null
    await new Promise((res) => setTimeout(res, 3_000))
  }
}

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

/** The IMS product id for a SKU. */
async function productIdBySku(sku: string): Promise<string> {
  const { Client } = await import('pg')
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    const r = await db.query<{ id: string }>(`select id from products where sku = $1`, [sku])
    if (!r.rows.length) throw new Error(`No IMS product for SKU ${sku}.`)
    return r.rows[0].id
  } finally {
    await db.end()
  }
}

/** The warehouse id for a code (e.g. CBG). */
async function warehouseIdByCode(code: string): Promise<string> {
  const { Client } = await import('pg')
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    const r = await db.query<{ id: string }>(`select id from warehouses where code = $1`, [code])
    if (!r.rows.length) throw new Error(`No warehouse with code ${code}.`)
    return r.rows[0].id
  } finally {
    await db.end()
  }
}

/** On-hand (physical) quantity a stock level holds for a product+warehouse. */
async function onHandFor(productId: string, warehouseId: string): Promise<number> {
  const { Client } = await import('pg')
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    const r = await db.query<{ quantity: string }>(
      `select quantity::float8 as quantity from stock_levels where "productId" = $1 and "warehouseId" = $2`,
      [productId, warehouseId],
    )
    return Number(r.rows[0]?.quantity ?? 0)
  } finally {
    await db.end()
  }
}

/** The RETURN_INBOUND stock movements a refund created at a warehouse (should be exactly one per refund line). */
async function returnInboundMovementsFor(
  referenceType: string,
  referenceId: string,
  warehouseId: string,
): Promise<Array<{ productId: string; qty: number; unitCostBase: string | null; totalValueBase: string | null }>> {
  const { Client } = await import('pg')
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    const r = await db.query<{ productId: string; qty: number; unitCostBase: string | null; totalValueBase: string | null }>(
      `select "productId", qty::float8 as qty, "unitCostBase", "totalValueBase"
         from stock_movements
        where type = 'RETURN_INBOUND' and "referenceType" = $1 and "referenceId" = $2 and "toWarehouseId" = $3
        order by "createdAt"`,
      [referenceType, referenceId, warehouseId],
    )
    return r.rows
  } finally {
    await db.end()
  }
}

/**
 * Set (or clear) the default-return-warehouse flag used by the Woo refund restock path.
 *
 * refund-sync.ts resolves ONE `defaultReturnWarehouse: true, active: true` warehouse to restock into, so
 * for a qty-refund to restock at all exactly this warehouse must carry the flag. Returns the code of the
 * warehouse that previously held it (or null) so the caller can restore the store afterwards. When turning
 * OFF we re-set whatever was there before (`restoreCode`) rather than blanket-clearing, so we never strip a
 * pre-existing configuration the rig depended on.
 */
async function setDefaultReturnWarehouse(code: string, on: boolean, restoreCode?: string | null): Promise<string | null> {
  const { Client } = await import('pg')
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    const prior = await db.query<{ code: string }>(
      `select code from warehouses where "defaultReturnWarehouse" = true limit 1`,
    )
    const priorCode = prior.rows[0]?.code ?? null
    if (on) {
      // Make exactly `code` the default return warehouse — clear any other holder first so findFirst is
      // deterministic.
      await db.query(`update warehouses set "defaultReturnWarehouse" = false where "defaultReturnWarehouse" = true and code <> $1`, [code])
      await db.query(`update warehouses set "defaultReturnWarehouse" = true where code = $1`, [code])
    } else {
      await db.query(`update warehouses set "defaultReturnWarehouse" = false where code = $1`, [code])
      if (restoreCode) {
        await db.query(`update warehouses set "defaultReturnWarehouse" = true where code = $1`, [restoreCode])
      }
    }
    return priorCode
  } finally {
    await db.end()
  }
}

/**
 * The Xero accounting tax type a named IMS tax rate carries. Used to derive OC-14's EXPECTED per-line tax
 * types from the store's OWN provisioned mappings (not from the sales order's own resolution, which would be
 * circular) — so a build that mis-resolved a line to the wrong code (e.g. NONE) is caught by comparison.
 * Not filtered on `active`: the rate a WC mapping points at may be inactive yet still the correct code.
 */
async function taxTypeForRateName(name: string): Promise<string> {
  const { Client } = await import('pg')
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    const r = await db.query<{ t: string | null }>(
      `select accounting_tax_type as t from tax_rates where name = $1 and accounting_tax_type is not null limit 1`,
      [name],
    )
    if (!r.rows.length || !r.rows[0].t) throw new Error(`No accounting tax type for rate "${name}" — the store's tax mappings are not provisioned as OC-14 expects.`)
    return r.rows[0].t
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
