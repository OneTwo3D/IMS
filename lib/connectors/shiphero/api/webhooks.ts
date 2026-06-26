import { shipheroGraphql } from './client'
import type { ShipheroWebhookEventType } from '@/lib/connectors/shiphero/webhook-validation'

/**
 * ShipHero webhook registration via the `webhook_create` GraphQL mutation. ShipHero
 * names webhooks by a human label and returns a per-shop `shared_signature_secret`
 * used to verify the HMAC on inbound deliveries. Exact mutation/field names are
 * flagged "verify on live tenant" in the reference plan; written defensively.
 */

/** Canonical ShipHero webhook label per internal event type (the `name` arg). */
export const SHIPHERO_WEBHOOK_NAMES: Record<ShipheroWebhookEventType, string> = {
  shipment_update: 'Shipment Update',
  order_allocated: 'Order Allocated',
  order_canceled: 'Order Canceled',
  inventory_update: 'Inventory Update',
}

export type ShipheroWebhookRegistration = {
  id: string | null
  name: string | null
  url: string | null
  sharedSecret: string | null
}

const WEBHOOK_CREATE = `mutation ($name: String!, $url: String!) {
  webhook_create(data: { name: $name, url: $url }) {
    request_id
    webhook { id name url shared_signature_secret }
  }
}`

const WEBHOOK_DELETE = `mutation ($name: String!) {
  webhook_delete(data: { name: $name }) {
    request_id
    complexity
  }
}`

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export async function registerShipheroWebhook(name: string, callbackUrl: string): Promise<ShipheroWebhookRegistration> {
  const result = await shipheroGraphql<{ webhook_create?: { webhook?: unknown } }>(WEBHOOK_CREATE, { name, url: callbackUrl })
  if (result.error) throw new Error(result.error)
  const webhook = asRecord(result.data?.webhook_create?.webhook)
  return {
    id: webhook ? str(webhook.id) : null,
    name: webhook ? str(webhook.name) : null,
    url: webhook ? str(webhook.url) : null,
    sharedSecret: webhook ? str(webhook.shared_signature_secret) : null,
  }
}

export async function deleteShipheroWebhook(name: string): Promise<void> {
  const result = await shipheroGraphql<unknown>(WEBHOOK_DELETE, { name })
  if (result.error) throw new Error(result.error)
}

/**
 * Register every event type's webhook against a single callback base URL of the
 * form `<base>/api/webhooks/shiphero/<event-type>`. Returns each registration so the
 * caller can persist the shared secret(s).
 */
export async function registerAllShipheroWebhooks(callbackBaseUrl: string): Promise<ShipheroWebhookRegistration[]> {
  const base = callbackBaseUrl.replace(/\/+$/, '')
  const registrations: ShipheroWebhookRegistration[] = []
  for (const [eventType, name] of Object.entries(SHIPHERO_WEBHOOK_NAMES) as [ShipheroWebhookEventType, string][]) {
    const url = `${base}/api/webhooks/shiphero/${eventType.replace(/_/g, '-')}`
    registrations.push(await registerShipheroWebhook(name, url))
  }
  return registrations
}
