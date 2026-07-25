/**
 * Periodic / cross-cutting full chain (o3d-lgo.7).
 *
 * X-01 is the batch-mode FOUNDATION the rest of Phase 2c (and OC-08's valued COGS
 * reversal) builds on. Everything else in the full-chain suite runs SYNC mode, where a
 * shipment's COGS posts the instant it dispatches and its accounting_shipment_journal_date
 * stays null forever. This spec proves the OTHER branch: with the daily batch armed, the
 * dispatch is SILENT and the journals appear only when runDailyBatchSync() sweeps them —
 * Group A1 defers the order's revenue, A2 reclassifies allocated inventory, and Group B
 * recognises the revenue and books COGS on the shipment.
 *
 * Two things make batch mode uniquely hazardous, and X-01 is built around both:
 *   1. Posting mode is a BRANCH (ims.ts:setPostingMode). Batch posting is
 *      xero_sync_enabled AND xero_daily_batch_enabled (accounting.ts:196) — BOTH true. Arm
 *      only dailyBatch and runDailyBatchSync returns early (daily-sync.ts:544) and the
 *      order is never invoiced, so nothing to defer.
 *   2. runDailyBatchSync is GLOBAL and unscoped. It journals every un-journaled shipment
 *      in the database, so a meaningful tie-out needs a clean baseline first —
 *      deleteUnjournaledShipmentBaseline() — or the batch posts ~dozens of prior tests'
 *      shipments into the shared Demo ledger. groupB === 1 below is the proof the baseline
 *      worked: without it the count would be in the nineties.
 *
 * As with every spec in this tier, the assertion is the journal READ BACK OUT OF XERO, not
 * the IMS's own sync-log row, and every posted document is registered for teardown.
 *
 * RUNNING THE BATCH-TRIGGERING TESTS (X-01 and X-02): both invoke the accounting-daily-batch cron,
 * which production rate-limits to ONCE per hour per IP (memory-backed; o3d-lgo.13, unfixed by design —
 * do NOT weaken it for tests). In a single invocation the SECOND of them 429s, so run them in SEPARATE
 * invocations, e.g. `npm run e2e:full-chain -- --grep "X-01:"` then `--grep "X-02:"`, restarting
 * ims-e2e-dev.service between them (which resets the limiter). X-02 detects the 429 and SKIPS loudly
 * (never a false pass) so the suite stays green when they are accidentally co-run; it is exercised for
 * real in its own invocation. X-05/X-07 are SYNC-mode and never touch the batch, so they co-run freely.
 */
import { expect, test } from '@playwright/test'
import { currentRunId } from './harness/global-setup.ts'
import { runTag, taggedSku } from './harness/tag.ts'
import { awaitWebhookDelivery, cleanupWc, createWcOrder, createWcProduct, wcCreds, type WcCreds } from './harness/wc.ts'
import {
  addManufacturingCostLine, allocateAndShip, applyStockWriteOff, completeProduction, createAndSendPo,
  createBill, createLandedCostPo, createManufacturingOrder, createStockTransfer, dispatchStockTransfer,
  editManufacturingCostLineAmount, openManufacturingOrder, openSalesOrder, processPendingXeroSyncViaUi,
  receiveGoods, receiveStockTransfer, runDailyBatch, runFxRevaluation, runTaxRateDriftCron, setPostingMode,
  startProduction,
} from './harness/ims.ts'
import { addStockAdjustment, configureProductComponents, createInventoryProduct, openInventoryProduct } from '../helpers.ts'
import { deleteFxRate, queryRows, seedFxRateAt } from './harness/fx-fixture.ts'
import {
  billIdsForPo, expectJournalLine, externalIdFor, getInvoice, getManualJournal, getXeroTaxRates,
  syncLogRowsFor, trackDocument, type XeroManualJournal, type XeroTaxRate,
} from './harness/xero.ts'
import {
  dailyBatchBoundary, dailyBatchDoc, deleteUnjournaledShipmentBaseline, postedDailyBatchJournalIds,
} from './harness/batch-fixture.ts'
import { runAllCleanups } from './harness/cleanup.ts'
import { assertE2eDatabase } from './harness/db-guard.ts'
import { withoutX04DriftEntries, X04_TAX_RATE_ID_PREFIX } from './harness/x04-drift-snapshot.ts'

const WAREHOUSE_CODE = 'CBG'
const UNIT_COST = 10 // addStockAdjustment seeds every positive line at £10/unit (helpers.ts:136).

