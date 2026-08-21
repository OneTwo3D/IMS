import type { Prisma } from '@/app/generated/prisma/client'
import { isUniqueConstraintViolation, uniqueConstraintFields } from '@/lib/db/prisma-unique-violation'
import { UNCLAIMED_ATTEMPT_REVISION } from '@/lib/domain/accounting/sync-log-attempt'
import type { AccountingEventStatus } from '@/lib/domain/accounting/accounting-event-types'
import type { MirroredEventWriteGuard } from '@/lib/domain/accounting/accounting-event-mirror'

/**
 * o3d-nf9i + o3d-osl8 item 2 — OPERATOR SETTLEMENT of an AccountingSyncLog row the system cannot
 * resolve for itself.
 *
 * WHAT THE OPERATOR IS DOING. Asserting a fact about the OUTSIDE world that IMS has no way to
 * check, and having that assertion recorded with their name on it:
 *
 *   { outcome: 'POSTED',     externalTransactionId }  ->  SYNCED, the document id recorded
 *   { outcome: 'NOT_POSTED', reason? }                ->  CANCELLED, no document id written
 *
 * It is NEVER an automatic reclassification. Nothing in this module infers an outcome from
 * errorMessage, age or retryCount — o3d-h2wx established that errorMessage carries no provenance
 * (both connectors overwrite `HTTP nnn` with the remote system's own text), so the only sound
 * source of the fact is a human who looked in the ledger. Where the claim cannot be computed, this
 * module states what is known and prescribes nothing.
 *
 * WHY IT COULD NOT BE BUILT BEFORE, AND WHAT CHANGED.
 *
 *   Two adversarial rounds on the parked branch o3d-nf9i-settlement-action killed it on the same
 *   defect, once for PROCESSING and once for FAILED: status is not an attempt identity. Every path
 *   returns a row to a status it already held — `retryFailed*` drives FAILED -> PENDING -> FAILED,
 *   the stale-claim reclaim drives PROCESSING -> PROCESSING — so a compare-and-swap on (id, status)
 *   can land an operator's conclusion about attempt N on attempt N+1. The remedy re-opened the
 *   stranded-document hole the order delete guard exists to close.
 *
 *   o3d-e2mz is that missing identity: `AccountingSyncLog.attemptRevision`, bumped by the processor
 *   on every claim and compare-and-swapped in its writeback, with the fence itself in
 *   lib/domain/accounting/sync-log-attempt.ts. This module does NOT re-derive it — it is the
 *   caller. `applyFencedAttemptDecision` owns every refusal about WHICH ATTEMPT a decision lands on
 *   (ROW_MISSING / UNFENCED_ATTEMPT / ATTEMPT_MOVED / STATUS_MOVED); this module owns only WHAT MAY
 *   BE ASSERTED about a row — its status, its type, and the post evidence it already carries.
 *
 * WHY PROCESSING IS SETTLEABLE NOW, having twice been ruled out.
 *
 *   The objection was concrete: a worker claims the row, issues the remote call, the operator looks
 *   in the ledger, correctly sees nothing YET, asserts NOT_POSTED, the row goes CANCELLED, the
 *   delete guard stops blocking, the order is hard-deleted — and then the call lands, stranding a
 *   document nothing in IMS can explain.
 *
 *   Under o3d-e2mz the Xero processor closes that ending on its own side. When its writeback loses
 *   the fence it does not discard what it learned: `recordPostedDocumentEvidence` writes the
 *   external id onto the row anyway (its only precondition is that the row names no document yet),
 *   and the delete guard blocks on `externalTransactionId != null` WHATEVER the status — see
 *   lib/domain/sales/order-delete-guard.ts, where a row with an id ranks as "already POSTED" ahead
 *   of any status test. So the two possible endings are:
 *
 *     • nothing posted  -> the row stays CANCELLED and the order becomes deletable, which is what
 *       the operator asserted and what they wanted; or
 *     • something posted -> the connector stamps the document id onto the CANCELLED row and raises
 *       an ERROR naming it, the order stays undeletable, and the operator's assertion is visibly
 *       contradicted by evidence rather than silently believed.
 *
 *   That is the settled rule "verified evidence outranks an unverifiable assertion", implemented on
 *   both sides. It does not make settling an in-flight attempt free — the operator can still be
 *   wrong — it makes being wrong DETECTED and non-destructive, which is the most a settlement UI
 *   can honestly offer.
 *
 * WHAT IS STILL REFUSED, and none of it is arbitrary: see SETTLEABLE_ACCOUNTING_SYNC_STATUSES
 * (PENDING, SYNCED, CANCELLED), isSettleableAccountingSyncType (DAILY_BATCH_*), and the fence's own
 * UNFENCED_ATTEMPT — which is what refuses every QuickBooks row, because that processor stamps no
 * attempt revision and its rows therefore stay at 0 forever. That is not a regression: a QuickBooks
 * row cannot be settled today either, and settling one under a one-sided fence would prove nothing.
 *
 * Pure functions only, so the decision — which statuses are settleable, the data patch per outcome,
 * the mirror guard, and the refusal vocabulary — is unit-testable without a database, exactly as
 * connector-orphans.ts and stranded-sync-rows.ts are.
 */

