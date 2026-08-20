import assert from 'node:assert/strict'
import test from 'node:test'
import * as cursorNs from '../lib/connectors/woocommerce/sync/product-conflict-cursor.ts'

const cursor = 'default' in cursorNs
  ? cursorNs.default as typeof import('../lib/connectors/woocommerce/sync/product-conflict-cursor.ts')
  : cursorNs

const {
  WC_PRODUCT_CONFLICT_RETRY_LIMIT,
  WC_PRODUCT_CONFLICT_STORE_LIMIT,
  capWcProductConflictIds,
  mergeWcProductConflictIds,
  parseWcProductConflictGeneration,
  parseWcProductConflictIds,
  parseWcProductConflictLedger,
  serializeWcProductConflictIds,
  serializeWcProductConflictLedger,
  shouldAdvanceWcProductCursor,
  wcProductConflictLockId,
  wcProductConflictSeenAtSettingKey,
  wcProductConflictSettingKey,
} = cursor
// o3d-xbt: the decisions that decide whether one permanent conflict pins the
// whole catalogue sweep, in the form that needs no database.

test('the cursor advances when every failure was permanent', () => {
  assert.equal(shouldAdvanceWcProductCursor({ errors: [], permanentErrors: [] }), true)
  assert.equal(
    shouldAdvanceWcProductCursor({ errors: ['SKU A: conflict'], permanentErrors: ['SKU A: conflict'] }),
    true,
    'the defect: this used to be false, so one conflicted product re-fetched the whole catalogue for ever',
  )
})

test('the cursor is held by ANY transient failure, alone or mixed with a permanent one', () => {
  assert.equal(
    shouldAdvanceWcProductCursor({ errors: ['WooCommerce API 502'], permanentErrors: [] }),
    false,
    'a run that did not see everything must not claim it did',
  )
  assert.equal(
    shouldAdvanceWcProductCursor({
      errors: ['SKU A: conflict', 'WooCommerce API 502'],
      permanentErrors: ['SKU A: conflict'],
    }),
    false,
  )
})

test('the conflict list is mode-scoped, like the cursor it accompanies', () => {
  assert.equal(wcProductConflictSettingKey('poll'), 'wc_product_sync_conflict_ids')
  assert.equal(wcProductConflictSettingKey('reconcile'), 'wc_product_reconcile_conflict_ids')
  // A manual reconcile shares the reconcile cursor, so it must share its list too
  // — otherwise it would advance one cursor while retrying against the other.
  assert.equal(wcProductConflictSettingKey('manual_reconcile'), 'wc_product_reconcile_conflict_ids')
  assert.notEqual(wcProductConflictSettingKey('poll'), wcProductConflictSettingKey('reconcile'))
})

test('an unreadable conflict list degrades to empty instead of throwing', () => {
  // It is rebuilt by the run that reads it, so an unreadable value costs one
  // cycle of retries; a thrown error would take down the sweep it protects.
  assert.deepEqual(parseWcProductConflictIds(null), [])
  assert.deepEqual(parseWcProductConflictIds(''), [])
  assert.deepEqual(parseWcProductConflictIds('not json'), [])
  assert.deepEqual(parseWcProductConflictIds('{"77":true}'), [])
  assert.deepEqual(parseWcProductConflictIds('[77, "88", null, 0, -3, 1.5, 77]'), [77, 88])
})

/**
 * The generation the fixtures sit at. Any number will do — that is the point of
 * a sequence — but a number bigger than one catches an implementation that
 * happens to work only when everything starts from zero.
 */
const GEN = 5

/**
 * Fill in the round-5 generations with the values that reproduce round 3's
 * semantics EXACTLY: the two rows agree, the run started from the generation the
 * list is at, and every carried id's conflict was recorded long before that. So
 * every clear applies, and the tests that are ABOUT the fence state the
 * generations they mean.
 */
function evidence(input: {
  generationAtStart?: number | null
  stored: number[]
  storedGeneration?: number | null
  ledgerGeneration?: number | null
  storedSeenAt?: ReadonlyMap<number, number>
  attempted?: Iterable<number>
  cleared?: Iterable<number>
  observed?: number[]
}) {
  const storedGeneration = input.storedGeneration === undefined ? GEN : input.storedGeneration
  const ledgerGeneration = input.ledgerGeneration === undefined ? storedGeneration : input.ledgerGeneration
  return {
    // Defaulted to the generation the list is at: the run read this list before
    // it fetched anything, so everything it knows it learned afterwards. The
    // tests that model an OVERLAP set it to an EARLIER generation, which is what
    // "the list moved while I was working" looks like.
    generationAtStart: input.generationAtStart === undefined ? GEN : input.generationAtStart,
    stored: input.stored,
    storedGeneration,
    storedLedger: {
      generation: ledgerGeneration,
      seenAtGeneration: input.storedSeenAt
        ? new Map(input.storedSeenAt)
        : new Map(input.stored.map((id) => [id, 1])),
    },
    attempted: new Set(input.attempted ?? []),
    cleared: new Set(input.cleared ?? []),
    observed: input.observed ?? [],
  }
}

