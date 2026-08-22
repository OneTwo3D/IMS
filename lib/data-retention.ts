import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { WC_WEBHOOK_EVENT_STATUS } from '@/lib/connectors/shopping-webhook-inbox'
import { alignmentDryRunEvidenceQuery } from '@/lib/domain/wms/alignment-dry-run'
import {
  UNRESOLVED_BACK_REFERENCE_EVIDENCE_WHERE,
  backReferenceEvidenceTombstone,
} from '@/lib/domain/accounting/back-reference-sweep'
import { followUpObligationsOwedBy } from '@/lib/domain/accounting/compacted-followup-loss'
import { POSTABLE_ACCOUNTING_SYNC_STATUSES } from '@/lib/domain/accounting/postable-sync-statuses'
import { REMOTE_MONEY_EVIDENCE_TYPES } from '@/lib/domain/accounting/remote-money-evidence'
import { UNRESOLVED_ABANDONED_CLAIM_WHERE } from '@/lib/domain/accounting/unresolved-abandoned-claim'
import {
  compactableInboundEventWhere,
  inboundEventCompactionData,
  receiptEventCompactionData,
} from '@/lib/domain/wms/inbound-event-retention'

/**
 * Rows read per page by the back-reference evidence compaction (o3d-bqw7 r2). Small on purpose: the
 * population is the unresolved-posted backlog, not the history, and each page is fully consumed
 * before the next is read.
 */
const BACK_REFERENCE_EVIDENCE_COMPACTION_PAGE_SIZE = 100

/**
 * Hard ceiling on rows this compaction touches in ONE run (o3d-bqw7 r3).
 *
 * It is the only PER-ROW loop in the purge — every sibling compaction below is a single bulk
 * statement whose cost the database bounds for us — and its page loop reads from the head until the
 * predicate is empty. That is fine for the steady state (a day's worth of rows crossing the cutoff)
 * and unbounded for the states that are not steady: the first run after this shipped, a connector
 * reconnected after months of unswept rows, a retention period shortened by an operator. Those cost
 * one statement per row, in a nightly job that holds a connection while it runs.
 *
 * Capping it costs nothing, because the work is RESUMABLE by construction: every compacted row
 * leaves the predicate for good (`backReferenceEvidenceCompactedAt` is no longer null), so the next
 * run continues from where this one stopped rather than repeating it. The bound is on the run, not
 * on the backlog.
 */
const BACK_REFERENCE_EVIDENCE_COMPACTION_MAX_ROWS = 5_000

