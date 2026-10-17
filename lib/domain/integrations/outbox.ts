import { reportUnrecordedShadow } from '@/lib/domain/outbound-shadow/unrecorded'
import { OUTBOUND_HELD_RETRY_DELAY_MS, isOutboundWriteHeldText } from '@/lib/security/outbound-write-hold-constants'
import { db } from '@/lib/db'
import {
  INTEGRATION_OUTBOX_DRAIN_LEASES_MS,
  type IntegrationOutboxDrainLeaseMs,
} from '@/lib/domain/integrations/outbox-leases'
import {
  isUniqueConstraintViolation,
  uniqueConstraintFields,
  uniqueViolationTargetsField,
} from '@/lib/db/prisma-unique-violation'
import {
  integrationOutboxStaleReclaimScope,
  OUTBOX_CUTOFF_CONNECTORS,
  outboxDestinationOf,
  outboxInternalOperationsOf,
  parseIntegrationOutboxPayload,
  PRODUCER_SEAMED_OUTBOX_DESTINATIONS,
  type OutboxConnectorWithoutShadow,
  type ProducerSeamedOutboxDestination,
} from '@/lib/domain/integrations/outbox-registry'
import { withSavepoint } from '@/lib/db/savepoint'
import { recordOutboundShadow } from '@/lib/domain/outbound-shadow/record'
import { producerShadowNotice, type ProducerReason } from '@/lib/security/producer-disposition-constants'
import type { ProducerDecision } from '@/lib/security/producer-disposition'
import { createdBeforeCutoffFloor, producerCutoffFloor, producerSeamVerdict, readProducerEnforcement } from '@/lib/security/producer-seam'
import { ownershipTargetForOutboxOperation, type MappedOperation } from '@/lib/security/writer-ownership-map'

export const INTEGRATION_OUTBOX_STATUS = {
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  SUCCEEDED: 'SUCCEEDED',
  RETRYABLE_FAILED: 'RETRYABLE_FAILED',
  PERMANENT_FAILED: 'PERMANENT_FAILED',
  /**
   * RETIRED BY THE PRODUCER-SIDE HOLD AND KEPT AS A SHADOW: the job was queued before the destination's live-from instant (or while the
   * hold stood), and the retirement PROVED from the row itself that no attempt to send it was ever made (attempts 0, or only a verified
   * hold refusal). It is terminal: never claimed, never replayed, and not a failure (no operator action is owed). Written only by the
   * retirement, and by the Xero drain for a job whose row it has proved never left; a job whose history cannot prove that is
   * PERMANENT_FAILED with the unknown-outcome sentence instead, never this. See lib/domain/outbound-shadow/retire-held-backlog.ts.
   */
  SHADOWED: 'SHADOWED',
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
  /** Durable attempt history (see the schema): true only when this row's claims stamp `firstAttemptedAt`; absent / false = unknown. */
  attemptHistoryTracked?: boolean
  firstAttemptedAt?: Date | null
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
  /**
   * What the producer-side hold needs for an operation whose effect is a vendor write (ignored for the others). `subject*`
   * name the thing the work is about (default: the operation and the idempotency key); `obligationAt` is the business-event
   * time an operation requires when its ownership-map row says so.
   */
  producer?: {
    subjectType?: string
    subjectId?: string
    obligationAt?: Date
    summary?: Record<string, string | number | boolean | null>
  }
}

/**
 * THE ANSWER OF AN ENQUEUE THAT THE PRODUCER-SIDE HOLD SHADOWED. NO ROW EXISTS: nothing is queued, nothing will be sent, and a
 * shadow record was kept instead (outbound_shadow_writes, in the caller's own transaction). It is deliberately NOT shaped like an
 * {@link IntegrationOutboxRow}, so a caller cannot read an id, a key or a status off it and carry on as if work were queued.
 */
export type OutboxEnqueueShadowed = {
  shadowed: true
  /** `<connector>/<operation>`. */
  operation: string
  notice: string
  reason: ProducerReason
  /** False when the shadow record itself could not be written: lost evidence, never lost work. */
  recorded: boolean
  occurrences: number | null
}

/** Narrows the result of an enqueue: true when the hold shadowed it and no row exists. */
export function isOutboxEnqueueShadowed(result: IntegrationOutboxRow | OutboxEnqueueShadowed): result is OutboxEnqueueShadowed {
  return (result as { shadowed?: unknown }).shadowed === true
}

