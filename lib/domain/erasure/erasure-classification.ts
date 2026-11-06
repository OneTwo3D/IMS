/**
 * EVERY TEXT OR JSON COLUMN ON EVERY TABLE WITH A RELATION PATH TO A CUSTOMER OR AN ORDER, CLASSIFIED. The tables are discovered from
 * the Prisma schema's relations by tests/erasure-schema-classification.test.ts, not listed by hand; the two tables that point at an
 * order only by reference id (the email outbox and notifications) are named in that test.
 *
 *   erased        the erasure core overwrites it (see erase-personal-data.ts)
 *   retained      kept on purpose; the reason is the value
 *   not-personal  identifier, status, reference or code that identifies no one on its own
 *
 * Columns are listed as STRINGS in arrays (not as object keys) so that this file is a catalogue of names, not code that
 * reads or writes them; the shadow-reader census reads property names.
 *
 * tests/erasure-schema-classification.test.ts reads prisma/schema.prisma and FAILS when a String or Json
 * column appears on one of these models and is not listed here, so a personal-data column added later cannot
 * silently escape erasure: the author has to decide, in this file, in the same change. It also fails on an
 * entry whose column no longer exists. Only String and Json columns need a verdict: numbers, booleans, dates
 * and enums carry no free text.
 *
 * RETAINED by decision: order totals, tax, lines, currency, ledger and Xero ids, the issued invoice PDF
 * (statutory record, six years) and the refund reason text.
 */
export type ModelClassification = {
  erased: readonly string[]
  notPersonal: readonly string[]
  retained: Readonly<Record<string, string>>
}

