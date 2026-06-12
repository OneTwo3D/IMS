import type { AccountingEventStatus } from './accounting-event-types'

export type AccountingDocumentEventType =
  | 'SALES_INVOICE'
  | 'SALES_INVOICE_UPDATE'
  | 'CREDIT_NOTE'
  | 'PURCHASE_INVOICE'
  | 'PURCHASE_INVOICE_UPDATE'

export type AccountingDocumentLineAmountMode = 'EXCLUSIVE' | 'INCLUSIVE'

export type AccountingDocumentContact = {
  name: string
  email?: string
}

export type AccountingDocumentLine = {
  description: string
  quantity: number
  unitAmount: number
  accountCode: string
  itemCode?: string
  itemName?: string
  taxType?: string | null
  discountAmount?: number
  discountRate?: number
  metadata?: Record<string, unknown>
}

export type AccountingDocumentAdjustment = {
  amount: number
  description?: string
  accountCode?: string
  taxType?: string | null
}

export type AccountingDocumentEventPayload = {
  kind: 'accounting-document'
  schemaVersion: 1
  documentType: AccountingDocumentEventType
  documentNumber?: string
  invoiceNumber?: string
  creditNoteNumber?: string
  contact: AccountingDocumentContact
  date: string
  dueDate?: string
  currency: string
  currencyRateToBase?: number
  reference?: string
  lineAmountMode: AccountingDocumentLineAmountMode
  lineAmountsIncludeTax: boolean
  sourceRefundId?: string
  supplierInvoicePath?: string
  lines: AccountingDocumentLine[]
  shipping?: AccountingDocumentAdjustment
  discount?: AccountingDocumentAdjustment
}

export type BuildAccountingDocumentEventInput = {
  type: AccountingDocumentEventType
  sourceEntityType: string
  sourceEntityId: string
  businessDate: Date | string
  currency: string
  idempotencyKey: string
  payload: AccountingDocumentEventPayload
  status?: AccountingEventStatus
  externalSystem?: string | null
  externalId?: string | null
  reversalOfId?: string | null
}
