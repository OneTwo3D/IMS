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
export async function resolveLostFollowUpRevival(
  context: RevivalContext & { attempt: number; retry: () => Promise<void> },
): Promise<void> {
  const { connector, type, referenceType, referenceId, plan, attempt, retry } = context

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

  if (attempt + 1 < MAX_FOLLOW_UP_REVIVAL_ATTEMPTS) {
    await retry()
    return
  }

  throw new Error(
    `Could not enqueue ${connector} ${type} for ${referenceType} ${referenceId}: lost the revival race on all `
    + `${MAX_FOLLOW_UP_REVIVAL_ATTEMPTS} attempts and no live row exists (last candidate ${plan.syncLogId}).`,
  )
}
