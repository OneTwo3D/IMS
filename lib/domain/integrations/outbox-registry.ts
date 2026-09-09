import { StockSyncReason } from '@/app/generated/prisma/enums'
import { z } from 'zod'

import {
  outboxReplayPolicyGrantsStaleReclaim,
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

type OutboxRegistryEntry<Name extends string = string> = {
  name: Name
  schema: z.ZodTypeAny
  /**
   * WHAT MAKES A SECOND EXECUTION OF THIS OPERATION SAFE (o3d-8td2). REQUIRED, so `tsc` refuses a
   * new registered operation until somebody has answered it — see
   * `lib/domain/integrations/outbox-replay-policy.ts` for what each answer asserts, and for why the
   * outbox's own compare-and-set cannot answer it. Every entry's answer must be justified in a
   * comment beside it, naming the guard or fence it is claiming.
   */
  replay: OutboxReplaySafety
}

function defineOutboxRegistry<const T extends Record<string, Record<string, OutboxRegistryEntry>>>(registry: T): T {
  return registry
}

export const INTEGRATION_OUTBOX_REGISTRY = defineOutboxRegistry({
  woocommerce: {
    // `pushStockToWc` sends `stock_quantity` as an ABSOLUTE integer recomputed from the IMS stock
    // maps at push time (lib/connectors/woocommerce/sync/stock-sync.ts). Two pushes racing assign
    // the same field and the later assignment is the fresher read of the same source; nothing is
    // created, appended or incremented, so a repeat cannot leave WooCommerce holding a quantity IMS
    // does not believe. The connector's own store-version precheck additionally aborts a push whose
    // credentials were rebound underneath it, which retains the job rather than sending a stale set.
    'stock.push': { name: 'stockSync', schema: WcStockSyncOutboxPayloadSchema, replay: 'remote-write-idempotent' },
  },
  xero: {
    // A Xero CREATE, and a repeat past the six-minute idempotency-key window is a second document —
    // the outbox lease is emphatically not what stops that. What stops it is o3d-jit6's fence in
    // lib/connectors/xero/sync-processor.ts: `renewOutboxLockForRemoteWrite` re-takes THIS job's
    // claim, compare-and-set on the exact `lockedAt` it holds, immediately before the socket, and
    // the same lease mints o3d-jit6's pre-post dispatch record by the fence that re-proves the sync
    // row's own claim. A worker whose row was reclaimed cannot renew, so it never reaches the wire —
    // safe DESPITE the reclaim, not because of it.
    'accounting.post': { name: 'postAccountingEvent', schema: XeroAccountingOutboxPayloadSchema, replay: 'remote-write-fenced-by-consumer' },
  },
  mintsoft: {
    // NOT ENQUEUED TODAY: nothing enqueues or claims this operation, and the schema above says why
    // the entry is a reservation. Assessed against the processor it names anyway, so wiring it up
    // later does not reopen the question. `processBookedInEvent` (lib/domain/wms/booked-in-service.ts)
    // reads the WMS with a GET only, takes `SELECT ... FOR UPDATE` on `wms_inbound_receipt_events`
    // and re-reads `processedAt` inside the same transaction, so a second worker BLOCKS on the row
    // lock and then returns `duplicate` without applying anything. The apply is a DELTA over each
    // line's `lastProcessedReceivedQty`, which is why the second pass has nothing left to book in.
    'inbound.booked-in': { name: 'processBookedInEvent', schema: MintsoftBookedInOutboxPayloadSchema, replay: 'local-only-guarded' },
  },
  accounting: {
    // The drain re-runs `queueLandedCostAdjustmentJournals`, which writes NOTHING to Xero: it
    // enqueues `AccountingSyncLog` rows, and the Xero post is a separate operation with its own
    // fence (see `xero/accounting.post` above). Each enqueue runs behind `lockFollowUpScope` and
    // then reads every prior attempt for its `landedCostAdjustmentIdempotencyKey` in ANY status
    // before creating, with the partial unique index behind that; the key is derived from the
    // adjustment (po / event / rounded delta) and not from the wall clock, so a replay months later
    // still collides with the original. A second worker's pass is a no-op.
    'landed-cost.adjustment-journal': { name: 'processLandedCostAdjustmentJournal', schema: LandedCostJournalOutboxPayloadSchema, replay: 'local-only-guarded' },
  },
  sales: {
    // Local only, and the guard is NOT that allocation is idempotent — it is not (o3d-67y r12 says
    // so in as many words). The guard is that `markSuccess` is called from allocation's
    // `onReconciledInTx` hook, so PROCESSING -> SUCCEEDED commits or rolls back WITH the release
    // itself; and because that mark fences on (lockedBy, lockedAt), a holder whose row was reclaimed
    // mid-allocation fails the mark and its whole allocation transaction rolls back rather than
    // double-releasing. The two workers also serialise on the sales-order lock allocation takes.
    'refund.reservation-release': { name: 'processRefundReservationRelease', schema: SalesRefundReservationReleaseOutboxPayloadSchema, replay: 'local-only-guarded' },
    // Local only. The sole effect is one order-scoped WARNING, delivered by `writeRefundWarningOnce`
    // — a findExisting-then-log pair wrapped by `lockedRefundWarningWriter` in a per-refund
    // advisory-lock transaction, so at most one row exists per (action, refundId) however many
    // workers run it. This row deliberately never touches allocation (o3d-67y r10).
    'refund.unmatched-warning': { name: 'processRefundUnmatchedWarning', schema: SalesRefundUnmatchedWarningOutboxPayloadSchema, replay: 'local-only-guarded' },
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

/** The declared replay-safety of a registered operation; `null` for one this build does not know. */
export function integrationOutboxReplayPolicy(connector: string, operation: string): OutboxReplaySafety | null {
  return getOutboxRegistryEntry(connector, operation)?.replay ?? null
}

/** The operations of one connector whose declared policy permits a stale-lock reclaim. */
function reclaimableOperationsOf(connector: string): string[] {
  const connectorRegistry = INTEGRATION_OUTBOX_REGISTRY[connector as RegisteredOutboxConnector]
  if (!connectorRegistry) return []
  return Object.entries(connectorRegistry as Record<string, OutboxRegistryEntry>)
    .filter(([, entry]) => outboxReplayPolicyGrantsStaleReclaim(entry.replay))
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
