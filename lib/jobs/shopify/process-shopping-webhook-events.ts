import {
  createShoppingWebhookEventRepository,
  type ShoppingWebhookEventRepository,
} from '@/lib/connectors/shopping-webhook-inbox'
import { processShopifyWebhookPayload } from '@/lib/connectors/shopify'
import {
  processPendingShoppingWebhookEvents,
  processShoppingWebhookEvent,
  type ProcessPendingShoppingWebhookEventsResult,
  type ProcessShoppingWebhookEventResult,
} from '@/lib/jobs/shopping/process-shopping-webhook-events'

export type ProcessShopifyWebhookEventResult = ProcessShoppingWebhookEventResult
export type ProcessPendingShopifyWebhookEventsResult = ProcessPendingShoppingWebhookEventsResult

type ProcessShopifyWebhookEventOptions = {
  repository?: ShoppingWebhookEventRepository
  now?: Date
  staleProcessingBefore?: Date
  processPayload?: typeof processShopifyWebhookPayload
  env?: Record<string, string | undefined>
}

type ProcessPendingShopifyWebhookEventsOptions = ProcessShopifyWebhookEventOptions & {
  pageSize?: number
}

function getRepository(repository?: ShoppingWebhookEventRepository): ShoppingWebhookEventRepository {
  return repository ?? createShoppingWebhookEventRepository({ connector: 'shopify' })
}

export async function processShopifyWebhookEvent(
  eventId: string,
  options: ProcessShopifyWebhookEventOptions = {},
): Promise<ProcessShopifyWebhookEventResult> {
  return processShoppingWebhookEvent(eventId, {
    connector: 'shopify',
    connectorLabel: 'Shopify',
    logPrefix: '[shopify-webhook-inbox]',
    repository: getRepository(options.repository),
    now: options.now,
    staleProcessingBefore: options.staleProcessingBefore,
    env: options.env,
    processPayload: async (input) => (options.processPayload ?? processShopifyWebhookPayload)({
      resource: input.resource,
      topic: input.topic,
      externalEventId: input.externalEventId,
      payload: input.payload,
    }),
  })
}

export async function processPendingShopifyWebhookEvents(
  options: ProcessPendingShopifyWebhookEventsOptions = {},
): Promise<ProcessPendingShopifyWebhookEventsResult> {
  return processPendingShoppingWebhookEvents({
    connector: 'shopify',
    connectorLabel: 'Shopify',
    logPrefix: '[shopify-webhook-inbox]',
    repository: getRepository(options.repository),
    now: options.now,
    staleProcessingBefore: options.staleProcessingBefore,
    env: options.env,
    pageSize: options.pageSize,
    processPayload: async (input) => (options.processPayload ?? processShopifyWebhookPayload)({
      resource: input.resource,
      topic: input.topic,
      externalEventId: input.externalEventId,
      payload: input.payload,
    }),
  })
}
