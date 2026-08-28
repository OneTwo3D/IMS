/**
 * Push manual journals to Xero — COGS, inventory adjustments, stock-in-transit.
 *
 * SPLIT IN TWO, AND THE SPLIT IS THE WHOLE OF o3d-jit6 r2 FINDING 1 (Codex).
 *
 * `pushManualJournal` used to do both halves in one call: it BUILT and VALIDATED the request body —
 * dropping zero lines, refusing a journal with nothing left, refusing an unbalanced one — and only
 * then sent it. Both refusals return WITHOUT CALLING XERO.
 *
 * That is fatal to the caller one layer up. The manual-journal branch of the sync processor mints a
 * durable "a create for this row is on the wire" record in the claim fence, IMMEDIATELY BEFORE this
 * call, because the record has to survive a commit failure that happens after a successful post. If a
 * gate inside this function then refuses, the marker is written and NOTHING LEFT THE PROCESS — and a
 * later, legitimate attempt reads a dispatch that never happened and refuses a create nobody made.
 * That is the same class of error as the duplicate the marker exists to prevent, in the opposite
 * direction (see lib/domain/accounting/create-dispatch-record.ts, which has already had this argument
 * once about the claim fence).
 *
 * So every gate that can refuse now lives in {@link prepareManualJournal}, which is PURE and
 * SYNCHRONOUS and touches nothing outside its arguments, and the caller runs it BEFORE it plans or
 * mints anything. {@link postPreparedManualJournal} is what remains: it takes a body that has already
 * cleared every check and hands it to the transport. It has no refusal of its own left to make, which
 * is the property the processor depends on — see the branch's comment there.
 *
 * `pushManualJournal` stays as the composition of the two, for callers with no dispatch record to
 * protect (the generic `XeroConnector.postJournalEntry` adapter). Its behaviour is unchanged.
 */

import { xeroHttpAttemptCount, xeroPost, type XeroNotSentReason } from './api'
import type { JournalEntry, JournalLine } from '../types'

type XeroManualJournalResponse = {
  ManualJournals: Array<{
    ManualJournalID: string
    Narration: string
    Status: string
  }>
}

/**
 * The brand that makes {@link PreparedManualJournal} OPAQUE (o3d-jit6 r3, Codex MEDIUM).
 *
 * `declare const` with a `unique symbol` type and NO export. A caller outside this module cannot
 * name this symbol, so it cannot write an object literal carrying the property, so it cannot
 * construct the type — the only route to a value of it is {@link prepareManualJournal}.
 *
 * WHY A BRAND AND NOT A COMMENT. The type used to be structurally `{ journal: Record<string,
 * unknown> }`, and a comment claiming it was opaque. It was not: `postPreparedManualJournal({
 * journal: anythingAtAll })` compiled, so every gate the r2 split moved into `prepareManualJournal`
 * could be walked past by a caller that never called it — which is precisely the defect the split
 * exists to prevent, reachable in one line.
 *
 * THIS REPOSITORY HAS DONE THIS BEFORE AND IT WORKED. `HeldClaim` (o3d-xl63 r6) makes a bare `Date`
 * a COMPILE ERROR where a claim is required, and the merged fence branch recorded that the original
 * defect had been invisible precisely because a timestamp is structurally identical to a claim. A
 * validated journal body is structurally identical to an unvalidated one for the same reason.
 */
declare const PREPARED_MANUAL_JOURNAL_BRAND: unique symbol

/**
 * A CAPABILITY TO POST A JOURNAL THAT HAS CLEARED EVERY LOCAL CHECK — AND NOTHING ELSE.
 *
 * Opaque by construction: the only way to obtain one is {@link prepareManualJournal}, so a call site
 * cannot reach {@link postPreparedManualJournal} with an unvalidated body — it would not compile.
 *
 * AND IT CARRIES NO BODY (o3d-jit6 r4, Codex MEDIUM). r3's shape was
 * `{ readonly journal: Record<string, unknown>; readonly [BRAND]: ... }`, and the brand
 * authenticated THE WRAPPER ONLY. `readonly` is a compile-time property of the reference, not of
 * the object: the record it pointed at was an ordinary mutable one, reachable through a legitimately
 * prepared value, so
 *
 *     const p = prepareManualJournal(entry)
 *     if (p.ok) (p.prepared.journal as Record<string, unknown>).JournalLines = whateverYouLike
 *
 * walked every gate the r2 split exists to enforce — the zero-line refusal, the balance check —
 * WITHOUT constructing a forged wrapper. The gate was passed by an object that no longer resembled
 * what was validated, which is the same defect as the forged wrapper arriving by a different door.
 *
 * So the type is now a PHANTOM: it has no accessible member at all, and the body lives in
 * {@link PREPARED_MANUAL_JOURNAL_BODIES}, a module-private `WeakMap` no caller can name or import.
 * `prepared.journal` is a compile error rather than a mutation point — see the `@ts-expect-error`
 * assertion in tests/accounting/xero-manual-journal-dispatch-honesty.test.ts, which is where a
 * type-level guarantee is tested from.
 */
