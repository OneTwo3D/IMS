/**
 * THE OPERATOR LEDGER CHECK — "I opened these payments in the ledger: none of them is this attempt"
 * (owner decision C4, 2026-10-01; the remedy for bd o3d-llyw's permanent hold).
 *
 * THE HOLD. `classifyLedgerSettlement` withholds on a ledger settlement it cannot MEASURE (its amount
 * or date is unreadable), because nothing the record itself says can rule it out as the attempt being
 * judged. When that record belongs to somebody else — a payment entered by hand, or a different row's
 * payment — no later event makes it readable, so every decision that judges the attempt against that
 * document withholds for ever. The automatic exclusion that once lifted it (o3d-r948 r3-r5) was removed
 * in r6 because the provenance it needed is not recorded anywhere, and C1 stopped an operator's
 * NOT_POSTED settlement from clearing a row. So the product had a refusal whose named remedy did not
 * remedy it.
 *
 * THE REMEDY IS A NEW, NARROW OPERATOR ASSERTION, and it is deliberately NOT a settlement of the row:
 * the attempt row is not touched, its ledger standing (ledger-standing.ts) is unchanged, and nothing
 * here ever says a payment was or was not posted. A check says exactly one thing, on a person's word:
 *
 *   "I looked in <connected organisation> at the payment records <R1..Rn> against document <D>, and
 *    none of them is the payment attempt <sync row A> made, nor a payment for receipt <P> that was
 *    already entered by hand."
 *
 * It is INSERT-ONLY (accounting_operator_ledger_checks, guarded by a database trigger), so a later
 * check never rewrites an earlier one, and it is scoped so tightly that every way the world can move
 * after the check voids it rather than stretching it:
 *
 *   (i)   it never clears a `present` verdict, and never any `unknown` other than an unmeasurable
 *         record — an unreadable probe, an undescribable attempt and an unproved collection are
 *         questions the operator's look does not answer;
 *   (ii)  EVERY unmeasurable record the probe returns NOW must carry a ledger id and be named by a check
 *         for THIS attempt and THIS receipt — a record that appeared since withholds again, and a
 *         record with no id can never be checked;
 *   (iii) the check's organisation must be the one that served the probe;
 *   (iv)  so must the check's connection GENERATION — re-minted at every Xero binding, so any reconnect
 *         (even back to the same organisation) voids every earlier check;
 *   and the probe must state which connection served it at all (`LedgerSettlementProbe.answeredBy`,
 *   request-bound); a probe that cannot say withholds.
 *
 * Having passed all of that, the attempt is judged AGAIN with the checked records set aside, and only
 * a `clear` from that second judgement lifts anything — so a measurable record matching the attempt
 * still refuses, and so does a collection the ledger did not prove complete.
 *
 * WHY A HUMAN'S WORD IS ACCEPTABLE HERE WHEN IT WAS NOT FOR NOT_POSTED (C1 vs C4). A NOT_POSTED
 * settlement asserts an ABSENCE nobody can see ("the call did not land"). A check asserts something
 * about records the operator is shown by id and can open: whether a specific, immutable ledger payment
 * is the one a specific attempt made. Its failure mode is still a duplicate payment if the person is
 * wrong, which is why the scope above is as narrow as it is, why every lift names the check ids that
 * permitted it, and why the operator text says what the check IS (an assertion, logged against the
 * user) and never what the ledger holds.
 *
 * Pure. The I/O — loading checks, recording one — lives in operator-ledger-check-store.ts.
 */

import { createHash } from 'node:crypto'

import {
  classifyLedgerSettlement,
  isUnmeasurableSettlementRecord,
  type AttemptDescription,
  type LedgerSettlementProbe,
  type ProbeConnectionBinding,
  type SettlementVerdict,
} from './ledger-settlement-evidence'
import { LEDGER_CHECK_CONTROL_NAME } from './operator-ledger-check-offer'

