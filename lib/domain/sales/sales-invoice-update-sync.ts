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
  /**
   * o3d-j625 — THE CONNECTOR WHOSE CHART THE ACCOUNT CODES IN `payload` CAME FROM.
   *
   * This module resolves the active connector itself and then hands the payload to `queueXeroSync`.
   * The payload was built by the caller from ONE read of `getAccountingSettings()`, which resolves the
   * active connector internally, so without this the two resolutions are independent: with QuickBooks
   * active the caller composes an update carrying QuickBooks `salesAccount` / `shippingAccount` /
   * `discountAccount`, a switch to Xero commits, and this queues that document as a XERO invoice
   * update. Xero then either rejects it or posts the order's revenue to whatever those codes happen to
   * name in its own chart.
   *
   * Checked before anything else below, so a mismatch is reported as a mismatch rather than as
   * "QuickBooks updates are not supported yet", which would be a true sentence about the wrong fact.
   */
  chartConnector: 'xero' | 'quickbooks' | null
  /**
   * o3d-j625 r3 (Codex HIGH 2) — WHICH CONNECTOR'S INVOICE `accountingInvoiceId` IS.
   *
   * SALES_INVOICE_UPDATE posts to `/Invoices/{accountingInvoiceId}`, so the id IS the target document.
   * It is retained across a connector switch by design — the invoice it names still exists in the ledger
   * it was posted to — which means `chartConnector` above, which proves only where the account CODES came
   * from, says nothing about it. After a switch both halves of the chart check can agree (the codes really
   * are the active connector's) while this update would rewrite a document the active connector does not
   * hold, or, worse, one of its own that happens to carry the same id.
   *
   * `null` = the link predates `SalesOrder.accountingInvoiceConnector`. FAIL CLOSED: refused and reported,
   * never resolved to the active connector.
   */
  documentConnector: 'xero' | 'quickbooks' | null
}

type QueueXeroSync = (params: {
  type: 'SALES_INVOICE_UPDATE'
  referenceType: 'SalesOrder'
  referenceId: string
  payload: Record<string, unknown>
  idempotencyKey: string
  // o3d-2sm1 r7: the real `queueXeroSync` now reports what it did, and `unknown` is what this
  // injection point needs — it does not read the answer, and widening it to the outcome type here
  // would make this module import the accounting facade's contract for no purpose.
}) => Promise<unknown>

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
  // o3d-j625: the codes and the row must come out of ONE resolution. Nothing is written when they do
  // not, and the posting stays outstanding — a sales-invoice update is re-derivable from the order, so
  // refusing costs a re-queue and writing the wrong one costs a wrong document in a live ledger.
  if (params.chartConnector !== (connector?.id ?? null)) {
    await deps.logActivity({
      entityType: 'SALES_ORDER',
      entityId: params.salesOrderId,
      action: 'sales_invoice_update_refused_retired_chart',
      tag: 'accounting',
      level: 'WARNING',
      description:
        `NOTHING WAS QUEUED. The sales invoice update for ${params.orderNumber} was built from `
        + `${params.chartConnector ?? 'no'} connector's chart of accounts, and the active accounting `
        + `connector is now ${connector?.id ?? 'none'}, so its account codes do not describe the ledger `
        + 'it would have been written to. The update is still OUTSTANDING: re-save the order once the '
        + 'accounting connector selection has settled.',
      metadata: {
        accountingInvoiceId: params.accountingInvoiceId,
        orderNumber: params.orderNumber,
        chartConnector: params.chartConnector,
        connector: connector?.id ?? null,
        idempotencyKey: params.idempotencyKey,
      },
    })
    return
  }
  // o3d-j625 r3 (Codex HIGH 2) — AND THE DOCUMENT ID MUST BE THIS CONNECTOR'S TOO.
  //
  // Asked immediately after the chart check and before the Xero-only gate, for the same reason the chart
  // check is asked first: reporting this as "QuickBooks updates are not supported yet" would be a true
  // sentence about the wrong fact.
  if (params.documentConnector !== (connector?.id ?? null)) {
    await deps.logActivity({
      entityType: 'SALES_ORDER',
      entityId: params.salesOrderId,
      action: 'sales_invoice_update_refused_unattributable_document',
      tag: 'accounting',
      level: 'WARNING',
      description:
        `NOTHING WAS QUEUED. The sales invoice update for ${params.orderNumber} would be posted against `
        + `accounting invoice ${params.accountingInvoiceId}, which IMS records as `
        + `${params.documentConnector ?? 'no connector (the link predates the column that records it)'} `
        + `while the active accounting connector is ${connector?.id ?? 'none'}. An accounting invoice id is `
        + 'a document id in the accounting system\'s own database and IMS keeps it when the connector '
        + 'selection changes, so it must not be assumed to belong to whichever connector is active now — '
        + 'the update would rewrite a document this connector does not hold. The update is still '
        + 'OUTSTANDING: re-post the invoice from this order so the document and its connector are recorded '
        + 'together, or correct the invoice by hand in the books that hold it.',
      metadata: {
        accountingInvoiceId: params.accountingInvoiceId,
        orderNumber: params.orderNumber,
        documentConnector: params.documentConnector,
        chartConnector: params.chartConnector,
        connector: connector?.id ?? null,
        idempotencyKey: params.idempotencyKey,
      },
    })
    return
  }
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
