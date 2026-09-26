import type { Prisma } from '@/app/generated/prisma/client'
import { accountingPostingKeyForRow, postingKeyIsReusedAcrossPostings } from '@/lib/accounting/posting-key'
import { isPostableAccountingSyncStatus } from '@/lib/domain/accounting/postable-sync-statuses'
import { SOURCE_CANCELLED_VOID_BASIS } from '@/lib/domain/accounting/accounting-event-void-basis'
import { updateMirroredAccountingEventStatus } from '@/lib/domain/accounting/accounting-event-mirror'
import { POSTING_REFUSAL_KINDS, postingRefusalMarkable, type PostingRefusalKind } from '@/lib/domain/accounting/posting-refusal-kinds'
import { lockPostingKey, type PostingSuppressionClient } from '@/lib/domain/accounting/posting-suppression'
import { UNCLAIMED_ATTEMPT_REVISION } from '@/lib/domain/accounting/sync-log-attempt'
import { settlementMirrorGuard } from '@/lib/domain/accounting/sync-row-settlement'

/**
 * o3d-j625 r7 (owner decision 2026-09-19, "Handled + stop retry") — MARK A REFUSED POSTING HANDLED, AND
 * MAKE SURE IMS NEVER POSTS IT.
 *
 * "Handled" is the operator's assertion that they posted THIS posting BY HAND in the ledger. For a posting
 * IMS also retries (the `retried` kinds, posting-refusal-kinds.ts), that assertion is only safe if IMS then
 * never posts it itself — otherwise the ledger gets it twice. So, in ONE transaction, under the per-key
 * lock every row-creating path also takes (posting-suppression.ts):
 *
 *   1. REFUSE if IMS may ALREADY have posted it, or may be posting it now: any sync row for this exact
 *      posting key that is PROCESSING, SYNCED, FAILED (sent or not is unknowable in general), carries an
 *      external id, or is PENDING but has been claimed by a processor before (it may have been sent and
 *      put back for a retry). Those are settled in the accounting sync log first — the mark cannot know
 *      whether the ledger already has the posting, and guessing is how it would be posted twice.
 *   2. CANCEL every remaining row for the key: PENDING and never claimed (revision 0, no external id),
 *      i.e. provably never sent. Conditional on exactly that, so a processor claiming one between the read
 *      and the write makes the mark refuse rather than cancel a row in flight. Their mirrored accounting
 *      events are voided as SOURCE-CANCELLED (never revivable) under the settlement guard.
 *   3. RESOLVE the refusal row as `handled_manually`, recording who and the note, and set `suppressedAt`,
 *      which the primitive reads from then on. Conditional on the row still being outstanding and of a
 *      markable kind, so two submits resolve it once.
 *
 * REOPENING: a posting marked handled stays handled. A later refusal of the same key is reported and not
 * recorded (recordAccountingPostingRefusal), and every later automatic enqueue of it is refused as already
 * handled by hand, so there is no second debt to reopen.
 */
export type MarkHandledClient = PostingSuppressionClient & {
  accountingPostingRefusal: {
    findUnique(args: { where: { id: string }; select: Record<string, true> }): Promise<{
      id: string; type: string; referenceType: string; referenceId: string; scope: string
      kind: string | null; resolvedAt: Date | null
      /** o3d-j625 r16: who is settling this posting by hand right now, and since when. NULL = nobody. */
      handPostClaimedAt?: Date | null; handPostClaimedBy?: string | null
    } | null>
    updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>
  }
  accountingSyncLog: {
    findMany(args: { where: Record<string, unknown>; select: Record<string, true> }): Promise<Array<{
      id: string; connector: string; status: string; attemptRevision: number | null
      externalTransactionId: string | null; payload: unknown
    }>>
    updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>
  }
}