export type PreparedManualJournal = {
  readonly [PREPARED_MANUAL_JOURNAL_BRAND]: 'lib/connectors/xero/journals#prepareManualJournal'
}

/**
 * WHERE THE VALIDATED BODY ACTUALLY LIVES — MODULE-PRIVATE, KEYED BY THE CAPABILITY.
 *
 * Not exported, so no other module can read it, write it, or take a reference to a body out of it.
 * The only writer is {@link prepareManualJournal} and the only reader is
 * {@link postPreparedManualJournal}; between those two statements the body is unreachable from
 * anywhere else in the process except by a reference that never escaped this function.
 *
 * A `WeakMap` rather than a `Map` so a prepared value that is never posted is collected with its
 * body instead of pinning a journal — and a hidden private field on the object would have been the
 * same guarantee with a worse failure mode: a runtime `#private` is invisible to the structural type
 * system, so the phantom type would still have needed writing down separately.
 */
const PREPARED_MANUAL_JOURNAL_BODIES = new WeakMap<PreparedManualJournal, Record<string, unknown>>()

/**
 * Freeze what was validated, so even the reference that never escaped cannot be edited later.
 *
 * BELT AND BRACES, and deliberately so. Hiding the body already stops today's caller; freezing stops
 * a future edit inside this module from handing a live reference to something that mutates it, and
 * makes any such attempt throw in strict mode rather than quietly change the wire body between the
 * balance check and the socket. The lines are frozen individually because freezing the array only
 * seals its LENGTH — `lines[0].LineAmount = 999` would still land.
 */
function freezeValidatedJournalBody(journal: Record<string, unknown>): Record<string, unknown> {
  const lines = journal.JournalLines
  if (Array.isArray(lines)) {
    for (const line of lines) Object.freeze(line)
    Object.freeze(lines)
  }
  return Object.freeze(journal)
}

export type ManualJournalPreparation =
  | { ok: true; prepared: PreparedManualJournal }
  | { ok: false; error: string }

/**
 * Build and CHECK the request body. PURE — no clock, no database, no network, nothing ambient.
 *
 * Every reason this module has to refuse a journal is here, so a caller that runs it first knows that
 * what follows either reaches Xero or fails at the transport.
 */
