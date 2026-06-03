import { expect, test } from '@playwright/test'

const redirectCases = [
  {
    from: '/analytics',
    to: /\/analytics\/sales-stats$/,
    heading: 'Sales Statistics',
  },
  {
    from: '/stock-control',
    to: /\/stock-control\/stock-adjustments$/,
    heading: 'Stock Adjustments',
  },
  {
    from: '/settings',
    to: /\/settings\/company$/,
    heading: 'Company Settings',
  },
] as const

const routeCases = [
  { path: '/activity', heading: 'Activity Log' },
  { path: '/analytics/sales-stats', heading: 'Sales Statistics' },
  { path: '/analytics/sales', heading: 'Sales Analytics' },
  { path: '/analytics/customers', heading: 'Customer Mix' },
  { path: '/analytics/margin', heading: 'Gross Margin' },
  { path: '/analytics/returns', heading: 'Returns' },
  { path: '/analytics/fulfillment', heading: 'Fulfillment KPIs' },
  { path: '/analytics/throughput', heading: 'Throughput' },
  { path: '/analytics/open-pos', heading: 'Open Purchase Orders' },
  { path: '/analytics/supplier-performance', heading: 'Supplier Performance' },
  { path: '/analytics/ppv', heading: 'Purchase Price Variance' },
  { path: '/analytics/spend', heading: 'Spend' },
  { path: '/analytics/lead-times', heading: 'Lead Times' },
  { path: '/analytics/purchase-stats', heading: 'Purchase Statistics' },
  { path: '/analytics/inventory-stats', heading: 'Inventory Report' },
  { path: '/analytics/forecast', heading: 'Reorder Forecast' },
  { path: '/analytics/reorder', heading: 'Reorder Planning' },
  { path: '/analytics/backorder', heading: 'Backorders' },
  { path: '/analytics/component-shortage', heading: 'Component Shortages' },
  { path: '/manufacturing', heading: 'Manufacturing' },
  { path: '/sales/contacts', heading: 'Customers' },
  { path: '/purchase-orders/suppliers', heading: 'Suppliers' },
  { path: '/settings/company', heading: 'Company Settings' },
  { path: '/settings/accounting', heading: 'Accounting Settings' },
  { path: '/settings/backup', heading: 'Backup & Restore' },
  { path: '/settings/inventory', heading: 'Inventory Settings' },
  { path: '/settings/purchasing', heading: 'Purchasing Settings' },
  { path: '/settings/sales', heading: 'Sales Settings' },
  { path: '/settings/system', heading: 'System Settings' },
  { path: '/settings/users', heading: 'User Management' },
  { path: '/sync', heading: 'Integrations' },
  { path: '/help', heading: 'Documentation' },
  { path: '/profile', heading: 'Profile' },
] as const

test.describe('authenticated route coverage', () => {
  for (const { from, to, heading } of redirectCases) {
    test(`redirects ${from} to its canonical route`, async ({ page }) => {
      await page.goto(from)
      await expect(page).toHaveURL(to)
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible()
    })
  }

  for (const { path, heading } of routeCases) {
    test(`loads ${path}`, async ({ page }) => {
      await page.goto(path)
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible()
    })
  }
})
