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
 * OFF BY DEFAULT: nothing is sent unless the setting `wc_withdrawal_outcome_enabled` is `true`, AND the ownership map's step-M gate lets the operation
 * through (`wooDrainHold(undefined, 'order.withdrawal-outcome')`: step M's live-from instant must have passed; before that it is held). The write is
 * idempotent per outcome key (the plugin adds a note once per key), so a webhook redelivery cannot add a second note. A failure is logged, never thrown:
 * the withdrawal handling itself (the hold, the cancellation) never waits on, or fails because of, the note.
 */
import { createHmac, randomBytes } from 'node:crypto'

import { logActivity } from '@/lib/activity-log'
import { connectorFetch } from '@/lib/security/connector-fetch'
import { isOutboundWriteHeldError } from '@/lib/security/outbound-write-grant'
import { getSettingValue, getSettingValues } from '@/lib/settings-store'
import { validateWooCommerceBaseUrl } from '../url-safety'
import { wooDrainHold, wooEgressHold } from '../producer-egress'

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
}

export type WithdrawalOutcomeResult =
  | { kind: 'written'; result: 'noted' | 'rejected' | 'already_done' | 'no_request' | 'no_withdrawal_plugin' }
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

const RESULTS = new Set(['noted', 'rejected', 'already_done', 'no_request', 'no_withdrawal_plugin'])

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

/** The one network call. Every refusal before it is a `skipped` result and sends nothing. */
export async function postWithdrawalOutcome(externalOrderId: string, input: WithdrawalOutcomeInput): Promise<WithdrawalOutcomeResult> {
  if (!(await isWithdrawalOutcomeEnabled())) return { kind: 'skipped', why: 'switch-off' }
  // The operation's own gate (its step must be live), then the destination-level barrier, the last one before anything leaves.
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

/**
 * Write the outcome of one withdrawal event, if its action has one and the writer is on. Never throws. `eventKey` identifies the customer event
 * (the order, the status and when it happened), so the same event written twice adds one note.
 */
export async function writeWithdrawalOutcomeForEvent(input: { orderId: string; externalOrderId: string; action: string; description: string; eventKey: string }): Promise<void> {
  const mapping = WITHDRAWAL_OUTCOME_BY_ACTION[input.action]
  if (!mapping) return
  try {
    const result = await postWithdrawalOutcome(input.externalOrderId, {
      outcome: mapping.outcome,
      outcomeKey: `${input.action}:${input.eventKey}`.slice(0, 96),
      note: `IMS: ${input.description}`,
      ...(mapping.reject ? { rejectReason: 'order already dispatched' } : {}),
    })
    if (result.kind === 'failed') {
      await logActivity({
        entityType: 'SALES_ORDER', entityId: input.orderId, action: 'wc_withdrawal_outcome_failed', tag: 'sync', level: 'WARNING',
        description: `The withdrawal outcome could not be written to the storefront order: ${result.error}`, resolveUser: false,
      })
    }
  } catch {
    // The outcome note must never turn a handled withdrawal into a failure.
  }
}
