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

export function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?])\s+(?=[A-Z"'(])/).map((sentence) => sentence.trim()).filter(Boolean)
}

/** The sentences that give a money instruction without conditioning it on the document existing. */
export function unconditionalMoneySentences(text: string): string[] {
  return sentencesOf(text).filter((sentence) => MONEY_WORD.test(sentence) && !CONDITIONAL.test(sentence))
}

/** A negative control: proves the checker CAN fail (it flags the round-2 shape). */
export const ROUND_2_SHAPE =
  'Reverse it ONLY if it exists there (if it does not exist there is nothing to reverse); a journal cannot be un-posted '
  + 'from here, so then cancel the order and have finance reverse the batch entry.'
