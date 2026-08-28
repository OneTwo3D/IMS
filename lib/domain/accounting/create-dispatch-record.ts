/**
 * A CREATE THAT LEFT, RECORDED BEFORE IT LEFT (o3d-jit6).
 *
 * THE DEFECT. `persistPostedXeroDocument` settles the sync row with the id Xero has just returned.
 * That transaction can fail AT COMMIT — a deadlock victim, a serialization failure, a connection
 * dropped while committing. The write rolls back, the row returns to PENDING with
 * `externalTransactionId` null, and `syncResult.externalId` — a real, freshly created document in a
 * live ledger — is discarded with it, because it existed only in the memory of a process that is now
 * handling an ordinary error. The ordinary retry then posts again.
 *
 * WHY NONE OF THE EXISTING MACHINERY REACHES IT. o3d-550x's conflict evidence covers the case where
 * the row will NEVER name this document because another worker's id already occupies it; it detects a
 * DISPLACEMENT. Here nothing is displaced — the row will eventually name a document, just not this one
 * — so there is no conflict to observe, and re-driving the record does not help either, because the
 * write is what failed. And every pre-post record this repository already has is scoped to somebody
 * else's problem: see {@link CREATE_REPLAY_POLICY} for which type is covered by what.
 *
 * THE ONLY EVIDENCE THAT SURVIVES A ROLLBACK IS EVIDENCE THAT COMMITTED FIRST. So the record is
 * written, and COMMITTED, before the request leaves. That is the rule o3d-k26m.5 stated for
 * `attemptedInvoiceNumber` and it is the same rule for the same reason: a create whose local record
 * cannot be written is a create whose OUTCOME cannot be recorded either, which is precisely the
 * lost-response state — so a failure to write it REFUSES the post rather than proceeding.
 *
 * BUT "BEFORE THE REQUEST" IS NOT "AS EARLY AS POSSIBLE" (Codex r1 finding 2, HIGH). The first cut
 * minted the record in its own statement and THEN asked the claim fence whether this worker still
 * owned the row. A fence that reports an expired lease or a lost claim returns with nothing sent —
 * and, in that version, with the record permanently written. A later, legitimate attempt then read a
 * dispatch that never happened and refused a create that had never been made: the prohibition fired
 * on a post nobody made, which is the same class of error as the duplicate it exists to prevent, in
 * the opposite direction.
 *
 * SO THE WORK IS SPLIT IN TWO, AND THE SPLIT IS ALONG "READ" / "WRITE":
 *
 *   {@link planCreateDispatch}   a READ. What does this row already record, and may this create go
 *                                out at all? Refuses here, before any gate has been passed, and
 *                                writes nothing whatever the answer is.
 *   the MINT                     the `data` fragment the plan hands back, written by the CLAIM FENCE
 *                                ITSELF — merged into the very `updateMany` that re-proves this
 *                                worker's claim, immediately before the socket.
 *
 * WHY THE MINT RIDES INSIDE THE FENCE'S OWN STATEMENT rather than being a second statement after it.
 * o3d-xl63 r5 #1 established, and a structural test asserts, that NOTHING AWAITABLE MAY SIT BETWEEN
 * PROVING THE CLAIM AND USING IT — a claim proven before an await has had that await to lapse in. A
 * dispatch record written after the fence would be exactly such an await. Making it part of the
 * fence's statement satisfies both rules at once: the record is committed before the wire, and the
 * claim proof is still the last thing that happens before it. It also makes the two facts atomic —
 * there is no interleaving in which this worker holds the claim but the record failed to land, or
 * the record landed for a worker that had already lost the row.
 *
 * AND THE EXCLUSIVITY IS THE CLAIM'S, NOT A CONDITIONAL WRITE'S. The earlier revision used
 * `where: { createDispatchedAt: null }` so that two workers could not both be told they were first.
 * They still cannot: the mint is written under `heldClaimWhere`, which exactly one worker satisfies,
 * and the database trigger makes the pair immutable once set even if a writer this repository does
 * not contain tries. Two workers can both PLAN "first-dispatch"; only one of them can fence.
 *
 * WHAT IS DURABLE, AND AT WHICH MOMENT:
 *
 *   before the socket   `createDispatchedAt` + `createDispatchIdempotencyKey`, committed by their own
 *                       statement. Nothing that happens to the post afterwards can unmake them, and a
 *                       database trigger (see the migration) stops any later writer clearing, moving
 *                       or splitting the pair.
 *   after the response  `externalTransactionId`, which is what actually prevents the second post in
 *                       the ordinary case — and which is exactly what a commit failure destroys.
 *
 * WHAT THIS DOES NOT SOLVE, SAID PLAINLY. Xero keeps an `Idempotency-Key` for SIX MINUTES. Inside
 * that window a re-post carrying the SAME key is answered with the original document, so a replay is
 * provably not a second create. Past it, for a type whose create has no natural key, THERE IS NO
 * REMEDY AT ALL: `POST /ManualJournals` deduplicates on nothing, `Reference` and `Narration` are free
 * text, and no lookup this repository can perform will say whether the earlier create landed. The
 * guard therefore refuses instead of guessing, and the refusal names an action a human can take. A
 * refusal an operator can act on beats a coin-flip that duplicates the accounts half the time.
 *
 * AND "AN ACTION A HUMAN CAN TAKE" HAS TO BE TRUE OF THE ROW IN FRONT OF THEM (Codex r1 finding 3).
 * The first cut printed ONE remedy for all eighteen no-remedy types: record the id with the per-row
 * settlement action, or cancel the row and re-queue. Six of those eighteen are DAILY_BATCH types, and
 * the settlement action refused the whole family — so for a sixth of the population the refusal
 * prescribed something that could not be done, which is the o3d-s36z defect (a re-queue that rebuilt
 * the identical payload and was then skipped by the sweep) in a new place.
 *
 * The remedy is now chosen by type, and the daily-batch half of it was MADE TO EXIST rather than
 * merely renamed: `settleableSettlementOutcomes` admits the POSTED assertion for DAILY_BATCH rows,
 * because every reason the family was refused is a reason about CANCELLED — see the argument beside
 * that function. Recording the journal's id leaves the row SYNCED, which is a live status to both the
 * batch recreators and the order delete guard, so it blocks the duplicate recreate and keeps the
 * orders protected. NOT_POSTED stays refused, and the batch refusal says so instead of offering it.
 *
 * AND THAT BLOCK IS NOW NAMED FOR WHAT IT IS (r2, Codex finding 2). "POSTED reads as posted to both
 * consumers" was the whole argument for admitting the assertion — and it only holds if "posted" is
 * TRUE, which nothing here checks: the operator types a document id and IMS makes no call, reads no
 * document and compares no figure. So the assertion is recorded as one (`settlementBasis`), and both
 * consumers read it: the recreate verdict still blocks but REPORTS the batch on every run instead of
 * skipping it silently, and the delete guard still refuses but stops telling the operator that a
 * document exists and needs reversing. The block is unchanged; the claim behind it is no longer
 * laundered into a confirmation.
 *
 * AND BE HONEST ABOUT HOW OFTEN THE REPLAY ARM ACTUALLY FIRES: rarely. The retry that follows a failed
 * persist is scheduled through the outbox, whose first backoff FLOOR is five minutes and which is only
 * claimable on the next five-minute cron tick, so by the time it runs the window has usually closed —
 * the arithmetic is `lib/domain/accounting/idempotency-retention.ts`, and it was established there
 * precisely so nobody would rely on the key. The replay arm is here because it is the one case that
 * can be PROVED safe, not because it is the common one. The common outcome of this fence is the
 * refusal, and that is the intended outcome: a stalled row an operator resolves, instead of a
 * duplicate journal nobody notices.
 */

