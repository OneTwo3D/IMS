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

/** Groups A1 → A2 → B, plus the three reconciliation sweeps. */
export async function runDailyBatch(): Promise<unknown> {
  const { runDailyBatchSync } = await import('../../../lib/connectors/xero/daily-sync.ts')
  return runDailyBatchSync()
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
