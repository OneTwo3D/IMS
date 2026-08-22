import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { readFollowUpIdempotencyKey, type FollowUpEnqueuePlan, type FollowUpPayload } from './followup-idempotency'
import { isOperatorAssertedSettlement } from './sync-row-settlement'
import { FOLLOW_UPS_ENQUEUED, type FollowUpEnqueueOutcome } from './followup-enqueue-outcome'

/**
 * o3d-h2wx — the I/O half of the follow-up revival rule, shared by both accounting
 * connectors so the two cannot drift apart on the one decision that moves money.
 */

type ReusePlan = Extract<FollowUpEnqueuePlan, { action: 'reuse' }>

type RevivalContext = {
  connector: string
  type: string
  referenceType: string
  referenceId: string
  /** The payload this attempt intended to write — the carrier of the pinned token. */
  payload: FollowUpPayload
  /** The row a reuse targeted, for diagnostics. Absent when the plan was a create. */
  syncLogId?: string
}

/**
 * Reports what a completed revival actually did. Written AFTER the compare-and-set so it
 * can never claim a revival that lost the race, and it reads the plan's disposition rather
 * than assuming — the target-changed path rotates the token and applies the recomputed
 * body, which the earlier fixed wording described as exactly the opposite (Codex r2 #4).
 */
export async function logFollowUpRevival(
  connector: string,
  type: string,
  referenceType: string,
  referenceId: string,
  plan: ReusePlan,
): Promise<void> {
  if (plan.divergedFields.length === 0) return
  const token = plan.tokenDisposition === 'pinned'
    ? 'under the idempotency token its earlier attempt used'
    : 'under a newly derived idempotency token, because no surviving attempt could have posted this document'
  const body = plan.bodyDisposition === 'pinned'
    ? `the recomputed ${plan.divergedFields.join(', ')} was SUPPRESSED so the request matches what may already have posted`
    : `the recomputed ${plan.divergedFields.join(', ')} was applied`
  await logActivity({
    entityType: 'SYSTEM',
    action: `${connector}_followup_revived`,
    tag: 'sync',
    level: 'WARNING',
    description: `Revived ${connector} ${type} for ${referenceType} ${referenceId} ${token}; ${body}.`,
    metadata: {
      type,
      referenceType,
      referenceId,
      syncLogId: plan.syncLogId,
      tokenDisposition: plan.tokenDisposition,
      bodyDisposition: plan.bodyDisposition,
      divergedFields: plan.divergedFields,
    },
  })
}

/**
 * How many times a lost compare-and-set may be re-planned. Each attempt re-reads state, so
 * exhausting this means something is contending for the row on every single pass.
 */
export const MAX_FOLLOW_UP_REVIVAL_ATTEMPTS = 3

/**
 * Handles a revival whose compare-and-set matched no row: another run revived it first, or
 * retention hard-deleted it between the read and the write (o3d-nepa).
 *
 * Re-planning is safe here BECAUSE the token is carried on the payload rather than held in
 * the row id — the caller re-plans with `plan.payload`, and a carried token is authoritative
 * in the planner, so whatever row the re-plan lands on posts under the same remote key.
 *
 * If every attempt is lost, this THROWS rather than returning. An earlier revision logged a
 * warning and returned, which silently dropped the follow-up: `logActivity` swallows its own
 * write failures, so the loss could be invisible (Codex review, r5 #2). Throwing hands it to
 * the connector's existing failure handling, which records it against the entry and retries.
 */
/**
 * Handles an enqueue that could not take the slot: a compare-and-set that matched no row
 * (another run revived it first, or retention hard-deleted it — o3d-nepa), or a create /
 * revive that the live-follow-up unique index rejected with P2002.
 *
 * BOTH must come through here. An earlier revision swallowed the P2002 as an idempotent
 * no-op, which meant a concurrently-created row under a DIFFERENT token silently won the
 * slot while our token's request may already have committed — the exact race the token
 * comparison below exists to catch (Codex review, r7 #1).
 *
 * Re-planning is safe BECAUSE the token is carried on the payload rather than held in the
 * row id: the caller re-plans with this payload, and a carried token is authoritative in the
 * planner, so whatever row the re-plan lands on posts under the same remote key.
 *
 * If every attempt is lost, this THROWS rather than returning. An earlier revision logged a
 * warning and returned, which silently dropped the follow-up: `logActivity` swallows its own
 * write failures, so the loss could be invisible (Codex r5 #2). Throwing hands it to the
 * connector's existing failure handling.
 *
 * o3d-peh1: the RE-PLAN's outcome is returned, not discarded. A re-plan can itself refuse — the
 * ledger can decline it, the token history can be ambiguous — and swallowing that here would put
 * back the exact "returned normally, enqueued nothing" silence one frame lower down, where it is
 * harder to see. The only thing that returns "enqueued" without queueing anything is the case where
 * a live row carrying OUR token already exists, which is the work, done by somebody else.
 */
