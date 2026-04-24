import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { COMPONENT_PRODUCT_STATUSES } from '@/lib/products/lifecycle'
import { pushStockToWc } from './stock-sync'
import type { StockSyncReason } from '@/app/generated/prisma/enums'

const WEBHOOK_ECHO_WINDOW_MS = 10 * 60 * 1000
const WC_STOCK_SYNC_CONNECTOR = 'woocommerce'
const JOB_CLAIM_WINDOW_MS = 10 * 60 * 1000
const immediateStockSyncProductIds = new Set<string>()
let immediateStockSyncScheduled = false

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

async function expandDependentKitIds(productIds: string[]): Promise<string[]> {
  if (productIds.length === 0) return []
  const rows = await db.productComponent.findMany({
    where: {
      componentId: { in: productIds },
      product: { lifecycleStatus: { in: COMPONENT_PRODUCT_STATUSES }, type: 'KIT' },
    },
    select: { productId: true },
  })
  return rows.map((row) => row.productId)
}

async function expandProductScope(productIds: string[]): Promise<string[]> {
  const normalized = [...new Set(productIds.filter(Boolean))]
  if (normalized.length === 0) return []
  const dependentKitIds = await expandDependentKitIds(normalized)
  return [...new Set([...normalized, ...dependentKitIds])]
}

export async function enqueueWcStockSyncJobs(
  productIds: string[],
  reason: StockSyncReason,
  options?: { force?: boolean; webhookQty?: number | null },
): Promise<string[]> {
  const scope = await expandProductScope(productIds)
  const now = new Date()

  for (const productId of scope) {
    await db.stockSyncJob.upsert({
      where: {
        connector_productId: {
          connector: WC_STOCK_SYNC_CONNECTOR,
          productId,
        },
      },
      create: {
        connector: WC_STOCK_SYNC_CONNECTOR,
        productId,
        reason,
        status: 'PENDING',
        force: options?.force ?? false,
        webhookQty: options?.webhookQty ?? null,
        attempts: 0,
        lastError: null,
        availableAt: now,
      },
      update: {
        reason,
        status: 'PENDING',
        force: options?.force === true ? true : undefined,
        webhookQty: options?.webhookQty ?? null,
        lastError: null,
        availableAt: now,
      },
    })
  }

  return scope
}

export async function processQueuedWcStockSyncJobs(options?: {
  productIds?: string[]
  limit?: number
}): Promise<{ processed: number; synced: number; failed: number; errors: string[] }> {
  const limit = options?.limit ?? 25
  const productIds = options?.productIds ? [...new Set(options.productIds)] : undefined
  const jobs = await db.stockSyncJob.findMany({
    where: {
      connector: WC_STOCK_SYNC_CONNECTOR,
      ...(productIds ? { productId: { in: productIds } } : {}),
      availableAt: { lte: new Date() },
    },
    orderBy: { updatedAt: 'asc' },
    take: limit,
  })

  const summary = { processed: 0, synced: 0, failed: 0, errors: [] as string[] }

  function shouldRetainJob(result: { synced: number; errors: string[]; message: string }, job: { force: boolean; reason: StockSyncReason }) {
    if (result.errors.length > 0 && result.synced === 0) return true
    if (job.force && result.synced === 0) return true
    if (job.reason === 'WC_WEBHOOK' && result.synced === 0) return true
    if (
      result.synced === 0
      && (
        result.message.includes('disabled')
        || result.message.includes('credentials')
        || result.message.includes('No warehouses')
      )
    ) {
      return true
    }
    return false
  }

  for (const job of jobs) {
    const claimCutoff = new Date()
    const claimUntil = new Date(claimCutoff.getTime() + JOB_CLAIM_WINDOW_MS)
    const claimed = await db.stockSyncJob.updateMany({
      where: {
        connector: WC_STOCK_SYNC_CONNECTOR,
        productId: job.productId,
        updatedAt: job.updatedAt,
        availableAt: { lte: claimCutoff },
      },
      data: {
        availableAt: claimUntil,
      },
    })
    if (claimed.count === 0) continue

    summary.processed++
    try {
      const result = await pushStockToWc({
        productIds: [job.productId],
        forceProductIds: job.force ? [job.productId] : [],
        source: job.reason,
      })

      if (shouldRetainJob(result, job)) {
        const nextAttempts = job.attempts + 1
        const nextAvailableAt = new Date(Date.now() + Math.min(nextAttempts, 12) * 5 * 60 * 1000)
        await db.stockSyncJob.update({
          where: {
            connector_productId: {
              connector: WC_STOCK_SYNC_CONNECTOR,
              productId: job.productId,
            },
          },
          data: {
            status: 'FAILED',
            attempts: nextAttempts,
            lastError: result.errors.join(' | ').slice(0, 1000),
            availableAt: nextAvailableAt,
          },
        })
        summary.failed++
        summary.errors.push(...result.errors)
        continue
      }

      await db.stockSyncJob.delete({
        where: {
          connector_productId: {
            connector: WC_STOCK_SYNC_CONNECTOR,
            productId: job.productId,
          },
        },
      })
      if (job.reason === 'DAILY_RECONCILIATION') {
        await db.stockSyncState.upsert({
          where: {
            connector_productId: {
              connector: WC_STOCK_SYNC_CONNECTOR,
              productId: job.productId,
            },
          },
          create: {
            connector: WC_STOCK_SYNC_CONNECTOR,
            productId: job.productId,
            lastCorrectedAt: new Date(),
          },
          update: { lastCorrectedAt: new Date() },
        })
      }
      summary.synced += result.synced
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const nextAttempts = job.attempts + 1
      const nextAvailableAt = new Date(Date.now() + Math.min(nextAttempts, 12) * 5 * 60 * 1000)
      await db.stockSyncJob.update({
        where: {
          connector_productId: {
            connector: WC_STOCK_SYNC_CONNECTOR,
            productId: job.productId,
          },
        },
        data: {
          status: 'FAILED',
          attempts: nextAttempts,
          lastError: message.slice(0, 1000),
          availableAt: nextAvailableAt,
        },
      })
      summary.failed++
      summary.errors.push(message)
    }
  }

  return summary
}

