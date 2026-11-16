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

/** Upper bound on how many ids one category samples for the bell: a storm of 5,000 rows is one alert, not 5,000 reads. */
export const ANNOUNCE_SAMPLE_LIMIT = 200

type IdRow = { id: string }

/** The slice of the Prisma client these sources use, so tests can supply a fake. */
export type NeedsAttentionDb = {
  wmsOrderPushLink: {
    count(args: { where: unknown }): Promise<number>
    findMany(args: { where: unknown; select: { id: true }; orderBy: { id: 'asc' }; take: number }): Promise<IdRow[]>
  }
  shoppingSyncLog: {
    findMany(args: { where: unknown; select: { id: true }; orderBy: { id: 'asc' }; take: number }): Promise<IdRow[]>
  }
  accountingSyncLog: {
    count(args: { where: unknown }): Promise<number>
    findMany(args: { where: unknown; select: { id: true }; orderBy: { id: 'asc' }; take: number }): Promise<IdRow[]>
  }
  wmsInboundReceiptEvent: {
    count(args: { where: unknown }): Promise<number>
    findMany(args: { where: unknown; select: { id: true }; orderBy: { id: 'asc' }; take: number }): Promise<IdRow[]>
  }
  wmsStockDiscrepancy: {
    count(args: { where: unknown }): Promise<number>
    findMany(args: { where: unknown; select: { id: true }; orderBy: { id: 'asc' }; take: number }): Promise<IdRow[]>
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

/** Stable ids of the rows currently open in a category (oldest id first, capped). */
export async function sampleOpenIds(
  deps: SourceDeps,
  key: AnnouncedCategoryKey,
  limit = ANNOUNCE_SAMPLE_LIMIT,
): Promise<string[]> {
  const select = { id: true } as const
  const orderBy = { id: 'asc' } as const
  let rows: IdRow[]
  switch (key) {
    case 'wmsPushBlocked':
      rows = await deps.db.wmsOrderPushLink.findMany({ where: WMS_PUSH_INBOX_WHERE, select, orderBy, take: limit })
      break
    case 'refundParks':
      rows = await deps.db.shoppingSyncLog.findMany({ where: activeRefundParkWhere(), select, orderBy, take: limit })
      break
    case 'failedAccounting': {
      const connector = await deps.activeAccountingConnector()
      rows = connector
        ? await deps.db.accountingSyncLog.findMany({ where: { connector, status: 'FAILED' }, select, orderBy, take: limit })
        : []
      break
    }
    case 'receiptReviews': {
      const wms = await deps.activeWmsConnector()
      rows = wms ? await deps.db.wmsInboundReceiptEvent.findMany({ where: receiptReviewWhere(wms), select, orderBy, take: limit }) : []
      break
    }
    case 'stockDiscrepancies': {
      const wms = await deps.activeWmsConnector()
      rows = wms ? await deps.db.wmsStockDiscrepancy.findMany({ where: stockDiscrepancyWhere(wms), select, orderBy, take: limit }) : []
      break
    }
  }
  return rows.map((row) => row.id)
}
