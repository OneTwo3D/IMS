import type { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { getIntegrationPluginState } from '@/lib/integration-plugins'
import { WMS_CONNECTOR_IDS } from '@/lib/connectors/wms/types'
import { getWmsConnector } from '@/lib/connectors/wms/registry'
import type { WmsConnector, WmsOrderAddress, WmsOrderPushInput, WmsOrderPushLine } from '@/lib/connectors/wms/types'
import { decideWmsHeldRelease, wmsAmbiguousCreateMayBeReplayed, wmsAmbiguousCreateRefusal } from './create-replay-policy'
import { WMS_CREATE_ELIGIBLE_ORDER_FENCES, wmsCreateEligibleOrderWhere } from './create-eligibility'
import { scrubWmsError } from './error-scrub'
import { recordWmsMutationEvent, type WmsMutationEventInput } from './mutation-audit'
import { createWmsPushStateSchemaGate, WMS_PUSH_STATE_ENUM } from './push-state-schema-gate'

/**
 * Connector-agnostic outbound order-push sweep (Phase 8). Pushes IMS sales
 * orders to the active WMS for fulfilment and propagates cancellations.
 *
 * Eligibility (create): ship-from warehouse bound to the active WMS connector,
 * status ready-to-fulfil (PROCESSING/ALLOCATED), and paid. Idempotent via the
 * WmsOrderPushLink (orderId unique); failed pushes retry up to MAX_ATTEMPTS then
 * dead-letter. The reverse direction — inbound dispatch→tracking — flows via the
 * connector-agnostic dispatch sweep (lib/domain/wms/dispatch-sweep.ts), which feeds
 * applyExternalFulfillmentUpdate once the WMS reports the order despatched.
 */

const READY_STATUSES = ['PROCESSING', 'ALLOCATED'] as const
/** Lifecycle statuses where the WMS order is already dispatched. A (full) refund on a
 *  dispatched order is a returns/financial matter — never a WMS cancellation. Under the
 *  orthogonal refund model a fully-refunded order keeps its lifecycle status, so this set
 *  is what distinguishes "pull it from the WMS" from "goods already gone". */
const POST_DISPATCH_STATUSES = ['SHIPPED', 'COMPLETED', 'DELIVERED'] as const
const MAX_ATTEMPTS = 5

/**
 * o3d-2k5r r3 — how many warehouse-presence probes ONE sweep may spend resolving ambiguous
 * revalidation candidates.
 *
 * The revalidation pass is otherwise purely local (no connector call, no API budget), and both
 * connectors implement the probe as a real search — Mintsoft an Order/Search, ShipHero a
 * credit-consuming GraphQL query. Bounding it keeps a backlog of ambiguous claims from turning
 * a local pass into a per-sweep quota drain.
 *
 * Running out is a DELAY, never a decision: an unprobed link is re-stamped and rotates back in on
 * a later sweep, and nothing is re-queued without an answer.
 */
const PRESENCE_PROBE_BUDGET = 5

/**
 * How long a create claim is exclusive (o3d-38gl).
 *
 * PENDING_CREATE is a STATE, not a claim: it cannot distinguish "I just took this" from
 * "another worker took this and is still talking to the WMS". Worker A wrote PENDING_CREATE and
 * committed; worker B then acquired the order lock, saw PENDING_CREATE, passed the check and
 * also called pushOrder. Worst on ShipHero, where preflight and create are separate operations
 * and partner_order_id is not unique — two winners can create and then fulfil DUPLICATE
 * warehouse orders.
 *
 * `lastAttemptAt` is already stamped on every claim, so it doubles as the lease with no schema
 * change: a claim is refused while another worker's stamp is still fresh. Long enough to cover
 * the slowest plausible pushOrder round trip, short enough that a crashed worker's order is
 * retried in minutes rather than stranded.
 *
 * o3d-2k5r r4 — AND EXPIRY IS NOT A HANDOVER. The lease used to GRANT the claim to the next
 * worker once it lapsed, which is what made the ordinary crash duplicate an order: a create that
 * reached the WMS before the worker died leaves nothing behind but this claim, and five minutes
 * later the claim was simply re-issued and the create repeated. The lease now decides only whether
 * a worker may STILL be inside pushOrder; a lapsed one is parked, never handed on. See
 * {@link decideCreateClaim}.
 */
const CREATE_CLAIM_LEASE_MS = 5 * 60 * 1000

/**
 * What a worker may do with the link it found under the order lock (o3d-2k5r r4).
 *
 * Three answers, because the old two were the defect. `shouldGrantCreateClaim` returned a boolean,
 * and a boolean forced "an expired claim" into the same bucket as "a link nobody has touched" —
 * so the only thing the create pass could do with a crashed worker's claim was take it and push
 * again.
 */
export type WmsCreateClaimDecision =
  /** No create has been dispatched for this order. Take the claim and call the WMS. */
  | 'CLAIM'
  /** Someone else owns this link, or is inside pushOrder right now. Do nothing at all. */
  | 'SKIP'
  /**
   * A create WAS dispatched and nothing ever recorded its outcome. Not this pass's to retry:
   * park it where the ambiguity is visible and let the reconciliation pass apply the connector's
   * replay policy.
   */
  | 'PARK_AMBIGUOUS'

/**
 * The create-claim rule, pure so it can be tested without a database — the claim itself needs the
 * order row lock, which a unit test cannot express.
 *
 * THE ONE THING THAT LICENCES A CREATE IS THE ABSENCE OF A DISPATCH STAMP. `lastAttemptAt` is
 * written by `claimForCreate` in the same transaction as the claim and IMMEDIATELY BEFORE the
 * remote call, so a PENDING_CREATE link carrying one means "a create request left this system and
 * we may never have learned what became of it". Every writer that legitimately (re-)queues an order
 * — the HELD release, the revalidation promote, the operator replay — CLEARS the stamp, and that
 * cleared stamp is the positive evidence this rule grants on. A stamp that is merely OLD is not
 * evidence of anything except elapsed time.
 *
 * `null` existing = no link at all, so no worker has claimed the order and pushOrder cannot have
 * been invoked. A non-PENDING_CREATE state means someone else owns the link (SYNCED, CANCELLED,
 * DEAD_LETTER, HELD, AMBIGUOUS_CREATE) and this pass has no business touching it.
 */
export function decideCreateClaim(
  existing: { state: string; lastAttemptAt: Date | null } | null,
  attemptedAt: Date,
  leaseMs: number = CREATE_CLAIM_LEASE_MS,
): WmsCreateClaimDecision {
  if (!existing) return 'CLAIM'
  if (existing.state !== 'PENDING_CREATE') return 'SKIP'
  // Queued and never dispatched — by the claim that has not happened yet, or by a writer that
  // cleared the stamp precisely to say so.
  if (!existing.lastAttemptAt) return 'CLAIM'
  // Inside the lease: another worker is plausibly still talking to the WMS. Touching the link now
  // would race a live push AND move its lease clock forward.
  if (attemptedAt.getTime() - existing.lastAttemptAt.getTime() < leaseMs) return 'SKIP'
  return 'PARK_AMBIGUOUS'
}

/**
 * May this worker take the create claim and call the WMS?
 *
 * Deliberately NARROWER than it used to be: an expired claim no longer qualifies. Kept as its own
 * function because it is the question the create path actually asks, and because stating it in
 * terms of {@link decideCreateClaim} is what stops the two drifting apart.
 */
export function shouldGrantCreateClaim(
  existing: { state: string; lastAttemptAt: Date | null } | null,
  attemptedAt: Date,
  leaseMs: number = CREATE_CLAIM_LEASE_MS,
): boolean {
  return decideCreateClaim(existing, attemptedAt, leaseMs) === 'CLAIM'
}

/**
 * May this worker write a DISPOSITION over the link — a state change that sends no request?
 *
 * A wider question than the claim, and a different one. `recordValidationFailure` is not going to
 * call the WMS, so an expired claim is something it may legitimately convert (that conversion is
 * how a stale claim becomes an AMBIGUOUS disposition rather than silently reading as "nothing
 * happened"). What it must never do is stamp itself over a link that has MOVED ON, or over a claim
 * whose holder is still inside pushOrder — which is exactly `SKIP`.
 */
export function mayDisposeCreateClaim(
  existing: { state: string; lastAttemptAt: Date | null } | null,
  attemptedAt: Date,
  leaseMs: number = CREATE_CLAIM_LEASE_MS,
): boolean {
  return decideCreateClaim(existing, attemptedAt, leaseMs) !== 'SKIP'
}

/**
 * o3d-2k5r — the ONE rule for "no remote WMS call was ever made for this order", written once
 * so no reader has to re-derive it from the columns and get it wrong.
 *
 * THE ONLY UNCONDITIONAL PROOF IS AN ABSENT LINK. Every other answer is a claim about a row
 * that was written by SOMETHING, and every writer of this row except one writes it either
 * side of a connector call whose outcome it may never learn.
 *
 * The single exception is a VALIDATION_FAILED disposition that `recordValidationFailure`
 * CREATED — buildPushInput threw on purely local data before anything was claimed, so
 * pushOrder was demonstrably never invoked. That is recorded as attempts 0 / pushedAt null /
 * externalOrderId null, and the writer is what makes those columns mean it:
 *
 *   - It refuses outright while a PENDING_CREATE claim's lease is still fresh, so it can
 *     never stamp itself over a worker that is mid-push.
 *   - When it converts an EXPIRED PENDING_CREATE claim it raises `attempts` to at least
 *     AMBIGUOUS_ATTEMPTS. A claim exists only because a worker was about to call the WMS,
 *     and `attempts` is incremented on the remote-failure path by a write that is itself
 *     `.catch(() => {})`-swallowed and does not run at all if the process is killed — so a
 *     pre-existing claim at attempts 0 means "a call was dispatched and the outcome is
 *     unknown", NOT "nothing happened".
 *
 * `attempts` therefore counts REMOTE CALLS THAT MAY HAVE BEEN DISPATCHED, not remote calls
 * known to have failed. That is the reading the hard-delete guard needs, and it is the only
 * reading that is safe when the answer is used to erase the last local record of a
 * warehouse order.
 *
 * WRITER AND READER SHARE THE COLUMNS THEMSELVES (o3d-2k5r r2). The constants below are what
 * `recordValidationFailure`'s create branch WRITES and what the predicates READ, so a change to
 * one is a change to the other by construction — the previous version restated the invariant by
 * hand in the writer and tied the two together with nothing but a pair of test assertions.
 */

/** The columns that say NO WMS ORDER EXISTS for this link. */
export const NO_WMS_ORDER_COLUMNS = { pushedAt: null, externalOrderId: null } as const

/** ...and, with attempts, that no remote call was ever DISPATCHED for it. */
export const NO_REMOTE_WMS_CALL_COLUMNS = { attempts: 0, ...NO_WMS_ORDER_COLUMNS } as const

/**
 * The number `recordValidationFailure` raises a CONVERTED claim to, so the columns stop reading
 * as proof.
 *
 * KNOWN COST, accepted deliberately: `attempts` is also the create pass's retry ladder, so a
 * converted claim that in fact made no call dead-letters after MAX_ATTEMPTS - AMBIGUOUS_ATTEMPTS
 * further real attempts rather than MAX_ATTEMPTS. Separating "calls that may have been
 * dispatched" from "retries spent" needs a second column and therefore a migration; until then
 * one spent retry is the price of not hard-deleting an order the warehouse may be picking, and
 * the delete guard's message says "may have been dispatched" rather than reporting the count as
 * a record of attempts made.
 */
export const AMBIGUOUS_ATTEMPTS = 1

/**
 * Does this link carry positive evidence that a WMS ORDER EXISTS for its order?
 *
 * The strongest of the three answers, and the cheapest: an id or a push stamp is a RECORD that
 * a warehouse order was minted. Nothing may re-open a create for such a link — createCandidates
 * selects on state alone, so a promote here mints a SECOND warehouse order for the same sales
 * order and overwrites the first id.
 */
export function wmsOrderMayExist(
  link: { pushedAt: Date | null; externalOrderId: string | null },
): boolean {
  return link.pushedAt !== NO_WMS_ORDER_COLUMNS.pushedAt
    || link.externalOrderId !== NO_WMS_ORDER_COLUMNS.externalOrderId
}

/**
 * o3d-2k5r r3 — the middle answer, and the one the branch previously did not have.
 *
 * NO record of a warehouse order, but spent attempts: a create MAY have been dispatched and its
 * outcome was never written back. This is exactly the shape `recordValidationFailure` mints when
 * it CONVERTS an expired PENDING_CREATE claim (attempts raised to AMBIGUOUS_ATTEMPTS, id and
 * stamp still null), and it is also every failed create on the retry ladder — a throw from
 * pushOrder can be a timeout on a request the WMS went on to honour.
 *
 * "Ambiguous" is NOT "safe to retry". A re-queue is bounded by MAX_ATTEMPTS, but the thing it
 * risks — a second physical fulfilment under an id IMS never learned — is not reversible and
 * cannot be cancelled automatically. So every writer that re-opens a create for such a link must
 * first obtain the WAREHOUSE'S OWN WORD that no such order exists (probeOrderPresence ===
 * 'MISSING'), or leave it to an operator.
 */
export function wmsCreateOutcomeIsAmbiguous(
  link: { attempts: number; pushedAt: Date | null; externalOrderId: string | null },
): boolean {
  // An order that positively may EXIST is not merely ambiguous — a stronger refusal already
  // covers it, and reporting it as ambiguous would invite a probe whose answer changes nothing.
  if (wmsOrderMayExist(link)) return false
  return link.attempts !== NO_REMOTE_WMS_CALL_COLUMNS.attempts
}

/**
 * Does this WmsOrderPushLink prove that nothing was ever sent to the WMS for its order?
 *
 * Pure, exported, and shared by the writer (through NO_REMOTE_WMS_CALL_COLUMNS), the hard-delete
 * guard and the revalidation re-queue, so the three cannot drift. `null` (no link at all) is the
 * only unconditional yes.
 *
 * On the pushedAt / externalOrderId conjuncts: NO writer in this file can currently produce a
 * VALIDATION_FAILED link that carries either one AT attempts 0 — every conversion of a
 * pre-existing link raises attempts to AMBIGUOUS_ATTEMPTS, and the create branch mints all three
 * columns together from NO_REMOTE_WMS_CALL_COLUMNS. So for THIS reader they are unreachable
 * belt-and-braces, and the earlier comment claiming they catch a real shape ("it pushed, then its
 * payload stopped building") was wrong. They are not decoration: they are reachable and load-
 * bearing for `wmsOrderMayExist`, whose caller reads links at attempts >= 1 — a HELD link that is
 * released keeps its pushedAt, and can then be converted to VALIDATION_FAILED.
 */
export function provesNoRemoteWmsCall(
  link: { state: string; attempts: number; pushedAt: Date | null; externalOrderId: string | null } | null,
): boolean {
  if (!link) return true
  if (link.state !== 'VALIDATION_FAILED') return false
  if (wmsOrderMayExist(link)) return false
  // The three answers are ONE ladder, so a reader cannot pick up "no order exists" without also
  // picking up "…and none may have been dispatched" (o3d-2k5r r3).
  return !wmsCreateOutcomeIsAmbiguous(link)
}
const DEFAULT_BATCH_SIZE = 25
/** o3d-rbyg: shared empty result for the live withdrawal screen — "nothing withdrawn", not "unknown". */
const EMPTY_ORDER_ID_SET: ReadonlySet<string> = new Set<string>()

export type WmsOrderPushSweepResult = {
  skipped?: string
  created: number
  /** o3d-bjc.8: links promoted from PENDING_VERIFY to SYNCED this sweep. */
  verified: number
  /** o3d-bjc.8: links quarantined by verification (foreign, or unresolvable past the bound). */
  verifyQuarantined: number
  /** o3d-bjc.8: links still awaiting a verdict — counted so an unknown is not silent. */
  verifyUnresolved: number
  updated: number
  cancelled: number
  held: number
  released: number
  failed: number
  deadLettered: number
  /**
   * o3d-92fu: orders parked VALIDATION_FAILED this sweep — the payload could not be
   * BUILT from local data, so no remote call was made. Deliberately NOT folded into
   * `failed`: `failed` means "we talked to the WMS and it did not work", and a sweep
   * reporting a remote failure that never happened sends an operator to the connector.
   */
  validationFailed: number
  /** o3d-92fu: VALIDATION_FAILED links whose payload builds again — returned to the create queue. */
  revalidated: number
  /**
   * o3d-2k5r r3: VALIDATION_FAILED links whose payload builds again but which were NOT re-queued,
   * because a create may already have been dispatched and the warehouse could not confirm the
   * order is absent. Counted separately from `revalidated` because they are the opposite outcome,
   * and separately from `failed` because nothing was sent — they are waiting on a warehouse answer
   * or on an operator.
   */
  revalidateAmbiguous: number
  /**
   * o3d-2k5r r4 — expired create claims PARKED this sweep because a create was dispatched for them
   * and nothing recorded the outcome. Counted apart from `failed`: nothing failed, and apart from
   * `revalidateAmbiguous`, which is the same refusal reached from the validation-failure route.
   */
  createClaimParked: number
  /** ...and parked links this sweep put back in the create queue, on the connector's replay policy. */
  ambiguousCreateRequeued: number
}

type OrderForPush = {
  id: string
  orderNumber: string | null
  externalOrderNumber: string | null
  currency: string
  customerName: string | null
  customerEmail: string | null
  customerVatNumber: string | null
  shippingAddress: unknown
  shippingService: string | null
  subtotalForeign: unknown
  shippingForeign: unknown
  taxForeign: unknown
  taxRatePercent: unknown
  pricesIncludeVat: boolean
  discountAmount: unknown
  totalForeign: unknown
  lines: CandidateLine[]
  refunds?: Array<{ lines: Array<{ salesOrderLineId: string | null; qty: unknown }> }>
}

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

/**
 * G6 (vn92.5) penny-precision guard. Returns the absolute drift, in pence, between an
 * order's declared total and the total re-derived from its own component fields
 * (subtotal + tax + shipping − discount). For a VAT-inclusive order the stored discount
 * is gross, so its embedded VAT must be added back (IMS computes tax on the discounted
 * net): validated against real orders — a £12 gross discount on a 20% order reconciles
 * only once its £2 VAT is added back. The effective rate is taken from taxRatePercent,
 * falling back to tax/(total−tax) when the named rate is absent.
 *
 * This is advisory only: the caller records the drift on the push link for operator
 * review but still pushes the order (a mis-derived formula must never block fulfilment).
 */
export function orderTotalDriftPence(order: {
  subtotalForeign: unknown
  taxForeign: unknown
  taxRatePercent: unknown
  shippingForeign: unknown
  discountAmount: unknown
  totalForeign: unknown
  pricesIncludeVat: boolean
}): number {
  const subtotal = num(order.subtotalForeign)
  const tax = num(order.taxForeign)
  const shipping = num(order.shippingForeign)
  const discount = num(order.discountAmount)
  const total = num(order.totalForeign)

  let discountVat = 0
  if (order.pricesIncludeVat && discount > 0) {
    const named = num(order.taxRatePercent)
    const rate = named > 0 ? named : total > tax ? tax / (total - tax) : 0
    if (rate > 0) discountVat = (discount * rate) / (1 + rate)
  }

  const computed = subtotal + tax + shipping - discount + discountVat
  return Math.round(Math.abs(computed - total) * 100)
}

/**
 * Rounded-pence drift ABOVE this is surfaced for review. orderTotalDriftPence rounds to
 * whole pence, so with `> 1` the effective trigger is ≥2p (a raw drift up to ~1.5p rounds
 * to 1 and is tolerated) — a rounded penny of slack, deliberately lenient for an advisory
 * flag so ordinary sub-penny VAT rounding never trips it.
 */
const TOTAL_DRIFT_TOLERANCE_PENCE = 1

export function readAddress(raw: unknown, customerName: string | null): WmsOrderAddress {
  const a = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const str = (...keys: string[]): string => {
    for (const key of keys) {
      const v = a[key]
      if (typeof v === 'string' && v.trim()) return v.trim()
    }
    return ''
  }
  const [firstName, ...rest] = (customerName ?? '').trim().split(/\s+/).filter(Boolean)
  return {
    firstName: firstName ?? '',
    lastName: rest.join(' '),
    company: str('company'),
    address1: str('line1', 'address1', 'address_1'),
    address2: str('line2', 'address2', 'address_2'),
    town: str('city', 'town'),
    county: str('county', 'state'),
    postCode: str('postcode', 'postCode', 'postal_code'),
    country: str('country'),
  }
}

type CandidateLine = {
  id?: string
  sku: string | null
  qty: unknown
  taxForeign: unknown
  totalForeign: unknown
  description: string
}

export function buildLines(lines: CandidateLine[], refundedByLine?: Map<string, number>): WmsOrderPushLine[] {
  const pushLines: WmsOrderPushLine[] = []
  for (const line of lines) {
    // A line with no SKU can't be fulfilled by the WMS — fail the whole order rather than
    // silently dropping the line. o3d-92fu: the create pass builds the payload BEFORE it
    // claims anything, so this no longer retries and dead-letters; it parks the order
    // VALIDATION_FAILED (no claim, no remote call) and the revalidation pass re-queues it
    // once the SKU is filled in.
    if (!line.sku) throw new Error('Sales order has a line with no SKU; cannot push to WMS')
    const orderedQty = num(line.qty) || 1
    // Refunded units must not be pushed to the WMS for fulfilment (refund state is
    // orthogonal to the lifecycle status now). Net by the line's refunded qty; a fully
    // refunded line is dropped from the payload entirely.
    const refunded = (line.id && refundedByLine?.get(line.id)) || 0
    const quantity = Math.max(0, orderedQty - refunded)
    if (quantity <= 0) continue
    // IMS stores SalesOrderLine.totalForeign as NET (ex-VAT) in both tax-inclusive
    // and tax-exclusive cases; taxForeign is the line VAT. Unit prices are per the
    // ORIGINAL qty so they stay correct when the shipped quantity is reduced.
    const total = num(line.totalForeign)
    const tax = num(line.taxForeign)
    pushLines.push({
      sku: line.sku,
      quantity,
      unitPriceExVat: total / orderedQty,
      unitPriceVat: tax / orderedQty,
      description: line.description || null,
    })
  }
  return pushLines
}

// Fields the push payload needs; shared by the create and update passes.
const ORDER_PUSH_SELECT = {
  id: true,
  orderNumber: true,
  externalOrderNumber: true,
  currency: true,
  customerName: true,
  customerEmail: true,
  customerVatNumber: true,
  shippingAddress: true,
  shippingService: true,
  subtotalForeign: true,
  shippingForeign: true,
  taxForeign: true,
  taxRatePercent: true,
  pricesIncludeVat: true,
  discountAmount: true,
  totalForeign: true,
  lines: { select: { id: true, sku: true, qty: true, taxForeign: true, totalForeign: true, description: true } },
  refunds: { select: { lines: { select: { salesOrderLineId: true, qty: true } } } },
} as const

/**
 * The reference IMS puts on the WMS order — and therefore the ONLY string a presence probe can
 * meaningfully ask the warehouse about (o3d-2k5r r3).
 *
 * Exported so the manual dead-letter replay probes the SAME reference a create would have used.
 * A probe against a different string is not weaker evidence, it is evidence about a different
 * question, and "MISSING" from it would license the duplicate it was supposed to prevent.
 */
export function wmsPushOrderReference(
  order: { id: string; orderNumber: string | null; externalOrderNumber: string | null },
): string {
  return order.orderNumber ?? order.externalOrderNumber ?? order.id
}

function buildPushInput(order: OrderForPush, externalWarehouseId: string): WmsOrderPushInput {
  return {
    orderNumber: wmsPushOrderReference(order),
    externalReference: order.id,
    externalWarehouseId,
    currency: order.currency,
    shippingAddress: readAddress(order.shippingAddress, order.customerName),
    email: order.customerEmail,
    phone: null,
    vatNumber: order.customerVatNumber,
    comments: null,
    courierService: order.shippingService,
    totalVat: num(order.taxForeign),
    shippingExVat: num(order.shippingForeign),
    shippingVat: 0,
    discountExVat: num(order.discountAmount),
    discountVat: 0,
    lines: buildLines(order.lines, refundedQtyByLine(order)),
  }
}

// Sum refunded quantity per sales-order line so the WMS payload can exclude it.
function refundedQtyByLine(order: { refunds?: Array<{ lines: Array<{ salesOrderLineId: string | null; qty: unknown }> }> }): Map<string, number> {
  const map = new Map<string, number>()
  for (const refund of order.refunds ?? []) {
    for (const line of refund.lines) {
      if (!line.salesOrderLineId) continue
      map.set(line.salesOrderLineId, (map.get(line.salesOrderLineId) ?? 0) + num(line.qty))
    }
  }
  return map
}

// --- Testability boundary -------------------------------------------------
// The sweep's data access is behind a port so the state machine can be unit
// tested with an in-memory fake (see tests/wms-order-push-sweep-state.test.ts),
// mirroring the repository pattern used by the shopping webhook inbox.

type PushState = 'PENDING_CREATE' | 'PENDING_VERIFY' | 'SYNCED' | 'PENDING_CANCEL' | 'CANCELLED' | 'DEAD_LETTER' | 'HELD' | 'VALIDATION_FAILED' | 'AMBIGUOUS_CREATE'
type LinkWrite = {
  connector?: string
  externalOrderId?: string | null
  externalOrderNumber?: string | null
  state?: PushState
  attempts?: number
  lastError?: string | null
  pushedAt?: Date | null
  lastAttemptAt?: Date | null
  cancelledAt?: Date | null
  courierPending?: boolean
  totalMismatchPence?: number | null
  dispatchFailureCount?: number
  dispatchLastError?: string | null
  dispatchDeadLetteredAt?: Date | null
  dispatchUnresolvedCount?: number
  dispatchUnresolvedError?: string | null
  dispatchUnresolvedAt?: Date | null
  reconcileCheckedAt?: Date | null
}

/**
 * 6oyu.2 (Codex): whenever the link starts pointing at a NEW WMS order (release
 * re-create, create-pass success), the previous order's dispatch dead-letter
 * state must not carry over — a stale dispatchDeadLetteredAt would permanently
 * suppress dispatch polling for the fresh order.
 */
const RESET_DISPATCH_FAILURES = {
  dispatchFailureCount: 0,
  dispatchLastError: null,
  dispatchDeadLetteredAt: null,
  // o3d-bjc.9: and the unresolved-record quarantine, for exactly the same
  // reason — the record that could not be read was the PREVIOUS WMS order's.
  dispatchUnresolvedCount: 0,
  dispatchUnresolvedError: null,
  dispatchUnresolvedAt: null,
  // Same rationale for the reconcile stamp: the recency belonged to the OLD
  // WMS order; the fresh one must rotate to the front of verification.
  reconcileCheckedAt: null,
} satisfies LinkWrite

export type WmsPushCandidate = OrderForPush & { shipFromWarehouseId: string | null; pushAttempts: number }
export type WmsPushUpdateLink = { id: string; externalOrderId: string | null; order: OrderForPush & { shipFromWarehouseId: string | null } }
/**
 * o3d-92fu: a VALIDATION_FAILED link plus the order data the payload is rebuilt from.
 * `lastError` is carried so a re-run that fails for the SAME reason can re-stamp the
 * rotation without re-auditing — the issue asks for the disposition to be recorded once,
 * not once per sweep forever.
 */
export type WmsPushRevalidateLink = {
  id: string
  orderId: string
  lastError: string | null
  attempts: number
  /** o3d-2k5r r2: the columns `wmsOrderMayExist` reads. Carried so the RE-QUEUE decision is made
   *  by the shared rule rather than by trusting the port's where-clause to have filtered. */
  pushedAt: Date | null
  externalOrderId: string | null
  order: OrderForPush & { shipFromWarehouseId: string | null }
}
/**
 * o3d-2k5r r4 — a link PARKED because a create was dispatched for it and its outcome was never
 * recorded. Structurally the revalidation candidate's columns, and for the same reason: the
 * re-queue decision is made from the shared `wmsOrderMayExist` rule rather than by trusting the
 * port's where-clause to have filtered.
 */
export type WmsPushAmbiguousCreateLink = WmsPushRevalidateLink

export type WmsPushLinkRef = { id: string; orderId: string; externalOrderId: string | null }

/**
 * o3d-2k5r r6 — a HELD link, carrying the evidence its release is decided on.
 *
 * A plain {@link WmsPushLinkRef} was not enough and that was the defect: the release pass could
 * see only the ids, so "was this order's warehouse order actually CANCELLED, or did the WMS merely
 * fail to find one?" was a question it had no column to ask. `cancelledAt` is that column — from
 * this revision the hold pass stamps it only on a CONFIRMED remote cancellation — and the order
 * reference is what the fallback presence probe has to be asked about.
 */
export type WmsPushReleasableLink = WmsPushLinkRef & {
  /** Non-null ONLY where `cancelOrder` answered `cancelled: true`. The affirmative evidence. */
  cancelledAt: Date | null
  order: { id: string; orderNumber: string | null; externalOrderNumber: string | null }
}
/**
 * o3d-bjc.8: a PENDING_VERIFY link, carrying OUR identifiers.
 *
 * `orderNumber` and `externalReference` (the sales-order id we send as
 * ExternalOrderReference) come from the local record, never from the create
 * response — an id the WMS handed back for some OTHER order of ours would
 * otherwise verify against itself and the link would go SYNCED pointing at
 * another customer's order.
 */
export type WmsPushVerifyLink = WmsPushLinkRef & {
  orderNumber: string | null
  externalReference: string
  /** Verification attempts already spent — the bound on how long "unknown" may last. */
  verifyAttempts: number
  /** A courier-fallback note held back until the id is proven ours. */
  courierPending: boolean
  shippingService: string | null
}

/**
 * o3d-2k5r r4 — what `claimForCreate` did. A boolean could not express the third answer, and that
 * is precisely why the third answer never happened.
 */
export type WmsCreateClaimOutcome = 'CLAIMED' | 'SKIPPED' | 'PARKED_AMBIGUOUS'

export interface WmsOrderPushPort {
  activeBindings(connector: string): Promise<Array<{ warehouseId: string; externalWarehouseId: string }>>
  /** HELD links whose order is back in a ready+paid state, with the release evidence. */
  releasableHeldOrders(connector: string, limit: number): Promise<WmsPushReleasableLink[]>
  /** Ready+paid orders for bound warehouses with no link or a PENDING_CREATE link. */
  createCandidates(connector: string, boundWarehouseIds: string[], limit: number): Promise<WmsPushCandidate[]>
  /**
   * o3d-5r8 — claim a candidate for the remote create, under the order's row lock.
   *
   * The create pass used to call the WMS with NOTHING in IMS recording that a remote
   * create was in flight: the WmsOrderPushLink was written only AFTER pushOrder returned.
   * A concurrent hard delete (deleteSalesOrder) could therefore remove the order while the
   * create was on the wire, the link write would then fail on the missing order, and the
   * WMS would be left holding an order IMS has no record of.
   *
   * Claiming writes the PENDING_CREATE link BEFORE the remote call, under the same row
   * lock deleteSalesOrder takes — so the deleter either sees the link and refuses, or
   * commits first and this claim finds the order gone and returns false.
   *
   * o3d-2k5r r4 — AND IT NEVER HANDS ON AN EXPIRED CLAIM. `'SKIPPED'` when the order is gone, the
   * link has moved on, or another worker's claim is still live. `'PARKED_AMBIGUOUS'` when the claim
   * has LAPSED: a create request left this system and nothing recorded what became of it, so the
   * link is moved to AMBIGUOUS_CREATE *inside this same transaction* — atomically with the decision
   * that it is stale, under the row lock, so no second worker can reach the same conclusion and
   * push. The caller must not call the WMS for either non-`'CLAIMED'` answer.
   */
  claimForCreate(orderId: string, connector: string, attemptedAt: Date): Promise<WmsCreateClaimOutcome>
  /**
   * o3d-92fu — record a PRE-CALL payload-validation failure, under the order's row lock.
   *
   * Deliberately NOT a plain upsert. The candidate list was read before this, so another worker
   * (or this sweep's own earlier pass) can have claimed the order and pushed it in between. An
   * unconditional write would then stamp VALIDATION_FAILED over a SYNCED link — keeping its
   * externalOrderId while dropping the order out of the update, hold, cancel and dispatch passes,
   * with a live warehouse order behind it. So the write happens under the same lock
   * claimForCreate and deleteSalesOrder take, and applies ONLY while the link is still absent or
   * PENDING_CREATE.
   *
   * o3d-2k5r — and it refuses while a PENDING_CREATE claim's LEASE IS STILL FRESH, because a
   * fresh claim is a worker that is inside pushOrder right now. Only an EXPIRED claim is
   * converted, and converting one marks the disposition AMBIGUOUS (attempts >= AMBIGUOUS_ATTEMPTS):
   * a claim exists only because a remote call was about to be made, and nothing durable records
   * whether it was. Only a disposition this method CREATED — no link existed at all — proves no
   * call was made. See provesNoRemoteWmsCall, which is what the hard-delete guard reads.
   *
   * Returns false when the order no longer exists, the link has moved on, or another worker's
   * claim is still live; the caller then simply skips it, exactly as it does for a refused claim.
   */
  recordValidationFailure(
    orderId: string,
    connector: string,
    error: string,
    attemptedAt: Date,
  ): Promise<boolean>
  /** SYNCED links for ready orders changed since the last push (updatedAt > pushedAt). */
  /**
   * o3d-bjc.8: links whose WMS order was created but never proved ours. They are
   * NOT create candidates (re-pushing would duplicate a real warehouse order)
   * and NOT updatable (we will not amend an order we cannot prove we own) —
   * only the scoped verification is retried.
   */
  verifiableLinks?(connector: string, limit: number): Promise<WmsPushVerifyLink[]>
  updatableLinks(connector: string, limit: number): Promise<WmsPushUpdateLink[]>
  /**
   * o3d-92fu — VALIDATION_FAILED links whose order is STILL create-eligible, so the
   * sweep can re-run the (purely local, zero-API-cost) payload build and put the order
   * back in the create queue once someone fixes the data.
   *
   * Without this the disposition is a one-way door: the order leaves createCandidates —
   * which is the whole point, it is what stops batchSize malformed orders starving every
   * later valid order — and nothing would ever bring it back after the SKU is filled in.
   *
   * Eligibility is deliberately the SAME predicate as createCandidates. An order that is
   * no longer ready+paid must NOT be promoted to PENDING_CREATE: PENDING_CREATE blocks the
   * hard-delete guard and VALIDATION_FAILED (at attempts 0) does not, so promoting a
   * cancelled order would silently re-lock the very door this issue opened.
   *
   * Returns the batch AND the true total, because a bounded sweep that reports only what it
   * processed reads as "covered everything" — the overflow is logged from `total`.
   *
   * Optional so existing test ports keep compiling; when absent, the pass does not run.
   */
  revalidatableLinks?(connector: string, boundWarehouseIds: string[], limit: number): Promise<{ links: WmsPushRevalidateLink[]; total: number }>
  /**
   * o3d-2k5r r4 — AMBIGUOUS_CREATE links whose order is STILL create-eligible.
   *
   * The park has to have a door or it is a grave, and the door is the connector's replay policy:
   * on a WMS whose own create refuses a duplicate, re-dispatching cannot mint a second warehouse
   * order however the race falls, so the link goes back in the create queue and heals itself. On a
   * WMS whose create does not, nothing here re-opens it and the reconciliation is a person's.
   *
   * Eligibility is deliberately the SAME predicate as createCandidates', for the same reason the
   * revalidation pass uses it: promoting an order that is no longer ready+paid would re-queue a
   * cancelled order for fulfilment.
   *
   * Returns the batch AND the true total, because a bounded sweep that reports only what it
   * processed reads as "covered everything".
   *
   * Optional so existing test ports keep compiling; when absent, the pass does not run.
   */
  ambiguousCreateLinks?(connector: string, boundWarehouseIds: string[], limit: number): Promise<{ links: WmsPushAmbiguousCreateLink[]; total: number }>
  /** SYNCED links whose order is ON_HOLD. */
  holdableLinks(connector: string, limit: number): Promise<WmsPushLinkRef[]>
  /** SYNCED links whose order is CANCELLED in IMS. */
  cancellableLinks(connector: string, limit: number): Promise<WmsPushLinkRef[]>
  upsertByOrder(orderId: string, create: LinkWrite & { connector: string }, update: LinkWrite): Promise<void>
  /** o3d-6x66: post-create withdrawal re-check, keyed by ORDER (the link id is
   *  not yet in hand at that point). Optional so existing test ports keep
   *  compiling; when absent, the compensation simply does not run. */
  readWithdrawalState?(orderId: string): Promise<{ withdrawalHoldAt: Date | null; withdrawalApprovedAt: Date | null } | null>
  /** o3d-d82p: the storefront-side withdrawal fence, checked immediately
   *  before the claim. Optional so existing test ports keep compiling; when
   *  absent the fence simply does not apply. */
  verifyWithdrawalFence?(orderId: string): Promise<boolean>
  /** o3d-rbyg: ONE batched storefront read per create batch — the subset of these orders the
   *  storefront currently reports withdrawn, whether or not IMS has ever heard of it. Optional so
   *  existing test ports keep compiling; when absent, no screening happens. */
  screenLiveWithdrawals?(orderIds: string[]): Promise<ReadonlySet<string>>
  /** o3d-rbyg: the LIVE storefront withdrawal verdict for one order. `null` means the storefront
   *  could not be read, which is NOT the same as "not withdrawn". Optional; absent = no live
   *  recheck, and the IMS markers remain the only trigger. */
  readLiveWithdrawal?(orderId: string): Promise<{ withdrawn: boolean; approved: boolean } | null>
  /** o3d-rbyg: does a STANDING withdrawal tombstone exist for this order? The durable half of the
   *  fence — a local read that an outage cannot change the answer of. It says only that a
   *  withdrawal stands, never what to do about it. Optional; absent = the tombstone is not
   *  consulted. */
  readWithdrawalTombstone?(orderId: string): Promise<{ standing: boolean } | null>
  updateLinkByOrder?(orderId: string, data: LinkWrite): Promise<void>
  updateLink(id: string, data: LinkWrite): Promise<void>
  /**
   * o3d-2k5r r2 — apply `data` ONLY while the link is still in `fromState`; false when it has
   * moved on. The convention already exists in order-reconcile-sweep (its per-attempt CAS), and
   * it exists for this reason.
   *
   * `updateLink` is a bare `update({ where: { id } })`: no row lock, no predicate. Every pass in
   * this sweep reads its batch and then writes it back some milliseconds later, and the cron
   * rate-limits sweeps without serialising them — so between the read and the write another
   * worker can have claimed the link, pushed it, and settled it. An unguarded write then stamps
   * a pre-push state over a settled one, and the create pass — whose candidate query selects on
   * state alone — pushes the SAME order a second time. Two warehouse orders, goods shipped
   * twice, which is the exact failure the claim lease exists to prevent.
   *
   * The state predicate is also what makes clearing `lastAttemptAt` here safe: a claim is
   * granted only from PENDING_CREATE, so at the instant a write guarded on any OTHER state
   * applies, no create claim can be live and the column being cleared is a rotation stamp
   * rather than a lease. A claim can only be taken after this write has committed, and it is
   * taken under the order's row lock.
   */
  updateLinkIfState(id: string, fromState: PushState, data: LinkWrite): Promise<boolean>
  /** q66in.4.6: audit-grade timeline row for a connector mutation — must never throw. */
  recordEvent(event: WmsMutationEventInput): Promise<void>
}

/** PII-free projection of a push input for the audit timeline: what IMS asked the WMS to hold. */
function pushIntentSummary(input: WmsOrderPushInput) {
  return {
    orderNumber: input.orderNumber,
    externalWarehouseId: input.externalWarehouseId,
    currency: input.currency,
    courierService: input.courierService,
    totalVat: input.totalVat,
    shippingExVat: input.shippingExVat,
    shippingVat: input.shippingVat,
    discountExVat: input.discountExVat,
    discountVat: input.discountVat,
    lines: input.lines.map((line) => ({ sku: line.sku, quantity: line.quantity, unitPriceExVat: line.unitPriceExVat, unitPriceVat: line.unitPriceVat })),
  }
}

type PushConnector = Pick<
  WmsConnector,
  // o3d-2k5r r3: `probeOrderPresence` is the connector-AUTHORITATIVE absence check the
  // revalidation pass needs before it may re-open a create whose outcome is unknown. Tri-state on
  // purpose: only MISSING means "verifiably no such order", and a merged/ambiguous match must
  // never be reported as MISSING.
  'pushOrder' | 'updateOrder' | 'cancelOrder' | 'addOrderComment' | 'verifyPushedOrder' | 'probeOrderPresence'
>

/**
 * Testable core of the order-push sweep — operates purely on the injected
 * connector + port. The production entry point (runWmsOrderPushSweep) wires the
 * active connector and the Prisma-backed port.
 */
export async function runWmsOrderPushSweepCore(
  connector: PushConnector,
  connectorId: string,
  port: WmsOrderPushPort,
  options?: { batchSize?: number; now?: () => Date },
): Promise<WmsOrderPushSweepResult> {
  const result: WmsOrderPushSweepResult = { created: 0, verified: 0, verifyQuarantined: 0, verifyUnresolved: 0, updated: 0, cancelled: 0, held: 0, released: 0, failed: 0, deadLettered: 0, validationFailed: 0, revalidated: 0, revalidateAmbiguous: 0, createClaimParked: 0, ambiguousCreateRequeued: 0 }
  if (!connector.pushOrder) return { ...result, skipped: 'Active WMS connector has no order-push support' }

  const batchSize = options?.batchSize ?? DEFAULT_BATCH_SIZE
  const now = options?.now ?? (() => new Date())

  // q66in.4.6 audit timeline: one event per remote mutation (attempted or
  // succeeded), best-effort — an audit failure must never fail the sweep.
  const audit = async (event: Omit<WmsMutationEventInput, 'connector' | 'direction' | 'triggeredBy'>) => {
    try {
      await port.recordEvent({ connector: connectorId, direction: 'OUTBOUND', triggeredBy: 'order-push-sweep', ...event })
    } catch (error) {
      console.error('[wms-order-push] failed to record audit event', error)
    }
  }

  // Best-effort warehouse-visible note when IMS can't propagate a hold/cancel
  // because the WMS order is already past NEW. Mirrors the refund-conflict comment
  // (onetwo3d-ims-ql59); never fail the sweep on a comment error.
  const postConflictComment = async (externalOrderId: string, comment: string, orderId?: string) => {
    if (!connector.addOrderComment) return
    try {
      await connector.addOrderComment(externalOrderId, comment)
      await audit({
        action: 'order_comment', outcome: 'SUCCEEDED', entityType: 'SALES_ORDER', entityId: orderId ?? null, externalId: externalOrderId,
        summary: 'Warehouse-visible note posted on WMS order', after: { comment },
      })
    } catch (error) {
      console.error('[wms-order-push] failed to post conflict comment', error)
      await audit({
        action: 'order_comment', outcome: 'FAILED', entityType: 'SALES_ORDER', entityId: orderId ?? null, externalId: externalOrderId,
        summary: 'Failed to post warehouse-visible note on WMS order', after: { comment }, error: scrubWmsError(error, 'WMS comment failed'),
      })
    }
  }

  /**
   * o3d-2k5r r3 — does the WAREHOUSE ITSELF say there is no order under this reference?
   *
   * The only evidence that licenses re-opening a create for a link whose remote outcome is
   * unknown. Deliberately tri-state-derived and fail-closed: `absent` is true ONLY for a
   * connector that answered MISSING, which its own contract defines as "verifiably no trace".
   * FOUND, AMBIGUOUS, a throw, a connector with no probe and an exhausted budget are all the same
   * answer here — NOT PROVED — and differ only in what the operator is told.
   *
   * The reason text is carried on the link's `lastError`, so the sync-exceptions inbox (which
   * lists VALIDATION_FAILED in BLOCKED_WMS_PUSH_STATES) shows why an order is sitting still.
   */
  let presenceProbeBudget = PRESENCE_PROBE_BUDGET
  const probeWarehouseAbsence = async (reference: string): Promise<{ absent: boolean; reason: string }> => {
    if (!connector.probeOrderPresence) {
      return { absent: false, reason: 'the active WMS connector cannot check whether such an order exists, so it cannot be re-queued automatically — check the WMS and resolve it by hand' }
    }
    if (presenceProbeBudget <= 0) {
      return { absent: false, reason: `this sweep's warehouse-presence check budget (${PRESENCE_PROBE_BUDGET}) is spent — it is re-checked on a later sweep` }
    }
    presenceProbeBudget -= 1
    try {
      const presence = await connector.probeOrderPresence(reference)
      if (presence === 'MISSING') return { absent: true, reason: `the WMS confirms it holds no order under reference ${reference}` }
      if (presence === 'FOUND') {
        return { absent: false, reason: `the WMS ALREADY holds an order under reference ${reference} — re-queueing would create a second one. Link it or cancel it in the WMS by hand` }
      }
      return { absent: false, reason: `the WMS returned an ambiguous match for reference ${reference}, so absence is not proved — resolve it in the WMS by hand` }
    } catch (error) {
      return { absent: false, reason: `the WMS presence check failed: ${scrubWmsError(error, 'presence probe failed')}` }
    }
  }

  const bindings = await port.activeBindings(connectorId)
  const externalWarehouseByWarehouse = new Map(bindings.map((b) => [b.warehouseId, b.externalWarehouseId]))

  // --- Release pass: a HELD order back in a ready+paid state re-enters the
  // create queue — BUT ONLY ON EVIDENCE THAT ITS WAREHOUSE ORDER IS GONE. ---
  //
  // o3d-2k5r r6. Clearing `externalOrderId` here IS a create re-open: the create pass selects on
  // state alone, so the next tick pushes the order again. The pass used to do that for every HELD
  // link, on the reasoning that "its WMS order was cancelled when it was held" — which the hold
  // pass does not actually establish. It parks a link HELD both when the WMS CONFIRMS the
  // cancellation and when the WMS merely answers NOT_FOUND, and on ShipHero NOT_FOUND is a lookup
  // result, not a fact about the warehouse. A lookup that missed a live order, followed by a
  // release, followed by a create ShipHero does not refuse, is two warehouse orders and two picks.
  //
  // So the release takes the two keys the rest of this branch takes, from the one rule in
  // create-replay-policy.ts. See {@link decideWmsHeldRelease} for what each key is and why a
  // presence probe is a refusal-only signal here rather than a licence.
  for (const link of await port.releasableHeldOrders(connectorId, batchSize)) {
    const reference = wmsPushOrderReference(link.order)
    // The persisted affirmative evidence: `cancelledAt` is stamped by the hold pass ONLY where
    // cancelOrder answered `cancelled: true`.
    const gate = decideWmsHeldRelease({
      connector: connectorId,
      remoteCancellationConfirmed: link.cancelledAt !== null,
      reference,
    })
    if (!gate.release) {
      // PARKED FOR MANUAL RECONCILIATION, not skipped. A link left HELD with no automatic exit is
      // invisible — HELD is not one of the sync-exception inbox's blocked states — and would be
      // re-examined and re-refused every sweep for ever. DEAD_LETTER is the state this repository
      // already uses for "a person has to look at the warehouse", and the inbox lists it.
      let parked = false
      try {
        parked = await port.updateLinkIfState(link.id, 'HELD', { state: 'DEAD_LETTER', lastError: gate.guidance, lastAttemptAt: now() })
      } catch (error) {
        console.error('[wms-order-push] held-release park failed', link.id, error)
        continue
      }
      if (!parked) {
        console.warn(`[wms-order-push] link ${link.id} left HELD before its park was written — another worker owns it now`)
        continue
      }
      result.deadLettered += 1
      console.warn(`[wms-order-push] link ${link.id} held with no confirmed WMS cancellation — parked for manual reconciliation`)
      await audit({
        action: 'order_release', outcome: 'FAILED', entityType: 'SALES_ORDER', entityId: link.orderId, externalId: link.externalOrderId,
        summary: 'Held order NOT re-queued — no confirmed WMS cancellation and this connector does not refuse a duplicate create',
        before: { state: 'HELD', externalOrderId: link.externalOrderId },
        after: { state: 'DEAD_LETTER', remoteCancellationConfirmed: false, createReplayPolicy: 'client-side-dedupe-only' },
        error: gate.guidance,
      })
      continue
    }
    if (gate.probeRequired) {
      // Refusal-only. `absent` false covers FOUND, AMBIGUOUS, a throw, no probe at all and an
      // exhausted budget — every one of which means "not proved gone", and none of which is a
      // reason to write anything. The link stays HELD and is re-examined next sweep; the reason is
      // recorded so an operator is not looking at a silent stall.
      const absence = await probeWarehouseAbsence(reference)
      if (!absence.absent) {
        console.warn(`[wms-order-push] link ${link.id} not released — ${absence.reason}`)
        await port
          .updateLinkIfState(link.id, 'HELD', { lastError: `Hold not released: ${absence.reason}`, lastAttemptAt: now() })
          .catch((error) => { console.error('[wms-order-push] held-release note failed', link.id, error) })
        continue
      }
    }
    // Only a release that actually PERSISTED counts and is audited (Codex r1:
    // swallowing the write error while recording SUCCEEDED forged the timeline).
    //
    // o3d-2k5r r2: GUARDED ON 'HELD', for the same reason the revalidation promote below is
    // guarded. This write nulls externalOrderId so the order re-creates. Two overlapping sweeps
    // both read the link while it is HELD; A releases it, claims it and pushes it to SYNCED with
    // a fresh WMS id — and B's unguarded release then stamped PENDING_CREATE back over that,
    // DISCARDING the new id, so the next sweep created a second warehouse order and IMS no
    // longer held a reference to the first.
    let released = false
    try {
      // o3d-2k5r r4: `lastAttemptAt: null` is now LOAD-BEARING, not tidiness. A PENDING_CREATE link
      // carrying a dispatch stamp means "a create left and we never learned the outcome", and the
      // claim rule parks such a link instead of claiming it. A release that left the CANCELLED WMS
      // order's old stamp in place would therefore park the very order it just re-opened. The
      // release is entitled to clear it ONLY on the evidence gathered above: a confirmed remote
      // cancellation, or a connector whose create refuses a duplicate plus a warehouse that says it
      // holds no such order. A cleared stamp is this pass's positive statement that both keys
      // turned — `decideCreateClaim` grants a claim on it.
      released = await port.updateLinkIfState(link.id, 'HELD', { state: 'PENDING_CREATE', externalOrderId: null, externalOrderNumber: null, attempts: 0, lastError: null, lastAttemptAt: null, cancelledAt: null, ...RESET_DISPATCH_FAILURES })
    } catch (error) {
      console.error('[wms-order-push] release link update failed', link.id, error)
      continue
    }
    if (!released) {
      console.warn(`[wms-order-push] link ${link.id} left HELD before its release was written — another worker owns it now; not released`)
      continue
    }
    result.released += 1
    await audit({
      action: 'order_release', outcome: 'SUCCEEDED', entityType: 'SALES_ORDER', entityId: link.orderId, externalId: link.externalOrderId,
      summary: 'Held order back in a ready+paid state — re-queued for WMS create',
      before: { state: 'HELD', externalOrderId: link.externalOrderId },
      // The evidence is on the audit row, so "why was this order re-created?" is answerable from
      // the timeline rather than from the code that happened to be deployed that day.
      after: { state: 'PENDING_CREATE', externalOrderId: null, releaseEvidence: gate.evidence, warehouseAbsenceProbed: gate.probeRequired },
    })
  }

  // --- Revalidation pass (o3d-92fu) ---
  //
  // VALIDATION_FAILED is a persisted disposition, not a grave. The whole reason it exists is
  // to take a malformed order OUT of createCandidates so it stops starving the queue — which
  // means something has to put it back once the data is fixed, or the order stays unpushable
  // forever after someone fills in the missing SKU.
  //
  // Rebuilding the payload is PURELY LOCAL: no connector call, no API budget, no claim. So
  // this pass is safe to run every sweep and deliberately runs BEFORE the create pass, so an
  // order fixed since the last sweep is pushed on this tick rather than the next.
  //
  // o3d-2k5r r3: ONE exception, and it is budgeted. A candidate whose remote outcome is ambiguous
  // — a converted create claim — cannot be re-queued without the warehouse's own word that no such
  // order exists, so it costs one presence probe (PRESENCE_PROBE_BUDGET per sweep, spent only on
  // candidates that would otherwise be re-queued this tick). The common case, a disposition that
  // proves no call was ever dispatched, still costs nothing.
  //
  // It rotates least-recently-checked first and reports its own overflow: a bounded sweep
  // that only reports what it processed reads as "covered everything".
  if (externalWarehouseByWarehouse.size > 0 && port.revalidatableLinks) {
    const { links, total } = await port.revalidatableLinks(connectorId, [...externalWarehouseByWarehouse.keys()], batchSize)
    if (total > links.length) {
      console.warn(
        `[wms-order-push] ${total} orders are parked VALIDATION_FAILED and eligible for revalidation; `
        + `this sweep re-checked the ${links.length} least-recently-checked. The remaining ${total - links.length} `
        + 'rotate in on following sweeps — they are NOT dropped.',
      )
    }
    for (const link of links) {
      const externalWarehouseId = link.order.shipFromWarehouseId ? externalWarehouseByWarehouse.get(link.order.shipFromWarehouseId) : undefined
      if (!externalWarehouseId) continue
      // o3d-2k5r r2/r3: THE RE-QUEUE READS THE SHARED RULE, not its own re-derivation of it.
      //
      // This pass's only outcome is "put the order back in createCandidates", and that query
      // selects on state alone — so promoting a link that already carries a WMS id or a push
      // stamp mints a SECOND warehouse order for the same sales order and overwrites the first
      // id. `wmsOrderMayExist` is the same function the hard-delete guard's rule is built from,
      // so the two readers cannot reach opposite conclusions from the same columns.
      //
      // The Prisma port ALSO filters on these columns, spread from the same constant, so
      // against THAT port this branch is unreachable. The two are not redundant: the query
      // filter is what keeps an unpromotable link out of the BOUNDED batch it would otherwise
      // sit at the head of forever, and this check is what makes the DECISION the shared rule's,
      // for any port. So the skipped link is surfaced by the sync-exceptions inbox rather than by
      // the warning below, which only fires for a port that did not filter.
      //
      // This is the FIRST of two gates. It refuses a link that positively records a warehouse
      // order. The second, below the payload rebuild, refuses one whose remote outcome is merely
      // UNKNOWN — see wmsCreateOutcomeIsAmbiguous. Between them the rule is exactly the hard-delete
      // guard's: only a disposition that proves no call was ever dispatched is re-queued on this
      // sweep's own authority.
      if (wmsOrderMayExist(link)) {
        console.warn(
          `[wms-order-push] link ${link.id} is parked VALIDATION_FAILED but carries `
          + `${link.externalOrderId ? `WMS order ${link.externalOrderId}` : 'a recorded push'} — NOT re-queued; `
          + 'a create would duplicate a warehouse order. Resolve it by hand.',
        )
        continue
      }
      const ts = now()
      try {
        buildPushInput(link.order, externalWarehouseId)
      } catch (error) {
        const message = scrubWmsError(error, 'WMS order payload could not be built')
        // Re-stamp so the rotation moves on. Audited only when the REASON changed — a new
        // reason is new information for the operator; the same one repeated every sweep is
        // the noise the persisted disposition exists to remove.
        // Guarded on VALIDATION_FAILED like the promote below: if the link was promoted and
        // claimed by an overlapping sweep between the read and here, this write would move that
        // worker's lease clock and stamp a stale lastError onto a link that has left this pass's
        // jurisdiction. Nothing to re-stamp then, and nothing to audit either.
        const restamped = await port
          .updateLinkIfState(link.id, 'VALIDATION_FAILED', { lastError: message, lastAttemptAt: ts })
          .catch((e) => {
            console.error('[wms-order-push] failed to re-stamp validation disposition', link.id, e)
            return false
          })
        if (restamped && message !== link.lastError) {
          await audit({
            action: 'order_validate', outcome: 'FAILED', entityType: 'SALES_ORDER', entityId: link.orderId, externalId: null,
            summary: `Order ${link.order.orderNumber ?? link.orderId} still cannot be pushed to the WMS, for a new reason: ${message}`,
            before: { state: 'VALIDATION_FAILED', lastError: link.lastError },
            after: { state: 'VALIDATION_FAILED', attempts: link.attempts, remoteCallMade: false },
            error: message,
          })
        }
        continue
      }
      // o3d-2k5r r3 — SECOND GATE: AN AMBIGUOUS CLAIM IS NOT RE-QUEUED ON THIS SWEEP'S WORD.
      //
      // The rule here used to be the opposite, and it was wrong. It held that spent attempts block
      // a hard DELETE but not a re-queue, on the argument that "a re-queue is bounded and
      // reversible where a delete is not". A re-queue is bounded — MAX_ATTEMPTS caps how many
      // times it repeats — but what it risks is not reversible: `attempts >= 1` with no id and no
      // push stamp is exactly what recordValidationFailure mints when it converts an EXPIRED
      // create claim, and a claim exists only because a worker was about to call pushOrder. If
      // that create landed before the worker died, the warehouse is holding an order whose id IMS
      // never learned; the next sweep creates a SECOND one and records only the second id. Goods
      // ship twice, and the unknown first id cannot be cancelled automatically.
      //
      // So the only disposition re-queued automatically is the one that PROVES no call was ever
      // dispatched — attempts 0, minted by recordValidationFailure's create branch from an ABSENT
      // link. For anything else this pass needs the warehouse's own word, and takes nothing else:
      // an operator assertion is not evidence (o3d-anu8), and neither is our own silence.
      //
      // A refusal here is NOT a dead end. The link stays VALIDATION_FAILED with the reason on
      // `lastError` (the sync-exceptions inbox lists it), the rotation stamp moves so it does not
      // sit at the head of the batch, and the next sweep probes again — so an order the WMS
      // genuinely never received re-queues itself as soon as the connector can say so.
      let warehouseAbsenceProved = false
      if (wmsCreateOutcomeIsAmbiguous(link)) {
        // o3d-2k5r r4 — AND A PROBE IS NOT THE WHOLE RULE EITHER.
        //
        // r3 re-queued on `probeOrderPresence === 'MISSING'` alone. MISSING says what the warehouse
        // HOLDS at the instant it is asked; it does not exclude a create that is still on the wire,
        // and on a connector whose own create does not refuse a duplicate the loser of that race is
        // a second warehouse order. So the probe is only asked for at all once the CONNECTOR's
        // create is known to be safe to repeat — see create-replay-policy.ts, which is also what
        // keeps this gate and the ambiguous-create pass answering the same question the same way.
        if (!wmsAmbiguousCreateMayBeReplayed(connectorId)) {
          const message = wmsAmbiguousCreateRefusal(connectorId, wmsPushOrderReference(link.order))
          console.warn(`[wms-order-push] link ${link.id} builds a valid payload again but is NOT re-queued — ${connectorId} cannot repeat a create safely`)
          const restamped = await port
            .updateLinkIfState(link.id, 'VALIDATION_FAILED', { lastError: message, lastAttemptAt: ts })
            .catch((e) => {
              console.error('[wms-order-push] failed to re-stamp an unreplayable revalidation candidate', link.id, e)
              return false
            })
          if (!restamped) continue
          result.revalidateAmbiguous += 1
          if (message !== link.lastError) {
            await audit({
              action: 'order_validate', outcome: 'FAILED', entityType: 'SALES_ORDER', entityId: link.orderId, externalId: null,
              summary: `Order ${link.order.orderNumber ?? link.orderId} can be pushed again, but a previous create may already have reached the WMS and this connector's create cannot be repeated safely — held back for reconciliation`,
              before: { state: 'VALIDATION_FAILED', lastError: link.lastError },
              after: { state: 'VALIDATION_FAILED', attempts: link.attempts, remoteOutcomeAmbiguous: true, createReplayable: false },
              error: message,
            })
          }
          continue
        }
        const absence = await probeWarehouseAbsence(wmsPushOrderReference(link.order))
        if (!absence.absent) {
          const message = 'A WMS create may already have been dispatched for this order and its outcome was never '
            + `recorded, so it will not be re-queued automatically: ${absence.reason}.`
          console.warn(`[wms-order-push] link ${link.id} builds a valid payload again but is NOT re-queued — ${absence.reason}`)
          // Guarded on VALIDATION_FAILED for the same reason every other write in this pass is: an
          // overlapping sweep may have promoted and claimed the link since it was read, and this
          // write moves the rotation stamp, which doubles as that worker's claim lease.
          const restamped = await port
            .updateLinkIfState(link.id, 'VALIDATION_FAILED', { lastError: message, lastAttemptAt: ts })
            .catch((e) => {
              console.error('[wms-order-push] failed to re-stamp an ambiguous revalidation candidate', link.id, e)
              return false
            })
          if (!restamped) continue
          result.revalidateAmbiguous += 1
          // Audited on the same discipline as the build-failure branch: a NEW reason is new
          // information, the same reason every sweep is the noise the persisted disposition exists
          // to remove.
          if (message !== link.lastError) {
            await audit({
              action: 'order_validate', outcome: 'FAILED', entityType: 'SALES_ORDER', entityId: link.orderId, externalId: null,
              summary: `Order ${link.order.orderNumber ?? link.orderId} can be pushed again, but a previous create may already have reached the WMS — held back for reconciliation`,
              before: { state: 'VALIDATION_FAILED', lastError: link.lastError },
              after: { state: 'VALIDATION_FAILED', attempts: link.attempts, remoteOutcomeAmbiguous: true },
              error: message,
            })
          }
          continue
        }
        warehouseAbsenceProved = true
      }

      // Builds again — back into the create queue. attempts is carried over untouched: if the
      // link had already spent remote attempts before it stopped building, those still count
      // against MAX_ATTEMPTS, so a genuinely broken order cannot loop the retry ladder by
      // failing validation in between.
      //
      // o3d-2k5r r2: STATE-GUARDED, and this is the hazard the guard closes.
      //
      // Two overlapping sweeps both read this link while it is VALIDATION_FAILED. A promotes it,
      // claims it under the order row lock and is inside pushOrder. B then reached this write —
      // an unguarded `update({ where: { id } })` that also NULLED lastAttemptAt — and so wiped
      // A's live claim lease. B's own claim check then hit `if (!existing.lastAttemptAt) return
      // true` and pushed the same order again: two warehouse orders, goods shipped twice. If A's
      // push had already landed, the same write reverted a SYNCED/PENDING_VERIFY link to
      // PENDING_CREATE while KEEPING its externalOrderId, which the create pass re-pushes.
      //
      // The predicate is what makes the lease CLEAR safe rather than merely narrower, and the
      // argument is short: the write applies only at an instant when the link is still
      // VALIDATION_FAILED, and shouldGrantCreateClaim grants a claim ONLY from PENDING_CREATE —
      // so at that instant no create claim can be live, whoever wrote the stamp (this pass's
      // rotation re-stamp above, or recordValidationFailure's own, which is equally fresh).
      // The column being cleared is therefore never a live lease. And it must be cleared: a
      // stamp written seconds ago would otherwise make claimForCreate refuse the order it has
      // just re-queued for a full CREATE_CLAIM_LEASE_MS.
      let promoted = false
      try {
        promoted = await port.updateLinkIfState(link.id, 'VALIDATION_FAILED', { state: 'PENDING_CREATE', lastError: null, lastAttemptAt: null })
      } catch (error) {
        console.error('[wms-order-push] failed to re-queue a revalidated order', link.id, error)
        continue
      }
      if (!promoted) {
        console.warn(`[wms-order-push] link ${link.id} left VALIDATION_FAILED before its re-queue was written — another worker owns it now; not re-queued`)
        continue
      }
      result.revalidated += 1
      await audit({
        action: 'order_validate', outcome: 'SUCCEEDED', entityType: 'SALES_ORDER', entityId: link.orderId, externalId: null,
        summary: `Order ${link.order.orderNumber ?? link.orderId} builds a valid WMS payload again — re-queued for create`
          + (warehouseAbsenceProved ? ', after the WMS confirmed it holds no such order' : ''),
        before: { state: 'VALIDATION_FAILED', lastError: link.lastError },
        // `warehouseAbsenceProved` distinguishes the two licences this promote can rest on: a
        // disposition that proved no call was ever dispatched, or a connector-authoritative
        // absence check. An auditor should never have to guess which one was relied on.
        after: { state: 'PENDING_CREATE', attempts: link.attempts, warehouseAbsenceProved },
      })
    }
  }

  // --- Ambiguous-create reconciliation pass (o3d-2k5r r4) ---
  //
  // AMBIGUOUS_CREATE is where a create claim goes when its holder vanished mid-push. The link is
  // not a create candidate any more — that is the whole point, it is what stops the next sweep
  // repeating the create — so something has to be able to let it out again, or the park is a grave
  // and the order can never be fulfilled OR deleted.
  //
  // THE DOOR NEEDS TWO KEYS, because the two risks are different risks.
  //
  //   1. THE ORDER MAY ALREADY BE THERE. Answered by the warehouse itself: probeOrderPresence
  //      === 'MISSING'. Nothing weaker — an operator's assertion is not evidence (o3d-anu8), and
  //      neither is our own silence.
  //   2. A REQUEST MAY STILL BE IN FLIGHT. A probe CANNOT answer this one: MISSING describes what
  //      the warehouse holds at the instant it is asked, and a create on the wire is neither
  //      present nor proof of absence. Elapsed time cannot answer it either — connectorFetch
  //      aborts a LIVE worker's request at its timeout, but the case this exists for is a worker
  //      that is not live, and a stopped process (SIGSTOP, a frozen VM) resumes with no bound at
  //      all. What answers it is the CONNECTOR'S OWN CONTRACT: if the remote refuses a duplicate,
  //      the loser of any race is refused by the party that owns the data, and the connector
  //      reconciles to the order that already exists.
  //
  // So both are required, and a connector that cannot supply the second is never re-dispatched
  // automatically at all — the refusal names what a person can do instead.
  //
  // Runs BEFORE the create pass, like the revalidation pass and for the same reason: a link this
  // sweep re-queues is pushed on this tick rather than the next.
  if (externalWarehouseByWarehouse.size > 0 && port.ambiguousCreateLinks) {
    const { links, total } = await port.ambiguousCreateLinks(connectorId, [...externalWarehouseByWarehouse.keys()], batchSize)
    if (total > links.length) {
      console.warn(
        `[wms-order-push] ${total} orders are parked AMBIGUOUS_CREATE and still create-eligible; `
        + `this sweep re-checked the ${links.length} least-recently-checked. The remaining ${total - links.length} `
        + 'rotate in on following sweeps — they are NOT dropped.',
      )
    }
    const replayable = wmsAmbiguousCreateMayBeReplayed(connectorId)
    for (const link of links) {
      const externalWarehouseId = link.order.shipFromWarehouseId ? externalWarehouseByWarehouse.get(link.order.shipFromWarehouseId) : undefined
      if (!externalWarehouseId) continue
      const ts = now()
      // The same first gate the revalidation pass applies, from the same shared rule: a link that
      // positively records a warehouse order must never be re-opened, whatever the policy says.
      if (wmsOrderMayExist(link)) {
        console.warn(
          `[wms-order-push] link ${link.id} is parked AMBIGUOUS_CREATE but carries `
          + `${link.externalOrderId ? `WMS order ${link.externalOrderId}` : 'a recorded push'} — NOT re-queued; `
          + 'a create would duplicate a warehouse order. Resolve it by hand.',
        )
        continue
      }
      const reference = wmsPushOrderReference(link.order)
      if (!replayable) {
        const message = wmsAmbiguousCreateRefusal(connectorId, reference)
        // Re-stamped so the rotation moves on, and audited only when the REASON changed — the same
        // discipline the revalidation pass uses, for the same reason: a persisted disposition exists
        // to stop the operator being told the same thing every ten minutes.
        const restamped = await port
          .updateLinkIfState(link.id, 'AMBIGUOUS_CREATE', { lastError: message, lastAttemptAt: ts })
          .catch((e) => {
            console.error('[wms-order-push] failed to re-stamp a parked create claim', link.id, e)
            return false
          })
        if (!restamped) continue
        if (message !== link.lastError) {
          await audit({
            action: 'order_create', outcome: 'FAILED', entityType: 'SALES_ORDER', entityId: link.orderId, externalId: null,
            summary: `Order ${link.order.orderNumber ?? link.orderId} has a WMS create whose outcome was never recorded, and `
              + `${connectorId} cannot repeat a create safely — it needs a person to reconcile it in the WMS`,
            before: { state: 'AMBIGUOUS_CREATE', lastError: link.lastError },
            after: { state: 'AMBIGUOUS_CREATE', attempts: link.attempts, remoteOutcomeAmbiguous: true, createReplayable: false },
            error: message,
          })
        }
        continue
      }
      // Replay-safe connector — the SECOND key. The payload still has to BUILD (a re-queue whose
      // payload cannot be built would simply be parked again by the create pass's validation route
      // on the next tick) and the warehouse still has to say it holds no such order.
      try {
        buildPushInput(link.order, externalWarehouseId)
      } catch (error) {
        const message = `${scrubWmsError(error, 'WMS order payload could not be built')} (a previous create for this order was dispatched with no recorded outcome)`
        const restamped = await port
          .updateLinkIfState(link.id, 'AMBIGUOUS_CREATE', { lastError: message, lastAttemptAt: ts })
          .catch((e) => {
            console.error('[wms-order-push] failed to re-stamp a parked create claim', link.id, e)
            return false
          })
        if (restamped && message !== link.lastError) {
          await audit({
            action: 'order_create', outcome: 'FAILED', entityType: 'SALES_ORDER', entityId: link.orderId, externalId: null,
            summary: `Order ${link.order.orderNumber ?? link.orderId} is parked after an unrecorded WMS create and its payload no longer builds: ${message}`,
            before: { state: 'AMBIGUOUS_CREATE', lastError: link.lastError },
            after: { state: 'AMBIGUOUS_CREATE', attempts: link.attempts, remoteOutcomeAmbiguous: true },
            error: message,
          })
        }
        continue
      }
      // THE FIRST KEY. The probe budget is shared with the revalidation pass above and is spent
      // only on links that would otherwise be re-queued on this tick; running out is a DELAY, never
      // a decision — an unprobed link is re-stamped and rotates back in on a later sweep.
      const absence = await probeWarehouseAbsence(reference)
      if (!absence.absent) {
        const message = 'A WMS create was dispatched for this order and its outcome was never recorded, so it will '
          + `not be re-queued automatically: ${absence.reason}.`
        console.warn(`[wms-order-push] link ${link.id} stays parked — ${absence.reason}`)
        const restamped = await port
          .updateLinkIfState(link.id, 'AMBIGUOUS_CREATE', { lastError: message, lastAttemptAt: ts })
          .catch((e) => {
            console.error('[wms-order-push] failed to re-stamp a parked create claim', link.id, e)
            return false
          })
        if (restamped && message !== link.lastError) {
          await audit({
            action: 'order_create', outcome: 'FAILED', entityType: 'SALES_ORDER', entityId: link.orderId, externalId: null,
            summary: `Order ${link.order.orderNumber ?? link.orderId} has a WMS create whose outcome was never recorded and the warehouse cannot confirm the order is absent — held back for reconciliation`,
            before: { state: 'AMBIGUOUS_CREATE', lastError: link.lastError },
            after: { state: 'AMBIGUOUS_CREATE', attempts: link.attempts, remoteOutcomeAmbiguous: true, createReplayable: true },
            error: message,
          })
        }
        continue
      }

      // Both keys turned. Back into the create queue: `lastAttemptAt: null` is the positive
      // statement the claim rule grants on — "nothing is outstanding that this system knows of" —
      // and it takes BOTH the warehouse's own word and the connector's duplicate refusal to be
      // entitled to make it. `attempts` is carried over untouched, so a warehouse that keeps
      // refusing still walks the ladder to DEAD_LETTER rather than looping forever.
      let promoted = false
      try {
        promoted = await port.updateLinkIfState(link.id, 'AMBIGUOUS_CREATE', { state: 'PENDING_CREATE', lastError: null, lastAttemptAt: null })
      } catch (error) {
        console.error('[wms-order-push] failed to re-queue a parked create claim', link.id, error)
        continue
      }
      if (!promoted) {
        console.warn(`[wms-order-push] link ${link.id} left AMBIGUOUS_CREATE before its re-queue was written — another worker owns it now; not re-queued`)
        continue
      }
      result.ambiguousCreateRequeued += 1
      await audit({
        action: 'order_create', outcome: 'SUCCEEDED', entityType: 'SALES_ORDER', entityId: link.orderId, externalId: null,
        summary: `Order ${link.order.orderNumber ?? link.orderId} had a WMS create with no recorded outcome — re-queued `
          + `after the WMS confirmed it holds no such order, and because ${connectorId} refuses a duplicate create `
          + 'and reconciles to the order it already holds',
        before: { state: 'AMBIGUOUS_CREATE', lastError: link.lastError },
        // BOTH licences are named, so an auditor never has to guess what a re-queue rested on.
        after: { state: 'PENDING_CREATE', attempts: link.attempts, warehouseAbsenceProved: true, createReplayPolicy: 'remote-refuses-duplicate' },
      })
    }
  }

  // --- Create pass ---
  if (externalWarehouseByWarehouse.size > 0) {
    const candidates = await port.createCandidates(connectorId, [...externalWarehouseByWarehouse.keys()], batchSize)

    // o3d-rbyg: screen the WHOLE batch against the live storefront before pushing any of it.
    //
    // verifyWithdrawalFence below only asks about orders that already have a withdrawal history —
    // with no suppression row it passes them without reading anything. So an order whose FIRST
    // withdrawal webhook was missed carries no row and no marker, and this sweep would push it.
    // The screen is what asks about those orders, and it is BATCHED — one request for the batch,
    // filtered server-side to the withdrawal statuses — rather than a by-ID read per created
    // order on the hot path.
    //
    // A screening failure leaves the batch with exactly the fence it had before; it must not stop
    // the sweep, or an unreachable storefront would halt warehouse fulfilment shop-wide.
    let liveWithdrawn: ReadonlySet<string> = EMPTY_ORDER_ID_SET
    try {
      liveWithdrawn = (await port.screenLiveWithdrawals?.(candidates.map((candidate) => candidate.id))) ?? EMPTY_ORDER_ID_SET
    } catch (e) {
      console.error(`[wms-order-push] live withdrawal screen failed: ${scrubWmsError(e, 'screen failed')}`)
    }

    for (const order of candidates) {
      // Refused on the storefront's own word. The screen has already written the suppression row,
      // so this order stays fenced from here on without needing another read.
      if (liveWithdrawn.has(order.id)) {
        console.warn(`[wms-order-push] order ${order.orderNumber ?? order.id} is withdrawn on the storefront but IMS had no record of it — not pushed`)
        continue
      }
      const externalWarehouseId = order.shipFromWarehouseId ? externalWarehouseByWarehouse.get(order.shipFromWarehouseId) : undefined
      if (!externalWarehouseId) continue

      const ts = now()

      // o3d-92fu: BUILD THE PAYLOAD BEFORE ANYTHING IS CLAIMED OR PERSISTED.
      //
      // buildPushInput used to run inside the same try as pushOrder, AFTER the claim. A
      // purely LOCAL failure — a line with no SKU — therefore left a PENDING_CREATE claim
      // that aged into DEAD_LETTER, even though pushOrder was never invoked and no remote
      // side effect was possible. The delete guard blocks on EVERY link, so the order became
      // permanently impossible to hard-delete because of a local data error.
      //
      // Persisting NOTHING here was tried and reverted (e5b57e1a): createCandidates selects
      // `no link OR PENDING_CREATE` ordered by updatedAt ASC and takes batchSize, so an order
      // that leaves no trace is re-selected and re-rejected every sweep, and batchSize
      // malformed orders starve every later VALID order out of the warehouse queue. That is
      // worse than the bug. The failure gets a PERSISTED disposition instead: it leaves the
      // candidate set like a dead letter, and — unlike a dead letter — records that no remote
      // call was ever made, which is what lets the delete guard let it go.
      let input: WmsOrderPushInput
      try {
        input = buildPushInput(order, externalWarehouseId)
      } catch (error) {
        const message = scrubWmsError(error, 'WMS order payload could not be built')
        const before = { state: order.pushAttempts > 0 ? 'PENDING_CREATE' : null, attempts: order.pushAttempts }
        // Under the ORDER LOCK, and only while the link is still absent or PENDING_CREATE — the
        // candidate list was read before this, so a concurrent worker may already have pushed the
        // order, and stamping this over a SYNCED link would strand a live warehouse order outside
        // every other pass. It also refuses while a claim's lease is still fresh, and marks the
        // disposition AMBIGUOUS when it converts an expired one — `attempts` is a floor on remote
        // calls that MAY have been dispatched, and only a disposition written with NO pre-existing
        // link proves none was. That distinction is the whole licence the delete guard acts on;
        // the rule lives in provesNoRemoteWmsCall so it is stated once.
        let recorded = false
        try {
          recorded = await port.recordValidationFailure(order.id, connectorId, message, ts)
        } catch (persistError) {
          // The disposition did not stick, so the order is still a candidate and is retried next
          // sweep. Nothing remote happened either way, so this is not a push failure.
          console.error('[wms-order-push] failed to persist validation disposition', order.id, persistError)
          result.failed += 1
          continue
        }
        // The order was deleted, or another worker owns the link now. Either way this pass has
        // nothing to say about it.
        if (!recorded) continue
        result.validationFailed += 1
        // Recorded ONCE, on entry. The old behaviour audited FAILED and incremented `failed`
        // on every single sweep for the same unpushable order; the revalidation pass below
        // re-audits only when the REASON changes or the payload starts building again.
        await audit({
          action: 'order_validate', outcome: 'FAILED', entityType: 'SALES_ORDER', entityId: order.id, externalId: null,
          summary: `Order ${order.orderNumber ?? order.id} cannot be pushed to the WMS: ${message}`,
          before,
          after: { state: 'VALIDATION_FAILED', attempts: order.pushAttempts, remoteCallMade: false },
          error: message,
        })
        continue
      }

      // o3d-5r8: claim before the remote call. A claim failure means the order was
      // deleted or another worker owns it — skip WITHOUT touching the WMS. A claim
      // error is not the order's fault either, so it is logged and retried next sweep
      // rather than counted against the order's push attempts.
      // o3d-d82p: the withdrawal fence, checked immediately before the claim.
      //
      // A by-ID WooCommerce read cannot happen inside the claim transaction —
      // that would hold a row lock across an HTTP call — so it happens here and
      // vouches for the order for a short window that claimForCreate then
      // re-checks under the lock. Fails closed: an unreadable storefront, or a
      // withdrawal it knows about that no webhook delivered, skips the order.
      let fenceOk = true
      try {
        fenceOk = (await port.verifyWithdrawalFence?.(order.id)) ?? true
      } catch (e) {
        console.error(`[wms-order-push] withdrawal fence check failed for ${order.id}: ${scrubWmsError(e, 'fence check failed')}`)
        fenceOk = false
      }
      if (!fenceOk) continue

      let claim: WmsCreateClaimOutcome = 'SKIPPED'
      try {
        claim = await port.claimForCreate(order.id, connectorId, ts)
      } catch (error) {
        console.error('[wms-order-push] create claim failed', order.id, error)
      }
      // o3d-2k5r r4 — THE CRASHED-CREATE PATH, which had no guard at all.
      //
      // A lapsed claim used to be granted straight back to this pass on state and a stale timestamp
      // alone. But the claim is written IMMEDIATELY BEFORE pushOrder, so a link still sitting at
      // PENDING_CREATE with a dispatch stamp means a create request left this system and nobody
      // recorded what became of it — the ordinary shape of a worker killed mid-push, and the one
      // that leaves a live warehouse order IMS has no id for. Pushing again there is a second
      // physical fulfilment that cannot be cancelled automatically.
      //
      // The park is written by claimForCreate ITSELF, inside the transaction that holds the order
      // row lock and decided the claim was stale, so the decision and the write cannot be separated
      // by another worker reaching the same conclusion.
      if (claim === 'PARKED_AMBIGUOUS') {
        result.createClaimParked += 1
        const reference = wmsPushOrderReference(order)
        console.warn(
          `[wms-order-push] order ${order.orderNumber ?? order.id} holds a create claim that expired with no `
          + 'recorded outcome — parked for reconciliation, NOT re-pushed',
        )
        await audit({
          action: 'order_create', outcome: 'FAILED', entityType: 'SALES_ORDER', entityId: order.id, externalId: null,
          summary: `A WMS create was dispatched for order ${order.orderNumber ?? order.id} and its outcome was never `
            + 'recorded — parked rather than re-pushed, so the warehouse is not asked to fulfil it twice',
          before: { state: 'PENDING_CREATE', attempts: order.pushAttempts },
          after: { state: 'AMBIGUOUS_CREATE', attempts: Math.max(order.pushAttempts, AMBIGUOUS_ATTEMPTS), remoteOutcomeAmbiguous: true },
          error: wmsAmbiguousCreateRefusal(connectorId, reference),
        })
        continue
      }
      if (claim !== 'CLAIMED') continue

      const beforeCreate = { state: order.pushAttempts > 0 ? 'PENDING_CREATE' : null, attempts: order.pushAttempts }
      // `push` is hoisted so the catch can tell "remote create failed" from "remote
      // create SUCCEEDED but recording the link failed" (Codex r1) — the audit
      // outcome must mirror the remote mutation, not the local bookkeeping. `input`
      // is no longer hoisted: it is built above, before the claim (o3d-92fu), so by
      // here it always exists and a build failure never reaches this handler.
      let push: Awaited<ReturnType<NonNullable<PushConnector['pushOrder']>>> | null = null
      try {
        push = await connector.pushOrder!(input)
        const courierPending = push.courierFallback ?? false
        // o3d-bjc.8: an id the connector MINTED but has not proved is ours is
        // not SYNCED. It is also emphatically not PENDING_CREATE — the order
        // exists in the warehouse now, and re-pushing would duplicate it — so
        // it gets its own state, and only the scoped verification is retried.
        // A connector that cannot verify (no verifyPushedOrder) keeps the old
        // behaviour rather than parking every order it creates.
        const createdState: PushState =
          push.needsVerification && connector.verifyPushedOrder ? 'PENDING_VERIFY' : 'SYNCED'
        // Penny-precision guard (G6): record (never block) when the order's own totals
        // don't reconcile to the penny, so an operator can investigate a mis-totalled order.
        const driftPence = orderTotalDriftPence(order)
        const totalMismatchPence = driftPence > TOTAL_DRIFT_TOLERANCE_PENCE ? driftPence : null
        if (totalMismatchPence !== null) {
          console.warn(`[wms-order-push] order ${order.orderNumber ?? order.id} total mismatch: ${totalMismatchPence}p drift vs derived total (pushed, flagged for review)`)
        }
        await port.upsertByOrder(
          order.id,
          { connector: connectorId, externalOrderId: push.externalOrderId, externalOrderNumber: push.externalOrderNumber, state: createdState, attempts: 0, pushedAt: ts, lastAttemptAt: ts, courierPending, totalMismatchPence },
          // attempts: 0 on BOTH sides (o3d-bjc.8). claimForCreate has usually
          // created the link already, so the update side is what runs — and the
          // verification budget reads this counter. Left carrying four failed
          // create attempts, a create that finally succeeded would be
          // quarantined on its FIRST transient unknown, putting a live WMS order
          // outside the update, cancel and dispatch passes.
          { connector: connectorId, externalOrderId: push.externalOrderId, externalOrderNumber: push.externalOrderNumber, state: createdState, attempts: 0, lastError: null, pushedAt: ts, lastAttemptAt: ts, cancelledAt: null, courierPending, totalMismatchPence, ...RESET_DISPATCH_FAILURES },
        )
        // o3d-6x66: the claim's withdrawal re-check committed BEFORE this
        // remote push, so a withdrawal landing in between still gets its order
        // created in the warehouse. Usually the hold pass pulls it back, but an
        // ambiguous remote result, a verification delay or a link-persistence
        // failure can leave a live warehouse order outside holdableLinks
        // entirely. Re-read now that we know the external id.
        //
        // Isolated in its own try: this runs AFTER the external id was
        // persisted, and the create path's generic catch rewrites the link to
        // PENDING_CREATE — which for a link that already has an id means the
        // next sweep creates a DUPLICATE warehouse order, or (with a marker
        // set) drops it out of both createCandidates and holdableLinks
        // entirely. A compensation failure must never do that.
        let raced: { withdrawalHoldAt: Date | null; withdrawalApprovedAt: Date | null } | null = null
        try {
          raced = (await port.readWithdrawalState?.(order.id)) ?? null
        } catch (e) {
          console.error(`[wms-order-push] post-create withdrawal re-check failed for ${order.id}: ${scrubWmsError(e, 'read failed')}`)
          raced = { withdrawalHoldAt: new Date(), withdrawalApprovedAt: null } // fail closed
        }

        let racedWithdrawn = Boolean(raced && (raced.withdrawalHoldAt || raced.withdrawalApprovedAt))
        let racedApproved = Boolean(raced?.withdrawalApprovedAt)

        // o3d-rbyg part 2: the IMS markers describe what IMS has been TOLD. A withdrawal filed
        // during the read-to-create window arrives by webhook, and this compensation runs long
        // before that webhook is processed — so the markers can be clean for an order the customer
        // has already withdrawn. Ask the storefront directly, once, now that the order exists in
        // the warehouse and the compensation machinery is right here.
        //
        // NOT fail-closed, and that asymmetry is deliberate: unlike the pre-claim fence, acting on
        // no evidence here means CANCELLING a warehouse order that was just created. An unreadable
        // storefront (null) therefore leaves the markers as the only trigger, exactly as before —
        // the hold pass, the withdrawal sweep and the daily reconcile still cover it.
        if (!racedWithdrawn) {
          let liveWithdrawal: { withdrawn: boolean; approved: boolean } | null = null
          try {
            liveWithdrawal = (await port.readLiveWithdrawal?.(order.id)) ?? null
          } catch (e) {
            console.error(`[wms-order-push] post-create live withdrawal read failed for ${order.id}: ${scrubWmsError(e, 'read failed')}`)
          }
          if (liveWithdrawal?.withdrawn) {
            racedWithdrawn = true
            racedApproved = liveWithdrawal.approved
          }
        }

        if (racedWithdrawn) {
          const approved = racedApproved
          try {
            // NEVER cancel an id we have not proved is ours. PENDING_VERIFY
            // means exactly that, and this file already documents that a wrong
            // id can answer NOT_FOUND while the real warehouse order stays
            // live — so "cancelled" there would be a lie that lets a withdrawn
            // order dispatch. Escalate instead; the verify pass promotes the
            // link and the ordinary hold/cancel pass then acts on it.
            if (createdState === 'PENDING_VERIFY') {
              await port.updateLinkByOrder?.(order.id, {
                lastError: 'Created in the WMS just as a withdrawal request landed, and the id is not yet '
                  + 'proved ours — NOT cancelled. Verify the order in the WMS and cancel it by hand.',
                lastAttemptAt: ts,
              })
              result.failed += 1
              await audit({
                action: approved ? 'order_cancel' : 'order_hold', outcome: 'FAILED',
                entityType: 'SALES_ORDER', entityId: order.id, externalId: push.externalOrderId,
                summary: 'Order was created in the WMS just as a withdrawal request landed, but its id is '
                  + 'unverified so it was NOT cancelled — handle it in the WMS by hand',
                before: beforeCreate,
                after: { state: createdState, externalOrderId: push.externalOrderId },
                error: 'raced withdrawal on an unverified id',
              })
              continue
            }

            const cancel = await connector.cancelOrder?.(push.externalOrderId)
            const pulled = Boolean(cancel && (cancel.cancelled || cancel.status === 'NOT_FOUND'))
            if (pulled) {
              // CANCELLED for an approved withdrawal — there is nothing to
              // release later. HELD only for a submitted one, which an
              // operator may still reject.
              const state: PushState = approved ? 'CANCELLED' : 'HELD'
              await port.updateLinkByOrder?.(order.id, {
                state, cancelledAt: ts, lastError: null, lastAttemptAt: ts, reconcileCheckedAt: null,
              })
              if (approved) result.cancelled += 1
              else result.held += 1
              await audit({
                action: approved ? 'order_cancel' : 'order_hold', outcome: 'SUCCEEDED',
                entityType: 'SALES_ORDER', entityId: order.id, externalId: push.externalOrderId,
                summary: `Order was created in the WMS just as a withdrawal request landed; pulled straight back and parked ${state}`,
                before: beforeCreate,
                after: { state, externalOrderId: push.externalOrderId },
              })
            } else {
              await port.updateLinkByOrder?.(order.id, {
                lastError: 'Created in the WMS just as a withdrawal request landed and could not be pulled '
                  + `back (WMS status ${cancel?.status ?? 'unknown'}) — cancel it in the WMS by hand.`,
                lastAttemptAt: ts,
              })
              result.failed += 1
              await audit({
                action: approved ? 'order_cancel' : 'order_hold', outcome: 'FAILED',
                entityType: 'SALES_ORDER', entityId: order.id, externalId: push.externalOrderId,
                summary: 'Order was created in the WMS just as a withdrawal request landed and could NOT be '
                  + 'pulled back — cancel it in the WMS by hand',
                before: beforeCreate,
                after: { state: createdState, externalOrderId: push.externalOrderId, wmsStatus: cancel?.status },
                error: 'raced withdrawal, remote cancel refused',
              })
            }
          } catch (e) {
            const message = scrubWmsError(e, 'raced-withdrawal compensation failed')
            console.error(`[wms-order-push] ${order.id}: ${message}`)
            result.failed += 1
            await port.updateLinkByOrder?.(order.id, { lastError: message, lastAttemptAt: ts }).catch(() => {})
          }
          // Deliberately NOT counted as `created`: the order existed at the
          // WMS for a moment, but this run's outcome is a hold, a cancel or a
          // failure, and counting both would misreport the sweep.
          continue
        }

        result.created += 1
        await audit({
          action: 'order_create', outcome: 'SUCCEEDED', entityType: 'SALES_ORDER', entityId: order.id, externalId: push.externalOrderId,
          summary: `Order ${order.orderNumber ?? order.id} created in WMS as ${push.externalOrderNumber ?? push.externalOrderId}`
            + (createdState === 'PENDING_VERIFY' ? ' (pending ownership verification)' : ''),
          before: beforeCreate,
          after: { state: createdState, externalOrderId: push.externalOrderId, externalOrderNumber: push.externalOrderNumber, courierPending, totalMismatchPence, intent: pushIntentSummary(input) },
        })
        // Courier-pending (G6c): the shipping service didn't resolve and the WMS used a
        // default courier — flag it on the WMS order so the warehouse verifies before despatch.
        //
        // Not while the id is unproven (o3d-bjc.8): the comment guard proves only
        // that the row is under our tenant, not that it is OUR ORDER, so a
        // same-client wrong-id would receive a misleading IMS note about a
        // shipping method that has nothing to do with it. The verify pass posts
        // it once the link is promoted.
        if (courierPending && createdState === 'SYNCED') {
          await postConflictComment(
            push.externalOrderId,
            `IMS: shipping method '${order.shippingService ?? '—'}' did not map to a WMS courier, so a default courier was used. Please verify the courier before despatch.`,
            order.id,
          )
        }
      } catch (error) {
        const attempts = order.pushAttempts + 1
        const dead = attempts >= MAX_ATTEMPTS
        const message = scrubWmsError(error, 'WMS order push failed')
        if (dead) result.deadLettered += 1
        else result.failed += 1
        const state: PushState = dead ? 'DEAD_LETTER' : 'PENDING_CREATE'
        await port
          .upsertByOrder(order.id, { connector: connectorId, state, attempts, lastError: message, lastAttemptAt: ts }, { state, attempts, lastError: message, lastAttemptAt: ts })
          .catch(() => {})
        await audit({
          action: 'order_create', outcome: push ? 'SUCCEEDED' : 'FAILED', entityType: 'SALES_ORDER', entityId: order.id, externalId: push?.externalOrderId ?? null,
          summary: push
            ? `Order ${order.orderNumber ?? order.id} created in WMS as ${push.externalOrderNumber ?? push.externalOrderId}, but recording the link failed`
            : `WMS create failed for order ${order.orderNumber ?? order.id}${dead ? ' — dead-lettered' : ''}`,
          before: beforeCreate,
          after: push
            ? { state: 'SYNCED', externalOrderId: push.externalOrderId, externalOrderNumber: push.externalOrderNumber, linkPersistFailed: true, intent: pushIntentSummary(input) }
            : { state, attempts },
          error: message,
        })
      }
    }
  }

  // --- Verify pass: prove a created-but-unverified link before anything else ---
  //
  // FIRST, and deliberately: a PENDING_VERIFY link is excluded from the create
  // and update passes, so until it resolves the order is doing nothing. It also
  // must never be re-pushed — the order already exists in the warehouse — so
  // the only thing retried here is a scoped READ.
  if (connector.verifyPushedOrder && port.verifiableLinks) {
    for (const link of await port.verifiableLinks(connectorId, batchSize)) {
      if (!link.externalOrderId) continue
      const verifyTs = now()
      let verdict: 'ours' | 'foreign' | 'unknown' = 'unknown'
      let verifyError: string | null = null
      try {
        verdict = await connector.verifyPushedOrder(link.externalOrderId, {
          orderNumber: link.orderNumber,
          externalReference: link.externalReference,
        })
      } catch (error) {
        // No evidence is not counter-evidence: stay PENDING_VERIFY and retry.
        verifyError = scrubWmsError(error, 'WMS push verification failed')
        console.error('[wms-order-push] verification failed', link.orderId, verifyError)
      }
      // o3d-rbyg round 2: the withdrawal evidence is gathered BEFORE the promotion is decided,
      // because one of these reads can WITHDRAW the verdict rather than merely qualify it (see the
      // tombstone read below). Hoisted so the decision block below can still see what was found.
      let heldNow = false
      let heldApproved = false
      let tombstoned = false
      if (verdict === 'ours') {
        // o3d-6x66: the id is now proved ours — which is precisely the moment a
        // raced-withdrawal create was left waiting for. Do NOT just promote and
        // clear lastError: the hold and cancel passes select by LIFECYCLE
        // status (ON_HOLD / CANCELLED), and the withdrawal markers are
        // committed BEFORE those transitions, so a transition that failed
        // leaves a verified, active WMS order that neither pass picks up —
        // with the explicit warning erased. Re-read the markers first.
        const held = await port.readWithdrawalState?.(link.orderId)
        heldNow = Boolean(held && (held.withdrawalHoldAt || held.withdrawalApprovedAt))
        heldApproved = Boolean(held?.withdrawalApprovedAt)

        // o3d-rbyg: promotion to SYNCED is a fulfilment decision — a SYNCED link is what the
        // dispatch passes act on — and until now it consulted only the IMS markers. An order
        // withdrawn on the storefront while its ownership was being proved carries no marker if
        // its webhook was missed, so it was promoted and shipped. Ask the storefront too.
        //
        // Same asymmetry as the post-create recheck: an unreadable storefront (null) must not
        // cancel a warehouse order we have just proved is ours, so it falls back to the markers.
        if (!heldNow) {
          let liveWithdrawal: { withdrawn: boolean; approved: boolean } | null = null
          try {
            liveWithdrawal = (await port.readLiveWithdrawal?.(link.orderId)) ?? null
          } catch (e) {
            console.error(`[wms-order-push] verify-pass live withdrawal read failed for ${link.orderId}: ${scrubWmsError(e, 'read failed')}`)
          }
          if (liveWithdrawal?.withdrawn) {
            heldNow = true
            heldApproved = liveWithdrawal.approved
          }
        }

        // o3d-rbyg: and the DURABLE half. The live read above is the half that an outage takes
        // away — exactly when a fence is most needed — and the tombstone is what the screen and the
        // live read WRITE so the order stays fenced without it. Consulting only the two readable
        // signals meant an order with a standing tombstone was promoted to SYNCED the moment
        // WooCommerce was unreachable, and SYNCED is what the dispatch passes act on.
        //
        // It is checked even when the live read came back CLEAN, for the same reason
        // verifyWithdrawalFenceForPush refuses a standing row without asking anyone: a tombstone is
        // retired only after the storefront has reported the request rejected across a whole
        // quiescence window, re-verified by the by-ID sweep. One ad-hoc read is not that evidence.
        //
        // HOLD, never cancel. A tombstone says "this order needs checking", never WHAT to do — the
        // rule the withdrawal module states in as many words — so the reversible action is the only
        // one it can authorise. If the customer's request was in fact approved, the markers, the
        // live read or the ordinary cancel pass supply that verdict and the cancel follows.
        if (!heldNow) {
          try {
            tombstoned = Boolean((await port.readWithdrawalTombstone?.(link.orderId))?.standing)
          } catch (e) {
            // o3d-rbyg round 2, Codex finding 4: an UNREAD tombstone is not an absent one, and the
            // decision it feeds is a promotion to SYNCED — which is precisely the state the dispatch
            // sweep fulfils from. Swallowing the failure and promoting anyway meant one bad local
            // read moved the link into the dispatch set with its durable fence never consulted.
            //
            // So the VERDICT is withdrawn, not the fence: the link stays PENDING_VERIFY and is
            // retried on the next sweep by the ordinary unresolved ladder below — attempts stamped
            // so it rotates, and escalated to the exception inbox at the bound rather than retrying
            // in silence for ever. Nothing is cancelled and nothing is re-pushed, so holding here
            // costs a sweep interval and risks nothing; promoting costs a customer's withdrawn
            // order being shipped.
            //
            // Deliberately NOT the same trade as the live storefront read above. That one falls back
            // to the markers because it is a REMOTE dependency whose outage says nothing about this
            // order and would otherwise strand every verified link shop-wide. This is a local read
            // of our own database, its failure is ours, and the safe side of it is standing still.
            const message = scrubWmsError(e, 'read failed')
            console.error(`[wms-order-push] verify-pass withdrawal tombstone read failed for ${link.orderId}: ${message}`)
            verdict = 'unknown'
            verifyError = `WMS order ${link.externalOrderId} is ours, but the durable withdrawal tombstone could not be read (${message})`
              + ' — the link was NOT promoted to SYNCED, because a SYNCED link is what the dispatch sweep fulfils'
          }
          if (tombstoned) {
            heldNow = true
            heldApproved = false
          }
        }
      }

      if (verdict === 'ours') {
        if (heldNow) {
          const approved = heldApproved
          let pulled = false
          // o3d-2k5r r6: hoisted out of the try because the DISPOSITION below turns on which of
          // the two answers `pulled` was made of — a confirmed cancellation, or a bare NOT_FOUND.
          let cancelConfirmed = false
          try {
            const cancel = await connector.cancelOrder?.(link.externalOrderId)
            pulled = Boolean(cancel && (cancel.cancelled || cancel.status === 'NOT_FOUND'))
            cancelConfirmed = cancel?.cancelled === true
          } catch (e) {
            console.error(`[wms-order-push] verified-then-withdrawn cancel failed for ${link.orderId}: ${scrubWmsError(e, 'cancel failed')}`)
          }
          // Which evidence fenced it, so the timeline shows whether a human still has to establish
          // what the customer actually asked for.
          const evidence = tombstoned
            ? ' (on a standing withdrawal tombstone — held, not cancelled, until the request itself is established)'
            : ''
          // o3d-2k5r r6: the same distinction the hold pass now draws. `pulled` spans a CONFIRMED
          // cancellation and a bare NOT_FOUND, and only the first is evidence. A HELD link's
          // `cancelledAt` is what the release pass reads before it re-opens a create, so stamping
          // it for a lookup miss would hand the release the very evidence it must not have. The
          // CANCELLED branch is terminal — nothing re-creates from it — so it keeps its stamp.
          await port.updateLink(link.id, pulled
            ? (approved
              ? { state: 'CANCELLED', cancelledAt: new Date(), lastError: null, reconcileCheckedAt: null }
              : { state: 'HELD', cancelledAt: cancelConfirmed ? new Date() : null, lastError: null, reconcileCheckedAt: null })
            : { state: 'SYNCED', lastError: 'Verified ours, but the customer has withdrawn this order and it could not be cancelled — cancel it in the WMS by hand' })
          if (pulled) { if (approved) result.cancelled += 1; else result.held += 1 } else result.failed += 1
          await audit({
            action: approved ? 'order_cancel' : 'order_hold', outcome: pulled ? 'SUCCEEDED' : 'FAILED',
            entityType: 'SALES_ORDER', entityId: link.orderId, externalId: link.externalOrderId,
            summary: pulled
              ? `Ownership verified for an order the customer had withdrawn in the meantime; ${approved ? 'cancelled' : 'held'} at the WMS${evidence}`
              : `Ownership verified for an order the customer had withdrawn, but it could NOT be pulled back — handle it in the WMS by hand${evidence}`,
            error: pulled ? undefined : 'verified-then-withdrawn, remote cancel failed',
          })
          continue
        }
        await port.updateLink(link.id, { state: 'SYNCED', lastError: null })
        result.verified += 1
        // The courier-pending note was held back until the id was proven.
        if (link.courierPending) {
          await postConflictComment(
            link.externalOrderId,
            `IMS: shipping method '${link.shippingService ?? '—'}' did not map to a WMS courier, so a default courier was used. Please verify the courier before despatch.`,
            link.orderId,
          )
        }
        await audit({
          action: 'order_create', outcome: 'SUCCEEDED', entityType: 'SALES_ORDER', entityId: link.orderId,
          externalId: link.externalOrderId,
          summary: `WMS order ${link.externalOrderId} verified as ours (${link.orderNumber ?? link.orderId}) — link promoted to SYNCED`,
          before: { state: 'PENDING_VERIFY', externalOrderId: link.externalOrderId },
          after: { state: 'SYNCED', externalOrderId: link.externalOrderId },
        })
      } else if (verdict === 'foreign') {
        // Quarantine, and do NOT re-push. Two facts are both true: this id is
        // not ours, and our create DID happen — so somewhere there is a real
        // order we can no longer address. Creating a second one would ship the
        // customer two parcels; that call belongs to an operator.
        const message = `WMS order ${link.externalOrderId} belongs to another tenant — link quarantined, NOT re-pushed`
        await port.updateLink(link.id, { state: 'DEAD_LETTER', lastError: message })
        result.verifyQuarantined += 1
        result.deadLettered += 1
        await audit({
          action: 'order_create', outcome: 'FAILED', entityType: 'SALES_ORDER', entityId: link.orderId,
          externalId: link.externalOrderId,
          summary: message,
          before: { state: 'PENDING_VERIFY', externalOrderId: link.externalOrderId },
          after: { state: 'DEAD_LETTER' },
          error: message,
        })
      } else {
        // 'unknown' → still PENDING_VERIFY on purpose: guessing either way
        // duplicates a real order or orphans one. But it is COUNTED, and the
        // attempt is stamped — otherwise the batch is re-selected from the same
        // permanently-unknown head every sweep and newer links never get a turn.
        const attempts = link.verifyAttempts + 1
        const exhausted = attempts >= MAX_ATTEMPTS
        if (exhausted) {
          // Still no answer after the bound. An order nobody can resolve is an
          // operator's decision, not a reason to keep quietly retrying while its
          // WMS order sits outside every other pass. Escalated, never re-pushed.
          const message = `WMS order ${link.externalOrderId} could not be verified after ${attempts} attempts`
            + `${verifyError ? ` (${verifyError})` : ''} — quarantined for manual check, NOT re-pushed`
          await port.updateLink(link.id, {
            state: 'DEAD_LETTER', attempts, lastError: message, lastAttemptAt: verifyTs,
          })
          result.verifyQuarantined += 1
          result.deadLettered += 1
          await audit({
            action: 'order_create', outcome: 'FAILED', entityType: 'SALES_ORDER', entityId: link.orderId,
            externalId: link.externalOrderId,
            summary: message,
            before: { state: 'PENDING_VERIFY', externalOrderId: link.externalOrderId, attempts: link.verifyAttempts },
            after: { state: 'DEAD_LETTER', attempts },
            error: message,
          })
        } else {
          await port.updateLink(link.id, {
            attempts,
            lastAttemptAt: verifyTs,
            lastError: verifyError ?? `WMS order ${link.externalOrderId} not yet verified as ours`,
          })
          result.verifyUnresolved += 1
        }
      }
    }
  }

  // --- Update pass: amend already-pushed orders changed since the last push ---
  if (connector.updateOrder && externalWarehouseByWarehouse.size > 0) {
    for (const link of await port.updatableLinks(connectorId, batchSize)) {
      const externalWarehouseId = link.order.shipFromWarehouseId ? externalWarehouseByWarehouse.get(link.order.shipFromWarehouseId) : undefined
      if (!externalWarehouseId || !link.externalOrderId) continue

      const ts = now()
      let update: Awaited<ReturnType<NonNullable<PushConnector['updateOrder']>>> | null = null
      try {
        const input = buildPushInput(link.order, externalWarehouseId)
        update = await connector.updateOrder(link.externalOrderId, input)
        // Bump pushedAt either way so we don't re-attempt until the next change;
        // a non-NEW WMS order can no longer be amended (inbound webhooks aside).
        await port.updateLink(link.id, { pushedAt: ts, lastAttemptAt: ts, lastError: update.updated ? null : `Amendment not propagated (WMS status ${update.status})` })
        if (update.updated) result.updated += 1
        await audit({
          action: 'order_update', outcome: update.updated ? 'SUCCEEDED' : 'FAILED', entityType: 'SALES_ORDER', entityId: link.order.id, externalId: link.externalOrderId,
          summary: update.updated
            ? `Order ${link.order.orderNumber ?? link.order.id} amendment propagated to WMS`
            : `Order ${link.order.orderNumber ?? link.order.id} amendment NOT propagated — WMS order past NEW (status ${update.status})`,
          before: { state: 'SYNCED', externalOrderId: link.externalOrderId },
          after: { propagated: update.updated, wmsStatus: update.status, intent: pushIntentSummary(input) },
          error: update.updated ? null : `Amendment not propagated (WMS status ${update.status})`,
        })
      } catch (error) {
        const message = scrubWmsError(error, 'WMS order update failed')
        result.failed += 1
        await port.updateLink(link.id, { lastError: message, lastAttemptAt: ts }).catch(() => {})
        await audit({
          action: 'order_update', outcome: update?.updated ? 'SUCCEEDED' : 'FAILED', entityType: 'SALES_ORDER', entityId: link.order.id, externalId: link.externalOrderId,
          summary: update
            ? `Order ${link.order.orderNumber ?? link.order.id} amendment ${update.updated ? 'propagated to WMS' : `not propagated (WMS status ${update.status})`}, but recording the link failed`
            : `WMS update failed for order ${link.order.orderNumber ?? link.order.id}`,
          before: { state: 'SYNCED', externalOrderId: link.externalOrderId },
          after: update ? { propagated: update.updated, wmsStatus: update.status, linkPersistFailed: true } : undefined,
          error: message,
        })
      }
    }
  }

  // --- Hold pass: an IMS-held order that was pushed is pulled back from the WMS
  // (cancelled) and parked as HELD so a later release re-pushes it. ---
  if (connector.cancelOrder) {
    for (const link of await port.holdableLinks(connectorId, batchSize)) {
      if (!link.externalOrderId) continue
      const ts = now()
      let cancel: Awaited<ReturnType<NonNullable<PushConnector['cancelOrder']>>> | null = null
      try {
        cancel = await connector.cancelOrder(link.externalOrderId)
        if (cancel.cancelled || cancel.status === 'NOT_FOUND') {
          // o3d-2k5r r6 — WHAT THIS WRITE RECORDS IS NOW THE DIFFERENCE BETWEEN THE TWO.
          //
          // `cancelled: true` is the warehouse saying it cancelled the order. `NOT_FOUND` is the
          // warehouse failing to return one, which on ShipHero is a lookup result and nothing more.
          // Both used to be stamped `cancelledAt: ts` — writing "cancelled at 09:04" for an order
          // nobody confirmed was cancelled — and the release pass then read that stamp (or rather,
          // read nothing at all) and re-created the order. The stamp is the persisted affirmative
          // evidence, so it is written ONLY for the confirmed case.
          //
          // And where the unconfirmed case can never be released safely, it is parked HERE rather
          // than left HELD to be refused by every future sweep: the same rule, asked at the moment
          // the ambiguity is created. See decideWmsHeldRelease.
          const confirmed = cancel.cancelled === true
          const gate = decideWmsHeldRelease({
            connector: connectorId,
            remoteCancellationConfirmed: confirmed,
            reference: link.externalOrderId,
          })
          // reconcileCheckedAt reset (q66in.4.4): a freshly held/cancelled link
          // must rotate to the FRONT of the reconcile's safety check, not
          // inherit its pre-transition verification recency.
          await port.updateLink(link.id, gate.release
            ? { state: 'HELD', cancelledAt: confirmed ? ts : null, lastError: null, lastAttemptAt: ts, reconcileCheckedAt: null }
            : { state: 'DEAD_LETTER', cancelledAt: null, lastError: gate.guidance, lastAttemptAt: ts, reconcileCheckedAt: null })
          if (gate.release) result.held += 1
          else result.deadLettered += 1
          await audit({
            action: 'order_hold', outcome: gate.release ? 'SUCCEEDED' : 'FAILED', entityType: 'SALES_ORDER', entityId: link.orderId, externalId: link.externalOrderId,
            summary: gate.release
              ? (confirmed
                ? 'IMS-held order pulled back from the WMS (cancellation confirmed, parked HELD)'
                : 'IMS-held order not found in the WMS (cancellation UNCONFIRMED, parked HELD — this connector refuses a duplicate create)')
              : 'IMS-held order not found in the WMS and the cancellation was never confirmed — parked for manual reconciliation',
            before: { state: 'SYNCED', externalOrderId: link.externalOrderId },
            after: { state: gate.release ? 'HELD' : 'DEAD_LETTER', wmsCancelStatus: cancel.status, remoteCancellationConfirmed: confirmed },
            error: gate.release ? null : gate.guidance,
          })
        } else {
          result.deadLettered += 1
          await port.updateLink(link.id, { state: 'DEAD_LETTER', lastError: `Held in IMS but WMS order past NEW (status ${cancel.status}) — raise a cancellation query in the WMS`, lastAttemptAt: ts })
          await audit({
            action: 'order_hold', outcome: 'FAILED', entityType: 'SALES_ORDER', entityId: link.orderId, externalId: link.externalOrderId,
            summary: 'IMS hold could not cancel the WMS order (past NEW) — dead-lettered for operator action',
            before: { state: 'SYNCED', externalOrderId: link.externalOrderId },
            after: { state: 'DEAD_LETTER', wmsStatus: cancel.status },
            error: `WMS order past NEW (status ${cancel.status})`,
          })
          await postConflictComment(link.externalOrderId, `IMS: This order has been placed ON HOLD in IMS but is already being fulfilled here (status ${cancel.status}) and could not be auto-cancelled. Please pause it if possible, or raise a cancellation query.`, link.orderId)
        }
      } catch (error) {
        const message = scrubWmsError(error, 'WMS hold/cancel failed')
        result.failed += 1
        await port.updateLink(link.id, { lastError: message, lastAttemptAt: ts }).catch(() => {})
        const remoteCancelled = cancel ? cancel.cancelled || cancel.status === 'NOT_FOUND' : false
        await audit({
          action: 'order_hold', outcome: remoteCancelled ? 'SUCCEEDED' : 'FAILED', entityType: 'SALES_ORDER', entityId: link.orderId, externalId: link.externalOrderId,
          summary: remoteCancelled ? 'WMS order cancelled for hold, but recording the link failed' : 'WMS hold/cancel call failed',
          before: { state: 'SYNCED', externalOrderId: link.externalOrderId },
          after: cancel ? { wmsCancelStatus: cancel.status, linkPersistFailed: true } : undefined,
          error: message,
        })
      }
    }
  }

  // --- Cancel pass: IMS-cancelled and fully-refunded orders that were pushed (SYNCED) ---
  if (connector.cancelOrder) {
    for (const link of await port.cancellableLinks(connectorId, batchSize)) {
      if (!link.externalOrderId) continue
      const ts = now()
      let cancel: Awaited<ReturnType<NonNullable<PushConnector['cancelOrder']>>> | null = null
      try {
        cancel = await connector.cancelOrder(link.externalOrderId)
        if (cancel.cancelled || cancel.status === 'NOT_FOUND') {
          await port.updateLink(link.id, { state: 'CANCELLED', cancelledAt: ts, lastError: null, lastAttemptAt: ts , reconcileCheckedAt: null })
          result.cancelled += 1
          await audit({
            action: 'order_cancel', outcome: 'SUCCEEDED', entityType: 'SALES_ORDER', entityId: link.orderId, externalId: link.externalOrderId,
            summary: 'IMS-cancelled/fully-refunded order cancelled in the WMS',
            before: { state: 'SYNCED', externalOrderId: link.externalOrderId },
            after: { state: 'CANCELLED', wmsCancelStatus: cancel.status },
          })
        } else {
          // Past NEW in the WMS — already being fulfilled despite the IMS cancel/full
          // refund. Only NEW orders auto-cancel; surface a dead-letter conflict so an
          // operator raises a cancellation query in the WMS rather than retrying forever.
          result.deadLettered += 1
          await port.updateLink(link.id, { state: 'DEAD_LETTER', lastError: `WMS order past NEW (status ${cancel.status}) — raise a cancellation query in the WMS`, lastAttemptAt: ts })
          await audit({
            action: 'order_cancel', outcome: 'FAILED', entityType: 'SALES_ORDER', entityId: link.orderId, externalId: link.externalOrderId,
            summary: 'IMS cancel could not cancel the WMS order (past NEW) — dead-lettered for operator action',
            before: { state: 'SYNCED', externalOrderId: link.externalOrderId },
            after: { state: 'DEAD_LETTER', wmsStatus: cancel.status },
            error: `WMS order past NEW (status ${cancel.status})`,
          })
          await postConflictComment(link.externalOrderId, `IMS: This order has been cancelled / fully refunded in IMS but is already being fulfilled here (status ${cancel.status}) and could not be auto-cancelled. Please raise a cancellation query.`, link.orderId)
        }
      } catch (error) {
        const message = scrubWmsError(error, 'WMS cancel failed')
        result.failed += 1
        await port.updateLink(link.id, { lastError: message, lastAttemptAt: ts }).catch(() => {})
        const remoteCancelled = cancel ? cancel.cancelled || cancel.status === 'NOT_FOUND' : false
        await audit({
          action: 'order_cancel', outcome: remoteCancelled ? 'SUCCEEDED' : 'FAILED', entityType: 'SALES_ORDER', entityId: link.orderId, externalId: link.externalOrderId,
          summary: remoteCancelled ? 'WMS order cancelled, but recording the link failed' : 'WMS cancel call failed',
          before: { state: 'SYNCED', externalOrderId: link.externalOrderId },
          after: cancel ? { wmsCancelStatus: cancel.status, linkPersistFailed: true } : undefined,
          error: message,
        })
      }
    }
  }

  return result
}

/**
 * The database's OWN vocabulary for the push-state enum — read from `pg_enum`, not from the
 * generated client, because it is precisely the disagreement between the two that this answers.
 *
 * A type that does not exist yields no rows, which the gate treats as "every required value is
 * missing" — the same refusal, which is right: a database with no `WmsOrderPushState` at all is
 * further behind, not closer.
 */
async function readWmsPushStateEnumValues(): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ enumlabel: string }>>`
    SELECT e.enumlabel AS "enumlabel"
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = ${WMS_PUSH_STATE_ENUM}
  `
  return rows.map((row) => row.enumlabel)
}

