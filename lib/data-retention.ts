import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { WC_WEBHOOK_EVENT_STATUS } from '@/lib/connectors/shopping-webhook-inbox'
import { FOLLOW_UP_IDEMPOTENCY_KEY } from '@/lib/domain/accounting/followup-idempotency'

const RETENTION_KEYS = [
  'retention_sales_orders_months',
  'retention_purchase_orders_months',
  'retention_customers_months',
  'retention_stock_movements_months',
  'retention_sync_logs_months',
  'retention_webhook_events_months',
] as const

const DEFAULTS: Record<string, number> = {
  retention_sales_orders_months: 0,
  retention_purchase_orders_months: 0,
  retention_customers_months: 0,
  retention_stock_movements_months: 0,
  retention_sync_logs_months: 6,
  // o3d-ahk: COMPACT succeeded shopping-webhook-inbox rows after N months — clear the bulky payloadJson
  // to reclaim storage while KEEPING the (connector, resource, payloadHash) row as an idempotency
  // tombstone (deleting it would let a redelivered/replayed old payload reprocess). Default 3 months.
  // Only PROCESSED rows are compacted; DEAD_LETTER (failed, unresolved) and PENDING/FAILED (undelivered)
  // are left fully intact for investigation/replay.
  retention_webhook_events_months: 3,
}

async function getRetentionSettings(): Promise<Record<string, number>> {
  const rows = await db.setting.findMany({
    where: { key: { in: [...RETENTION_KEYS] } },
  })
  const result: Record<string, number> = {}
  for (const key of RETENTION_KEYS) {
    const row = rows.find((r) => r.key === key)
    const parsed = row ? Number.parseInt(row.value, 10) : DEFAULTS[key]
    result[key] = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULTS[key]
  }
  return result
}

function monthsAgo(months: number): Date {
  const d = new Date()
  d.setMonth(d.getMonth() - months)
  return d
}

// ---------------------------------------------------------------------------
// o3d-nepa: accounting sync log retention
// ---------------------------------------------------------------------------

/** Statuses a row can no longer leave on its own. Everything else is live work. */
const ACCOUNTING_TERMINAL_STATUSES = ['SYNCED', 'FAILED', 'CANCELLED'] as const

/**
 * The generic queue's remote idempotency token (queueAccountingSync / queueAccountingSyncTx). Both
 * connectors derive the key they send to the remote system from it — QuickBooks via
 * getIdempotencySource, Xero via its own builder — so DROPPING IT ROTATES THE TOKEN of any replay,
 * which is how the same payment posts twice. It is a token, not data: it identifies the request, it
 * does not describe a customer or an amount.
 *
 * The partial unique index that keys on it (20260424214500) covers PENDING/PROCESSING/SYNCED only,
 * so a compacted terminal row is outside it — the token is kept for the FOLLOW-UP PLANNER, not for
 * the index.
 */
const GENERIC_IDEMPOTENCY_KEY = '_idempotencyKey'

/**
 * The ONLY payload keys a tombstone keeps. Both are remote idempotency tokens; every other key is
 * request data (customer names, emails, addresses, journal lines, amounts) and is what the settings
 * UI's retention promise is actually about.
 *
 * `_followUpIdempotencyKey` is load-bearing in the strongest sense (o3d-h2wx): both sync processors
 * select FAILED rows and read it via readFollowUpIdempotencyKey. A FAILED row whose payload was
 * nulled wholesale reads as "no token", so planFollowUpEnqueue sees a token it cannot reconcile —
 * for an INVOICE_PAYMENT that either rotates the remote key (duplicate payment) or flips the plan to
 * `refuse` (a settlement stranded until someone reconciles it by hand). Money either way, which is
 * why compaction REDUCES the payload rather than clearing it.
 */
const RETAINED_PAYLOAD_TOKEN_KEYS: readonly string[] = [GENERIC_IDEMPOTENCY_KEY, FOLLOW_UP_IDEMPOTENCY_KEY]

