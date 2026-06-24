import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { COMPONENT_PRODUCT_STATUSES } from '@/lib/products/lifecycle'
import { pushStockToWc } from './stock-sync'
import type { StockSyncReason } from '@/app/generated/prisma/enums'
import {
  buildWcStockSyncOutboxPayload,
  parseWcStockSyncPayload,
  type WcStockSyncOutboxPayload,
} from './stock-sync-job-payload'
import {
  buildOutboxIdempotencyKey,
  claimIntegrationOutboxWork,
  enqueueIntegrationOutbox,
  INTEGRATION_OUTBOX_STATUS,
  markIntegrationOutboxPermanentFailure,
  markIntegrationOutboxRetryableFailure,
  type IntegrationOutboxRow,
} from '@/lib/domain/integrations/outbox'
import { INTEGRATION_OUTBOX_OPERATIONS } from '@/lib/domain/integrations/outbox-registry'

const WEBHOOK_ECHO_WINDOW_MS = 10 * 60 * 1000
const WC_STOCK_SYNC_CONNECTOR = 'woocommerce'
const WC_STOCK_SYNC_OPERATION = INTEGRATION_OUTBOX_OPERATIONS.woocommerce.stockSync
const WC_STOCK_SYNC_WORKER_ID = 'woocommerce-stock-sync'
const WC_STOCK_SYNC_MAX_ATTEMPTS = 12
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

function wcStockSyncIdempotencyKey(productId: string): string {
  return buildOutboxIdempotencyKey(WC_STOCK_SYNC_CONNECTOR, WC_STOCK_SYNC_OPERATION, productId)
}

function samePayload(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

type ApplyStockOutboxPayloadOptions = {
  row: IntegrationOutboxRow
  productId: string
  reason: StockSyncReason
  force?: boolean
  webhookQty?: number | null
  nextAttemptAt: Date
  status: string
  attempts?: number
  lastError?: string | null
}

async function applyStockOutboxPayload(options: ApplyStockOutboxPayloadOptions): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = attempt === 0
      ? options.row
      : await db.integrationOutbox.findUnique({ where: { id: options.row.id } })
    if (!current) return false

    const payload = parseWcStockSyncPayload({
      id: current.id,
      payloadJson: buildWcStockSyncOutboxPayload(
        options.productId,
        options.reason,
        { force: options.force, webhookQty: options.webhookQty },
        current.payloadJson,
      ),
    })

    if (current.status === INTEGRATION_OUTBOX_STATUS.PROCESSING) {
      if (samePayload(current.payloadJson, payload)) return true
      const updated = await db.integrationOutbox.updateMany({
        where: {
          id: current.id,
          status: INTEGRATION_OUTBOX_STATUS.PROCESSING,
        },
        data: {
          payloadJson: payload,
          lastError: null,
        },
      })
      if (updated.count > 0) return true
      continue
    }

    const resetAttempts = current.status === INTEGRATION_OUTBOX_STATUS.SUCCEEDED
      || current.status === INTEGRATION_OUTBOX_STATUS.PERMANENT_FAILED
    const updated = await db.integrationOutbox.updateMany({
      where: {
        id: current.id,
        status: { not: INTEGRATION_OUTBOX_STATUS.PROCESSING },
      },
      data: {
        connector: WC_STOCK_SYNC_CONNECTOR,
        operation: WC_STOCK_SYNC_OPERATION,
        idempotencyKey: wcStockSyncIdempotencyKey(options.productId),
        payloadJson: payload,
        status: options.status,
        ...(options.attempts !== undefined ? { attempts: options.attempts } : {}),
        ...(options.attempts === undefined && resetAttempts ? { attempts: 0 } : {}),
        nextAttemptAt: options.nextAttemptAt,
        lastError: options.lastError ?? null,
        lockedAt: null,
        lockedBy: null,
      },
    })
    if (updated.count > 0) return true
  }
  return false
}

