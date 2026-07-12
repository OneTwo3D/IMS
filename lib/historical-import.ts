/**
 * Shared progress shape for the historical-sales import surfaced on the Reorder Planning
 * report. The import is currently driven by the WooCommerce connector
 * (lib/connectors/woocommerce/orders.ts), but the progress TYPE is connector-agnostic and
 * lives here so shared page/UI code consumes it without importing from
 * lib/connectors/woocommerce/** (mz3ly th34p / WC-followup Phase 6 boundary).
 */
export type HistoricalImportProgress = {
  status: 'idle' | 'running' | 'done' | 'error'
  message: string
  ordersProcessed: number
  movementsCreated: number
  ordersSkipped: number // already-imported orders
  itemsSkipped: number // line items with no matching SKU
  totalOrders: number
  totalPages: number
  currentPage: number
  errors: string[]
}
