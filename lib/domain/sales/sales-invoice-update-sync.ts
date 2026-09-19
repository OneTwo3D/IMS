import { accountingPostingKey } from '@/lib/accounting/posting-key'

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

/**
 * o3d-j625 r4 (Codex HIGH 4) — THE ACCOUNTING FACADE, NOT `queueXeroSync`.
 *
 * This module used to call the Xero queue directly, ignore what it answered, and log
 * `sales_invoice_update_queued` unconditionally. `queueXeroSync` declines for reasons that have nothing
 * to do with this module's own checks — an unresolved prior attempt, a deleted order, a stale discount,
 * a posting mode switched off, a connector transition under the write — and every one of them left the
 * local sale updated, the ledger stale, and an INFO record saying the update was queued. It also bypassed
 * both facade guards (chart and document provenance), and the r3 consumption census, which only
 * recognised `queueAccountingSync*`.
 *
 * Routed through the facade, the row gets the chart guard, the document-id guard and the connector
 * queue's own verdicts, and this module gets the WHOLE answer back to act on.
 */
type QueueAccountingSync = (params: {
  type: 'SALES_INVOICE_UPDATE'
  referenceType: 'SalesOrder'
  referenceId: string
  payload: Record<string, unknown>
  idempotencyKey: string
  chartConnector: 'xero' | 'quickbooks' | null
  documentConnector: 'xero' | 'quickbooks' | null
}) => Promise<{ queued: boolean; reason?: 'not-configured' | 'refused' | 'already-queued' | 'handled-by-hand'; connector: string | null }>

type LogActivity = (params: {
  entityType: 'SALES_ORDER'
  entityId: string
  action: string
  tag: 'accounting'
  level: 'INFO' | 'WARNING' | 'ERROR'
  description: string
  metadata: Record<string, unknown>
}) => Promise<void>

export type QueueSalesInvoiceUpdateDeps = {
  /** Read ONCE, and only to COMPARE with the chart and the document — never to route. */
  getActiveAccountingConnectorInfo(): Promise<SalesInvoiceUpdateConnectorInfo>
  /**
   * o3d-j625 r4: `isAccountingSyncTypeEnabled` is GONE from this seam. It resolved the active connector a
   * second time and its `false` silently returned; "is this type posted" is now the facade's
   * `not-configured` answer, given for the chart's own connector.
   */
  queueAccountingSync: QueueAccountingSync
  logActivity: LogActivity
  /**
   * o3d-j625 r4 — the refusal, as OUTSTANDING work in the exception inbox rather than a log line an
   * operator has to already be reading. Injected like everything else this module uses.
   */
  recordPostingRefusal: (record: {
    /** o3d-j625 r5/r6: the key THIS module's enqueue uses — derived here from the enqueue's own identity. */
    /** o3d-j625 r6 (review H4): the kind of this site's refusal row — re-saving the order raises it again. */
    kind: 'sales_invoice_update'
    posting: { type: string; referenceType: string; referenceId: string; scope: string }
    chartConnector: string | null
    activeConnector: string | null
    reason: string
    committed: string
    remedy: string
    detail?: Record<string, unknown>
  }) => Promise<void>
}

