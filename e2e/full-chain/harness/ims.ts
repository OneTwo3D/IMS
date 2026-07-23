/**
 * IMS side of the full-chain harness (o3d-lgo.4).
 *
 * UI drivers go through the real screens a user would use (Playwright), because the
 * point of this tier is the whole chain, not the services underneath it — those already
 * have unit coverage.
 *
 * Sync triggers, by contrast, call the domain functions DIRECTLY rather than curling
 * /api/cron/*. Two reasons, both learned the hard way:
 *   - the cron routes carry per-route hourly rate limits, so a suite that re-triggers
 *     them gets 429s partway through a run;
 *   - the crontab is app-managed and GLOBAL (syncCrontab writes the single `ims`
 *     crontab with one hardcoded BASE_URL), so this instance must never own a schedule.
 */
import { expect, type Page } from '@playwright/test'

// --- UI drivers --------------------------------------------------------------

export async function openSalesOrder(page: Page, salesOrderId: string): Promise<void> {
  await page.goto(`/sales/${salesOrderId}`)
  await expect(page.getByText(/order/i).first()).toBeVisible({ timeout: 30_000 })
}

/**
 * Allocate → pick → pack → ship, the way an operator does it.
 * Mirrors e2e/xero.spec.ts:createShippedOrderWithPendingAccounting, which is the
 * established shape for this flow.
 */
export async function allocateAndShip(
  page: Page,
  opts: { carrier?: string; tracking?: string } = {},
): Promise<void> {
  // Two different starting points, and assuming the first is why this originally hung:
  //  - a MANUALLY created order arrives DRAFT and needs "Process";
  //  - a WOO-IMPORTED order arrives PROCESSING, already carrying allocations from the
  //    import's auto-allocation — but still PROCESSING, so there is no "Process" button.
  // "Create Shipments" only renders when allocations.length > 0 AND status ===
  // 'ALLOCATED' (so-detail-client.tsx:475), so an imported order sits there forever
  // unless something promotes it. Clicking Auto-Allocate/Re-Allocate is what an
  // operator does, and it runs allocateSalesOrder, which performs the
  // PROCESSING -> ALLOCATED transition (allocation-service.ts:881).
  const processBtn = page.getByRole('button', { name: 'Process' })
  if (await processBtn.isVisible().catch(() => false)) {
    await processBtn.click()
  } else {
    const allocateBtn = page.getByRole('button', { name: /^(Auto-Allocate|Re-Allocate)$/ })
    if (await allocateBtn.isVisible().catch(() => false)) {
      await allocateBtn.click()
    }
  }

  // The shipment button appears only once allocation has settled; poll rather than
  // sleep, because allocation timing varies with stock layout.
  await expect
    .poll(async () => {
      await page.reload()
      return page.getByRole('button', { name: /create shipments/i }).isVisible()
    }, { timeout: 90_000 })
    .toBe(true)

  await page.getByRole('button', { name: /create shipments/i }).click()
  await expect(page.getByText(/shipment from/i)).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: /start picking/i }).click()
  await page.getByRole('button', { name: /mark packed/i }).click()
  await page.getByRole('button', { name: /^Ship$/ }).click()

  const dialog = page.getByRole('dialog', { name: /Ship/i })
  await expect(dialog).toBeVisible()
  if (opts.carrier) await dialog.locator('select').selectOption({ label: opts.carrier }).catch(() => {})
  if (opts.tracking) await dialog.locator('input').first().fill(opts.tracking).catch(() => {})
  await dialog.getByRole('button', { name: /confirm shipment/i }).click()
  await expect(dialog).toBeHidden({ timeout: 30_000 })
  await expect(page.getByText(/^Shipped$/).first()).toBeVisible({ timeout: 30_000 })
}