import type { AccountingSyncType } from '@/app/generated/prisma/client'

import {
  XERO_IDEMPOTENCY_KEY_RETENTION_MS,
  isWithinXeroIdempotencyWindow,
} from './idempotency-retention'
import { isDailyBatchSyncType } from './sync-row-settlement'

/**
 * What stands between a SECOND attempt at this type's remote create and a duplicate document.
 *
 * Exhaustive over `AccountingSyncType` on purpose: it is a `Record`, so adding an enum value fails
 * `tsc` until somebody has written down which of these answers is true of it. A table that could be
 * left incomplete would answer "no policy" for the new type, and "no policy" is how the eighteen
 * journal types went uncovered in the first place.
 */
export type CreateReplayPolicy =
  /**
   * NOTHING. The create makes a new remote document, the remote deduplicates on no key we control,
   * and no lookup can establish afterwards whether it landed. These are the types this fence exists
   * for, and the types whose refusal has no automatic resolution.
   */
  | 'no-remedy'
  /**
   * The create is update-or-create on a number IMS mints and re-mints IDENTICALLY, so a re-post
   * replaces the same document rather than adding one. True of `CREDIT_NOTE`: `POST /CreditNotes` is
   * keyed on `CreditNoteNumber`, the number is taken from the row's own payload, and Xero requires
   * ACCRECCREDIT numbers to be unique — see the header of `connectors/xero/credit-notes.ts`.
   */
  | 'natural-key-upsert'
  /** The remote verb is create-only and refuses a duplicate loudly (`PUT /Invoices`, o3d-6l3). */
  | 'create-only-refuses'
  /** `remoteAttemptedAt` plus the ledger settlement probe decide it (o3d-0m56). */
  | 'money-fenced'
  /** The invoice-number ownership fence decides it (o3d-k26m.5). */
  | 'number-fenced'
  /** A pre-post ledger lookup decides it (`isFirstPurchaseCreditNoteAttempt`, o3d-tfri). */
  | 'ledger-probed'
  /** No new remote document is created, so a repeat cannot duplicate one. */
  | 'not-a-create'

export const CREATE_REPLAY_POLICY: Record<AccountingSyncType, CreateReplayPolicy> = {
  // The eighteen ManualJournal types. `POST /ManualJournals`, no natural key of any kind.
  COGS_JOURNAL: 'no-remedy',
  INVENTORY_ADJUSTMENT: 'no-remedy',
  STOCK_IN_TRANSIT: 'no-remedy',
  STOCK_RECEIPT: 'no-remedy',
  COGS_REVERSAL: 'no-remedy',
  STOCK_ALLOCATION: 'no-remedy',
  DAILY_BATCH_REVENUE_DEFERRAL: 'no-remedy',
  DAILY_BATCH_INVENTORY_ALLOC: 'no-remedy',
  DAILY_BATCH_GROUP_B: 'no-remedy',
  DAILY_BATCH_INVENTORY_RECONCILIATION: 'no-remedy',
  DAILY_BATCH_COGS_RECONCILIATION: 'no-remedy',
  DAILY_BATCH_TRANSIT_RECONCILIATION: 'no-remedy',
  UNEARNED_REV_REVERSAL: 'no-remedy',
  ALLOCATION_REVERSAL: 'no-remedy',
  REALISED_FX_JOURNAL: 'no-remedy',
  UNREALISED_FX_JOURNAL: 'no-remedy',
  MANUFACTURING_JOURNAL: 'no-remedy',
  MANUFACTURING_RECLASS: 'no-remedy',

  CREDIT_NOTE: 'natural-key-upsert',
  TAX_RATE_SYNC: 'natural-key-upsert',
  PURCHASE_INVOICE: 'create-only-refuses',
  SALES_INVOICE: 'number-fenced',
  PURCHASE_CREDIT_NOTE: 'ledger-probed',
  INVOICE_PAYMENT: 'money-fenced',
  BILL_PAYMENT: 'money-fenced',
  PURCHASE_CREDIT_NOTE_ALLOCATION: 'money-fenced',

  SALES_INVOICE_UPDATE: 'not-a-create',
  PURCHASE_INVOICE_UPDATE: 'not-a-create',
  BILL_ATTACHMENT: 'not-a-create',
  INVOICE_PDF: 'not-a-create',
  INVOICE_EMAIL: 'not-a-create',
  WC_INVOICE_NOTE: 'not-a-create',
}

