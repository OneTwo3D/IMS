import { describeEarlierPostings, describeRetiredUnproven, type EarlierPosting } from '@/lib/domain/accounting/posting-mark-handled'

/**
 * ── o3d-j625 r16 — WHAT TO DO *FIRST*, for a refusal a person can close by hand ──
 *
 * The refusing site's own remedy is rendered verbatim beside this, always; this is the ORDER, and it exists
 * because the order is the whole of the safety argument. r14 wrote it by rewriting the site's remedy, which
 * cost round 12's property its exactness for no gain — the two sentences answer different questions and are
 * now two fields.
 *
 * Every branch names an ACT, not a caution, because the act is what closes the interval: taking the posting
 * for hand posting is a transaction that cancels the unsent rows and stops IMS queueing it, so an operator
 * who takes it and then spends twenty minutes in the ledger cannot be overtaken.
 */
/**
 * The primary instruction for a posting whose CURRENT version is in doubt AND for which an earlier document exists. Every branch is
 * conditional, and the earlier version alone satisfies only the middle one. 'update' = an edit of one document; 'payment' = a bill
 * payment (an earlier payment does not discharge this one); anything else cannot have an earlier document (the key is not reused).
 */
function combinedStep(type: string | undefined): string {
  if (type === 'BILL_PAYMENT') {
    return 'check the ledger for the CURRENT payment (the one this refused posting would have registered, not the earlier payment): '
      + 'if the current payment is there, do not post again; if only the earlier payment is there, register this payment as a new one '
      + '(the earlier payment does not discharge it); if nothing is there, post it as a new payment.'
  }
  return 'check the ledger for the CURRENT version (the one this refused posting would have made, not the earlier version): '
    + 'if the current version is there, do not post again; if only the earlier version is there, apply the update to it (it updates '
    + 'that earlier document; do not raise a second one); if nothing is there, post it as a new document.'
}

export function handPostOrderFor(state: {
  queuedRow: 'unsent' | 'may-be-sent' | null
  earlierPostingDetails: EarlierPosting[]
  retiredUnproven: string[]
  /** The refused posting's type: tells an UPDATE (edit of one document) from a PAYMENT from anything else. */
  type?: string
  claim: { at: string; byName: string | null; mine: boolean } | null
}): string {
  const earlier = describeEarlierPostings(state.earlierPostingDetails)
  // o3d-1e7sl (C1): earlier attempts retired without proof are never "nothing posted". Appended to every
  // branch the operator can still act on, because each of them ends in a hand posting.
  const earlierExists = state.earlierPostingDetails.length > 0
  const retired = describeRetiredUnproven(state.retiredUnproven, { earlierDocumentExists: earlierExists })
  // Codex round 4: for ANY retired-unproven attempt the PRIMARY hand-post instruction is itself conditional. The
  // retired attempt may have reached the ledger, so "post it now" would raise a DUPLICATE; the check comes first and
  // the post is ONLY for an absent document. (An appended caution after an unconditional "post it" is not a condition.)
  const hasRetired = state.retiredUnproven.length > 0
  // Codex round 6: an earlier posting the ledger did NOT confirm is the same hazard from the other side: the hand posting
  // REPLACES it only if it exists. The primary instruction is conditional on that too.
  const hasUnverifiedEarlier = state.earlierPostingDetails.some((e) => e.standing !== 'CONFIRMED_POSTED')
  // Codex round 7 - THREE THINGS, NEVER ONE: the retired unproven attempt (may or may not have posted THE CURRENT update), the
  // earlier document (version N, any standing) and the refused newer update (version N+1, what is owed). When an earlier
  // document exists AND the current one is in doubt (a retired attempt, or an earlier row the ledger did not confirm), the
  // earlier document alone must never satisfy "do not post again": the check is for the CURRENT version.
  const combined = earlierExists && (hasRetired || hasUnverifiedEarlier)
  const currentVersionStep = combinedStep(state.type)
  const postStep = combined
    ? currentVersionStep
    : hasRetired
    ? 'check the ledger for that document first; post it ONLY if it is absent. If it exists, do not post again - just'
    : hasUnverifiedEarlier
      ? 'check the ledger for the earlier document first. If it exists there, update that document rather than raising a second one; if it is absent, post this as a new document. Then'
      : 'post it in the ledger now, then'
  if (state.claim?.mine) {
    return 'YOU are settling this by hand. IMS will not queue this posting while you hold it, so take your '
      + `time: ${postStep} ${combined ? 'Press "Mark as handled" only once the CURRENT version is in the ledger, to confirm it and close this row.' : 'press "Mark as handled" to confirm it and close this row.'} If `
      + 'you are not going to post it, press "Release" — IMS may then queue it again.'
      + earlier
      + retired
  }
  if (state.claim) {
    return `${state.claim.byName ?? 'Another operator'} is settling this by hand (taken ${state.claim.at}). `
      + 'Do NOT post it as well. IMS will not queue it while they hold it, and the row closes when they '
      + 'confirm. If they are not going to finish, release their claim first.'
      + earlier
  }
  if (state.queuedRow === 'may-be-sent') {
    return 'DO NOT POST THIS BY HAND. IMS may ALREADY have posted this — its accounting sync row is in '
      + 'flight, has been claimed by a processor, or carries a document id — so posting it now is how the '
      + 'ledger gets it twice. Find this posting in the accounting sync log and settle THAT row first; '
      + 'taking it for hand posting will refuse until you do.'
      + earlier
  }
  return 'DO NOT POST THIS BY HAND YET. Press "Take for hand posting" FIRST. That is one transaction which '
    + (state.queuedRow === 'unsent'
      ? 'cancels the queued row IMS is holding for this posting (nothing has picked it up yet), refuses if '
        + 'any row may already have been sent, '
      : 'refuses if any row for this posting may already have been sent, cancels any that provably has not, ')
    + 'and stops IMS queueing this posting at all while you hold it — so IMS cannot send it behind you '
    + 'while you are in the ledger. '
    + (combined
      ? `Then ${currentVersionStep} Press "Mark as handled" only once the CURRENT version is in the ledger.`
      : hasRetired
      ? 'Then check the ledger for that document first; post it ONLY if it is absent. If it exists, do not post again - just press "Mark as handled".'
      : hasUnverifiedEarlier
        ? 'Then check the ledger for the earlier document first. If it exists there, update that document rather than raising a second one; if it is absent, post this as a new document. Then press "Mark as handled".'
        : 'Then post it, then press "Mark as handled".')
    + earlier
    + retired
}

