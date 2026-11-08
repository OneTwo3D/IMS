/**
 * THE ERASURE RECORD: what IMS keeps to be able to DEMONSTRATE that an erasure happened, without keeping
 * what was erased.
 *
 * An erasure record names the REQUEST, the DATE and the SCOPE, and never the subject. It may carry local
 * surrogates (the customer's cuid and the order cuids, which are those rows' own primary keys and mean
 * nothing outside IMS), per-table counts, the trigger kind, and a per-external-system verdict. It must carry
 * no name, email, phone, address, company or VAT number, and its free-text description is a FIXED string with
 * nothing interpolated into it.
 *
 * THE RECORD IS EXEMPT FROM ACTIVITY-LOG RETENTION. The ordinary INFO sweep deletes after 30 days, but the
 * duty to be able to show an erasure was done outlives that by years. `ERASURE_RECORD_ACTION` is spread
 * into `RETAINED_ACTIONS` in lib/activity-log-cleanup.ts; it is a shared constant on purpose, so the writer
 * and the cleanup cannot drift apart by one retyping the string.
 *
 * WHAT THE RECORD DEPENDS ON. The customer cuid points at a row whose remaining columns are the placeholder.
 * That is the intended end state and is why the surrogate is safe. It also means the proof can only be
 * verified while that Customer row exists: IMS guarantees an anonymised Customer row is NEVER hard-deleted
 * (see tests/erasure-customer-never-deleted.test.ts). If a row were removed regardless, the record would
 * still show the request, date and scope, but could no longer be tied to a row.
 *
 * The OLD action name `gdpr_anonymised` is deliberately NOT reused: rows written under it before this record
 * existed carry the customer's name in their description, and exempting that name from retention would keep
 * the identity that was erased. They age out on the ordinary schedule.
 */

export const ERASURE_RECORD_ACTION = 'gdpr_erasure_recorded'
export const ERASURE_FAILURE_ACTION = 'gdpr_erasure_failed'

/** Actions the activity-log cleanup must never age out. Spread, do not retype. */
export const ERASURE_RETAINED_ACTIONS: readonly string[] = [ERASURE_RECORD_ACTION]

export const ERASURE_PLACEHOLDER_NAME = 'GDPR Anonymised'
export const ERASURE_PLACEHOLDER_FIRST_NAME = 'GDPR'
export const ERASURE_PLACEHOLDER_LAST_NAME = 'Anonymised'
/** Written to a sent or failed email_outbox.toEmail: syntactically an address, deliverable nowhere (RFC 2606). */
export const ERASURE_PLACEHOLDER_EMAIL = 'erased@erased.invalid'

export const ERASURE_TRIGGERS = ['ON_REQUEST', 'MIRRORED_FROM_STOREFRONT', 'SCHEDULED', 'IMPORT_AFTER_ERASURE'] as const
/** IMPORT_AFTER_ERASURE: an order that arrived after its customer was erased, created already erased; the record carries the customer's ORIGINAL request id. */
export type ErasureTrigger = (typeof ERASURE_TRIGGERS)[number]

/**
 * What happened to an external system's copy. IMS makes NO write to any external system for an erasure (an erasure must never become an outbound write), so
 * `propagated` is reserved for a future propagation and is not written today.
 *   erased-at-source          the storefront anonymised the order first and IMS mirrored it (the trigger says so)
 *   refused-pending-legal     IMS holds a copy it deliberately left untouched until the accountant / DPO rules (the Xero contact: its name shows on every historical invoice)
 *   refused                   the copy is still live and IMS did not write to the system (open warehouse orders: an operator handles them by hand)
 *   not-technically-possible  the system has no way to erase it (despatched warehouse orders)
 *   not-applicable            IMS holds nothing in that system for this subject
 *   not-attempted             nothing was done and nothing is recorded as decided
 */
export const ERASURE_SYSTEM_VERDICTS = ['propagated', 'refused', 'refused-pending-legal', 'erased-at-source', 'not-technically-possible', 'not-applicable', 'not-attempted'] as const
export type ErasureSystemVerdict = (typeof ERASURE_SYSTEM_VERDICTS)[number]

export const ERASURE_EXTERNAL_SYSTEMS = ['storefront', 'accounting', 'warehouse', 'carrierPortal'] as const
export type ErasureExternalSystem = (typeof ERASURE_EXTERNAL_SYSTEMS)[number]

export type ErasureCounts = {
  customers: number
  salesOrders: number
  shipments: number
  shoppingCustomerLinks: number
  shoppingOrderLinks: number
  wmsStatusSnapshots: number
  outboxRowsErased: number
  /** Rows claimed by a sender when the erasure ran: the address is replaced in place, the claim and status untouched, and the drain refuses at its recipient confirm. */
  outboxRowsClaimedFenced: number
  /** Accounting sync rows for these orders (and their refunds) whose stored payload copy had contact identity removed or replaced. */
  accountingPayloadsScrubbed: number
  /** Held WooCommerce sales-invoice rows (shopping sync log) whose parked accounting payload had contact identity replaced. */
  heldInvoicePayloadsScrubbed: number
  /** Payments of these orders whose free-text note was erased (the reference and the amount are kept). */
  paymentNotesErased: number
  /** Rows hanging off these orders (warehouse links, discrepancies, returns inbox, stock movements) whose free text had the subject's values removed. */
  linkedFreeTextScrubbed: number
  /** Email suppression rows for the subject's addresses (the address is the erased person's) that were deleted. */
  bounceRecordsDeleted: number
  /** Existing activity-log rows whose description or metadata held the subject's identifying values. */
  activityRowsScrubbed: number
  /** Raw storefront / warehouse payload copies projected or cleared (raw-payloads.ts), and orders whose inbox rows could not be looked for. */
  rawWebhookEventsProjected: number
  rawSyncLogsProjected: number
  rawReturnRecordsCleared: number
  storefrontIdMissing: number
  /** Accounting events and event-log rows whose stored document payload had its contact block scrubbed (derived-copies.ts). */
  accountingEventCopiesScrubbed: number
  /** Accounting sync rows whose error text was replaced by the fixed marker. */
  accountingErrorsScrubbed: number
  notifications: number
}