/** Refund through the UI. Amount is per-line quantity, matching the dialog. */
export async function refundOrder(page: Page, opts: { quantity: number; reason?: string }): Promise<void> {
  await page.getByRole('button', { name: /^Refund$/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Process Refund' })
  await expect(dialog).toBeVisible()
  await dialog.locator('input').first().fill(opts.reason ?? 'full-chain e2e refund')
  await dialog.locator('input[type="number"]').first().fill(String(opts.quantity))
  await dialog.getByRole('button', { name: /confirm refund/i }).click()
  await expect(dialog).toBeHidden({ timeout: 30_000 })
}

/**
 * Write stock OFF against a configured adjustment reason, the way an operator does — the flow
 * that queues an INVENTORY_ADJUSTMENT journal (X-07).
 *
 * A stock adjustment only posts to the ledger when its line carries a reason whose account_code
 * is set (stock-adjustment-apply.ts): the reason account is the P&L/contra leg, inventory (631)
 * the other. A NEGATIVE quantity books a write-off — DR reason account / CR inventory at the FIFO
 * cost of the layers it consumes — so the SKU must already hold priced stock. The plain
 * addStockAdjustment helper never selects a reason (its positive seed posts nothing), which is
 * exactly why it could not exercise this path.
 *
 * Reuses the same "New Stock Adjustment" dialog as addStockAdjustment. `qty` is the magnitude to
 * remove (a positive number entered as a negative quantity); no unit cost is supplied — a
 * write-off is valued from the existing layers, not re-priced.
 */
export async function applyStockWriteOff(
  page: Page,
  opts: { sku: string; qty: number; reasonName: string; warehouseCode: string },
): Promise<void> {
  await page.goto('/stock-control/stock-adjustments')
  await page.getByRole('button', { name: /new adjustment/i }).click()

  const dialog = page.getByRole('dialog', { name: 'New Stock Adjustment' })
  await dialog.getByPlaceholder(/search by sku or name/i).fill(opts.sku)
  await dialog.getByRole('option', { name: new RegExp(opts.sku) }).first().click()

  // Warehouse must be the one holding the stock, or the write-off has no layers to consume.
  const warehouseSelect = dialog.locator('select[aria-label="Warehouse"]').first()
  const wantedOption = warehouseSelect.locator('option', { hasText: opts.warehouseCode })
  await expect(wantedOption.first()).toHaveCount(1)
  const wantedLabel = ((await wantedOption.first().textContent()) ?? '').trim()
  await warehouseSelect.selectOption({ label: wantedLabel })

  // Select the reason by its unique name. Without a reason (value=''), no accountCode resolves and
  // NO journal is queued — the whole point of the test would silently evaporate, so assert it took.
  const reasonSelect = dialog.locator('select[aria-label="Reason"]').first()
  await expect(reasonSelect).toBeVisible({ timeout: 30_000 })
  await reasonSelect.selectOption({ label: opts.reasonName })

  // Negative quantity = removal. No unit cost: a write-off is valued at the consumed layers' cost.
  await dialog.getByRole('spinbutton', { name: /quantity to add or remove/i }).last().fill(String(-Math.abs(opts.qty)))
  await dialog.getByRole('button', { name: /save adjustments/i }).click()
  await dialog.getByText(/1 adjustment saved\./i).waitFor({ timeout: 30_000 })
  await dialog.waitFor({ state: 'hidden' })
}

// --- purchasing -------------------------------------------------------------

/**
 * Open a PO's detail page.
 *
 * Needed because processPendingXeroSyncViaUi navigates AWAY (page.goto('/sync?connector=xero')),
 * so anything driving the PO afterwards is looking at the sync dashboard. Without this, a second
 * receiveGoods hunts for a "Receive Goods" button that is not on the page and simply hangs until
 * the test times out — 15 minutes of nothing, reported as an inscrutable locator.click timeout.
 */
export async function openPurchaseOrder(page: Page, poId: string): Promise<void> {
  await page.goto(`/purchase-orders/${poId}`)
  await expect(page.getByRole('button', { name: /receive goods|create bill|close po/i }).first())
    .toBeVisible({ timeout: 30_000 })
}

/**
 * Raise a PO for a product and send it. Returns the PO id.
 * Mirrors e2e/xero.spec.ts:createReceivedPoWithBill, the established shape for this flow.
 */
export async function createAndSendPo(
  page: Page,
  opts: {
    sku: string
    supplierLabel?: string
    qty?: string
    unitCost?: string
    /** Extra product lines beyond the first (for multi-line POs, e.g. landed-cost distribution across SKUs). */
    extraLines?: Array<{ sku: string; qty: string; unitCost: string }>
    /** An inline landed cost ("Additional Cost") on the PO — distributed into the cost layers at receipt. */
    additionalCost?: { description: string; amount: string; distributionMethod?: 'BY_VALUE' | 'BY_QUANTITY' | 'BY_WEIGHT' | 'EQUAL_SPLIT' }
    /**
     * Raise the PO in a FOREIGN currency (e.g. 'EUR'), with `fxRate` as the booked base→foreign rate the
     * bill records (PP-08). The currency select is driven AFTER the supplier is chosen, because picking a
     * supplier resets the currency to that supplier's default (po-form.tsx handleSupplierChange). A seeded
     * fx_rate for base→currency on or before "now" is REQUIRED — createPurchaseOrder throws
     * "Missing … FX rate" otherwise (purchase-order-fx.ts) — and the typed rate must be within 2% of it
     * (PURCHASE_ORDER_FX_OVERRIDE_TOLERANCE), so the caller seeds the booked rate first and passes it here.
     */
    currency?: string
    fxRate?: string
  },
): Promise<{ poId: string; poReference: string }> {
  await page.goto('/purchase-orders')
  await page.getByRole('button', { name: /new po/i }).click()

  const dialog = page.getByRole('dialog', { name: 'New Purchase Order' })
  await dialog.locator('select').first().selectOption({ label: opts.supplierLabel ?? 'E2E Supplier' })

  // Foreign-currency PO. Do this AFTER the supplier select (which resets currency to the supplier default)
  // and BEFORE entering line costs so the costs are read as foreign amounts. The currency <select> is the
  // only one carrying an <option value="EUR">-style code option; the FX <input> is min=0.0001/step=0.0001,
  // distinct from the qty (min=1) and cost (min=0) line inputs, and is enabled once currency != base.
  if (opts.currency) {
    await dialog.locator(`select:has(option[value="${opts.currency}"])`).selectOption(opts.currency)
    if (opts.fxRate) {
      await dialog.locator('input[type="number"][min="0.0001"][step="0.0001"]').fill(opts.fxRate)
    }
  }

  // A PO line's cost is entered by the BUYER — products carry a sales price, never a purchase cost. Leaving
  // it unset raises the PO at ZERO, which bills at zero and posts a £0 ACCPAY: everything "succeeds" and the
  // numbers are meaningless. The line inputs are unlabelled cells; qty is min=1/step=1, cost is
  // min=0/step=0.01. Each added product appends a row, so line i's inputs are the i-th of each kind.
  const lines = [{ sku: opts.sku, qty: opts.qty ?? '1', unitCost: opts.unitCost ?? '12.00' }, ...(opts.extraLines ?? [])]
  for (let i = 0; i < lines.length; i++) {
    await dialog.getByPlaceholder(/search product to add/i).fill(lines[i].sku)
    await dialog.getByRole('button', { name: new RegExp(lines[i].sku) }).first().click()
    await dialog.locator('input[type="number"][min="1"][step="1"]').nth(i).fill(lines[i].qty)
    await dialog.locator('input[type="number"][min="0"][step="0.01"]').nth(i).fill(lines[i].unitCost)
  }

  // Optional inline landed cost. "Add Cost" appends a row (in a SECOND table) with a Description input and an
  // amount input sharing the line-cost attributes (min=0 step=0.01) — added AFTER every product line, so it
  // is the LAST such input. A distribution-method select in the same row governs how it spreads across lines.
  if (opts.additionalCost) {
    await dialog.getByRole('button', { name: /add cost/i }).click()
    await dialog.getByPlaceholder(/description \(e\.g\. shipping\)/i).fill(opts.additionalCost.description)
    await dialog.locator('input[type="number"][min="0"][step="0.01"]').last().fill(opts.additionalCost.amount)
    await dialog.locator('select').last().selectOption(opts.additionalCost.distributionMethod ?? 'BY_VALUE')
  }

  await dialog.getByRole('button', { name: /create purchase order/i }).click()

  await page.waitForURL(/\/purchase-orders\/.+/)
  const poId = page.url().split('/').pop()!
  await page.getByRole('button', { name: /confirm & send po/i }).click()
  await expect(page.getByText(/^PO Sent$/)).toBeVisible({ timeout: 30_000 })

  // Return the PO's human reference too, so callers can assert the EXACT value rather than a
  // shape. "contains PO-" would accept another order's reference and pass while the ledger trail
  // pointed at the wrong PO.
  //
  // Matched on the reference's own SHAPE, not `heading level 1` — that picks up the layout's
  // top-bar title ("Purchase Orders") rather than the PO, which is how the first cut of this
  // asserted the bill's Reference should equal "Purchase Orders".
  const heading = page.getByRole('heading').filter({ hasText: /^PO-\d{8}-/ }).first()
  await expect(heading).toBeVisible({ timeout: 30_000 })
  const poReference = ((await heading.textContent()) ?? '').trim()
  return { poId, poReference }
}

/**
 * Receive goods against the open PO.
 *
 * `expectStatus` is the caller's claim about the outcome: a full receipt lands RECEIVED,
 * a short one PARTIALLY_RECEIVED (resolved in receivePurchaseOrder,
 * app/actions/purchase-orders.ts:1915). Asserting it here means a partial receipt that
 * silently books as complete fails at the point of the mistake.
 */
export async function receiveGoods(
  page: Page,
  opts: { expectStatus: 'Received' | 'Partially Received'; qty?: string } = { expectStatus: 'Received' },
): Promise<void> {
  await page.getByRole('button', { name: /receive goods/i }).click()
  const dialog = page.getByRole('dialog', { name: /Receive Goods/ })
  await expect(dialog).toBeVisible()
  if (opts.qty !== undefined) {
    await dialog.locator('input[type="number"]').first().fill(opts.qty)
  }
  await dialog.getByRole('button', { name: /confirm receipt/i }).click()
  await expect(dialog).toBeHidden({ timeout: 30_000 })
  await expectPoStatus(page, opts.expectStatus)

  // Then RELOAD, which does a different job from the assertion above and is not redundant with
  // it (I removed it once believing it was, and was wrong).
  //
  // The badge only proves the refresh landed when the status TRANSITIONS. It does not when the
  // status stays put — a second short receipt on an already-PARTIALLY_RECEIVED PO leaves the
  // badge already reading "Partially Received", so the assertion is satisfied by the OLD render
  // and returns before the new line data arrives. The bill dialog then seeds billLines from
  // stale `po.lines` (po-detail-client.tsx:792, a useState initialiser that runs once) and bills
  // the previous received quantity.
  //
  // So: the assertion proves the receipt HAPPENED; the reload guarantees the caller SEES it.
  // One second, and it holds for every receipt rather than only the ones that change status.
  await page.reload()
  await expectPoStatus(page, opts.expectStatus)
}

/**
 * Wait for the PO's STATUS BADGE to read `label`.
 *
 * Scoped to a <span> on purpose. The obvious getByText(/^Received$/) matches a <th> COLUMN
 * HEADER — "Received" heads the quantity column in four separate tables on this page — so it
 * was satisfied the instant the page rendered, whatever the PO status. That assertion could
 * not fail: a receipt that never happened would have sailed through it.
 *
 * The cost was not just a weak assertion. receivePurchaseOrder's handler fires router.refresh()
 * WITHOUT awaiting it and closes the dialog immediately (po-detail-client.tsx:216-219), so
 * returning early handed the caller a page still showing pre-receipt data. The bill dialog then
 * seeds billLines from `po.lines` in a useState INITIALISER (:792) that runs once at mount —
 * reading qtyReceived=0, computing billableCap=0, filtering every line out, and rendering a
 * dialog with NO table. PP-01 passed for days and then spent 33.5s waiting for a table that
 * could never appear, with the receipt long since committed in the database.
 *
 * The badge is rendered from the SERVER's po.status (:2004), so waiting for it proves the refresh
 * landed WHEN THE STATUS CHANGES. It proves nothing when the status stays the same — see the
 * reload in receiveGoods, which covers that case.
 */
async function expectPoStatus(page: Page, label: string): Promise<void> {
  const badge = page.locator('span').filter({ hasText: new RegExp(`^${label}$`) })
  await expect(badge.first()).toBeVisible({ timeout: 30_000 })
}

/**
 * Cancel the PO, the way an operator does.
 *
 * Cancellation is gated to DRAFT or PARTIALLY_RECEIVED (po-detail-client.tsx:1924): a fully
 * RECEIVED PO has no Cancel button at all.
 *
 * ACCEPTS THE NATIVE confirm(). handleCancel guards on window.confirm (:1980), and Playwright
 * auto-DISMISSES native dialogs unless something handles them — so without this the click
 * returns cleanly, NOTHING is cancelled, and the test fails minutes later hunting for a reversal
 * journal that was never requested.
 */
export async function cancelPurchaseOrder(page: Page, opts: { expectStatus?: string } = {}): Promise<void> {
  const expectStatus = opts.expectStatus ?? 'Cancelled'
  const accept = (d: { accept: () => Promise<void> }) => { void d.accept() }
  page.on('dialog', accept)
  try {
    await page.getByRole('button', { name: /^Cancel PO$/ }).click()
    await expectPoStatus(page, expectStatus)
  } finally {
    page.off('dialog', accept)
  }

  // Same reason as receiveGoods: handleCancel fires router.refresh() WITHOUT awaiting it (:1991),
  // so the caller needs a page that has actually re-read the server.
  await page.reload()
  await expectPoStatus(page, expectStatus)
}

/**
 * Return received goods to the supplier, the way an operator does.
 *
 * Unlike cancelPurchaseOrder this is a real shadcn <Dialog>, NOT a native confirm(), so it needs
 * no dialog handler — adding one here would be cargo cult.
 *
 * The button is gated on canReturn && hasReturnable (po-detail-client.tsx:1918/:1926), and
 * hasReturnable is `qtyReceived - qtyReturned > 0`. So there must be RECEIVED, un-returned stock
 * before this is reachable at all: a PO that has only been sent or shipped has no button.
 *
 * REASON IS REQUIRED (:466) and the warehouse must be chosen per line (:434) — the dialog
 * validates both client-side and refuses to submit, which would surface much later as a missing
 * credit note rather than as the form error it actually is.
 */
export async function returnItems(
  page: Page,
  opts: { qty: string; reason: string; notes?: string; expectStatus?: string },
): Promise<void> {
  const expectStatus = opts.expectStatus ?? 'Partially Returned'

  await page.getByRole('button', { name: /return items/i }).click()
  const dialog = page.getByRole('dialog', { name: /Return Items/ })
  await expect(dialog).toBeVisible({ timeout: 30_000 })

  // Same lesson as createBill: the returnable lines arrive asynchronously, so filling the qty
  // before the table exists is a race that only loses under load.
  await expect(dialog.locator('table')).toBeVisible({ timeout: 30_000 })

  await dialog.locator('#returnReason').fill(opts.reason)
  if (opts.notes) await dialog.locator('#returnNotes').fill(opts.notes)

  await dialog.locator('input[type="number"]').first().fill(opts.qty)

  // The warehouse <select> opens on "Select…" (index 0) and the dialog rejects that with
  // "Select a warehouse for each line". Index 1 is the first real warehouse.
  const warehouse = dialog.locator('select').first()
  await expect(warehouse).toBeVisible({ timeout: 30_000 })
  await warehouse.selectOption({ index: 1 })

  await dialog.getByRole('button', { name: /confirm return/i }).click()
  await expect(dialog).toBeHidden({ timeout: 30_000 })

  await page.reload()
  await expectPoStatus(page, expectStatus)
}

/**
 * Post the return-generated supplier credit note to the accounting connector.
 *
 * A return does NOT post a credit note by itself: returnPurchaseOrder only DRAFTS one, and only
 * when the PO already has a bill (purchase-orders.ts:2405). An operator then posts it from the
 * "Supplier credit notes" card, which is what queues PURCHASE_CREDIT_NOTE (:3727).
 *
 * The card self-hides when there are no credits and no bills, so its presence is itself the
 * assertion that the draft was created.
 */
export async function postSupplierCreditNote(page: Page): Promise<void> {
  // Match the card heading's "Supplier credit notes (N)" specifically. A bare /Supplier credit
  // notes/i also matches the prose hint above the table ("…(Supplier credit notes, below)…",
  // po-detail-client.tsx:2121), so it resolves to two elements and strict mode throws.
  const card = page.getByText(/Supplier credit notes \(\d+\)/i)
  await expect(card).toBeVisible({ timeout: 30_000 })

  const post = page.getByRole('button', { name: /^Post$/ })
  await expect(post).toBeVisible({ timeout: 30_000 })
  await post.click()

  // The row's badge flips DRAFT -> POSTED once the action returns. Waiting on the badge rather
  // than the button avoids racing the "Posting…" label back to "Post".
  await expect(page.getByText(/^POSTED$/).first()).toBeVisible({ timeout: 60_000 })
}

/**
 * Record a MANUAL freight/additional-cost supplier credit note against the PO's bill — the
 * "Record credit note" flow on the Supplier credit notes card (recordSupplierFreightCreditNote,
 * supplier-credit-notes-card.tsx). Unlike a goods return (which DRAFTS a credit automatically),
 * an over-charged or duplicate freight bill is credited BY HAND: enter a GROSS amount and it drafts
 * a credit note the operator then posts with postSupplierCreditNote(). Requires the PO to already
 * have a bill (the card self-hides otherwise).
 */
export async function recordFreightCreditNote(
  page: Page,
  opts: { amount: string; creditNoteNumber?: string; reason?: string },
): Promise<void> {
  await page.getByRole('button', { name: /record credit note/i }).click()
  const dialog = page.getByRole('dialog', { name: /Record supplier credit note/i })
  await expect(dialog).toBeVisible({ timeout: 30_000 })
  await dialog.locator('#cn-amount').fill(opts.amount)
  if (opts.creditNoteNumber) await dialog.locator('#cn-number').fill(opts.creditNoteNumber)
  await dialog.locator('#cn-reason').fill(opts.reason ?? 'Duplicate freight bill')
  await dialog.getByRole('button', { name: /record \(draft\)/i }).click()
  await expect(dialog).toBeHidden({ timeout: 30_000 })
}

/**
 * Enter the supplier bill against the PO. Returns the supplier invoice number used.
 *
 * `expectBillCount` is how many bills the PO should carry AFTERWARDS, and defaults to the first.
 * A PO received in instalments is billed in instalments, so the "Bills (n)" confirmation cannot
 * be hardcoded to 1 — doing so would make the second bill of a two-delivery PO look like a
 * failure while it had in fact been created perfectly.
 */
// A minimal but structurally-valid PDF (header + one empty page + xref/trailer). The upload endpoint
// (/api/upload/invoice) accepts it by magic bytes + extension; it only needs to round-trip to Xero as an
// attachment, not render anything. Kept inline so the harness needs no on-disk fixture.
const MINIMAL_PDF = Buffer.from(
  '%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 3 3]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
  'latin1',
)

export async function createBill(
  page: Page,
  opts: { reference: string; expectBillCount?: number; includeAdditionalCosts?: boolean; attachPdf?: boolean },
): Promise<string> {
  await page.getByRole('button', { name: /create bill/i }).click()
  const dialog = page.getByRole('dialog', { name: /Create Bill/ })
  await expect(dialog).toBeVisible({ timeout: 30_000 })

  // WAIT for the billable lines to load before clicking Next.
  //
  // Step 1 renders its table only once billLines is populated (po-detail-client.tsx:952),
  // and the lines arrive asynchronously. The pattern this was lifted from
  // (xero.spec.ts:createReceivedPoWithBill) clicks Next immediately, relying on the rows
  // being there and pre-selected — so it is a race, not a wait. It won running alone and
  // lost behind the slower order-to-cash tests: Next fired against an empty selection,
  // the wizard stayed on step 1 showing "Select at least one line", and the failure
  // surfaced 30s later as a confusing "Review & Confirm dialog not found".
  // Scope to the FIRST table — the billable GOODS lines. A PO carrying an inline landed cost renders a
  // SECOND table (the additional-costs billing rows), so a bare `dialog.locator('table')` is a strict-mode
  // violation. `.first()` is the goods-lines table on every PO (single-table POs are unaffected).
  const linesTable = dialog.locator('table').first()
  await expect(linesTable).toBeVisible({ timeout: 30_000 })
  const firstLine = linesTable.locator('tbody input[type="checkbox"]').first()
  await expect(firstLine).toBeVisible({ timeout: 30_000 })
  if (!(await firstLine.isChecked())) await firstLine.check()

  // When the PO carries landed costs, also select every row in the SECOND (additional-costs) table so the
  // freight is billed too. Leaving it unbilled would credit transit for the landed value at receipt but only
  // debit the goods portion — stranding a permanent transit balance (Codex).
  if (opts.includeAdditionalCosts) {
    const costsTable = dialog.locator('table').nth(1)
    await expect(costsTable).toBeVisible({ timeout: 30_000 })
    const costBoxes = costsTable.locator('tbody input[type="checkbox"]')
    const n = await costBoxes.count()
    expect(n, 'the additional-costs table should have at least one billable row').toBeGreaterThan(0)
    for (let i = 0; i < n; i++) {
      const box = costBoxes.nth(i)
      if (!(await box.isChecked())) await box.check()
    }
  }

  await dialog.getByRole('button', { name: /^Next$/ }).click()
  // Explicit timeout: this inherited Playwright's 5s default while every neighbour waits
  // 30s. A load-sensitive default is a flake generator.
  await expect(page.getByRole('dialog', { name: /Create Bill — Review & Confirm/ })).toBeVisible({ timeout: 30_000 })
  await dialog.getByPlaceholder(/supplier's invoice/i).fill(opts.reference)
  // Attach a supplier-invoice PDF (the hidden accept=".pdf" input in the review step). This sets
  // supplierInvoiceUrl on the bill, which becomes supplierInvoicePath and drives the BILL_ATTACHMENT
  // follow-up (PP-10). setInputFiles works on the hidden input; wait for the "Uploaded" badge so the
  // async upload has resolved before confirming.
  if (opts.attachPdf) {
    await dialog.locator('input[type="file"]').setInputFiles({
      name: `supplier-invoice-${opts.reference}.pdf`,
      mimeType: 'application/pdf',
      buffer: MINIMAL_PDF,
    })
    await expect(dialog.getByText(/^Uploaded$/)).toBeVisible({ timeout: 30_000 })
  }

  await dialog.getByRole('button', { name: /confirm bill/i }).click()
  await expect(dialog).toBeHidden({ timeout: 30_000 })
  await expect(page.getByRole('button', { name: new RegExp(`Bills \\(${opts.expectBillCount ?? 1}\\)`) }))
    .toBeVisible({ timeout: 30_000 })
  return opts.reference
}

/**
 * Mark the PO's (single) bill as paid from a chosen bank account, the way an operator does — the AP mirror
 * of a customer payment (PP-09). This is the ONLY in-app trigger for a BILL_PAYMENT (and, for a foreign
 * bill, the REALISED_FX_JOURNAL): markBillPaid enqueues both (app/actions/purchase-orders.ts). It is an
 * OPERATOR action against an EXPLICIT bank account, NOT the payment-account map — that map is read only on
 * the sales side (enqueueSalesInvoiceFollowUps), so unlike OC-15 there is no per-test map to configure here.
 *
 * The bill must already carry an accountingInvoiceId (i.e. its PURCHASE_INVOICE CREATE has posted and been
 * written back) BEFORE this runs, or markBillPaid records the payment locally only and queues nothing to
 * Xero (po-detail-client.tsx warns exactly this). Callers therefore drain the bill to Xero first.
 *
 * `bankAccountId` is the Bank Account <option> VALUE — the connector-native id (Xero AccountID,
 * accounting_accounts.externalAccountId), which the caller resolves from the DB. Selecting by value rather
 * than the "<code> — <name>" option text is deterministic and sidesteps the em-dash in that label. PP-09
 * settles a GBP bill from the Business Bank Account (090); PP-08 settles a EUR bill from a EUR bank account
 * (avoiding a cross-currency payment). `paymentDate` overrides the dialog's today default (PP-08 dates the
 * settlement so its seeded settlement FX rate is the latest on or before it).
 */
export async function markBillPaidViaUi(
  page: Page,
  opts: { bankAccountId: string; reference?: string; paymentDate?: string },
): Promise<void> {
  // The Bills section is collapsed by default (po-detail-client.tsx showInvoices=false); expand it so the
  // per-bill "Mark Paid" button renders. Idempotent-safe: only toggle when the button is not already shown.
  const markPaidBtn = page.getByRole('button', { name: /^Mark Paid$/ }).first()
  if (!(await markPaidBtn.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: /^Bills \(\d+\)$/ }).click()
  }
  await expect(markPaidBtn).toBeVisible({ timeout: 30_000 })
  await markPaidBtn.click()

  const dialog = page.getByRole('dialog', { name: /Mark Bill as Paid/i })
  await expect(dialog).toBeVisible({ timeout: 30_000 })
  // Bank accounts load asynchronously (getBillPaymentAccounts on mount); the select is absent until then.
  const bankSelect = dialog.locator('#bank-account')
  await expect(bankSelect).toBeVisible({ timeout: 30_000 })
  await bankSelect.selectOption({ value: opts.bankAccountId })
  if (opts.paymentDate) await dialog.locator('#payment-date').fill(opts.paymentDate)
  if (opts.reference !== undefined) await dialog.locator('#payment-ref').fill(opts.reference)

  await dialog.getByRole('button', { name: /^Mark Paid$/ }).click()
  await expect(dialog).toBeHidden({ timeout: 30_000 })
  // The bill row flips to a "Paid" badge once markBillPaid returns and the page refreshes.
  await expect(page.getByText(/^Paid/).first()).toBeVisible({ timeout: 30_000 })
}

/** Drive the Xero connector page's "Process pending now". */
export async function processPendingXeroSyncViaUi(page: Page): Promise<void> {
  await page.goto('/sync?connector=xero')
  await expect(page.getByRole('heading', { name: 'Xero Connector' })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Sync' }).click()
  const btn = page.getByRole('button', { name: /process pending now/i })
  await expect(btn).toBeEnabled()
  await btn.click()
  await expect(page.getByText(/Sync complete:/i)).toBeVisible({ timeout: 120_000 })
}

// --- direct sync triggers ----------------------------------------------------

/**
 * Post everything queued to Xero.
 *
 * NB this drains the WHOLE pending queue, which is why full-chain specs must run
 * serially and why the rig has its own database — on a shared queue it would post
 * unrelated documents to the ledger.
 */
export async function processPendingXeroSync(): Promise<unknown> {
  // Import the module directly, NOT the ../xero/index.ts barrel: the barrel drags in a
  // graph with a CJS/ESM mismatch and dies with "Cannot use import statement outside a
  // module". The other two triggers below already import their module directly, which is
  // why only this one broke.
  const { processPendingXeroSync: run } = await import('../../../lib/connectors/xero/sync-processor.ts')
  return run()
}

/**
 * Run the daily batch — Groups A1 → A2 → B, plus the three reconciliation sweeps —
 * IN THE APP, via its cron route.
 *
 * NOT a direct `import(daily-sync.ts)`: that module's graph reaches the invoice-PDF stack
 * (pdfkit/sharp) and other CJS-only packages, so pulling it into the Playwright process
 * dies with "Cannot use import statement outside a module" — the same reason
 * processPendingXeroSync and runWcOrderReconcile go through the app rather than importing
 * their module here. Driving the route runs runDailyBatchSync where those deps resolve,
 * and is the faithful path (the poster has NO server action or UI button — the cron is the
 * only in-app trigger, app/actions/accounting-batch.ts:71).
 *
 * Auth is the cron bearer secret (lib/cron-auth.ts). The route is rate-limited to ONCE per
 * hour (lib/cron-rate-limit.ts, memory-backed), so a debugging re-run inside the hour 429s
 * — restart ims-e2e-dev.service between runs to clear the bucket, which also clears the
 * login limiter.
 *
 * Returns the batch result (groupA1/A2/B counts, errors, sweep deltas) parsed from the
 * response — runDailyBatchSync only QUEUES the journals (PENDING); drain them to Xero with
 * processPendingXeroSyncViaUi afterwards.
 */
export async function runDailyBatch(page: Page): Promise<Record<string, unknown>> {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    throw new Error('CRON_SECRET is not set in the test environment — cannot trigger the daily-batch cron route.')
  }
  const res = await page.request.get('/api/cron/accounting-daily-batch', {
    headers: { Authorization: `Bearer ${secret}` },
  })
  if (!res.ok()) {
    throw new Error(`daily-batch cron HTTP ${res.status()}: ${(await res.text()).slice(0, 300)}`)
  }
  const body = (await res.json()) as Record<string, unknown>
  // The route answers 200 with { skipped, reason } when the plugin/flags are off — a batch
  // that never ran must fail the test loudly, not silently return zero counts.
  if (body.skipped) {
    throw new Error(`daily batch was skipped: ${String(body.reason ?? 'unknown reason')}`)
  }
  return body
}

/** Detect paid/reversed invoices + bills (the chargeback path). */
export async function runPaymentPoll(): Promise<unknown> {
  const { pollXeroPayments } = await import('../../../lib/connectors/xero/payment-poller.ts')
  return pollXeroPayments()
}

/**
 * Drive the WooCommerce order reconcile sweep — the safety net that ingests orders the realtime webhook
 * missed. Posts the operator's "manual sync" endpoint (admin-authed, which the page already is), which runs
 * syncNewWcOrders({ mode: 'manual_reconcile' }) IN THE APP and awaits it. This deliberately goes through the
 * route rather than importing order-import.ts into the Playwright process: that module's graph pulls a
 * CJS-only dependency and dies with "Cannot use import statement outside a module" (the same reason
 * processPendingXeroSync drives the Xero sync through the UI). manual_reconcile honours wc_sync_order_statuses
 * and adds 'completed', and is ungated (unlike runWcReconcile's 24h webhook-primary interval).
 */
export async function runWcOrderReconcile(
  page: Page,
  opts: { allowErrors?: boolean } = {},
): Promise<{ synced: number; skipped: number; errors: string[] }> {
  const res = await page.request.post('/api/shopping/manual-sync', {
    data: { type: 'orders', connector: 'woocommerce' },
  })
  if (!res.ok()) {
    throw new Error(`WC manual reconcile HTTP ${res.status()}: ${(await res.text()).slice(0, 300)}`)
  }
  // Validate the RESULT, not just the HTTP status: the route answers 200 { success:true } even when
  // syncNewWcOrders reported per-order or fetch failures in result.errors (WooCommerce unavailable, auth,
  // rate limit). Left unchecked, a negative assertion (OC-20) could pass because reconciliation did nothing.
  const body = (await res.json()) as {
    success?: boolean
    error?: string
    result?: { synced?: number; skipped?: number; errors?: string[] }
  }
  if (!body.success) {
    throw new Error(`WC manual reconcile not successful: ${body.error ?? JSON.stringify(body).slice(0, 300)}`)
  }
  const result = body.result ?? {}
  // By default a reported per-order/fetch error is a hard failure (a WooCommerce outage must not read as a
  // clean no-op). OC-17 opts into allowErrors: a missing-FX order is EXPECTED to fail import and quarantine,
  // and the test asserts that outcome from result.errors + the pending-FX queue.
  if (!opts.allowErrors && result.errors && result.errors.length) {
    throw new Error(`WC manual reconcile reported ${result.errors.length} order error(s): ${result.errors.slice(0, 3).join('; ')}`)
  }
  return { synced: result.synced ?? 0, skipped: result.skipped ?? 0, errors: result.errors ?? [] }
}

/**
 * Drain the shopping-webhook inbox — the consumer that reprocesses PENDING
 * `shopping_webhook_events` into sales orders — IN THE APP, via its cron route.
 *
 * Same reasoning as runDailyBatch: the domain job (processPendingWcWebhookEvents) reaches
 * a CJS-only graph and cannot be imported into the Playwright process, so the faithful
 * trigger is the cron route. Auth is the cron bearer secret (lib/cron-auth.ts).
 *
 * Two behaviours the caller must respect:
 *   - the woocommerce tick only PROCESSES when wc_sync_enabled is true; with the gate off
 *     it returns { skipped: true, reason: 'wc_sync_disabled' } and drains nothing (the
 *     route reads the gate per-connector, app/api/cron/shopping-webhook-inbox/route.ts);
 *   - it is rate-limited to CRON_RATE_LIMIT_FIVE_MINUTE_MAX (15) per five minutes per IP,
 *     far looser than the daily batch's 1/hour, so ordinary retries are fine.
 *
 * Returns the parsed WOOCOMMERCE connector tick — either the
 * ProcessPendingWcWebhookEventsResult counters { attempted, processed, failed,
 * deadLettered, skipped } or a { skipped, reason } shape.
 */
export async function runInboxDrain(page: Page): Promise<Record<string, unknown>> {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    throw new Error('CRON_SECRET is not set in the test environment — cannot trigger the shopping-webhook-inbox cron route.')
  }
  const res = await page.request.get('/api/cron/shopping-webhook-inbox', {
    headers: { Authorization: `Bearer ${secret}` },
  })
  if (!res.ok()) {
    throw new Error(`shopping-webhook-inbox cron HTTP ${res.status()}: ${(await res.text()).slice(0, 300)}`)
  }
  const body = (await res.json()) as { connectors?: { woocommerce?: Record<string, unknown> } }
  const wc = body.connectors?.woocommerce
  if (!wc) {
    throw new Error(`shopping-webhook-inbox response missing the woocommerce connector tick: ${JSON.stringify(body).slice(0, 300)}`)
  }
  return wc
}

// --- manufacturing ----------------------------------------------------------

/**
 * Create a manufacturing order for a BOM product and open its detail page, the way an operator
 * does (X-05). Returns the production-order id (the URL tail), which is the referenceId every
 * MANUFACTURING_JOURNAL / MANUFACTURING_RECLASS sync log keys on.
 *
 * The MO is created in DRAFT — it posts NOTHING yet. The manufacturing overhead journal only
 * appears at completion, and only if an overhead cost line was added first (a bare component→
 * finished-goods movement nets to zero on the inventory account, so with no overhead there is no
 * journal at all). Mirrors the proven flow in admin-workflows.spec.ts:252.
 */
export async function createManufacturingOrder(
  page: Page,
  opts: { bomSku: string; warehouseCode: string; qty: number },
): Promise<string> {
  await page.goto('/manufacturing')
  await page.getByRole('button', { name: /new order/i }).click()

  const dialog = page.getByRole('dialog', { name: /New Manufacturing Order/i })
  await expect(dialog).toBeVisible({ timeout: 30_000 })
  await dialog.getByPlaceholder(/search by sku or name/i).fill(opts.bomSku)
  await dialog.getByRole('button', { name: new RegExp(opts.bomSku) }).first().click()
  // Consume from the warehouse holding the seeded component stock. The option label carries the
  // warehouse NAME plus its code in parentheses (e.g. "Cambridge (CBG)"), so match by the code
  // substring rather than a hardcoded label (mirrors addStockAdjustment's warehouse pick).
  const warehouseSelect = dialog.locator('select').first()
  const wanted = warehouseSelect.locator('option', { hasText: opts.warehouseCode })
  await expect(wanted.first()).toHaveCount(1)
  const wantedLabel = ((await wanted.first().textContent()) ?? '').trim()
  await warehouseSelect.selectOption({ label: wantedLabel })
  await dialog.locator('input[type="number"]').first().fill(String(opts.qty))
  await dialog.getByRole('button', { name: /create order/i }).click()

  // The new order lands in the list; open it and confirm we are on a detail page that offers the
  // DRAFT→IN_PROGRESS action, so subsequent steps drive the right screen.
  const row = page.getByRole('row').filter({ hasText: opts.bomSku }).first()
  await expect(row).toBeVisible({ timeout: 30_000 })
  await Promise.all([
    page.waitForURL(/\/manufacturing\/.+/),
    row.locator('td').first().click(),
  ])
  await expect(page.getByRole('button', { name: /start production/i })).toBeVisible({ timeout: 30_000 })
  return page.url().split('/').pop()!
}

/**
 * Open an MO detail page by id. Needed because processPendingXeroSyncViaUi navigates AWAY to the
 * sync dashboard, so anything driving the MO afterwards (e.g. the post-completion cost-line edit that
 * triggers MANUFACTURING_RECLASS) must first return to the detail page — otherwise it hunts for the
 * cost editor on /sync and hangs. Same hazard as openPurchaseOrder.
 */
export async function openManufacturingOrder(page: Page, moId: string): Promise<void> {
  await page.goto(`/manufacturing/${moId}`)
  await expect(page.getByRole('button', { name: /save manufacturing costs/i })).toBeVisible({ timeout: 30_000 })
}

/**
 * Add an overhead cost line on the MO detail page and save it — the capitalised overhead that
 * MANUFACTURING_JOURNAL books (DR inventory / CR the line's account) at completion. `accountCode`
 * overrides the default overhead account per line; omit it to use xero_manufacturing_overhead_account.
 * The cost editor is editable in any non-CANCELLED status, so this works before completion (to seed
 * the journal) or after (to trigger a MANUFACTURING_RECLASS — see editManufacturingCostLineAmount).
 */
export async function addManufacturingCostLine(
  page: Page,
  opts: { description: string; amount: string; accountCode?: string },
): Promise<void> {
  await page.getByRole('button', { name: /add line/i }).click()
  await page.getByPlaceholder(/e\.g\. Labour, Machine time/i).last().fill(opts.description)
  await page.getByPlaceholder('0.00').last().fill(opts.amount)
  if (opts.accountCode) await page.getByPlaceholder(/default overhead account/i).last().fill(opts.accountCode)
  await page.getByRole('button', { name: /save manufacturing costs/i }).click()
  await expect(page.getByText(/^Saved\.$/)).toBeVisible({ timeout: 30_000 })
}

/**
 * Change the (single) overhead cost line's amount on an already-COMPLETED MO and save — the edit
 * that queues a MANUFACTURING_RECLASS reclassifying the overhead delta between inventory (units
 * still on hand) and COGS (units already consumed). Targets the first amount input.
 */
export async function editManufacturingCostLineAmount(page: Page, amount: string): Promise<void> {
  await page.getByPlaceholder('0.00').first().fill(amount)
  await page.getByRole('button', { name: /save manufacturing costs/i }).click()
  await expect(page.getByText(/^Saved\.$/)).toBeVisible({ timeout: 30_000 })
}

/** DRAFT → IN_PROGRESS. Reserves component stock; posts no journal. */
export async function startProduction(page: Page): Promise<void> {
  await page.getByRole('button', { name: /start production/i }).click()
  await expect(page.getByText(/^IN PROGRESS$/i).first()).toBeVisible({ timeout: 30_000 })
}

/**
 * IN_PROGRESS → COMPLETED. Consumes the component layers, creates the finished-goods layer, and —
 * if an overhead cost line exists — queues the MANUFACTURING_JOURNAL. Completing at the planned
 * quantity (the dialog default) avoids any yield-loss reweighting.
 */
export async function completeProduction(page: Page): Promise<void> {
  await page.getByRole('button', { name: /mark completed/i }).click()
  const dialog = page.getByRole('dialog', { name: /Complete production/i })
  await expect(dialog).toBeVisible({ timeout: 30_000 })
  await dialog.getByRole('button', { name: /^Complete$/ }).click()
  await expect(dialog).toBeHidden({ timeout: 30_000 })
  await expect(page.getByText(/^COMPLETED$/i).first()).toBeVisible({ timeout: 30_000 })
}

// --- posting-mode control ----------------------------------------------------

/**
 * Arm/disarm this instance's Xero posting for a test.
 *
 * The rig starts DISARMED on purpose, so nothing posts to the shared Demo ledger until
 * a test explicitly asks. isDailyBatchPostingEnabled() (lib/accounting.ts:196) is
 * `xero_sync_enabled && xero_daily_batch_enabled`, and that flag is a BRANCH, not a
 * detail: in batch mode shipment COGS appears only via runDailyBatchSync's Group B,
 * while outside it COGS_JOURNAL comes only from landed-cost revaluation. Tests that
 * care must exercise both.
 */
export async function setPostingMode(mode: { sync: boolean; dailyBatch: boolean }): Promise<void> {
  const { Client } = await import('pg')
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    if ((process.env.DATABASE_URL ?? '').includes('onetwo3d_ims_dev')) {
      throw new Error('ABORT: refusing to arm posting against the STAGE database.')
    }
    for (const [key, value] of [
      ['xero_sync_enabled', String(mode.sync)],
      ['xero_daily_batch_enabled', String(mode.dailyBatch)],
    ] as const) {
      await db.query(
        `insert into settings (key, value, "updatedAt") values ($1, $2, now())
           on conflict (key) do update set value = excluded.value, "updatedAt" = now()`,
        [key, value],
      )
    }
  } finally {
    await db.end()
  }
}

