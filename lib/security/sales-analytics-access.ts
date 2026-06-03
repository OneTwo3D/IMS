const SALES_ANALYTICS_ROLES = new Set(['ADMIN', 'MANAGER', 'FINANCE'])

export const SALES_ANALYTICS_LINKS = [
  { href: '/analytics/sales', label: 'Sales Analytics' },
  { href: '/analytics/customers', label: 'Customer Mix' },
  { href: '/analytics/margin', label: 'Gross Margin' },
  { href: '/analytics/returns', label: 'Returns' },
  { href: '/analytics/fulfillment', label: 'Fulfillment KPIs' },
  { href: '/analytics/throughput', label: 'Throughput' },
] as const

export function canAccessSalesAnalytics(role: string): boolean {
  return SALES_ANALYTICS_ROLES.has(role)
}
