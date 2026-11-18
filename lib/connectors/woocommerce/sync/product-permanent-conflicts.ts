/**
 * THE BOUNDED RE-ATTEMPT LIST for products the bulk product sync buried.
 *
 * The bulk sync advances its cursor past a failure no retry can fix (a duplicate GTIN, a WooCommerce id
 * already mapped to another IMS row, a structure conflict, a product over the variation limit), because
 * pinning the cursor re-reads the whole catalogue for ever. Both cursors read WooCommerce by
 * `modified_after`, and most remedies are IMS-side and do not move WooCommerce's `date_modified`, so a
 * fixed product had no way back. This list is the way back: the WooCommerce ids that were buried, kept in
 * one Setting, and fetched DIRECTLY by id at the start of each run, in addition to the `modified_after`
 * window.
 *
 * Bounded twice: the list holds at most MAX_STORED_PERMANENT_CONFLICTS ids (the longest-buried drop first,
 * and the drop is logged), and one run re-attempts at most MAX_PERMANENT_CONFLICT_REATTEMPTS of them,
 * least recently attempted first so every id gets its turn. What a run did NOT re-attempt is logged by the
 * caller: a bound that stays quiet reads as "covered everything".
 */

import { db } from '@/lib/db'

export const PERMANENT_CONFLICTS_SETTING = 'wc_product_permanent_conflicts'
export const MAX_STORED_PERMANENT_CONFLICTS = 200
export const MAX_PERMANENT_CONFLICT_REATTEMPTS = 20

export type PermanentConflict = {
  /** The WooCommerce product id, fetched at /products/<id>. */
  id: number
  sku: string
  /** When it was first buried. */
  since: string
  /** When a run last re-attempted it; null until one has. */
  lastAttemptAt: string | null
  /** When it was last (re-)recorded as conflicting by a page walk; a removal decided before this is stale. */
  conflictAt?: string
  /** Consecutive re-attempts that failed TRANSIENTLY (reset by a permanent outcome); never holds the product cursor. */
  attempts?: number
  lastError?: string
}

/** After this many consecutive transient re-attempt failures an operator-visible warning is raised. */
export const PERMANENT_CONFLICT_ATTEMPT_WARNING_THRESHOLD = 5

export function parsePermanentConflicts(raw: string | null | undefined): PermanentConflict[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const seen = new Set<number>()
    const items: PermanentConflict[] = []
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue
      const { id, sku, since, lastAttemptAt, conflictAt, attempts, lastError } = entry as Record<string, unknown>
      if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0 || seen.has(id)) continue
      seen.add(id)
      items.push({
        id,
        sku: typeof sku === 'string' ? sku : '',
        since: typeof since === 'string' ? since : new Date(0).toISOString(),
        lastAttemptAt: typeof lastAttemptAt === 'string' ? lastAttemptAt : null,
        ...(typeof conflictAt === 'string' ? { conflictAt } : {}),
        ...(typeof attempts === 'number' && Number.isFinite(attempts) && attempts > 0 ? { attempts } : {}),
        ...(typeof lastError === 'string' ? { lastError } : {}),
      })
    }
    return items
  } catch {
    return []
  }
}

/** Least recently attempted first (never attempted before attempted), then the longest buried. */
export function selectPermanentConflictReattempts(
  items: PermanentConflict[],
  max: number = MAX_PERMANENT_CONFLICT_REATTEMPTS,
): { chosen: PermanentConflict[]; notAttempted: PermanentConflict[] } {
  const ordered = [...items].sort((a, b) => {
    const aAttempt = a.lastAttemptAt ? Date.parse(a.lastAttemptAt) : -Infinity
    const bAttempt = b.lastAttemptAt ? Date.parse(b.lastAttemptAt) : -Infinity
    if (aAttempt !== bAttempt) return aAttempt < bAttempt ? -1 : 1
    const aSince = Date.parse(a.since)
    const bSince = Date.parse(b.since)
    return (Number.isFinite(aSince) ? aSince : 0) - (Number.isFinite(bSince) ? bSince : 0)
  })
  return { chosen: ordered.slice(0, max), notAttempted: ordered.slice(max) }
}