async function completeClaimedJob(job: IntegrationOutboxRow): Promise<'succeeded' | 'requeued'> {
  const succeeded = await db.integrationOutbox.updateMany({
    where: {
      id: job.id,
      status: INTEGRATION_OUTBOX_STATUS.PROCESSING,
      lockedBy: WC_STOCK_SYNC_WORKER_ID,
      lockedAt: job.lockedAt,
      updatedAt: job.updatedAt,
    },
    data: {
      status: INTEGRATION_OUTBOX_STATUS.SUCCEEDED,
      nextAttemptAt: null,
      lastError: null,
      lockedAt: null,
      lockedBy: null,
    },
  })
  if (succeeded.count > 0) return 'succeeded'

  const current = await db.integrationOutbox.findUnique({
    where: { id: job.id },
    select: { payloadJson: true },
  })
  if (!current) {
    throw new Error(`WooCommerce stock outbox job ${job.id} could not be completed by ${WC_STOCK_SYNC_WORKER_ID}`)
  }
  if (samePayload(current.payloadJson, job.payloadJson)) {
    const completed = await db.integrationOutbox.updateMany({
      where: {
        id: job.id,
        status: INTEGRATION_OUTBOX_STATUS.PROCESSING,
        lockedBy: WC_STOCK_SYNC_WORKER_ID,
        lockedAt: job.lockedAt,
      },
      data: {
        status: INTEGRATION_OUTBOX_STATUS.SUCCEEDED,
        nextAttemptAt: null,
        lastError: null,
        lockedAt: null,
        lockedBy: null,
      },
    })
    if (completed.count > 0) return 'succeeded'
    throw new Error(`WooCommerce stock outbox job ${job.id} could not be completed by ${WC_STOCK_SYNC_WORKER_ID}`)
  }

  const requeued = await db.integrationOutbox.updateMany({
    where: {
      id: job.id,
      status: INTEGRATION_OUTBOX_STATUS.PROCESSING,
      lockedBy: WC_STOCK_SYNC_WORKER_ID,
      lockedAt: job.lockedAt,
    },
    data: {
      status: INTEGRATION_OUTBOX_STATUS.PENDING,
      nextAttemptAt: new Date(),
      lastError: null,
      lockedAt: null,
      lockedBy: null,
    },
  })
  if (requeued.count === 0) {
    throw new Error(`WooCommerce stock outbox job ${job.id} changed while processing but could not be requeued`)
  }
  return 'requeued'
}

async function migrateLegacyWcStockSyncJobs(productIds?: string[], limit = 100): Promise<number> {
  const jobs = await db.stockSyncJob.findMany({
    where: {
      connector: WC_STOCK_SYNC_CONNECTOR,
      ...(productIds ? { productId: { in: productIds } } : {}),
    },
    orderBy: { updatedAt: 'asc' },
    take: limit,
  })

  for (const job of jobs) {
    const row = await enqueueIntegrationOutbox({
      connector: WC_STOCK_SYNC_CONNECTOR,
      operation: WC_STOCK_SYNC_OPERATION,
      idempotencyKey: wcStockSyncIdempotencyKey(job.productId),
      payloadJson: buildWcStockSyncOutboxPayload(
        job.productId,
        job.reason,
        { force: job.force, webhookQty: job.webhookQty },
      ),
      nextAttemptAt: job.availableAt,
    })
    const migrated = await applyStockOutboxPayload({
      row,
      productId: job.productId,
      reason: job.reason,
      force: job.force,
      webhookQty: job.webhookQty,
      nextAttemptAt: job.availableAt,
      status: job.status === 'FAILED'
        ? job.attempts >= WC_STOCK_SYNC_MAX_ATTEMPTS
          ? INTEGRATION_OUTBOX_STATUS.PERMANENT_FAILED
          : INTEGRATION_OUTBOX_STATUS.RETRYABLE_FAILED
        : INTEGRATION_OUTBOX_STATUS.PENDING,
      attempts: job.attempts,
      lastError: job.lastError,
    })
    if (!migrated) continue

    await db.stockSyncJob.delete({
      where: {
        connector_productId: {
          connector: job.connector,
          productId: job.productId,
        },
      },
    }).catch(() => {
      // Another worker may have migrated the same legacy row.
    })
  }

  return jobs.length
}