export const ERASURE_CLASSIFICATION: Record<string, ModelClassification> = {
  Customer: {
    erased: ['firstName', 'lastName', 'email', 'phone', 'company', 'taxNumber', 'billingAddress', 'shippingAddress', 'notes'],
    notPersonal: ['id'],
    retained: {
      accountingContactId: 'ledger contact id, part of the accounting record',
      accountingContactProvenance: 'ledger contact provenance, part of the accounting record',
    },
  },
  SalesOrder: {
    erased: ['customerName', 'customerEmail', 'customerVatNumber', 'billingAddress', 'shippingAddress', 'notes', 'internalNotes', 'trackingNumber'],
    notPersonal: ['id', 'externalOrderNumber', 'withdrawalLastWcStatus', 'currency', 'customerId', 'shippingService', 'courierKey', 'shippingMethodId', 'taxRateName', 'shipFromWarehouseId', 'salesRep', 'discountStr', 'discountRestatement', 'orderNumber', 'paymentMethod', 'paymentMethodTitle', 'revenueDeferredBatchRef', 'inventoryAllocatedBatchRef', 'allocationBatchSyncLogId', 'allocationBatchConnector', 'allocationBatchAccountCode', 'allocationBatchPasses'],
    retained: {
      invoiceNumber: 'issued invoice number, statutory record',
      accountingInvoiceId: 'ledger document id, statutory record',
      accountingInvoiceConnector: 'ledger connector, statutory record',
      invoicePdfPath: 'the issued invoice PDF is a statutory record, kept six years',
    },
  },
  Shipment: {
    erased: ['trackingNumber'],
    notPersonal: ['id', 'orderId', 'warehouseId', 'shippingService', 'shipmentJournalBatchRef', 'allocatedReliefSyncLogId', 'allocatedReliefConnector', 'allocatedReliefAccountCode'],
    retained: {
    },
  },
  ShoppingCustomerLink: {
    // The ROW is deleted by the erasure (it names the live storefront account); both columns are erased with it.
    erased: ['externalCustomerId', 'metadata'],
    notPersonal: ['id', 'customerId', 'connector'],
    retained: {},
  },
  ShoppingOrderLink: {
    erased: ['metadata'],
    notPersonal: ['id', 'orderId', 'connector'],
    retained: {
      externalOrderId: 'storefront order id, part of the order record',
      externalOrderNumber: 'storefront order number, part of the order record',
    },
  },
  WmsOrderStatusSnapshot: {
    erased: ['deepLinkUrl', 'trackingNumber', 'carrier'],
    notPersonal: ['id', 'orderId', 'connector', 'connectorLabel', 'externalOrderId', 'externalOrderNumber', 'status', 'statusLabel', 'mergedOrderNumbers', 'lastError', 'wcPushedStatus'],
    retained: {
    },
  },
  EmailOutbox: {
    erased: ['toEmail'],
    notPersonal: ['id', 'kind', 'referenceType', 'referenceId', 'lastError', 'lockedBy'],
    retained: {
      subject: 'carries the order reference only ("Order Confirmation <ref>"), never a name',
      html: 'a literal placeholder at enqueue; the body is rendered at send time from the live order',
      attachments: 'none are enqueued for customer-facing kinds; the PDF is rendered at send time',
    },
  },
  Notification: {
    erased: ['title', 'message'],
    notPersonal: ['id', 'userId', 'type'],
    retained: {
      actionUrl: 'an internal path; it is what links the notification to the order',
    },
  },
  SalesOrderRefund: {
    erased: [],
    notPersonal: ['id', 'orderId', 'creditNoteNumber', 'accountingCreditNoteId', 'accountingCreditNoteConnector', 'returnWarehouseId', 'totalsBasis', 'source', 'allocationBasisUnresolved', 'accountingRetrySyncs', 'reversalStagingState'],
    retained: {
      reason: 'owner decision: the refund reason text is kept',
      accountingWarning: 'accounting diagnostic on the refund record',
    },
  },
  // Linked by a relation, with no text or JSON column of their own (only keys, amounts and dates).
  CogsEntry: { erased: [], notPersonal: [], retained: {} },
  CostLayer: { erased: [], notPersonal: [], retained: {} },
  CostLayerRevaluation: { erased: [], notPersonal: ['reason'], retained: {} },
  CostLayerSourceLine: { erased: [], notPersonal: ['sourceCostLayerId'], retained: {} },
  OrderAllocation: { erased: [], notPersonal: ['costLayerSnapshot'], retained: {} },
  Payment: {
    erased: ['notes'],
    notPersonal: ['currency', 'method'],
    retained: { reference: 'the payment reference / transaction id reconciles the receipt with the bank and the ledger' },
  },
  ReturnExpectation: { erased: [], notPersonal: ['reference', 'transitJournalKey'], retained: {} },
  ReturnExpectationLine: { erased: [], notPersonal: ['sku', 'costSnapshot'], retained: {} },
  SalesOrderLine: {
    erased: [],
    notPersonal: ['wclcFeeKind', 'sku', 'discountStr', 'fulfillmentRequirements'],
    retained: { description: 'the product or fee text on an invoiced line: part of the retained sale record' },
  },
  SalesOrderRefundLine: {
    erased: [],
    notPersonal: ['costLayerSnapshot', 'accountingTaxType', 'lineKind'],
    retained: { description: 'the text on a refunded line: part of the retained credit-note record' },
  },
  ShipmentLine: { erased: [], notPersonal: ['costLayerSnapshot'], retained: {} },
  StockMovement: { erased: ['note'], notPersonal: ['referenceType', 'referenceId', 'idempotencyKey'], retained: {} },
  WmsOrderDiscrepancy: {
    erased: ['detail'],
    notPersonal: ['connector', 'category', 'status'],
    retained: { externalOrderNumber: 'the warehouse order number reconciles the order with the warehouse' },
  },
  WmsOrderPushLink: {
    erased: ['lastError', 'dispatchLastError', 'dispatchUnresolvedError'],
    notPersonal: ['connector', 'courierForm', 'courierFormName'],
    retained: {
      externalOrderId: 'the warehouse order id reconciles the order with the warehouse',
      externalOrderNumber: 'the warehouse order number reconciles the order with the warehouse',
    },
  },
  WmsReturnsInbox: {
    erased: ['reason', 'rawPayload', 'resolutionNote'],
    notPersonal: ['connector', 'externalReturnId', 'sku', 'reference', 'resolvedBy'],
    retained: {},
  },
}

export function classifiedColumns(model: string): string[] {
  const c = ERASURE_CLASSIFICATION[model]
  return c ? [...c.erased, ...c.notPersonal, ...Object.keys(c.retained)] : []
}
