import {
  getWcWebhookMaxAttempts,
  getWcWebhookProcessPageSize,
  getWcWebhookStaleProcessingMs,
  nextWcWebhookRetryAt,
  normalizeWcWebhookError,
  type ShoppingWebhookEventConnector,
  type ShoppingWebhookEventRepository,
  type ShoppingWebhookEventRow,
} from '@/lib/connectors/woocommerce/webhook-inbox'
import type { ShoppingWebhookResource } from '@/lib/shopping'

export type ProcessShoppingWebhookEventResult =
  | { status: 'processed'; eventId: string }
  | { status: 'failed'; eventId: string; error: string; nextAttemptAt: Date }
  | { status: 'dead_letter'; eventId: string; error: string }
  | { status: 'skipped'; eventId: string; reason: string }

export type ProcessPendingShoppingWebhookEventsResult = {
  attempted: number
  processed: number
  failed: number
  deadLettered: number
  skipped: number
}

export type ShoppingWebhookProcessorOptions = {
  connector: ShoppingWebhookEventConnector
  connectorLabel: string
  logPrefix: string
  repository: ShoppingWebhookEventRepository
  processPayload: (input: {
    resource: ShoppingWebhookResource
    topic: string | null
    externalEventId: string | null
    payload: unknown
  }) => Promise<Response>
  now?: Date
  staleProcessingBefore?: Date
  env?: Record<string, string | undefined>
}

export type PendingShoppingWebhookProcessorOptions = ShoppingWebhookProcessorOptions & {
  pageSize?: number
}

class ShoppingWebhookProcessingError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message)
    this.name = 'ShoppingWebhookProcessingError'
  }
}

const SHOPPING_WEBHOOK_RESOURCES = new Set<ShoppingWebhookResource>(['orders', 'products', 'refunds'])

function isShoppingWebhookResource(resource: string): resource is ShoppingWebhookResource {
  return SHOPPING_WEBHOOK_RESOURCES.has(resource as ShoppingWebhookResource)
}

function assertProcessableEvent(
  row: ShoppingWebhookEventRow,
  connector: ShoppingWebhookEventConnector,
  connectorLabel: string,
): asserts row is ShoppingWebhookEventRow & { resource: ShoppingWebhookResource } {
  if (row.connector !== connector) {
    throw new ShoppingWebhookProcessingError(`Unsupported shopping webhook connector: ${row.connector}`, false)
  }
  if (!isShoppingWebhookResource(row.resource)) {
    throw new ShoppingWebhookProcessingError(`Unsupported ${connectorLabel} webhook resource: ${row.resource}`, false)
  }
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

async function assertSuccessfulResponse(response: Response, connectorLabel: string): Promise<void> {
  if (response.status < 400) return

  let errorBody: unknown
  try {
    errorBody = await response.json()
  } catch {
    errorBody = await response.text().catch(() => '')
  }
  throw new ShoppingWebhookProcessingError(
    `${connectorLabel} webhook processing returned HTTP ${response.status}: ${JSON.stringify(errorBody)}`,
    isRetryableHttpStatus(response.status),
  )
}

function isRetryableProcessingError(error: unknown): boolean {
  if (error instanceof ShoppingWebhookProcessingError) return error.retryable
  return true
}

function nextRetryAt(input: {
  attempts: number
  now: Date
  eventId: string
}) {
  // maxAttempts counts total claims. Since claimEvent post-increments attempts,
  // attempt 1 gets the first retry delay and attempt N dead-letters when N
  // reaches the configured maximum.
  return nextWcWebhookRetryAt({
    attempts: input.attempts,
    now: input.now,
    eventId: input.eventId,
  })
}

export async function processShoppingWebhookEvent(
  eventId: string,
  options: ShoppingWebhookProcessorOptions,
): Promise<ProcessShoppingWebhookEventResult> {
  const now = options.now ?? new Date()
  const staleProcessingBefore = options.staleProcessingBefore
    ?? new Date(now.getTime() - getWcWebhookStaleProcessingMs(options.env))
  const claimed = await options.repository.claimEvent(eventId, now, staleProcessingBefore)
  if (!claimed) return { status: 'skipped', eventId, reason: 'not_due_or_already_processed' }

  try {
    assertProcessableEvent(claimed, options.connector, options.connectorLabel)
    const response = await options.processPayload({
      resource: claimed.resource,
      topic: claimed.topic,
      externalEventId: claimed.externalEventId,
      payload: claimed.payloadJson,
    })
    await assertSuccessfulResponse(response, options.connectorLabel)
    await options.repository.markProcessed(claimed.id, now)
    return { status: 'processed', eventId: claimed.id }
  } catch (error) {
    const message = normalizeWcWebhookError(error)
    const maxAttempts = getWcWebhookMaxAttempts(options.env)
    if (!isRetryableProcessingError(error) || claimed.attempts >= maxAttempts) {
      await options.repository.markDeadLetter({ id: claimed.id, now, error: message })
      console.warn(`${options.logPrefix} event dead-lettered`, {
        eventId: claimed.id,
        attempts: claimed.attempts,
        retryable: isRetryableProcessingError(error),
      })
      return { status: 'dead_letter', eventId: claimed.id, error: message }
    }

    const nextAttemptAt = nextRetryAt({ attempts: claimed.attempts, now, eventId: claimed.id })
    await options.repository.markFailed({
      id: claimed.id,
      now,
      error: message,
      nextAttemptAt,
    })
    console.warn(`${options.logPrefix} event processing failed`, {
      eventId: claimed.id,
      attempts: claimed.attempts,
      nextAttemptAt: nextAttemptAt.toISOString(),
    })
    return { status: 'failed', eventId: claimed.id, error: message, nextAttemptAt }
  }
}

export async function processPendingShoppingWebhookEvents(
  options: PendingShoppingWebhookProcessorOptions,
): Promise<ProcessPendingShoppingWebhookEventsResult> {
  const now = options.now ?? new Date()
  const staleProcessingBefore = options.staleProcessingBefore
    ?? new Date(now.getTime() - getWcWebhookStaleProcessingMs(options.env))
  const pageSize = options.pageSize ?? getWcWebhookProcessPageSize(options.env)
  const events = await options.repository.findDueEvents({
    now,
    staleProcessingBefore,
    take: pageSize,
  })
  const counters: ProcessPendingShoppingWebhookEventsResult = {
    attempted: events.length,
    processed: 0,
    failed: 0,
    deadLettered: 0,
    skipped: 0,
  }

  for (const event of events) {
    try {
      const result = await processShoppingWebhookEvent(event.id, {
        ...options,
        now,
        staleProcessingBefore,
      })
      if (result.status === 'processed') counters.processed += 1
      else if (result.status === 'failed') counters.failed += 1
      else if (result.status === 'dead_letter') counters.deadLettered += 1
      else counters.skipped += 1
    } catch (error) {
      counters.failed += 1
      console.warn(`${options.logPrefix} event processing crashed`, {
        eventId: event.id,
        error: normalizeWcWebhookError(error),
      })
    }
  }

  console.info(`${options.logPrefix} tick complete`, counters)
  return counters
}
