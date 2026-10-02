/**
 * o3d-f709 / o3d-vzje - HOW A MIRRORED ACCOUNTING EVENT CAME TO BE POSTED (`AccountingEvent.postBasis`).
 *
 * A LEAF MODULE, for the reason `accounting-event-void-basis.ts` and `sync-row-settlement.ts` give:
 * suites replace `accounting-event-mirror` with a partial mock, under which a value import of its
 * constants would be `undefined`.
 *
 * THE THREE VALUES, each written by the code that made the fact true and never inferred:
 *
 *   CONNECTOR          the connector's own success writeback: the ledger answered and holds the
 *                      document. Written by every POSTED mirror write that carries no guard.
 *   OPERATOR_ASSERTION a person typed the document id in (settlement POSTED, mark-handled VOID is not
 *                      this). Written by every POSTED mirror write made under a settlement guard.
 *                      The event's `linesJson` is then enqueue-time INTENT, not what the ledger holds.
 *   SYNC_LOG_BACKFILL  the administrative backfill repaired the mirror from a sync log already
 *                      recorded as connector-confirmed (the backfill refuses to mirror an operator's
 *                      assertion as POSTED at all). Counted as confirmed (D6): it restates a
 *                      connector fact the sync log carries, though the event was not witnessed live.
 *
 * NULL is "unrecorded": every event written before the column existed, every event a predecessor
 * binary writes while it serves across the deploy, and every POSTED event whose writer did not say.
 * It is NEVER read as confirmed, and there is no backfill (a marker for an act IMS did not witness).
 */
export const CONNECTOR_POST_BASIS = 'CONNECTOR'
export const OPERATOR_ASSERTION_POST_BASIS = 'OPERATOR_ASSERTION'
export const SYNC_LOG_BACKFILL_POST_BASIS = 'SYNC_LOG_BACKFILL'

/** The bases that count as a CONFIRMED post. Anything else - including NULL - does not. */
export const CONFIRMED_POST_BASES = [CONNECTOR_POST_BASIS, SYNC_LOG_BACKFILL_POST_BASIS] as const

/**
 * The post basis for a POSTED mirror of a sync-log row, from the row's `settlementBasis`.
 *
 *   null              the connector's own writeback                       -> CONNECTOR
 *   OPERATOR_RELEASE  an operator moved a row whose id is the connector's -> CONNECTOR
 *   OPERATOR_ASSERTION a person typed the outcome                         -> OPERATOR_ASSERTION
 *   anything else     not a basis this build can vouch for                -> null (unrecorded)
 */
export function postBasisForSyncLogSettlementBasis(settlementBasis: string | null | undefined): string | null {
  if (settlementBasis === null) return CONNECTOR_POST_BASIS
  if (settlementBasis === 'OPERATOR_RELEASE') return CONNECTOR_POST_BASIS
  if (settlementBasis === 'OPERATOR_ASSERTION') return OPERATOR_ASSERTION_POST_BASIS
  return null
}
