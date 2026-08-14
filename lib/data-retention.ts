import type { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { WC_WEBHOOK_EVENT_STATUS } from '@/lib/connectors/shopping-webhook-inbox'
import { FOLLOW_UP_IDEMPOTENCY_KEY, MONEY_MOVING_FOLLOW_UP_TYPES } from '@/lib/domain/accounting/followup-idempotency'

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
 * Payload keys a tombstone ALSO keeps: non-PII settlement FACTS that a page still reads back off an
 * already-terminal row to decide what to tell an operator (Codex NO-SHIP finding 3).
 *
 * The defect this closes: INVOICE_PAYMENT and BILL_PAYMENT rows are ordinary compaction candidates,
 * and `payload.amount` is the ONLY thing that distinguishes a part payment (or an over-payment) from
 * a full settlement. settlementStatus compares it against the document total and can only do so while
 * it is numeric; with it gone, a SYNCED row carrying an external id falls straight through to
 * SETTLED. A known GBP1-against-GBP1,000 part payment — the exact case o3d-lgo.15 exists to surface —
 * would turn into a green "Settled" badge six months later, over a balance the ledger still shows
 * outstanding. `paymentId` is what attributes the row to a local receipt: effectivePaymentSyncRows
 * drops rows whose receipt was deleted by matching on it, and deletePayment finds the registration to
 * retire the same way, so losing it silently changes receipt history and payment deletion too.
 *
 * PRESERVING BEATS AN "UNVERIFIABLE" STATE. Both are a number and a local cuid — not a customer name,
 * an address or a line description — which is precisely the distinction this whole change is drawn
 * on. Keeping them costs nothing the retention promise covers, while the alternative (teaching every
 * settlement reader a fourth "we used to know" verdict) spreads retention's fingerprints across the
 * accounting UI.
 *
 * Each key is kept ONLY IN THE SHAPE ITS READER TESTS FOR (see paymentSyncPayloadFacts): a
 * non-numeric amount reads as "cannot compare" rather than as a shortfall, so carrying one forward in
 * the wrong type would be worse than dropping it — it would look present.
 *
 * Kept for EVERY type rather than only the payment types: they are the same keys wherever they occur,
 * a number and an id are non-PII on any row, and a type-conditional payload rule is one more thing to
 * get wrong when a new payment-shaped sync type is added.
 */
const RETAINED_PAYLOAD_FACT_KEYS: readonly { key: string; kind: 'string' | 'number' }[] = [
  { key: 'amount', kind: 'number' },
  { key: 'paymentId', kind: 'string' },
]

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
 * Sync types whose MERE EXISTENCE — at ANY status, CANCELLED included — is consumed as evidence by
 * another sweep. Such a row is not a log entry, it is a durable DO-NOT-RE-ENQUEUE marker, and deleting
 * it re-arms the very thing it was suppressing (Codex NO-SHIP finding 4).
 *
 * PURCHASE_CREDIT_NOTE_ALLOCATION. reenqueueMissingCreditNoteAllocations (audit-w77e) sweeps POSTED
 * supplier credit notes and skips any that already has an allocation row — its query filters connector
 * and type but NOT status, deliberately, because the question it asks is "does anyone already own
 * this?". cancelOrphanedAccountingSyncRows cancels every PENDING row of a non-active connector, and a
 * pending allocation inherently has no externalTransactionId, so a cancelled allocation lands exactly
 * in the delete branch below. Delete it and the sweep sees a never-enqueued gap, re-creates the
 * allocation somebody intentionally abandoned, and Xero applies a real AP allocation months late.
 * Pre-migration rows reach this on the FIRST run through the createdAt fallback.
 *
 * This is the general refutation of the delete branch's original justification. That justification —
 * "the delete guard matches a CANCELLED row only via a non-null external id, so one without it is
 * invisible" — is true of order-delete-guard.ts and FALSE of the codebase: the guard is not the only
 * reader of a sync row's existence. So the branch now carries an explicit type carve-out rather than
 * an argument about one consumer.
 *
 * AUDITED, NOT GUESSED. Every accountingSyncLog findFirst/findMany/findUnique/count/groupBy in app/,
 * lib/, scripts/ and prisma/ was checked for an existence test with no status clause (there is no raw
 * SQL against the table anywhere). The full result is in the o3d-nepa PR notes; the only OTHER
 * production hit is lib/ops/health.ts getLatestAccountingBatch, which reads the single most recent
 * DAILY_BATCH_* row to report health. That one is not listed here: it consumes RECENCY, not existence,
 * and retention only ever reaches rows that resolved a full retention window ago — for it to matter,
 * the newest batch in the system would have to be older than the cutoff, in which case dropping from
 * "CANCELLED months ago" to "no batch sync log found" makes the health check MORE alarming, not less.
 *
 * These types are TOMBSTONED instead of deleted: the row survives as the marker, the payload does not.
 */
const EXISTENCE_EVIDENCE_SYNC_TYPES = ['PURCHASE_CREDIT_NOTE_ALLOCATION'] as const

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
 *  - the DELETE branch is restricted to CANCELLED rows with no externalTransactionId AND no type
 *    whose bare existence another sweep consumes (EXISTENCE_EVIDENCE_SYNC_TYPES). What is left is
 *    invisible to lib/domain/sales/order-delete-guard.ts (it matches a CANCELLED row only via
 *    `externalTransactionId IS NOT NULL`) and to every other existence test in the codebase, so
 *    deleting one removes no evidence anything reads. The earlier version of this argument rested on
 *    the delete guard ALONE and was wrong in general — see EXISTENCE_EVIDENCE_SYNC_TYPES.
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
 * Reduce a payload to its remote idempotency TOKENS plus the non-PII settlement FACTS its readers
 * still need, dropping every other key. Returns null when there is nothing to write (the payload is
 * not an object), so the caller leaves it untouched.
 */
export function compactAccountingSyncPayload(payload: unknown): Record<string, string | number> | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  const source = payload as Record<string, unknown>
  const kept: Record<string, string | number> = {}
  for (const key of RETAINED_PAYLOAD_TOKEN_KEYS) {
    const value = source[key]
    // Strings only, matching readFollowUpIdempotencyKey: a non-string is not a usable remote token,
    // and carrying one forward would preserve something that is not what this exemption is for.
    if (typeof value === 'string') kept[key] = value
  }
  for (const { key, kind } of RETAINED_PAYLOAD_FACT_KEYS) {
    const value = source[key]
    // Only in the shape the reader tests for — see RETAINED_PAYLOAD_FACT_KEYS.
    if (typeof value === kind) kept[key] = value as string | number
  }
  return kept
}

