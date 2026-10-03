import { describeRetiredUnproven } from '@/lib/domain/accounting/posting-mark-handled'

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
export function handPostOrderFor(state: {
  queuedRow: 'unsent' | 'may-be-sent' | null
  earlierPostings: string[]
  retiredUnproven: string[]
  claim: { at: string; byName: string | null; mine: boolean } | null
}): string {
  const earlier = state.earlierPostings.length > 0
    ? ' The ledger ALREADY holds '
      + `${state.earlierPostings.join(', ')} for this obligation, from an earlier version of this document — `
      + 'your hand posting REPLACES that document; do not raise a second one.'
    : ''
  // o3d-1e7sl (C1): earlier attempts retired without proof are never "nothing posted". Appended to every
  // branch the operator can still act on, because each of them ends in a hand posting.
  const retired = describeRetiredUnproven(state.retiredUnproven)
  // Codex round 4: for ANY retired-unproven attempt the PRIMARY hand-post instruction is itself conditional. The
  // retired attempt may have reached the ledger, so "post it now" would raise a DUPLICATE; the check comes first and
  // the post is ONLY for an absent document. (An appended caution after an unconditional "post it" is not a condition.)
  const hasRetired = state.retiredUnproven.length > 0
  const postStep = hasRetired
    ? 'check the ledger for that document first; post it ONLY if it is absent. If it exists, do not post again - just'
    : 'post it in the ledger now, then'
  if (state.claim?.mine) {
    return 'YOU are settling this by hand. IMS will not queue this posting while you hold it, so take your '
      + `time: ${postStep} press "Mark as handled" to confirm it and close this row. If `
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
    + (hasRetired
      ? 'Then check the ledger for that document first; post it ONLY if it is absent. If it exists, do not post again - just press "Mark as handled".'
      : 'Then post it, then press "Mark as handled".')
    + earlier
    + retired
}