function noEvidence(stored: number[]) {
  return evidence({ stored })
}
test('the read cap is the STORE limit, and the store is bigger than the retry window', () => {
  // Round 2 read at most one window's worth, so a 250-id backlog came back as
  // 100 and the other 150 were gone the moment the row was rewritten. The window
  // still bounds the WORK (one WooCommerce request); the store bounds the ROW.
  assert.ok(
    WC_PRODUCT_CONFLICT_STORE_LIMIT > WC_PRODUCT_CONFLICT_RETRY_LIMIT,
    'a store no bigger than the window cannot rotate — it can only truncate',
  )
  const many = Array.from({ length: WC_PRODUCT_CONFLICT_RETRY_LIMIT * 3 }, (_, i) => i + 1)
  assert.equal(
    parseWcProductConflictIds(JSON.stringify(many)).length,
    WC_PRODUCT_CONFLICT_RETRY_LIMIT * 3,
    'a backlog longer than one window must survive being read back',
  )
  const overStore = Array.from({ length: WC_PRODUCT_CONFLICT_STORE_LIMIT + 10 }, (_, i) => i + 1)
  assert.equal(parseWcProductConflictIds(JSON.stringify(overStore)).length, WC_PRODUCT_CONFLICT_STORE_LIMIT)
})

test('the cap reports what it kept AND what it dropped', () => {
  const many = Array.from({ length: WC_PRODUCT_CONFLICT_STORE_LIMIT + 5 }, (_, i) => i + 1)
  const { kept, dropped } = capWcProductConflictIds(many)

  assert.equal(kept.length, WC_PRODUCT_CONFLICT_STORE_LIMIT)
  assert.deepEqual(dropped, many.slice(WC_PRODUCT_CONFLICT_STORE_LIMIT))
  assert.deepEqual(
    kept.filter((id) => dropped.includes(id)),
    [],
    'an id is carried or dropped, never both — the caller reports the second as a held cursor',
  )
})

test('the cap drops nothing when it does not need to, and de-duplicates first', () => {
  assert.deepEqual(capWcProductConflictIds([]), { kept: [], dropped: [] })
  assert.deepEqual(capWcProductConflictIds([77, 77, 88]), { kept: [77, 88], dropped: [] })
  // Duplicates and junk are removed BEFORE the cap, so a list of the same id
  // repeated 2000 times does not report 1000 abandoned products.
  const repeated = Array.from({ length: WC_PRODUCT_CONFLICT_STORE_LIMIT * 2 }, () => 77)
  assert.deepEqual(capWcProductConflictIds(repeated), { kept: [77], dropped: [] })
  assert.deepEqual(capWcProductConflictIds([0, -3, 1.5, 5]), { kept: [5], dropped: [] })
})

test('the conflict lock is mode-scoped, exactly like the row it protects', () => {
  // Serializing the poll against the reconcile would be contention with no
  // safety gain: they write different rows. Serializing the manual reconcile
  // against the cron one is the entire point — they write the SAME row.
  assert.notEqual(wcProductConflictLockId('poll'), wcProductConflictLockId('reconcile'))
  assert.equal(wcProductConflictLockId('manual_reconcile'), wcProductConflictLockId('reconcile'))
})

// ---------------------------------------------------------------------------
// o3d-xbt round 3, finding 1 — the list is MERGED onto, not replaced.
//
// Two sweeps overlap (the cron reconcile against the manual one, or the poll
// against itself), and the one that finishes second used to write a list
// computed from a snapshot taken before the first one committed. Every id the
// first recorded vanished, with the cursor already past those products.
// ---------------------------------------------------------------------------

test('ids the run knows NOTHING about survive the merge untouched', () => {
  // 99 is another sweep's: it was not on our list when we started, we never
  // fetched it, and we have no evidence about it whatsoever. Replacing the row
  // drops it; merging keeps it.
  const merged = mergeWcProductConflictIds(evidence({
    stored: [99],
    attempted: new Set([77]),
    cleared: new Set(),
    observed: [77],
  }))
  assert.deepEqual(merged.kept, [99, 77], 'the other sweep\'s id stays, and ours joins it')
  assert.deepEqual(merged.dropped, [])
})

