import { scrubWmsMutationPayload } from '@/lib/domain/wms/mutation-audit'

/**
 * q66in.7.2: BEFORE/AFTER DIFFS FOR CONNECTOR CONFIGURATION CHANGES.
 *
 * Connection, binding, courier-map and dispatch-scope saves used to be recorded — when they were
 * recorded at all — as AFTER-VALUES ONLY. "Updated Mintsoft warehouse binding: stockSyncMode
 * ALIGN_TO_WMS" tells a later reader what the binding is, which they could have read off the row
 * anyway. What it never told them is what it WAS, so the one question an incident asks —
 * "did somebody change this, and from what?" — had no answer in the log at all. The courier map and
 * the dispatch/delta scope logged nothing whatsoever.
 *
 * This builds the missing half. It is deliberately a diff and not a snapshot pair: only the keys
 * that actually moved are recorded, so the entry says what CHANGED rather than burying it in
 * twenty unchanged fields, and an unchanged save produces no audit noise.
 *
 * SECRETS NEVER APPEAR, in either half. Call sites pass PRESENCE, never values — `fixedKeyConfigured:
 * true`, `webhookSigningConfigured: false` — and the rotation of a secret is recorded as the fact
 * that a slot was rewritten (`secretsRotated: ['webhookSecret']`), which is the auditable event.
 * `scrubWmsMutationPayload` then runs over both halves as defence in depth, so a call site that
 * passes a credential-shaped key by mistake degrades to `[masked]` instead of leaking it into the
 * activity log.
 */

export type ConfigSnapshot = Record<string, unknown>

export type ConfigChangeAudit = {
  /** True when there was no prior row/value at all — a create, not an edit. */
  created: boolean
  /** Keys whose value moved, sorted. Empty means nothing changed. */
  changed: string[]
  /** Prior values, restricted to `changed`. Empty on a create. */
  before: ConfigSnapshot
  /** New values, restricted to `changed`. */
  after: ConfigSnapshot
}

/** Structural equality via canonical JSON — handles arrays (reportRecipients), nested objects (thresholds) and dates. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  try {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
  } catch {
    return false
  }
}

function scrubSnapshot(snapshot: ConfigSnapshot): ConfigSnapshot {
  const scrubbed = scrubWmsMutationPayload(snapshot)
  return (scrubbed && typeof scrubbed === 'object' && !Array.isArray(scrubbed))
    ? scrubbed as ConfigSnapshot
    : {}
}

/**
 * Diff two configuration snapshots.
 *
 * `before === null` means "there was nothing here" — a created binding, a setting written for the
 * first time. That is reported as `created: true` with an EMPTY `before`, rather than as every key
 * changing from `undefined`, because "created" and "every field edited" are different events and a
 * reader should not have to tell them apart from the shape of the payload.
 *
 * The key set is the union of both sides, so a key REMOVED from the config (present before, absent
 * after) is reported as a change to `null` rather than vanishing from the diff — dropping a routing
 * entry is exactly the kind of change this exists to catch.
 */
export function diffConfigSnapshots(before: ConfigSnapshot | null, after: ConfigSnapshot): ConfigChangeAudit {
  if (before === null) {
    return { created: true, changed: Object.keys(after).sort(), before: {}, after: scrubSnapshot(after) }
  }

  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
  const changedBefore: ConfigSnapshot = {}
  const changedAfter: ConfigSnapshot = {}
  const changed: string[] = []

  for (const key of keys) {
    if (sameValue(before[key], after[key])) continue
    changed.push(key)
    changedBefore[key] = before[key] ?? null
    changedAfter[key] = after[key] ?? null
  }

  return { created: false, changed, before: scrubSnapshot(changedBefore), after: scrubSnapshot(changedAfter) }
}

/**
 * The metadata block for a config-change activity entry.
 *
 * `changed` is duplicated out of the diff at the top level on purpose: it is the field an operator
 * scans a list of entries by, and it stays readable when `before`/`after` are long.
 */
export function configChangeMetadata(diff: ConfigChangeAudit, extra: ConfigSnapshot = {}): ConfigSnapshot {
  return {
    ...extra,
    created: diff.created,
    changed: diff.changed,
    before: diff.before,
    after: diff.after,
  }
}

/**
 * A one-line human summary: "changed stockSyncMode, syncFrequencyMinutes" / "no changes".
 * Capped, because a diff over a large routing map must not produce a 4KB description.
 */
export function describeConfigChange(diff: ConfigChangeAudit, maxFields = 6): string {
  if (diff.created) return 'created'
  if (diff.changed.length === 0) return 'no changes'
  const shown = diff.changed.slice(0, maxFields).join(', ')
  const rest = diff.changed.length - maxFields
  return rest > 0 ? `changed ${shown} (+${rest} more)` : `changed ${shown}`
}

/**
 * Diff a keyed routing map (IMS shipping-service name → external courier service id) into the three
 * things an operator needs to see, WITHOUT dumping both maps.
 *
 * A courier map is the highest-consequence routing config there is — a wrong id sends real parcels
 * out on the wrong service — and it was saved with no audit entry at all. `removed` matters as much
 * as `changed`: a dropped entry silently falls back to the default courier id, which looks like
 * nothing happened until the labels come out wrong.
 */
export function diffRoutingMap(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): { added: string[]; removed: string[]; changed: string[] } {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
  const added: string[] = []
  const removed: string[] = []
  const changed: string[] = []
  for (const key of keys) {
    const inBefore = Object.prototype.hasOwnProperty.call(before, key)
    const inAfter = Object.prototype.hasOwnProperty.call(after, key)
    if (!inBefore && inAfter) added.push(key)
    else if (inBefore && !inAfter) removed.push(key)
    else if (!sameValue(before[key], after[key])) changed.push(key)
  }
  return { added, removed, changed }
}

/** Parse a stored JSON routing map defensively — a malformed stored value diffs as empty, never throws. */
export function parseRoutingMap(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}