/**
 * The ONE row shape retention may DELETE outright, minus the expiry clause (which both branches add
 * for themselves).
 *
 * A FUNCTION rather than a constant, and used in BOTH places, because the compact branch has to
 * exclude exactly what this includes: two hand-written copies of the predicate would drift and the
 * three cases would quietly stop being disjoint — a row could be compacted AND deleted in the same
 * run, or fall through both and never expire at all.
 */
function accountingDeletableShape(): Prisma.AccountingSyncLogWhereInput {
  return {
    status: 'CANCELLED',
    externalTransactionId: null,
    // Codex NO-SHIP finding 4 — see EXISTENCE_EVIDENCE_SYNC_TYPES. A cancelled row of one of these
    // types is a durable marker another sweep reads; it gets a tombstone, not a delete.
    type: { notIn: [...EXISTENCE_EVIDENCE_SYNC_TYPES] },
  }
}

/**
 * Everything that makes a row a COMPACTION candidate. Used twice on purpose: once to select the
 * batch, and again — unchanged, plus the row id — as the WHERE of each conditional write, so the
 * write re-checks at commit time every condition that made the row eligible when it was read (see the
 * loop in purgeExpiredData for why that matters).
 */
function accountingCompactCandidateWhere(cutoff: Date): Prisma.AccountingSyncLogWhereInput {
  return {
    status: { in: [...ACCOUNTING_TERMINAL_STATUSES] },
    compactedAt: null,
    // Payloads a FUTURE posting decision still reads off a SYNCED row — see the constant.
    type: { notIn: [...PAYLOAD_LOAD_BEARING_SYNC_TYPES] },
    AND: [
      // Explicitly disjoint from the delete branch, so the three cases stay provably non-overlapping
      // no matter what order they run in.
      { NOT: accountingDeletableShape() },
      // Codex NO-SHIP finding 2 — A FAILED MONEY-MOVING FOLLOW-UP KEEPS ITS REQUEST BODY.
      //
      // FAILED is not "finished", it is "waiting for someone to press retry", and three paths revive
      // one WITHOUT rebuilding its payload: retryFailedXeroSync / retryFailedQuickBooksSync (any
      // FAILED row on the connector, no age or type bound), resetFailedDailyBatchLogs, and
      // planFollowUpEnqueue's reuse path.
      //
      // The planner is the sharp edge. A compacted INVOICE_PAYMENT tombstone has no anchors, so
      // couldHaveCommittedThis reads it as "possibly this one" (correctly — unknown must mean
      // possible where money is concerned); bodyCouldHaveReachedTheLedger then finds the body
      // incomplete and drops it from `postable`; and the fallback pins that same token-only object as
      // the request body. Both connectors reject a body with no accountingInvoiceId / bankAccountId /
      // amount before they post, so the payment can never go out and never recovers — retention would
      // have MANUFACTURED the "incomplete oldest attempt" case the planner was built to survive.
      //
      // THE TYPE SET IS MONEY_MOVING_FOLLOW_UP_TYPES, imported from followup-idempotency.ts rather
      // than restated: it is the same set that decides `bodyDisposition: 'pinned'`, and the same set
      // REQUIRED_BODY_FIELDS is keyed on. Those are the follow-ups whose stored body is REUSED
      // verbatim; every other follow-up type is re-driven with a freshly recomputed body
      // (`bodyDisposition: 'fresh'`), so losing the stored one costs nothing. The blunt retry actions
      // cover every remaining type, and they are handled at their own end — they now refuse to revive
      // a row whose body retention has already removed.
      //
      // The retention window is not lost, only paused: such a row is compacted as soon as it stops
      // being FAILED (retried through to SYNCED, or cancelled), which is the same rule case 1 applies
      // to PENDING/PROCESSING — an unresolved row has no expiry.
      { NOT: { status: 'FAILED', type: { in: [...MONEY_MOVING_FOLLOW_UP_TYPES] } } },
    ],
    ...accountingRowExpiredWhere(cutoff),
  }
}