/**
 * How much of Xero's six minutes is given up so that a replay decided HERE is still inside the window
 * when it reaches the socket.
 *
 * The decision is taken, then the lease is re-fenced, then the auth is resolved, then the request
 * travels; none of that is instant, and a replay that arrives one second late is not a replay at all —
 * Xero processes it as a brand-new request and creates the second document this fence exists to
 * prevent. A minute is generous for the work in between and still leaves five minutes of real window.
 *
 * It is subtracted rather than compared loosely because the cost is asymmetric: being a minute too
 * cautious costs a refusal an operator resolves, being a second too bold costs a duplicate journal.
 */
export const CREATE_DISPATCH_REPLAY_MARGIN_MS = 60 * 1000

/** What was already on the row when this attempt asked, or null when nothing was. */
export type RecordedCreateDispatch = {
  dispatchedAt: Date
  /** Null for a record written before the key was stored, which can never match and so never replays. */
  idempotencyKey: string | null
  /**
   * o3d-gvzu — WHEN A LATER STATEMENT PROVED THAT THE DISPATCH ABOVE PUT NOTHING ON THE WIRE, or null
   * when nothing has proved that.
   *
   * NOT the negation of `dispatchedAt`, and not derivable from it: the marker records an INTENTION
   * committed before a socket, and this records a FACT established after it. Only the second one can
   * license another attempt, which is why it needs a column of its own — the pair above is write-once
   * by database trigger, deliberately, because it is a prohibition and a prohibition that tampering
   * clears hands the tamperer what they wanted.
   *
   * IT IS A ONE-SHOT PERMISSION, SPENT BY THE SEND IT PERMITS. The attempt that proceeds on it clears
   * it in the very statement that re-proves the claim — see {@link CreateDispatchReleaseConsumption}.
   * Left standing, it would still be there after a send that DID land, and would license a third
   * attempt: the release says "nothing has been sent for this marker", and that stops being true the
   * moment the next request leaves.
   */
  releasedAt: Date | null
}

export type CreateDispatchBasis =
  /** Nothing is dispatched for this row yet; the fence must mint the record as it sends. */
  | 'first-dispatch'
  /**
   * o3d-gvzu — the marker stands, and a later statement PROVED that the request it records never left
   * this process. Nothing is in the ledger under it, so this create is still the first one Xero will
   * ever see, whatever the key and whatever the age of the marker.
   *
   * The fence must SPEND the release as it sends (`{@link CreateDispatchReleaseConsumption}`), so this
   * basis can be taken exactly once per proof.
   */
  | 'released-nothing-left-the-process'
  /** The same key, inside the window: Xero answers with the original document. */
  | 'replay-within-idempotency-window'
  /** The create is update-or-create on a number IMS re-mints identically. */
  | 'natural-key-upsert'

export type CreateDispatchDecision =
  | { dispatch: true; basis: CreateDispatchBasis }
  | { dispatch: false; error: string }

/**
 * The columns the CLAIM FENCE must merge into its renewal statement as it sends.
 *
 * Shaped as the `data` fragment rather than as loose values so the fence cannot write one half of the
 * pair: the instant and the key it describes are one fact, and the database trigger restores them
 * TOGETHER for exactly the same reason.
 */
export type CreateDispatchMint = {
  createDispatchedAt: Date
  createDispatchIdempotencyKey: string
}

/**
 * o3d-gvzu — SPENDING THE RELEASE, in the same statement that sends under it.
 *
 * Written by the claim fence for exactly the same reason the mint is: a permission that outlives the
 * send it permitted is a permission standing over a request that may have landed. If this attempt's
 * request does leave and its settling transaction then fails at COMMIT, the row must be back in the
 * refusing state the marker alone produces — and it is, because the release is already gone.
 *
 * If the transport refuses this attempt too, the hand-back writes a FRESH release, on its own proof.
 * A release is never inherited; each one describes one attempt that provably sent nothing.
 */
export type CreateDispatchReleaseConsumption = {
  createDispatchReleasedAt: null
}

/**
 * The one `data` fragment the fence merges into its renewal statement, whichever kind it is.
 *
 * A union rather than two parameters, so the fence cannot be handed both: minting a marker and
 * spending a release in one statement is a state that has no meaning, and the type refuses it.
 */
export type CreateDispatchFenceWrite = CreateDispatchMint | CreateDispatchReleaseConsumption

