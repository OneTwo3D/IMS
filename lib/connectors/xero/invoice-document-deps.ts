import type { InvoiceDocumentDeps } from '@/lib/domain/invoice-documents/fetch-service'
import { xeroDayCallsRemaining } from './api'
import { organisationDayCallsRemaining } from './day-limit-observation'
import { getStoredXeroTenantId } from './auth'
import { downloadLedgerDocumentPdf, lookupInvoiceDocumentClaims, lookupSalesCreditNoteDocumentClaims } from './invoice-document-source'

/** The ledger-backed dependencies of the invoice-document fetch: read-only Xero calls behind the connector's budget. */
export function xeroInvoiceDocumentDeps(): InvoiceDocumentDeps {
  return {
    lookupInvoiceClaims: lookupInvoiceDocumentClaims,
    lookupCreditNoteClaims: lookupSalesCreditNoteDocumentClaims,
    downloadPdf: downloadLedgerDocumentPdf,
    now: () => new Date(),
    // o3d-hvzdx: the organisation's allowance as every worker last saw it, not only this process (null when nothing fresh is known: the sweep waits).
    // #1132 LOW-7: read for the organisation IMS is connected to now (no tenant connected: unknown, the sweep waits).
    dayCallsRemaining: async () => organisationDayCallsRemaining(xeroDayCallsRemaining(), await getStoredXeroTenantId().catch(() => null)),
  }
}
