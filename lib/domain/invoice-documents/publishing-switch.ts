import { getSettingValue } from '@/lib/settings-store'

/**
 * The one switch for putting the stored customer invoice in front of the customer through IMS: the My Account download flag AND the invoice
 * e-mail's attachment. OFF BY DEFAULT: only an explicit `true` turns it on; unset, empty or anything else is off.
 *
 * Kept apart from the storefront writer so the e-mail builder can read it without importing a storefront connector.
 */
export const WC_INVOICE_DOCUMENT_ENABLED_SETTING = 'wc_invoice_document_enabled'

export async function isInvoiceDocumentPublishingEnabled(): Promise<boolean> {
  return (await getSettingValue(WC_INVOICE_DOCUMENT_ENABLED_SETTING)) === 'true'
}
