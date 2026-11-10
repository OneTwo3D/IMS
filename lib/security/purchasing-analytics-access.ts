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

/**
 * The same policy for server actions that return purchasing-analytics data (supplier names, unit and landed
 * costs). A server action is a directly callable endpoint, so the page gate alone is not enough; this throws
 * instead of redirecting. Call it with the role of the session `requirePermission('analytics')` returned.
 */
export function assertPurchasingAnalyticsAccess(role: string | null | undefined): void {
  if (!canAccessPurchasingAnalytics(role)) {
    throw new Error('Forbidden: purchasing analytics is restricted to Admin, Manager and Finance')
  }
}
