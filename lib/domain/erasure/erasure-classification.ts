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
  // wcLineBaseline (JSON): WooCommerce line item ids, quantities, SKUs and the order total taken at the first IMS line edit. Product and money figures only: no name, address, email or free text.
  SalesOrder: {
    erased: ['customerName', 'customerEmail', 'customerVatNumber', 'billingAddress', 'shippingAddress', 'notes', 'internalNotes', 'trackingNumber'],
    notPersonal: ['id', 'externalOrderNumber', 'withdrawalLastWcStatus', 'currency', 'customerId', 'shippingService', 'courierKey', 'shippingMethodId', 'taxRateName', 'shipFromWarehouseId', 'salesRep', 'discountStr', 'discountRestatement', 'euVatLineAccount', 'euVatRegimeBasis', 'orderNumber', 'iossNumber', 'deliveryTerm', 'paymentMethod', 'paymentMethodTitle', 'revenueDeferredBatchRef', 'inventoryAllocatedBatchRef', 'allocationBatchSyncLogId', 'allocationBatchConnector', 'allocationBatchAccountCode', 'allocationBatchPasses', 'wcLineBaseline'],
    retained: {
      invoiceNumber: 'issued invoice number, statutory record',
      accountingInvoiceId: 'ledger document id, statutory record',
      accountingInvoiceConnector: 'ledger connector, statutory record',
      invoicePdfPath: 'the issued invoice PDF is a statutory record, kept six years',
    },
  },
  Shipment: {
    erased: ['trackingNumber'],
    notPersonal: ['id', 'orderId', 'warehouseId', 'reference', 'shippingService', 'shipmentJournalBatchRef', 'allocatedReliefSyncLogId', 'allocatedReliefConnector', 'allocatedReliefAccountCode', 'cogsRelievedFromInventorySyncLogId'],
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
  // o3d-cdhl: dated partial-payment-removal history; ids, kinds, amounts and the matched ledger payment ids only.
  PaymentRemovalReconciliation: { erased: [], notPersonal: ['id', 'orderId', 'connector', 'accountingInvoiceId', 'kind', 'currency', 'matchedPaymentIds', 'ledgerAction', 'refundId'], retained: {} },
  SalesOrderRefund: {
    erased: ['accountingWarning'],
    notPersonal: ['id', 'orderId', 'creditNoteNumber', 'accountingCreditNoteId', 'accountingCreditNoteConnector', 'returnWarehouseId', 'returnReasonId', 'totalsBasis', 'source', 'allocationBasisUnresolved', 'accountingRetrySyncs', 'reversalStagingState', 'returnCostSplit', 'returnShipmentQty', 'deferralAdjustmentRef'],
    retained: {
      reason: 'owner decision: the refund reason text is kept',
    },
  },
  // o3d-ngmt.22: the record that a refund recorded in error was deleted. Keyed to its order by id only (no foreign key, so it outlives a deleted order). Ids, a credit note number,
  // amounts and a JSON of the reversed movements (ids and quantities); the one free-text column is the operator's delete reason, retained like the refund's own reason.
  SalesOrderRefundDeletion: {
    erased: [],
    notPersonal: ['refundId', 'orderId', 'creditNoteNumber', 'accountingCreditNoteId', 'deletedById', 'voidSyncLogId', 'reversal'],
    retained: {
      reason: 'owner decision (as for the refund reason): the reason an operator gave for deleting a refund is part of the audit record',
    },
  },
  // CRM customer identity: the insert-only merge / unmerge audit. Ids only (the pair of customer ids and the staff user who decided); no name, email or free text,
  // so there is nothing to erase, and the rows are KEPT by an erasure (the audit trail of who was joined to whom must survive). No foreign keys: it is reached by id.
  CustomerMergeEvent: { erased: [], notPersonal: ['customerId', 'otherCustomerId', 'decidedByUserId'], retained: {} },
  // CRM cluster erasure request: the saved member list of a whole-person erasure. Ids only (the customers it covered and the staff user who asked); no name, email or
  // free text, so there is nothing to erase and the row is KEPT as the proof of what the erasure covered. No foreign keys: reached by id.
  CustomerClusterErasure: { erased: [], notPersonal: ['requestedCustomerId', 'memberIds', 'requestedByUserId'], retained: {} },
  // Linked by a relation, with no text or JSON column of their own (only keys, amounts and dates).
  CogsEntry: { erased: [], notPersonal: [], retained: {} },
  CostLayer: { erased: [], notPersonal: ['returnMovementId'], retained: {} },
  CostLayerRevaluation: { erased: [], notPersonal: ['reason'], retained: {} },
  CostLayerSourceLine: { erased: [], notPersonal: ['sourceCostLayerId'], retained: {} },
  OrderAllocation: { erased: [], notPersonal: ['costLayerSnapshot'], retained: {} },
  SalesOrderLinePeg: { erased: [], notPersonal: ['createdById', 'endedById', 'receivedByWarehouse', 'seenLandedByWarehouse'], retained: {} },
  Payment: {
    erased: ['notes'],
    notPersonal: ['currency', 'method'],
    retained: { reference: 'the payment reference / transaction id reconciles the receipt with the bank and the ledger' },
  },
  SalesOrderInvoiceDocument: {
    erased: [],
    notPersonal: ['connector', 'externalDocumentId', 'externalStatus', 'sha256', 'evidenceKey'],
    retained: {
      documentNumber: 'issued invoice / credit note number, statutory record',
      storedPath: 'the issued invoice / credit note PDF is a statutory record, kept six years',
    },
  },
  // lastResult is a fixed vocabulary written by IMS (covered, fired, not-eligible, no-tracking, order-gone, window-closed), never remote free text.
  TrackshipRefireState: { erased: [], notPersonal: ['id', 'orderId', 'lastResult'], retained: {} },
  InvoiceStorePublication: { erased: [], notPersonal: ['noteInvoiceId', 'noteStoreId', 'flagDocumentId'], retained: {} },
  InvoiceDocumentFetchState: { erased: [], notPersonal: ['subjectKey', 'lastError', 'leaseHolder'], retained: {} },
  ReturnExpectation: { erased: [], notPersonal: ['reference', 'transitJournalKey'], retained: {} },
  ReturnExpectationLine: { erased: [], notPersonal: ['sku', 'costSnapshot'], retained: {} },
  SalesOrderLine: {
    erased: [],
    notPersonal: ['wclcFeeKind', 'sku', 'discountStr', 'fulfillmentRequirements', 'exchangeForRefundId'],
    retained: { description: 'the product or fee text on an invoiced line: part of the retained sale record' },
  },
  SalesOrderRefundLine: {
    erased: [],
    notPersonal: ['costLayerSnapshot', 'accountingTaxType', 'lineKind', 'postingTaxType'],
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
    // doublePostageDetail: order numbers, currency and amounts only (built by decideDoublePostage); no name, address or contact.
    notPersonal: ['connector', 'courierForm', 'courierFormName', 'pushWarehouseId', 'lineSnapshotToken', 'amendLeaseOwner', 'courierTaskService', 'doublePostageDetail',
      // Mixed-warehouse scope: a mode, a version, a hash of the lines sent, stamps, a fixed-vocabulary freeze reason and minor-unit amounts. No person is named.
      'scopeHash', 'scopeFrozenReason'],
    retained: {
      externalOrderId: 'the warehouse order id reconciles the order with the warehouse',
      externalOrderNumber: 'the warehouse order number reconciles the order with the warehouse',
    },
  },
  WmsOrderPushItem: {
    // The warehouse's own line ids with the SKU and quantity of each line: no person is named. Deleted with its link (cascade).
    erased: [],
    notPersonal: ['linkId', 'externalOrderId', 'externalItemId', 'sku'],
    retained: {},
  },
  WmsOrderPushScopeLine: {
    // The part of an order sent to the warehouse: the order line id, SKU and quantity of each line. No person is named. Deleted with its link (cascade).
    erased: [],
    notPersonal: ['linkId', 'orderLineId', 'sku'],
    retained: {},
  },
  WmsDespatchApplication: {
    // One row per applied warehouse despatch: an idempotency key built from IDs and the shipment ids shipped. No person is named. Deleted with its link (cascade).
    erased: [],
    notPersonal: ['linkId', 'idempotencyKey', 'shipmentIds'],
    retained: {},
  },
  WmsOperatorTask: {
    // Operator query tasks: the warehouse and IMS order numbers, SKUs, quantities and line ids, in fixed wording built by IMS. No person is named
    // and no free text from the customer or the warehouse is stored (the connector's error text is not copied in). Deleted with its order (cascade).
    erased: [],
    notPersonal: ['id', 'connector', 'orderId', 'externalOrderId', 'queryText', 'payload', 'contentHash', 'doneBy'],
    retained: {},
  },
  // Supporting documents attached to an order. A SALES order's attachment can hold the customer's personal data in its CONTENT (a customer purchase order, an
  // email, a proof of address), which cannot be redacted, so an erasure DELETES the rows (live and soft-deleted) and the files of the erased orders
  // (deleteSalesOrderAttachmentsInTx + removeOrderAttachmentFiles). The original file name can carry a name and goes with the row. A PURCHASE order's
  // attachments are supplier-side commercial documents, not personal data of a customer, and are not reached by an erasure (a purchase order has no customer link).
  OrderAttachment: {
    erased: ['originalFilename'],
    notPersonal: ['id', 'storedName', 'mimeType', 'sha256', 'uploadedByUserId'],
    retained: {},
  },
  WmsReturnsInbox: {
    erased: ['reason', 'rawPayload', 'resolutionNote'],
    notPersonal: ['connector', 'externalReturnId', 'sku', 'reference', 'resolvedBy'],
    retained: {},
  },
  // Sales-order custom field values (product values are not personal and are not linked to an order). The text and JSON an operator types
  // into an order's custom fields can be about the person, so both are erased: the erasure DELETES every value row of the order.
  CustomFieldValue: {
    erased: ['valueText', 'valueJson'],
    notPersonal: ['id'],
    retained: {},
  },
}