export async function enqueueAndProcessImmediateWcStockSync(
  productIds: string[],
  reason: Extract<StockSyncReason, 'IMS_CHANGE' | 'WC_WEBHOOK' | 'MANUAL'>,
  options?: { force?: boolean; webhookQty?: number | null },
): Promise<void> {
  const scope = await enqueueWcStockSyncJobs(productIds, reason, options)
  if (scope.length === 0) return
  for (const productId of scope) immediateStockSyncProductIds.add(productId)
  if (immediateStockSyncScheduled) return

  immediateStockSyncScheduled = true
  await nextTick()
  const coalescedScope = [...immediateStockSyncProductIds]
  immediateStockSyncProductIds.clear()
  immediateStockSyncScheduled = false

  const outcome = await processQueuedWcStockSyncJobs({ productIds: coalescedScope, limit: coalescedScope.length })
  if (outcome.failed > 0) {
    await logActivity({
      entityType: 'SYNC',
      action: 'stock_sync_enqueue',
      tag: 'sync',
      level: 'WARNING',
      description: `Immediate WooCommerce stock sync left ${outcome.failed} queued failure(s) for retry`,
      metadata: {
        productIds: coalescedScope,
        errors: outcome.errors.slice(0, 10),
      },
    })
  }
}

export async function recordIncomingWcWebhook(productId: string, qty: number | null): Promise<void> {
  await db.stockSyncState.upsert({
    where: {
      connector_productId: {
        connector: WC_STOCK_SYNC_CONNECTOR,
        productId,
      },
    },
    create: {
      connector: WC_STOCK_SYNC_CONNECTOR,
      productId,
      lastWebhookQty: qty,
      lastWebhookAt: new Date(),
    },
    update: {
      lastWebhookQty: qty,
      lastWebhookAt: new Date(),
    },
  })
}

export async function shouldSuppressWcWebhookEcho(productId: string, qty: number | null): Promise<boolean> {
  const state = await db.stockSyncState.findUnique({
    where: {
      connector_productId: {
        connector: WC_STOCK_SYNC_CONNECTOR,
        productId,
      },
    },
    select: { lastPushedAt: true, lastPushedQty: true },
  })
  if (!state?.lastPushedAt) return false
  if (qty == null || state.lastPushedQty == null) return false
  const ageMs = Date.now() - state.lastPushedAt.getTime()
  return ageMs >= 0 && ageMs <= WEBHOOK_ECHO_WINDOW_MS && state.lastPushedQty === qty
}
