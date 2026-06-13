// ---------------------------------------------------------------------------
// Landed-cost adjustment-journal durable outbox (audit-grob)
//
// recalculateLandedCosts / recalculateDirectLandedCosts mutate cost layers in a
// transaction, and the COGS/inventory reclass journals were queued AFTER that tx
// committed (a log-only try/catch). A crash between commit and queue lost the
// journals: a retry hits the no-op path (PO already CANCELLED / cost unchanged)
// and never re-queues — a silent GL gap.
//
// This enqueues the recalc result into the generic IntegrationOutbox INSIDE the
// recalc tx (so it commits atomically), and a cron-drained processor re-runs
// queueLandedCostAdjustmentJournals. Because those journals already carry
// idempotency keys, the drain is a NO-OP when the immediate post-commit call
// succeeded, and a RECOVERY when it was lost. The direct post-commit call is kept
// for immediacy — the outbox is a pure backstop, so a drain outage can never
// halt journals that already posted directly.
// ---------------------------------------------------------------------------

import type { Prisma } from '@/app/generated/prisma/client'
import {
  enqueueIntegrationOutbox,
  claimIntegrationOutboxWork,
  markIntegrationOutboxSuccess,
  markIntegrationOutboxRetryableFailure,
  buildOutboxIdempotencyKey,
  DEFAULT_INTEGRATION_OUTBOX_MAX_ATTEMPTS,
  type IntegrationOutboxClient,
  type IntegrationOutboxRow,
} from '@/lib/domain/integrations/outbox'
import { LandedCostJournalOutboxPayloadSchema } from '@/lib/domain/integrations/outbox-registry'
import { accountingPayloadKey } from '@/lib/accounting/payload-key'
import type { LandedCostRecalcResult } from './landed-cost-service'

export const LANDED_COST_OUTBOX_CONNECTOR = 'accounting'
export const LANDED_COST_OUTBOX_OPERATION = 'landed-cost.adjustment-journal'
const LANDED_COST_OUTBOX_WORKER = 'landed-cost-journal-drain'
const ADJUSTMENT_EPSILON = 0.01
// Delay the backstop drain past the immediate post-commit direct call so the drain
// never races it (Codex review): by the next cron tick the direct journals are
// already queued/SYNCED, so the drain's re-queue is an idempotent no-op. A crash
// that lost the direct call is still recovered on the following tick.
const DEFAULT_DRAIN_GRACE_MS = 90_000

type LandedCostAdjustmentArrays = Pick<LandedCostRecalcResult, 'inventoryTransitAdjustments' | 'cogsAdjustments'>
type LandedCostScheduleInput = LandedCostAdjustmentArrays & Pick<LandedCostRecalcResult, 'auditRunIds'>

/**
 * True when a recalc produced at least one material (|delta| > epsilon) journal.
 * Pure — no point enqueuing an outbox row for a zero-delta recalc.
 */
export function landedCostResultHasJournals(result: LandedCostAdjustmentArrays): boolean {
  const material = (rows: Array<{ totalDelta: number }>) => rows.some((r) => Math.abs(r.totalDelta) > ADJUSTMENT_EPSILON)
  return material(result.inventoryTransitAdjustments) || material(result.cogsAdjustments)
}

/** The minimal payload stored on the outbox row (only what the journal builder reads). */
export function buildLandedCostOutboxPayload(result: LandedCostAdjustmentArrays) {
  return {
    inventoryTransitAdjustments: result.inventoryTransitAdjustments,
    cogsAdjustments: result.cogsAdjustments,
  }
}

/**
 * Enqueue the recalc result for durable journal processing — call INSIDE the
 * recalc transaction so the outbox row commits atomically with the cost-layer
 * changes. No-op for zero-delta recalcs. Idempotency key is content-derived so a
 * (re)run with identical adjustments dedups.
 */
