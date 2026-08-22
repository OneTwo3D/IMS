/**
 * o3d-0m56 round 3 (Codex) — the way OUT of a correctly-refused money row.
 *
 * Everything else in this issue is about refusing. The refusals are right, and together they
 * produce a state with no exit: a payment that reached the ledger but whose response was lost
 * leaves a FAILED row that can never be retried (the ledger holds it), never posts (the guard
 * refuses), and goes on blocking the next receipt for that order as an unresolved attempt. The
 * operator can see exactly what happened and has no button that changes anything.
 *
 * So: an operator may declare the row SETTLED — but only when IMS can SEE the settlement. That is
 * the whole design constraint. A free-form "mark as done" would be a hole straight through every
 * guard above it, usable to clear a row whose payment does not exist and whose invoice would then
 * silently go unpaid for ever. This one refuses unless the ledger positively holds the attempt,
 * and it writes the remote id it matched, so the local row afterwards says WHICH payment settled
 * it rather than merely that somebody clicked.
 */

export type SettledRowReconciliation =
  | { resolve: true; externalTransactionId: string | null; detail: string }
  | { resolve: false; reason: string }

export type ReconcilableRow = {
  status: string
  type: string
}

/**
 * Decide whether a row may be declared settled. Pure — the probe's I/O and the write are the
 * caller's, so the rule that lets a human close a money row is testable on its own.
 */
export function decideSettledRowReconciliation(params: {
  row: ReconcilableRow | null
  /** What the ledger says about this row's own attempt. */
  settlement: { outcome: 'clear' } | { outcome: 'present'; detail: string; matchedId: string | null } | { outcome: 'unknown'; reason: string }
  isMoneyMoving: (type: string) => boolean
}): SettledRowReconciliation {
  const { row, settlement } = params
  if (!row) return { resolve: false, reason: 'That sync entry no longer exists.' }
  if (!params.isMoneyMoving(row.type)) {
    // Nothing else needs this door, and every door into the sync log is a way to fake a success.
    return {
      resolve: false,
      reason: `Only a payment entry can be reconciled this way; this one is a ${row.type}. Retry it instead.`,
    }
  }
  if (row.status !== 'FAILED') {
    return {
      resolve: false,
      reason: `Only a FAILED entry can be reconciled; this one is ${row.status}. `
        + 'A live entry is either still working or already recorded as settled.',
    }
  }
  if (settlement.outcome === 'unknown') {
    return {
      resolve: false,
      reason: `IMS could not read the document in the accounting connector (${settlement.reason}), so it `
        + 'cannot confirm the payment is there. Try again when the connector responds.',
    }
  }
  if (settlement.outcome === 'clear') {
    return {
      resolve: false,
      // The important refusal. "It failed, just close it" is exactly what an operator wants to do
      // here, and doing it would leave an invoice outstanding in the ledger with nothing in IMS
      // still asking anyone to look at it.
      reason: 'The accounting connector does NOT hold a payment matching this entry, so there is '
        + 'nothing to reconcile — closing it would leave the document unpaid with nothing tracking '
        + 'it. Retry the entry instead, or record the payment in the ledger by hand first.',
    }
  }
  return { resolve: true, externalTransactionId: settlement.matchedId, detail: settlement.detail }
}