// --- stock-transfer drivers (X-06) -------------------------------------------
//
// A warehouse-to-warehouse transfer posts NO Xero journal (app/actions/transfers.ts has zero
// accounting calls). X-06 uses a real transfer only to CONSUME the goods PO's source cost layer
// via TRANSFER_OUT (writing stock_transfer_lines.costLayerSnapshot), which is what the retrospective
// landed-cost recalc reads to EXCLUDE those units from COGS. The transfer server actions are guarded
// by requirePermission, so they cannot be called headless — they must go through the authenticated UI.

/**
 * Create a DRAFT stock transfer of `qty` units of `sku` from one warehouse to another, the way an
 * operator does. Warehouses are selected by their internal id (the <option> value), resolved by the
 * caller from the DB, so the source is deterministically the warehouse the goods receipt landed in.
 * Returns the transfer's human reference (TRF-YYYYMMDD-…), the handle for dispatch/receive.
 */
export async function createStockTransfer(
  page: Page,
  opts: { fromWarehouseId: string; toWarehouseId: string; sku: string; qty: number },
): Promise<string> {
  await page.goto('/stock-control/transfers')
  await page.getByRole('button', { name: /new transfer/i }).click()

  const dialog = page.getByRole('dialog', { name: 'New Stock Transfer' })
  await expect(dialog).toBeVisible({ timeout: 30_000 })

  // The two warehouse <select>s are, in DOM order, From then To (the warehouse grid renders them in
  // that order). Selecting by the <option> value (warehouse id) is deterministic and sidesteps the
  // em-dash in the "CODE — Name" label text.
  const selects = dialog.locator('select')
  await selects.nth(0).selectOption(opts.fromWarehouseId)
  await selects.nth(1).selectOption(opts.toWarehouseId)

  // Search the product in, then click the result. The result rows fire on mousedown (before the
  // input's 150ms blur-hide), so a normal click — which presses mousedown first — selects it.
  await dialog.getByPlaceholder(/search by sku or name/i).fill(opts.sku)
  await dialog.getByRole('button', { name: new RegExp(opts.sku) }).first().click()

  // The line's qty input is min=1/step=1; it is the only number input in the dialog.
  await dialog.locator('input[type="number"][min="1"][step="1"]').first().fill(String(opts.qty))

  await dialog.getByRole('button', { name: /save as draft/i }).click()
  await expect(dialog).toBeHidden({ timeout: 30_000 })

  // The new DRAFT is prepended to the list. Read its reference back off the row so dispatch/receive
  // can target exactly this transfer (the list may hold prior transfers).
  const row = page.locator('tr').filter({ hasText: /TRF-\d{8}-/ }).first()
  await expect(row).toBeVisible({ timeout: 30_000 })
  const reference = ((await row.locator('td').first().textContent()) ?? '').trim()
  if (!/^TRF-\d{8}-/.test(reference)) {
    throw new Error(`createStockTransfer: could not read the new transfer reference (got "${reference}")`)
  }
  return reference
}

