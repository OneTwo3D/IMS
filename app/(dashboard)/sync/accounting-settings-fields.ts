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

export const ACCOUNTING_CONNECTOR_IDS = ['xero', 'quickbooks'] as const
export type AccountingConnectorId = (typeof ACCOUNTING_CONNECTOR_IDS)[number]

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
 * Account mappings that MUST NOT share a code, with the reason the reconciliation breaks
 * if they do. Pure data so the rule is reviewable next to the fields it governs.
 */
const MUST_BE_DISTINCT: Array<{ a: string; b: string; why: string }> = [
  {
    a: 'transit_account',
    b: 'allocated_inventory_account',
    why:
      'the transit GL reconciliation compares the period movement of the transit account against the ' +
      'transit subledger, on the premise that ONLY the enumerated purchase streams move that account. ' +
      'The daily batch codes allocated inventory (DR on allocation, CR on COGS) and those movements are ' +
      'not in the transit subledger, so sharing a code makes the sweep flag every window with sales ' +
      'activity — permanently, and never swept. Allocated stock would also be reported inside Stock in ' +
      'Transit on the balance sheet',
  },
]

/** Every setting key the collision rules could involve, across all connectors. */
export function accountMappingRuleKeys(): string[] {
  return ACCOUNTING_CONNECTOR_IDS.flatMap((c) =>
    MUST_BE_DISTINCT.flatMap((r) => [settingKeyFor(c, r.a), settingKeyFor(c, r.b)]),
  )
}

export type AccountMappingError = {
  /** The setting keys involved, so a caller can tell whether THIS save touched them. */
  keys: string[]
  message: string
}

/**
 * Reject account mappings whose collision would silently corrupt a reconciliation.
 *
 * Pure, so it can be unit-tested and reused by both the save path and any readiness view.
 * Empty result means valid.
 *
 * This exists because stage ran with allocated_inventory_account == transit_account (both
 * 632) and NOTHING complained — not the save path, not a readiness check (o3d-f82). The
 * misconfiguration is invisible until a reconciliation sweep flags a gap that looks like a
 * data problem rather than a settings one.
 *
 * @param payload the settings about to be saved (connector-prefixed keys).
 * @param current the settings as currently stored, when known. Supplying it makes the
 *   check "you may not INTRODUCE a collision" rather than "you may not save anything while
 *   one exists" — see the lockout note below. Omit to validate the payload alone.
 */
export function validateAccountingAccountMapping(
  payload: Record<string, string>,
  current?: Record<string, string>,
): AccountMappingError[] {
  const labelFor = (suffix: string) => ACCOUNT_FIELDS.find((f) => f.suffix === suffix)?.label ?? suffix
  const errors: AccountMappingError[] = []
  // Validate whatever prefixes are actually PRESENT in the payload rather than trusting a
  // caller-supplied connector id.
  //
  // The first cut took the connector from saveAccountingSettings' getActiveAccountingConnector(),
  // which is xero-first and independent of the ?connector= URL param the client builds its
  // payload from (xero-client.tsx:157). So a QuickBooks save would be checked against
  // xero_* keys, find nothing, and the guard would silently never fire — a guard that
  // reports success is worse than no guard. Keys absent from the payload are skipped
  // anyway, so checking both prefixes costs nothing and cannot mis-fire.
  for (const connectorId of ACCOUNTING_CONNECTOR_IDS) {
    for (const rule of MUST_BE_DISTINCT) {
      const aKey = settingKeyFor(connectorId, rule.a)
      const bKey = settingKeyFor(connectorId, rule.b)
      const aVal = (payload[aKey] ?? '').trim()
      const bVal = (payload[bKey] ?? '').trim()
      // Blank is "not configured", not a collision — several of these are legitimately unset.
      if (!aVal || !bVal || aVal !== bVal) continue

      // Do not punish an admin for a collision that ALREADY exists and that this save does
      // not touch. Otherwise: settings already collide, the account cache is empty or the
      // connector is disconnected so the UI hides the account selectors entirely, the
      // admin tries to turn sync OFF — and the save is refused over two fields they
      // cannot even see. The guard would lock them out of repairing it. Rule is therefore
      // "you may not INTRODUCE the collision", not "nothing works while one exists".
      if (current) {
        const unchanged =
          (current[aKey] ?? '').trim() === aVal && (current[bKey] ?? '').trim() === bVal
        if (unchanged) continue
      }

      errors.push({
        keys: [aKey, bKey],
        message:
          `"${labelFor(rule.a)}" and "${labelFor(rule.b)}" are both set to account ${aVal}. ` +
          `They must be different accounts: ${rule.why}.`,
      })
    }
  }
  return errors
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
