import { WMS_INBOUND_EVENT_PROCESSING_STATUS } from '@/lib/domain/wms/inbound-event-status'
import { WMS_PUSH_INBOX_WHERE } from '@/lib/domain/wms/push-recovery-affordance'
import { activeRefundParkWhere } from '@/lib/domain/sales/refund-park-recovery'

/**
 * The WHERE clauses behind the categories the bell announces, stated once so the dashboard count and
 * the notification sample read the SAME rows as the pages they point at:
 *
 *  - wmsPushBlocked   : the inbox's own selection (WMS_PUSH_INBOX_WHERE).
 *  - refundParks      : the inbox's own selection (activeRefundParkWhere) — refund-sync PENDING/FAILED/QUARANTINED parks.
 *  - failedAccounting : AccountingSyncLog FAILED for the ACTIVE connector — exactly what FailedSyncBanner counts.
 *  - receiptReviews   : the WMS dashboard's own receipt-review predicate, for the enabled WMS connector (paused, unprocessed REQUIRES_REVIEW).
 *  - stockDiscrepancies: the WMS dashboard's own "Open Discrepancies" predicate, for the enabled WMS connector.
 */
export const receiptReviewWhere = (connector: string) => ({
  connector,
  processedAt: null,
  processingStatus: WMS_INBOUND_EVENT_PROCESSING_STATUS.requiresReview,
})

export const stockDiscrepancyWhere = (connector: string) => ({ connector, status: 'OPEN' as const })

/** How many unannounced rows one pass announces (one notification covers them all); the rest follow on the next pass. */
export const ANNOUNCE_BATCH_LIMIT = 200

type IdRow = { id: string }

/** The slice of the Prisma client these sources use, so tests can supply a fake. */
export type NeedsAttentionDb = {
  wmsOrderPushLink: {
    count(args: { where: unknown }): Promise<number>
    findMany(args: { where: unknown; select: { id: true }; orderBy: { id: 'asc' }; take?: number }): Promise<IdRow[]>
  }
  shoppingSyncLog: {
    findMany(args: { where: unknown; select: { id: true }; orderBy: { id: 'asc' }; take?: number }): Promise<IdRow[]>
  }
  accountingSyncLog: {
    count(args: { where: unknown }): Promise<number>
    findMany(args: { where: unknown; select: { id: true }; orderBy: { id: 'asc' }; take?: number }): Promise<IdRow[]>
  }
  wmsInboundReceiptEvent: {
    count(args: { where: unknown }): Promise<number>
    findMany(args: { where: unknown; select: { id: true }; orderBy: { id: 'asc' }; take?: number }): Promise<IdRow[]>
  }
  wmsStockDiscrepancy: {
    count(args: { where: unknown }): Promise<number>
    findMany(args: { where: unknown; select: { id: true }; orderBy: { id: 'asc' }; take?: number }): Promise<IdRow[]>
  }
}

export type SourceDeps = {
  db: NeedsAttentionDb
  /** The active accounting connector id, or null when none is enabled (FailedSyncBanner shows nothing then). */
  activeAccountingConnector: () => Promise<string | null>
  /** The enabled WMS connector id, or null when none is enabled (a disabled connector's leftovers are not actionable). */
  activeWmsConnector: () => Promise<string | null>
}

/** The three categories the inbox summary does not carry — one count each, never row-loading. */
export async function countNonInboxCategories(deps: SourceDeps): Promise<{
  failedAccounting: number
  receiptReviews: number
  stockDiscrepancies: number
}> {
  const [connector, wms] = await Promise.all([deps.activeAccountingConnector(), deps.activeWmsConnector()])
  const [failedAccounting, receiptReviews, stockDiscrepancies] = await Promise.all([
    connector ? deps.db.accountingSyncLog.count({ where: { connector, status: 'FAILED' } }) : Promise.resolve(0),
    wms ? deps.db.wmsInboundReceiptEvent.count({ where: receiptReviewWhere(wms) }) : Promise.resolve(0),
    wms ? deps.db.wmsStockDiscrepancy.count({ where: stockDiscrepancyWhere(wms) }) : Promise.resolve(0),
  ])
  return { failedAccounting, receiptReviews, stockDiscrepancies }
}

export type AnnouncedCategoryKey = 'wmsPushBlocked' | 'refundParks' | 'failedAccounting' | 'receiptReviews' | 'stockDiscrepancies'

type IdQuery = { where: object; run: (extra: object, take?: number) => Promise<IdRow[]> } | null

/** The "open" predicate and reader for one category, or null when the category has no open set right now. */
async function openQuery(deps: SourceDeps, key: AnnouncedCategoryKey): Promise<IdQuery> {
  const select = { id: true } as const
  const orderBy = { id: 'asc' } as const
  const make = (
    where: object,
    read: (args: { where: unknown; select: typeof select; orderBy: typeof orderBy; take?: number }) => Promise<IdRow[]>,
  ): IdQuery => ({
    where,
    run: (extra, take) => read({ where: { AND: [where, extra] }, select, orderBy, ...(take === undefined ? {} : { take }) }),
  })
  switch (key) {
    case 'wmsPushBlocked':
      return make(WMS_PUSH_INBOX_WHERE, (a) => deps.db.wmsOrderPushLink.findMany(a))
    case 'refundParks':
      return make(activeRefundParkWhere(), (a) => deps.db.shoppingSyncLog.findMany(a))
    case 'failedAccounting': {
      const connector = await deps.activeAccountingConnector()
      return connector ? make({ connector, status: 'FAILED' }, (a) => deps.db.accountingSyncLog.findMany(a)) : null
    }
    case 'receiptReviews': {
      const wms = await deps.activeWmsConnector()
      return wms ? make(receiptReviewWhere(wms), (a) => deps.db.wmsInboundReceiptEvent.findMany(a)) : null
    }
    case 'stockDiscrepancies': {
      const wms = await deps.activeWmsConnector()
      return wms ? make(stockDiscrepancyWhere(wms), (a) => deps.db.wmsStockDiscrepancy.findMany(a)) : null
    }
  }
}

/**
 * Which of the already-announced ids are STILL open. Everything announced that is not in this list
 * has cleared, so a later recurrence of the same row is a new transition.
 */
export async function stillOpenAmong(deps: SourceDeps, key: AnnouncedCategoryKey, announced: string[]): Promise<string[]> {
  if (announced.length === 0) return []
  const query = await openQuery(deps, key)
  if (!query) return []
  return (await query.run({ id: { in: announced } })).map((row) => row.id)
}

/**
 * Open rows that have NOT been announced, oldest id first, at most `limit`. The exclusion is done in
 * the database, so rows beyond any earlier batch are reached on the next pass rather than never.
 */
export async function nextUnannounced(
  deps: SourceDeps,
  key: AnnouncedCategoryKey,
  announced: string[],
  limit = ANNOUNCE_BATCH_LIMIT,
): Promise<string[]> {
  const query = await openQuery(deps, key)
  if (!query) return []
  const extra = announced.length > 0 ? { id: { notIn: announced } } : {}
  return (await query.run(extra, limit)).map((row) => row.id)
}