test.describe.serial('@full-chain @wc @xero periodic', () => {
  let creds: WcCreds
  let runId: string

  test.beforeAll(async () => {
    runId = currentRunId()
    creds = await wcCreds()
  })

  test.afterAll(async () => {
    // Leave the rig disarmed regardless of outcome; the Xero documents this run posted are
    // voided by global teardown via the trackDocument registry.
    await setPostingMode({ sync: false, dailyBatch: false }).catch(() => {})
    if (creds && runId) await cleanupWc(creds, runId)
  })

  test('X-01: daily-batch A1/A2/B tie-out — deferral, reclassification and shipment COGS posted and balanced IN Xero', async ({ page }) => {
    test.setTimeout(600_000)

    const sku = taggedSku(runId, 'X01')
    const unitPrice = '20.00'
    const qty = 2
    const expectedCogs = qty * UNIT_COST // 2 × £10 = £20, VAT-independent
    const expectedRevenue = Number(unitPrice) * qty // ex-VAT net the batch defers/recognises: £40

    // 0. CLEAN BASELINE FIRST. The batch is global; without this it would journal every
    //    prior sync-mode test's stranded shipment into the shared Demo ledger. Idempotent —
    //    a no-op on an already-clean database.
    const baseline = await deleteUnjournaledShipmentBaseline()
    console.log(`[X-01] baseline: deleted ${baseline.candidateOrders} batch-candidate order(s)`, baseline.deleted)

    // 1. ARM BATCH MODE — sync AND dailyBatch, both true (see the header note). Armed before
    //    import so the SALES_INVOICE is queued at import time (order-import.ts) and the
    //    order carries an accountingInvoiceId, which Group A1 requires.
    await setPostingMode({ sync: true, dailyBatch: true })

    // 2. The IMS needs the product (mapped by SKU) and priced stock, seeded at £10/unit so
    //    COGS is a known number the read-back can assert exactly.
    await createInventoryProduct(page, { sku, name: `${runTag(runId)} X01`, price: unitPrice })
    await addStockAdjustment(page, sku, 10, WAREHOUSE_CODE)

    // 3. Place the order in Woo for real; Woo's own webhook imports it.
    const product = await createWcProduct(creds, runId, { label: 'X01', price: unitPrice })
    expect(product.sku).toBe(sku)
    const order = await createWcOrder(creds, runId, { lines: [{ productId: product.id, quantity: qty }] })
    expect(order.status).toBe('processing')
    const imported = await awaitWebhookDelivery(order.id, { creds })
    expect(imported.salesOrderId).toBeTruthy()

    // 4. Fulfil it the way an operator does. In batch mode the dispatch posts NO COGS — it
    //    only stages the shipment; the batch is what journals it.
    await openSalesOrder(page, imported.salesOrderId)
    await allocateAndShip(page, { tracking: `${runTag(runId)}-X01` })

    // 5. Post the queued invoice BEFORE running the batch: Group A1 filters on
    //    accountingInvoiceId (daily-sync.ts:557), which is only set once the SALES_INVOICE
    //    has actually synced. Skip this and the batch finds nothing to defer.
    await processPendingXeroSyncViaUi(page)
    const invoiceId = await externalIdFor({ type: 'SALES_INVOICE', referenceId: imported.salesOrderId })
    trackDocument('Invoices', invoiceId, `X-01 invoice ${runTag(runId)}`)
    expect((await getInvoice(invoiceId)).Status).toBe('AUTHORISED')

    // 6. Run the batch. A1 -> A2 -> B run sequentially in this one call, so the markers each
    //    group sets chain into the next. The counts are the tie-out that ONLY this order was
    //    journaled: a dirty baseline would push groupB into the nineties. Capture the DB clock
    //    boundary first so the read-back is scoped to THIS run's journals, not a prior run's.
    const batchBoundary = await dailyBatchBoundary()
    const batch = (await runDailyBatch(page)) as unknown as {
      groupA1: number; groupA2: number; groupB: number; errors: string[]
    }
    expect(batch.errors, `daily batch reported errors: ${batch.errors.join('; ')}`).toEqual([])
    expect(batch.groupA1, 'exactly one order deferred (Group A1)').toBe(1)
    expect(batch.groupA2, 'exactly one order reclassified (Group A2)').toBe(1)
    expect(batch.groupB, 'exactly one shipment journaled (Group B)').toBe(1)

    // 7. Drain the batch journals to Xero and resolve + REGISTER all three for teardown BEFORE
    //    any assertion, all inside a try whose finally is the ledger safety net (Codex r3).
    //    Two failure modes it must survive:
    //      - the DRAIN itself can throw after Xero has already accepted a journal (a UI
    //        completion-signal timeout), so it lives INSIDE the try — a throw here must still
    //        reach the finally that registers what posted;
    //      - the batch posts MORE than A1/A2/B — with a rounding account configured a
    //        reconciliation sweep (inventory/COGS/transit) can queue its own journal — so the
    //        finally registers EVERY DailyBatch document that posted after the boundary, not
    //        just the three we assert on. trackDocument dedupes, so re-registering is harmless.
    const specs = [
      { key: 'a1', type: 'DAILY_BATCH_REVENUE_DEFERRAL', label: 'A1 revenue deferral' },
      { key: 'a2', type: 'DAILY_BATCH_INVENTORY_ALLOC', label: 'A2 inventory alloc' },
      { key: 'b', type: 'DAILY_BATCH_GROUP_B', label: 'B shipment COGS' },
    ] as const
    const journalId: Partial<Record<'a1' | 'a2' | 'b', string>> = {}
    try {
      await processPendingXeroSyncViaUi(page)
      for (const s of specs) {
        const doc = await dailyBatchDoc(s.type, { createdAfter: batchBoundary })
        journalId[s.key] = doc.externalId
        trackDocument('ManualJournals', doc.externalId, `X-01 ${s.label} ${runTag(runId)}`)
      }
    } finally {
      // Register every DailyBatch journal that actually posted this run — the three tie-out
      // journals AND any reconciliation sweep — even if the drain or a lookup above threw.
      for (const posted of await postedDailyBatchJournalIds(batchBoundary)) {
        trackDocument('ManualJournals', posted.externalId, `X-01 ${posted.type} ${runTag(runId)}`)
      }
    }

    // 8. THE POINT: read all three journals back out of Xero and assert on what the ledger
    //    actually holds.
    const salesAccount = await settingValue('xero_sales_account')
    const unearnedAccount = await settingValue('xero_unearned_revenue_account')
    const inventoryAccount = await settingValue('xero_inventory_account')
    const allocatedAccount = await settingValue('xero_allocated_inventory_account')
    const cogsAccount = await settingValue('xero_cogs_account')

    // A1 — revenue deferral: DR sales, CR unearned, for the order's ex-VAT net. POSTED, not
    // merely "not DELETED": a DRAFT journal moves nothing.
    const a1Journal = await getManualJournal(journalId.a1!)
    expect(a1Journal.Status).toBe('POSTED')
    expectBalanced(a1Journal)
    expectJournalLine(a1Journal.JournalLines, { accountCode: salesAccount, debit: expectedRevenue })
    expectJournalLine(a1Journal.JournalLines, { accountCode: unearnedAccount, credit: expectedRevenue })

    // A2 — inventory reclassification: DR allocated-inventory, CR inventory, for COGS.
    const a2Journal = await getManualJournal(journalId.a2!)
    expect(a2Journal.Status).toBe('POSTED')
    expectBalanced(a2Journal)
    expectJournalLine(a2Journal.JournalLines, { accountCode: allocatedAccount, debit: expectedCogs })
    expectJournalLine(a2Journal.JournalLines, { accountCode: inventoryAccount, credit: expectedCogs })

    // B — shipment recognition + COGS. The revenue leg recognises out of unearned exactly
    // what A1 deferred in (deferred then recognised, same £), and the COGS leg moves the
    // allocated inventory A2 parked out to COGS. That cross-tie is the whole A1/A2/B story.
    const bJournal = await getManualJournal(journalId.b!)
    expect(bJournal.Status).toBe('POSTED')
    expectBalanced(bJournal)
    expectJournalLine(bJournal.JournalLines, { accountCode: unearnedAccount, debit: expectedRevenue })
    expectJournalLine(bJournal.JournalLines, { accountCode: salesAccount, credit: expectedRevenue })
    expectJournalLine(bJournal.JournalLines, { accountCode: cogsAccount, debit: expectedCogs })
    expectJournalLine(bJournal.JournalLines, { accountCode: allocatedAccount, credit: expectedCogs })
  })

  test('X-07: a stock write-off posts an INVENTORY_ADJUSTMENT journal (DR write-off / CR inventory) verified IN Xero', async ({ page }) => {
    test.setTimeout(600_000)

    // Closes the e2e/xero.spec.ts:139 test.fixme — that test only ever checked for a sync-LOG row,
    // and it never appeared because the flow it drove queued NO journal at all: an adjustment posts
    // to the ledger ONLY when its line carries a reason whose account_code is set
    // (stock-adjustment-apply.ts). The rig's adjustment_reasons table is empty, so the plain
    // addStockAdjustment helper (no reason) is silently journal-less. This test seeds a reason with
    // an account, writes stock OFF against it, and asserts the POSTED ManualJournal in Xero — the
    // ledger, not a log row.
    //
    // SYNC mode: INVENTORY_ADJUSTMENT queues at adjustment time and posts on the next drain. It is an
    // ordinary sync journal, NOT a daily-batch one, so the batch stays off and no clean baseline is
    // needed.
    //
    // Seed with posting DISARMED (a prior serial test may have left it armed). The +10 stock seed below
    // must not queue an untracked INVENTORY_ADJUSTMENT: the bulk-adjustment dialog defaults a new line to
    // the FIRST active reason, so if any active reason existed the seed would post a stray journal the
    // boundary-scoped teardown could never register (Codex r2). With posting DISARMED the seed cannot
    // queue anything whatever reasons exist; sync is armed AFTER the seed, for the write-off itself.
    await setPostingMode({ sync: false, dailyBatch: false })

    const sku = taggedSku(runId, 'X07')
    const reasonName = `${runTag(runId)} X07 shrinkage`
    const writeOffQty = 2
    const expectedValue = writeOffQty * UNIT_COST // 2 × £10 = £20, the FIFO cost of the consumed layers

    const inventoryAccount = await settingValue('xero_inventory_account') // 631
    // The reason's contra leg. inventory_revaluation (311) is a real, postable Demo account already
    // used by the landed-cost revaluation journals, so a manual journal can DR it.
    const writeOffAccount = await settingValue('xero_inventory_revaluation_account')

    // Product + priced stock to write off. The +10 seed MUST run BEFORE the reason is seeded: the
    // bulk-adjustment dialog defaults a new line's reason to the FIRST available reason
    // (bulk-adjustment-form.tsx). Seeding with sync DISARMED (above) means the line cannot post a journal
    // whatever reasons exist; its only job is to lay down a £10/unit cost layer for the write-off. The
    // reason is seeded AFTER, so the write-off (with sync armed) is the only thing that journals.
    await createInventoryProduct(page, { sku, name: `${runTag(runId)} X07`, price: '20.00' })
    await addStockAdjustment(page, sku, 10, WAREHOUSE_CODE)

    // Arm posting now — only the reason-coded write-off below should queue an INVENTORY_ADJUSTMENT.
    await setPostingMode({ sync: true, dailyBatch: false })

    const reasonId = await seedAdjustmentReason(reasonName, writeOffAccount)
    try {
      // Capture the DB clock AFTER the seed and BEFORE the write-off, so the read-back is scoped to
      // THIS run's journal (a prior run's INVENTORY_ADJUSTMENT would otherwise be a false match).
      const boundary = await dailyBatchBoundary()
      await applyStockWriteOff(page, { sku, qty: writeOffQty, reasonName, warehouseCode: WAREHOUSE_CODE })

      let externalId: string | undefined
      try {
        // Drain the queued INVENTORY_ADJUSTMENT to Xero, then resolve + REGISTER it before asserting —
        // the drain can throw after Xero has already accepted the journal (a UI completion-signal
        // timeout), so registration lives in a try whose finally is the ledger safety net.
        await processPendingXeroSyncViaUi(page)
        const doc = await awaitSyncedJournal('INVENTORY_ADJUSTMENT', boundary)
        externalId = doc.externalId
        trackDocument('ManualJournals', externalId, `X-07 write-off ${runTag(runId)}`)
      } finally {
        // Failure-safe (Codex r1): settle any in-flight post-boundary INVENTORY_ADJUSTMENT work and
        // register EVERY external id that posted, regardless of final status — the drain can throw
        // after Xero accepted the journal, or the external-id write-back can lag a UI-signal timeout,
        // so a single immediate read could miss the real document. Mirrors postedDailyBatchJournalIds.
        // trackDocument dedupes, so re-registering the happy-path id is harmless.
        for (const posted of await settledJournalExternalIds('INVENTORY_ADJUSTMENT', boundary)) {
          trackDocument('ManualJournals', posted, `X-07 write-off ${runTag(runId)}`)
        }
      }

      // THE POINT: read the journal back out of Xero. A write-off DEBITS the reason account and
      // CREDITS inventory for the FIFO cost of the units removed. POSTED, not merely "not DELETED".
      const journal = await getManualJournal(externalId!)
      expect(journal.Status).toBe('POSTED')
      expectBalanced(journal)
      expectJournalLine(journal.JournalLines, { accountCode: writeOffAccount, debit: expectedValue })
      expectJournalLine(journal.JournalLines, { accountCode: inventoryAccount, credit: expectedValue })
    } finally {
      // Remove the seeded reason regardless of outcome. No FK RESTRICTs it (only external_wms_bindings
      // references it, ON DELETE SET NULL), so the delete is safe even after a movement used it.
      await deleteAdjustmentReason(reasonId)
    }
  })

  test('X-05: manufacturing completion posts MANUFACTURING_JOURNAL, and a post-completion cost-line edit posts MANUFACTURING_RECLASS — both verified IN Xero', async ({ page }) => {
    test.setTimeout(600_000)

    // SYNC mode: both journals queue at their transition (completion, then the cost-line edit) and
    // post on the next drain — ordinary sync journals, NOT daily-batch ones, so the batch stays off
    // and no clean baseline is needed.
    //
    // Seed with posting DISARMED (a prior serial test may have left it armed): the component stock
    // adjustments below must not queue untracked INVENTORY_ADJUSTMENT journals — the bulk-adjustment
    // dialog defaults a new line to the first active reason, so any active reason would make each seed
    // post a stray journal the boundary-scoped teardown could never register (Codex r2). With posting
    // DISARMED the seeds cannot queue anything; posting is armed only AFTER seeding, right before the MO.
    await setPostingMode({ sync: false, dailyBatch: false })

    const overheadAccount = await settingValue('xero_manufacturing_overhead_account') // 330
    const inventoryAccount = await settingValue('xero_inventory_account') // 631
    const overhead = 20 // £ capitalised overhead the completion journal books
    const reclassDelta = 10 // £20 → £30: with all output still on hand the delta reclassifies wholly to inventory

    const compA = taggedSku(runId, 'X05A')
    const compB = taggedSku(runId, 'X05B')
    const bomSku = taggedSku(runId, 'X05BOM')
    // Captured just before the setting is armed (inside the try); undefined means "not yet touched".
    let priorMfgSetting: string | null | undefined

    try {
      // Two priced components + a BOM consuming 2×A + 1×B per unit. Component stock is seeded at
      // £10/unit, but the journal books ONLY the overhead — the component→finished-goods legs net to
      // zero on the inventory account — so the component cost never enters the assertion.
      await createInventoryProduct(page, { sku: compA, name: `${runTag(runId)} X05 A`, price: '2.00' })
      await createInventoryProduct(page, { sku: compB, name: `${runTag(runId)} X05 B`, price: '3.00' })
      await addStockAdjustment(page, compA, 10, WAREHOUSE_CODE)
      await addStockAdjustment(page, compB, 5, WAREHOUSE_CODE)
      await createInventoryProduct(page, { sku: bomSku, name: `${runTag(runId)} X05 BOM`, type: 'BOM', price: '30.00' })
      await openInventoryProduct(page, bomSku)
      await configureProductComponents(page, [{ sku: compA, qty: '2' }, { sku: compB, qty: '1' }])

      // Seeding done — arm posting now. The rig leaves the per-type manufacturing setting UNSET, which
      // makes queueAccountingSync a silent no-op for these two types (getAccountingPostingContext returns
      // null); 'authorised' resolves to a POSTED journal. Both types share this one key. Capture its EXACT
      // prior state (absent vs a specific value) and restore it in finally — never blanket-delete, which
      // would drop a deliberate 'off'/'draft' config and let later sync-enabled activity post journals
      // (Codex r3).
      priorMfgSetting = await getSettingRaw('xero_sync_manufacturing_journal')
      await setPostingMode({ sync: true, dailyBatch: false })
      await setSetting('xero_sync_manufacturing_journal', 'authorised')

      // Build qty 2. The overhead line MUST be added before completion for the journal to capture it.
      const moId = await createManufacturingOrder(page, { bomSku, warehouseCode: WAREHOUSE_CODE, qty: 2 })
      await addManufacturingCostLine(page, { description: `${runTag(runId)} labour`, amount: String(overhead) })
      await startProduction(page)
      const journalBoundary = await dailyBatchBoundary()
      await completeProduction(page)

      // --- MANUFACTURING_JOURNAL: DR inventory / CR overhead for the capitalised overhead. Register
      //     the posted id (failure-safe) before asserting, mirroring X-07's teardown net.
      let mfgJournalId: string | undefined
      try {
        await processPendingXeroSyncViaUi(page)
        mfgJournalId = (await awaitSyncedJournal('MANUFACTURING_JOURNAL', journalBoundary)).externalId
        trackDocument('ManualJournals', mfgJournalId, `X-05 mfg journal ${runTag(runId)}`)
      } finally {
        for (const id of await settledJournalExternalIds('MANUFACTURING_JOURNAL', journalBoundary)) {
          trackDocument('ManualJournals', id, `X-05 mfg journal ${runTag(runId)}`)
        }
      }
      const mfgJournal = await getManualJournal(mfgJournalId!)
      expect(mfgJournal.Status).toBe('POSTED')
      expectBalanced(mfgJournal)
      expectJournalLine(mfgJournal.JournalLines, { accountCode: inventoryAccount, debit: overhead })
      expectJournalLine(mfgJournal.JournalLines, { accountCode: overheadAccount, credit: overhead })

      // --- MANUFACTURING_RECLASS: raise the overhead £20 → £30 on the COMPLETED order. Nothing was
      //     shipped, so all output is on hand and the whole £10 delta reclassifies into inventory
      //     (DR inventory / CR overhead) — no COGS leg.
      // The prior drain navigated to /sync, so return to the MO detail page before editing its costs.
      await openManufacturingOrder(page, moId)
      const reclassBoundary = await dailyBatchBoundary()
      await editManufacturingCostLineAmount(page, String(overhead + reclassDelta))
      let reclassId: string | undefined
      try {
        await processPendingXeroSyncViaUi(page)
        reclassId = (await awaitSyncedJournal('MANUFACTURING_RECLASS', reclassBoundary)).externalId
        trackDocument('ManualJournals', reclassId, `X-05 mfg reclass ${runTag(runId)}`)
      } finally {
        for (const id of await settledJournalExternalIds('MANUFACTURING_RECLASS', reclassBoundary)) {
          trackDocument('ManualJournals', id, `X-05 mfg reclass ${runTag(runId)}`)
        }
      }
      const reclassJournal = await getManualJournal(reclassId!)
      expect(reclassJournal.Status).toBe('POSTED')
      expectBalanced(reclassJournal)
      expectJournalLine(reclassJournal.JournalLines, { accountCode: inventoryAccount, debit: reclassDelta })
      expectJournalLine(reclassJournal.JournalLines, { accountCode: overheadAccount, credit: reclassDelta })
    } finally {
      // Restore the manufacturing posting setting to EXACTLY its prior state (Codex r3): delete only if it
      // was absent before this run, otherwise write the captured prior value back. Never blanket-delete —
      // that would drop a deliberate 'off'/'draft'. `undefined` means we never got as far as arming it.
      if (priorMfgSetting === null) await deleteSetting('xero_sync_manufacturing_journal')
      else if (priorMfgSetting !== undefined) await setSetting('xero_sync_manufacturing_journal', priorMfgSetting)
    }
  })

  test('X-02: a never-swept transit GL residue gets swept by the daily-batch transit reconciliation — DAILY_BATCH_TRANSIT_RECONCILIATION posted IN Xero', async ({ page }) => {
    test.setTimeout(600_000)

    // The transit subledger-vs-GL rounding sweep (6oyu.4/khdw) runs at the END of the daily batch:
    // when the transit account's GL period-movement differs from the transit subledger by a residue
    // within the £1 sweep tolerance it posts a DAILY_BATCH_TRANSIT_RECONCILIATION journal to the
    // rounding account; a MATERIAL gap FLAGS and is NEVER swept (the scjz.13 trap). The rig carries NO
    // transit GL balance snapshots, so the reconciliation is normally "unavailable" — the transit
    // account has never been swept. This seeds a controlled, sub-£1 residue for a fresh snapshot date
    // (an entity that was never swept) and proves the batch sweeps it EXACTLY once into a real POSTED
    // Xero journal. Closes gate 6oyu.4.1.
    const transitAccount = await settingValue('xero_transit_account') // 632
    const roundingAccount = await settingValue('xero_rounding_difference_account') // 860
    const residue = 0.3 // £ — inside the £1 sweep tolerance, so classified 'sweep' not 'flag'

    // 0. Clean baseline + arm batch mode. The sweep needs sync AND dailyBatch both armed; the clean
    //    baseline keeps Groups A1/A2/B empty so the transit sweep is the only tie-out journal.
    const baseline = await deleteUnjournaledShipmentBaseline()
    console.log(`[X-02] baseline: deleted ${baseline.candidateOrders} batch-candidate order(s)`)
    await setPostingMode({ sync: true, dailyBatch: true })

    // 1. Seed the residue: an opening (yesterday) + closing (today) GL balance snapshot for account 632
    //    whose MOVEMENT sits exactly `residue` below the live transit subledger movement over the same
    //    window → delta = subledger − GL = +£0.30 → the sweep DRs transit / CRs rounding.
    const seed = await seedTransitReconciliationResidue(transitAccount, residue)
    console.log(`[X-02] seeding a ${residue} transit residue for reconciliation date ${seed.dateIso}`)
    try {
      const boundary = await dailyBatchBoundary()
      // accounting-daily-batch is rate-limited to 1/hour/IP (o3d-lgo.13). X-01 triggers the same route
      // earlier in this serial suite, so in a NORMAL full-suite invocation X-02's call is the SECOND and
      // is refused with HTTP 429 — the batch cannot run and there is nothing to assert. Rather than fail
      // the suite on a production rate limit we must not weaken, SKIP with a clear pointer: X-02 is
      // validated in its OWN invocation (or after a `systemctl restart ims-e2e-dev.service`, which resets
      // the memory-backed limiter). The seed + any log are still retired in finally.
      let batch: {
        groupA1: number; groupA2: number; groupB: number; errors: string[]
        transitReconciliationSwept?: number | null
      }
      try {
        batch = (await runDailyBatch(page)) as unknown as typeof batch
      } catch (e) {
        const msg = String(e)
        if (/HTTP 429|rate.?limit/i.test(msg)) {
          // LOUD, not silent: a skipped X-02 means NO transit-sweep coverage in this invocation, so say
          // so in the run log. This is the documented o3d-lgo.13 mitigation (the daily-batch cron is
          // 1/hour/IP and X-01 already spent the quota) — X-02 must run in its own invocation or after a
          // `systemctl restart ims-e2e-dev.service`. Not a pass masquerading as coverage.
          console.warn('[X-02] SKIPPED — accounting-daily-batch hourly quota already consumed this invocation (X-01 ran the batch earlier; o3d-lgo.13). No transit-reconciliation coverage in THIS run. Re-run X-02 in a dedicated invocation (or after a service restart, which resets the memory-backed limiter) to exercise it.')
          test.skip(true, 'accounting-daily-batch hourly quota already consumed this invocation (o3d-lgo.13); run X-02 in its own invocation or after a service restart.')
        }
        throw e
      }
      expect(batch.errors, `daily batch reported errors: ${batch.errors.join('; ')}`).toEqual([])
      // The never-swept entity got swept, for exactly the seeded signed residue (subledger higher → +).
      expect(batch.transitReconciliationSwept, 'transit reconciliation swept the seeded residue').toBeCloseTo(residue, 2)

      // 2. Drain, then resolve + REGISTER the sweep journal (and any other daily-batch journal that
      //    posted) before asserting — same ledger-safety-net shape as X-01.
      let sweepId: string | undefined
      try {
        await processPendingXeroSyncViaUi(page)
        sweepId = (await awaitSyncedJournal('DAILY_BATCH_TRANSIT_RECONCILIATION', boundary)).externalId
        trackDocument('ManualJournals', sweepId, `X-02 transit sweep ${runTag(runId)}`)
      } finally {
        for (const posted of await postedDailyBatchJournalIds(boundary)) {
          trackDocument('ManualJournals', posted.externalId, `X-02 ${posted.type} ${runTag(runId)}`)
        }
      }

      // 3. THE POINT: read the sweep journal back out of Xero — DR transit / CR rounding for £0.30,
      //    POSTED (not merely "not DELETED").
      const journal = await getManualJournal(sweepId!)
      expect(journal.Status).toBe('POSTED')
      expectBalanced(journal)
      expectJournalLine(journal.JournalLines, { accountCode: transitAccount, debit: residue })
      expectJournalLine(journal.JournalLines, { accountCode: roundingAccount, credit: residue })
    } finally {
      // Remove the seeded snapshots. The reconciliation sync log + accounting_event for the CHOSEN date
      // are deliberately LEFT as a "date used" marker so the next run in this rolling window picks a fresh
      // date (the sweep is idempotent per date at Xero); teardown voids the Xero document.
      await seed.cleanup()
    }
  })

  test('X-06: a retrospective landed cost on TRANSFERRED-OUT units posts a STOCK_IN_TRANSIT reval and NO COGS_JOURNAL — landed cost routed through transit exactly once IN Xero', async ({ page }) => {
    test.setTimeout(600_000)

    // Closes gate 6oyu.19.1. A warehouse transfer posts NO Xero journal; the testable content is the
    // retrospective landed-cost revaluation that must EXCLUDE the transferred-out units from COGS.
    //
    // Scenario: a goods PO receives 100 @ £10 into WH-A; ALL 100 are transferred to WH-B (dispatch +
    // receive), consuming the source cost layer via TRANSFER_OUT; THEN a £1/unit (£100) landed cost
    // arrives and the reval runs. Because the 100 units left via TRANSFER_OUT (not a sale),
    // getTransferConsumedQtyForCostLayer zeroes the source layer's netConsumedQty, so the reval must:
    //   - post NO COGS_JOURNAL for the goods PO (a broken exclusion would book a spurious retrospective
    //     COGS whose offset ALSO credits transit, per scjz.34 — doubling the transit movement);
    //   - post ONE STOCK_IN_TRANSIT journal revaluing the on-hand DESTINATION units (the £100 delta
    //     reaches the destination layer via the transfer's costLayerSourceLine + propagateLandedCost-
    //     ToOutputs): DR inventory £100 / CR transit £100.
    // So the landed cost is routed through transit EXACTLY ONCE (a single −£100 credit), which is the gate
    // ("source posts no COGS; transit drains exactly once"). The offsetting freight-supplier bill (an
    // ACCPAY that DEBITS transit £100) is a downstream AP event, orthogonal to this exclusion gate and
    // already covered by PP-07's receipt-vs-bill transit tie-out — so it is deliberately NOT posted here,
    // which keeps the gate decoupled from the freight-PO billing flow (see the reval step).
    //
    // SYNC mode, no daily batch — the reval queues an ordinary sync journal, so no clean baseline is
    // needed. The reval legs are inventory (631) / transit (632), NOT the Xero SYSTEM AR/AP accounts, so
    // this is unaffected by the o3d-lgo.6.1 FX-journal defect that parks X-03.
    await setPostingMode({ sync: true, dailyBatch: false })

    const sku = taggedSku(runId, 'X06')
    const qty = 100
    const unitCost = '10.00'
    const freightTotal = qty * 1 // £100 landed cost, £1/unit

    const inventoryAccount = await settingValue('xero_inventory_account') // 631
    const transitAccount = await settingValue('xero_transit_account') // 632

    await createInventoryProduct(page, { sku, name: `${runTag(runId)} X06`, price: '20.00' })

    // Goods PO -> receive. The receipt lays down the source cost layer L1 (100 @ £10).
    const { poId: goodsPoId, poReference } = await createAndSendPo(page, { sku, qty: String(qty), unitCost })
    await receiveGoods(page, { expectStatus: 'Received' })

    // Resolve the warehouse the receipt landed in (the transfer source) and a DIFFERENT destination — so
    // the test is robust to whichever warehouse the PO defaulted to.
    const { sourceWarehouseId, destWarehouseId } = await pickTransferWarehouses(sku)

    // Real transfer of all 100 units: DRAFT -> dispatch (consumes L1 via TRANSFER_OUT, writing the
    // costLayerSnapshot the exclusion query reads) -> receive (recreates the layer at WH-B). No journal.
    const transferRef = await createStockTransfer(page, { fromWarehouseId: sourceWarehouseId, toWarehouseId: destWarehouseId, sku, qty })
    await dispatchStockTransfer(page, transferRef)
    await receiveStockTransfer(page, transferRef)

    // The transfer MUST have genuinely drained the source layer — otherwise the "no COGS" assertion below
    // is trivially true (nothing consumed) rather than proof the exclusion fired. With the source layer
    // fully consumed via TRANSFER_OUT, the reval's netConsumedQty would be 100 WITHOUT the exclusion and it
    // would book £100 of spurious COGS; that it books none is the exclusion working.
    const source = await costLayerTotalsAt(sku, sourceWarehouseId)
    expect(source.received, 'the goods receipt laid down 100 units at the source warehouse').toBeCloseTo(qty, 4)
    expect(source.remaining, 'the transfer consumed the ENTIRE source layer (TRANSFER_OUT) — nothing left on hand there').toBeCloseTo(0, 4)
    const dest = await costLayerTotalsAt(sku, destWarehouseId)
    expect(dest.remaining, 'all 100 units are on hand at the destination warehouse after the transfer').toBeCloseTo(qty, 4)

    // Scope the read-back / no-COGS check to THIS run's journals.
    const boundary = await dailyBatchBoundary()

    // Retrospective landed cost: a freight PO (£100, BY_VALUE) linked to the goods PO. createFreightPo runs
    // the recalc synchronously and queues the STOCK_IN_TRANSIT reval journal for the on-hand units.
    //
    // We deliberately do NOT bill the freight PO here. It is created DRAFT (createFreightPo sets no status),
    // so billing it would need an extra confirm-and-send step and would couple this gate to the freight-PO
    // billing flow — orthogonal to the TRANSFER_OUT exclusion under test (6oyu.19.1). "Transit drains
    // exactly once" is proved directly instead: the reval routes the £100 landed cost through transit
    // EXACTLY ONCE (a single −£100 credit) and books NO COGS. A broken exclusion would post a retrospective
    // COGS_JOURNAL whose offset ALSO credits transit (scjz.34), doubling the transit movement to −£200 — so
    // the single −£100 credit + zero COGS is the whole tie-out.
    const { freightPoId } = await createLandedCostPo(page, {
      goodsPoReference: poReference, amount: String(freightTotal), description: `${runTag(runId)} freight`,
    })
    expect(freightPoId, 'the freight PO was created').toBeTruthy()

    // Drain everything queued (STOCK_RECEIPT and the STOCK_IN_TRANSIT reval), then resolve + REGISTER every
    // posted document BEFORE any assertion — the drain can throw after Xero accepted a journal, so
    // registration lives in a finally that is the ledger safety net.
    //
    // Enumerate ALL STOCK_IN_TRANSIT rows for the PO, not just the latest — "routed through transit exactly
    // once" is only meaningful if there is EXACTLY one such journal, and externalIdFor returns only the most
    // recent, so a duplicate reval (a retry or idempotency regression posting a SECOND £100 journal) would
    // slip through it while transit is credited £200 (Codex). The set comes from transitSyncRowsForPo rather
    // than externalIdsFor, which returns as soon as one document is SYNCED and so cannot see a duplicate
    // still in flight. We assert no in-flight rows, then the distinct-document count, then aggregate the
    // transit movement across every matching journal.
    let stockInTransitIds: string[] = []
    let transitRows: Array<{ status: string; externalTransactionId: string | null }> = []
    try {
      await processPendingXeroSyncViaUi(page)
    } finally {
      // REGISTER STATUS-AGNOSTICALLY, and only then read for the assertion. externalIdsFor/externalIdFor
      // wait for SYNCED rows and THROW when any row for the reference FAILED — so a partial drain (one
      // journal accepted by Xero, a sibling row failed) would leave a real, voidable document unregistered
      // and stranded in the shared ledger (Codex). settledJournalExternalIds snapshots every id whatever the
      // row's status, scoped to THIS PO, which is precisely the recovery those helpers cannot express.
      //
      // NO timestamp bound: goodsPoId alone establishes ownership, and the PO's STOCK_RECEIPT row was written
      // by receiveGoods BEFORE `boundary` was captured — filtering on it would skip the very receipt journal
      // this recovery exists to void, leaking it into the shared ledger (Codex).
      const recoverAndRegister = async (): Promise<void> => {
        for (const [type, label] of [
          ['STOCK_IN_TRANSIT', 'stock-in-transit reval'],
          ['STOCK_RECEIPT', 'stock receipt'],
          // If the exclusion REGRESSED and a spurious COGS_JOURNAL posted, register that too so teardown
          // voids it and the assertion below — not the ledger — is what fails.
          ['COGS_JOURNAL', 'UNEXPECTED cogs'],
        ] as const) {
          for (const id of await settledJournalExternalIds(type, null, { referenceId: goodsPoId })) {
            trackDocument('ManualJournals', id, `X-06 ${label} ${runTag(runId)}`)
          }
        }
      }
      // TWO passes over ALL THREE types, and asymmetry between them would be a hole. One pass can miss a
      // document two ways: its database read fails transiently (it only WARNS and returns []), or a row was
      // still PROCESSING when the 30s settle window expired and received its external id afterwards — the
      // realistic case for a spurious COGS_JOURNAL under Xero throttling. trackDocument dedupes, so the
      // repeat costs nothing (Codex).
      //
      // The residual gap — Xero accepted a POST whose id NO read can resolve — needs a run-id-tagged Xero
      // rescan of manual journals, the suite-wide follow-up tracked as o3d-lgo.7.1.
      await recoverAndRegister()
      const receiptId = await externalIdFor({ type: 'STOCK_RECEIPT', referenceId: goodsPoId }).catch(() => '')
      if (receiptId) trackDocument('ManualJournals', receiptId, `X-06 stock receipt ${runTag(runId)}`)
      await recoverAndRegister()

      // THE EXACT-ONCE SET, taken from a TERMINAL-STATE query rather than externalIdsFor. That helper
      // returns as soon as `expected` distinct documents are SYNCED, so a duplicate still PENDING would
      // leave a one-element array and the "exactly one" assertion would pass while transit was about to be
      // credited twice — the very idempotency regression this test exists to catch (Codex). Enumerating
      // every row for the PO after the settle passes makes both the in-flight count and the distinct-id
      // count assertable below, and gives registration the complete set.
      transitRows = await transitSyncRowsForPo(goodsPoId).catch(() => transitRows)
      stockInTransitIds = [...new Set(
        transitRows.map((r) => r.externalTransactionId).filter((id): id is string => Boolean(id)),
      )]
      for (const id of stockInTransitIds) {
        trackDocument('ManualJournals', id, `X-06 stock-in-transit reval ${runTag(runId)}`)
      }
    }

    // THE CRUX: NO COGS_JOURNAL was queued for the goods PO. The 100 units left via TRANSFER_OUT, so the
    // source layer's netConsumedQty is zero and the reval must not book any retrospective COGS.
    expect(
      await cogsJournalCountForPo(goodsPoId, boundary),
      'a retrospective landed cost on TRANSFERRED-out units must post NO COGS_JOURNAL (6oyu.19.1)',
    ).toBe(0)

    // TERMINAL-STATE BARRIER, before the count. "Exactly one" is only a claim about the ledger if nothing is
    // still on its way there: a second reval sitting PENDING would make the count read 1 and pass, then post
    // afterwards and credit transit twice — or be cancelled by teardown and hide the regression permanently
    // (Codex).
    const inFlight = transitRows.filter((r) => r.status === 'PENDING' || r.status === 'PROCESSING')
    expect(
      inFlight.length,
      `every STOCK_IN_TRANSIT row for the PO reached a terminal status before asserting exact-once; ` +
        `${inFlight.length} still in flight: ${JSON.stringify(transitRows)}`,
    ).toBe(0)

    // EXACTLY ONE STOCK_IN_TRANSIT journal posted for the PO — a duplicate would credit transit twice
    // (£200) and defeat "routed through transit exactly once", so counting the distinct documents across
    // ALL terminal rows is the load-bearing check, not just inspecting one.
    expect(
      stockInTransitIds.length,
      `the reval posted EXACTLY ONE STOCK_IN_TRANSIT journal for the PO; rows: ${JSON.stringify(transitRows)}`,
    ).toBe(1)

    // Aggregate across every matching journal (exactly one here): revaluing the on-hand DESTINATION units
    // DR inventory £100 / CR transit £100, each POSTED and balanced (not merely "not DELETED"). The total
    // transit credit is the £100 landed cost routed through transit EXACTLY ONCE — the point of the exclusion.
    let totalInventory = 0
    let totalTransit = 0
    for (const id of stockInTransitIds) {
      const reval = await getManualJournal(id)
      expect(reval.Status).toBe('POSTED')
      expectBalanced(reval)
      totalInventory += journalSumFor(reval, inventoryAccount)
      totalTransit += journalSumFor(reval, transitAccount)
    }
    expect(totalInventory, 'the reval debits inventory for the £100 landed cost on the on-hand units').toBeCloseTo(freightTotal, 2)
    expect(totalTransit, 'the reval credits transit for the £100 landed cost — routed through transit exactly once').toBeCloseTo(-freightTotal, 2)
  })

  test('X-04: IMS↔Xero tax-rate DRIFT is detected (Setting snapshot + WARNING ActivityLog), clears on reconcile — detect-only, no Xero write', async ({ page }) => {
    test.setTimeout(600_000)

    // Tax-rate drift is DETECT-ONLY: the cron GET /api/cron/xero-tax-rate-drift compares each active IMS
    // TaxRate (that has active components) against the live Xero rate and, on divergence, writes a Setting
    // snapshot (xero_tax_rate_drift_current) + last-checked stamp and a WARNING ActivityLog — it NEVER
    // writes back to Xero (that is the separate TAX_RATE_SYNC subsystem). The rig carries 40 IMS rates but
    // ZERO components, so the sweep normally short-circuits without even calling Xero.
    //
    // This seeds ONE IMS rate that MIRRORS a live Xero rate exactly (so the sweep loads exactly it), then
    // drives the arc: baseline = no drift; perturb the IMS component rate = drift detected (snapshot +
    // ActivityLog); reconcile = drift clears. The cron is rate-limited 1/hour/IP, so it runs three times in
    // one test only because 'xero-tax-rate-drift' is in E2E_OVERRIDE_JOBS (lib/cron-rate-limit.ts) and the
    // rig sets E2E_TEST_MODE=1 + E2E_CRON_RATE_LIMIT_MAX.
    //
    // The Xero connection MUST carry the accounting.settings scope or GET /TaxRates 403s; verified live on
    // the rig (200, 57 rates). The plugin is enabled + connected here (every other Xero test posts), so the
    // cron does not skip.

    // Pick a live Xero rate with a single clean component to mirror. Prefer a non-sales "VAT on Expenses"
    // rate so nothing an order-to-cash test maps to is touched; fall back to any single-component rate.
    const xeroRates = await getXeroTaxRates()
    const mirror = pickMirrorableXeroRate(xeroRates)
    const component = mirror.TaxComponents![0]
    const xeroPercent = component.Rate // e.g. 20
    const driftedPercent = Math.abs(xeroPercent - 5) < 0.001 ? xeroPercent + 2 : xeroPercent - 2 // a distinct, non-zero divergence

    // Clear ONLY leftover X-04 seeds from a crashed prior run — matched by the 'e2e-x04' id prefix this
    // test stamps, NEVER by "has components" or by name (which could erase real, persistent tax config
    // that scripts/copy-tax-rates.ts legitimately seeds with components; Codex). Then seed the mirror.
    await deleteX04SeededTaxRates()
    // CRASH RECOVERY, and it must happen BEFORE the baseline capture. A run that died after Phase B leaves
    // the drift snapshot naming an e2e-x04-* rate. deleteX04SeededTaxRates() removes the rate but not the
    // snapshot entry, so capturing the snapshot as-is would take a DANGLING entry as the baseline and
    // faithfully restore it at teardown — every later run then reinstalling operator-visible drift for a
    // rate that no longer exists, which is exactly the poisoning the cleanup exists to prevent (Codex).
    // Purge X-04-owned entries from the live setting first, then capture what remains as the baseline.
    await purgeX04DriftSnapshotEntries()
    const taxRateId = await seedMirroredTaxRate(mirror.Name, component.Name, xeroPercent, Boolean(component.IsCompound))
    // Capture the prior drift settings (absent on a clean rig) so teardown restores EXACTLY.
    const priorSnapshot = await getSettingRaw('xero_tax_rate_drift_current')
    const priorChecked = await getSettingRaw('xero_tax_rate_drift_last_checked_at')
    // Cutoff for the ActivityLog cleanup, taken from the DB clock immediately BEFORE the first sweep: the
    // sweeps are global and log a WARNING per drifted rate, so teardown must remove the rows THEY wrote
    // while preserving anything older (see deleteDriftActivityLogRowsSince).
    const driftLogCutoff = await dbNow()

    try {
      // Every assertion is scoped to OUR rate id, not the sweep's global counts — the rig may legitimately
      // carry other component-backed rates (copy-tax-rates), so only `checked >= 1` (our rate was seen) and
      // per-id snapshot/ActivityLog membership are safe to assert.
      //
      // --- Phase A: BASELINE. Our IMS rate mirrors Xero exactly -> it must NOT appear as drifted.
      const a = await runTaxRateDriftCron(page)
      expect(a.checked, 'the sweep loaded at least our seeded rate (active + has an active component)').toBeGreaterThanOrEqual(1)
      expect(await driftSnapshotHasRate(taxRateId), 'a matching rate is absent from the drift snapshot').toBe(false)
      expect((await driftActivityLogRows(taxRateId)).length, 'no drift log for a matching rate yet').toBe(0)

      // --- Phase B: INJECT DRIFT. Move OUR component rate off Xero's -> the sweep must detect our rate.
      await setTaxRateComponentRate(taxRateId, driftedPercent / 100)
      const b = await runTaxRateDriftCron(page)
      expect(b.drifted, 'at least our perturbed rate is detected as drifted').toBeGreaterThanOrEqual(1)

      // The Setting snapshot names OUR rate with a mismatch status; the last-checked stamp is fresh.
      const snapshot = await getSettingRaw('xero_tax_rate_drift_current')
      expect(snapshot, 'the cron wrote the drift snapshot Setting').toBeTruthy()
      const entry = (JSON.parse(snapshot!) as Array<{ taxRateId: string; name: string; status: string; lines: string[] }>)
        .find((e) => e.taxRateId === taxRateId)
      expect(entry, 'the snapshot contains our drifted rate').toBeTruthy()
      expect(entry!.status).toBe('mismatch')
      expect(entry!.lines.join(' '), 'the snapshot describes the component-rate divergence').toMatch(new RegExp(component.Name, 'i'))
      const checkedAt = await getSettingRaw('xero_tax_rate_drift_last_checked_at')
      expect(checkedAt, 'the last-checked stamp was written').toBeTruthy()
      expect(Date.now() - Date.parse(checkedAt!), 'the last-checked stamp is fresh').toBeLessThan(10 * 60_000)

      // A WARNING ActivityLog row records the detection, keyed on OUR rate id.
      const logs = await driftActivityLogRows(taxRateId)
      expect(logs.length, 'a tax_rate_drift_detected ActivityLog row was written for our rate').toBeGreaterThanOrEqual(1)
      const log = logs[0]
      expect(log.action).toBe('tax_rate_drift_detected')
      expect(log.entityType).toBe('SYSTEM')
      expect(log.level).toBe('WARNING')
      expect(log.tag).toBe('accounting')

      // --- Phase C: RECONCILE. Restore OUR component to Xero's rate -> the next sweep clears our drift.
      await setTaxRateComponentRate(taxRateId, xeroPercent / 100)
      await runTaxRateDriftCron(page)
      expect(
        await driftSnapshotHasRate(taxRateId),
        'the reconciled rate has dropped out of the drift snapshot',
      ).toBe(false)
    } finally {
      // Remove EXACTLY the seeded rate by its id (components cascade) and the ActivityLog rows it produced,
      // and restore the drift Settings to EXACTLY their prior state. Nothing here is name- or
      // component-scoped, so no pre-existing tax config can be touched.
      //
      // EVERY step runs even if an earlier one rejects. Sequential awaits would abandon the rest on the
      // first transient failure, and the two Settings restorations are the steps that must not be skipped:
      // leaving the drift snapshot pointing at this test's deliberately-drifted rate poisons LATER runs,
      // which capture that polluted snapshot as their "prior" state and faithfully restore it forever.
      // Global teardown voids Xero documents; it does not repair these settings (Codex). runAllCleanups
      // attempts every step and rethrows the collected failures, so cleanup stays loud.
      await runAllCleanups('X-04', [
        ['delete drift ActivityLog rows for our rate', () => deleteDriftActivityLogRows(taxRateId)],
        // ...and the rows OUR sweeps wrote for anyone else's drifted rate: three global sweeps would
        // otherwise leave up to three duplicate WARNINGs per pre-existing drift, while the snapshot they
        // belong to is rolled back (Codex). Older rows are preserved.
        ['delete drift ActivityLog rows written by our sweeps', () => deleteDriftActivityLogRowsSince(driftLogCutoff)],
        ['delete seeded tax rate', () => deleteTaxRateById(taxRateId)],
        ['restore xero_tax_rate_drift_current', () => restoreSetting('xero_tax_rate_drift_current', priorSnapshot)],
        ['restore xero_tax_rate_drift_last_checked_at', () => restoreSetting('xero_tax_rate_drift_last_checked_at', priorChecked)],
      ])
    }
  })

  // Was parked behind o3d-lgo.6.1 as "the revaluation posts an UNREALISED_FX_JOURNAL to Xero". That
  // premise was wrong in the same way PP-08's was: getUnrealisedFxAccounts() resolves the journal's CONTROL
  // leg to settings.accountsReceivableAccount / accountsPayableAccount — Xero SYSTEM accounts 610/800 on
  // BOTH the rig and stage — and Xero refuses manual-journal lines to system accounts, so pushManualJournal
  // 400'd and nothing ever posted. The fix (o3d-lgo.6.1, Jan's call) is SUPPRESS-FOR-XERO: Xero revalues
  // foreign AR/AP itself, so an IMS journal for the same movement was both illegal and double-counting.
  //
  // So this is the period-end mirror of PP-08's assertion: with a genuine unrealised movement to revalue,
  // the sweep still runs and still BUILDS the journal, and nothing is queued for Xero.
  test('X-03: the period-end FX revaluation finds a real unrealised movement and SUPPRESSES the UNREALISED_FX_JOURNAL for Xero (o3d-lgo.6.1)', async ({ page }) => {
    test.setTimeout(900_000)

    // An open (unpaid) FOREIGN payable is the input the revaluation needs: getOpenPayables selects bills
    // with paidAt null, totalForeign > 0 and a non-base PO currency (lib/accounting-fx-revaluation.ts). A
    // EUR PO -> receipt -> bill, left unpaid, is the cheapest way to create exactly one.
    //
    // Same load-bearing precondition as PP-08/OC-10: with fx_rates EMPTY, createPurchaseOrder THROWS
    // "Missing … FX rate", so the BOOKED rate must exist before the PO. The unrealised movement then comes
    // from a SECOND, divergent rate seeded after the bill — buildRevaluationLines values the open payable at
    // the valuation-date rate and compares it to the booked carrying value.
    const sku = taggedSku(runId, 'X03')
    const reference = `${runTag(runId)}-X03`
    const qty = 4
    const unitCostEur = '25.00'
    const bookedRate = 1.15    // 1 GBP = 1.15 EUR when the bill was booked
    const valuationRate = 1.35 // EUR weaker at period end -> the GBP carrying value of the payable falls
    // Pin the valuation date rather than defaulting to today: it is the sweep's referenceId, so pinning it
    // makes the (asserted-absent) journal addressable, and it keeps repeat runs from colliding on the
    // hasRevaluationForDate() skip.
    const valuationDate = new Date().toISOString().slice(0, 10)

    await setPostingMode({ sync: true, dailyBatch: false })

    // MIDNIGHT-ANCHORED, not now()-relative — the trap that first failed this test. The sweep resolves each
    // open balance with `fetchedAt <= asOf` where asOf is the valuation DATE at midnight, so a rate seeded
    // at now() is ALWAYS after that boundary: the divergent rate is invisible, every balance falls back to
    // its booked rate, the movement computes to zero and the sweep reports documents: 0 — no journal built,
    // and the suppression assertion below would have nothing to prove. date_trunc puts the two seeds at
    // 22:00 and 23:00 the previous day: both inside the boundary, in the intended order, at any run time.
    const bookedRateId = await seedFxRateAt('EUR', bookedRate, "date_trunc('day', now()) - interval '2 hours'")
    let valuationRateId = ''
    try {
      await createInventoryProduct(page, { sku, name: `${runTag(runId)} X03`, price: '60.00' })

      const { poId } = await createAndSendPo(page, {
        sku, qty: String(qty), unitCost: unitCostEur, currency: 'EUR', fxRate: String(bookedRate),
      })
      await receiveGoods(page, { expectStatus: 'Received' })
      await createBill(page, { reference })

      // Drain so the EUR bill and its base-currency receipt journal reach Xero; register both for teardown
      // failure-safe (PP-07's pattern) — this test posts real documents even though its subject is one that
      // must NOT be posted.
      try {
        await processPendingXeroSyncViaUi(page)
      } finally {
        const receiptJournalId = await externalIdFor({ type: 'STOCK_RECEIPT', referenceId: poId }).catch(() => '')
        if (receiptJournalId) trackDocument('ManualJournals', receiptJournalId, `X-03 stock receipt ${runTag(runId)}`)
        const billRecordId = (await billIdsForPo(poId).catch((): string[] => []))[0]
        const billId = billRecordId
          ? await externalIdFor({ type: 'PURCHASE_INVOICE', referenceId: billRecordId }).catch(() => '')
          : ''
        if (billId) trackDocument('Invoices', billId, `X-03 bill ${runTag(runId)}`)
      }

      const [billRecordId] = await billIdsForPo(poId)
      const [{ totalForeign, totalBase }] = await queryRows<{ totalForeign: string; totalBase: string }>(
        `select "totalForeign", "totalBase" from purchase_invoices where id = $1 and "paidAt" is null`, [billRecordId],
      )
      // The payable is genuinely OPEN — a paid bill is invisible to getOpenPayables and the sweep would have
      // nothing to revalue, making the suppression assertion vacuous.
      expect(Number(totalForeign), 'the EUR bill is open and carries a foreign balance').toBeGreaterThan(0)

      // Now the divergent valuation rate, seeded LATER than the booked one but still inside the valuation
      // date's midnight boundary (see the anchoring note above), so the sweep resolves THIS rate rather than
      // the booked one and the movement is material by construction.
      valuationRateId = await seedFxRateAt('EUR', valuationRate, "date_trunc('day', now()) - interval '1 hour'")
      const revaluedBase = Number(totalForeign) / valuationRate
      expect(
        Math.abs(Number(totalBase) - revaluedBase),
        'the rate move is a material unrealised movement, so a journal is genuinely warranted',
      ).toBeGreaterThan(1)

      const result = await runFxRevaluation(page, { valuationDate })

      // The sweep RAN — { skipped } means sync was disarmed or the date was already revalued, either of
      // which would make the zero-row assertion below meaningless.
      expect(result.skipped, `the revaluation must actually run: ${JSON.stringify(result)}`).toBeFalsy()
      expect(result.success, `the revaluation reported failure: ${JSON.stringify(result)}`).toBe(true)
      // And it found real work: `documents` counts the open foreign documents it revalued, `revalued` counts
      // the journals it ENQUEUED — incremented after queueAccountingSync returns, so revalued >= 1 proves
      // the enqueue was ATTEMPTED with lines built. This is what stops "no rows" from passing vacuously.
      expect(Number(result.documents), 'the sweep revalued at least the open EUR bill').toBeGreaterThanOrEqual(1)
      expect(Number(result.revalued), 'the sweep built and enqueued at least one revaluation journal').toBeGreaterThanOrEqual(1)

      // THE POINT (o3d-lgo.6.1): the enqueue was attempted and NOTHING was written for Xero. Not a FAILED
      // row — the defect state, "Account code 800 is not a valid code for this document" — and not a SYNCED
      // one, which would double-count Xero's own revaluation.
      const fxRows = await syncLogRowsFor({ type: 'UNREALISED_FX_JOURNAL', referenceId: valuationDate })
      expect(
        fxRows,
        `UNREALISED_FX_JOURNAL must be suppressed for Xero, but ${fxRows.length} sync-log row(s) exist for ` +
          `valuation date ${valuationDate}: ${JSON.stringify(fxRows)}. A FAILED row means the o3d-lgo.6.1 ` +
          `defect is back (the control leg targets a SYSTEM AR/AP account); a SYNCED row means IMS is ` +
          `double-counting Xero's own foreign-balance revaluation.`,
      ).toEqual([])

      // Failure-safe: if suppression ever regressed into a POSTED journal, register it so teardown voids it
      // rather than stranding a manual journal in the shared Demo ledger.
      for (const row of fxRows) {
        if (row.externalTransactionId) {
          trackDocument('ManualJournals', row.externalTransactionId, `X-03 UNEXPECTED unrealised FX ${runTag(runId)}`)
        }
      }
    } finally {
      await deleteFxRate(bookedRateId)
      if (valuationRateId) await deleteFxRate(valuationRateId)
    }
  })
})