test('an id leaves the list on EVIDENCE only — cleared goes, everything else stays', () => {
  const merged = mergeWcProductConflictIds(evidence({
    stored: [1, 2, 3, 4],
    // 1 imported cleanly; 2 was attempted and failed TRANSIENTLY; 3 was attempted
    // and conflicted again; 4 was never reached (outside this run's window).
    attempted: new Set([1, 2, 3]),
    cleared: new Set([1]),
    observed: [3],
  }))
  assert.equal(merged.kept.includes(1), false, 'evidence it imported — the only thing that clears an id')
  assert.equal(merged.kept.includes(2), true, 'a transient failure says nothing about whether it still conflicts')
  assert.equal(merged.kept.includes(3), true, 'and a re-observed conflict certainly stays')
  assert.equal(merged.kept.includes(4), true, 'not reaching an id is not evidence about it')
})

test('a conflict observed this run outranks a stale clear', () => {
  // Nothing should produce both; if something ever does, the reading that keeps
  // the product on the list is the safe one.
  const merged = mergeWcProductConflictIds(evidence({
    stored: [5],
    attempted: new Set([5]),
    cleared: new Set([5]),
    observed: [5],
  }))
  assert.deepEqual(merged.kept, [5])
})

test('the merge is a no-op for a run that saw nothing', () => {
  assert.deepEqual(mergeWcProductConflictIds(noEvidence([7, 8, 9])).kept, [7, 8, 9])
})

// ---------------------------------------------------------------------------
// o3d-xbt round 3, finding 2 — the store ROTATES, so the window is not a cap.
// ---------------------------------------------------------------------------

test('ids this run attempted go to the BACK, so the next window is the ids it did not reach', () => {
  const merged = mergeWcProductConflictIds(evidence({
    stored: [1, 2, 3, 4, 5],
    attempted: new Set([1, 2]),
    cleared: new Set(),
    observed: [1, 2],
  }))
  assert.deepEqual(
    merged.kept,
    [3, 4, 5, 1, 2],
    'a fixed order would re-attempt the same head every run and never reach the tail at all',
  )
})

test('a backlog longer than the window is walked in full, a window at a time', () => {
  // The property the whole rotation exists for: every carried id IS re-attempted,
  // within ceil(n / window) runs, at one extra request per run.
  const window = WC_PRODUCT_CONFLICT_RETRY_LIMIT
  let list = Array.from({ length: window * 2 + 5 }, (_, i) => i + 1)
  const attemptedEver = new Set<number>()

  for (let run = 0; run < 3; run++) {
    const thisWindow = list.slice(0, window)
    for (const id of thisWindow) attemptedEver.add(id)
    list = mergeWcProductConflictIds(evidence({
      stored: list,
      attempted: new Set(thisWindow),
      cleared: new Set(),
      observed: thisWindow,
    })).kept
  }

  assert.equal(attemptedEver.size, window * 2 + 5, 'every id was re-attempted within three runs')
  assert.equal(list.length, window * 2 + 5, 'and none of them was dropped to achieve it')
})

test('the cap drops the ids a HELD cursor can re-present, never the carried ones', () => {
  // Bands 1 and 2 sit behind a cursor that has already moved past them, so
  // dropping one really would abandon it. A band-3 id was fetched by THIS run's
  // modified-after window, so holding the cursor brings it back. The cap must
  // therefore eat the fresh band, and say which ids those were.
  const stored = Array.from({ length: WC_PRODUCT_CONFLICT_STORE_LIMIT }, (_, i) => i + 1)
  const fresh = [900_001, 900_002, 900_003]
  const merged = mergeWcProductConflictIds(evidence({
    stored,
    attempted: new Set(fresh),
    cleared: new Set(),
    observed: fresh,
  }))

  assert.deepEqual(merged.kept, stored, 'every carried id is still carried')
  assert.deepEqual(merged.dropped, fresh)
  assert.deepEqual(
    merged.droppedRecoverableByCursor,
    fresh,
    'and the caller can tell the operator, truthfully, that holding the cursor covers them',
  )
})

test('a dropped id that the cursor CANNOT recover is reported separately', () => {
  // Only reachable if the stored row grew past the cap by some other route, which
  // parseWcProductConflictIds prevents today. It is distinguished anyway, because
  // the difference decides whether the message an operator reads is true.
  const stored = Array.from({ length: WC_PRODUCT_CONFLICT_STORE_LIMIT + 2 }, (_, i) => i + 1)
  const merged = mergeWcProductConflictIds(noEvidence(stored))
  assert.equal(merged.dropped.length, 2)
  assert.deepEqual(merged.droppedRecoverableByCursor, [], 'these were carried; the cursor is long past them')
})

