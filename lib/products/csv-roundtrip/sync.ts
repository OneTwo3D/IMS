import type { ProductLifecycleStatus } from '@/app/generated/prisma/client'
import { enqueueStockSync, pushProductMetadata } from '@/lib/shopping'
import { isAnyWmsConnectorEnabled, scheduleWmsProductSync } from '@/lib/domain/wms/product-sync-dispatch'
import { invalidateStaleHsProposal } from '@/lib/trade/hs-classification-trigger'

/**
 * The follow-up an edited product gets, which is exactly what the product editor (updateProduct) does after its
 * transaction commits: push the product's metadata to the storefront through the shopping facade, queue a stock sync
 * (forced for an archived product so the storefront is told it is gone), schedule the warehouse (WMS) product sync, and
 * drop a pending HS-code proposal that the edit made stale. Nothing here talks to a vendor itself; each step hands the
 * product to the same IMS queue or facade the editor uses, so the connectors' own gates, holds and rate limits apply.
 *
 * Bulk bound. The storefront push runs in ONE background task at {@link PRODUCT_CSV_SYNC_CONCURRENCY} (5) at a time, the
 * same ceiling the product CSV import uses, and the stock sync is a single batched queue call per lifecycle group, so
 * neither fans out with the size of the file. The warehouse sync is the one that did, see {@link PRODUCT_CSV_WMS_PER_PRODUCT_LIMIT}.
 *
 * Run AFTER the batches have committed, and best-effort: a failed push is logged and the next sync sweep picks the
 * product up; it never undoes the edit.
 */

export type ProductCsvSyncTarget = {
  id: string
  lifecycleStatus: ProductLifecycleStatus
  /** Name, description or category changed: the HS-code proposal's inputs moved. */
  classificationChanged: boolean
}

/** Concurrent storefront pushes. The same ceiling the product CSV import uses. */
export const PRODUCT_CSV_SYNC_CONCURRENCY = 5

async function runWithConcurrency<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) await worker(items[cursor++])
  }))
}

/**
 * Storefront and HS-proposal follow-up. Safe to run after the response (inside `after`).
 */
export async function runProductCsvStorefrontSync(targets: readonly ProductCsvSyncTarget[]): Promise<void> {
  const unique = [...new Map(targets.map((target) => [target.id, target])).values()]
  if (unique.length === 0) return

  await runWithConcurrency(unique, PRODUCT_CSV_SYNC_CONCURRENCY, async (target) => {
    try {
      const result = await pushProductMetadata(target.id)
      if (!result.success && result.error) console.error(result.error)
    } catch (error) {
      console.error(error)
    }
  })

  const archived = unique.filter((target) => target.lifecycleStatus === 'ARCHIVED').map((target) => target.id)
  const live = unique.filter((target) => target.lifecycleStatus !== 'ARCHIVED').map((target) => target.id)
  try {
    if (live.length > 0) await enqueueStockSync(live, 'IMS_CHANGE')
    if (archived.length > 0) await enqueueStockSync(archived, 'IMS_CHANGE', { force: true })
  } catch (error) {
    console.error(error)
  }

  await runWithConcurrency(unique.filter((target) => target.classificationChanged), PRODUCT_CSV_SYNC_CONCURRENCY, async (target) => {
    try {
      await invalidateStaleHsProposal(target.id)
    } catch (error) {
      console.error(error)
    }
  })
}

/**
 * Most products that get a per-product warehouse sync. `scheduleWmsProductSync` registers three `after()` tasks per
 * product and each product sync opens its own warehouse job, with no ceiling across jobs, so a 20,000-product edit would
 * register 60,000 tasks against the live warehouse API. Up to this many (an ordinary handful of edits, the editor's own pattern) are
 * scheduled one by one; a larger edit is NOT scheduled per product and is left to the warehouse connector's product verify run
 * (its scheduled cron and the Run Product Verify button on /sync), which walks the catalogue in batches of
 * 100 at a fixed concurrency of 5 and corrects any product that differs from its last accepted payload.
 */
export const PRODUCT_CSV_WMS_PER_PRODUCT_LIMIT = 25

export type ProductCsvWmsOutcome = { scheduled: number; deferred: number }

/**
 * The warehouse (WMS) product sync. It registers its work with Next's `after`, so it must be called while the request is
 * still in scope, which is why it is separate from {@link runProductCsvStorefrontSync}. The editor gates it on the
 * caller holding the `sync` permission and a WMS connector being enabled; the caller passes the first and this checks
 * the second.
 */
export async function scheduleProductCsvWmsSync(targets: readonly ProductCsvSyncTarget[]): Promise<ProductCsvWmsOutcome> {
  const unique = [...new Set(targets.map((target) => target.id))]
  if (unique.length === 0) return { scheduled: 0, deferred: 0 }
  try {
    if (!(await isAnyWmsConnectorEnabled())) return { scheduled: 0, deferred: 0 }
    if (unique.length > PRODUCT_CSV_WMS_PER_PRODUCT_LIMIT) return { scheduled: 0, deferred: unique.length }
    for (const id of unique) scheduleWmsProductSync(id)
    return { scheduled: unique.length, deferred: 0 }
  } catch (error) {
    console.error(error)
    return { scheduled: 0, deferred: 0 }
  }
}
