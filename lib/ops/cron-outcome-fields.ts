import type { CronOutcomeSlug } from './cron-outcomes'
import { mintsoftCronFailureFields as warehouseConnectorCronFailureFields } from '@/lib/connectors/mintsoft/cron-outcome-fields' // wms-connector-boundary-ok: 2026-11-13: the table spreads the connector's own declarations

/**
 * EVERY FAILURE-LIKE FIELD OF EVERY CRON ROUTE'S RESULT, AND WHAT THE ROUTE'S MAPPING DOES WITH IT.
 *
 * tests/ops/cron-outcome-fields.test.ts reads the TypeScript type of each route's result (the parameter of its entry in lib/ops/cron-outcomes.ts),
 * lists every property at any depth whose name looks like a failure (fail, error, dead, conflict, park, unresolved, reject, quarantin, incomplete,
 * orphan, stuck, blocked, refus), and requires each to be declared here, once:
 *
 *  - `consumed`: the mapping turns it into failed (or held). The test PROBES it: a result with only that field set must not map to ok.
 *  - `breakdownOf`: already included in a parent count or list, so counting it again would double-count; the value names the parent (which must be
 *    consumed). The test checks that the field alone does not fail the run.
 *  - `ignored`: not a failure of the run, with the reason. A reason that says "it decides X" names the field the mapping reads instead.
 *
 * A new failure field added to a producer therefore fails CI until it is mapped or justified here. Paths use `.` for a property and `[]` for array items.
 * `probes` gives the other fields a consumed path needs to be set for its probe to mean anything (for example a precondition).
 */
export type CronFieldDeclaration = {
  consumed?: string[]
  breakdownOf?: Record<string, string>
  ignored?: Record<string, string>
  probes?: Record<string, Record<string, unknown>>
}

export const cronFailureFields: Record<CronOutcomeSlug, CronFieldDeclaration> = {
  'account-balance-snapshot': { consumed: ['errors'] },
  'accounting-daily-batch': { consumed: ['errors'] },
  'accounting-fx-revaluation': {
    consumed: ['error', 'refused'],
  },
  'accounting-payment-poll': { consumed: ['errors'] },
  'accounting-payment-reconcile': { consumed: ['errors'] },
  'accounting-sync': {
    consumed: ['failed', 'backReferenceRepair.failed', 'creditNoteAllocationReenqueue.failed', 'landedCostJournalOutbox.failed', 'provisionalPostingRefusals.failed', 'errors'],
    ignored: { provisionalPostingRefusals: 'the replay result as a whole; its failure count is `provisionalPostingRefusals.failed`, which is consumed' },
  },
  'activity-cleanup': {},
  backup: { consumed: ['error', 'uploadError', 'cleanupError'] },
  'delivery-status': { consumed: ['failed'] },
  'email-outbox': {
    consumed: ['failed', 'parked', 'conflicted', 'conflictedWithoutSend', 'unresolvedAfterSend', 'erasureReconcileIncomplete'],
    ignored: { unresolvedWithoutSend: 'the quietest of the four claim-loss counts: nothing was delivered and nothing attributed, so there is no incident (see the field comment in lib/email-outbox.ts)' },
  },
  'fx-rates': {
    consumed: ['failed', 'error', 'pendingWcOrderRetry.failed', 'pendingWcReceiptRetry.queue.failed', 'pendingWcReceiptRetry.queue.error', 'pendingWcReceiptRetry.orphans.failed', 'pendingWcReceiptRetry.orphans.error', 'stepFailures[].error'],
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
  },
  'inventory-snapshot': {},
  'invoice-documents': {
    consumed: ['failed'],
    probes: { failed: { stoppedEarly: 'stopped', stored: 0 } },
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
    consumed: ['orders.errors', 'products.errors', 'products.permanentErrors', 'refundStockCorrections.error', 'stock.queued.errors', 'stock.sync.errors', 'stock.errors'],
    breakdownOf: { 'stock.queued.failed': 'stock.queued.errors' },
    ignored: { 'heldSalesInvoices.stillStuck': 'held sales invoices waiting on the accounting connector; it would keep the run red for as long as accounting is disconnected, and the held-invoice queue has its own exception inbox' },
  },
  'wc-withdrawal-sweep': {
    consumed: ['erasureSweep.errors'],
    ignored: {
      unresolved: 'the route throws when this is above zero (a failed run by the exception path)',
      'dispatchScreen.unresolved': 'the route throws when this is above zero (a failed run by the exception path)',
      'admissionRefusals.stillRefused': 'orders that are still, correctly, refused admission: failing the job on them would make a correct refusal look like a broken cron (see the route)',
      'admissionRefusals.unresolved': 'reported, not thrown, by design: a storefront outage already surfaces through the withdrawal sweep (see the route)',
      admissionRefusals: 'the drain result as a whole; its counts are listed individually',
    },
  },
  'wms-order-push': {
    consumed: ['failed', 'deadLettered'],
    ignored: {
      verifyQuarantined: 'links quarantined by verification: an operator-queue state with its own notice, not a failed run',
      verifyUnresolved: 'links still awaiting a verdict: counted so an unknown is not silent, not a failure',
      validationFailed: 'orders whose payload could not be built locally: documented as NOT a failure (nothing was sent), parked for an operator',
      createClaimParked: 'expired create claims parked because a create may have been dispatched: nothing failed, an operator or the next sweep decides',
      recoveryRefusedPreCutoff: 'a recovery the live-from cut-off refuses by design',
    },
  },
  'wms-order-reconcile': {
    ignored: { 'counters.errors': 'decides `status` (FAILED or PARTIAL when above zero), which the mapping reads' },
  },
  'wms-order-status': { consumed: ['failed', 'errors'] },
  'wms-watchdog': {
    ignored: { deliveryFailures: 'decides `status` (FAILED when a breach could not be alerted), which the mapping reads' },
  },
  'writers-check': {},
  'xero-chart-sync': { consumed: ['errors'] },
  'xero-tax-rate-drift': {},
  ...warehouseConnectorCronFailureFields,
}
