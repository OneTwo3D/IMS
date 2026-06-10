import assert from 'node:assert/strict'
import test from 'node:test'

import { hasPermission, type Role } from '../../../lib/permissions.ts'
import {
  BASE_ANALYTICS_LINKS,
  getSidebarAnalyticsChildren,
  INVENTORY_COSTING_REPORT_LINKS,
  INVENTORY_LEDGER_REPORT_LINKS,
  REPORT_ACCESS_GROUPS,
  shouldShowSidebarAnalyticsGroup,
  uniqueLinks,
  type SidebarLink,
} from '../../../lib/sidebar/analytics-access.ts'

const ROLES: Role[] = ['ADMIN', 'MANAGER', 'WAREHOUSE', 'FINANCE', 'READONLY', 'SUPPLIER']

function hrefsFor(role: Role): Set<string> {
  return new Set(getSidebarAnalyticsChildren(role).map((link) => link.href))
}

function assertLinksMatchPermission(role: Role, links: readonly SidebarLink[], allowed: boolean) {
  const hrefs = hrefsFor(role)
  for (const link of links) {
    assert.equal(hrefs.has(link.href), allowed, `${role}: ${link.href}`)
  }
}

test('sidebar report group links follow their canAccess rule for each role', () => {
  for (const role of ROLES) {
    for (const group of REPORT_ACCESS_GROUPS) {
      assertLinksMatchPermission(role, group.links, group.canAccess(role))
    }
  }
})

test('base analytics links require analytics permission', () => {
  for (const role of ROLES) {
    assertLinksMatchPermission(role, BASE_ANALYTICS_LINKS, hasPermission(role, 'analytics'))
  }
})

test('inventory ledger and costing links follow their permission gates', () => {
  for (const role of ROLES) {
    assertLinksMatchPermission(role, INVENTORY_LEDGER_REPORT_LINKS, hasPermission(role, 'analytics.inventory_ledger'))
    assertLinksMatchPermission(role, INVENTORY_COSTING_REPORT_LINKS, hasPermission(role, 'analytics.inventory_costing'))
  }
})

test('admin sidebar analytics links keep the expected happy-path ordering', () => {
  assert.deepEqual(
    getSidebarAnalyticsChildren('ADMIN').map((link) => link.href),
    [
      '/analytics/sales-stats',
      '/analytics/purchase-stats',
      '/analytics/product-profitability',
      '/analytics/inventory-stats',
      '/analytics/stock-on-hand',
      '/analytics/inventory-aging',
      '/analytics/dead-stock',
      '/analytics/stock-allocations',
      '/analytics/negative-stock',
      '/analytics/reorder',
      '/analytics/backorder',
      '/analytics/component-shortage',
      '/analytics/sales',
      '/analytics/customers',
      '/analytics/margin',
      '/analytics/returns',
      '/analytics/fulfillment',
      '/analytics/throughput',
      '/analytics/open-pos',
      '/analytics/supplier-performance',
      '/analytics/ppv',
      '/analytics/spend',
      '/analytics/lead-times',
      '/analytics/vat',
      '/analytics/currency-summary',
      '/analytics/ar-aging',
      '/analytics/ap-aging',
      '/analytics/fx-gain-loss',
      '/analytics/production-variance',
      '/analytics/wip',
      '/analytics/stock-movements',
      '/analytics/stock-adjustments',
      '/analytics/transfers',
      '/analytics/stock-counts',
      '/analytics/inventory-valuation',
      '/analytics/cogs',
      '/analytics/landed-cost',
      '/analytics/inventory-turnover',
    ],
  )
})

test('uniqueLinks keeps first occurrence and removes duplicate hrefs', () => {
  assert.deepEqual(
    uniqueLinks([
      { href: '/analytics/stock-on-hand', label: 'Stock on Hand' },
      { href: '/analytics/stock-on-hand', label: 'Duplicate Stock on Hand' },
      { href: '/analytics/reorder', label: 'Reorder Planning' },
    ]),
    [
      { href: '/analytics/stock-on-hand', label: 'Stock on Hand' },
      { href: '/analytics/reorder', label: 'Reorder Planning' },
    ],
  )
})

test('analytics group visibility follows visible child links', () => {
  for (const role of ROLES) {
    assert.equal(shouldShowSidebarAnalyticsGroup(role), getSidebarAnalyticsChildren(role).length > 0, role)
  }
  assert.equal(shouldShowSidebarAnalyticsGroup('SUPPLIER'), false)
})
