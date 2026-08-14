import type { Prisma } from '@/app/generated/prisma/client'
import { isUniqueConstraintViolation, uniqueConstraintFields } from '@/lib/db/prisma-unique-violation'

/**
 * o3d-nf9i (all of it) + o3d-osl8 (its item 1 ONLY) — OPERATOR SETTLEMENT of an
 * AccountingSyncLog row the system cannot resolve for itself.
 *
 * WHAT SHIPS HERE, AND WHAT DELIBERATELY DOES NOT.
 *
 *  o3d-nf9i  CLOSED by this module. A FAILED row that must NOT be retried. FAILED is not proof
 *            that nothing posted: both processors make the REMOTE CALL BEFORE persisting SYNCED
 *            and the externalTransactionId (lib/connectors/xero/sync-processor.ts ~L735), so an
 *            exception in that writeback window terminalises the row FAILED with a real
 *            document sitting in the ledger. That is o3d-ju8t, and it is why FAILED is inside
 *            lib/domain/sales/order-delete-guard.ts's LIVE_ACCOUNTING_SYNC_STATUSES.
 *            Two histories strand on it:
 *              - a genuine PART-PAYMENT where one of two INVOICE_PAYMENT rows FAILED, and
 *              - a payment reversed in the ledger and legitimately re-posted, where a stale
 *                SYNCED row's pinned token blocks its replacement.
 *            Neither can be retried safely and neither resolves itself. A FAILED row is also
 *            the one status that is genuinely SAFE to settle: it is terminal, so no worker
 *            holds it and no remote call is owed against it.
 *
 *  o3d-osl8  ONLY ITEM 1 (the stranded-row LOADER) ships. A PROCESSING row stranded on a
 *            RETIRED connector is now VISIBLE — which is the whole of item 1, and which nothing
 *            else in the product provided — but it is NOT settleable, and the rest of o3d-osl8
 *            stays open.
 *
 * WHY PROCESSING IS NOT SETTLEABLE — read this before "restoring" it.
 *
 *   A CAS on `status = 'PROCESSING'` proves only that the row STILL SAYS PROCESSING. It does
 *   not prove the worker's remote call finished, and it does not prove the operator is settling
 *   the same claim the worker took. The losing interleaving is ordinary, not exotic:
 *
 *     worker claims the row -> issues the remote call -> operator (correctly, at that instant)
 *     sees no document in the ledger -> asserts NOT_POSTED -> row goes CANCELLED -> the delete
 *     guard no longer blocks -> the order is hard-deleted -> the call lands.
 *
 *   That is EXACTLY the stranded-document ending the guard exists to prevent, and it is why
 *   o3d-sref made the orphan sweep stop retiring unprovable claims in the first place. Offering
 *   a human the button the sweep was forbidden re-opens the hole with a name on it.
 *
 *   Closing it needs an immutable claim/attempt GENERATION on the row that the connectors'
 *   writeback also compare-and-sets on, so a settlement can fence a specific attempt and a late
 *   writeback loses. That is connector work, tracked under o3d-osl8, and it is not this module.
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
 * The ONLY status an operator may settle.
 *
 *   FAILED  terminal-looking but ambiguous (o3d-nf9i / o3d-ju8t above), and — crucially —
 *           TERMINAL, so no worker holds it and no remote call is outstanding against it. The
 *           row is not going to move under the operator's feet by itself; only another human
 *           or a retry can move it, and the CAS catches both.
 *
 * PROCESSING is excluded: see the module comment. A CAS on PROCESSING fences the ROW, not the
 * CLAIM, so it cannot tell a finished call from one still in flight. Settling it is only safe
 * once the claim carries a generation the connectors' writeback also CASes on (o3d-osl8).
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
export const SETTLEABLE_ACCOUNTING_SYNC_STATUSES = ['FAILED'] as const

export type SettleableAccountingSyncStatus = (typeof SETTLEABLE_ACCOUNTING_SYNC_STATUSES)[number]

/** Terminal statuses — recorded outcomes, never re-openable from here. */
const TERMINAL_ACCOUNTING_SYNC_STATUSES = new Set(['SYNCED', 'CANCELLED'])

