/**
 * Which number a sales order's accounting invoice is posted under (o3d-k26m.1).
 *
 * ONE ORDER, ONE NUMBER. IMS reaches the accounting connector by two routes — the WooCommerce
 * importer, and `queueSalesInvoiceForOrder` when an order is finalised from the IMS side — and
 * they used to derive the number independently: `INWC-<wc order number>` from the importer,
 * `INV-<order number>` from the finaliser. Both are "correct" in isolation and they disagree,
 * which matters because the Xero sales-invoice create is an UPSERT ON InvoiceNumber: two routes
 * with two numbers for one order is two documents, not one document posted twice.
 *
 * So the persisted `SalesOrder.invoiceNumber` wins whenever it exists. For a WooCommerce order
 * that is WooCommerce's own `_wcpdf_invoice_number` — the number on the customer's PDF and on
 * every historical xeroom document. For a manual order it is whatever `generateInvoiceNumber`
 * minted, which IMS already prints on its own invoice and which, until now, was NOT the number
 * Xero received.
 */

export type SalesInvoiceNumberSource = 'persisted' | 'derived'

export function resolveSalesInvoiceNumberForPost(params: {
  /** SalesOrder.invoiceNumber — WooCommerce's number, or one minted by generateInvoiceNumber. */
  persistedInvoiceNumber: string | null | undefined
  /** Prefix from Settings → Company → Numbering (`inv_prefix`). */
  fallbackPrefix: string
  /** The order reference the fallback is derived from (getSalesOrderReference). */
  orderReference: string
}): { invoiceNumber: string; source: SalesInvoiceNumberSource } {
  const persisted = params.persistedInvoiceNumber?.trim()
  if (persisted) return { invoiceNumber: persisted, source: 'persisted' }
  return { invoiceNumber: `${params.fallbackPrefix}${params.orderReference}`, source: 'derived' }
}

/**
 * Shopping connectors that SUPPLY the invoice number rather than receiving one.
 *
 * For these, `SalesOrder.invoiceNumber` is not a slot IMS may fill — it is where the storefront's
 * own number is recorded, and the accounting document is posted under it. Minting a number into
 * that slot does two kinds of damage at once: the order posts to the ledger under a number the
 * customer's own invoice does not carry, and the backfill that captures the real number (guarded
 * on `invoiceNumber: null`) never fires again, so the mistake is permanent.
 */
export const EXTERNAL_INVOICE_NUMBER_CONNECTORS: readonly string[] = ['woocommerce']

export function invoiceNumberIsExternallySupplied(connectors: readonly string[]): boolean {
  return connectors.some((c) => EXTERNAL_INVOICE_NUMBER_CONNECTORS.includes(c))
}
