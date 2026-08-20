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
 * How many conflicted products are RE-FETCHED per run. WooCommerce caps
 * `per_page` at 100, so this is one page — the retry pass costs exactly one
 * extra request, which is the whole point of bounding it.
 *
 * It is NOT the size of the stored list. See the store limit below.
 */
export const WC_PRODUCT_CONFLICT_RETRY_LIMIT = 100

/**
 * How many conflicted products are CARRIED between runs.
 *
 * o3d-xbt round 3, Codex finding 2 — THE STORE ROTATES.
 *
 * Round 2 made the store and the retry window the same 100, so the 101st
 * conflicted product was dropped: told about, loudly, but dropped, and the
 * cursor advanced past it. A bounded sweep that says what it abandoned is better
 * than one that hides it, and still worse than one that abandons nothing.
 *
 * The two bounds exist for different reasons, so they are two numbers. The RETRY
 * limit bounds the WORK: one extra WooCommerce request per run, whatever the
 * backlog. The STORE limit bounds the SETTINGS ROW: a value that grows without
 * end is its own defect. Separating them means a backlog of 250 conflicts costs
 * exactly one request per run and is fully covered in three runs, because the
 * list is written back ROTATED — the ids this run attempted go to the BACK, so
 * the next run's window is the ids it has not reached yet.
 *
 * Ten windows is the ceiling on how stale the least-recently-attempted id can
 * be. The poll runs every few minutes, so even a full store is walked in under
 * an hour.
 */
export const WC_PRODUCT_CONFLICT_STORE_LIMIT = 1000

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
 * The advisory-lock id that serializes one mode's read-modify-write of its
 * conflict list against another sweep's (o3d-xbt round 3, finding 1).
 *
 * Mode-scoped for the same reason the setting key is: the poll and the reconcile
 * write DIFFERENT rows, and making them queue behind each other would be pure
 * contention. `manual_reconcile` shares the reconcile row, so it shares the lock
 * — that pair is precisely the overlap that happens in practice, a cron
 * reconcile running while an operator presses the button.
 */
export function wcProductConflictLockId(mode: WcProductSyncMode): number {
  return mode === 'poll' ? 1 : 2
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
  const seen = new Set<number>()
  for (const entry of parsed) {
    const id = typeof entry === 'number' ? entry : Number(entry)
    if (Number.isInteger(id) && id > 0 && !seen.has(id)) {
      seen.add(id)
      ids.push(id)
    }
  }
  return ids.slice(0, WC_PRODUCT_CONFLICT_STORE_LIMIT)
}

/**
 * What the cap KEPT and what it DROPPED.
 *
 * o3d-xbt round 2, Codex finding 2. The cap capped and returned a string, so an
 * id beyond it vanished with nothing said. That is the failure mode a bounded
 * sweep is supposed to make impossible: truncating silently reads, to every
 * operator and every later reader of the code, as "covered everything".
 */
export type WcProductConflictCarry = {
  /** The ids that will be carried to the next run, in rotation order. */
  kept: number[]
  /** The ids the cap could not carry, in the order they were offered. */
  dropped: number[]
}

export function capWcProductConflictIds(
  ids: Iterable<number>,
  limit: number = WC_PRODUCT_CONFLICT_STORE_LIMIT,
): WcProductConflictCarry {
  // Set-backed rather than `unique.includes`: the store is an order of magnitude
  // longer than the window it feeds, and a quadratic scan over a full one runs on
  // every sweep.
  const unique: number[] = []
  const seen = new Set<number>()
  for (const id of ids) {
    if (Number.isInteger(id) && id > 0 && !seen.has(id)) {
      seen.add(id)
      unique.push(id)
    }
  }
  return { kept: unique.slice(0, limit), dropped: unique.slice(limit) }
}

/**
 * The evidence a run gathered about one product, from the sweep's point of view.
 * Named rather than passed as four bare sets, because which set an id lands in
 * IS the decision this module exists to make.
 */
export type WcProductConflictEvidence = {
  /** The list as it stands in the database RIGHT NOW — re-read under the lock. */
  stored: readonly number[]
  /** Every id this run actually tried to import, whatever the outcome. */
  attempted: ReadonlySet<number>
  /**
   * Ids this run has POSITIVE evidence are no longer conflicted: they imported
   * cleanly, or WooCommerce answered a by-id fetch without them (deleted, or no
   * longer visible to these credentials).
   *
   * Not reaching an id is not evidence. Neither is a transient failure on it.
   */
  cleared: ReadonlySet<number>
  /** Ids that conflicted in THIS run, in the order they were observed. */
  observed: readonly number[]
}