export async function scheduleLandedCostJournalOutbox(
  tx: Prisma.TransactionClient,
  result: LandedCostScheduleInput,
  options: { graceMs?: number; now?: Date } = {},
): Promise<void> {
  if (!landedCostResultHasJournals(result)) return
  const payload = buildLandedCostOutboxPayload(result)
  const now = options.now ?? new Date()
  const idempotencyKey = buildOutboxIdempotencyKey(
    LANDED_COST_OUTBOX_CONNECTOR,
    LANDED_COST_OUTBOX_OPERATION,
    // Per-recalc identity (auditRunIds) so two DISTINCT recalcs with identical
    // adjustment content (e.g. A→B today, A→B again later) still each get their
    // own durable backstop row instead of deduping to the first (Codex review).
    result.auditRunIds.join(','),
    accountingPayloadKey('landed-cost-outbox', payload),
  )
  await enqueueIntegrationOutbox(
    {
      connector: LANDED_COST_OUTBOX_CONNECTOR,
      operation: LANDED_COST_OUTBOX_OPERATION,
      idempotencyKey,
      payloadJson: payload,
      nextAttemptAt: new Date(now.getTime() + (options.graceMs ?? DEFAULT_DRAIN_GRACE_MS)),
    },
    { client: tx as unknown as IntegrationOutboxClient },
  )
}

/** Re-shape a parsed outbox payload into the LandedCostRecalcResult queueLandedCostAdjustmentJournals expects. */
export function landedCostOutboxPayloadToRecalcResult(
  payload: { inventoryTransitAdjustments: LandedCostRecalcResult['inventoryTransitAdjustments']; cogsAdjustments: LandedCostRecalcResult['cogsAdjustments'] },
): LandedCostRecalcResult {
  return {
    revalidatePoIds: [],
    auditRunIds: [],
    warnings: [],
    inventoryTransitAdjustments: payload.inventoryTransitAdjustments,
    cogsAdjustments: payload.cogsAdjustments,
  }
}

export type ProcessLandedCostOutboxResult = { claimed: number; succeeded: number; failed: number }

export type LandedCostOutboxDrainDeps = {
  claimWork: typeof claimIntegrationOutboxWork
  queueJournals: (result: LandedCostRecalcResult) => Promise<unknown>
  markSuccess: (options: Parameters<typeof markIntegrationOutboxSuccess>[0]) => Promise<unknown>
  markRetry: (options: Parameters<typeof markIntegrationOutboxRetryableFailure>[0]) => Promise<unknown>
}

const defaultDrainDeps = (): LandedCostOutboxDrainDeps => ({
  claimWork: claimIntegrationOutboxWork,
  // Lazy import to avoid a cycle (landed-cost-service imports this module).
  queueJournals: async (result) => (await import('./landed-cost-service')).queueLandedCostAdjustmentJournals(result),
  markSuccess: markIntegrationOutboxSuccess,
  markRetry: markIntegrationOutboxRetryableFailure,
})

/**
 * Drain pending landed-cost journal outbox jobs (called from the accounting-sync
 * cron). Each job re-runs queueLandedCostAdjustmentJournals — idempotent, so a
 * job whose journals already posted directly is a harmless no-op, and a job left
 * behind by a crash recovers. Failures mark the job retryable (exponential
 * backoff) rather than dropping it.
 */
export async function processLandedCostJournalOutbox(
  deps: LandedCostOutboxDrainDeps = defaultDrainDeps(),
  limit = 50,
): Promise<ProcessLandedCostOutboxResult> {
  const jobs = await deps.claimWork({
    connector: LANDED_COST_OUTBOX_CONNECTOR,
    operation: LANDED_COST_OUTBOX_OPERATION,
    workerId: LANDED_COST_OUTBOX_WORKER,
    limit,
    maxAttempts: DEFAULT_INTEGRATION_OUTBOX_MAX_ATTEMPTS,
  })
  const result: ProcessLandedCostOutboxResult = { claimed: jobs.length, succeeded: 0, failed: 0 }
  for (const job of jobs) {
    await processOneLandedCostOutboxJob(job, deps, result)
  }
  return result
}

async function processOneLandedCostOutboxJob(
  job: IntegrationOutboxRow,
  deps: LandedCostOutboxDrainDeps,
  result: ProcessLandedCostOutboxResult,
): Promise<void> {
  if (!job.lockedAt) { result.failed++; return }
  try {
    const payload = LandedCostJournalOutboxPayloadSchema.parse(job.payloadJson)
    await deps.queueJournals(landedCostOutboxPayloadToRecalcResult(payload))
    await deps.markSuccess({ id: job.id, workerId: LANDED_COST_OUTBOX_WORKER, lockedAt: job.lockedAt })
    result.succeeded++
  } catch (error) {
    await deps.markRetry({
      id: job.id,
      workerId: LANDED_COST_OUTBOX_WORKER,
      lockedAt: job.lockedAt,
      error,
      attemptsBeforeFailure: job.attempts,
      maxAttempts: DEFAULT_INTEGRATION_OUTBOX_MAX_ATTEMPTS,
    })
    result.failed++
  }
}
