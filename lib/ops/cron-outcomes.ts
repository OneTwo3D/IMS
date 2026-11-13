import type { WmsOrderReconcileResult } from '@/lib/domain/wms/order-reconcile-sweep'
import type { WmsOrderPushSweepResult } from '@/lib/domain/wms/order-push-sweep'
import type { WmsOrderStatusSweepResult } from '@/lib/domain/wms/order-status-sweep'
import type { WmsWatchdogResult } from '@/lib/domain/wms/watchdog-sweep'
import type { HsSweepResult } from '@/lib/trade/hs-classification-sweep'
import type { ProcessEmailOutboxResult } from '@/lib/email-outbox'
import type { ProcessRefundReservationReleaseResult } from '@/lib/domain/sales/refund-reservation-release-outbox'
import type { syncAccountingAccountBalanceSnapshots } from '@/lib/accounting'
import type { runArApFxRevaluation } from '@/lib/accounting-fx-revaluation'
import type { runScheduledInvariantCheck } from '@/lib/cron/invariant-check'
import type { fetchAllFxRatesInternal } from '@/lib/currencies/fx-refresh'
import type { retryPendingWcOrdersWaitingForFx } from '@/lib/connectors/woocommerce/sync/order-import'
import type { sweepUnregisteredReceipts } from '@/lib/domain/accounting/receipt-registration-sweep'
import type { writeDailyInventorySnapshot } from '@/lib/domain/inventory/inventory-snapshot'
import type { runInvoiceDocumentSweep } from '@/lib/domain/invoice-documents/sweep'
import type { getInvoiceDocumentHealth } from '@/lib/domain/invoice-documents/health'
import type { runScheduledReconciliationPack } from '@/lib/ops/reconciliation-pack-schedule'
import type { runReadSyncLivenessAlarmLive } from '@/lib/ops/read-sync-liveness-alarm'
import type { runWritersCheckRecord } from '@/lib/ops/writers-check-record'
import type { syncChartOfAccounts } from '@/lib/connectors/xero/accounts'
import type { pollXeroPayments } from '@/lib/connectors/xero/payment-poller'
import type { reconcileXeroPayments } from '@/lib/connectors/xero/payment-reconcile'
import type { repairXeroBackReferences, reenqueueMissingCreditNoteAllocations } from '@/lib/connectors/xero/sync-processor'
import type { processLandedCostJournalOutbox } from '@/lib/domain/purchasing/landed-cost-journal-outbox'
import type { reconcileProvisionalPostingRefusals } from '@/lib/domain/accounting/posting-refusal-reconcile'
import type { WcReconcileResult } from '@/lib/connectors/woocommerce/sync/reconcile'
import type { sweepUnallocatedProcessingOrders } from '@/lib/fulfillment/reallocation-sweep'
import type { sweepUnresolvedDirectCreateMarkers } from '@/lib/fulfillment/pre-fulfilment-reallocation'
import type { sweepWithdrawalSuppressions, sweepDispatchEligibleWithdrawals } from '@/lib/connectors/woocommerce/sync/withdrawal'
import type { drainWcOrderAdmissionRefusals } from '@/lib/connectors/woocommerce/sync/order-admission'
import type { WcErasureSweepOutcome } from '@/lib/connectors/woocommerce/sync/anonymisation-sweep'
import type { purgeExpiredActivityLogs, purgeExpiredCronRuns } from '@/lib/activity-log-cleanup'
import type { purgeExpiredData } from '@/lib/data-retention'
import type { ProcessPendingWcWebhookEventsResult } from '@/lib/jobs/woocommerce/process-shopping-webhook-events'
import type { processShoppingOrderCompletions, processShoppingOrderStatusPushes, processShoppingInvoiceDocumentPublications } from '@/lib/shopping'
import type { XeroDailyBatchResult } from '@/lib/connectors/xero/daily-sync'
import { counts, from, enumResult, noFailureSignal, num, permanentLists, structural, worstOutcome } from './cron-outcome-helpers'
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

type Ret<F extends (...args: never[]) => unknown> = Awaited<ReturnType<F>>

/** A run that did nothing by design. */
type Skip = { skipped: boolean; reason: string }

