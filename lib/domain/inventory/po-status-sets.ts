import { Prisma, PurchaseOrderStatus } from '@/app/generated/prisma/client'

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

/**
 * Statuses that by themselves PROVE the PO was ordered — they are only reachable via PO_SENT in the
 * transition graph (PURCHASE_ORDER_TRANSITIONS). Used to identify committed history robustly even for
 * legacy/imported rows where poSentAt was never stamped. CLOSED is deliberately NOT here: the graph
 * allows RFQ_SENT→CLOSED and QUOTE_RECEIVED→CLOSED, so a CLOSED PO may never have been ordered — only
 * poSentAt disambiguates it. PO_SENT itself is omitted because it always carries poSentAt.
 */
export const ORDERED_EVIDENCE_PO_STATUSES: PurchaseOrderStatus[] = [
  PurchaseOrderStatus.SHIPPED,
  PurchaseOrderStatus.PARTIALLY_RECEIVED,
  PurchaseOrderStatus.RECEIVED,
  PurchaseOrderStatus.INVOICED,
  PurchaseOrderStatus.PARTIALLY_RETURNED,
  PurchaseOrderStatus.RETURNED,
]

/**
 * Prisma WHERE fragment selecting COMMITTED purchase orders for reporting (o3d-27l, o3d-1di) — i.e. POs
 * that were actually ordered, not the DRAFT/RFQ_SENT/QUOTE_RECEIVED quote pipeline and not CANCELLED.
 * "Committed" = poSentAt was stamped (the PO_SENT transition) OR the current status proves an order was
 * placed (ORDERED_EVIDENCE_PO_STATUSES, robust to un-backfilled poSentAt). This correctly EXCLUDES a
 * quote that was abandoned straight to CLOSED (poSentAt null, CLOSED not proof) while INCLUDING a real
 * PO_SENT→CLOSED. Spread into a query's where alongside `type: 'GOODS'` and any date filter.
 */
export const COMMITTED_PURCHASE_ORDER_WHERE: Prisma.PurchaseOrderWhereInput = {
  status: { not: PurchaseOrderStatus.CANCELLED },
  OR: [
    { poSentAt: { not: null } },
    { status: { in: ORDERED_EVIDENCE_PO_STATUSES } },
  ],
}
