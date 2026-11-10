import type { SidebarLink } from './analytics-access'

/**
 * Children of the sidebar "Inventory" group. "Products" (the /inventory page)
 * is always present; "HS Code Review" needs the inventory.edit permission.
 */
export function getInventoryChildren(canEditInventory: boolean): SidebarLink[] {
  return [
    { href: '/inventory', label: 'Products' },
    ...(canEditInventory ? [{ href: '/trade/hs-code-review', label: 'HS Code Review' }] : []),
  ]
}
