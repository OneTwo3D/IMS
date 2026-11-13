import type { WmsOrderReconcileResult } from '@/lib/domain/wms/order-reconcile-sweep'
import type { WmsOrderPushSweepResult } from '@/lib/domain/wms/order-push-sweep'
import type { WmsOrderStatusSweepResult } from '@/lib/domain/wms/order-status-sweep'
import type { WmsDispatchSweepResult } from '@/lib/domain/wms/dispatch-sweep'
import type { WmsWatchdogResult } from '@/lib/domain/wms/watchdog-sweep'
import type { MintsoftBundleVerifyResult } from '@/lib/connectors/mintsoft/sync/bundle-sync'
import type { MintsoftProductSyncResult } from '@/lib/connectors/mintsoft/sync/product-sync'
import type { MintsoftReturnsSyncResult } from '@/lib/connectors/mintsoft/sync/returns-sync'
import type { MintsoftStockSyncResult } from '@/lib/connectors/mintsoft/sync/stock-sync'
import type { HsSweepResult } from '@/lib/trade/hs-classification-sweep'
import type { ProcessEmailOutboxResult } from '@/lib/email-outbox'
import type { ProcessRefundReservationReleaseResult } from '@/lib/domain/sales/refund-reservation-release-outbox'
import type { ProcessMintsoftBookedInEventsResult } from '@/lib/jobs/wms/process-mintsoft-booked-in-event'
import { classifyCronResult, type CronOutcomeClass } from './cron-run'

/**
 * THE EXIT-STATUS MAPPING OF EVERY /api/cron/* ROUTE, ONE ENTRY PER ROUTE, FROM THAT ROUTE'S OWN RESULT.
 *
 * A route says how its result reports failure, in its own terms (a status enum, a count, an error list), and this module turns that into
 * ok / skipped / held / failed (see lib/ops/cron-run.ts; only failed answers non-2xx). There is no shape-guessing at the response: a
 * route with no entry here has no mapping, and tests/ops/cron-response-census.test.ts fails it.
 *
 * Held: a write the outbound-write hold refused is not a failure. Text failures are recognised by the hold's own reference; the sweeps
 * that count failures as numbers also count the held ones in `outboundHeld`, which is subtracted before a count is read as a failure.
 */

type Rec = Record<string, unknown>

const isRec = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value)
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

const RANK: Record<CronOutcomeClass, number> = { skipped: 0, ok: 1, held: 2, failed: 3 }

/** The worst of the classes: failed, then held, then ok, then skipped. */
export function worstOutcome(...classes: CronOutcomeClass[]): CronOutcomeClass {
  return classes.reduce<CronOutcomeClass>((worst, next) => (RANK[next] > RANK[worst] ? next : worst), 'skipped')
}

/** Error text, error lists, `success: false` and a lowercase failed status, at any depth; held-aware. Skipped is not decided here. */
function structural(result: unknown): CronOutcomeClass {
  if (!isRec(result)) return 'ok'
  const { outcomeClass } = classifyCronResult({ ...result, skipped: undefined })
  return outcomeClass === 'skipped' ? 'ok' : outcomeClass
}

/** A status of FAILED or PARTIAL is a failure; SKIPPED is skipped. A failing status whose errors are all held writes is held. */
function enumStatus(result: unknown): CronOutcomeClass | null {
  if (!isRec(result)) return null
  const status = result.status
  if (status === 'SKIPPED') return 'skipped'
  if (status !== 'FAILED' && status !== 'PARTIAL') return null
  const errors = num(result.errors)
  return errors > 0 && errors <= num(result.outboundHeld) ? 'held' : 'failed'
}

/** Counts of failures: `failed` or `errors` as numbers, minus the held ones, in the record and every record nested in it. */
function counts(result: unknown, keys: readonly string[]): CronOutcomeClass {
  if (Array.isArray(result)) return worstOutcome('ok', ...result.map((entry) => counts(entry, keys)))
  if (!isRec(result) || result.skipped === true) return 'ok'
  const held = num(result.outboundHeld)
  const classes: CronOutcomeClass[] = ['ok']
  for (const key of keys) {
    // A list of error texts next to the count is the better evidence (held-aware): structural() reads it.
    if (Array.isArray(result[key])) continue
    const count = num(result[key])
    if (count > 0) classes.push(count <= held ? 'held' : 'failed')
  }
  for (const value of Object.values(result)) {
    if (isRec(value) || Array.isArray(value)) classes.push(counts(value, keys))
  }
  return worstOutcome(...classes)
}

/** A top-level skip: `skipped: true`, or a skip reason in `skipped` (a string) or `skippedReason`. */
function skippedByDesign(result: unknown): boolean {
  if (!isRec(result)) return false
  return result.skipped === true || (typeof result.skipped === 'string' && result.skipped !== '')
}

/** A route whose result carries no failure signal (it reports what it did; a failure is a throw): ok, or skipped when it says so. */
const noFailureSignal = (result: object): CronOutcomeClass => (skippedByDesign(result) ? 'skipped' : 'ok')

function from(result: unknown, ...parts: Array<CronOutcomeClass | null>): CronOutcomeClass {
  if (skippedByDesign(result)) return 'skipped'
  return worstOutcome('ok', ...parts.filter((part): part is CronOutcomeClass => part !== null))
}

/** A status-enum result: SKIPPED is skipped; otherwise the enum, the counts and the error texts decide. */
function enumResult(result: unknown, keys: readonly string[]): CronOutcomeClass {
  const status = enumStatus(result)
  if (status === 'skipped') return 'skipped'
  return from(result, status, counts(result, keys), structural(result))
}

type MintsoftStockSyncCronResult = { ran: number; due: number; details: Array<Pick<MintsoftStockSyncResult, 'status' | 'errors'>> }

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
  // status: SKIPPED | SUCCEEDED | PARTIAL | FAILED; errors: number
  'mintsoft-bundle-verify': (r: MintsoftBundleVerifyResult) => enumResult(r, ['errors']),
  // status enum; errors: number; outboundHeld: number
  'mintsoft-dispatch-sync': (r: WmsDispatchSweepResult) => enumResult(r, ['errors']),
  // status enum; errors: number
  'mintsoft-product-verify': (r: MintsoftProductSyncResult) => enumResult(r, ['errors']),
  // status enum; errors: number
  'mintsoft-returns-sync': (r: MintsoftReturnsSyncResult) => enumResult(r, ['errors']),
  // one result per binding: status enum and errors: number
  'mintsoft-stock-sync': (r: MintsoftStockSyncCronResult) => from(r, ...r.details.map((detail) => enumResult(detail, ['errors']))),
  // failed: number (booked-in events that failed to process); error texts in the recheck
  'mintsoft-webhook-sweeper': (r: Partial<ProcessMintsoftBookedInEventsResult> & Rec) => from(r, counts(r, ['failed']), structural(r)),
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
} satisfies Record<string, (result: never) => CronOutcomeClass>

export type CronOutcomeSlug = keyof typeof cronOutcomes

/** How one route's result ends, by the route's own mapping above. */
export function cronOutcome<K extends CronOutcomeSlug>(slug: K, result: Parameters<(typeof cronOutcomes)[K]>[0]): CronOutcomeClass {
  return (cronOutcomes[slug] as (result: unknown) => CronOutcomeClass)(result)
}