/**
 * May the attempt that took this basis RELEASE the marker if its transport proves nothing was sent?
 *
 * o3d-gvzu, and this is the narrow half of the whole change. A proof produced by this attempt covers
 * THIS attempt's request and nothing else, so it may only be turned into a release when the marker on
 * the row describes a dispatch this process can speak for:
 *
 *  • `first-dispatch`                    the marker IS this attempt's — the fence minted it one
 *                                        statement ago. Proving this attempt sent nothing proves the
 *                                        marker stands over nothing.
 *  • `released-nothing-left-the-process` the marker's own dispatch was already proved unsent (that is
 *                                        why the release existed), and this attempt spent that release
 *                                        and then sent nothing either. Nothing has ever left for this
 *                                        row, so the release may be re-established.
 *
 * And it may NOT on the other two, which is the case that would be wrong rather than merely useless:
 *
 *  • `replay-within-idempotency-window`  the marker records an EARLIER attempt, by this process or
 *                                        another, and that attempt may well have reached Xero — the
 *                                        replay arm exists precisely because it might have. Proving
 *                                        that THIS request never left says nothing about that one, and
 *                                        a release written on it would license a create on top of a
 *                                        document that already exists.
 *  • `natural-key-upsert`                the marker gates nothing for this type, so a release would
 *                                        add a permission where none was ever withheld.
 */
export function mayReleaseCreateDispatch(basis: CreateDispatchBasis): boolean {
  return basis === 'first-dispatch' || basis === 'released-nothing-left-the-process'
}

/**
 * Why a marker was NOT released, when it was not. Reported rather than inferred, because the two
 * reasons mean different things to whoever reads the row afterwards.
 */
export type CreateDispatchReleaseRefusal =
  /**
   * Nothing proved the request failed to leave. THIS IS THE COMMON CASE AND THE CORRECT ONE: a
   * timeout, a socket reset mid-write, a 5xx, a client that threw — the request may have arrived, and
   * a marker released here would license a create on top of a document that exists.
   */
  | 'no-proof-the-request-did-not-leave'
  /**
   * The proof is sound but it is about the wrong request: this attempt replayed a marker some earlier
   * attempt minted, and that one may well have reached the ledger.
   */
  | 'marker-is-not-this-attempts'

export type CreateDispatchReleaseVerdict =
  | { release: true; notSent: string }
  | { release: false; refusal: CreateDispatchReleaseRefusal }

/**
 * MAY THIS ATTEMPT RELEASE THE MARKER IT IS STANDING UNDER? (o3d-gvzu)
 *
 * PURE, AND SEPARATE FROM THE BRANCH THAT CALLS IT, because this is the decision the whole change
 * turns on and it must be testable against a real transport outcome rather than reasoned about in
 * prose. Two independent conditions, both required:
 *
 *  1. `notSent` is present — a NAMED member of the transport's enumeration, written by the statement
 *     that performed the refusal (see `XeroNotSentReason`). Absent for every case where the request
 *     may have arrived.
 *  2. `reachedTheWire` is false — the delta of the process-wide HTTP attempt counter across the call.
 *
 * WHY BOTH, WHEN EITHER WOULD USUALLY DO. They are measurements of the same fact from opposite ends
 * and they fail in opposite directions: the counter is process-wide, so a concurrent Xero call by
 * another row moves it and it reports "sent" for a call that sent nothing; the tag is written at one
 * statement, so a site that forgot to carry it reports nothing at all. Requiring both means neither a
 * mislabelled site nor a quiet counter can license a release on its own, and the conjunction can only
 * ever WITHHOLD a release that one of them would have granted. A withheld release costs a refusal an
 * operator resolves. A wrong one costs a duplicate journal in a live ledger that nobody will notice.
 *
 * AND THE PROOF IS ABOUT THIS ATTEMPT'S REQUEST, so the basis has to admit it — see
 * {@link mayReleaseCreateDispatch}.
 */
export function decideCreateDispatchRelease(params: {
  basis: CreateDispatchBasis
  outcome: { reachedTheWire: boolean; notSent?: string }
}): CreateDispatchReleaseVerdict {
  const { notSent, reachedTheWire } = params.outcome
  if (notSent === undefined || reachedTheWire) {
    return { release: false, refusal: 'no-proof-the-request-did-not-leave' }
  }
  if (!mayReleaseCreateDispatch(params.basis)) {
    return { release: false, refusal: 'marker-is-not-this-attempts' }
  }
  return { release: true, notSent }
}

/**
 * May this create go out — and, when it is the FIRST one, what the fence must record as it sends.
 *
 * `write` is the mint only for `first-dispatch`. A replay does not re-mint: the row already carries
 * the record, and moving the instant forward would renew Xero's six-minute window against itself for
 * ever. For `released-nothing-left-the-process` it is the release CONSUMPTION instead — the permission
 * is spent by the statement that sends under it (o3d-gvzu). For the remaining bases it is null and the
 * fence writes nothing but its own renewal.
 */
export type CreateDispatchPlan =
  | { dispatch: true; basis: CreateDispatchBasis; write: CreateDispatchFenceWrite | null }
  | { dispatch: false; error: string }

/**
 * May this create go out, given what the row already records about an earlier one?
 *
 * PURE, and every clock it uses is the caller's single reading of the DATABASE's clock. Comparing a
 * `createDispatchedAt` written by Postgres against an application host's `new Date()` would be the
 * cross-host comparison o3d-clxw spent five rounds removing, and its dangerous direction here is the
 * permissive one: a host running fast reads a dispatch as older than it is and refuses (safe), a host
 * running slow reads it as younger and REPLAYS a key Xero has already forgotten (a duplicate).
 */