/**
 * Seed an active adjustment reason carrying a P&L/contra account code, so a stock adjustment line
 * against it queues an INVENTORY_ADJUSTMENT journal. Returns the reason id for teardown. The rig
 * keeps adjustment_reasons EMPTY, so the name is unique per run and cleaned up in finally.
 */
async function seedAdjustmentReason(name: string, accountCode: string): Promise<string> {
  const { Client } = await import('pg')
  const { randomUUID } = await import('node:crypto')
  const id = `e2e-x07-${randomUUID()}`
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    await db.query(
      `insert into adjustment_reasons (id, name, account_code, "sortOrder", active, "createdAt", "updatedAt")
         values ($1, $2, $3, 0, true, now(), now())`,
      [id, name, accountCode],
    )
    return id
  } finally {
    await db.end()
  }
}

async function deleteAdjustmentReason(id: string): Promise<void> {
  const { Client } = await import('pg')
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    await db.query(`delete from adjustment_reasons where id = $1`, [id])
  } finally {
    await db.end()
  }
}

/**
 * Poll for a SYNCED accounting_sync_log of `type` created after `createdAfter`, returning its Xero
 * external id. Scoped to this run by the boundary (mirrors batch-fixture's dailyBatchDoc): without
 * it a prior run's journal of the same type would be a false match and teardown would void the wrong
 * document. Fails loudly on a FAILED log or timeout rather than returning null.
 */
