/**
 * Server-side search / filter / pagination for the Sales Orders and Purchase Orders lists.
 *
 * These lists used to load the newest 200 rows into the browser and filter THERE, so a search for
 * an older order came back empty and read as "this order does not exist". Everything here builds
 * Prisma `where` clauses so the database does the work across ALL rows, and the page shows a count
 * and a pager.
 *
 * Two rules, each deliberate:
 *   - The DEFAULT view hides finished work (completed/delivered sales orders) and archived rows,
 *     and says so on screen with a count and a one-click way to show them.
 *   - A SEARCH always looks at everything, including completed and archived rows. An archived row
 *     is only hidden from the operational list; it is still a real order a customer may ring about.
 *
 * Archiving is a display concern. Nothing in here touches what any financial report counts.
 */
import type { Prisma } from '@/app/generated/prisma/client'

export const ORDER_LIST_PAGE_SIZE = 50
/** Longest search text sent to the database. */
export const ORDER_LIST_MAX_QUERY_LENGTH = 100
/**
 * Below this length a search is NOT a substring scan (one or two characters would fan out into many
 * case-insensitive scans over every order). Shorter input only matches an order number or reference
 * exactly, and the page asks for more characters.
 */
export const ORDER_LIST_MIN_SUBSTRING_LENGTH = 3

export function isShortListQuery(q: string | null | undefined): boolean {
  const n = normaliseListQuery(q).length
  return n > 0 && n < ORDER_LIST_MIN_SUBSTRING_LENGTH
}

export const SO_STATUSES = [
  'DRAFT', 'PENDING_PAYMENT', 'ON_HOLD', 'PROCESSING', 'ALLOCATED', 'PICKING', 'PACKING',
  'SHIPPED', 'COMPLETED', 'DELIVERED', 'CANCELLED',
] as const
export type SoListStatus = (typeof SO_STATUSES)[number]

export const SO_COMPLETED_STATUSES = ['COMPLETED', 'DELIVERED'] as const satisfies readonly SoListStatus[]

export const PO_STATUSES = [
  'DRAFT', 'RFQ_SENT', 'QUOTE_RECEIVED', 'PO_SENT', 'SHIPPED', 'PARTIALLY_RECEIVED', 'RECEIVED',
  'CLOSED', 'INVOICED', 'PARTIALLY_RETURNED', 'RETURNED', 'CANCELLED',
] as const
export type PoListStatus = (typeof PO_STATUSES)[number]

export type ListPage = { page: number; pageSize: number; total: number; pageCount: number }

export function normaliseListQuery(q: string | null | undefined): string {
  return (q ?? '').trim().slice(0, ORDER_LIST_MAX_QUERY_LENGTH)
}

export function normalisePage(page: number | string | null | undefined): number {
  const n = typeof page === 'string' ? Number.parseInt(page, 10) : page
  return typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1
}

export function normaliseStatuses<T extends string>(raw: readonly string[] | string | null | undefined, allowed: readonly T[]): T[] {
  const list = typeof raw === 'string' ? raw.split(',') : [...(raw ?? [])]
  const set = new Set(allowed as readonly string[])
  return [...new Set(list.map((s) => s.trim()).filter((s) => set.has(s)))] as T[]
}

export function buildListPage(page: number, pageSize: number, total: number): ListPage {
  return { page, pageSize, total, pageCount: Math.max(1, Math.ceil(total / pageSize)) }
}

const eq = (value: string) => ({ equals: value, mode: 'insensitive' as const })
const ci = (value: string) => ({ contains: value, mode: 'insensitive' as const })

export type SoListFilter = {
  q?: string
  statuses?: SoListStatus[]
  /** Show COMPLETED / DELIVERED orders in the default view. Search and an explicit status pick always include them. */
  showCompleted?: boolean
  /** Show archived orders in the default view. Search always includes them. */
  includeArchived?: boolean
}

/** What the default view is hiding, so the page can say so. */
export type SoListHidden = { completed: boolean; archived: boolean }

export function soListHides(filter: SoListFilter): SoListHidden {
  const q = normaliseListQuery(filter.q)
  const searching = q.length > 0
  const explicit = (filter.statuses?.length ?? 0) > 0
  return {
    completed: !searching && !explicit && !filter.showCompleted,
    archived: !searching && !filter.includeArchived,
  }
}

export function buildSalesOrderListWhere(filter: SoListFilter): Prisma.SalesOrderWhereInput {
  const q = normaliseListQuery(filter.q)
  const hides = soListHides(filter)
  const and: Prisma.SalesOrderWhereInput[] = []

  if (hides.archived) and.push({ archived: { not: true } })
  if (filter.statuses && filter.statuses.length > 0) and.push({ status: { in: filter.statuses } })
  else if (hides.completed) and.push({ status: { notIn: [...SO_COMPLETED_STATUSES] } })

  if (q && q.length < ORDER_LIST_MIN_SUBSTRING_LENGTH) {
    and.push({ OR: [{ orderNumber: eq(q) }, { externalOrderNumber: eq(q) }] })
  } else if (q) {
    and.push({
      OR: [
        { orderNumber: ci(q) },
        { externalOrderNumber: ci(q) },
        { customerName: ci(q) },
        { customerEmail: ci(q) },
        { trackingNumber: ci(q) },
        { shoppingLinks: { some: { OR: [{ externalOrderNumber: ci(q) }, { externalOrderId: ci(q) }] } } },
        { lines: { some: { sku: ci(q) } } },
        { shipments: { some: { trackingNumber: ci(q) } } },
      ],
    })
  }
  return and.length ? { AND: and } : {}
}

export type PoListFilter = {
  q?: string
  statuses?: PoListStatus[]
  invoiced?: boolean
  returned?: boolean
  includeArchived?: boolean
}

export function poListHidesArchived(filter: PoListFilter): boolean {
  return normaliseListQuery(filter.q).length === 0 && !filter.includeArchived
}

export function buildPurchaseOrderListWhere(filter: PoListFilter): Prisma.PurchaseOrderWhereInput {
  const q = normaliseListQuery(filter.q)
  const and: Prisma.PurchaseOrderWhereInput[] = []

  if (poListHidesArchived(filter)) and.push({ archived: { not: true } })
  if (filter.statuses && filter.statuses.length > 0) and.push({ status: { in: filter.statuses } })
  if (filter.invoiced) and.push({ invoices: { some: {} } })
  if (filter.returned) and.push({ lines: { some: { qtyReturned: { gt: 0 } } } })

  if (q && q.length < ORDER_LIST_MIN_SUBSTRING_LENGTH) {
    and.push({ reference: eq(q) })
  } else if (q) {
    and.push({
      OR: [
        { reference: ci(q) },
        { supplierRef: ci(q) },
        { trackingNumber: ci(q) },
        { supplier: { name: ci(q) } },
        { lines: { some: { product: { sku: ci(q) } } } },
      ],
    })
  }
  return and.length ? { AND: and } : {}
}