/**
 * The statuses an operator may settle.
 *
 *   FAILED      terminal-looking but ambiguous (o3d-ju8t): both processors make the REMOTE CALL
 *               BEFORE persisting SYNCED and the externalTransactionId, so an exception in that
 *               writeback window terminalises the row FAILED with a real document in the ledger.
 *               A FAILED row is therefore NOT proof that nothing posted, which is precisely why it
 *               blocks the hard delete and why only a human who looked can resolve it.
 *
 *   PROCESSING  a claim that will never be released — its connector was retired, so no processor
 *               will ever pick it up again (o3d-osl8). Settleable because losing the race is now
 *               detected and non-destructive on the Xero side; see the module comment.
 *
 * PENDING is excluded: nothing was ever sent, so there is no ambiguity to settle, and the ordinary
 * sweeps own it — cancelPendingSalesInvoiceSyncForOrder and cancelOrphanedAccountingSyncRows both
 * retire PENDING rows without a human asserting anything. Offering it here would give an operator a
 * second way to abandon work the system abandons correctly by itself.
 *
 * SYNCED and CANCELLED are excluded because they are already recorded outcomes. Re-settling one
 * would let this action rewrite a recorded fact, which is the one thing an audited assertion must
 * never be able to do.
 *
 * NOTE THE FOOTGUN. There are two other exported constants called LIVE_ACCOUNTING_SYNC_STATUSES:
 * app/actions/accounting-sync.ts's is ['PENDING','PROCESSING'] (what a processor can still claim)
 * and lib/domain/sales/order-delete-guard.ts's is ['PENDING','PROCESSING','SYNCED','FAILED'] (what
 * blocks a hard delete). Neither is the settleable set, so this module defines its own rather than
 * importing either and silently inheriting the wrong membership.
 */
export const SETTLEABLE_ACCOUNTING_SYNC_STATUSES = ['FAILED', 'PROCESSING'] as const

export type SettleableAccountingSyncStatus = (typeof SETTLEABLE_ACCOUNTING_SYNC_STATUSES)[number]

/** Terminal statuses — recorded outcomes, never re-openable from here. */
const TERMINAL_ACCOUNTING_SYNC_STATUSES = new Set(['SYNCED', 'CANCELLED'])

export function isSettleableAccountingSyncStatus(status: string): status is SettleableAccountingSyncStatus {
  return (SETTLEABLE_ACCOUNTING_SYNC_STATUSES as readonly string[]).includes(status)
}

/**
 * Whether a row carries an attempt a decision can be tied to at all.
 *
 * Delegates to the fence's own constant rather than re-stating "greater than zero": revision 0
 * means "no processor participating in the fence has ever claimed this row", and that is the fence's
 * definition to own, not this module's. Used by the UI to disable the control with a reason instead
 * of offering a button whose only possible answer is UNFENCED_ATTEMPT.
 */
export function isFencedAttemptRevision(attemptRevision: number | null | undefined): boolean {
  return typeof attemptRevision === 'number' && attemptRevision !== UNCLAIMED_ATTEMPT_REVISION
}

/**
 * DAILY_BATCH_* rows are NOT settleable, whatever their status or attempt.
 *
 * A daily-batch row is not keyed by an order: it is keyed by `referenceType='DailyBatch'` and a
 * synthetic `<group>-<date>[-digest]` referenceId covering EVERY order staged into that batch.
 * CANCELLED is read as "this batch never posted" by two readers that do not coordinate:
 *
 *   1. the daily-batch RECREATORS, which take the absence of a live batch row as licence to
 *      re-derive and re-post the journal from the staged orders, and
 *   2. lib/domain/sales/order-delete-guard.ts, whose `daily_batch_staged` check selects only its
 *      LIVE_ACCOUNTING_SYNC_STATUSES, so a CANCELLED batch row blocks nothing.
 *
 * Settling one NOT_POSTED opens that race: the recreator reads the staged orders, the delete guard
 * sees only the CANCELLED row and permits the hard delete, and the recreator then posts a journal
 * containing the deleted order's amount — an amount nothing in IMS can now explain, in a journal
 * nothing can un-post. The attempt fence does not help here: it fences the ROW against a competing
 * writer, and this race is between two OTHER subsystems reading the row's status.
 *
 * A batch is a finance-level correction (reverse the journal in the ledger, let the sweep re-derive)
 * rather than a per-row operator assertion, so the whole family is refused.
 */
export const DAILY_BATCH_SYNC_TYPE_PREFIX = 'DAILY_BATCH_'

export function isSettleableAccountingSyncType(type: string): boolean {
  return !type.startsWith(DAILY_BATCH_SYNC_TYPE_PREFIX)
}

