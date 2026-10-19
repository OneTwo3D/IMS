/**
 * EVERY TABLE OF THE SCHEMA, CLASSIFIED: the one registry behind the empty-target and foreign-data rails.
 *
 * The runner writes a fixed set of tables and nothing else. A first load needs a database that holds none of the business data of the installation, and a resume needs it to hold nothing
 * the run did not put there; both are decided table by table from this registry instead of from a list someone remembered:
 *
 *   RUNNER_WRITES   a table the runner (through the importers) writes. Its rows are accounted for row by row by the observation; on a first run it must be empty (except the audit trail and
 *                   the run record, which have their own rules).
 *   CONFIG_ALLOWED  installation configuration, accounts, logs of the application's own operation, and the schema's migration history. May hold rows. The reason says why.
 *   MUST_BE_EMPTY   every other table: business data the runner never writes. Any row in it is foreign data, on a first run and on every evaluation of a resume.
 *
 * A table that is not in this registry is a table nobody decided about: a unit test fails when the schema has one (so a new table forces a decision), and at run time a table in the
 * database that is not here refuses the load (it is not assumed harmless). Names are the database's table names (the `@@map` of each model).
 */
export type TableKind = 'RUNNER_WRITES' | 'CONFIG_ALLOWED' | 'MUST_BE_EMPTY'

export interface TableClass {
  kind: TableKind
  reason: string
}

