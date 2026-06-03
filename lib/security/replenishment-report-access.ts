const REPLENISHMENT_REPORT_ROLES = new Set(['ADMIN', 'MANAGER', 'FINANCE'])

export const REPLENISHMENT_REPORT_LINKS = [
  { href: '/analytics/reorder', label: 'Reorder Planning' },
  { href: '/analytics/backorder', label: 'Backorders' },
  { href: '/analytics/component-shortage', label: 'Component Shortages' },
] as const

export function canAccessReplenishmentReports(role: string): boolean {
  return REPLENISHMENT_REPORT_ROLES.has(role)
}
