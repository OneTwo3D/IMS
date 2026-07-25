/**
 * Batch-mode clean-state fixture for the periodic full-chain spec (o3d-lgo.7 / X-series).
 *
 * WHY THIS EXISTS — the trap, not the mechanics.
 *
 * runDailyBatchSync() (lib/connectors/xero/daily-sync.ts) is GLOBAL and UNSCOPED: it
 * journals EVERY order the batch's three groups can reach, across the whole database. In
 * SYNC mode a shipment is never journaled — its accounting_shipment_journal_date is set
 * ONLY by the daily batch (daily-sync.ts:1276) — so every prior sync-mode order-to-cash
 * test leaves behind a SHIPPED shipment with a null journal date and a paid+invoiced sales
 * order with a null revenue-deferred date. These accumulate: ~98 stranded shipments at the
 * time this was written.
 *
 * Run the batch against that residue and it posts dozens of orders' worth of COGS and
 * revenue journals into the SHARED Xero Demo ledger in one go — none of them tracked for
 * teardown, all of them stranded. A batch-mode tie-out test is only meaningful if the
 * batch has EXACTLY the test's own fresh shipment to journal, so the run's groupA1/A2/B
 * counts and the read-back journals are about one known order rather than a pile of
 * history.
 *
 * The endorsed way to get there is to DELETE the pre-existing batch candidates and their
 * dependency subtree, verified live against the real FK graph.
 *
 * TARGETING (Codex r1): the candidate set is the batch's OWN A1/A2/B predicates, NOT a
 * loose "any un-journaled shipment". That earlier predicate got it wrong at both ends — it
 * over-deleted orders whose only shipment was still PENDING (never a batch input), and it
 * MISSED A1/A2-eligible orders that carry no shipment at all (still journaled by the global
 * batch, stranding an untracked journal). Mirroring daily-sync.ts's own filters deletes
 * exactly what the batch would touch, no more and no less, and a fail-closed invariant
 * recount below refuses to proceed if any candidate survives.
 *
 * DELETE ORDER is dictated by the RESTRICT foreign keys, bottom-up:
 *   shipment_lines        RESTRICT-blocks sales_order_lines (lineId); deleting it also
 *                         SET-NULLs the surviving stock_movements.shipmentLineId — the
 *                         dispatch movements are left orphaned on purpose (they feed no
 *                         batch group, and restoring the cost layers they consumed would be
 *                         far riskier than leaving valued history behind).
 *   sales_order_refund_lines  RESTRICT-blocks sales_order_refunds (refundId).
 *   payments              RESTRICT-blocks sales_orders (orderId).
 *   sales_order_refunds   RESTRICT-blocks sales_orders (orderId).
 *   sales_order_lines     RESTRICT-blocks sales_orders (orderId).
 *   sales_orders          last; CASCADE-removes order_allocations, shipments (whose
 *                         shipment_lines are already gone), shopping_order_links and the
 *                         wms_* rows.
 *
 * We deliberately do NOT touch stock_movements / cogs_entries / cost_layers: no FK forces
 * it (shipment_lines -> stock_movements is SET NULL), the batch's posting groups never read
 * raw movements, and the reconciliation sweeps only post a journal for a SUB-PENNY
 * subledger-vs-GL rounding gap — a material gap is flagged, never swept — so orphaned
 * historical movements cannot make the batch post a stray journal.
 *
 * Idempotent and safe to call at the start of every batch-mode test: on a clean database
 * the candidate set is empty and every delete is a no-op.
 */
import { Client } from 'pg'

import { assertE2eDatabase } from './db-guard.ts'
import { trackDocument, type XeroDocKind } from './xero.ts'

