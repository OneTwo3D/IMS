import {
  createWcWebhookEventRepository,
  getWcWebhookProcessPageSize,
  getWcWebhookStaleProcessingMs,
  nextWcWebhookRetryAt,
  normalizeWcWebhookError,
  type WcWebhookEventRepository,
  type WcWebhookEventRow,
} from '@/lib/connectors/woocommerce/webhook-inbox'
import { processWcWebhookPayload } from '@/lib/connectors/woocommerce/webhooks'
import type { ShoppingWebhookResource } from '@/lib/shopping'

export type ProcessWcWebhookEventResult =
  | { status: 'processed'; eventId: string }
  | { status: 'failed'; eventId: string; error: string; nextAttemptAt: Date }
  | { status: 'skipped'; eventId: string; reason: string }

export type ProcessPendingWcWebhookEventsResult = {
  attempted: number
  processed: number
  failed: number
  skipped: number
}

type ProcessWcWebhookEventOptions = {
  repository?: WcWebhookEventRepository
  now?: Date
  staleProcessingBefore?: Date
  processPayload?: typeof processWcWebhookPayload
}

type ProcessPendingWcWebhookEventsOptions = ProcessWcWebhookEventOptions & {
  pageSize?: number
  env?: Record<string, string | undefined>
}

const WC_WEBHOOK_RESOURCES = new Set<ShoppingWebhookResource>(['orders', 'products', 'refunds'])

function isShoppingWebhookResource(resource: string): resource is ShoppingWebhookResource {
  return WC_WEBHOOK_RESOURCES.has(resource as ShoppingWebhookResource)
}

function getRepository(repository?: WcWebhookEventRepository): WcWebhookEventRepository {
  return repository ?? createWcWebhookEventRepository()
}

function assertProcessableEvent(row: WcWebhookEventRow): asserts row is WcWebhookEventRow & {
  connector: 'woocommerce'
  resource: ShoppingWebhookResource
} {
  if (row.connector !== 'woocommerce') {
    throw new Error(`Unsupported shopping webhook connector: ${row.connector}`)
  }
  if (!isShoppingWebhookResource(row.resource)) {
    throw new Error(`Unsupported WooCommerce webhook resource: ${row.resource}`)
  }
}

async function assertSuccessfulResponse(response: Response): Promise<void> {
  if (response.status < 400) return
  let errorBody: unknown
  try {
    errorBody = await response.json()
  } catch {
    errorBody = await response.text().catch(() => '')
  }
  throw new Error(`WooCommerce webhook processing returned HTTP ${response.status}: ${JSON.stringify(errorBody)}`)
}

export async function processWcWebhookEvent(
  eventId: string,
  options: ProcessWcWebhookEventOptions = {},
): Promise<ProcessWcWebhookEventResult> {
  const repository = getRepository(options.repository)
  const now = options.now ?? new Date()
  const staleProcessingBefore = options.staleProcessingBefore
    ?? new Date(now.getTime() - getWcWebhookStaleProcessingMs())
  const claimed = await repository.claimEvent(eventId, now, staleProcessingBefore)
  if (!claimed) return { status: 'skipped', eventId, reason: 'not_due_or_already_processed' }

  try {
    assertProcessableEvent(claimed)
    const response = await (options.processPayload ?? processWcWebhookPayload)({
      resource: claimed.resource,
      topic: claimed.topic,
      payload: claimed.payloadJson,
    })
    await assertSuccessfulResponse(response)
    await repository.markProcessed(claimed.id, now)
    return { status: 'processed', eventId: claimed.id }
  } catch (error) {
    const message = normalizeWcWebhookError(error)
    const nextAttemptAt = nextWcWebhookRetryAt({ attempts: claimed.attempts, now })
    await repository.markFailed({
      id: claimed.id,
      now,
      error: message,
      nextAttemptAt,
    })
    return { status: 'failed', eventId: claimed.id, error: message, nextAttemptAt }
  }
}

export async function processPendingWcWebhookEvents(
  options: ProcessPendingWcWebhookEventsOptions = {},
): Promise<ProcessPendingWcWebhookEventsResult> {
  const repository = getRepository(options.repository)
  const now = options.now ?? new Date()
  const staleProcessingBefore = new Date(
    now.getTime() - getWcWebhookStaleProcessingMs(options.env),
  )
  const events = await repository.findDueEvents({
    now,
    take: options.pageSize ?? getWcWebhookProcessPageSize(options.env),
    staleProcessingBefore,
  })

  const counters: ProcessPendingWcWebhookEventsResult = {
    attempted: events.length,
    processed: 0,
    failed: 0,
    skipped: 0,
  }

  for (const event of events) {
    const result = await processWcWebhookEvent(event.id, {
      repository,
      now,
      staleProcessingBefore,
      processPayload: options.processPayload,
    })
    if (result.status === 'processed') counters.processed += 1
    else if (result.status === 'failed') counters.failed += 1
    else counters.skipped += 1
  }

  return counters
}
