import type { XeroSettings } from '@/lib/connectors/xero/settings'

/**
 * Which Xero account mappings must be set before Xero sync may be switched on (`getXeroSyncReadiness`), and which are only reported.
 * Pure and import-light, so the split is pinned by a unit test (tests/connectors/xero-readiness-accounts.test.ts).
 */
export const REQUIRED_ACCOUNTS: Array<{ key: keyof XeroSettings; label: string }> = [
  { key: 'xero_sales_account', label: 'Sales Revenue' },
  { key: 'xero_shipping_account', label: 'Shipping Income' },
  { key: 'xero_discount_account', label: 'Discounts Given' },
  { key: 'xero_transit_account', label: 'Stock in Transit' },
  { key: 'xero_inventory_account', label: 'Inventory Asset' },
  { key: 'xero_allocated_inventory_account', label: 'Allocated Inventory' },
  { key: 'xero_cogs_account', label: 'Cost of Goods Sold' },
  { key: 'xero_unearned_revenue_account', label: 'Unearned Revenue' },
]

/**
 * o3d-n2ci4 (#1135 review MED-3): MAPPINGS THAT ARE REPORTED, NOT REQUIRED.
 *
 * IMS posts no FX journal to Xero any more (Xero books realised and unrealised currency gains itself), so the AR / AP control accounts
 * and the realised FX account are read only by the IMS FX gain/loss report. Requiring them before sync could be enabled made a fresh
 * install map accounts nothing posts to. They are still listed when unmapped, as information, and never block `ready`. The Unrealised
 * FX account is not listed at all: nothing reads it.
 *
 * NOT A WAY ROUND A POSTING THAT NEEDS ONE: nothing posts to these today (the realised FX journal is suppressed at the enqueue). A
 * future path that posts with one of them (for example a per-event purchase FX difference journal on the Realised FX account) must refuse
 * at its OWN switch while the account is unmapped; it cannot rely on this list.
 */
export const REPORT_ONLY_ACCOUNTS: Array<{ key: keyof XeroSettings; label: string }> = [
  { key: 'xero_accounts_receivable_account', label: 'Accounts Receivable' },
  { key: 'xero_accounts_payable_account', label: 'Accounts Payable' },
  { key: 'xero_realised_fx_gain_loss_account', label: 'Realised FX Gain/Loss' },
]

/**
 * #1140 LOW-1 / purchase FX step-2 LOW-14: WHILE `purchase_event_fx_rates_enabled` IS ON these two accounts are REQUIRED, not reported. The per-event
 * purchase FX journals post the FX difference to Realised FX Gain/Loss and the bill-vs-order price difference to Purchase Price Variance, so a sync
 * that is "ready" without them is ready to refuse (the receipt valuation refuses while either is blank). Realised FX moves from the report-only list
 * to the required one while the switch is on, so it is never listed twice.
 */
export const PURCHASE_FX_REQUIRED_ACCOUNTS: Array<{ key: keyof XeroSettings; label: string }> = [
  { key: 'xero_realised_fx_gain_loss_account', label: 'Realised FX Gain/Loss' },
  { key: 'xero_purchase_price_variance_account', label: 'Purchase Price Variance' },
]

/** The pure split, exported so a test pins which mappings block `ready` and which are only reported. */
export function xeroMissingAccountMappings(settings: XeroSettings, options: { purchaseEventFxEnabled?: boolean } = {}): {
  missingAccounts: Array<{ key: string; label: string }>
  reportOnlyMissingAccounts: Array<{ key: string; label: string }>
} {
  const missing = (list: Array<{ key: keyof XeroSettings; label: string }>) => list
    .filter(a => !settings[a.key])
    .map(a => ({ key: a.key as string, label: a.label }))
  const purchaseFx = options.purchaseEventFxEnabled === true
  const required = purchaseFx ? [...REQUIRED_ACCOUNTS, ...PURCHASE_FX_REQUIRED_ACCOUNTS] : REQUIRED_ACCOUNTS
  const requiredKeys = new Set<string>(required.map((a) => a.key as string))
  const reportOnly = REPORT_ONLY_ACCOUNTS.filter((a) => !requiredKeys.has(a.key as string))
  return { missingAccounts: missing(required), reportOnlyMissingAccounts: missing(reportOnly) }
}
