const MANUFACTURING_ANALYTICS_ROLES = new Set(['ADMIN', 'MANAGER', 'FINANCE'])

export const MANUFACTURING_ANALYTICS_LINKS = [
  { href: '/analytics/production-variance', label: 'Production Variance' },
  { href: '/analytics/wip', label: 'WIP' },
] as const

export function canAccessManufacturingAnalytics(role: string | null | undefined): boolean {
  return role ? MANUFACTURING_ANALYTICS_ROLES.has(role) : false
}