export type MarkHandledResult =
  /**
   * o3d-j625 r13: `suppressed` says whether IMS will refuse this posting FOR EVER (the ordinary case) or
   * only stop retrying the edit just posted by hand (a reused posting key — see the note at the write).
   * Returned rather than inferred, because the operator-facing sentence differs and a caller cannot
   * re-derive it without re-implementing the rule.
   */
  | { ok: true; cancelledSyncRows: string[]; kind: PostingRefusalKind; suppressed: boolean }
  /**
   * o3d-j625 r16 (Codex round 15, HIGH 1) — `not_claimed` and `claimed_by_other` are the two answers the
   * CLAIM added. A hand posting is only safe if IMS was standing back while it was made, so the mark asks
   * for the claim that establishes that, and names the holder when somebody else has it.
   */
  | {
      ok: false
      code: 'not_found' | 'already_resolved' | 'not_markable' | 'may_be_posted' | 'not_claimed' | 'claimed_by_other'
      message: string
      claimedBy?: string | null
      claimedAt?: Date | null
    }

/**
 * THROWN (not returned) when the state moved under the mark after it had started writing — so the caller's
 * transaction ROLLS BACK and no row is left half-cancelled. Every other refusal happens before any write
 * and is returned.
 */
export class MarkHandledRaceError extends Error {
  constructor() {
    super('This posting changed while it was being marked (it was resolved, or IMS picked it up). Refresh and look again.')
    this.name = 'MarkHandledRaceError'
  }
}

/**
 * ── IS THIS SYNC ROW PROVABLY UNSENT? ──
 *
 * PENDING, never claimed by a processor (revision 0) and carrying no external id. Anything else may
 * already be in the ledger — SYNCED and FAILED both mean a call was made, PROCESSING means one is in
 * flight, a claimed PENDING row may have been sent and put back for a retry — and the mark refuses those
 * rather than guessing, because guessing is how a posting reaches the ledger twice.
 *
 * o3d-j625 r14 (Codex, HIGH) — EXPORTED, because the EXCEPTION INBOX now has to ask the same question.
 *
 * The inbox lists a refusal whose posting key has a live row (r12 keeps the debt when it cannot prove the
 * posting was queued after the refusal), and it used to render the refusing site's "post it by hand"
 * remedy for it. Codex's finding is that the remedy instructs the operator into a duplicate: the worker
 * can post the PENDING row while they are in the ledger posting it by hand, and the mark's guard — this
 * predicate — only fires when they come BACK to mark, which is after the damage. So the inbox has to
 * classify the row before it writes an instruction, and it must classify it with THIS predicate rather
 * than a second copy: "provably unsent" decides whether the safe order is "mark first, then post" (the
 * mark cancels it) or "settle the sync log first" (the mark will refuse), and two spellings of that rule
 * would eventually disagree about which instruction an operator is given.
 */
export function accountingSyncRowIsProvablyUnsent(sync: {
  status: string
  attemptRevision: number | null
  externalTransactionId: string | null
}): boolean {
  return sync.status === 'PENDING'
    && sync.attemptRevision === UNCLAIMED_ATTEMPT_REVISION
    && !sync.externalTransactionId
}

/**
 * ── IS THIS ROW SETTLED HISTORY — a posting that ALREADY HAPPENED and was a DIFFERENT ONE? ──
 *
 * o3d-j625 r16 (Codex round 15, HIGH 2). r14 asked one question of every row under a refusal's posting
 * key: "is it provably unsent?" — and treated every other answer as "IMS may already have posted THIS".
 * For nearly every type that is right, because the key names ONE posting for ever, so any row under it is
 * a row for the posting in hand.
 *
 * Three types share their key across successive DISTINCT postings by design
 * (`postingKeyIsReusedAcrossPostings`: SALES_INVOICE_UPDATE, PURCHASE_INVOICE_UPDATE, BILL_PAYMENT — the
 * key names the OBLIGATION "the ledger holds the current version of this document"). On those, a row that
 * has already completed posted an EARLIER edit, and Codex executed what that cost: edit 1 posts, edit 2 is
 * refused, and the mark then refuses `may_be_posted` INDEFINITELY, sending the operator to settle a row
 * that is not settleable — it succeeded. The newly refused edit had no remedy at all.
 *
 * SO THE QUESTION IS "COULD THIS ROW POST *THIS* REFUSAL", AND BOTH HALVES OF THE ANSWER ALREADY EXIST:
 *
 *   · `isPostableAccountingSyncStatus` (postable-sync-statuses.ts) — the statuses from which a remote
 *     document CAN STILL BE POSTED, i.e. PENDING / PROCESSING / FAILED. It says of the other two, in its
 *     own words: "SYNCED and CANCELLED are excluded because no claim can succeed against them: they are
 *     outcomes, not work." A row in an outcome status cannot post anything in the future.
 *   · `postingKeyIsReusedAcrossPostings` (posting-key.ts) — whether a completed row under this key is
 *     therefore a DIFFERENT posting from the one refused. It is, because the refusal in hand exists
 *     precisely because its own posting was NOT queued, so no row under the key is its row.
 *
 * Both have to hold. On a key that is NOT reused, a completed row may be this very posting — a false debt
 * round 12 deliberately keeps — and it still blocks, which is the direction that cannot duplicate a
 * posting. THIS IS NOT A WIDENING OF `accountingSyncRowIsProvablyUnsent`: a settled-history row is not
 * cancelled and not claimed either. It is excluded from the question, and REPORTED instead
 * (`earlierPostings`), so the operator is told what the ledger already holds under this obligation rather
 * than having it silently ignored.
 */
