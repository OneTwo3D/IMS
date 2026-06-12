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

export type PurchaseInvoiceUpdateSyncDeps<Tx extends PurchaseInvoiceUpdateSyncTx> = {
  getActiveAccountingConnectorInfo: () => Promise<AccountingConnectorInfo>
  isAccountingSyncTypeEnabled: (type: 'PURCHASE_INVOICE_UPDATE') => Promise<boolean>
  queueAccountingSyncTx: (tx: Tx, params: QueueAccountingSyncTxParams) => Promise<void>
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

  await params.deps.queueAccountingSyncTx(params.tx, {
    type: 'PURCHASE_INVOICE_UPDATE',
    referenceType: 'PurchaseOrder',
    referenceId: params.poId,
    payload: params.accountingPayload,
    idempotencyKey: params.idempotencyKey,
  })
  return 'queued'
}
