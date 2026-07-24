/**
 * Pure filtering of the `xero_tax_rate_drift_current` Setting for X-04's crash recovery.
 *
 * The setting is an operator-visible JSON array of drift entries. X-04 deliberately drifts a rate it seeded
 * with an `e2e-x04` id prefix, so a run that dies after injecting drift leaves an entry naming a rate the
 * NEXT run deletes — a dangling entry that run would otherwise capture as its "prior" state and restore at
 * teardown, reinstalling test drift permanently (Codex).
 *
 * Split out from the spec so the three cases that matter can be unit-tested without a database.
 */

/** X-04 stamps every tax rate it seeds with this id prefix; it is the only ownership signal. */
export const X04_TAX_RATE_ID_PREFIX = 'e2e-x04'

type DriftEntry = { taxRateId?: unknown }

/**
 * The snapshot with every X-04-owned entry removed, or the input UNCHANGED when there is nothing to do.
 *
 * Deliberately conservative, because this value is written back to operator-visible state:
 *   - unparseable or non-array JSON is returned as-is — a shape we do not understand is not ours to rewrite;
 *   - entries without a string taxRateId are KEPT (they cannot be proven to be ours);
 *   - a snapshot that was ENTIRELY X-04's collapses to null, i.e. delete the setting, restoring the clean
 *     rig's "absent" state rather than leaving an empty array the operator UI would have to interpret.
 */
export function withoutX04DriftEntries(raw: string | null): string | null {
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return raw
  }
  if (!Array.isArray(parsed)) return raw

  const kept = (parsed as DriftEntry[]).filter((entry) => {
    const id = entry?.taxRateId
    return !(typeof id === 'string' && id.startsWith(X04_TAX_RATE_ID_PREFIX))
  })
  if (kept.length === parsed.length) return raw
  return kept.length ? JSON.stringify(kept) : null
}
