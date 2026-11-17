/**
 * INVOICING STATE: the orthogonal invoicing dimension of a sales order (NOT_INVOICED / PARTIALLY_INVOICED /
 * FULLY_INVOICED), stored on `SalesOrder.invoicingState`. It mirrors RefundDisposition (`SalesOrder.refundStatus`):
 * the fulfilment `status` says where the order is in its lifecycle, this says whether an invoice exists for it, and
 * the two are independent (a SHIPPED order can be NOT_INVOICED, a CANCELLED one keeps the state it had).
 *
 * IT IS DERIVED, NEVER SET BY HAND. `deriveInvoicingState` is a pure function of the evidence below and
 * `recomputeSalesOrderInvoicingState` is the ONE writer of the column: every site that creates, retires, fails,
 * revives or links a sales invoice calls it, and `repairInvoicingStates` (scripts/recompute-invoicing-state.ts) re-derives
 * the whole table idempotently, which is also how an existing database is made correct.
 *
 * WHAT COUNTS AS INVOICED (any one is enough):
 *   1. IMS-POSTED OR QUEUED. An accounting sync row of type SALES_INVOICE or SALES_INVOICE_UPDATE for the order whose
 *      work slot is OCCUPIED (PENDING, PROCESSING or SYNCED: `workSlotStanding`, lib/domain/accounting/ledger-standing.ts)
 *      or that names a document (a FAILED row carrying a document id is a document that exists). So a queued invoice
 *      counts the moment it is queued, and a posted one stays counted.
 *   2. LINKED. `accountingInvoiceId` is set: the ledger document is linked to the order, whatever happened to the row.
 *   3. XEROOM-FOUND. During the parallel phase the sales invoicing incumbent raises the ledger invoice, and IMS only
 *      mirrors its NUMBER (`_wcpdf_invoice_number`). `invoiceNumber` set on an order linked to a connector that SUPPLIES
 *      the number (`invoiceNumberIsExternallySupplied`) is that number and counts. An `invoiceNumber` on any other order
 *      was minted by IMS and is not evidence of an invoice (the same rule as INVOICED_ORDER_WHERE).
 *
 * WHAT DOES NOT COUNT:
 *   - a shadow (CANCELLED, HELD_SHADOW basis): IMS recorded that it WOULD have invoiced and the incumbent owns the
 *     operation; if the incumbent's number is on the order, rule 3 counts it, never the shadow;
 *   - a FAILED row with no document id (nothing reached the ledger), a CANCELLED row retired without a document id
 *     (the order was cancelled before it posted; an operator settled NOT_POSTED; a verified reversal);
 *   - credit notes and refunds. A credit note REDUCES what is owed on an invoice, it does not un-invoice the order: a
 *     fully refunded order is still FULLY_INVOICED, and CREDIT_NOTE rows are not read here at all.
 *   - the order's lifecycle status. A CANCELLED order keeps its invoicing state, so the history stays visible.
 *
 * PARTIAL VS FULL. IMS invoices a whole order (a sales invoice is reconciled to the order's own total before it is
 * queued; there is no per-shipment invoice and no consolidated invoice). The only measurable shortfall is therefore
 * QUANTITY: the quantity on the latest counted IMS invoice document's lines against the quantity on the order's lines now.
 * Fewer units invoiced than ordered is PARTIALLY_INVOICED; at least as many is FULLY_INVOICED. A document whose lines are
 * not readable (retention compacted the payload) and a Xeroom-found or link-only invoice (IMS cannot read what that
 * document covers; the incumbent raises one invoice for the whole order) read FULLY_INVOICED: an invoice exists, and
 * IMS does not guess a shortfall it cannot measure.
 *
 * VOIDED. IMS retires an invoice by proving it never posted (the sweep that retires an unposted invoice on a cancelled
 * order, the orphan sweep, an operator's NOT_POSTED settlement) or by releasing the link; when no evidence above stands
 * the state returns to NOT_INVOICED. A document the ledger itself later marks VOIDED keeps its link and is not
 * un-invoiced here (see the PR notes).
 */

import { Prisma } from '@/app/generated/prisma/client'
import type { InvoicingState } from '@/lib/domain/sales/invoicing-state-labels'
import { invoiceNumberIsExternallySupplied } from '@/lib/domain/accounting/sales-invoice-number'
import { LEDGER_STANDING_SELECT, namesADocument, workSlotStanding } from '@/lib/domain/accounting/ledger-standing'