/** One recorded check, as the rule reads it. Mirrors the insert-only table's columns. */
export type OperatorLedgerCheck = {
  id: string
  /** The unresolved attempt (AccountingSyncLog id) the check speaks about. */
  syncLogId: string
  /** The receipt (Payment id) whose registration or post the check lets through. */
  paymentId: string
  connector: string
  /** The ledger document the checked records settle (the probe's target). */
  ledgerDocumentId: string
  /** The EXACT unmeasurable record ids the probe showed when the check was recorded. */
  ledgerRecordIds: readonly string[]
  /**
   * {@link settlementRecordFingerprint} of each of those records AS CONFIRMED, index-aligned with
   * `ledgerRecordIds`. Optional only so the type can describe a row built in memory; a check without
   * them covers nothing.
   */
  ledgerRecordFingerprints?: readonly string[]
  /** The organisation and consent generation that served the probe the operator was shown. */
  tenantId: string
  connectionGeneration: string
}

/** What a decision judging one attempt knows about where it is. */
export type OperatorLedgerCheckScope = {
  /** The attempt being judged. */
  attemptSyncLogId: string
  /**
   * The receipt whose money would move if the attempt is cleared — the receipt being REGISTERED (the
   * enqueue decision), or the receipt of the row being POSTED / REVIVED (the post fence, the revival
   * gate). Null when that row names none: no check can apply, because no check can be shown to have
   * considered a hand-entered duplicate of it.
   */
  paymentId: string | null
  connector: string
  /** The document the probe read. Null = unknown, and no check applies. */
  ledgerDocumentId: string | null
  /**
   * The ledger id the attempt row ITSELF records (`externalTransactionId`), when the caller holds it. A
   * record carrying that id is the attempt's own payment by the row's own account, so no check may set
   * it aside, whatever a person asserted.
   */
  attemptRecordedLedgerId?: string | null
}

/**
 * Why a hold that a check could in principle lift is NOT liftable by one — each is a fact the operator
 * is told, so the remedy sentence never offers a lever that cannot work.
 */
export type LedgerCheckUnavailableReason =
  /** An unmeasurable record carries no ledger id, so nothing could name it. */
  | 'record-without-id'
  /** The probe could not say which connection served it (legacy token with no generation, or a reconnect between its fetches). */
  | 'connection-unbound'
  /** The row being cleared names no receipt, or the probe read no named document. */
  | 'scope-unnamed'
  /** An unreadable record carries the very ledger id the attempt row records as its own. */
  | 'record-is-the-attempts-own'

/** What would lift a withheld attempt, for the operator text. */
export type LedgerCheckRemedy =
  | {
      liftable: true
      attemptSyncLogId: string
      paymentId: string
      ledgerDocumentId: string
      /** Every unmeasurable record id the probe returned now — all must be checked. */
      recordIds: string[]
      /** The subset no check in scope names yet (the ones the operator still has to look at). */
      uncheckedRecordIds: string[]
      /** The connection the check must be recorded under (it is voided by any reconnect). */
      binding: ProbeConnectionBinding
    }
  | { liftable: false; reason: LedgerCheckUnavailableReason }

export type CheckedSettlementVerdict = {
  verdict: SettlementVerdict
  /** The check ids that lifted an unmeasurable-record hold. Non-empty ONLY when `verdict` is `clear` because of them. */
  liftedByCheckIds: string[]
  /** Set when the verdict is an unmeasurable-record hold: what would (or why nothing can) lift it. */
  remedy: LedgerCheckRemedy | null
}

/**
 * The version of {@link settlementRecordFingerprint}'s canonical serialisation, carried as the prefix of
 * every fingerprint so a stored check can never be compared against a differently-built one: a version
 * this build does not produce simply never matches, which is the withholding answer.
 */
export const SETTLEMENT_RECORD_FINGERPRINT_VERSION = 'v1'

