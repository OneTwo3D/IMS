import { db } from '@/lib/db'
import {
  INTEGRATION_OUTBOX_STATUS,
  type IntegrationOutboxClient,
  type IntegrationOutboxRow,
  type IntegrationOutboxStatus,
} from '@/lib/domain/integrations/outbox'

const ADMIN_OUTBOX_DEFAULT_LIMIT = 50
export const ADMIN_OUTBOX_MAX_LIMIT = 100
export const ADMIN_OUTBOX_STALE_PROCESSING_LOCK_MS = 10 * 60 * 1000
const REDACTED_VALUE = '[redacted]'
const SENSITIVE_SINGLE_KEYS = new Set(['authorization', 'secret', 'password', 'token', 'bearer', 'creds', 'cred', 'pwd', 'salt', 'hmac', 'signature'])
const SENSITIVE_KEY_PAIRS = new Set([
  'access_token',
  'api_key',
  'bearer_token',
  'client_secret',
  'consumer_key',
  'consumer_secret',
  'private_key',
  'refresh_token',
])

const REPLAYABLE_STATUSES = [
  INTEGRATION_OUTBOX_STATUS.RETRYABLE_FAILED,
  INTEGRATION_OUTBOX_STATUS.PERMANENT_FAILED,
] as const

const PERMANENT_FAILABLE_STATUSES = [
  INTEGRATION_OUTBOX_STATUS.PENDING,
  INTEGRATION_OUTBOX_STATUS.PROCESSING,
  INTEGRATION_OUTBOX_STATUS.RETRYABLE_FAILED,
  INTEGRATION_OUTBOX_STATUS.PERMANENT_FAILED,
] as const

export type AdminIntegrationOutboxRow = Omit<IntegrationOutboxRow, 'payloadJson'> & {
  payloadJson: unknown
}

export type ListIntegrationOutboxAdminOptions = {
  client?: IntegrationOutboxClient
  connector?: string
  operation?: string
  status?: string
  createdFrom?: Date
  createdTo?: Date
  olderThanMs?: number
  oldestPending?: boolean
  permanentFailed?: boolean
  cursor?: string
  limit?: number
  now?: Date
}

export type ListIntegrationOutboxAdminResult = {
  rows: AdminIntegrationOutboxRow[]
  hasMore: boolean
  nextCursor: string | null
  limit: number
}

export type IntegrationOutboxAdminTransitionResult = {
  row: AdminIntegrationOutboxRow
  priorStatus: string
  priorLastError: string | null
}

export class IntegrationOutboxAdminError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(message)
    this.name = 'IntegrationOutboxAdminError'
  }
}

function getClient(client?: IntegrationOutboxClient): IntegrationOutboxClient {
  return client ?? (db as unknown as IntegrationOutboxClient)
}

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined) return ADMIN_OUTBOX_DEFAULT_LIMIT
  if (!Number.isFinite(limit)) {
    throw new IntegrationOutboxAdminError('limit must be a finite number', 400, 'invalid_limit')
  }
  return Math.min(ADMIN_OUTBOX_MAX_LIMIT, Math.max(1, Math.floor(limit)))
}

function isKnownStatus(status: string): status is IntegrationOutboxStatus {
  return (Object.values(INTEGRATION_OUTBOX_STATUS) as string[]).includes(status)
}

function includesStatus(statuses: readonly string[], status: string): boolean {
  return statuses.includes(status)
}

function requiredStatus(options: ListIntegrationOutboxAdminOptions): string | undefined {
  if (options.oldestPending && options.permanentFailed) {
    throw new IntegrationOutboxAdminError(
      'oldestPending and permanentFailed filters cannot be combined',
      400,
      'conflicting_status_filters',
    )
  }

  const forcedStatus = options.oldestPending
    ? INTEGRATION_OUTBOX_STATUS.PENDING
    : options.permanentFailed
      ? INTEGRATION_OUTBOX_STATUS.PERMANENT_FAILED
      : undefined

  if (options.status !== undefined && !isKnownStatus(options.status)) {
    throw new IntegrationOutboxAdminError(`Unknown integration outbox status: ${options.status}`, 400, 'invalid_status')
  }
  if (forcedStatus && options.status && options.status !== forcedStatus) {
    throw new IntegrationOutboxAdminError(
      `status=${options.status} conflicts with the requested outbox shortcut filter`,
      400,
      'conflicting_status_filters',
    )
  }
  return forcedStatus ?? options.status
}

