/**
 * Role-based access control (RBAC) permission system.
 */

export type Role = 'ADMIN' | 'MANAGER' | 'WAREHOUSE' | 'FINANCE' | 'READONLY' | 'SUPPLIER'

export type Permission =
  | 'dashboard'
  | 'inventory' | 'inventory.edit' | 'inventory.prices'
  | 'stock_control' | 'stock_control.adjust' | 'stock_control.transfer'
  | 'purchasing' | 'purchasing.create' | 'purchasing.receive' | 'purchasing.invoice'
  | 'sales' | 'sales.create' | 'sales.process' | 'sales.refund'
  | 'manufacturing'
  | 'analytics'
  | 'analytics.inventory_ledger'
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
    'dashboard', 'inventory', 'inventory.edit', 'inventory.prices',
    'stock_control', 'stock_control.adjust', 'stock_control.transfer',
    'purchasing', 'purchasing.create', 'purchasing.receive', 'purchasing.invoice',
    'sales', 'sales.create', 'sales.process', 'sales.refund',
    'manufacturing', 'analytics', 'analytics.inventory_ledger', 'sync',
    'settings', 'settings.company', 'settings.users',
    'activity_log', 'help',
  ]),
  MANAGER: new Set([
    'dashboard', 'inventory', 'inventory.edit', 'inventory.prices',
    'stock_control', 'stock_control.adjust', 'stock_control.transfer',
    'purchasing', 'purchasing.create', 'purchasing.receive', 'purchasing.invoice',
    'sales', 'sales.create', 'sales.process', 'sales.refund',
    'manufacturing', 'analytics', 'analytics.inventory_ledger', 'sync',
    'activity_log', 'help',
  ]),
  WAREHOUSE: new Set([
    'dashboard', 'inventory', 'inventory.edit',
    'stock_control', 'stock_control.adjust', 'stock_control.transfer',
    'purchasing', 'purchasing.receive',
    'sales', 'sales.process',
    'manufacturing',
    'analytics.inventory_ledger',
    'help',
  ]),
  FINANCE: new Set([
    'dashboard', 'inventory', 'inventory.prices',
    'purchasing', 'purchasing.create', 'purchasing.invoice',
    'sales', 'sales.refund',
    'analytics', 'analytics.inventory_ledger',
    'help',
  ]),
  READONLY: new Set([
    'dashboard', 'inventory',
    'purchasing', 'sales',
    'analytics',
    'help',
  ]),
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