/**
 * THE SETTLEMENT BASIS MARKER — how a terminal status was arrived at (o3d-nf9i r3, Codex finding 1).
 *
 * A settled POSTED row is written status=SYNCED with an externalTransactionId. So is a row the
 * connector genuinely posted and confirmed. Until this marker existed the two were the SAME ROW, and
 * every downstream reader that asks "did this post?" answered as though the ledger had confirmed it
 * — laundering an operator's BELIEF into the connector's CONFIRMATION.
 *
 * They are not the same claim, and the difference is exactly the one `exceptions` settled: a verdict
 * must return the answer PLUS its basis, because an answer reached by an unverifiable assertion is a
 * materially weaker claim than the same answer reached from a confirmation, and a caller acting on
 * the weak one must be able to name which it got.
 *
 * WHAT IS ACTUALLY UNVERIFIED, concretely, and why a number is not a substitute. The operator types
 * a document id. IMS makes no call, reads no document, and compares no figure — a settled row's
 * `payload.amount` is still only what IMS INTENDED to send. Xero accepts a payment smaller than the
 * invoice as a PART payment and returns a perfectly good payment id, so an asserted INVOICE_PAYMENT
 * can name a real document that settles a fraction of the invoice while IMS's two local numbers
 * agree with each other. `settlementStatus` compares exactly those two local numbers, so a
 * MONETARY-ONLY COMPARISON MUST FAIL CLOSED on an asserted row: see lib/domain/accounting/
 * settlement-status.ts, which refuses to return SETTLED for one whatever the amounts say.
 *
 * Written on BOTH outcomes, not only POSTED. A CANCELLED row is read as "nothing posted" by the
 * delete guard and by the follow-up ambiguity set, and "nothing posted because a human looked" is a
 * weaker fact than "nothing posted because the connector never got a document id" in exactly the
 * same way.
 *
 * NULL is the connector's own writeback and needs no marker: absence of an assertion IS the
 * confirmation case, and back-filling every historical row to say so would be a write with no
 * information in it.
 */
export const OPERATOR_ASSERTION_SETTLEMENT_BASIS = 'OPERATOR_ASSERTION'

export type SettlementBasis = 'CONNECTOR_CONFIRMED' | 'OPERATOR_ASSERTION'

/**
 * The basis a row's recorded outcome rests on. Reads the column rather than the errorMessage text:
 * o3d-h2wx established that errorMessage carries no provenance — both connectors overwrite it with
 * the remote system's own words — so a settlement note is not something a reader may key on.
 */
export function settlementBasisOf(settlementBasis: string | null | undefined): SettlementBasis {
  return settlementBasis === OPERATOR_ASSERTION_SETTLEMENT_BASIS ? 'OPERATOR_ASSERTION' : 'CONNECTOR_CONFIRMED'
}

export function isOperatorAssertedSettlement(settlementBasis: string | null | undefined): boolean {
  return settlementBasisOf(settlementBasis) === 'OPERATOR_ASSERTION'
}

export type SettlementOutcome = 'POSTED' | 'NOT_POSTED'

export type SettlementAssertion =
  | { outcome: 'POSTED'; externalTransactionId: string }
  | { outcome: 'NOT_POSTED'; reason?: string }

export type SettlementRefusalCode =
  | 'pending_not_settleable'
  | 'already_terminal'
  | 'status_not_settleable'
  | 'daily_batch_not_settleable'
  | 'missing_external_id'
  | 'external_id_conflict'
  | 'contradicts_post_evidence'
  | 'contradicts_mirrored_document'

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

function describeDailyBatchRefusal(type: string): string {
  return `${type} is a DAILY BATCH row and cannot be settled by hand. A batch row is keyed by the `
    + 'batch, not by one order, and CANCELLED reads as "never posted" BOTH to the batch recreators '
    + 'and to the order delete guard. Settling it would let an order be hard-deleted while a '
    + 'recreate is already building a journal that still contains that order\'s value. Reverse the '
    + 'journal in the accounting system and let the batch sweep re-derive it instead.'
}

/**
 * The refusal an operator gets for a status they may not settle. Exported so the server action can
 * refuse on the SHOWN status — before it reads the row at all — with the same wording the post-read
 * refusal would produce, and so the UI can explain a control it has disabled.
 */
export function describeUnsettleableStatus(status: string): string {
  if (status === 'PENDING') return PENDING_REFUSAL_MESSAGE
  if (TERMINAL_ACCOUNTING_SYNC_STATUSES.has(status)) {
    return `This row is already ${status}. A recorded outcome cannot be re-settled.`
  }
  return `Status ${status} cannot be settled by hand. Only FAILED and PROCESSING rows can.`
}

/**
 * What the operator needs to know BEFORE asserting, for the row in front of them. Facts about what
 * their assertion does and what can still contradict it — deliberately not a recommendation, and
 * deliberately not silence.
 */
export function describeSettlementCaveat(status: string): string | null {
  if (status === 'PROCESSING') {
    return 'This row is PROCESSING: a worker claimed it and its remote call may never have returned. '
      + 'Your assertion is fenced to the attempt shown, so a worker that is still running will lose '
      + 'its writeback rather than overwrite you — but if it DID post, the connector records the '
      + 'document id on this row anyway and the order stays undeletable. Check the accounting system '
      + 'before asserting, and expect to be contradicted if a document turns up.'
  }
  if (status === 'FAILED') {
    return 'A FAILED row is NOT proof that nothing posted: the remote call happens before the result '
      + 'is written down, so a failure here can sit in front of a real document in the ledger. Look '
      + 'the document up before asserting either outcome.'
  }
  return null
}

