import type { Prisma } from '@/app/generated/prisma/client'

/**
 * o3d-nf9i + o3d-osl8 — OPERATOR SETTLEMENT of an AccountingSyncLog row the system cannot
 * resolve for itself.
 *
 * THE TWO STRANDINGS THIS EXISTS FOR. Both are ordinary histories, not corruption.
 *
 *  o3d-nf9i  A FAILED row that must NOT be retried. FAILED is not proof that nothing posted:
 *            both processors make the REMOTE CALL BEFORE persisting SYNCED and the
 *            externalTransactionId (lib/connectors/xero/sync-processor.ts ~L735), so an
 *            exception in that writeback window terminalises the row FAILED with a real
 *            document sitting in the ledger. That is o3d-ju8t, and it is why FAILED is inside
 *            lib/domain/sales/order-delete-guard.ts's LIVE_ACCOUNTING_SYNC_STATUSES.
 *            Two histories strand on it:
 *              - a genuine PART-PAYMENT where one of two INVOICE_PAYMENT rows FAILED, and
 *              - a payment reversed in the ledger and legitimately re-posted, where a stale
 *                SYNCED row's pinned token blocks its replacement.
 *            Neither can be retried safely and neither resolves itself.
 *
 *  o3d-osl8  A PROCESSING row stranded on a RETIRED connector. Since o3d-sref the orphan
 *            sweep deliberately no longer retires an unprovable claim (retiring it read as
 *            "deliberately abandoned" and unblocked a hard delete while the old worker's
 *            request was still in flight), so it stays PROCESSING forever. The only other
 *            remedy is re-enabling a connector whose tenant may be gone, and until then the
 *            order is permanently undeletable.
 *
 * WHAT THIS IS. An operator ASSERTING something the system cannot verify:
 *
 *   { outcome: 'POSTED',     externalTransactionId }  ->  SYNCED, external id recorded
 *   { outcome: 'NOT_POSTED', reason? }                ->  CANCELLED, external id left NULL
 *
 * It is NEVER an automatic reclassification. Nothing in here infers an outcome from
 * errorMessage, age, or retry count — o3d-h2wx already established that errorMessage carries
 * no provenance (both connectors overwrite `HTTP nnn` with the remote system's own text), so
 * the only sound source of the fact is a human who looked in the ledger.
 *
 * Pure functions only, so the decision — which statuses are settleable, the CAS where-shape,
 * the data patch per outcome, and the refusal reasons — is unit-testable without a database,
 * exactly as connector-orphans.ts and followup-idempotency.ts are.
 */

/**
 * The ONLY two statuses an operator may settle.
 *
 *   FAILED      terminal-looking but ambiguous (o3d-nf9i / o3d-ju8t above).
 *   PROCESSING  a claim that was taken and never resolved (o3d-osl8 / o3d-sref above).
 *
 * PENDING is excluded on purpose: nothing was ever sent, so there is no ambiguity to settle,
 * and the ordinary sweeps own it — cancelPendingSalesInvoiceSyncForOrder and
 * cancelOrphanedAccountingSyncRows both retire PENDING rows without needing a human to assert
 * anything. Offering it here would give an operator a second, unfenced way to abandon work
 * the system is perfectly able to abandon correctly by itself.
 *
 * SYNCED and CANCELLED are excluded because they are already terminal: re-settling them would
 * let this action rewrite a recorded outcome, which is the one thing an audited assertion
 * must never be able to do.
 *
 * NOTE THE FOOTGUN. There are two exported constants called LIVE_ACCOUNTING_SYNC_STATUSES:
 * app/actions/accounting-sync.ts's is ['PENDING','PROCESSING'] (what a connector's processor
 * can still claim) and lib/domain/sales/order-delete-guard.ts's is
 * ['PENDING','PROCESSING','SYNCED','FAILED'] (what blocks a hard delete). Neither is the
 * settleable set, so this module defines its own rather than importing either and silently
 * inheriting the wrong membership.
 */
export const SETTLEABLE_ACCOUNTING_SYNC_STATUSES = ['FAILED', 'PROCESSING'] as const

export type SettleableAccountingSyncStatus = (typeof SETTLEABLE_ACCOUNTING_SYNC_STATUSES)[number]

/** Terminal statuses — recorded outcomes, never re-openable from here. */
const TERMINAL_ACCOUNTING_SYNC_STATUSES = new Set(['SYNCED', 'CANCELLED'])

