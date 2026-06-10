import { hasPermission, type Permission } from '@/lib/permissions'
import { canAccessFinanceAnalytics, FINANCE_ANALYTICS_LINKS } from '@/lib/security/finance-analytics-access'
import { canAccessManufacturingAnalytics, MANUFACTURING_ANALYTICS_LINKS } from '@/lib/security/manufacturing-analytics-access'
import { canAccessPurchasingAnalytics, PURCHASING_ANALYTICS_LINKS } from '@/lib/security/purchasing-analytics-access'
import { canAccessReplenishmentReports, REPLENISHMENT_REPORT_LINKS } from '@/lib/security/replenishment-report-access'
import { canAccessSalesAnalytics, SALES_ANALYTICS_LINKS } from '@/lib/security/sales-analytics-access'
import { canAccessStockPositionReports, STOCK_POSITION_REPORT_LINKS } from '@/lib/security/stock-position-policy'

export type SidebarLink = {
  href: string
  label: string
}

export const BASE_ANALYTICS_LINKS = [
  { href: '/analytics/sales-stats', label: 'Sales Statistics' },
  { href: '/analytics/purchase-stats', label: 'Purchase Statistics' },
  { href: '/analytics/product-profitability', label: 'Product Profitability' },
  { href: '/analytics/inventory-stats', label: 'Inventory Report' },
] as const satisfies readonly SidebarLink[]

export const INVENTORY_LEDGER_REPORT_LINKS = [
  { href: '/analytics/stock-movements', label: 'Stock Movement Ledger' },
  { href: '/analytics/stock-adjustments', label: 'Stock Adjustments' },
  { href: '/analytics/transfers', label: 'Stock Transfers' },
  { href: '/analytics/stock-counts', label: 'Stock Counts' },
] as const satisfies readonly SidebarLink[]

export const INVENTORY_COSTING_REPORT_LINKS = [
  { href: '/analytics/inventory-valuation', label: 'Inventory Valuation' },
  { href: '/analytics/cogs', label: 'COGS Report' },
  { href: '/analytics/landed-cost', label: 'Landed Cost Analysis' },
  { href: '/analytics/inventory-turnover', label: 'Inventory Turnover' },
] as const satisfies readonly SidebarLink[]

export const REPORT_ACCESS_GROUPS = [
  { links: STOCK_POSITION_REPORT_LINKS, canAccess: canAccessStockPositionReports },
  { links: REPLENISHMENT_REPORT_LINKS, canAccess: canAccessReplenishmentReports },
  { links: SALES_ANALYTICS_LINKS, canAccess: canAccessSalesAnalytics },
  { links: PURCHASING_ANALYTICS_LINKS, canAccess: canAccessPurchasingAnalytics },
  { links: FINANCE_ANALYTICS_LINKS, canAccess: canAccessFinanceAnalytics },
  { links: MANUFACTURING_ANALYTICS_LINKS, canAccess: canAccessManufacturingAnalytics },
] as const satisfies ReadonlyArray<{
  links: readonly SidebarLink[]
  canAccess: (role: string) => boolean
}>

export function uniqueLinks(links: readonly SidebarLink[]): SidebarLink[] {
  const seen = new Set<string>()
  return links.filter((link) => {
    if (seen.has(link.href)) return false
    seen.add(link.href)
    return true
  })
}

export function getSidebarAnalyticsChildren(userRole: string): SidebarLink[] {
  const can = (p: Permission) => hasPermission(userRole, p)
  return uniqueLinks([
    ...(can('analytics') ? BASE_ANALYTICS_LINKS : []),
    ...REPORT_ACCESS_GROUPS.flatMap(({ links, canAccess }) => (canAccess(userRole) ? [...links] : [])),
    ...(can('analytics.inventory_ledger') ? INVENTORY_LEDGER_REPORT_LINKS : []),
    ...(can('analytics.inventory_costing') ? INVENTORY_COSTING_REPORT_LINKS : []),
  ])
}

export function shouldShowSidebarAnalyticsGroup(userRole: string): boolean {
  return getSidebarAnalyticsChildren(userRole).length > 0
}
