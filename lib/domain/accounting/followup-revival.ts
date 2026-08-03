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
 * Handles a revival whose compare-and-set matched no row: the row was revived by another
 * run, or retention hard-deleted it between the read and the write (o3d-nepa).
 *
 * The distinction that matters is whether the row we lost was carrying a PINNED token. If
 * it was, that row held the only record of what the earlier attempt posted under, and
 * simply re-planning would mint a fresh token and post a SECOND payment — the very hazard
 * this whole change closes (Codex r2 blocker). For money movement that refuses, loudly.
 *
 * When the token was going to be rotated anyway, the lost row carried no safety value, so
 * re-planning once against current state is correct.
 */
export async function resolveLostFollowUpRevival(
  context: RevivalContext & { replanned: boolean; retry: () => Promise<void> },
): Promise<void> {
  const { connector, type, referenceType, referenceId, plan, replanned, retry } = context
  const survivor = await db.accountingSyncLog.findUnique({
    where: { id: plan.syncLogId },
    select: { id: true },
  })

  if (!survivor && plan.tokenDisposition === 'pinned' && isMoneyMovingFollowUp(type)) {
    await logActivity({
      entityType: 'SYSTEM',
      action: `${connector}_followup_token_lost`,
      tag: 'sync',
      level: 'ERROR',
      description: `Refused to re-enqueue ${connector} ${type} for ${referenceType} ${referenceId}: the FAILED row `
        + 'carrying its idempotency token was deleted before it could be revived, so a retry would post under a '
        + 'token the ledger has never seen and could duplicate a payment. Reconcile this reference manually.',
      metadata: { type, referenceType, referenceId, syncLogId: plan.syncLogId },
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