/**
 * The batch-candidate anchor — the exact set daily-sync.ts's Groups A1, A2 and B can reach
 * in one run, each arm mirroring that group's OWN production filter so the union neither
 * over- nor under-deletes (Codex r2):
 *   - A1: paid + invoiced order, revenue-deferred marker still null (daily-sync.ts:553).
 *   - A2: revenue-deferred set but inventory-allocated still null (daily-sync.ts:656).
 *   - B:  BOTH markers already set AND a SHIPPED shipment not yet journaled
 *         (daily-sync.ts:789) — the marker requirements matter, because a shipped-but-
 *         uninvoiced/unpaid order can never pass A1→A2 and so the batch can never journal
 *         it; without them the B arm would irreversibly delete orders the batch cannot
 *         reach. The same-run chain (A1 defers → A2 reclassifies → B journals) is covered
 *         by the A1/A2 arms: an order the batch WILL journal this run but whose markers are
 *         still null is caught by A1 (or A2), not B.
 * refundStatus='FULL' is excluded everywhere the batch excludes it. An order matching ANY
 * arm is one the batch will act on, so the union is the set to clear.
 */
const CANDIDATE_ORDER_IDS = `
  SELECT o.id
  FROM sales_orders o
  WHERE
    (o."paidAt" IS NOT NULL
       AND o.accounting_revenue_deferred_date IS NULL
       AND o.accounting_invoice_id IS NOT NULL
       AND o.status NOT IN ('CANCELLED', 'DRAFT')
       AND o."refundStatus" <> 'FULL')
    OR
    (o.accounting_revenue_deferred_date IS NOT NULL
       AND o.accounting_inventory_allocated_date IS NULL
       AND o.status IN ('ALLOCATED', 'PICKING', 'PACKING', 'SHIPPED', 'COMPLETED', 'DELIVERED')
       AND o."refundStatus" <> 'FULL')
    OR
    (o.accounting_revenue_deferred_date IS NOT NULL
       AND o.accounting_inventory_allocated_date IS NOT NULL
       AND o."refundStatus" <> 'FULL'
       AND EXISTS (
         SELECT 1 FROM shipments s
         WHERE s."orderId" = o.id
           AND s.status = 'SHIPPED'
           AND s.accounting_shipment_journal_date IS NULL))
`

export type BatchBaselineResult = {
  candidateOrders: number
  deleted: {
    shipmentLines: number
    refundLines: number
    payments: number
    refunds: number
    orderLines: number
    orders: number
  }
  cancelledSyncLogs: number
  /**
   * Rows this baseline retired that ALREADY CARRIED a Xero id — i.e. Xero accepted the document and the
   * local status write-back was lost or later failed. Cancelling such a row is still correct (it must not be
   * revived and reposted against orders we are about to delete), but the DOCUMENT is real and live in the
   * shared Demo ledger, so the caller must register it for teardown. Blanket-cancelling without surfacing
   * these hid live journals and skewed the reconciliation sweeps X-02 asserts on (Codex, o3d-lgo.16).
   */
  retiredPostedDocuments: RetiredPostedDocument[]
}

export type RetiredPostedDocument = {
  type: string
  referenceId: string
  externalId: string
  /** The status the row held BEFORE cancellation — 'PROCESSING' means it was claimed and possibly in flight. */
  priorStatus: string
}

/**
 * Delete every pre-existing daily-batch candidate order and its dependency subtree so a
 * subsequent runDailyBatchSync() journals ONLY the caller's own fresh shipment.
 *
 * Runs as a single transaction — either the whole candidate subtree goes or none of it
 * does — and ends with a fail-closed invariant recount: if any A1/A2/B candidate survives,
 * it ROLLs BACK and throws rather than arm a run the batch could pollute. Returns per-table
 * counts for the run log.
 */
