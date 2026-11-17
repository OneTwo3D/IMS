/**
 * The write-site entry points of invoicing-state.ts, behind a dynamic import.
 *
 * The derivation reads the ledger-standing rules, and those sit in an import cycle with the very modules that write sync rows
 * (sync-log-attempt, sync-log-row, the sweeps). A static import from a write site would make that cycle evaluate in a different
 * order and fail with "Cannot access ... before initialization". This leaf has no static value imports, so every write site can
 * import it safely and the derivation loads on first use.
 */
import type { Prisma } from '@/app/generated/prisma/client'
import type { InvoicingStateClient } from '@/lib/domain/sales/invoicing-state'

export type { InvoicingStateClient }

const load = () => import('@/lib/domain/sales/invoicing-state')

export async function recomputeSalesOrderInvoicingState(client: InvoicingStateClient, orderId: string) {
  return (await load()).recomputeSalesOrderInvoicingState(client, orderId)
}
export async function recomputeInvoicingStateForRow(client: unknown, row: { type: string; referenceType: string; referenceId: string }) {
  return (await load()).recomputeInvoicingStateForRow(client, row)
}
export async function recomputeInvoicingStateForSyncLogs(client: unknown, where: Prisma.AccountingSyncLogWhereInput) {
  return (await load()).recomputeInvoicingStateForSyncLogs(client, where)
}
export async function invoicingOrderIdsForRows(client: unknown, where: Prisma.AccountingSyncLogWhereInput) {
  return (await load()).invoicingOrderIdsForRows(client, where)
}
export async function recomputeInvoicingStateForOrders(client: unknown, orderIds: readonly string[]) {
  return (await load()).recomputeInvoicingStateForOrders(client, orderIds)
}
