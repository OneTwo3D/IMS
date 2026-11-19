import { getSettingValue } from '@/lib/settings-store'

/**
 * THE ONE SWITCH FOR IMS'S WOOCOMMERCE INVOICE NOTE. OFF BY DEFAULT: only an explicit `true` turns it on; unset, empty or anything else is off.
 *
 * Until step X of the switchover Xeroom writes the order note and IMS's stays off; at step X this goes on and Xeroom's note goes off (the mu-plugin
 * option o3d_xeroom_order_note_off). It used to follow `xero_sync_sales_invoice`, which defaults on, so the note would have been written as soon as the
 * Xero flow ran, alongside Xeroom's. It is independent of the Xero document switches and of `wc_invoice_document_enabled` (the customer download flag).
 */
export const WC_INVOICE_NOTE_ENABLED_SETTING = 'wc_invoice_note_enabled'

export async function isInvoiceNoteEnabled(): Promise<boolean> {
  return (await getSettingValue(WC_INVOICE_NOTE_ENABLED_SETTING)) === 'true'
}