export function decideCreateDispatch(params: {
  type: AccountingSyncType
  /** The key this attempt is about to send. */
  idempotencyKey: string
  recorded: RecordedCreateDispatch | null
  /** `clock_timestamp()`, read from the same database as `recorded.dispatchedAt`. */
  now: Date
  /** What the refusal should call this document, e.g. `COGS_JOURNAL for PurchaseOrder po-1`. */
  label: string
}): CreateDispatchDecision {
  if (params.recorded === null) return { dispatch: true, basis: 'first-dispatch' }

  // o3d-gvzu — THE RELEASE IS ASKED FIRST, AND THE ORDER IS LOAD-BEARING.
  //
  // A release is positive evidence that NOTHING WAS EVER SENT under this marker, so it answers the
  // question the two arms below only approximate: they reason about whether a second request would be
  // deduplicated, and this says there is no first request to deduplicate against.
  //
  // It must win over `replay-within-idempotency-window` even when that arm would also dispatch,
  // because the two bases produce different WRITES. The replay arm writes nothing; this one spends the
  // release. A release left standing after a send is a permission over a request that may have landed
  // — the exact shape of the defect this column exists to remove, in the opposite direction — so the
  // arm that consumes it has to be the one that is taken.
  if (params.recorded.releasedAt !== null) {
    return { dispatch: true, basis: 'released-nothing-left-the-process' }
  }

  const { dispatchedAt, idempotencyKey: recordedKey } = params.recorded
  const sameKey = recordedKey !== null && recordedKey === params.idempotencyKey
  // The margin is applied by asking the question from a moment slightly in the FUTURE, so the one
  // definition of the window stays in idempotency-retention.ts rather than being restated with an
  // adjustment here.
  //
  // THE NON-NEGATIVE TEST IS SEPARATE, AND IT HAS TO BE. `isWithinXeroIdempotencyWindow` already
  // refuses a negative age — but the age it sees has the margin added, so a record stamped up to a
  // whole margin AFTER `now` would come back positive and small, i.e. "very fresh", and REPLAY. A
  // dispatch instant this instance cannot order against its own reading of the same clock is not
  // evidence of anything, and the direction it fails in unguarded is the permissive one.
  const withinWindow = params.now.getTime() >= dispatchedAt.getTime()
    && isWithinXeroIdempotencyWindow(
      dispatchedAt,
      new Date(params.now.getTime() + CREATE_DISPATCH_REPLAY_MARGIN_MS),
    )
  if (sameKey && withinWindow) return { dispatch: true, basis: 'replay-within-idempotency-window' }

  const policy = CREATE_REPLAY_POLICY[params.type]
  if (policy === 'natural-key-upsert') return { dispatch: true, basis: 'natural-key-upsert' }

  const minutes = Math.floor((params.now.getTime() - dispatchedAt.getTime()) / 60_000)
  const age = Number.isFinite(minutes) && minutes >= 0
    ? `${minutes} minute${minutes === 1 ? '' : 's'} ago`
    : 'at a time this instance cannot order against its own clock'
  return {
    dispatch: false,
    error:
      `NOTHING WAS SENT. IMS recorded a dispatch for ${params.label} at `
      + `${dispatchedAt.toISOString()} (${age}) and never recorded a document id for it. `
      + `${CREATE_DISPATCH_UNSETTLED_MEANING} ${sameKey
        ? `Xero forgets an idempotency key after ${Math.round(XERO_IDEMPOTENCY_KEY_RETENTION_MS / 60_000)} `
          + 'minutes, so re-sending the same key now would be processed as a NEW request'
        : 'This attempt would go out under a DIFFERENT idempotency key than the dispatch on record, so '
          + 'it would be processed as a new request'}`
      + `, and a ${params.type} create has no number or reference Xero deduplicates on. Posting would `
      + `therefore create a SECOND document if the first one landed, and nothing IMS can read says `
      + `whether it did. ${describeCreateDispatchRemedy(params.type)}`,
  }
}

/**
 * WHAT A DISPATCH RECORD WITH NO DOCUMENT ID ACTUALLY MEANS — BOTH OF THE THINGS IT MEANS
 * (o3d-jit6 r3, Codex HIGH).
 *
 * The refusal used to say this state "is what happens when the post succeeds and the transaction
 * that would have written the id fails at COMMIT". That is ONE of its producers, and stating it as
 * the explanation is the laundering this record's own settlement basis exists to stop, one layer
 * up: it turns an unknown into a story, and the story sends an operator hunting for a document that
 * may never have existed — or, on a DAILY_BATCH row, hand-posting a journal to replace one IMS
 * simply never sent.
 *
 * THE SECOND PRODUCER IS THE TRANSPORT. The record is minted by the claim fence, which is the last
 * statement before `postPreparedManualJournal`; the transport then has four refusals of its own
 * BELOW it — no usable connection, `accountingPostingIntentRefusal`, the egress authorisations, and
 * the rate budget. r3 deliberately did not hoist them and the reasons stand: each is evaluated once,
 * immediately before the socket, against the very auth the request was built from; one may read AND
 * write the database and one takes an exclusive slot; and o3d-batch-realm deleted precisely such a
 * pre-check because a refusal produced from a stale read is as wrong as a permission produced from
 * one. So a refusal there leaves a minted record and NOTHING IN THE LEDGER.
 *
 * AND THE ROW COULD NOT TELL THEM APART — UNTIL IT COULD (o3d-gvzu). The pair itself still cannot be
 * cleared, and must not be: it is a PROHIBITION, and a prohibition that tampering clears hands the
 * tamperer what they wanted. So the answer is a SECOND column, `createDispatchReleasedAt`, written
 * only when the transport hands back a NAMED, provably pre-egress refusal — see
 * {@link XeroNotSentReason} in the Xero client for the enumeration and for why each member is provable
 * from where its statement sits.
 *
 * SO THIS MESSAGE IS NOW THE STATE THAT REMAINS AFTER THE RELEASE HAS FAILED TO APPLY, and it is worth
 * naming which cases those are, because they are exactly the ones where an absence must not be read as
 * a negative answer:
 *
 *  • the request may have arrived  a timeout, a socket reset mid-write, a 5xx, or a client that threw.
 *                                  Nothing left to prove the negative with, so the marker STANDS. This
 *                                  is the dominant producer, and it is the correct outcome.
 *  • the marker is somebody else's this attempt replayed an earlier dispatch's key rather than minting
 *                                  its own; proving THIS request never left says nothing about that
 *                                  one. See {@link mayReleaseCreateDispatch}.
 *  • the release write failed      the hand-back could not commit, so nothing was released and nothing
 *                                  was handed back either.
 *
 * The evidence trail is unchanged and is what an operator should read first: an attempt that provably
 * sent nothing reports itself as `notPosted` rather than as a failure, which logs
 * `xero_sync_transport_refused_before_post` naming this sync log id.
 */
