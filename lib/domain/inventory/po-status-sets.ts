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