/**
 * THE WAREHOUSE'S COPY, counted at erasure. The warehouse has no erase endpoint and IMS may not rewrite a live order, so for each of the subject's orders that exists there
 * the record says which state it is in. `open` orders (pushed, not despatched, not cancelled) still hold the person's name and address: each is listed so an operator can
 * handle it by hand. Only the surrogate order id and the warehouse order NUMBER are listed (both are retained identifiers of an order, not of a person).
 */
export type ErasureWarehouseSummary = {
  /** Orders with a warehouse link that carries a warehouse order id. */
  linkedOrders: number
  despatched: number
  open: number
  /** Linked orders that were cancelled in the warehouse. */
  cancelled: number
  /** Links with no warehouse order id that the push code PROVES were never sent (its own no-remote-call predicate): nothing is held there. */
  notPushed: number
  /**
   * Orders IMS cannot PROVE are gone from, or never reached, the warehouse: a link with no warehouse order id that the push code does not prove was never sent (a create is
   * claimed immediately before the remote call, so a killed worker, a timeout, a replay that cleared the attempt columns or an old link with no claim history can all leave an
   * order in the warehouse with no id here), and a CANCELLED link whose cancellation the warehouse did not confirm (it answered NOT_FOUND, or no evidence is kept). Each is
   * listed for the operator to VERIFY. Never read as "nothing held".
   */
  ambiguous: number
  /** Links parked MERGED (the warehouse merged the order into another: the data lives on under the combined order). Counted inside despatched/open too. */
  merged: number
  openOrders: Array<{ orderId: string; warehouseOrderNumber: string | null }>
  /** The ambiguous orders, by surrogate order id and, when one is recorded, the warehouse order number. */
  ambiguousOrders: Array<{ orderId: string; warehouseOrderNumber: string | null }>
}

export const EMPTY_WAREHOUSE_SUMMARY: ErasureWarehouseSummary = { linkedOrders: 0, despatched: 0, open: 0, cancelled: 0, notPushed: 0, ambiguous: 0, merged: 0, openOrders: [], ambiguousOrders: [] }

export type ErasureRecordMetadata = {
  requestId: string
  erasedAt: string
  trigger: ErasureTrigger
  /** Null for an order erased on its own (a guest order, or an order whose customer keeps other live orders). */
  customerId: string | null
  orderIds: string[]
  counts: ErasureCounts
  systems: Record<ErasureExternalSystem, ErasureSystemVerdict>
  warehouse: ErasureWarehouseSummary
}

/** The verdicts that follow from the trigger alone (nothing in the subject's data is read): used where no richer decision was made (an order created already erased). */
export function defaultSystemVerdicts(trigger: ErasureTrigger): Record<ErasureExternalSystem, ErasureSystemVerdict> {
  const atSource = trigger === 'MIRRORED_FROM_STOREFRONT' || trigger === 'IMPORT_AFTER_ERASURE'
  return { storefront: atSource ? 'erased-at-source' : 'not-attempted', accounting: 'not-applicable', warehouse: 'not-applicable', carrierPortal: 'not-attempted' }
}

/**
 * Metadata KEY NAMES are chosen to stay clear of sanitizeActivityLogMetadata's sensitive-key pattern
 * (email|address|vat|phone|...), which would otherwise replace the value with a redaction marker.
 */
export function buildErasureRecordMetadata(input: {
  requestId: string
  erasedAt: Date
  trigger: ErasureTrigger
  /** Null for an order erased on its own (a guest order, or an order whose customer keeps other live orders). */
  customerId: string | null
  orderIds: string[]
  counts: ErasureCounts
  systems?: Record<ErasureExternalSystem, ErasureSystemVerdict>
  warehouse?: ErasureWarehouseSummary
}): ErasureRecordMetadata {
  return {
    requestId: input.requestId,
    erasedAt: input.erasedAt.toISOString(),
    trigger: input.trigger,
    customerId: input.customerId,
    orderIds: [...input.orderIds],
    counts: { ...input.counts },
    systems: input.systems ? { ...input.systems } : defaultSystemVerdicts(input.trigger),
    warehouse: input.warehouse ? { ...input.warehouse, openOrders: input.warehouse.openOrders.map((o) => ({ ...o })), ambiguousOrders: input.warehouse.ambiguousOrders.map((o) => ({ ...o })) } : { ...EMPTY_WAREHOUSE_SUMMARY, openOrders: [], ambiguousOrders: [] },
  }
}

/** The fixed description of a successful erasure. Nothing about the subject is interpolated. */
export const ERASURE_RECORD_DESCRIPTION = 'Personal data erased (see metadata for the request, scope and per-system verdicts)'
/** The fixed description of a failed erasure. The exception text is NOT included: it can echo data. */
export const ERASURE_FAILURE_DESCRIPTION = 'Personal data erasure failed and was rolled back; nothing was erased'
