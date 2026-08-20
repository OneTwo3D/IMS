import assert from 'node:assert/strict'
import test from 'node:test'
import * as cursorNs from '../lib/connectors/woocommerce/sync/product-conflict-cursor.ts'

const cursor = 'default' in cursorNs
  ? cursorNs.default as typeof import('../lib/connectors/woocommerce/sync/product-conflict-cursor.ts')
  : cursorNs

const {
  WC_PRODUCT_CONFLICT_RETRY_LIMIT,
  capWcProductConflictIds,
  parseWcProductConflictIds,
  serializeWcProductConflictIds,
  shouldAdvanceWcProductCursor,
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

test('ids round-trip, de-duplicate, and are capped at one WooCommerce page', () => {
  assert.equal(serializeWcProductConflictIds([]), '[]')
  assert.equal(serializeWcProductConflictIds([77, 77, 88]), '[77,88]')

  const many = Array.from({ length: WC_PRODUCT_CONFLICT_RETRY_LIMIT + 25 }, (_, i) => i + 1)
  const kept = parseWcProductConflictIds(serializeWcProductConflictIds(many))
  assert.equal(
    kept.length,
    WC_PRODUCT_CONFLICT_RETRY_LIMIT,
    'the re-attempt must stay one extra request — an unbounded list would recreate the unbounded work this fixes',
  )
  assert.equal(kept[0], 1, 'the cap keeps the head of the list, so the ids just observed survive it')
})

// o3d-xbt round 2, Codex finding 2 — a bound that says what it dropped.

test('the cap reports what it kept AND what it dropped', () => {
  const many = Array.from({ length: WC_PRODUCT_CONFLICT_RETRY_LIMIT + 5 }, (_, i) => i + 1)
  const { kept, dropped } = capWcProductConflictIds(many)

  assert.equal(kept.length, WC_PRODUCT_CONFLICT_RETRY_LIMIT)
  assert.deepEqual(dropped, many.slice(WC_PRODUCT_CONFLICT_RETRY_LIMIT))
  assert.deepEqual(
    kept.filter((id) => dropped.includes(id)),
    [],
    'an id is carried or dropped, never both — the caller reports the second as abandoned',
  )
})

test('the cap drops nothing when it does not need to, and de-duplicates first', () => {
  assert.deepEqual(capWcProductConflictIds([]), { kept: [], dropped: [] })
  assert.deepEqual(capWcProductConflictIds([77, 77, 88]), { kept: [77, 88], dropped: [] })
  // Duplicates and junk are removed BEFORE the cap, so a list of the same id
  // repeated 200 times does not report 100 abandoned products.
  const repeated = Array.from({ length: WC_PRODUCT_CONFLICT_RETRY_LIMIT * 2 }, () => 77)
  assert.deepEqual(capWcProductConflictIds(repeated), { kept: [77], dropped: [] })
  assert.deepEqual(capWcProductConflictIds([0, -3, 1.5, 5]), { kept: [5], dropped: [] })
})

test('serialize is the cap — the two cannot report different truncations', () => {
  const many = Array.from({ length: WC_PRODUCT_CONFLICT_RETRY_LIMIT + 5 }, (_, i) => i + 1)
  assert.equal(serializeWcProductConflictIds(many), JSON.stringify(capWcProductConflictIds(many).kept))
})

test('the READ cap never exceeds the RETRY cap — nothing carried goes unattempted', () => {
  // syncAllWcProducts slices the carried list to WC_PRODUCT_CONFLICT_RETRY_LIMIT
  // before re-fetching. That slice is only harmless while the parse cap is no
  // larger; if it grew, the overflow would be dropped by that line in silence —
  // which is the very defect the truncation log above exists to prevent. Pinned,
  // rather than left as a property two constants happen to have.
  const many = Array.from({ length: WC_PRODUCT_CONFLICT_RETRY_LIMIT * 3 }, (_, i) => i + 1)
  assert.ok(
    parseWcProductConflictIds(JSON.stringify(many)).length <= WC_PRODUCT_CONFLICT_RETRY_LIMIT,
    'the read cap must stay at or below the retry cap',
  )
})
