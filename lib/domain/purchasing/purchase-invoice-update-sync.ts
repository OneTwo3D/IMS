import type { PurchaseInvoiceAccountingPayload } from '@/lib/domain/purchasing/purchase-invoice-edit'

type AccountingConnectorInfo = {
  id: string
  name: string
} | null

type PurchaseInvoiceUpdateSyncTx = {
  activityLog: {
    create: (input: {
      data: {
        entityType: 'PURCHASE_ORDER'
        entityId: string
        action: 'purchase_invoice_update_skipped_unsupported_connector'
        tag: 'accounting'
        level: 'WARNING'
        description: string
        metadata: {
          invoiceId: string
          accountingInvoiceId: string
          connector: string | null
          idempotencyKey: string
        }
      }
    }) => Promise<unknown>
  }
}

type QueueAccountingSyncTxParams = {
  type: 'PURCHASE_INVOICE_UPDATE'
  referenceType: 'PurchaseOrder'
  referenceId: string
  payload: Record<string, unknown>
  idempotencyKey: string
  /**
   * o3d-j625 r2 — THE CONNECTOR WHOSE CHART `payload` WAS BUILT FROM. Required, mirroring
   * `queueAccountingSyncTx`'s own declaration: this local type is what the injected enqueue is checked
   * against, so leaving it optional here would let the real required parameter be satisfied by a
   * `undefined` that type-checks at the injection site.
   */
  chartConnector: 'xero' | 'quickbooks' | null
  /**
   * o3d-j625 r3 (Codex HIGH 2) — WHOSE BILL `payload.accountingInvoiceId` IS. Declared here for the
   * same reason `chartConnector` is: this local type is what the injected enqueue is checked against,
   * so omitting it would let the real parameter be satisfied by an `undefined` that type-checks.
   */
  documentConnector: 'xero' | 'quickbooks' | null
}

// 6oyu.4 (khdw): a bill edit reposts to Xero, changing the NET (transit) leg from the
// old subtotal to the new one — the transit subledger must record the signed delta.
type TransitSubledgerUpdateInput = {
  sourceType: 'PURCHASE_BILL_UPDATE'
  sourceRef: string
  idempotencyKey: string
  baseDelta: number
  journalDate: string
}

/** o3d-j625 r4: the shape of `accountingPostingVerdictForChart`'s answer, restated so this module stays injectable. */
export type PurchaseInvoiceUpdatePostingVerdict =
  | { verdict: 'post'; connector: 'xero' | 'quickbooks' }
  | { verdict: 'not-configured'; connector: 'xero' | 'quickbooks' }
  | { verdict: 'chart-retired'; chartConnector: 'xero' | 'quickbooks'; activeConnector: 'xero' | 'quickbooks' | null }
  | { verdict: 'no-chart' }

export type PurchaseInvoiceUpdateSyncDeps<Tx extends PurchaseInvoiceUpdateSyncTx> = {
  /**
   * o3d-j625 r4 (Codex HIGH 3) — REPLACES `isAccountingSyncTypeEnabled`, WHICH RESOLVED THE ACTIVE
   * CONNECTOR A SECOND TIME. That boolean's `false` meant both "posting is switched off" and "the chart
   * this edit was built from belongs to a connector that is no longer active", and this function returned
   * `skipped-disabled` for both — an informational outcome — before the enqueue's chart guard could ever
   * refuse. The verdict is asked OF THE CHART'S CONNECTOR, and a retired chart is a refusal.
   */
  postingVerdictForChart: (
    chartConnector: 'xero' | 'quickbooks' | null,
    type: 'PURCHASE_INVOICE_UPDATE',
  ) => Promise<PurchaseInvoiceUpdatePostingVerdict>
  queueAccountingSyncTx: (tx: Tx, params: QueueAccountingSyncTxParams) => Promise<boolean>
  recordTransitSubledgerMovement: (tx: Tx, input: TransitSubledgerUpdateInput) => Promise<void>
}

