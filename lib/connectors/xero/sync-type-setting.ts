import type { XeroSettings } from './settings'

type XeroSettingKey = keyof XeroSettings

/**
 * Map sync type enum → setting key for per-type enable/disable. A type NOT listed has no per-type switch: the enqueue gate treats it as
 * 'submitted' whenever Xero sync is on. Kept in a pure module so the writers check reads the very table the queue gate reads.
 */
export const XERO_SYNC_TYPE_SETTING: Readonly<Record<string, XeroSettingKey>> = {
  SALES_INVOICE: 'xero_sync_sales_invoice',
  SALES_INVOICE_UPDATE: 'xero_sync_sales_invoice',
  CREDIT_NOTE: 'xero_sync_credit_note',
  CREDIT_NOTE_VOID: 'xero_sync_credit_note',
  CREDIT_NOTE_ALLOCATION: 'xero_sync_credit_note',
  PURCHASE_INVOICE: 'xero_sync_purchase_invoice',
  PURCHASE_INVOICE_UPDATE: 'xero_sync_purchase_invoice',
  SALES_INVOICE_DELETE: 'xero_sync_sales_invoice',
  PURCHASE_INVOICE_DELETE: 'xero_sync_purchase_invoice',
  COGS_JOURNAL: 'xero_sync_cogs_journal',
  COGS_REVERSAL: 'xero_sync_cogs_reversal',
  STOCK_RECEIPT: 'xero_sync_stock_receipt',
  INVENTORY_ADJUSTMENT: 'xero_sync_inventory_adjustment',
  STOCK_ALLOCATION: 'xero_sync_stock_allocation',
  REALISED_FX_JOURNAL: 'xero_sync_realised_fx_journal',
  UNREALISED_FX_JOURNAL: 'xero_sync_unrealised_fx_journal',
  MANUFACTURING_JOURNAL: 'xero_sync_manufacturing_journal',
  MANUFACTURING_RECLASS: 'xero_sync_manufacturing_journal',
  TAX_RATE_SYNC: 'xero_sync_tax_rate',
}
