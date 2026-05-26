import {
  createShoppingWebhookEventRepository,
  type ShoppingWebhookEventRepository,
} from '@/lib/connectors/woocommerce/webhook-inbox'
import { processWcWebhookPayload } from '@/lib/connectors/woocommerce/webhooks'
import {
  processPendingShoppingWebhookEvents,
  processShoppingWebhookEvent,
  type ProcessPendingShoppingWebhookEventsResult,
  type ProcessShoppingWebhookEventResult,
} from '@/lib/jobs/shopping/process-shopping-webhook-events'

export type ProcessWcWebhookEventResult = ProcessShoppingWebhookEventResult
export type ProcessPendingWcWebhookEventsResult = ProcessPendingShoppingWebhookEventsResult

type ProcessWcWebhookEventOptions = {
  repository?: ShoppingWebhookEventRepository
  now?: Date
  staleProcessingBefore?: Date
  processPayload?: typeof processWcWebhookPayload
  env?: Record<string, string | undefined>
}

type ProcessPendingWcWebhookEventsOptions = ProcessWcWebhookEventOptions & {
  pageSize?: number
}

function getRepository(repository?: ShoppingWebhookEventRepository): ShoppingWebhookEventRepository {
  return repository ?? createShoppingWebhookEventRepository({ connector: 'woocommerce' })
}

export async function processWcWebhookEvent(
  eventId: string,
  options: ProcessWcWebhookEventOptions = {},
): Promise<ProcessWcWebhookEventResult> {
  return processShoppingWebhookEvent(eventId, {
    connector: 'woocommerce',
    connectorLabel: 'WooCommerce',
    logPrefix: '[woocommerce-webhook-inbox]',
    repository: getRepository(options.repository),
    now: options.now,
    staleProcessingBefore: options.staleProcessingBefore,
    env: options.env,
    processPayload: async (input) => (options.processPayload ?? processWcWebhookPayload)({
      resource: input.resource,
      topic: input.topic,
      payload: input.payload,
    }),
  })
}

export async function processPendingWcWebhookEvents(
  options: ProcessPendingWcWebhookEventsOptions = {},
): Promise<ProcessPendingWcWebhookEventsResult> {
  return processPendingShoppingWebhookEvents({
    connector: 'woocommerce',
    connectorLabel: 'WooCommerce',
    logPrefix: '[woocommerce-webhook-inbox]',
    repository: getRepository(options.repository),
    now: options.now,
    staleProcessingBefore: options.staleProcessingBefore,
    env: options.env,
    pageSize: options.pageSize,
    processPayload: async (input) => (options.processPayload ?? processWcWebhookPayload)({
      resource: input.resource,
      topic: input.topic,
      payload: input.payload,
    }),
  })
}
