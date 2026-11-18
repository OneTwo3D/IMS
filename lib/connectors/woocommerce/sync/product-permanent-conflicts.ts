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
}

export function parsePermanentConflicts(raw: string | null | undefined): PermanentConflict[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const seen = new Set<number>()
    const items: PermanentConflict[] = []
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue
      const { id, sku, since, lastAttemptAt } = entry as Record<string, unknown>
      if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0 || seen.has(id)) continue
      seen.add(id)
      items.push({
        id,
        sku: typeof sku === 'string' ? sku : '',
        since: typeof since === 'string' ? since : new Date(0).toISOString(),
        lastAttemptAt: typeof lastAttemptAt === 'string' ? lastAttemptAt : null,
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
  /** Imported successfully, or gone from WooCommerce: dropped from the list. */
  remove: number[]
  /** Re-attempted this run and still not imported: stamped so the next run takes others first. */
  attempted: number[]
}

/** Pure: the list after a delta, bounded. `dropped` is whatever the bound pushed out. */
export function applyPermanentConflictDelta(
  current: PermanentConflict[],
  delta: PermanentConflictDelta,
  nowIso: string,
  maxStored: number = MAX_STORED_PERMANENT_CONFLICTS,
): { items: PermanentConflict[]; dropped: PermanentConflict[] } {
  const removed = new Set(delta.remove)
  const attempted = new Set(delta.attempted)
  const byId = new Map<number, PermanentConflict>()
  for (const item of current) {
    if (removed.has(item.id)) continue
    byId.set(item.id, attempted.has(item.id) ? { ...item, lastAttemptAt: nowIso } : item)
  }
  for (const entry of delta.add) {
    if (removed.has(entry.id)) continue
    const existing = byId.get(entry.id)
    byId.set(entry.id, existing ? { ...existing, sku: entry.sku || existing.sku } : { id: entry.id, sku: entry.sku, since: nowIso, lastAttemptAt: null })
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
  if (delta.add.length === 0 && delta.remove.length === 0 && delta.attempted.length === 0) return { dropped: [] }
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