async function awaitSyncedJournal(
  type: string,
  createdAfter: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ referenceId: string; externalId: string }> {
  const { Client } = await import('pg')
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    const deadline = Date.now() + (opts.timeoutMs ?? 120_000)
    let last: { status: string; error: string | null } | null = null
    while (Date.now() < deadline) {
      const r = await db.query<{ referenceId: string; externalTransactionId: string | null; status: string; errorMessage: string | null }>(
        `select "referenceId", "externalTransactionId", status, "errorMessage"
           from accounting_sync_logs
          where connector = 'xero' and type = $1::"AccountingSyncType"
            and "createdAt" > $2::timestamptz
          order by "createdAt" desc limit 1`,
        [type, createdAfter],
      )
      if (r.rows.length) {
        const row = r.rows[0]
        last = { status: row.status, error: row.errorMessage }
        if (row.status === 'SYNCED' && row.externalTransactionId) {
          return { referenceId: row.referenceId, externalId: row.externalTransactionId }
        }
        if (row.status === 'FAILED') {
          throw new Error(`${type} FAILED in Xero sync: ${row.errorMessage ?? 'no error recorded'}`)
        }
      }
      await new Promise((res) => setTimeout(res, 2_000))
    }
    throw new Error(
      `No SYNCED ${type} journal created after ${createdAfter} within the timeout` +
        (last ? ` (last seen: status=${last.status}${last.error ? `, error=${last.error}` : ''})` : ' (none queued — did the adjustment carry a reason with an account?)'),
    )
  } finally {
    await db.end()
  }
}

