/**
 * Explicit confirmation carried by a server action call, so a protection shown in a dialog is also
 * enforced where the action runs. A client that skips the dialog (or a stale bundle) is refused.
 *
 * Plain module, not a 'use server' file, so the pure helpers can be imported by client components
 * and tests as well as by the actions.
 */

export type ActionConfirmation = {
  /** Must be literally `true`; anything else is a refusal. */
  confirmed: true
  /** The name/code the operator typed, for actions that require typing the target. */
  typedName?: string
}

/** Bulk retry: the operator confirmed this many FAILED rows. */
export type BulkRetryConfirmation = ActionConfirmation & { expectedCount: number }

export const CONFIRMATION_REQUIRED_CODE = 'confirmation_required'

export function isExplicitlyConfirmed(confirmation: unknown): confirmation is ActionConfirmation {
  return (
    typeof confirmation === 'object'
    && confirmation !== null
    && (confirmation as { confirmed?: unknown }).confirmed === true
  )
}

/** Exact match after trimming surrounding whitespace. Case matters: codes and file names are case-sensitive. */
export function typedConfirmationMatches(typed: unknown, expected: string): boolean {
  return typeof typed === 'string' && expected.length > 0 && typed.trim() === expected
}

/**
 * Whether a confirm button may enable: every requirement the dialog set must be met, and nothing is
 * in flight. Lives here (not in the component) so the rule is testable without a browser.
 */
export function isConfirmReady(input: {
  typedExpected?: string
  typed: string
  acknowledgementRequired: boolean
  acknowledged: boolean
  pending: boolean
}): boolean {
  if (input.pending) return false
  if (input.typedExpected !== undefined && !typedConfirmationMatches(input.typed, input.typedExpected)) return false
  if (input.acknowledgementRequired && !input.acknowledged) return false
  return true
}
