/**
 * THE OPEN-PURCHASE-ORDER TRANSIT SCHEDULE (R11's IMS side), from IMS's own transit sub-ledger.
 *
 * Stock in Transit is a clearing account: a goods or freight bill DEBITS it, and a receipt, a landed-cost reclass, a supplier credit note or a
 * cancellation moves value out (lib/domain/accounting/transit-subledger-movement.ts lists every flow). Every posting to the account records a
 * signed row in the transit sub-ledger against the purchase order it belongs to, so the value in transit for ONE purchase order at the cycle
 * date D is the sum of its rows dated up to and including D. THE SCHEDULE is the sum of that figure over the OPEN purchase orders, the goods
 * and freight orders in a committed-incoming status (PO_SENT, SHIPPED, PARTIALLY_RECEIVED: the one definition in
 * lib/domain/inventory/po-status-sets.ts). R11 compares it with the stored Stock in Transit balance of Xero for D.
 *
 * WHAT THE COMPARISON CAN AND CANNOT SEE (stated, decided; owner question in the build report):
 *   - The sub-ledger records postings only after its recorded coverage watermark (`transit_ledger_coverage_start_date`), and has no opening
 *     balance. The schedule is complete only for an order whose whole history is after the watermark, so the watermark must be recorded, a
 *     real date on or before D, and EVERY open order must have been created after it; otherwise the schedule is not proven complete
 *     (NO_POPULATION_RECORD), never short.
 *   - A purchase order that is NOT open but still holds value in transit (a received or closed order whose freight was never reclassed), and the
 *     refund-in-transit leg (goods a customer returned that are not yet back, which belongs to no order), are in the account's balance but
 *     are not "open-order" transit: they are not in the schedule, so the balance differs from it and the item FAILS, and each is LISTED
 *     (out of the population, never judged) with its sub-ledger figure so the difference can be explained.
 *   - A sub-ledger row whose source type this module does not know, or that names an order IMS does not hold, makes the schedule unreadable.
 * Nothing here reads a clock or a file; the sub-ledger arrives from the one read-only IMS transaction (ims-readers.ts, `transitSchedule`).
 */

import { Prisma } from '@/app/generated/prisma/client'
import { decimalText, parseDecimalStrict } from '@/lib/reconciliation-pack/compare'
import type { PackReasonCode } from '@/lib/reconciliation-pack/constants'
import type { ImsTransitSchedule } from '@/lib/reconciliation-pack/ims-readers'
import type { KeyPart } from '@/lib/reconciliation-pack/identity'

const Dec = Prisma.Decimal
type Dec = Prisma.Decimal

/** Fixed words, not data: they print as they are. */
export const TRANSIT_BALANCE_TOKEN = 'ledger-transit-balance'
export const CUSTOMER_RETURN_TRANSIT_TOKEN = 'ledger-transit-customer-return'
export const TRANSIT_BALANCE_KEY: readonly KeyPart[] = [{ kind: 'sku', raw: TRANSIT_BALANCE_TOKEN }]
export const CUSTOMER_RETURN_TRANSIT_KEY: readonly KeyPart[] = [{ kind: 'sku', raw: CUSTOMER_RETURN_TRANSIT_TOKEN }]

export type TransitSchedule =
  | { ok: true; /** The sum of the open orders' transit, six decimals. */ value: string; /** Non-open orders and the refund leg with a non-zero figure: listed, never judged. */ listed: Array<{ key: KeyPart[]; value: string }> }
  | { ok: false; reason: PackReasonCode }

const DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/

/** The schedule for cycle date `asOf` from the section, or the closed reason it cannot be had. Total: never throws. */
export function buildTransitSchedule(section: ImsTransitSchedule, asOf: string): TransitSchedule {
  try {
    if (section.asOf !== asOf) return { ok: false, reason: 'STALE_BASIS' }
    // Coverage: the watermark is the proof that the sub-ledger holds the whole history of an order created after it.
    const watermark = section.coverageStart
    if (watermark === null || !DATE_RE.test(watermark) || watermark > asOf) return { ok: false, reason: 'NO_POPULATION_RECORD' }
    const open = new Map(section.openOrders.map((order) => [order.id, order] as const))
    if (open.size !== section.openOrders.length) return { ok: false, reason: 'DUPLICATE_KEY' }
    for (const order of section.openOrders) {
      const created = order.createdAt.slice(0, 10)
      if (!DATE_RE.test(created)) return { ok: false, reason: 'NO_POPULATION_RECORD' }
      if (created <= watermark) return { ok: false, reason: 'NO_POPULATION_RECORD' }
    }
    const known = new Map(section.orders.map((order) => [order.id, order] as const))
    if (known.size !== section.orders.length) return { ok: false, reason: 'DUPLICATE_KEY' }

    const perOrder = new Map<string, Dec>()
    for (const row of section.net) {
      const amount = parseDecimalStrict(row.net)
      if (amount === null) return { ok: false, reason: 'BAD_VALUE' }
      // Every named order must be one IMS holds: the reader returns every order a row names.
      if (!known.has(row.poId)) return { ok: false, reason: 'BAD_KEY' }
      perOrder.set(row.poId, (perOrder.get(row.poId) ?? new Dec(0)).plus(amount))
    }
    let total = new Dec(0)
    const listed: Array<{ key: KeyPart[]; value: string }> = []
    for (const [poId, amount] of [...perOrder.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (open.has(poId)) { total = total.plus(amount); continue }
      if (amount.isZero()) continue
      listed.push({ key: [{ kind: 'ims-id', raw: poId }], value: decimalText(amount) })
    }
    const customer = parseDecimalStrict(section.customerReturns)
    if (customer === null) return { ok: false, reason: 'BAD_VALUE' }
    if (!customer.isZero()) listed.push({ key: [...CUSTOMER_RETURN_TRANSIT_KEY], value: decimalText(customer) })
    return { ok: true, value: total.toFixed(6), listed }
  } catch {
    return { ok: false, reason: 'INTERNAL_ERROR' }
  }
}