/**
 * Failure-safe teardown net: SETTLE any in-flight post-boundary sync work of `type`, then return
 * EVERY external id that posted regardless of final status. A journal Xero accepted but whose status
 * write-back lagged (or later FAILED) still recorded its id and is a real document that must be
 * voided. Best-effort — waits out PENDING/PROCESSING rows up to a bounded deadline, then reads.
 *
 * NEVER throws (teardown must run even if this cannot resolve), but — unlike a silent `catch(() => [])`
 * at the call site — when it CANNOT resolve (no connection, reads still failing, or the settle deadline
 * expiring) it WARNS LOUDLY with the boundary rather than returning an indistinguishable empty list, so
 * a possibly-stranded journal in the SHARED Demo ledger is surfaced in the run log. Transient
 * connection AND read failures are retried. Mirrors batch-fixture.postedDailyBatchJournalIds (Codex).
 */
async function settledJournalExternalIds(
  type: string,
  createdAfter: string | null,
  opts: { referenceId?: string; timeoutMs?: number } = {},
): Promise<string[]> {
  const { referenceId, timeoutMs = 30_000 } = opts
  // OWNERSHIP SCOPE. Type + timestamp alone is not ownership: the rig takes live Woo webhooks and
  // processPendingXeroSyncViaUi drains the WHOLE queue, so a post-boundary journal can belong to another
  // flow entirely — and every id returned here is registered for teardown, which VOIDS it. Passing the
  // referenceId confines both the recovery and the deletion to documents this test's own reference produced
  // (Codex). Omit it only where the caller has no reference to scope by and over-collection is impossible.
  //
  // A null `createdAfter` drops the timestamp predicate, and a referenceId-scoped call SHOULD drop it: the
  // reference already establishes ownership, while the timestamp actively EXCLUDES rows the test owns but
  // created earlier. That is not hypothetical — receiveGoods() writes the PENDING STOCK_RECEIPT row before
  // X-06 takes its boundary, so a boundary-filtered recovery would skip the very receipt journal it exists
  // to void and leak it into the shared ledger (Codex).
  if (createdAfter === null && !referenceId) {
    throw new Error('settledJournalExternalIds: dropping the timestamp predicate needs a referenceId — an unscoped snapshot would register (and void) unrelated documents.')
  }
  const since = createdAfter === null ? '' : ` and "createdAt" > $2::timestamptz`
  const scope = referenceId ? ` and "referenceId" = $${createdAfter === null ? 2 : 3}` : ''
  const params = (base: unknown[]) => {
    const withTime = createdAfter === null ? [base[0]] : base
    return referenceId ? [...withTime, referenceId] : withTime
  }
  const warn = (why: string) =>
    console.warn(`[fc-teardown] ${why} for ${type} journals${createdAfter === null ? '' : ` created after ${createdAfter}`}${referenceId ? ` (reference ${referenceId})` : ''} — a posted journal may be left in the shared ledger; check ${type} sync logs.`)

  const { Client } = await import('pg')
  // A node-postgres Client cannot be re-connected after a failed connect(), so each retry needs a FRESH
  // client — reusing one (as an earlier cut did) makes attempts 2-3 fail instantly and the retry useless
  // (Codex r4).
  let db: import('pg').Client | null = null
  for (let attempt = 0; attempt < 3 && !db; attempt++) {
    const candidate = new Client({ connectionString: process.env.DATABASE_URL })
    try {
      await candidate.connect()
      db = candidate
    } catch {
      await candidate.end().catch(() => {})
      await new Promise((res) => setTimeout(res, 1_000))
    }
  }
  if (!db) { warn('could not connect to the database'); return [] }

  try {
    const deadline = Date.now() + timeoutMs
    // Settle: wait out in-flight post-boundary work so the snapshot does not race a journal the server
    // is still posting. A transient read here is tolerated and retried against the deadline.
    let settled = false
    for (;;) {
      let inFlight = -1
      try {
        const r = await db.query<{ n: number }>(
          `select count(*)::int as n from accounting_sync_logs
            where connector = 'xero' and type = $1::"AccountingSyncType"
              and status in ('PENDING', 'PROCESSING')${since}${scope}`,
          params([type, createdAfter]),
        )
        inFlight = r.rows[0]?.n ?? 0
      } catch { /* transient — fall through to the deadline check and retry */ }
      if (inFlight === 0) { settled = true; break }
      if (Date.now() >= deadline) break
      await new Promise((res) => setTimeout(res, 2_000))
    }
    if (!settled) warn('the drain did not settle within the deadline (rows still in flight)')

    // Surface the ONE window this (and batch-fixture.postedDailyBatchJournalIds) cannot close: a row that
    // is FAILED yet carries NO external id — i.e. Xero may have accepted the POST but the id write-back
    // was lost. No id is registrable, so teardown cannot void it; warn loudly so a possibly-stranded
    // journal is visible in the run log. Recovering it needs a run-id-tagged Xero rescan, the suite-wide
    // follow-up tracked as o3d-lgo.7.1 (not built here).
    try {
      const stranded = await db.query<{ n: number }>(
        `select count(*)::int as n from accounting_sync_logs
          where connector = 'xero' and type = $1::"AccountingSyncType"
            and status = 'FAILED' and "externalTransactionId" is null${since}${scope}`,
        params([type, createdAfter]),
      )
      if ((stranded.rows[0]?.n ?? 0) > 0) {
        warn(`${stranded.rows[0].n} FAILED ${type} row(s) carry NO external id — if Xero accepted the POST the journal is unrecoverable here (o3d-lgo.7.1)`)
      }
    } catch { /* best-effort surfacing only */ }

    // Snapshot every post-boundary document that carries a Xero id (ANY status — a POST Xero accepted
    // whose status write-back lagged or later FAILED still recorded a real, voidable id), retrying a
    // transient read before giving up — a partial set beats a silent empty one.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await db.query<{ externalTransactionId: string }>(
          `select "externalTransactionId" from accounting_sync_logs
            where connector = 'xero' and type = $1::"AccountingSyncType"
              and "externalTransactionId" is not null${since}${scope}`,
          params([type, createdAfter]),
        )
        return r.rows.map((row) => row.externalTransactionId)
      } catch { await new Promise((res) => setTimeout(res, 1_000)) }
    }
    warn('could not read the posted journals')
    return []
  } finally {
    await db.end().catch(() => {})
  }
}

