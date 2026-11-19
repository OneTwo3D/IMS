/** Products the product-sync-marks cron hands to the storefront and warehouse per run. */
export const PRODUCT_SYNC_SWEEP_BATCH = 25
/** Cadence of that cron, in minutes (its default schedule is every 5 minutes). */
export const PRODUCT_SYNC_SWEEP_MINUTES = 5
/** A drain that crashed leaves a claim; it is retaken after this long. */
export const PRODUCT_SYNC_CLAIM_LEASE_MINUTES = 15
/** Failed drains per product before it is left parked, visible in the table with its last error. */
export const PRODUCT_SYNC_MAX_ATTEMPTS = 5
