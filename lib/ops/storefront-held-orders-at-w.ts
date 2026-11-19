/**
 * STEP W HAND-SEND LISTS (read-only) AND THE HAND-SENT MARK. IMS confirms a storefront order itself only when it was PLACED after the switch-on instant; an
 * order placed before it is refused on purpose (WooCommerce confirmed it, or owed it before it stopped sending), so a person covers the ones WooCommerce never
 * confirmed. IMS never sends for any of these. Populations, each with the action it implies:
 *
 *   held-unpaid       storefront orders imported held (pending payment / on hold, or allocated by the import before payment), never released (the one-shot release
 *                     marker is still armed), placed BEFORE the switch-on. UNPAID: WooCommerce already sent the order-received / on-hold e-mail when they were
 *                     placed (not one of the two natives that are switched off). SEND NOTHING NOW; they are confirmed by hand when paid (`paid` below).
 *                     Held orders without an armed marker (imported before the marker existed, or held after being paid and confirmed by WooCommerce) are NOT
 *                     listed: nothing proves WooCommerce did not confirm them, so they are checked in WooCommerce by hand.
 *   gap-paid          storefront orders PLACED from `natives-off` up to the switch-on that are already paid (not held, not cancelled): WooCommerce's processing
 *                     e-mail was off and IMS's not yet on. SEND the confirmation.
 *   paid              orders placed before the switch-on whose release IMS refused as history AND for which the store reported a PAID time on or after
 *                     `paid-since` (the natives-off instant): the payment came after WooCommerce stopped confirming, so nobody did. SEND the confirmation.
 *                     The filter is the RECORDED PAID TIME (the store's date_paid), not when IMS processed the release, so a backlogged earlier payment is excluded.
 *   released-in-ims   orders placed before the switch-on that an IMS user (or a move without a store paid time) released: NO payment was reported. CHECK payment in
 *                     WooCommerce; send only if it shows paid. Never treated as paid.
 * Only orders with no confirmation in the e-mail outbox and no hand-sent mark are listed. `markStorefrontHandSent` records a hand-send (actor, audited,
 * idempotent); it refuses an order IMS already confirmed and an unpaid one.
 * Not covered, by decision: an order placed AFTER the switch-on and released in IMS more than 48 h after placement without a store paid time is not
 * confirmed by IMS (too old) and is not listed.
 */
import { db } from '@/lib/db'
import type { SalesOrderStatus } from '@/app/generated/prisma/client'
import { STOREFRONT_CONFIRMATION_KIND } from '@/lib/domain/storefront-customer-email/constants'
import { RELEASE_NOT_SENT_ACTION } from '@/lib/storefront-customer-email'

export const HAND_SENT_ACTION = 'storefront_confirmation_hand_sent'

export type HandSendRow = {
  orderId: string
  reference: string
  status: string
  placedAt: Date
  customerEmail: string
  population: 'held-unpaid' | 'gap-paid' | 'paid' | 'released-in-ims'
}

export type HandSendInput = {
  /** The switch-on instant: the upper bound of placement in every list (IMS confirms what is placed at or after it). Null = no lists (nothing can be judged). */
  switchOnAt: Date | null
  /** The instant WooCommerce's native processing e-mail was switched off: lower bound of the gap list. Null = no gap list. */
  nativesOffAt?: Date | null
  /** Lower bound of the store's PAID time for the paid / released-in-ims lists (the natives-off instant). Null = neither list. */
  paidSince?: Date | null
}

const SELECT = { id: true, status: true, orderNumber: true, externalOrderNumber: true, externalCreatedAt: true, createdAt: true, customerEmail: true } as const
type OrderRow = { id: string; status: string; orderNumber: string | null; externalOrderNumber: string | null; externalCreatedAt: Date | null; createdAt: Date; customerEmail: string | null }
const UNPAID_STATUSES: SalesOrderStatus[] = ['DRAFT', 'CANCELLED', 'PENDING_PAYMENT', 'ON_HOLD']
const HELD_OR_ALLOCATED: SalesOrderStatus[] = ['PENDING_PAYMENT', 'ON_HOLD', 'ALLOCATED', 'PICKING', 'PACKING']

