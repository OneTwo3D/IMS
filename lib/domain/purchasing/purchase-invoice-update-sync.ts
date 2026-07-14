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
  getActiveAccountingConnectorInfo: () => Promise<AccountingConnectorInfo>
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
  idempotencyKey: string | null
  // 6oyu.4 (khdw): the bill's NET (transit) subtotal before and after this edit, in
  // base currency, so the transit subledger records the signed movement (new − old).
  previousSubtotalBase: number
  newSubtotalBase: number
  deps: PurchaseInvoiceUpdateSyncDeps<Tx>
}): Promise<'queued' | 'skipped-disabled' | 'skipped-no-external-id' | 'skipped-unsupported-connector'> {
  if (!params.accountingInvoiceId || !params.idempotencyKey) return 'skipped-no-external-id'
  if (!params.syncEnabled) return 'skipped-disabled'

  const connector = await params.deps.getActiveAccountingConnectorInfo()
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
