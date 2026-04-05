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

const NAV_ITEMS_TOP = [
  { href: '/dashboard',       label: 'Dashboard',       icon: LayoutDashboard },
  { href: '/inventory',       label: 'Inventory',        icon: Package },
]

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
  { href: '/analytics/sales-stats', label: 'Sales Statistics' },
  { href: '/analytics/forecast',    label: 'Reorder Forecast' },
]

const NAV_ITEMS_BOTTOM = [
  { href: '/manufacturing',   label: 'Manufacturing',    icon: Factory },
  { href: '/sync',            label: 'Sync',             icon: RefreshCw },
  { href: '/activity',        label: 'Activity',         icon: ActivitySquare },
  { href: '/settings',        label: 'Settings',         icon: Settings },
  { href: '/help',            label: 'Help',             icon: HelpCircle },
]

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false)

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
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground text-xs font-bold">
            12
          </span>
          {!collapsed && <span className="text-sm">OneTwo3D IMS</span>}
        </Link>
      </div>

      {/* Navigation */}
      <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-2">
        {NAV_ITEMS_TOP.map((item) => (
          <NavItem key={item.href} {...item} collapsed={collapsed} />
        ))}
        <NavGroup
          label="Stock Control"
          icon={Warehouse}
          children={STOCK_CONTROL_CHILDREN}
          collapsed={collapsed}
        />
        <NavGroup
          label="Purchases"
          icon={ShoppingCart}
          children={PURCHASES_CHILDREN}
          collapsed={collapsed}
        />
        <NavGroup
          label="Sales"
          icon={TrendingUp}
          children={SALES_CHILDREN}
          collapsed={collapsed}
        />
        <NavGroup
          label="Analytics"
          icon={BarChart3}
          children={ANALYTICS_CHILDREN}
          collapsed={collapsed}
        />
        {NAV_ITEMS_BOTTOM.map((item) => (
          <NavItem key={item.href} {...item} collapsed={collapsed} />
        ))}
      </nav>

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
    </aside>
  )
}