/**
 * For a caller whose connector is never a vendor (an internal ledger operation): the row, or a loud failure if the impossible
 * happens. A shadow here would mean an internal operation was registered against a vendor destination without its caller being
 * rewritten, which must not be silently read as "queued".
 */
export function requireEnqueuedOutboxRow(result: IntegrationOutboxRow | OutboxEnqueueShadowed): IntegrationOutboxRow {
  if (isOutboxEnqueueShadowed(result)) {
    throw new Error(`Integration outbox operation ${result.operation} was shadowed by the producer-side hold, but this caller expects a queued row`)
  }
  return result
}

export type ClaimIntegrationOutboxOptions = {
  client?: IntegrationOutboxClient
  connector?: string
  operation?: string
  idempotencyKeys?: string[]
  limit?: number
  workerId: string
  now?: Date
  /**
   * o3d-8td2 r6 (Codex MEDIUM): a lease this claim may take, and NOT `number`.
   *
   * The listing threshold in `outbox-admin.ts` is the maximum over
   * `INTEGRATION_OUTBOX_DRAIN_LEASES_MS`, so a lease that map does not contain would let the
   * exception inbox call a row stalled while its holder was still inside its lease. Typing the
   * parameter as the map's literal union makes that unrepresentable at every call site — including
   * the shorthand and spread forms a source scan cannot see — instead of asking a regex to notice it.
   */
  staleLockMs?: IntegrationOutboxDrainLeaseMs
  maxAttempts?: number
  /**
   * o3d-6ldlj: SERIALISE claims that share a key (WooCommerce order status pushes are sequenced PER ORDER).
   * When given, each candidate is claimed inside ONE transaction that first takes a transaction-scoped advisory
   * lock on `keyOf(row)`, then asks `mayClaim` (which reads through the SAME transaction), then runs the claim
   * compare-and-set. Every claimer of that key takes the same lock, so "no sibling is PROCESSING" and "I became
   * PROCESSING" cannot interleave: a check made BEFORE the claim statement, outside the lock, would let two workers
   * both pass. A candidate that may not claim is skipped untouched (no attempt consumed, still due, so the next
   * drain finds it). Needs the default client (a real database), never a caller-supplied one.
   */
  /**
   * o3d-6ldlj: claim ONE job at a time, at the moment its attempt is about to start. `limit` is then only the SCAN
   * window (how many due candidates are looked at, oldest first) and the call returns as soon as `claimLimit` jobs
   * were actually claimed. Claiming a whole batch up front stamps every job with the same `lockedAt` while the
   * worker processes them one after another, so a job at the back can age past the drain lease before its attempt
   * starts and be parked as "dead" while live.
   */
  claimLimit?: number
  /** Rows to skip (already attempted by this drain). */
  excludeIds?: string[]
  claimGate?: {
    keyOf: (row: IntegrationOutboxRow) => string | null
    mayClaim: (tx: IntegrationOutboxClient, row: IntegrationOutboxRow, now: Date) => Promise<boolean>
  }
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
/** @see INTEGRATION_OUTBOX_DRAIN_LEASES_MS — the one place every lease in this build is declared. */
const DEFAULT_STALE_LOCK_MS = INTEGRATION_OUTBOX_DRAIN_LEASES_MS.default
/**
 * First-retry backoff floor. Exported because it is what an automatic connector retry is scheduled
 * against, and therefore what decides whether a remote idempotency key is still alive when the retry
 * lands — see lib/domain/accounting/idempotency-retention.ts.
 */
export const DEFAULT_RETRY_BASE_DELAY_MS = 5 * 60 * 1000
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

/**
 * THE SECOND COPY OF THE ACCOUNTING KEY NORMALISER, AND IT DOES NOT SHARE ITS PROBLEM (o3d-11rf r12).
 *
 * This is character for character `buildAccountingEventIdempotencyKey`'s per-part normalisation, so
 * the question r12 asked of that one has to be asked here: does the database's LOCALE decide what it
 * computes? It does not, and for a reason that is worth writing down rather than re-deriving.
 *
 * `String.prototype.toLowerCase` is locale-INDEPENDENT by specification — the locale-sensitive
 * spelling is `toLocaleLowerCase`, which this does not use. What r12 fixed was not a JavaScript
 * normaliser; it was a SQL RE-IMPLEMENTATION of one, where `lower()` resolves the collation of its
 * argument and a `tr-TR` database folds ASCII `I` to dotless `ı`. This normaliser has no SQL twin:
 * `buildOutboxIdempotencyKey` is the only producer of `integration_outbox.idempotencyKey`, every
 * caller is TypeScript, and the database only stores the result and uniques it. Give it one — a
 * statement that re-derives an outbox key in SQL — and it acquires r12's exposure immediately, and
 * the fix is the one that statement carries: pin the collation on the ARGUMENT of `lower()`.
 */
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

/**
 * Is this the `integration_outbox.idempotencyKey` unique violation — i.e. this work item is
 * already queued and the enqueue is a benign replay?
 *
 * o3d-5od: the `meta.target` reading this replaced never matched under the pg driver adapter.
 * It only kept working here because of the `target == null && modelName === 'IntegrationOutbox'`
 * fallback below, which treated EVERY P2002 on the model as an idempotency-key conflict. Now
 * that the violated column is readable, that fallback is narrowed to the case where the error
 * genuinely names no constraint at all, so a future second unique index on IntegrationOutbox
 * cannot be silently swallowed as a duplicate enqueue.
 */
function isIdempotencyKeyConflict(error: unknown): boolean {
  if (!isUniqueConstraintViolation(error)) return false
  if (uniqueViolationTargetsField(error, 'idempotencyKey')) return true
  return uniqueConstraintFields(error) === null
    && (error as { meta?: { modelName?: unknown } }).meta?.modelName === 'IntegrationOutbox'
}

/**
 * THE WRITER-SIDE CUT-OFF FOR QUEUED JOBS: the rows of a vendor connector that were created before that connector's live-from instant.
 *
 * A job queued before the instant (while the transport hold was the only barrier, or before the producer hold was enforced) belongs to
 * the writer that owned the destination then, and IMS never delivers it, whatever its status and however it was re-armed. This is the
 * fragment that MATCHES such rows; the claim negates it (NOT), so the oldest-first window never contains one and cannot be starved by
 * them. Null when no connector has a floor: the switch is off, or the destination is not in its live phase. Then nothing is added and the
 * legacy predicate is exact. A registered operation whose effect is local (`internal`) is never matched. Read at the moment it is asked
 * for, from the environment, and cached nowhere.
 */
export function outboxBeforeCutoffWhere(context: { now?: Date } = {}): Record<string, unknown> | null {
  const clauses: Array<Record<string, unknown>> = []
  for (const connector of OUTBOX_CUTOFF_CONNECTORS) {
    const floor = producerCutoffFloor(connector, context.now ? { now: context.now } : {})
    if (floor === null) continue
    const internal = outboxInternalOperationsOf(connector)
    clauses.push({
      connector,
      createdAt: { lt: floor },
      ...(internal.length > 0 ? { operation: { notIn: internal } } : {}),
    })
  }
  return clauses.length > 0 ? { OR: clauses } : null
}

/** The floor that applies to ONE job (null when none), for a path that holds the row rather than a query. */
export function outboxRowCutoffFloor(connector: string, operation: string, context: { now?: Date } = {}): Date | null {
  if (!(OUTBOX_CUTOFF_CONNECTORS as readonly string[]).includes(connector)) return null
  if (outboxInternalOperationsOf(connector as (typeof OUTBOX_CUTOFF_CONNECTORS)[number]).includes(operation)) return null
  return producerCutoffFloor(connector as (typeof OUTBOX_CUTOFF_CONNECTORS)[number], context.now ? { now: context.now } : {})
}

/** True when this job predates the cut-off that applies to it. No floor: false. */
export function outboxRowBeforeCutoff(
  row: { connector: string; operation: string; createdAt: Date },
  context: { now?: Date } = {},
): Date | null {
  const floor = outboxRowCutoffFloor(row.connector, row.operation, context)
  return floor !== null && createdBeforeCutoffFloor(row.createdAt, floor) ? floor : null
}

function dueAtOrBefore(now: Date): unknown {
  return { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] }
}

