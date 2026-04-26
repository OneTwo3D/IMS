import type {
  AccountingDocumentAdjustment,
  AccountingDocumentEventPayload,
  AccountingDocumentEventType,
  AccountingDocumentLine,
  BuildAccountingDocumentEventInput,
} from './accounting-document-event-types'
import type { AccountingEventDraft, AccountingEventStatus } from './accounting-event-types'

const DEFAULT_STATUS: AccountingEventStatus = 'PENDING'

const DOCUMENT_EVENT_TYPES = new Set<string>([
  'SALES_INVOICE',
  'CREDIT_NOTE',
  'PURCHASE_INVOICE',
])

function requireNonBlank(value: string, field: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${field} is required`)
  return trimmed
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function numberValue(value: unknown, field: string): number | undefined {
  if (value == null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a finite, non-negative number`)
  }
  return Object.is(value, -0) ? 0 : value
}

function coerceBusinessDate(value: Date | string): Date {
  const date = value instanceof Date ? new Date(value) : new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw new Error('businessDate must be a valid date')
  }
  return date
}

function normalizeCurrency(value: string): string {
  return requireNonBlank(value, 'currency').toUpperCase()
}

function normalizeType(value: string): AccountingDocumentEventType {
  const type = requireNonBlank(value, 'type')
  if (!DOCUMENT_EVENT_TYPES.has(type)) {
    throw new Error(`Unsupported accounting document event type: ${type}`)
  }
  return type as AccountingDocumentEventType
}

function normalizeDocumentLine(line: unknown, index: number): AccountingDocumentLine {
  if (!isRecord(line)) throw new Error(`payload.lines[${index}] must be an object`)

  const description = requireNonBlank(stringValue(line.description) ?? '', `payload.lines[${index}].description`)
  const accountCode = requireNonBlank(stringValue(line.accountCode) ?? '', `payload.lines[${index}].accountCode`)
  const quantity = numberValue(line.quantity, `payload.lines[${index}].quantity`)
  const unitAmount = numberValue(line.unitAmount, `payload.lines[${index}].unitAmount`)
  if (quantity == null || quantity <= 0) throw new Error(`payload.lines[${index}].quantity must be positive`)
  if (unitAmount == null) throw new Error(`payload.lines[${index}].unitAmount is required`)
  const itemCode = stringValue(line.itemCode)
  const itemName = stringValue(line.itemName)
  const discountAmount = numberValue(line.discountAmount, `payload.lines[${index}].discountAmount`)
  const discountRate = numberValue(line.discountRate, `payload.lines[${index}].discountRate`)

  return {
    description,
    quantity,
    unitAmount,
    accountCode,
    ...(itemCode ? { itemCode } : {}),
    ...(itemName ? { itemName } : {}),
    ...(typeof line.taxType === 'string' || line.taxType === null ? { taxType: line.taxType } : {}),
    ...(discountAmount !== undefined ? { discountAmount } : {}),
    ...(discountRate !== undefined ? { discountRate } : {}),
    ...(isRecord(line.metadata) ? { metadata: line.metadata } : {}),
  }
}

function normalizeAdjustment(input: {
  amount: unknown
  description: unknown
  accountCode: unknown
  taxType: unknown
  field: string
}): AccountingDocumentAdjustment | undefined {
  const amount = numberValue(input.amount, `${input.field}.amount`)
  if (amount == null || amount <= 0) return undefined

  return {
    amount,
    ...(stringValue(input.description) ? { description: stringValue(input.description) } : {}),
    ...(stringValue(input.accountCode) ? { accountCode: stringValue(input.accountCode) } : {}),
    ...(typeof input.taxType === 'string' || input.taxType === null ? { taxType: input.taxType } : {}),
  }
}

export function isAccountingDocumentEventType(type: string): type is AccountingDocumentEventType {
  return DOCUMENT_EVENT_TYPES.has(type)
}

