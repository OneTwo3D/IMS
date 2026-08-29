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
  | 'payment_account_unmapped'
  /**
   * o3d-batch-ret ROUND 8 (Codex HIGH), WIDENED IN ROUND 10: A FIELD THE PAYMENT DECISION IS BUILT
   * FROM IS PRESENT AND CANNOT BE READ.
   *
   * Round 8 named it `payment_amount_unreadable`, because the amount was the only field that had
   * been given the treatment. Round 10 classified the whole boundary — the `_registerPayment` flag,
   * the amount (`_paymentAmount`/`lines`/`shippingAmount`/`discountAmount`), and the
   * `_paymentMethod`, `currency` and `_paymentDate` the enqueue writes onto the row — and every one
   * of them can now be present holding something nothing can read. They share this code because they
   * share a REMEDY, which is what a reason code is for: there is nothing to configure, retrying
   * reads the same bytes, and the payload itself has to be rebuilt. Which field it was is in the
   * refusal's `detail` and in {@link UnreadablePaymentFact}, not in a fan of near-identical codes.
   *
   * IT IS A SECOND, DIFFERENT PRE-ENQUEUE REFUSAL AND NOT A CASE OF THE FIRST. The one above is a
   * SETTING an operator can correct, and correcting it makes the next pass queue the payment. This
   * one is a corrupt payload at rest, and folding it into `payment_account_unmapped` would send an
   * operator to a bank-account screen that has nothing to do with it.
   *
   * BEFORE THIS EXISTED IT WAS REPORTED AS SUCCESS, one level below where round 6 found the same
   * class: `requestedInvoicePaymentAmount` answered `number | undefined`, and both connectors read
   * the undefined and the derived zero the same way — FOLLOW_UPS_ENQUEUED. See
   * {@link RequestedInvoicePayment}.
   */
  | 'payment_payload_unreadable'

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
export function refusedFollowUpEnqueue(...refusals: FollowUpEnqueueRefusal[]): RefusedFollowUpEnqueue {
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
 * WHAT A POSTED INVOICE'S PAYLOAD IS ASKING TO SETTLE — AND "UNKNOWN" IS NOT ONE OF THE ANSWERS
 * "NOTHING" IS (o3d-batch-ret r8, Codex HIGH). RESOLVED BEFORE ANY CONFIGURATION IS CONSULTED, AND
 * ON BOTH CONNECTORS.
 *
 * ROUND 7 MOVED THE DEFECT ONE LEVEL DOWN INSTEAD OF REMOVING IT. Round 6's defect was a `let`
 * seeded with a value that MEANS SUCCESS, inherited by every branch that failed to overwrite it.
 * Round 7 replaced it with a resolver — and the resolver returned `number | undefined`, where
 * `undefined` meant "this declaration cannot be read" and a derived `0` meant "nothing is owed".
 * Both connectors then wrote `if (amount === undefined || !(amount > 0)) return FOLLOW_UPS_ENQUEUED`,
 * so the two collapsed back into the one value that discharges money work. A `_paymentAmount` of
 * `"abc"`, a `lines` key that is absent, a `lines` that is an object, a line with no `quantity` —
 * every one of them settled a row whose payment was requested and never queued, on a connector
 * (QuickBooks) where the marker is the ONLY record that the money is owed.
 *
 * FOUR DIFFERENT FACTS, AND EXACTLY ONE OF THEM MEANS NO PAYMENT IS OWED. A missing `lines`, a
 * non-array `lines`, a malformed amount and an explicit zero are not the same state, and the
 * fail-safe direction is not the same for them either: the explicit zero must SETTLE (round 7's
 * fix — a paid £0 WooCommerce order asks for a payment worth nothing and must not be refused for a
 * bank account it will never use), and the other three must REFUSE.
 *
 * SO THE ANSWER IS A UNION AND THE NUMBER LIVES ON ONE ARM OF IT. `none` is reserved for a finite
 * non-positive DECLARED amount, or for a derivation that actually succeeded over a validated
 * `lines` array; `invalid` carries the operator-facing reason it could not be read; and `amount`
 * is the only arm that carries a number, so there is no value a caller can read without
 * discriminating first. The `undefined`-means-two-things read is not a mistake a caller can still
 * make — it is a type error.
 *
 * A NUMERIC STRING IS READABLE, EVERYWHERE AN AMOUNT IS READ. `_paymentAmount` already accepted
 * one, and line quantities are typed `DecimalInput` upstream (`Prisma.Decimal | string | number`),
 * whose JSON form is a STRING. Rejecting those would turn ordinary persisted payloads into
 * refusals, which is the opposite failure and a louder one.
 */
type RequestedInvoicePayment =
  /** The payload says, readably, that no payment is owed. This is the ONLY arm that may settle. */
  | { readonly kind: 'none' }
  /** A finite, positive amount to register. */
  | { readonly kind: 'amount'; readonly amount: number }
  /** The payload asked for a payment and cannot say how much. NOT a zero, and not a mapping problem. */
  | { readonly kind: 'invalid'; readonly detail: string }

/** The refused arm alone — see {@link decideRequestedInvoicePayment} for why it is named. */
export type RefusedFollowUpEnqueue = Extract<FollowUpEnqueueOutcome, { enqueued: false }>

/**
 * A finite amount read from a number or a numeric string; `null` when the value is not one.
 *
 * `''` is `null` rather than `0`: `Number('')` is 0, so an empty string would otherwise DECLARE a
 * zero — the single value that settles — out of a field that says nothing.
 */
function finiteAmount(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return null
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/** What an unreadable value IS, for the operator sentence — bounded, so a payload cannot flood a log. */
function describeUnreadable(value: unknown): string {
  if (value === undefined) return 'absent'
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  if (typeof value === 'object') return 'an object'
  if (typeof value === 'string') return `the string ${JSON.stringify(value.slice(0, 40))}`
  if (typeof value === 'number') return String(value)
  return `a ${typeof value}`
}

/**
 * o3d-batch-ret ROUND 9 (Codex HIGH) — ABSENCE AND A PRESENT VALUE ARE DIFFERENT FACTS, AND ONLY
 * ABSENCE MAY CHOOSE A DEFAULT.
 *
 * `payload.field === undefined` cannot tell "this payload does not use this mechanism" from "the key
 * is there and something wrote nothing into it". The first is a legitimate instruction to take the
 * other path — derive the amount, or treat the adjustment as a real zero. The second is a value at
 * rest that CANNOT BE READ, which is the exact state `invalid` was built for one round earlier, and
 * reading it as the first is how a persisted null becomes "nothing owed".
 *
 * `Object.hasOwn` is the only thing that separates them, so every optional monetary field asks it
 * before it looks at what it holds. A key that is present holds SOMETHING — including `null`, and
 * including an explicit `undefined` — and that something must pass {@link finiteAmount} or the
 * payload is refused.
 *
 * `lines` needs no presence test of its own: absent and present-but-unreadable already take the SAME
 * arm there (`!Array.isArray(...)` refuses both), so there is no default for absence to select, and
 * neither can a line's `quantity` or `unitAmount` — an absent one is already `invalid`. The three
 * fields below are the only ones that had a default for absence to select.
 */
function declaresField(payload: Record<string, unknown>, field: string): boolean {
  return Object.hasOwn(payload, field)
}

/**
 * The description of a value the payload DOES state. It differs from {@link describeUnreadable} in
 * exactly one place, and that place is the finding: a present key holding `undefined` must not be
 * reported to an operator as "absent", because absent is the one thing it is not.
 */
function describePresent(value: unknown): string {
  return value === undefined ? 'present and holds `undefined`' : describeUnreadable(value)
}

const NOTHING_OWED: RequestedInvoicePayment = { kind: 'none' }

/** A positive amount is owed; a finite non-positive one is the readable "nothing is owed". */
function readableAmount(amount: number): RequestedInvoicePayment {
  return amount > 0 ? { kind: 'amount', amount } : NOTHING_OWED
}

function unreadableAmount(detail: string): RequestedInvoicePayment {
  return { kind: 'invalid', detail }
}

/** A readable adjustment, or the operator clause saying why it could not be read. */
type OptionalAdjustment = { readonly amount: number } | { readonly detail: string }

/**
 * `shippingAmount` and `discountAmount`: ABSENT IS A REAL ZERO, PRESENT-AND-UNREADABLE IS NOT.
 *
 * An invoice with no shipping leg carries no `shippingAmount` at all, so absence has to mean zero or
 * ordinary payloads would be refused. A key that is THERE holding a null, an object, or `"abc"` is a
 * different fact — something wrote into it and what it wrote cannot be read — and folding that into
 * the zero silently changes the amount the customer is recorded as having paid, in whichever
 * direction the missing figure would have moved it.
 */
function optionalAdjustment(payload: Record<string, unknown>, field: string): OptionalAdjustment {
  if (!declaresField(payload, field)) return { amount: 0 }
  const value = payload[field]
  const amount = finiteAmount(value)
  return amount === null
    ? { detail: `\`${field}\` is ${describePresent(value)}, which is not a finite number` }
    : { amount }
}

/**
 * THE RESOLUTION ITSELF, SHARED SO THE TWO CONNECTORS CANNOT DISAGREE ABOUT IT — they acquired the
 * round-6 defect independently, in duplicated code, which is the whole argument for it living here.
 *
 * A DECLARED `_paymentAmount` IS FINAL. It is what the payload SAID to settle: if it cannot be read
 * the answer is `invalid`, never a quiet fall-through to a figure derived from something else. The
 * derivation is the fallback for a payload that declares nothing, and it is the round-7 note that
 * matters here — the shipped code declared `amount` as `number | undefined` and tested `== null`
 * before converting, so a numeric STRING was never converted and reached the enqueue as a string.
 *
 * `lines` MUST BE AN ARRAY OF READABLE LINES. Round 7 replaced an unguarded cast with
 * `Array.isArray(payload.lines) ? ... : []`, which stopped a TypeError from failing an already-posted
 * invoice — and put "there are no lines" and "the lines cannot be read" both at zero, i.e. at
 * settled. The guard stays; its answer changes.
 *
 * IT IS MODULE-PRIVATE, AND THAT IS WHAT MAKES THE FOLD MANDATORY (round 9, Codex MEDIUM). The
 * argument for {@link decideRequestedInvoicePayment} is that a union alone leaves the conflation
 * available to a caller who wants it, and the fold takes the branch once so nobody can write
 * `if (r.kind !== 'amount') return FOLLOW_UPS_ENQUEUED` again. That argument only holds while the
 * fold is the ONLY DOOR: while this function and its result type were exported, a new connector
 * could import them and write that exact line, and the module API would not have stopped it. So
 * neither this nor {@link RequestedInvoicePayment} leaves the module — the export list IS the
 * invariant, not the comment above it. Tests reach the resolver the way production does, by driving
 * a connector through the fold, and `followup-enqueue-resolver-door.test.ts` fails if the export
 * comes back.
 */
function requestedInvoicePayment(payload: Record<string, unknown>): RequestedInvoicePayment {
  if (declaresField(payload, '_paymentAmount')) {
    const declared = payload._paymentAmount
    const amount = finiteAmount(declared)
    return amount === null
      ? unreadableAmount(`\`_paymentAmount\` is ${describePresent(declared)}, which is not a finite amount`)
      : readableAmount(amount)
  }

  const lines = payload.lines
  if (!Array.isArray(lines)) {
    return unreadableAmount(
      `the payload declares no \`_paymentAmount\` and its \`lines\` is ${describeUnreadable(lines)} rather than an `
      + 'array, so there is nothing to derive the amount from',
    )
  }
  let derived = 0
  for (const [index, line] of lines.entries()) {
    if (typeof line !== 'object' || line === null || Array.isArray(line)) {
      return unreadableAmount(`\`lines[${index}]\` is ${describeUnreadable(line)} rather than a line`)
    }
    const { quantity, unitAmount } = line as { quantity?: unknown; unitAmount?: unknown }
    const readableQuantity = finiteAmount(quantity)
    if (readableQuantity === null) {
      return unreadableAmount(`\`lines[${index}].quantity\` is ${describeUnreadable(quantity)}, which is not a finite number`)
    }
    const readableUnitAmount = finiteAmount(unitAmount)
    if (readableUnitAmount === null) {
      return unreadableAmount(`\`lines[${index}].unitAmount\` is ${describeUnreadable(unitAmount)}, which is not a finite number`)
    }
    derived += readableQuantity * readableUnitAmount
  }

  // See `optionalAdjustment`: only an ABSENT key selects the zero. Until round 9 both of these read
  // `=== null || === undefined ? 0`, so a persisted null was spent as a zero and the amount the
  // customer is recorded as having paid quietly changed by whatever the null was hiding.
  const shipping = optionalAdjustment(payload, 'shippingAmount')
  if ('detail' in shipping) return unreadableAmount(shipping.detail)
  const discount = optionalAdjustment(payload, 'discountAmount')
  if ('detail' in discount) return unreadableAmount(discount.detail)

  const total = derived + shipping.amount - discount.amount
  // Every part is finite and the sum still need not be. A total that overflowed is not a figure to
  // settle a customer's invoice against, and it is certainly not a zero.
  return Number.isFinite(total)
    ? readableAmount(total)
    : unreadableAmount('the amount derived from the payload lines is not a finite number')
}

/**
 * ONE FIELD'S ANSWER: the value it states, or the operator clause saying why it could not be read
 * (o3d-batch-ret r10, Codex HIGH).
 *
 * It is the shape {@link OptionalAdjustment} already had, generalised, and it is deliberately NOT a
 * `T | null`: a `null`/`undefined` answer is exactly the conflation five rounds have been chasing —
 * the caller has to discriminate before it can read a value, and the arm it must handle carries the
 * sentence an operator will read rather than a bare absence.
 */
type PayloadField<T> = { readonly value: T } | { readonly detail: string }

/** The one wording for "this key is there and what it holds cannot be read". */
function unreadableField(field: string, value: unknown, expectation: string): { readonly detail: string } {
  return { detail: `\`${field}\` is ${describePresent(value)}, ${expectation}` }
}

/**
 * WHAT AN ABSENT KEY MEANS, PER FIELD — AND WHETHER THAT ANSWER WAS DERIVED OR INHERITED
 * (o3d-batch-ret r11, Codex HIGH).
 *
 * Round 10 centralised four reads and, with them, four absent-key defaults. Three of those defaults
 * were CARRIED OVER from the inline expressions rather than argued for, and round 11 is the bill for
 * one of them. So the table is written down, with the distinction that matters stated per field: a
 * default is ESTABLISHED when something outside this module makes it true, and INHERITED when its
 * only warrant is that the code used to do it.
 *
 *   `_registerPayment` absent → `false`.        ESTABLISHED. The ordinary sales path composes
 *     payloads without the key at all, so absence must mean "no payment requested" or every invoice
 *     IMS raises itself would be refused. The alternative is not merely unwarranted, it is
 *     contradicted by the writers.
 *
 *   `_paymentMethod` absent → `''`.             ESTABLISHED, and re-argued rather than assumed. The
 *     WooCommerce importer writes `wcOrder.payment_method || undefined`, which JSON drops, while
 *     `_registerPayment` can still be true — an order marked paid with no gateway string — so
 *     absence is a REAL state meaning "no method was recorded". And `''` cannot mis-settle the way
 *     `'GBP'` could: it is a sentinel no real method has, `lookupPaymentAccount`'s only wildcard is
 *     on the CURRENCY half (`method:*`), so an empty method matches no mapping written for a real
 *     one. It fails closed into the ordinary mapping refusal, which names the empty method out loud.
 *
 *   `currency` absent → NO DEFAULT AT ALL; it REFUSES (r12). Round 11 replaced the `'GBP'` literal
 *     with the IMS base currency and called that ESTABLISHED, on the warrant that the connect-time
 *     guards refuse a ledger whose base currency is not `getBaseCurrencyCode()`. That warrant is
 *     true only of the path where the remote base was READ. When it cannot be read the guard has
 *     nothing to compare, does not fire, and the binding is stored anyway — so a USD ledger can be
 *     bound to a EUR installation and the equality the default rests on was never established for
 *     it. The default is therefore withdrawn rather than re-argued: see
 *     {@link payloadPaymentCurrency}. o3d-emus restores it by persisting the verified remote base.
 *
 *   `_paymentDate` absent → TODAY.              INHERITED. Nothing derives it; its whole warrant is
 *     that both connectors have always done it, and unlike `''` it is a guess at a value that really
 *     exists (the day the money moved) — the `field` refusal clause says so itself, "a date read as
 *     today dates the receipt wrongly in the ledger". What keeps it from being a live defect is that
 *     the only writer of these keys cannot produce it: `_registerPayment` is
 *     `!!wcOrder.date_paid_gmt && …` while `_paymentDate` is `wcOrder.date_paid_gmt || undefined`,
 *     so a payload that ASKS for a payment always carries the date. It is reachable only from a
 *     payload written by some future producer, and it is filed rather than changed here — refusing
 *     it would refuse historical rows for a state no current writer emits, which is a larger change
 *     than this finding, and it must not be made on the way past. o3d-pi9n.
 */

/**
 * `_registerPayment` — THE FLAG CODEX NAMED, AND THE ONLY THREE ANSWERS IT HAS.
 *
 * ABSENT means this payload does not use the mechanism: the ordinary sales path composes payloads
 * without the key at all, so absence must mean "no payment requested" or every invoice IMS raises
 * itself would be refused. A LITERAL `false` is the same statement made explicitly — the WooCommerce
 * importer writes `!!wcOrder.date_paid_gmt && documentTotalsToTheOrder`, so an unpaid order really
 * does persist `false`.
 *
 * EVERY OTHER PRESENT VALUE IS UNREADABLE, IN BOTH DIRECTIONS. `null`, `0`, `''` and an explicit
 * `undefined` are values something WROTE, and the truthiness test spent all four as "nobody asked" —
 * which on QuickBooks (`consumer: 'none'`) clears the only evidence the money is owed. `'false'`,
 * `'0'`, `1` and `{}` are the mirror: they are not a request either, and truthiness let them enter
 * payment registration and queue a receipt against an invoice on the strength of a corrupt byte.
 * Neither direction is safe to guess, so both refuse.
 */
function payloadPaymentRequested(payload: Record<string, unknown>): PayloadField<boolean> {
  if (!declaresField(payload, '_registerPayment')) return { value: false }
  const value = payload._registerPayment
  if (value === true || value === false) return { value }
  return unreadableField('_registerPayment', value, 'which is neither `true` nor `false`')
}

/**
 * `_registerPayment`, ASKED BY THE READERS WHOSE FAIL-SAFE DIRECTION IS THE OPPOSITE ONE.
 *
 * `followUpObligationsOwedBy` records what a row owed while its payload still exists to be read, and
 * that record is allowed to be BROADER than the enqueue's gate but never narrower: an obligation
 * recorded that the enqueue would have skipped costs a line of noise, one it failed to record lets a
 * genuinely lost payment be classified as nothing at all. So an unreadable flag answers TRUE there,
 * where the connectors refuse — the same classification, read for the safe direction of a different
 * question, instead of a second truthiness test written out beside the first.
 */
export function payloadMayOweInvoicePayment(payload: Record<string, unknown>): boolean {
  const requested = payloadPaymentRequested(payload)
  return 'detail' in requested || requested.value
}

/**
 * `_paymentMethod` — ABSENT IS A REAL STATE AND IT IS NOT AN ERROR.
 *
 * The importer writes `wcOrder.payment_method || undefined`, which JSON drops, so an order Woo
 * recorded no method for persists no key. That must not refuse: it resolves to `''`, the mapping is
 * asked about `":GBP"`, and the answer is the ORDINARY mapping refusal naming an empty method —
 * which is a true sentence an operator can act on. A present non-string is different: `as string`
 * made a number or an object into a mapping-lookup key with no cast at runtime at all.
 */
function payloadPaymentMethod(payload: Record<string, unknown>): PayloadField<string> {
  if (!declaresField(payload, '_paymentMethod')) return { value: '' }
  const value = payload._paymentMethod
  return typeof value === 'string'
    ? { value }
    : unreadableField('_paymentMethod', value, 'which is not a payment-method string')
}

/**
 * WHY AN ABSENT `currency` HAS NO DEFAULT LEFT TO TAKE (o3d-batch-ret r12, Codex HIGH).
 *
 * Every other absent-key answer in this file is a fact about IMS — what its own writers emit, what
 * its own mapping table does with `''`. This one was a fact about A REMOTE LEDGER, and that is the
 * difference round 11 did not price in.
 *
 * The clause it read is `if (organisation.baseCurrency && organisation.baseCurrency !== imsBase)`,
 * in both `connectXero` and `connectQuickBooks`. It is a TRUTHY-only comparison, and both readers
 * answer `null` for a base currency they could not obtain — a non-OK response, a body with no
 * organisation in it, a `BaseCurrency`/`HomeCurrency` that is not a currency string. On that path
 * the guard has nothing to compare, so it does not fire, and the binding is stored regardless. A
 * transient failure at the moment an operator clicks Connect is enough to bind a USD ledger to a
 * EUR installation.
 *
 * So `getBaseCurrencyCode()` is NOT a stand-in for what the ledger denominates in. It is the same
 * value on every binding whose guard actually ran, and nothing on this side of the wire can tell
 * those bindings apart from the ones whose guard was handed a null — the verified remote base is
 * not persisted anywhere (o3d-emus).
 */
const LEDGER_BASE_UNVERIFIED =
  'the payload names no currency, so the document was denominated by the ledger in ITS OWN base '
  + 'currency — and what that is was never verified for this connection: both connect-time guards '
  + 'compare the remote base currency only when they could READ it, and neither records the value '
  + 'they compared, so nothing here establishes that the ledger posts in the IMS base currency'

/**
 * `currency` — THE FIELD WHERE THE OLD DEFAULT MOVED MONEY TO THE WRONG PLACE, THREE TIMES.
 *
 * `payload.currency as string || 'GBP'` answered `GBP` for an absent key, for a present `null`, and
 * for a present `''` alike. The last two are a currency something wrote nothing into, and
 * `lookupPaymentAccount(map, method, currency)` keys the BANK ACCOUNT on it — so a EUR invoice
 * whose currency did not survive persistence was settled into the sterling account, and the amount
 * was written onto the INVOICE_PAYMENT row as sterling too. Round 10 closed those two.
 *
 * ROUND 11 TOOK THE THIRD — the ABSENT arm's `GBP` LITERAL, which on a EUR-base installation
 * stamped a payment in a currency the document was not in — and replaced it with the IMS base
 * currency, on the warrant that the connect-time guards refuse a ledger whose base currency is not
 * `getBaseCurrencyCode()`. ROUND 12 IS THE BILL FOR THAT WARRANT: it is true of the path where the
 * remote base was read and silent on the path where it could not be (see
 * {@link LEDGER_BASE_UNVERIFIED}), so the equality was asserted, not established.
 *
 * THE ANSWER IS TO STOP DEFAULTING, NOT TO PICK A BETTER DEFAULT. There is no value available here
 * that is known to be the one the document posted in, and a payment stamped in a currency nobody
 * verified selects the bank account by that currency — the identical failure the previous two
 * rounds closed, arriving through the binding instead of through the payload. So an absent
 * `currency` on a payload that asks for a payment REFUSES, under the `base-currency` fact, exactly
 * as an unresolvable base currency already did.
 *
 * IT COSTS NOTHING TODAY, WHICH IS WHY IT CAN BE DONE HERE. The only writer of `_registerPayment`
 * is the WooCommerce order importer, and it writes `currency` unconditionally
 * (`wcOrder.currency || 'GBP'`, always a non-empty string) on the same payload literal — so no
 * current producer can emit the combination this refuses. o3d-emus restores the default properly,
 * by persisting the remote base currency the guard verified and comparing against THAT.
 *
 * A PRESENT value must still NAME a currency, and it settles: the refusal is on the absent arm
 * only, so every payload that states its own currency is untouched by this round.
 */
function payloadPaymentCurrency(payload: Record<string, unknown>): PayloadField<string> {
  if (!declaresField(payload, 'currency')) return { detail: LEDGER_BASE_UNVERIFIED }
  const value = payload.currency
  return typeof value === 'string' && value.trim() !== ''
    ? { value }
    : unreadableField('currency', value, 'which is not a currency code')
}

/** `YYYY-MM-DD`, which is the form both ledgers are given and the form `slice(0, 10)` assumed. */
const LEDGER_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * `_paymentDate` — WHERE THE UNREADABLE VALUE DID NOT DEFAULT, IT THREW.
 *
 * `(payload._paymentDate as string)?.slice(0, 10) || <today>` has three behaviours and only one of
 * them was intended: absent (and present `null`) took today's date, a present NUMBER or object
 * raised `TypeError: .slice is not a function` out of an invoice that had ALREADY POSTED — failing
 * the entry after the ledger write — and a present string was sliced with no validation at all, so
 * `"20/08/2026"` was handed to the ledger as the day `"20/08/2026"`.
 *
 * Absence keeps the default: a payment whose date was not recorded is registered today, which is
 * what both connectors have always done. A present value must be a string whose first ten characters
 * are a real calendar day — `2026-13-45` parses to `NaN` and is refused rather than sent.
 */
function payloadPaymentDate(payload: Record<string, unknown>): PayloadField<string> {
  const today = new Date().toISOString().slice(0, 10)
  if (!declaresField(payload, '_paymentDate')) return { value: today }
  const value = payload._paymentDate
  if (typeof value !== 'string') {
    return unreadableField('_paymentDate', value, 'which is not a date string')
  }
  const day = value.slice(0, 10)
  if (!LEDGER_DATE.test(day) || Number.isNaN(Date.parse(day))) {
    return unreadableField('_paymentDate', value, 'whose first ten characters are not a YYYY-MM-DD date')
  }
  return { value: day }
}

/**
 * EVERYTHING THE ENQUEUE PUTS ON THE INVOICE_PAYMENT ROW, once every field it came from was READ.
 *
 * The connectors receive this and nothing else: there is no raw payload value left in their hands to
 * apply an `as string || <default>` to, which is the structural half of the round-10 fix.
 */
export type InvoicePaymentToRegister = {
  /** Finite and positive — {@link requestedInvoicePayment} owns the rest of that decision. */
  readonly amount: number
  readonly method: string
  readonly currency: string
  /** `YYYY-MM-DD`. */
  readonly paymentDate: string
}

/**
 * WHAT A REFUSAL LOG CAN STILL SAY ABOUT THE ROW when the payload is the thing that is broken.
 *
 * `null` where the field itself is the unreadable one. It exists for the activity-log metadata and
 * carries NO decision: a caller cannot reach a settlement through it, which is why it is safe to
 * export where {@link InvoicePaymentRequest} is not.
 */
export type PaymentRefusalContext = {
  readonly method: string | null
  readonly currency: string | null
}

/**
 * WHICH OF THE FOUR THINGS THIS PATH COULD NOT ESTABLISH (o3d-batch-ret r10/r11, Codex HIGH).
 *
 * They share one reason code because they share one remedy, and they DO NOT share one sentence.
 * Round 8's message opens "the invoice asked for a payment to be registered and the persisted
 * payload cannot say how much", and the round-7/r8 lesson is precisely that a clause true of one
 * call site becomes a lie at the next: on a `request` refusal we do not know that the invoice asked
 * for anything — that is the very fact that could not be read — and on a `field` refusal the amount
 * read perfectly well. `unreadablePaymentPayloadRefusalMessage` composes the opening clause and the
 * "X IS NOT Y" claim from this, and the registry test walks all three forms.
 */
export type UnreadablePaymentFact =
  /** `_registerPayment` is present and is neither `true` nor `false`. */
  | 'request'
  /** A payment was asked for and how much cannot be read. */
  | 'amount'
  /** A payment of a known amount was asked for and a field the registration is built from cannot be read. */
  | 'field'
  /**
   * The payload names NO currency — which is legitimate and the ordinary case — and the currency it
   * would therefore be settled in, the LEDGER's own base currency, is not established for this
   * connection (o3d-batch-ret r11, widened in r12). Nothing about the payload is wrong here, which
   * is why it is not `field`: no rebuild of it can help, and the operator must not be sent to look.
   */
  | 'base-currency'

/** A payment the payload asked for, or may have asked for, and could not describe. */
export type UnreadablePaymentPayload = {
  readonly fact: UnreadablePaymentFact
  /** Which field could not be read, and what it holds, as a clause. */
  readonly detail: string
  /** Whatever else about the row the log can still name truthfully. */
  readonly known: PaymentRefusalContext
}

/** The whole payload boundary's answer for this path. */
type InvoicePaymentRequest =
  /** Readably, no payment is owed. The ONLY arm that may settle. */
  | { readonly kind: 'none' }
  /** Every field read, and a payment to queue. */
  | { readonly kind: 'requested'; readonly payment: InvoicePaymentToRegister }
  /** Some field is present and cannot be read. NOT a zero, and not a mapping problem. */
  | { readonly kind: 'invalid'; readonly unreadable: UnreadablePaymentPayload }

/**
 * THE WHOLE BOUNDARY, IN ORDER — AND THE ORDER IS ITSELF A DECISION (o3d-batch-ret r10, Codex HIGH).
 *
 * 1. THE FLAG FIRST, UNCONDITIONALLY. An unreadable `_registerPayment` refuses even over a payload
 *    whose amount reads as zero: we do not know whether a payment was asked for, and "settle because
 *    the money question happens to answer nothing" would be guessing the very thing that is corrupt.
 * 2. THE AMOUNT NEXT — round 7's ordering, which the mapping arms depend on. A readable non-positive
 *    amount SETTLES here, before `_paymentMethod`, `currency` or `_paymentDate` are judged at all:
 *    an invoice that owes nothing queues no row, so no field that only a queued row uses can refuse
 *    it. A paid £0 WooCommerce order must not be refused over a currency it will never spend.
 * 3. THEN THE THREE FIELDS THE ENQUEUE ACTUALLY WRITES.
 *
 * `method` and `currency` are classified up front regardless, because {@link PaymentRefusalContext}
 * is what the refusal's activity-log metadata is built from and a refusal about the AMOUNT should
 * still say which method and currency the row named.
 */
function invoicePaymentRequest(payload: Record<string, unknown>): InvoicePaymentRequest {
  const method = payloadPaymentMethod(payload)
  const currency = payloadPaymentCurrency(payload)
  const known: PaymentRefusalContext = {
    method: 'value' in method ? method.value : null,
    currency: 'value' in currency ? currency.value : null,
  }

  const unreadable = (fact: UnreadablePaymentFact, detail: string): InvoicePaymentRequest =>
    ({ kind: 'invalid', unreadable: { fact, detail, known } })

  const requested = payloadPaymentRequested(payload)
  if ('detail' in requested) return unreadable('request', requested.detail)
  if (!requested.value) return { kind: 'none' }

  const amount = requestedInvoicePayment(payload)
  if (amount.kind === 'invalid') return unreadable('amount', amount.detail)
  if (amount.kind === 'none') return { kind: 'none' }

  if ('detail' in method) return unreadable('field', method.detail)
  // WHICH refusal this is depends on WHOSE value could not be read, and `declaresField` is the same
  // discriminator `payloadPaymentCurrency` used to pick the arm (o3d-batch-ret r11). A present
  // unreadable `currency` is a corrupt PAYLOAD FIELD; an absent one is not a payload fault at all —
  // it is the unverified ledger base of r12 — and telling an operator to look at a field the payload
  // legitimately omits is the r7/r8 defect: a clause true of one call site read at one where it is
  // false.
  if ('detail' in currency) {
    return unreadable(declaresField(payload, 'currency') ? 'field' : 'base-currency', currency.detail)
  }
  const paymentDate = payloadPaymentDate(payload)
  if ('detail' in paymentDate) return unreadable('field', paymentDate.detail)

  return {
    kind: 'requested',
    payment: { amount: amount.amount, method: method.value, currency: currency.value, paymentDate: paymentDate.value },
  }
}

/**
 * WHY NOTHING IS RESOLVED HERE ANY MORE (o3d-batch-ret r12, Codex HIGH).
 *
 * Round 11 put a `resolveBasePaymentCurrency()` in this position — one `getBaseCurrencyCode()` read
 * per fold, injected into the classifier — so that the two connectors could not disagree about the
 * currency an absent `currency` settles in. The shape was right and the VALUE was wrong: the IMS
 * base currency is not what the ledger denominated the document in, it is only equal to it on the
 * bindings whose connect-time guard could read the remote base (see {@link LEDGER_BASE_UNVERIFIED}).
 *
 * With the absent arm refusing, there is no value left for this decision to resolve, and the read is
 * gone rather than kept for a message. That is deliberate: a base currency resolved and then never
 * spent is exactly the sort of vestige a later round mistakes for an established fact. When o3d-emus
 * persists the remote base the guard verified, the resolution comes back HERE, in the fold, reading
 * THAT — and the round-11 argument for the position survives its value.
 */

/**
 * o3d-batch-ret ROUND 10 (Codex HIGH) — THE FIELD THAT GATES THE WHOLE DECISION WAS STILL READ BY
 * TRUTHINESS, AND THAT IS THE FIFTH ROUND ON ONE AXIS.
 *
 * Rounds 6–9 each moved this conflation one frame outward: a default that meant success, then a
 * resolver that merged "unknown" with "nothing owed", then a present `null` read as an absent key —
 * and each fix was aimed at the field Codex had just named. The field that decides whether ANY of
 * that runs was never one of them. Both connectors opened with `if (!payload._registerPayment)
 * return FOLLOW_UPS_ENQUEUED`, so an absent flag, a literal `false`, a present `null`, a `0`, an
 * `''` and an explicit `undefined` were ONE answer — "nobody asked for a payment" — and a truthy
 * malformed value such as the string `'false'` went the other way and ENTERED payment registration.
 *
 * SO THIS ROUND CHANGES SHAPE INSTEAD OF FIXING A FIELD. Everything the two connectors read out of
 * the persisted payload on this path is classified HERE, by field, with absence and
 * present-but-unreadable answered separately for each — and the connectors read NOTHING out of the
 * payload themselves. `_registerPayment` is the flag, `_paymentAmount`/`lines`/`shippingAmount`/
 * `discountAmount` are the money (rounds 8–9, unchanged), and `_paymentMethod`, `currency` and
 * `_paymentDate` were the three fields still being read inline with `as string || <default>` —
 * where a present unreadable `currency` silently became `GBP` and settled the payment against the
 * wrong bank account, and a non-string `_paymentDate` threw a TypeError out of an already-posted
 * invoice. A field added later cannot get an ad-hoc truthiness test, because there is nowhere in
 * either connector left to write one.
 *
 * THE FOLD IS THE ONLY WAY EITHER CONNECTOR ASKS THE QUESTION — AND THAT IS WHY IT IS A FOLD RATHER
 * THAN A `switch` EACH OF THEM WRITES (o3d-batch-ret r8, Codex HIGH).
 *
 * A union alone leaves the conflation available to a caller who wants it: `if (r.kind !== 'amount')
 * return FOLLOW_UPS_ENQUEUED` type-checks perfectly and is exactly the round-7 defect written out
 * longhand. So the branch is taken HERE, once, and what the callers supply is what to DO with the
 * two arms that are theirs:
 *
 *   • `none` never reaches a caller at all. Settling is this function's answer, not a decision two
 *     connectors are trusted to repeat.
 *   • `onInvalid` must return {@link RefusedFollowUpEnqueue} — the `enqueued: false` arm — so a
 *     caller CANNOT return `FOLLOW_UPS_ENQUEUED` from it. An unreadable payload cannot reach the
 *     settle path, and that is a compile error rather than a convention, which is the same move
 *     that made a missing verdict a ts2366 two rounds ago.
 *   • `onAmount` gets a fully-read {@link InvoicePaymentToRegister} — a finite positive amount and
 *     the three fields the enqueue puts on the row — so a mapping may finally be asked about (the
 *     round-7 ordering) and there is no raw payload value left for the caller to default.
 *
 * The `switch` is exhaustive against a declared return type, so a fourth arm added to
 * `InvoicePaymentRequest` fails to build here (ts2366) instead of falling out as `undefined`.
 */
export async function decideRequestedInvoicePayment(
  payload: Record<string, unknown>,
  handle: {
    onAmount: (payment: InvoicePaymentToRegister) => Promise<FollowUpEnqueueOutcome>
    onInvalid: (unreadable: UnreadablePaymentPayload) => Promise<RefusedFollowUpEnqueue>
  },
): Promise<FollowUpEnqueueOutcome> {
  const requested = invoicePaymentRequest(payload)
  switch (requested.kind) {
    case 'none':
      return FOLLOW_UPS_ENQUEUED
    case 'requested':
      return await handle.onAmount(requested.payment)
    case 'invalid':
      return await handle.onInvalid(requested.unreadable)
  }
}

/**
 * WHAT AN OPERATOR IS TOLD WHEN THE PAYLOAD CANNOT SAY WHAT IS OWED (o3d-batch-ret r8, Codex HIGH),
 * IN THE THREE FORMS THE BOUNDARY ACTUALLY PRODUCES (r10).
 *
 * Round 8 wrote ONE sentence because the amount was the only field classified. Round 10 classified
 * the flag and the three registration fields as well, and the opening clause it inherited —
 * "the invoice asked for a payment to be registered" — is FALSE of a `_registerPayment` refusal,
 * where whether the invoice asked is the fact that could not be read. That is the r7 finding again
 * (a clause true of one call site passed to one where it is false), so the clause is selected from
 * {@link UnreadablePaymentFact} rather than written once and reused. The rest of the message is
 * true of all three and stays shared.
 *
 * A payload the code cannot read is a REAL STATE an operator needs to see. It is not a mapping
 * problem — there is no setting to correct — and it is not "nothing was owed", so neither of the
 * two sentences this module already writes is true of it.
 *
 * IT PROMISES NO RECOVERY OF ITS OWN, for the reason `paymentAccountRefusalMessage` gives: what
 * re-reads a retained marker is a declared fact about the connector, so `recovery` comes in from
 * `followUpObligationRecoveryNote(...)`. What is said here and not there is that the re-read cannot
 * FIX this one: the payload is at rest, so every further pass reads the same bytes and refuses
 * again until the payload itself is rebuilt.
 *
 * AND IT AUTHORISES NO HAND-MADE PAYMENT. The invoice has posted; the operator can be asked to READ
 * it and ESCALATE what they read, and nothing more — a receipt entered by hand would be a second
 * one that no request id can deduplicate (the o3d-0bfh r11 rule).
 */
const UNREADABLE_PAYMENT_CLAUSES: Record<UnreadablePaymentFact, { asked: string; claim: string }> = {
  /**
   * THE ONE THAT COULD NOT BORROW ROUND 8'S SENTENCE (o3d-batch-ret r10). Every other refusal on
   * this path opens "the invoice asked for a payment to be registered" — and here that is the fact
   * that could not be read. Saying it anyway would assert the thing the row is refusing over.
   */
  request: {
    asked: 'the persisted payload does not say whether a payment was asked for at all',
    claim: 'AN UNREADABLE REQUEST IS NOT A "NO": this row does not say no payment was owed, it says whether one is '
      + 'owed cannot be read from it — and it is equally not a YES, so registering one on the strength of it would '
      + 'be a receipt against an invoice nothing asked to settle',
  },
  amount: {
    asked: 'the invoice asked for a payment to be registered and the persisted payload cannot say how much',
    claim: 'AN UNREADABLE AMOUNT IS NOT A ZERO: this row does not say no payment was owed, it says how much is owed '
      + 'cannot be read from it',
  },
  field: {
    asked: 'the invoice asked for a payment to be registered and a field the registration is built from cannot be read',
    claim: 'AN UNREADABLE FIELD IS NOT ITS DEFAULT: this row does not state the value that was assumed for it — a '
      + 'currency read as sterling settles the money into the wrong bank account, and a date read as today dates the '
      + 'receipt wrongly in the ledger',
  },
  /**
   * THE ONE WHERE THE PAYLOAD IS FINE AND THE CONNECTION IS NOT (o3d-batch-ret r11, rewritten r12).
   *
   * Omitting `currency` is the ordinary case, not a corruption: the document is then denominated by
   * the LEDGER, in the ledger's own base currency. So the sentence must NOT send an operator to look
   * at the payload — there is nothing wrong with it — and it must not promise a payload rebuild will
   * help, which is why this is a fact of its own rather than the `field` clause reused.
   *
   * ROUND 11 WROTE IT AS "could not be resolved", because the only way to reach it then was an IMS
   * organisation row that would not read. Round 12 found the larger one: the value can resolve
   * perfectly and still not be the ledger's, because the connect-time guards compare the remote base
   * currency only when they could read it and record nothing about what they compared. The sentence
   * therefore says UNVERIFIED rather than unresolvable, and names the remedy that fits it — an
   * operator who reconnects the ledger makes the guard run again with a readable answer, where
   * re-running the sync would only reach the same silence.
   */
  'base-currency': {
    asked: 'the invoice asked for a payment to be registered, its payload names no currency of its own — which is '
      + 'ordinary — and the currency the ledger therefore denominated that document in is not established for this '
      + 'connection',
    claim: 'AN UNVERIFIED LEDGER BASE CURRENCY IS NOT THE IMS ONE: this row does not say the payment is in the IMS '
      + 'base currency, it says the currency it would be settled in was never read back from the ledger — the '
      + 'connect-time check compares that currency only when it can be read, and stores the connection either way — '
      + 'and the bank account is keyed on that currency, so assuming one selects an account by a currency nobody '
      + 'verified and stamps it onto the payment. Reconnect the ledger to establish it',
  },
}

export function unreadablePaymentPayloadRefusalMessage(input: {
  /** Display name of the accounting package, for the operator: `Xero`, `QuickBooks`. */
  connector: string
  referenceType: string
  referenceId: string
  /** Which of the three things the payload failed to state. */
  fact: UnreadablePaymentFact
  /** Which field could not be read, and what it holds, as a clause. */
  detail: string
  /** The connector's declared recovery note — what re-reads the retained marker, if anything. */
  recovery: string
}): string {
  const { asked, claim } = UNREADABLE_PAYMENT_CLAUSES[input.fact]
  return `Refused to enqueue the ${input.connector} INVOICE_PAYMENT for ${input.referenceType} ${input.referenceId}: `
    + `${asked} — ${input.detail}. `
    + 'NOTHING WAS QUEUED, and the row is deliberately left marked as owing follow-ups so the money is not reported as '
    + `settled. ${claim}, `
    + 'and settling that the same way as a row that owes nothing is how a receipt that was really taken disappears. '
    + 'There is no setting to correct and no further attempt at this row can repair it — the payload is at rest, so every '
    + `pass reads the same bytes and refuses again. What re-reads the marker on this connector is a fact about the `
    + `connector rather than a promise made here: ${input.recovery}; that re-read changes nothing until the payload `
    + `itself is rebuilt. READ the invoice in ${input.connector}, record what is actually present against it, and `
    + 'ESCALATE that reading with this reference. A payment entered by hand in the meantime would be a SECOND one, '
    + 'racing whatever the corrected payload queues, and no request id can deduplicate it.'
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
