import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { COMPONENT_PRODUCT_STATUSES } from '@/lib/products/lifecycle'
import { pushStockToWc } from './stock-sync'
import type { StockSyncReason } from '@/app/generated/prisma/enums'
import {
  buildOutboxIdempotencyKey,
  claimIntegrationOutboxWork,
  enqueueIntegrationOutbox,
  INTEGRATION_OUTBOX_STATUS,
  markIntegrationOutboxPermanentFailure,
  markIntegrationOutboxRetryableFailure,
  markIntegrationOutboxSuccess,
  type IntegrationOutboxRow,
} from '@/lib/domain/integrations/outbox'

const WEBHOOK_ECHO_WINDOW_MS = 10 * 60 * 1000
const WC_STOCK_SYNC_CONNECTOR = 'woocommerce'
const WC_STOCK_SYNC_OPERATION = 'stock.push'
const WC_STOCK_SYNC_WORKER_ID = 'woocommerce-stock-sync'
const WC_STOCK_SYNC_RETRY_DELAY_BASE_MS = 5 * 60 * 1000
const WC_STOCK_SYNC_RETRY_DELAY_MAX_STEPS = 12
const immediateStockSyncProductIds = new Set<string>()
let immediateStockSyncScheduled = false

type WcStockSyncOutboxPayload = {
  productId: string
  reason: StockSyncReason
  force: boolean
  webhookQty: number | null
}

const WC_STOCK_SYNC_REASONS: StockSyncReason[] = [
  'IMS_CHANGE',
  'WC_WEBHOOK',
  'DAILY_RECONCILIATION',
  'MANUAL',
]

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

function wcStockSyncIdempotencyKey(productId: string): string {
  return buildOutboxIdempotencyKey(WC_STOCK_SYNC_CONNECTOR, WC_STOCK_SYNC_OPERATION, productId)
}

function isStockSyncReason(value: unknown): value is StockSyncReason {
  return typeof value === 'string' && WC_STOCK_SYNC_REASONS.includes(value as StockSyncReason)
}

function parseWcStockSyncPayload(row: IntegrationOutboxRow): WcStockSyncOutboxPayload {
  const payload = row.payloadJson
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`WooCommerce stock outbox payload for ${row.id} must be an object`)
  }
  const data = payload as Record<string, unknown>
  if (typeof data.productId !== 'string' || !data.productId.trim()) {
    throw new Error(`WooCommerce stock outbox payload for ${row.id} is missing productId`)
  }
  if (!isStockSyncReason(data.reason)) {
    throw new Error(`WooCommerce stock outbox payload for ${row.id} has invalid reason`)
  }
  return {
    productId: data.productId,
    reason: data.reason,
    force: data.force === true,
    webhookQty: typeof data.webhookQty === 'number' ? data.webhookQty : null,
  }
}

function retryDelayMs(attemptsBeforeFailure: number): number {
  return Math.min(attemptsBeforeFailure + 1, WC_STOCK_SYNC_RETRY_DELAY_MAX_STEPS) * WC_STOCK_SYNC_RETRY_DELAY_BASE_MS
}

export async function enqueueWcStockSyncJobs(
  productIds: string[],
  reason: StockSyncReason,
  options?: { force?: boolean; webhookQty?: number | null },
): Promise<string[]> {
  const scope = await expandProductScope(productIds)
  const now = new Date()

  for (const productId of scope) {
    const payload: WcStockSyncOutboxPayload = {
      productId,
      reason,
      force: options?.force ?? false,
      webhookQty: options?.webhookQty ?? null,
    }
    const row = await enqueueIntegrationOutbox({
      connector: WC_STOCK_SYNC_CONNECTOR,
      operation: WC_STOCK_SYNC_OPERATION,
      idempotencyKey: wcStockSyncIdempotencyKey(productId),
      payloadJson: payload,
      nextAttemptAt: now,
    })
    await db.integrationOutbox.updateMany({
      where: {
        id: row.id,
        status: { not: INTEGRATION_OUTBOX_STATUS.PROCESSING },
      },
      data: {
        connector: WC_STOCK_SYNC_CONNECTOR,
        operation: WC_STOCK_SYNC_OPERATION,
        idempotencyKey: wcStockSyncIdempotencyKey(productId),
        payloadJson: payload,
        status: INTEGRATION_OUTBOX_STATUS.PENDING,
        attempts: 0,
        nextAttemptAt: now,
        lastError: null,
        lockedAt: null,
        lockedBy: null,
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
  const productIds = options?.productIds !== undefined ? [...new Set(options.productIds)] : undefined
  const summary = { processed: 0, synced: 0, failed: 0, errors: [] as string[] }
  if (productIds?.length === 0) return summary

  const jobs = await claimIntegrationOutboxWork({
    connector: WC_STOCK_SYNC_CONNECTOR,
    operation: WC_STOCK_SYNC_OPERATION,
    idempotencyKeys: productIds?.map(wcStockSyncIdempotencyKey),
    limit,
    workerId: WC_STOCK_SYNC_WORKER_ID,
  })

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
    summary.processed++
    if (!job.lockedAt) {
      summary.failed++
      summary.errors.push(`WooCommerce stock outbox job ${job.id} was claimed without lockedAt`)
      continue
    }

    let payload: WcStockSyncOutboxPayload
    try {
      payload = parseWcStockSyncPayload(job)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await markIntegrationOutboxPermanentFailure({
        id: job.id,
        workerId: WC_STOCK_SYNC_WORKER_ID,
        lockedAt: job.lockedAt,
        error: message,
      })
      summary.failed++
      summary.errors.push(message)
      continue
    }

    try {
      const result = await pushStockToWc({
        productIds: [payload.productId],
        forceProductIds: payload.force ? [payload.productId] : [],
        source: payload.reason,
      })

      if (shouldRetainJob(result, payload)) {
        await markIntegrationOutboxRetryableFailure({
          id: job.id,
          workerId: WC_STOCK_SYNC_WORKER_ID,
          lockedAt: job.lockedAt,
          error: result.errors.join(' | ') || result.message || 'WooCommerce stock sync failed',
          retryDelayMs: retryDelayMs(job.attempts),
        })
        summary.failed++
        summary.errors.push(...result.errors)
        continue
      }

      await markIntegrationOutboxSuccess({
        id: job.id,
        workerId: WC_STOCK_SYNC_WORKER_ID,
        lockedAt: job.lockedAt,
      })
      if (payload.reason === 'DAILY_RECONCILIATION') {
        await db.stockSyncState.upsert({
          where: {
            connector_productId: {
              connector: WC_STOCK_SYNC_CONNECTOR,
              productId: payload.productId,
            },
          },
          create: {
            connector: WC_STOCK_SYNC_CONNECTOR,
            productId: payload.productId,
            lastCorrectedAt: new Date(),
          },
          update: { lastCorrectedAt: new Date() },
        })
      }
      summary.synced += result.synced
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await markIntegrationOutboxRetryableFailure({
        id: job.id,
        workerId: WC_STOCK_SYNC_WORKER_ID,
        lockedAt: job.lockedAt,
        error: message,
        retryDelayMs: retryDelayMs(job.attempts),
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