/**
 * WHAT HAPPENED TO THE BILL EDIT'S LEDGER UPDATE.
 *
 * The two refusals are OWED postings and a caller must surface them; the three skips are informational.
 * o3d-j625 r4 split `refused-chart-retired` out of what was `skipped-disabled`: "the connector this edit
 * was built for is no longer the active one" is not "posting is switched off", and collapsing the two
 * made a connector switch read as a setting.
 *
 *   queued                     the update row is durable.
 *   refused                    the enqueue itself declined (its chart/document guard, or a posting
 *                              context that changed under the write).
 *   refused-chart-retired      the chart's connector is no longer active — detected before enqueueing.
 *   skipped-disabled           the chart's connector is active and does not post bill updates.
 *   skipped-no-external-id     the bill never reached a ledger.
 *   skipped-unsupported-connector  the chart's connector has no bill-update poster (QuickBooks).
 */
export type PurchaseInvoiceUpdateOutcome =
  | 'queued'
  | 'refused'
  | 'refused-chart-retired'
  | 'skipped-disabled'
  | 'skipped-no-external-id'
  | 'skipped-unsupported-connector'

/** The outcomes that leave a ledger update OWED. */
export function purchaseInvoiceUpdateIsOwed(outcome: PurchaseInvoiceUpdateOutcome): boolean {
  return outcome === 'refused' || outcome === 'refused-chart-retired'
}

