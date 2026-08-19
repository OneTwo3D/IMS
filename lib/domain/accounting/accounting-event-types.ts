export type AccountingEventStatus =
  | 'PENDING'
  | 'POSTED'
  | 'FAILED'
  | 'REVERSED'
  | 'VOID'
  // o3d-cvj9: this event posted, and a LATER revision of the same external document has since
  // taken over its external id (accounting_events is @@unique([externalSystem, externalId]), so
  // exactly one row may claim a document at a time). The row keeps the payload it posted, so the
  // revision chain stays readable; `superseded_by_revision` in its event log names the successor.
  | 'SUPERSEDED'

export type AccountingEventLine = {
  accountCode: string
  description: string
  debit?: number
  credit?: number
  taxType?: string | null
  tracking?: Record<string, string | number | boolean | null>
  metadata?: Record<string, unknown>
}

export type AccountingEventPayload = AccountingEventLine[] | Record<string, unknown>

export type AccountingEventDraft = {
  type: string
  sourceEntityType: string
  sourceEntityId: string
  businessDate: Date
  status: AccountingEventStatus
  idempotencyKey: string
  linesJson: AccountingEventPayload
  currency: string
  externalSystem?: string | null
  externalId?: string | null
  reversalOfId?: string | null
}

export type AccountingEventLogDraft = {
  accountingEventId: string
  action: string
  message?: string | null
  metadata?: Record<string, unknown> | null
}

export type BuildAccountingEventInput = {
  type: string
  sourceEntityType: string
  sourceEntityId: string
  businessDate: Date | string
  currency: string
  idempotencyKey: string
  lines: AccountingEventLine[]
  status?: AccountingEventStatus
  externalSystem?: string | null
  externalId?: string | null
  reversalOfId?: string | null
}
