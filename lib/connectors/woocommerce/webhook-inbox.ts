import { createHash } from 'crypto'

import { db } from '@/lib/db'
import type { ShoppingWebhookResource } from '@/lib/shopping'

export const WC_WEBHOOK_EVENT_STATUS = {
  pending: 'PENDING',
  processing: 'PROCESSING',
  processed: 'PROCESSED',
  failed: 'FAILED',
} as const

export type WcWebhookEventStatus =
  typeof WC_WEBHOOK_EVENT_STATUS[keyof typeof WC_WEBHOOK_EVENT_STATUS]

export type WcWebhookEventRow = {
  id: string
  connector: string
  resource: string
  externalEventId: string | null
  topic: string | null
  payloadHash: string
  payloadJson: unknown
  status: string
  attempts: number
  nextAttemptAt: Date | null
  processedAt: Date | null
  lastError: string | null
  receivedAt: Date
  updatedAt: Date
}

export type PersistWcWebhookEventInput = {
  resource: ShoppingWebhookResource
  topic: string | null
  externalEventId?: string | null
  rawBody: string
  payload: unknown
}

export type PersistWcWebhookEventResult =
  | { status: 'created'; event: WcWebhookEventRow }
  | { status: 'duplicate'; event: WcWebhookEventRow }

export type WcWebhookEventRepository = {
  createEvent(input: PersistWcWebhookEventInput & { connector: 'woocommerce'; payloadHash: string }): Promise<WcWebhookEventRow>
  findByConnectorResourceAndPayloadHash(input: {
    connector: 'woocommerce'
    resource: ShoppingWebhookResource
    payloadHash: string
  }): Promise<WcWebhookEventRow | null>
  findDueEvents(input: {
    now: Date
    take: number
    staleProcessingBefore: Date
  }): Promise<Array<Pick<WcWebhookEventRow, 'id'>>>
  claimEvent(id: string, now: Date, staleProcessingBefore: Date): Promise<WcWebhookEventRow | null>
  markProcessed(id: string, now: Date): Promise<WcWebhookEventRow>
  markFailed(input: { id: string; now: Date; error: string; nextAttemptAt: Date }): Promise<WcWebhookEventRow>
}

type ShoppingWebhookEventDelegate = {
  create(args: unknown): Promise<WcWebhookEventRow>
  findUnique(args: unknown): Promise<WcWebhookEventRow | null>
  findMany(args: unknown): Promise<Array<Pick<WcWebhookEventRow, 'id'>>>
  update(args: unknown): Promise<WcWebhookEventRow>
  updateMany(args: unknown): Promise<{ count: number }>
}

type ShoppingWebhookEventClient = {
  shoppingWebhookEvent: ShoppingWebhookEventDelegate
}

const DEFAULT_PROCESS_PAGE_SIZE = 100
const DEFAULT_RETRY_DELAY_MS = 60_000
const MAX_RETRY_DELAY_MS = 60 * 60 * 1000
const DEFAULT_STALE_PROCESSING_MS = 15 * 60 * 1000

const eventSelect = {
  id: true,
  connector: true,
  resource: true,
  externalEventId: true,
  topic: true,
  payloadHash: true,
  payloadJson: true,
  status: true,
  attempts: true,
  nextAttemptAt: true,
  processedAt: true,
  lastError: true,
  receivedAt: true,
  updatedAt: true,
}

function getClient(client?: ShoppingWebhookEventClient): ShoppingWebhookEventClient {
  return client ?? (db as unknown as ShoppingWebhookEventClient)
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002'
}

export function hashWcWebhookPayload(rawBody: string): string {
  return createHash('sha256').update(rawBody).digest('hex')
}

export function calculateWcWebhookRetryDelayMs(attempts: number): number {
  const safeAttempts = Math.max(1, attempts)
  return Math.min(MAX_RETRY_DELAY_MS, DEFAULT_RETRY_DELAY_MS * 2 ** (safeAttempts - 1))
}

