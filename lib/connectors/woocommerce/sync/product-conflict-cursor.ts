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
 * The companion row recording, for each carried id, the LIST GENERATION at which
 * its conflict was last observed (o3d-xbt round 5, findings 1 and 2).
 *
 * Round 4 held wall-clock milliseconds here. See `WcProductConflictEvidence`
 * for why they are gone; this row survives because the per-id granularity does.
 *
 * WHY A SECOND ROW RATHER THAN A RICHER VALUE. The id list is a JSON array and
 * an older build parses it as one. Replacing that array with pairs, objects or
 * a versioned envelope makes every one of those builds read the list as EMPTY,
 * which is precisely the silent abandonment this whole mechanism exists to
 * prevent, and it would happen on a rollback, when somebody is already having a
 * bad day.
 *
 * Both rows are written in the SAME transaction under the SAME lock, and both
 * carry the generation, which is what makes a write by any OTHER build
 * detectable — see `WC_PRODUCT_CONFLICT_LEDGER_VERSION`.
 */
export function wcProductConflictSeenAtSettingKey(mode: WcProductSyncMode): string {
  return mode === 'poll' ? 'wc_product_sync_conflict_seen_at' : 'wc_product_reconcile_conflict_seen_at'
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
 *
 * It is also what makes the GENERATION a sequence rather than a guess: the lock
 * is held to commit across the re-read and the write, so the writers of one row
 * form a single serialized chain and each one mints exactly one number.
 */
export function wcProductConflictLockId(mode: WcProductSyncMode): number {
  return mode === 'poll' ? 1 : 2
}

/**
 * The generation marker that rides IN the id list, as an element every id parser
 * in every build already skips (o3d-xbt round 5, finding 2).
 *
 * `parseWcProductConflictIds` — this build's and round 3's and round 4's alike —
 * keeps an entry only when `Number(entry)` is a positive integer. `"gen:7"` is
 * NaN, so an older build reads `["gen:7", 77]` as exactly `[77]`: the retry set
 * is unchanged, nothing is abandoned, and the marker costs it nothing.
 *
 * What it buys is the thing a sidecar alone cannot buy. An older build that
 * WRITES the list writes `JSON.stringify(kept)` — bare integers — so the marker
 * DISAPPEARS. Its absence, or a value that no longer matches the ledger beside
 * it, is proof that a writer which does not maintain the ledger has been here,
 * and the timestamps in that ledger can no longer be trusted to describe the
 * list. That is a detectable condition, and a detectable condition can be
 * degraded to safely; an undetectable one can only be lost.
 */
const WC_PRODUCT_CONFLICT_GENERATION_PREFIX = 'gen:'

/**
 * The shape of the ledger row. Bumped from round 4's bare `{id: epochMs}`, which
 * carried no version and no generation, so a build reading it could not tell
 * milliseconds from generations. A ledger this build does not recognise is
 * treated as no ledger at all, which is the safe end of the fence rather than
 * the permissive one.
 */
export const WC_PRODUCT_CONFLICT_LEDGER_VERSION = 2

/**
 * Tolerant of anything the setting row may hold: a JSON array, an empty string, a
 * value written by an older build, or garbage. A conflict list that throws would
 * take down the sync it exists to protect, and an unreadable list is recoverable
 * (the run rebuilds it) while a thrown error is not.
 *
 * The generation marker is skipped by the same rule that skips junk, which is
 * exactly why an older build can read a list this one wrote.
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
 * The generation this list was written at, or null if it was written by
 * something that does not mint generations — an older build, a hand-edited row,
 * or an unreadable value.
 *
 * NULL IS NOT ZERO AND MUST NOT BEHAVE LIKE IT. Null means "an unrecognised
 * writer produced this list", and the whole point is that such a list cannot be
 * cleared against, because its ids may have been observed at any time at all.
 */
export function parseWcProductConflictGeneration(raw: string | null | undefined): number | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  for (const entry of parsed) {
    if (typeof entry !== 'string' || !entry.startsWith(WC_PRODUCT_CONFLICT_GENERATION_PREFIX)) continue
    const generation = Number(entry.slice(WC_PRODUCT_CONFLICT_GENERATION_PREFIX.length))
    return Number.isInteger(generation) && generation > 0 ? generation : null
  }
  return null
}

