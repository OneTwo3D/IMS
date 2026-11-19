/**
 * CUSTOMER TIMELINE (CRM foundation): one chronological, newest-first list of what happened for a customer or a whole cluster. READ-ONLY.
 *
 * Sources, each its own bounded query (so a customer with thousands of orders never loads them all): the order placed, the order cancelled, the invoice
 * issued, a receipt, a credit note / refund, a refund payment, an expected return, and a warehouse return. An event carries ids, numbers, dates, an
 * amount and a status, and NEVER a name, email, address, note or reason text, so rendering the timeline reveals nothing the order page does not.
 *
 * KEYSET PAGINATION. Events sort by (time desc, key desc); the cursor is the last event's `${epochMs}:${key}`. Each source is read with `time <= cursor
 * time` and `take = limit + TIE_ROOM`, then the merged list is cut strictly after the cursor, so a page boundary that falls inside a run of events with
 * the same millisecond neither repeats nor skips one (up to TIE_ROOM ties per source).
 */
import type { Prisma } from '@/app/generated/prisma/client'

export const TIMELINE_PAGE_SIZE = 50
const TIE_ROOM = 50

export type TimelineKind =
  | 'ORDER_PLACED'
  | 'ORDER_CANCELLED'
  | 'INVOICE'
  | 'PAYMENT'
  | 'CREDIT_NOTE'
  | 'REFUND_PAYMENT'
  | 'RETURN_EXPECTED'
  | 'WAREHOUSE_RETURN'

export interface TimelineEvent {
  /** Unique and stable: `<KIND>:<row id>`. */
  key: string
  kind: TimelineKind
  /** ISO instant. */
  at: string
  orderId: string
  orderNumber: string
  customerId: string | null
  /** Invoice number, credit note number, payment method or return reference: an identifier, never free text. */
  reference: string | null
  /** Decimal string in `currency`, null when the event has no amount. */
  amount: string | null
  currency: string | null
  status: string | null
}

export interface TimelinePage {
  events: TimelineEvent[]
  /** Pass as `cursor` for the next page; null when there is no more. */
  nextCursor: string | null
}

type Reader = Pick<Prisma.TransactionClient, 'salesOrder' | 'payment' | 'salesOrderRefund' | 'returnExpectation' | 'wmsReturnsInbox'>

const orderLabel = (o: { id: string; orderNumber: string | null; externalOrderNumber: string | null }) => o.orderNumber ?? o.externalOrderNumber ?? o.id.slice(0, 8)

export function encodeCursor(event: Pick<TimelineEvent, 'at' | 'key'>): string {
  return `${new Date(event.at).getTime()}:${event.key}`
}

export function decodeCursor(cursor: string | null | undefined): { atMs: number; key: string } | null {
  if (!cursor) return null
  const i = cursor.indexOf(':')
  const atMs = Number(cursor.slice(0, i))
  if (i <= 0 || !Number.isFinite(atMs)) return null
  return { atMs, key: cursor.slice(i + 1) }
}

/** Sort newest first, then by key descending; the cursor cut uses the same order. */
export function compareEvents(a: Pick<TimelineEvent, 'at' | 'key'>, b: Pick<TimelineEvent, 'at' | 'key'>): number {
  const d = new Date(b.at).getTime() - new Date(a.at).getTime()
  if (d !== 0) return d
  return a.key < b.key ? 1 : a.key > b.key ? -1 : 0
}

/** The events strictly after the cursor (older), at most `limit`, and the cursor for the page after. Pure. */
export function pageEvents(all: TimelineEvent[], cursor: { atMs: number; key: string } | null, limit: number): TimelinePage {
  const sorted = [...all].sort(compareEvents)
  const after = cursor ? sorted.filter((e) => compareEvents({ at: new Date(cursor.atMs).toISOString(), key: cursor.key }, e) < 0) : sorted
  const events = after.slice(0, limit)
  return { events, nextCursor: after.length > limit ? encodeCursor(events[events.length - 1]!) : null }
}