const RETENTION_KEYS = [
  'retention_sales_orders_months',
  'retention_purchase_orders_months',
  'retention_customers_months',
  'retention_stock_movements_months',
  'retention_sync_logs_months',
  'retention_webhook_events_months',
  'retention_wms_events_months',
  'retention_wms_sync_jobs_months',
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
  // q66in.7.4: COMPACT resolved rows in the two inbound WMS event tables (wms_inbound_receipt_events,
  // wms_webhook_events) after N months. Same 3-month default and the same compact-don't-delete rule
  // as the shopping inbox above: the row is an idempotency tombstone, so only its payload expires,
  // and only once the event has RESOLVED. See lib/domain/wms/inbound-event-retention.ts.
  retention_wms_events_months: 3,
  // q66in.7.4: DELETE finished WMS sync jobs after N months — which cascades their wms_sync_logs
  // lines (the FK is ON DELETE CASCADE), the table the issue named as growing unbounded. Twelve
  // months, deliberately: WmsMutationEvent — the audit-grade mutation timeline — keeps a full year
  // and correlates to a run through its free-string `jobId`, so a shorter window here would leave
  // the timeline pointing at runs that no longer exist. Tune this DOWN only together with
  // WMS_MUTATION_EVENT_RETENTION_DAYS.
  retention_wms_sync_jobs_months: 12,
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

/**
 * Purge or archive expired data based on retention settings.
 * - Sync logs & stock movements: hard-deleted
 * - Sales orders, purchase orders, customers: soft-archived (archived = true)
 * Call on a daily schedule via /api/cron/activity-cleanup.
 */
export async function purgeExpiredData(): Promise<{
  syncLogsDeleted: number
  /** Resolved inbound WMS event rows whose payload was cleared, keeping the idempotency tombstone (q66in.7.4). */
  wmsInboundEventsCompacted: number
  /** Finished WMS sync jobs deleted; their wms_sync_logs lines go with them by FK cascade (q66in.7.4). */
  wmsSyncJobsDeleted: number
  /**
   * Expired-but-unresolved accounting sync rows reduced to an attribution-only tombstone: unresolved
   * back-reference evidence (o3d-9kek) and unresolved abandoned claims (o3d-nepa). One counter for
   * both because it is one write producing one tombstone shape; the two differ only in which
   * question keeps the row.
   */
  backReferenceEvidenceCompacted: number
  stockMovementsDeleted: number
  webhookEventsCompacted: number
  salesOrdersArchived: number
  purchaseOrdersArchived: number
  customersArchived: number
}> {
  const settings = await getRetentionSettings()
  let syncLogsDeleted = 0
  let wmsInboundEventsCompacted = 0
  let wmsSyncJobsDeleted = 0
  let backReferenceEvidenceCompacted = 0
  let stockMovementsDeleted = 0
  let webhookEventsCompacted = 0
  let salesOrdersArchived = 0
  let purchaseOrdersArchived = 0
  let customersArchived = 0

  // Sync logs — hard delete
  const syncMonths = settings.retention_sync_logs_months
  if (syncMonths > 0) {
    const cutoff = monthsAgo(syncMonths)
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
      // o3d-nepa / o3d-y14: age alone NEVER expires accounting work that can still be posted.
      //
      // A PENDING, PROCESSING or FAILED row is not a log of something that happened — it is an
      // UNFINISHED JOB carrying the payload a worker will post from. Deleting one does not merely
      // lose an audit trail:
      //
      // o3d-nepa, THE ACTUAL P1: age alone never expires accounting work that CAN STILL BE POSTED.
      // A PENDING, PROCESSING or FAILED row is not a log of something that happened — it is an
      // UNFINISHED JOB carrying the payload a worker will post from, and both processors read the
      // row and its payload BEFORE they conditionally claim it, so a worker can be holding the
      // payload in memory while retention removes the row underneath it. The remote call still
      // happens and nothing is left to record that it did. The hard-delete guard counts the same
      // statuses (o3d-sref; o3d-ju8t: FAILED does NOT prove nothing was posted), so a deleted row
      // reads as zero and the order becomes hard-deletable with a document standing in the ledger.
      //
      // An earlier revision of this branch exempted PROCESSING rows from deletion and was REVERTED,
      // on the grounds that retaining the full row — payload included, holding customer names,
      // emails and financial lines — contradicts the retention period the settings UI promises.
      // That objection is answered by fixing the PROMISE rather than the data, because there is no
      // version of this that keeps both: a compacted payload cannot be posted, so retaining
      // unfinished work WHOLE is the only shape that works. What is retained is bounded by the
      // OUTSTANDING WORK BACKLOG — visible and actionable on the failed-sync dashboard — not by
      // history: every row leaves this exemption the moment it reaches SYNCED or CANCELLED and is
      // then expired by age normally. components/settings/data-retention.tsx says so.
      //
      // THE STATUS LIST IS THE SHARED CONSTANT, NOT A LOCAL COPY. o3d-nepa and PR #618 (o3d-y14,
      // branch o3d-y14-backfill-safety) introduced postable-sync-statuses.ts byte for byte
      // identically, so the two landed as the same add. BOTH READERS ARE NOW IN THE TREE: #618's
      // `applyWcCouponCorrection` counts these statuses under the sales-order row lock and declines
      // to correct an order that has any, because a queued payload is a SNAPSHOT built from the
      // pre-correction amount. Deleting the row by age would turn that decided fact into a false
      // one — the backfill would count zero, permanently stamp the order as corrected, and the
      // worker would still post the understated invoice. That is the same set this delete refuses
      // to touch, and if the two ever drift the hole reopens silently, which is the whole reason
      // neither side spells the statuses out.
      //
      // So the exemption is keyed on the SHARED constant both readers use — if the two sets ever
      // drift the hole reopens silently, which is why neither side spells the statuses out.
      //
      // AN EARLIER REVISION of this branch exempted PROCESSING only, and was reverted on the
      // grounds that retaining whole rows contradicts the retention period the settings UI
      // promises. That objection is answered by fixing the PROMISE rather than the data, because
      // there is no version of this that keeps both: a compacted payload cannot be posted, so
      // retaining unfinished work whole is the only shape that works. What is retained is bounded
      // by the OUTSTANDING WORK BACKLOG (visible and actionable on the failed-sync dashboard), not
      // by history — every row leaves the exemption the moment it reaches SYNCED or CANCELLED, and
      // is then expired by age normally. components/settings/data-retention.tsx says so.
      // o3d-9kek: what this ALSO does not delete is UNRESOLVED BACK-REFERENCE EVIDENCE — a posted row
      // whose repair sweep has not reached a verdict on it. Deleting one of those does not just
      // lose an audit trail: deleting a COMPETING sibling turns an ambiguity the sweep was
      // refusing to guess at into an apparent certainty (one unlinked bill, one surviving
      // claimant), and the sweep then attributes an external id whose competitor it can no longer
      // see. Nothing downstream can detect that, because the surviving state is genuinely
      // indistinguishable from an unambiguous one.
      //
      // Those rows are COMPACTED instead (below), not exempted. An earlier revision of this branch
      // exempted them outright and called it bounded because "the sweep stamps every row it
      // settles". It is not bounded: a permanently ambiguous row is never stamped by design, a
      // disconnected connector's rows are never swept at all, and no QuickBooks sweep existed, so
      // full payloads — customer names, emails, addresses, financial lines — could outlive the
      // configured retention period indefinitely. That is the same defect as the reverted
      // PROCESSING exemption above, and it is fixed the same way the o3d-nepa note prescribes: a
      // compacted tombstone carrying only what a later reader must be able to see.
      //
      // o3d-nepa: and what it does not delete EITHER is a row whose existence is the only local
      // guard against moving the same money in the ledger twice — a registered INVOICE_PAYMENT, an
      // applied PURCHASE_CREDIT_NOTE_ALLOCATION, a sent BILL_PAYMENT. Those guards do not fail when
      // their evidence is deleted; they answer "nothing has been sent" and mean it, and Xero's
      // idempotency key expired six minutes after the original call, so nothing remote catches the
      // second one. The back-reference clause above does not cover them: it requires an
      // externalTransactionId AND one of the four DOCUMENT types, and the harm here comes from
      // FOLLOW-UP types whose row matters whatever their status. See remote-money-evidence.ts for
      // the three readers and for why this is not compaction (yet).
      //
      // o3d-nepa, THE OTHER HALF: AGE IS NOT EVIDENCE THAT A THING IS FINISHED. The status clause
      // releases a row the moment it is no longer postable, which leaves TWO deletable statuses —
      // and only one of them is an outcome. SYNCED is: the call was made and the ledger answered.
      // CANCELLED is an ABANDONMENT, written by a sweep, by the post-time retirement of a CLAIMED
      // row, or by an operator, none of whom can see whether the remote call had already landed.
      // A claimed row that was abandoned and never resolved therefore ages out and disappears, and
      // no reader FAILS when it does: the daily-batch recreate sweep reads "no row at all" as "the
      // journal never posted" and re-raises a DUPLICATE into a live ledger, and the money-retry
      // guard reads a scope one CANCELLED sibling short as UNAMBIGUOUS and posts a second payment.
      // The one abandonment that IS proof — `abandonedBeforeRemoteCall`, written only over a
      // provably PRE-CALL PENDING row — still expires by age. See unresolved-abandoned-claim.ts.
      //
      // FOUR CLAUSES, FOUR DIFFERENT QUESTIONS, AND NONE SUBSUMES ANOTHER:
      //
      //   status ∉ POSTABLE  — "can a document still be posted FROM this row?" PENDING carries no
      //                        externalTransactionId at all, so the back-reference predicate never
      //                        sees it; without this clause a PENDING SALES_INVOICE is still
      //                        deleted by age with its payload.
      //   type ∉ MONEY       — "is this row's bare existence the only thing suppressing a second
      //                        remote call?" That is about FINISHED work — SYNCED and CANCELLED
      //                        rows, which the status clause deliberately releases.
      //   NOT UNRESOLVED_…   — "is this row the only evidence that a document was posted without
      //                        being linked?" SYNCED/FAILED carrying an external id.
      //   NOT UNRESOLVED_ABANDONED_CLAIM
      //                      — "was this row ever RESOLVED at all?" A CANCELLED SALES_INVOICE is in
      //                        none of the other three: CANCELLED is outside POSTABLE by design,
      //                        SALES_INVOICE is deliberately outside the money-evidence list, and a
      //                        row abandoned before it posted carries no external id for the
      //                        back-reference clause to see.
      //
      // Where the first and third overlap (FAILED with an external id) the row is retained by both
      // and then COMPACTED below, which blanks the payload. That is safe rather than contradictory:
      // an external id means the document already posted and both processors short-circuit to the
      // follow-ups instead of re-posting when `externalTransactionId` is set, so no blanked payload
      // is ever sent, and what the delete guard needs is only that the ROW SURVIVES — it counts
      // rows, it does not read them.
      db.accountingSyncLog.deleteMany({
        where: {
          createdAt: { lt: cutoff },
          status: { notIn: [...POSTABLE_ACCOUNTING_SYNC_STATUSES] },
          type: { notIn: [...REMOTE_MONEY_EVIDENCE_TYPES] },
          // TWO exemptions, both expressed as a NOT over a SHARED constant, and neither spelled out
          // here. `AND` rather than two `NOT` keys because an object literal has only one of those —
          // and writing them as one merged predicate would make the delete pass true when EITHER
          // clause was satisfied, which is the opposite of what both of them mean.
          AND: [
            { NOT: UNRESOLVED_BACK_REFERENCE_EVIDENCE_WHERE },
            { NOT: UNRESOLVED_ABANDONED_CLAIM_WHERE },
          ],
        },
      }),
    ])
    syncLogsDeleted = wc.count + acct.count

    // The other half: expired-but-unresolved rows lose their CONTENT and keep their ATTRIBUTION.
    // Ordered after the delete deliberately — the two predicates are MUTUALLY EXCLUSIVE (the delete
    // requires NOT UNRESOLVED_…, this one requires it), so no row is both deleted and compacted, and
    // doing the delete first means a crash between them leaves rows un-compacted (repeated next run)
    // rather than un-deleted.
    //
    // They are no longer exact COMPLEMENTS, because o3d-nepa holds two further sets back from the
    // delete without adding either of them here — both are in NEITHER pass, deliberately:
    //
    //   • the MONEY-EVIDENCE types. Compaction writes `payload: {}`, and a money row with a blank
    //     body is the worst of both worlds — the follow-up planner can neither prove from it that
    //     nothing was sent nor re-send it, which is exactly the shape that made money retries
    //     permanently unusable in o3d-nepa's parked attempt (round 1 finding 2).
    //   • POSTABLE rows with no external id (PENDING, PROCESSING, and FAILED that never posted).
    //     These are unfinished JOBS, and the payload is the request a worker will build from, so
    //     blanking it would destroy the work while leaving the row claiming it is still owed.
    //
    // A POSTABLE row that DOES carry an external id (FAILED, already posted) is in both the delete's
    // exemption and this pass, and is compacted: its document exists, both processors short-circuit
    // to the follow-ups rather than re-posting, so the payload is not what makes it postable.
    //
    // o3d-nepa's UNRESOLVED ABANDONED CLAIM is the third set, and it IS in this pass — that is the
    // whole reason it can be held back from the delete without repeating the mistake the reverted
    // PROCESSING exemption made. A CANCELLED SALES_INVOICE payload is customer names, email and
    // delivery addresses and line descriptions, and retaining that whole and for ever contradicts
    // the period the settings UI promises. Nothing reads it: every reader that the deletion would
    // mislead — the daily-batch recreate verdict, the money-retry ambiguity guard, the staged-debit
    // resolver — reads COLUMNS. So the row survives as evidence and its content expires on schedule.
    //
    // `backReferenceEvidenceCompactedAt: null` PERMANENTLY excludes already-compacted rows from THIS
    // PASS, so each daily run rewrites only the newly-eligible slice instead of the whole tombstone
    // set — the same shape as the o3d-ahk webhook inbox compaction below.
    //
    // It does NOT exclude them from the repair sweep (o3d-9kek r4 finding 3). An earlier revision
    // did, which meant retention silently RETIRED unresolved repair work: compaction is scheduled by
    // age and says nothing about repairability, so an ambiguity that cleared after the horizon was
    // never reconsidered and a transiently failing back-reference was never repaired. A tombstone
    // keeps every column the id write needs and stays a candidate for it; what is genuinely lost is
    // only the payload-dependent follow-ups, which the sweep discards under an explicit terminal
    // policy and warns about.
    //
    // o3d-bqw7 r2 — AND IT RECORDS WHAT THE ROW OWED, WHICH IS WHY THIS IS NO LONGER ONE STATEMENT.
    //
    // The discard warning downstream claims "this row's outstanding follow-ups can no longer be
    // enqueued", and it used to answer that from the row's TYPE. A type is coarser than the truth: a
    // SALES_INVOICE owes a payment registration only when its payload carries `_registerPayment`, and
    // the ordinary sales path composes payloads without it — so tombstones that lost nothing were
    // warned about, and because the warning gates the obligation release, a false one that is also
    // unwritable holds an already-posted row at PENDING for ever.
    //
    // The only moment that question can be answered truthfully is THIS one: after it, the payload the
    // answer is derived from does not exist. So the compaction reads each row, derives what it owed
    // and writes that down in the SAME statement that empties the payload. Per row rather than one
    // `updateMany`, because a bulk UPDATE cannot compute a different value per row without moving the
    // enqueue's gate conditions into SQL, where they would drift from the branches they mirror.
    //
    // The volume is not the whole table: the predicate is `createdAt < cutoff` AND unresolved AND
    // holding an external id AND one of four types AND not already compacted, and each daily run only
    // sees the slice that has newly crossed the cutoff. It is nonetheless the ONLY per-row loop in
    // this purge, so it is BOUNDED by BACK_REFERENCE_EVIDENCE_COMPACTION_MAX_ROWS as well as by the
    // predicate — see that constant for why a cap costs nothing here.
    //
    // FAILING PART-WAY IS SAFE. Each row is its own statement, and a row that was not reached simply
    // keeps its payload and is compacted on the next run — the same property the single `updateMany`
    // had, for the same reason (`backReferenceEvidenceCompactedAt: null` excludes what is done).
    //
    // o3d-psvi — AND A ROW AN OPERATOR HAS JUST RE-OPENED IS NOT EXPIRED.
    //
    // `releaseRetiredAccountingSyncRowForLiveSale` puts a retired row back in front of the repair
    // sweep by writing SYNCED while leaving `backReferenceCheckedAt` null and keeping the document
    // id — which is EXACTLY this predicate. And such a row is OLD BY CONSTRUCTION: it was retired
    // long enough ago for somebody to notice and press the button. Compacting on `createdAt` alone
    // would therefore race the sweep for precisely the rows the release exists to rescue, and the
    // race is not harmless — the payload is what the PAYMENT registration is rebuilt from, so
    // compacting first means the sweep rebuilds only the PDF and warns that the payment is
    // unrecoverable, which is the opposite of what the release told the operator would happen.
    //
    // So the age test reads the row's LAST COMPLETION as well as its birth: a row whose `syncedAt`
    // falls inside the retention window is recent WORK, whatever its `createdAt` says. That is a
    // DEFERRAL and not an exemption — it moves with the cutoff, so a released row that nothing ever
    // finishes becomes compactable one full retention period later and the bound this compaction
    // exists to impose still holds.
    //
    // o3d-nepa — TWO POPULATIONS, ONE TOMBSTONE, because they lose the same thing and keep the same
    // thing. o3d-9kek's unresolved back-reference evidence, and the UNRESOLVED ABANDONED CLAIM: a
    // CANCELLED row whose abandonment does not establish that nothing was sent. Both are kept for
    // their COLUMNS (who, what, which document, what status) and neither has a reader that touches
    // the payload, so the payload is what expires. The money-evidence types are in NEITHER pass, for
    // the opposite reason: their payload IS the request.
    //
    // Both ORs are carried under an explicit `AND` rather than as two `OR` keys, which an object
    // literal cannot hold: the age deferral and the population disjunction are separate conditions
    // and collapsing them into one array would compact a row that satisfied EITHER.
    const compactableWhere = {
      createdAt: { lt: cutoff },
      backReferenceEvidenceCompactedAt: null,
      AND: [
        { OR: [{ syncedAt: null }, { syncedAt: { lt: cutoff } }] },
        { OR: [UNRESOLVED_BACK_REFERENCE_EVIDENCE_WHERE, UNRESOLVED_ABANDONED_CLAIM_WHERE] },
      ],
    }
    let compacted = 0
    let examined = 0
    // Paged from the head each time rather than by cursor: every row this loop touches LEAVES the
    // predicate, so the next page is always what is left.
    for (;;) {
      const remaining = BACK_REFERENCE_EVIDENCE_COMPACTION_MAX_ROWS - examined
      if (remaining <= 0) break
      const page = await db.accountingSyncLog.findMany({
        where: compactableWhere,
        select: { id: true, type: true, referenceType: true, externalTransactionId: true, payload: true },
        orderBy: { createdAt: 'asc' },
        take: Math.min(BACK_REFERENCE_EVIDENCE_COMPACTION_PAGE_SIZE, remaining),
      })
      if (page.length === 0) break
      examined += page.length
      const now = new Date()
      // A page whose rows all decline the write would otherwise be re-read for ever. The select and
      // the write now ask LITERALLY the same question, so a decline means a concurrent writer moved
      // the row out of the predicate — in which case the next select will not return it either, and
      // re-reading the page is work with no end. Stop and let the next run see the settled state.
      let writtenThisPage = 0
      for (const row of page) {
        const { count } = await db.accountingSyncLog.updateMany({
          // THE WHOLE SELECTION PREDICATE, RE-ASSERTED — not just the row id and the compaction stamp
          // (o3d-bqw7 r3, Codex HIGH). The read and the write are separate statements, so every
          // column the selection turned on is a column a concurrent writer can turn off in between:
          // the sweep stamping `backReferenceCheckedAt` or repairing the row, an operator retry
          // taking FAILED back to PENDING, `decideSaleRelease` retiring it to CANCELLED. Narrowing
          // this to `{ id, backReferenceEvidenceCompactedAt: null }` compacted such a row ANYWAY —
          // payload emptied, error message cleared, and an obligation record computed from a payload
          // the row had already moved on from, which is the one way this pass can UNDER-report what
          // is owed. Re-asserting the predicate makes the write a no-op instead, and the row is
          // re-selected on the next run if it is still eligible.
          where: { ...compactableWhere, id: row.id },
          data: {
            ...backReferenceEvidenceTombstone(now),
            // Keys only — no name, address, amount or document text. See the migration.
            followUpObligations: followUpObligationsOwedBy(row),
          },
        })
        compacted += count
        writtenThisPage += count
      }
      if (writtenThisPage === 0) break
      if (page.length < BACK_REFERENCE_EVIDENCE_COMPACTION_PAGE_SIZE) break
    }
    backReferenceEvidenceCompacted = compacted
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

  // Inbound WMS event tables — COMPACT resolved rows (q66in.7.4). Both tables were previously
  // untouched by every retention pass, so a payload (delivery addresses, contact names, line detail)
  // and a full dry-run review image lived forever. The predicate — resolved only, never a
  // dead-letter or a review that is still waiting — lives in lib/domain/wms/inbound-event-retention.ts
  // next to the reasoning for it.
  const wmsEventMonths = settings.retention_wms_events_months
  if (wmsEventMonths > 0) {
    const cutoff = monthsAgo(wmsEventMonths)
    const [receipts, webhooks] = await Promise.all([
      db.wmsInboundReceiptEvent.updateMany({
        where: compactableInboundEventWhere(cutoff),
        data: receiptEventCompactionData(Prisma.JsonNull),
      }),
      db.wmsWebhookEvent.updateMany({
        where: compactableInboundEventWhere(cutoff),
        data: inboundEventCompactionData(),
      }),
    ])
    wmsInboundEventsCompacted = receipts.count + webhooks.count
  }

  // WMS sync jobs — hard delete FINISHED runs, which cascades their per-SKU wms_sync_logs lines
  // (q66in.7.4). Deleting the parent is what bounds the child: a stock sync writes one log line per
  // checked SKU per run, so the lines are the volume and the job is the only handle on them.
  //
  // WHAT THIS REFUSES TO DELETE, and why age alone is not a licence:
  //   • A job that has not FINISHED (PENDING/RUNNING, or any row with a null finishedAt). An
  //     unfinished run is either in flight or stuck; either way its lines are live state, and an old
  //     timestamp on a stuck job is a REASON to keep it, not to remove it.
  //   • THE ONE DRY RUN each unconfirmed ALIGN_TO_WMS binding is waiting on. The confirm-alignment
  //     action refuses to arm live downward corrections without a completed dry run for that
  //     warehouse, so that job is the unmet precondition of an outstanding operator decision and
  //     deleting it silently revokes a confirmation nobody has made yet.
  //
  //     IT IS ONE ROW, NOT A WAREHOUSE (Codex r10 #3). An earlier revision excluded every STOCK_SYNC
  //     job for the warehouse and called the imprecision "over-retains a little". It is not a
  //     little: a stock sync writes one wms_sync_logs line per checked SKU per run and runs on a
  //     schedule, so a single binding left unconfirmed pinned every run and every line for that
  //     warehouse indefinitely — the highest-volume table here, exempted without bound by a
  //     condition nothing forces anyone to clear. The exemption is now exactly the row
  //     wms-connector-boundary-ok: q66in.7.4: naming the confirm helper the exemption mirrors is the point of the comment.
  //     `confirmMintsoftAlignmentMode` would read, resolved through the SHARED query so the two
  //     cannot drift: narrower than the confirm predicate deletes the evidence the operator is about
  //     to be asked for, wider re-opens the unbounded exemption.
  //
  //     A binding with no qualifying dry run protects nothing — there is no decision pending on a
  //     row that does not exist, and the operator has to run a fresh dry run either way.
  const wmsJobMonths = settings.retention_wms_sync_jobs_months
  if (wmsJobMonths > 0) {
    const cutoff = monthsAgo(wmsJobMonths)
    const pendingAlignmentBindings = await db.externalWmsBinding.findMany({
      where: { stockSyncMode: 'ALIGN_TO_WMS', alignmentConfirmedAt: null },
      select: { connector: true, warehouseId: true },
    })
    // Deduplicated on the SCOPE the query keys on, so two bindings of one connector on one warehouse
    // resolve the same single job once.
    const scopes = new Map(
      pendingAlignmentBindings.map((row) => [`${row.connector}:${row.warehouseId}`, row] as const),
    )
    const protectedJobIds: string[] = []
    for (const scope of scopes.values()) {
      const evidence = await db.wmsSyncJob.findFirst({
        ...alignmentDryRunEvidenceQuery(scope),
        select: { id: true },
      })
      if (evidence) protectedJobIds.push(evidence.id)
    }

    const { count } = await db.wmsSyncJob.deleteMany({
      where: {
        startedAt: { lt: cutoff },
        finishedAt: { not: null },
        status: { in: ['SUCCEEDED', 'FAILED', 'PARTIAL'] },
        ...(protectedJobIds.length > 0 ? { id: { notIn: protectedJobIds } } : {}),
      },
    })
    wmsSyncJobsDeleted = count
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
  const parts: string[] = []
  if (syncLogsDeleted > 0) parts.push(`${syncLogsDeleted} sync logs deleted`)
  if (backReferenceEvidenceCompacted > 0) parts.push(`${backReferenceEvidenceCompacted} unresolved back-reference sync logs compacted`)
  if (stockMovementsDeleted > 0) parts.push(`${stockMovementsDeleted} stock movements deleted`)
  if (webhookEventsCompacted > 0) parts.push(`${webhookEventsCompacted} webhook events compacted`)
  if (wmsInboundEventsCompacted > 0) parts.push(`${wmsInboundEventsCompacted} WMS inbound events compacted`)
  if (wmsSyncJobsDeleted > 0) parts.push(`${wmsSyncJobsDeleted} WMS sync jobs deleted (with their log lines)`)
  if (salesOrdersArchived > 0) parts.push(`${salesOrdersArchived} sales orders archived`)
  if (purchaseOrdersArchived > 0) parts.push(`${purchaseOrdersArchived} purchase orders archived`)
  if (customersArchived > 0) parts.push(`${customersArchived} customers archived`)

  if (parts.length > 0) {
    await logActivity({
      entityType: 'SYSTEM',
      action: 'cleanup',
      tag: 'system',
      description: `Data retention cleanup: ${parts.join(', ')}`,
      metadata: { syncLogsDeleted, backReferenceEvidenceCompacted, stockMovementsDeleted, webhookEventsCompacted, wmsInboundEventsCompacted, wmsSyncJobsDeleted, salesOrdersArchived, purchaseOrdersArchived, customersArchived },
      resolveUser: false,
    })
  }

  return { syncLogsDeleted, backReferenceEvidenceCompacted, stockMovementsDeleted, webhookEventsCompacted, wmsInboundEventsCompacted, wmsSyncJobsDeleted, salesOrdersArchived, purchaseOrdersArchived, customersArchived }
}
