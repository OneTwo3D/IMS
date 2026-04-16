/**
 * QuickBooks Online settings helpers.
 * Mirrors the pattern in lib/connectors/xero/settings.ts.
 */

import { getSettingValues } from '@/lib/settings-store'

export type QuickBooksSettings = {
  quickbooks_client_id: string
  quickbooks_client_secret: string
  quickbooks_company_id: string
  quickbooks_sync_enabled: string
  quickbooks_use_sandbox: string
  quickbooks_sync_sales_invoice: string
  quickbooks_sync_credit_note: string
  quickbooks_sync_purchase_invoice: string
  quickbooks_sync_cogs_journal: string
  quickbooks_sync_cogs_reversal: string
  quickbooks_sync_stock_receipt: string
  quickbooks_sync_inventory_adjustment: string
  quickbooks_sync_stock_allocation: string
  quickbooks_sync_attach_pdf: string
  quickbooks_sales_account: string
  quickbooks_shipping_account: string
  quickbooks_discount_account: string
  quickbooks_cogs_account: string
  quickbooks_inventory_account: string
  quickbooks_allocated_inventory_account: string
  quickbooks_unearned_revenue_account: string
  quickbooks_transit_account: string
  quickbooks_daily_batch_enabled: string
  quickbooks_payment_polling_enabled: string
}

export const QUICKBOOKS_SETTING_KEYS = [
  'quickbooks_client_id', 'quickbooks_client_secret', 'quickbooks_company_id',
  'quickbooks_sync_enabled', 'quickbooks_use_sandbox',
  'quickbooks_sync_sales_invoice', 'quickbooks_sync_credit_note', 'quickbooks_sync_purchase_invoice',
  'quickbooks_sync_cogs_journal', 'quickbooks_sync_cogs_reversal',
  'quickbooks_sync_stock_receipt', 'quickbooks_sync_inventory_adjustment', 'quickbooks_sync_stock_allocation',
  'quickbooks_sync_attach_pdf',
  'quickbooks_sales_account', 'quickbooks_shipping_account', 'quickbooks_discount_account',
  'quickbooks_cogs_account', 'quickbooks_inventory_account', 'quickbooks_allocated_inventory_account',
  'quickbooks_unearned_revenue_account',
  'quickbooks_transit_account',
  'quickbooks_daily_batch_enabled', 'quickbooks_payment_polling_enabled',
] as const

const QUICKBOOKS_DEFAULTS: QuickBooksSettings = {
  quickbooks_client_id: '',
  quickbooks_client_secret: '',
  quickbooks_company_id: '',
  quickbooks_sync_enabled: 'false',
  quickbooks_use_sandbox: 'false',
  quickbooks_sync_sales_invoice: 'submitted',
  quickbooks_sync_credit_note: 'submitted',
  quickbooks_sync_purchase_invoice: 'submitted',
  quickbooks_sync_cogs_journal: 'submitted',
  quickbooks_sync_cogs_reversal: 'submitted',
  quickbooks_sync_stock_receipt: 'submitted',
  quickbooks_sync_inventory_adjustment: 'submitted',
  quickbooks_sync_stock_allocation: 'submitted',
  quickbooks_sync_attach_pdf: 'true',
  quickbooks_sales_account: '',
  quickbooks_shipping_account: '',
  quickbooks_discount_account: '',
  quickbooks_cogs_account: '',
  quickbooks_inventory_account: '',
  quickbooks_allocated_inventory_account: '',
  quickbooks_unearned_revenue_account: '',
  quickbooks_transit_account: '',
  quickbooks_daily_batch_enabled: 'false',
  quickbooks_payment_polling_enabled: 'false',
}

export async function getQuickBooksSettings(): Promise<QuickBooksSettings> {
  const map = await getSettingValues([...QUICKBOOKS_SETTING_KEYS])
  const result = { ...QUICKBOOKS_DEFAULTS }
  for (const key of Object.keys(result) as (keyof QuickBooksSettings)[]) {
    const value = map.get(key)
    if (value) result[key] = value
  }
  return result
}
