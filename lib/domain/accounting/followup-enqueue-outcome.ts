// ---------------------------------------------------------------------------
// o3d-peh1 — A REFUSAL THAT ITS CALLERS CANNOT SEE IS A NO-OP THAT REPORTS SUCCESS.
//
// `enqueueFollowUpSyncLog` has THREE ways of declining to enqueue a follow-up, and all are
// deliberate, correct refusals: an ambiguous idempotency-token history, a ledger that will not say
// the attempt is absent, and a revival target that carries no attempt revision AND whose type the
// ledger probe does not speak for. The first two wrote a WARNING to the activity log and then RETURNED NORMALLY,
// and `Promise<void>` gave the caller nothing to read. So every caller — the connector's own post
// path, the credit-note re-enqueue sweep, and above all `repairXeroBackReferences` — treated the
// refusal as "the follow-ups are enqueued".
//
// THE THIRD CASE IS NOT A REFUSAL AND MUST NOT BE GIVEN A REASON CODE (round 4, Codex LOW). A live
// sibling holding the scope under a DIFFERENT idempotency token is resolved by
// `resolveLostFollowUpRevival`, which either answers FOLLOW_UPS_ENQUEUED (the live row carries OUR
// token, so the work IS queued) or THROWS. Nothing on that path constructs an outcome, so the
// `slot_lost` reason this union used to declare was unconstructible: a caller could branch on it
// for ever and never see it, and a reader would believe a refusal existed that in fact surfaces as
// an exception. It was removed rather than wired up — the throw is the correct behaviour, since the
// unique index gives the slot away and retrying cannot recover it.
//
// The worst of those is the back-reference sweep, because it does not merely continue: it SETTLES.
// It marks the parent row SYNCED, clears `backReferenceFollowUpsPendingAt` — the last record that
// anything was owed — and logs `xero_backreference_followups_recovered`, while the money-moving child
// (an INVOICE_PAYMENT, a PURCHASE_CREDIT_NOTE_ALLOCATION) is still FAILED and was never re-enqueued.
// A payment is lost, and the log says it was recovered.
//
// THE OUTCOME IS A UNION, NOT A BOOLEAN BESIDE A LIST. `{ enqueued: boolean; refusals: [] }` can be
// constructed inconsistently — enqueued true with refusals in it, or false with none — and the first
// caller to read the wrong half of it reintroduces the defect in a new place. Here the refusals exist
// only on the arm that has them, and the only constructor that can build that arm demands at least
// one, so "there is a refusal" and "this was not enqueued" are the same fact.
//
// A REFUSAL CARRIES ITS OPERATOR MESSAGE. Not a code the caller re-renders into prose of its own:
// two hand-written descriptions of the same refusal drift, and the sweep is further from the
// evidence than the enqueue is. The enqueue writes the sentence once, logs it, and hands the same
// sentence to whoever has to act on it.
// ---------------------------------------------------------------------------

/**
 * Why a follow-up enqueue declined. These are the machine keys that already appear in the
 * `*_followup_enqueue_refused` activity metadata, so an operator reading the log and a caller
 * branching on the outcome are naming the same thing.
 *
 * EVERY MEMBER IS CONSTRUCTED SOMEWHERE. A reason nothing can produce is worse than no reason at
 * all: it advertises a branch that never runs and describes a refusal an operator will never see.
 * See the header on `slot_lost`, which was exactly that.
 */
export type FollowUpEnqueueDeclineReason =
  /** `planFollowUpEnqueue` refused: several FAILED rows for this scope under DIFFERENT tokens. */
  | 'plan_refused'
  /** o3d-0m56: the ledger would not confirm the attempt is absent, so re-posting could duplicate it. */
  | 'ledger_not_clear'
  /**
   * o3d-batch-ret round 5 (Codex MEDIUM): the revival target carries NO attempt revision AND its type
   * is one the ledger probe does not speak for, so nothing established that the effect has not
   * already happened.
   *
   * Round 4 removed a blanket refusal of revision-0 reuse targets and replaced it with
   * `ledgerClearsFollowUpRevival`. That replacement is real for money-moving types and a NO-OP for
   * every other one — it returns `{ clear: true }` before probing anything when
   * `isMoneyMovingSyncType` is false. A revision-0 FAILED row is exactly the legacy population the
   * fence cannot reason about (the migration left every pre-existing FAILED row at 0, so "revision 0
   * means never claimed" is true of fresh rows and false of those), and for INVOICE_EMAIL the effect
   * is a customer invoice email that CANNOT be recalled. So the half of round 4's refusal that its
   * replacement does not cover is kept: the revival is refused, visibly, with a remedy.
   */
  | 'unprobed_unfenced_reuse'

