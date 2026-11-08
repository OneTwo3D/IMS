import { db } from '@/lib/db'
import { ERASURE_RECORD_ACTION, type ErasureWarehouseSummary } from './erasure-record'

/**
 * THE READ-ONLY VIEW OF THE ERASURE RECORDS (Settings > Erasure records): what an operator or an auditor reads to see that an erasure was done, when, under which
 * trigger, how much was reached, and what each external system still holds. It shows ONLY the fields the record itself is allowed to carry (see erasure-record.ts):
 * request id, dates, trigger, counts, per-system verdicts and the warehouse's open orders by surrogate order id and warehouse order number. It reads no customer or
 * order column, so there is no erased value it could display, and it shows the customer's surrogate id only as the record's own key.
 */
export type ErasureRecordRow = {
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
export function readErasureRecord(metadata: unknown, fallbackDate: Date): ErasureRecordRow | null {
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
        ambiguousOrders: Array.isArray(w.ambiguousOrders) ? w.ambiguousOrders.filter(isObject).map((o) => ({ orderId: String(o.orderId ?? '') })) : [],
      }
    : null
  return {
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

export async function listErasureRecords(limit = 200): Promise<ErasureRecordRow[]> {
  const rows = await db.activityLog.findMany({
    where: { action: ERASURE_RECORD_ACTION },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: { metadata: true, createdAt: true },
  })
  return rows.map((r) => readErasureRecord(r.metadata, r.createdAt)).filter((r): r is ErasureRecordRow => r !== null)
}
