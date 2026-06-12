export type SalesInvoiceUpdateConnectorInfo = {
  id: string
  name: string
} | null

export type SalesInvoiceUpdateQueueParams = {
  salesOrderId: string
  orderNumber: string
  accountingInvoiceId: string
  payload: Record<string, unknown>
  idempotencyKey: string
}

type QueueXeroSync = (params: {
  type: 'SALES_INVOICE_UPDATE'
  referenceType: 'SalesOrder'
  referenceId: string
  payload: Record<string, unknown>
  idempotencyKey: string
}) => Promise<void>

type LogActivity = (params: {
  entityType: 'SALES_ORDER'
  entityId: string
  action: string
  tag: 'accounting'
  level: 'INFO' | 'WARNING'
  description: string
  metadata: Record<string, unknown>
}) => Promise<void>

export type QueueSalesInvoiceUpdateDeps = {
  getActiveAccountingConnectorInfo(): Promise<SalesInvoiceUpdateConnectorInfo>
  isAccountingSyncTypeEnabled(type: 'SALES_INVOICE_UPDATE'): Promise<boolean>
  queueXeroSync: QueueXeroSync
  logActivity: LogActivity
}

export async function queueSalesInvoiceUpdateForExistingAccountingInvoice(
  params: SalesInvoiceUpdateQueueParams,
  deps: QueueSalesInvoiceUpdateDeps,
): Promise<void> {
  const connector = await deps.getActiveAccountingConnectorInfo()
  if (connector?.id !== 'xero') {
    await deps.logActivity({
      entityType: 'SALES_ORDER',
      entityId: params.salesOrderId,
      action: 'sales_invoice_update_skipped_unsupported_connector',
      tag: 'accounting',
      level: 'WARNING',
      description: connector
        ? `Sales invoice update for ${params.orderNumber} was not queued because ${connector.name} invoice updates are not supported yet`
        : `Sales invoice update for ${params.orderNumber} was not queued because no accounting connector is active`,
      metadata: {
        accountingInvoiceId: params.accountingInvoiceId,
        orderNumber: params.orderNumber,
        connector: connector?.id ?? null,
        idempotencyKey: params.idempotencyKey,
      },
    })
    return
  }

  if (!(await deps.isAccountingSyncTypeEnabled('SALES_INVOICE_UPDATE'))) return

  await deps.queueXeroSync({
    type: 'SALES_INVOICE_UPDATE',
    referenceType: 'SalesOrder',
    referenceId: params.salesOrderId,
    payload: params.payload,
    idempotencyKey: params.idempotencyKey,
  })
  await deps.logActivity({
    entityType: 'SALES_ORDER',
    entityId: params.salesOrderId,
    action: 'sales_invoice_update_queued',
    tag: 'accounting',
    level: 'INFO',
    description: `Queued sales invoice update for ${params.orderNumber} against accounting invoice ${params.accountingInvoiceId}`,
    metadata: {
      accountingInvoiceId: params.accountingInvoiceId,
      orderNumber: params.orderNumber,
      idempotencyKey: params.idempotencyKey,
    },
  })
}