export async function loadTimeline(db: Reader, customerIds: string[], options: { cursor?: string | null; limit?: number } = {}): Promise<TimelinePage> {
  const limit = Math.min(Math.max(options.limit ?? TIMELINE_PAGE_SIZE, 1), 200)
  const cursor = decodeCursor(options.cursor)
  if (customerIds.length === 0) return { events: [], nextCursor: null }
  const take = limit + TIE_ROOM + 1
  const upTo = cursor ? new Date(cursor.atMs) : undefined
  const inOrder = { customerId: { in: customerIds } }
  const orderSelect = { id: true, orderNumber: true, externalOrderNumber: true, customerId: true } as const

  const [placed, cancelled, invoiced, payments, refunds, expectations, returns] = await Promise.all([
    db.salesOrder.findMany({
      where: { ...inOrder, ...(upTo ? { createdAt: { lte: upTo } } : {}) },
      select: { ...orderSelect, createdAt: true, status: true, currency: true, totalForeign: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take,
    }),
    db.salesOrder.findMany({
      where: { ...inOrder, cancelledAt: upTo ? { not: null, lte: upTo } : { not: null } },
      select: { ...orderSelect, cancelledAt: true, status: true },
      orderBy: [{ cancelledAt: 'desc' }, { id: 'desc' }], take,
    }),
    db.salesOrder.findMany({
      where: { ...inOrder, invoicedAt: upTo ? { not: null, lte: upTo } : { not: null } },
      select: { ...orderSelect, invoicedAt: true, invoiceNumber: true, currency: true, totalForeign: true },
      orderBy: [{ invoicedAt: 'desc' }, { id: 'desc' }], take,
    }),
    db.payment.findMany({
      where: { order: inOrder, ...(upTo ? { paidAt: { lte: upTo } } : {}) },
      select: { id: true, refundId: true, amount: true, currency: true, method: true, paidAt: true, order: { select: orderSelect } },
      orderBy: [{ paidAt: 'desc' }, { id: 'desc' }], take,
    }),
    db.salesOrderRefund.findMany({
      where: { order: inOrder, ...(upTo ? { createdAt: { lte: upTo } } : {}) },
      select: { id: true, creditNoteNumber: true, totalForeign: true, createdAt: true, order: { select: { ...orderSelect, currency: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take,
    }),
    db.returnExpectation.findMany({
      where: { order: inOrder, ...(upTo ? { createdAt: { lte: upTo } } : {}) },
      select: { id: true, reference: true, status: true, createdAt: true, order: { select: orderSelect } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take,
    }),
    db.wmsReturnsInbox.findMany({
      where: { order: inOrder, ...(upTo ? { createdAt: { lte: upTo } } : {}) },
      select: { id: true, reference: true, status: true, createdAt: true, order: { select: orderSelect } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take,
    }),
  ])

  const events: TimelineEvent[] = []
  for (const o of placed) events.push({ key: `ORDER_PLACED:${o.id}`, kind: 'ORDER_PLACED', at: o.createdAt.toISOString(), orderId: o.id, orderNumber: orderLabel(o), customerId: o.customerId, reference: null, amount: o.totalForeign.toString(), currency: o.currency, status: o.status })
  for (const o of cancelled) events.push({ key: `ORDER_CANCELLED:${o.id}`, kind: 'ORDER_CANCELLED', at: o.cancelledAt!.toISOString(), orderId: o.id, orderNumber: orderLabel(o), customerId: o.customerId, reference: null, amount: null, currency: null, status: o.status })
  for (const o of invoiced) events.push({ key: `INVOICE:${o.id}`, kind: 'INVOICE', at: o.invoicedAt!.toISOString(), orderId: o.id, orderNumber: orderLabel(o), customerId: o.customerId, reference: o.invoiceNumber, amount: o.totalForeign.toString(), currency: o.currency, status: null })
  for (const p of payments) events.push({ key: `${p.refundId ? 'REFUND_PAYMENT' : 'PAYMENT'}:${p.id}`, kind: p.refundId ? 'REFUND_PAYMENT' : 'PAYMENT', at: p.paidAt.toISOString(), orderId: p.order.id, orderNumber: orderLabel(p.order), customerId: p.order.customerId, reference: p.method, amount: p.amount.toString(), currency: p.currency, status: null })
  for (const r of refunds) events.push({ key: `CREDIT_NOTE:${r.id}`, kind: 'CREDIT_NOTE', at: r.createdAt.toISOString(), orderId: r.order.id, orderNumber: orderLabel(r.order), customerId: r.order.customerId, reference: r.creditNoteNumber, amount: r.totalForeign.toString(), currency: r.order.currency, status: null })
  for (const r of expectations) events.push({ key: `RETURN_EXPECTED:${r.id}`, kind: 'RETURN_EXPECTED', at: r.createdAt.toISOString(), orderId: r.order.id, orderNumber: orderLabel(r.order), customerId: r.order.customerId, reference: r.reference, amount: null, currency: null, status: r.status })
  for (const r of returns) events.push({ key: `WAREHOUSE_RETURN:${r.id}`, kind: 'WAREHOUSE_RETURN', at: r.createdAt.toISOString(), orderId: r.order!.id, orderNumber: orderLabel(r.order!), customerId: r.order!.customerId, reference: r.reference, amount: null, currency: null, status: r.status })
  return pageEvents(events, cursor, limit)
}