/**
 * WHAT THE OPERATOR WAS SHOWN ABOUT ONE SETTLEMENT, as one comparable string.
 *
 * A check names records by their immutable ledger id, but the operator's judgement was made on what the
 * record SAID: its (unreadable) amount, its date, its reference. A payment edited in place in Xero keeps
 * its id and can stay unmeasurable, so an id alone would let a check made about one state of the record
 * set aside a different one. Every field the preview shows and the rule reads is in here, in a fixed
 * order, as the exact text the probe produced: the id (folded the way ids are compared), the readable
 * amount's exact digits, the unreadable figure as Xero stated it, the date and the reference. A check
 * applies to a record only while the record still produces the fingerprint stored with the check.
 */
export function settlementRecordFingerprint(record: {
  id?: string | null
  amount: { toFixed(): string } | null
  unreadableAmount?: string | null
  date: string | null
  reference?: string | null
}): string {
  const canonical = JSON.stringify([
    SETTLEMENT_RECORD_FINGERPRINT_VERSION,
    normaliseLedgerId(record.id),
    record.amount === null ? null : record.amount.toFixed(),
    record.unreadableAmount ?? null,
    record.date ?? null,
    record.reference ?? null,
  ])
  return `${SETTLEMENT_RECORD_FINGERPRINT_VERSION}:${createHash('sha256').update(canonical).digest('hex')}`
}

/** Ledger ids are compared case-insensitively and trimmed: Xero GUIDs come back in either case. */
export function sameLedgerId(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normaliseLedgerId(a)
  const right = normaliseLedgerId(b)
  return left !== null && left === right
}

export function normaliseLedgerId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().toLowerCase()
  return trimmed === '' ? null : trimmed
}

/**
 * The connection a probe's fetches were served by, from the identity each RESPONSE carries — or null.
 *
 * Every response must name the same non-empty tenant AND the same non-empty generation. A response
 * with no identity (no request was made, a test double, a connector whose transport does not say) makes
 * the whole answer unbound, and so does any disagreement between two fetches.
 */
export function bindProbeToConnection(
  responses: ReadonlyArray<{ tenantId?: string | null; connectionGeneration?: string | null }>,
): ProbeConnectionBinding | null {
  if (responses.length === 0) return null
  const first = responses[0]!
  const tenantId = typeof first.tenantId === 'string' ? first.tenantId.trim() : ''
  const connectionGeneration = typeof first.connectionGeneration === 'string' ? first.connectionGeneration.trim() : ''
  if (tenantId === '' || connectionGeneration === '') return null
  for (const response of responses) {
    if ((response.tenantId ?? '').trim() !== tenantId) return null
    if ((response.connectionGeneration ?? '').trim() !== connectionGeneration) return null
  }
  return { tenantId, connectionGeneration }
}

/** The checks that are about THIS attempt, THIS receipt, THIS document and THIS connection. */
function checksInScope(
  checks: readonly OperatorLedgerCheck[],
  scope: OperatorLedgerCheckScope & { paymentId: string; ledgerDocumentId: string },
  binding: ProbeConnectionBinding,
): OperatorLedgerCheck[] {
  return checks.filter((check) =>
    check.syncLogId === scope.attemptSyncLogId
    && check.paymentId === scope.paymentId
    && check.connector === scope.connector
    && sameLedgerId(check.ledgerDocumentId, scope.ledgerDocumentId)
    && check.tenantId === binding.tenantId
    && check.connectionGeneration === binding.connectionGeneration)
}

/**
 * Judge ONE attempt against the probe, honouring operator ledger checks under the rule in the header.
 *
 * With no checks this is exactly `classifyLedgerSettlement` plus a remedy description, so a caller
 * that switches to it changes no verdict until a person records a check.
 */
