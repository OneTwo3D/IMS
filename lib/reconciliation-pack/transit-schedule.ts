/**
 * THE TRANSIT SCHEDULE (R11's IMS side), from IMS's own transit sub-ledger: the WHOLE of it up to the cycle date.
 *
 * Stock in Transit is a clearing account: a goods or freight bill DEBITS it, and a receipt, a landed-cost reclass, a supplier credit note or a
 * cancellation moves value out. Every posting to the account records a signed row in the transit sub-ledger
 * (lib/domain/accounting/transit-subledger-movement.ts: it lists EVERY source type that posts to the account, and every posting site calls
 * recordTransitSubledgerMovement: PURCHASE_BILL and PURCHASE_BILL_UPDATE and SUPPLIER_CREDIT_NOTE and PURCHASE_ORDER_CANCEL and SUPPLIER_RETURN in
 * app/actions/purchase-orders.ts and lib/domain/purchasing, STOCK_RECEIPT in lib/domain/wms/booked-in-service.ts and the warehouse-system stock sync,
 * LANDED_COST_RECLASS and LANDED_COST_CONSUMED_OFFSET in lib/domain/purchasing/landed-cost-service.ts, CUSTOMER_RETURN_IN_TRANSIT in
 * lib/domain/sales/refund-service.ts). THE SCHEDULE IS THE SUM OF ALL OF IT: the value in transit for each purchase order (its rows by recorded source,
 * summed), open or not, plus the refund-in-transit leg, which belongs to no order. R11 compares that total with the stored Stock in Transit balance of
 * Xero for the cycle date (owner ruling 2026-10-24: the balance holds all of it, so the comparison must).
 *
 * THE NAMED RESIDUE LIST. The purchase orders that are NOT open (not in a committed-incoming status: PO_SENT, SHIPPED, PARTIALLY_RECEIVED, the one definition in
 * lib/domain/inventory/po-status-sets.ts) but still hold a non-zero transit balance are listed by identity with that residue, under outOfPopulation
 * (reported, never judged): a finding detail that explains the total and does not change the outcome by itself. Their value is IN the total.
 *
 * COVERAGE. The sub-ledger records postings only after its recorded coverage watermark (`transit_ledger_coverage_start_date`) and has no opening balance, so the total
 * is complete only if the watermark is recorded, a real date on or before D, EVERY purchase order in IMS (goods and freight, any status, cancelled and closed included) was created
 * after it, EVERY durable source document of every transit source type (bills, receipts, supplier returns, supplier credit notes, landed-cost links and revaluations, customer refunds and
 * return expectations: TRANSIT_SOURCE_DOCUMENTS, none of which the retention job prunes) was created after it, and NO sub-ledger row is dated before it (ImsTransitSchedule.preWatermark);
 * otherwise NO_POPULATION_RECORD, never a short schedule. Nothing rests on a log: the sync-log signal is additional only. A source type this module does not know, or an order IMS does not hold, makes it unreadable.
 * Nothing here reads a clock or a file; the sub-ledger arrives from the one read-only IMS transaction (ims-readers.ts, `transitSchedule`).
 */

import { Prisma } from '@/app/generated/prisma/client'
import { decimalText, parseDecimalStrict } from '@/lib/reconciliation-pack/compare'
import type { PackReasonCode } from '@/lib/reconciliation-pack/constants'
import { TRANSIT_SOURCE_DOCUMENTS, type ImsTransitSchedule } from '@/lib/reconciliation-pack/ims-readers'
import type { KeyPart } from '@/lib/reconciliation-pack/identity'

const Dec = Prisma.Decimal
type Dec = Prisma.Decimal

/** Fixed words, not data: they print as they are. */
export const TRANSIT_BALANCE_TOKEN = 'ledger-transit-balance'
export const TRANSIT_BALANCE_KEY: readonly KeyPart[] = [{ kind: 'sku', raw: TRANSIT_BALANCE_TOKEN }]

export type TransitSchedule =
  | { ok: true; /** The WHOLE sub-ledger to the cycle date (every order, open or not, and the refund leg), six decimals. */ value: string; /** Non-open orders with a non-zero residue: listed by identity, never judged. */ residue: Array<{ key: KeyPart[]; value: string }> }
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
    // The ledger has no opening balance: ANYTHING that can post to transit and predates the watermark can carry history the total does not hold, and offsetting amounts could then
    // make the balance equal a partial ledger. So every purchase order of any type and status, every refund-in-transit source document and every sub-ledger row must postdate it. A row
    // dated before the watermark contradicts the recorded watermark itself (the ledger claims to start there), so the recorded boundary is not trustworthy: NO_POPULATION_RECORD.
    // One count per durable source document kind (TRANSIT_SOURCE_DOCUMENTS); the section must name EVERY kind, each a whole number, or the schedule is unreadable (a missing kind is
    // never zero).
    const pre = section.preWatermark
    if (typeof pre !== 'object' || pre === null) return { ok: false, reason: 'SOURCE_UNREADABLE' }
    for (const document of TRANSIT_SOURCE_DOCUMENTS) { const n = (pre as Record<string, unknown>)[document.kind]; if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) return { ok: false, reason: 'SOURCE_UNREADABLE' } }
    if (TRANSIT_SOURCE_DOCUMENTS.some((document) => pre[document.kind]! > 0)) return { ok: false, reason: 'NO_POPULATION_RECORD' }
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
    const residue: Array<{ key: KeyPart[]; value: string }> = []
    for (const [poId, amount] of [...perOrder.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      total = total.plus(amount)
      if (open.has(poId) || amount.isZero()) continue
      residue.push({ key: [{ kind: 'ims-id', raw: poId }], value: decimalText(amount) })
    }
    const customer = parseDecimalStrict(section.customerReturns)
    if (customer === null) return { ok: false, reason: 'BAD_VALUE' }
    total = total.plus(customer)
    return { ok: true, value: total.toFixed(6), residue }
  } catch {
    return { ok: false, reason: 'INTERNAL_ERROR' }
  }
}