function unlockedOrStale(now: Date, staleLockMs: number): unknown {
  return { OR: [{ lockedAt: null }, { lockedAt: { lt: new Date(now.getTime() - staleLockMs) } }] }
}

/**
 * THE ARM THAT TAKES WORK FROM SOMEBODY ELSE (o3d-8td2).
 *
 * The first OR arm claims rows NOBODY is executing: PENDING / RETRYABLE_FAILED, which every
 * completion path reaches only after nulling `lockedAt`, so its own staleness clause is a repair for
 * an orphaned lock stamp on a row whose worker has already let go of it.
 *
 * The second arm is different in kind. It takes a PROCESSING row — one a worker claimed and may
 * still be executing — on the strength of nothing but elapsed time, which cannot tell a dead holder
 * from a slow one. The HANDOVER is sound: the update below compare-and-sets on the exact `lockedAt`
 * and `lockedBy` this candidate was read with (re-checking its status and attempt cap in the same
 * statement), and every completion helper fences on that same pair, so a previous holder that comes
 * back cannot write the row at all.
 *
 * What none of that can make safe is the operation's EFFECT, which the previous holder may already
 * have produced. Whether a second execution of that effect is harmless is a property of the
 * OPERATION, declared on the registry entry — see lib/domain/integrations/outbox-replay-policy.ts
 * — and this arm is offered only where that declaration says yes.
 */
