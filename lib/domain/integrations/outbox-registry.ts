import { StockSyncReason } from '@/app/generated/prisma/enums'
import { z } from 'zod'

const nonEmptyString = z.string().trim().min(1)

export const WcStockSyncOutboxPayloadSchema = z.object({
  productId: nonEmptyString,
  reason: z.nativeEnum(StockSyncReason),
  force: z.boolean().optional().default(false),
  webhookQty: z.number().finite().nullable().optional().default(null),
})

export const XeroAccountingOutboxPayloadSchema = z.object({
  accountingSyncLogId: nonEmptyString,
})

/**
 * Scaffolded for future outbox-based Mintsoft webhook processing. Current
 * Mintsoft webhook processing routes through the WMS booked-in job
 * directly without enqueueing to IntegrationOutbox.
 *
 * The future processor should read the full event row from
 * wms_inbound_receipt_events keyed by eventId, so this payload deliberately
 * carries no webhook body, ASN id, retry state, or processing metadata.
 */
export const MintsoftBookedInOutboxPayloadSchema = z.object({
  eventId: nonEmptyString,
})

type OutboxRegistryEntry<Name extends string = string> = {
  name: Name
  schema: z.ZodTypeAny
}

function defineOutboxRegistry<const T extends Record<string, Record<string, OutboxRegistryEntry>>>(registry: T): T {
  return registry
}

export const INTEGRATION_OUTBOX_REGISTRY = defineOutboxRegistry({
  woocommerce: {
    'stock.push': { name: 'stockSync', schema: WcStockSyncOutboxPayloadSchema },
  },
  xero: {
    'accounting.post': { name: 'postAccountingEvent', schema: XeroAccountingOutboxPayloadSchema },
  },
  mintsoft: {
    'inbound.booked-in': { name: 'processBookedInEvent', schema: MintsoftBookedInOutboxPayloadSchema },
  },
})

type OperationConstants<T extends Record<string, Record<string, OutboxRegistryEntry>>> = {
  [Connector in keyof T]: {
    [Operation in keyof T[Connector] as T[Connector][Operation]['name']]: Operation
  }
}

function buildOperationConstants<T extends Record<string, Record<string, OutboxRegistryEntry>>>(
  registry: T,
): OperationConstants<T> {
  const constants: Record<string, Record<string, string>> = {}
  for (const [connector, operations] of Object.entries(registry)) {
    constants[connector] = {}
    for (const [operation, entry] of Object.entries(operations)) {
      constants[connector][entry.name] = operation
    }
  }
  return constants as OperationConstants<T>
}

export const INTEGRATION_OUTBOX_OPERATIONS = buildOperationConstants(INTEGRATION_OUTBOX_REGISTRY)

export type RegisteredOutboxConnector = keyof typeof INTEGRATION_OUTBOX_REGISTRY

export type WcStockSyncOutboxPayload = z.infer<typeof WcStockSyncOutboxPayloadSchema>
export type XeroAccountingOutboxPayload = z.infer<typeof XeroAccountingOutboxPayloadSchema>
export type MintsoftBookedInOutboxPayload = z.infer<typeof MintsoftBookedInOutboxPayloadSchema>

function getOutboxPayloadSchema(connector: string, operation: string): z.ZodTypeAny | null {
  const connectorRegistry = INTEGRATION_OUTBOX_REGISTRY[connector as RegisteredOutboxConnector]
  if (!connectorRegistry) return null
  return (connectorRegistry as Record<string, OutboxRegistryEntry>)[operation]?.schema ?? null
}

export function isRegisteredOutboxOperation(connector: string, operation: string): boolean {
  return getOutboxPayloadSchema(connector, operation) !== null
}

/**
 * Parses registered operation payloads through their Zod schemas.
 *
 * Unknown operations are returned unchanged so existing rows and future
 * connector jobs can still be claimed or replayed before they are registered.
 * That passthrough path uses the caller-provided generic type assertion only;
 * callers that need type safety for unknown operations must validate them
 * independently or check isRegisteredOutboxOperation first.
 */
export function parseIntegrationOutboxPayload<T = unknown>(input: {
  connector: string
  operation: string
  payloadJson: unknown
  rowId?: string
}): T {
  const schema = getOutboxPayloadSchema(input.connector, input.operation)
  if (!schema) return input.payloadJson as T
  const parsed = schema.safeParse(input.payloadJson)
  if (parsed.success) return parsed.data as T

  const label = input.rowId
    ? `Integration outbox payload for ${input.rowId}`
    : `Integration outbox payload for ${input.connector}/${input.operation}`
  const details = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'payload'}: ${issue.message}`).join('; ')
  throw new Error(`${label} is invalid: ${details}`)
}
