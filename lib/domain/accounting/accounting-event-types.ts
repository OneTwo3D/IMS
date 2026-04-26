export type AccountingEventStatus =
  | 'PENDING'
  | 'POSTED'
  | 'FAILED'
  | 'REVERSED'
  | 'VOID'

export type AccountingEventLine = {
  accountCode: string
  description: string
  debit?: number
  credit?: number
  taxType?: string | null
  tracking?: Record<string, string | number | boolean | null>
  metadata?: Record<string, unknown>
}

export type AccountingEventDraft = {
  type: string
  sourceEntityType: string
  sourceEntityId: string
  businessDate: Date
  status: AccountingEventStatus
  idempotencyKey: string
  linesJson: AccountingEventLine[]
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
  idempotencyKey: string
  lines: AccountingEventLine[]
  status?: AccountingEventStatus
  externalSystem?: string | null
  externalId?: string | null
  reversalOfId?: string | null
}
