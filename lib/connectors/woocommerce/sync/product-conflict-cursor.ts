/**
 * o3d-xbt: the bulk product sync's permanent/transient split, and the retry set
 * that makes advancing the cursor safe.
 *
 * THE DEFECT. `syncAllWcProducts` pushed every failure into `result.errors` and
 * advanced its modified-after cursor only when that array was empty. One product
 * with a PERMANENT conflict — a GTIN or a WooCommerce id already mapped to a
 * different IMS product, typically a SKU renamed in WooCommerce leaving the old
 * row holding the id — therefore pinned `last_wc_product_sync_at` /
 * `last_wc_product_reconcile_at` forever. Every subsequent cycle re-fetched the
 * WHOLE catalogue from an ever-older cursor, re-imported all of it, and re-failed
 * on the same product: unbounded work per cycle, permanently.
 *
 * WHY THE CURSOR CANNOT SIMPLY ADVANCE. Not advancing was load-bearing, not an
 * oversight. o3d-y89x relies on it: a structure conflict is resolved on the IMS
 * side (un-kitting a row, re-parenting a variant), which changes nothing in
 * WooCommerce, so a cursor that had stepped past the product would never fetch it
 * again and the fix would never be picked up. The exception inbox says as much in
 * its own copy — those rows carry no acknowledge action precisely because "the
 * product reconcile does not move past a conflicted product".
 *
 * THE SPLIT. Permanent failures are tracked separately AND their WooCommerce ids
 * are persisted, so the next run re-fetches exactly those products BY ID
 * (`include=`) regardless of the cursor. The re-attempt survives; what stops is
 * re-importing the entire catalogue to reach it. A product that no longer comes
 * back from WooCommerce (deleted, or now invisible to the credentials) simply
 * drops out of the set, so it is self-healing rather than a list that only grows.
 */

/**
 * How many conflicted products are carried between runs. WooCommerce caps
 * `per_page` at 100, so this is one page — the retry pass costs exactly one
 * extra request, which is the whole point of bounding it.
 */
export const WC_PRODUCT_CONFLICT_RETRY_LIMIT = 100

export type WcProductSyncMode = 'poll' | 'reconcile' | 'manual_reconcile'

/**
 * Mode-scoped, exactly like the cursor it accompanies: the poll and the
 * reconcile keep separate cursors, so a conflict list shared between them would
 * let one mode's run silently satisfy the other's retry.
 */
export function wcProductConflictSettingKey(mode: WcProductSyncMode): string {
  return mode === 'poll' ? 'wc_product_sync_conflict_ids' : 'wc_product_reconcile_conflict_ids'
}

/**
 * Tolerant of anything the setting row may hold: a JSON array, an empty string, a
 * value written by an older build, or garbage. A conflict list that throws would
 * take down the sync it exists to protect, and an unreadable list is recoverable
 * (the run rebuilds it) while a thrown error is not.
 */
export function parseWcProductConflictIds(raw: string | null | undefined): number[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const ids: number[] = []
  for (const entry of parsed) {
    const id = typeof entry === 'number' ? entry : Number(entry)
    if (Number.isInteger(id) && id > 0 && !ids.includes(id)) ids.push(id)
  }
  return ids.slice(0, WC_PRODUCT_CONFLICT_RETRY_LIMIT)
}

/**
 * What the cap KEPT and what it DROPPED.
 *
 * o3d-xbt round 2, Codex finding 2. `serializeWcProductConflictIds` capped the
 * list at one WooCommerce page and returned a string, so an id beyond the cap
 * vanished with nothing said. That is the failure mode a bounded sweep is
 * supposed to make impossible: truncating silently reads, to every operator and
 * every later reader of the code, as "covered everything". A dropped id is a
 * product that conflicts, is not re-attempted, and — because the cursor has
 * already moved past it — will not be seen again until it changes in WooCommerce
 * or somebody resets the cursor by hand.
 *
 * The bound stays (an unbounded retry recreates the unbounded work o3d-xbt
 * fixed). What changes is that the caller is now TOLD, and can say so out loud.
 */
export type WcProductConflictCarry = {
  /** The ids that will be carried to the next run, newest first. */
  kept: number[]
  /** The ids the cap could not carry, in the order they were offered. */
  dropped: number[]
}

export function capWcProductConflictIds(ids: Iterable<number>): WcProductConflictCarry {
  const unique: number[] = []
  for (const id of ids) {
    if (Number.isInteger(id) && id > 0 && !unique.includes(id)) unique.push(id)
  }
  // Newest first, so the cap drops the STALEST conflict rather than the one just
  // observed — an id kept in the list is only worth keeping while it is still
  // being re-attempted.
  return {
    kept: unique.slice(0, WC_PRODUCT_CONFLICT_RETRY_LIMIT),
    dropped: unique.slice(WC_PRODUCT_CONFLICT_RETRY_LIMIT),
  }
}

export function serializeWcProductConflictIds(ids: Iterable<number>): string {
  return JSON.stringify(capWcProductConflictIds(ids).kept)
}

/**
 * The cursor may move when every failure this run was permanent. A transient
 * failure means the run did NOT see everything the cursor claims it saw, so
 * advancing would skip remote changes older than now — the original rule, intact.
 *
 * Permanent failures no longer hold it because they are carried in the conflict
 * set instead: the retry is by id, not by cursor.
 */
export function shouldAdvanceWcProductCursor(result: { errors: string[]; permanentErrors: string[] }): boolean {
  return result.errors.length === result.permanentErrors.length
}
