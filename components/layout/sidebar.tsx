'use client'

import Link from 'next/link'
import { useState } from 'react'
import {
  LayoutDashboard,
  Package,
  Warehouse,
  ShoppingCart,
  TrendingUp,
  Factory,
  RefreshCw,
  BarChart3,
  Settings,
  ActivitySquare,
  HelpCircle,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { NavItem } from './nav-item'
import { NavGroup } from './nav-group'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { hasPermission, type Permission } from '@/lib/permissions'
import { canAccessStockPositionReports, STOCK_POSITION_REPORT_LINKS } from '@/lib/security/stock-position-policy'
import { canAccessReplenishmentReports, REPLENISHMENT_REPORT_LINKS } from '@/lib/security/replenishment-report-access'
import { canAccessSalesAnalytics, SALES_ANALYTICS_LINKS } from '@/lib/security/sales-analytics-access'
import { canAccessPurchasingAnalytics, PURCHASING_ANALYTICS_LINKS } from '@/lib/security/purchasing-analytics-access'
import { canAccessFinanceAnalytics, FINANCE_ANALYTICS_LINKS } from '@/lib/security/finance-analytics-access'
import { canAccessManufacturingAnalytics, MANUFACTURING_ANALYTICS_LINKS } from '@/lib/security/manufacturing-analytics-access'

const STOCK_CONTROL_CHILDREN = [
  { href: '/stock-control/stock-adjustments', label: 'Stock Adjustments' },
  { href: '/stock-control/transfers',  label: 'Warehouse Transfers' },
]

const PURCHASES_CHILDREN = [
  { href: '/purchase-orders',           label: 'Purchase Orders' },
  { href: '/purchase-orders/suppliers', label: 'Suppliers' },
]

const SALES_CHILDREN = [
  { href: '/sales',          label: 'Sales Orders' },
  { href: '/sales/contacts', label: 'Customers' },
]

const ANALYTICS_CHILDREN = [
  { href: '/analytics/sales-stats',            label: 'Sales Statistics' },
  { href: '/analytics/purchase-stats',         label: 'Purchase Statistics' },
  { href: '/analytics/product-profitability',  label: 'Product Profitability' },
  { href: '/analytics/inventory-stats',        label: 'Inventory Report' },
  ...SALES_ANALYTICS_LINKS,
  ...PURCHASING_ANALYTICS_LINKS,
  ...FINANCE_ANALYTICS_LINKS,
  ...MANUFACTURING_ANALYTICS_LINKS,
  ...STOCK_POSITION_REPORT_LINKS,
  ...REPLENISHMENT_REPORT_LINKS,
]

const INVENTORY_LEDGER_REPORT_LINKS = [
  { href: '/analytics/stock-movements',        label: 'Stock Movement Ledger' },
  { href: '/analytics/stock-adjustments',      label: 'Stock Adjustments' },
  { href: '/analytics/transfers',              label: 'Stock Transfers' },
  { href: '/analytics/stock-counts',           label: 'Stock Counts' },
]

const INVENTORY_COSTING_REPORT_LINKS = [
  { href: '/analytics/inventory-valuation',    label: 'Inventory Valuation' },
  { href: '/analytics/cogs',                   label: 'COGS Report' },
  { href: '/analytics/landed-cost',            label: 'Landed Cost Analysis' },
  { href: '/analytics/inventory-turnover',     label: 'Inventory Turnover' },
]

const REPORT_ACCESS_GROUPS = [
  { hrefs: new Set<string>(REPLENISHMENT_REPORT_LINKS.map((link) => link.href)), canAccess: canAccessReplenishmentReports },
  { hrefs: new Set<string>(SALES_ANALYTICS_LINKS.map((link) => link.href)), canAccess: canAccessSalesAnalytics },
  { hrefs: new Set<string>(PURCHASING_ANALYTICS_LINKS.map((link) => link.href)), canAccess: canAccessPurchasingAnalytics },
  { hrefs: new Set<string>(FINANCE_ANALYTICS_LINKS.map((link) => link.href)), canAccess: canAccessFinanceAnalytics },
  { hrefs: new Set<string>(MANUFACTURING_ANALYTICS_LINKS.map((link) => link.href)), canAccess: canAccessManufacturingAnalytics },
]

function getSettingsChildren(accountingIntegrationEnabled: boolean) {
  return [
    { href: '/settings/company', label: 'Company' },
    { href: '/settings/inventory', label: 'Inventory' },
    { href: '/settings/sales', label: 'Sales' },
    { href: '/settings/purchasing', label: 'Purchasing' },
    ...(accountingIntegrationEnabled ? [{ href: '/settings/accounting', label: 'Accounting' }] : []),
    { href: '/settings/users', label: 'Users' },
    { href: '/settings/backup', label: 'Backup & Restore' },
    { href: '/settings/system', label: 'System' },
  ]
}

// Supplier-specific navigation
const SUPPLIER_NAV = [
  { href: '/supplier/rfqs',     label: 'RFQs',         icon: ShoppingCart },
  { href: '/supplier/orders',   label: 'Purchase Orders', icon: Package },
  { href: '/supplier/products', label: 'My Products',   icon: Package },
]

type SidebarProps = {
  companyName?: string
  logoUrl?: string | null
  userRole?: string
  shoppingIntegrationEnabled: boolean
  accountingIntegrationEnabled: boolean
  wmsIntegrationEnabled: boolean
  onNavigate?: () => void
  forceExpanded?: boolean
}

export function Sidebar({
  companyName,
  logoUrl,
  userRole = 'ADMIN',
  shoppingIntegrationEnabled,
  accountingIntegrationEnabled,
  wmsIntegrationEnabled,
  onNavigate,
  forceExpanded,
}: SidebarProps) {
  const [internalCollapsed, setCollapsed] = useState(false)
  const collapsed = forceExpanded ? false : internalCollapsed
  const can = (p: Permission) => hasPermission(userRole, p)
  const isSupplier = userRole === 'SUPPLIER'
  const settingsChildren = getSettingsChildren(accountingIntegrationEnabled)
  const showIntegrations = shoppingIntegrationEnabled || accountingIntegrationEnabled || wmsIntegrationEnabled
  const analyticsChildren = [
    ...(can('analytics') ? ANALYTICS_CHILDREN : [...STOCK_POSITION_REPORT_LINKS]),
    ...(!can('analytics') && canAccessReplenishmentReports(userRole) ? [...REPLENISHMENT_REPORT_LINKS] : []),
    ...(!can('analytics') && canAccessSalesAnalytics(userRole) ? [...SALES_ANALYTICS_LINKS] : []),
    ...(!can('analytics') && canAccessPurchasingAnalytics(userRole) ? [...PURCHASING_ANALYTICS_LINKS] : []),
    ...(!can('analytics') && canAccessFinanceAnalytics(userRole) ? [...FINANCE_ANALYTICS_LINKS] : []),
    ...(!can('analytics') && canAccessManufacturingAnalytics(userRole) ? [...MANUFACTURING_ANALYTICS_LINKS] : []),
    ...(can('analytics.inventory_ledger') ? INVENTORY_LEDGER_REPORT_LINKS : []),
    ...(can('analytics.inventory_costing') ? INVENTORY_COSTING_REPORT_LINKS : []),
  ]
    .filter((item) => {
      const group = REPORT_ACCESS_GROUPS.find((candidate) => candidate.hrefs.has(item.href))
      return !group || group.canAccess(userRole)
    })

  // Supplier gets a completely different navigation
  if (isSupplier) {
    return (
      <aside className={cn('relative flex h-full flex-col border-r bg-card transition-all duration-200', collapsed ? 'w-14' : 'w-56')}>
        <div className={cn('flex h-14 items-center border-b px-3', collapsed && 'justify-center')}>
          <Link href="/supplier/rfqs" className="flex items-center gap-2 font-semibold">
            {logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logoUrl} alt="" className="h-7 w-7 shrink-0 rounded-md object-contain" />
            ) : (
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground text-xs font-bold">12</span>
            )}
            {!collapsed && <span className="text-sm">{companyName || 'One Two Inventory'}</span>}
          </Link>
        </div>
        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-2">
          {SUPPLIER_NAV.map((item) => (
            <NavItem key={item.href} {...item} collapsed={collapsed} onNavigate={onNavigate} />
          ))}
          <NavItem href="/help" label="Help" icon={HelpCircle} collapsed={collapsed} onNavigate={onNavigate} />
        </nav>
        {!forceExpanded && (
          <>
            <Separator />
            <div className="p-2">
              <Button variant="ghost" size="sm" className={cn('w-full', collapsed ? 'justify-center px-0' : 'justify-start')} onClick={() => setCollapsed((c) => !c)} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
                {collapsed ? <ChevronRight className="h-4 w-4" /> : <><ChevronLeft className="h-4 w-4 mr-2" /><span className="text-xs">Collapse</span></>}
              </Button>
            </div>
          </>
        )}
      </aside>
    )
  }

  return (
    <aside
      className={cn(
        'relative flex h-full flex-col border-r bg-card transition-all duration-200',
        collapsed ? 'w-14' : 'w-56',
      )}
    >
      {/* Logo */}
      <div className={cn('flex h-14 items-center border-b px-3', collapsed && 'justify-center')}>
        <Link href="/dashboard" className="flex items-center gap-2 font-semibold">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUrl} alt="" className="h-7 w-7 shrink-0 rounded-md object-contain" />
          ) : (
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground text-xs font-bold">
              12
            </span>
          )}
          {!collapsed && <span className="text-sm">{companyName || 'One Two Inventory'}</span>}
        </Link>
      </div>

      {/* Navigation */}
      <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-2">
        {can('dashboard') && <NavItem href="/dashboard" label="Dashboard" icon={LayoutDashboard} collapsed={collapsed} onNavigate={onNavigate} />}
        {can('inventory') && <NavItem href="/inventory" label="Inventory" icon={Package} collapsed={collapsed} onNavigate={onNavigate} />}
        {can('stock_control') && (
          <NavGroup label="Stock Control" icon={Warehouse} items={STOCK_CONTROL_CHILDREN} collapsed={collapsed} onExpand={() => setCollapsed(false)} onNavigate={onNavigate} />
        )}
        {can('purchasing') && (
          <NavGroup label="Purchases" icon={ShoppingCart} items={PURCHASES_CHILDREN} collapsed={collapsed} onExpand={() => setCollapsed(false)} onNavigate={onNavigate} />
        )}
        {can('sales') && (
          <NavGroup label="Sales" icon={TrendingUp} items={SALES_CHILDREN} collapsed={collapsed} onExpand={() => setCollapsed(false)} onNavigate={onNavigate} />
        )}
        {canAccessStockPositionReports(userRole) && (
          <NavGroup label="Analytics" icon={BarChart3} items={analyticsChildren} collapsed={collapsed} onExpand={() => setCollapsed(false)} onNavigate={onNavigate} />
        )}
        {can('manufacturing') && <NavItem href="/manufacturing" label="Manufacturing" icon={Factory} collapsed={collapsed} onNavigate={onNavigate} />}
        {can('sync') && showIntegrations && <NavItem href="/sync" label="Integrations" icon={RefreshCw} collapsed={collapsed} onNavigate={onNavigate} />}
        {can('activity_log') && <NavItem href="/activity" label="Activity" icon={ActivitySquare} collapsed={collapsed} onNavigate={onNavigate} />}
        <NavItem href="/help" label="Help" icon={HelpCircle} collapsed={collapsed} onNavigate={onNavigate} />
        {can('settings') && (
          <NavGroup label="Settings" icon={Settings} items={settingsChildren} collapsed={collapsed} onExpand={() => setCollapsed(false)} onNavigate={onNavigate} />
        )}
      </nav>

      {!forceExpanded && (
        <>
          <Separator />
          {/* Collapse toggle */}
          <div className="p-2">
            <Button
              variant="ghost"
              size="sm"
              className={cn('w-full', collapsed ? 'justify-center px-0' : 'justify-start')}
              onClick={() => setCollapsed((c) => !c)}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              {collapsed ? (
                <ChevronRight className="h-4 w-4" />
              ) : (
                <>
                  <ChevronLeft className="h-4 w-4 mr-2" />
                  <span className="text-xs">Collapse</span>
                </>
              )}
            </Button>
          </div>
        </>
      )}
    </aside>
  )
}
