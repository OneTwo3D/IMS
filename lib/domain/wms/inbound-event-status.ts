/**
 * The processing lifecycle of a WMS INBOUND EVENT row, stated once, connector-agnostically.
 *
 * Every warehouse that pushes events at us (a booked-in callback, a despatch notification) lands a
 * row that this state machine then owns: PENDING → retried → processed, or parked for review, or
 * dead. Nothing in that lifecycle is a property of any one warehouse — the retry ladder, the
 * exception inbox's "dead" filter and the retention sweep's "resolved" definition all read these
 * values without caring who sent the event.
 *
 * o3d-remove-shiphero round 2 (Codex HIGH 3): it used to be `MINTSOFT_WEBHOOK_PROCESSING_STATUS`,
 * exported from the Mintsoft booked-in processor, and the two genuinely generic modules that read it
 * — lib/domain/wms/exception-inbox.ts and lib/domain/wms/inbound-event-retention.ts — therefore
 * spelled a connector's name eleven times to ask a question that has nothing to do with that
 * connector. Renaming it was not cosmetic: those modules could not be brought inside the connector
 * boundary guard while they did.
 */
export const WMS_INBOUND_EVENT_PROCESSING_STATUS = {
  pending: 'PENDING',
  pendingRetry: 'PENDING_RETRY',
  failedRetry: 'FAILED_RETRY',
  requiresReview: 'REQUIRES_REVIEW',
  dead: 'DEAD',
  processed: 'PROCESSED',
} as const

export type WmsInboundEventProcessingStatus =
  typeof WMS_INBOUND_EVENT_PROCESSING_STATUS[keyof typeof WMS_INBOUND_EVENT_PROCESSING_STATUS]