/** The id list as it goes into the settings row: the marker first, then the ids. */
export function serializeWcProductConflictIds(kept: readonly number[], generation: number): string {
  return JSON.stringify([`${WC_PRODUCT_CONFLICT_GENERATION_PREFIX}${generation}`, ...kept])
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
 * The ledger beside the list: which generation the list was at when it was
 * written, and the generation at which each carried id's conflict was last
 * OBSERVED.
 */
export type WcProductConflictLedger = {
  /**
   * The generation of the list this ledger describes, or null when the row is
   * absent, unreadable, or written in a shape this build does not know.
   */
  generation: number | null
  /** id -> the list generation at which that id's conflict was last observed. */
  seenAtGeneration: Map<number, number>
}

/**
 * Parse the ledger.
 *
 * Tolerant in exactly the way the id list is, and for the same reason: a
 * malformed row must not throw and take down the sweep. What it must NOT do is
 * degrade to "permissive". Round 4 read a missing entry as zero and therefore as
 * "older than anything, clear it", reasoning that an unstamped id predates the
 * deploy. That reasoning holds for a fleet that has finished rolling and for
 * nothing else: while an older build is still running it keeps WRITING unstamped
 * ids, and every one of them was observed AFTER the deploy, not before. So an
 * unreadable ledger, or an entry that is simply not there, now means UNKNOWN,
 * and unknown keeps the product on the list.
 */
export function parseWcProductConflictLedger(raw: string | null | undefined): WcProductConflictLedger {
  const empty: WcProductConflictLedger = { generation: null, seenAtGeneration: new Map() }
  if (!raw) return empty
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return empty
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty
  const envelope = parsed as { v?: unknown; gen?: unknown; seen?: unknown }
  if (envelope.v !== WC_PRODUCT_CONFLICT_LEDGER_VERSION) return empty
  const generation = typeof envelope.gen === 'number' ? envelope.gen : Number(envelope.gen)
  if (!Number.isInteger(generation) || generation <= 0) return empty
  const seenAtGeneration = new Map<number, number>()
  if (envelope.seen && typeof envelope.seen === 'object' && !Array.isArray(envelope.seen)) {
    for (const [key, value] of Object.entries(envelope.seen as Record<string, unknown>)) {
      const id = Number(key)
      const at = typeof value === 'number' ? value : Number(value)
      if (Number.isInteger(id) && id > 0 && Number.isInteger(at) && at > 0) seenAtGeneration.set(id, at)
    }
  }
  return { generation, seenAtGeneration }
}

/**
 * Serialise the ledger, PRUNED to the ids actually carried — otherwise it is a
 * map that only ever grows, which is the defect the store limit exists to stop
 * one row away.
 */
export function serializeWcProductConflictLedger(
  generation: number,
  seenAtGeneration: ReadonlyMap<number, number>,
  kept: readonly number[],
): string {
  const seen: Record<string, number> = {}
  for (const id of kept) {
    const at = seenAtGeneration.get(id)
    if (at !== undefined && at > 0) seen[String(id)] = at
  }
  return JSON.stringify({ v: WC_PRODUCT_CONFLICT_LEDGER_VERSION, gen: generation, seen })
}

/**
 * The evidence a run gathered about one product, from the sweep's point of view.
 * Named rather than passed as four bare sets, because which set an id lands in
 * IS the decision this module exists to make.
 *
 * THERE IS NO CLOCK IN HERE ANY MORE (o3d-xbt round 5, finding 1).
 *
 * Round 4 timed the evidence with `Date.now()` on the host that gathered it and
 * compared those numbers across runs. Two sweeps of the same mode do not have to
 * be on the same host — the cron reconcile and an operator's manual reconcile
 * are different processes, and in a multi-instance deployment different machines
 * — and NTP does not make two hosts agree, it makes each of them approximately
 * right. A host a few seconds fast stamps a conflict into the future; a host a
 * few seconds slow then judges its own stale success to be newer than that
 * conflict and removes it. The failure that produces is the exact one this
 * mechanism exists to prevent: a product silently off the list with the cursor
 * already past it and both runs green.
 *
 * So the ordering is not a time at all. It is a GENERATION: a counter minted by
 * the writer that holds `wcProductConflictLockId`, incremented once per commit,
 * and stored in both rows. Every writer of one list is in that same serialized
 * chain, so the numbers form a total order that no host's clock participates in
 * — skew cannot make 6 smaller than 5. The database is the only sequencer, and
 * it sequences by lock ordering rather than by reading a clock, so it does not
 * matter that `now()` in Postgres is transaction-start time either.
 */
export type WcProductConflictEvidence = {
  /**
   * The generation of the list as this run FOUND it, read before the run fetched
   * anything, or null if the list was absent or unmarked at that point.
   *
   * This is the whole freshness rule, and it is the same arm round 4 needed and
   * for the same reason. A conflict recorded at a generation this run had
   * already seen was on the list before this run gathered a single fact, so
   * everything the run knows, it learned afterwards. A conflict recorded at a
   * LATER generation appeared while we were working, and we cannot claim our
   * evidence outranks it — ties, and everything unprovable, go to the conflict.
   *
   * Round 4 needed a second, per-id arm to stop two sequential sweeps in the
   * same millisecond looking concurrent. Generations have no resolution to lose:
   * two sequential sweeps are two different numbers however fast they run, so
   * the case that regressed is decided correctly by this arm alone.
   */
  generationAtStart: number | null
  /** The list as it stands in the database RIGHT NOW — re-read under the lock. */
  stored: readonly number[]
  /** The generation marker on that re-read list; null if an unmarked writer wrote it. */
  storedGeneration: number | null
  /** The ledger re-read under the lock alongside `stored`. */
  storedLedger: WcProductConflictLedger
  /** Every id this run actually tried to import, whatever the outcome. */
  attempted: ReadonlySet<number>
  /**
   * Ids this run has POSITIVE evidence are no longer conflicted: they imported
   * cleanly, or WooCommerce answered a by-id fetch without them (deleted, or no
   * longer visible to these credentials).
   *
   * Not reaching an id is not evidence. Neither is a transient failure on it.
   * AND EVIDENCE THAT CANNOT BE SHOWN TO POSTDATE THE CONFLICT IT WOULD ANSWER
   * IS NOT EVIDENCE EITHER — see the merge below.
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
  /** The generation to write on BOTH rows: one more than anything either held. */
  generation: number
  /** The ledger to write beside `kept`: the generation each kept id was last observed at. */
  seenAtGeneration: Map<number, number>
  /**
   * Ids this run holds clearing evidence for that it REFUSED to act on, because
   * the conflict on the list cannot be shown to be older than that evidence.
   * Reported, because a sweep silently declining to apply its own result is
   * exactly the kind of thing that should be visible when someone is working out
   * why a product is still on the list.
   */
  staleClears: number[]
  /**
   * FALSE when the two rows disagree about the generation — i.e. something that
   * does not maintain the ledger has written the list since it was last written
   * here. No clear is applied on such a merge, and the caller says so out loud.
   */
  attributable: boolean
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

  const stored = evidence.stored.filter((id) => Number.isInteger(id) && id > 0)
  const storedSet = new Set(stored)
  const ledger = evidence.storedLedger

  /**
   * The number this merge mints. Taken from the HIGHEST thing either row holds,
   * not from the list alone: when an unmarked writer has stripped the marker,
   * the ledger is the only surviving memory of how far the sequence had got, and
   * restarting at 1 would make a NEW generation compare as older than a stamp
   * from the old era — which is the erasure, re-introduced by the repair.
   */
  let highest = Math.max(evidence.storedGeneration ?? 0, ledger.generation ?? 0)
  for (const at of ledger.seenAtGeneration.values()) if (at > highest) highest = at
  const generation = highest + 1

  /**
   * o3d-xbt round 5, finding 2 — AN OLD WRITER MUST DEGRADE TO SAFE, NOT TO
   * SILENT ERASURE.
   *
   * Round 4 put the timestamps in a sidecar so that an older build READING the
   * list would still see a plain array of ids. That half is right and is kept.
   * What it did not answer is the older build WRITING: on a rollback, or during
   * the minutes a fleet takes to roll, a round-3 build merges the list and
   * leaves the ledger untouched. Nothing about the resulting row says so. Two
   * consequences, and the second is the dangerous one:
   *
   *   - an id that build ADDED has no ledger entry, and round 4 read a missing
   *     entry as "older than everything, clear it";
   *   - an id that build RE-OBSERVED keeps its old ledger entry, so the ledger
   *     positively asserts a conflict is older than it is — and no comparison,
   *     however careful, can survive being lied to about its inputs.
   *
   * Both are fixed by the same thing: the generation marker rides in the LIST,
   * and any build that does not know about it strips it on write. So the two
   * rows agreeing on a generation is a positive statement that the last writer
   * of the list was one that also wrote this ledger. When they disagree — a
   * missing marker, a marker from a generation the ledger has never heard of —
   * the ledger describes some other version of this list and nothing in it may
   * be relied on. The merge then applies NO clear at all, reports every one of
   * them, and re-stamps every carried id at the new generation, which restores a
   * consistent pair in one merge. The cost of the safe reading is that a
   * genuinely resolved product waits one more sweep and one more by-id fetch.
   * The cost of the permissive reading is a conflicted product gone for good.
   */
  const attributable =
    evidence.storedGeneration !== null
    && ledger.generation !== null
    && evidence.storedGeneration === ledger.generation

  // Classified ONCE per stored id, not per band: the two band filters below both
  // ask the same question, and a predicate that also records a stale clear would
  // otherwise report each one twice.
  const startedAt = evidence.generationAtStart ?? 0
  const staleClears: number[] = []
  const cleared = new Set<number>()
  for (const id of storedSet) {
    // An id that conflicted in THIS run is conflicted, whatever else the run
    // thinks it saw. Nothing should produce both, and if something ever does,
    // the safe reading is the one that keeps the product on the list.
    if (observed.has(id)) continue
    if (!evidence.cleared.has(id)) continue
    const seenAt = attributable ? ledger.seenAtGeneration.get(id) : undefined
    // `<=`, not `<`: a conflict recorded AT the generation we read at start had
    // already been committed when we read it, so our evidence — all of which we
    // gathered afterwards — really is newer. Anything above that generation
    // appeared while we were running, and an id with no entry at all has no
    // provenance we can check. Both keep the product.
    if (seenAt !== undefined && seenAt <= startedAt) cleared.add(id)
    else staleClears.push(id)
  }

  const untouched = stored.filter((id) => !evidence.attempted.has(id) && !cleared.has(id))
  const reattempted = stored.filter((id) => evidence.attempted.has(id) && !cleared.has(id))
  const fresh = [...observed].filter((id) => !storedSet.has(id))

  const { kept, dropped } = capWcProductConflictIds([...untouched, ...reattempted, ...fresh])
  const freshSet = new Set(fresh)

  // The stamp only ever moves FORWARD, and every carried id has one. A run that
  // re-observes a conflict pushes it to THIS generation, so a sweep that started
  // earlier can no longer answer it. An id whose provenance we could not check —
  // no entry, or a ledger that does not describe this list — is stamped here
  // too, which is both the safe reading (only a run starting after this merge
  // may clear it) and the repair: one merge later it is an ordinary carried id
  // again. An id nobody touched keeps the generation it already had, so a
  // long-running sweep does not have its clears invalidated by sweeps that had
  // nothing to say about the products it is clearing.
  const seenAtGeneration = new Map<number, number>()
  for (const id of kept) {
    const before = attributable ? ledger.seenAtGeneration.get(id) : undefined
    seenAtGeneration.set(id, observed.has(id) || before === undefined ? generation : before)
  }

  return {
    kept,
    dropped,
    droppedRecoverableByCursor: dropped.filter((id) => freshSet.has(id)),
    generation,
    seenAtGeneration,
    staleClears,
    attributable,
  }
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
