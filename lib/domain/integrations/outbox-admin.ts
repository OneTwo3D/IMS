import { db } from '@/lib/db'
import {
  INTEGRATION_OUTBOX_STATUS,
  type IntegrationOutboxClient,
  type IntegrationOutboxRow,
  type IntegrationOutboxStatus,
} from '@/lib/domain/integrations/outbox'
import { INTEGRATION_OUTBOX_MAX_LEASE_MS } from '@/lib/domain/integrations/outbox-leases'
import { integrationOutboxUnreclaimableScope } from '@/lib/domain/integrations/outbox-registry'

const ADMIN_OUTBOX_DEFAULT_LIMIT = 50
export const ADMIN_OUTBOX_MAX_LIMIT = 100
/**
 * How long past the LONGEST lease a lock has to sit before this file will touch it (o3d-8td2 r4).
 *
 * A margin, not a safety property. Nothing about elapsed time proves a holder died — that is the
 * finding this whole issue turns on — so the margin buys no belief about the EFFECT, and the actions
 * below are shaped so that none is needed. What it does buy is the narrower claim these actions do
 * make: that the row is past the point where any worker could still consider it its own. Five
 * minutes covers clock skew between app instances (each stamps `lockedAt` from its own clock) and a
 * drain tick that began a moment before its lease expired.
 */
export const ADMIN_OUTBOX_POST_LEASE_MARGIN_MS = 5 * 60 * 1000

/**
 * THE STALENESS THRESHOLD, DERIVED FROM THE LEASES IT OVERRIDES (o3d-8td2 round 4, Codex HIGH 1).
 *
 * Round 3 wrote this as its own `10 * 60 * 1000`. That reads as agreement with the outbox default
 * lease, and it silently DISAGREED with the only lease that differs: `xero/accounting.post` is
 * drained under fifteen minutes, so a Xero row locked twelve minutes ago was offered to an operator
 * as a stalled park while the worker holding it was still comfortably inside its lease — a row that
 * is not stalled at all, presented as one, with an action on it.
 *
 * So it is computed rather than restated: the maximum over every lease
 * `INTEGRATION_OUTBOX_DRAIN_LEASES_MS` declares, plus a margin. A future drain that takes a
 * longer lease raises this threshold in the same edit, and `tests/domain/integrations/outbox.test.ts`
 * asserts the inequality over the map rather than over a copied number.
 */
export const ADMIN_OUTBOX_STALE_PROCESSING_LOCK_MS = INTEGRATION_OUTBOX_MAX_LEASE_MS
  + ADMIN_OUTBOX_POST_LEASE_MARGIN_MS
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

