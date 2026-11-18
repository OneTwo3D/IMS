/**
 * WHO NUMBERS SALES INVOICES, AS THE SETTINGS SCREEN STATES IT.
 *
 * While an incumbent writer (Xeroom) owns sales invoices (lib/security/writer-ownership-map.ts, `xero.sales.invoice`),
 * IMS must not change how they are numbered: the invoice number is the one the incumbent posts to the accounting
 * system, and the storefront's own for a WooCommerce order. So a sales invoice number is NOT a configurable document
 * type (lib/domain/numbering/document-types.ts has no entry for it), and the screen shows it read-only with the owner
 * named. This is a statement, never a switch: nothing here reads or writes a number.
 */

import { explainProducerDisposition } from '@/lib/security/producer-disposition'
import { WRITER_OWNER_LABEL } from '@/lib/security/producer-disposition-constants'

export type SalesInvoiceNumberOwner = {
  owner: string
  ownerLabel: string
  /** Always false in this build: no sales invoice numbering is configurable here, whoever owns it. */
  configurable: false
  message: string
}

export function describeSalesInvoiceNumberOwner(): SalesInvoiceNumberOwner {
  const decision = explainProducerDisposition('xero', 'sales.invoice')
  const ownerLabel = WRITER_OWNER_LABEL[decision.owner]
  const message = decision.owner === 'IMS'
    ? 'Sales invoice numbers are not configurable here. IMS does not change how they are numbered.'
    : `Sales invoice numbers belong to ${ownerLabel} and are shown here for information only. IMS does not change how they are numbered, and a WooCommerce order keeps the invoice number its storefront gave it.`
  return { owner: decision.owner, ownerLabel, configurable: false, message }
}