export function normalizeWcWebhookError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export function createWcWebhookEventRepository(
  options: { client?: ShoppingWebhookEventClient } = {},
): WcWebhookEventRepository {
  const client = getClient(options.client).shoppingWebhookEvent

  return {
    async createEvent(input) {
      return client.create({
        data: {
          connector: input.connector,
          resource: input.resource,
          externalEventId: input.externalEventId ?? null,
          topic: input.topic,
          payloadHash: input.payloadHash,
          payloadJson: input.payload,
          status: WC_WEBHOOK_EVENT_STATUS.pending,
          attempts: 0,
          nextAttemptAt: null,
          processedAt: null,
          lastError: null,
        },
        select: eventSelect,
      })
    },
    async findByConnectorResourceAndPayloadHash(input) {
      return client.findUnique({
        where: {
          connector_resource_payloadHash: {
            connector: input.connector,
            resource: input.resource,
            payloadHash: input.payloadHash,
          },
        },
        select: eventSelect,
      })
    },
    async findDueEvents(input) {
      return client.findMany({
        where: {
          connector: 'woocommerce',
          OR: [
            { status: WC_WEBHOOK_EVENT_STATUS.pending },
            {
              status: WC_WEBHOOK_EVENT_STATUS.failed,
              OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: input.now } }],
            },
            {
              status: WC_WEBHOOK_EVENT_STATUS.processing,
              updatedAt: { lte: input.staleProcessingBefore },
            },
          ],
        },
        orderBy: { receivedAt: 'asc' },
        select: { id: true },
        take: input.take,
      })
    },
    async claimEvent(id, now, staleProcessingBefore) {
      const updated = await client.updateMany({
        where: {
          id,
          connector: 'woocommerce',
          OR: [
            { status: WC_WEBHOOK_EVENT_STATUS.pending },
            {
              status: WC_WEBHOOK_EVENT_STATUS.failed,
              OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
            },
            {
              status: WC_WEBHOOK_EVENT_STATUS.processing,
              updatedAt: { lte: staleProcessingBefore },
            },
          ],
        },
        data: {
          status: WC_WEBHOOK_EVENT_STATUS.processing,
          attempts: { increment: 1 },
          nextAttemptAt: null,
          lastError: null,
        },
      })
      if (updated.count === 0) return null
      return client.findUnique({ where: { id }, select: eventSelect })
    },
    async markProcessed(id, now) {
      return client.update({
        where: { id },
        data: {
          status: WC_WEBHOOK_EVENT_STATUS.processed,
          processedAt: now,
          nextAttemptAt: null,
          lastError: null,
        },
        select: eventSelect,
      })
    },
    async markFailed(input) {
      return client.update({
        where: { id: input.id },
        data: {
          status: WC_WEBHOOK_EVENT_STATUS.failed,
          lastError: input.error,
          nextAttemptAt: input.nextAttemptAt,
        },
        select: eventSelect,
      })
    },
  }
}

export async function persistWcWebhookEvent(
  repository: WcWebhookEventRepository,
  input: PersistWcWebhookEventInput,
  options: { isUniqueConstraintError?: (error: unknown) => boolean } = {},
): Promise<PersistWcWebhookEventResult> {
  const payloadHash = hashWcWebhookPayload(input.rawBody)
  const uniqueError = options.isUniqueConstraintError ?? isUniqueConstraintError

  try {
    return {
      status: 'created',
      event: await repository.createEvent({
        ...input,
        connector: 'woocommerce',
        payloadHash,
      }),
    }
  } catch (error) {
    if (!uniqueError(error)) throw error
    const existing = await repository.findByConnectorResourceAndPayloadHash({
      connector: 'woocommerce',
      resource: input.resource,
      payloadHash,
    })
    if (!existing) throw error
    return { status: 'duplicate', event: existing }
  }
}

export function getWcWebhookProcessPageSize(env: Record<string, string | undefined> = process.env): number {
  const raw = env.WC_WEBHOOK_INBOX_PROCESS_PAGE_SIZE?.trim()
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_PROCESS_PAGE_SIZE
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_PROCESS_PAGE_SIZE
}

export function getWcWebhookStaleProcessingMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.WC_WEBHOOK_INBOX_STALE_PROCESSING_MS?.trim()
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_STALE_PROCESSING_MS
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_STALE_PROCESSING_MS
}

export function nextWcWebhookRetryAt(options: { attempts: number; now: Date }): Date {
  return new Date(options.now.getTime() + calculateWcWebhookRetryDelayMs(options.attempts))
}