/**
 * o3d-1izw — the fail-closed gate, shared by the sweep's preflight and the write site that mints
 * AMBIGUOUS_CREATE. One instance per process, so the success is cached once and the refusal is
 * announced once. See lib/domain/wms/push-state-schema-gate.ts.
 */
export const assertWmsPushStateSchemaReady = createWmsPushStateSchemaGate(readWmsPushStateEnumValues)

/** The warehouses this connector currently has an ACTIVE binding for, on an ACTIVE connection. */
function activeBoundWarehouseIds(client: Prisma.TransactionClient, connectorId: string): Promise<Array<{ warehouseId: string }>> {
  return client.externalWmsBinding.findMany({
    where: { connector: connectorId, active: true, connection: { active: true } },
    select: { warehouseId: true },
  })
}

/**
 * WOULD THE CREATE PASS SELECT THESE ORDERS? — the shared predicate, evaluated by the database,
 * for readers outside this sweep (o3d-2k5r r6).
 *
 * Exported so the sync-exceptions inbox can decide whether to render a Re-push control from the
 * SAME query the sweep selects candidates with. A hand-written copy of three of its six fences is
 * what let the inbox offer a control for an order the sweep would never pick up, and report success
 * when it was pressed.
 */
export async function wmsCreateEligibleOrderIds(connectorId: string, orderIds: readonly string[]): Promise<Set<string>> {
  if (orderIds.length === 0) return new Set()
  const bindings = await activeBoundWarehouseIds(db, connectorId)
  // No active binding at all: nothing is create-eligible. Returning "all of them" on an empty
  // binding list would be the same absence-as-an-answer mistake in miniature.
  if (bindings.length === 0) return new Set()
  const rows = await db.salesOrder.findMany({
    where: { id: { in: [...orderIds] }, ...wmsCreateEligibleOrderWhere(bindings.map((b) => b.warehouseId)) },
    select: { id: true },
  })
  return new Set(rows.map((row) => row.id))
}