export { INVOICING_STATES, INVOICING_STATE_LABELS, type InvoicingState } from '@/lib/domain/sales/invoicing-state-labels'

/** The sync types whose rows are an invoice for the order. CREDIT_NOTE is deliberately absent: a credit note does not un-invoice. */
export const INVOICING_SYNC_TYPES = ['SALES_INVOICE', 'SALES_INVOICE_UPDATE'] as const

export type InvoicingEvidenceRow = {
  type: string
  status: string
  externalTransactionId: string | null
  abandonedBeforeRemoteCall: boolean | null
  settlementBasis: string | null
  createdAt: Date
  payload: unknown
}

export type InvoicingEvidence = {
  accountingInvoiceId: string | null
  invoiceNumber: string | null
  /** The connectors the order is linked to (`shoppingLinks`). */
  linkedConnectors: readonly string[]
  /** Units on the order's lines now. */
  orderedQuantity: number
  /** The order's sales-invoice sync rows, any status. */
  rows: readonly InvoicingEvidenceRow[]
}

/** The quantity a sync row's stored payload invoices, or null when the payload is not readable. */
export function invoicedQuantityOfPayload(payload: unknown): number | null {
  if (payload === null || typeof payload !== 'object') return null
  const lines = (payload as { lines?: unknown }).lines
  if (!Array.isArray(lines)) return null
  let total = 0
  for (const line of lines) {
    const q = line && typeof line === 'object' ? Number((line as { quantity?: unknown }).quantity) : Number.NaN
    if (!Number.isFinite(q)) return null
    total += q
  }
  return total
}

/** Is this row an invoice IMS has queued or posted (rule 1)? */
export function rowCountsAsInvoice(row: InvoicingEvidenceRow): boolean {
  return (INVOICING_SYNC_TYPES as readonly string[]).includes(row.type)
    && (workSlotStanding(row).slot === 'OCCUPIED' || namesADocument(row))
}

/** THE DERIVATION. Pure. */
export function deriveInvoicingState(evidence: InvoicingEvidence): InvoicingState {
  const counted = evidence.rows.filter(rowCountsAsInvoice)
  const linked = Boolean(evidence.accountingInvoiceId)
  const xeroom = Boolean(evidence.invoiceNumber?.trim()) && invoiceNumberIsExternallySupplied(evidence.linkedConnectors)
  if (counted.length === 0 && !linked && !xeroom) return 'NOT_INVOICED'

  // The latest counted document that states its lines (an UPDATE restates the whole invoice, so the newest wins).
  const latest = [...counted].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]
  const invoiced = latest ? invoicedQuantityOfPayload(latest.payload) : null
  if (invoiced === null) return 'FULLY_INVOICED'
  // Half a thousandth of a unit: quantities are stored to four decimals.
  return invoiced + 0.0005 < evidence.orderedQuantity ? 'PARTIALLY_INVOICED' : 'FULLY_INVOICED'
}

export type InvoicingStateClient = {
  salesOrder: {
    findUnique(args: unknown): Promise<unknown>
    updateMany(args: unknown): Promise<{ count: number }>
  }
  accountingSyncLog: { findMany(args: unknown): Promise<unknown> }
  $queryRaw?: (query: Prisma.Sql) => Promise<unknown>
  $transaction?: unknown
  /** Present on the top-level client only; an interactive transaction client has no $connect. */
  $connect?: unknown
}

async function readEvidence(client: InvoicingStateClient, orderId: string): Promise<InvoicingEvidence | null> {
  const order = (await client.salesOrder.findUnique({
    where: { id: orderId },
    select: {
      accountingInvoiceId: true,
      invoiceNumber: true,
      shoppingLinks: { select: { connector: true } },
      lines: { select: { qty: true } },
    },
  })) as {
    accountingInvoiceId: string | null
    invoiceNumber: string | null
    shoppingLinks: { connector: string }[]
    lines: { qty: Prisma.Decimal | number | string }[]
  } | null
  if (!order) return null
  const rows = (await client.accountingSyncLog.findMany({
    where: { referenceType: 'SalesOrder', referenceId: orderId, type: { in: [...INVOICING_SYNC_TYPES] } },
    select: { ...LEDGER_STANDING_SELECT, type: true, createdAt: true, payload: true },
  })) as InvoicingEvidenceRow[]
  return {
    accountingInvoiceId: order.accountingInvoiceId,
    invoiceNumber: order.invoiceNumber,
    linkedConnectors: (order.shoppingLinks ?? []).map((l) => l.connector),
    orderedQuantity: (order.lines ?? []).reduce((sum, l) => sum + Number(l.qty), 0),
    rows: Array.isArray(rows) ? rows : [],
  }
}

