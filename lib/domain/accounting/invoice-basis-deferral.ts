/**
 * o3d-r2nkq (FRS 102 s23.10) — DEFERRING THE REVENUE OF AN UNPAID INVOICE UNTIL THE GOODS SHIP.
 *
 * Group A1 defers an order's unshipped revenue (DR Sales / CR Unearned Revenue) once the order is PAID. An unpaid order
 * whose invoice IMS posted as AUTHORISED (a manual or B2B order: the invoice goes out when the order is created or a draft
 * is finalised) therefore keeps that revenue in Sales until payment, although the goods have not left.
 *
 * Behind `xero_defer_unpaid_invoiced_revenue_enabled` (default OFF; owner rulings 2026-11-26):
 *
 *  - ON, Group A1 also defers an UNPAID order, with exactly the machinery and accounts a paid order uses (only the
 *    part not yet shipped; shipments costed before the deferral stay in Sales), when IMS can PROVE its invoice reached
 *    Xero as an AUTHORISED document AT OR AFTER the instant the switch went on. Invoices already open at switch-on stay
 *    in Sales for manual review: nothing is backfilled. A DRAFT-mode invoice posts nothing in Xero and is never deferred.
 *  - The deferral is dated on the invoice's DOCUMENT day (the day Sales was credited) and stamped
 *    `revenueDeferralBasis = INVOICE` with that day in `revenueDeferralEventAt`. A2, Group B and the pre-batch refund
 *    adjustments date from it instead of the payment day, so each shipment releases its revenue on the day it ships.
 *  - A payment later removed from such an order only reopens the receivable: no chargeback credit note is raised,
 *    and the revenue-without-payment check does not apply (the order was never deferred because it was paid).
 *
 * OFF, nothing here is consulted by a write path: the basis columns stay NULL, and NULL reads as PAID everywhere.
 */
import type { Prisma } from '@/app/generated/prisma/client'

import { recoverPostedBusinessDate } from '@/lib/domain/accounting/back-reference'
import { businessDay } from '@/lib/domain/accounting/daily-batch-event-date'

/** The switch (default OFF) and its switch-on instant, written by `npm run settings:set` (lib/domain/settings/system-switches.ts, which holds the same literals). */
export const INVOICE_BASIS_DEFERRAL_SWITCH_KEY = 'xero_defer_unpaid_invoiced_revenue_enabled'
export const INVOICE_BASIS_DEFERRAL_ENABLED_AT_KEY = 'xero_defer_unpaid_invoiced_revenue_enabled_at'

type SettingReader = Pick<Prisma.TransactionClient, 'setting'>
type SyncLogReader = Pick<Prisma.TransactionClient, 'accountingSyncLog'>

export type InvoiceBasisDeferralSwitch = { on: true; since: Date } | { on: false }

/**
 * ON only for the exact string `true` AND a readable switch-on instant. A switch turned on by a direct write (SQL, a
 * restore) has no instant to anchor "posted after switch-on", and reads OFF rather than deferring every open invoice.
 */
export async function readInvoiceBasisDeferralSwitch(client: SettingReader): Promise<InvoiceBasisDeferralSwitch> {
  const rows = await client.setting.findMany({
    where: { key: { in: [INVOICE_BASIS_DEFERRAL_SWITCH_KEY, INVOICE_BASIS_DEFERRAL_ENABLED_AT_KEY] } },
    select: { key: true, value: true },
  })
  const value = rows.find((row) => row.key === INVOICE_BASIS_DEFERRAL_SWITCH_KEY)?.value
  if (value !== 'true') return { on: false }
  const raw = rows.find((row) => row.key === INVOICE_BASIS_DEFERRAL_ENABLED_AT_KEY)?.value
  if (typeof raw !== 'string' || raw.trim() === '') return { on: false }
  const since = new Date(raw.trim())
  if (Number.isNaN(since.getTime())) return { on: false }
  return { on: true, since }
}

/**
 * The unpaid orders Group A1 may consider under the switch. The proof below decides which of them are deferred; this
 * only narrows the read. Same exclusions as the paid selection.
 */
