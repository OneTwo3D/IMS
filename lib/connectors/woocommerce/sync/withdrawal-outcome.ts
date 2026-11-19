/**
 * THE WITHDRAWAL OUTCOME WRITER: TELL THE STOREFRONT WHAT IMS DID WITH A CUSTOMER'S EU WITHDRAWAL REQUEST.
 *
 * The bridge plugin's order sweep did this through its `/order/{id}/wdraw-outcome` route: an order note saying what happened and, when the goods had
 * already gone, a REJECTION of the customer's request through the withdrawal plugin's own service. Owner decision 2026-11-18 (1): at switchover step M IMS
 * takes it over and the bridge is fully disabled. IMS works from the order status (pending-wdraw or withdrawn), not from the bridge's queue
 * (withdrawal.ts), and this module writes the outcome back through the companion plugin (1.5.0 or later):
 * POST /wp-json/oti/v1/order/{id}/withdrawal-outcome, signed exactly like the TrackShip re-fire route (HMAC-SHA256 of `timestamp \n POST \n path \n body`,
 * single-use nonce in the body, 5 minute window).
 *
 * OFF BY DEFAULT: nothing is sent unless the setting `wc_withdrawal_outcome_enabled` is `true`, AND step M is live. Step M is checked two ways: the ownership
 * map's gate (`wooDrainHold(undefined, 'order.withdrawal-outcome')`, which only holds while the producer enforcement variable names woocommerce) AND the
 * step's own live-from read directly (`withdrawalOutcomeStepMHeld`, which holds whatever the enforcement variable says). The write is
 * idempotent TWICE OVER, keyed on the withdrawal's own identity (order + storefront request + outcome kind), never on a modified time: IMS writes each
 * outcome once, recorded durably in `wc_withdrawal_outcomes` after the storefront answers, and the plugin adds a note once per key. A redelivered webhook, a
 * poll, or the plugin's own later order change cannot add a second note. A failure is logged, never thrown: the withdrawal handling itself (the hold, the
 * cancellation) never waits on, or fails because of, the note. A rejection the storefront could not carry out (no request, no withdrawal plugin, or a failed
 * write) is NEVER recorded as written: it raises an operator task so a person rejects the request by hand.
 */
import { createHmac, randomBytes } from 'node:crypto'

import { logActivity } from '@/lib/activity-log'
import { connectorFetch } from '@/lib/security/connector-fetch'
import { isOutboundWriteHeldError } from '@/lib/security/outbound-write-grant'
import { getSettingValue, getSettingValues } from '@/lib/settings-store'
import { validateWooCommerceBaseUrl } from '../url-safety'
import { wooDrainHold, wooEgressHold } from '../producer-egress'
import { explainProducerDisposition, type ProducerDecisionContext } from '@/lib/security/producer-disposition'

/** The idempotency key IMS sends for an outcome, and the one the plugin stores (as `n:<key>` / `r:<key>`) in its done-marker meta. */
export function withdrawalOutcomeKey(externalOrderId: string, requestKey: string, action: string): string {
  return `wdo:${externalOrderId}:${requestKey}:${action}`.slice(0, 96)
}

export const WC_WITHDRAWAL_OUTCOME_ENABLED_SETTING = 'wc_withdrawal_outcome_enabled'

/** OFF BY DEFAULT: only an explicit `true` turns it on. */
export async function isWithdrawalOutcomeEnabled(): Promise<boolean> {
  return (await getSettingValue(WC_WITHDRAWAL_OUTCOME_ENABLED_SETTING)) === 'true'
}

export type WithdrawalOutcomeKind = 'noted' | 'rejected'
export type WithdrawalOutcomeInput = {
  outcome: WithdrawalOutcomeKind
  /** One key per outcome event; the storefront writes the note once per key. */
  outcomeKey: string
  note: string
  rejectReason?: string
  /** The storefront withdrawal request id, from IMS's own record. The plugin checks that it belongs to the order. */
  requestId?: string
}