export const TABLE_CLASSES: Readonly<Record<string, TableClass>> = {
  '_prisma_migrations': { kind: 'CONFIG_ALLOWED', reason: 'migration history of the schema itself' },
  accounting_account_balance_snapshots: { kind: 'MUST_BE_EMPTY', reason: 'accounting ledger, sync and reconciliation records: business data this runner never writes' },
  accounting_accounts: { kind: 'CONFIG_ALLOWED', reason: 'chart of accounts configuration' },
  accounting_event_logs: { kind: 'MUST_BE_EMPTY', reason: 'accounting ledger, sync and reconciliation records: business data this runner never writes' },
  accounting_events: { kind: 'MUST_BE_EMPTY', reason: 'accounting ledger, sync and reconciliation records: business data this runner never writes' },
  accounting_operator_ledger_checks: { kind: 'MUST_BE_EMPTY', reason: 'accounting ledger, sync and reconciliation records: business data this runner never writes' },
  accounting_posting_refusals: { kind: 'MUST_BE_EMPTY', reason: 'accounting ledger, sync and reconciliation records: business data this runner never writes' },
  accounting_reconciliation_findings: { kind: 'MUST_BE_EMPTY', reason: 'accounting ledger, sync and reconciliation records: business data this runner never writes' },
  accounting_reconciliation_runs: { kind: 'MUST_BE_EMPTY', reason: 'accounting ledger, sync and reconciliation records: business data this runner never writes' },
  accounting_sync_logs: { kind: 'MUST_BE_EMPTY', reason: 'accounting ledger, sync and reconciliation records: business data this runner never writes' },
  accounting_tokens: { kind: 'CONFIG_ALLOWED', reason: 'accounting connector credentials' },
  activity_logs: { kind: 'RUNNER_WRITES', reason: 'audit trail of the run (its import rows name the actor)' },
  adjustment_reasons: { kind: 'CONFIG_ALLOWED', reason: 'configured stock-adjustment reasons' },
  bom_items: { kind: 'RUNNER_WRITES', reason: 'manufacturing BOM items written with a BOM product recipe' },
  boms: { kind: 'RUNNER_WRITES', reason: 'manufacturing BOM written with a BOM product recipe' },
  cogs_entries: { kind: 'MUST_BE_EMPTY', reason: 'cost-of-goods records of sales' },
  cogs_subledger_movements: { kind: 'MUST_BE_EMPTY', reason: 'cost-of-goods records of sales' },
  cost_layer_revaluations: { kind: 'MUST_BE_EMPTY', reason: 'cost-layer history beyond opening layers' },
  cost_layer_source_lines: { kind: 'MUST_BE_EMPTY', reason: 'cost-layer history beyond opening layers' },
  cost_layers: { kind: 'RUNNER_WRITES', reason: 'opening-stock cost layers' },
  cron_runs: { kind: 'CONFIG_ALLOWED', reason: 'run history of scheduled jobs, no business data' },
  currencies: { kind: 'CONFIG_ALLOWED', reason: 'currency list; seeded' },
  customers: { kind: 'MUST_BE_EMPTY', reason: 'customers records: business data this runner never writes' },
  document_templates: { kind: 'CONFIG_ALLOWED', reason: 'configured document templates' },
  email_outbox: { kind: 'MUST_BE_EMPTY', reason: 'outbound email queue and suppressions' },
  email_suppressions: { kind: 'MUST_BE_EMPTY', reason: 'outbound email queue and suppressions' },
  external_wms_bindings: { kind: 'CONFIG_ALLOWED', reason: 'warehouse connector binding configuration' },
  first_load_apply_runs: { kind: 'RUNNER_WRITES', reason: "the runner's own run record" },
  freight_cost_lines: { kind: 'MUST_BE_EMPTY', reason: 'freight on purchase orders' },
  fx_rate_push_log: { kind: 'CONFIG_ALLOWED', reason: 'operational log of exchange-rate pushes, no business data' },
  fx_rates: { kind: 'CONFIG_ALLOWED', reason: 'stored exchange rates (a purchase order needs one; checked by a rail)' },
  hs_code_proposals: { kind: 'MUST_BE_EMPTY', reason: 'customs code proposals' },
  integration_outbox: { kind: 'MUST_BE_EMPTY', reason: 'outbound connector queue' },
  inventory_reservation_snapshot_runs: { kind: 'MUST_BE_EMPTY', reason: 'inventory snapshots' },
  inventory_reservation_snapshots: { kind: 'MUST_BE_EMPTY', reason: 'inventory snapshots' },
  inventory_snapshot_runs: { kind: 'MUST_BE_EMPTY', reason: 'inventory snapshots' },
  inventory_snapshots: { kind: 'MUST_BE_EMPTY', reason: 'inventory snapshots' },
  kit_items: { kind: 'MUST_BE_EMPTY', reason: 'kits records: business data this runner never writes' },
  kits: { kind: 'MUST_BE_EMPTY', reason: 'kits records: business data this runner never writes' },
  landed_cost_links: { kind: 'MUST_BE_EMPTY', reason: 'landed-cost records' },
  landed_cost_revaluation_runs: { kind: 'MUST_BE_EMPTY', reason: 'landed-cost records' },
  manufacturing_cost_lines: { kind: 'MUST_BE_EMPTY', reason: 'manufacturing cost records' },
  notification_read_receipts: { kind: 'CONFIG_ALLOWED', reason: 'which operator read which notification' },
  notifications: { kind: 'CONFIG_ALLOWED', reason: 'operator notifications, no business data' },
  one_time_tokens: { kind: 'CONFIG_ALLOWED', reason: 'login and invitation tokens' },
  order_allocations: { kind: 'MUST_BE_EMPTY', reason: 'sales-order stock allocations' },
  organisations: { kind: 'CONFIG_ALLOWED', reason: 'the company record (base currency); seeded' },
  outbound_shadow_writes: { kind: 'MUST_BE_EMPTY', reason: 'outbound-write shadow record' },
  passkeys: { kind: 'CONFIG_ALLOWED', reason: 'operator login credentials' },
  payments: { kind: 'MUST_BE_EMPTY', reason: 'payments records: business data this runner never writes' },
  product_categories: { kind: 'RUNNER_WRITES', reason: 'categories created by the products importer' },
  product_components: { kind: 'RUNNER_WRITES', reason: 'recipe components written with a KIT or BOM' },
  product_contents: { kind: 'MUST_BE_EMPTY', reason: 'product web content' },
  product_options: { kind: 'MUST_BE_EMPTY', reason: 'variant options' },
  production_orders: { kind: 'MUST_BE_EMPTY', reason: 'manufacturing orders' },
  products: { kind: 'RUNNER_WRITES', reason: 'the product catalogue' },
  purchase_invoice_lines: { kind: 'MUST_BE_EMPTY', reason: 'purchase invoices, receipts and returns' },
  purchase_invoices: { kind: 'MUST_BE_EMPTY', reason: 'purchase invoices, receipts and returns' },
  purchase_order_lines: { kind: 'RUNNER_WRITES', reason: 'lines of the purchase orders the runner may load' },
  purchase_orders: { kind: 'RUNNER_WRITES', reason: 'the purchase orders the runner may load' },
  purchase_receipt_lines: { kind: 'MUST_BE_EMPTY', reason: 'purchase invoices, receipts and returns' },
  purchase_receipts: { kind: 'MUST_BE_EMPTY', reason: 'purchase invoices, receipts and returns' },
  purchase_return_lines: { kind: 'MUST_BE_EMPTY', reason: 'purchase invoices, receipts and returns' },
  purchase_returns: { kind: 'MUST_BE_EMPTY', reason: 'purchase invoices, receipts and returns' },
  purchase_units: { kind: 'CONFIG_ALLOWED', reason: 'configured units of measure' },
  sales_order_lines: { kind: 'MUST_BE_EMPTY', reason: 'sales orders and their refunds' },
  sales_order_refund_lines: { kind: 'MUST_BE_EMPTY', reason: 'sales orders and their refunds' },
  sales_order_refunds: { kind: 'MUST_BE_EMPTY', reason: 'sales orders and their refunds' },
  sales_orders: { kind: 'MUST_BE_EMPTY', reason: 'sales orders and their refunds' },
  sessions: { kind: 'CONFIG_ALLOWED', reason: 'login sessions of operators' },
  settings: { kind: 'CONFIG_ALLOWED', reason: 'installation settings; seeded and provisioned' },
  shipment_lines: { kind: 'MUST_BE_EMPTY', reason: 'shipments records: business data this runner never writes' },
  shipments: { kind: 'MUST_BE_EMPTY', reason: 'shipments records: business data this runner never writes' },
  shopping_customer_links: { kind: 'MUST_BE_EMPTY', reason: 'storefront links, logs and webhook events' },
  shopping_order_links: { kind: 'MUST_BE_EMPTY', reason: 'storefront links, logs and webhook events' },
  shopping_product_links: { kind: 'MUST_BE_EMPTY', reason: 'storefront links, logs and webhook events' },
  shopping_status_mappings: { kind: 'CONFIG_ALLOWED', reason: 'storefront connector status mapping configuration; seeded' },
  shopping_sync_logs: { kind: 'MUST_BE_EMPTY', reason: 'storefront links, logs and webhook events' },
  shopping_tax_rate_mappings: { kind: 'CONFIG_ALLOWED', reason: 'storefront connector tax-rate mapping configuration' },
  shopping_webhook_events: { kind: 'MUST_BE_EMPTY', reason: 'storefront links, logs and webhook events' },
  stock_count_lines: { kind: 'MUST_BE_EMPTY', reason: 'stock counts' },
  stock_counts: { kind: 'MUST_BE_EMPTY', reason: 'stock counts' },
  stock_levels: { kind: 'RUNNER_WRITES', reason: 'stock levels written with opening stock' },
  stock_movement_backfill_audit: { kind: 'MUST_BE_EMPTY', reason: 'stock-movement backfill audit' },
  stock_movements: { kind: 'RUNNER_WRITES', reason: 'opening-stock movements' },
  stock_sync_jobs: { kind: 'MUST_BE_EMPTY', reason: 'stock-sync state and jobs' },
  stock_sync_states: { kind: 'MUST_BE_EMPTY', reason: 'stock-sync state and jobs' },
  stock_transfer_lines: { kind: 'MUST_BE_EMPTY', reason: 'stock transfers' },
  stock_transfers: { kind: 'MUST_BE_EMPTY', reason: 'stock transfers' },
  supplier_credit_notes: { kind: 'MUST_BE_EMPTY', reason: 'supplier credit notes' },
  supplier_products: { kind: 'RUNNER_WRITES', reason: 'price cache written by every purchase order' },
  suppliers: { kind: 'RUNNER_WRITES', reason: 'the supplier list' },
  tax_rate_components: { kind: 'CONFIG_ALLOWED', reason: 'components of the tax rates' },
  tax_rates: { kind: 'CONFIG_ALLOWED', reason: 'tax rates (checked by the tax rails)' },
  transit_subledger_movements: { kind: 'MUST_BE_EMPTY', reason: 'in-transit ledger' },
  users: { kind: 'CONFIG_ALLOWED', reason: 'operator accounts' },
  warehouses: { kind: 'CONFIG_ALLOWED', reason: 'the warehouses the load needs; configuration (their profile is checked by a rail)' },
  wc_withdrawal_suppressions: { kind: 'MUST_BE_EMPTY', reason: 'storefront withdrawal suppressions' },
  wms_asn_line_maps: { kind: 'MUST_BE_EMPTY', reason: 'warehouse-connector records' },
  wms_asn_maps: { kind: 'MUST_BE_EMPTY', reason: 'warehouse-connector records' },
  wms_bundle_links: { kind: 'MUST_BE_EMPTY', reason: 'warehouse-connector records' },
  wms_connections: { kind: 'CONFIG_ALLOWED', reason: 'warehouse connector configuration' },
  wms_inbound_receipt_events: { kind: 'MUST_BE_EMPTY', reason: 'warehouse-connector records' },
  wms_mutation_events: { kind: 'MUST_BE_EMPTY', reason: 'warehouse-connector records' },
  wms_order_discrepancies: { kind: 'MUST_BE_EMPTY', reason: 'warehouse-connector records' },
  wms_order_push_links: { kind: 'MUST_BE_EMPTY', reason: 'warehouse-connector records' },
  wms_order_status_snapshots: { kind: 'MUST_BE_EMPTY', reason: 'warehouse-connector records' },
  wms_product_links: { kind: 'MUST_BE_EMPTY', reason: 'warehouse-connector records' },
  wms_returns_inbox: { kind: 'MUST_BE_EMPTY', reason: 'warehouse-connector records' },
  wms_stock_discrepancies: { kind: 'MUST_BE_EMPTY', reason: 'warehouse-connector records' },
  wms_stock_snapshots: { kind: 'MUST_BE_EMPTY', reason: 'warehouse-connector records' },
  wms_sync_jobs: { kind: 'MUST_BE_EMPTY', reason: 'warehouse-connector records' },
  wms_sync_logs: { kind: 'MUST_BE_EMPTY', reason: 'warehouse-connector records' },
  wms_webhook_events: { kind: 'MUST_BE_EMPTY', reason: 'warehouse-connector records' },
}

/** RUNNER_WRITES tables that may hold rows on a first run: the audit trail (the application logs its own use) and the run record (it has its own rule). */
export const FRESH_RUN_MAY_HOLD: ReadonlySet<string> = new Set(['activity_logs', 'first_load_apply_runs'])

export const tablesOfKind = (kind: TableKind): string[] => Object.entries(TABLE_CLASSES).filter(([, c]) => c.kind === kind).map(([name]) => name).sort()
