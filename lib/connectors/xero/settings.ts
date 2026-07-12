/**
 * Xero-specific settings helpers.
 * Moved from app/actions/xero-sync.ts — these are internal utilities, not server actions.
 */

import { getSettingValues } from '@/lib/settings-store'

export type XeroSettings = {
  xero_client_id: string
  xero_client_secret: string
  xero_sync_enabled: string
  xero_sync_sales_invoice: string
  xero_sync_credit_note: string
  xero_sync_purchase_credit_note: string
  xero_sync_purchase_invoice: string
  xero_sync_cogs_journal: string
  xero_sync_cogs_reversal: string
  xero_sync_stock_receipt: string
  xero_sync_inventory_adjustment: string
  xero_sync_stock_allocation: string
  xero_sync_realised_fx_journal: string
  xero_sync_unrealised_fx_journal: string
  xero_sync_manufacturing_journal: string
  xero_sync_tax_rate: string
  xero_sync_attach_pdf: string
  xero_sales_account: string
  xero_shipping_account: string
  xero_discount_account: string
  xero_cogs_account: string
  xero_inventory_revaluation_account: string
  xero_inventory_account: string
  xero_allocated_inventory_account: string
  xero_unearned_revenue_account: string
  xero_transit_account: string
  xero_rounding_difference_account: string
  xero_accounts_receivable_account: string
  xero_accounts_payable_account: string
  xero_realised_fx_gain_loss_account: string
  xero_unrealised_fx_gain_loss_account: string
  xero_manufacturing_overhead_account: string
  xero_daily_batch_enabled: string
  xero_payment_polling_enabled: string
}

export const XERO_SETTING_KEYS = [
  'xero_client_id', 'xero_client_secret', 'xero_sync_enabled',
  'xero_sync_sales_invoice', 'xero_sync_credit_note', 'xero_sync_purchase_credit_note', 'xero_sync_purchase_invoice',
  'xero_sync_cogs_journal', 'xero_sync_cogs_reversal',
  'xero_sync_stock_receipt', 'xero_sync_inventory_adjustment', 'xero_sync_stock_allocation',
  'xero_sync_realised_fx_journal', 'xero_sync_unrealised_fx_journal',
  'xero_sync_manufacturing_journal',
  'xero_sync_tax_rate',
  'xero_sync_attach_pdf',
  'xero_sales_account', 'xero_shipping_account', 'xero_discount_account',
  'xero_cogs_account', 'xero_inventory_revaluation_account',
  'xero_inventory_account', 'xero_allocated_inventory_account',
  'xero_unearned_revenue_account',
  'xero_transit_account',
  'xero_rounding_difference_account',
  'xero_accounts_receivable_account', 'xero_accounts_payable_account',
  'xero_realised_fx_gain_loss_account', 'xero_unrealised_fx_gain_loss_account',
  'xero_manufacturing_overhead_account',
  'xero_daily_batch_enabled', 'xero_payment_polling_enabled',
]

const XERO_DEFAULTS: XeroSettings = {
  xero_client_id: '',
  xero_client_secret: '',
  xero_sync_enabled: 'false',
  xero_sync_sales_invoice: 'submitted',
  xero_sync_credit_note: 'submitted',
  xero_sync_purchase_credit_note: 'submitted',
  xero_sync_purchase_invoice: 'submitted',
  xero_sync_cogs_journal: 'submitted',
  xero_sync_cogs_reversal: 'submitted',
  xero_sync_stock_receipt: 'submitted',
  xero_sync_inventory_adjustment: 'submitted',
  xero_sync_stock_allocation: 'submitted',
  xero_sync_realised_fx_journal: 'submitted',
  xero_sync_unrealised_fx_journal: 'submitted',
  xero_sync_manufacturing_journal: 'submitted',
  xero_sync_tax_rate: 'submitted',
  xero_sync_attach_pdf: 'true',
  xero_sales_account: '',
  xero_shipping_account: '',
  xero_discount_account: '',
  xero_cogs_account: '',
  xero_inventory_revaluation_account: '',
  xero_inventory_account: '',
  xero_allocated_inventory_account: '',
  xero_unearned_revenue_account: '',
  xero_transit_account: '',
  xero_rounding_difference_account: '',
  xero_accounts_receivable_account: '',
  xero_accounts_payable_account: '',
  xero_realised_fx_gain_loss_account: '',
  xero_unrealised_fx_gain_loss_account: '',
  xero_manufacturing_overhead_account: '',
  xero_daily_batch_enabled: 'false',
  xero_payment_polling_enabled: 'false',
}

export async function getXeroSettings(): Promise<XeroSettings> {
  const map = await getSettingValues(XERO_SETTING_KEYS)
  const result = { ...XERO_DEFAULTS }
  for (const k of Object.keys(result) as (keyof XeroSettings)[]) {
    const v = map.get(k)
    if (v) result[k] = v
  }
  return result
}
