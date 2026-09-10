import { db } from '@/lib/db'
import {
  INTEGRATION_OUTBOX_STATUS,
  type IntegrationOutboxClient,
  type IntegrationOutboxRow,
  type IntegrationOutboxStatus,
} from '@/lib/domain/integrations/outbox'
import { INTEGRATION_OUTBOX_MAX_LEASE_MS } from '@/lib/domain/integrations/outbox-leases'
import {
  integrationOutboxUnreclaimableScope,
  isUnreclaimableOutboxOperation,
} from '@/lib/domain/integrations/outbox-registry'

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
 * A ROW NOTHING WILL EVER COME BACK FOR (o3d-8td2 round 3, Codex HIGH; round 4, HIGH 2).
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
 * The threshold is the SAME constant {@link permanentlyFailIntegrationOutboxAdminRow} refuses below,
 * so a row can never be shown here while the action offered on it would be rejected as
 * `processing_lock_active`.
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

/**
 * THE STAMP A DEAD-LETTERED PARK CARRIES, saying in the row itself what nobody can verify.
 *
 * `permanentlyFailIntegrationOutboxAdminRow` writes no `lastError` of its own, so before round 4 a
 * park landed in the PERMANENT_FAILED list carrying whatever the crashed worker had left — usually
 * `null` — and an operator looking at it later had no way to know it had been stopped by hand rather
 * than by a failure, nor what was and was not known about its effect. The re-queue is a SEPARATE act
 * taken on that list; this is the only thing standing between it and a blind one.
 */
export function stalledOutboxParkDeadLetterReason(row: {
  connector: string
  operation: string
  lockedBy: string | null
  lockedAt: Date | null
}): string {
  const heldBy = row.lockedBy ?? 'an unnamed worker'
  const heldSince = row.lockedAt ? row.lockedAt.toISOString() : 'an unknown time'
  const leaseMinutes = Math.round(ADMIN_OUTBOX_STALE_PROCESSING_LOCK_MS / 60_000)
  return `Dead-lettered from the exception inbox: the PROCESSING lock taken by ${heldBy} at ${heldSince} `
    + `was never released and is older than every drain lease (${leaseMinutes} minutes). `
    + 'NOTHING HAS BEEN RE-RUN, and two things are NOT known: whether that worker died or is merely '
    + `paused, and whether its ${row.connector}/${row.operation} effect reached the remote system. `
    + 'Re-queueing this row runs the operation again — check the remote system first.'
}

/**
 * THE ONE ACTION ON A PARK, AND IT DOES NOT RE-RUN THE OPERATION (o3d-8td2 round 4, Codex HIGH 1).
 *
 * ROUND 3 BUILT THE THING THE VERDICT FORBIDS, and the argument against it is this issue's own.
 * `unsafe-to-replay` exists because `lockedAt < now - lease` cannot distinguish a holder that DIED
 * from one that is merely SLOW, so handing the row to a second executor on that evidence can produce
 * the effect twice. Round 3 refused to let a WORKER do that and then offered an OPERATOR a button
 * that did it: dead-letter, then immediately re-queue, on exactly the same evidence. A compare-and-set
 * fences the row's later WRITES; it cannot unsend a WooCommerce push or un-queue an invoice email
 * that the first holder had already issued. A paused worker that resumes after the button is pressed
 * still finishes its work, and the re-queued row does it a second time.
 *
 * SO THE OPERATOR ACTION DEAD-LETTERS AND STOPS. That is the whole of it, and it is defensible where
 * a re-queue is not, for one reason: DEAD-LETTERING PRODUCES NO EFFECT. It moves a row from a status
 * nothing will ever act on to a status nothing will ever act on, and every completion path is fenced
 * on `(lockedBy, lockedAt)`, so a resuming holder cannot write the row either. It needs no belief
 * about whether the holder is alive, which is the only belief this evidence cannot support.
 *
 * RE-ENQUEUE REMAINS AVAILABLE AND REMAINS A SEPARATE ACT. The dead-lettered row lands in the
 * exception inbox's PERMANENT_FAILED section, carrying {@link stalledOutboxParkDeadLetterReason},
 * where {@link replayIntegrationOutboxAdminRow} is the existing affordance. That is deliberately not
 * one click: it is a different surface, a different row state, and a stated reason naming what
 * cannot be verified, so the person who re-runs a possibly-already-delivered effect is asserting
 * something they went and checked rather than something the clock told them.
 *
 * WHAT IT COSTS, said plainly. For `woocommerce/stock.push` the folded backlog does NOT drain on
 * this action — the row's latest quantity still waits for the replay. The park is no longer
 * invisible or self-perpetuating, which was the r3 finding; it is now a two-act recovery, and the
 * second act is the one that can duplicate an effect, so it is the one an operator has to mean.
 *
 * REFUSES ANYTHING THAT IS NOT A PARK. The caller is an inbox row an operator clicked, rendered from
 * a snapshot; by the time the click lands the worker may have finished, or the row may never have
 * been in scope. Re-read and re-checked here against the same predicate the list was built from.
 */
export async function deadLetterStalledIntegrationOutboxPark(options: {
  client?: IntegrationOutboxClient
  id: string
  now?: Date
  staleProcessingLockMs?: number
}): Promise<IntegrationOutboxAdminTransitionResult> {
  const client = getClient(options.client)
  const now = options.now ?? new Date()
  const staleProcessingLockMs = Math.max(
    0,
    Math.floor(options.staleProcessingLockMs ?? ADMIN_OUTBOX_STALE_PROCESSING_LOCK_MS),
  )
  const prior = await requireRow(client, options.id)

  // The SAME rule the list is built from, so the action can never reach a row the rule does not
  // cover — and, since round 4, that rule is total over rows: an unregistered operation is inside
  // it, not invisible to it.
  if (!isUnreclaimableOutboxOperation(prior.connector, prior.operation)) {
    throw new IntegrationOutboxAdminError(
      `Integration outbox row ${options.id} (${prior.connector}/${prior.operation}) is not a parked row: its operation is reclaimable, so a drain sweep recovers it without an operator`,
      409,
      'not_a_stalled_park',
    )
  }
  if (prior.status !== INTEGRATION_OUTBOX_STATUS.PROCESSING || prior.lockedAt === null) {
    throw new IntegrationOutboxAdminError(
      `Integration outbox row ${options.id} is ${prior.status}, not a stalled PROCESSING park`,
      409,
      'not_a_stalled_park',
    )
  }

  // One step, and it is the step that fences on `lockedAt` and refuses a lock that is not yet stale.
  return await permanentlyFailIntegrationOutboxAdminRow({
    client,
    id: options.id,
    now,
    staleProcessingLockMs,
    lastError: stalledOutboxParkDeadLetterReason(prior),
  })
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
  /**
   * Written into `lastError` in the SAME fenced statement as the status flip, so a row can never be
   * dead-lettered without its reason. Omitted by the generic operator action, which is taken on a
   * row that already carries the failure that brought it here; supplied by
   * {@link deadLetterStalledIntegrationOutboxPark}, whose row carries nothing at all.
   */
  lastError?: string
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
      ...(options.lastError === undefined ? {} : { lastError: options.lastError }),
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
