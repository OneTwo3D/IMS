/**
 * Generic accounting facade — core code imports ONLY from here, never from connector modules.
 * Currently delegates to Xero. In future, reads an `accounting_connector` setting to route
 * to Xero or QuickBooks.
 */

import type { AccountingSyncType } from '@/app/generated/prisma/client'

export type AccountingSettings = {
  syncEnabled: boolean
  salesAccount: string
  shippingAccount: string
  discountAccount: string
  cogsAccount: string
  inventoryAccount: string
  allocatedInventoryAccount: string
  unearnedRevenueAccount: string
  transitAccount: string
  paymentAccountMap: string
  invoiceUrlTemplate: string
  billUrlTemplate: string
}

export async function queueAccountingSync(params: {
  type: AccountingSyncType
  referenceType: string
  referenceId: string
  payload: Record<string, unknown>
}): Promise<void> {
  // Dynamically import the active connector's queue function
  const { queueXeroSync } = await import('@/lib/connectors/xero/queue')
  return queueXeroSync(params)
}

export async function getAccountingSettings(): Promise<AccountingSettings> {
  const { getXeroSettings } = await import('@/lib/connectors/xero/settings')
  const xs = await getXeroSettings()

  // Read connector-agnostic settings directly from the core settings table.
  const { db } = await import('@/lib/db')
  const [invoiceUrlSetting, billUrlSetting, paymentMapSetting] = await Promise.all([
    db.setting.findUnique({ where: { key: 'accounting_invoice_url_template' } }),
    db.setting.findUnique({ where: { key: 'accounting_bill_url_template' } }),
    db.setting.findUnique({ where: { key: 'accounting_payment_account_map' } }),
  ])

  return {
    syncEnabled: xs.xero_sync_enabled === 'true',
    salesAccount: xs.xero_sales_account,
    shippingAccount: xs.xero_shipping_account,
    discountAccount: xs.xero_discount_account,
    cogsAccount: xs.xero_cogs_account,
    inventoryAccount: xs.xero_inventory_account,
    allocatedInventoryAccount: xs.xero_allocated_inventory_account,
    unearnedRevenueAccount: xs.xero_unearned_revenue_account,
    transitAccount: xs.xero_transit_account,
    paymentAccountMap: paymentMapSetting?.value ?? '{}',
    invoiceUrlTemplate: invoiceUrlSetting?.value ?? 'https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID={id}',
    billUrlTemplate: billUrlSetting?.value ?? 'https://go.xero.com/AccountsPayable/View.aspx?InvoiceID={id}',
  }
}

/**
 * Fetch just the payment account map JSON. Used by connector sync processors
 * so they don't have to re-fetch all accounting settings.
 */
export async function getPaymentAccountMap(): Promise<string> {
  const { db } = await import('@/lib/db')
  const row = await db.setting.findUnique({ where: { key: 'accounting_payment_account_map' } })
  return row?.value ?? '{}'
}

export function lookupPaymentAccount(
  mapJson: string,
  method: string,
  currency: string,
): string | null {
  try {
    const map = JSON.parse(mapJson) as Record<string, string>
    const exact = map[`${method}:${currency}`]
    if (exact) return exact
    const wildcard = map[`${method}:*`]
    if (wildcard) return wildcard
    return null
  } catch {
    return null
  }
}
