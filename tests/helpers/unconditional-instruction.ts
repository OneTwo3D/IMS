/**
 * o3d-1e7sl (Codex round 3) - THE UNIVERSAL CHECK FOR "AN UNCONDITIONAL MONEY INSTRUCTION ON A NON-CONFIRMED STANDING".
 *
 * An operator string attached to a standing the ledger did not confirm (asserted, unproven, queued) may mention
 * reversing / crediting / voiding / re-posting a document ONLY conditionally on the document existing: a reversal
 * of a journal that never posted is itself an erroneous entry. The definition is mechanical so it cannot be argued
 * away per string: split the COMPLETE rendered text into sentences; any sentence containing reverse | reversal |
 * credit | void | re-post | repost that does NOT also contain "only if", "if it exists" or "if it exist" is an
 * unconditional instruction. A universal ABSENCE check over the whole string: a conditional clause sitting beside an
 * unconditional one satisfies an existential check, which is the hole round 2 shipped through.
 */
const MONEY_WORD = /\b(reverse|reversed|reversal|credit|void|re-?post|repost)\b/i
const CONDITIONAL = /only if|if it exists?\b/i
/**
 * Codex round 4: the round-3 verb list could not see "post it in the ledger now". The POST-class verbs are matched
 * where they are AN INSTRUCTION (clause start, after a colon / comma / bracket, or after then / and / or / to / must /
 * should / can / may / just / now / you), never where they DESCRIBE ("did not post", "could post a second document",
 * "nothing will ever raise it"). Such a clause must say it applies ONLY if the document is absent, name the check
 * first, or be a prohibition ("do not post again"): a prohibition cannot create an entry.
 */
const POST_VERB = /(?:^|[:,(]\s*|\b(?:then|and|or|to|must|should|can|may|just|now|please|you|ONLY)\s+)(?:post|hand-post|raise|record|enter|book|remove|delete|adjust|write[- ]off|clear|re-?send|resend|retry)\b/i
const POST_CONDITIONAL = /only if|if it exists?\b|if (it is |it's |the document is |that is )?(absent|not there|missing)|if (it|the document|that|this) (is not|isn't|does not|doesn't)\b|unless|check[^.;]*\bfirst\b|first check|\bdo not\b|\bdon't\b|\bif the document is already\b|if nothing is there|if only the earlier [a-z]+ is there/i
/** The cause LABEL (a status name, not an instruction) is not a money word: "verified reversed". */
const LABELS = /verified reversed/gi

/**
 * Split into CLAUSES, not only sentences: a semicolon or a dash can join a conditional clause to an unconditional
 * one ("Reverse it ONLY if it exists; ... so then have finance reverse it"), and a sentence-level check would call
 * that whole sentence conditional - which is exactly the round-2 miss.
 */
export function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?;])\s+|\s+[—–]\s+|\s+-\s+(?=[a-z])|,\s+so\s+(?:then\s+)?/).map((sentence) => sentence.trim()).filter(Boolean)
}

/**
 * A POST-class instruction is one whose verb is NOT negated within the four words before it, or by IMS as the subject ("not going to post",
 * "decide not to post", "nothing can post", "will not post"): a negated verb is a prohibition or a description.
 */
function postInstruction(text: string): boolean {
  const match = POST_VERB.exec(text)
  if (!match) return false
  const before = text.slice(0, match.index + match[0].length)
  return !/\b(not|never|nothing|cannot|can't|won't|n't|refuse|refuses|IMS)\b(\W+\w+){0,4}\W+\w+$/i.test(before)
}

/** The sentences that give a money instruction without conditioning it on the document existing. */
export function unconditionalMoneySentences(text: string): string[] {
  return sentencesOf(text).filter((sentence) => {
    const text1 = sentence.replace(LABELS, 'verified-gone')
    return (MONEY_WORD.test(text1) && !CONDITIONAL.test(sentence)) || (postInstruction(text1) && !POST_CONDITIONAL.test(sentence))
  })
}

/** A negative control: proves the checker CAN fail (it flags the round-2 shape). */
/** Round-4 negative control: the unconditional hand-post shape the round-3 verb list could not see. */
export const ROUND_4_SHAPE =
  'IMS will not queue this posting while you hold it: post it in the ledger now, then press "Mark as handled".'

export const ROUND_2_SHAPE =
  'Reverse it ONLY if it exists there (if it does not exist there is nothing to reverse); a journal cannot be un-posted '
  + 'from here, so then cancel the order and have finance reverse the batch entry.'

/**
 * o3d-1e7sl Codex round 5 - FACTUAL HISTORY CLAIMS. A string may state what IMS or the connector did or did not do
 * ("made no call", "never asked", "never sent", "was not sent", "did not reach", "nothing was sent") ONLY when the
 * standing's cause PROVES it: the pre-call stamp (RECORDED_PRE_CALL), the row's own stored request (REJECTED_BEFORE_POSTING),
 * a verified reversal. Every other standing (asserted, unproven, queued, confirmed) licenses NO history claim about the
 * original attempt: an operator can settle a FAILED or PROCESSING attempt whose remote call SUCCEEDED and whose response
 * was lost. Negated and hedged forms ("does not prove nothing was posted", "may have been posted") are not claims.
 */
const HISTORY_CLAIM = /\b(made no call|nobody (called|read|compared|asked|checked)|no one (called|read|compared)|no call (was|has been) made|never (made|asked|sent|read|called|queried|reached|posted|saw)|(was|were|is|are|has been|have been) not (sent|posted|made|asked|read)|did not (reach|make|ask|read|send|call)|nothing (was|has been) (sent|posted|debited|made))\b/i
const NOT_A_CLAIM = /(not|never|no) (proof|proven|prove|evidence)[^.;:,—]*|does not (prove|say|show)[^.;:,—]*|cannot (say|tell|rule)[^.;:,—]*|can(not)? (still )?have[^.;:,—]*|may (well )?have[^.;:,—]*|would leave[^.;:,—]*|without proof[^.;:,—]*|not proof[^.;:,—]*|if (it|the document)[^.;:,—]*|could (not )?[^.;:,—]*/gi

/** The history claims a string makes that its cause does not license. `allowed` is the cause's licensed phrasing, or null for none. */
export function unlicensedHistoryClaims(text: string, allowed: RegExp | null): string[] {
  return sentencesOf(text.replace(NOT_A_CLAIM, ' ')).filter((clause) => {
    const m = HISTORY_CLAIM.exec(clause)
    if (!m) return false
    return !(allowed && allowed.test(clause))
  })
}
