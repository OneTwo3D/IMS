import {
  createWcWebhookEventRepository,
  getWcWebhookMaxAttempts,
  getWcWebhookProcessPageSize,
  getWcWebhookStaleProcessingMs,
  nextWcWebhookRetryAt,
  normalizeWcWebhookError,
  type WcWebhookEventRepository,
  type WcWebhookEventRow,
} from '@/lib/connectors/woocommerce/webhook-inbox'
import { processShopifyWebhookPayload } from '@/lib/connectors/shopify'
import type { ShoppingWebhookResource } from '@/lib/shopping'

export type ProcessShopifyWebhookEventResult =
  | { status: 'processed'; eventId: string }
  | { status: 'failed'; eventId: string; error: string; nextAttemptAt: Date }
  | { status: 'dead_letter'; eventId: string; error: string }
  | { status: 'skipped'; eventId: string; reason: string }

export type ProcessPendingShopifyWebhookEventsResult = {
  attempted: number
  processed: number
  failed: number
  deadLettered: number
  skipped: number
}

type ProcessShopifyWebhookEventOptions = {
  repository?: WcWebhookEventRepository
  now?: Date
  staleProcessingBefore?: Date
  processPayload?: typeof processShopifyWebhookPayload
  env?: Record<string, string | undefined>
}

type ProcessPendingShopifyWebhookEventsOptions = ProcessShopifyWebhookEventOptions & {
  pageSize?: number
}

class ShopifyWebhookProcessingError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message)
    this.name = 'ShopifyWebhookProcessingError'
  }
}

const SHOPIFY_WEBHOOK_RESOURCES = new Set<ShoppingWebhookResource>(['orders', 'products', 'refunds'])

function isShoppingWebhookResource(resource: string): resource is ShoppingWebhookResource {
  return SHOPIFY_WEBHOOK_RESOURCES.has(resource as ShoppingWebhookResource)
}

function getRepository(repository?: WcWebhookEventRepository): WcWebhookEventRepository {
  return repository ?? createWcWebhookEventRepository({ connector: 'shopify' })
}

function assertProcessableEvent(row: WcWebhookEventRow): asserts row is WcWebhookEventRow & {
  connector: 'shopify'
  resource: ShoppingWebhookResource
} {
  if (row.connector !== 'shopify') {
    throw new ShopifyWebhookProcessingError(`Unsupported shopping webhook connector: ${row.connector}`, false)
  }
  if (!isShoppingWebhookResource(row.resource)) {
    throw new ShopifyWebhookProcessingError(`Unsupported Shopify webhook resource: ${row.resource}`, false)
  }
}

async function assertSuccessfulResponse(response: Response): Promise<void> {
  if (response.ok) return

  let errorBody: unknown
  try {
    errorBody = await response.json()
  } catch {
    errorBody = await response.text().catch(() => '')
  }
  throw new ShopifyWebhookProcessingError(
    `Shopify webhook processing returned HTTP ${response.status}: ${JSON.stringify(errorBody)}`,
    response.status >= 500,
  )
}

function isRetryableProcessingError(error: unknown): boolean {
  if (error instanceof ShopifyWebhookProcessingError) return error.retryable
  return true
}

export async function processShopifyWebhookEvent(
  eventId: string,
  options: ProcessShopifyWebhookEventOptions = {},
): Promise<ProcessShopifyWebhookEventResult> {
  const repository = getRepository(options.repository)
  const now = options.now ?? new Date()
  const staleProcessingBefore = options.staleProcessingBefore
    ?? new Date(now.getTime() - getWcWebhookStaleProcessingMs(options.env))
  const claimed = await repository.claimEvent(eventId, now, staleProcessingBefore)
  if (!claimed) return { status: 'skipped', eventId, reason: 'not_due_or_already_processed' }

  try {
    assertProcessableEvent(claimed)
    const response = await (options.processPayload ?? processShopifyWebhookPayload)({
      resource: claimed.resource,
      topic: claimed.topic,
      externalEventId: claimed.externalEventId,
      payload: claimed.payloadJson,
    })
    await assertSuccessfulResponse(response)
    await repository.markProcessed(claimed.id, now)
    return { status: 'processed', eventId: claimed.id }
  } catch (error) {
    const message = normalizeWcWebhookError(error)
    const maxAttempts = getWcWebhookMaxAttempts(options.env)
    if (!isRetryableProcessingError(error) || claimed.attempts >= maxAttempts) {
      await repository.markDeadLetter({ id: claimed.id, now, error: message })
      console.warn('[shopify-webhook-inbox] event dead-lettered', {
        eventId: claimed.id,
        attempts: claimed.attempts,
        retryable: isRetryableProcessingError(error),
      })
      return { status: 'dead_letter', eventId: claimed.id, error: message }
    }

    const nextAttemptAt = nextWcWebhookRetryAt({ attempts: claimed.attempts, now, eventId: claimed.id })
    await repository.markFailed({
      id: claimed.id,
      now,
      error: message,
      nextAttemptAt,
    })
    console.warn('[shopify-webhook-inbox] event processing failed', {
      eventId: claimed.id,
      attempts: claimed.attempts,
      nextAttemptAt: nextAttemptAt.toISOString(),
    })
    return { status: 'failed', eventId: claimed.id, error: message, nextAttemptAt }
  }
}

export async function processPendingShopifyWebhookEvents(
  options: ProcessPendingShopifyWebhookEventsOptions = {},
): Promise<ProcessPendingShopifyWebhookEventsResult> {
  const repository = getRepository(options.repository)
  const now = options.now ?? new Date()
  const staleProcessingBefore = options.staleProcessingBefore
    ?? new Date(now.getTime() - getWcWebhookStaleProcessingMs(options.env))
  const pageSize = options.pageSize ?? getWcWebhookProcessPageSize(options.env)
  const events = await repository.findDueEvents({
    now,
    staleProcessingBefore,
    take: pageSize,
  })
  const counters: ProcessPendingShopifyWebhookEventsResult = {
    attempted: events.length,
    processed: 0,
    failed: 0,
    deadLettered: 0,
    skipped: 0,
  }

  for (const event of events) {
    try {
      const result = await processShopifyWebhookEvent(event.id, {
        repository,
        now,
        staleProcessingBefore,
        processPayload: options.processPayload,
        env: options.env,
      })
      if (result.status === 'processed') counters.processed += 1
      else if (result.status === 'failed') counters.failed += 1
      else if (result.status === 'dead_letter') counters.deadLettered += 1
      else counters.skipped += 1
    } catch (error) {
      counters.failed += 1
      console.warn('[shopify-webhook-inbox] event processing crashed', {
        eventId: event.id,
        error: normalizeWcWebhookError(error),
      })
    }
  }

  console.info('[shopify-webhook-inbox] tick complete', counters)
  return counters
}
