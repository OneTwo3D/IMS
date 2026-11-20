/**
 * THE INSTANT THE OPENING STOCK WAS TAKEN (o3d-hqvrp.92).
 *
 * The first-load apply records it, once, on the run record's `facts`, just before it writes the first opening-stock row: it is the manifest's `stockExtractedAt`, the instant the Qoblex stock was READ (not the apply time). Opening stock is a
 * quiescent snapshot, so every sale completed BEFORE this instant is already reflected in the quantities and cost layers it loaded; a sale
 * completed at or after it is not. The storefront order import uses it to decide which first-seen completed orders may consume stock: only
 * those completed at or after it. Nothing here guesses: an ABSENT instant reads as `null`, and the reader of a `null` consumes nothing (fail closed). A read error or a malformed
 * value THROWS, so the caller fails and is retried instead of misclassifying an order for good.
 */
export const OPENING_STOCK_CUTOFF_FACT = 'openingStockCutoffAt'