// ---------------------------------------------------------------------------
// o3d-xbt round 4, finding 1 — A STALE SUCCESSFUL SWEEP MUST NOT ERASE A NEWER
// CONFLICT.
//
// Round 3 fixed the sweep that carried NO evidence about another sweep's id: the
// merge keeps what it cannot speak to. It did not fix the sweep whose evidence
// is real but OLD. Sweep A imports product 7 cleanly and then spends another
// twenty minutes on the rest of the catalogue. Sweep B starts later, re-imports
// 7, hits a GTIN collision, takes the lock and writes [7]. A finally reaches the
// lock, re-reads [7], and removes it — on evidence, exactly as round 3 requires,
// and the conflict is gone with the cursor already past the product.
//
// o3d-xbt round 5, finding 1 replaced the clock that ordered those two runs with
// the list's own GENERATION. The rule is unchanged: a clear must be shown to
// postdate the conflict it would answer, and anything unprovable keeps the
// product.
// ---------------------------------------------------------------------------

test('a clean import from BEFORE a carried conflict does not clear it (o3d-xbt r4, finding 1)', () => {
  const merged = mergeWcProductConflictIds(evidence({
    // We OVERLAP the other sweep: the list was at generation 5 when we read it,
    // and it is at 6 now, so the conflict on it was recorded while we worked.
    generationAtStart: GEN,
    stored: [7],
    storedGeneration: GEN + 1,
    storedSeenAt: new Map([[7, GEN + 1]]),
    attempted: [7],
    cleared: [7],
  }))

  assert.deepEqual(
    merged.kept,
    [7],
    'our import really did succeed, and it succeeded BEFORE the conflict that is now on the list — removing 7 would erase a live conflict with the cursor already past the product',
  )
  assert.deepEqual(merged.staleClears, [7], 'and the run says out loud that it declined to act on its own result')
})

test('a conflict recorded at a generation the run had ALREADY read is cleared', () => {
  // The mirror, and the reason the rule is a comparison rather than "a carried
  // id can never be cleared": the conflict was committed before we read the row,
  // so every fact we then gathered is later than it.
  const merged = mergeWcProductConflictIds(evidence({
    generationAtStart: GEN,
    stored: [7],
    storedGeneration: GEN + 1,
    // Recorded at 5 and merely carried through the generation-6 write by another
    // sweep that had nothing to say about product 7.
    storedSeenAt: new Map([[7, GEN]]),
    attempted: [7],
    cleared: [7],
  }))

  assert.deepEqual(merged.kept, [], 'newer evidence answers an older conflict — otherwise the list would never shrink')
  assert.deepEqual(merged.staleClears, [], 'nothing was declined')
})

test('a conflict recorded one generation past the run\'s start keeps the product', () => {
  // The tie, at the only resolution a generation has. Keeping a resolved product
  // costs one id in a by-id fetch; losing a conflicted one is permanent and
  // silent.
  const merged = mergeWcProductConflictIds(evidence({
    generationAtStart: GEN,
    stored: [7],
    storedGeneration: GEN + 1,
    storedSeenAt: new Map([[7, GEN + 1]]),
    attempted: [7],
    cleared: [7],
  }))

  assert.deepEqual(merged.kept, [7], 'a tie between two OVERLAPPING runs goes to the conflict')
  assert.deepEqual(merged.staleClears, [7])
})

test('a by-id fetch that answered WITHOUT the product is fenced the same way', () => {
  // The second kind of clearing evidence. It is not privileged: a store that
  // answered without product 7 half an hour ago says nothing about a conflict
  // recorded since, and the sweep that saw the conflict fetched it, so the
  // product plainly still exists.
  const stale = mergeWcProductConflictIds(evidence({
    generationAtStart: GEN,
    stored: [7],
    storedGeneration: GEN + 2,
    storedSeenAt: new Map([[7, GEN + 2]]),
    cleared: [7],
  }))
  assert.deepEqual(stale.kept, [7])
  assert.deepEqual(stale.staleClears, [7])
})

