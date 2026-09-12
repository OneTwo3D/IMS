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

export type PurchaseInvoiceUpdateSyncDeps<Tx extends PurchaseInvoiceUpdateSyncTx> = {
  isAccountingSyncTypeEnabled: (type: 'PURCHASE_INVOICE_UPDATE') => Promise<boolean>
  queueAccountingSyncTx: (tx: Tx, params: QueueAccountingSyncTxParams) => Promise<boolean>
  recordTransitSubledgerMovement: (tx: Tx, input: TransitSubledgerUpdateInput) => Promise<void>
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
  idempotencyKey: string | null
  // 6oyu.4 (khdw): the bill's NET (transit) subtotal before and after this edit, in
  // base currency, so the transit subledger records the signed movement (new − old).
  previousSubtotalBase: number
  newSubtotalBase: number
  deps: PurchaseInvoiceUpdateSyncDeps<Tx>
}): Promise<'queued' | 'skipped-disabled' | 'skipped-no-external-id' | 'skipped-unsupported-connector'> {
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

  if (!await params.deps.isAccountingSyncTypeEnabled('PURCHASE_INVOICE_UPDATE')) {
    return 'skipped-disabled'
  }

  const queued = await params.deps.queueAccountingSyncTx(params.tx, {
    type: 'PURCHASE_INVOICE_UPDATE',
    referenceType: 'PurchaseOrder',
    referenceId: params.poId,
    payload: params.accountingPayload,
    idempotencyKey: params.idempotencyKey,
    // o3d-j625 r2: the same connector the gate above just required to be Xero, and the one the caller
    // read the transit account and tax-type code from. One resolution, carried to the write.
    chartConnector: params.chartConnector,
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
  return 'queued'
}
