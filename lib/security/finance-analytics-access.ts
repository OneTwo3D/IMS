const FINANCE_ANALYTICS_ROLES = new Set(['ADMIN', 'FINANCE'])

export const FINANCE_ANALYTICS_LINKS = [
  { href: '/analytics/vat', label: 'VAT' },
  { href: '/analytics/ar-aging', label: 'AR Aging' },
  { href: '/analytics/ap-aging', label: 'AP Aging' },
  { href: '/analytics/fx-gain-loss', label: 'FX Gain/Loss' },
] as const

export function canAccessFinanceAnalytics(role: string | null | undefined): boolean {
  return role ? FINANCE_ANALYTICS_ROLES.has(role) : false
}