test('a re-observed conflict is stamped at the NEW generation, so an older sweep cannot answer it', () => {
  const merged = mergeWcProductConflictIds(evidence({
    stored: [7],
    storedSeenAt: new Map([[7, 1]]),
    attempted: [7],
    observed: [7],
  }))

  assert.equal(merged.generation, GEN + 1, 'the merge mints the next generation')
  assert.equal(
    merged.seenAtGeneration.get(7),
    GEN + 1,
    'the list carries WHEN it was last seen conflicted, not when it was first added',
  )
})

test('a run with nothing to say leaves the stamp exactly where it was', () => {
  // Re-stamping every carried id on every sweep would invalidate the clears of
  // every sweep already in flight, which is how a lapping poll stops being able
  // to clear anything at all.
  const merged = mergeWcProductConflictIds(evidence({
    stored: [7],
    storedSeenAt: new Map([[7, 2]]),
  }))

  assert.deepEqual(merged.kept, [7])
  assert.equal(merged.seenAtGeneration.get(7), 2, 'untouched means untouched')
})

test('a long-running sweep can still clear ids that nobody re-observed while it ran', () => {
  // The granularity the fence must not cost. Ten merges happened while this
  // sweep worked, but none of them said anything about product 7, so 7's
  // conflict still predates everything this run knows.
  const merged = mergeWcProductConflictIds(evidence({
    generationAtStart: GEN,
    stored: [7, 8],
    storedGeneration: GEN + 10,
    storedSeenAt: new Map([[7, GEN], [8, GEN + 10]]),
    attempted: [7, 8],
    cleared: [7, 8],
  }))

  assert.deepEqual(merged.kept, [8], '7 leaves; 8 was re-observed after we started and stays')
  assert.deepEqual(merged.staleClears, [8])
})

test('a stale clear is reported ONCE, not once per band it was tested in', () => {
  const merged = mergeWcProductConflictIds(evidence({
    generationAtStart: GEN,
    stored: [7, 8],
    storedGeneration: GEN + 1,
    storedSeenAt: new Map([[7, GEN + 1], [8, GEN + 1]]),
    attempted: [7],
    cleared: [7, 8],
  }))

  assert.deepEqual(merged.staleClears, [7, 8], 'one entry each, whichever rotation band the id belongs to')
})

// ---------------------------------------------------------------------------
// o3d-xbt round 5, finding 1 — TWO HOSTS' CLOCKS DO NOT AGREE, SO NOTHING IS
// DECIDED BY A CLOCK.
//
// Round 4 stamped the evidence with `Date.now()` on the host that gathered it.
// The cron reconcile and an operator's manual reconcile are different processes
// and may be different machines; NTP keeps each host approximately right, not
// two hosts equal. A host a few seconds fast records a conflict "in the future",
// and a slow host then judges its own stale success to be the newer fact and
// removes the conflict — the cursor is already past the product, both runs are
// green, and nothing anywhere mentions it again.
//
// These tests run the real read-merge-write cycle twice against one settings
// row, with the two sweeps on clocks that disagree by ten minutes in exactly the
// direction that fools a timestamp comparison.
// ---------------------------------------------------------------------------

/** The two settings rows, as strings, exactly as the sweep stores them. */
type ConflictRows = { list?: string; ledger?: string }

/** What a sweep reads before it fetches anything. */
function openSweep(rows: ConflictRows) {
  return {
    generationAtStart: parseWcProductConflictGeneration(rows.list),
    carried: parseWcProductConflictIds(rows.list),
  }
}

/** The read-modify-write under the lock, writing both rows as production does. */
function commitSweep(
  rows: ConflictRows,
  opened: { generationAtStart: number | null },
  gathered: { attempted?: Iterable<number>; cleared?: Iterable<number>; observed?: number[] },
) {
  const outcome = mergeWcProductConflictIds({
    generationAtStart: opened.generationAtStart,
    stored: parseWcProductConflictIds(rows.list),
    storedGeneration: parseWcProductConflictGeneration(rows.list),
    storedLedger: parseWcProductConflictLedger(rows.ledger),
    attempted: new Set(gathered.attempted ?? []),
    cleared: new Set(gathered.cleared ?? []),
    observed: gathered.observed ?? [],
  })
  rows.list = serializeWcProductConflictIds(outcome.kept, outcome.generation)
  rows.ledger = serializeWcProductConflictLedger(outcome.generation, outcome.seenAtGeneration, outcome.kept)
  return outcome
}

