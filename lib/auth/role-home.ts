/**
 * Where a signed-in role lands. A SUPPLIER is an external party with no access to
 * the internal dashboard: sending it there ends in a permission failure that the
 * error boundary renders as "Something went wrong". Its home is the supplier portal.
 */
export const SUPPLIER_HOME_PATH = '/supplier/rfqs'
export const INTERNAL_HOME_PATH = '/dashboard'

export function homePathForRole(role: string | null | undefined): string {
  return role === 'SUPPLIER' ? SUPPLIER_HOME_PATH : INTERNAL_HOME_PATH
}