export function accountingSyncRowPostedAnEarlierPosting(sync: { type: string; status: string }): boolean {
  return !isPostableAccountingSyncStatus(sync.status) && postingKeyIsReusedAcrossPostings(sync.type)
}

/** The rows under one posting key, split by what each one can still do. */
type PostingKeyRows = {
  /** Rows that may already be in the ledger or may still post THIS posting. Nothing may be marked while one stands. */
  blocking: PostingKeyRow[]
  /** Provably unsent rows: PENDING, never claimed, no document id. Cancelled by the claim / the mark. */
  cancellable: PostingKeyRow[]
  /** Completed postings of an EARLIER posting on a reused key. Neither blocking nor cancellable — reported. */
  earlier: PostingKeyRow[]
}
type PostingKeyRow = {
  id: string; connector: string; status: string; attemptRevision: number | null
  externalTransactionId: string | null; payload: unknown
}

/**
 * Read every non-cancelled sync row for this POSTING (not merely this document — `accountingPostingKeyForRow`
 * is the same function the row-creating primitive keys its clear on) and classify it. ONE place, because the
 * claim, the mark and the inbox's own instruction must not be able to disagree about which rows matter.
 */
async function postingKeyRows(tx: MarkHandledClient, key: { type: string; referenceType: string; referenceId: string; scope: string }): Promise<PostingKeyRows> {
  const candidates = (await tx.accountingSyncLog.findMany({
    where: { type: key.type, referenceType: key.referenceType, referenceId: key.referenceId, status: { not: 'CANCELLED' } },
    select: { id: true, connector: true, status: true, attemptRevision: true, externalTransactionId: true, payload: true },
  })).filter((sync) => accountingPostingKeyForRow({ ...key, payload: sync.payload }).scope === key.scope)
  const earlier = candidates.filter((sync) => accountingSyncRowPostedAnEarlierPosting({ type: key.type, status: sync.status }))
  const couldPost = candidates.filter((sync) => !earlier.includes(sync))
  return {
    earlier,
    blocking: couldPost.filter((sync) => !accountingSyncRowIsProvablyUnsent(sync)),
    cancellable: couldPost.filter((sync) => accountingSyncRowIsProvablyUnsent(sync)),
  }
}

/** The one sentence both the claim and the mark refuse with, so an operator cannot read two accounts of it. */
function mayBePostedMessage(rows: PostingKeyRows): string {
  return 'IMS may already have posted this, or be posting it now — accounting sync '
    + `${rows.blocking.map((sync) => `row ${sync.id} is ${sync.status}${sync.externalTransactionId ? ` with document ${sync.externalTransactionId}` : ''}`).join('; ')}. `
    + 'Check the ledger and settle that row in the accounting sync log first; marking this handled now could '
    + 'post it twice.'
}

/**
 * Cancel the provably-unsent rows and void their mirrored events, CONDITIONAL on exactly the state that
 * made them provably unsent — so a processor claiming one between the read and the write makes this throw
 * (the caller's transaction rolls back) rather than cancel a row in flight.
 */