/** Locate a transfer's summary row by its reference. */
function transferRow(page: Page, reference: string) {
  return page.locator('tr').filter({ hasText: reference }).first()
}

/**
 * Dispatch the DRAFT transfer (DRAFT → IN_TRANSIT). This books stock OUT of the source warehouse and
 * consumes its FIFO cost layers, writing the costLayerSnapshot the reval exclusion reads. Guarded by a
 * native confirm() — Playwright auto-dismisses those unless something accepts, so without the handler
 * the click is a silent no-op (same trap as cancelPurchaseOrder).
 */
export async function dispatchStockTransfer(page: Page, reference: string): Promise<void> {
  await page.goto('/stock-control/transfers')
  const row = transferRow(page, reference)
  await expect(row).toBeVisible({ timeout: 30_000 })

  const accept = (d: { accept: () => Promise<void> }) => { void d.accept() }
  page.on('dialog', accept)
  try {
    await row.getByRole('button', { name: /dispatch/i }).click()
    // The row flips to the In Transit badge once the action resolves (router.refresh is fired without
    // await, so wait on the server-rendered badge rather than returning early).
    await expect(transferRow(page, reference).getByText(/^In Transit$/)).toBeVisible({ timeout: 30_000 })
  } finally {
    page.off('dialog', accept)
  }
  await page.reload()
  await expect(transferRow(page, reference).getByText(/^In Transit$/)).toBeVisible({ timeout: 30_000 })
}