export const CREATE_DISPATCH_UNSETTLED_MEANING =
  'TWO THINGS PRODUCE THAT STATE AND IMS CANNOT TELL THEM APART FROM THIS ROW: either the post '
  + 'landed and the transaction that would have written the id failed at COMMIT (a real document '
  + 'exists), or IMS recorded the dispatch and its own transport then refused before anything left '
  + 'the process — no usable connection, a posting-intent refusal, an egress authorisation, or an '
  + 'exhausted rate budget — in which case NO document exists. Check the activity log for '
  + '`xero_sync_transport_refused_before_post` against this sync row first: if it is there, IMS '
  + 'refused to send and the ledger should be empty.'

/**
 * The message for an attempt that recorded a dispatch and then PROVABLY sent nothing.
 *
 * Reported through `notPosted`, so the row is handed back intact instead of spending a retry on a
 * send that never happened — the treatment a lost claim and an expired lease already get, for the
 * same reason. It still does NOT clear the record: nothing may, and pretending otherwise would be the
 * prohibition-that-tampering-clears mistake. What it does is make the false marker LOUD and NAMED at
 * the moment it is created, so the refusal that follows has something to point at — and, since
 * o3d-gvzu, say whether a RELEASE was recorded beside the marker or, if not, exactly which of the two
 * reasons for withholding one applies.
 */
export function describeCreateDispatchNotSent(params: {
  label: string
  error: string
  /**
   * o3d-gvzu: the named pre-egress refusal, when the transport produced one, and undefined when it
   * did not. Undefined is what a timeout, a reset mid-write and a 5xx all look like here.
   */
  notSent?: string
  /** Whether this hand-back will also write the release. See {@link mayReleaseCreateDispatch}. */
  releasing: boolean
}): string {
  const head = `NOTHING WAS SENT for ${params.label}: IMS recorded that a create was about to be `
    + `dispatched and its own transport then refused before the request left this process — `
    + `${params.error}.`
  if (params.releasing) {
    return `${head} The refusal was \`${params.notSent}\`, which is provably ABOVE the socket, so this `
      + 'hand-back also records a RELEASE against the dispatch marker: the marker itself is write-once '
      + 'and stays exactly where it is (it is a prohibition, and one that tampering clears is worth '
      + 'nothing), but the release beside it says the request it records never left. The next attempt '
      + 'may therefore send, whatever the age of the marker — and it SPENDS the release as it sends, so '
      + 'if that request does leave, this row is back under the marker alone.'
  }
  return `${head} NO RELEASE IS RECORDED`
    + (params.notSent
      ? ', because this attempt did not mint the marker it would be releasing — it replayed an earlier '
        + 'dispatch, and proving that THIS request never left says nothing about that one.'
      : ': the transport gave no proof that the request failed to leave, which is what a timeout, a '
        + 'connection reset mid-write and a 5xx all look like. Any of those may have reached Xero.')
    + ' The dispatch record therefore STANDS, which means a later attempt outside Xero\'s idempotency '
    + 'window will be refused even though no document may have been created. That refusal is '
    + 'recoverable and names how; this line is the evidence it will tell an operator to look for.'
}

/**
 * The remedy, CHOSEN BY TYPE (Codex r1 finding 3).
 *
 * A refusal whose remedy cannot be performed is not a remedy, and the generic one could not be
 * performed on a DAILY_BATCH row: that family had no per-row settlement at all, no cancel, and a
 * FAILED batch row is revived to PENDING by `resetFailedDailyBatchLogs` on every daily run — so it
 * would refuse, fail and revive for ever while blocking its own batch's recreate.
 */
export function describeCreateDispatchRemedy(type: AccountingSyncType): string {
  if (isDailyBatchSyncType(type)) {
    return 'REMEDY: look in the accounting system for that journal. If it is there, record its id '
      + 'against this row with the per-row settlement action on /sync, choosing "It DID post" — a '
      + 'DAILY BATCH row accepts that assertion and only that one. It leaves the row SYNCED, which '
      + 'blocks both the batch recreate probe and the order delete guard, so no second journal is '
      + 'derived and the orders staged into the batch stay protected. It is recorded as YOUR '
      + 'ASSERTION, not as a confirmed post: both of those readers name it as one, and the daily run '
      + 'will report the batch until somebody confirms the journal is really there. If the '
      + 'journal is NOT there, post it in the accounting system from this row\'s own lines and record '
      + 'that id here the same way: a batch covers every order staged into it, so there is deliberately '
      + 'no per-row cancel-and-re-queue for one — cancelling it would let an order be hard-deleted while '
      + 'a recreate was already building a journal containing its value.'
  }
  return 'REMEDY: look in Xero for that document. If it is there, record its id against this row with '
    + 'the per-row settlement action on /sync (it is written as an operator assertion, not a connector '
    + 'confirmation). If it is not there, cancel this row and re-queue the work from the source '
    + 'document, which raises a new row with no dispatch on record.'
}