/** What each route answers, written out so that every field a producer reports is visible to tests/ops/cron-outcome-fields.test.ts. */
type BackupCronResult =
  | Skip
  | { error: string }
  | { filename: string; uploaded: boolean; deleted: number; uploadError?: string; cleanupError?: string }
type FxRatesCronResult = (Ret<typeof fetchAllFxRatesInternal> | { error: string }) & {
  pendingWcReceiptRetry: {
    queue: Ret<typeof retryPendingWcOrdersWaitingForFx> | { error: string }
    orphans: Ret<typeof sweepUnregisteredReceipts> | { error: string }
  }
  stepFailures?: Array<{ step: string; error: string }>
}
type AccountingSyncCronResult = {
  processed?: number
  succeeded?: number
  failed?: number
  skipped?: number | boolean
  reason?: string
  outboundHeld?: number
  backReferenceRepair?: Ret<typeof repairXeroBackReferences>
  creditNoteAllocationReenqueue?: Ret<typeof reenqueueMissingCreditNoteAllocations>
  landedCostJournalOutbox?: Ret<typeof processLandedCostJournalOutbox>
  provisionalPostingRefusals?: Ret<typeof reconcileProvisionalPostingRefusals>
  errors?: string[]
}
type ActivityCleanupCronResult = {
  totalDeleted: number
  retention: Ret<typeof purgeExpiredActivityLogs>['retention']
  demandDeleted: number
  cronRuns: Ret<typeof purgeExpiredCronRuns>
  dataRetention: Ret<typeof purgeExpiredData>
  wmsMutationEvents: number
}
type ReallocationSweepCronResult = Partial<Ret<typeof sweepUnallocatedProcessingOrders>> & {
  directCreateMarkers: Ret<typeof sweepUnresolvedDirectCreateMarkers> | null
  ok?: boolean
  failures?: Record<string, string>
}
type WcWithdrawalSweepCronResult = Ret<typeof sweepWithdrawalSuppressions> & {
  dispatchScreen?: Ret<typeof sweepDispatchEligibleWithdrawals>
  admissionRefusals: Ret<typeof drainWcOrderAdmissionRefusals>
  erasureSweep: WcErasureSweepOutcome
}
export type ShoppingTick =
  | ProcessPendingWcWebhookEventsResult
  | { skipped: true; reason: string; gates: object }
  | { attempted: number; processed: number; failed: number; deadLettered: number; skipped: number; error: string }
export type ShoppingDrain =
  | Ret<typeof processShoppingOrderCompletions>
  | Ret<typeof processShoppingOrderStatusPushes>
  | Ret<typeof processShoppingInvoiceDocumentPublications>
  | { skipped: boolean; reason?: string; error?: string }
type ShoppingWebhookInboxCronResult = {
  connectors: {
    woocommerce: ShoppingTick & {
      orderCompletions: ShoppingDrain
      orderStatusPushes: ShoppingDrain
      invoiceDocumentPublications: ShoppingDrain
    }
  }
}
type ReconciliationPackCronResult = {
  status: Ret<typeof runScheduledReconciliationPack>['status']
  outcome: Ret<typeof runScheduledReconciliationPack>['record']['outcome']
  code: Ret<typeof runScheduledReconciliationPack>['record']['code']
  exitCode: Ret<typeof runScheduledReconciliationPack>['record']['exitCode']
  packRunId: Ret<typeof runScheduledReconciliationPack>['record']['runId']
  sequence: Ret<typeof runScheduledReconciliationPack>['record']['sequence']
  recorded: boolean
}
type InvoiceDocumentsCronResult = Ret<typeof runInvoiceDocumentSweep> & { health: Ret<typeof getInvoiceDocumentHealth> }
type XeroChartSyncCronResult = Ret<typeof syncChartOfAccounts> | Skip
type WritersCheckCronResult = Ret<typeof runWritersCheckRecord>