/**
 * Sync types whose payload stays INTACT forever, because a LATER POSTING DECISION reads it back off
 * an already-terminal (SYNCED) row. Compacting one does not lose an audit detail, it changes what
 * the next journal posts:
 *
 *  - UNREALISED_FX_JOURNAL — lib/accounting-fx-revaluation.ts reads prior revaluations across
 *    PENDING/PROCESSING/*SYNCED* (its ACTIVE_SYNC_STATUSES) to decide which to REVERSE before
 *    reposting. A payload that no longer parses is silently skipped, so the prior revaluation is
 *    never reversed and the revaluation is posted TWICE.
 *  - UNEARNED_REV_REVERSAL — refund-service's double-reversal guard (priorUnearnedReversed) and the
 *    Group-B deferred true-up (sumPostedUnearnedReversal, scjz.68) both sum `payload.lines` off
 *    PENDING/PROCESSING/SYNCED rows. Losing the lines reads as "nothing was reversed yet" and
 *    re-reverses deferred revenue that a credit note already took out.
 *  - COGS_REVERSAL — same guard, plus the structured 6dp `_cogsReversalBase` refund-service prefers.
 *
 * NOTE: this contradicts the o3d-nepa spec, which placed the FX hazard under "not terminal". It is
 * not confined to live rows — ACTIVE_SYNC_STATUSES includes SYNCED. These payloads are journal lines
 * (account codes and amounts), not personal data, so retaining them is a narrow, defensible cost.
 */
const PAYLOAD_LOAD_BEARING_SYNC_TYPES = ['UNREALISED_FX_JOURNAL', 'UNEARNED_REV_REVERSAL', 'COGS_REVERSAL'] as const

/**
 * Replaces errorMessage on a compacted row. NOT simply nulled: rejected-sync-warnings.ts surfaces
 * errorMessage for FAILED *_INVOICE_UPDATE rows on the order/PO pages with no age bound, and its
 * safeErrorMessage fallback ("The accounting connector rejected this invoice update.") would assert
 * a cause we no longer know. A marker keeps the warning honest — the rejection still happened, the
 * detail is gone on purpose — and carries no PII, since connector error text routinely quotes
 * contact names and document references back at us.
 */
const COMPACTED_ERROR_MESSAGE = 'Detail removed by data retention (o3d-nepa).'

/**
 * Cap per run so the FIRST run after deploy — which faces every already-expired row at once — cannot
 * turn the nightly cron into an unbounded write storm. Compaction is per-row by necessity (each row
 * keeps its OWN tokens), so this is a real loop, not one statement. Anything left over is simply
 * compacted by the next night's run; retaining a payload one day longer is the safe direction.
 */
const ACCOUNTING_COMPACT_MAX_PER_RUN = 5000

/**
 * "Expired" for an accounting sync row: keyed on resolvedAt — WHEN THE ROW RESOLVED — never on
 * createdAt.
 *
 * PRE-MIGRATION ROWS (resolvedAt IS NULL) fall back to createdAt. NULL cannot mean "expired long
 * ago" (the first run would eat the entire history) and it cannot mean "never expires" (nothing
 * would ever be cleaned), so the fallback is the only third option — and it is sound ONLY because
 * of what the two branches it feeds can actually do:
 *
 *  - the DELETE branch is restricted to CANCELLED rows with no externalTransactionId, which
 *    lib/domain/sales/order-delete-guard.ts cannot see at all (it matches a CANCELLED row only via
 *    `externalTransactionId IS NOT NULL`). Deleting one removes no evidence any guard reads.
 *  - the COMPACT branch keeps every field the guard reads, so an over-eager fallback costs payload
 *    detail on an old row, never the row itself.
 *
 * It is also a LOWER bound: resolvedAt >= createdAt always, so the fallback can only expire a
 * pre-migration row EARLIER than the truth, never later — and only rows that were ALREADY terminal
 * when the column shipped can reach it, because every terminal transition now stamps resolvedAt in
 * the same write. Live rows never reach this predicate at all; they are excluded by status first.
 */
function accountingRowExpiredWhere(cutoff: Date) {
  return {
    OR: [
      { resolvedAt: { lt: cutoff } },
      { resolvedAt: null, createdAt: { lt: cutoff } },
    ],
  }
}

/**
 * Reduce a payload to its remote idempotency tokens, dropping every other key. Returns null when
 * there is nothing to write (the payload is not an object), so the caller leaves it untouched.
 */
export function compactAccountingSyncPayload(payload: unknown): Record<string, string> | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  const source = payload as Record<string, unknown>
  const kept: Record<string, string> = {}
  for (const key of RETAINED_PAYLOAD_TOKEN_KEYS) {
    const value = source[key]
    // Strings only, matching readFollowUpIdempotencyKey: a non-string is not a usable remote token,
    // and carrying one forward would preserve something that is not what this exemption is for.
    if (typeof value === 'string') kept[key] = value
  }
  return kept
}

