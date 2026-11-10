/**
 * Which purchase orders a SUPPLIER login may see, and in what role.
 *
 * A purchase order is the buyer's own work in progress until it is sent. A
 * DRAFT carries quantities, products and prices the buyer is still weighing, and
 * the supplier must not see it, open it, quote on it or download its PDF. Every
 * supplier-facing read and write goes through this module so the rule lives in
 * one place.
 */
import type { Prisma } from '@/app/generated/prisma/client'

/** RFQs the supplier can still answer: the buyer has sent them, no quote is in yet. */
export const SUPPLIER_QUOTABLE_STATUSES = ['RFQ_SENT'] as const

/**
 * RFQs the supplier can open: the quotable ones, plus the ones already quoted
 * (read-only), so submitting a quote lands on a confirmation, not a 404.
 */
export const SUPPLIER_RFQ_VIEWABLE_STATUSES = ['RFQ_SENT', 'QUOTE_RECEIVED'] as const

/**
 * Orders the buyer has actually sent. A DRAFT never qualifies, and neither does a
 * CANCELLED order that was never sent (a draft the buyer abandoned).
 */
export function supplierSentPurchaseOrderWhere(): Prisma.PurchaseOrderWhereInput {
  return {
    status: { not: 'DRAFT' },
    NOT: { status: 'CANCELLED', rfqSentAt: null, poSentAt: null },
  }
}
