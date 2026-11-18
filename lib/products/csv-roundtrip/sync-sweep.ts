import { Prisma } from '@/app/generated/prisma/client'
import type { ProductLifecycleStatus } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { enqueueStockSync, pushProductMetadata } from '@/lib/shopping'
import { isAnyWmsConnectorEnabled, syncWmsProductNow } from '@/lib/domain/wms/product-sync-dispatch'
import { invalidateStaleHsProposal } from '@/lib/trade/hs-classification-trigger'
import {
  PRODUCT_SYNC_CLAIM_LEASE_MINUTES,
  PRODUCT_SYNC_MAX_ATTEMPTS,
  PRODUCT_SYNC_SWEEP_BATCH,
} from '@/lib/products/csv-roundtrip/sync-constants'

/**
 * THE DRAIN of the sync an Edit by CSV owes.
 *
 * An apply never calls a vendor. Each batch it commits also writes a `product_sync_marks` row per product, in the same
 * transaction (store.ts), so the edit and the obligation are one atomic fact and survive a restart. This sweep, run by the
 * `product-sync-marks` cron, takes at most {@link PRODUCT_SYNC_SWEEP_BATCH} marks per run and does for each product what
 * the product editor does after a save: the storefront metadata push, the storefront stock sync through the shopping
 * facade's queue (forced for an archived product), the warehouse product / bundle sync, and the HS-proposal invalidation.
 * A 20,000-product edit therefore reaches the vendors as a steady trickle of at most 25 products per run, never as a burst.
 *
 * LEASE AND RETRY. A mark is claimed (leased) by one statement with FOR UPDATE SKIP LOCKED, so two overlapping runs take
 * different marks; a run that dies leaves a claim that expires and is retaken. A failure releases the lease, records the
 * error and counts an attempt; after {@link PRODUCT_SYNC_MAX_ATTEMPTS} the mark is parked (kept, visible, no longer taken).
 * A re-edit resets the mark, and a finished product's mark is only deleted if it was not re-marked while it was in flight.
 */

export type ProductSyncSweepResult = {
  claimed: number
  synced: number
  failed: number
  /** Marks still waiting after this run (not parked). */
  remaining: number
  /** Marks that have used up their attempts and are no longer taken. */
  parked: number
}

type ClaimedMark = { productId: string; storefrontPending: boolean; warehousePending: boolean; updatedAt: Date }

const STOREFRONT_CONCURRENCY = 5
/** What the shopping facade answers when no connector is runnable (lib/shopping.ts). */
const NO_SHOPPING_CONNECTOR = 'No runnable shopping connector configured'

async function inBatches<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) await worker(items[cursor++])
  }))
}

export async function runProductSyncSweep(options: { limit?: number } = {}): Promise<ProductSyncSweepResult> {
  const limit = Math.max(1, Math.min(options.limit ?? PRODUCT_SYNC_SWEEP_BATCH, PRODUCT_SYNC_SWEEP_BATCH))

  const claimed = await db.$queryRaw<ClaimedMark[]>(Prisma.sql`
    UPDATE "product_sync_marks" SET "claimedAt" = now(), "attempts" = "attempts" + 1
    WHERE "productId" IN (
      SELECT "productId" FROM "product_sync_marks"
      WHERE "attempts" < ${PRODUCT_SYNC_MAX_ATTEMPTS}
        AND ("claimedAt" IS NULL OR "claimedAt" < now() - make_interval(mins => ${PRODUCT_SYNC_CLAIM_LEASE_MINUTES}))
      ORDER BY "createdAt", "productId"
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "productId", "storefrontPending", "warehousePending", "updatedAt"
  `)

  const failures = new Map<string, string>()
  if (claimed.length > 0) {
    const products = await db.product.findMany({
      where: { id: { in: claimed.map((mark) => mark.productId) } },
      select: { id: true, lifecycleStatus: true },
    })
    const lifecycle = new Map<string, ProductLifecycleStatus>(products.map((product) => [product.id, product.lifecycleStatus]))
    const fail = (id: string, error: unknown) => { failures.set(id, error instanceof Error ? error.message : String(error)) }

    const storefront = claimed.filter((mark) => mark.storefrontPending && lifecycle.has(mark.productId))
    await inBatches(storefront, STOREFRONT_CONCURRENCY, async (mark) => {
      try {
        const pushed = await pushProductMetadata(mark.productId)
        // A push the connector declined (no connector configured, a hold or shadow, a setting that forbids it) is the same
        // non-event it is in the editor and is not retried; a real failure is carried onto the mark and retried.
        if (!pushed.success && pushed.error && !pushed.shadowed && pushed.error !== NO_SHOPPING_CONNECTOR) fail(mark.productId, pushed.error)
      } catch (error) {
        fail(mark.productId, error)
      }
    })
    const live = storefront.filter((mark) => lifecycle.get(mark.productId) !== 'ARCHIVED').map((mark) => mark.productId)
    const archived = storefront.filter((mark) => lifecycle.get(mark.productId) === 'ARCHIVED').map((mark) => mark.productId)
    try {
      if (live.length > 0) await enqueueStockSync(live, 'IMS_CHANGE')
      if (archived.length > 0) await enqueueStockSync(archived, 'IMS_CHANGE', { force: true })
    } catch (error) {
      for (const id of [...live, ...archived]) fail(id, error)
    }

    const warehouse = claimed.filter((mark) => mark.warehousePending && lifecycle.has(mark.productId))
    if (warehouse.length > 0 && await isAnyWmsConnectorEnabled()) {
      for (const mark of warehouse) {
        try {
          await syncWmsProductNow(mark.productId)
        } catch (error) {
          fail(mark.productId, error)
        }
      }
    }

    for (const mark of claimed) {
      if (!lifecycle.has(mark.productId)) continue
      try {
        await invalidateStaleHsProposal(mark.productId)
      } catch (error) {
        fail(mark.productId, error)
      }
    }

    for (const mark of claimed) {
      const error = failures.get(mark.productId)
      if (error === undefined) {
        // Only if it was not re-marked (a re-edit bumps updatedAt) while this run had it.
        await db.$executeRaw(Prisma.sql`DELETE FROM "product_sync_marks" WHERE "productId" = ${mark.productId} AND "updatedAt" = ${mark.updatedAt}::timestamp`)
      } else {
        await db.$executeRaw(Prisma.sql`UPDATE "product_sync_marks" SET "claimedAt" = NULL, "lastError" = ${error.slice(0, 500)} WHERE "productId" = ${mark.productId} AND "updatedAt" = ${mark.updatedAt}::timestamp`)
      }
    }
  }

  const [counts] = await db.$queryRaw<Array<{ remaining: bigint | number; parked: bigint | number }>>(Prisma.sql`
    SELECT count(*) FILTER (WHERE "attempts" < ${PRODUCT_SYNC_MAX_ATTEMPTS}) AS remaining,
           count(*) FILTER (WHERE "attempts" >= ${PRODUCT_SYNC_MAX_ATTEMPTS}) AS parked
    FROM "product_sync_marks"
  `)
  return {
    claimed: claimed.length,
    synced: claimed.length - failures.size,
    failed: failures.size,
    remaining: Number(counts?.remaining ?? 0),
    parked: Number(counts?.parked ?? 0),
  }
}