/** A manual journal is balanced iff its signed LineAmounts (debits +, credits −) sum to zero. */
function expectBalanced(journal: XeroManualJournal): void {
  const net = journal.JournalLines.reduce((sum, line) => sum + line.LineAmount, 0)
  expect(Math.abs(net), `journal ${journal.ManualJournalID} is unbalanced by ${net}`).toBeLessThan(0.005)
}

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

/** Read a settings value, or null when the row is absent — so a test can restore the EXACT prior state
 *  (delete vs. write-back) rather than blanket-deleting a key it only temporarily overrode. */
async function getSettingRaw(key: string): Promise<string | null> {
  const { Client } = await import('pg')
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    const r = await db.query<{ value: string }>(`select value from settings where key = $1`, [key])
    return r.rows.length ? r.rows[0].value : null
  } finally {
    await db.end()
  }
}

/** Upsert a settings row (X-05 arms the per-type manufacturing posting setting the rig leaves unset). */
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

/** Delete a settings row, restoring the rig's baseline for a key a test armed. */
async function deleteSetting(key: string): Promise<void> {
  const { Client } = await import('pg')
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    await db.query(`delete from settings where key = $1`, [key])
  } finally {
    await db.end()
  }
}

/**
 * Seed a controlled, within-tolerance transit subledger-vs-GL residue so the daily-batch transit
 * reconciliation (transit-gl-reconciliation.ts) sweeps EXACTLY `residue` (X-02).
 *
 * The reconciliation compares the transit account's GL PERIOD MOVEMENT between two balance snapshots
 * (opening = closing − 1 day, closing) against Σ of the transit subledger movements over that same
 * half-open window (opening.balanceDate, closing.balanceDate]. delta = subledger − GL classifies the
 * gap; |delta| ≤ £1 sweeps. The rig holds NO transit balance snapshots, so this seeds both:
 *   - read the LIVE subledger movement S over the window (whatever real purchase postings sit there),
 *   - set opening.amountBase = 0 and closing.amountBase = round2(S) − residue,
 * so GL movement = round2(S) − residue while the subledger sums to S → delta = +residue exactly,
 * regardless of what real transit activity the window already contains. Uses base currency GBP and a
 * synthetic externalAccountId (distinct from any real Xero account id) under accountCode 632, so
 * findLatestAccountBalanceSnapshot resolves it by account code.
 *
 * FRESH DATE PER RUN (Codex): the sweep's Xero Idempotency-Key is STABLE per date
 * (`DAILY_BATCH_TRANSIT_RECONCILIATION:TRANSITRECON-<date>`, sync-processor.ts:1425), so re-posting the
 * SAME date returns the prior — now teardown-voided — journal and the accounting-event mirror collides
 * on (externalSystem, externalId). So this scans the coverage window newest-first for a date whose
 * reconciliation was NEVER posted (no DAILY_BATCH_TRANSIT_RECONCILIATION accounting_event), and uses
 * that as the closing date — guaranteeing a fresh Xero idempotency key AND a clean mirror every run.
 * The window is [today−6 … today]: every such date's opening (date−1) still satisfies the coverage
 * watermark (transit_ledger_coverage_start_date = 2026-07-16). The chosen date's event is left in place
 * as a "used" marker so it is not reused within the same rolling window; a new UTC day frees a fresh
 * date automatically. Throws (→ the test fails loudly) if all seven are exhausted in one window.
 *
 * Returns the chosen dateIso and a cleanup that removes only the two snapshot rows it seeded (tagged by
 * sourcePayloadRef); it also clears any STALE seeded snapshots up front so findLatest resolves to this
 * run's closing date rather than a crashed run's leftover.
 */
