/**
 * STEP W HAND-SEND LIST (read-only). IMS e-mails a storefront order's confirmation only for an order PLACED after the switch-on instant; WooCommerce
 * confirmed everything before it. Two populations fall between the two senders and are listed here for the owner to confirm by hand:
 *
 *   held       storefront orders still PENDING_PAYMENT or ON_HOLD (bank transfer / cheque, not yet paid). Placed before the switch-on, they were sent
 *              WooCommerce's on-hold e-mail but their processing confirmation is sent on payment, which is after natives-off: nobody sends it.
 *   gap        storefront orders placed from `natives-off` up to the switch-on (WooCommerce was no longer sending, IMS not yet sending).
 *
 * Only orders with no confirmation in the e-mail outbox are listed. IMS NEVER sends for these (a placed-before-the-stamp order is refused by design);
 * the list is for a person. No write, no network.
 */
import { db } from '@/lib/db'
import { STOREFRONT_CONFIRMATION_KIND } from '@/lib/domain/storefront-customer-email/constants'

export type HandSendRow = {
  orderId: string
  reference: string
  status: string
  placedAt: Date
  customerEmail: string
  population: 'held' | 'gap'
}

export type HandSendInput = {
  /** The instant the switch was turned on (or is about to be): the upper bound of the gap. Null = no gap list. */
  switchOnAt: Date | null
  /** The instant WooCommerce's native confirmation e-mail was turned off: the lower bound of the gap. Null = no gap list. */
  nativesOffAt: Date | null
}

export async function listStorefrontHandSendOrders(input: HandSendInput, client: typeof db = db): Promise<HandSendRow[]> {
  const base = { isQuote: false, erasedAt: null, customerEmail: { not: null }, shoppingLinks: { some: {} } } as const
  const select = { id: true, status: true, orderNumber: true, externalOrderNumber: true, externalCreatedAt: true, createdAt: true, customerEmail: true } as const
  const held = await client.salesOrder.findMany({ where: { ...base, status: { in: ['PENDING_PAYMENT', 'ON_HOLD'] } }, select })
  const gap = input.nativesOffAt && input.switchOnAt
    ? await client.salesOrder.findMany({
      where: { ...base, status: { notIn: ['DRAFT', 'CANCELLED'] }, OR: [
        { externalCreatedAt: { gte: input.nativesOffAt, lt: input.switchOnAt } },
        { externalCreatedAt: null, createdAt: { gte: input.nativesOffAt, lt: input.switchOnAt } },
      ] },
      select,
    })
    : []
  const seen = new Set<string>()
  const rows: HandSendRow[] = []
  for (const [population, list] of [['held', held], ['gap', gap]] as const) {
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

export function renderHandSendList(rows: readonly HandSendRow[]): string {
  if (rows.length === 0) return 'No storefront order needs a hand-sent confirmation.'
  const lines = [`${rows.length} storefront order(s) to confirm by hand (IMS will not send these):`]
  for (const r of rows) lines.push(`${r.population.padEnd(5)} ${r.reference}  ${r.status}  placed ${r.placedAt.toISOString()}  ${r.customerEmail}`)
  return lines.join('\n')
}