export async function resolveLostFollowUpRevival(
  context: RevivalContext & { attempt: number; retry: () => Promise<FollowUpEnqueueOutcome> },
): Promise<FollowUpEnqueueOutcome> {
  const { connector, type, referenceType, referenceId, payload, syncLogId, attempt, retry } = context
  const pinnedToken = readFollowUpIdempotencyKey(payload)

  // Another run got there first. That is only the outcome we wanted if the row it left
  // behind carries OUR token: counting live rows without comparing tokens would accept a
  // row posting under a different key while ours may already have committed (Codex r6).
  const live = await db.accountingSyncLog.findMany({
    where: {
      connector,
      type: type as never,
      referenceType,
      referenceId,
      status: { in: ['PENDING', 'PROCESSING', 'SYNCED'] },
    },
    // o3d-anu8: settlementBasis, because SYNCED is in the live set above and an operator can put a
    // row there by asserting it posted.
    select: { id: true, payload: true, settlementBasis: true },
  })
  const ours = live.filter((row) => readFollowUpIdempotencyKey(row.payload) === pinnedToken)
  if (ours.length > 0) {
    // A ROW SOMEBODY ASSERTED IS NOT "ANOTHER RUN GOT THERE FIRST" (o3d-anu8).
    //
    // Returning here means the follow-up is accounted for: a live row exists carrying our token, so
    // whatever posts it will post under the key we would have used. That reasoning is about a row a
    // PROCESSOR owns. An operator-settled row is SYNCED with a document id typed by hand, no worker
    // will ever pick it up, and returning quietly leaves the work permanently undone while looking
    // like the ordinary race outcome — the same silent suppression as the skip in planFollowUpEnqueue,
    // reached through the recovery path instead.
    //
    // Throwing hands it to the connector's failure handling, which is what makes it visible. It is
    // NOT re-enqueued here: if the assertion is right the ledger already holds this, and this
    // function has no way to find out which.
    const asserted = ours.filter((row) => isOperatorAssertedSettlement(row.settlementBasis))
    if (asserted.length > 0) {
      throw new Error(
        `Cannot enqueue ${connector} ${type} for ${referenceType} ${referenceId}: the live row carrying this `
        + `follow-up's idempotency token (${asserted.map((row) => row.id).join(', ')}) is SYNCED because an OPERATOR `
        + 'asserted it posted, not because the connector confirmed it — no worker will ever post from it, so treating '
        + 'it as work already in hand would leave this permanently undone. Check the asserted document in the '
        + 'accounting system and resolve that row before retrying.',
      )
    }
    // o3d-peh1: the caller is TOLD this is accounted for. A bare `return` reads as "nothing to
    // report", and the obligation release downstream cannot distinguish that from a refusal.
    return FOLLOW_UPS_ENQUEUED
  }
  if (live.length > 0) {
    // A live row owns this scope but under a different token. Retrying cannot help — the
    // unique index gives it the slot — and silently accepting it would be the duplicate we
    // are guarding against, so surface it instead of guessing.
    throw new Error(
      `Cannot enqueue ${connector} ${type} for ${referenceType} ${referenceId}: a live follow-up already owns this `
      + `reference under a different idempotency token (rows ${live.map((row) => row.id).join(', ')}; expected `
      + `${pinnedToken ?? 'none'}). Reconcile in the ledger before retrying.`,
    )
  }

  if (attempt + 1 < MAX_FOLLOW_UP_REVIVAL_ATTEMPTS) {
    return await retry()
  }

  throw new Error(
    `Could not enqueue ${connector} ${type} for ${referenceType} ${referenceId}: lost the enqueue race on all `
    + `${MAX_FOLLOW_UP_REVIVAL_ATTEMPTS} attempts and no live row carries its token`
    + `${syncLogId ? ` (last candidate ${syncLogId})` : ''}.`,
  )
}
