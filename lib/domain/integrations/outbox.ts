import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { parseIntegrationOutboxPayload } from '@/lib/domain/integrations/outbox-registry'

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
  idempotencyKeys?: string[]
  limit?: number
  workerId: string
  now?: Date
  staleLockMs?: number
  maxAttempts?: number
}

export type MarkIntegrationOutboxFailureOptions = {
  client?: IntegrationOutboxClient
  id: string
  workerId: string
  lockedAt: Date
  error: unknown
  now?: Date
  maxAttempts?: number
}

export type MarkIntegrationOutboxRetryableFailureOptions = MarkIntegrationOutboxFailureOptions & {
  attemptsBeforeFailure: number
  retryDelayMs?: number
  retryBaseDelayMs?: number
  retryMaxDelayMs?: number
  retryJitterMs?: number
  retryJitterRandom?: () => number
}

export type MarkIntegrationOutboxSuccessOptions = {
  client?: IntegrationOutboxClient
  id: string
  workerId: string
  lockedAt: Date
}

class IntegrationOutboxClaimConflictError extends Error {}

const CLAIMABLE_STATUSES = [
  INTEGRATION_OUTBOX_STATUS.PENDING,
  INTEGRATION_OUTBOX_STATUS.RETRYABLE_FAILED,
] as const
const DEFAULT_CLAIM_LIMIT = 25
const DEFAULT_STALE_LOCK_MS = 10 * 60 * 1000
const DEFAULT_RETRY_BASE_DELAY_MS = 5 * 60 * 1000
const DEFAULT_RETRY_MAX_DELAY_MS = 60 * 60 * 1000
const DEFAULT_RETRY_JITTER_MS = 30 * 1000
const DEFAULT_MINIMUM_JITTER_RATIO = 0.05
const EXPONENTIAL_ATTEMPT_CAP = 30
export const DEFAULT_INTEGRATION_OUTBOX_MAX_ATTEMPTS = 5
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

function configuredPositiveMs(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw == null || raw.trim() === '') return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.floor(parsed)
}

function configuredNonNegativeMs(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw == null || raw.trim() === '') return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) return fallback
  return Math.floor(parsed)
}

function normalizeDelayMs(delayMs: number): number {
  if (!Number.isFinite(delayMs)) return 0
  return Math.max(0, Math.floor(delayMs))
}

/**
 * Computes retry delay as exponential backoff plus tail jitter.
 *
 * Tail jitter only moves retries later than the exponential schedule, which
 * preserves a predictable minimum wait while spreading workers after connector
 * outages. A small jitter floor still applies when configured jitter is zero to
 * avoid synchronized retry bursts.
 */
export function calculateIntegrationOutboxRetryDelayMs(options: {
  attemptsBeforeFailure: number
  baseDelayMs?: number
  maxDelayMs?: number
  jitterMs?: number
  random?: () => number
}): number {
  // Retry config is read per call so tests and one-off jobs can exercise env
  // fallback behavior without reloading the module. Production changes still
  // require a process restart to affect running workers predictably.
  const attemptsBeforeFailure = Math.max(0, Math.floor(options.attemptsBeforeFailure))
  const baseDelayMs = normalizeDelayMs(
    options.baseDelayMs ?? configuredPositiveMs('OUTBOX_RETRY_BASE_MS', DEFAULT_RETRY_BASE_DELAY_MS),
  )
  const maxDelayMs = normalizeDelayMs(
    options.maxDelayMs ?? configuredPositiveMs('OUTBOX_RETRY_MAX_MS', DEFAULT_RETRY_MAX_DELAY_MS),
  )
  const jitterMs = normalizeDelayMs(
    options.jitterMs ?? configuredNonNegativeMs('OUTBOX_RETRY_JITTER_MS', DEFAULT_RETRY_JITTER_MS),
  )
  const random = options.random ?? Math.random
  const jitterRatio = Math.min(1, Math.max(0, random()))
  // Tail jitter preserves the exponential minimum and only pushes jobs later,
  // avoiding early retries while spreading workers after connector outages.
  const effectiveJitterMs = Math.max(jitterMs, Math.floor(baseDelayMs * DEFAULT_MINIMUM_JITTER_RATIO))
  const jitterDelayMs = Math.floor(effectiveJitterMs * jitterRatio)
  const cappedAttempts = Math.min(attemptsBeforeFailure, EXPONENTIAL_ATTEMPT_CAP)
  const exponentialDelayMs = baseDelayMs * (2 ** cappedAttempts)
  return Math.min(exponentialDelayMs + jitterDelayMs, maxDelayMs)
}

