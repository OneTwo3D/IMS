/**
 * Background HS-code classification sweep (6igm.4). Finds eligible products that have no HS code
 * and have never been classified, runs each through the classifier + validator, and enqueues a
 * PENDING proposal into the review queue (6igm.3). Driven by /api/cron/hs-classify.
 *
 * Scope: only products with NO existing proposal are picked up, so a product is proposed at most
 * once by the sweep — no re-spamming of rejected suggestions, and pending items are left for the
 * operator. Re-examining already-coded but low-confidence products is a follow-up.
 *
 * Rate limits: the classifier already degrades to keyword rules on API 429/error, and the sweep
 * caps both the per-run batch and the concurrency, so it can't hammer the Anthropic API.
 */
import { db } from '@/lib/db'
import { Prisma, ProductType, ProductLifecycleStatus } from '@/app/generated/prisma/client'
import { upsertHsCodeProposal } from '@/lib/trade/hs-proposal-service'

const ELIGIBLE_TYPES = [ProductType.SIMPLE, ProductType.VARIANT, ProductType.KIT, ProductType.BOM]
export const HS_SWEEP_DEFAULT_LIMIT = 25
const HS_SWEEP_CONCURRENCY = 3

export type HsSweepResult = { scanned: number; proposed: number; errors: number }

/** Prisma filter for products the sweep should classify: eligible, live, uncoded, never proposed. */
export function hsSweepCandidateWhere(): Prisma.ProductWhereInput {
  return {
    type: { in: ELIGIBLE_TYPES },
    lifecycleStatus: { not: ProductLifecycleStatus.ARCHIVED },
    hsCode: null,
    hsCodeProposals: { none: {} },
  }
}

/** Run one sweep batch. Errors are isolated per product so one failure doesn't abort the run. */
export async function runHsClassificationSweep(
  { limit = HS_SWEEP_DEFAULT_LIMIT }: { limit?: number } = {},
): Promise<HsSweepResult> {
  const candidates = await db.product.findMany({
    where: hsSweepCandidateWhere(),
    orderBy: { createdAt: 'asc' },
    take: limit,
    select: { id: true },
  })

  let proposed = 0
  let errors = 0
  const queue = [...candidates]

  async function worker(): Promise<void> {
    for (;;) {
      const item = queue.shift() // synchronous — no cross-worker race in the single-threaded loop
      if (!item) return
      try {
        await upsertHsCodeProposal(item.id)
        proposed += 1
      } catch {
        errors += 1
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(HS_SWEEP_CONCURRENCY, candidates.length) }, () => worker()),
  )

  return { scanned: candidates.length, proposed, errors }
}
