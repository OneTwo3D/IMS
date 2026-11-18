/**
 * Who may open the analytics "Overview" reports: Sales Statistics, Purchase Statistics, Product Profitability and
 * the Inventory Report, plus the forecast actions behind them and the non-`po_` CSV export types.
 *
 * They return margins, FIFO inventory value, invoices, customer ageing and supplier names, so they follow the same
 * policy as every other analytics group (Admin, Manager, Finance). The `analytics` permission alone is not enough:
 * READONLY holds it, and these reports used to be open to it.
 */
const OVERVIEW_ANALYTICS_ROLES = new Set(['ADMIN', 'MANAGER', 'FINANCE'])

export function canAccessOverviewAnalytics(role: string | null | undefined): boolean {
  return role ? OVERVIEW_ANALYTICS_ROLES.has(role) : false
}

/** The same policy for server actions, which are directly callable endpoints: throws instead of redirecting. */
export function assertOverviewAnalyticsAccess(role: string | null | undefined): void {
  if (!canAccessOverviewAnalytics(role)) {
    throw new Error('Forbidden: overview analytics is restricted to Admin, Manager and Finance')
  }
}