/**
 * A ROW NOTHING WILL EVER COME BACK FOR — AND THIS FILE ONLY LISTS IT (o3d-8td2 r3 HIGH, r4 HIGH 2,
 * r6 withdrawal).
 *
 * Two conditions, and both have to hold before a stalled row is an operator's problem:
 *
 *   1. PROCESSING with a lock older than EVERY lease — see {@link ADMIN_OUTBOX_STALE_PROCESSING_LOCK_MS}.
 *      Not merely PROCESSING: a job inside its lease is not an exception, it is a job.
 *   2. On a row `integrationOutboxUnreclaimableScope` matches. A reclaimable row's stale lock is
 *      picked up by the next drain sweep with nobody asked, so listing it would be the same
 *      self-resolving noise this inbox already refuses to show for RETRYABLE_FAILED.
 *
 * ...and that is the whole predicate, because for such a row there is no third chance: the drain
 * will not take it, the retry ladder does not apply to a non-failed status, and no reconcile
 * elsewhere drains the outbox (o3d-22jw had to be corrected on exactly this point — the WooCommerce
 * daily reconcile calls `pushStockToWc` directly and never touches a row).
 *
 * IT RETURNS A SCOPE UNCONDITIONALLY, which round 3's `| null` did not. That scope is now the
 * COMPLEMENT of what a worker may reclaim, taken over rows rather than over registry entries, so a
 * row on an operation this build has never heard of — which `enqueueIntegrationOutbox` deliberately
 * accepts — is inside it. Round 3 excluded exactly those rows from both the reclaim and the list.
 *
 * THERE IS NO ONE-CLICK ACTION ON WHAT THIS RETURNS, AND THAT IS THE FINDING, NOT AN OMISSION
 * (o3d-8td2 round 6, and o3d-7qdb carries the full record). Rounds 3, 4 and 5 each shipped a
 * recovery button here and each drew a Codex HIGH:
 *
 *   - r3 dead-lettered and re-queued, which is the stale-lock reclaim the declaration forbids, done
 *     by hand, on the same evidence a worker is not allowed to act on;
 *   - r4 reduced it to dead-letter-only, defended as producing "no effect at all";
 *   - r5 showed that defence is false at its root. `PERMANENT_FAILED` IS NOT INERT. WooCommerce's
 *     normal enqueue path resets a permanent failure to PENDING on the next stock change
 *     (lib/connectors/woocommerce/sync/stock-sync-jobs.ts, `status: { not: PROCESSING }`), and
 *     `scheduleXeroAccountingOutbox` does the same (lib/connectors/xero/outbox.ts) from
 *     `ensureXeroOutboxForPendingSyncLogs`, which runs on EVERY Xero sweep
 *     (lib/connectors/xero/sync-processor.ts). Dead-lettering a park therefore parks it until the
 *     next ordinary event replays it — an old absolute stock quantity over a fresh one, or a second
 *     invoice email.
 *
 * The general rule that follows, and the one any future attempt has to answer: THERE IS NO STATUS IN
 * THIS SYSTEM THAT IS INERT. Every terminal status is an input to some enqueue path. So a recovery
 * cannot be made safe by choosing a quieter status; it must either verify the remote system directly
 * or require the operator to supply evidence the system cannot obtain for itself.
 *
 * Listing is a read and needs none of that, which is why it is what survived.
 *
 * AND THERE IS NO OTHER EXIT TO POINT AT — INCLUDING THE ONE THIS COMMENT USED TO POINT AT (round 7,
 * Codex round 6 HIGH). Round 6 ended here with "the operator is not left helpless:
 * `permanentlyFailIntegrationOutboxAdminRow` predates this branch and carries its own established
 * semantics", and the exception inbox's copy said the same thing to operators. That is the withdrawn
 * action with the button taken off. `permanentlyFailIntegrationOutboxAdminRow` writes the
 * `integration_outbox` row and nothing else, so for Xero the `AccountingSyncLog` that owns the work
 * is untouched and stays PENDING — or PROCESSING with an already-stale `processingStartedAt`, which
 * is exactly the shape a park has. `ensureXeroOutboxForPendingSyncLogs` is the FIRST statement of
 * every sweep, selects precisely those logs, and `scheduleXeroAccountingOutbox` resets the row it
 * finds to PENDING with `attempts: 0`; `claimIntegrationOutboxWork` then takes it on the same sweep.
 * Dead-lettering a park is therefore not a way to stop it, it is a slower way to replay it, and the
 * operator's check of the remote system does not change that because no action here is conditioned
 * on what they found.
 *
 * SO: ON A ROW THIS PREDICATE LISTS, THERE IS NO SAFE AUTOMATED REMEDY AT ALL — not in this module,
 * not through the admin API, not anywhere in IMS. The two mutations this module exports keep their
 * own pre-existing semantics for the rows they were built for; neither is a remedy for a park, and
 * nothing may recommend them as one. What an operator has instead is a read of the remote system and
 * a correction made THERE, outside the queue, where nothing can re-enqueue it. A remedy that does not
 * rest on elapsed time is open as o3d-7qdb, and the operator-facing half of this is
 * `app/(dashboard)/sync/exceptions/stalled-park-guidance.ts`, where the prohibition and the
 * recommendation are separate fields so that a test can tell which is which.
 */
export function stalledIntegrationOutboxParkWhere(options?: {
  now?: Date
  staleProcessingLockMs?: number
}): Record<string, unknown> {
  const now = options?.now ?? new Date()
  const staleMs = Math.max(0, Math.floor(options?.staleProcessingLockMs ?? ADMIN_OUTBOX_STALE_PROCESSING_LOCK_MS))
  return {
    ...integrationOutboxUnreclaimableScope(),
    status: INTEGRATION_OUTBOX_STATUS.PROCESSING,
    lockedAt: { not: null, lte: new Date(now.getTime() - staleMs) },
  }
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
