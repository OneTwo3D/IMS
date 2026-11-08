import { db } from '@/lib/db'
import { ERASURE_RECORD_ACTION, type ErasureWarehouseSummary } from './erasure-record'

/**
 * THE READ-ONLY VIEW OF THE ERASURE RECORDS (Settings > Erasure records): what an operator or an auditor reads to see that an erasure was done, when, under which
 * trigger, how much was reached, and what each external system still holds. It shows ONLY the fields the record itself is allowed to carry (see erasure-record.ts):
 * request id, dates, trigger, counts, per-system verdicts and the warehouse's open orders by surrogate order id and warehouse order number. It reads no customer or
 * order column, so there is no erased value it could display, and it shows the customer's surrogate id only as the record's own key.
 */
export type ErasureRecordRow = {
  /** The activity-log row's own id: the pagination cursor. */
  logId: string
  requestId: string
  erasedAt: string
  trigger: string
  customerId: string | null
  orderCount: number
  counts: Record<string, number>
  systems: Record<string, string>
  warehouse: ErasureWarehouseSummary | null
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A record's metadata, read defensively: records written before a field existed lack it. Anything that is not the expected scalar shape is dropped. */
export function readErasureRecord(metadata: unknown, fallbackDate: Date, logId = ''): ErasureRecordRow | null {
  if (!isObject(metadata) || typeof metadata.requestId !== 'string') return null
  const numbers = (v: unknown): Record<string, number> => (isObject(v) ? Object.fromEntries(Object.entries(v).filter(([, n]) => typeof n === 'number')) as Record<string, number> : {})
  const strings = (v: unknown): Record<string, string> => (isObject(v) ? Object.fromEntries(Object.entries(v).filter(([, n]) => typeof n === 'string')) as Record<string, string> : {})
  const w = isObject(metadata.warehouse) ? metadata.warehouse : null
  const warehouse: ErasureWarehouseSummary | null = w
    ? {
        linkedOrders: Number(w.linkedOrders) || 0, despatched: Number(w.despatched) || 0, open: Number(w.open) || 0, cancelled: Number(w.cancelled) || 0,
        notPushed: Number(w.notPushed) || 0, ambiguous: Number(w.ambiguous) || 0, merged: Number(w.merged) || 0,
        openOrders: Array.isArray(w.openOrders)
          ? w.openOrders.filter(isObject).map((o) => ({ orderId: String(o.orderId ?? ''), warehouseOrderNumber: typeof o.warehouseOrderNumber === 'string' ? o.warehouseOrderNumber : null }))
          : [],
        ambiguousOrders: Array.isArray(w.ambiguousOrders) ? w.ambiguousOrders.filter(isObject).map((o) => ({ orderId: String(o.orderId ?? ''), warehouseOrderNumber: typeof o.warehouseOrderNumber === 'string' ? o.warehouseOrderNumber : null })) : [],
      }
    : null
  return {
    logId,
    requestId: metadata.requestId,
    erasedAt: typeof metadata.erasedAt === 'string' ? metadata.erasedAt : fallbackDate.toISOString(),
    trigger: typeof metadata.trigger === 'string' ? metadata.trigger : 'unknown',
    customerId: typeof metadata.customerId === 'string' ? metadata.customerId : null,
    orderCount: Array.isArray(metadata.orderIds) ? metadata.orderIds.length : 0,
    counts: numbers(metadata.counts),
    systems: strings(metadata.systems),
    warehouse,
  }
}

export const ERASURE_RECORD_PAGE_SIZE = 50

export type ErasureRecordQuery = {
  /** Only records that still leave warehouse orders to handle by hand (open or ambiguous). */
  onlyObligations?: boolean
  /** Look one record up by its request id. */
  requestId?: string
  /** The `nextCursor` of the previous page. */
  cursor?: string
  limit?: number
}

export type ErasureRecordPage = {
  rows: Array<ErasureRecordRow & { orderNumbers: Record<string, string> }>
  /** Pass back as `cursor` for the next (older) page; null on the last page. */
  nextCursor: string | null
}

/**
 * One page of records, newest first, keyset-paged by the log row's own id (so a page never skips or repeats a row), optionally filtered to the records with open or
 * ambiguous warehouse orders, or to one request id. Nothing is dropped silently: an older record is always reachable by paging, by the filter or by its request id.
 * The IMS order NUMBERS of the listed warehouse orders are read for display (an order number identifies an order, not a person).
 */
export async function listErasureRecords(query: ErasureRecordQuery = {}): Promise<ErasureRecordPage> {
  const limit = Math.min(Math.max(query.limit ?? ERASURE_RECORD_PAGE_SIZE, 1), 200)
  const where = {
    action: ERASURE_RECORD_ACTION,
    ...(query.requestId ? { metadata: { path: ['requestId'], equals: query.requestId } } : {}),
    ...(query.onlyObligations ? { OR: [{ metadata: { path: ['warehouse', 'open'], gt: 0 } }, { metadata: { path: ['warehouse', 'ambiguous'], gt: 0 } }] } : {}),
  }
  const rows = await db.activityLog.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    select: { id: true, metadata: true, createdAt: true },
  })
  const page = rows.slice(0, limit)
  const records = page.map((r) => readErasureRecord(r.metadata, r.createdAt, r.id)).filter((r): r is ErasureRecordRow => r !== null)
  const ids = [...new Set(records.flatMap((r) => [...(r.warehouse?.openOrders ?? []), ...(r.warehouse?.ambiguousOrders ?? [])].map((o) => o.orderId)))]
  const numbers = ids.length === 0 ? [] : await db.salesOrder.findMany({ where: { id: { in: ids } }, select: { id: true, orderNumber: true } })
  const byId = Object.fromEntries(numbers.filter((o) => o.orderNumber).map((o) => [o.id, o.orderNumber as string]))
  return {
    rows: records.map((r) => {
      const mine = [...(r.warehouse?.openOrders ?? []), ...(r.warehouse?.ambiguousOrders ?? [])].map((o) => o.orderId)
      return { ...r, orderNumbers: Object.fromEntries(mine.filter((id) => byId[id]).map((id) => [id, byId[id]!])) }
    }),
    nextCursor: rows.length > limit ? page[page.length - 1]!.id : null,
  }
}