/**
 * Receive the whole in-transit transfer (IN_TRANSIT → RECEIVED) via "Mark Received". This recreates the
 * FIFO layers at the destination warehouse (linked back to the source layer via costLayerSourceLine), so
 * the landed-cost reval propagates the revaluation to the on-hand destination units.
 */
export async function receiveStockTransfer(page: Page, reference: string): Promise<void> {
  await page.goto('/stock-control/transfers')
  const row = transferRow(page, reference)
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.getByRole('button', { name: /mark received/i }).click()
  await expect(transferRow(page, reference).getByText(/^Received$/)).toBeVisible({ timeout: 30_000 })
  await page.reload()
  await expect(transferRow(page, reference).getByText(/^Received$/)).toBeVisible({ timeout: 30_000 })
}

/**
 * Create a FREIGHT-type "Landed Cost PO" linked to an already-confirmed goods PO, the way an operator
 * does — the New Landed Cost PO dialog on the PO list (freight-po-form.tsx → createFreightPo). Creating
 * it runs recalculateLandedCosts SYNCHRONOUSLY and queues the STOCK_IN_TRANSIT (and, for consumed units,
 * COGS_JOURNAL) revaluation journals. Base currency only (no FX). Returns the new freight PO's id.
 */
export async function createLandedCostPo(
  page: Page,
  opts: { goodsPoReference: string; supplierLabel?: string; amount: string; description?: string },
): Promise<{ freightPoId: string }> {
  await page.goto('/purchase-orders')
  await page.getByRole('button', { name: /landed cost po/i }).click()

  const dialog = page.getByRole('dialog', { name: 'New Landed Cost PO' })
  await expect(dialog).toBeVisible({ timeout: 30_000 })

  // Supplier is the first <select> in the header. Pick the shared E2E supplier by default.
  await dialog.locator('select').first().selectOption({ label: opts.supplierLabel ?? 'E2E Supplier' })

  // Link the goods PO by ticking its checkbox row (matched by the PO reference).
  const poRow = dialog.locator('label').filter({ hasText: opts.goodsPoReference }).first()
  await expect(poRow).toBeVisible({ timeout: 30_000 })
  const poBox = poRow.locator('input[type="checkbox"]')
  if (!(await poBox.isChecked())) await poBox.check()

  // Add one cost line: description + amount, distributed BY_VALUE (the default). The amount input is
  // min=0/step=0.01 and appears only after "Add Cost".
  await dialog.getByRole('button', { name: /add cost/i }).click()
  await dialog.getByPlaceholder(/description/i).fill(opts.description ?? 'Freight')
  await dialog.locator('input[type="number"][min="0"][step="0.01"]').first().fill(opts.amount)

  await dialog.getByRole('button', { name: /create landed cost po/i }).click()
  // On success the app navigates to the new freight PO.
  await page.waitForURL(/\/purchase-orders\/.+/, { timeout: 30_000 })
  const freightPoId = page.url().split('/').pop()!
  await expect(page.getByRole('heading').filter({ hasText: /^PO-\d{8}-/ }).first()).toBeVisible({ timeout: 30_000 })
  return { freightPoId }
}

