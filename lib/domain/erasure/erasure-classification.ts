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
    erased: ['deepLinkUrl', 'trackingNumber', 'carrier', 'lastError'],
    notPersonal: ['id', 'orderId', 'connector', 'connectorLabel', 'externalOrderId', 'externalOrderNumber', 'status', 'statusLabel', 'mergedOrderNumbers', 'wcPushedStatus'],
    retained: {
    },
  },
  EmailOutbox: {
    erased: ['toEmail', 'lastError'],
    notPersonal: ['id', 'kind', 'referenceType', 'referenceId', 'lockedBy'],
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
    erased: ['accountingWarning'],
    notPersonal: ['id', 'orderId', 'creditNoteNumber', 'accountingCreditNoteId', 'accountingCreditNoteConnector', 'returnWarehouseId', 'totalsBasis', 'source', 'allocationBasisUnresolved', 'accountingRetrySyncs', 'reversalStagingState'],
    retained: {
      reason: 'owner decision: the refund reason text is kept',
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
  SalesOrderInvoiceDocument: {
    erased: [],
    notPersonal: ['connector', 'externalDocumentId', 'externalStatus', 'sha256'],
    retained: {
      documentNumber: 'issued invoice / credit note number, statutory record',
      storedPath: 'the issued invoice / credit note PDF is a statutory record, kept six years',
    },
  },
  InvoiceDocumentFetchState: { erased: [], notPersonal: ['subjectKey', 'lastError', 'leaseHolder'], retained: {} },
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

// Reached from an erased order's return by the inbox row id / the order id, not by a foreign key (named in the schema test).
// The suppression table is keyed by ADDRESS: the erasure deletes the rows for the subject's addresses (the address and the mail server's raw text).
ERASURE_CLASSIFICATION.EmailSuppression = { erased: ['email', 'reason'], notPersonal: ['id', 'source'], retained: {} }
ERASURE_CLASSIFICATION.WmsMutationEvent = {
  erased: ['before', 'after'],
  notPersonal: ['connector', 'action', 'entityType', 'entityId', 'externalId', 'summary', 'error', 'jobId', 'triggeredBy'],
  retained: {},
}
// The returns sync no longer copies the raw warehouse record here (only the return id); rows written before that are cleared by the erasure (raw-payloads.ts).
ERASURE_CLASSIFICATION.WmsSyncLog = {
  erased: ['payload'],
  notPersonal: ['jobId', 'sku', 'productId', 'reason'],
  retained: {},
}
// The raw storefront copies: reached by the storefront order id inside the payload, not by a relation (named in the schema test). The payload is replaced
// by an allowlist projection, the error text by the marker; every other column is an id, a status, a count or a clock.
ERASURE_CLASSIFICATION.ShoppingWebhookEvent = {
  erased: ['payloadJson', 'lastError'],
  notPersonal: ['connector', 'resource', 'externalEventId', 'topic', 'payloadHash', 'originAttestation', 'status'],
  retained: {},
}
ERASURE_CLASSIFICATION.ShoppingSyncLog = {
  erased: ['payload', 'errorMessage'],
  notPersonal: ['connector', 'entityType', 'entityId', 'externalId', 'recordKind'],
  retained: {},
}

// The derived accounting copies: reached by (referenceType, referenceId) / (sourceEntityType, sourceEntityId) = the order and its refunds, not by a relation (named in the schema test).
// The contact block of a payload is scrubbed by derived-copies.ts / erase-personal-data.ts (email always; name kept only where the copy may describe a posted, retained document).
ERASURE_CLASSIFICATION.AccountingSyncLog = {
  erased: ['payload', 'errorMessage'],
  notPersonal: ['connector', 'referenceType', 'referenceId', 'settlementBasis', 'connectionProvenance', 'createDispatchIdempotencyKey', 'followUpObligations'],
  retained: {
    externalTransactionId: 'the ledger document id reconciles the posted document',
    attemptedInvoiceNumber: 'the invoice number is part of the retained invoice record',
  },
}
ERASURE_CLASSIFICATION.AccountingEvent = {
  erased: ['linesJson'],
  notPersonal: ['type', 'sourceEntityType', 'sourceEntityId', 'status', 'idempotencyKey', 'currency', 'externalSystem', 'revisionOrderBasis', 'voidBasis', 'postBasis', 'reversalOfId'],
  retained: { externalId: 'the ledger document id reconciles the posted document' },
}
// The event log's MESSAGE is free text: a final failure writes the raw connector error into it (it can echo the customer's or a third party's name), so it is
// replaced by the marker; the superseded body in metadata can hold a contact block. The action stays: it says what happened.
ERASURE_CLASSIFICATION.AccountingEventLog = { erased: ['metadata', 'message'], notPersonal: ['action'], retained: {} }

// Keyed by the storefront order id only; it carries no personal data (named in the schema test: no relation reaches it).
ERASURE_CLASSIFICATION.StorefrontCustomerErasureTombstone = { erased: [], notPersonal: ['connector', 'customerKeyHash'], retained: {} } // a hash of connector + storefront customer id: no raw identifier
ERASURE_CLASSIFICATION.StorefrontOrderErasureObligation = { erased: [], notPersonal: ['connector', 'externalOrderId'], retained: {} }

export function classifiedColumns(model: string): string[] {
  const c = ERASURE_CLASSIFICATION[model]
  return c ? [...c.erased, ...c.notPersonal, ...Object.keys(c.retained)] : []
}
