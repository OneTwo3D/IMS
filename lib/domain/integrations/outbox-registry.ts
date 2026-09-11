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
 * The two fields are one union, not two independent choices. An operation that admits its effects
 * are keyed by a SUB-OPERATION (`xero/accounting.post`, over `AccountingSyncType`) cannot be
 * declared anything but `unsafe-to-replay`, because a single verdict over several effects is an
 * average, and an average reads as an answer while asserting nothing about the member that matters.
 *
 * Nor can an operation whose run is an EFFECT SEQUENCE — one guarded effect followed by effects the
 * guard does not cover (o3d-8td2 round 3). `mintsoft/inbound.booked-in` declared itself
 * single-effect and was not, which is the escape this arm closes: an entry can no longer buy a
 * reclaimable verdict by describing only the part of its run that deserves one.
 */
type OutboxRegistryEntry<Name extends string = string> =
  & { name: Name; schema: z.ZodTypeAny }
  & (
    | { effects: { keyedBy: 'operation' }; replay: OutboxReplaySafety }
    | {
      effects: { keyedBy: 'sub-operation'; discriminator: string; weakestKnownEffect: string }
      replay: 'unsafe-to-replay'
    }
    | {
      effects: {
        keyedBy: 'effect-sequence'
        guardedEffect: string
        effectsOutsideTheGuard: readonly [string, ...string[]]
      }
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
    // THE PARK IS NOT FREE, and round 2 priced it with two claims that were both FALSE (Codex round
    // 3, HIGH; o3d-22jw records the corrected analysis). `applyStockOutboxPayload` folds a new stock
    // change into an existing PROCESSING row rather than creating another, so a row parked here
    // keeps absorbing enqueues and none of them drain. Round 2 called that acceptable because the
    // daily reconcile shared the key and an operator could see the row anyway. Verified in round 3:
    //
    //   THE DAILY RECONCILE DOES NOT SHARE THE KEY. `runWooCommerceDailyReconcile`
    //   (lib/connectors/woocommerce/sync/reconcile.ts) calls `pushStockToWc({ forceAll: true })`
    //   DIRECTLY. It never enqueues, never claims, never completes an outbox row. So it re-pushes
    //   the correct quantity once a day and leaves the park untouched — which means the park
    //   survives every reconcile, and between two of them a change made a minute after the crash
    //   waits up to 24 hours. For a stock quantity that is an oversell window, not a delay.
    //
    //   THE PARK WAS NOT VISIBLE WHERE ANYBODY LOOKS. The exception inbox listed `PERMANENT_FAILED`
    //   and nothing else, so a stalled PROCESSING row appeared on no operator surface at all; the
    //   admin list would show it only to someone who already suspected it and filtered for it.
    //
    // AND NOTHING IN THIS BRANCH PAYS FOR IT (o3d-8td2 r8 — the whole park surface was WITHDRAWN,
    // and o3d-7qdb carries it). Rounds 3 through 7 answered the two findings above with an operator
    // surface: a derived list of stalled parks in the exception inbox, first with a one-click
    // recovery, then with the recovery removed, then with guidance and structural guards around what
    // was left. Five Codex HIGHs came out of it in four rounds — the recovery replayed what this very
    // verdict forbids (r3), `PERMANENT_FAILED` turned out not to be inert so the recovery replayed it
    // by a slower route (r5), the listing's own copy directed operators onto that route (r6), and
    // then the GUARDS meant to keep the section safe were themselves found incomplete (r7). That last
    // one is the reason it is gone rather than fixed again: a guard built by enumerating what an
    // operator or a component might do has no closing condition.
    //
    // SO THE HONEST POSITION IS WORSE THAN ROUND 2 CLAIMED AND IS WRITTEN DOWN AS SUCH: a row parked
    // here is invisible on the exception inbox (the admin outbox API can still list PROCESSING rows
    // to somebody who already suspects one), the daily reconcile corrects the QUANTITY once a day
    // without touching the row, and every stock change in between is folded into the park and waits.
    // What this branch does fix is the VERDICT — `unsafe-to-replay` here and on `xero/accounting.post`
    // — so no second worker is handed the row at all. o3d-22jw tracks the black hole; o3d-7qdb tracks
    // an operator remedy that does not rest on elapsed time.
    //
    // THE PARK IS STILL A PARK, and that is deliberate. An automatic drain would be a second worker
    // executing the same absolute push, which is the exact reordering hazard this entry is
    // `unsafe-to-replay` for; a self-healing sweep here would reintroduce the defect while looking
    // like the fix. The real fix is the monotonic push generation named above.
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
    // it is `sendAccountingInvoiceEmailInternal` -> `queueEmail` -> `db.emailOutbox.create`. Worker A
    // can insert the row and pause before completing its sync-log and outbox rows; fifteen minutes
    // later worker B reclaims, passes its own fence honestly (A's lock is now stale), and inserts a
    // SECOND row. Both are delivered. The processor's own comment at that call site says what that
    // means: "a second worker here means the customer receives the invoice twice", and
    // POST_EFFECT.INVOICE_EMAIL adds that the email CANNOT be recalled. A claim proof taken before
    // the effect cannot couple that effect to the completion; only evidence that outlives the worker
    // can.
    //
    // THE TWO DATABASE FACTS THIS USED TO REST ON ARE BOTH GONE, AND THE VERDICT IS UNCHANGED
    // (o3d-alnk). Rounds 1-3 argued the above from two properties of the table, and o3d-alnk's fence
    // branch removed both. They are restated here as what is TRUE AFTER BOTH BRANCHES, because a
    // verdict standing on a false reason is a verdict nobody can re-check:
    //
    //   1. IT SAID `EmailOutbox` HAS "no idempotency key and no unique constraint of any kind".
    //      It now has `email_outbox_undelivered_reference_uq`, a PARTIAL unique index on
    //      (kind, referenceType, referenceId) WHERE status IN ('PENDING','PROCESSING'). That refuses
    //      a duplicate UNDELIVERED ROW — and a duplicate undelivered row is not the hazard. The
    //      reclaim window is `ADMIN_OUTBOX_STALE_PROCESSING_LOCK_MS` wide and the email drain empties
    //      PENDING inside it, so by the time worker B replays, A's copy is typically already SENT —
    //      outside the predicate. B's insert is accepted and the customer is emailed twice. The index
    //      closes the window in which nothing had been delivered yet and leaves open the one in which
    //      something has. Nor could any constraint here have closed it: a send is not a database
    //      write, so refusing a second ROW cannot unsend a mail already on the wire.
    //      Proven, not asserted, in tests/concurrency/outbox-stale-park.concurrent.test.ts: a SENT
    //      first copy, then a second PENDING insert the database accepts (inside a rolled-back
    //      transaction, so no mail can leave).
    //
    //   2. IT SAID THE QUEUE HAS "no holder identity — `processingStartedAt` is a timestamp, not a
    //      `lockedBy`" — and every terminal write an unfenced `update({ where: { id } })`. It now has
    //      a per-claim `lockedBy` token and terminal writes that compare-and-set on it. That closes
    //      the queue's OWN re-arming race, and it does not touch this one: the two workers that
    //      duplicate an invoice email here are one reclaim apart in the INTEGRATION outbox, and each
    //      enqueues a row of its own that the email drain then handles correctly and separately. A
    //      fence inside the downstream queue cannot see a duplicate that arrived as two legitimate
    //      enqueues.
    //
    // So `unsafe-to-replay` stands on the argument above rather than on either removed fact — and it
    // is over-determined in any case, because `effects.keyedBy` is 'sub-operation': INVOICE_EMAIL is
    // only the WEAKEST known effect of an entry that also multiplexes the CREATE types, and the
    // reclaim predicate cannot discriminate between them.
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
    // UNSAFE (Codex round 3, MEDIUM 1 — round 2 declared this `local-only-guarded` under
    // `ONE_EFFECT`, and the "one effect" half of that was simply not true of the processor).
    //
    // What round 2 said about the GUARDED part is right, and is kept because it is still the reason
    // the guarded part needs no more than this: `processBookedInEvent`
    // (lib/domain/wms/booked-in-service.ts) reads the WMS with a GET only, takes
    // `SELECT ... FOR UPDATE` on `wms_inbound_receipt_events`, re-reads `processedAt` inside the
    // same transaction, and applies a DELTA over each line's `lastProcessedReceivedQty`. A second
    // worker BLOCKS on the row lock and then returns `duplicate` with nothing left to book in, and
    // because the delta is recomputed inside the lock a slow worker cannot apply one it computed
    // before it slept. For the RECEIPT, the guard sits between the resume and the effect.
    //
    // BUT THE RECEIPT IS NOT THE RUN. The transaction closes at line ~1085; after it commits,
    // `processBookedInEvent` goes on to do three more things, none of them under any guard:
    //
    //   1. `enqueueStockSync(processed.productIds, 'IMS_CHANGE')` (~1131) — the WooCommerce stock
    //      push for every product whose quantity just changed. Its own throw is swallowed and logged.
    //   2. `logActivity(... 'mintsoft_booked_in_processed')` (~1137).
    //   3. `recordWmsMutationEvent(... 'booked_in_receipt', 'SUCCEEDED')` (~1150) — the audit trail
    //      the ASN timeline is built from.
    //
    // A crash anywhere in that tail is UNRECOVERABLE, and it is the guard that makes it so:
    // `processedAt` is already committed, so the reclaim's second worker re-reads it, answers
    // `duplicate` at line ~1087 and completes the outbox row SUCCEEDED — having applied nothing.
    // Stock is booked in and WooCommerce is never told; the audit row for a mutation that really
    // happened never exists. That is not a duplicate the guard prevented, it is a silent partial
    // application the guard CAUSED, and `local-only-guarded` asserts the opposite of it.
    //
    // AND ONE EFFECT ESCAPES IN THE OTHER DIRECTION. The `received_warehouse_divergence` WARNING at
    // line ~674 is inside the transaction but is issued through `logActivity`, which writes on the
    // GLOBAL `db` client, not on `tx` (lib/activity-log.ts — `logActivityInTransaction` is the one
    // that takes a client, and it is not the one used here). So it commits on its own connection: a
    // rollback of the receipt work leaves the warning standing, and the retry writes a second one.
    // The same operation therefore both loses effects and duplicates them.
    //
    // STILL NOT ENQUEUED TODAY — nothing enqueues or claims this operation, and the schema above
    // says why the entry is a reservation. That is precisely why the round-2 declaration was the
    // dangerous kind of wrong: a dormant entry is read as settled by whoever wires it up, and this
    // one said the assessment had already been done. Wiring it up now inherits a refusal instead.
    // To earn a reclaimable verdict, move the three tail effects inside the transaction (the stock
    // sync as an outbox row enqueued on `tx`, the audit and activity writes on `tx`) and switch the
    // divergence warning to `logActivityInTransaction`.
    'inbound.booked-in': {
      name: 'processBookedInEvent',
      schema: MintsoftBookedInOutboxPayloadSchema,
      effects: {
        keyedBy: 'effect-sequence',
        guardedEffect: 'the receipt application, under SELECT ... FOR UPDATE on wms_inbound_receipt_events + processedAt',
        effectsOutsideTheGuard: [
          'enqueueStockSync (post-commit): the WooCommerce stock push for every product booked in',
          'logActivity mintsoft_booked_in_processed (post-commit)',
          'recordWmsMutationEvent booked_in_receipt/SUCCEEDED (post-commit)',
          'logActivity received_warehouse_divergence (in-transaction, but on the global db client, so it commits independently)',
        ],
      },
      replay: 'unsafe-to-replay',
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
 * registered operation.
 *
 * AND WHERE IT DOES BITE, THERE IS NO EXIT TO NAME (o3d-8td2 r7 MEDIUM, corrected r8). Until round 7
 * this comment ended by calling `permanentlyFailIntegrationOutboxAdminRow` "the operator exit for a
 * row parked with a stale PROCESSING lock". It is not an exit. That function writes the
 * `integration_outbox` row and nothing else, so for Xero the owning `AccountingSyncLog` is untouched
 * and stays selectable by `ensureXeroOutboxForPendingSyncLogs` — the first statement of every sweep
 * — which re-queues the row through `scheduleXeroAccountingOutbox` on that same sweep; a WooCommerce
 * row is reset to PENDING by the next ordinary stock change for the product. Dead-lettering a park
 * is a slower replay, not a stop. A maintainer sent here looking for a remedy must be told there is
 * none rather than pointed at a mutation: the remedy is a read of the remote system and a correction
 * made THERE, and a safe automated one is open as o3d-7qdb.
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
