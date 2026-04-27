import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'

export const INTEGRATION_OUTBOX_STATUS = {
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  SUCCEEDED: 'SUCCEEDED',
  RETRYABLE_FAILED: 'RETRYABLE_FAILED',
  PERMANENT_FAILED: 'PERMANENT_FAILED',
} as const

export type IntegrationOutboxStatus = typeof INTEGRATION_OUTBOX_STATUS[keyof typeof INTEGRATION_OUTBOX_STATUS]

export type IntegrationOutboxRow = {
  id: string
  connector: string
  operation: string
  idempotencyKey: string
  payloadJson: unknown
  status: string
  attempts: number
  nextAttemptAt: Date | null
  lastError: string | null
  lockedAt: Date | null
  lockedBy: string | null
  createdAt: Date
  updatedAt: Date
}

type IntegrationOutboxDelegate = {
  create(args: unknown): Promise<IntegrationOutboxRow>
  findUnique(args: unknown): Promise<IntegrationOutboxRow | null>
  findMany(args: unknown): Promise<IntegrationOutboxRow[]>
  updateMany(args: unknown): Promise<{ count: number }>
}

export type IntegrationOutboxClient = {
  integrationOutbox: IntegrationOutboxDelegate
}

export type EnqueueIntegrationOutboxInput = {
  connector: string
  operation: string
  idempotencyKey: string
  payloadJson: unknown
  nextAttemptAt?: Date | null
}

export type ClaimIntegrationOutboxOptions = {
  client?: IntegrationOutboxClient
  connector?: string
  operation?: string
  limit?: number
  workerId: string
  now?: Date
  staleLockMs?: number
}

export type MarkIntegrationOutboxFailureOptions = {
  client?: IntegrationOutboxClient
  id: string
  workerId: string
  lockedAt: Date
  error: unknown
  now?: Date
  retryDelayMs?: number
}

export type MarkIntegrationOutboxSuccessOptions = {
  client?: IntegrationOutboxClient
  id: string
  workerId: string
  lockedAt: Date
}

const CLAIMABLE_STATUSES = [
  INTEGRATION_OUTBOX_STATUS.PENDING,
  INTEGRATION_OUTBOX_STATUS.RETRYABLE_FAILED,
] as const
const DEFAULT_CLAIM_LIMIT = 25
const DEFAULT_STALE_LOCK_MS = 10 * 60 * 1000
const DEFAULT_RETRY_DELAY_MS = 5 * 60 * 1000
const MAX_ERROR_LENGTH = 1000

function getClient(client?: IntegrationOutboxClient): IntegrationOutboxClient {
  return client ?? (db as unknown as IntegrationOutboxClient)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function truncateError(error: unknown): string {
  return errorMessage(error).slice(0, MAX_ERROR_LENGTH)
}

function isIdempotencyKeyConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return false
  const target = error.meta?.target
  return Array.isArray(target)
    ? target.includes('idempotencyKey')
    : String(target).includes('idempotencyKey')
}

function dueAtOrBefore(now: Date): unknown {
  return { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] }
}

function unlockedOrStale(now: Date, staleLockMs: number): unknown {
  return { OR: [{ lockedAt: null }, { lockedAt: { lt: new Date(now.getTime() - staleLockMs) } }] }
}

function claimableWhere(options: {
  connector?: string
  operation?: string
  now: Date
  staleLockMs: number
}): unknown {
  const staleLockedBefore = new Date(options.now.getTime() - options.staleLockMs)
  return {
    ...(options.connector ? { connector: options.connector } : {}),
    ...(options.operation ? { operation: options.operation } : {}),
    OR: [
      {
        status: { in: [...CLAIMABLE_STATUSES] },
        AND: [
          dueAtOrBefore(options.now),
          unlockedOrStale(options.now, options.staleLockMs),
        ],
      },
      {
        status: INTEGRATION_OUTBOX_STATUS.PROCESSING,
        lockedAt: { lt: staleLockedBefore },
      },
    ],
  }
}

function claimUpdateWhere(row: IntegrationOutboxRow, now: Date): unknown {
  if (row.status === INTEGRATION_OUTBOX_STATUS.PROCESSING) {
    return {
      id: row.id,
      status: INTEGRATION_OUTBOX_STATUS.PROCESSING,
      lockedAt: row.lockedAt,
      lockedBy: row.lockedBy,
    }
  }

  return {
    id: row.id,
    status: { in: [...CLAIMABLE_STATUSES] },
    AND: [
      dueAtOrBefore(now),
      row.lockedAt ? { lockedAt: row.lockedAt } : { lockedAt: null },
    ],
  }
}

function positiveLimit(limit: number | undefined): number {
  return Math.max(1, Math.floor(limit ?? DEFAULT_CLAIM_LIMIT))
}

