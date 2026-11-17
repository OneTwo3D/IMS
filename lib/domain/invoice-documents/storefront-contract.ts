/**
 * The names IMS and the storefront's helper plugin agree on for the customer invoice. A leaf module (no imports), so a test can read it
 * without opening a database. Pinned against the plugin's source by tests/connectors/woo-helper-invoice-contract.test.ts.
 */

/** The order meta the helper plugin reads to decide whether to show the invoice download button. */
export const WC_INVOICE_DOCUMENT_META_KEY = '_ims_invoice_pdf_available'
/** The meta value that shows the button. */
export const WC_INVOICE_DOCUMENT_META_VALUE = 'yes'