export async function listStorefrontHandSendOrders(input: HandSendInput, client: typeof db = db): Promise<HandSendRow[]> {
  const { switchOnAt } = input
  if (!switchOnAt) return []
  const base = { isQuote: false, erasedAt: null, customerEmail: { not: null }, shoppingLinks: { some: {} } } as const
  const placedBefore = (from?: Date | null) => ({
    OR: [
      { externalCreatedAt: { ...(from ? { gte: from } : {}), lt: switchOnAt } },
      { externalCreatedAt: null, createdAt: { ...(from ? { gte: from } : {}), lt: switchOnAt } },
    ],
  })
  const lists: Array<[HandSendRow['population'], OrderRow[]]> = []
  lists.push(['held-unpaid', await client.salesOrder.findMany({
    where: { ...base, status: { in: HELD_OR_ALLOCATED }, confirmationOnReleasePendingAt: { not: null }, ...placedBefore() },
    select: SELECT,
  })])
  if (input.nativesOffAt) {
    lists.push(['gap-paid', await client.salesOrder.findMany({
      where: { ...base, status: { notIn: UNPAID_STATUSES }, ...placedBefore(input.nativesOffAt) },
      select: SELECT,
    })])
  }
  if (input.paidSince) {
    const refused = await client.activityLog.findMany({
      where: { action: RELEASE_NOT_SENT_ACTION, entityType: 'SALES_ORDER', entityId: { not: null } },
      select: { entityId: true, metadata: true, createdAt: true },
    })
    const paidIds = new Set<string>()
    const unreportedIds = new Set<string>()
    for (const row of refused) {
      const meta = (row.metadata ?? {}) as { reason?: string; paidObserved?: boolean; releasedAt?: string }
      if (meta.reason !== 'before_switch_on' && meta.reason !== 'disabled') continue
      const paidAt = meta.paidObserved === true && typeof meta.releasedAt === 'string' ? Date.parse(meta.releasedAt) : Number.NaN
      if (Number.isFinite(paidAt)) { if (paidAt >= input.paidSince.getTime()) paidIds.add(row.entityId as string) }
      // No paid time reported (an IMS-side release): payment unknown. A release before the switch-on (`disabled`) counts only once it is after natives-off.
      else if (meta.reason === 'before_switch_on' || row.createdAt.getTime() >= input.paidSince.getTime()) unreportedIds.add(row.entityId as string)
    }
    const fetchIds = async (ids: Set<string>) => ids.size === 0 ? [] : client.salesOrder.findMany({
      where: { ...base, id: { in: [...ids] }, status: { notIn: UNPAID_STATUSES } }, select: SELECT,
    })
    lists.push(['paid', await fetchIds(paidIds)])
    // Not paid-observed: placed before the switch-on and released by an IMS move; payment unknown. Only those that are not also in the paid set.
    for (const id of paidIds) unreportedIds.delete(id)
    lists.push(['released-in-ims', await fetchIds(unreportedIds)])
  }
  const seen = new Set<string>()
  const rows: HandSendRow[] = []
  for (const [population, list] of lists) {
    for (const order of list) {
      if (seen.has(order.id)) continue
      seen.add(order.id)
      rows.push({
        orderId: order.id,
        reference: order.orderNumber ?? order.externalOrderNumber ?? order.id.slice(0, 8),
        status: order.status,
        placedAt: order.externalCreatedAt ?? order.createdAt,
        customerEmail: order.customerEmail ?? '',
        population,
      })
    }
  }
  if (rows.length === 0) return []
  const orderIds = rows.map((r) => r.orderId)
  const confirmed = await client.emailOutbox.findMany({
    where: { kind: STOREFRONT_CONFIRMATION_KIND, referenceType: 'SalesOrder', referenceId: { in: orderIds } },
    select: { referenceId: true },
  })
  const marked = await client.activityLog.findMany({ where: { action: HAND_SENT_ACTION, entityType: 'SALES_ORDER', entityId: { in: orderIds } }, select: { entityId: true } })
  const done = new Set([...confirmed.map((c) => c.referenceId), ...marked.map((m) => m.entityId)])
  return rows.filter((r) => !done.has(r.orderId)).sort((a, b) => a.placedAt.getTime() - b.placedAt.getTime())
}

export type MarkResult = { reference: string; outcome: 'marked' | 'already-marked' | 'refused'; reason?: string }

/**
 * Record that the confirmation of these orders was sent BY HAND, so the lists stop showing them. Audited (the actor is in the row), idempotent (a second mark
 * is a no-op), and it refuses an order that is not found, that IMS already confirmed (an outbox confirmation exists: nothing to hand-send) and that is unpaid
 * (pending payment, on hold, draft, cancelled: never confirm an unpaid order). Writes only the activity row.
 */
export async function markStorefrontHandSent(references: readonly string[], by: string, client: typeof db = db): Promise<MarkResult[]> {
  const results: MarkResult[] = []
  for (const reference of references) {
    const order = await client.salesOrder.findFirst({
      where: { OR: [{ orderNumber: reference }, { externalOrderNumber: reference }], shoppingLinks: { some: {} } },
      select: { id: true, status: true },
    })
    if (!order) { results.push({ reference, outcome: 'refused', reason: 'no storefront order with this number' }); continue }
    if (UNPAID_STATUSES.includes(order.status as SalesOrderStatus)) { results.push({ reference, outcome: 'refused', reason: `the order is ${order.status} (unpaid): never confirm an unpaid order` }); continue }
    const confirmed = await client.emailOutbox.findFirst({ where: { kind: STOREFRONT_CONFIRMATION_KIND, referenceType: 'SalesOrder', referenceId: order.id }, select: { id: true } })
    if (confirmed) { results.push({ reference, outcome: 'refused', reason: 'IMS already queued the confirmation for this order' }); continue }
    const existing = await client.activityLog.findFirst({ where: { action: HAND_SENT_ACTION, entityType: 'SALES_ORDER', entityId: order.id }, select: { id: true } })
    if (existing) { results.push({ reference, outcome: 'already-marked' }); continue }
    await client.activityLog.create({
      data: {
        userId: null, entityType: 'SALES_ORDER', entityId: order.id, action: HAND_SENT_ACTION, tag: 'sales', level: 'INFO',
        description: `Order confirmation e-mail marked as sent by hand by ${by}`,
        metadata: { by },
      },
    })
    results.push({ reference, outcome: 'marked' })
  }
  return results
}

const ACTION: Record<HandSendRow['population'], string> = {
  'held-unpaid': 'UNPAID - send nothing now; confirm by hand when paid',
  'gap-paid': 'PAID - send the confirmation',
  'paid': 'PAID (store reported a paid time) - send the confirmation',
  'released-in-ims': 'CHECK - released in IMS, no payment reported; send only if WooCommerce shows it paid',
}

export function renderHandSendList(rows: readonly HandSendRow[]): string {
  if (rows.length === 0) return 'No storefront order needs a hand-sent confirmation.'
  const lines = [`${rows.length} storefront order(s) (IMS will not send these; after sending run --mark-sent <order number>... --by <name> --yes):`]
  for (const r of rows) lines.push(`${r.population.padEnd(15)} ${r.reference}  ${r.status}  placed ${r.placedAt.toISOString()}  ${r.customerEmail}  ${ACTION[r.population]}`)
  return lines.join('\n')
}
