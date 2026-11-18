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
  cogsComparison: number
  marginComparison: number
  inventoryValue: number
}
type ChartCostFields = { cogs: number; marginPct: number; compCogs: number; compMarginPct: number }
type TopProductCostFields = { marginPct: number }

export function redactDashboardCostFigures<
  K extends KpiCostFields,
  C extends ChartCostFields,
  T extends TopProductCostFields,
>(input: { kpi: K; chartData: C[]; topProducts: T[] }): { kpi: K; chartData: C[]; topProducts: T[] } {
  return {
    kpi: {
      ...input.kpi,
      cogsCurrent: 0,
      profitCurrent: 0,
      marginCurrent: 0,
      cogsComparison: 0,
      marginComparison: 0,
      inventoryValue: 0,
    },
    chartData: input.chartData.map((p) => ({ ...p, cogs: 0, marginPct: 0, compCogs: 0, compMarginPct: 0 })),
    topProducts: input.topProducts.map((p) => ({ ...p, marginPct: 0 })),
  }
}
