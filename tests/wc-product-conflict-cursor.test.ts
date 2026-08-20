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
  shouldAdvanceWcProductCursor,
  wcProductConflictLockId,
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
function noEvidence(stored: number[]) {
  return { stored, attempted: new Set<number>(), cleared: new Set<number>(), observed: [] as number[] }
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
  const merged = mergeWcProductConflictIds({
    stored: [99],
    attempted: new Set([77]),
    cleared: new Set(),
    observed: [77],
  })
  assert.deepEqual(merged.kept, [99, 77], 'the other sweep\'s id stays, and ours joins it')
  assert.deepEqual(merged.dropped, [])
})

test('an id leaves the list on EVIDENCE only — cleared goes, everything else stays', () => {
  const merged = mergeWcProductConflictIds({
    stored: [1, 2, 3, 4],
    // 1 imported cleanly; 2 was attempted and failed TRANSIENTLY; 3 was attempted
    // and conflicted again; 4 was never reached (outside this run's window).
    attempted: new Set([1, 2, 3]),
    cleared: new Set([1]),
    observed: [3],
  })
  assert.equal(merged.kept.includes(1), false, 'evidence it imported — the only thing that clears an id')
  assert.equal(merged.kept.includes(2), true, 'a transient failure says nothing about whether it still conflicts')
  assert.equal(merged.kept.includes(3), true, 'and a re-observed conflict certainly stays')
  assert.equal(merged.kept.includes(4), true, 'not reaching an id is not evidence about it')
})

test('a conflict observed this run outranks a stale clear', () => {
  // Nothing should produce both; if something ever does, the reading that keeps
  // the product on the list is the safe one.
  const merged = mergeWcProductConflictIds({
    stored: [5],
    attempted: new Set([5]),
    cleared: new Set([5]),
    observed: [5],
  })
  assert.deepEqual(merged.kept, [5])
})

test('the merge is a no-op for a run that saw nothing', () => {
  assert.deepEqual(mergeWcProductConflictIds(noEvidence([7, 8, 9])).kept, [7, 8, 9])
})

// ---------------------------------------------------------------------------
// o3d-xbt round 3, finding 2 — the store ROTATES, so the window is not a cap.
// ---------------------------------------------------------------------------

test('ids this run attempted go to the BACK, so the next window is the ids it did not reach', () => {
  const merged = mergeWcProductConflictIds({
    stored: [1, 2, 3, 4, 5],
    attempted: new Set([1, 2]),
    cleared: new Set(),
    observed: [1, 2],
  })
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
    list = mergeWcProductConflictIds({
      stored: list,
      attempted: new Set(thisWindow),
      cleared: new Set(),
      observed: thisWindow,
    }).kept
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
  const merged = mergeWcProductConflictIds({
    stored,
    attempted: new Set(fresh),
    cleared: new Set(),
    observed: fresh,
  })

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