export async function maybeQueuePurchaseInvoiceUpdate<Tx extends PurchaseInvoiceUpdateSyncTx>(params: {
  tx: Tx
  syncEnabled: boolean
  invoiceId: string
  poId: string
  poReference: string
  accountingInvoiceId: string | null
  accountingPayload: PurchaseInvoiceAccountingPayload
  /**
   * o3d-j625 r2 (Codex HIGH 1) — THE CONNECTOR THE CALLER'S CHART READ RESOLVED, PASSED IN RATHER THAN
   * RESOLVED AGAIN HERE.
   *
   * `accountingPayload` is built by the caller from ITS `getAccountingSettings()` read —
   * `transitAccount` on every line, `reverseChargePurchaseTaxType` on the tax code. This function used
   * to call `getActiveAccountingConnectorInfo()` for its Xero-only gate, and the enqueue then resolved
   * the connector a THIRD time, so "the payload's codes", "the gate's verdict" and "the row's
   * connector" were three independent answers to one question with a full bill recalculation and a
   * line-by-line update between them. There is one answer now and it comes from the caller.
   */
  chartConnector: 'xero' | 'quickbooks' | null
  /**
   * o3d-j625 r3 (Codex HIGH 2) — WHICH CONNECTOR'S BILL `accountingPayload.accountingInvoiceId` NAMES.
   *
   * A PURCHASE_INVOICE_UPDATE posts to `/Invoices/{accountingInvoiceId}`, so the id IS the target. It
   * is retained across a connector switch, so `chartConnector` — which proves only where the transit
   * account code came from — cannot speak for it. `null` means the link predates the provenance column
   * and the enqueue refuses rather than assuming the active connector.
   */
  documentConnector: 'xero' | 'quickbooks' | null
  idempotencyKey: string | null
  // 6oyu.4 (khdw): the bill's NET (transit) subtotal before and after this edit, in
  // base currency, so the transit subledger records the signed movement (new − old).
  previousSubtotalBase: number
  newSubtotalBase: number
  deps: PurchaseInvoiceUpdateSyncDeps<Tx>
}): Promise<PurchaseInvoiceUpdateOutcome> {
  if (!params.accountingInvoiceId || !params.idempotencyKey) return 'skipped-no-external-id'
  if (!params.syncEnabled) return 'skipped-disabled'

  // o3d-j625 r2: the CALLER's chart connector, not a fresh resolution. The name is derived from the id
  // rather than read off a second lookup for the same reason.
  const connector: AccountingConnectorInfo = params.chartConnector
    ? { id: params.chartConnector, name: params.chartConnector === 'xero' ? 'Xero' : 'QuickBooks' }
    : null
  if (connector?.id !== 'xero') {
    await params.tx.activityLog.create({
      data: {
        entityType: 'PURCHASE_ORDER',
        entityId: params.poId,
        action: 'purchase_invoice_update_skipped_unsupported_connector',
        tag: 'accounting',
        level: 'WARNING',
        description: connector
          ? `Purchase bill update for ${params.poReference} was not queued because ${connector.name} bill updates are not supported yet`
          : `Purchase bill update for ${params.poReference} was not queued because no accounting connector is active`,
        metadata: {
          invoiceId: params.invoiceId,
          accountingInvoiceId: params.accountingInvoiceId,
          connector: connector?.id ?? null,
          idempotencyKey: params.idempotencyKey,
        },
      },
    })
    return 'skipped-unsupported-connector'
  }

  // o3d-j625 r4 (Codex HIGH 3): asked OF THE CHART, and a retired chart is a refusal, not a skip.
  const verdict = await params.deps.postingVerdictForChart(params.chartConnector, 'PURCHASE_INVOICE_UPDATE')
  if (verdict.verdict === 'chart-retired') return 'refused-chart-retired'
  if (verdict.verdict !== 'post') return 'skipped-disabled'

  const queued = await params.deps.queueAccountingSyncTx(params.tx, {
    type: 'PURCHASE_INVOICE_UPDATE',
    referenceType: 'PurchaseOrder',
    referenceId: params.poId,
    payload: params.accountingPayload,
    idempotencyKey: params.idempotencyKey,
    // o3d-j625 r2: the same connector the gate above just required to be Xero, and the one the caller
    // read the transit account and tax-type code from. One resolution, carried to the write.
    chartConnector: params.chartConnector,
    // o3d-j625 r3 (Codex HIGH 2): and whose bill the payload's `accountingInvoiceId` is.
    documentConnector: params.documentConnector,
  })
  // 6oyu.4 (khdw): the Xero update REPLACES the bill, so the transit GL debit moves
  // from the old net subtotal to the new one — record the signed delta (new − old).
  // Keyed by the update's own idempotency key (a content hash, unique per edit), so a
  // retried identical edit records once; a zero-delta edit (e.g. only the invoice
  // number changed) is skipped by the recorder. The journal posts on the bill date.
  // Record on the queue's OWN decision (bcz9.4): only when it actually queued, so a
  // disabled type can't write a subledger row with no GL counterpart.
  if (queued) {
    await params.deps.recordTransitSubledgerMovement(params.tx, {
      sourceType: 'PURCHASE_BILL_UPDATE',
      sourceRef: params.poId,
      idempotencyKey: params.idempotencyKey,
      baseDelta: params.newSubtotalBase - params.previousSubtotalBase,
      journalDate: String(params.accountingPayload.date),
    })
  }
  // o3d-j625 r3 (Codex HIGH 1 family) — AND THE ANSWER IS THE QUEUE'S, NOT A CONSTANT.
  //
  // This returned `'queued'` unconditionally, having just branched on `queued` one statement earlier to
  // decide whether a subledger row was safe to write. So the subledger was right and the CALLER was
  // told the posting had been queued when the enqueue had declined it — and the caller's activity log
  // then recorded `queuedAccountingUpdate` from a boolean derived from the bill's own columns, which
  // consults the enqueue not at all. Reporting a decline as a queue is how an edit that never reached
  // the ledger leaves no trace anywhere.
  //
  // `'refused'` covers both shapes of decline the boolean can carry — the posting context changed under
  // the write, or the chart/document provenance was refused — because the caller's action is the same
  // for both: say so, loudly, and leave the bill edit standing (rolling a local edit back because the
  // connector selection moved would make a retired chart block bill editing entirely).
  return queued ? 'queued' : 'refused'
}
