/**
 * WooCommerce Shopping Connector
 *
 * Handles all sync between One Two Inventory and WooCommerce:
 * - Order import and status sync (bidirectional)
 * - Product sync (bidirectional)
 * - Stock level sync (IMS → WC)
 * - Refund sync (WC → IMS)
 * - Delivery status (WC → IMS via AST/TrackShip)
 */

// API client
export { getWcCredentials, wcFetch, wcPost, wcPut } from './api'

// Legacy exports
export { startHistoricalImport, getImportProgress, type HistoricalImportProgress } from './orders'
export { fetchWcProductUrl } from './products'
export { getWcDeliveryStatus } from './delivery'

// Sync modules
export { importWcOrder, syncNewWcOrders } from './sync/order-import'
export { syncWcOrderStatus, pushImsStatusToWc } from './sync/order-status'
export { syncWcRefund, syncRefundsForOrder } from './sync/refund-sync'
export { syncWcProductToIms, pushImsProductToWc, syncAllWcProducts } from './sync/product-sync'
export { pushStockToWc } from './sync/stock-sync'
export { processWcCompletion } from './sync/completion-flow'
export { verifyWcWebhook } from './sync/webhook-verify'
