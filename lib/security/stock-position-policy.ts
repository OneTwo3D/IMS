import { hasPermission } from '@/lib/permissions'

export const STOCK_POSITION_REPORT_LINKS = [
  { href: '/analytics/stock-on-hand', label: 'Stock on Hand' },
  { href: '/analytics/stock-allocations', label: 'Stock Allocations' },
  { href: '/analytics/negative-stock', label: 'Negative Stock' },
] as const

export function canAccessStockPositionReports(role: string): boolean {
  return hasPermission(role, 'analytics') || role === 'WAREHOUSE'
}