function claimableWhere(options: {
  connector?: string
  operation?: string
  idempotencyKeys?: string[]
  now: Date
  staleLockMs: number
  maxAttempts: number
  /** {@link integrationOutboxStaleReclaimScope}: the extra predicate, or `null` for no arm at all. */
  staleReclaimScope: Record<string, unknown> | null
}): unknown {
  const staleLockedBefore = new Date(options.now.getTime() - options.staleLockMs)
  const beforeCutoff = outboxBeforeCutoffWhere({ now: options.now })
  return {
    ...(options.connector ? { connector: options.connector } : {}),
    ...(options.operation ? { operation: options.operation } : {}),
    ...(options.idempotencyKeys && options.idempotencyKeys.length > 0
      ? { idempotencyKey: { in: [...new Set(options.idempotencyKeys)] } }
      : {}),
    ...(beforeCutoff ? { NOT: beforeCutoff } : {}),
    attempts: { lt: options.maxAttempts },
    OR: [
      {
        status: { in: [...CLAIMABLE_STATUSES] },
        AND: [
          dueAtOrBefore(options.now),
          unlockedOrStale(options.now, options.staleLockMs),
        ],
      },
      ...(options.staleReclaimScope
        ? [{
          status: INTEGRATION_OUTBOX_STATUS.PROCESSING,
          lockedAt: { lt: staleLockedBefore },
          ...options.staleReclaimScope,
        }]
        : []),
    ],
  }
}