/**
 * The same question, asked INSIDE a write transaction, under the sales order's row lock.
 *
 * A render-time answer is a statement about the past: a binding can be disabled, or the order moved
 * to an unbound warehouse, between the page the operator is looking at and the button they press.
 * So the writer re-proves it here, holding the same `FOR UPDATE` lock `claimForCreate` and
 * `deleteSalesOrder` take — which is what makes "eligible" true at the instant the link is reset
 * rather than true when the page rendered.
 */
export async function isWmsCreateEligibleForUpdate(
  tx: Prisma.TransactionClient,
  connectorId: string,
  orderId: string,
): Promise<boolean> {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM sales_orders WHERE id = ${orderId} FOR UPDATE`
  if (locked.length === 0) return false
  const bindings = await activeBoundWarehouseIds(tx, connectorId)
  if (bindings.length === 0) return false
  const row = await tx.salesOrder.findFirst({
    where: { id: orderId, ...wmsCreateEligibleOrderWhere(bindings.map((b) => b.warehouseId)) },
    select: { id: true },
  })
  return row !== null
}

/** Prisma-backed port — the exact queries the sweep used before the extraction. */
export function createPrismaWmsOrderPushPort(): WmsOrderPushPort {
  return {
    activeBindings: (connector) =>
      db.externalWmsBinding.findMany({
        where: { connector, active: true, connection: { active: true } },
        select: { warehouseId: true, externalWarehouseId: true },
      }),
    releasableHeldOrders: (connector, limit) =>
      db.wmsOrderPushLink.findMany({
        where: {
          connector,
          state: 'HELD',
          // o3d-2k5r r6: the SHARED create fences, spread rather than restated. A release puts the
          // order straight into the create queue, so anything createCandidates would refuse must
          // not be released — including the withdrawal fences (o3d-e1yb), which are the reason a
          // rejected withdrawal returning the storefront order to a ready status must not put the
          // goods back on the pick line. The bound-warehouse half is deliberately absent: the
          // create pass re-checks it, and an unbound warehouse is a reason not to CREATE, not a
          // reason to keep a cancelled warehouse order's id on the link.
          order: WMS_CREATE_ELIGIBLE_ORDER_FENCES,
        },
        // cancelledAt is the affirmative remote-cancellation evidence and the order reference is
        // what the fallback probe is asked about — see WmsPushReleasableLink.
        select: {
          id: true, orderId: true, externalOrderId: true, cancelledAt: true,
          order: { select: { id: true, orderNumber: true, externalOrderNumber: true } },
        },
        take: limit,
      }),
    async createCandidates(connector, boundWarehouseIds, limit) {
      const rows = await db.salesOrder.findMany({
        where: {
          // o3d-2k5r r6: THE predicate, from lib/domain/wms/create-eligibility.ts. This query is
          // the definition of "the sweep will create a warehouse order for this", and four other
          // readers have to agree with it; the last one written by hand agreed with half of it.
          ...wmsCreateEligibleOrderWhere(boundWarehouseIds),
          OR: [{ wmsOrderPush: { is: null } }, { wmsOrderPush: { state: 'PENDING_CREATE' } }],
        },
        select: { ...ORDER_PUSH_SELECT, shipFromWarehouseId: true, wmsOrderPush: { select: { attempts: true } } },
        take: limit,
        orderBy: { updatedAt: 'asc' },
      })
      return rows.map(({ wmsOrderPush, ...order }) => ({ ...order, pushAttempts: wmsOrderPush?.attempts ?? 0 }))
    },
    async claimForCreate(orderId, connector, attemptedAt) {
      // o3d-1izw — THE WRITE-SITE GUARD. This transaction is the one that mints AMBIGUOUS_CREATE,
      // and on a database without that enum value Postgres rejects it, rolls the transaction back
      // and leaves the order neither claimed nor parked — so the next sweep reaches the same link
      // and repeats the same unattributable driver error, for ever. Asked here (and not only in
      // the sweep's preflight) because this port is reachable from any composition, and a raw
      // `invalid input value for enum` is not a diagnosis.
      await assertWmsPushStateSchemaReady()
      return db.$transaction(async (tx) => {
        // Same row lock deleteSalesOrder takes — this is what makes the claim and the
        // delete mutually exclusive rather than merely racing.
        const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM sales_orders WHERE id = ${orderId} FOR UPDATE`
        if (locked.length === 0) return 'SKIPPED'
        // o3d-e1yb [wdraw]: re-check UNDER THE LOCK. The candidate query ran
        // earlier, and a withdrawal request can land between the two — the
        // marker is written under this same lock, so checking it here is what
        // makes the two mutually exclusive rather than merely racing.
        const fresh = await tx.salesOrder.findUnique({
          where: { id: orderId },
          // orderNumber/externalOrderNumber are read for the PARK's operator-facing refusal: it
          // names the reference a person will search the WMS for, and the sales order id is not it.
          select: { withdrawalHoldAt: true, withdrawalApprovedAt: true, orderNumber: true, externalOrderNumber: true },
        })
        if (fresh?.withdrawalHoldAt || fresh?.withdrawalApprovedAt) return 'SKIPPED'

        // o3d-d82p: a live WooCommerce withdrawal SUPPRESSION is a fulfilment
        // fence in its own right, not just an ingestion guard.
        //
        // The IMS markers are written by the withdrawal handler, so an order
        // whose withdrawal is known to the storefront but has not yet been
        // applied here — a missed or delayed webhook, an import that raced a
        // resubmission — carries neither marker. This sweep runs every 10
        // minutes and the withdrawal sweep every 15, so checking only the
        // markers leaves a window in which a withdrawn order is pushed to the
        // warehouse. The tombstone is the durable record that the storefront
        // knows something we may not, so refuse the claim while it exists.
        //
        // Deliberately includes a RETIRED (soft-deleted) row inside its fence
        // grace. Retirement and the end of the fence must not be the same
        // instant, or a resubmission landing between the final live read and
        // the retirement — with its webhook missed — leaves the order
        // immediately pushable. The cost is that a legitimately rejected
        // withdrawal delays the WMS push by up to the grace window; that is
        // the intended trade.
        const link = await tx.shoppingOrderLink.findFirst({
          where: { orderId, connector: 'woocommerce' },
          select: { externalOrderId: true },
        })
        if (link) {
          const suppressed = await tx.wcWithdrawalSuppression.findUnique({
            where: {
              connector_externalOrderId: { connector: 'woocommerce', externalOrderId: link.externalOrderId },
            },
            select: { retiredAt: true, pushProofToken: true, verifiedSafeUntil: true },
          })
          if (suppressed) {
            // A live row refuses outright. A RETIRED one is allowed only on a
            // single-use proof minted by the by-ID WooCommerce read taken
            // immediately before this claim — CONSUMED here under the lock, so
            // no other attempt can ride on it.
            if (!suppressed.retiredAt) return 'SKIPPED'
            if (!suppressed.pushProofToken) return 'SKIPPED'
            if (!suppressed.verifiedSafeUntil || suppressed.verifiedSafeUntil <= new Date()) return 'SKIPPED'
            const consumed = await tx.wcWithdrawalSuppression.updateMany({
              where: {
                connector: 'woocommerce',
                externalOrderId: link.externalOrderId,
                pushProofToken: suppressed.pushProofToken,
              },
              data: { pushProofToken: null, verifiedSafeUntil: null },
            })
            if (consumed.count === 0) return 'SKIPPED'
          }
        }

        const existing = await tx.wmsOrderPushLink.findUnique({
          where: { orderId },
          select: { state: true, attempts: true, lastAttemptAt: true },
        })
        // o3d-38gl: refuses while another worker's claim is still fresh. Without the lease,
        // PENDING_CREATE is merely a state that every waiting worker passes, and they all push.
        //
        // o3d-2k5r r4: and an EXPIRED claim is not granted either — it is parked, HERE, inside the
        // transaction that holds the order row lock and has just decided it is stale. Doing it in a
        // later statement would reopen the very race the lock closes: two sweeps could both read
        // PENDING_CREATE, both find it lapsed, and one of them could still be pushing while the
        // other wrote the park.
        const decision = decideCreateClaim(existing, attemptedAt)
        if (decision === 'SKIP') return 'SKIPPED'
        if (decision === 'PARK_AMBIGUOUS') {
          await tx.wmsOrderPushLink.updateMany({
            // Belt and braces under a lock that already serialises this: the park must not land on
            // a link some other writer moved between the read above and here.
            where: { orderId, state: 'PENDING_CREATE', lastAttemptAt: existing?.lastAttemptAt ?? null },
            data: {
              state: 'AMBIGUOUS_CREATE',
              // The same floor recordValidationFailure raises a converted claim to, and for exactly
              // the same reason: a claim exists only because a worker was about to call the WMS, so
              // attempts 0 must stop reading as "no call was ever dispatched" the moment we accept
              // that we will never learn the outcome. `increment` is deliberately not used —
              // attempts is a floor on calls that MAY have been made, not a retry count, and
              // re-parking the same link must not inflate it toward MAX_ATTEMPTS.
              attempts: Math.max(existing?.attempts ?? 0, AMBIGUOUS_ATTEMPTS),
              lastError: wmsAmbiguousCreateRefusal(connector, wmsPushOrderReference({ id: orderId, orderNumber: fresh?.orderNumber ?? null, externalOrderNumber: fresh?.externalOrderNumber ?? null })),
              lastAttemptAt: attemptedAt,
            },
          })
          return 'PARKED_AMBIGUOUS'
        }
        await tx.wmsOrderPushLink.upsert({
          where: { orderId },
          create: { orderId, connector, state: 'PENDING_CREATE', lastAttemptAt: attemptedAt },
          update: { lastAttemptAt: attemptedAt },
        })
        return 'CLAIMED'
      })
    },
    async recordValidationFailure(orderId, connector, error, attemptedAt) {
      return db.$transaction(async (tx) => {
        // The same row lock deleteSalesOrder and claimForCreate take — this is what makes the
        // disposition and the delete (or a concurrent claim) serialise rather than merely race.
        const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM sales_orders WHERE id = ${orderId} FOR UPDATE`
        if (locked.length === 0) return false
        const existing = await tx.wmsOrderPushLink.findUnique({
          where: { orderId },
          select: { state: true, attempts: true, lastAttemptAt: true },
        })
        // o3d-2k5r: ONE predicate, and deliberately THE CLAIM'S OWN. It answers both questions
        // this write has to get right, and an earlier version asked them separately — a state
        // check that shouldGrantCreateClaim already subsumes, which no test could ever fail.
        //
        //  1. Has the link MOVED ON? Any state other than PENDING_CREATE (SYNCED, PENDING_VERIFY,
        //     DEAD_LETTER, HELD, CANCELLED) belongs to a worker that has already talked to the
        //     WMS. Stamping VALIDATION_FAILED over a SYNCED link keeps its externalOrderId while
        //     dropping the order out of the update, hold, cancel and dispatch passes — a live
        //     warehouse order with nothing watching it.
        //  2. Is a PENDING_CREATE claim still LIVE? The state alone cannot tell "a claim nobody is
        //     using" from "a worker is inside pushOrder right now" — which is exactly why the
        //     claim gates on a lease. This write is a full state change plus a new lastAttemptAt,
        //     so on a fresh claim it would overwrite a live push AND move its lease clock forward.
        //     The cron rate-limits sweeps but does not serialise them, so overlapping passes are
        //     the designed-for case, not a freak race.
        //
        // The caller already treats false as "another worker owns this" and simply re-checks the
        // order next sweep.
        // o3d-2k5r r4: the DISPOSITION predicate, not the claim's. They diverged when an expired
        // claim stopped being claimable: this write sends nothing, so it may still convert a lapsed
        // claim (that conversion is what marks the disposition AMBIGUOUS). What it must never do is
        // land on a link that has moved on, or on a claim whose holder is still inside pushOrder.
        if (existing && !mayDisposeCreateClaim(existing, attemptedAt)) return false
        await tx.wmsOrderPushLink.upsert({
          where: { orderId },
          // CREATED here = provably pre-call: no link existed, so no worker had claimed the order
          // and pushOrder cannot have been invoked. attempts 0 is the hard-delete guard's proof,
          // and this branch is the ONLY writer entitled to mint it (see provesNoRemoteWmsCall).
          create: { orderId, connector, state: 'VALIDATION_FAILED', attempts: 0, lastError: error, lastAttemptAt: attemptedAt },
          // CONVERTED from an EXPIRED claim = AMBIGUOUS. The claim was written immediately before
          // a pushOrder call; the increment that would have recorded that call lives in a catch
          // whose own write is `.catch(() => {})` and which does not run at all if the worker was
          // killed. So a pre-existing claim still sitting at attempts 0 means "a call was
          // dispatched and we never learned the outcome". Raising it to AMBIGUOUS_ATTEMPTS is what
          // stops the guard reading that silence as proof and hard-deleting an order the warehouse
          // may be picking. `increment` is deliberately not used: attempts is a floor on calls that
          // may have been made, and re-parking the same link must not inflate it toward MAX_ATTEMPTS.
          update: {
            state: 'VALIDATION_FAILED',
            attempts: Math.max(existing?.attempts ?? 0, AMBIGUOUS_ATTEMPTS),
            lastError: error,
            lastAttemptAt: attemptedAt,
          },
        })
        return true
      })
    },
    async verifiableLinks(connector, limit) {
      const rows = await db.wmsOrderPushLink.findMany({
        where: { connector, state: 'PENDING_VERIFY', externalOrderId: { not: null } },
        select: {
          id: true, orderId: true, externalOrderId: true, attempts: true, courierPending: true,
          order: { select: { orderNumber: true, shippingService: true } },
        },
        take: limit,
        // Least-recently-ATTEMPTED first (o3d-bjc.8). An `unknown` verdict leaves
        // the row otherwise untouched, so a pushedAt ordering would re-select the
        // same permanently-unknown head batch every sweep and no newer link would
        // ever be verified — its live WMS order then stays out of the update,
        // dispatch and reconcile paths indefinitely.
        orderBy: [{ lastAttemptAt: { sort: 'asc', nulls: 'first' } }, { pushedAt: 'asc' }],
      })
      return rows.map((row) => ({
        id: row.id,
        orderId: row.orderId,
        externalOrderId: row.externalOrderId,
        orderNumber: row.order?.orderNumber ?? null,
        // What buildPushInput sends as ExternalOrderReference.
        externalReference: row.orderId,
        verifyAttempts: row.attempts,
        courierPending: row.courierPending,
        shippingService: row.order?.shippingService ?? null,
      }))
    },
    async updatableLinks(connector, limit) {
      // "order changed since push" is a two-column comparison Prisma can't express.
      const dueRows = await db.$queryRaw<Array<{ id: string }>>`
        SELECT l.id
        FROM wms_order_push_links l
        JOIN sales_orders o ON o.id = l."orderId"
        WHERE l.connector = ${connector}
          AND l.state::text = 'SYNCED'
          AND l."externalOrderId" IS NOT NULL
          AND o.status::text IN ('PROCESSING', 'ALLOCATED')
          AND o."refundStatus"::text <> 'FULL'
          AND o."updatedAt" > COALESCE(l."pushedAt", to_timestamp(0))
        ORDER BY o."updatedAt" ASC
        LIMIT ${limit}
      `
      const dueIds = dueRows.map((row) => row.id)
      if (!dueIds.length) return []
      return db.wmsOrderPushLink.findMany({
        where: { id: { in: dueIds } },
        select: { id: true, externalOrderId: true, order: { select: { ...ORDER_PUSH_SELECT, shipFromWarehouseId: true } } },
      })
    },
    async revalidatableLinks(connector, boundWarehouseIds, limit) {
      // o3d-92fu. The order predicate is deliberately IDENTICAL to createCandidates', because
      // this pass's only outcome is "put it back in that queue": promoting an order that
      // createCandidates would not accept would park it in PENDING_CREATE, which the
      // hard-delete guard blocks on — silently re-closing the door this issue opened, for an
      // order that provably never reached the WMS.
      //
      // o3d-2k5r r2: AND the same columns the core's re-queue guard reads, spread from the
      // SHARED CONSTANT rather than restated — a link carrying a WMS id or a push stamp must
      // not merely be skipped in the core, it must not occupy a slot in the bounded batch at
      // all. Nothing in this pass re-stamps a skipped link, and the ordering is
      // `lastAttemptAt asc nulls first`, so a handful of permanently-unpromotable links would
      // sit at the head of the queue every sweep and starve the promotable tail behind them.
      // Such a link is not silently dropped. It stays parked as VALIDATION_FAILED and is listed
      // by the sync-exceptions inbox, whose BLOCKED_WMS_PUSH_STATES includes VALIDATION_FAILED
      // precisely so a state nothing retries on its own cannot become an invisible
      // non-delivery. And `total` then counts only what this pass can act on, which is what the
      // overflow notice claims it counts.
      const where = {
        connector,
        state: 'VALIDATION_FAILED',
        ...NO_WMS_ORDER_COLUMNS,
        order: wmsCreateEligibleOrderWhere(boundWarehouseIds),
      } satisfies Prisma.WmsOrderPushLinkWhereInput
      const [rows, total] = await Promise.all([
        db.wmsOrderPushLink.findMany({
          where,
          select: {
            id: true, orderId: true, lastError: true, attempts: true,
            // Carried even though the where-clause already filters on them, so the core decides
            // with the shared predicate instead of trusting THIS port to have filtered.
            pushedAt: true, externalOrderId: true,
            order: { select: { ...ORDER_PUSH_SELECT, shipFromWarehouseId: true } },
          },
          take: limit,
          // Least-recently-CHECKED first, so a backlog larger than batchSize rotates through
          // instead of the same head batch being re-checked every sweep while the tail is
          // never revisited (the same failure verifiableLinks documents).
          orderBy: [{ lastAttemptAt: { sort: 'asc', nulls: 'first' } }, { updatedAt: 'asc' }],
        }),
        // The TRUE total, so the sweep can say what it did not get to this tick.
        db.wmsOrderPushLink.count({ where }),
      ])
      return { links: rows, total }
    },
    async ambiguousCreateLinks(connector, boundWarehouseIds, limit) {
      // o3d-2k5r r4. Same order predicate as createCandidates', for the reason revalidatableLinks
      // states: this pass's only outcome is "put it back in that queue", so anything that query
      // would refuse must not be promoted into PENDING_CREATE here.
      //
      // And the same NO_WMS_ORDER_COLUMNS filter, spread from the shared constant: a parked link
      // that somehow carries a WMS id or a push stamp can never be re-queued, so it must not occupy
      // a slot in the bounded batch either — the ordering is `lastAttemptAt asc nulls first`, and a
      // permanently-unpromotable head would starve the tail behind it every sweep. Such a link is
      // still visible: AMBIGUOUS_CREATE is one of the sync-exceptions inbox's blocked states.
      const where = {
        connector,
        state: 'AMBIGUOUS_CREATE',
        ...NO_WMS_ORDER_COLUMNS,
        order: wmsCreateEligibleOrderWhere(boundWarehouseIds),
      } satisfies Prisma.WmsOrderPushLinkWhereInput
      const [rows, total] = await Promise.all([
        db.wmsOrderPushLink.findMany({
          where,
          select: {
            id: true, orderId: true, lastError: true, attempts: true,
            pushedAt: true, externalOrderId: true,
            order: { select: { ...ORDER_PUSH_SELECT, shipFromWarehouseId: true } },
          },
          take: limit,
          orderBy: [{ lastAttemptAt: { sort: 'asc', nulls: 'first' } }, { updatedAt: 'asc' }],
        }),
        db.wmsOrderPushLink.count({ where }),
      ])
      return { links: rows, total }
    },
    // o3d-bjc.8: PENDING_VERIFY is deliberately NOT cancellable or holdable.
    // The tempting argument is urgency — a cancelled order must not ship — but
    // the mechanism does not survive it: in the very case this state exists for
    // (the create landed under an id we did not record correctly) the scoped
    // lookup for that wrong id 404s, which cancelMintsoftOrder reports as
    // NOT_FOUND and the sweep records as a successful cancellation. IMS would
    // then show CANCELLED while the real order stayed live and shipped. The
    // verify pass runs FIRST, so a resolvable link is SYNCED within the same
    // tick; one that will not resolve is escalated to an operator instead.
    holdableLinks: (connector, limit) =>
      db.wmsOrderPushLink.findMany({
        where: { connector, state: 'SYNCED', externalOrderId: { not: null }, order: { status: 'ON_HOLD' } },
        select: { id: true, orderId: true, externalOrderId: true },
        take: limit,
      }),
    cancellableLinks: (connector, limit) =>
      db.wmsOrderPushLink.findMany({
        where: {
          connector,
          state: 'SYNCED',
          externalOrderId: { not: null },
          order: {
            OR: [
              { status: 'CANCELLED' },
              // A fully-refunded order that has not yet dispatched must be pulled from the
              // WMS too; it keeps its lifecycle status under the orthogonal refund model,
              // so refundStatus (not status) is what flags it for cancellation.
              { refundStatus: 'FULL', status: { notIn: [...POST_DISPATCH_STATUSES, 'CANCELLED'] } },
            ],
          },
        },
        select: { id: true, orderId: true, externalOrderId: true },
        take: limit,
      }),
    async verifyWithdrawalFence(orderId) {
      const { verifyWithdrawalFenceForPush } = await import('@/lib/connectors/woocommerce/sync/withdrawal')
      return verifyWithdrawalFenceForPush(orderId)
    },
    async screenLiveWithdrawals(orderIds) {
      const { screenLiveWithdrawalsForPush } = await import('@/lib/connectors/woocommerce/sync/withdrawal')
      return screenLiveWithdrawalsForPush(orderIds)
    },
    async readLiveWithdrawal(orderId) {
      const { readLiveWithdrawalForOrder } = await import('@/lib/connectors/woocommerce/sync/withdrawal')
      return readLiveWithdrawalForOrder(orderId)
    },
    async readWithdrawalTombstone(orderId) {
      const { readStandingWithdrawalTombstone } = await import('@/lib/connectors/woocommerce/sync/withdrawal')
      return readStandingWithdrawalTombstone(orderId)
    },
    async readWithdrawalState(orderId) {
      return db.salesOrder.findUnique({
        where: { id: orderId },
        select: { withdrawalHoldAt: true, withdrawalApprovedAt: true },
      })
    },
    async updateLinkByOrder(orderId, data) {
      await db.wmsOrderPushLink.updateMany({ where: { orderId }, data })
    },
    async upsertByOrder(orderId, create, update) {
      await db.wmsOrderPushLink.upsert({ where: { orderId }, create: { orderId, ...create }, update })
    },
    async updateLink(id, data) {
      await db.wmsOrderPushLink.update({ where: { id }, data })
    },
    async updateLinkIfState(id, fromState, data) {
      // updateMany, not update: `update` has no way to express a predicate beyond the unique
      // key, so the compare-and-set has to go through the many-form. Postgres takes the row
      // lock for the duration of the matching scan, so two workers racing this cannot both
      // match — the loser sees count 0 and is told the link moved on. Same shape as the
      // per-attempt CAS in order-reconcile-sweep.
      const { count } = await db.wmsOrderPushLink.updateMany({
        where: { id, state: fromState as never },
        data,
      })
      return count > 0
    },
    recordEvent: (event) => recordWmsMutationEvent(event),
  }
}

export async function runWmsOrderPushSweep(
  options?: { batchSize?: number },
): Promise<WmsOrderPushSweepResult> {
  const empty: WmsOrderPushSweepResult = { created: 0, verified: 0, verifyQuarantined: 0, verifyUnresolved: 0, updated: 0, cancelled: 0, held: 0, released: 0, failed: 0, deadLettered: 0, validationFailed: 0, revalidated: 0, revalidateAmbiguous: 0, createClaimParked: 0, ambiguousCreateRequeued: 0 }

  const state = await getIntegrationPluginState()
  const connectorId = WMS_CONNECTOR_IDS.find((id) => state[id])
  if (!connectorId) return { ...empty, skipped: 'No WMS connector enabled' }

  const connector = getWmsConnector(connectorId)
  if (!connector.pushOrder) return { ...empty, skipped: 'Active WMS connector has no order-push support' }

  // o3d-1izw — THE PREFLIGHT. Before a candidate is read, a claim is taken or a connector is
  // called: this build writes push states an unmigrated database does not have, and a sweep that
  // discovers that half way through a claim leaves a link it cannot finish writing. Throws
  // WmsPushStateSchemaError, which names the issue and the remedy; the cron route surfaces it as a
  // failed job rather than a green run that quietly did nothing.
  await assertWmsPushStateSchemaReady()

  return runWmsOrderPushSweepCore(connector, connectorId, createPrismaWmsOrderPushPort(), options)
}