function normalizeIdempotencyPart(part: string | number | Date): string {
  const value = part instanceof Date ? part.toISOString().slice(0, 10) : String(part)
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '')
  if (!normalized) throw new Error('Integration outbox idempotency key parts must not be blank')
  return normalized
}

export function buildOutboxIdempotencyKey(
  connector: string,
  operation: string,
  ...parts: Array<string | number | Date>
): string {
  if (parts.length === 0) throw new Error('At least one integration outbox idempotency key part is required')
  return [connector, operation, ...parts].map(normalizeIdempotencyPart).join(':')
}

function isIdempotencyKeyConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return false
  const target = error.meta?.target
  if (target == null && error.meta?.modelName === 'IntegrationOutbox') return true
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
  idempotencyKeys?: string[]
  now: Date
  staleLockMs: number
  maxAttempts: number
}): unknown {
  const staleLockedBefore = new Date(options.now.getTime() - options.staleLockMs)
  return {
    ...(options.connector ? { connector: options.connector } : {}),
    ...(options.operation ? { operation: options.operation } : {}),
    ...(options.idempotencyKeys && options.idempotencyKeys.length > 0
      ? { idempotencyKey: { in: [...new Set(options.idempotencyKeys)] } }
      : {}),
    attempts: { lt: options.maxAttempts },
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

function claimUpdateWhere(row: IntegrationOutboxRow, now: Date, maxAttempts: number): unknown {
  if (row.status === INTEGRATION_OUTBOX_STATUS.PROCESSING) {
    return {
      id: row.id,
      status: INTEGRATION_OUTBOX_STATUS.PROCESSING,
      attempts: { lt: maxAttempts },
      lockedAt: row.lockedAt,
      lockedBy: row.lockedBy,
    }
  }

  return {
    id: row.id,
    status: { in: [...CLAIMABLE_STATUSES] },
    attempts: { lt: maxAttempts },
    AND: [
      dueAtOrBefore(now),
      row.lockedAt ? { lockedAt: row.lockedAt } : { lockedAt: null },
    ],
  }
}

function positiveLimit(limit: number | undefined): number {
  return Math.max(1, Math.floor(limit ?? DEFAULT_CLAIM_LIMIT))
}

function positiveMaxAttempts(maxAttempts: number | undefined): number {
  return Math.max(1, Math.floor(maxAttempts ?? DEFAULT_INTEGRATION_OUTBOX_MAX_ATTEMPTS))
}

async function requireOutboxRow(client: IntegrationOutboxClient, id: string): Promise<IntegrationOutboxRow> {
  const row = await client.integrationOutbox.findUnique({ where: { id } })
  if (!row) throw new Error(`Integration outbox row ${id} was not found`)
  return row
}

function claimedBy(options: { id: string; workerId: string; lockedAt: Date }): Record<string, unknown> {
  return {
    id: options.id,
    status: INTEGRATION_OUTBOX_STATUS.PROCESSING,
    lockedBy: options.workerId,
    lockedAt: options.lockedAt,
  }
}

async function updateClaimedOutboxRow(
  client: IntegrationOutboxClient,
  options: { id: string; workerId: string; lockedAt: Date; data: unknown; where?: Record<string, unknown> },
): Promise<IntegrationOutboxRow> {
  const result = await client.integrationOutbox.updateMany({
    where: { ...claimedBy(options), ...(options.where ?? {}) },
    data: options.data,
  })
  if (result.count === 0) {
    throw new IntegrationOutboxClaimConflictError(
      `Integration outbox row ${options.id} is not claimed by ${options.workerId}`,
    )
  }
  return requireOutboxRow(client, options.id)
}

export async function enqueueIntegrationOutbox(
  input: EnqueueIntegrationOutboxInput,
  options: { client?: IntegrationOutboxClient } = {},
): Promise<IntegrationOutboxRow> {
  const client = getClient(options.client)
  const payloadJson = parseIntegrationOutboxPayload({
    connector: input.connector,
    operation: input.operation,
    payloadJson: input.payloadJson,
  })
  try {
    return await client.integrationOutbox.create({
      data: {
        connector: input.connector,
        operation: input.operation,
        idempotencyKey: input.idempotencyKey,
        payloadJson,
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
  const maxAttempts = positiveMaxAttempts(options.maxAttempts)
  const candidates = await client.integrationOutbox.findMany({
    where: claimableWhere({
      connector: options.connector,
      operation: options.operation,
      idempotencyKeys: options.idempotencyKeys,
      now,
      staleLockMs,
      maxAttempts,
    }),
    orderBy: { createdAt: 'asc' },
    take: positiveLimit(options.limit),
  })

  const claimed: IntegrationOutboxRow[] = []
  for (const row of candidates) {
    const result = await client.integrationOutbox.updateMany({
      where: claimUpdateWhere(row, now, maxAttempts),
      data: {
        status: INTEGRATION_OUTBOX_STATUS.PROCESSING,
        lockedAt: now,
        lockedBy: options.workerId,
      },
    })
    if (result.count === 0) continue
    claimed.push(await requireOutboxRow(client, row.id))
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
  options: MarkIntegrationOutboxRetryableFailureOptions,
): Promise<IntegrationOutboxRow> {
  const client = getClient(options.client)
  const now = options.now ?? new Date()
  const maxAttempts = positiveMaxAttempts(options.maxAttempts)
  const retryDelayMs = options.retryDelayMs === undefined
    ? calculateIntegrationOutboxRetryDelayMs({
      attemptsBeforeFailure: options.attemptsBeforeFailure,
      baseDelayMs: options.retryBaseDelayMs,
      maxDelayMs: options.retryMaxDelayMs,
      jitterMs: options.retryJitterMs,
      random: options.retryJitterRandom,
    })
    : normalizeDelayMs(options.retryDelayMs)

  const retryableUpdate = await client.integrationOutbox.updateMany({
    where: {
      ...claimedBy(options),
      attempts: { lt: maxAttempts - 1 },
    },
    data: {
      status: INTEGRATION_OUTBOX_STATUS.RETRYABLE_FAILED,
      attempts: { increment: 1 },
      nextAttemptAt: new Date(now.getTime() + retryDelayMs),
      lastError: truncateError(options.error),
      lockedAt: null,
      lockedBy: null,
    },
  })
  if (retryableUpdate.count > 0) {
    return requireOutboxRow(client, options.id)
  }

  return updateClaimedOutboxRow(client, {
    id: options.id,
    workerId: options.workerId,
    lockedAt: options.lockedAt,
    where: { attempts: { gte: maxAttempts - 1 } },
    data: {
      status: INTEGRATION_OUTBOX_STATUS.PERMANENT_FAILED,
      attempts: { increment: 1 },
      nextAttemptAt: null,
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
  return updateClaimedOutboxRow(client, {
    id: options.id,
    workerId: options.workerId,
    lockedAt: options.lockedAt,
    data: {
      status: INTEGRATION_OUTBOX_STATUS.PERMANENT_FAILED,
      attempts: { increment: 1 },
      nextAttemptAt: null,
      lastError: truncateError(options.error),
      lockedAt: null,
      lockedBy: null,
    },
  })
}
