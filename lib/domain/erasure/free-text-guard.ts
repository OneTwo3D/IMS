/**
 * THE FREE-TEXT COLUMNS GUARDED IN THE DATABASE FOR ERASED ORDERS (migration erased_order_free_text_guard).
 *
 * A trigger on each table below replaces these columns with the fixed erasure marker (JSON: `{}`) on any insert or update of a row whose
 * order, or whose order's customer, is erased. So no writer, present or future, can put exception text or a note that echoes the person into
 * them afterwards, including an outer `catch` that runs without the order lock. tests/erasure-free-text-guard-census.test.ts pins this list
 * to the classification (an `erased` free-text column on an order-linked table must be guarded here or be listed there as unguarded, with a
 * reason) and the Postgres test proves every entry fires.
 *
 * The erasure itself clears the existing values once; `reconcileErasedFreeText` clears a value inserted while an erasure was still uncommitted
 * (the one case a trigger cannot see).
 */
export type GuardedFreeText = {
  model: string
  table: string
  orderIdColumn: string
  columns: readonly string[]
  jsonColumns?: readonly string[]
  /** Field name -> database column name, where the model maps the column to a different name. */
  dbNames?: Readonly<Record<string, string>>
}

export function sqlColumn(g: GuardedFreeText, field: string): string {
  return g.dbNames?.[field] ?? field
}

export const GUARDED_FREE_TEXT: readonly GuardedFreeText[] = [
  { model: 'WmsOrderStatusSnapshot', table: 'wms_order_status_snapshots', orderIdColumn: 'orderId', columns: ['lastError'] },
  { model: 'WmsOrderPushLink', table: 'wms_order_push_links', orderIdColumn: 'orderId', columns: ['lastError', 'dispatchLastError', 'dispatchUnresolvedError'] },
  { model: 'WmsOrderDiscrepancy', table: 'wms_order_discrepancies', orderIdColumn: 'orderId', columns: ['detail'] },
  { model: 'WmsReturnsInbox', table: 'wms_returns_inbox', orderIdColumn: 'orderId', columns: ['reason', 'resolutionNote'], jsonColumns: ['rawPayload'] },
  { model: 'SalesOrderRefund', table: 'sales_order_refunds', orderIdColumn: 'orderId', columns: ['accountingWarning'], dbNames: { accountingWarning: 'accounting_warning' } },
]

/**
 * `erased` free-text columns on order-linked tables that are deliberately NOT guarded by a trigger, with the reason. Payment.notes has its own
 * guard (it keeps the importer's exact sentences). The rest are written only by the system, or are cleared by the erasure and not rewritten.
 */
export const UNGUARDED_FREE_TEXT: Readonly<Record<string, string>> = {
  'EmailOutbox.lastError': 'guarded in the drain (recipient refusal and invalid-recipient write under the order lock) and cleared by the reconcile pass',
  'StockMovement.note': 'system-written at shipment with the order reference only; cleared by the erasure',
  'Payment.notes': 'has its own trigger (erased_order_payment_note_guard), which keeps the importer\'s exact sentences',
  'Customer.notes': 'every customer write is a conditional update that refuses an anonymised customer',
  'SalesOrder.notes': 'updateSalesOrderNotes refuses an erased order under the order lock; the storefront importer withholds identity columns from an erased order',
  'SalesOrder.internalNotes': 'updateSalesOrderNotes refuses an erased order under the order lock',
  'Notification.message': 'guarded by trigger notifications_erased_order_text (migration erasure_derived_copies), which keys on the order id in the action url; the erasure replaces the text of the rows that already exist',
  'EmailSuppression.reason': 'deleted by the erasure; the drain writes none for an erased order (the invalid-recipient write is made under the order lock)',
  'WmsMutationEvent.before': 'audit JSON written with the decision made under the order lock (returns sync); cleared by the erasure',
  'WmsMutationEvent.after': 'audit JSON written with the decision made under the order lock (returns sync); cleared by the erasure',
  'ShoppingWebhookEvent.lastError': 'guarded by the raw-payload trigger (erased_wc_webhook_event_guard, migration erasure_raw_payload_projection), which keys on the storefront order id inside the payload, not on an order column',
  'ShoppingSyncLog.payload': 'guarded by the raw-payload trigger (erased_wc_sync_log_guard), which projects the payload by its shape',
  'ShoppingSyncLog.errorMessage': 'guarded by the raw-payload trigger (erased_wc_sync_log_guard)',
  'AccountingSyncLog.errorMessage': 'guarded by trigger accounting_sync_logs_erased_error (migration erasure_derived_copies), which keys on referenceType and referenceId, not on an order column',
  'AccountingSyncLog.payload': 'the contact block is replaced by the erasure and by the central accounting-row gate (createAccountingSyncLogRow) and the posting gate; financial fields are kept',
  'AccountingEventLog.metadata': 'the superseded body is guarded by trigger accounting_event_logs_erased_contact (migration erasure_derived_copies)',
  'WmsSyncLog.payload': 'the returns sync no longer writes the raw warehouse record here (only the return id); rows written before that are cleared by the erasure (raw-payloads.ts)',
}