/**
 * o3d-batch-ret ROUND 6 (Codex HIGH) — A REFUSAL THAT HAPPENS BEFORE THE ENQUEUE IS EVER CALLED.
 *
 * The three above are the enqueue's own: `enqueueFollowUpSyncLog` was reached, looked at the row
 * history or the ledger, and declined. This one is raised by the CONNECTOR, one frame up, when the
 * post path was asked for a payment (`_registerPayment`) and the payment-account configuration
 * cannot name an account to register it against — so the enqueue is never attempted at all.
 *
 * IT IS A SEPARATE SUB-VOCABULARY BECAUSE THE COUNT IS LOAD-BEARING. Three prose sites state how
 * many ways THE ENQUEUE declines, and `followup-enqueue-refusal-vocabulary.test.ts` holds them to
 * the declaration. Folding a caller-side refusal into that union would have made all three sites
 * wrong in the safe-looking direction — a number that is too big describes refusals the enqueue does
 * not have — so the two sets are named separately and each is counted against what it is about.
 */
export type FollowUpPreEnqueueRefusalReason =
  /**
   * `_registerPayment` was requested and no bank account could be resolved for it: either no payment
   * account map is configured at all, or none maps this method/currency pair. Nothing was queued.
   *
   * BEFORE THIS EXISTED THE SKIP WAS REPORTED AS SUCCESS. `paymentOutcome` was initialised to
   * `FOLLOW_UPS_ENQUEUED` and these two branches only wrote a WARNING to the activity log, so the
   * aggregate verdict said `enqueued: true`, `obligationReleasePrerequisite` handed the fence no
   * prerequisite, and the fence CLEARED the obligation generation over a payment that had been
   * requested and never queued. On Xero the sweep could no longer find the row; on QuickBooks, whose
   * registry entry declares no consumer at all, the money was lost permanently. Repairing the
   * mapping afterwards could not re-drive a marker that no longer existed.
   */
  'payment_account_unmapped'

/** Every reason a follow-up can be reported as still owed — the enqueue's own, and the caller's. */
export type FollowUpEnqueueRefusalReason = FollowUpEnqueueDeclineReason | FollowUpPreEnqueueRefusalReason

export type FollowUpEnqueueRefusal = {
  type: string
  referenceType: string
  referenceId: string
  reason: FollowUpEnqueueRefusalReason
  /**
   * The operator-facing sentence, ending in a remedy that can actually be performed. Written by the
   * enqueue, logged by the enqueue, and re-used verbatim by whichever caller has to report it.
   */
  message: string
  /** The FAILED row a revival would have reused, where the refusal was about a specific row. */
  syncLogId?: string
}

/**
 * Did the enqueue leave this row's follow-ups OWED?
 *
 * `enqueued: true` means every follow-up this row owes is now queued, or was already queued by a
 * live row, or the row owes none. It is the ONLY value a caller may settle on.
 */
export type FollowUpEnqueueOutcome =
  | { readonly enqueued: true }
  | { readonly enqueued: false; readonly refusals: readonly FollowUpEnqueueRefusal[] }

export const FOLLOW_UPS_ENQUEUED: FollowUpEnqueueOutcome = { enqueued: true }

/**
 * Build a refused outcome. Throws on an empty list rather than quietly producing a refused outcome
 * with nothing in it — an unexplained refusal is the same silence this type exists to remove, and a
 * caller cannot report what it was not told.
 */
export function refusedFollowUpEnqueue(...refusals: FollowUpEnqueueRefusal[]): FollowUpEnqueueOutcome {
  if (refusals.length === 0) throw new Error('refusedFollowUpEnqueue requires at least one refusal')
  return { enqueued: false, refusals }
}

