/**
 * Role-based access control (RBAC) permission system.
 */

export type Role = 'ADMIN' | 'MANAGER' | 'WAREHOUSE' | 'FINANCE' | 'READONLY' | 'SUPPLIER'

export type Permission =
  /**
   * o3d-512h round 3 — the INTERNAL-PRINCIPAL boundary.
   *
   * SUPPLIER is an EXTERNAL principal: a third party we hand a login to so it
   * can quote its own RFQs. Every other role is an internal user of the ERP.
   * `requireAuth` cannot tell those apart — it answers "is someone signed in" —
   * so every endpoint gated on it served the supplier's browser the same rows it
   * served a warehouse operative's.
   *
   * This permission is the difference, expressed in the table rather than as a
   * hard-coded role check, so a role added later has to make the call explicitly
   * instead of inheriting internal reach by omission. Nothing in the nav uses
   * it; it exists to be required, not displayed.
   */
  | 'internal'
  | 'dashboard'
  | 'inventory' | 'inventory.edit' | 'inventory.prices'
  | 'stock_control' | 'stock_control.adjust' | 'stock_control.transfer'
  | 'purchasing' | 'purchasing.create' | 'purchasing.receive' | 'purchasing.invoice'
  | 'sales' | 'sales.create' | 'sales.process' | 'sales.refund'
  | 'manufacturing'
  | 'analytics'
  | 'analytics.inventory_ledger'
  | 'analytics.inventory_costing'
  | 'sync'
  | 'settings' | 'settings.company' | 'settings.users'
  | 'activity_log'
  | 'help'
  // Supplier-specific
  | 'supplier_portal' | 'supplier_portal.products' | 'supplier_portal.po' | 'supplier_portal.rfq'

/**
 * Permissions matrix per role.
 */
const ROLE_PERMISSIONS: Record<Role, Set<Permission>> = {
  ADMIN: new Set([
    'internal',
    'dashboard', 'inventory', 'inventory.edit', 'inventory.prices',
    'stock_control', 'stock_control.adjust', 'stock_control.transfer',
    'purchasing', 'purchasing.create', 'purchasing.receive', 'purchasing.invoice',
    'sales', 'sales.create', 'sales.process', 'sales.refund',
    'manufacturing', 'analytics', 'analytics.inventory_ledger', 'analytics.inventory_costing', 'sync',
    'settings', 'settings.company', 'settings.users',
    'activity_log', 'help',
  ]),
  MANAGER: new Set([
    'internal',
    'dashboard', 'inventory', 'inventory.edit', 'inventory.prices',
    'stock_control', 'stock_control.adjust', 'stock_control.transfer',
    'purchasing', 'purchasing.create', 'purchasing.receive', 'purchasing.invoice',
    'sales', 'sales.create', 'sales.process', 'sales.refund',
    'manufacturing', 'analytics', 'analytics.inventory_ledger', 'analytics.inventory_costing', 'sync',
    'activity_log', 'help',
  ]),
  WAREHOUSE: new Set([
    'internal',
    'dashboard', 'inventory', 'inventory.edit',
    'stock_control', 'stock_control.adjust', 'stock_control.transfer',
    'purchasing', 'purchasing.receive',
    'sales', 'sales.process',
    'manufacturing',
    'analytics.inventory_ledger',
    'help',
  ]),
  FINANCE: new Set([
    'internal',
    'dashboard', 'inventory', 'inventory.prices',
    'purchasing', 'purchasing.create', 'purchasing.invoice',
    'sales', 'sales.refund',
    'analytics', 'analytics.inventory_ledger', 'analytics.inventory_costing',
    'help',
  ]),
  READONLY: new Set([
    'internal',
    'dashboard', 'inventory',
    'purchasing', 'sales',
    'analytics',
    'help',
  ]),
  // No 'internal': a supplier is an external party. Anything it may read has to
  // be scoped to its OWN rows by the action itself (app/actions/supplier-portal.ts),
  // which is why holding a permission is never sufficient on that surface.
  SUPPLIER: new Set([
    'supplier_portal', 'supplier_portal.products', 'supplier_portal.po', 'supplier_portal.rfq',
    'help',
  ]),
}

export function hasPermission(role: string, permission: Permission): boolean {
  const perms = ROLE_PERMISSIONS[role as Role]
  return perms?.has(permission) ?? false
}

export function getPermissions(role: string): Set<Permission> {
  return ROLE_PERMISSIONS[role as Role] ?? new Set()
}

export function isSupplier(role: string): boolean {
  return role === 'SUPPLIER'
}

export function isAdmin(role: string): boolean {
  return role === 'ADMIN'
}

/**
 * ROLES, in the order the matrix above declares them. Exported so an exhaustiveness test cannot
 * be satisfied by a hand-maintained list that silently misses a newly added role.
 */
export const ROLES = Object.keys(ROLE_PERMISSIONS) as Role[]

/**
 * Where a role can actually LAND — the destination a "you may not see this page" screen is allowed
 * to offer it.
 *
 * o3d-osl8 round 5, finding 4. The Integrations denial screen offered `/dashboard` on the claim
 * that "every authenticated role can reach it". SUPPLIER cannot: it does not hold `dashboard`, so
 * /dashboard's own read (getDashboardData → requirePermission('dashboard')) throws a typed denial
 * and drops the reader into the generic error boundary — the exact dead end that screen was
 * introduced to remove, reached one click later.
 *
 * A route NAME proves nothing about reachability, so each destination carries the gate it actually
 * has to pass, and the gate is checked against this same matrix (and, in tests, against the target
 * file's own source). Two shapes because the two destinations are gated differently and pretending
 * otherwise is how the original claim went wrong:
 *   • `permission` — the destination's read calls requirePermission(p);
 *   • `role`       — the destination gates on the ROLE itself (the supplier portal redirects any
 *                    non-SUPPLIER session away, so holding a permission is not sufficient there).
 *
 * The `/help` fallback is not decorative: it is the only destination in the product that every
 * declared role holds, so it is what an unknown or future role gets rather than a link that
 * type-checks and then fails at runtime.
 */
export type RoleLanding = {
  href: string
  label: string
  gate: { kind: 'permission'; permission: Permission } | { kind: 'role'; role: Role }
}

export function landingForRole(role: string | null | undefined): RoleLanding {
  if (role === 'SUPPLIER') {
    return { href: '/supplier/rfqs', label: 'Go to your RFQs', gate: { kind: 'role', role: 'SUPPLIER' } }
  }
  if (role && hasPermission(role, 'dashboard')) {
    return { href: '/dashboard', label: 'Back to dashboard', gate: { kind: 'permission', permission: 'dashboard' } }
  }
  return { href: '/help', label: 'Go to Help', gate: { kind: 'permission', permission: 'help' } }
}

/** Whether `role` genuinely satisfies a landing's own gate. The check the original claim skipped. */
export function landingIsReachableBy(landing: RoleLanding, role: string): boolean {
  return landing.gate.kind === 'role'
    ? role === landing.gate.role
    : hasPermission(role, landing.gate.permission)
}

/**
 * Navigation items visible per role.
 */
export type NavItem = {
  label: string
  href: string
  icon?: string
  permission: Permission
  children?: NavItem[]
}

export function filterNavByRole(items: NavItem[], role: string): NavItem[] {
  return items
    .filter((item) => hasPermission(role, item.permission))
    .map((item) => ({
      ...item,
      children: item.children ? filterNavByRole(item.children, role) : undefined,
    }))
}