function createdAtFilter(options: ListIntegrationOutboxAdminOptions): Record<string, Date> | undefined {
  const filter: Record<string, Date> = {}
  if (options.createdFrom) filter.gte = options.createdFrom
  if (options.createdTo) filter.lte = options.createdTo
  if (options.olderThanMs !== undefined) {
    if (!Number.isFinite(options.olderThanMs) || options.olderThanMs < 0) {
      throw new IntegrationOutboxAdminError('olderThanMs must be a non-negative finite number', 400, 'invalid_age_filter')
    }
    const ageCutoff = new Date((options.now ?? new Date()).getTime() - Math.floor(options.olderThanMs))
    filter.lte = filter.lte && filter.lte < ageCutoff ? filter.lte : ageCutoff
  }
  if (filter.gte && filter.lte && filter.gte > filter.lte) {
    throw new IntegrationOutboxAdminError('createdFrom must be before or equal to createdTo', 400, 'invalid_date_range')
  }
  return Object.keys(filter).length > 0 ? filter : undefined
}

function listWhere(options: ListIntegrationOutboxAdminOptions): Record<string, unknown> {
  const status = requiredStatus(options)
  const createdAt = createdAtFilter(options)
  return {
    ...(options.connector ? { connector: options.connector } : {}),
    ...(options.operation ? { operation: options.operation } : {}),
    ...(status ? { status } : {}),
    ...(createdAt ? { createdAt } : {}),
  }
}

function sensitiveKeyTokens(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/g)
    .map((token) => token.toLowerCase())
    .filter(Boolean)
}

export function isSensitiveIntegrationOutboxPayloadKey(key: string): boolean {
  const tokens = sensitiveKeyTokens(key)
  if (tokens.length === 0) return false
  if (tokens.length === 1) return SENSITIVE_SINGLE_KEYS.has(tokens[0])
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (SENSITIVE_KEY_PAIRS.has(`${tokens[index]}_${tokens[index + 1]}`)) return true
  }
  return false
}

function cloneAndRedact(value: unknown, key?: string, seen = new WeakSet<object>()): unknown {
  if (key && isSensitiveIntegrationOutboxPayloadKey(key)) return REDACTED_VALUE
  if (value == null || typeof value !== 'object') return value
  if (value instanceof Date) return value.toISOString()
  if (seen.has(value)) return REDACTED_VALUE
  seen.add(value)
  if (Array.isArray(value)) return value.map((item) => cloneAndRedact(item, undefined, seen))
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
      childKey,
      cloneAndRedact(childValue, childKey, seen),
    ]),
  )
}

/**
 * Redacts values based on payload key names only. It intentionally does not
 * scan arbitrary string values, so callers must avoid putting secrets inside
 * non-sensitive fields such as free-text descriptions.
 */
export function redactIntegrationOutboxPayload(payloadJson: unknown): unknown {
  return cloneAndRedact(payloadJson)
}

export function toAdminIntegrationOutboxRow(row: IntegrationOutboxRow): AdminIntegrationOutboxRow {
  return {
    ...row,
    payloadJson: redactIntegrationOutboxPayload(row.payloadJson),
  }
}

