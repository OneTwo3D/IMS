import type { CronOutcomeSlug } from './cron-outcomes'
import { mintsoftCronFailureFields as warehouseConnectorCronFailureFields } from '@/lib/connectors/mintsoft/cron-outcome-fields' // wms-connector-boundary-ok: 2026-11-13: the table spreads the connector's own declarations

/**
 * EVERY FAILURE-LIKE FIELD OF EVERY CRON ROUTE'S RESULT, AND WHAT THE ROUTE'S MAPPING DOES WITH IT.
 *
 * tests/ops/cron-outcome-fields.test.ts reads the TypeScript type of each route's result (the parameter of its entry in lib/ops/cron-outcomes.ts),
 * lists every property at any depth whose name looks like a failure (fail, error, dead, conflict, park, unresolved, reject, quarantin, incomplete,
 * orphan, stuck, blocked, refus, stoppedEarly, aborted, halted, interrupted, truncated, capped), and requires each to be declared here, once:
 *
 *  - `consumed`: the mapping turns it into failed (or held). The test PROBES it: a result with only that field set must not map to ok.
 *  - `breakdownOf`: already included in a parent count or list, so counting it again would double-count; the value names the parent (which must be
 *    consumed). The test checks that the field alone does not fail the run.
 *  - `ignored`: not a failure of the run, with the reason. A reason that says "it decides X" names the field the mapping reads instead.
 *
 * A new failure field added to a producer therefore fails CI until it is mapped or justified here. Paths use `.` for a property and `[]` for array items.
 * `probes` (key `'*'`: every probe, and the busy-run baseline) gives the other fields a consumed path needs to be set for its probe to mean anything (for example a precondition).
 */
export type CronFieldDeclaration = {
  consumed?: string[]
  breakdownOf?: Record<string, string>
  ignored?: Record<string, string>
  probes?: Record<string, Record<string, unknown>>
  /**
   * How this route's result says it skipped by design (`{ skipped: true }`, a status enum, a skip reason). Every consumed field is probed a second
   * time WITH this set: a top-level skip must never mask the failure of a sweep that ran. Omit it for a route that cannot skip.
   */
  skipState?: Record<string, unknown>
}