export type PermanentConflictDelta = {
  /** Newly buried (or buried again): added, keeping an existing entry's `since`. */
  add: Array<{ id: number; sku: string }>
  /**
   * Imported successfully, or gone from WooCommerce: dropped from the list. `at` is when that was decided: a removal
   * never erases a conflict recorded after it (in this run, or by a concurrent one).
   */
  remove: Array<{ id: number; at: string }>
  /** Re-attempted this run and still permanently in conflict: stamped so the next run takes others first. */
  attempted: number[]
  /** Re-attempted this run and failed transiently: counted and kept; this never holds the product cursor. */
  failed: Array<{ id: number; error: string }>
}

/** Pure: the list after a delta, bounded. `dropped` is whatever the bound pushed out. */
export function applyPermanentConflictDelta(
  current: PermanentConflict[],
  delta: PermanentConflictDelta,
  nowIso: string,
  maxStored: number = MAX_STORED_PERMANENT_CONFLICTS,
): { items: PermanentConflict[]; dropped: PermanentConflict[] } {
  const attempted = new Set(delta.attempted)
  const failed = new Map(delta.failed.map((entry) => [entry.id, entry.error]))
  const byId = new Map<number, PermanentConflict>()
  for (const item of current) {
    let next = item
    if (attempted.has(item.id)) next = { ...next, lastAttemptAt: nowIso, attempts: undefined, lastError: undefined }
    if (failed.has(item.id)) next = { ...next, lastAttemptAt: nowIso, attempts: (item.attempts ?? 0) + 1, lastError: failed.get(item.id)!.slice(0, 200) }
    byId.set(item.id, next)
  }
  // Removals first, then additions: a conflict recorded in the same run (a page-walk failure after a retry that succeeded)
  // is the LATER event and must win. A removal also leaves alone an entry conflicting since after it was decided.
  for (const removal of delta.remove) {
    const existing = byId.get(removal.id)
    if (!existing) continue
    if (existing.conflictAt && Date.parse(existing.conflictAt) > Date.parse(removal.at)) continue
    byId.delete(removal.id)
  }
  for (const entry of delta.add) {
    const existing = byId.get(entry.id)
    byId.set(entry.id, existing
      ? { ...existing, sku: entry.sku || existing.sku, conflictAt: nowIso }
      : { id: entry.id, sku: entry.sku, since: nowIso, lastAttemptAt: null, conflictAt: nowIso })
  }
  const all = [...byId.values()]
  if (all.length <= maxStored) return { items: all, dropped: [] }
  const byAge = [...all].sort((a, b) => Date.parse(b.since) - Date.parse(a.since))
  return { items: byAge.slice(0, maxStored), dropped: byAge.slice(maxStored) }
}

export async function readPermanentConflicts(): Promise<PermanentConflict[]> {
  const row = await db.setting.findUnique({ where: { key: PERMANENT_CONFLICTS_SETTING } })
  return parsePermanentConflicts(row?.value)
}

/**
 * Apply a delta under a transaction-scoped lock on the Setting, re-reading inside it: the poll and the
 * reconcile can overlap, and a read-modify-write outside the lock would lose the other's entries.
 */
export async function recordPermanentConflictDelta(delta: PermanentConflictDelta): Promise<{ dropped: PermanentConflict[] }> {
  if (delta.add.length === 0 && delta.remove.length === 0 && delta.attempted.length === 0 && delta.failed.length === 0) return { dropped: [] }
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${PERMANENT_CONFLICTS_SETTING}))`
    const row = await tx.setting.findUnique({ where: { key: PERMANENT_CONFLICTS_SETTING } })
    const { items, dropped } = applyPermanentConflictDelta(parsePermanentConflicts(row?.value), delta, new Date().toISOString())
    const value = JSON.stringify(items)
    await tx.setting.upsert({
      where: { key: PERMANENT_CONFLICTS_SETTING },
      create: { key: PERMANENT_CONFLICTS_SETTING, value },
      update: { value },
    })
    return { dropped }
  })
}
