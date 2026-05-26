import { createHash } from 'crypto'

import type { Prisma, PrismaClient } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { parsePositiveIntegerEnv } from '@/lib/env'
import type { ShoppingWebhookResource } from '@/lib/shopping'

const WOOCOMMERCE_CONNECTOR = 'woocommerce' as const
const SHOPIFY_CONNECTOR = 'shopify' as const

export type ShoppingWebhookEventConnector = typeof WOOCOMMERCE_CONNECTOR | typeof SHOPIFY_CONNECTOR

export const WC_WEBHOOK_EVENT_STATUS = {
  pending: 'PENDING',
  processing: 'PROCESSING',
  processed: 'PROCESSED',
  failed: 'FAILED',
  deadLetter: 'DEAD_LETTER',
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

export type PersistShoppingWebhookEventInput = {
  resource: ShoppingWebhookResource
  topic: string | null
  externalEventId?: string | null
  rawBody: string
  payload: unknown
}

export type PersistWcWebhookEventInput = PersistShoppingWebhookEventInput

export type PersistShoppingWebhookEventResult =
  | { status: 'created'; event: WcWebhookEventRow }
  | { status: 'duplicate'; event: WcWebhookEventRow }

export type PersistWcWebhookEventResult = PersistShoppingWebhookEventResult

export type WcWebhookEventRepository = {
  createEvent(input: PersistShoppingWebhookEventInput & { connector: ShoppingWebhookEventConnector; payloadHash: string }): Promise<WcWebhookEventRow>
  findByConnectorResourceAndPayloadHash(input: {
    connector: ShoppingWebhookEventConnector
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
  markDeadLetter(input: { id: string; now: Date; error: string }): Promise<WcWebhookEventRow>
}

type ShoppingWebhookEventClient = Pick<PrismaClient, 'shoppingWebhookEvent' | '$queryRaw'>

const DEFAULT_PROCESS_PAGE_SIZE = 100
const DEFAULT_RETRY_DELAY_MS = 60_000
const MAX_RETRY_DELAY_MS = 60 * 60 * 1000
const DEFAULT_STALE_PROCESSING_MS = 15 * 60 * 1000
const DEFAULT_MAX_ATTEMPTS = 24
const DEFAULT_RETRY_JITTER_RATIO = 0.25
const MIN_RETRY_DELAY_MS = 1_000
const MAX_ERROR_LENGTH = 8 * 1024

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
  return client ?? db
}

function isUniqueConstraintError(error: unknown): boolean {
  // P2002 is Prisma's unique-constraint violation code.
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002'
}

export function hashWcWebhookPayload(rawBody: string): string {
  // Hash the exact signed body bytes. Do not stringify parsed JSON here: WC
  // redeliveries are byte-identical, and whitespace-sensitive hashing keeps
  // dedupe aligned with the signature input while avoiding extra CPU work.
  return createHash('sha256').update(rawBody).digest('hex')
}

export const hashShoppingWebhookPayload = hashWcWebhookPayload

function seededUnitInterval(seed: string): number {
  const digest = createHash('sha256').update(seed).digest()
  return digest.readUInt32BE(0) / 0xFFFF_FFFF
}

export function calculateWcWebhookRetryDelayMs(
  attempts: number,
  options: {
    jitterSeed?: string
    jitterRatio?: number
    random?: () => number
  } = {},
): number {
  const safeAttempts = Math.max(1, attempts)
  const base = Math.min(MAX_RETRY_DELAY_MS, DEFAULT_RETRY_DELAY_MS * 2 ** (safeAttempts - 1))
  const jitterRatio = options.jitterRatio ?? DEFAULT_RETRY_JITTER_RATIO
  if (jitterRatio <= 0) return base
  const unit = options.jitterSeed ? seededUnitInterval(options.jitterSeed) : (options.random ?? Math.random)()
  const jitter = base * jitterRatio * (unit * 2 - 1)
  return Math.max(MIN_RETRY_DELAY_MS, Math.floor(base + jitter))
}

export function normalizeWcWebhookError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message.length <= MAX_ERROR_LENGTH) return message
  return `${message.slice(0, MAX_ERROR_LENGTH)}... [truncated]`
}