export type WcProductConflictMerge = WcProductConflictCarry & {
  /**
   * Of `dropped`, the ids this run learned about from the modified-after pass —
   * the ones a HELD cursor will present again next run. The rest were already
   * carried, and the cursor is long past them.
   */
  droppedRecoverableByCursor: number[]
}

/**
 * Merge one run's evidence into the list as it stands, rather than replacing it
 * (o3d-xbt round 3, Codex finding 1).
 *
 * WHY MERGING RATHER THAN REPLACING. Round 2 ordered the two writes WITHIN a
 * sweep — list first, cursor second, cursor held if the list would not write.
 * That is necessary and not sufficient, because two sweeps OVERLAP: the cron
 * reconcile and the manual one share both rows, and the poll can lap itself when
 * a catalogue takes longer than the cron interval. Sweep A ends, writes [7],
 * advances the cursor. Sweep B — which read the list before A wrote it, and
 * never saw product 7 because its pages were fetched earlier — then writes ITS
 * list, computed from a snapshot that predates A. Product 7 disappears with the
 * cursor already past it: nothing re-fetches it, nothing knows it exists, and
 * both runs report success. Ordering inside one sweep cannot see this; only
 * re-reading the row under a lock and merging onto it can.
 *
 * So the write is a read-modify-write under `wcProductConflictLockId`, and this
 * is the modify. An id leaves the list on EVIDENCE only, and evidence is a
 * property of a run, not of a snapshot — which means a concurrent sweep's
 * additions survive ours untouched, because we have no evidence about them.
 *
 * ORDER IS ROTATION. Three bands, front to back:
 *
 *   1. carried ids this run did NOT reach     — least recently attempted, so the
 *                                               next run's window takes them first;
 *   2. carried ids this run DID attempt and could not clear;
 *   3. ids that conflicted for the FIRST time this run.
 *
 * The cap therefore drops from band 3 first, and band 3 is exactly the set a
 * HELD cursor re-presents next run. That asymmetry is the whole reason the cap
 * is survivable: bands 1 and 2 sit behind a cursor that has already moved past
 * them, so dropping one of those really would abandon it, while dropping a
 * band-3 id costs one more sweep of work and nothing else.
 */
export function mergeWcProductConflictIds(evidence: WcProductConflictEvidence): WcProductConflictMerge {
  const observed = new Set<number>()
  for (const id of evidence.observed) {
    if (Number.isInteger(id) && id > 0) observed.add(id)
  }
  // An id that conflicted in this run is conflicted, whatever else the run
  // thinks it saw. Nothing should produce both, and if something ever does, the
  // safe reading is the one that keeps the product on the list.
  const cleared = (id: number) => evidence.cleared.has(id) && !observed.has(id)

  const stored = evidence.stored.filter((id) => Number.isInteger(id) && id > 0)
  const storedSet = new Set(stored)

  const untouched = stored.filter((id) => !evidence.attempted.has(id) && !cleared(id))
  const reattempted = stored.filter((id) => evidence.attempted.has(id) && !cleared(id))
  const fresh = [...observed].filter((id) => !storedSet.has(id))

  const { kept, dropped } = capWcProductConflictIds([...untouched, ...reattempted, ...fresh])
  const freshSet = new Set(fresh)
  return { kept, dropped, droppedRecoverableByCursor: dropped.filter((id) => freshSet.has(id)) }
}

/**
 * The cursor may move when every failure this run was permanent. A transient
 * failure means the run did NOT see everything the cursor claims it saw, so
 * advancing would skip remote changes older than now — the original rule, intact.
 *
 * Permanent failures no longer hold it because they are carried in the conflict
 * set instead: the retry is by id, not by cursor.
 *
 * A conflict the store could not carry is reported as TRANSIENT for exactly this
 * reason (round 3, finding 2): the retry list is the mechanism that makes
 * advancing safe, so when it cannot hold an id, the only mechanism left is the
 * cursor — and holding it re-presents that product next run. Same rule the
 * completion path follows one layer up: a refusal that cannot be filed is not
 * reported as permanent.
 */
export function shouldAdvanceWcProductCursor(result: { errors: string[]; permanentErrors: string[] }): boolean {
  return result.errors.length === result.permanentErrors.length
}
