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
  parseWcProductConflictIds,
  parseWcProductConflictSeenAt,
  serializeWcProductConflictSeenAt,
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

/** The evidence a run with nothing to say would hand the merge. */
/**
 * A fixed "now" for the round-4 stamps. Real ms, so the ordering reads the way
 * production's does.
 */
const NOW = 1_700_000_000_000

/**
 * Fill in the round-4 timestamps with the values that reproduce round 3's
 * semantics EXACTLY: nothing carried has a stamp (so any evidence is newer,
 * which is what a list written by an older build looks like), and everything
 * this run saw, it saw NOW.
 *
 * The tests that are ABOUT the timestamps pass them explicitly.
 */
function evidence(input: {
  runStartedAt?: number
  stored: number[]
  attempted?: Iterable<number>
  cleared?: Iterable<number> | ReadonlyMap<number, number>
  observed?: number[]
  storedSeenAt?: ReadonlyMap<number, number>
  observedAt?: ReadonlyMap<number, number>
}) {
  const observed = input.observed ?? []
  const clearedInput = input.cleared ?? []
  const cleared = clearedInput instanceof Map
    ? clearedInput as ReadonlyMap<number, number>
    : new Map<number, number>([...(clearedInput as Iterable<number>)].map((id) => [id, NOW]))
  return {
    // Defaulted to NOW: a run that started after everything it is being compared
    // against, which is what a sequential sweep looks like. The tests that model
    // an OVERLAP set it explicitly to a moment before the stored observation.
    runStartedAt: input.runStartedAt ?? NOW,
    stored: input.stored,
    storedSeenAt: input.storedSeenAt ?? new Map<number, number>(),
    attempted: new Set(input.attempted ?? []),
    cleared,
    observed,
    observedAt: input.observedAt ?? new Map(observed.map((id) => [id, NOW])),
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
// Evidence therefore has a TIME, and a clear must be strictly newer than the
// observation it would override.
// ---------------------------------------------------------------------------

test('a clean import from BEFORE a carried conflict does not clear it (o3d-xbt r4, finding 1)', () => {
  const merged = mergeWcProductConflictIds(evidence({
    // We OVERLAP the other sweep: we were already running when it recorded the
    // conflict. Without this the runs are merely sequential and there is no race
    // to adjudicate.
    runStartedAt: NOW - 25 * 60_000,
    stored: [7],
    // What the lock re-read: another sweep observed this conflict a minute ago.
    storedSeenAt: new Map([[7, NOW]]),
    attempted: [7],
    // Ours imported cleanly — twenty minutes before that.
    cleared: new Map([[7, NOW - 20 * 60_000]]),
  }))

  assert.deepEqual(
    merged.kept,
    [7],
    'our import really did succeed, and it succeeded BEFORE the conflict that is now on the list — removing 7 would erase a live conflict with the cursor already past the product',
  )
  assert.deepEqual(merged.staleClears, [7], 'and the run says out loud that it declined to act on its own result')
})

test('a clean import from AFTER the carried conflict DOES clear it', () => {
  // The mirror, and the reason the rule is a comparison rather than "a carried
  // id can never be cleared": our import is the LATEST thing anyone knows about
  // product 7, so it is the answer.
  const merged = mergeWcProductConflictIds(evidence({
    // Still an overlap — we started before the conflict was recorded — so this
    // is decided by the per-id stamps and not by the run's start.
    runStartedAt: NOW - 30 * 60_000,
    stored: [7],
    storedSeenAt: new Map([[7, NOW - 20 * 60_000]]),
    attempted: [7],
    cleared: new Map([[7, NOW]]),
  }))

  assert.deepEqual(merged.kept, [], 'newer evidence answers an older conflict — otherwise the list would never shrink')
  assert.deepEqual(merged.staleClears, [], 'nothing was declined')
})

test('evidence gathered at the SAME instant as the conflict keeps the product', () => {
  // Strictly newer, on purpose. Keeping a resolved product costs one id in a
  // by-id fetch; losing a conflicted one is permanent and silent.
  const merged = mergeWcProductConflictIds(evidence({
    runStartedAt: NOW - 60_000,
    stored: [7],
    storedSeenAt: new Map([[7, NOW]]),
    attempted: [7],
    cleared: new Map([[7, NOW]]),
  }))

  assert.deepEqual(merged.kept, [7], 'a tie between two OVERLAPPING runs goes to the conflict')
  assert.deepEqual(merged.staleClears, [7])
})

test('a by-id fetch that answered WITHOUT the product is timed the same way', () => {
  // The second kind of clearing evidence. It is not privileged: a store that
  // answered without product 7 half an hour ago says nothing about a conflict
  // observed since, and the sweep that saw the conflict fetched it, so the
  // product plainly still exists.
  const stale = mergeWcProductConflictIds(evidence({
    runStartedAt: NOW - 35 * 60_000,
    stored: [7],
    storedSeenAt: new Map([[7, NOW]]),
    cleared: new Map([[7, NOW - 30 * 60_000]]),
  }))
  assert.deepEqual(stale.kept, [7])
  assert.deepEqual(stale.staleClears, [7])
})

test('a re-observed conflict pushes the stamp FORWARD, so an older sweep cannot answer it', () => {
  const merged = mergeWcProductConflictIds(evidence({
    stored: [7],
    storedSeenAt: new Map([[7, NOW]]),
    attempted: [7],
    observed: [7],
    observedAt: new Map([[7, NOW + 5_000]]),
  }))

  assert.equal(
    merged.seenAt.get(7),
    NOW + 5_000,
    'the list carries WHEN it was last seen conflicted, not when it was first added',
  )
})

test('a run with nothing to say leaves the stamp exactly where it was', () => {
  // Re-stamping to "now" on every sweep would silently re-arm every older
  // sweep's clearing evidence, which is the defect, restored by a different
  // route.
  const merged = mergeWcProductConflictIds(evidence({
    stored: [7],
    storedSeenAt: new Map([[7, NOW]]),
  }))

  assert.deepEqual(merged.kept, [7])
  assert.equal(merged.seenAt.get(7), NOW, 'untouched means untouched')
})

test('a list written by a build with NO sidecar still clears normally', () => {
  // The migration case. An id carried by an older build was written before this
  // build was deployed, so it genuinely predates every run that can be in
  // flight; treating its stamp as zero is not a fudge, it is the truth, and it
  // reproduces round 3's behaviour exactly until the row is first rewritten.
  const merged = mergeWcProductConflictIds(evidence({
    stored: [7],
    storedSeenAt: new Map(),
    attempted: [7],
    cleared: new Map([[7, 1]]),
  }))

  assert.deepEqual(merged.kept, [])
  assert.deepEqual(merged.staleClears, [])
})

test('a stale clear is reported ONCE, not once per band it was tested in', () => {
  const merged = mergeWcProductConflictIds(evidence({
    runStartedAt: NOW - 60_000,
    stored: [7, 8],
    storedSeenAt: new Map([[7, NOW], [8, NOW]]),
    attempted: [7],
    cleared: new Map([[7, NOW - 1], [8, NOW - 1]]),
  }))

  assert.deepEqual(merged.staleClears, [7, 8], 'one entry each, whichever rotation band the id belongs to')
})

// ---------------------------------------------------------------------------
// The sidecar row itself.
// ---------------------------------------------------------------------------

test('the sidecar is a SEPARATE row, so an older build reads the id list unchanged', () => {
  // Encoding the stamps into the id array — pairs, objects, a versioned envelope
  // — makes every older build parse the list as EMPTY, which is the silent
  // abandonment this mechanism exists to prevent, arriving on the day somebody
  // rolls back. A sidecar degrades to "no timestamps" instead.
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

test('an unreadable sidecar degrades to NO timestamps rather than throwing', () => {
  // Same rule the id list follows: a conflict list that throws takes down the
  // sync it exists to protect.
  for (const raw of ['', 'not json', '[1,2,3]', 'null', '{"7":"nonsense"}', '{"7":-1}', '{"nope":123}']) {
    assert.deepEqual([...parseWcProductConflictSeenAt(raw)], [], `"${raw}" must parse to an empty map`)
  }
  assert.deepEqual([...parseWcProductConflictSeenAt('{"7":1700000000000}')], [[7, 1_700_000_000_000]])
})

test('the sidecar is PRUNED to the ids actually carried', () => {
  // Otherwise it is a map that only ever grows — the defect the store limit
  // stops, one row away.
  const written = serializeWcProductConflictSeenAt(new Map([[7, NOW], [8, NOW], [9, NOW]]), [7, 9])
  assert.deepEqual(JSON.parse(written), { '7': NOW, '9': NOW })
})

test('the merge prunes the stamps of ids the cap dropped', () => {
  const stored = Array.from({ length: WC_PRODUCT_CONFLICT_STORE_LIMIT }, (_, i) => i + 1)
  const merged = mergeWcProductConflictIds(evidence({
    stored,
    storedSeenAt: new Map(stored.map((id) => [id, NOW])),
    attempted: [900_001],
    observed: [900_001],
  }))

  assert.deepEqual(merged.dropped, [900_001])
  assert.equal(merged.seenAt.has(900_001), false, 'a dropped id carries no stamp into the row')
  assert.equal(merged.seenAt.size, merged.kept.length)
})

test('two SEQUENTIAL runs are not a race, so a resolved product leaves on the very next run', () => {
  // The tie-break that a millisecond clock cannot make on the per-id stamps
  // alone. Run N records the conflict; run N+1 starts, re-fetches by id and
  // imports it cleanly — possibly within the same millisecond, on a small
  // catalogue. There is no overlap to adjudicate: everything run N+1 knows, it
  // learned after run N wrote that stamp. Deciding this on the per-id stamps
  // alone would leave a resolved product on the list for an extra run every
  // time.
  const merged = mergeWcProductConflictIds(evidence({
    runStartedAt: NOW,
    stored: [7],
    storedSeenAt: new Map([[7, NOW]]),
    attempted: [7],
    cleared: new Map([[7, NOW]]),
  }))

  assert.deepEqual(merged.kept, [], 'the run began no earlier than the conflict, so its evidence cannot predate it')
  assert.deepEqual(merged.staleClears, [])
})