export function buildAccountingDocumentPayload(params: {
  type: string
  sourceEntityType: string
  sourceEntityId: string
  payload: unknown
  fallbackCurrency: string
}): AccountingDocumentEventPayload {
  const type = normalizeType(params.type)
  const sourceEntityType = requireNonBlank(params.sourceEntityType, 'sourceEntityType')
  const sourceEntityId = requireNonBlank(params.sourceEntityId, 'sourceEntityId')
  if (!isRecord(params.payload)) throw new Error('payload must be an object')

  const payload = params.payload
  const currency = normalizeCurrency(stringValue(payload.currency) ?? params.fallbackCurrency)
  const date = requireNonBlank(stringValue(payload.date) ?? '', 'payload.date')
  const contactName = requireNonBlank(stringValue(payload.contactName) ?? '', 'payload.contactName')
  const lineAmountsIncludeTax = booleanValue(payload.lineAmountsIncludeTax) ?? false
  const lines = Array.isArray(payload.lines)
    ? payload.lines.map((line, index) => normalizeDocumentLine(line, index))
    : []
  if (lines.length === 0) throw new Error('Document accounting events require at least one line')

  const invoiceNumber = stringValue(payload.invoiceNumber)
  const creditNoteNumber = stringValue(payload.creditNoteNumber)
  const contactEmail = stringValue(payload.contactEmail)
  const dueDate = stringValue(payload.dueDate)
  const currencyRateToBase = numberValue(payload.currencyRateToBase, 'payload.currencyRateToBase')
  const reference = stringValue(payload.reference)
  const sourceRefundId = stringValue(payload.sourceRefundId)
    ?? (type === 'CREDIT_NOTE' && sourceEntityType === 'SalesOrderRefund' ? sourceEntityId : undefined)
  const supplierInvoicePath = stringValue(payload.supplierInvoicePath)
  const shipping = normalizeAdjustment({
    amount: payload.shippingAmount,
    description: payload.shippingDescription,
    accountCode: payload.shippingAccountCode,
    taxType: payload.shippingTaxType,
    field: 'payload.shipping',
  })
  const discount = normalizeAdjustment({
    amount: payload.discountAmount,
    description: payload.discountDescription,
    accountCode: payload.discountAccountCode,
    taxType: payload.discountTaxType,
    field: 'payload.discount',
  })

  return {
    kind: 'accounting-document',
    schemaVersion: 1,
    documentType: type,
    ...(invoiceNumber || creditNoteNumber ? { documentNumber: invoiceNumber ?? creditNoteNumber } : {}),
    ...(invoiceNumber ? { invoiceNumber } : {}),
    ...(creditNoteNumber ? { creditNoteNumber } : {}),
    contact: {
      name: contactName,
      ...(contactEmail ? { email: contactEmail } : {}),
    },
    date,
    ...(dueDate ? { dueDate } : {}),
    currency,
    ...(currencyRateToBase !== undefined ? { currencyRateToBase } : {}),
    ...(reference ? { reference } : {}),
    lineAmountMode: lineAmountsIncludeTax ? 'INCLUSIVE' : 'EXCLUSIVE',
    lineAmountsIncludeTax,
    ...(sourceRefundId ? { sourceRefundId } : {}),
    ...(supplierInvoicePath ? { supplierInvoicePath } : {}),
    lines,
    ...(shipping ? { shipping } : {}),
    ...(discount ? { discount } : {}),
  }
}

export function buildAccountingDocumentEvent(input: BuildAccountingDocumentEventInput): AccountingEventDraft {
  const type = normalizeType(input.type)
  const currency = normalizeCurrency(input.currency)

  return {
    type,
    sourceEntityType: requireNonBlank(input.sourceEntityType, 'sourceEntityType'),
    sourceEntityId: requireNonBlank(input.sourceEntityId, 'sourceEntityId'),
    businessDate: coerceBusinessDate(input.businessDate),
    status: input.status ?? DEFAULT_STATUS,
    idempotencyKey: requireNonBlank(input.idempotencyKey, 'idempotencyKey'),
    linesJson: input.payload,
    currency,
    ...(input.externalSystem !== undefined ? { externalSystem: input.externalSystem } : {}),
    ...(input.externalId !== undefined ? { externalId: input.externalId } : {}),
    ...(input.reversalOfId !== undefined ? { reversalOfId: input.reversalOfId } : {}),
  }
}