/**
 * Purge or archive expired data based on retention settings.
 * - Storefront sync logs & stock movements: hard-deleted
 * - Accounting sync logs (o3d-nepa): three disjoint cases, all keyed on resolvedAt, never createdAt —
 *   unresolved rows are NEVER touched at any age; CANCELLED-with-no-external-id is deleted; every
 *   other expired terminal row is COMPACTED to a posting tombstone the delete guard can still read
 * - Shopping webhook inbox: processed rows compacted to a dedup tombstone (o3d-ahk)
 * - Sales orders, purchase orders, customers: soft-archived (archived = true)
 * Call on a daily schedule via /api/cron/activity-cleanup.
 */
export async function purgeExpiredData(): Promise<{
  /** Storefront (shopping) sync logs — still a plain hard delete. */
  shoppingSyncLogsDeleted: number
  /** Accounting sync rows PROVEN to have had no remote effect, hard-deleted (o3d-nepa). */
  accountingSyncLogsDeleted: number
  /** Accounting sync rows reduced to a posting tombstone, NOT deleted (o3d-nepa). */
  accountingSyncLogsCompacted: number
  stockMovementsDeleted: number
  webhookEventsCompacted: number
  salesOrdersArchived: number
  purchaseOrdersArchived: number
  customersArchived: number
}> {
  const settings = await getRetentionSettings()
  let shoppingSyncLogsDeleted = 0
  let accountingSyncLogsDeleted = 0
  let accountingSyncLogsCompacted = 0
  let stockMovementsDeleted = 0
  let webhookEventsCompacted = 0
  let salesOrdersArchived = 0
  let purchaseOrdersArchived = 0
  let customersArchived = 0

  // Sync logs — storefront rows hard-deleted; accounting rows deleted ONLY when provably inert,
  // otherwise compacted to a tombstone (o3d-nepa).
  const syncMonths = settings.retention_sync_logs_months
  if (syncMonths > 0) {
    const cutoff = monthsAgo(syncMonths)
    const expired = accountingRowExpiredWhere(cutoff)
    const [wc, acct] = await Promise.all([
      db.shoppingSyncLog.deleteMany({
        where: {
          createdAt: { lt: cutoff },
          // o3d-w00 / o3d-iup / o3d-7yf: never retention-delete an UNRESOLVED WooCommerce refund park
          // (PENDING/FAILED amount-mismatch or QUARANTINED monetary-only). Each is a refund whose money
          // already left the business but has no SalesOrderRefund / credit note yet; deleting it erases the
          // only record of an unaccounted refund and defeats the deletion/rebind guards that rely on it.
          // It must persist until an operator resolves it (which flips it to SYNCED, after which it expires
          // normally). Now that upsertRefundPark dedups parks to one row per refund, excluding PENDING/
          // FAILED no longer risks the unbounded growth that scoped this to QUARANTINED before. entityId:
          // not null also skips the entity-less missing-FX queue rows.
          NOT: {
            connector: 'woocommerce',
            direction: 'FROM_CONNECTOR',
            entityType: 'SalesOrder',
            status: { in: ['PENDING', 'FAILED', 'QUARANTINED'] },
            entityId: { not: null },
          },
        },
      }),
      // o3d-nepa CASE 2 of 3 — DELETE, and ONLY here.
      //
      // This branch used to delete accounting rows by AGE ALONE, with no status, connector or
      // external-id condition, on a clock (createdAt) that terminalisation never refreshes. So a row
      // that was still UNRESOLVED, or that had terminalised seconds earlier, was destroyed by the
      // very next cleanup — and with it the order delete guard's only evidence that a document may
      // exist in the ledger (o3d-ju8t: FAILED does not prove nothing posted; o3d-sref: a stale
      // PROCESSING claim may have posted without ever writing an external id; o3d-0g2n: QuickBooks'
      // updateBackReference swallows its failure with no repair sweep, so on that connector the sync
      // row is sometimes the ONLY record that an invoice exists).
      //
      // What survives as a delete is the one shape proven to have had NO REMOTE EFFECT: CANCELLED
      // with no externalTransactionId. Note the proof is not "the cancel paths refuse rows carrying
      // an external id" — cancelPendingSalesInvoiceSyncForOrder also retires STALE PROCESSING rows,
      // which o3d-sref establishes may have posted without recording an id. The proof is narrower and
      // stronger: order-delete-guard matches a CANCELLED row ONLY via `externalTransactionId IS NOT
      // NULL`, so a CANCELLED row without one is already invisible to every guard. Deleting it
      // removes nothing that is read.
      //
      // An earlier revision instead exempted PROCESSING rows from the age delete. That was REVERTED
      // for three reasons, all fixed by the three-case rule: it only DEFERRED the loss (expiry still
      // keyed on createdAt, so the row died the moment it terminalised); it retained whole payloads
      // holding customer names, emails and financial lines while the settings UI promised permanent
      // deletion; and it was the wrong shape, since the guard needs a handful of fields, not a row.
      db.accountingSyncLog.deleteMany({
        where: {
          status: 'CANCELLED',
          externalTransactionId: null,
          ...expired,
        },
      }),
    ])
    shoppingSyncLogsDeleted = wc.count
    accountingSyncLogsDeleted = acct.count

    // o3d-nepa CASE 3 of 3 — COMPACT TO A TOMBSTONE. Every OTHER terminal row past the cutoff:
    // SYNCED, FAILED, and CANCELLED-carrying-an-external-id. The row STAYS, keeping exactly what
    // order-delete-guard.ts reads — connector, type, status, referenceType, referenceId,
    // externalTransactionId, createdAt (and now resolvedAt) — and loses the personal/financial body.
    //
    // (CASE 1 — NEVER TOUCHED — is the absence of a branch: PENDING and PROCESSING rows appear in
    // none of the three queries, at any age. Their payloads are live inputs, not history, and
    // "unresolved" is never safe to forget: o3d-sref's stale claim, the FX revaluation's
    // reverse-before-repost set, refund-service's double-reversal guard and followup-revival all read
    // them. A row that has not resolved has no expiry, full stop.)
    //
    // Compaction is a per-row loop, not one updateMany, because each row keeps its OWN tokens.
    // `compactedAt: null` is the idempotence guard — the same job the `NOT payloadJson = {}`
    // predicate does for the webhook inbox below — so each run only touches newly-eligible rows
    // instead of rewriting the whole retained tombstone set. It is a column rather than a payload
    // marker so the exclusion is a plain indexed predicate (see the partial index in the migration)
    // and so an operator reading a thinned payload can see it was retention that thinned it.
    const compactCandidates = await db.accountingSyncLog.findMany({
      where: {
        status: { in: [...ACCOUNTING_TERMINAL_STATUSES] },
        compactedAt: null,
        // Payloads a FUTURE posting decision still reads off a SYNCED row — see the constant.
        type: { notIn: [...PAYLOAD_LOAD_BEARING_SYNC_TYPES] },
        // Explicitly disjoint from the delete branch above, so the three cases stay provably
        // non-overlapping no matter what order they run in.
        NOT: { status: 'CANCELLED', externalTransactionId: null },
        ...expired,
      },
      select: { id: true, payload: true, errorMessage: true },
      orderBy: { createdAt: 'asc' },
      take: ACCOUNTING_COMPACT_MAX_PER_RUN,
    })

    const compactedAt = new Date()
    for (const row of compactCandidates) {
      const payload = compactAccountingSyncPayload(row.payload)
      await db.accountingSyncLog.update({
        where: { id: row.id },
        data: {
          // Left untouched when it is not an object — writing over a NULL payload would gain nothing
          // and needs Prisma's DbNull sentinel to express.
          ...(payload === null ? {} : { payload }),
          // A row that never carried an error keeps its clean null; only a real message is replaced.
          errorMessage: row.errorMessage === null ? null : COMPACTED_ERROR_MESSAGE,
          compactedAt,
        },
      })
      accountingSyncLogsCompacted++
    }
  }

  // Shopping webhook inbox — COMPACT succeeded rows (o3d-ahk). Clear the bulky payloadJson to reclaim
  // storage but KEEP the row: its (connector, resource, payloadHash) unique key is the inbox's
  // idempotency record, so deleting it would let a redelivered or replayed old payload be accepted as
  // new and reprocessed (re-applying stale addresses/status, re-enqueueing stock). Only PROCESSED rows
  // are compacted; DEAD_LETTER (failed/unresolved — the only record of the failed event) and
  // PENDING/FAILED (undelivered work) are left fully intact. The `payloadJson != {}` predicate
  // PERMANENTLY excludes already-compacted rows, so each daily run only touches the newly-eligible set
  // (a day's worth of rows crossing the cutoff) rather than rewriting the whole retained tombstone set.
  const webhookMonths = settings.retention_webhook_events_months
  if (webhookMonths > 0) {
    const cutoff = monthsAgo(webhookMonths)
    const { count } = await db.shoppingWebhookEvent.updateMany({
      where: {
        status: WC_WEBHOOK_EVENT_STATUS.processed,
        updatedAt: { lt: cutoff },
        NOT: { payloadJson: { equals: {} } },
      },
      data: { payloadJson: {}, lastError: null },
    })
    webhookEventsCompacted = count
  }

  // Stock movements — hard delete (exclude historical import types)
  const movementMonths = settings.retention_stock_movements_months
  if (movementMonths > 0) {
    const cutoff = monthsAgo(movementMonths)
    const movementIds = (await db.stockMovement.findMany({
      where: {
        createdAt: { lt: cutoff },
        NOT: { referenceType: { in: ['WcHistorical', 'WcInitialImport', 'CsvHistorical'] } },
      },
      select: { id: true },
    })).map((row) => row.id)

    if (movementIds.length > 0) {
      await db.cogsEntry.deleteMany({
        where: { movementId: { in: movementIds } },
      })
      await db.costLayer.updateMany({
        where: { adjustmentMovementId: { in: movementIds } },
        data: { adjustmentMovementId: null },
      })
      const { count } = await db.stockMovement.deleteMany({
        where: { id: { in: movementIds } },
      })
      stockMovementsDeleted = count
    }
  }

  // Sales orders — soft archive terminal-status orders
  const soMonths = settings.retention_sales_orders_months
  if (soMonths > 0) {
    const cutoff = monthsAgo(soMonths)
    const { count } = await db.salesOrder.updateMany({
      where: {
        createdAt: { lt: cutoff },
        // Terminal lifecycle, or any refunded order (refund state is now orthogonal).
        OR: [
          { status: { in: ['COMPLETED', 'DELIVERED', 'CANCELLED'] } },
          { refundStatus: { not: 'NONE' } },
        ],
        archived: false,
      },
      data: { archived: true },
    })
    salesOrdersArchived = count
  }

  // Purchase orders — soft archive terminal-status POs
  const poMonths = settings.retention_purchase_orders_months
  if (poMonths > 0) {
    const cutoff = monthsAgo(poMonths)
    const { count } = await db.purchaseOrder.updateMany({
      where: {
        createdAt: { lt: cutoff },
        status: { in: ['RECEIVED', 'CLOSED', 'INVOICED', 'PARTIALLY_RETURNED', 'RETURNED', 'CANCELLED'] },
        archived: false,
      },
      data: { archived: true },
    })
    purchaseOrdersArchived = count
  }

  // Customers — soft archive inactive customers with no unarchived orders
  const custMonths = settings.retention_customers_months
  if (custMonths > 0) {
    const cutoff = monthsAgo(custMonths)
    const { count } = await db.customer.updateMany({
      where: {
        updatedAt: { lt: cutoff },
        archived: false,
        salesOrders: { none: { archived: false } },
      },
      data: { archived: true },
    })
    customersArchived = count
  }

  // Log activity for each type that had changes
  // o3d-nepa: accounting deletions and accounting tombstones are reported SEPARATELY from the
  // storefront deletions they used to be summed into. One "sync logs deleted" figure covering three
  // different fates would tell an operator that rows were destroyed when most were retained, which
  // is the opposite of what the delete guard depends on being able to prove.
  const parts: string[] = []
  if (shoppingSyncLogsDeleted > 0) parts.push(`${shoppingSyncLogsDeleted} storefront sync logs deleted`)
  if (accountingSyncLogsDeleted > 0) parts.push(`${accountingSyncLogsDeleted} accounting sync logs deleted`)
  if (accountingSyncLogsCompacted > 0) parts.push(`${accountingSyncLogsCompacted} accounting sync logs compacted`)
  if (stockMovementsDeleted > 0) parts.push(`${stockMovementsDeleted} stock movements deleted`)
  if (webhookEventsCompacted > 0) parts.push(`${webhookEventsCompacted} webhook events compacted`)
  if (salesOrdersArchived > 0) parts.push(`${salesOrdersArchived} sales orders archived`)
  if (purchaseOrdersArchived > 0) parts.push(`${purchaseOrdersArchived} purchase orders archived`)
  if (customersArchived > 0) parts.push(`${customersArchived} customers archived`)

  if (parts.length > 0) {
    await logActivity({
      entityType: 'SYSTEM',
      action: 'cleanup',
      tag: 'system',
      description: `Data retention cleanup: ${parts.join(', ')}`,
      metadata: { shoppingSyncLogsDeleted, accountingSyncLogsDeleted, accountingSyncLogsCompacted, stockMovementsDeleted, webhookEventsCompacted, salesOrdersArchived, purchaseOrdersArchived, customersArchived },
      resolveUser: false,
    })
  }

  return { shoppingSyncLogsDeleted, accountingSyncLogsDeleted, accountingSyncLogsCompacted, stockMovementsDeleted, webhookEventsCompacted, salesOrdersArchived, purchaseOrdersArchived, customersArchived }
}