/**
 * THE ONE SENTENCE BOTH CONNECTORS SAY WHEN A REQUESTED PAYMENT CANNOT BE QUEUED (o3d-batch-ret r6,
 * Codex HIGH).
 *
 * Written here rather than twice, because the two connectors had the identical defect and the r7/r8
 * lesson is that a message duplicated across surfaces drifts until one of the copies authorises
 * something the other forbids. What CANNOT be shared is what happens next: on Xero the marker is
 * re-read by a sweep, on QuickBooks nothing re-reads it at all. That difference is a declared fact
 * about the connector, so `recovery` comes in from
 * `followUpObligationRecoveryNote(followUpObligationRecoveryFor(...))` and is never written here —
 * the same rule `xeroRetainedFollowUpObligationDescription` follows.
 *
 * IT NAMES NO HAND-MADE PAYMENT. The remedy is a SETTING, which is safe to repeat and cannot double
 * anything; the recovery note then says whether the queued work comes back on its own. Telling an
 * operator to register the receipt in the accounting package instead would be the o3d-0bfh r11
 * defect on a new surface — no request id can deduplicate a payment a human entered by hand.
 */
export function paymentAccountRefusalMessage(input: {
  /** Display name of the accounting package, for the operator: `Xero`, `QuickBooks`. */
  connector: string
  referenceType: string
  referenceId: string
  /** What the configuration failed to yield, as a clause: "no payment account map is configured". */
  missing: string
  /** Where the operator sets it, as a sentence. */
  configure: string
  /** The connector's declared recovery note — what re-reads the retained marker, if anything. */
  recovery: string
}): string {
  return `Refused to enqueue the ${input.connector} INVOICE_PAYMENT for ${input.referenceType} ${input.referenceId}: `
    + `the invoice asked for a payment to be registered and ${input.missing}. NOTHING WAS QUEUED, and the row is `
    + 'deliberately left marked as owing follow-ups so the money is not reported as settled — it is SYNCED and '
    + `carries its external id exactly like a row that completed. ${input.configure} What happens to this row once `
    + `the setting is corrected is a fact about this connector, not a promise made here: ${input.recovery}.`
}

/**
 * THE AMOUNT A POSTED INVOICE'S PAYLOAD IS ACTUALLY ASKING TO SETTLE (o3d-batch-ret r7, Codex
 * MEDIUM) — RESOLVED BEFORE ANY CONFIGURATION IS CONSULTED, AND ON BOTH CONNECTORS.
 *
 * ROUND 6 TURNED A SILENT SUCCESS INTO A FALSE REFUSAL. `decideInvoicePaymentFollowUp` validated the
 * payment-account map FIRST and only then computed the amount, so the explicit `!(amount > 0)`
 * verdict — "nobody is owed anything, and that is a success" — sat downstream of a check the
 * no-payment case never needed. The WooCommerce importer sets
 * `_registerPayment: !!wcOrder.date_paid_gmt && documentTotalsToTheOrder` while
 * `resolveWcInvoicePaymentAmount` returns `undefined` for a PAID ZERO-TOTAL order (its guard is
 * `gross > 0`), so a £0 order marked paid asks for a payment worth nothing. With no mapping
 * configured that order was refused for a bank account it would never have used, kept its obligation
 * marker for ever, and — on QuickBooks — could carry the posted parent all the way to FAILED.
 *
 * THE ORDER OF QUESTIONS IS THE FIX, NOT A NEW BRANCH. A consumer may only ask about a mapping once
 * it knows a payment is genuinely owed; asking earlier makes a configuration answer stand in for a
 * money one. Both connectors had the identical ordering and both are reordered, and the resolution
 * itself is HERE rather than twice, because a rule copied into two files is a rule two files can
 * disagree about — which is how this pair acquired the same defect in the first place.
 *
 * IT RETURNS `undefined` RATHER THAN 0 FOR AN UNUSABLE DECLARATION, and the caller's `!(amount > 0)`
 * reads both the same way: nothing to move. Note the string arm — the shipped code declared
 * `amount` as `number | undefined` and then tested `amount == null` before converting, so a numeric
 * STRING was never converted and was handed to the enqueue as a string. Doing the conversion where
 * the value's type is actually examined is what makes that arm reachable.
 */
