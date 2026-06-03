const PURCHASING_ANALYTICS_ROLES = new Set(['ADMIN', 'MANAGER', 'FINANCE'])

export const PURCHASING_ANALYTICS_LINKS = [
  { href: '/analytics/open-pos', label: 'Open POs' },
  { href: '/analytics/supplier-performance', label: 'Supplier Performance' },
  { href: '/analytics/ppv', label: 'Purchase Price Variance' },
  { href: '/analytics/spend', label: 'Spend' },
  { href: '/analytics/lead-times', label: 'Lead Times' },
] as const

export function canAccessPurchasingAnalytics(role: string | null | undefined): boolean {
  return role ? PURCHASING_ANALYTICS_ROLES.has(role) : false
}
