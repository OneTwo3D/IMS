import type { InvoiceDocumentDeps } from '@/lib/domain/invoice-documents/fetch-service'
import { downloadLedgerDocumentPdf, lookupInvoiceDocumentClaims, lookupSalesCreditNoteDocumentClaims } from './invoice-document-source'

/** The ledger-backed dependencies of the invoice-document fetch: read-only Xero calls behind the connector's budget. */
export function xeroInvoiceDocumentDeps(): InvoiceDocumentDeps {
  return {
    lookupInvoiceClaims: lookupInvoiceDocumentClaims,
    lookupCreditNoteClaims: lookupSalesCreditNoteDocumentClaims,
    downloadPdf: downloadLedgerDocumentPdf,
    now: () => new Date(),
  }
}