export type WithdrawalOutcomeResult =
  | { kind: 'written'; result: 'noted' | 'rejected' | 'already_done' | 'no_request' | 'no_withdrawal_plugin' | 'not_rejected' }
  | { kind: 'order-gone' }
  | { kind: 'skipped'; why: 'switch-off' | 'held' }
  | { kind: 'failed'; error: string }

/** The path the route is served at, which is part of what is signed. */
export function withdrawalOutcomePath(orderId: string): string {
  return `/wp-json/oti/v1/order/${orderId}/withdrawal-outcome`
}

export function signWithdrawalOutcome(input: { timestamp: number; orderId: string; body: string }, secret: string): string {
  return createHmac('sha256', secret).update(`${input.timestamp}\nPOST\n${withdrawalOutcomePath(input.orderId)}\n${input.body}`).digest('hex')
}

const RESULTS = new Set(['noted', 'rejected', 'already_done', 'no_request', 'no_withdrawal_plugin', 'not_rejected'])

/** The pure half of the transport: the storefront's HTTP answer to a result. Never remote free text. */
export function classifyWithdrawalOutcomeResponse(status: number, body: unknown): WithdrawalOutcomeResult {
  const record = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  if (status === 200) {
    return typeof record.result === 'string' && RESULTS.has(record.result)
      ? { kind: 'written', result: record.result as 'noted' }
      : { kind: 'failed', error: 'The storefront answered the withdrawal outcome with a result IMS does not know, so nothing is recorded as done.' }
  }
  if (status === 404) {
    return record.code === 'oti_wo_not_found'
      ? { kind: 'order-gone' }
      : { kind: 'failed', error: 'The storefront has no withdrawal-outcome route: install the onetwoInventory Helper plugin 1.5.0 or later on the store.' }
  }
  if (status === 401) return { kind: 'failed', error: 'The storefront refused the signature of the withdrawal outcome: the shared webhook secret does not match the plugin.' }
  if (status === 409) return { kind: 'failed', error: 'Another outcome for this order was already running on the storefront.' }
  return { kind: 'failed', error: `The storefront answered the withdrawal outcome with HTTP ${status}.` }
}

const TIMEOUT_MS = 30_000

/**
 * Step M's own live-from, read directly (not through the producer enforcement variable): the withdrawal outcome is IMS's only once the step's live-from has
 * passed and IMS owns the operation there. Anything unreadable holds. Pure; never throws.
 */
export function withdrawalOutcomeStepMHeld(context: ProducerDecisionContext = {}): boolean {
  const decision = explainProducerDisposition('woocommerce', 'order.withdrawal-outcome', undefined, context)
  return decision.phase !== 'P2' || decision.owner !== 'IMS'
}