export function requestedInvoicePaymentAmount(payload: Record<string, unknown>): number | undefined {
  const declared = payload._paymentAmount
  if (typeof declared === 'number') return Number.isFinite(declared) ? declared : undefined
  if (typeof declared === 'string') {
    const parsed = Number(declared)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  // Anything else DECLARED is unusable and must not silently fall back to a derived figure: the
  // payload said what to settle and it cannot be read, which is not the same as it saying nothing.
  if (declared !== null && declared !== undefined) return undefined

  // Nothing declared: derive the document total the same way both connectors always have. The
  // `Array.isArray` guard replaces an unguarded cast — a payload with no lines used to throw a
  // TypeError from inside the follow-up pass, which fails an entry whose invoice has already posted.
  const lines = Array.isArray(payload.lines) ? payload.lines as Array<{ quantity: number; unitAmount: number }> : []
  const shipping = typeof payload.shippingAmount === 'number' ? payload.shippingAmount : 0
  const discount = typeof payload.discountAmount === 'number' ? payload.discountAmount : 0
  return lines.reduce((sum, line) => sum + line.quantity * line.unitAmount, 0) + shipping - discount
}

/**
 * WHAT ACTUALLY HAPPENS TO A POSTED ROW WHOSE PAYMENT WAS REFUSED ON THE PROCESSOR'S OWN POST PATH
 * (o3d-batch-ret r7, Codex MEDIUM).
 *
 * THE SHARED PRODUCER TOOK ITS RECOVERY CLAUSE AS AN ARGUMENT, AND THAT LET A TRUE CLAUSE BE PASSED
 * WHERE IT IS FALSE. `paymentAccountRefusalMessage` deliberately refuses to write the "what happens
 * next" half itself, because that half differs by connector — and round 6 filled it in from the
 * REGISTRY at both call sites. The registry answers a question about a RETAINED MARKER on a row at
 * rest: on QuickBooks `consumer: 'none'`, i.e. nothing re-reads it, escalate. That is true of the
 * retained-marker sweep and FALSE of this refusal, which does not leave the row at rest at all:
 * `requireFollowUpsEnqueued` throws, the connector catches it and `markSyncLogForFollowUpRetry` puts
 * the POSTED parent back to PENDING with its external id and its marker intact, and the next
 * processor pass selects it, takes the idempotency short-circuit on that id, and retries only the
 * follow-ups. So the operator was told to escalate a row that was actively retrying.
 *
 * THE REGISTRY FACT IS STILL THE REGISTRY'S, and it is where this clause ENDS rather than what it
 * replaces: `atRest` is the caller's `followUpObligationRecoveryNote(...)`, describing the row once
 * the retries are spent. Nothing about a connector's consumer is written here.
 *
 * ONLY A CALL SITE WITH ONE DRIVER MAY USE THIS. The Xero twin of this refusal is reached from the
 * processor's post path AND from `repairXeroBackReferences`, which hands the connector's
 * `enqueueFollowUps` over by identity; on the sweep's pass the row is at rest and no processor retry
 * is coming, so this clause would be false there. That call site therefore keeps the
 * driver-agnostic registry note, which is true on both of its drivers. QuickBooks binds no sweep
 * (its registry entry is the declaration of that), so its refusal has exactly one driver.
 */
export function postedRowFollowUpRetryNote(input: {
  /** Display name of the accounting package, for the operator: `QuickBooks`. */
  connector: string
  /** The processor's own retry bound, read from the connector rather than restated as a number. */
  maxRetries: number
  /** The connector's declared fact about a retained marker once the retries are spent. */
  atRest: string
}): string {
  return `this refusal FAILS the entry rather than settling it. The posted parent keeps its external id and its `
    + `follow-up obligation marker and goes back on the queue, so the main ${input.connector} sync processor selects `
    + `it again — ${input.maxRetries} attempts in all — takes the idempotency short-circuit on that external id `
    + 'straight back to the follow-ups instead of posting a second document, and queues the payment as soon as the '
    + 'mapping names an account for it. Nothing is posted twice and nothing needs to be settled by hand in the '
    + `meantime. Once those ${input.maxRetries} attempts are spent the row comes to rest FAILED and still marked, `
    + `and from that point ${input.atRest}`
}

/** The refusals an outcome carries; empty for an enqueued one. */
export function followUpEnqueueRefusals(outcome: FollowUpEnqueueOutcome): readonly FollowUpEnqueueRefusal[] {
  return outcome.enqueued ? [] : outcome.refusals
}

/**
 * Fold the fan-out of one posted row (an invoice owes a payment AND a PDF; a PDF owes an email AND a
 * store note) into one outcome.
 *
 * REFUSALS ACCUMULATE AND NOTHING SWALLOWS THEM. A refused payment beside an enqueued PDF is refused
 * overall, because the caller's question is "may I settle this row?" and the answer is no while any
 * part of the work is still owed.
 */
export function combineFollowUpEnqueueOutcomes(
  ...outcomes: FollowUpEnqueueOutcome[]
): FollowUpEnqueueOutcome {
  const refusals = outcomes.flatMap(followUpEnqueueRefusals)
  return refusals.length === 0 ? FOLLOW_UPS_ENQUEUED : { enqueued: false, refusals }
}

/** One line naming every refusal, for an activity-log description or a thrown error. */
export function describeFollowUpEnqueueRefusals(outcome: FollowUpEnqueueOutcome): string {
  return followUpEnqueueRefusals(outcome)
    .map((refusal) => `${refusal.type} for ${refusal.referenceType} ${refusal.referenceId} (${refusal.reason}): ${refusal.message}`)
    .join(' | ')
}

/**
 * o3d-batch-ret (Codex HIGH) — THE RELEASE PREREQUISITE THE ENQUEUE'S OWN VERDICT BELONGS IN.
 *
 * A CORRECT CHECK PLACED AFTER THE IRREVERSIBLE STEP IS NOT A CHECK. Both connectors composed the
 * enqueue verdict, the receipt verdict and the fence answer at their choke point — `requireFollowUpsEnqueued`
 * on the post path, `followUpSettlement` in the sweep — and both of those run AFTER
 * `registerDeferredOrderReceipts` has already taken the marker decision under the sales-order lock.
 * With no receipt outstanding and no prerequisite stated, the fence answered `released`: the claimed
 * generation was cleared, and the refusal the choke point then raised could not put it back. The row
 * is SYNCED, linked, and marker-null — which the next sweep reads as reconciled and stamps, with the
 * payment or PDF that was REFUSED never re-enqueued. The operator notice made it worse by promising
 * the opposite: that the row stays marked and the next sweep will pick the work up.
 *
 * So the verdict is computed BEFORE the fence is invoked and travels INTO it, as the caller-side
 * prerequisite the fence already knows how to withhold a release on (`prerequisite-unmet`).
 *
 *   • ENQUEUED, no caller prerequisite — `undefined`, so every connector post path keeps the
 *     single-pass fence exactly as o3d-0bfh r15 left it. Nothing about the hot path changes.
 *   • ENQUEUED, with a caller prerequisite — the caller's own closure, unchanged.
 *   • REFUSED — a closure that answers `false` without asking the caller's. The caller's
 *     prerequisite ANNOUNCES a terminal loss, and announcing one on a pass that queued nothing is
 *     the same mistake `dischargeDeferredReceiptObligation` avoids when its re-read answers
 *     `retained`: the announcement is what licenses the settlement, so it must not be spent on a
 *     pass that is not going to settle.
 *
 * The refusal is not folded into the receipt answer, for the reason `combineFollowUpEnqueueOutcomes`
 * gives: they are different states with different operator remedies. This composes them only where
 * the question is the single one the fence asks — "may this generation be cleared?" — and the answer
 * is no while any part of the work is still owed.
 */
export function obligationReleasePrerequisite(
  enqueue: FollowUpEnqueueOutcome,
  callerPrerequisite?: () => Promise<boolean>,
): (() => Promise<boolean>) | undefined {
  if (enqueue.enqueued) return callerPrerequisite
  return async () => false
}