export function isSettleableAccountingSyncStatus(status: string): status is SettleableAccountingSyncStatus {
  return (SETTLEABLE_ACCOUNTING_SYNC_STATUSES as readonly string[]).includes(status)
}

export type SettlementOutcome = 'POSTED' | 'NOT_POSTED'

export type SettlementAssertion =
  | { outcome: 'POSTED'; externalTransactionId: string }
  | { outcome: 'NOT_POSTED'; reason?: string }

export type SettlementRefusalCode =
  | 'pending_not_settleable'
  | 'already_terminal'
  | 'status_not_settleable'
  | 'missing_external_id'
  | 'external_id_conflict'
  | 'contradicts_post_evidence'

export type SettlementRefusal = { code: SettlementRefusalCode; message: string }

/** The subset of the row the decision needs. Everything else is carried for audit only. */
export type SettlementRowView = {
  status: string
  externalTransactionId: string | null
}

function trimmed(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Why this row + this assertion must be refused, or null when it may proceed.
 *
 * Evaluated against the row as READ, which is also the view the operator was shown. The CAS in
 * buildSettlementWhere re-asserts the status at write time, so a row that moves between the
 * read and the write fails there rather than being settled on a stale basis.
 */
export function refuseSettlement(row: SettlementRowView, assertion: SettlementAssertion): SettlementRefusal | null {
  if (row.status === 'PENDING') {
    return {
      code: 'pending_not_settleable',
      message:
        'This row is still PENDING: nothing has been sent, so there is nothing to settle. It will be '
        + 'processed, retried, or retired by the ordinary sweeps.',
    }
  }
  if (TERMINAL_ACCOUNTING_SYNC_STATUSES.has(row.status)) {
    return {
      code: 'already_terminal',
      message: `This row is already ${row.status}. A recorded outcome cannot be re-settled.`,
    }
  }
  if (!isSettleableAccountingSyncStatus(row.status)) {
    return {
      code: 'status_not_settleable',
      message: `Status ${row.status} cannot be settled by hand. Only FAILED and PROCESSING rows can.`,
    }
  }

  const existingExternalId = trimmed(row.externalTransactionId)

  if (assertion.outcome === 'POSTED') {
    const asserted = trimmed(assertion.externalTransactionId)
    if (!asserted) {
      return {
        code: 'missing_external_id',
        message:
          'Asserting POSTED requires the external document id from the accounting system. Without it '
          + 'the row records a post that nothing can be reconciled against.',
      }
    }
    // Re-asserting the SAME id is idempotent (a retried click, a lost response). Asserting a
    // DIFFERENT one would overwrite post evidence the row already carries — the only durable
    // pointer at a document in the ledger — so it is refused rather than clobbered.
    if (existingExternalId && existingExternalId !== asserted) {
      return {
        code: 'external_id_conflict',
        message:
          `This row already carries external id ${existingExternalId}. Settling it as ${asserted} would `
          + 'overwrite the only pointer IMS has at the existing document. Reconcile the two in the ledger first.',
      }
    }
    return null
  }

  // NOT_POSTED against a row that ALREADY carries an external id is a contradiction: the id is
  // post evidence. It also would not achieve what the operator wants — verified in
  // tests/sales-order-delete-guard.test.ts, a CANCELLED row that still carries an external id
  // STILL blocks the hard delete (o3d-v7sy), so the order would stay undeletable anyway.
  if (existingExternalId) {
    return {
      code: 'contradicts_post_evidence',
      message:
        `This row already carries external id ${existingExternalId}, which is evidence it DID post. `
        + 'Settle it as POSTED, or reverse the document in the accounting system first.',
    }
  }
  return null
}

/**
 * The compare-and-set fence.
 *
 * `observedStatus` is the status the operator was SHOWN — passed back by the caller, not
 * re-read here. A mismatch means the row moved (a worker finished it, a sweep retired it,
 * another operator settled it) and the assertion was therefore made against a stale view of
 * the world, so the write must not land. Same shape and same reasoning as
 * markSyncLogForFollowUpRetry's `where: { id, retryCount }` (audit-dzm9) and
 * applyMainSyncFailureRetry's (audit-om4e): the loser of the race changes nothing and reports
 * the PERSISTED state, never its own stale one.
 */
export function buildSettlementWhere(
  syncLogId: string,
  observedStatus: SettleableAccountingSyncStatus,
): Prisma.AccountingSyncLogWhereInput & { id: string; status: SettleableAccountingSyncStatus } {
  return { id: syncLogId, status: observedStatus }
}

/** The message a lost CAS reports — it names the PERSISTED state, not the stale one. */
export function describeLostSettlementCas(persistedStatus: string | null): string {
  return persistedStatus === null
    ? 'This sync row no longer exists (it was purged or deleted while you were looking at it). Nothing was changed.'
    : `This sync row is now ${persistedStatus}, not the status you were shown. Someone or something else `
      + 'resolved it first, so your assertion was not applied. Nothing was changed — reload and look again.'
}

/**
 * The data patch for each outcome.
 *
 * ------------------------------------------------------------------------------------------
 * WHAT TERMINALISING ACTUALLY FREES — the bd issue's wording is misleading, so read this.
 *
 * o3d-nf9i says terminalising "frees the partial unique index slot". That is TRUE ONLY FOR THE
 * NOT_POSTED (CANCELLED) BRANCH. Both partial unique indexes —
 *   accounting_sync_logs_idempotency_key_uq       (migration 20260424214500)
 *   accounting_sync_logs_followup_live_unique     (migration 20260615000000)
 * carry the predicate `status IN ('PENDING','PROCESSING','SYNCED')`. SYNCED is INSIDE them.
 * So the POSTED branch frees NOTHING: the row moves from outside the index (FAILED) to inside
 * it (SYNCED) and now OCCUPIES the slot. That is correct semantics, not a bug — "it really did
 * post" means the follow-up is CLOSED, and hasExistingSyncLog counting PENDING/PROCESSING/
 * SYNCED will (rightly) refuse to enqueue another one.
 * ------------------------------------------------------------------------------------------
 * LOAD-BEARING SIDE EFFECT of the NOT_POSTED branch — deliberate, not incidental.
 *
 * enqueueFollowUpSyncLog selects `status: 'FAILED'` ONLY when it gathers the ambiguity set
 * (lib/connectors/xero/sync-processor.ts ~L293, lib/connectors/quickbooks/sync-processor.ts
 * ~L169). Moving a FAILED row to CANCELLED therefore REMOVES it from that set. For a
 * money-moving type (INVOICE_PAYMENT, PURCHASE_CREDIT_NOTE_ALLOCATION), planFollowUpEnqueue
 * refuses whenever two or more DISTINCT tokens could have committed; cancelling one of them
 * drops the distinct-token count to one and turns that `refuse` into a `create`/`reuse`.
 *
 * That is exactly the intended unblock for the o3d-nf9i part-payment history — and it is also
 * why the operator's assertion has to be a real, audited statement of fact rather than a
 * convenience button. Cancelling a row that DID post would let a duplicate payment out.
 * ------------------------------------------------------------------------------------------
 */
export function buildSettlementData(assertion: SettlementAssertion, now: Date): Prisma.AccountingSyncLogUpdateManyMutationInput {
  if (assertion.outcome === 'POSTED') {
    return {
      status: 'SYNCED',
      externalTransactionId: assertion.externalTransactionId.trim(),
      syncedAt: now,
      // Matches the processors' own success write (xero/sync-processor.ts ~L741): a SYNCED row
      // carries no error text. The failure that made this row need settling is preserved in the
      // activity-log metadata (priorErrorMessage), so nothing is lost.
      errorMessage: null,
      // Release the claim. A PROCESSING row settled this way must not look claimed afterwards.
      processingStartedAt: null,
    }
  }
  return {
    status: 'CANCELLED',
    // externalTransactionId is DELIBERATELY ABSENT from this patch — not set to null.
    //
    // The delete guard (verified in tests/sales-order-delete-guard.test.ts) ranks a row with an
    // external id as "already POSTED, needs explicit reversal or credit note" whatever its
    // status, and a CANCELLED row that still carries one STILL BLOCKS the hard delete. So the
    // NOT_POSTED branch must never WRITE an external id — and equally must never CLEAR one,
    // which would destroy real post evidence. refuseSettlement() has already established that
    // this row carries none, so leaving the column untouched leaves it NULL, which is what
    // makes the order deletable again.
    errorMessage: settlementNote(assertion),
    processingStartedAt: null,
  }
}

/** The free-text note written onto a settled row, in the style of cancel-order-invoice-sync.ts. */
export function settlementNote(assertion: SettlementAssertion): string {
  if (assertion.outcome === 'POSTED') {
    return `Settled by operator: verified POSTED as ${assertion.externalTransactionId.trim()}.`
  }
  const reason = trimmed(assertion.reason)
  return `Settled by operator: verified NOT POSTED — nothing reached the accounting system.${reason ? ` ${reason}` : ''}`
}

/**
 * The mirrored accounting-event status that goes with each outcome.
 *
 * Both connectors and lib/domain/accounting/cancel-order-invoice-sync.ts (~L56-60) terminalise
 * the mirror whenever they terminalise a sync row, because a PENDING mirror left behind reads
 * to reconciliation as work still owed. Settlement is a terminalisation, so it must do the
 * same or it just moves the stranding one table across.
 *
 * VOID (not FAILED, not CANCELLED — the mirror's own enum) is the mirror's "deliberately
 * abandoned, never posted" state, matching voidMirroredAccountingEventsForOrder.
 */
export function settlementMirrorStatus(outcome: SettlementOutcome): 'POSTED' | 'VOID' {
  return outcome === 'POSTED' ? 'POSTED' : 'VOID'
}

/** The external id to stamp on the mirrored event. Null for NOT_POSTED, for the reasons above. */
export function settlementMirrorExternalId(assertion: SettlementAssertion): string | null {
  return assertion.outcome === 'POSTED' ? assertion.externalTransactionId.trim() : null
}

// ---------------------------------------------------------------------------
// o3d-osl8 item 1 — the STRANDED-ROW read model.
//
// "Do NOT present an aggregate count as a remedy — that was the specific criticism." Today
// every accounting log view is scoped to the ACTIVE connector: getAccountingSyncLogs resolves
// the active connector before reading, and getXeroSyncLogs / getQuickBooksSyncLogs hard-filter
// `connector: 'xero' | 'quickbooks'`. A row left behind on a retired connector is therefore
// visible ONLY as the integer in the orphan banner — which tells an operator that something is
// wrong and nothing about WHAT, so there is no way to act on it.
//
// These two functions are the loader's decision content, kept pure so the scoping rule is
// testable without a database.
// ---------------------------------------------------------------------------

/** Statuses a stranded row can be in and still be unresolved work. */
export const STRANDED_ACCOUNTING_SYNC_STATUSES = ['PENDING', 'PROCESSING', 'FAILED'] as const

/**
 * Rows that no processor will ever pick up AND no log view will ever show: unresolved work on
 * a connector other than the active one. When no accounting connector is enabled at all, every
 * unresolved row qualifies — nothing is going to process any of them.
 *
 * Served by @@index([connector, status, createdAt]) on AccountingSyncLog.
 */
export function buildStrandedSyncRowWhere(activeConnector: string | null): Prisma.AccountingSyncLogWhereInput {
  const status = { in: [...STRANDED_ACCOUNTING_SYNC_STATUSES] }
  return activeConnector ? { status, connector: { not: activeConnector } } : { status }
}

export type StrandedSyncRowSource = {
  id: string
  connector: string
  type: string
  status: string
  referenceType: string
  referenceId: string
  externalTransactionId: string | null
  errorMessage: string | null
  createdAt: Date
}

export type StrandedSyncRow = {
  id: string
  connector: string
  type: string
  status: string
  referenceType: string
  referenceId: string
  externalTransactionId: string | null
  errorMessage: string | null
  createdAt: string
  /** Whole days since the row was queued — the "how long has this been stuck" the count hid. */
  ageDays: number
  /** Whether the settlement control applies. PENDING rows are listed but not settleable. */
  settleable: boolean
}

export function describeStrandedSyncRow(row: StrandedSyncRowSource, now: Date): StrandedSyncRow {
  const ageMs = Math.max(0, now.getTime() - row.createdAt.getTime())
  return {
    id: row.id,
    connector: row.connector,
    type: row.type,
    status: row.status,
    referenceType: row.referenceType,
    referenceId: row.referenceId,
    externalTransactionId: row.externalTransactionId,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt.toISOString(),
    ageDays: Math.floor(ageMs / 86_400_000),
    settleable: isSettleableAccountingSyncStatus(row.status),
  }
}