/**
 * Whether the per-row settlement control applies to a row, and the reason when it does not.
 *
 * ONE implementation, shared by every surface that offers the control — the stranded-row list on a
 * retired connector (o3d-osl8) and the active connector's sync log (o3d-nf9i). Two copies of "which
 * rows get a button" would drift, and the drift would be invisible: a row offered a control it
 * cannot use looks identical to one that works until it is clicked.
 *
 * THREE INDEPENDENT GATES, checked in the order that produces the most useful message:
 *
 *  1. STATUS. Only FAILED and PROCESSING admit an operator assertion. A PENDING row has sent
 *     nothing, so there is nothing to assert about; the sweeps retire it correctly by themselves,
 *     and SYNCED/CANCELLED are already recorded outcomes.
 *  2. TYPE. DAILY_BATCH_* is refused whatever its status, because CANCELLED reads as "never posted"
 *     to both the batch recreators and the order delete guard.
 *  3. ATTEMPT. A row at revision 0 carries no attempt an assertion could be fenced to, so
 *     applyFencedAttemptDecision would refuse it as UNFENCED_ATTEMPT. Offering a control whose only
 *     possible answer is a refusal is worse than not offering one, so it is disabled WITH the reason
 *     — permanent for a QuickBooks row, and "not claimed yet" for a Xero one.
 *
 * The type gate is checked before the attempt gate deliberately: a DAILY_BATCH row can never be
 * settled at any revision, so telling the operator to wait for an attempt would mislead them.
 *
 * This is a UI AFFORDANCE, not a permission and not a guarantee. Whether an assertion actually lands
 * is decided by applyFencedAttemptDecision at write time against the state then — never by this.
 */
export type SyncRowSettleability = {
  settleable: boolean
  notSettleableReason: string | null
  settlementCaveat: string | null
  /**
   * True when the only thing letting this row be settled is ADOPTION — it carries no attempt
   * revision, and it is settleable solely because nothing can ever claim it. Carried so the operator
   * is told they are minting the attempt identity rather than naming one they were shown.
   */
  requiresAttemptAdoption: boolean
}

/**
 * ADOPTING A ROW THAT NO PROCESSOR CAN EVER CLAIM (r3, Codex finding 3).
 *
 * Every row that exists today is at revision 0, and revision 0 is `UNFENCED_ATTEMPT`. Left there,
 * this branch's remedy does not exist for a single one of the rows that motivated it: an o3d-osl8
 * stranded row sits on a RETIRED connector, so no processor will ever claim it, so its revision will
 * never leave 0, so it is refused for ever. "Wait for the fence to claim it" is a dead end, and a
 * refusal with no remedy the operator can perform is exactly what this session ruled out.
 *
 * A row on the ACTIVE connector is a different case and needs nothing new: `retryFailed*` returns it
 * to PENDING, the fence-aware processor claims it, and the claim bump makes it attempt 1. That route
 * exists, so adoption is not offered there — it would be a second way to do what the system already
 * does correctly by itself, which is the same objection that keeps PENDING unsettleable.
 *
 * WHY ADOPTING IS SOUND WHERE IT IS OFFERED, given that a compare-and-swap on (id, status) is the
 * very defect the fence was built for. That defect is a defect because ANOTHER WRITER can return the
 * row to a status it already held — `retryFailed*` driving FAILED -> PENDING -> FAILED, the
 * stale-claim reclaim driving PROCESSING -> PROCESSING — so the operator's conclusion about attempt
 * N lands on attempt N+1. Remove every such writer and there is no attempt N+1 to land on: a row
 * whose connector is retired has exactly ONE attempt, the abandoned one in front of the operator,
 * and status is a sufficient identity for a row that can only ever have had one. The adoption is
 * itself a CAS on (id, revision 0, status), so two operators racing produce one winner and one
 * ATTEMPT_MOVED, and a sweep that retires the row first moves its status and refuses the adoption.
 *
 * The caller decides `unclaimable` — it is a fact about the INSTALLATION (which connector is active),
 * not about the row — and it must never be passed for the active connector.
 */
export function describeAttemptAdoptionCaveat(connector: string): string {
  return `This row carries no attempt revision, so settling it MINTS one: no processor participating in the `
    + `attempt fence will ever claim a ${connector} row while ${connector} is not the active connector, so the `
    + 'attempt in front of you is the only one this row can ever have had. Your assertion is fenced on that — if '
    + 'anything moves the row before you record this, it is refused rather than applied.'
}

export function describeSyncRowSettleability(
  row: {
    status: string
    type: string
    attemptRevision: number | null | undefined
    /**
     * Whether NOTHING that participates in the attempt fence can ever claim this row — true for a
     * row on a retired connector. Absent/false means the ordinary rule applies and revision 0 is
     * refused. See describeAttemptAdoptionCaveat for why this is the whole precondition.
     */
    unclaimable?: boolean
    /** Only used to word the adoption caveat. */
    connector?: string
  },
): SyncRowSettleability {
  if (!isSettleableAccountingSyncStatus(row.status)) {
    return {
      settleable: false,
      notSettleableReason: describeUnsettleableStatus(row.status),
      settlementCaveat: null,
      requiresAttemptAdoption: false,
    }
  }
  if (!isSettleableAccountingSyncType(row.type)) {
    return {
      settleable: false,
      settlementCaveat: null,
      requiresAttemptAdoption: false,
      notSettleableReason:
        `${row.type} is a DAILY BATCH row and cannot be settled by hand at any attempt. A batch row covers `
        + 'every order staged into it, and cancelling it would let one of those orders be deleted while a '
        + 'recreate is still building a journal containing its value. Reverse the journal in the accounting '
        + 'system and let the batch sweep re-derive it.',
    }
  }
  if (!isFencedAttemptRevision(row.attemptRevision)) {
    // ADOPTION. The row can be settled after all when nothing can ever claim it — otherwise this
    // branch's remedy does not reach the rows it was built for. See describeAttemptAdoptionCaveat.
    if (row.unclaimable) {
      return {
        settleable: true,
        notSettleableReason: null,
        requiresAttemptAdoption: true,
        settlementCaveat: [describeAttemptAdoptionCaveat(row.connector ?? 'this'), describeSettlementCaveat(row.status)]
          .filter((part): part is string => !!part)
          .join(' '),
      }
    }
    return {
      settleable: false,
      settlementCaveat: null,
      requiresAttemptAdoption: false,
      notSettleableReason:
        'This row carries no attempt revision, so a decision cannot be tied to the attempt it would be made '
        + 'about and would be refused. It is on the ACTIVE connector, so the fence-aware processor will stamp '
        + 'one the next time it claims the row: retry the row, and settle it once it shows an attempt. Rows on a '
        + 'RETIRED connector never get one and are settled by adoption instead.',
    }
  }
  return {
    settleable: true,
    notSettleableReason: null,
    requiresAttemptAdoption: false,
    settlementCaveat: describeSettlementCaveat(row.status),
  }
}

