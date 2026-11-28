import { hasPermission } from '@/lib/permissions'

export const STOCK_POSITION_REPORT_LINKS = [
  { href: '/analytics/stock-on-hand', label: 'Stock on Hand' },
  { href: '/analytics/inventory-aging', label: 'Inventory Aging' },
  { href: '/analytics/dead-stock', label: 'Dead Stock' },
  { href: '/analytics/slow-stock', label: 'Slow Stock (NRV review)' },
  { href: '/analytics/stock-allocations', label: 'Stock Allocations' },
  { href: '/analytics/negative-stock', label: 'Negative Stock' },
] as const

export function canAccessStockPositionReports(role: string): boolean {
  return hasPermission(role, 'analytics') || role === 'WAREHOUSE'
}

/**
 * Stock value and unit cost are cost figures: only roles holding inventory.prices (Admin, Manager, Finance) may see them on a
 * stock-position report. Warehouse and read-only roles still see quantities. Pass the result as `includeCost` to the report
 * functions so the value fields never leave the server for other roles.
 */
export function canViewStockValue(role: string): boolean {
  return hasPermission(role, 'inventory.prices')
}