test('a sweep on a FAST clock cannot have its conflict erased by a slow one (o3d-xbt r5, finding 1)', () => {
  // Two hosts, ten minutes apart, and neither of them knows it.
  const slowHost = { now: () => 1_700_000_000_000 }
  const fastHost = { now: () => 1_700_000_000_000 + 10 * 60_000 }

  const rows: ConflictRows = {}
  // Generation 1 exists: product 7 conflicted at some point in the past and the
  // list is the only record the cursor has already stepped over it.
  const seeding = openSweep(rows)
  commitSweep(rows, seeding, { attempted: [7], observed: [7] })

  // REAL ORDER OF EVENTS.
  // 1. The slow-clocked sweep starts and imports product 7 cleanly.
  const slow = openSweep(rows)
  const slowClearedAt = slowHost.now()
  // 2. The fast-clocked sweep starts AFTER it, re-imports 7, and this time a
  //    GTIN collision refuses it. It reaches the lock first and writes.
  const fast = openSweep(rows)
  const fastObservedAt = fastHost.now()
  commitSweep(rows, fast, { attempted: [7], observed: [7] })

  assert.ok(
    slowClearedAt < fastObservedAt,
    'sanity: in REAL time the clean import happened first, which is why it must not answer the conflict',
  )
  assert.notEqual(
    fastHost.now(),
    slowHost.now(),
    'sanity: the two hosts disagree about what time it is, so any rule comparing their stamps is deciding on the skew',
  )

  // 3. The slow-clocked sweep finally reaches the lock, still holding its clean
  //    import.
  const outcome = commitSweep(rows, slow, { attempted: [7], cleared: [7] })

  assert.deepEqual(outcome.kept, [7], 'the live conflict survives a stale success, whatever the two clocks say')
  assert.deepEqual(outcome.staleClears, [7])
  assert.deepEqual(parseWcProductConflictIds(rows.list), [7], 'and the row still names the product')
})

test('reversing the skew does not reverse the answer', () => {
  // The same real sequence, with the CLEARING host now the fast one — so its
  // stale success carries the larger timestamp by ten minutes. Round 4's
  // comparison (`clearedAt > seenAt`, and a run-start arm reading the same
  // clock) says "newer, clear it" here and "older, keep it" above, off nothing
  // but which machine picked up the job.
  const rows: ConflictRows = {}
  commitSweep(rows, openSweep(rows), { attempted: [7], observed: [7] })

  const clearingHost = { now: () => 1_700_000_000_000 + 10 * 60_000 }
  const observingHost = { now: () => 1_700_000_000_000 }

  const clearing = openSweep(rows)
  const clearedAt = clearingHost.now()
  const observing = openSweep(rows)
  const observedAt = observingHost.now()
  commitSweep(rows, observing, { attempted: [7], observed: [7] })

  assert.ok(
    clearedAt > observedAt,
    'the stale success now LOOKS newer by ten minutes — this is the input that made round 4 erase the conflict',
  )
  const outcome = commitSweep(rows, clearing, { attempted: [7], cleared: [7] })
  assert.deepEqual(outcome.kept, [7], 'and the answer is the same one, because no clock was consulted')
})

test('two SEQUENTIAL runs are not a race, so a resolved product leaves on the very next run', () => {
  // The arm that is not cosmetic. Run N records the conflict; run N+1 starts
  // afterwards, re-fetches by id and imports it cleanly — possibly within the
  // same millisecond, on a small catalogue, which is what regressed when round 4
  // tried to decide this on per-id stamps alone. Generations have no resolution
  // to lose: two sequential sweeps are two different numbers however fast they
  // run.
  const rows: ConflictRows = {}
  commitSweep(rows, openSweep(rows), { attempted: [7], observed: [7] })
  assert.deepEqual(parseWcProductConflictIds(rows.list), [7], 'precondition: run N recorded the conflict')

  const next = openSweep(rows)
  const outcome = commitSweep(rows, next, { attempted: [7], cleared: [7] })

  assert.deepEqual(outcome.kept, [], 'the run began after the conflict was committed, so its evidence cannot predate it')
  assert.deepEqual(outcome.staleClears, [])
})

// ---------------------------------------------------------------------------
// o3d-xbt round 5, finding 2 — AN OLDER BUILD THAT WRITES MUST DEGRADE TO SAFE.
//
// Round 4 chose a sidecar row so that an older build READING the list would
// still see a plain array of ids rather than parsing an envelope as empty. That
// reasoning is right and incomplete: on a rollback, and for the minutes a fleet
// takes to roll, the older build also WRITES. It merges the list and leaves the
// ledger untouched, and round 4 read a missing entry as "older than everything,
// clear it" — so the very build the sidecar was designed to protect became the
// one that caused the silent erasure.
//
// The generation marker rides in the list precisely so that write is visible:
// any build that does not know about it strips it, and the two rows then
// disagree.
// ---------------------------------------------------------------------------