export function prepareManualJournal(
  entry: JournalEntry,
  status: string = 'POSTED',
): ManualJournalPreparation {
  // Xero Manual Journal lines use a single signed `LineAmount` field
  // (positive = debit, negative = credit). DebitAmount/CreditAmount are
  // not accepted on ManualJournals — Xero rejects the payload with
  // "The LineAmount field is mandatory". See:
  // https://developer.xero.com/documentation/api/accounting/manualjournals
  const journalLines = entry.lines
    .map((line: JournalLine) => {
      const debit = Number(line.debit ?? 0)
      const credit = Number(line.credit ?? 0)
      const signed = debit - credit
      if (signed === 0) return null // skip zero lines — Xero would reject them
      const xeroLine: Record<string, unknown> = {
        LineAmount: Math.round(signed * 100) / 100,
        AccountCode: line.accountCode,
        Description: line.description,
      }
      if (line.taxType) xeroLine.TaxType = line.taxType
      return xeroLine
    })
    .filter((l): l is Record<string, unknown> => l !== null)

  if (journalLines.length === 0) {
    return { ok: false, error: 'Journal has no non-zero lines' }
  }

  // Validate debits = credits (sum of signed LineAmounts must be zero)
  const totalDebits = entry.lines.reduce((s, l) => s + Number(l.debit ?? 0), 0)
  const totalCredits = entry.lines.reduce((s, l) => s + Number(l.credit ?? 0), 0)
  if (Math.abs(totalDebits - totalCredits) > 0.01) {
    return { ok: false, error: `Journal unbalanced: debits=${totalDebits}, credits=${totalCredits}` }
  }

  const journal: Record<string, unknown> = {
    Narration: entry.narration,
    Date: entry.date,
    JournalLines: journalLines,
    Status: status,
  }
  // THE ONE MINT, and r4 makes it mint a TOKEN rather than a wrapper around the body.
  //
  // `as` rather than a literal because the brand is a phantom — it exists only in the type — and this
  // is the single place in the codebase allowed to assert it. It is a NARROWING assertion still:
  // every object type is assignable to `{}`, so the two types are comparable and this is legal
  // without `as unknown as`, which stays banned here.
  //
  // The token is frozen as well as empty. There is nothing on it to reach, and now nothing can be
  // stapled onto it either — a caller that could add `journal` back would not be reaching the body
  // (the poster reads the map, not the argument), but it would make the capability look like it
  // carried one, which is how the r3 shape read to everybody who used it.
  const prepared = Object.freeze({}) as PreparedManualJournal
  // The body goes where only this module can reach it, frozen, and the local reference dies with
  // this call: `journal` is not returned, not captured by anything that outlives the function, and
  // not reachable from `prepared`.
  PREPARED_MANUAL_JOURNAL_BODIES.set(prepared, freezeValidatedJournalBody(journal))
  return { ok: true, prepared }
}

/**
 * What one attempt at posting a prepared journal did — INCLUDING WHETHER IT REACHED THE WIRE AT ALL.
 */
export type ManualJournalPostOutcome = {
  success: boolean
  journalId?: string
  error?: string
  /**
   * FALSE only when this process is PROVABLY certain that no request left it (o3d-jit6 r3, Codex
   * HIGH).
   *
   * The transport still has refusals of its own below the caller's dispatch record, and r3
   * established that they must not be hoisted: each is evaluated once, immediately before the
   * socket, against the very auth the request was built from, one may read AND write the database
   * and one takes an exclusive slot, and o3d-batch-realm deleted exactly such a pre-check because a
   * refusal produced from a stale read is as wrong as a permission produced from one. So the caller
   * cannot ask the questions earlier — but it can be TOLD the answer afterwards, and that is what
   * this field is.
   *
   * MEASURED, NOT PARSED. It is the delta of `xeroHttpAttemptCount()` across the call: a monotonic
   * counter incremented by `noteRequest`, on the statement immediately before `connectorFetch`, on
   * the one path in `api.ts` that reaches Xero's API. Reading a status code would not do — the four
   * refusals do not share one (`XERO_NOT_SENT_STATUS` for the auth/intent/egress three, 429 for the
   * rate budget) and 429 is also what Xero itself answers AFTER a real send — and reading the error
   * TEXT would be a shape test on prose, which is not evidence.
   *
   * IT ERRS TOWARDS "SENT", ALWAYS. The counter is process-wide, so a concurrent Xero call by
   * another row or another tenant moves it and this reports `true` for a call that in fact sent
   * nothing; the caller then behaves exactly as it did before. And `noteRequest` runs BEFORE
   * `connectorFetch`, so a socket that never opened (DNS, TLS, connection refused) also counts as
   * sent. False means nothing left; true means nothing is claimed.
   */
  reachedTheWire: boolean
  /**
   * WHICH PROVABLY PRE-EGRESS REFUSAL STOPPED THIS ATTEMPT, when one did (o3d-gvzu).
   *
   * `reachedTheWire: false` says "no request left this process". This says WHICH refusal is
   * responsible, taken from the statement that made it rather than from the status or the prose —
   * see {@link XeroNotSentReason} for why each member is provable.
   *
   * IT IS NOT A SECOND SPELLING OF `reachedTheWire`, and the caller must require BOTH before it acts
   * on "nothing was sent". They are independent measurements of the same fact from opposite ends: the
   * counter delta is measured across the whole call and errs towards `true` (it is process-wide, so a
   * concurrent Xero call by another row moves it), while the tag is written at one statement and errs
   * towards absent (it is refused once anything has gone out on this call). Requiring both means a
   * mislabelled site cannot on its own license the release of a dispatch marker, and neither can a
   * quiet counter.
   *
   * `undefined` covers every case where this process cannot prove the request did not arrive — a real
   * reply of any status, a timeout, a socket reset mid-write, a 5xx, a `connectorFetch` throw.
   */
  notSent?: ManualJournalNotSentReason
}

