/**
 * Unpaid-invoice deferral (FRS 102 s23.10) — DEFERRING THE REVENUE OF AN UNPAID INVOICE UNTIL THE GOODS SHIP.
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
import { subtractMoney, toDecimal } from '@/lib/domain/math/decimal'
import { LEDGER_STANDING_SELECT, ledgerStanding, mayHaveReachedLedger } from '@/lib/domain/accounting/ledger-standing'

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
  // The switch first, and the instant only when it is on: with it off this is ONE read of one row.
  const value = (await client.setting.findUnique({ where: { key: INVOICE_BASIS_DEFERRAL_SWITCH_KEY }, select: { value: true } }))?.value
  if (value !== 'true') return { on: false }
  const raw = (await client.setting.findUnique({ where: { key: INVOICE_BASIS_DEFERRAL_ENABLED_AT_KEY }, select: { value: true } }))?.value
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
  abandonedBeforeRemoteCall: boolean | null
  syncedAt: Date | null
  payload: unknown
}

function postingModeOf(payload: unknown): unknown {
  return typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>)._postingMode : undefined
}

/**
 * Pure: which orders carry PROOF that their invoice reached Xero as AUTHORISED at or after `since`.
 *
 * Proof is a SALES_INVOICE row of the order whose ledger standing is CONFIRMED_POSTED (the connector's own writeback,
 * never an operator's assertion; lib/domain/accounting/ledger-standing.ts), names the order's own invoice id, was synced
 * at or after `since`, was sent with posting mode `submitted` (AUTHORISED) and carries the document date it was sent with.
 * An order with any invoice row that may have reached the ledger in `draft` mode is refused, whatever else it has.
 * Anything less is not proof, and the order stays in Sales.
 */