/** The one network call. Every refusal before it is a `skipped` result and sends nothing. */
export async function postWithdrawalOutcome(externalOrderId: string, input: WithdrawalOutcomeInput): Promise<WithdrawalOutcomeResult> {
  if (!(await isWithdrawalOutcomeEnabled())) return { kind: 'skipped', why: 'switch-off' }
  // The operation's own gate (its step must be live), then the destination-level barrier, the last one before anything leaves.
  if (withdrawalOutcomeStepMHeld()) return { kind: 'skipped', why: 'held' }
  if (wooDrainHold(undefined, 'order.withdrawal-outcome').held) return { kind: 'skipped', why: 'held' }
  if (wooEgressHold().held) return { kind: 'skipped', why: 'held' }
  const config = await getSettingValues(['wc_url', 'wc_webhook_secret'])
  const url = config.get('wc_url') ?? ''
  const secret = config.get('wc_webhook_secret') ?? ''
  if (!url || !secret) return { kind: 'failed', error: 'WooCommerce URL or webhook secret is not configured.' }
  const validated = validateWooCommerceBaseUrl(url)
  if (!validated.ok) return { kind: 'failed', error: validated.error }
  if (!/^[1-9]\d{0,17}$/.test(externalOrderId)) return { kind: 'failed', error: 'The storefront order id is not a number, so nothing was sent.' }
  const timestamp = Math.floor(Date.now() / 1000)
  const body = JSON.stringify({
    order_id: Number(externalOrderId), ts: timestamp, nonce: randomBytes(16).toString('hex'),
    outcome: input.outcome, outcome_key: input.outcomeKey, note: input.note,
    ...(input.rejectReason ? { reject_reason: input.rejectReason } : {}),
    ...(input.requestId && /^[1-9]\d{0,17}$/.test(input.requestId) ? { request_id: Number(input.requestId) } : {}),
  })
  try {
    const res = await connectorFetch(`${validated.normalizedUrl}${withdrawalOutcomePath(externalOrderId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-OTI-Timestamp': String(timestamp), 'X-OTI-Signature': signWithdrawalOutcome({ timestamp, orderId: externalOrderId, body }, secret) },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }, { connectorName: 'WooCommerce' })
    return classifyWithdrawalOutcomeResponse(res.status, await res.json().catch(() => null))
  } catch (error) {
    if (isOutboundWriteHeldError(error)) return { kind: 'skipped', why: 'held' }
    return { kind: 'failed', error: `The withdrawal outcome request did not complete: ${error instanceof Error ? error.name : 'unknown error'}.` }
  }
}

/** What each withdrawal log event means for the storefront. Events not listed write nothing. */
export const WITHDRAWAL_OUTCOME_BY_ACTION: Readonly<Record<string, { outcome: WithdrawalOutcomeKind; reject?: boolean }>> = {
  // The request came in after despatch: the goods have gone, so it is a return. The request is rejected, as the bridge did.
  wc_withdrawal_after_dispatch: { outcome: 'rejected', reject: true },
  wc_withdrawal_approved_after_dispatch: { outcome: 'noted' },
  wc_withdrawal_hold_applied: { outcome: 'noted' },
  wc_withdrawal_hold_failed: { outcome: 'noted' },
  wc_withdrawal_approved: { outcome: 'noted' },
  wc_withdrawal_approval_failed: { outcome: 'noted' },
}

/** The result words that mean the storefront DID what was asked. `no_request` and `no_withdrawal_plugin` are failures of a rejection. */
const DONE_RESULTS = new Set(['noted', 'rejected', 'already_done'])

/** What the store knows of the order's withdrawal request. `previousRequestId` is what IMS held BEFORE this call recorded `requestId`. */
export type WithdrawalRequestIdentity = { requestId: string | null; previousRequestId: string | null; generation: number }
export type WithdrawalOutcomeRow = { result: string; generation: number | null }

/** The durable once-only store. A test seam; absent = the database. */
export type WithdrawalOutcomeStore = {
  /** IMS's record of the order's withdrawal request: records `incomingRequestId` when given (a different id replaces the recorded one) and returns it. */
  identity(orderId: string, incomingRequestId: string | null): Promise<WithdrawalRequestIdentity>
  findRow(orderId: string, requestKey: string, kind: string): Promise<WithdrawalOutcomeRow | null>
  markWritten(orderId: string, requestKey: string, kind: string, result: string, generation: number): Promise<void>
  /**
   * One task per order, outcome kind, request key and hold generation, however often it is raised: a LATER request (another key or generation) on the same
   * order raises its own, even when the earlier task was closed.
   */
  raiseTask(input: { orderId: string; externalOrderId: string; kind: string; requestKey: string; generation: number; queryText: string }): Promise<void>
}

/** A terminal row: the storefront could not carry the outcome out, a task was raised, and IMS does not try or warn again for this key. */
export const TASK_RAISED_RESULT = 'task_raised'

const dbStore: WithdrawalOutcomeStore = {
  async identity(orderId, incomingRequestId) {
    const { db } = await import('@/lib/db')
    // Read, compare and record under the order's row lock (as withdrawal.ts does), so two events for the same order cannot both read the same
    // "previous" id and both take the alias or the new-id path.
    return db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM sales_orders WHERE id = ${orderId} FOR UPDATE`
      if (locked.length === 0) return { requestId: null, previousRequestId: null, generation: 0 }
      const before = await tx.salesOrder.findUnique({ where: { id: orderId }, select: { withdrawalRequestId: true, withdrawalHoldGeneration: true } })
      if (incomingRequestId && before && before.withdrawalRequestId !== incomingRequestId) {
        await tx.salesOrder.update({ where: { id: orderId }, data: { withdrawalRequestId: incomingRequestId } })
      }
      return {
        requestId: incomingRequestId ?? before?.withdrawalRequestId ?? null,
        previousRequestId: before?.withdrawalRequestId ?? null,
        generation: before?.withdrawalHoldGeneration ?? 0,
      }
    })
  },
  async findRow(orderId, requestKey, kind) {
    const { db } = await import('@/lib/db')
    const row = await db.wcWithdrawalOutcome.findFirst({ where: { orderId, requestKey, outcomeKind: kind }, select: { result: true, holdGeneration: true } })
    return row ? { result: row.result, generation: row.holdGeneration } : null
  },
  async markWritten(orderId, requestKey, kind, result, generation) {
    const { db } = await import('@/lib/db')
    await db.wcWithdrawalOutcome.createMany({ data: [{ orderId, requestKey, outcomeKind: kind, result, holdGeneration: generation }], skipDuplicates: true })
  },
  async raiseTask(input) {
    const { db } = await import('@/lib/db')
    const { raiseWmsOperatorTask } = await import('@/lib/domain/wms/operator-tasks')
    await raiseWmsOperatorTask(db, {
      connector: 'woocommerce', orderId: input.orderId, externalOrderId: input.externalOrderId, reason: 'WITHDRAWAL_REJECT_NOT_WRITTEN',
      queryText: input.queryText, dedupeBasis: `wdraw-reject:${input.orderId}:${input.kind}:${input.requestKey}:g${input.generation}`,
    })
  },
}