export async function deleteUnjournaledShipmentBaseline(): Promise<BatchBaselineResult> {
  const url = process.env.DATABASE_URL ?? ''
  // POSITIVE allowlist (Codex r1/r2), not a STAGE denylist and not a substring test: this is a destructive,
  // unscoped delete, so it runs ONLY when the URL's DATABASE NAME is exactly the e2e database. Now shared
  // with the X-04 tax-rate fixture, which had a weaker denylist guard (harness/db-guard.ts).
  assertE2eDatabase('deleteUnjournaledShipmentBaseline')

  const db = new Client({ connectionString: url })
  await db.connect()
  try {
    await db.query('BEGIN')

    // Retire any stale DAILY-BATCH work FIRST, independent of the candidate orders (Codex r2,
    // critical). Daily-batch logs key on referenceType='DailyBatch' with a digest reference
    // (`A1-<date>-<hash>`), NOT an order/refund id, so the id-scoped cancellation below can't
    // reach them. A left-over PENDING/PROCESSING one would be drained straight to the shared
    // ledger UNTRACKED by the next processPendingXeroSync; worse, runDailyBatchSync's
    // resetFailedDailyBatchLogs REVIVES every FAILED daily-batch log to PENDING, so a stale
    // FAILED row would repost a payload computed from orders this baseline just deleted.
    // CANCELLED is safe: the drain and the outbox claim both require PENDING/PROCESSING
    // (sync-processor.ts), and the FAILED-reset only touches FAILED — so a cancelled row is
    // inert and cannot be revived. Runs even when there are no candidate orders.
    //
    // Capture rows that ALREADY POSTED before retiring them (o3d-lgo.16). A FAILED — or even PENDING — row
    // CAN carry an externalTransactionId: Xero accepted the POST and the status write-back was lost. That
    // document is live in the shared ledger, and cancelling its row makes it invisible to every retry and
    // dashboard, so the ids are returned for the caller to register with trackDocument.
    const retiredPostedDocuments = await selectPostedRowsAboutToBeRetired(db, {
      sql: `"referenceType" = 'DailyBatch' AND status IN ('PENDING', 'PROCESSING', 'FAILED')`,
      params: [],
    })
    const cancelledBatchLogs = await db.query(
      `UPDATE accounting_sync_logs
          SET status = 'CANCELLED'
        WHERE "referenceType" = 'DailyBatch'
          AND status IN ('PENDING', 'PROCESSING', 'FAILED')`,
    )

    // Resolve the candidate order ids ONCE, then anchor every delete on that id array.
    // Re-running the predicate per delete is not just slower — each delete removes rows and
    // SET-NULLs shipmentLineId, so a live subquery would see a moving target. Capture the
    // refund ids in the same breath: their sync logs key on refundId, not orderId, and the
    // cascade drops the refund rows before we get a chance to name them (Codex r2).
    const candidates = await db.query<{ id: string }>(CANDIDATE_ORDER_IDS)
    const orderIds = candidates.rows.map((r) => r.id)

    if (orderIds.length === 0) {
      await db.query('COMMIT')
      warnRetiredPostedDocuments(retiredPostedDocuments)
      return {
        candidateOrders: 0,
        deleted: { shipmentLines: 0, refundLines: 0, payments: 0, refunds: 0, orderLines: 0, orders: 0 },
        cancelledSyncLogs: cancelledBatchLogs.rowCount ?? 0,
        retiredPostedDocuments,
      }
    }

    const refundRows = await db.query<{ id: string }>(
      `SELECT id FROM sales_order_refunds WHERE "orderId" = ANY($1::text[])`,
      [orderIds],
    )
    const refundIds = refundRows.rows.map((r) => r.id)

    // Retire any live sync logs BEFORE the source rows disappear. The global preflight
    // blocks a run on any PENDING/PROCESSING accounting_sync_log, and — worse — the next
    // processPendingXeroSync would drain a surviving log and post its payload to the shared
    // Demo ledger UNTRACKED. Logs key on referenceId (salesOrderId for the invoice/deferral
    // family, refundId for CREDIT_NOTE / COGS_REVERSAL / UNEARNED_REV_REVERSAL — Codex r2),
    // never a strict FK, so both id families must be named. Ids are cuids (globally unique),
    // so matching by referenceId alone cannot catch an unrelated document.
    // Same posted-row capture as above, for the order/refund-scoped family (o3d-lgo.16).
    retiredPostedDocuments.push(...await selectPostedRowsAboutToBeRetired(db, {
      sql: `status IN ('PENDING', 'PROCESSING') AND "referenceId" = ANY($1::text[])`,
      params: [[...orderIds, ...refundIds]],
    }))
    const cancelled = await db.query(
      `UPDATE accounting_sync_logs
          SET status = 'CANCELLED'
        WHERE status IN ('PENDING', 'PROCESSING')
          AND "referenceId" = ANY($1::text[])`,
      [[...orderIds, ...refundIds]],
    )

    // Bottom-up, in the RESTRICT-dictated order documented above.
    const shipmentLines = await db.query(
      `DELETE FROM shipment_lines WHERE "shipmentId" IN (SELECT id FROM shipments WHERE "orderId" = ANY($1::text[]))`,
      [orderIds],
    )
    const refundLines = await db.query(
      `DELETE FROM sales_order_refund_lines WHERE "refundId" = ANY($1::text[])`,
      [refundIds],
    )
    const payments = await db.query(`DELETE FROM payments WHERE "orderId" = ANY($1::text[])`, [orderIds])
    const refunds = await db.query(`DELETE FROM sales_order_refunds WHERE "orderId" = ANY($1::text[])`, [orderIds])
    const orderLines = await db.query(`DELETE FROM sales_order_lines WHERE "orderId" = ANY($1::text[])`, [orderIds])
    const orders = await db.query(`DELETE FROM sales_orders WHERE id = ANY($1::text[])`, [orderIds])

    // Fail-closed invariant (Codex r1): after the delete NO batch candidate may remain. On a
    // correctly-scoped delete this is always zero; if it is not, some candidate slipped the
    // predicate and the batch would journal it, so refuse to proceed rather than post a
    // stray, untracked journal into the shared ledger.
    const survivors = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM (${CANDIDATE_ORDER_IDS}) c`,
    )
    const remaining = survivors.rows[0]?.n ?? 0
    if (remaining > 0) {
      await db.query('ROLLBACK')
      throw new Error(
        `Baseline invariant failed: ${remaining} daily-batch candidate order(s) still present after cleanup — refusing to arm the batch.`,
      )
    }

    await db.query('COMMIT')
    warnRetiredPostedDocuments(retiredPostedDocuments)
    return {
      candidateOrders: orderIds.length,
      deleted: {
        shipmentLines: shipmentLines.rowCount ?? 0,
        refundLines: refundLines.rowCount ?? 0,
        payments: payments.rowCount ?? 0,
        refunds: refunds.rowCount ?? 0,
        orderLines: orderLines.rowCount ?? 0,
        orders: orders.rowCount ?? 0,
      },
      cancelledSyncLogs: (cancelledBatchLogs.rowCount ?? 0) + (cancelled.rowCount ?? 0),
      retiredPostedDocuments,
    }
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    await db.end()
  }
}

/**
 * The rows a pending cancellation is about to retire that ALREADY carry a Xero id.
 *
 * Runs INSIDE the baseline's transaction and BEFORE the UPDATE, because after it the prior status is gone.
 * `where` is a fixed fragment written here in this file, never caller input; params are bound.
 */
async function selectPostedRowsAboutToBeRetired(
  db: Client,
  where: { sql: string; params: unknown[] },
): Promise<RetiredPostedDocument[]> {
  const r = await db.query<{ type: string; referenceId: string; externalTransactionId: string; status: string }>(
    `SELECT type::text AS type, "referenceId", "externalTransactionId", status
       FROM accounting_sync_logs
      WHERE connector = 'xero' AND "externalTransactionId" IS NOT NULL AND (${where.sql})`,
    where.params,
  )
  return r.rows.map((row) => ({
    type: row.type,
    referenceId: row.referenceId,
    externalId: row.externalTransactionId,
    priorStatus: row.status,
  }))
}

/**
 * Say out loud what was retired despite having posted — a silent cancellation is how a live journal goes
 * missing. A PROCESSING row is called out separately: it was CLAIMED, so something may have been mid-flight
 * (the preflight is supposed to block a run while any row is PENDING/PROCESSING, so seeing one here means
 * that guard was bypassed or a prior run died mid-drain).
 */
function warnRetiredPostedDocuments(docs: RetiredPostedDocument[]): void {
  for (const doc of docs) {
    console.warn(
      `[batch-baseline] RETIRED a ${doc.priorStatus} ${doc.type} row that had already posted to Xero ` +
        `(${doc.externalId}, reference ${doc.referenceId}) — the document is LIVE in the shared ledger and ` +
        `must be registered for teardown (o3d-lgo.16).`,
    )
  }
  const claimed = docs.filter((d) => d.priorStatus === 'PROCESSING')
  if (claimed.length) {
    console.warn(
      `[batch-baseline] ${claimed.length} of those were PROCESSING (claimed, possibly in flight) — the ` +
        `preflight should have blocked this run; check for a prior run that died mid-drain.`,
    )
  }
}

/**
 * The daily-batch clock boundary — the current database time, captured just BEFORE the
 * batch is triggered so the read-back can require a journal created AFTER it (see
 * dailyBatchDoc). Read from the DB rather than the test process to avoid host/DB clock skew.
 */
export async function dailyBatchBoundary(): Promise<string> {
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    const r = await db.query<{ now: string }>(`SELECT now()::text AS now`)
    return r.rows[0].now
  } finally {
    await db.end()
  }
}

/**
 * EVERY daily-batch manual journal that posted this run — A1, A2 and Group B AND the three
 * reconciliation sweeps (inventory / COGS / transit). Scoped to `createdAfter` so it names
 * only this run's documents. This is the teardown safety net (Codex r3/r4).
 *
 * The batch does not post only the three tie-out journals: with a rounding-difference account
 * configured, a sub-penny subledger-vs-GL gap makes a reconciliation sweep queue its own
 * manual journal, which the same queue drain then posts. A test that registered only A1/A2/B
 * would strand any such sweep journal in the shared Demo ledger.
 *
 * Two robustness measures the degraded paths need (Codex r4):
 *   - SETTLE before snapshotting. processPendingXeroSyncViaUi waits on a DOM signal, not a
 *     server-side fence, so a UI timeout can return while the drain is still posting. A
 *     one-shot read would miss a journal completing just after it. So poll until no
 *     post-boundary DailyBatch row is still PENDING/PROCESSING (or a bounded deadline). On the
 *     happy path everything is already terminal, so this returns immediately.
 *   - Take any row that carries an externalTransactionId REGARDLESS of status: a POST that
 *     Xero accepted but whose status write-back lagged (or later FAILED) still recorded the
 *     id, and that document is real and must be voided.
 * Transient failures — of the CONNECTION as well as the reads — are retried rather than
 * collapsed to empty (Codex r5). It stays best-effort (never throws, because teardown must
 * run even if this cannot), but when it CANNOT resolve — no connection, reads still failing,
 * or the settle deadline expiring with rows still in flight — it WARNS loudly with the
 * boundary rather than returning a silent empty, so a possibly-stranded journal is surfaced
 * in the run log (matching the suite's `[xero-teardown]` warning convention) and returns
 * whatever ids it did read (a partial set beats nothing).
 *
 * The ONE window it cannot close is a crash BETWEEN Xero accepting the POST and the id being
 * written to the sync log, and the related case of an id landing AFTER the settle deadline: no
 * id is readable to register, and recovering it would need production idempotency-key replay
 * or a run-id-tagged Xero rescan in global teardown. That is a suite-wide gap inherent to
 * every doc-posting spec here (OC/PP included), tracked as follow-up o3d-lgo.7.1, not specific
 * to X-01.
 */
export async function postedDailyBatchJournalIds(
  createdAfter: string,
  opts: { settleTimeoutMs?: number } = {},
): Promise<Array<{ type: string; referenceId: string; externalId: string }>> {
  const warn = (why: string) =>
    console.warn(`[x01-teardown] ${why} for daily-batch journals created after ${createdAfter} — a posted journal may be left in the shared ledger; check DAILY_BATCH sync logs.`)

  const db = new Client({ connectionString: process.env.DATABASE_URL })
  let connected = false
  for (let attempt = 0; attempt < 3 && !connected; attempt++) {
    try {
      await db.connect()
      connected = true
    } catch {
      await new Promise((res) => setTimeout(res, 1_000))
    }
  }
  if (!connected) {
    warn('could not connect to the database')
    return []
  }

  try {
    const deadline = Date.now() + (opts.settleTimeoutMs ?? 30_000)
    // Settle: wait out any in-flight post-boundary daily-batch work so the snapshot does not
    // race a journal the server is still posting.
    let settled = false
    for (;;) {
      let inFlight = -1
      try {
        const r = await db.query<{ n: number }>(
          `select count(*)::int as n from accounting_sync_logs
            where connector = 'xero' and "referenceType" = 'DailyBatch'
              and "createdAt" > $1::timestamptz and status in ('PENDING', 'PROCESSING')`,
          [createdAfter],
        )
        inFlight = r.rows[0]?.n ?? 0
      } catch {
        // transient — fall through to the deadline check and retry
      }
      if (inFlight === 0) {
        settled = true
        break
      }
      if (Date.now() >= deadline) break
      await new Promise((res) => setTimeout(res, 2_000))
    }
    if (!settled) warn('the drain did not settle within the deadline (rows still in flight)')

    // Snapshot every post-boundary daily-batch document that carries a Xero id, retrying a
    // transient read a few times before giving up.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await db.query<{ type: string; referenceId: string; externalTransactionId: string }>(
          `select type, "referenceId", "externalTransactionId"
             from accounting_sync_logs
            where connector = 'xero'
              and "referenceType" = 'DailyBatch'
              and "createdAt" > $1::timestamptz
              and "externalTransactionId" is not null`,
          [createdAfter],
        )
        return r.rows.map((row) => ({ type: row.type, referenceId: row.referenceId, externalId: row.externalTransactionId }))
      } catch {
        await new Promise((res) => setTimeout(res, 1_000))
      }
    }
    warn('could not read the posted journals')
    return []
  } finally {
    await db.end().catch(() => {})
  }
}

/**
 * The daily-batch journals are keyed by a DIGEST-SUFFIXED referenceId
 * (buildDailyBatchReferenceId -> `<group>-<date>-<8 hex>`), computed from the exact set of
 * order/shipment ids in the run — so a test cannot know it up front the way it knows a
 * sales order id. This resolves the journal by TYPE instead, and scopes it to THIS run with
 * a `createdAfter` boundary.
 *
 * The boundary is not optional cleanliness — it is correctness (Codex r3). Without it the
 * helper returns the newest log of the type across ALL history, so if the current batch
 * failed to create one of its three logs it would silently hand back a PRIOR run's SYNCED
 * journal (same amounts, same accounts → the ledger assertions pass) and teardown would
 * then void the OLD document instead of this run's. Requiring createdAt > boundary makes a
 * missing journal a loud timeout, not a false pass.
 *
 * Fails loudly on a FAILED log or a timeout rather than returning null — a missing journal
 * means the batch did not post, and a test asserting "no journal" would be a false pass.
 */
export async function dailyBatchDoc(
  type: 'DAILY_BATCH_REVENUE_DEFERRAL' | 'DAILY_BATCH_INVENTORY_ALLOC' | 'DAILY_BATCH_GROUP_B',
  opts: { createdAfter: string; timeoutMs?: number },
): Promise<{ referenceId: string; externalId: string }> {
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
        [type, opts.createdAfter],
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
      `No SYNCED ${type} journal created after ${opts.createdAfter} with an externalTransactionId within the timeout` +
        (last ? ` (last seen: status=${last.status}${last.error ? `, error=${last.error}` : ''})` : ' (no daily-batch log for this run — did the batch queue it?)'),
    )
  } finally {
    await db.end()
  }
}

/**
 * The Xero document kind a sync type produces, for teardown registration — or null when the type posts no
 * standalone voidable document.
 *
 * Explicit rather than defaulting to ManualJournals: registering a Xero id under the WRONG kind means
 * teardown issues a void against the wrong endpoint and the real document survives, which is precisely the
 * silent-leak failure this mapping exists to prevent. An unmapped type therefore WARNS instead of guessing.
 * Attachment/PDF/email/note/tax-rate types are deliberately null — they mutate or attach to a document
 * someone else already registered, so there is nothing separate to void.
 */
export function xeroDocKindForSyncType(type: string): XeroDocKind | null {
  switch (type) {
    case 'SALES_INVOICE':
    case 'SALES_INVOICE_UPDATE':
    case 'PURCHASE_INVOICE':
    case 'PURCHASE_INVOICE_UPDATE':
      return 'Invoices'
    case 'CREDIT_NOTE':
    case 'PURCHASE_CREDIT_NOTE':
      return 'CreditNotes'
    case 'INVOICE_PAYMENT':
    case 'BILL_PAYMENT':
      return 'Payments'
    case 'COGS_JOURNAL':
    case 'COGS_REVERSAL':
    case 'INVENTORY_ADJUSTMENT':
    case 'STOCK_IN_TRANSIT':
    case 'STOCK_RECEIPT':
    case 'STOCK_ALLOCATION':
    case 'UNEARNED_REV_REVERSAL':
    case 'REALISED_FX_JOURNAL':
    case 'UNREALISED_FX_JOURNAL':
    case 'MANUFACTURING_JOURNAL':
    case 'MANUFACTURING_RECLASS':
    case 'DAILY_BATCH_REVENUE_DEFERRAL':
    case 'DAILY_BATCH_INVENTORY_ALLOC':
    case 'DAILY_BATCH_GROUP_B':
    case 'DAILY_BATCH_INVENTORY_RECONCILIATION':
    case 'DAILY_BATCH_COGS_RECONCILIATION':
    case 'DAILY_BATCH_TRANSIT_RECONCILIATION':
      return 'ManualJournals'
    // Ride on a document registered elsewhere (or write nothing voidable): nothing separate to void.
    case 'BILL_ATTACHMENT':
    case 'INVOICE_PDF':
    case 'INVOICE_EMAIL':
    case 'WC_INVOICE_NOTE':
    case 'PURCHASE_CREDIT_NOTE_ALLOCATION':
    case 'TAX_RATE_SYNC':
      return null
    default:
      console.warn(`[batch-baseline] no Xero document kind mapped for sync type ${type} — cannot register it for teardown; add it to xeroDocKindForSyncType.`)
      return null
  }
}

/**
 * Register every already-posted document the baseline retired, so teardown VOIDS it out of the shared Demo
 * ledger instead of leaving it live and invisible (o3d-lgo.16). Safe to call unconditionally — the common
 * case is an empty list, and trackDocument dedupes.
 */
export function registerRetiredPostedDocuments(baseline: BatchBaselineResult, label: string): void {
  for (const doc of baseline.retiredPostedDocuments) {
    const kind = xeroDocKindForSyncType(doc.type)
    if (kind) trackDocument(kind, doc.externalId, `${label} retired-but-posted ${doc.type}`)
  }
}
