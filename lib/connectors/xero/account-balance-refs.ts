/**
 * The provenance of a stored Xero balance, in its sourcePayloadRef. Kept in its own module (no database, no network)
 * so the reconciliation pack's as-of basis can read it without importing the pull.
 *
 * A row Xero returned carries the plain reference. A zero SYNTHESISED for a configured account that a NON-EMPTY Trial
 * Balance omitted carries the suffix, so a reader can tell "Xero reported this account at zero" from "Xero said nothing
 * about this account". It must never be read as an explicit zero.
 */
export const XERO_TRIAL_BALANCE_REF_PREFIX = 'xero:trial-balance:'
export const XERO_ABSENT_FROM_TB_REF_SUFFIX = ':absent-from-tb'

export function xeroTrialBalanceRef(balanceDate: string, absentFromTrialBalance: boolean): string {
  return `${XERO_TRIAL_BALANCE_REF_PREFIX}${balanceDate}${absentFromTrialBalance ? XERO_ABSENT_FROM_TB_REF_SUFFIX : ''}`
}
