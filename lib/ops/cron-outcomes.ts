import type { WmsOrderReconcileResult } from '@/lib/domain/wms/order-reconcile-sweep'
import type { WmsOrderPushSweepResult } from '@/lib/domain/wms/order-push-sweep'
import type { WmsOrderStatusSweepResult } from '@/lib/domain/wms/order-status-sweep'
import type { WmsWatchdogResult } from '@/lib/domain/wms/watchdog-sweep'
import type { HsSweepResult } from '@/lib/trade/hs-classification-sweep'
import type { ProcessEmailOutboxResult } from '@/lib/email-outbox'
import type { ProcessRefundReservationReleaseResult } from '@/lib/domain/sales/refund-reservation-release-outbox'
import { counts, from, enumResult, noFailureSignal, num, structural, worstOutcome } from './cron-outcome-helpers'
import { mintsoftCronOutcomes as warehouseConnectorCronOutcomes } from '@/lib/connectors/mintsoft/cron-outcomes' // wms-connector-boundary-ok: 2026-11-13: the registry spreads the connector's own entries
import type { CronOutcomeClass } from './cron-run'

export { worstOutcome }

/**
 * THE EXIT-STATUS MAPPING OF EVERY /api/cron/* ROUTE, ONE ENTRY PER ROUTE, FROM THAT ROUTE'S OWN RESULT.
 *
 * A route says how its result reports failure, in its own terms (a status enum, a count, an error list), and this module turns that into
 * ok / skipped / held / failed (see lib/ops/cron-run.ts; only failed answers non-2xx). There is no shape-guessing at the response: a
 * route with no entry here has no mapping, and tests/ops/cron-response-census.test.ts fails it.
 *
 * Held: a write the outbound-write hold refused is not a failure. Text failures are recognised by the hold's own reference; the sweeps
 * that count failures as numbers also count the held ones in `outboundHeld`, which is subtracted before a count is read as a failure.
 * The warehouse connector's routes have their own entries, spread in below.
 */

/**
 * ROUTE -> HOW ITS RESULT REPORTS FAILURE. The comment on each entry is the contract the route's own result type gives.
 */