export async function enqueueWcStockSyncJobs(
  productIds: string[],
  reason: StockSyncReason,
  options?: { force?: boolean; webhookQty?: number | null },
): Promise<string[]> {
  const scope = await expandProductScope(productIds)
  if (scope.length === 0) return []
  const now = new Date()
  await migrateLegacyWcStockSyncJobs(scope, Math.max(scope.length, 1))

  for (const productId of scope) {
    const row = await enqueueIntegrationOutbox({
      connector: WC_STOCK_SYNC_CONNECTOR,
      operation: WC_STOCK_SYNC_OPERATION,
      idempotencyKey: wcStockSyncIdempotencyKey(productId),
      payloadJson: buildWcStockSyncOutboxPayload(productId, reason, options),
      nextAttemptAt: now,
    })
    const queued = await applyStockOutboxPayload({
      row,
      productId,
      reason,
      force: options?.force,
      webhookQty: options?.webhookQty,
      nextAttemptAt: now,
      status: INTEGRATION_OUTBOX_STATUS.PENDING,
    })
    if (!queued) throw new Error(`WooCommerce stock outbox job for product ${productId} could not be queued`)
  }

  return scope
}

export async function processQueuedWcStockSyncJobs(options?: {
  productIds?: string[]
  limit?: number
  migrateLegacy?: boolean
}): Promise<{ processed: number; synced: number; failed: number; errors: string[] }> {
  const limit = options?.limit ?? 25
  const productIds = options?.productIds !== undefined ? [...new Set(options.productIds)] : undefined
  const summary = { processed: 0, synced: 0, failed: 0, errors: [] as string[] }
  if (productIds?.length === 0) return summary

  if (options?.migrateLegacy !== false) {
    await migrateLegacyWcStockSyncJobs(productIds, limit)
  }

  const jobs = await claimIntegrationOutboxWork({
    connector: WC_STOCK_SYNC_CONNECTOR,
    operation: WC_STOCK_SYNC_OPERATION,
    idempotencyKeys: productIds?.map(wcStockSyncIdempotencyKey),
    limit,
    workerId: WC_STOCK_SYNC_WORKER_ID,
    maxAttempts: WC_STOCK_SYNC_MAX_ATTEMPTS,
  })

  function shouldRetainJob(result: { synced: number; errors: string[]; message: string }, job: { force: boolean; reason: StockSyncReason }) {
    // d2jd (codex): retain on ANY error, not only when nothing synced. A single
    // outbox job can push MORE than one product — a scoped VARIABLE parent expands
    // to its children, and a scoped component pulls in dependent kits — and those
    // expanded products have no outbox job of their own. So a mixed-success run (one
    // product synced, another hit a transient preflight/lookup error) must still be
    // retried, or the failed product stays stale until the daily reconcile. Re-pushing
    // the already-synced products on retry is an idempotent no-op (the lastPushedQty
    // dedupe skips them); genuinely permanent errors stay bounded by MAX_ATTEMPTS →
    // PERMANENT_FAILED.
    if (result.errors.length > 0) return true
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
          attemptsBeforeFailure: job.attempts,
          maxAttempts: WC_STOCK_SYNC_MAX_ATTEMPTS,
        })
        summary.failed++
        // Always record a reason: a retained force/abort case (e.g. version_changed
        // race, disabled/credentials/no-warehouses) returns synced=0 with EMPTY
        // result.errors and only a result.message, which would otherwise log an
        // empty errors[] and make the "queued failure" warning undiagnosable.
        summary.errors.push(
          ...(result.errors.length > 0
            ? result.errors
            : [result.message || `Product ${payload.productId}: stock not pushed (retained for retry)`]),
        )
        continue
      }

      const completion = await completeClaimedJob(job)
      if (completion === 'requeued') {
        summary.synced += result.synced
        continue
      }

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
        attemptsBeforeFailure: job.attempts,
        maxAttempts: WC_STOCK_SYNC_MAX_ATTEMPTS,
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

  const outcome = await processQueuedWcStockSyncJobs({
    productIds: coalescedScope,
    limit: coalescedScope.length,
    migrateLegacy: false,
  })
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
