/**
 * XeroConnector — implements AccountingConnector interface.
 * Main entry point for the Xero accounting connector module.
 */

import type {
  AccountingConnector,
  JournalEntry,
  InvoiceData,
  BillData,
  CreditNoteData,
  SyncResult,
} from '../types'
import { isConnected } from './auth'
import { syncChartOfAccounts } from './accounts'
import { findOrCreateContact } from './contacts'
import { findOrCreateItem } from './items'
import { pushSalesInvoice } from './invoices'
import { pushPurchaseBill } from './bills'
import { pushCreditNote } from './credit-notes'
import { pushManualJournal } from './journals'
import { getSettingValue } from '@/lib/settings-store'

export class XeroConnector implements AccountingConnector {
  readonly id = 'xero'
  readonly name = 'Xero'

  async isConfigured(): Promise<boolean> {
    const [clientId, clientSecret] = await Promise.all([
      getSettingValue('xero_client_id'),
      getSettingValue('xero_client_secret'),
    ])
    return !!(clientId && clientSecret)
  }

  async isConnected(): Promise<boolean> {
    const status = await isConnected()
    return status.connected
  }

  async postJournalEntry(entry: JournalEntry): Promise<SyncResult> {
    const result = await pushManualJournal(entry)
    return { success: result.success, externalId: result.journalId, error: result.error }
  }

  async postInvoice(data: InvoiceData): Promise<SyncResult> {
    const result = await pushSalesInvoice(data)
    return { success: result.success, externalId: result.invoiceId, error: result.error }
  }

  async postBill(data: BillData): Promise<SyncResult> {
    const result = await pushPurchaseBill(data)
    return { success: result.success, externalId: result.invoiceId, error: result.error }
  }

  async postCreditNote(data: CreditNoteData): Promise<SyncResult> {
    const result = await pushCreditNote(data)
    return { success: result.success, externalId: result.creditNoteId, error: result.error }
  }

  async findOrCreateContact(name: string, email?: string, isSupplier?: boolean): Promise<SyncResult> {
    const result = await findOrCreateContact(name, email, isSupplier)
    return { success: result.success, externalId: result.contactId, error: result.error }
  }

  async findOrCreateItem(code: string, name: string): Promise<SyncResult> {
    const result = await findOrCreateItem(code, name)
    return { success: result.success, externalId: result.itemId, error: result.error }
  }

  async syncAccounts(): Promise<{ synced: number; errors: string[] }> {
    return syncChartOfAccounts()
  }
}

// Re-export submodules for direct use
export { getAuthorizationUrl, consumeXeroOAuthState, exchangeCodeForTokens, disconnect, isConnected, getAccessToken } from './auth'
export { syncChartOfAccounts, getXeroTaxRates } from './accounts'
export { findOrCreateContact } from './contacts'
export { findOrCreateItem } from './items'
export { pushSalesInvoice } from './invoices'
export { pushPurchaseBill } from './bills'
export { pushCreditNote } from './credit-notes'
export { pushManualJournal } from './journals'
export { processPendingXeroSync } from './sync-processor'
export { syncXeroAccountBalanceSnapshots, parseXeroTrialBalanceRows } from './account-balances'