/**
 * Trigger the IMS↔Xero tax-rate drift detection cron IN THE APP, via its route (X-04). Same shape as
 * runDailyBatch: the poster has no server action or UI button — the CRON_SECRET-gated cron is the only
 * in-app trigger (app/api/cron/xero-tax-rate-drift/route.ts). Returns the parsed sweep result
 * ({ checked, drifted }); throws on a non-2xx or a { skipped } body (plugin off / not connected), so a
 * sweep that never ran fails the test loudly rather than reading as zero drift.
 *
 * The route is rate-limited 1/hour/IP by default; X-04 runs it three times in one test, which is why
 * 'xero-tax-rate-drift' is in E2E_OVERRIDE_JOBS (lib/cron-rate-limit.ts) and the rig sets
 * E2E_TEST_MODE=1 + E2E_CRON_RATE_LIMIT_MAX.
 */
export async function runTaxRateDriftCron(page: Page): Promise<{ checked: number; drifted: number }> {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    throw new Error('CRON_SECRET is not set in the test environment — cannot trigger the tax-rate-drift cron route.')
  }
  const res = await page.request.get('/api/cron/xero-tax-rate-drift', {
    headers: { Authorization: `Bearer ${secret}` },
  })
  if (!res.ok()) {
    throw new Error(`xero-tax-rate-drift cron HTTP ${res.status()}: ${(await res.text()).slice(0, 300)}`)
  }
  const body = (await res.json()) as { checked?: number; drifted?: number; skipped?: boolean; reason?: string }
  if (body.skipped) {
    throw new Error(`tax-rate drift sweep was skipped: ${String(body.reason ?? 'unknown reason')}`)
  }
  return { checked: Number(body.checked ?? 0), drifted: Number(body.drifted ?? 0) }
}
