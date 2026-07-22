import { PurchaseOrderStatus } from '@/app/generated/prisma/client'

/**
 * Purchase-order statuses that count as COMMITTED INCOMING SUPPLY (o3d-s8n.8).
 *
 * PO_SENT / SHIPPED / PARTIALLY_RECEIVED are ordered-and-real — the goods are on their way. DRAFT,
 * RFQ_SENT and QUOTE_RECEIVED are NOT committed (nothing has been ordered yet) and must not inflate an
 * "Incoming" figure; RECEIVED/CLOSED/RETURNED are done. This is the single source of truth so the
 * product-page Incoming aggregate, its drill-down popup, the replenishment inbound total and the
 * lifecycle-archive "has incoming supply" check cannot drift apart (they previously disagreed — a DRAFT
 * PO inflated the aggregate while the drill-down excluded it, and SHIPPED POs were dropped entirely).
 */
export const INCOMING_PO_STATUSES: PurchaseOrderStatus[] = [
  PurchaseOrderStatus.PO_SENT,
  PurchaseOrderStatus.SHIPPED,
  PurchaseOrderStatus.PARTIALLY_RECEIVED,
]

/**
 * Purchase-order statuses that are NOT yet a commitment — a quote has been requested or received (or
 * the PO is still a draft), but nothing has actually been ordered (o3d-27l/o3d-1di). These must never
 * inflate committed ordering history, spend, average cost, or outstanding-value metrics. Exclude these
 * (plus CANCELLED) from any "what we've committed to buy" report so every column shares one population
 * and the committed/incoming figures are a clean subset. Counterpart to INCOMING_PO_STATUSES
 * (committed-and-still-inbound) for the reporting layer.
 */
export const PRE_COMMITMENT_PO_STATUSES: PurchaseOrderStatus[] = [
  PurchaseOrderStatus.DRAFT,
  PurchaseOrderStatus.RFQ_SENT,
  PurchaseOrderStatus.QUOTE_RECEIVED,
]