export function classifyLedgerSettlementWithOperatorChecks(
  attempt: AttemptDescription,
  probe: LedgerSettlementProbe,
  scope: OperatorLedgerCheckScope,
  checks: readonly OperatorLedgerCheck[],
): CheckedSettlementVerdict {
  const first = classifyLedgerSettlement(attempt, probe)
  // (i) Only an unmeasurable-record hold is a question a ledger check answers. `present` in particular
  // is returned untouched: a check never clears a payment IMS can match to the attempt.
  if (first.outcome !== 'unknown' || first.cause !== 'record-unmeasurable' || !probe.ok) {
    return { verdict: first, liftedByCheckIds: [], remedy: null }
  }

  // (ii) The WHOLE set the probe cannot measure, not just the first record the classifier stopped on.
  const unmeasurable = probe.records.filter(isUnmeasurableSettlementRecord)
  const recordIds = unmeasurable.map((record) => normaliseLedgerId(record.id))
  if (recordIds.some((id) => id === null)) {
    return { verdict: first, liftedByCheckIds: [], remedy: { liftable: false, reason: 'record-without-id' } }
  }
  const ownId = normaliseLedgerId(scope.attemptRecordedLedgerId)
  if (ownId !== null && recordIds.includes(ownId)) {
    return { verdict: first, liftedByCheckIds: [], remedy: { liftable: false, reason: 'record-is-the-attempts-own' } }
  }
  // (iii)/(iv) need a probe that can say which connection served it.
  const binding = probe.answeredBy ?? null
  if (binding === null) {
    return { verdict: first, liftedByCheckIds: [], remedy: { liftable: false, reason: 'connection-unbound' } }
  }
  if (scope.paymentId === null || normaliseLedgerId(scope.ledgerDocumentId) === null) {
    return { verdict: first, liftedByCheckIds: [], remedy: { liftable: false, reason: 'scope-unnamed' } }
  }
  const named = { ...scope, paymentId: scope.paymentId, ledgerDocumentId: scope.ledgerDocumentId as string }
  const ids = recordIds as string[]
  const eligible = checksInScope(checks, named, binding)
  // A check covers a record only AS IT WAS CONFIRMED: the fingerprint stored beside the record id in the
  // check must equal the fingerprint of the record the probe returned NOW. A payment edited in place in
  // Xero (same immutable id, a different amount, date or reference, still unreadable) is therefore not
  // covered by a check made about its earlier state, at every gate that applies this rule.
  const currentFingerprint = new Map<string, string>()
  for (const record of unmeasurable) currentFingerprint.set(normaliseLedgerId(record.id) as string, settlementRecordFingerprint(record))
  const coveredBy = (id: string) => eligible.filter((check) => check.ledgerRecordIds.some((checked, index) =>
    sameLedgerId(checked, id)
    && typeof check.ledgerRecordFingerprints?.[index] === 'string'
    && check.ledgerRecordFingerprints[index] === currentFingerprint.get(id)))
  const unchecked = ids.filter((id) => coveredBy(id).length === 0)
  const remedy: LedgerCheckRemedy = {
    liftable: true,
    attemptSyncLogId: scope.attemptSyncLogId,
    paymentId: named.paymentId,
    ledgerDocumentId: named.ledgerDocumentId,
    recordIds: unmeasurable.map((record) => (record.id as string).trim()),
    uncheckedRecordIds: unmeasurable
      .filter((record) => unchecked.includes(normaliseLedgerId(record.id) as string))
      .map((record) => (record.id as string).trim()),
    binding,
  }
  if (unchecked.length > 0) return { verdict: first, liftedByCheckIds: [], remedy }

  // Every unmeasurable record is named by a check in scope. Judge the attempt AGAIN with those records
  // set aside, so the rest of the ledger still decides: a measurable record matching the attempt is
  // `present`, an unproved collection is `unknown`, and only `clear` lifts. (The mark pass of the FIRST
  // judgement already ran over every record, the checked ones included, and found nothing — otherwise
  // it would have answered `present` above.)
  const second = classifyLedgerSettlement(attempt, {
    ...probe,
    records: probe.records.filter((record) => !isUnmeasurableSettlementRecord(record)),
  })
  if (second.outcome !== 'clear') return { verdict: second, liftedByCheckIds: [], remedy: null }
  const lifting = new Set<string>()
  for (const id of ids) for (const check of coveredBy(id)) lifting.add(check.id)
  return { verdict: second, liftedByCheckIds: [...lifting].sort(), remedy: null }
}