export async function listIntegrationOutboxAdminRows(
  options: ListIntegrationOutboxAdminOptions = {},
): Promise<ListIntegrationOutboxAdminResult> {
  const client = getClient(options.client)
  const limit = boundedLimit(options.limit)
  const rows = await client.integrationOutbox.findMany({
    where: listWhere(options),
    orderBy: options.oldestPending ? [{ createdAt: 'asc' }, { id: 'asc' }] : [{ updatedAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
  })
  const pageRows = rows.slice(0, limit)

  return {
    rows: pageRows.map(toAdminIntegrationOutboxRow),
    hasMore: rows.length > limit,
    nextCursor: rows.length > limit ? pageRows.at(-1)?.id ?? null : null,
    limit,
  }
}

async function requireRow(client: IntegrationOutboxClient, id: string): Promise<IntegrationOutboxRow> {
  const row = await client.integrationOutbox.findUnique({ where: { id } })
  if (!row) throw new IntegrationOutboxAdminError(`Integration outbox row ${id} was not found`, 404, 'not_found')
  return row
}

export async function replayIntegrationOutboxAdminRow(options: {
  client?: IntegrationOutboxClient
  id: string
  now?: Date
}): Promise<IntegrationOutboxAdminTransitionResult> {
  const client = getClient(options.client)
  const prior = await requireRow(client, options.id)
  const priorStatus = prior.status
  const priorLastError = prior.lastError
  if (!includesStatus(REPLAYABLE_STATUSES, prior.status)) {
    throw new IntegrationOutboxAdminError(
      `Integration outbox row ${options.id} is ${prior.status}; only failed rows can be replayed`,
      409,
      'not_replayable',
    )
  }

  const now = options.now ?? new Date()
  const result = await client.integrationOutbox.updateMany({
    where: { id: options.id, status: { in: [...REPLAYABLE_STATUSES] } },
    data: {
      status: INTEGRATION_OUTBOX_STATUS.PENDING,
      attempts: 0,
      nextAttemptAt: now,
      lastError: null,
      lockedAt: null,
      lockedBy: null,
    },
  })
  if (result.count === 0) {
    throw new IntegrationOutboxAdminError(
      `Integration outbox row ${options.id} changed while replay was being applied`,
      409,
      'stale_row',
    )
  }

  return {
    row: toAdminIntegrationOutboxRow(await requireRow(client, options.id)),
    priorStatus,
    priorLastError,
  }
}

function assertPermanentFailableRow(options: {
  row: IntegrationOutboxRow
  now: Date
  staleProcessingLockMs: number
}) {
  if (!includesStatus(PERMANENT_FAILABLE_STATUSES, options.row.status)) {
    throw new IntegrationOutboxAdminError(
      `Integration outbox row ${options.row.id} is ${options.row.status}; succeeded rows cannot be marked as permanent failures`,
      409,
      'not_permanent_failable',
    )
  }
  if (options.row.status !== INTEGRATION_OUTBOX_STATUS.PROCESSING || options.row.lockedAt === null) return
  const staleBefore = new Date(options.now.getTime() - options.staleProcessingLockMs)
  if (options.row.lockedAt > staleBefore) {
    throw new IntegrationOutboxAdminError(
      `Integration outbox row ${options.row.id} is currently processing; wait for the lock to become stale before dead-lettering`,
      409,
      'processing_lock_active',
    )
  }
}

function permanentFailWhere(row: IntegrationOutboxRow): Record<string, unknown> {
  return {
    id: row.id,
    status: { in: [...PERMANENT_FAILABLE_STATUSES] },
    ...(row.status === INTEGRATION_OUTBOX_STATUS.PROCESSING ? { lockedAt: row.lockedAt } : {}),
  }
}

export async function permanentlyFailIntegrationOutboxAdminRow(options: {
  client?: IntegrationOutboxClient
  id: string
  now?: Date
  staleProcessingLockMs?: number
}): Promise<IntegrationOutboxAdminTransitionResult> {
  const client = getClient(options.client)
  const prior = await requireRow(client, options.id)
  const priorStatus = prior.status
  const priorLastError = prior.lastError
  assertPermanentFailableRow({
    row: prior,
    now: options.now ?? new Date(),
    staleProcessingLockMs: Math.max(0, Math.floor(options.staleProcessingLockMs ?? ADMIN_OUTBOX_STALE_PROCESSING_LOCK_MS)),
  })

  const result = await client.integrationOutbox.updateMany({
    where: permanentFailWhere(prior),
    data: {
      status: INTEGRATION_OUTBOX_STATUS.PERMANENT_FAILED,
      nextAttemptAt: null,
      lockedAt: null,
      lockedBy: null,
    },
  })
  if (result.count === 0) {
    throw new IntegrationOutboxAdminError(
      `Integration outbox row ${options.id} changed while permanent failure was being applied`,
      409,
      'stale_row',
    )
  }

  return {
    row: toAdminIntegrationOutboxRow(await requireRow(client, options.id)),
    priorStatus,
    priorLastError,
  }
}