/**
 * The pre-egress refusals a manual-journal post can meet: the transport's four (o3d-gvzu), plus the
 * one this module makes for itself.
 */
export type ManualJournalNotSentReason = XeroNotSentReason | 'body-not-validated'

/**
 * Send the body that has already cleared {@link prepareManualJournal}.
 *
 * MAKES NO CHECKS. Anything added here would be a gate BELOW the caller's dispatch record again, which
 * is the defect this split exists to close — a new rule about journals belongs in `prepareManualJournal`.
 * Observing what the TRANSPORT did is not a check: it refuses nothing, changes no outcome here, and
 * only lets the caller tell a post that failed from one that never happened.
 *
 * NOTE WHAT IT SENDS (o3d-jit6 r4): the body from {@link PREPARED_MANUAL_JOURNAL_BODIES}, NOT one
 * taken off the argument. That is the whole of the medium — the argument no longer has one — and it
 * is what makes "the body that was validated" and "the body that goes on the wire" the same object
 * by construction rather than by trusting the caller not to have touched it in between.
 */
export async function postPreparedManualJournal(
  prepared: PreparedManualJournal,
  opts?: { idempotencyKey?: string },
): Promise<ManualJournalPostOutcome> {
  const journal = PREPARED_MANUAL_JOURNAL_BODIES.get(prepared)
  if (!journal) {
    // UNREACHABLE FROM TYPED CODE, and not a gate: the only mint always registers a body, and the
    // brand makes a token this module did not mint impossible to construct. It is here for the
    // untyped bypass (`as never`, a plain-JS caller, a value that crossed a module-instance
    // boundary), and it answers the only way that is safe for the caller's dispatch record — NOTHING
    // WAS SENT, said through the same field the measured answer uses, so a create that reaches this
    // line is handed back for replay instead of being failed or, worse, posted from an unvalidated
    // body. It asks no question about the journal, so it is not a refusal moved below the fence.
    return {
      success: false,
      error: 'the prepared journal carried no validated body — nothing was sent',
      reachedTheWire: false,
      // PROVABLE BY CONSTRUCTION, and the only member not owned by the transport: this returns
      // ABOVE `xeroPost`, so no auth is resolved, no request is built and `performRequest` is never
      // entered. There is no measurement to take because there is no call.
      notSent: 'body-not-validated',
    }
  }
  const attemptsBefore = xeroHttpAttemptCount()
  const res = await xeroPost<XeroManualJournalResponse>('ManualJournals', journal, opts)
  const reachedTheWire = xeroHttpAttemptCount() > attemptsBefore
  if (!res.ok || !res.data?.ManualJournals?.length) {
    // The tag is carried through UNCHANGED — never inferred here from `reachedTheWire`, and never
    // widened. A response that arrived (or failed to arrive) with no tag stays untagged, which is
    // what keeps a timeout, a reset and a 5xx on the "may have been sent" side of the line.
    return {
      success: false,
      error: res.error ?? 'Failed to create manual journal',
      reachedTheWire,
      notSent: res.notSent,
    }
  }

  return { success: true, journalId: res.data.ManualJournals[0].ManualJournalID, reachedTheWire }
}

/**
 * Create a manual journal entry in Xero.
 *
 * Prepare-then-post, for callers that have nothing recorded ahead of the call. A caller that mints a
 * dispatch record must NOT use this — it has to run the two halves itself, with the mint between them.
 */
export async function pushManualJournal(
  entry: JournalEntry,
  status: string = 'POSTED',
  opts?: { idempotencyKey?: string },
): Promise<ManualJournalPostOutcome> {
  const preparation = prepareManualJournal(entry, status)
  // A journal that will not build never reaches the transport, which is the whole point of the
  // split — so this one is `reachedTheWire: false` by construction rather than by measurement.
  if (!preparation.ok) return { success: false, error: preparation.error, reachedTheWire: false }
  return postPreparedManualJournal(preparation.prepared, opts)
}