/* ------------------------------------------------------------------------------------------- *
 * OPERATOR TEXT — single-sourced here, and CONDITIONAL on what the remedy can actually do.
 * ------------------------------------------------------------------------------------------- */

export { LEDGER_CHECK_CONTROL_NAME, offersOperatorLedgerCheck } from './operator-ledger-check-offer'

/**
 * THE SENTENCE THAT TELLS AN OPERATOR WHAT LIFTS AN UNMEASURABLE-RECORD HOLD — or why nothing they
 * record can. Never states what the ledger holds or that anything was or was not posted: the hold
 * exists because IMS cannot read those records.
 *
 * `attemptLabel` describes the attempt the operator must compare against (amount, date, reference),
 * built by the caller from the attempt description it already holds.
 */
/**
 * Where the hold was met, which decides what happens after a check is recorded:
 *   registration — the recorder re-runs the receipt's guarded registration itself;
 *   post         — the entry's next automatic attempt reads the check (the manual Retry does not yet);
 *   revival      — the next automatic enqueue of this follow-up reads it.
 */
export type LedgerCheckContext = 'registration' | 'post' | 'revival'

const AFTER_CHECK: Record<LedgerCheckContext, string> = {
  registration: 'IMS then registers this receipt again through the same checks.',
  post: 'This entry\'s next automatic attempt reads the check; Retry on the Sync Dashboard does not read ledger checks yet.',
  revival: 'The next automatic enqueue of this entry reads the check.',
}

export function describeLedgerCheckRemedy(
  remedy: LedgerCheckRemedy,
  attemptLabel: string,
  context: LedgerCheckContext = 'registration',
): string {
  if (!remedy.liftable) {
    switch (remedy.reason) {
      case 'record-without-id':
        return 'An operator ledger check cannot lift this hold: at least one of those settlements carries no '
          + 'ledger id, so it cannot be named and checked. Resolve it in the accounting system and ESCALATE.'
      case 'connection-unbound':
        return 'An operator ledger check cannot lift this hold yet: IMS could not establish which Xero connection '
          + 'answered the reading (the stored connection records no generation, or it changed while the reading '
          + 'ran). Reconnect Xero from Settings, then look at this refusal again.'
      case 'record-is-the-attempts-own':
        return 'An operator ledger check cannot lift this hold: one of those settlements carries the very ledger id '
          + 'the earlier entry records as its own payment. If that payment should not be there, deal with it in the '
          + 'accounting system first; IMS will not set it aside on anyone\'s word.'
      case 'scope-unnamed':
        return 'An operator ledger check cannot lift this hold: the entry being cleared names no receipt or no '
          + 'ledger document, so a check could not be tied to it. ESCALATE.'
    }
  }
  const unchecked = remedy.uncheckedRecordIds.length === remedy.recordIds.length
    ? remedy.recordIds
    : remedy.uncheckedRecordIds
  const one = unchecked.length === 1
  return `WHAT LIFTS THIS HOLD: open ${one ? 'payment' : 'each of the payments'} `
    + `${unchecked.join(', ')} on document ${remedy.ledgerDocumentId} in Xero and compare ${one ? 'it' : 'each'} with ${attemptLabel}. `
    + (one
      ? 'Only if it is not that attempt\'s payment, and not a payment for this receipt already entered by hand, '
      : 'Only if none of them is that attempt\'s payment, and none is a payment for this receipt already entered by hand, ')
    + `record that on the Accounting Sync page: entry ${remedy.attemptSyncLogId}, "${LEDGER_CHECK_CONTROL_NAME}", `
    + `for receipt ${remedy.paymentId}. ${AFTER_CHECK[context]} The check is `
    + 'your assertion and is logged against your account; it covers only those payment ids, it lapses after any '
    + 'Xero reconnect, a payment that appears later holds the receipt again, and it never overrides a payment IMS '
    + `can match to the attempt. If ${one ? 'it' : 'one of them'} IS that attempt's payment, do not record a check: `
    + 'settle the entry as posted instead.'
}