export function isSettleableAccountingSyncStatus(status: string): status is SettleableAccountingSyncStatus {
  return (SETTLEABLE_ACCOUNTING_SYNC_STATUSES as readonly string[]).includes(status)
}

/**
 * DAILY_BATCH_* rows are NOT settleable, whatever their status.
 *
 * A daily-batch row is not keyed by an order: it is keyed by `referenceType='DailyBatch'` and a
 * synthetic `<group>-<date>[-digest]` referenceId covering EVERY order staged into that batch.
 * CANCELLED is read as "this batch never posted" by two different readers that do not
 * coordinate:
 *
 *   1. the daily-batch RECREATORS, which take the absence of a live batch row as licence to
 *      re-derive and re-post the journal from the staged orders, and
 *   2. lib/domain/sales/order-delete-guard.ts, whose `daily_batch_staged` check selects only
 *      LIVE_ACCOUNTING_SYNC_STATUSES, so a CANCELLED batch row blocks nothing.
 *
 * Settling one NOT_POSTED therefore opens this race: the recreator reads the staged orders, the
 * delete guard sees only the CANCELLED row and permits the hard delete, and the recreator then
 * posts a journal containing the deleted order's amount — an amount nothing in IMS can now
 * explain, in a journal nothing can un-post.
 *
 * A batch is a FINANCE-level correction (reverse the journal in the ledger, let the sweep
 * re-derive), never a per-row operator assertion, so the settlement action refuses the whole
 * family rather than trying to sequence the two readers.
 */
export const DAILY_BATCH_SYNC_TYPE_PREFIX = 'DAILY_BATCH_'

export function isSettleableAccountingSyncType(type: string): boolean {
  return !type.startsWith(DAILY_BATCH_SYNC_TYPE_PREFIX)
}

export type SettlementOutcome = 'POSTED' | 'NOT_POSTED'

export type SettlementAssertion =
  | { outcome: 'POSTED'; externalTransactionId: string }
  | { outcome: 'NOT_POSTED'; reason?: string }

export type SettlementRefusalCode =
  | 'pending_not_settleable'
  | 'processing_claim_unprovable'
  | 'already_terminal'
  | 'status_not_settleable'
  | 'daily_batch_not_settleable'
  | 'missing_external_id'
  | 'external_id_conflict'
  | 'contradicts_post_evidence'

export type SettlementRefusal = { code: SettlementRefusalCode; message: string }

/** The subset of the row the decision needs. Everything else is carried for audit only. */
export type SettlementRowView = {
  status: string
  /** DAILY_BATCH_* is refused whatever the status — see isSettleableAccountingSyncType. */
  type: string
  externalTransactionId: string | null
}

function trimmed(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}

const PENDING_REFUSAL_MESSAGE =
  'This row is still PENDING: nothing has been sent, so there is nothing to settle. It will be '
  + 'processed, retried, or retired by the ordinary sweeps.'

/**
 * The honest reason PROCESSING is refused. It names the limitation rather than pretending the
 * status is uninteresting: the operator CAN see the row (that is o3d-osl8 item 1, and it ships),
 * they simply cannot settle it yet, and the message says exactly what is missing and why.
 */
const PROCESSING_REFUSAL_MESSAGE =
  'This row is PROCESSING: a worker claimed it and its remote call may STILL BE IN FLIGHT. '
  + 'Settling it cannot be made safe yet — the claim carries no generation, so nothing can prove '
  + 'the call has finished, nor that you are settling the same attempt that is running. A '
  + '"did not post" recorded here would unblock the order delete while the call was still landing, '
  + 'which is precisely the stranded document the delete guard exists to prevent (o3d-sref). '
  + 'Re-enable that connector so the claim can finish; settling an in-flight claim needs a fenced '
  + 'claim generation on the row, tracked in o3d-osl8.'

function describeDailyBatchRefusal(type: string): string {
  return `${type} is a DAILY BATCH row and cannot be settled by hand. A batch row is keyed by the `
    + 'batch, not by one order, and CANCELLED reads as "never posted" BOTH to the batch recreators '
    + 'and to the order delete guard. Settling it would let an order be hard-deleted while a '
    + 'recreate is already building a journal that still contains that order\'s value. Reverse the '
    + 'journal in the accounting system and let the batch sweep re-derive it instead.'
}