/**
 * Why this row + this assertion must be refused, or null when it may proceed.
 *
 * Evaluated against the row as READ, which is also the view the operator was shown. The attempt
 * fence re-asserts the status AND the attempt at write time, so a row that moves between this read
 * and the write is refused there rather than settled on a stale basis.
 */
export function refuseSettlement(row: SettlementRowView, assertion: SettlementAssertion): SettlementRefusal | null {
  if (row.status === 'PENDING') {
    return { code: 'pending_not_settleable', message: PENDING_REFUSAL_MESSAGE }
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

  // NOT_POSTED against a row that ALREADY carries an external id is a contradiction: the id is post
  // evidence, and verified evidence outranks an assertion the system cannot check. It also would not
  // achieve what the operator wants — per tests/sales-order-delete-guard.test.ts a CANCELLED row
  // that still carries an external id STILL blocks the hard delete (o3d-v7sy), so the order would
  // stay undeletable anyway.
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
 * The data patch for each outcome. `attemptRevision` is DELIBERATELY absent — the fence sets it, and
 * applyFencedAttemptDecision's parameter type forbids passing it, so a patch that tried to would not
 * compile.
 *
 * ------------------------------------------------------------------------------------------------
 * WHAT TERMINALISING ACTUALLY FREES — o3d-nf9i's own wording is misleading, so read this.
 *
 * The issue says terminalising "frees the partial unique index slot". That is TRUE ONLY OF THE
 * NOT_POSTED (CANCELLED) BRANCH. Both partial unique indexes —
 *   accounting_sync_logs_idempotency_key_uq       (migration 20260424214500)
 *   accounting_sync_logs_followup_live_unique     (migration 20260615000000)
 * carry the predicate `status IN ('PENDING','PROCESSING','SYNCED')`. SYNCED is INSIDE them. So the
 * POSTED branch frees NOTHING: the row moves from outside the index (FAILED/PROCESSING is partially
 * inside) to inside it and OCCUPIES the slot. That is correct semantics, not a bug — "it really did
 * post" means the follow-up is CLOSED, and hasExistingSyncLog counting PENDING/PROCESSING/SYNCED
 * will rightly refuse to enqueue another one.
 * ------------------------------------------------------------------------------------------------
 * LOAD-BEARING SIDE EFFECT of the NOT_POSTED branch — deliberate, not incidental.
 *
 * enqueueFollowUpSyncLog selects `status: 'FAILED'` when it gathers the ambiguity set
 * (lib/connectors/xero/sync-processor.ts, lib/connectors/quickbooks/sync-processor.ts). Moving a
 * FAILED row to CANCELLED REMOVES it from that set. For a money-moving type (INVOICE_PAYMENT,
 * PURCHASE_CREDIT_NOTE_ALLOCATION), planFollowUpEnqueue refuses whenever two or more DISTINCT
 * tokens could have committed; cancelling one of them drops the distinct-token count to one and
 * turns that `refuse` into a `create`/`reuse`.
 *
 * That is exactly the intended unblock for o3d-nf9i's part-payment history — and it is also why the
 * assertion has to be a real, audited statement of fact rather than a convenience button.
 * Cancelling a row that DID post would let a duplicate payment out.
 * ------------------------------------------------------------------------------------------------
 */
export function buildSettlementData(
  assertion: SettlementAssertion,
  now: Date,
): Omit<Prisma.AccountingSyncLogUpdateManyMutationInput, 'attemptRevision'> {
  if (assertion.outcome === 'POSTED') {
    return {
      status: 'SYNCED',
      externalTransactionId: assertion.externalTransactionId.trim(),
      syncedAt: now,
      // The connector's own success write clears errorMessage; settlement REPLACES it with the
      // settlement note instead. A SYNCED row that a human vouched for reads very differently from
      // one the connector confirmed, and the sync log shows this column — leaving it blank would
      // make an asserted post indistinguishable from a verified one at a glance. The failure text it
      // replaces is preserved in the activity-log metadata (priorErrorMessage), so nothing is lost.
      errorMessage: settlementNote(assertion),
      // Clear the claim stamp. A settled row must not look claimed afterwards — otherwise the
      // stale-claim reclaim would treat it as a candidate the moment its connector came back.
      processingStartedAt: null,
      // THE BASIS, machine-readable (r3, Codex finding 1). errorMessage above is for a human and
      // carries no provenance a reader may key on; this column is what stops settlement-status.ts
      // reporting an asserted post as a ledger-confirmed settlement.
      settlementBasis: OPERATOR_ASSERTION_SETTLEMENT_BASIS,
    }
  }
  return {
    status: 'CANCELLED',
    // externalTransactionId is DELIBERATELY ABSENT from this patch — not set to null.
    //
    // The delete guard ranks a row with an external id as "already POSTED, needs explicit reversal
    // or credit note" whatever its status, and a CANCELLED row that still carries one STILL BLOCKS
    // the hard delete. So the NOT_POSTED branch must never WRITE an external id — and equally must
    // never CLEAR one, which would destroy real post evidence. refuseSettlement() has already
    // established that this row carries none, so leaving the column untouched leaves it NULL, which
    // is what makes the order deletable again. It also leaves the column free for the connector's
    // own fence-loss evidence write to fill in if the call turns out to have landed.
    errorMessage: settlementNote(assertion),
    processingStartedAt: null,
    // Written on the NOT_POSTED branch too. "Nothing posted, a human looked" is a weaker fact than
    // "nothing posted, the connector never got an id", and the delete guard and the follow-up
    // ambiguity set both act on this row as though it were the latter.
    settlementBasis: OPERATOR_ASSERTION_SETTLEMENT_BASIS,
  }
}

/**
 * The patch for a POSTED assertion whose SALE IS CANCELLED (r3, Codex finding 4).
 *
 * The ordinary POSTED patch writes status=SYNCED + externalTransactionId, and that pair IS
 * `repairXeroBackReferences`' candidate shape (`status IN (SYNCED, FAILED) AND
 * externalTransactionId IS NOT NULL AND backReferenceCheckedAt IS NULL`). Handing the sweep that
 * shape for a cancelled order is handing it an instruction to stamp the document id onto the
 * cancelled sale and carry on with its work. o3d-e2mz closed exactly this for the connector's own
 * fence-loss recovery — twice, once for a sale cancelled before its read (r5) and once for a sale
 * cancelled just after it (r6) — and settling by hand reopens it unless settlement writes the same
 * shape the connector does.
 *
 * So the id is still RECORDED — it is real evidence, the delete guard reads
 * externalTransactionId whatever the status, and destroying it would strand the document — but the
 * row is terminalised CANCELLED with no syncedAt, which is outside the sweep's shape. Nothing
 * carries the cancelled sale's work (back-reference, PDF, email, storefront note, PAYMENT) any
 * further.
 */
export function buildCancelledSaleSettlementData(
  assertion: Extract<SettlementAssertion, { outcome: 'POSTED' }>,
  now: Date,
): Omit<Prisma.AccountingSyncLogUpdateManyMutationInput, 'attemptRevision'> {
  void now
  return {
    status: 'CANCELLED',
    externalTransactionId: assertion.externalTransactionId.trim(),
    // Deliberately NOT stamped. syncedAt is "this row reached the ledger as live work"; the document
    // exists but its work is retired, and a syncedAt would make the row read as ordinary success.
    syncedAt: null,
    processingStartedAt: null,
    errorMessage: cancelledSaleSettlementNote(assertion),
    settlementBasis: OPERATOR_ASSERTION_SETTLEMENT_BASIS,
  }
}

export function cancelledSaleSettlementNote(
  assertion: Extract<SettlementAssertion, { outcome: 'POSTED' }>,
): string {
  return `Settled by operator: verified POSTED as ${assertion.externalTransactionId.trim()}, but THE SALE THIS ROW `
    + 'BELONGS TO IS CANCELLED. The document id is recorded — the order delete guard reads it whatever the status '
    + '— and the row is left CANCELLED so no sweep carries the cancelled sale\'s remaining work (back-reference, '
    + 'PDF, email, storefront note, payment) any further. Reverse the document in the accounting system.'
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
 * Both connectors and lib/domain/accounting/cancel-order-invoice-sync.ts terminalise the mirror
 * whenever they terminalise a sync row, because a PENDING mirror left behind reads to reconciliation
 * as work still owed. Settlement is a terminalisation, so it must do the same or it just moves the
 * stranding one table across.
 *
 * VOID (not FAILED, not CANCELLED — the mirror's own enum) is the mirror's "deliberately abandoned,
 * never posted" state, matching voidMirroredAccountingEventsForOrder.
 */
export function settlementMirrorStatus(outcome: SettlementOutcome): AccountingEventStatus {
  return outcome === 'POSTED' ? 'POSTED' : 'VOID'
}

/** The external id to stamp on the mirrored event. Null for NOT_POSTED, for the reasons above. */
export function settlementMirrorExternalId(assertion: SettlementAssertion): string | null {
  return assertion.outcome === 'POSTED' ? assertion.externalTransactionId.trim() : null
}

/**
 * The compare-and-swap the mirror write itself runs under — the fix for the round-2 finding that the
 * ownership read below is not a lock.
 *
 * The ownership read tells the operator (via the audit) who else claims this mirror, but a sibling
 * can post in the window between that read and this write, and no amount of re-reading closes it.
 * Guarding the WRITE does, in both directions:
 *
 *   • settlement VOIDs, then the sibling posts -> the sibling's own unconditional success write sets
 *     POSTED + externalId. Correct final state, and the sibling wins because it has evidence.
 *   • the sibling posts, then settlement VOIDs -> this guard refuses (status is POSTED, externalId
 *     is set), the event keeps its document id, and the audit records `refused` rather than a lie.
 *
 * The POSTED branch is guarded too: an operator recording a document must not silently overwrite a
 * mirror that already names a DIFFERENT one.
 */
export function settlementMirrorGuard(): MirroredEventWriteGuard {
  return {
    statusIn: ['PENDING', 'FAILED'],
    // Post evidence on the mirror is never erased or replaced by an assertion, either way round.
    requireExternalIdNull: true,
  }
}

/**
 * WHEN A REFUSED MIRROR WRITE IS A CONTRADICTION RATHER THAN A NO-OP (r3, Codex finding 2).
 *
 * `settlementMirrorGuard` makes the mirror write a compare-and-swap, and a CAS that does not hold
 * returns `'refused'`. Round 2 treated every refusal the same way — record it in the audit, return
 * the settlement as a SUCCESS — which is how a settlement that recorded document A could come back
 * `success: true` while the mirrored event for the very same logical document names document B. The
 * operator is told their assertion was accepted; the two systems now disagree; nothing refuses.
 *
 * `taxinv` is the same shape and the same verdict: a WRONG document that REPORTED SUCCESS, where the
 * verdict half was worse than the figure. An assertion contradicted by a document IMS already holds
 * must be REFUSED, not annotated.
 *
 * THE LINE IS A DOCUMENT ID, on either side — the same line `refuseSettlement` already draws for the
 * sync row's own externalTransactionId, and for the same reason: an id is the durable pointer at
 * something that exists in the ledger, and post evidence outranks an assertion IMS cannot check.
 *
 *   • NOT_POSTED against a mirror that names ANY document, or that records a POST -> contradiction.
 *   • POSTED as A against a mirror that names B -> contradiction. Two documents for one logical
 *     posting is precisely the state nobody can reconcile afterwards.
 *   • POSTED as A against a mirror that names A -> NOT a contradiction. A retried click, or a lost
 *     response; the guard declines because there is nothing left to write.
 *   • A refusal with NO document on the mirror at all (a VOID event, a POSTED one that never
 *     recorded an id) -> NOT a contradiction. Nothing there outranks anything; the audit records
 *     that the mirror was left alone and the settlement stands.
 *
 * Returns null when the settlement may proceed, so the caller's `if (refusal) rollback` reads the
 * same way as every other refusal in this module.
 */
export type MirroredDocumentView = { status: string; externalId: string | null }

export function refuseSettlementContradictedByMirror(
  assertion: SettlementAssertion,
  mirrored: MirroredDocumentView,
): SettlementRefusal | null {
  const mirroredId = trimmed(mirrored.externalId)

  if (assertion.outcome === 'NOT_POSTED') {
    if (mirroredId) {
      return {
        code: 'contradicts_mirrored_document',
        message:
          `The mirrored accounting event for this row already names document ${mirroredId}, which is evidence `
          + 'it DID post. Nothing was settled and nothing was changed. Settle this row as POSTED with that id, '
          + 'or reverse the document in the accounting system first and settle it afterwards.',
      }
    }
    if (mirrored.status === 'POSTED') {
      return {
        code: 'contradicts_mirrored_document',
        message:
          'The mirrored accounting event for this row is already recorded as POSTED, so asserting that nothing '
          + 'posted contradicts a posting IMS has already written down. Nothing was settled and nothing was '
          + 'changed. Find the document in the accounting system and settle this row as POSTED with its id, or '
          + 'reverse it there first.',
      }
    }
    return null
  }

  const asserted = trimmed(assertion.externalTransactionId)
  if (mirroredId && mirroredId !== asserted) {
    return {
      code: 'contradicts_mirrored_document',
      message:
        `The mirrored accounting event for this row already names document ${mirroredId}, and this settlement `
        + `asserts ${asserted}. Two different documents cannot both be this posting, so nothing was settled and `
        + 'nothing was changed — the row still names whatever it named before. Check BOTH ids in the accounting '
        + `system: if ${mirroredId} is the real one there is nothing to settle, and if it is not, reverse it there `
        + 'before recording the other.',
    }
  }
  return null
}

/**
 * THE ONE referenceType WHOSE ROW BELONGS TO A SALE THAT CAN BE CANCELLED (r3, Codex finding 4).
 *
 * Read from o3d-e2mz's SALE_SCOPED_REFERENCE_TYPE, which draws the line for the connector's own
 * fence-loss recovery, and it has to be drawn the same way here or the two disagree about the same
 * row. `referenceId` IS the sales order id for these rows, so the cancellation state is one locked
 * read away. Every other reference resolves to something a sales-order cancellation does not speak
 * for:
 *
 *  • `PurchaseInvoice` / `PurchaseOrder` — a supplier bill; no sale is involved.
 *  • `SalesOrderRefund` (the CREDIT_NOTE rows) — a refund credit note is very often the DIRECT
 *    CONSEQUENCE of the cancellation. Gating it on the order being live would strand exactly the
 *    document the cancellation created: crediting a cancelled sale is right, invoicing it is wrong.
 */
export const SALE_SCOPED_SETTLEMENT_REFERENCE_TYPE = 'SalesOrder'

export function isSaleScopedSettlementRow(referenceType: string): boolean {
  return referenceType === SALE_SCOPED_SETTLEMENT_REFERENCE_TYPE
}

// ---------------------------------------------------------------------------
// MIRROR OWNERSHIP — whose accounting event is it, actually?
// ---------------------------------------------------------------------------

/**
 * MIRROR IDENTITY IS LOGICAL, NOT PER-ROW.
 *
 * buildMirroredAccountingEventIdempotencyKey prefers the payload's own `_idempotencyKey` over the
 * sync-log id, so every ATTEMPT at the same logical document maps to the SAME AccountingEvent; and
 * the legacy `accounting-sync:<connector>:<type>:<ref>:<date>` fallback key is shared across
 * attempts too. Meanwhile a FAILED row can legitimately coexist with a LIVE replacement, because
 * both partial unique indexes on AccountingSyncLog carry `status IN ('PENDING','PROCESSING',
 * 'SYNCED')` — FAILED is OUTSIDE them, so nothing stops a fresh attempt being enqueued alongside it.
 *
 * So settlement resolves ownership first and SKIPS the mirror write when another row owns it. The
 * row's own status change still proceeds — the row IS genuinely settled, and that is the fact the
 * operator asserted. Only the shared mirror is left to its owner, and the skip is recorded in the
 * audit so it is visible rather than silent.
 *
 * This read is an EXPLANATION, not a fence: settlementMirrorGuard above is what makes a stale answer
 * here harmless.
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
 * SYNCED) or already POSTED (carries an externalTransactionId, whatever its status — a FAILED row
 * with an id is a document that exists, per o3d-ju8t).
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
// Unique-index collisions
// ---------------------------------------------------------------------------

/**
 * The two AccountingSyncLog partial unique indexes a settled row can re-enter.
 * Their predicate is `status IN ('PENDING','PROCESSING','SYNCED')`, so ONLY the POSTED branch can
 * collide with them: NOT_POSTED moves the row to CANCELLED, which leaves both indexes.
 */
const ACCOUNTING_SYNC_LOG_UNIQUE_INDEXES = [
  'accounting_sync_logs_idempotency_key_uq',
  'accounting_sync_logs_followup_live_unique',
]

/**
 * The accounting_events unique constraint on (externalSystem, externalId). A DIFFERENT failure with
 * a DIFFERENT remedy — see below.
 */
const ACCOUNTING_EVENT_EXTERNAL_ID_FIELDS = ['externalSystem', 'externalId', 'accounting_events_externalSystem_externalId_key']

export type SettlementUniqueConflictKind = 'live_row_conflict' | 'external_id_already_mirrored'

export type SettlementUniqueConflict = { kind: SettlementUniqueConflictKind; message: string }

/**
 * Translate a P2002 raised by a settlement into something an operator can act on — or return null,
 * which means "this is not a collision this action understands" and the caller must rethrow.
 *
 * ROUND 2, FINDING 3 — WHY THIS IS TWO CASES AND NOT ONE. The previous attempt caught P2002 around
 * the whole POSTED transaction and reported ONE message: "another LIVE sync row already holds this
 * row's identity". But that transaction also contains the MIRROR write, and AccountingEvent uniquely
 * constrains (externalSystem, externalId). An operator asserting a document id that is already
 * mapped to another event therefore hit the same catch and was told a live SYNC ROW held their
 * identity — the wrong cause, with a remedy ("resolve that live row") that cannot fix a duplicate
 * event mapping. The two are distinguished by the constraint the database actually named:
 *
 *   • an AccountingSyncLog partial index -> a live sibling row holds this row's identity;
 *   • accounting_events (externalSystem, externalId) -> that DOCUMENT ID is already recorded against
 *     another accounting event, which usually means it is the wrong id, or that the document has
 *     already been reconciled against a different row.
 *
 * Anything else returns null and is rethrown rather than dressed up as either.
 */
export function describeSettlementUniqueConflict(error: unknown): SettlementUniqueConflict | null {
  if (!isUniqueConstraintViolation(error)) return null
  const fields = uniqueConstraintFields(error)
  if (!fields) return null

  if (fields.some((field) => ACCOUNTING_EVENT_EXTERNAL_ID_FIELDS.includes(field))) {
    return {
      kind: 'external_id_already_mirrored',
      message:
        'That document id is already recorded against a DIFFERENT accounting event, so this row was not '
        + 'settled and nothing was changed. Either the id belongs to another document, or this document '
        + 'has already been reconciled against another sync row — check which in the accounting system '
        + 'before asserting it here.',
    }
  }

  if (fields.some((field) => ACCOUNTING_SYNC_LOG_UNIQUE_INDEXES.includes(field))) {
    return {
      kind: 'live_row_conflict',
      message:
        'Another LIVE sync row already holds this row\'s identity, so recording this one as SYNCED '
        + `collided with it (${fields.join(', ')}). Nothing was changed — the whole settlement rolled back. `
        + 'Resolve that live row first (let it finish, or settle it), then settle this one. IMS will not '
        + 'cancel it for you: it may be a real attempt that is still running.',
    }
  }

  // A unique violation this action does not recognise. Reporting it as either of the above would be
  // a guess about a money path; the caller rethrows so it surfaces as the fault it is.
  return null
}