/** Whether the client can answer the recompute. Production clients always can; a unit test's narrow stand-in for a transaction may not, and then there is nothing to derive from. */
function canRecompute(client: InvoicingStateClient): boolean {
  return typeof client.salesOrder?.findUnique === 'function'
    && typeof client.salesOrder?.updateMany === 'function'
    && typeof client.accountingSyncLog?.findMany === 'function'
}

async function recomputeWithin(client: InvoicingStateClient, orderId: string): Promise<{ state: InvoicingState | null; changed: boolean }> {
  if (!canRecompute(client)) return { state: null, changed: false }
  // The order row lock, taken through the one lock helper (lockSalesOrder), and only if this transaction does not hold it already. It serialises two
  // writers of the SAME order: the second reads the first one's committed rows after it acquires the lock, so two invoices racing cannot leave a stale value.
  await lockOrderFirst(client, orderId)
  const evidence = await readEvidence(client, orderId)
  if (!evidence) return { state: null, changed: false }
  const state = deriveInvoicingState(evidence)
  // A compare-and-set on the column: an unchanged value writes nothing (no row version, no updatedAt bump).
  const { count } = await client.salesOrder.updateMany({ where: { id: orderId, invoicingState: { not: state } }, data: { invoicingState: state } })
  return { state, changed: count > 0 }
}

/**
 * THE ONE WRITER OF `SalesOrder.invoicingState`. Re-reads the evidence and writes the derived value.
 *
 * Pass the caller's TRANSACTION when the invoice change is in one (the recompute commits or rolls back with it and takes
 * the order row lock there), or the plain client AFTER the change has committed (it then runs its own short transaction).
 * A site that has written an accounting sync row must not take the order lock afterwards inside the same transaction
 * unless it already holds it: the cancellation path locks the order FIRST and then the sync rows, so the opposite order
 * is a deadlock. Those sites recompute after they commit, and the sweep heals a crash in between.
 */
export async function recomputeSalesOrderInvoicingState(
  client: InvoicingStateClient,
  orderId: string,
): Promise<{ state: InvoicingState | null; changed: boolean }> {
  if (!canRecompute(client)) return { state: null, changed: false }
  if (typeof client.$connect === 'function' && typeof client.$transaction === 'function') {
    return (client as unknown as { $transaction<T>(fn: (tx: InvoicingStateClient) => Promise<T>): Promise<T> }).$transaction((tx) => recomputeWithin(tx, orderId))
  }
  return recomputeWithin(client, orderId)
}

/**
 * The write-site entry for a sync row the caller has just written or moved: recomputes the order the row belongs to, and does
 * nothing for any other row (a payment, a credit note, a purchase document). A client with no `salesOrder` delegate is the
 * narrow stand-in a unit test hands a pure writer; production clients always have it.
 */
export async function recomputeInvoicingStateForRow(
  client: unknown,
  row: { type: string; referenceType: string; referenceId: string },
): Promise<void> {
  if (row.referenceType !== 'SalesOrder' || !(INVOICING_SYNC_TYPES as readonly string[]).includes(row.type)) return
  const c = client as Partial<InvoicingStateClient>
  if (!canRecompute(c as InvoicingStateClient)) return
  await recomputeSalesOrderInvoicingState(c as InvoicingStateClient, row.referenceId)
}

/**
 * THE CANONICAL LOCK ORDER: THE ORDER ROW FIRST, THEN THE SYNC ROWS. Cancellation (`lockSalesOrder`, then the sync-row retirement) is the
 * reference. A writer that moves a sales-invoice sync row inside a transaction must call this (or `lockOrderForRow`) BEFORE its first
 * write to that row; taking the order lock after the row is the opposite order and can deadlock against a cancellation. A no-op outside a
 * transaction, when the transaction already holds the lock, and for a client that cannot take one (a unit test's stand-in).
 */