export async function queueSalesInvoiceUpdateForExistingAccountingInvoice(
  params: SalesInvoiceUpdateQueueParams,
  deps: QueueSalesInvoiceUpdateDeps,
): Promise<void> {
  // o3d-j625 r6 (review M1) — THE ENQUEUE'S IDENTITY, ONCE, AND THE KEY DERIVED FROM IT HERE. r5 had the
  // caller build `posting` from its own re-typed copy of these fields and pass it in, which is the shape the
  // review mutated: a caller could name a different posting than the one this module enqueues and nothing
  // would notice. The refusal row, the enqueue and (through the facade) the clear now read one object.
  const identity = {
    type: 'SALES_INVOICE_UPDATE' as const,
    referenceType: 'SalesOrder' as const,
    referenceId: params.salesOrderId,
    payload: params.payload,
    idempotencyKey: params.idempotencyKey,
  }
  const posting = accountingPostingKey(identity)
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
    await deps.recordPostingRefusal({
      kind: 'sales_invoice_update',
      posting,
      chartConnector: params.chartConnector,
      activeConnector: connector?.id ?? null,
      reason: 'retired_chart',
      committed: `the order ${params.orderNumber} is updated in IMS`,
      remedy:
        'Re-save the order once the accounting connector selection has settled, or correct the invoice by hand '
        + 'in the books its account codes belong to and mark this row handled — that stops IMS updating it too.',
      detail: { accountingInvoiceId: params.accountingInvoiceId, documentConnector: params.documentConnector },
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
    await deps.recordPostingRefusal({
      kind: 'sales_invoice_update',
      posting,
      chartConnector: params.chartConnector,
      activeConnector: connector?.id ?? null,
      reason: 'unattributable_document_id',
      committed: `the order ${params.orderNumber} is updated in IMS`,
      remedy:
        // o3d-j625 r7 (review H-A): r5 said "re-post the invoice from this order", which IMS does not offer.
        'IMS cannot show which accounting connector holds this invoice, so it will not update it. Correct the '
        + 'invoice by hand in the ledger that holds it, then mark this row handled — that stops IMS updating it too.',
      detail: { accountingInvoiceId: params.accountingInvoiceId, documentConnector: params.documentConnector },
    })
    return
  }
  // o3d-j625 r4: keyed on the CHART's connector, which the checks above have just shown to be the active
  // one — not on a value re-read for the purpose.
  if (params.chartConnector !== 'xero') {
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

  const enqueued = await deps.queueAccountingSync({
    ...identity,
    chartConnector: params.chartConnector,
    documentConnector: params.documentConnector,
  })

  // o3d-j625 r4 (Codex HIGH 4) — THE ANSWER DECIDES WHAT IS RECORDED.
  if (!enqueued.queued && enqueued.reason === 'not-configured') {
    // The chart's connector does not post invoice updates. What `isAccountingSyncTypeEnabled === false`
    // used to mean here, and it stays silent for the same reason: nothing will ever post, nothing is owed.
    return
  }
  if (!enqueued.queued) {
    await deps.logActivity({
      entityType: 'SALES_ORDER',
      entityId: params.salesOrderId,
      action: 'sales_invoice_update_not_queued',
      tag: 'accounting',
      level: 'ERROR',
      description:
        `NOTHING WAS QUEUED for the sales invoice update for ${params.orderNumber}, but the order is updated in `
        + `IMS. The accounting queue REFUSED it (an unresolved earlier attempt, a deleted order, a stale discount, `
        + `or an accounting connector change under the write — see the accounting activity log), so accounting `
        + `invoice ${params.accountingInvoiceId} still shows the PREVIOUS version and nothing retries this on its `
        + 'own. Re-save the order once the cause is resolved, or correct the invoice by hand in the ledger.',
      metadata: {
        accountingInvoiceId: params.accountingInvoiceId,
        orderNumber: params.orderNumber,
        idempotencyKey: params.idempotencyKey,
        enqueueReason: enqueued.reason ?? null,
        enqueueConnector: enqueued.connector,
      },
    })
    await deps.recordPostingRefusal({
      kind: 'sales_invoice_update',
      posting,
      chartConnector: params.chartConnector,
      activeConnector: connector?.id ?? null,
      reason: 'enqueue_refused',
      committed: `the order ${params.orderNumber} is updated in IMS`,
      remedy:
        'Re-save the order once the cause is resolved (see the accounting activity log), or correct the '
        + 'invoice by hand in the ledger and mark this row handled — that stops IMS updating it too.',
      detail: { accountingInvoiceId: params.accountingInvoiceId, documentConnector: params.documentConnector, enqueueReason: enqueued.reason ?? null },
    })
    return
  }
  await deps.logActivity({
    entityType: 'SALES_ORDER',
    entityId: params.salesOrderId,
    action: 'sales_invoice_update_queued',
    tag: 'accounting',
    level: 'INFO',
    description: enqueued.reason === 'already-queued'
      ? `Sales invoice update for ${params.orderNumber} against accounting invoice ${params.accountingInvoiceId} was already queued`
      : `Queued sales invoice update for ${params.orderNumber} against accounting invoice ${params.accountingInvoiceId}`,
    metadata: {
      accountingInvoiceId: params.accountingInvoiceId,
      orderNumber: params.orderNumber,
      idempotencyKey: params.idempotencyKey,
      alreadyQueued: enqueued.reason === 'already-queued',
    },
  })
}
