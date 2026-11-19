/**
 * STEP W HAND-SEND LISTS (read-only). IMS confirms a storefront order itself only when it was PLACED after the switch-on instant; an order placed before it is
 * refused on purpose (WooCommerce confirmed it, or owed it before it stopped sending), so a person covers the ones WooCommerce never confirmed. Three lists,
 * each with the action it implies. No write, no network. IMS never sends for any of these.
 *
 *   heldUnpaid  storefront orders imported held (pending payment / on hold), never released (the one-shot release marker is still armed), placed BEFORE the
 *               switch-on. They are UNPAID: WooCommerce already sent the order-received / on-hold e-mail when they were placed (that e-mail is not one of the
 *               two natives that are switched off). SEND NOTHING NOW. They need a hand-sent confirmation when they are paid; the paid list below shows them then.
 *               Held orders without an armed marker (imported before the marker existed, or put on hold after being paid and confirmed by WooCommerce) are NOT
 *               listed: nothing proves WooCommerce did not already confirm them, so they are checked in WooCommerce by hand.
 *   gapPaid     storefront orders placed from `natives-off` up to the switch-on that are already paid (not held, not cancelled): WooCommerce's processing
 *               e-mail was off and IMS's not yet on, so nobody confirmed them. SEND the confirmation now.
 *   paidSince   orders placed before the switch-on whose release (payment) IMS saw on or after `paid-since` and refused as history: PAID, no confirmation from
 *               IMS. SEND the confirmation now (WooCommerce's processing e-mail was off when they were paid).
 * Only orders with no confirmation in the e-mail outbox are listed.
 */
import { db } from '@/lib/db'
import { STOREFRONT_CONFIRMATION_KIND } from '@/lib/domain/storefront-customer-email/constants'
import { RELEASE_NOT_SENT_ACTION } from '@/lib/storefront-customer-email'

export type HandSendRow = {
  orderId: string
  reference: string
  status: string
  placedAt: Date
  customerEmail: string
  population: 'held-unpaid' | 'gap-paid' | 'paid-since'
}

export type HandSendInput = {
  /** The switch-on instant: the upper bound of every list (IMS confirms what is placed at or after it). Null = no lists (nothing can be judged). */
  switchOnAt: Date | null
  /** The instant WooCommerce's native processing e-mail was switched off: lower bound of the gap list. Null = no gap list. */
  nativesOffAt?: Date | null
  /** Lower bound of the paid-since list (normally W). Null = no paid list. */
  paidSince?: Date | null
}

const SELECT = { id: true, status: true, orderNumber: true, externalOrderNumber: true, externalCreatedAt: true, createdAt: true, customerEmail: true } as const
type OrderRow = { id: string; status: string; orderNumber: string | null; externalOrderNumber: string | null; externalCreatedAt: Date | null; createdAt: Date; customerEmail: string | null }

export async function listStorefrontHandSendOrders(input: HandSendInput, client: typeof db = db): Promise<HandSendRow[]> {
  const { switchOnAt } = input
  if (!switchOnAt) return []
  const base = { isQuote: false, erasedAt: null, customerEmail: { not: null }, shoppingLinks: { some: {} } } as const
  const placedBefore = (extra?: Date | null) => ({
    OR: [
      { externalCreatedAt: { ...(extra ? { gte: extra } : {}), lt: switchOnAt } },
      { externalCreatedAt: null, createdAt: { ...(extra ? { gte: extra } : {}), lt: switchOnAt } },
    ],
  })
  const lists: Array<[HandSendRow['population'], OrderRow[]]> = []
  lists.push(['held-unpaid', await client.salesOrder.findMany({
    where: { ...base, status: { in: ['PENDING_PAYMENT', 'ON_HOLD'] }, confirmationOnReleasePendingAt: { not: null }, ...placedBefore() },
    select: SELECT,
  })])
  if (input.nativesOffAt) {
    lists.push(['gap-paid', await client.salesOrder.findMany({
      where: { ...base, status: { notIn: ['DRAFT', 'CANCELLED', 'PENDING_PAYMENT', 'ON_HOLD'] }, ...placedBefore(input.nativesOffAt) },
      select: SELECT,
    })])
  }
  if (input.paidSince) {
    const refused = await client.activityLog.findMany({
      where: { action: RELEASE_NOT_SENT_ACTION, entityType: 'SALES_ORDER', createdAt: { gte: input.paidSince }, entityId: { not: null } },
      select: { entityId: true, metadata: true },
    })
    const refusedIds = [...new Set(refused.filter((r) => (r.metadata as { reason?: string } | null)?.reason === 'before_switch_on').map((r) => r.entityId as string))]
    lists.push(['paid-since', refusedIds.length === 0 ? [] : await client.salesOrder.findMany({
      where: { ...base, id: { in: refusedIds }, status: { notIn: ['DRAFT', 'CANCELLED', 'PENDING_PAYMENT', 'ON_HOLD'] } },
      select: SELECT,
    })])
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
  const confirmed = await client.emailOutbox.findMany({
    where: { kind: STOREFRONT_CONFIRMATION_KIND, referenceType: 'SalesOrder', referenceId: { in: rows.map((r) => r.orderId) } },
    select: { referenceId: true },
  })
  const done = new Set(confirmed.map((c) => c.referenceId))
  return rows.filter((r) => !done.has(r.orderId)).sort((a, b) => a.placedAt.getTime() - b.placedAt.getTime())
}

const ACTION: Record<HandSendRow['population'], string> = {
  'held-unpaid': 'UNPAID - send nothing now; confirm by hand when paid (see --paid-since)',
  'gap-paid': 'PAID - send the confirmation now',
  'paid-since': 'PAID - send the confirmation now',
}

export function renderHandSendList(rows: readonly HandSendRow[]): string {
  if (rows.length === 0) return 'No storefront order needs a hand-sent confirmation.'
  const lines = [`${rows.length} storefront order(s) (IMS will not send these):`]
  for (const r of rows) lines.push(`${r.population.padEnd(11)} ${r.reference}  ${r.status}  placed ${r.placedAt.toISOString()}  ${r.customerEmail}  ${ACTION[r.population]}`)
  return lines.join('\n')
}
