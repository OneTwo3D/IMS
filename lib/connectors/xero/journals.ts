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

import { xeroHttpAttemptCount, xeroPost } from './api'
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
 * A journal body that has cleared every local check and is ready for the wire.
 *
 * Opaque by construction: the only way to obtain one is {@link prepareManualJournal}, so a call site
 * cannot reach {@link postPreparedManualJournal} with an unvalidated body — it would not compile.
 */
export type PreparedManualJournal = {
  readonly journal: Record<string, unknown>
  readonly [PREPARED_MANUAL_JOURNAL_BRAND]: 'lib/connectors/xero/journals#prepareManualJournal'
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

  // The one mint. `as` rather than a literal because the brand is a phantom — it exists only in the
  // type — and this is the single place in the codebase allowed to assert it. The body is annotated
  // first so the assertion stays a NARROWING one: `PreparedManualJournal` is assignable to
  // `{ journal: Record<string, unknown> }`, which is what makes `as` legal here and what would stop
  // it if the wire shape and the type ever drifted apart. It is deliberately not `as unknown as`.
  const journal: Record<string, unknown> = {
    Narration: entry.narration,
    Date: entry.date,
    JournalLines: journalLines,
    Status: status,
  }
  return { ok: true, prepared: { journal } as PreparedManualJournal }
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
}

/**
 * Send a body that has already cleared {@link prepareManualJournal}.
 *
 * MAKES NO CHECKS. Anything added here would be a gate BELOW the caller's dispatch record again, which
 * is the defect this split exists to close — a new rule about journals belongs in `prepareManualJournal`.
 * Observing what the TRANSPORT did is not a check: it refuses nothing, changes no outcome here, and
 * only lets the caller tell a post that failed from one that never happened.
 */
export async function postPreparedManualJournal(
  prepared: PreparedManualJournal,
  opts?: { idempotencyKey?: string },
): Promise<ManualJournalPostOutcome> {
  const attemptsBefore = xeroHttpAttemptCount()
  const res = await xeroPost<XeroManualJournalResponse>('ManualJournals', prepared.journal, opts)
  const reachedTheWire = xeroHttpAttemptCount() > attemptsBefore
  if (!res.ok || !res.data?.ManualJournals?.length) {
    return { success: false, error: res.error ?? 'Failed to create manual journal', reachedTheWire }
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
