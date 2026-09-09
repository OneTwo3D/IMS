import { StockSyncReason } from '@/app/generated/prisma/enums'
import { z } from 'zod'

import {
  outboxReplayPolicyGrantsStaleReclaim,
  resolveOutboxReplaySafety,
  type OutboxReplaySafety,
} from '@/lib/domain/integrations/outbox-replay-policy'

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

// o3d-67y: a refund reduces an allocated order's demand, so the refunded units'
// stock reservation must be released by re-running allocation AFTER the refund tx
// commits. That release is best-effort and can be bypassed by a post-commit throw
// or lost to a crash. This backstop row is enqueued INSIDE the refund tx (durable,
// atomic with the refund) and drained idempotently — re-running allocation on an
// already-released order is a harmless no-op. Payload carries only the identifiers
// the drain re-reads under the order lock.
export const SalesRefundReservationReleaseOutboxPayloadSchema = z.object({
  orderId: nonEmptyString,
  refundId: nonEmptyString,
})

// o3d-67y r10: a SEPARATE row (independent idempotency + lifecycle) carries the durable operator WARNING for an
// unmatched external refund quantity line that allocation cannot release. Kept distinct from the release row so
// delivering the WARNING never re-runs the non-idempotent allocation (Codex review r10).
export const SalesRefundUnmatchedWarningOutboxPayloadSchema = z.object({
  orderId: nonEmptyString,
  refundId: nonEmptyString,
  refundOrderRef: z.string().optional().default(''),
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

// audit-grob: landed-cost adjustment journals are enqueued into the outbox IN the
// recalc transaction (durable), then drained idempotently. Payload is the subset
// of LandedCostRecalcResult the journal builder consumes.
const LandedCostAdjustmentEntrySchema = z.object({
  primaryPoId: nonEmptyString,
  primaryPoRef: z.string(),
  freightPoId: z.string().nullable().optional().default(null),
  eventKey: z.string(),
  totalDelta: z.number().finite(),
})
export const LandedCostJournalOutboxPayloadSchema = z.object({
  // Required (not defaulted): the scheduler only ever enqueues a fully-formed
  // result with both arrays, so a missing array is a malformed payload that must
  // retry, not a silent no-op success (Codex review).
  inventoryTransitAdjustments: z.array(LandedCostAdjustmentEntrySchema),
  cogsAdjustments: z.array(LandedCostAdjustmentEntrySchema),
})

/**
 * WHAT MAKES A SECOND EXECUTION OF THIS OPERATION SAFE (o3d-8td2). Both fields are REQUIRED, so
 * `tsc` refuses a new registered operation until somebody has answered — see
 * `lib/domain/integrations/outbox-replay-policy.ts` for what each answer asserts, and for why the
 * outbox's own compare-and-set cannot answer it. Every entry's answer must be justified in a
 * comment beside it, naming the guard, fence or dispatch evidence it is claiming.
 *
 * The two fields are one union, not two independent choices: an operation that admits its effects
 * are keyed by a SUB-OPERATION (`xero/accounting.post`, over `AccountingSyncType`) cannot be
 * declared anything but `unsafe-to-replay`, because a single verdict over several effects is an
 * average, and an average reads as an answer while asserting nothing about the member that matters.
 */
type OutboxRegistryEntry<Name extends string = string> =
  & { name: Name; schema: z.ZodTypeAny }
  & (
    | { effects: { keyedBy: 'operation' }; replay: OutboxReplaySafety }
    | {
      effects: { keyedBy: 'sub-operation'; discriminator: string; weakestKnownEffect: string }
      replay: 'unsafe-to-replay'
    }
  )

function defineOutboxRegistry<const T extends Record<string, Record<string, OutboxRegistryEntry>>>(registry: T): T {
  return registry
}

/** Sugar for the ordinary case, so the interesting one stands out at a glance. */
const ONE_EFFECT = { keyedBy: 'operation' } as const

export const INTEGRATION_OUTBOX_REGISTRY = defineOutboxRegistry({
  woocommerce: {
    // UNSAFE (Codex round 2, HIGH 1 — this entry said `remote-write-idempotent` in round 1 and the
    // reasoning behind that was wrong in a way worth keeping written down).
    //
    // `pushStockToWc` sends `stock_quantity` as an ABSOLUTE integer (lib/connectors/woocommerce/sync/
    // stock-sync.ts), so a REPEAT is harmless — the same field is assigned the same value. That is
    // idempotence, and it is the only question round 1 asked. The question it did not ask is
    // ORDERING, and the reclaim is a machine for getting that wrong:
    //
    //   worker A resolves stock_quantity = 10 (resolvePushStockQuantity, ~line 1093) and pauses
    //   before `pushBatchWithFence` reaches the socket; stock falls to 0 and enqueues its own row —
    //   which, sharing this product's idempotency key, IS this row; ten minutes later worker B
    //   reclaims it, computes 0, pushes 0 and completes it SUCCEEDED; A then resumes and pushes 10.
    //
    // A is fenced out of the ROW (its `completeClaimedJob` CAS fails and it throws), but WooCommerce
    // is left holding 10 against an IMS truth of 0, and `persistSuccessfulPushState` — which runs
    // inside `pushStockToWc`, knowing nothing of the outbox — has already written lastPushedQty=10
    // over B's 0. Nothing is queued to correct it: the row that would have carried the correction is
    // the one B just closed. The oversell stands until the daily forceAll reconcile.
    //
    // Neither existing guard touches this. The store-version precheck aborts a push whose
    // CREDENTIALS were rebound, which is a different question. The 1qsb clamp re-reads fresh stock
    // and takes min(snapshot, fresh) — but it runs at build time, before the preflight round-trips
    // and the batch POST, so it moves the start of the window rather than closing it. Nothing local
    // can close it: once both requests are in flight, arrival order at WooCommerce is not ours to
    // decide. The WooCommerce products batch endpoint offers no generation, version or conditional
    // write to reject a regression with, so `remote-write-idempotent` cannot honestly be claimed
    // until one exists on our side of the wire (a monotonic push generation the receiver checks).
    //
    // THE PARK IS NOT FREE, and this is the trade being taken. `applyStockOutboxPayload` folds a new
    // stock change into an existing PROCESSING row rather than creating another, so a row parked
    // here keeps absorbing enqueues that will not drain until an operator dead-letters it in the
    // outbox admin. That is a visible, operator-resolvable stall, weighed against a wrong quantity
    // at WooCommerce that nobody is told about — see the o3d-8td2 follow-up.
    'stock.push': {
      name: 'stockSync',
      schema: WcStockSyncOutboxPayloadSchema,
      effects: ONE_EFFECT,
      replay: 'unsafe-to-replay',
    },
  },
  xero: {
    // UNSAFE (Codex round 2, HIGH 2 — round 1 declared `remote-write-fenced-by-consumer` here, and
    // that verdict was an AVERAGE over effects that do not agree).
    //
    // This one operation multiplexes every `AccountingSyncType`. The payload carries only
    // `accountingSyncLogId`; the type that decides what actually happens lives on the
    // `AccountingSyncLog` row, which the outbox row neither carries nor joins to. So the reclaim
    // predicate cannot discriminate, and one verdict has to stand for a sales invoice, a bill, a
    // payment, a PDF download, a WooCommerce note and a customer email at once.
    //
    // For the CREATE types the round-1 story is right as far as it goes: o3d-jit6's
    // `renewOutboxLockForRemoteWrite` re-takes this job's claim, CAS on the exact `lockedAt` it
    // holds, immediately before the socket, and for `manual-journal` the same statement mints a
    // durable dispatch record (the only `fenceBeforeRemoteWrite` call site passing a
    // `createDispatchWrite`).
    //
    // INVOICE_EMAIL is the counterexample that decides the entry. Its fence is
    // `lease.fenceBeforeRemoteWrite('invoice-email')` with NO dispatch write, and the effect behind
    // it is `sendAccountingInvoiceEmailInternal` -> `queueEmail` -> a bare `db.emailOutbox.create`.
    // `EmailOutbox` has no idempotency key and no unique constraint of any kind. Worker A can insert
    // the row and pause before completing its sync-log and outbox rows; fifteen minutes later worker
    // B reclaims, passes its own fence honestly (A's lock is now stale), and inserts a SECOND row.
    // Both are delivered. The processor's own comment at that call site says what that means: "a
    // second worker here means the customer receives the invoice twice", and POST_EFFECT.INVOICE_EMAIL
    // adds that the email CANNOT be recalled. A claim proof taken before the effect cannot couple
    // that effect to the completion; only evidence that outlives the worker can.
    //
    // AND THE QUEUE IT ENQUEUES INTO CANNOT RESIST REPLAY EITHER (o3d-alnk, P1). That EmailOutbox
    // has no holder identity — `processingStartedAt` is a timestamp, not a `lockedBy` — and every
    // terminal write is an unfenced `update({ where: { id } })`. An effect whose downstream queue is
    // itself unfenced cannot be declared replay-safe on the strength of the upstream fence, so even
    // a dispatch record minted here would not on its own settle this entry.
    'accounting.post': {
      name: 'postAccountingEvent',
      schema: XeroAccountingOutboxPayloadSchema,
      effects: {
        keyedBy: 'sub-operation',
        discriminator: 'AccountingSyncType (on the AccountingSyncLog the payload points at)',
        weakestKnownEffect: 'INVOICE_EMAIL',
      },
      replay: 'unsafe-to-replay',
    },
  },
  mintsoft: {
    // NOT ENQUEUED TODAY: nothing enqueues or claims this operation, and the schema above says why
    // the entry is a reservation. Assessed against the processor it names anyway, so wiring it up
    // later does not reopen the question. `processBookedInEvent` (lib/domain/wms/booked-in-service.ts)
    // reads the WMS with a GET only, takes `SELECT ... FOR UPDATE` on `wms_inbound_receipt_events`
    // and re-reads `processedAt` inside the same transaction, so a second worker BLOCKS on the row
    // lock and then returns `duplicate` without applying anything. The apply is a DELTA over each
    // line's `lastProcessedReceivedQty`, which is why the second pass has nothing left to book in.
    //
    // ORDERING, re-checked in round 2: the guard sits between the RESUME and the effect, not merely
    // between the claim and the effect. A slow worker that wakes after a reclaim re-enters the same
    // transaction, takes the same row lock, re-reads `processedAt` (line ~320) and returns
    // `duplicate` — it cannot apply a delta computed before it slept, because the delta is
    // recomputed from `lastProcessedReceivedQty` inside the lock. Nothing here is an absolute
    // assignment, so there is no older value that can land last.
    'inbound.booked-in': {
      name: 'processBookedInEvent',
      schema: MintsoftBookedInOutboxPayloadSchema,
      effects: ONE_EFFECT,
      replay: 'local-only-guarded',
    },
  },
  accounting: {
    // The drain re-runs `queueLandedCostAdjustmentJournals`, which writes NOTHING to Xero: it
    // enqueues `AccountingSyncLog` rows, and the Xero post is a separate operation with its own
    // entry above. Each enqueue runs behind `lockFollowUpScope` and then reads every prior attempt
    // for its `landedCostAdjustmentIdempotencyKey` in ANY status before creating, with a unique
    // index behind that (`isIdempotencyKeyIndexCollision`, lib/connectors/xero/queue.ts) catching
    // whatever the read misses; the key is derived from the adjustment (po / event / rounded delta)
    // and not from the wall clock, so a replay months later still collides with the original.
    //
    // ORDERING, re-checked in round 2: the effect is create-if-absent, never an absolute assignment,
    // so "which one lands last" has no meaning — the second create finds or collides with the first
    // whichever order they run in, and neither overwrites the other. MULTIPLEXING, re-checked: the
    // payload carries two arrays (inventory-transit and COGS adjustments), but they are two
    // populations of the SAME effect under the SAME guard and the same key derivation, not two kinds
    // of effect, so one verdict covers both without averaging.
    'landed-cost.adjustment-journal': {
      name: 'processLandedCostAdjustmentJournal',
      schema: LandedCostJournalOutboxPayloadSchema,
      effects: ONE_EFFECT,
      replay: 'local-only-guarded',
    },
  },
  sales: {
    // Local only, and the guard is NOT that allocation is idempotent — it is not (o3d-67y r12 says
    // so in as many words). The guard is that `markSuccess` is called from allocation's
    // `onReconciledInTx` hook (lib/domain/sales/refund-reservation-release-outbox.ts:609,
    // lib/domain/sales/allocation-service.ts:3787), so PROCESSING -> SUCCEEDED commits or rolls back
    // WITH the release itself; and because that mark fences on (lockedBy, lockedAt), a holder whose
    // row was reclaimed mid-allocation fails the mark and its whole allocation transaction rolls
    // back rather than double-releasing. The two workers also serialise on the sales-order lock
    // allocation takes.
    //
    // ORDERING, re-checked in round 2: this is the strongest shape in the registry and the one the
    // two HIGHs above both lack — the effect and the completion are ONE transaction, so a slow
    // worker cannot land an effect it no longer has the right to. There is no window between them
    // for a pause to fall into.
    'refund.reservation-release': {
      name: 'processRefundReservationRelease',
      schema: SalesRefundReservationReleaseOutboxPayloadSchema,
      effects: ONE_EFFECT,
      replay: 'local-only-guarded',
    },
    // Local only. The sole effect is one order-scoped WARNING, delivered by `writeRefundWarningOnce`
    // — a findExisting-then-log pair wrapped by `lockedRefundWarningWriter` in a per-refund
    // advisory-lock transaction, so at most one row exists per (action, refundId) however many
    // workers run it. This row deliberately never touches allocation (o3d-67y r10).
    //
    // ORDERING, re-checked in round 2: `markSuccess` here is OUTSIDE the write's transaction, unlike
    // the release above — so a slow worker CAN re-enter after a reclaim. It re-enters the advisory
    // lock and the findExisting, which is the guard, and writes nothing. The effect is write-once,
    // not an assignment, so a late arrival has no older value to impose.
    'refund.unmatched-warning': {
      name: 'processRefundUnmatchedWarning',
      schema: SalesRefundUnmatchedWarningOutboxPayloadSchema,
      effects: ONE_EFFECT,
      replay: 'local-only-guarded',
    },
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

export type LandedCostJournalOutboxPayload = z.infer<typeof LandedCostJournalOutboxPayloadSchema>
export type SalesRefundReservationReleaseOutboxPayload = z.infer<typeof SalesRefundReservationReleaseOutboxPayloadSchema>
export type WcStockSyncOutboxPayload = z.infer<typeof WcStockSyncOutboxPayloadSchema>
export type XeroAccountingOutboxPayload = z.infer<typeof XeroAccountingOutboxPayloadSchema>
export type MintsoftBookedInOutboxPayload = z.infer<typeof MintsoftBookedInOutboxPayloadSchema>

function getOutboxRegistryEntry(connector: string, operation: string): OutboxRegistryEntry | null {
  const connectorRegistry = INTEGRATION_OUTBOX_REGISTRY[connector as RegisteredOutboxConnector]
  if (!connectorRegistry) return null
  return (connectorRegistry as Record<string, OutboxRegistryEntry>)[operation] ?? null
}

function getOutboxPayloadSchema(connector: string, operation: string): z.ZodTypeAny | null {
  return getOutboxRegistryEntry(connector, operation)?.schema ?? null
}

/**
 * The GOVERNING replay-safety of a registered operation; `null` for one this build does not know.
 *
 * Resolved rather than read: an entry whose effects are keyed by a sub-operation folds to
 * `unsafe-to-replay` however its `replay` field reads, so the multiplexing rule holds at runtime and
 * not only under `tsc` (o3d-8td2 round 2).
 */
export function integrationOutboxReplayPolicy(connector: string, operation: string): OutboxReplaySafety | null {
  const entry = getOutboxRegistryEntry(connector, operation)
  return entry ? resolveOutboxReplaySafety(entry) : null
}

/** The operations of one connector whose declared policy permits a stale-lock reclaim. */
function reclaimableOperationsOf(connector: string): string[] {
  const connectorRegistry = INTEGRATION_OUTBOX_REGISTRY[connector as RegisteredOutboxConnector]
  if (!connectorRegistry) return []
  return Object.entries(connectorRegistry as Record<string, OutboxRegistryEntry>)
    .filter(([, entry]) => outboxReplayPolicyGrantsStaleReclaim(resolveOutboxReplaySafety(entry)))
    .map(([operation]) => operation)
}

/**
 * THE EXTRA PREDICATE A STALE-LOCK RECLAIM HAS TO SATISFY, or `null` when no row may be reclaimed
 * at all under this claim's scope.
 *
 * Answered about the ROW rather than about the claim: a claim scoped to a connector alone, or to
 * nothing, still gets a stale-reclaim arm — restricted to the operations whose declaration permits
 * it, which is what the arm was always implicitly asserting about every row it matched.
 *
 * FAILS CLOSED on anything this build cannot identify. An operation missing from this registry is
 * one whose effects this binary knows nothing about, and "we have never heard of it" is not a reason
 * to believe a second execution is harmless. It costs nothing today — every drain claims its own
 * registered operation — and where it does bite, `permanentlyFailIntegrationOutboxAdminRow` is the
 * operator exit for a row parked with a stale PROCESSING lock.
 */
export function integrationOutboxStaleReclaimScope(
  connector: string | undefined,
  operation: string | undefined,
): Record<string, unknown> | null {
  if (operation) {
    if (!connector) return null
    const policy = integrationOutboxReplayPolicy(connector, operation)
    return policy !== null && outboxReplayPolicyGrantsStaleReclaim(policy) ? {} : null
  }
  if (connector) {
    const operations = reclaimableOperationsOf(connector)
    return operations.length > 0 ? { operation: { in: operations } } : null
  }
  const perConnector = Object.keys(INTEGRATION_OUTBOX_REGISTRY)
    .map((name) => ({ connector: name, operation: { in: reclaimableOperationsOf(name) } }))
    .filter((scope) => scope.operation.in.length > 0)
  return perConnector.length > 0 ? { OR: perConnector } : null
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
