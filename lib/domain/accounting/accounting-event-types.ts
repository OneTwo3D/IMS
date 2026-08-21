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
  //   `superseded_by_revision`          — a later write of the same document took the id over, on
  //                                       an order the external system's own stamps ESTABLISHED.
  //   `superseded_by_assumed_order`     — o3d-cvj9 r7: the same handover, on an order nothing
  //                                       established — see ASSUMED_REVISION_ORDER_TAKEOVER_ACTION.
  //                                       Its own action, not a flag on the line above, because the
  //                                       accounting reconciliation report selects on it to raise
  //                                       `document_claim_moved_on_assumed_order`; a claim that
  //                                       moved on a guess has to be listable, not merely recorded.
  //   `revision_superseded_by_newer`    — this write arrived after a later one had taken the id.
  //                                       Only the external system's own stamps can say that, so
  //                                       this action is only ever written on their authority.
  //   `revision_claim_yielded_no_write`  — o3d-cvj9 r6: this attempt made NO connector call (the
  //                                       processor's short-circuit replay), so it took no claim.
  //                                       It asserts nothing about which write is newer.
  //   `revision_claim_order_unverified` — o3d-cvj9 r3, administrative backfill only: this write and
  //                                       the holder could not be ordered, so the claim was left
  //                                       where it was. It asserts nothing about which is newer.
  // o3d-cvj9 r6: `superseded_by_revision`, `superseded_by_assumed_order` and
  // `revision_superseded_by_newer` carry `orderingBasis` and `orderingEstablished` in their
  // metadata — an order Xero's stamps settled and one reached by falling back on "a create precedes
  // its revisions" are not the same claim, and whoever reads the trail has to be able to say which
  // one moved the money's document id.
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
