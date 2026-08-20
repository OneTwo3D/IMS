export type AccountingEventStatus =
  | 'PENDING'
  | 'POSTED'
  | 'FAILED'
  | 'REVERSED'
  | 'VOID'
  // o3d-cvj9: this event posted and does NOT hold its external document's id — another event row
  // does (accounting_events is @@unique([externalSystem, externalId]), so exactly one row may claim
  // a document at a time). The row keeps the payload it posted, so the revision chain stays
  // readable, and its event log says WHY it holds no claim:
  //   `superseded_by_revision`          — a later write of the same document took the id over.
  //   `revision_superseded_by_newer`    — this write arrived after a later one had taken the id.
  //   `revision_claim_order_unverified` — o3d-cvj9 r3, administrative backfill only: this write and
  //                                       the holder could not be ordered, so the claim was left
  //                                       where it was. It asserts nothing about which is newer.
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