async function requireOutboxRow(client: IntegrationOutboxClient, id: string): Promise<IntegrationOutboxRow> {
  const row = await client.integrationOutbox.findUnique({ where: { id } })
  if (!row) throw new Error(`Integration outbox row ${id} was not found`)
  return row
}

function claimedBy(options: { id: string; workerId: string; lockedAt: Date }): unknown {
  return {
    id: options.id,
    status: INTEGRATION_OUTBOX_STATUS.PROCESSING,
    lockedBy: options.workerId,
    lockedAt: options.lockedAt,
  }
}

async function updateClaimedOutboxRow(
  client: IntegrationOutboxClient,
  options: { id: string; workerId: string; lockedAt: Date; data: unknown },
): Promise<IntegrationOutboxRow> {
  const result = await client.integrationOutbox.updateMany({
    where: claimedBy(options),
    data: options.data,
  })
  if (result.count === 0) {
    throw new Error(`Integration outbox row ${options.id} is not claimed by ${options.workerId}`)
  }
  return requireOutboxRow(client, options.id)
}

export async function enqueueIntegrationOutbox(
  input: EnqueueIntegrationOutboxInput,
  options: { client?: IntegrationOutboxClient } = {},
): Promise<IntegrationOutboxRow> {
  const client = getClient(options.client)
  try {
    return await client.integrationOutbox.create({
      data: {
        connector: input.connector,
        operation: input.operation,
        idempotencyKey: input.idempotencyKey,
        payloadJson: input.payloadJson,
        status: INTEGRATION_OUTBOX_STATUS.PENDING,
        attempts: 0,
        nextAttemptAt: input.nextAttemptAt ?? null,
        lastError: null,
        lockedAt: null,
        lockedBy: null,
      },
    })
  } catch (error) {
    if (!isIdempotencyKeyConflict(error)) throw error
    const existing = await client.integrationOutbox.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    })
    if (existing) return existing
    throw error
  }
}

export async function claimIntegrationOutboxWork(
  options: ClaimIntegrationOutboxOptions,
): Promise<IntegrationOutboxRow[]> {
  const client = getClient(options.client)
  const now = options.now ?? new Date()
  const staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS
  const candidates = await client.integrationOutbox.findMany({
    where: claimableWhere({
      connector: options.connector,
      operation: options.operation,
      now,
      staleLockMs,
    }),
    orderBy: { createdAt: 'asc' },
    take: positiveLimit(options.limit),
  })

  const claimed: IntegrationOutboxRow[] = []
  for (const row of candidates) {
    const result = await client.integrationOutbox.updateMany({
      where: claimUpdateWhere(row, now),
      data: {
        status: INTEGRATION_OUTBOX_STATUS.PROCESSING,
        lockedAt: now,
        lockedBy: options.workerId,
      },
    })
    if (result.count === 0) continue
    claimed.push({
      ...row,
      status: INTEGRATION_OUTBOX_STATUS.PROCESSING,
      lockedAt: now,
      lockedBy: options.workerId,
      updatedAt: now,
    })
  }

  return claimed
}

export async function markIntegrationOutboxSuccess(
  options: MarkIntegrationOutboxSuccessOptions,
): Promise<IntegrationOutboxRow> {
  const client = getClient(options.client)
  return updateClaimedOutboxRow(client, {
    id: options.id,
    workerId: options.workerId,
    lockedAt: options.lockedAt,
    data: {
      status: INTEGRATION_OUTBOX_STATUS.SUCCEEDED,
      nextAttemptAt: null,
      lastError: null,
      lockedAt: null,
      lockedBy: null,
    },
  })
}

export async function markIntegrationOutboxRetryableFailure(
  options: MarkIntegrationOutboxFailureOptions,
): Promise<IntegrationOutboxRow> {
  const client = getClient(options.client)
  const now = options.now ?? new Date()
  const row = await requireOutboxRow(client, options.id)
  const attempts = row.attempts + 1
  return updateClaimedOutboxRow(client, {
    id: options.id,
    workerId: options.workerId,
    lockedAt: options.lockedAt,
    data: {
      status: INTEGRATION_OUTBOX_STATUS.RETRYABLE_FAILED,
      attempts,
      nextAttemptAt: new Date(now.getTime() + (options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS)),
      lastError: truncateError(options.error),
      lockedAt: null,
      lockedBy: null,
    },
  })
}

export async function markIntegrationOutboxPermanentFailure(
  options: MarkIntegrationOutboxFailureOptions,
): Promise<IntegrationOutboxRow> {
  const client = getClient(options.client)
  const row = await requireOutboxRow(client, options.id)
  return updateClaimedOutboxRow(client, {
    id: options.id,
    workerId: options.workerId,
    lockedAt: options.lockedAt,
    data: {
      status: INTEGRATION_OUTBOX_STATUS.PERMANENT_FAILED,
      attempts: row.attempts + 1,
      nextAttemptAt: null,
      lastError: truncateError(options.error),
      lockedAt: null,
      lockedBy: null,
    },
  })
}
