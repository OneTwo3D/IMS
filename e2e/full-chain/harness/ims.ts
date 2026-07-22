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
  },
): Promise<{ poId: string; poReference: string }> {
  await page.goto('/purchase-orders')
  await page.getByRole('button', { name: /new po/i }).click()

  const dialog = page.getByRole('dialog', { name: 'New Purchase Order' })
  await dialog.locator('select').first().selectOption({ label: opts.supplierLabel ?? 'E2E Supplier' })

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
 * Enter the supplier bill against the PO. Returns the supplier invoice number used.
 *
 * `expectBillCount` is how many bills the PO should carry AFTERWARDS, and defaults to the first.
 * A PO received in instalments is billed in instalments, so the "Bills (n)" confirmation cannot
 * be hardcoded to 1 — doing so would make the second bill of a two-delivery PO look like a
 * failure while it had in fact been created perfectly.
 */
export async function createBill(
  page: Page,
  opts: { reference: string; expectBillCount?: number; includeAdditionalCosts?: boolean },
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
  await dialog.getByRole('button', { name: /confirm bill/i }).click()
  await expect(dialog).toBeHidden({ timeout: 30_000 })
  await expect(page.getByRole('button', { name: new RegExp(`Bills \\(${opts.expectBillCount ?? 1}\\)`) }))
    .toBeVisible({ timeout: 30_000 })
  return opts.reference
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
