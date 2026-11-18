/**
 * o3d-hqvrp.59 — the penny balance of a journal payload, measured the way the connector SENDS it.
 *
 * Xero manual journal lines carry one signed amount per line, rounded to 2dp (lib/connectors/xero/journals.ts). Rounding
 * per line can leave the lines as sent a penny apart even when the raw debit and credit sums agree to within a penny
 * (33.333 + 33.333 + 33.334 against 100). Pure, so the enqueue can refuse such a journal before it is queued and the
 * connector can refuse it again at the wire.
 *
 * Returns null for a payload that is not a journal (no `lines` carrying `debit` or `credit`), else the signed total in pennies.
 */
export function journalSentPennyImbalance(payload: unknown): number | null {
  if (typeof payload !== 'object' || payload === null) return null
  const lines = (payload as { lines?: unknown }).lines
  if (!Array.isArray(lines)) return null
  let isJournal = false
  let total = 0
  for (const line of lines) {
    if (typeof line !== 'object' || line === null) continue
    const { debit, credit } = line as { debit?: unknown; credit?: unknown }
    if (debit === undefined && credit === undefined) continue
    isJournal = true
    const signed = (Number(debit ?? 0) || 0) - (Number(credit ?? 0) || 0)
    total += Math.round(Math.round(signed * 100 * 1e6) / 1e6)
  }
  return isJournal ? total : null
}
