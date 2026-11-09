import type { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'

type Client = Prisma.TransactionClient | typeof db

/**
 * How many OTHER IMS orders carry this invoice number? The ledger matches numbers case-insensitively and the storefront's number is not unique
 * in IMS, so a document fetched under a number is only this order's while no other order holds it. One probe of the lower("invoiceNumber")
 * index; asked before a fetch, again inside the promotion transaction, and by the reader on every customer download.
 */
export async function otherOrdersHoldingInvoiceNumber(client: Client, orderId: string, invoiceNumber: string): Promise<number> {
  const rows = await client.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM sales_orders
    WHERE lower("invoiceNumber") = lower(${invoiceNumber.trim()}) AND id <> ${orderId}
  `
  return rows[0]?.n ?? 0
}
