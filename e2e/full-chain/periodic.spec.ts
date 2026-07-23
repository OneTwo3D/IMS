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
 */
import { expect, test } from '@playwright/test'
import { currentRunId } from './harness/global-setup.ts'
import { runTag, taggedSku } from './harness/tag.ts'
import { awaitWebhookDelivery, cleanupWc, createWcOrder, createWcProduct, wcCreds, type WcCreds } from './harness/wc.ts'
import {
  allocateAndShip, applyStockWriteOff, openSalesOrder, processPendingXeroSyncViaUi, runDailyBatch, setPostingMode,
} from './harness/ims.ts'
import { addStockAdjustment, createInventoryProduct } from '../helpers.ts'
import {
  expectJournalLine, externalIdFor, getInvoice, getManualJournal, trackDocument, type XeroManualJournal,
} from './harness/xero.ts'
import {
  dailyBatchBoundary, dailyBatchDoc, deleteUnjournaledShipmentBaseline, postedDailyBatchJournalIds,
} from './harness/batch-fixture.ts'

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
    await setPostingMode({ sync: true, dailyBatch: false })

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
    // (bulk-adjustment-form.tsx), so a reason present at seed time would make this "reasonless" +10
    // silently queue its OWN £100 INVENTORY_ADJUSTMENT and strand it untracked in the shared ledger
    // (Codex r1). With adjustment_reasons empty here, the line carries no reason and posts nothing —
    // its only job is to lay down a £10/unit cost layer for the write-off to consume.
    await createInventoryProduct(page, { sku, name: `${runTag(runId)} X07`, price: '20.00' })
    await addStockAdjustment(page, sku, 10, WAREHOUSE_CODE)

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
        for (const posted of await settledJournalExternalIds('INVENTORY_ADJUSTMENT', boundary).catch(() => [])) {
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
 * Mirrors batch-fixture.postedDailyBatchJournalIds.
 */
async function settledJournalExternalIds(type: string, createdAfter: string, timeoutMs = 30_000): Promise<string[]> {
  const { Client } = await import('pg')
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const inFlight = await db.query<{ n: number }>(
        `select count(*)::int as n from accounting_sync_logs
          where connector = 'xero' and type = $1::"AccountingSyncType"
            and "createdAt" > $2::timestamptz and status in ('PENDING', 'PROCESSING')`,
        [type, createdAfter],
      )
      if ((inFlight.rows[0]?.n ?? 0) === 0 || Date.now() >= deadline) {
        const r = await db.query<{ externalTransactionId: string }>(
          `select "externalTransactionId" from accounting_sync_logs
            where connector = 'xero' and type = $1::"AccountingSyncType"
              and "createdAt" > $2::timestamptz and "externalTransactionId" is not null`,
          [type, createdAfter],
        )
        return r.rows.map((row) => row.externalTransactionId)
      }
      await new Promise((res) => setTimeout(res, 2_000))
    }
  } finally {
    await db.end()
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