function claimUpdateWhere(row: IntegrationOutboxRow, now: Date, maxAttempts: number): unknown {
  // The writer-side cut-off, re-derived INSIDE the claim statement: the candidate was selected by a query that carried it, but the claim
  // is the compare-and-set that takes the job, and what it decides must be the floor of that moment, not of the read before it.
  const beforeCutoff = outboxBeforeCutoffWhere({ now })
  if (row.status === INTEGRATION_OUTBOX_STATUS.PROCESSING) {
    return {
      ...(beforeCutoff ? { NOT: beforeCutoff } : {}),
      id: row.id,
      status: INTEGRATION_OUTBOX_STATUS.PROCESSING,
      attempts: { lt: maxAttempts },
      lockedAt: row.lockedAt,
      lockedBy: row.lockedBy,
    }
  }

  return {
    ...(beforeCutoff ? { NOT: beforeCutoff } : {}),
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

type OutboxProducerVerdict =
  | { kind: 'proceed' }
  | { kind: 'shadow'; destination: ProducerSeamedOutboxDestination; operation: string; decision: ProducerDecision }

/**
 * Does the producer-side hold let this outbox operation be queued? Only an operation whose effect is a vendor write is asked
 * (see OutboxRegistryEntry.destination). An operation of such a vendor that the ownership map does not name is SHADOW while the
 * hold is enforced for that vendor: a job nobody classified is not produced.
 */
function outboxProducerVerdict(input: EnqueueIntegrationOutboxInput): OutboxProducerVerdict {
  const destination = outboxDestinationOf(input.connector, input.operation)
  if (!(PRODUCER_SEAMED_OUTBOX_DESTINATIONS as readonly string[]).includes(destination)) return { kind: 'proceed' }
  const seamed = destination as ProducerSeamedOutboxDestination
  const target = ownershipTargetForOutboxOperation(`${input.connector}/${input.operation}`)
  if (!target || target.destination !== seamed) {
    const enforcement = readProducerEnforcement()
    if (!enforcement.enforced || !enforcement.destinations.has(seamed)) return { kind: 'proceed' }
    return {
      kind: 'shadow',
      destination: seamed,
      operation: `unmapped:${input.connector}/${input.operation}`,
      decision: { disposition: 'SHADOW', reason: 'owner_unknown', owner: 'unknown', phase: 'P1', cutoff: null, grant: 'unreadable' },
    }
  }
  const verdict = producerSeamVerdict(seamed, target.operation as MappedOperation<ProducerSeamedOutboxDestination>, input.producer?.obligationAt)
  if (verdict.kind !== 'shadow') return { kind: 'proceed' }
  return { kind: 'shadow', destination: seamed, operation: target.operation, decision: verdict.decision }
}

async function shadowOutboxEnqueue(
  client: IntegrationOutboxClient,
  input: EnqueueIntegrationOutboxInput,
  payloadJson: unknown,
  verdict: Extract<OutboxProducerVerdict, { kind: 'shadow' }>,
): Promise<OutboxEnqueueShadowed> {
  let occurrences: number | null = null
  let recorded = false
  try {
    const result = await withSavepoint(client, () => recordOutboundShadow(client, {
      destination: verdict.destination,
      operation: verdict.operation,
      subjectType: input.producer?.subjectType ?? `${input.connector}/${input.operation}`,
      subjectId: input.producer?.subjectId ?? input.idempotencyKey,
      payload: { operation: `${input.connector}/${input.operation}`, payload: payloadJson },
      summary: { outboxOperation: `${input.connector}/${input.operation}`, ...(input.producer?.summary ?? {}) },
      decision: verdict.decision,
    }))
    occurrences = result.occurrences
    recorded = true
  } catch (error) {
    reportUnrecordedShadow({ destination: verdict.destination, operation: verdict.operation, subject: `${input.connector}/${input.operation} (${input.idempotencyKey})`, error })
  }
  return {
    shadowed: true,
    operation: `${input.connector}/${input.operation}`,
    notice: producerShadowNotice({ connector: verdict.destination, reason: verdict.decision.reason, owner: verdict.decision.owner }),
    reason: verdict.decision.reason,
    recorded,
    occurrences,
  }
}

/**
 * Queue one integration job, or, when the producer-side hold shadows a job whose effect is a vendor write, queue NOTHING and
 * answer {@link OutboxEnqueueShadowed}. The result type says which can happen: a connector that is a literal never-shadowed one
 * ('xero', 'accounting', 'sales') gets a row; anything else gets the union, and the compiler makes the caller choose what a
 * shadow means to it. A caller must never treat a shadow as queued work.
 */
export async function enqueueIntegrationOutbox<C extends string>(
  input: EnqueueIntegrationOutboxInput & { connector: C },
  options: { client?: IntegrationOutboxClient } = {},
): Promise<C extends OutboxConnectorWithoutShadow ? IntegrationOutboxRow : IntegrationOutboxRow | OutboxEnqueueShadowed> {
  const client = getClient(options.client)
  const payloadJson = parseIntegrationOutboxPayload({
    connector: input.connector,
    operation: input.operation,
    payloadJson: input.payloadJson,
  })
  const producerVerdict = outboxProducerVerdict(input)
  if (producerVerdict.kind === 'shadow') return await shadowOutboxEnqueue(client, input, payloadJson, producerVerdict) as never
  try {
    // o3d-slrn: this is called with a TRANSACTION client by scheduleXeroAccountingOutbox and
    // friends, and the catch below queries the same client to return the existing row. This path
    // was already firing before o3d-5od via the old modelName fallback, so it is the one instance
    // of this bug that has been live in production.
    return await withSavepoint(client, () => client.integrationOutbox.create({
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
        // This binary stamps the first claim, so for a row it creates "no first claim recorded" is a positive record of "never claimed".
        attemptHistoryTracked: true,
      },
    })) as never
  } catch (error) {
    if (!isIdempotencyKeyConflict(error)) throw error
    const existing = await client.integrationOutbox.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    })
    if (existing) return existing as never
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
  const baseWhere = claimableWhere({
    connector: options.connector,
    operation: options.operation,
    idempotencyKeys: options.idempotencyKeys,
    now,
    staleLockMs,
    maxAttempts,
    staleReclaimScope: integrationOutboxStaleReclaimScope(options.connector, options.operation),
  })
  const candidates = await client.integrationOutbox.findMany({
    where: options.excludeIds && options.excludeIds.length > 0
      ? { AND: [baseWhere, { id: { notIn: [...options.excludeIds] } }] }
      : baseWhere,
    orderBy: { createdAt: 'asc' },
    take: positiveLimit(options.limit),
  })

  const claimed: IntegrationOutboxRow[] = []
  const gate = options.claimGate
  if (gate) {
    if (options.client) throw new Error('claimGate needs the default database client')
    for (const row of candidates) {
      const key = gate.keyOf(row)
      const won = await db.$transaction(async (tx) => {
        if (key !== null) {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`
        }
        const txClient = tx as unknown as IntegrationOutboxClient
        if (key !== null && !(await gate.mayClaim(txClient, row, now))) return false
        const result = await txClient.integrationOutbox.updateMany({
          where: claimUpdateWhere(row, now, maxAttempts),
          data: {
            status: INTEGRATION_OUTBOX_STATUS.PROCESSING,
            lockedAt: now,
            lockedBy: options.workerId,
            // The durable attempt history: the FIRST claim is stamped here, before any request can leave, and nothing but a hold-refused claim that
            // created the stamp itself ever clears it (markIntegrationOutboxRetryableFailure). A replay, a re-arm or a retry leave it alone.
            ...(row.firstAttemptedAt ? {} : { firstAttemptedAt: now }),
          },
        })
        return result.count > 0
      })
      if (won) claimed.push(await requireOutboxRow(client, row.id))
      if (options.claimLimit !== undefined && claimed.length >= options.claimLimit) break
    }
    return claimed
  }
  for (const row of candidates) {
    const result = await client.integrationOutbox.updateMany({
      where: claimUpdateWhere(row, now, maxAttempts),
      data: {
        status: INTEGRATION_OUTBOX_STATUS.PROCESSING,
        lockedAt: now,
        lockedBy: options.workerId,
        ...(row.firstAttemptedAt ? {} : { firstAttemptedAt: now }),
      },
    })
    if (result.count === 0) continue
    claimed.push(await requireOutboxRow(client, row.id))
    if (options.claimLimit !== undefined && claimed.length >= options.claimLimit) break
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

  // A HELD WRITE IS NOT A FAILURE OF THE WORK (outbound-write hold). The installation has not been
  // granted the destination, so the job did not run; spending an attempt would march it towards
  // PERMANENT_FAILED - a dead letter that reads as "the destination rejected this" - merely because the
  // hold lasted longer than the retry budget. The job stays retryable, keeps its attempt count, and is
  // offered again after OUTBOUND_HELD_RETRY_DELAY_MS, for as long as the hold lasts.
  if (isOutboundWriteHeldText(errorMessage(options.error))) {
    const heldRow = await updateClaimedOutboxRow(client, {
      id: options.id,
      workerId: options.workerId,
      lockedAt: options.lockedAt,
      data: {
        status: INTEGRATION_OUTBOX_STATUS.RETRYABLE_FAILED,
        nextAttemptAt: new Date(now.getTime() + normalizeDelayMs(options.retryDelayMs ?? OUTBOUND_HELD_RETRY_DELAY_MS)),
        lastError: truncateError(options.error),
        lockedAt: null,
        lockedBy: null,
      },
    })
    // A hold refuses a request before it leaves. If THIS claim is the one that created the first-attempt stamp (the stamp equals its own claim
    // time), nothing has ever left for this job, so the stamp is withdrawn; a stamp from any earlier claim never equals this one and stays.
    await client.integrationOutbox.updateMany({
      where: { id: options.id, attemptHistoryTracked: true, firstAttemptedAt: options.lockedAt },
      data: { firstAttemptedAt: null },
    })
    return heldRow
  }

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
