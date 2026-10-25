/**
 * The provenance of a stored Xero balance, in its sourcePayloadRef. Kept in its own module (no database, no network)
 * so the reconciliation pack's as-of basis can read it without importing the pull. The pull writes the refs and the basis
 * reads them through this one definition.
 *
 * - `reported`: a row Xero returned carries the plain reference.
 * - `absent`: a zero SYNTHESISED for a configured account that a NON-EMPTY Trial Balance omitted, where the report did not
 *   prove itself complete. It must never be read as an explicit zero.
 * - `proven-absent`: the same synthesised zero, but the report proved itself complete (one Total SummaryRow whose value the
 *   sum of all rows' YTD Debit and YTD Credit equals exactly), so Xero's omission of a no-balance account is a true zero.
 *   It is only meaningful with the Trial Balance parser version that applies that proof.
 */
export const XERO_TRIAL_BALANCE_REF_PREFIX = 'xero:trial-balance:'
export const XERO_ABSENT_FROM_TB_REF_SUFFIX = ':absent-from-tb'
export const XERO_ABSENT_FROM_COMPLETE_TB_REF_SUFFIX = ':absent-from-complete-tb'

export type XeroTrialBalanceRefKind = 'reported' | 'absent' | 'proven-absent'

const SUFFIX: Record<XeroTrialBalanceRefKind, string> = {
  reported: '',
  absent: XERO_ABSENT_FROM_TB_REF_SUFFIX,
  'proven-absent': XERO_ABSENT_FROM_COMPLETE_TB_REF_SUFFIX,
}

export function xeroTrialBalanceRef(balanceDate: string, kind: XeroTrialBalanceRefKind): string {
  return `${XERO_TRIAL_BALANCE_REF_PREFIX}${balanceDate}${SUFFIX[kind]}`
}

/** The kind a stored reference says for this date, or null when it is none of the three. */
export function parseXeroTrialBalanceRef(balanceDate: string, ref: string | null | undefined): XeroTrialBalanceRefKind | null {
  for (const kind of ['reported', 'absent', 'proven-absent'] as const) if (ref === xeroTrialBalanceRef(balanceDate, kind)) return kind
  return null
}