/**
 * Why a check that covers every unreadable record still does not get a receipt sent: another
 * registration on the same invoice has already posted, and the post fence refuses a second payment beside
 * one IMS posted itself (the documented part-payment limit). No lever is offered, because none exists in
 * the product; the sentence exists so nobody records checks that cannot work.
 */
export function describeLedgerCheckBlockedByPostedRegistration(entryIds: readonly string[]): string {
  return `An operator ledger check cannot get this receipt sent: ${entryIds.length === 1 ? 'entry' : 'entries'} `
    + `${entryIds.join(', ')} already posted a payment against this invoice, and the check IMS makes immediately `
    + 'before sending money refuses a payment beside one IMS has already posted on the same invoice (a known limit '
    + 'for part payments). A check here would only queue a payment that is then refused. ESCALATE.'
}

/**
 * A short description of an attempt for the operator to compare a ledger payment against. Amount and
 * date are what the attempt SENT (or would send); the reference is the mark IMS writes into the
 * payment's reference field.
 */
export function describeAttemptForLedgerCheck(attempt: {
  syncLogId: string
  status: string
  amount: string | null
  currency: string | null
  date: string | null
  marker: string | null
}): string {
  const parts = [
    attempt.amount !== null ? `${attempt.currency ?? ''} ${attempt.amount}`.trim() : 'an amount IMS cannot state',
    attempt.date !== null ? `dated ${attempt.date}` : 'with no recorded date',
    attempt.marker !== null ? `reference containing ${attempt.marker}` : null,
  ].filter((part): part is string => part !== null)
  return `the ${attempt.status} attempt ${attempt.syncLogId} (${parts.join(', ')})`
}

/**
 * The receipt an INVOICE_PAYMENT payload was queued for — the ONE reading of that field
 * (`payloadPaymentId` in invoice-payment-enqueue.ts delegates here). Any other type answers null: no
 * operator ledger check is ever recorded for one, so none may lift its hold.
 */
export function invoicePaymentReceiptId(payload: unknown): string | null {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
  return typeof p.paymentId === 'string' ? p.paymentId : null
}

/** The scope for judging `attempt` before posting (or reviving) a row of `type` with this payload. */
export function ledgerCheckScopeForPost(params: {
  type: string
  connector: string
  attemptSyncLogId: string
  /** The payload of the row whose money would move — its receipt and its document. */
  postingPayload: unknown
}): OperatorLedgerCheckScope {
  const p = (params.postingPayload && typeof params.postingPayload === 'object' ? params.postingPayload : {}) as Record<string, unknown>
  const isReceipt = params.type === 'INVOICE_PAYMENT'
  return {
    attemptSyncLogId: params.attemptSyncLogId,
    paymentId: isReceipt ? invoicePaymentReceiptId(params.postingPayload) : null,
    connector: params.connector,
    ledgerDocumentId: isReceipt && typeof p.accountingInvoiceId === 'string' ? p.accountingInvoiceId : null,
  }
}

/**
 * The same judgement, loading checks ONLY when a check could change it — an unmeasurable-record hold
 * whose records all carry ids, on a probe bound to a connection, for a named receipt and document.
 * Every other verdict is returned without a database read, and a loader that FAILS is read as "no
 * checks" (the withholding answer), never as a reason to proceed.
 */
export async function judgeAttemptWithOperatorChecks(
  attempt: AttemptDescription,
  probe: LedgerSettlementProbe,
  scope: OperatorLedgerCheckScope,
  loadChecks: ((scope: OperatorLedgerCheckScope) => Promise<readonly OperatorLedgerCheck[]>) | null | undefined,
): Promise<CheckedSettlementVerdict> {
  const unchecked = classifyLedgerSettlementWithOperatorChecks(attempt, probe, scope, [])
  if (unchecked.remedy?.liftable !== true || !loadChecks) return unchecked
  let checks: readonly OperatorLedgerCheck[]
  try {
    checks = await loadChecks(scope)
  } catch {
    return unchecked
  }
  return classifyLedgerSettlementWithOperatorChecks(attempt, probe, scope, checks)
}