/**
 * The refusal an operator gets for a status they may not settle. Exported so the server action
 * can refuse on the SHOWN status — before it reads the row at all — with the same wording the
 * post-read refusal would produce.
 */
export function describeUnsettleableStatus(status: string): string {
  if (status === 'PENDING') return PENDING_REFUSAL_MESSAGE
  if (status === 'PROCESSING') return PROCESSING_REFUSAL_MESSAGE
  if (TERMINAL_ACCOUNTING_SYNC_STATUSES.has(status)) {
    return `This row is already ${status}. A recorded outcome cannot be re-settled.`
  }
  return `Status ${status} cannot be settled by hand. Only FAILED rows can.`
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
    return { code: 'pending_not_settleable', message: PENDING_REFUSAL_MESSAGE }
  }
  if (row.status === 'PROCESSING') {
    return { code: 'processing_claim_unprovable', message: PROCESSING_REFUSAL_MESSAGE }
  }
  if (TERMINAL_ACCOUNTING_SYNC_STATUSES.has(row.status)) {
    return {
      code: 'already_terminal',
      message: `This row is already ${row.status}. A recorded outcome cannot be re-settled.`,
    }
  }
  if (!isSettleableAccountingSyncStatus(row.status)) {
    return { code: 'status_not_settleable', message: describeUnsettleableStatus(row.status) }
  }
  // Type check AFTER status: a DAILY_BATCH row is refused on its type even when its status is
  // otherwise settleable, and the message must name the batch race rather than the status.
  if (!isSettleableAccountingSyncType(row.type)) {
    return { code: 'daily_batch_not_settleable', message: describeDailyBatchRefusal(row.type) }
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
      // Clear any stale claim stamp. Only FAILED rows reach here and a FAILED row holds no live
      // claim, but a row that failed mid-claim can still carry the stamp, and a settled row must
      // not look claimed afterwards.
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
// MIRROR OWNERSHIP — whose accounting event is it, actually?
// ---------------------------------------------------------------------------

/**
 * MIRROR IDENTITY IS LOGICAL, NOT PER-ROW, and that makes an unconditional mirror write unsafe.
 *
 * buildMirroredAccountingEventIdempotencyKey prefers the payload's own `_idempotencyKey` over
 * the sync-log id, so every ATTEMPT at the same logical document maps to the SAME
 * AccountingEvent; and the `accounting-sync:<connector>:<type>:<ref>:<date>` fallback key is
 * shared across attempts too. Meanwhile a FAILED row can legitimately coexist with a LIVE
 * replacement, because both partial unique indexes on AccountingSyncLog carry the predicate
 * `status IN ('PENDING','PROCESSING','SYNCED')` — FAILED is OUTSIDE them, so nothing stops a
 * fresh attempt being enqueued alongside the old one.
 *
 * Put those together and settling the OLD FAILED row NOT_POSTED would write VOID and clear the
 * externalId on an event that now belongs to the LIVE (or already POSTED) replacement:
 * reconciliation would read a real, in-flight or posted document as deliberately abandoned, and
 * the id pointing at it would be gone. updateMirroredAccountingEventStatus has no prior-status
 * or ownership CAS of its own to stop that (unlike voidMirroredAccountingEventsForOrder, which
 * re-asserts `status IN ('PENDING','FAILED')` in the update).
 *
 * So settlement resolves ownership first and SKIPS the mirror write when another row owns it.
 * The row's own status change still proceeds — the row IS genuinely settled, and that is the
 * fact the operator asserted. Only the shared mirror is left to its owner, and the skip is
 * recorded in the audit metadata so it is visible rather than silent.
 */
export const MIRROR_OWNING_SYNC_STATUSES = ['PENDING', 'PROCESSING', 'SYNCED'] as const

/** Another sync row that may map onto the same mirrored accounting event. */
export type MirrorClaimCandidate = {
  id: string
  status: string
  externalTransactionId: string | null
  /** Every idempotency key the mirror updater would try for that row. */
  mirrorKeys: readonly string[]
}

export type MirrorOwnershipConflict = {
  syncLogId: string
  status: string
  /** Whether the other row is merely live, or carries post evidence of its own. */
  posted: boolean
  sharedKey: string
}

/**
 * The other row that owns this mirrored event, or null when nothing else claims it.
 *
 * "Owns" = shares a mirror key AND is either LIVE (still able to post: PENDING / PROCESSING /
 * SYNCED) or already POSTED (carries an externalTransactionId, whatever its status — a FAILED
 * row with an id is a document that exists, per o3d-ju8t).
 */
export function findMirrorOwnershipConflict(
  selfMirrorKeys: readonly string[],
  candidates: readonly MirrorClaimCandidate[],
): MirrorOwnershipConflict | null {
  if (selfMirrorKeys.length === 0) return null
  const mine = new Set(selfMirrorKeys)
  for (const candidate of candidates) {
    const live = (MIRROR_OWNING_SYNC_STATUSES as readonly string[]).includes(candidate.status)
    const posted = trimmed(candidate.externalTransactionId).length > 0
    if (!live && !posted) continue
    const sharedKey = candidate.mirrorKeys.find((key) => mine.has(key))
    if (sharedKey) return { syncLogId: candidate.id, status: candidate.status, posted, sharedKey }
  }
  return null
}

/** The note recorded on the audit row when the mirror write is skipped. */
export function describeMirrorOwnershipSkip(conflict: MirrorOwnershipConflict): string {
  return `Mirrored accounting event left untouched: sync row ${conflict.syncLogId} (${conflict.status}`
    + `${conflict.posted ? ', carries post evidence' : ''}) maps to the same mirrored event and still owns it. `
    + 'Settling this row does not terminalise a document another attempt is responsible for.'
}

// ---------------------------------------------------------------------------
// The POSTED branch's unique-index collision
// ---------------------------------------------------------------------------

/**
 * Moving a row FAILED -> SYNCED puts it back INSIDE both partial unique indexes
 *   accounting_sync_logs_idempotency_key_uq     (migration 20260424214500)
 *   accounting_sync_logs_followup_live_unique   (migration 20260615000000)
 * whose predicate is `status IN ('PENDING','PROCESSING','SYNCED')`. A historical FAILED row
 * therefore collides with a LIVE row for the same identity, and Postgres raises P2002.
 *
 * The transaction rolls back correctly, so nothing is half-written — but the raw exception is
 * useless to an operator, who sees only a hung dialog. This turns it into a statement of what
 * happened and what to do.
 *
 * It deliberately does NOT auto-cancel the conflicting live row. That row may be a genuine
 * in-flight attempt; cancelling it from here would be exactly the unfenced retirement o3d-sref
 * removed from the orphan sweep, done silently as a side effect of settling a different row.
 *
 * Returns null when the error is not a unique violation, so the caller rethrows anything else.
 */
export function describeSettlementUniqueConflict(error: unknown): string | null {
  if (!isUniqueConstraintViolation(error)) return null
  const fields = uniqueConstraintFields(error)
  const named = fields && fields.length > 0 ? ` (${fields.join(', ')})` : ''
  return 'Another LIVE sync row already holds this row\'s identity, so recording this one as SYNCED '
    + `collided with it${named}. Nothing was changed — the whole settlement rolled back. Resolve that `
    + 'live row first (let it finish, or settle it once it is FAILED), then settle this one. IMS will '
    + 'not cancel it for you: it may be a real attempt that is still running.'
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
  /**
   * Whether the settlement control applies. PENDING, PROCESSING and DAILY_BATCH_* rows are all
   * LISTED — being visible is the whole of o3d-osl8 item 1 and does not depend on being
   * actionable — but only FAILED non-batch rows can be settled.
   */
  settleable: boolean
  /**
   * Why not, when `settleable` is false. Without this the UI silently omits the control and the
   * operator is left to guess whether the row is fine or merely unfixable from here.
   */
  notSettleableReason: string | null
}

export function describeStrandedSyncRow(row: StrandedSyncRowSource, now: Date): StrandedSyncRow {
  const ageMs = Math.max(0, now.getTime() - row.createdAt.getTime())
  const settleableStatus = isSettleableAccountingSyncStatus(row.status)
  const settleableType = isSettleableAccountingSyncType(row.type)
  const settleable = settleableStatus && settleableType
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
    settleable,
    notSettleableReason: settleable
      ? null
      : settleableStatus
        ? describeDailyBatchRefusal(row.type)
        : describeUnsettleableStatus(row.status),
  }
}