/**
 * The narrow delegate surface this needs, so a caller can pass `db`, a transaction, or a stub.
 *
 * READ-ONLY, and that is the finding-2 fix expressed in a type: this module can no longer write a
 * dispatch record at all, so no future call site can reintroduce one on a path that sends nothing.
 * The only writer is the claim fence, using {@link CreateDispatchMint}.
 */
export type CreateDispatchClient = {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>
  accountingSyncLog: {
    findUnique(args: {
      where: { id: string }
      select: {
        createDispatchedAt: true
        createDispatchIdempotencyKey: true
        createDispatchReleasedAt: true
      }
    }): Promise<{
      createDispatchedAt: Date | null
      createDispatchIdempotencyKey: string | null
      createDispatchReleasedAt: Date | null
    } | null>
  }
}

/**
 * Decide whether this create may go out, and hand back what the CLAIM FENCE must record as it sends.
 *
 * WRITES NOTHING. That is finding 2: everything below can refuse, and a refusal here must leave the
 * row exactly as it found it, because a marker written on a path that sends nothing is a prohibition
 * standing over a post nobody made. The record is minted by the fence, from {@link CreateDispatchPlan}
 * `mint`, in the same statement that re-proves the claim — see the header.
 *
 * WHERE IT IS CALLED. Immediately before the fence, which is immediately before the socket. It is
 * awaited, so it deliberately runs BEFORE the claim is proven rather than after it: an await between
 * the proof and the send is the o3d-xl63 r5 #1 defect, and the same ordering argument the
 * PURCHASE_CREDIT_NOTE branch already makes for `isFirstPurchaseCreditNoteAttempt`.
 *
 * FAILS CLOSED. A `$queryRaw` or `findUnique` that throws refuses the post — nothing was sent —
 * because a create we cannot describe is a create whose outcome we cannot record. A row that has
 * vanished refuses for the same reason: there is nowhere left to write the id this post would return.
 */