// Reached from an erased order's return by the inbox row id / the order id, not by a foreign key (named in the schema test).
// The suppression table is keyed by ADDRESS: the erasure deletes the rows for the subject's addresses (the address and the mail server's raw text).
// Refused-or-stalled action records: keyed by an entity id (no foreign key, so the row outlives a deleted order). The intent is the warehouse push summary
// (order number, SKUs, quantities, amounts) and the detail is fixed wording built by IMS from a status token: no person is named and no remote free text
// is stored, so nothing is erased and no free-text guard is needed.
ERASURE_CLASSIFICATION.RefusedAction = {
  erased: [],
  notPersonal: ['entityType', 'entityId', 'action', 'gate', 'intent', 'detail', 'resolution'],
  retained: {},
}
// WooCommerce-vs-IMS order divergence records: keyed by the order id (no foreign key, so the row outlives a deleted order). The differences are built by IMS
// from SKUs, quantities and amounts only (never a payload's free text, name, address or note), so nothing is erased and no free-text guard is needed.
ERASURE_CLASSIFICATION.WcOrderDivergence = {
  erased: [],
  notPersonal: ['orderId', 'externalOrderId', 'externalOrderNumber', 'differences', 'fingerprint', 'resolution'],
  retained: {},
}
ERASURE_CLASSIFICATION.WcOrderDivergenceRecheck = { erased: [], notPersonal: ['orderId', 'externalOrderId'], retained: {} }
// Xero payment-matching results: one row per customer receipt, keyed by the payment and order ids (no foreign key, so the row outlives a deleted receipt). It holds ids, a Xero
// bank-account id, an amount, a currency and a reason code in fixed wording built by IMS: no person is named and no remote free text is stored, so nothing is erased.
ERASURE_CLASSIFICATION.XeroPaymentMatch = {
  erased: [],
  notPersonal: ['paymentId', 'orderId', 'mode', 'reason', 'detail', 'bankAccountId', 'currency', 'accountingInvoiceId', 'claimToken'],
  retained: {},
}
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
  notPersonal: ['connector', 'referenceType', 'referenceId', 'settlementBasis', 'connectionProvenance', 'createDispatchIdempotencyKey', 'followUpObligations', 'payloadAccountNets'],
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