export function provenInvoiceBasisOrders(
  orders: ReadonlyArray<{ id: string; accountingInvoiceId: string | null }>,
  rows: ReadonlyArray<ProofRow>,
  since: Date,
): Map<string, InvoiceBasisProof> {
  const proven = new Map<string, InvoiceBasisProof>()
  for (const order of orders) {
    if (!order.accountingInvoiceId) continue
    const own = rows.filter((row) => row.referenceId === order.id)
    if (own.some((row) => mayHaveReachedLedger(row) && postingModeOf(row.payload) === 'draft')) continue
    const create = own
      .filter((row) => row.type === 'SALES_INVOICE'
        && ledgerStanding(row) === 'CONFIRMED_POSTED'
        && row.settlementBasis === null
        && row.externalTransactionId === order.accountingInvoiceId
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
    },
    select: { ...LEDGER_STANDING_SELECT, type: true, referenceId: true, syncedAt: true, payload: true },
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

// ---------------------------------------------------------------------------------------------------------------------
// UNWINDING AN INVOICE-BASIS DEFERRAL WHOSE INVOICE IS GONE.
//
// The deferral (DR Sales / CR Unearned Revenue) was made because the invoice credited Sales. When that invoice is deleted
// or voided (IMS's document delete completing, or Xero reporting it VOIDED), Xero reverses the invoice's Sales credit but
// the deferral stays in Unearned Revenue, and nothing would ever release it: no shipment of a voided invoice recognises
// revenue, and a cancelled order never ships. So the moment IMS learns the invoice is gone it records the obligation on
// the order (`revenueDeferralUnwindOwedAt`, in the same transaction), and the daily batch posts the reversal
// (DR Unearned Revenue / CR Sales) for exactly what is still open, recording the pounds and the journal.
// ---------------------------------------------------------------------------------------------------------------------

export type InvoiceBasisUnwindReason = 'INVOICE_DELETED' | 'INVOICE_VOIDED'

type UnwindMarkClient = Pick<Prisma.TransactionClient, 'salesOrder'>

/**
 * Record that an INVOICE-basis deferral is owed an unwind. Idempotent: only an order deferred from its invoice, with no
 * unwind owed or done yet, is marked. Returns how many orders were marked. A PAID-basis deferral is never touched: its
 * deferral came from the payment, and the refund and chargeback paths own it.
 */
export async function markInvoiceBasisDeferralUnwindOwed(
  client: UnwindMarkClient,
  target: { orders?: ReadonlyArray<{ orderId: string; invoiceId: string }>; accountingInvoiceIds?: readonly string[] },
  reason: InvoiceBasisUnwindReason,
  at: Date = new Date(),
): Promise<number> {
  // One statement per invoice, so each order records WHICH invoice its unwind is for (the cancel compares it).
  const marks: Array<{ where: Prisma.SalesOrderWhereInput; invoiceId: string }> = [
    ...(target.orders ?? []).map((row) => ({ where: { id: row.orderId }, invoiceId: row.invoiceId })),
    ...(target.accountingInvoiceIds ?? []).map((invoiceId) => ({ where: { accountingInvoiceId: invoiceId }, invoiceId })),
  ]
  let marked = 0
  for (const mark of marks) {
    const result = await client.salesOrder.updateMany({
      where: {
        ...mark.where,
        revenueDeferralBasis: 'INVOICE',
        revenueDeferredDate: { not: null },
        revenueDeferralUnwindOwedAt: null,
        revenueDeferralUnwoundAmount: null,
      },
      data: { revenueDeferralUnwindOwedAt: at, revenueDeferralUnwindReason: reason, revenueDeferralUnwindInvoiceId: mark.invoiceId },
    })
    marked += result.count
  }
  return marked
}

/** The facts the open deferral is reckoned from: all durable (order, shipment and refund rows), never sync-log rows, which retention deletes. */
export type OpenDeferralInputs = {
  unearnedRevenueAmount: Prisma.Decimal | number | string | null
  revenueDeferralUnwoundAmount?: Prisma.Decimal | number | string | null
  shipments: ReadonlyArray<{ shipmentJournalDate: Date | null; revenueRecognizedAmount: Prisma.Decimal | number | string | null }>
  refunds: ReadonlyArray<{ id: string; deferralAdjustmentRef?: string | null; unearnedReversedAmount: Prisma.Decimal | number | string | null; reversalStagingState?: string | null; accountingRetryRequired?: boolean | null }>
}

/**
 * Pure: how much of an order's deferral is still in Unearned Revenue — what A1 stored, less what its journaled shipments
 * recognised, less what each refund recorded taking out, less any unwind already posted. Exact decimals. A refund whose
 * reversal is not durably recorded (or still owes a retry) makes the figure unprovable: the caller refuses rather than
 * reverse a figure that may already have been taken (the refund path's own rule).
 */
export function openInvoiceBasisDeferral(order: OpenDeferralInputs): { ok: true; open: Prisma.Decimal } | { ok: false; reason: string } {
  let open = toDecimal(order.unearnedRevenueAmount ?? 0)
  for (const shipment of order.shipments) {
    if (shipment.shipmentJournalDate) open = subtractMoney(open, shipment.revenueRecognizedAmount ?? 0)
  }
  for (const refund of order.refunds) {
    // A refund entered before the first run was netted out of the deferral itself (its adjustment journal); it took nothing later.
    if (refund.deferralAdjustmentRef) continue
    if (refund.accountingRetryRequired) return { ok: false, reason: `refund ${refund.id} still owes an accounting retry` }
    if (refund.unearnedReversedAmount != null) {
      open = subtractMoney(open, refund.unearnedReversedAmount)
    } else if (refund.reversalStagingState !== 'NOT_STAGED') {
      return { ok: false, reason: `refund ${refund.id} recorded no unearned-revenue reversal amount` }
    }
  }
  open = subtractMoney(open, order.revenueDeferralUnwoundAmount ?? 0)
  return { ok: true, open: open.isNegative() ? toDecimal(0) : open.toDecimalPlaces(2) }
}

/** The orders the daily batch owes an unwind: marked, and not yet unwound. */
export const INVOICE_BASIS_UNWIND_OWED_WHERE = {
  revenueDeferralBasis: 'INVOICE',
  revenueDeferredDate: { not: null },
  revenueDeferralUnwindOwedAt: { not: null },
  revenueDeferralUnwoundAmount: null,
} satisfies Prisma.SalesOrderWhereInput

/**
 * Which of these A1 deferral journals may have reached the ledger (judged by ledgerStanding: anything but PROVEN_NOT_POSTED
 * counts, so a queued journal counts, as it will post before or after the unwind and the account nets either way). A
 * deferral journal with no row at all, or only rows proven never sent, is not unwound: reversing a credit that never
 * landed would put the pounds into Sales twice.
 */
export async function deferralJournalsThatMayHavePosted(client: SyncLogReader, refs: readonly string[]): Promise<Set<string>> {
  if (refs.length === 0) return new Set()
  const rows = await client.accountingSyncLog.findMany({
    where: { type: 'DAILY_BATCH_REVENUE_DEFERRAL', referenceId: { in: [...refs] } },
    select: { ...LEDGER_STANDING_SELECT, referenceId: true },
  })
  // No row at all is refused, never assumed: retention does not prune posted daily-batch rows, so a missing row is
  // as likely a cancelled, never-posted journal, and reversing it would put the pounds into Sales a second time.
  return new Set(rows.filter((row) => mayHaveReachedLedger(row)).map((row) => row.referenceId))
}

/** Prisma expands `{ in: [...] }` into one bind parameter per id; reads over many ids are chunked. */
export const INVOICE_BASIS_ID_CHUNK = 1000

function chunk<T>(items: readonly T[], size = INVOICE_BASIS_ID_CHUNK): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * The unpaid orders that may qualify, found from the INVOICE side and bounded by time: sales-invoice rows of a sales
 * order synced at or after the switch-on instant (so the read never grows with the open invoices from before
 * switch-on, which stay in Sales), then those orders that are still unpaid and undeferred, then the proof over them.
 * Every `in` list is chunked. Returns the proofs, keyed by order id.
 */
export async function findProvenInvoiceBasisCandidates(
  client: SyncLogReader & Pick<Prisma.TransactionClient, 'salesOrder'>,
  since: Date,
): Promise<Map<string, InvoiceBasisProof>> {
  const posted = await client.accountingSyncLog.findMany({
    where: { type: 'SALES_INVOICE', referenceType: 'SalesOrder', syncedAt: { gte: since } },
    select: { referenceId: true },
    distinct: ['referenceId'],
  })
  const orderIds = [...new Set(posted.map((row) => row.referenceId))].sort()
  const candidates: Array<{ id: string; accountingInvoiceId: string | null }> = []
  for (const ids of chunk(orderIds)) {
    candidates.push(...await client.salesOrder.findMany({
      where: { ...UNPAID_INVOICE_BASIS_A1_WHERE, id: { in: ids } },
      select: { id: true, accountingInvoiceId: true },
    }))
  }
  const proofs = new Map<string, InvoiceBasisProof>()
  for (const group of chunk(candidates)) {
    for (const [id, proof] of await proveInvoiceBasisOrders(client, group, since)) proofs.set(id, proof)
  }
  return proofs
}

/**
 * Unwound INVOICE-basis orders that may be RE-deferred: unwound (or unwound with nothing open), still carrying an invoice,
 * not cancelled, drafted or fully refunded. Whether the invoice is a NEW one proved AUTHORISED after the unwind was owed
 * is decided by the proof, per order.
 */
export const INVOICE_BASIS_REDEFER_WHERE = {
  revenueDeferralBasis: 'INVOICE',
  revenueDeferredDate: { not: null },
  revenueDeferralUnwoundAmount: { not: null },
  accountingInvoiceId: { not: null },
  status: { notIn: ['CANCELLED', 'DRAFT'] },
  refundStatus: { not: 'FULL' },
} satisfies Prisma.SalesOrderWhereInput