export async function planCreateDispatch(
  client: CreateDispatchClient,
  params: { entryId: string; type: AccountingSyncType; idempotencyKey: string; label: string },
): Promise<CreateDispatchPlan> {
  try {
    // ONE reading of the DATABASE's clock, used both to stamp and to age. `clock_timestamp()` rather
    // than `now()`: `now()` is the transaction's start time, and these statements are not in one
    // transaction, so it would be a different kind of instant on each call.
    //
    // IT IS ALSO WHAT THE FENCE WILL STAMP, one statement later. Taking it here rather than in the
    // fence keeps every `createDispatchedAt` on the SAME clock as the `now` every later attempt ages
    // it against (o3d-clxw) — the application host's `new Date()` the fence uses for the claim is a
    // different clock and must never end up in this column. The gap between this read and the write
    // is one statement, and it errs in the safe direction anyway: a record stamped very slightly
    // EARLY reads as slightly OLDER, so the replay window closes sooner, never later.
    const clock = await client.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`
    const now = clock?.[0]?.now
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      return {
        dispatch: false,
        error: `NOTHING WAS SENT. IMS could not read the database clock to record that a create for `
          + `${params.label} is about to be dispatched, so it cannot tell a first attempt from a repeat.`,
      }
    }

    const row = await client.accountingSyncLog.findUnique({
      where: { id: params.entryId },
      select: {
        createDispatchedAt: true,
        createDispatchIdempotencyKey: true,
        createDispatchReleasedAt: true,
      },
    })
    if (!row) {
      return {
        dispatch: false,
        error: `NOTHING WAS SENT. The sync row for ${params.label} could not be read back to record that `
          + 'a create is about to be dispatched, so there is nowhere to write the document id this post '
          + 'would return — which is the state that produces a duplicate.',
      }
    }

    if (row.createDispatchedAt === null) {
      return {
        dispatch: true,
        basis: 'first-dispatch',
        write: { createDispatchedAt: now, createDispatchIdempotencyKey: params.idempotencyKey },
      }
    }

    const decision = decideCreateDispatch({
      type: params.type,
      idempotencyKey: params.idempotencyKey,
      recorded: {
        dispatchedAt: row.createDispatchedAt,
        idempotencyKey: row.createDispatchIdempotencyKey,
        releasedAt: row.createDispatchReleasedAt,
      },
      now,
      label: params.label,
    })
    // A row that already carries a record is never re-minted: the pair is what the earlier dispatch
    // wrote, the trigger holds it there, and moving the instant forward would renew Xero's six-minute
    // window against itself for ever.
    //
    // o3d-gvzu: the ONE thing the fence writes on such a row is the release CONSUMPTION, and only on
    // the basis that was taken because a release was standing. `null` for every other basis, so no
    // other arm can clear a permission it did not read.
    if (!decision.dispatch) return decision
    return {
      dispatch: true,
      basis: decision.basis,
      write: decision.basis === 'released-nothing-left-the-process'
        ? { createDispatchReleasedAt: null }
        : null,
    }
  } catch (error) {
    return {
      dispatch: false,
      error: `NOTHING WAS SENT. IMS could not record that a create for ${params.label} is about to be `
        + `dispatched: ${String(error)}. A create whose local record cannot be written is a create whose `
        + 'OUTCOME cannot be recorded either, so it is refused rather than sent unrecorded.',
    }
  }
}

/**
 * HOW LONG THE REPLAY WINDOW HAS ALREADY BEEN RUNNING — MEASURED ENTIRELY ON THE DATABASE'S CLOCK
 * (o3d-jit6 r8, Codex HIGH).
 *
 * The window a hand-back races did not start when the hand-back started. It started at
 * `createDispatchedAt` — the instant the claim fence stamped as the create went out — and by the time
 * a transport refusal has been classified, worded and carried back up to the runner, some of it is
 * already gone. A budget computed from the hand-back's own entry therefore describes a window that no
 * longer exists, and the further the refusal is from the mint the more of the real deadline it
 * over-states. The marker's instant is the only honest anchor, because it IS the instant the window
 * opened.
 *
 * WHAT CROSSES BETWEEN CLOCKS IS A DURATION, NEVER AN INSTANT. `clock_timestamp()` and
 * `createDispatchedAt` are read from the SAME database in the same call, so their difference is a real
 * elapsed time and is safe to hand to a host-side bound. Comparing the column against this host's own
 * `new Date()` is the o3d-clxw defect, and this deliberately does not do it — see the header of
 * {@link decideCreateDispatch} for why that comparison fails in the permissive direction.
 *
 * AND THE SAMPLE IS ONE STATEMENT, NOT TWO (o3d-jit6 r9, Codex HIGH). r8 read `clock_timestamp()`
 * and then fetched the marker in a SEPARATE query. Everything the second round trip cost — which is
 * exactly what a database under load costs most of — fell outside the difference, so the elapsed
 * figure was short by that much and the deadline built from it sat that much LATER than the truth,
 * under precisely the delay that makes the window tight. One statement reads the marker and the clock
 * together and returns nothing but their difference, so the duration that crosses to the host is the
 * one the database measured at the moment it read the row.
 *
 * BOUNDED BY CONSTRUCTION: one row, by primary key, with no join and no scan — the read cannot cost
 * more than the thing it is measuring.
 *
 * FAILS TO "UNKNOWN", NOT TO ZERO. A caller that cannot learn the age must fall back to its own
 * entry-anchored bound rather than treat the budget as spent: refusing to hand the row back at all is
 * strictly worse than handing it back a little late, because a row left PROCESSING is unclaimable for
 * the whole stale cutoff — which is the very stranding the hand-back exists to prevent.
 */
export type CreateDispatchAge =
  /**
   * `elapsedMs` and nothing else: r9's rule is that ONLY A DURATION may cross to the host. An instant
   * carried out of here invites a host-side `Date.now()` comparison, which is the o3d-clxw defect.
   */
  | { known: true; elapsedMs: number }
  | { known: false; reason: 'no-marker' | 'unreadable' | 'unorderable' }

export async function readCreateDispatchAge(
  client: CreateDispatchClient,
  entryId: string,
): Promise<CreateDispatchAge> {
  try {
    // ONE STATEMENT, ONE ROW, ONE CLOCK READ. `clock_timestamp()` is evaluated inside the same
    // statement that reads the marker, so the subtraction happens where both operands live and the
    // time this query itself spends is INSIDE the figure rather than after it. NULL comes back for a
    // row that carries no marker; no row at all comes back for a row that is gone.
    //
    // AND BOTH OPERANDS ARE NAIVE UTC, SO THE SESSION'S TIME ZONE CANNOT MOVE THE ANSWER (o3d-jit6
    // r10, Codex HIGH). `create_dispatched_at` is `TIMESTAMP(3)` WITHOUT time zone and carries the
    // driver's naive UTC instant; `clock_timestamp()` is `timestamptz`. Subtracting one from the
    // other makes Postgres promote the naive column to `timestamptz` USING THE SESSION'S `TimeZone`,
    // so on any session that is not UTC the elapsed figure is wrong by exactly that offset. The
    // offset is HOURS and the window it is measured against is SIX MINUTES, so this does not skew
    // the answer, it replaces it: a positive offset reports a window that closed long ago and
    // refuses every attempt after the first as budget-exhausted, while a negative one reports a
    // NEGATIVE age, which the ordering test below rejects as `unorderable` — and the caller then
    // falls back to the entry-anchored bound, which is the over-stated deadline the marker anchor
    // exists to replace.
    //
    // `AT TIME ZONE 'UTC'` demotes the clock into the same naive UTC frame the column already lives
    // in, and `timestamp - timestamp` consults no session setting at all: the interval is identical
    // under every `TimeZone`, which is the property the test pins.
    const rows = await client.$queryRaw<Array<{ elapsedMs: number | null }>>`
      SELECT (EXTRACT(EPOCH FROM ((clock_timestamp() AT TIME ZONE 'UTC') - "create_dispatched_at")) * 1000)::double precision
             AS "elapsedMs"
      FROM "accounting_sync_logs"
      WHERE "id" = ${entryId}
      LIMIT 1
    `
    const row = rows?.[0]
    if (!row) return { known: false, reason: 'unreadable' }
    // No marker means no replay window is standing over this row at all, so there is nothing for a
    // deadline to be anchored to. That is a different answer from "could not read", and the caller
    // says which one it got.
    if (row.elapsedMs === null || row.elapsedMs === undefined) return { known: false, reason: 'no-marker' }

    const elapsedMs = Number(row.elapsedMs)
    // THE SAME NON-NEGATIVE TEST `decideCreateDispatch` MAKES, for the same reason: an instant this
    // instance cannot order against its own reading of the same clock is not evidence of anything.
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return { known: false, reason: 'unorderable' }
    return { known: true, elapsedMs }
  } catch {
    return { known: false, reason: 'unreadable' }
  }
}