export function createWcWebhookEventRepository(
  options: { client?: ShoppingWebhookEventClient; connector?: ShoppingWebhookEventConnector } = {},
): WcWebhookEventRepository {
  const prisma = getClient(options.client)
  const client = prisma.shoppingWebhookEvent
  const connector = options.connector ?? WOOCOMMERCE_CONNECTOR

  return {
    async createEvent(input) {
      return client.create({
        data: {
          connector,
          resource: input.resource,
          externalEventId: input.externalEventId ?? null,
          topic: input.topic,
          payloadHash: input.payloadHash,
          payloadJson: input.payload as Prisma.InputJsonValue,
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
          connector,
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
      const rows = await prisma.$queryRaw<WcWebhookEventRow[]>`
        UPDATE "shopping_webhook_events"
        SET
          "status" = ${WC_WEBHOOK_EVENT_STATUS.processing},
          "attempts" = "attempts" + 1,
          "nextAttemptAt" = NULL,
          "lastError" = NULL,
          "updatedAt" = ${now}
        WHERE "id" = ${id}
          AND "connector" = ${connector}
          AND (
            "status" = ${WC_WEBHOOK_EVENT_STATUS.pending}
            OR ("status" = ${WC_WEBHOOK_EVENT_STATUS.failed} AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= ${now}))
            OR ("status" = ${WC_WEBHOOK_EVENT_STATUS.processing} AND "updatedAt" <= ${staleProcessingBefore})
          )
        RETURNING
          "id",
          "connector",
          "resource",
          "externalEventId",
          "topic",
          "payloadHash",
          "payloadJson",
          "status",
          "attempts",
          "nextAttemptAt",
          "processedAt",
          "lastError",
          "receivedAt",
          "updatedAt"
      `
      return rows[0] ?? null
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
    async markDeadLetter(input) {
      return client.update({
        where: { id: input.id },
        data: {
          status: WC_WEBHOOK_EVENT_STATUS.deadLetter,
          lastError: input.error,
          nextAttemptAt: null,
        },
        select: eventSelect,
      })
    },
  }
}

export async function persistShoppingWebhookEvent(
  repository: WcWebhookEventRepository,
  input: PersistShoppingWebhookEventInput,
  options: {
    connector: ShoppingWebhookEventConnector
    isUniqueConstraintError?: (error: unknown) => boolean
  },
): Promise<PersistShoppingWebhookEventResult> {
  const payloadHash = hashShoppingWebhookPayload(input.rawBody)
  const uniqueError = options.isUniqueConstraintError ?? isUniqueConstraintError

  try {
    return {
      status: 'created',
      event: await repository.createEvent({
        ...input,
        connector: options.connector,
        payloadHash,
      }),
    }
  } catch (error) {
    if (!uniqueError(error)) throw error
    const existing = await repository.findByConnectorResourceAndPayloadHash({
      connector: options.connector,
      resource: input.resource,
      payloadHash,
    })
    if (!existing) {
      console.warn('[shopping-webhook-inbox] unique collision without findable duplicate', {
        connector: options.connector,
        resource: input.resource,
        payloadHash,
      })
      throw error
    }
    return { status: 'duplicate', event: existing }
  }
}

export async function persistWcWebhookEvent(
  repository: WcWebhookEventRepository,
  input: PersistWcWebhookEventInput,
  options: { isUniqueConstraintError?: (error: unknown) => boolean } = {},
): Promise<PersistWcWebhookEventResult> {
  return persistShoppingWebhookEvent(repository, input, {
    ...options,
    connector: WOOCOMMERCE_CONNECTOR,
  })
}

export async function persistShopifyWebhookEvent(
  repository: WcWebhookEventRepository,
  input: PersistShoppingWebhookEventInput,
  options: { isUniqueConstraintError?: (error: unknown) => boolean } = {},
): Promise<PersistShoppingWebhookEventResult> {
  return persistShoppingWebhookEvent(repository, input, {
    ...options,
    connector: SHOPIFY_CONNECTOR,
  })
}

export function getWcWebhookProcessPageSize(env: Record<string, string | undefined> = process.env): number {
  return parsePositiveIntegerEnv(env.WC_WEBHOOK_INBOX_PROCESS_PAGE_SIZE, DEFAULT_PROCESS_PAGE_SIZE)
}

export function getWcWebhookStaleProcessingMs(env: Record<string, string | undefined> = process.env): number {
  return parsePositiveIntegerEnv(env.WC_WEBHOOK_INBOX_STALE_PROCESSING_MS, DEFAULT_STALE_PROCESSING_MS)
}

export function getWcWebhookMaxAttempts(env: Record<string, string | undefined> = process.env): number {
  return parsePositiveIntegerEnv(env.WC_WEBHOOK_INBOX_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS)
}

export function nextWcWebhookRetryAt(options: { attempts: number; now: Date; eventId?: string }): Date {
  return new Date(options.now.getTime() + calculateWcWebhookRetryDelayMs(options.attempts, {
    jitterSeed: options.eventId ? `${options.eventId}:${options.attempts}` : undefined,
  }))
}
