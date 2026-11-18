import { canAccessSalesAnalytics } from '@/lib/security/sales-analytics-access'

/**
 * The dashboard is open to every internal role that holds `dashboard` (Warehouse, Read-only and Finance included),
 * but its COGS, profit, margin and inventory-value figures are the numbers the Gross Margin report restricts to
 * Admin, Manager and Finance. Those figures are withheld on the server for everyone else, so a Read-only user cannot
 * read them off the action response even though the page hides the cards.
 */
export function canViewDashboardCostFigures(role: string | null | undefined): boolean {
  return role ? canAccessSalesAnalytics(role) : false
}

type KpiCostFields = {
  cogsCurrent: number
  profitCurrent: number
  marginCurrent: number
  marginBoundCurrent: string
  cogsComparison: number
  marginComparison: number
  marginBoundComparison: string
  inventoryValue: number
}
type ChartCostFields = {
  cogs: number
  marginPct: number
  marginPctBound: string
  compCogs: number
  compMarginPct: number
  compMarginPctBound: string
}

/**
 * The only top-product fields that ever leave the action. An ALLOWLIST: the working row also carries `totalCogs` and
 * the positive-credit sums, and a spread would ship them. `marginPct`/`marginPctBound` are in the list because the
 * visible case needs them; the restricted case overwrites them.
 */
const TOP_PRODUCT_FIELDS = [
  'productId', 'sku', 'name', 'netRevenue', 'refundsNetBasis', 'refundsGrossBasis', 'refundsUnknownBasis',
  'refundBasisComplete', 'netRevenueBound', 'qtySold', 'qtyRefunded', 'netQty', 'marginPct', 'marginPctBound',
] as const

export function projectTopProduct<T extends { productId: string; marginPct: number; marginPctBound: string }>(row: T): Pick<T, (typeof TOP_PRODUCT_FIELDS)[number] & keyof T> {
  const out: Record<string, unknown> = {}
  for (const key of TOP_PRODUCT_FIELDS) out[key] = (row as Record<string, unknown>)[key]
  return out as Pick<T, (typeof TOP_PRODUCT_FIELDS)[number] & keyof T>
}

export function redactDashboardCostFigures<
  K extends KpiCostFields,
  C extends ChartCostFields,
  T extends { productId: string; marginPct: number; marginPctBound: string },
>(input: { kpi: K; chartData: C[]; topProducts: T[] }) {
  return {
    kpi: {
      ...input.kpi,
      cogsCurrent: 0,
      profitCurrent: 0,
      marginCurrent: 0,
      marginBoundCurrent: 'exact',
      cogsComparison: 0,
      marginComparison: 0,
      marginBoundComparison: 'exact',
      inventoryValue: 0,
    } as K,
    chartData: input.chartData.map((p) => ({
      ...p, cogs: 0, marginPct: 0, marginPctBound: 'exact', compCogs: 0, compMarginPct: 0, compMarginPctBound: 'exact',
    }) as C),
    topProducts: input.topProducts.map((p) => ({ ...projectTopProduct(p), marginPct: 0, marginPctBound: 'exact' }) as unknown as T),
  }
}