async function cancelProvablyUnsentRows(
  tx: MarkHandledClient,
  key: { type: string; referenceType: string; referenceId: string; scope: string },
  rows: PostingKeyRow[],
  note: string,
): Promise<string[]> {
  const ids = rows.map((sync) => sync.id)
  if (ids.length === 0) return []
  const cancelled = await tx.accountingSyncLog.updateMany({
    where: { id: { in: ids }, status: 'PENDING', attemptRevision: UNCLAIMED_ATTEMPT_REVISION, externalTransactionId: null },
    data: { status: 'CANCELLED', errorMessage: note, processingStartedAt: null },
  })
  if (cancelled.count !== ids.length) throw new MarkHandledRaceError()
  for (const sync of rows) {
    const mirror = await updateMirroredAccountingEventStatus(tx as unknown as Prisma.TransactionClient, {
      connector: sync.connector,
      syncLogId: sync.id,
      type: key.type,
      referenceType: key.referenceType,
      referenceId: key.referenceId,
      payload: sync.payload,
      status: 'VOID',
      voidBasis: SOURCE_CANCELLED_VOID_BASIS,
      message: note,
      guard: settlementMirrorGuard(),
    })
    if (mirror === 'refused') throw new MarkHandledRaceError()
  }
  return ids
}

const REFUSAL_SELECT = {
  id: true, type: true, referenceType: true, referenceId: true, scope: true, kind: true, resolvedAt: true,
  handPostClaimedAt: true, handPostClaimedBy: true,
} as const

type LoadedRefusal = NonNullable<Awaited<ReturnType<MarkHandledClient['accountingPostingRefusal']['findUnique']>>>

/**
 * The checks every hand-posting act shares, and the LOCK between them: read the row for its posting key,
 * take the key's advisory lock, then RE-READ under it. The second read is the authoritative one — the first
 * exists only to learn which key to lock — so two operators, or an operator and a mark, are serialised by
 * PostgreSQL rather than by the order their reads happened to land in.
 */
async function loadRefusalUnderItsKey(
  tx: MarkHandledClient,
  id: string,
): Promise<
  | { ok: false; result: Extract<MarkHandledResult, { ok: false }> }
  | { ok: true; row: LoadedRefusal; key: { type: string; referenceType: string; referenceId: string; scope: string } }
> {
  const first = await tx.accountingPostingRefusal.findUnique({ where: { id }, select: REFUSAL_SELECT })
  if (!first) return { ok: false, result: { ok: false, code: 'not_found', message: 'This refused posting no longer exists.' } }
  const key = { type: first.type, referenceType: first.referenceType, referenceId: first.referenceId, scope: first.scope }
  await lockPostingKey(tx, key)
  const row = await tx.accountingPostingRefusal.findUnique({ where: { id }, select: REFUSAL_SELECT }) ?? first
  if (row.resolvedAt) return { ok: false, result: { ok: false, code: 'already_resolved', message: 'This refused posting is already resolved.' } }
  if (!postingRefusalMarkable(row.kind)) {
    return {
      ok: false,
      result: {
        ok: false,
        code: 'not_markable',
        message: row.kind && row.kind in POSTING_REFUSAL_KINDS
          ? `IMS clears this row itself when the posting is queued, so it cannot be marked handled. ${POSTING_REFUSAL_KINDS[row.kind as PostingRefusalKind].how}`
          : 'This row does not say which kind of refusal it is, so it cannot be marked handled.',
      },
    }
  }
  return { ok: true, row, key }
}