async function seedTransitReconciliationResidue(
  transitAccount: string,
  residue: number,
): Promise<{ cleanup: () => Promise<void>; dateIso: string }> {
  const { Client } = await import('pg')
  const { randomUUID } = await import('node:crypto')
  const TAG = 'e2e-fc-x02'
  const externalAccountId = `e2e-fc-x02-${transitAccount}`

  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()

  const midnightUtc = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const isoOf = (d: Date) => d.toISOString().slice(0, 10)

  let dateIso = ''
  try {
    // Clear stale seeded snapshots first, so findLatestAccountBalanceSnapshot resolves 632 to THIS run's
    // closing date and not a crashed run's leftover at a later date.
    await db.query(`delete from accounting_account_balance_snapshots where "sourcePayloadRef" = $1`, [TAG])

    // Pick a fresh, never-posted closing date in [today−6 … today] (all satisfy the coverage watermark).
    // A date counts as USED if it carries EITHER a DAILY_BATCH_TRANSIT_RECONCILIATION accounting_event OR a
    // LIVE (PENDING/PROCESSING/SYNCED) sync log for TRANSITRECON-<date>. Checking the sync log too matters
    // because production deliberately allows the accounting-event MIRROR to fail while the sync log stays
    // queued and posts — and daily-batch dedup (hasLiveDailyBatchLog) keys on that live sync log. Skipping
    // it would let us pick a date whose sweep is suppressed by an existing live log, wasting the batch
    // quota and finding no journal (Codex r4).
    const today = midnightUtc(new Date())
    let closingDate: Date | null = null
    for (let back = 0; back <= 6; back++) {
      const d = new Date(today)
      d.setUTCDate(d.getUTCDate() - back)
      const ref = `TRANSITRECON-${isoOf(d)}`
      const used = await db.query<{ n: number }>(
        `select (
           (select count(*) from accounting_events
              where type = 'DAILY_BATCH_TRANSIT_RECONCILIATION' and "sourceEntityId" = $1)
         + (select count(*) from accounting_sync_logs
              where connector = 'xero' and type = 'DAILY_BATCH_TRANSIT_RECONCILIATION'
                and "referenceId" = $1 and status in ('PENDING', 'PROCESSING', 'SYNCED'))
         )::int as n`,
        [ref],
      )
      if ((used.rows[0]?.n ?? 0) === 0) { closingDate = d; break }
    }
    if (!closingDate) {
      throw new Error(
        'X-02: every transit reconciliation date in the coverage window [today−6 … today] is already used. ' +
          'The sweep is idempotent per date at Xero, so a used date returns the voided journal — wait for a new UTC day.',
      )
    }
    const openingDate = new Date(closingDate)
    openingDate.setUTCDate(openingDate.getUTCDate() - 1)
    dateIso = isoOf(closingDate)

    // Live subledger movement over (openingDate, closingDate], rounded to GL precision (2dp). This is
    // whatever real PURCHASE_BILL/STOCK_RECEIPT/etc. rows the window already holds — the closing
    // snapshot below absorbs it so only `residue` is left as the gap.
    const s = await db.query<{ sum: string | null }>(
      `select coalesce(sum(base_delta), 0)::text as sum from transit_subledger_movements
        where journal_date > $1 and journal_date <= $2`,
      [openingDate, closingDate],
    )
    const subledgerSum = Math.round(Number(s.rows[0]?.sum ?? 0) * 100) / 100
    const closingAmount = Math.round((subledgerSum - residue) * 100) / 100

    const insert = async (balanceDate: Date, amountBase: number) =>
      db.query(
        `insert into accounting_account_balance_snapshots
           (id, connector, "externalAccountId", "accountCode", "accountName", "balanceDate", currency,
            "amountForeign", "amountBase", "sourcePayloadRef", "fetchedAt", "createdAt", "updatedAt")
         values ($1, 'xero', $2, $3, 'Stock in Transit (e2e)', $4, 'GBP', $5, $5, $6, now(), now(), now())
         on conflict (connector, "externalAccountId", "balanceDate", currency)
           do update set "amountBase" = excluded."amountBase", "amountForeign" = excluded."amountForeign",
                         "sourcePayloadRef" = excluded."sourcePayloadRef", "fetchedAt" = now()`,
        [`${TAG}-${randomUUID()}`, externalAccountId, transitAccount, balanceDate, amountBase, TAG],
      )
    await insert(openingDate, 0)
    await insert(closingDate, closingAmount)
  } finally {
    await db.end()
  }

  return {
    dateIso,
    cleanup: async () => {
      const c = new Client({ connectionString: process.env.DATABASE_URL })
      await c.connect()
      try {
        await c.query(`delete from accounting_account_balance_snapshots where "sourcePayloadRef" = $1`, [TAG])
      } finally {
        await c.end()
      }
    },
  }
}

/** Signed sum of a manual journal's lines on one account (+ debit, − credit; expectJournalLine convention). */
function journalSumFor(journal: XeroManualJournal, accountCode: string): number {
  return journal.JournalLines.filter((l) => l.AccountCode === accountCode).reduce((s, l) => s + l.LineAmount, 0)
}

/**
 * The warehouse the goods receipt landed in (transfer source), plus a DIFFERENT warehouse to transfer to
 * (X-06). Source = the cost layer's warehouse (robust to whichever warehouse the PO defaulted to);
 * destination prefers E2E-SECOND but is any other warehouse.
 */
