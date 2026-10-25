/** The outcomes of the tax re-key plan (lib/tax/tax-rekey.ts), in a module with no imports so the settings panel (a client component) can show them. */
export const REKEY_OUTCOMES = ['ALREADY_CORRECT', 'REKEY', 'NO_MATCH', 'AMBIGUOUS', 'PERCENTAGE_DIFFERS', 'SIDE_NOT_ALLOWED', 'MEANING_DIFFERS', 'NAME_MATCHES_INACTIVE'] as const
export type RekeyOutcome = (typeof REKEY_OUTCOMES)[number]

export const REKEY_OUTCOME_MEANING: Record<RekeyOutcome, string> = {
  ALREADY_CORRECT: 'the code already points at the same-named, active, same-percentage live type',
  REKEY: 'one live type has the same name, status ACTIVE, the same percentage and a compatible country, under a different code: the rate is re-keyed to it',
  NO_MATCH: 'no live type has this name (or the only ones disagree on country): nothing is changed',
  AMBIGUOUS: 'more than one active live type has this name: which one is meant would be a guess; nothing is changed',
  PERCENTAGE_DIFFERS: 'the name matches an active live type whose percentage is not the IMS rate\'s: not re-keyed (fix the percentage first)',
  SIDE_NOT_ALLOWED: 'the name and percentage match but Xero does not allow the live type on a side the IMS rate is used for (revenue for sales, expenses for purchases): not re-keyed',
  MEANING_DIFFERS: 'the name and percentage match but the live type is built differently (component count, a component rate, compounding, or a non-recoverable component): the same tax meaning cannot be established, not re-keyed',
  NAME_MATCHES_INACTIVE: 'the only live types with this name are not ACTIVE in Xero: nothing is changed',
}