export const cronFailureFields: Record<CronOutcomeSlug, CronFieldDeclaration> = {
  'account-balance-snapshot': { consumed: ['errors'] },
  'accounting-daily-batch': { consumed: ['errors'], skipState: { skipped: true, reason: 'x' } },
  'accounting-fx-revaluation': {
    skipState: { success: true, skipped: true, reason: 'x' },
    consumed: ['error', 'refused'],
    // `success` is the mapping's own signal: probe each field on a run that otherwise succeeded, or the probe would pass on `success` alone
    probes: { '*': { success: true } },
  },
  'accounting-payment-poll': { consumed: ['errors'], skipState: { skipped: 'x' } },
  'accounting-payment-reconcile': { consumed: ['errors'], skipState: { skipped: true, reason: 'x' } },
  'accounting-sync': {
    skipState: { skipped: true, reason: 'x' },
    consumed: ['failed', 'backReferenceRepair.failed', 'creditNoteAllocationReenqueue.failed', 'landedCostJournalOutbox.failed', 'provisionalPostingRefusals.failed', 'errors'],
    ignored: { provisionalPostingRefusals: 'the replay result as a whole; its failure count is `provisionalPostingRefusals.failed`, which is consumed' },
  },
  'activity-cleanup': {},
  backup: { consumed: ['error', 'uploadError', 'cleanupError'], skipState: { skipped: true, reason: 'x' } },
  'delivery-status': { consumed: ['failed'] },
  'email-outbox': {
    consumed: ['failed', 'parked', 'conflicted', 'conflictedWithoutSend', 'unresolvedAfterSend', 'erasureReconcileIncomplete'],
    ignored: { unresolvedWithoutSend: 'the quietest of the four claim-loss counts: nothing was delivered and nothing attributed, so there is no incident (see the field comment in lib/email-outbox.ts); a row left unresolved is reclaimed by the stale-claim pass, and one that keeps failing reaches `parked`, which is consumed' },
  },
  'fx-rates': {
    consumed: ['failed', 'error', 'pendingWcOrderRetry.failed', 'pendingWcReceiptRetry.queue.failed', 'pendingWcReceiptRetry.queue.error', 'pendingWcReceiptRetry.orphans.failed', 'pendingWcReceiptRetry.orphans.error', 'stepFailures[].error', 'connectorPushFailures', 'pendingWcOrderRetryFailures'],
    breakdownOf: {},
    ignored: {
      'pendingWcReceiptRetry.orphans': 'the sweep result as a whole; its failure count is `pendingWcReceiptRetry.orphans.failed`, which is consumed',
      stepFailures: 'the list whose items are `stepFailures[].error`, which is consumed',
    },
  },
  'hs-classify': { consumed: ['errors'] },
  'invariant-check': {
    consumed: ['errors'],
    probes: { errors: { status: 'completed' } },
    ignored: { 'reports.inventory.truncated': 'only says the inventory report\'s finding list was cut at its cap: the findings are data for the readiness gate, which fails on `truncated` itself and on the `invariant_report_truncated` finding; the check ran to completion (`status`), and a run that did not is read from `status`' },
  },
  'inventory-snapshot': {
    ignored: {
      driftCount: 'value drift between the day\'s snapshot and the ledger is reported as data (it is the run\'s status reason `inventory_snapshot_value_drift:N`) and is what the invariant check monitors; the snapshot itself was written',
      driftTruncated: 'only says the drift list was cut at its cap; `driftCount` is the finding',
      drift: 'the list behind `driftCount`: findings reported as data for the invariant check, not a failed snapshot',
    },
  },
  'invoice-documents': {
    consumed: ['failed', 'stoppedEarly'],
    probes: { failed: { stoppedEarly: null, stored: 0 } },
  },
  'product-lifecycle-archive': {},
  'read-sync-liveness': {
    ignored: { deliveryFailures: 'decides `status` (FAILED when a breach could not be alerted), which the mapping reads' },
  },
  'recompute-product-lead-times': { consumed: ['failed'] },
  'reconciliation-pack': {},
  'reallocation-sweep': {
    consumed: ['errors', 'directCreateMarkers.errors', 'failures'],
    probes: { failures: { ok: false } },
  },
  'refund-reservation-release': { consumed: ['release.failed', 'unmatchedWarnings.failed'] },
  'shopping-webhook-inbox': {
    consumed: [
      'connectors.woocommerce.failed',
      'connectors.woocommerce.deadLettered',
      'connectors.woocommerce.error',
      'connectors.woocommerce.orderCompletions.deadLettered',
      'connectors.woocommerce.orderCompletions.errors',
      'connectors.woocommerce.orderCompletions.error',
      'connectors.woocommerce.orderStatusPushes.deadLettered',
      'connectors.woocommerce.orderStatusPushes.errors',
      'connectors.woocommerce.orderStatusPushes.error',
      'connectors.woocommerce.invoiceDocumentPublications.deadLettered',
      'connectors.woocommerce.invoiceDocumentPublications.errors',
      'connectors.woocommerce.invoiceDocumentPublications.error',
    ],
  },
  'wc-reconcile': {
    skipState: { skipped: true, reason: 'x' },
    consumed: ['orders.errors', 'products.errors', 'products.permanentErrors', 'refundStockCorrections.error', 'stock.queued.errors', 'stock.sync.errors', 'stock.errors'],
    breakdownOf: { 'stock.queued.failed': 'stock.queued.errors' },
    ignored: { 'stock.sync.aborted': 'a stock push refused before any work (the setting is off, no credentials or warehouses, or the outbound-write hold): the route reports it as a skip (`reconciliation_refused`) that leaves the pass due, by design; a push that failed in flight carries `stock.sync.errors`, which is consumed', 'heldSalesInvoices.stillStuck': 'held sales invoices waiting on the accounting connector: each pass logs the stuck invoices as an activity warning, and counting them would keep the run red for as long as accounting is disconnected' },
  },
  'wc-withdrawal-sweep': {
    consumed: ['erasureSweep.errors', 'admissionRefusals.failed'],
    skipState: { skipped: true, reason: 'x' },
    ignored: {
      unresolved: 'the route throws when this is above zero (a failed run by the exception path)',
      'dispatchScreen.unresolved': 'the route throws when this is above zero (a failed run by the exception path)',
      'admissionRefusals.stillRefused': 'orders that are still, correctly, refused admission: failing the job on them would make a correct refusal look like a broken cron (see the route)',
      'admissionRefusals.unresolved': 'expected states only (the order is gone from the store, the first-import lock was busy, the withdrawal screen could not decide yet): asked again next sweep, no operator action; read and import failures are counted in `admissionRefusals.failed`, which is consumed',
      admissionRefusals: 'the drain result as a whole; its counts are listed individually',
    },
  },
  'wms-order-push': {
    skipState: { skipped: 'x' },
    consumed: ['failed', 'deadLettered', 'shadowUnrecorded', 'validationFailed', 'createClaimParked', 'fenceCheckErrors', 'claimErrors', 'linkWriteErrors'],
    ignored: {
      verifyQuarantined: 'links quarantined by verification: each is also counted in `deadLettered` (consumed) and audited as a FAILED order create, so the run already reads failed',
      verifyUnresolved: 'links still awaiting a verdict: counted so an unknown is not silent, not a failure',
      recoveryRefusedPreCutoff: 'a recovery the live-from cut-off refuses by design',
    },
  },
  'wms-order-reconcile': {
    ignored: { 'counters.errors': 'decides `status` (FAILED or PARTIAL when above zero), which the mapping reads' },
  },
  'wms-order-status': { consumed: ['failed', 'errors', 'probeFailures', 'pushFailures'], skipState: { skipped: 'x' } },
  'wms-watchdog': {
    ignored: {
      deliveryFailures: 'decides `status` (FAILED when a breach could not be alerted), which the mapping reads',
      staleBindingAlerts: 'the number of stale-sync alerts that WERE raised and delivered; an alert that could not be delivered is `deliveryFailures`, which decides `status`',
    },
  },
  'writers-check': {},
  'xero-chart-sync': { consumed: ['errors'], skipState: { skipped: true, reason: 'x' } },
  'xero-tax-rate-drift': {
    ignored: { drifted: 'an alert-only check: each drifted rate is logged as an operator WARNING and that is the whole job; a failed check is a throw' },
  },
  ...warehouseConnectorCronFailureFields,
}