/**
 * Purge or archive expired data based on retention settings.
 * - Storefront sync logs & stock movements: hard-deleted
 * - Accounting sync logs (o3d-nepa): three disjoint cases, all keyed on resolvedAt, never createdAt —
 *     NEVER TOUCHED  anything not terminal (PENDING/PROCESSING) at any age, the three types a later
 *                    posting decision reads back, and a FAILED money-moving follow-up, whose stored
 *                    request body is reused verbatim if anyone retries it;
 *     DELETED        CANCELLED, no externalTransactionId, and not a type whose bare existence another
 *                    sweep consumes as a do-not-re-enqueue marker;
 *     TOMBSTONED     every other expired terminal row — COMPACTED in place to the fields the delete
 *                    guard reads, its idempotency tokens and its non-PII settlement facts
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
      // which o3d-sref establishes may have posted without recording an id. The proof is narrower:
      // order-delete-guard matches a CANCELLED row ONLY via `externalTransactionId IS NOT NULL`, so
      // such a row is invisible to it.
      //
      // ...but the delete guard is NOT the only reader of a sync row's existence, which is what an
      // earlier revision of this comment assumed (Codex NO-SHIP finding 4). A whole TYPE can be a
      // durable do-not-re-enqueue marker whose bare presence another sweep consumes; those are carved
      // out by accountingDeletableShape and tombstoned instead. See EXISTENCE_EVIDENCE_SYNC_TYPES for
      // the carve-out and for the audit behind it.
      //
      // An earlier revision instead exempted PROCESSING rows from the age delete. That was REVERTED
      // for three reasons, all fixed by the three-case rule: it only DEFERRED the loss (expiry still
      // keyed on createdAt, so the row died the moment it terminalised); it retained whole payloads
      // holding customer names, emails and financial lines while the settings UI promised permanent
      // deletion; and it was the wrong shape, since the guard needs a handful of fields, not a row.
      db.accountingSyncLog.deleteMany({
        where: { ...accountingDeletableShape(), ...expired },
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
    const compactWhere = accountingCompactCandidateWhere(cutoff)
    const compactCandidates = await db.accountingSyncLog.findMany({
      where: compactWhere,
      select: { id: true, payload: true, errorMessage: true },
      orderBy: { createdAt: 'asc' },
      take: ACCOUNTING_COMPACT_MAX_PER_RUN,
    })

    const compactedAt = new Date()
    for (const row of compactCandidates) {
      const payload = compactAccountingSyncPayload(row.payload)
      // A CONDITIONAL write, never an id-fenced update (Codex NO-SHIP finding 1).
      //
      // Candidates are SELECTED in one statement and written one at a time afterwards, and a row can
      // be REVIVED in the gap: retryFailedXeroSync / retryFailedQuickBooksSync flip any FAILED row to
      // PENDING and clear resolvedAt, resetFailedDailyBatchLogs does the same for a batch, and the
      // follow-up revival path restores a live row for the same scope. Fenced only by id, this write
      // would then overwrite a LIVE row's restored request body with the tombstone computed from the
      // pre-revival read AND stamp compactedAt on it — handing the processor work whose payload we
      // had just destroyed. Nothing about the shape of the write makes that visible afterwards: the
      // row looks exactly like a legitimately compacted one.
      //
      // Re-checking the WHOLE candidate predicate (the identical object, unmodified) closes the
      // window at commit time: compactedAt still null, status still terminal, type still outside both
      // exclusion sets, still disjoint from the delete branch — and still EXPIRED, which is the
      // condition that catches a row revived and re-resolved in between, because de-terminalising
      // CLEARS resolvedAt and the next terminal transition stamps a fresh one that is nowhere near
      // the cutoff.
      //
      // Counted from `count` rather than incremented per iteration: a row the predicate no longer
      // matches is left completely alone, and must not be reported as compacted.
      const { count } = await db.accountingSyncLog.updateMany({
        where: { id: row.id, ...compactWhere },
        data: {
          // Left untouched when it is not an object — writing over a NULL payload would gain nothing
          // and needs Prisma's DbNull sentinel to express.
          ...(payload === null ? {} : { payload }),
          // A row that never carried an error keeps its clean null; only a real message is replaced.
          errorMessage: row.errorMessage === null ? null : COMPACTED_ERROR_MESSAGE,
          compactedAt,
        },
      })
      accountingSyncLogsCompacted += count
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