export const UNPAID_INVOICE_BASIS_A1_WHERE = {
  paidAt: null,
  revenueDeferredDate: null,
  accountingInvoiceId: { not: null },
  status: { notIn: ['CANCELLED', 'DRAFT'] },
  refundStatus: { not: 'FULL' },
} satisfies Prisma.SalesOrderWhereInput

/** What the proof found for one order: the invoice's document day (UTC midnight), the day the deferral is dated. */
export type InvoiceBasisProof = { eventAt: Date }

type ProofRow = {
  type: string
  referenceId: string
  externalTransactionId: string | null
  status: string
  settlementBasis: string | null
  syncedAt: Date | null
  payload: unknown
}

function postingModeOf(payload: unknown): unknown {
  return typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>)._postingMode : undefined
}

/**
 * Pure: which orders carry PROOF that their invoice reached Xero as AUTHORISED at or after `since`.
 *
 * Proof is a SALES_INVOICE row of the order that the CONNECTOR confirmed (status SYNCED, no operator settlement basis),
 * names the order's own invoice id, was synced at or after `since`, was sent with posting mode `submitted` (AUTHORISED)
 * and carries the document date it was sent with. An order with any synced invoice row sent in `draft` mode is refused,
 * whatever else it has. Anything less is not proof, and the order stays in Sales.
 */
export function provenInvoiceBasisOrders(
  orders: ReadonlyArray<{ id: string; accountingInvoiceId: string | null }>,
  rows: ReadonlyArray<ProofRow>,
  since: Date,
): Map<string, InvoiceBasisProof> {
  const proven = new Map<string, InvoiceBasisProof>()
  for (const order of orders) {
    if (!order.accountingInvoiceId) continue
    const own = rows.filter((row) => row.referenceId === order.id && row.status === 'SYNCED')
    if (own.some((row) => postingModeOf(row.payload) === 'draft')) continue
    const create = own
      .filter((row) => row.type === 'SALES_INVOICE'
        && row.externalTransactionId === order.accountingInvoiceId
        && row.settlementBasis === null
        && row.syncedAt !== null
        && row.syncedAt.getTime() >= since.getTime()
        && postingModeOf(row.payload) === 'submitted')
      .sort((a, b) => (a.syncedAt as Date).getTime() - (b.syncedAt as Date).getTime())[0]
    if (!create) continue
    const eventAt = recoverPostedBusinessDate((create.payload ?? {}) as Record<string, unknown>)
    if (!eventAt) continue
    proven.set(order.id, { eventAt })
  }
  return proven
}

/** Read the sync rows the proof needs and apply it. One query for the whole candidate set. */
export async function proveInvoiceBasisOrders(
  client: SyncLogReader,
  orders: ReadonlyArray<{ id: string; accountingInvoiceId: string | null }>,
  since: Date,
): Promise<Map<string, InvoiceBasisProof>> {
  if (orders.length === 0) return new Map()
  const rows = await client.accountingSyncLog.findMany({
    where: {
      referenceType: 'SalesOrder',
      referenceId: { in: orders.map((order) => order.id) },
      type: { in: ['SALES_INVOICE', 'SALES_INVOICE_UPDATE'] },
      status: 'SYNCED',
    },
    select: { type: true, referenceId: true, externalTransactionId: true, status: true, settlementBasis: true, syncedAt: true, payload: true },
  })
  return provenInvoiceBasisOrders(orders, rows, since)
}

/**
 * The day the order's deferral was made from, which A2, Group B and the pre-batch refund adjustments may not date
 * before: the invoice's document day for an INVOICE-basis deferral, the payment day otherwise (NULL basis = PAID,
 * which is every deferral made with the switch off — so with it off this is `businessDay(paidAt)`, as before).
 */
export function deferralAnchorDay(order: {
  paidAt: Date | null | undefined
  revenueDeferralBasis?: string | null
  revenueDeferralEventAt?: Date | null
}): string | null {
  if (order.revenueDeferralBasis === 'INVOICE') return businessDay(order.revenueDeferralEventAt)
  return businessDay(order.paidAt)
}

/** An INVOICE-basis deferral was not made because the order was paid: a removed payment owes no revenue unwind. */
export function isInvoiceBasisDeferral(order: { revenueDeferralBasis?: string | null }): boolean {
  return order.revenueDeferralBasis === 'INVOICE'
}