/** What a round-3/round-4 build writes: `JSON.stringify(kept)`, bare integers. */
function olderBuildWrites(rows: ConflictRows, kept: number[]) {
  rows.list = JSON.stringify(kept)
}

test('an older build still reads the id list exactly, marker and all (o3d-xbt r5, finding 2)', () => {
  // The property the sidecar was chosen for, kept. Every build's id parser drops
  // an entry that is not a positive integer, so the marker is invisible to all of
  // them and the retry set is unchanged.
  const written = serializeWcProductConflictIds([77, 88], 3)
  assert.deepEqual(JSON.parse(written), ['gen:3', 77, 88], 'the marker is an ordinary array element')
  assert.deepEqual(parseWcProductConflictIds(written), [77, 88], 'and it is not an id')
  assert.equal(parseWcProductConflictGeneration(written), 3)
  assert.equal(parseWcProductConflictGeneration('[77, 88]'), null, 'a list an older build wrote has no generation')
})

test('an older build that RE-OBSERVES a conflict cannot have it erased', () => {
  // The case a set-comparison or a content hash cannot see, and the one that
  // matters most: the older build changes NOTHING about the list — one id in,
  // the same id out — while what it means has changed completely, because that
  // id was seen conflicting again just now.
  const rows: ConflictRows = {}
  commitSweep(rows, openSweep(rows), { attempted: [7], observed: [7] })
  const ledgerBefore = rows.ledger

  // Our sweep starts, reads the list, and imports product 7 cleanly.
  const ours = openSweep(rows)

  // A rolled-back instance re-observes the conflict and rewrites the list. Same
  // ids, same order, same JSON an older build would produce — and no ledger.
  olderBuildWrites(rows, [7])
  assert.equal(rows.ledger, ledgerBefore, 'precondition: the older build did not touch the ledger')

  const outcome = commitSweep(rows, ours, { attempted: [7], cleared: [7] })

  assert.equal(outcome.attributable, false, 'the two rows disagree, so nothing in the ledger describes this list')
  assert.deepEqual(outcome.kept, [7], 'and the conflict survives instead of being erased on an unverifiable stamp')
  assert.deepEqual(outcome.staleClears, [7], 'reported, so "nothing cleared" is not mistaken for "nothing resolved"')
})

test('an id an older build ADDED is not cleared on a missing entry either', () => {
  const rows: ConflictRows = {}
  commitSweep(rows, openSweep(rows), { attempted: [7], observed: [7] })
  const ours = openSweep(rows)

  // The older build adds product 9, which has no ledger entry at all. Round 4
  // read that absence as zero — "older than anything you could be holding" —
  // which is true only of a fleet that has finished rolling.
  olderBuildWrites(rows, [7, 9])

  const outcome = commitSweep(rows, ours, { attempted: [7, 9], cleared: [7, 9] })

  assert.deepEqual(outcome.kept, [7, 9], 'an unstamped id was observed by SOMETHING, and we cannot say when')
  assert.deepEqual(outcome.staleClears, [7, 9])
})

test('the pair repairs itself in ONE merge, so a rollback costs a sweep and not a mechanism', () => {
  const rows: ConflictRows = {}
  commitSweep(rows, openSweep(rows), { attempted: [7], observed: [7] })
  olderBuildWrites(rows, [7])

  // The merge that detects the strip re-stamps everything it carries.
  const repair = commitSweep(rows, openSweep(rows), { attempted: [7], cleared: [7] })
  assert.equal(repair.attributable, false)
  assert.equal(
    parseWcProductConflictGeneration(rows.list),
    parseWcProductConflictLedger(rows.ledger).generation,
    'both rows now name the same generation again',
  )

  // And the very next sweep clears normally.
  const after = commitSweep(rows, openSweep(rows), { attempted: [7], cleared: [7] })
  assert.equal(after.attributable, true)
  assert.deepEqual(after.kept, [], 'a genuinely resolved product costs one extra sweep, not its place on the list')
})

test('the generation never restarts below a stamp that outlived the marker', () => {
  // The repair must not re-introduce the erasure by numbering backwards: a
  // sweep that started at generation 4 must not find a NEWER list numbered 1 and
  // read its stamps as older. The ledger is the surviving memory of how far the
  // sequence had got.
  const rows: ConflictRows = {}
  for (let i = 0; i < 4; i++) commitSweep(rows, openSweep(rows), { attempted: [7], observed: [7] })
  const reached = parseWcProductConflictGeneration(rows.list)
  assert.equal(reached, 4)

  const inFlight = openSweep(rows)
  olderBuildWrites(rows, [7])
  const repair = commitSweep(rows, openSweep(rows), { attempted: [7], observed: [7] })

  assert.ok(repair.generation > reached!, 'the sequence continues from the ledger rather than from one')
  const outcome = commitSweep(rows, inFlight, { attempted: [7], cleared: [7] })
  assert.deepEqual(outcome.kept, [7], 'so the in-flight sweep still cannot answer a conflict recorded after it started')
})

