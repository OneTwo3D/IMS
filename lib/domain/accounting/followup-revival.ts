import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { isMoneyMovingFollowUp, type FollowUpEnqueuePlan } from './followup-idempotency'

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
  plan: ReusePlan
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
 * Records an unresolvable money-moving follow-up as a durable, operator-visible FAILED row
 * rather than only an activity-log line.
 *
 * An activity log is not a recovery route: `logActivity` swallows its own write failures,
 * the failed-sync banner and the sync UI's retry action both read AccountingSyncLog, and
 * neither would ever show this (Codex review, r3 #D). A FAILED row surfaces in both and is
 * never picked up by a processor, so it cannot post anything — it is a tombstone, not work.
 */
async function recordUnresolvableFollowUp(
  context: RevivalContext & { reason: string },
): Promise<void> {
  const { connector, type, referenceType, referenceId, plan, reason } = context
  await db.accountingSyncLog.create({
    data: {
      connector,
      type: type as never,
      status: 'FAILED',
      referenceType,
      referenceId,
      payload: plan.payload as never,
      errorMessage: reason,
      retryCount: MAX_RETRY_TOMBSTONE,
    },
  })
  await logActivity({
    entityType: 'SYSTEM',
    action: `${connector}_followup_token_lost`,
    tag: 'sync',
    level: 'ERROR',
    description: `Refused to re-enqueue ${connector} ${type} for ${referenceType} ${referenceId}: ${reason}`,
    metadata: { type, referenceType, referenceId, syncLogId: plan.syncLogId },
  })
}

/**
 * Retry count stamped on a tombstone. Well past every connector's MAX_RETRIES so no sweep
 * treats it as retryable work, while leaving it visible to the failed-sync surfaces.
 */
const MAX_RETRY_TOMBSTONE = 99

/**
 * Handles a revival whose compare-and-set matched no row: the row was revived by another
 * run, or retention hard-deleted it between the read and the write (o3d-nepa).
 *
 * The distinction that matters is whether the row we lost was carrying a PINNED token. If
 * it was, that row held the only record of what the earlier attempt posted under, and
 * re-planning would mint a fresh token and post a SECOND payment — the very hazard this
 * whole change closes (Codex r2 blocker).
 *
 * For a pinned money-moving plan this therefore does NOT retry at all, under any outcome of
 * the survivor read. Retrying after checking is what left a window for retention to delete
 * the row in between and let the retry create a fresh-token replacement (Codex r3 #E);
 * removing the retry removes the window rather than narrowing it.
 *
 * When the token was going to be rotated anyway, the lost row carried no safety value, so
 * re-planning once against current state is correct.
 */
export async function resolveLostFollowUpRevival(
  context: RevivalContext & { replanned: boolean; retry: () => Promise<void> },
): Promise<void> {
  const { connector, type, referenceType, referenceId, plan, replanned, retry } = context

  if (plan.tokenDisposition === 'pinned' && isMoneyMovingFollowUp(type)) {
    // Someone else revived it — that revival carries the same pinned token, so it is the
    // outcome we wanted and there is nothing left to do.
    const live = await db.accountingSyncLog.count({
      where: {
        connector,
        type: type as never,
        referenceType,
        referenceId,
        status: { in: ['PENDING', 'PROCESSING', 'SYNCED'] },
      },
    })
    if (live > 0) return
    await recordUnresolvableFollowUp({
      connector,
      type,
      referenceType,
      referenceId,
      plan,
      reason: 'The FAILED row carrying this follow-up\'s idempotency token was removed before it could be revived. '
        + 'Retrying would post under a token the ledger has never seen and could duplicate a payment, so it has been '
        + 'left for manual reconciliation: confirm in the ledger whether the original posted, then resolve this row.',
    })
    return
  }

  if (!replanned) {
    await retry()
    return
  }

  // Two consecutive lost races. Bounded on purpose, but not silent — something else is
  // contending for this row and the follow-up has not been enqueued.
  await logActivity({
    entityType: 'SYSTEM',
    action: `${connector}_followup_revival_abandoned`,
    tag: 'sync',
    level: 'WARNING',
    description: `Gave up reviving ${connector} ${type} for ${referenceType} ${referenceId} after two lost races; `
      + 'no follow-up row was enqueued by this run.',
    metadata: { type, referenceType, referenceId, syncLogId: plan.syncLogId },
  })
}