async function pickTransferWarehouses(sku: string): Promise<{ sourceWarehouseId: string; destWarehouseId: string }> {
  const layers = await queryRows<{ wid: string }>(
    `select cl."warehouseId" as wid from cost_layers cl
       join products p on p.id = cl."productId"
      where p.sku = $1 order by cl."receivedAt" desc limit 1`,
    [sku],
  )
  if (!layers.length) throw new Error(`pickTransferWarehouses: no cost layer found for ${sku} — did the receipt post?`)
  const sourceWarehouseId = layers[0].wid
  const others = await queryRows<{ id: string }>(
    `select id from warehouses where id <> $1 order by (case when code = 'E2E-SECOND' then 0 else 1 end), code asc limit 1`,
    [sourceWarehouseId],
  )
  if (!others.length) throw new Error('pickTransferWarehouses: the rig needs a second warehouse to transfer to.')
  return { sourceWarehouseId, destWarehouseId: others[0].id }
}

/** Total received/remaining qty across a SKU's cost layers in one warehouse (X-06 transfer verification). */
async function costLayerTotalsAt(sku: string, warehouseId: string): Promise<{ received: number; remaining: number }> {
  const rows = await queryRows<{ received: number; remaining: number }>(
    `select coalesce(sum(cl."receivedQty"), 0)::float8 as received,
            coalesce(sum(cl."remainingQty"), 0)::float8 as remaining
       from cost_layers cl join products p on p.id = cl."productId"
      where p.sku = $1 and cl."warehouseId" = $2`,
    [sku, warehouseId],
  )
  return { received: rows[0]?.received ?? 0, remaining: rows[0]?.remaining ?? 0 }
}

/** Count COGS_JOURNAL sync-log rows for a PO — the exclusion check: TRANSFERRED-out units must post NONE. */
/**
 * EVERY STOCK_IN_TRANSIT sync row for the PO — status and id, whatever the status.
 *
 * X-06's exact-once claim needs the complete picture, which externalIdsFor cannot give: that helper returns
 * the moment `expected` distinct documents are SYNCED, so a duplicate still PENDING is invisible to it. Here
 * an in-flight row is visible (the barrier) and every terminal row's id counts toward the distinct-document
 * total (the count).
 */
async function transitSyncRowsForPo(
  poId: string,
): Promise<Array<{ status: string; externalTransactionId: string | null }>> {
  return queryRows<{ status: string; externalTransactionId: string | null }>(
    `select status, "externalTransactionId" from accounting_sync_logs
      where connector = 'xero' and type = 'STOCK_IN_TRANSIT'::"AccountingSyncType" and "referenceId" = $1
      order by "createdAt" asc`,
    [poId],
  )
}

async function cogsJournalCountForPo(poId: string, createdAfter: string): Promise<number> {
  const rows = await queryRows<{ n: number }>(
    `select count(*)::int as n from accounting_sync_logs
      where connector = 'xero' and type = 'COGS_JOURNAL'::"AccountingSyncType"
        and "referenceId" = $1 and "createdAt" > $2::timestamptz`,
    [poId, createdAfter],
  )
  return rows[0]?.n ?? 0
}

// --- X-04 tax-rate drift helpers ---------------------------------------------

/**
 * Pick a live Xero rate to mirror: a single-component, non-zero rate, preferring a "VAT on Expenses"
 * (input/purchases) rate so nothing an order-to-cash test maps to is perturbed. Falls back to any
 * single-component rate with a positive component.
 */
function pickMirrorableXeroRate(rates: XeroTaxRate[]): XeroTaxRate {
  const single = rates.filter((r) => (r.TaxComponents?.length ?? 0) === 1 && (r.TaxComponents![0].Rate ?? 0) > 0)
  if (!single.length) {
    throw new Error('X-04: no live Xero tax rate with a single positive component to mirror — cannot seed the drift baseline.')
  }
  const preferred = single.find((r) => /VAT on Expenses/i.test(r.Name) && r.Status === 'ACTIVE')
    ?? single.find((r) => r.Status === 'ACTIVE')
    ?? single[0]
  return preferred
}

// Every X-04 tax-rate row this test creates carries this id prefix, so all cleanup is scoped to rows THIS
// test owns — never "all rates with components" and never by name (which could erase real, persistent tax
// configuration; Codex HIGH). Defined in the harness because the pure snapshot filter is keyed on it too.

/**
 * Fail closed unless we are pointed at the disposable e2e database.
 *
 * Was a DENYLIST of the stage database name, which passed for production, a backup, a renamed clone or any
 * misconfiguration we had not thought of — while the helpers behind it delete tax rates and ActivityLog rows
 * and restore global Settings (Codex). assertE2eDatabase is the positive allowlist the batch fixture already
 * used, now shared.
 */
function assertNotStageDb(): void {
  assertE2eDatabase('X-04 tax-rate fixture')
}

/** Delete ONLY X-04-owned seeded tax rates (id prefix), clearing a crashed prior run; components cascade. */
async function deleteX04SeededTaxRates(): Promise<void> {
  assertNotStageDb()
  const { Client } = await import('pg')
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    await db.query(`delete from tax_rates where id like $1`, [`${X04_TAX_RATE_ID_PREFIX}%`])
  } finally {
    await db.end()
  }
}

/**
 * Purge X-04-owned entries from the LIVE drift snapshot + their ActivityLog rows, so a crashed prior run
 * cannot hand this run a dangling baseline to preserve.
 *
 * Runs before the baseline capture (see the call site). Everything is scoped by the X04 id prefix, so a
 * real drifted rate detected by the operator's own hourly sweep survives untouched — the snapshot is
 * operator-visible state, and erasing someone else's entry would be worse than leaving ours.
 */
async function purgeX04DriftSnapshotEntries(): Promise<void> {
  assertNotStageDb()
  const raw = await getSettingRaw('xero_tax_rate_drift_current')
  const purged = withoutX04DriftEntries(raw)
  if (purged !== raw) {
    console.warn('[X-04] purged leftover e2e-x04 entries from xero_tax_rate_drift_current (a prior run crashed after injecting drift)')
    await restoreSetting('xero_tax_rate_drift_current', purged)
  }
  const { Client } = await import('pg')
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    await db.query(
      `delete from activity_logs where action = 'tax_rate_drift_detected' and "entityId" like $1`,
      [`${X04_TAX_RATE_ID_PREFIX}%`],
    )
  } finally {
    await db.end()
  }
}

/** Delete EXACTLY one seeded tax rate by id (teardown; components cascade). Guarded to our own id prefix. */
async function deleteTaxRateById(id: string): Promise<void> {
  assertNotStageDb()
  if (!id.startsWith(X04_TAX_RATE_ID_PREFIX)) {
    throw new Error(`deleteTaxRateById refused: ${id} is not an X-04-owned tax rate id.`)
  }
  const { Client } = await import('pg')
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    await db.query(`delete from tax_rates where id = $1`, [id])
  } finally {
    await db.end()
  }
}

/**
 * Seed an active IMS TaxRate that MIRRORS a live Xero rate: same name (exact, so the sweep matches it by
 * name key), one active component with `percent` as a decimal fraction (rate*100 = percent). Returns the
 * new tax rate id. Relies on DB defaults for type/taxCategory/usedFor/flags; sets the @updatedAt columns.
 */
async function seedMirroredTaxRate(
  name: string, componentName: string, percent: number, isCompound: boolean,
): Promise<string> {
  assertNotStageDb()
  const { Client } = await import('pg')
  const { randomUUID } = await import('node:crypto')
  const rateId = `${X04_TAX_RATE_ID_PREFIX}-${randomUUID()}`
  const componentId = `${X04_TAX_RATE_ID_PREFIX}c-${randomUUID()}`
  const fraction = percent / 100
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    await db.query(
      `insert into tax_rates (id, name, rate, is_compound, active, "createdAt", "updatedAt")
         values ($1, $2, $3, $4, true, now(), now())`,
      [rateId, name, fraction, isCompound],
    )
    await db.query(
      `insert into tax_rate_components
         (id, tax_rate_id, name, rate, compound_on_previous, "sort_order", active, created_at, updated_at)
         values ($1, $2, $3, $4, $5, 0, true, now(), now())`,
      [componentId, rateId, componentName, fraction, isCompound],
    )
    return rateId
  } finally {
    await db.end()
  }
}

/** Set the (single) component rate of a seeded tax rate to `fraction` (decimal), to inject/clear drift. */
async function setTaxRateComponentRate(taxRateId: string, fraction: number): Promise<void> {
  assertNotStageDb()
  const { Client } = await import('pg')
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    const r = await db.query(
      `update tax_rate_components set rate = $2, updated_at = now() where tax_rate_id = $1`,
      [taxRateId, fraction],
    )
    if (r.rowCount !== 1) throw new Error(`setTaxRateComponentRate: expected to update 1 component, updated ${r.rowCount}`)
  } finally {
    await db.end()
  }
}

/** Whether the drift snapshot Setting currently names a tax rate id. */
async function driftSnapshotHasRate(taxRateId: string): Promise<boolean> {
  const raw = await getSettingRaw('xero_tax_rate_drift_current')
  if (!raw) return false
  try {
    const entries = JSON.parse(raw) as Array<{ taxRateId?: string }>
    return Array.isArray(entries) && entries.some((e) => e.taxRateId === taxRateId)
  } catch {
    return false
  }
}

/** The tax_rate_drift_detected ActivityLog rows for a tax rate id, newest first. */
async function driftActivityLogRows(
  taxRateId: string,
): Promise<Array<{ action: string; entityType: string; level: string; tag: string }>> {
  return queryRows(
    `select action, "entityType"::text as "entityType", level::text as level, tag
       from activity_logs
      where action = 'tax_rate_drift_detected' and "entityId" = $1
      order by "createdAt" desc`,
    [taxRateId],
  )
}

/** Remove the ActivityLog rows the drift detection wrote for a tax rate id (teardown). */
/** The database's own clock — a cutoff taken from the app's clock could skew against the rows it filters. */
async function dbNow(): Promise<string> {
  const rows = await queryRows<{ now: string }>(`select now()::text as now`, [])
  return rows[0].now
}

/**
 * Delete tax_rate_drift_detected rows written SINCE `cutoff`, preserving everything older.
 *
 * X-04's three sweeps are global: each logs a WARNING for EVERY drifted component-backed IMS rate, not just
 * the seeded one — and the spec deliberately tolerates other component-backed rates existing. Deleting only
 * rows for our own taxRateId therefore left up to three duplicate warnings per run for any genuinely drifted
 * rate, while the snapshot and last-checked stamp were rolled back — contradictory observability that buries
 * real alerts (Codex). The cutoff is taken immediately before the first sweep, so rows the operator's own
 * hourly sweep wrote earlier survive; on the rig the only sweeps inside the window are this test's.
 */
async function deleteDriftActivityLogRowsSince(cutoff: string): Promise<void> {
  assertNotStageDb()
  await queryRows(
    `delete from activity_logs where action = 'tax_rate_drift_detected' and "createdAt" >= $1::timestamptz`,
    [cutoff],
  )
}

async function deleteDriftActivityLogRows(taxRateId: string): Promise<void> {
  const { Client } = await import('pg')
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    await db.query(`delete from activity_logs where action = 'tax_rate_drift_detected' and "entityId" = $1`, [taxRateId])
  } finally {
    await db.end()
  }
}

/** Restore a settings key to EXACTLY its prior state — delete if it was absent, else write the value back. */
async function restoreSetting(key: string, prior: string | null): Promise<void> {
  if (prior === null) await deleteSetting(key)
  else await setSetting(key, prior)
}