function claimedByOther(row: LoadedRefusal): Extract<MarkHandledResult, { ok: false }> {
  return {
    ok: false,
    code: 'claimed_by_other',
    claimedBy: row.handPostClaimedBy ?? null,
    claimedAt: row.handPostClaimedAt ?? null,
    message:
      'Another operator is settling this posting by hand — they took it '
      + `${row.handPostClaimedAt ? `at ${row.handPostClaimedAt.toISOString()}` : 'already'}. `
      + 'Do not post it as well: while they hold it IMS will not queue it, and when they confirm it the row '
      + 'closes. If they are not going to, release their claim first.',
  }
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════════════
 * o3d-j625 r16 (Codex round 15, HIGH 1) — TAKE THIS REFUSED POSTING FOR HAND POSTING
 * ══════════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE FINDING. r12 keeps a debt it cannot prove was discharged; r14 stopped the inbox from telling an
 * operator to post by hand while a live row for the same posting existed. Round 15 pointed at the case with
 * NO live row — the ordinary one — and at the only mechanism r14 had: a sentence. An operator reads the
 * page and acts twenty minutes later; in between, a second operator re-queues the posting (or any of the
 * sweeps does), the worker posts it, and the ledger has it twice. `markPostingHandled` refuses when they
 * come back, which is after the damage. A render-time classification narrows that interval. It does not
 * remove it, and calling it prevention is the mischaracterisation round 15 caught.
 *
 * THE FIX IS A CLAIM, NOT A BETTER SENTENCE. This function is what an operator does BEFORE going to the
 * ledger, and in ONE transaction under the posting key's advisory lock it:
 *
 *   1. REFUSES if any row for the key may already have been sent (`blocking`) — the same guard, the same
 *      words, run before the ledger write instead of after it. The operator is sent to the accounting sync
 *      log, which is the surface that owns that ambiguity.
 *   2. CANCELS every provably-unsent row, conditionally on exactly what made it provably unsent, so a
 *      processor claiming one at that instant makes this roll back rather than cancel a row in flight.
 *   3. WRITES THE CLAIM, conditionally on `handPostClaimedAt` being NULL. From that commit on,
 *      `readPostingSuppression` reports the key as one IMS must not queue, and every creation of an
 *      accounting sync row goes through `createAccountingSyncLogRow`, which asks it under this same lock
 *      (the primitive census, tests/accounting/sync-log-row-primitive.test.ts, is what makes "every" true).
 *
 * WHAT HAPPENS TO AN OPERATOR WHO READS THE PAGE AND ACTS TWENTY MINUTES LATER. Their first act is this
 * one, and it is decided against the state as it is THEN, under the lock — not against the page. If a row
 * appeared meanwhile that may have been sent, they are refused and told where to look; if an unsent row
 * appeared, it is cancelled. A stale page can therefore produce a refusal, never a duplicate.
 *
 * WHAT HAPPENS TO TWO OPERATORS ON THE SAME REFUSAL AT ONCE. They serialise on the key's lock. The first
 * writes the claim; the second's conditional write matches no row and it is told, by name, who is settling
 * it. Only one of them can be in the ledger on IMS's instruction.
 *
 * THE WINDOW THAT REMAINS, stated as a window and not as a residual risk: from the moment the claim is
 * RELEASED (`releasePostingHandPostClaim`) IMS may queue and post the posting again. If the holder posted
 * it by hand and then released instead of confirming, that is a duplicate — but it is one explicit human
 * action, taken against an explicit warning, not a race, and it is the only way out of a claim nobody is
 * going to finish. There is no expiry: a claim never times out, because a claim that lapsed on a timer
 * would re-open exactly the interval this closes. The claim is visible on the outstanding row instead.
 *
 * WHY NOT "one action that does the cancel and the acknowledgement together". Because the acknowledgement
 * is of something IMS does not do: the ledger write happens in the operator's browser, minutes later, so
 * "one transaction" could only mean marking handled BEFORE posting. That leaves the same interval between
 * the mark's commit and the ledger write — and on a REUSED posting key r13 deliberately writes NO
 * suppression, so during that interval a new edit can be queued and posted. A claim covers exactly that
 * interval and can be given back; a mark cannot.
 */
export type HandPostClaimResult =
  | { ok: true; cancelledSyncRows: string[]; claimedAt: Date; earlierPostings: string[] }
  | Extract<MarkHandledResult, { ok: false }>

export async function claimPostingForHandPosting(
  tx: MarkHandledClient,
  params: { id: string; userId: string; now?: Date },
): Promise<HandPostClaimResult> {
  const now = params.now ?? new Date()
  const loaded = await loadRefusalUnderItsKey(tx, params.id)
  if (!loaded.ok) return loaded.result
  const { row, key } = loaded
  if (row.handPostClaimedAt) {
    // Idempotent for the holder: pressing it twice must not read as somebody else's claim.
    if (row.handPostClaimedBy === params.userId) {
      return { ok: true, cancelledSyncRows: [], claimedAt: row.handPostClaimedAt, earlierPostings: [] }
    }
    return claimedByOther(row)
  }
  const rows = await postingKeyRows(tx, key)
  if (rows.blocking.length > 0) return { ok: false, code: 'may_be_posted', message: mayBePostedMessage(rows) }
  const cancelledSyncRows = await cancelProvablyUnsentRows(
    tx, key, rows.cancellable,
    'Cancelled: an operator took this refused posting to settle it by hand, so IMS must not post it too.',
  )
  const claimed = await tx.accountingPostingRefusal.updateMany({
    where: { id: row.id, resolvedAt: null, handPostClaimedAt: null },
    data: { handPostClaimedAt: now, handPostClaimedBy: params.userId },
  })
  // Not a `claimed_by_other`: the row was unclaimed under this lock a statement ago, so a zero count means
  // the row moved in a way this transaction cannot describe. Thrown, so the cancellations roll back with it.
  if (claimed.count === 0) throw new MarkHandledRaceError()
  return {
    ok: true,
    cancelledSyncRows,
    claimedAt: now,
    earlierPostings: rows.earlier.map((sync) => sync.externalTransactionId ?? sync.id),
  }
}

/**
 * GIVE THE CLAIM BACK. The refusal stays outstanding and IMS may queue the posting again from here on, so
 * this is the one act that re-opens the interval the claim closed — the caller warns about it, and the
 * activity entry it writes says what was given up.
 *
 * Anybody may release anybody's claim, deliberately: the alternative is an outstanding posting nobody can
 * ever settle because the person who took it has gone. Who held it is returned so the caller can say so.
 */
export type HandPostReleaseResult =
  | { ok: true; releasedFrom: string | null; heldSince: Date }
  | Extract<MarkHandledResult, { ok: false }>
  | { ok: false; code: 'not_claimed'; message: string }

export async function releasePostingHandPostClaim(
  tx: MarkHandledClient,
  params: { id: string },
): Promise<HandPostReleaseResult> {
  const loaded = await loadRefusalUnderItsKey(tx, params.id)
  if (!loaded.ok) return loaded.result
  const { row } = loaded
  if (!row.handPostClaimedAt) {
    return { ok: false, code: 'not_claimed', message: 'Nobody is settling this posting by hand, so there is no claim to release.' }
  }
  const released = await tx.accountingPostingRefusal.updateMany({
    where: { id: row.id, resolvedAt: null, handPostClaimedAt: { not: null } },
    data: { handPostClaimedAt: null, handPostClaimedBy: null },
  })
  if (released.count === 0) throw new MarkHandledRaceError()
  return { ok: true, releasedFrom: row.handPostClaimedBy ?? null, heldSince: row.handPostClaimedAt }
}

export async function markPostingHandled(
  tx: MarkHandledClient,
  params: { id: string; userId: string; note: string | null; now?: Date },
): Promise<MarkHandledResult> {
  const now = params.now ?? new Date()
  const loaded = await loadRefusalUnderItsKey(tx, params.id)
  if (!loaded.ok) return loaded.result
  const { row, key } = loaded

  /**
   * o3d-j625 r16 (Codex round 15, HIGH 1) — THE MARK IS THE SECOND HALF OF AN ACT, NOT THE WHOLE OF IT.
   *
   * "I posted this by hand" can only be safe if IMS was standing back WHILE it was posted, and the only
   * thing that establishes that is the claim (`claimPostingForHandPosting`). Refusing the mark without one
   * is what turns the ordering from an instruction an operator may read late, or not at all, into a
   * mechanism: there is no path on which a hand posting is recorded over an interval IMS was free to post
   * in. It is also why the message names the act rather than scolding — the operator has just done the
   * ledger work and needs the way forward.
   */
  if (!row.handPostClaimedAt) {
    return {
      ok: false,
      code: 'not_claimed',
      message:
        'Take this posting for hand posting FIRST — that is what stops IMS queueing it while you are in the '
        + 'ledger. Press "Take for hand posting" (it cancels any queued row that nothing has picked up, and '
        + 'refuses if one may already have been sent), then post it, then mark it handled. If you have '
        + 'already posted it, take it now and check the accounting sync log for a row IMS queued meanwhile.',
    }
  }
  if (row.handPostClaimedBy !== params.userId) return claimedByOther(row)

  // Still asked, with the claim held: the claim stops every path that goes through the row-creating
  // primitive, and this is what would catch one that did not.
  const rows = await postingKeyRows(tx, key)
  if (rows.blocking.length > 0) return { ok: false, code: 'may_be_posted', message: mayBePostedMessage(rows) }

  const note = `Cancelled: marked handled — posted by hand${params.note ? ` (${params.note})` : ''}.`
  const cancelIds = await cancelProvablyUnsentRows(tx, key, rows.cancellable, note)
  const markableKinds = (Object.keys(POSTING_REFUSAL_KINDS) as PostingRefusalKind[]).filter((kind) => postingRefusalMarkable(kind))
  /**
   * ── o3d-j625 r13 (independent review, HIGH) — THE SUPPRESSION IS NOT WRITTEN ON A REUSED POSTING KEY ──
   *
   * `suppressedAt` is written here and cleared NOWHERE (the migration says so: "set once by the mark,
   * never cleared"), and it is keyed on the POSTING KEY. For nearly every type that key names one posting
   * for ever, so "IMS will never post this" is exactly the operator's assertion made durable.
   *
   * For the three types whose key is REUSED by successive distinct postings
   * (`postingKeyIsReusedAcrossPostings` — SALES_INVOICE_UPDATE, PURCHASE_INVOICE_UPDATE, BILL_PAYMENT) it
   * is a one-way door across every FUTURE posting. The review executed it: mark one refusal handled, let
   * the cause clear, edit the bill again — the new edit is suppressed silently, the enqueue answers
   * `handled-by-hand`, `purchaseInvoiceUpdateIsOwed('queued')` is false, and a transit-subledger movement
   * is written for a GL journal that was never queued. IMS holds edit n, the ledger holds edit 1, and
   * nothing anywhere says so. That is the divergence enqueue-outcome.ts calls the worst outcome in the
   * issue, reached through the remedy for it.
   *
   * WHY NOT-SUPPRESSING IS SAFE FOR EXACTLY THESE TYPES, which is what makes this the fix rather than a
   * trade. Suppression exists to stop IMS posting a SECOND ledger entry beside the one a human made. All
   * three of these postings OVERWRITE a document the ledger already holds — the Xero bill update replaces
   * the bill (see the transit note in purchase-invoice-update-sync.ts), the invoice update replaces the
   * invoice, and a bill payment settles an already-settled bill — so applying one again writes the same
   * state rather than a second entry. The harm suppression prevents cannot arise; the harm it causes is
   * real, silent and permanent. Every other markable kind is CREATE-shaped and still suppresses.
   *
   * THE ROW IS STILL RESOLVED, and the pending row is still cancelled: the operator's assertion is
   * recorded, the debt is closed, and IMS does not re-post the edit they just posted by hand. What changes
   * is only that a LATER, DIFFERENT posting on the same key is queued as usual — which is what the ledger
   * needs, and what `clearing: 'retried'` already promises for these kinds ("Re-saving the bill queues the
   * update again").
   */
  const keyIsReused = postingKeyIsReusedAcrossPostings(row.type)
  const resolved = await tx.accountingPostingRefusal.updateMany({
    where: { id: row.id, resolvedAt: null, kind: { in: markableKinds } },
    data: {
      resolvedAt: now,
      resolution: 'handled_manually',
      resolvedBy: params.userId,
      resolutionNote: params.note,
      ...(keyIsReused ? {} : { suppressedAt: now }),
      /**
       * o3d-j625 r16 — AND THE CLAIM IS GIVEN BACK HERE, which matters most on exactly the keys the block
       * above declines to suppress. On a reused key the claim is the ONLY thing standing between IMS and
       * the next edit of this document; leaving it set would suppress every future edit silently, which is
       * the r13 finding reintroduced through the r16 remedy. On a key that IS suppressed it is redundant,
       * and cleared anyway so that "claimed" never outlives the act it described.
       */
      handPostClaimedAt: null,
      handPostClaimedBy: null,
    },
  })
  if (resolved.count === 0) throw new MarkHandledRaceError()
  return { ok: true, cancelledSyncRows: cancelIds, kind: row.kind as PostingRefusalKind, suppressed: !keyIsReused }
}