/** The fixed per-order key for "the storefront request id is not known". It never moves with the order's modified time or a counter. */
export const unknownRequestKey = (orderId: string): string => `u:${orderId}`
/** The marker for "the request IMS recorded (or none) may not be the one now pending": raised once per recorded request (or the unknown key) and hold generation. */
const ambiguousKey = (orderId: string, requestId: string | null, generation: number): string => `x:${orderId}:${requestId ?? 'u'}:g${generation}`

/**
 * Write the outcome of one withdrawal event, if its action has one and the writer is on. Never throws. The identity is (order, withdrawal request, action):
 * the same event seen again, however often and whatever the order's modified time, adds nothing once the storefront has confirmed it. With no request id
 * known the identity is the fixed key `u:<order>`; a rejection the storefront cannot carry out raises ONE operator task for the order and records a terminal
 * row for its key, so it is neither re-sent nor re-warned on every webhook.
 * `requestId` is the storefront request id read from the order payload (the helper plugin's `_oti_wdraw_request_id`), when it carries one.
 */
export async function writeWithdrawalOutcomeForEvent(
  input: { orderId: string; externalOrderId: string; action: string; description: string; requestId?: string | null },
  store: WithdrawalOutcomeStore = dbStore,
): Promise<void> {
  const mapping = WITHDRAWAL_OUTCOME_BY_ACTION[input.action]
  if (!mapping) return
  try {
    if (!(await isWithdrawalOutcomeEnabled())) return
    const identity = await store.identity(input.orderId, input.requestId ?? null)
    const { requestId, generation } = identity
    const requestKey = requestId ? `r${requestId}` : unknownRequestKey(input.orderId)
    const row = await store.findRow(input.orderId, requestKey, input.action)
    if (row) {
      // A request IMS has already handled (or failed to), and a NEWER submission since, with no new request id to tell them apart: IMS cannot say whether the
      // pending request is the one it handled. Never skip it silently: a person looks, once per generation. This applies to the unknown key too: a later
      // request B whose id is still unknown must not be swallowed by the row of request A.
      if (mapping.reject && row.generation !== null && generation > row.generation) {
        const marker = ambiguousKey(input.orderId, requestId, generation)
        if (await store.findRow(input.orderId, marker, input.action)) return
        await store.markWritten(input.orderId, marker, input.action, TASK_RAISED_RESULT, generation)
        await store.raiseTask({
          orderId: input.orderId, externalOrderId: input.externalOrderId, kind: input.action, requestKey: marker, generation,
          queryText: `The customer filed another withdrawal request for storefront order ${input.externalOrderId} after despatch, and IMS cannot tell whether it is the one it already handled${requestId ? ` (request ${requestId})` : ''}. Check the order in WooCommerce and reject the pending request by hand.`,
        })
      }
      return
    }
    // The request id has just become known for an order whose outcome was already written under the unknown key: the same request, not a second note and
    // not a second rejection. Only for the SAME submission (equal hold generation): a later submission moves the generation, so a stored outcome says nothing
    // about it and its own outcome is sent. A rejection already carried out under the unknown key is adopted the same way: the plugin answers 'rejected' to a
    // request that is already rejected, but it ALSO adds a second admin note, so it is never posted again for the same generation.
    if (requestId && identity.previousRequestId === null) {
      const unknownRow = await store.findRow(input.orderId, unknownRequestKey(input.orderId), input.action)
      const sameSubmission = unknownRow !== null && DONE_RESULTS.has(unknownRow.result) && unknownRow.generation !== null && unknownRow.generation === generation
      const sameOutcome = unknownRow !== null && (mapping.reject ? unknownRow.result === 'rejected' || unknownRow.result === 'already_done' : unknownRow.result !== 'rejected')
      if (unknownRow && sameSubmission && sameOutcome) {
        await store.markWritten(input.orderId, requestKey, input.action, unknownRow.result, generation)
        return
      }
    }
    const result = await postWithdrawalOutcome(input.externalOrderId, {
      outcome: mapping.outcome,
      outcomeKey: withdrawalOutcomeKey(input.externalOrderId, requestKey, input.action),
      note: `IMS: ${input.description}`,
      ...(mapping.reject ? { rejectReason: 'order already dispatched' } : {}),
      ...(requestId ? { requestId } : {}),
    })
    if (result.kind === 'written' && DONE_RESULTS.has(result.result)) {
      await store.markWritten(input.orderId, requestKey, input.action, result.result, generation)
      return
    }
    const why = result.kind === 'written' ? (result.result === 'no_request' ? 'the storefront holds no withdrawal request for this order'
      : result.result === 'not_rejected' ? 'the request is no longer pending and is not rejected (it may have been approved)' : 'the withdrawal plugin is not active on the storefront')
      : result.kind === 'failed' ? result.error : null
    if (why === null) return
    if (mapping.reject) {
      await store.raiseTask({
        orderId: input.orderId, externalOrderId: input.externalOrderId, kind: input.action, requestKey, generation,
        queryText: `The customer's withdrawal request for storefront order ${input.externalOrderId} was filed after despatch and IMS could not reject it (${why}). Reject the request in WooCommerce by hand.`,
      })
    }
    // A definite "cannot" from the storefront is terminal for this key once the task is raised: no resend, no new warning per webhook. A transport
    // failure is not: it is tried again.
    if (result.kind === 'written') await store.markWritten(input.orderId, requestKey, input.action, TASK_RAISED_RESULT, generation)
    await logActivity({
      entityType: 'SALES_ORDER', entityId: input.orderId, action: 'wc_withdrawal_outcome_failed', tag: 'sync', level: 'WARNING',
      description: `The withdrawal outcome could not be written to the storefront order: ${why}`, resolveUser: false,
    })
  } catch {
    // The outcome note must never turn a handled withdrawal into a failure.
  }
}