export const cronOutcomes = {
  // errors: string[] (a vendor read that failed)
  'account-balance-snapshot': (r: { errors: string[] }) => from(r, structural(r)),
  // errors: string[]
  'accounting-daily-batch': (r: { errors?: string[]; skipped?: boolean }) => from(r, structural(r)),
  // success: false
  'accounting-fx-revaluation': (r: { success: boolean }) => from(r, r.success ? null : 'failed'),
  // errors: string[]
  'accounting-payment-poll': (r: { errors?: string[]; skipped?: boolean | string }) => from(r, structural(r)),
  // errors: string[]
  'accounting-payment-reconcile': (r: { errors?: string[]; skipped?: boolean }) => from(r, structural(r)),
  // failed: number minus outboundHeld; error texts anywhere in the Xero result and the sweeps around it
  'accounting-sync': (r: { failed?: number; outboundHeld?: number }) => from(r, counts(r, ['failed']), structural(r)),
  // a purge reports what it deleted; there is no failure signal short of a throw
  'activity-cleanup': noFailureSignal,
  // 'error' in the result
  backup: (r: object) => from(r, 'error' in r ? 'failed' : null),
  // delivery lookups report counts only; failure is a throw
  'delivery-status': noFailureSignal,
  // failed: number (an email that did not send); erasureReconcileIncomplete: string[]
  'email-outbox': (r: ProcessEmailOutboxResult & { erasureReconcileIncomplete?: string[] }) =>
    from(r, num(r.failed) > 0 || (r.erasureReconcileIncomplete?.length ?? 0) > 0 ? 'failed' : null),
  // errors / stepFailures: lists of texts; a step that threw is reported as { error }
  'fx-rates': (r: object) => from(r, structural(r)),
  // errors: number
  'hs-classify': (r: HsSweepResult) => from(r, num(r.errors) > 0 ? 'failed' : null),
  // status !== 'completed'
  'invariant-check': (r: { status?: unknown }) => from(r, r.status === 'completed' ? structural(r) : 'failed'),
  // a snapshot reports drift as data, which is an alert and not a failed run; failure is a throw
  'inventory-snapshot': noFailureSignal,
  // a run that stopped early having stored nothing and failed something; a partial run that stored some is progress
  'invoice-documents': (r: { stoppedEarly?: unknown; stored?: number; failed?: number }) =>
    from(r, r.stoppedEarly && num(r.stored) === 0 && num(r.failed) > 0 ? 'failed' : null),
  // an archive pass reports what it archived and skipped; there is no failure signal short of a throw
  'product-lifecycle-archive': noFailureSignal,
  // status: FAILED = a stale feed that no admin could be told about
  'read-sync-liveness': (r: { status?: unknown }) => from(r, r.status === 'FAILED' ? 'failed' : null),
  // failed: number (products whose lead time could not be written)
  'recompute-product-lead-times': (r: { failed: number }) => from(r, num(r.failed) > 0 ? 'failed' : null),
  // status: 'failed', or the run was not recorded
  'reconciliation-pack': (r: { status?: unknown; recorded?: boolean }) =>
    r.status === 'skipped' && r.recorded ? 'skipped' : r.status === 'failed' || !r.recorded ? 'failed' : 'ok',
  // a pass that threw is reported as ok: false with failures (the route classifies held throws itself and passes the class)
  'reallocation-sweep': (r: { ok?: boolean }) => from(r, r.ok === false ? 'failed' : null),
  // failed: number in each of the two drains
  'refund-reservation-release': (r: { release: ProcessRefundReservationReleaseResult; unmatchedWarnings: ProcessRefundReservationReleaseResult }) =>
    from(r, counts(r, ['failed'])),
  // failed: number (events that failed to process) and error texts, per connector tick and per drain
  'shopping-webhook-inbox': (r: object) => from(r, counts(r, ['failed']), structural(r)),
  // error texts and lists in each section (orders, products, stock, queued pushes); held pushes are recognised by their text
  'wc-reconcile': (r: object) => from(r, structural(r)),
  // the withdrawal and screening failures throw; errors: string[] from the erasure and admission sweeps
  'wc-withdrawal-sweep': (r: object) => from(r, structural(r)),
  // failed and deadLettered: numbers, with outboundHeld (held pushes, also in failed) subtracted
  'wms-order-push': (r: WmsOrderPushSweepResult) => from(r, counts(r, ['failed', 'deadLettered'])),
  // status enum; counters.errors: number
  'wms-order-reconcile': (r: WmsOrderReconcileResult) => enumResult(r, ['errors']),
  // failed: number
  'wms-order-status': (r: WmsOrderStatusSweepResult) => from(r, counts(r, ['failed'])),
  // status: FAILED = breaches nobody could be alerted to
  'wms-watchdog': (r: WmsWatchdogResult): CronOutcomeClass => (r.status === 'FAILED' ? 'failed' : r.status === 'SKIPPED' ? 'skipped' : 'ok'),
  // status: FAILED
  'writers-check': (r: { status?: unknown }) => from(r, r.status === 'FAILED' ? 'failed' : null),
  // errors: string[]
  'xero-chart-sync': (r: { errors?: string[]; skipped?: boolean }) => from(r, structural(r)),
  // an alert-only drift check: drift is data, failure is a throw
  'xero-tax-rate-drift': noFailureSignal,
  ...warehouseConnectorCronOutcomes,
} satisfies Record<string, (result: never) => CronOutcomeClass>

export type CronOutcomeSlug = keyof typeof cronOutcomes

/** How one route's result ends, by the route's own mapping above. */
export function cronOutcome<K extends CronOutcomeSlug>(slug: K, result: Parameters<(typeof cronOutcomes)[K]>[0]): CronOutcomeClass {
  return (cronOutcomes[slug] as (result: unknown) => CronOutcomeClass)(result)
}