test('a ledger this build does not recognise is no ledger, not a permissive one', () => {
  // Round 4's shape: bare `{id: epochMs}`, no version and no generation. Read as
  // generations those milliseconds would be enormous — but the rule must not
  // depend on that accident, so an unversioned ledger is rejected outright.
  assert.deepEqual(parseWcProductConflictLedger('{"7":1700000000000}'), { generation: null, seenAtGeneration: new Map() })
  for (const raw of ['', 'not json', '[1,2,3]', 'null', '{"v":2}', '{"v":1,"gen":3,"seen":{"7":1}}', '{"v":2,"gen":0,"seen":{}}']) {
    assert.equal(parseWcProductConflictLedger(raw).generation, null, `"${raw}" must not present itself as a ledger`)
  }
  const good = parseWcProductConflictLedger('{"v":2,"gen":3,"seen":{"7":2,"8":"3","9":-1,"x":1}}')
  assert.equal(good.generation, 3)
  assert.deepEqual([...good.seenAtGeneration], [[7, 2], [8, 3]], 'and junk entries are dropped, not thrown over')
})

test('an unreadable ledger keeps the products instead of clearing them', () => {
  const merged = mergeWcProductConflictIds(evidence({
    stored: [7],
    ledgerGeneration: null,
    attempted: [7],
    cleared: [7],
  }))

  assert.deepEqual(merged.kept, [7], 'a row we cannot read is not a row that says "go ahead"')
  assert.deepEqual(merged.staleClears, [7])
})

// ---------------------------------------------------------------------------
// The ledger row itself.
// ---------------------------------------------------------------------------

test('the ledger is a SEPARATE row, so an older build reads the id list unchanged', () => {
  assert.notEqual(wcProductConflictSeenAtSettingKey('poll'), wcProductConflictSettingKey('poll'))
  assert.notEqual(wcProductConflictSeenAtSettingKey('reconcile'), wcProductConflictSettingKey('reconcile'))
  assert.notEqual(
    wcProductConflictSeenAtSettingKey('poll'),
    wcProductConflictSeenAtSettingKey('reconcile'),
    'mode-scoped, like the list and the cursor it describes',
  )
  assert.equal(
    wcProductConflictSeenAtSettingKey('manual_reconcile'),
    wcProductConflictSeenAtSettingKey('reconcile'),
    'and the manual reconcile shares the reconcile row, because it shares the list',
  )
})

test('the ledger is PRUNED to the ids actually carried', () => {
  // Otherwise it is a map that only ever grows — the defect the store limit
  // stops, one row away.
  const written = serializeWcProductConflictLedger(4, new Map([[7, 2], [8, 3], [9, 1]]), [7, 9])
  assert.deepEqual(JSON.parse(written), { v: 2, gen: 4, seen: { '7': 2, '9': 1 } })
})

test('the merge prunes the stamps of ids the cap dropped', () => {
  const stored = Array.from({ length: WC_PRODUCT_CONFLICT_STORE_LIMIT }, (_, i) => i + 1)
  const merged = mergeWcProductConflictIds(evidence({
    stored,
    storedSeenAt: new Map(stored.map((id) => [id, 1])),
    attempted: [900_001],
    observed: [900_001],
  }))

  assert.deepEqual(merged.dropped, [900_001])
  assert.equal(merged.seenAtGeneration.has(900_001), false, 'a dropped id carries no stamp into the row')
  assert.equal(merged.seenAtGeneration.size, merged.kept.length, 'and every carried id has one')
})

test('every carried id is stamped, even one the run knew nothing about', () => {
  // A stamp that is merely absent is the state the fence cannot check, so the
  // merge never leaves one behind: an id with no provenance is stamped HERE,
  // which is the safe reading and the repair at the same time.
  const merged = mergeWcProductConflictIds(evidence({
    stored: [7, 8],
    storedSeenAt: new Map([[7, 2]]),
  }))

  assert.equal(merged.seenAtGeneration.get(7), 2)
  assert.equal(merged.seenAtGeneration.get(8), merged.generation, 'only a run starting after THIS merge may clear it')
})
