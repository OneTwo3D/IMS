import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import type { FollowUpEnqueuePlan } from './followup-idempotency'

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

export async function resolveLostFollowUpRevival(
  context: RevivalContext & { replanned: boolean; retry: () => Promise<void> },
): Promise<void> {
  const { connector, type, referenceType, referenceId, plan, replanned, retry } = context

  // Another run revived it first. That revival carries the same pinned token — the planner
  // stamps it onto the payload rather than leaving it implicit in the row id — so it is the
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