export async function lockOrderFirst(client: unknown, orderId: string): Promise<void> {
  const c = client as Partial<InvoicingStateClient> | null
  if (!c || typeof c.$queryRaw !== 'function' || typeof c.$connect === 'function') return
  const { hasLockedSalesOrder, lockSalesOrder } = await import('@/lib/domain/sales/allocation-service')
  if (hasLockedSalesOrder(c as never, orderId)) return
  await lockSalesOrder(c as never, orderId)
}

/** Several orders, in id order, so two writers locking overlapping sets cannot take them in opposite orders. */
export async function lockOrdersFirst(client: unknown, orderIds: readonly string[]): Promise<void> {
  for (const id of [...new Set(orderIds)].sort()) await lockOrderFirst(client, id)
}

/** `lockOrderFirst` for the order a sync row belongs to; nothing for any row that is not a sales invoice. */
export async function lockOrderForRow(client: unknown, row: { type: string; referenceType: string; referenceId: string }): Promise<void> {
  if (row.referenceType !== 'SalesOrder' || !(INVOICING_SYNC_TYPES as readonly string[]).includes(row.type)) return
  await lockOrderFirst(client, row.referenceId)
}

/** `lockOrdersFirst` for the orders of the sales-invoice rows matching `where` (read before the write that moves them). */
export async function lockOrdersOfInvoiceRows(client: unknown, where: Prisma.AccountingSyncLogWhereInput): Promise<void> {
  await lockOrdersFirst(client, await invoicingOrderIdsForRows(client, where))
}

/** The orders the sales-invoice rows matching `where` belong to. Read BEFORE a write that moves those rows out of `where`. */
export async function invoicingOrderIdsForRows(client: unknown, where: Prisma.AccountingSyncLogWhereInput): Promise<string[]> {
  const c = client as InvoicingStateClient
  if (!canRecompute(c)) return []
  const rows = (await c.accountingSyncLog.findMany({
    where: { AND: [where, { referenceType: 'SalesOrder', type: { in: [...INVOICING_SYNC_TYPES] } }] },
    select: { referenceId: true },
  })) as { referenceId: string }[]
  return [...new Set(rows.map((r) => r.referenceId))]
}

/** Recompute a list of orders (as returned by `invoicingOrderIdsForRows`). */
export async function recomputeInvoicingStateForOrders(client: unknown, orderIds: readonly string[]): Promise<void> {
  const c = client as Partial<InvoicingStateClient>
  if (!canRecompute(c as InvoicingStateClient)) return
  for (const id of orderIds) await recomputeSalesOrderInvoicingState(c as InvoicingStateClient, id)
}

/** Recompute every order a set of sync-log rows belongs to (sales-invoice rows only; anything else is ignored). */
export async function recomputeInvoicingStateForSyncLogs(
  client: unknown,
  where: Prisma.AccountingSyncLogWhereInput,
): Promise<number> {
  const ids = await invoicingOrderIdsForRows(client, where)
  await recomputeInvoicingStateForOrders(client, ids)
  return ids.length
}

export type InvoicingRepairClient = InvoicingStateClient & {
  salesOrder: InvoicingStateClient['salesOrder'] & { findMany(args: unknown): Promise<unknown> }
}

/**
 * Re-derives the column for every order (or one batch of them), oldest id first. Idempotent: a second run changes nothing.
 * `limit` bounds one call; pass the returned `nextCursor` back as `after` to continue.
 */
export async function repairInvoicingStates(
  client: InvoicingRepairClient,
  options: { limit?: number; after?: string | null; dryRun?: boolean } = {},
): Promise<{ examined: number; changed: number; nextCursor: string | null }> {
  const limit = options.limit ?? 500
  const batch = (await client.salesOrder.findMany({
    where: options.after ? { id: { gt: options.after } } : {},
    orderBy: { id: 'asc' },
    take: limit,
    select: { id: true, invoicingState: true },
  })) as { id: string; invoicingState: InvoicingState }[]
  let changed = 0
  for (const order of batch) {
    if (options.dryRun) {
      const evidence = await readEvidence(client, order.id)
      if (evidence && deriveInvoicingState(evidence) !== order.invoicingState) changed += 1
      continue
    }
    const result = await recomputeSalesOrderInvoicingState(client, order.id)
    if (result.changed) changed += 1
  }
  return { examined: batch.length, changed, nextCursor: batch.length === limit ? batch[batch.length - 1]!.id : null }
}