export const cronOutcomes = {
  // errors: string[] (a vendor read that failed)
  'account-balance-snapshot': (r: Ret<typeof syncAccountingAccountBalanceSnapshots>) => from(r, structural(r)),
  // errors: string[]
  'accounting-daily-batch': (r: XeroDailyBatchResult | Skip) => from(r, structural(r)),
  // success: false; `error`; refused: number (enqueues the run owed and could not make)
  'accounting-fx-revaluation': (r: Ret<typeof runArApFxRevaluation>) => from(r, r.success ? null : 'failed', structural(r), r.refused > 0 ? 'failed' : null),
  // errors: string[]
  'accounting-payment-poll': (r: Ret<typeof pollXeroPayments> | Skip) => from(r, structural(r)),
  // errors: string[]
  'accounting-payment-reconcile': (r: ({ mode: string } & Ret<typeof reconcileXeroPayments>) | Skip) => from(r, structural(r)),
  // failed: number minus outboundHeld; error texts anywhere in the Xero result and the sweeps around it
  // a sweep that threw is carried in `errors` (held-aware), and counts even on a tick that otherwise skipped by design
  'accounting-sync': (r: AccountingSyncCronResult) => {
    const sweepFailure = r.errors && r.errors.length > 0 ? structural({ errors: r.errors }) : null
    return from(r, counts(r, ['failed']), structural(r), sweepFailure)
  },
  // a purge reports what it deleted; there is no failure signal short of a throw
  'activity-cleanup': (r: ActivityCleanupCronResult) => noFailureSignal(r),
  // `error` (the dump or its manifest failed); `uploadError` (a configured remote target did not take the copy); `cleanupError` (retention purge failed)
  backup: (r: BackupCronResult) => from(r, 'error' in r || 'uploadError' in r || 'cleanupError' in r ? 'failed' : null),
  // failed: number (a refused or unanswered TrackShip lookup, an order that could not be marked delivered)
  'delivery-status': (r: { checked: number; delivered: number; failed?: number }) => from(r, counts(r, ['failed'])),
  // failed (an email that did not send), parked (stale rows moved to the send cap), conflicted, conflictedWithoutSend and
  // unresolvedAfterSend (a duplicate send is possible): numbers; erasureReconcileIncomplete: string[]
  'email-outbox': (r: ProcessEmailOutboxResult & { erasureReconcileIncomplete?: string[] }) =>
    from(r, counts(r, ['failed', 'parked', 'conflicted', 'conflictedWithoutSend', 'unresolvedAfterSend']), (r.erasureReconcileIncomplete?.length ?? 0) > 0 ? 'failed' : null),
  // errors / stepFailures: lists of texts; a step that threw is reported as { error }; connectorPushFailures / connectorPushHeld: connector FX push errors returned (not thrown) by the fan-out, held ones apart; pendingWcOrderRetryFailures: the order retry threw
  'fx-rates': (r: FxRatesCronResult) => from(r, structural(r), counts(r, ['failed', 'connectorPushFailures', 'pendingWcOrderRetryFailures'])),
  // errors: number
  'hs-classify': (r: HsSweepResult) => from(r, num(r.errors) > 0 ? 'failed' : null),
  // status !== 'completed'
  'invariant-check': (r: Ret<typeof runScheduledInvariantCheck>) => from(r, r.status === 'completed' ? structural(r) : 'failed'),
  // a snapshot reports drift as data, which is an alert and not a failed run; failure is a throw
  'inventory-snapshot': (r: Ret<typeof writeDailyInventorySnapshot>) => noFailureSignal(r),
  // stoppedEarly (an unexpected exception, a ledger refusal or rate limit, or three fetch failures in a row) fails the run WHATEVER `stored` is:
  // partial progress does not make an unfinished sweep a success. Held-aware (a hold-refused stop reads as held). failed: documents that failed this run.
  'invoice-documents': (r: InvoiceDocumentsCronResult) =>
    from(r, r.stoppedEarly ? structural({ error: r.stoppedEarly }) : null, num(r.failed) > 0 ? 'failed' : null),
  // an archive pass reports what it archived and skipped; there is no failure signal short of a throw
  'product-lifecycle-archive': (r: { scanned: number; archived: number; skippedWithStock: number; skippedWithIncoming: number }) => noFailureSignal(r),
  // status: FAILED = a stale feed that no admin could be told about
  'read-sync-liveness': (r: Ret<typeof runReadSyncLivenessAlarmLive>) => from(r, r.status === 'FAILED' ? 'failed' : null),
  // failed: number (products whose lead time could not be written)
  'recompute-product-lead-times': (r: { failed: number }) => from(r, num(r.failed) > 0 ? 'failed' : null),
  // status: 'failed', or the run was not recorded
  'reconciliation-pack': (r: ReconciliationPackCronResult) =>
    r.status === 'skipped' && r.recorded ? 'skipped' : r.status === 'failed' || !r.recorded ? 'failed' : 'ok',
  // stockEnqueueFailures: the storefront stock enqueue after the allocations failed (the store keeps the old quantities);
  // a pass that threw is reported as ok: false with failures (the route classifies held throws itself and passes the class)
  'reallocation-sweep': (r: ReallocationSweepCronResult) => from(r, r.ok === false ? 'failed' : null, counts(r, ['errors', 'stockEnqueueFailures'])),
  // failed: number in each of the two drains
  'refund-reservation-release': (r: { release: ProcessRefundReservationReleaseResult; unmatchedWarnings: ProcessRefundReservationReleaseResult }) =>
    from(r, counts(r, ['failed'])),
  // failed: number (events that failed to process) and error texts, per connector tick and per drain
  'shopping-webhook-inbox': (r: ShoppingWebhookInboxCronResult) => from(r, counts(r, ['failed', 'deadLettered']), structural(r)),
  // error texts and lists in each section (orders, products, stock, queued pushes); held pushes are recognised by their text;
  // refundStockCorrections.error (the queueing of open refund stock corrections threw); products.permanentErrors: permanent import conflicts, reported apart from errors and never cleared without an operator
  'wc-reconcile': (r: WcReconcileResult | Skip) => from(r, structural(r), permanentLists(r, ['permanentErrors'])),
  // the withdrawal and screening failures throw; errors: string[] from the erasure sweep; admissionRefusals.failed: number (the by-id read or the import failed)
  'wc-withdrawal-sweep': (r: WcWithdrawalSweepCronResult | Skip) => from(r, structural(r), counts(r, ['failed'])),
  // failed, deadLettered and shadowUnrecorded (a held create whose only record could not be written): numbers, with outboundHeld (held pushes, also in failed) subtracted;
  // validationFailed and createClaimParked: orders NEWLY parked this run (the payload cannot be built; a dispatched create with no recorded outcome), counted once on entry, never the backlog, so a later healthy sweep is green again;
  // fenceCheckErrors, claimErrors and linkWriteErrors: a withdrawal-fence check, create-claim transaction or recovery-pass link write that THREW (the order is skipped and retried, but the sweep could not decide it)
  'wms-order-push': (r: WmsOrderPushSweepResult) => from(r, counts(r, ['failed', 'deadLettered', 'shadowUnrecorded', 'validationFailed', 'createClaimParked', 'fenceCheckErrors', 'claimErrors', 'linkWriteErrors'])),
  // status enum; counters.errors: number
  'wms-order-reconcile': (r: WmsOrderReconcileResult) => enumResult(r, ['errors']),
  // failed: number; probeFailures: number (a presence probe that threw, apart from the expected unresolved states); pushFailures / pushHeld: whole-batch counts of failed and hold-refused pushes (`errors` is cut at 20 for display, so the mapping reads the counts); errors: string[] (storefront status pushes that failed, held-aware)
  'wms-order-status': (r: WmsOrderStatusSweepResult) => from(r, counts(r, ['failed', 'probeFailures', 'pushFailures']), structural(r)),
  // status: FAILED = breaches nobody could be alerted to
  'wms-watchdog': (r: WmsWatchdogResult): CronOutcomeClass => (r.status === 'FAILED' ? 'failed' : r.status === 'SKIPPED' ? 'skipped' : 'ok'),
  // status: FAILED
  'writers-check': (r: WritersCheckCronResult) => from(r, r.status === 'FAILED' ? 'failed' : null),
  // errors: string[]
  'xero-chart-sync': (r: XeroChartSyncCronResult) => from(r, structural(r)),
  // an alert-only drift check: drift is data, failure is a throw
  'xero-tax-rate-drift': (r: { checked: number; drifted: number } | Skip) => noFailureSignal(r),
  ...warehouseConnectorCronOutcomes,
} satisfies Record<string, (result: never) => CronOutcomeClass>

export type CronOutcomeSlug = keyof typeof cronOutcomes

/** How one route's result ends, by the route's own mapping above. */
export function cronOutcome<K extends CronOutcomeSlug>(slug: K, result: Parameters<(typeof cronOutcomes)[K]>[0]): CronOutcomeClass {
  return (cronOutcomes[slug] as (result: unknown) => CronOutcomeClass)(result)
}
