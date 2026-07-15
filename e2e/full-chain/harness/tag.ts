/**
 * Run tagging for the full-chain suite (o3d-lgo.4).
 *
 * Every artefact a run creates — Woo SKUs and order refs, IMS records, Xero document
 * References — carries the same tag. That is what lets teardown find its own work, and
 * what lets a human tell "this run's rubbish" from "someone else's" in a SHARED Woo
 * store and a SHARED Xero Demo ledger. Without it, a failed teardown is unrecoverable
 * by anything except a Demo reset.
 *
 * Tags are deliberately greppable and obviously synthetic, so a stray one in a real
 * ledger reads as test residue rather than a real customer order.
 */

/** e.g. E2E-FC-1a2b3c4d — stable for the life of one suite run. */
export function newRunId(): string {
  // Time-ordered prefix so tags sort chronologically when sweeping stragglers, plus
  // randomness so two concurrent runs (which should not happen, but might) cannot collide.
  const t = Date.now().toString(36)
  const r = Math.random().toString(36).slice(2, 6)
  return `${t}${r}`
}

export const TAG_PREFIX = 'E2E-FC'

/** The tag for a run: E2E-FC-<runId>. */
export function runTag(runId: string): string {
  return `${TAG_PREFIX}-${runId}`
}

/** A tagged, unique-per-call SKU. */
export function taggedSku(runId: string, label: string): string {
  return `${TAG_PREFIX}-${runId}-${label}`.toUpperCase().slice(0, 60)
}

/** True when a name/reference belongs to ANY full-chain run (not just this one). */
export function isFullChainArtefact(value: string | null | undefined): boolean {
  return !!value && value.includes(TAG_PREFIX)
}

/** True when it belongs to THIS run. */
export function isThisRun(value: string | null | undefined, runId: string): boolean {
  return !!value && value.includes(runTag(runId))
}
