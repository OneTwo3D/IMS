// iwrm: connector-agnostic definitions for the accounting account-mapping +
// sync settings form (shared by xero-client.tsx and its tests).
//
// Account/sync settings are keyed per connector (xero_* vs quickbooks_*). The
// field definitions hold the connector-agnostic SUFFIX; the form resolves the
// full key via `${connectorId}_${suffix}`, so one form drives both Xero and
// QuickBooks. `connectors` restricts a field to the connectors that actually
// define that setting key (omit = available on both). Keeping this pure (no
// React) makes the save-payload mapping unit-testable — this is a save-path bug
// that previously hardcoded xero_* keys, silently dropping qbo_* mappings.

export type AccountingConnectorId = 'xero' | 'quickbooks'

export type AccountFieldDef = {
  suffix: string
  label: string
  description: string
  connectors?: AccountingConnectorId[]
}

export const ACCOUNT_FIELDS: AccountFieldDef[] = [
  { suffix: 'sales_account', label: 'Sales Revenue', description: 'Revenue from sales invoices' },
  { suffix: 'shipping_account', label: 'Shipping Income', description: 'Shipping charges on sales' },
  { suffix: 'discount_account', label: 'Discounts Given', description: 'Order-level discounts' },
  { suffix: 'transit_account', label: 'Stock in Transit', description: 'Purchase bills and goods ordered but not yet received' },
  { suffix: 'inventory_account', label: 'Inventory Asset', description: 'Stock on hand value' },
  { suffix: 'allocated_inventory_account', label: 'Allocated Inventory', description: 'Stock allocated to paid orders awaiting dispatch' },
  { suffix: 'cogs_account', label: 'Cost of Goods Sold', description: 'COGS booked on dispatch' },
  { suffix: 'manufacturing_overhead_account', label: 'Manufacturing Overhead', description: 'Overhead absorbed into manufactured stock cost on production completion. Leave blank to capitalise components at material cost only.' },
  // Xero-only: the retrospective COGS revaluation path is Xero-specific (no quickbooks_* key).
  { suffix: 'inventory_revaluation_account', label: 'Inventory Revaluation', description: 'P&L offset for retrospective COGS corrections on goods already sold (e.g. freight cancelled after dispatch). Leave blank to use Stock in Transit.', connectors: ['xero'] },
  { suffix: 'rounding_difference_account', label: 'Rounding Difference', description: 'Optional. Absorbs the sub-penny residue when 6dp inventory values post to the 2dp ledger, so the inventory subledger ties to the GL exactly. Leave blank to keep accepting residue within tolerance (no rounding line posted).' },
  { suffix: 'unearned_revenue_account', label: 'Unearned Revenue', description: 'Liability account for revenue deferred until shipment' },
  { suffix: 'accounts_receivable_account', label: 'Accounts Receivable', description: 'Your Accounts Receivable control account — used as the control side of realised and unrealised FX journals on foreign-currency customer balances' },
  { suffix: 'accounts_payable_account', label: 'Accounts Payable', description: 'Your Accounts Payable control account — used as the control side of realised and unrealised FX journals on foreign-currency supplier balances' },
  { suffix: 'realised_fx_gain_loss_account', label: 'Realised FX Gain/Loss', description: 'P&L account for settlement-rate variances' },
  { suffix: 'unrealised_fx_gain_loss_account', label: 'Unrealised FX Gain/Loss', description: 'Account for open AR/AP revaluation journals' },
]

export const SYNC_TYPE_TOGGLES: AccountFieldDef[] = [
  { suffix: 'sync_sales_invoice', label: 'Sales Invoices', description: 'Push invoices when generated' },
  { suffix: 'sync_credit_note', label: 'Credit Notes', description: 'Push credit notes on refund' },
  { suffix: 'sync_purchase_invoice', label: 'Purchase Bills', description: 'Push supplier bills when PO is invoiced' },
  // Xero-only: supplier credit notes (ACCPAYCREDIT) have no quickbooks_* sync key.
  { suffix: 'sync_purchase_credit_note', label: 'Supplier Credit Notes', description: 'Push supplier credit notes (e.g. a credited duplicate freight bill) as ACCPAYCREDIT', connectors: ['xero'] },
  { suffix: 'sync_stock_receipt', label: 'Stock Receipts', description: 'Journal: DR Inventory / CR Stock in Transit on goods received' },
  { suffix: 'sync_cogs_reversal', label: 'COGS Reversals', description: 'Reverse COGS on stock returns' },
  { suffix: 'sync_inventory_adjustment', label: 'Inventory Adjustments', description: 'Journal for manual stock adjustments' },
  { suffix: 'sync_realised_fx_journal', label: 'Realised FX Journals', description: 'Post settlement-rate gains and losses on foreign payments' },
  { suffix: 'sync_unrealised_fx_journal', label: 'Unrealised FX Revaluation', description: 'Post reversible open AR/AP revaluation journals' },
]

// Connector-prefixed setting suffixes persisted by the form alongside the
// ACCOUNT_FIELDS. Sending a suffix the active connector does not define is
// harmless — the connector's saveSettings allowlists by its own key set.
export const SAVED_SETTING_SUFFIXES = [
  'sync_enabled',
  'sync_sales_invoice', 'sync_credit_note', 'sync_purchase_invoice',
  'sync_cogs_journal', 'sync_cogs_reversal', 'sync_stock_receipt',
  'sync_inventory_adjustment', 'sync_stock_allocation',
  'sync_realised_fx_journal', 'sync_unrealised_fx_journal',
  'sync_attach_pdf',
  'daily_batch_enabled', 'payment_polling_enabled',
]

export function isFieldAvailableForConnector(def: AccountFieldDef, connectorId: AccountingConnectorId): boolean {
  return !def.connectors || def.connectors.includes(connectorId)
}

export function settingKeyFor(connectorId: AccountingConnectorId, suffix: string): string {
  return `${connectorId}_${suffix}`
}

/**
 * Build the connector-prefixed settings payload from the in-form state. Uses the
 * active connector's prefix for every sync/flag suffix plus every account field
 * available on that connector, so QuickBooks account mappings actually persist
 * (the old hardcoded xero_* payload was filtered out by saveQuickBooksSettings).
 */
export function buildAccountingSettingsPayload(
  connectorId: AccountingConnectorId,
  state: Record<string, string>,
): Record<string, string> {
  const payload: Record<string, string> = {}
  for (const suffix of SAVED_SETTING_SUFFIXES) {
    const key = settingKeyFor(connectorId, suffix)
    payload[key] = state[key] ?? ''
  }
  for (const field of ACCOUNT_FIELDS) {
    if (!isFieldAvailableForConnector(field, connectorId)) continue
    const key = settingKeyFor(connectorId, field.suffix)
    payload[key] = state[key] ?? ''
  }
  return payload
}
