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

/** What happened to an external system's copy. `not-attempted` until the propagation work lands. */
export const ERASURE_SYSTEM_VERDICTS = ['propagated', 'refused', 'not-technically-possible', 'not-attempted'] as const
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

export type ErasureRecordMetadata = {
  requestId: string
  erasedAt: string
  trigger: ErasureTrigger
  /** Null for an order erased on its own (a guest order, or an order whose customer keeps other live orders). */
  customerId: string | null
  orderIds: string[]
  counts: ErasureCounts
  systems: Record<ErasureExternalSystem, ErasureSystemVerdict>
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
}): ErasureRecordMetadata {
  return {
    requestId: input.requestId,
    erasedAt: input.erasedAt.toISOString(),
    trigger: input.trigger,
    customerId: input.customerId,
    orderIds: [...input.orderIds],
    counts: { ...input.counts },
    systems: { storefront: 'not-attempted', accounting: 'not-attempted', warehouse: 'not-attempted', carrierPortal: 'not-attempted' },
  }
}

/** The fixed description of a successful erasure. Nothing about the subject is interpolated. */
export const ERASURE_RECORD_DESCRIPTION = 'Personal data erased (see metadata for the request, scope and per-system verdicts)'
/** The fixed description of a failed erasure. The exception text is NOT included: it can echo data. */
export const ERASURE_FAILURE_DESCRIPTION = 'Personal data erasure failed and was rolled back; nothing was erased'
