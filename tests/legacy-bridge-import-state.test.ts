import assert from 'node:assert/strict'
import test from 'node:test'

import { checkOrderNumber, decideLink, desiredLinkFor, readLegacyOrderState, type ExistingLink } from '@/lib/connectors/mintsoft/legacy-bridge-import/state'

const meta = (pairs: Record<string, unknown>) => Object.entries(pairs).map(([key, value]) => ({ id: 1, key, value }))
const order = (pairs: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ id: 501, number: '1001', status: 'processing', meta_data: meta(pairs), ...extra })
const state = (pairs: Record<string, unknown>) => readLegacyOrderState(order(pairs))!

test('an order with no bridge meta carries no bridge state', () => {
  const s = readLegacyOrderState(order({ _other: 'x', _mintsoft_order_id: '', _mintsoft_terminal: 0 }))!
  assert.equal(s.hasBridgeState, false)
  assert.deepEqual(desiredLinkFor(s), { kind: 'none', reason: 'not-created-by-bridge' })
})

test('an unreadable meta list is null, never "no state"', () => {
  assert.equal(readLegacyOrderState({ id: 1, meta_data: null }), null)
  assert.equal(readLegacyOrderState({ id: 1, meta_data: [{ key: 7 }] }), null)
})

test('plain order: trusted id becomes a SYNCED link', () => {
  const s = state({ _mintsoft_order_id: '9001', _mintsoft_order_number: '1001', _mintsoft_status: 'NEW' })
  assert.deepEqual(desiredLinkFor(s), { kind: 'link', state: 'SYNCED', externalOrderId: '9001', externalOrderNumber: '1001', lastError: null })
})

test('merged order: MERGED naming the survivor, with the combined number only when recorded', () => {
  const s = state({ _mintsoft_order_id: 9100, _mintsoft_merged: '1', _mintsoft_order_number: '1001+1002' })
  assert.deepEqual(desiredLinkFor(s), { kind: 'link', state: 'MERGED', externalOrderId: '9100', externalOrderNumber: '1001+1002', lastError: null })
  const bare = state({ _mintsoft_order_id: 9100, _mintsoft_merged: 1 })
  assert.equal((desiredLinkFor(bare) as { externalOrderNumber: string | null }).externalOrderNumber, null)
})

test('split and partially despatched: parts are read, link is SYNCED on the primary id', () => {
  const s = state({ _mintsoft_order_id: '9200', _mintsoft_total_parts: '3', _mintsoft_split_parts_done: [1], _mintsoft_split_part_statuses: { '1': 'despatched', '2': 'NEW', '3': 'ONBACKORDER' } })
  assert.deepEqual(s.split, { totalParts: 3, thisPart: null, partsDone: [1], partsResolved: [], partStatuses: { '1': 'DESPATCHED', '2': 'NEW', '3': 'ONBACKORDER' } })
  assert.equal((desiredLinkFor(s) as { state: string }).state, 'SYNCED')
  const csv = state({ _mintsoft_order_id: '9200', _mintsoft_split_parts_done: '1, 2' })
  assert.deepEqual(csv.split?.partsDone, [1, 2])
})

test('an unreadable parts meta is reported, not guessed', () => {
  const s = state({ _mintsoft_order_id: '9200', _mintsoft_split_parts_done: 'abc' })
  assert.deepEqual(s.unreadable, ['_mintsoft_split_parts_done'])
})

test('withdrawal-held: queue, ownership and token are read', () => {
  const s = state({ _mintsoft_order_id: '9300', _mintsoft_wdraw_pending: 'HOLD', _mintsoft_wdraw_token: 'abc', _mintsoft_wdraw_hold_owned: '1' })
  assert.deepEqual(s.withdrawal, { pending: 'hold', outbox: false, token: true, holdOwned: true, partial: false })
  assert.equal((desiredLinkFor(s) as { state: string }).state, 'SYNCED')
  assert.equal(state({ _mintsoft_wdraw_outbox: { action: 'reject' } }).withdrawal?.pending, 'outboxed')
})

test('dead-lettered with no id: DEAD_LETTER; with an id: the order exists so SYNCED', () => {
  const dead = state({ _mintsoft_sync_dead: '1', _mintsoft_sync_attempts: '5', _mintsoft_sync_pending: 'create' })
  assert.deepEqual(desiredLinkFor(dead), { kind: 'dead-letter', externalOrderId: null, attempts: 5, lastError: (desiredLinkFor(dead) as { lastError: string }).lastError })
  assert.equal((desiredLinkFor(state({ _mintsoft_sync_dead: '1', _mintsoft_order_id: '77' })) as { state: string }).state, 'SYNCED')
})

test('verify-pending: blocked (never a link) on the unproved id; the trusted id wins when both exist', () => {
  const v = state({ _mintsoft_verify_pending: '1', _mintsoft_verify_order_id: '9400' })
  assert.deepEqual(desiredLinkFor(v), { kind: 'blocked', reason: 'verify-pending', verifyOrderId: '9400' })
  assert.equal((desiredLinkFor(state({ _mintsoft_verify_pending: '1', _mintsoft_verify_order_id: '9400', _mintsoft_order_id: '9401' })) as { externalOrderId: string }).externalOrderId, '9401')
})

test('the bridge writeback queues are read: dead-letter, terminal-forced with a clipped reason, resolved split parts', () => {
  const v = state({ _mintsoft_order_id: '9001', _mintsoft_dead_letter: '1', _mintsoft_terminal_forced: '1', _mintsoft_terminal_forced_reason: `x\ny${'z'.repeat(200)}`, _mintsoft_split_parts_resolved: '2,3' })
  assert.equal(v.writebackDeadLetter, true)
  assert.equal(v.terminalForced, true)
  assert.equal(v.terminalForcedReason!.length, 80)
  assert.doesNotMatch(v.terminalForcedReason!, /\n/)
  assert.deepEqual(v.split?.partsResolved, [2, 3])
  const none = state({ _mintsoft_order_id: '9001' })
  assert.equal(none.writebackDeadLetter, false)
  assert.equal(none.terminalForced, false)
})

test('a queued create with no id is nothing to adopt; a malformed id is unreadable', () => {
  assert.equal(desiredLinkFor(state({ _mintsoft_sync_pending: 'create' })).kind, 'none')
  assert.deepEqual(desiredLinkFor(state({ _mintsoft_order_id: 'abc' })), { kind: 'unreadable', keys: ['_mintsoft_order_id'] })
  assert.deepEqual(desiredLinkFor(state({ _mintsoft_order_id: '12abc' })), { kind: 'unreadable', keys: ['_mintsoft_order_id'] })
})

test('legacy merge keys are surfaced', () => {
  assert.deepEqual(state({ _mintsoft_merge_candidate: '1', _mintsoft_merge_hold_since: '2026-11-01', _mintsoft_merge_hold_token: '' }).mergeStateKeys, ['_mintsoft_merge_candidate', '_mintsoft_merge_hold_since'])
})

test('OrderNumber: empty prefix equals the bridge number; a prefix breaks it; a merged survivor matches on a part', () => {
  const plain = state({ _mintsoft_order_id: '1', _mintsoft_order_number: '1001' })
  assert.deepEqual(checkOrderNumber(plain, '', null), { ok: true, imsReference: '1001' })
  assert.deepEqual(checkOrderNumber(plain, 'WC-', null), { ok: false, imsReference: 'WC-1001', bridgeReference: '1001', reason: 'prefix' })
  const merged = state({ _mintsoft_order_id: '1', _mintsoft_merged: 1, _mintsoft_order_number: '1000+1001' })
  assert.equal(checkOrderNumber(merged, '', null).ok, true)
  assert.equal(checkOrderNumber(plain, '', '1001').ok, true)
  assert.deepEqual(checkOrderNumber(plain, '', 'X1001'), { ok: false, imsReference: 'X1001', bridgeReference: '1001', reason: 'differs' })
})

const existing = (over: Partial<ExistingLink> = {}): ExistingLink => ({ id: 'l1', connector: 'mintsoft', state: 'SYNCED', externalOrderId: '9001', externalOrderNumber: '1001', attempts: 0, lastAttemptAt: new Date(), pushedAt: new Date(), ...over })

test('decideLink: create, unchanged, adopt a bare placeholder, conflict otherwise', () => {
  const desired = desiredLinkFor(state({ _mintsoft_order_id: '9001' }))
  assert.equal(decideLink(desired, null, 'mintsoft').action, 'create')
  assert.equal(decideLink(desired, existing(), 'mintsoft').action, 'unchanged')
  assert.equal(decideLink(desired, existing({ state: 'PENDING_CREATE', externalOrderId: null, lastAttemptAt: null, pushedAt: null }), 'mintsoft').action, 'adopt')
  const differs = decideLink(desired, existing({ externalOrderId: '8888' }), 'mintsoft')
  assert.equal(differs.action, 'conflict')
  // A claimed create (dispatch stamp) is in flight, not a placeholder.
  assert.equal(decideLink(desired, existing({ state: 'PENDING_CREATE', externalOrderId: null, lastAttemptAt: new Date(), pushedAt: null }), 'mintsoft').action, 'conflict')
  assert.equal(decideLink(desired, existing({ state: 'HELD', externalOrderId: null, pushedAt: null }), 'mintsoft').action, 'conflict')
  assert.equal(decideLink(desired, existing({ connector: 'other' }), 'mintsoft').action, 'conflict')
  // The same id in another state is a conflict, not "unchanged".
  for (const state of ['DEAD_LETTER', 'CANCELLED', 'HELD', 'AMBIGUOUS_CREATE', 'PENDING_VERIFY', 'MERGED']) {
    assert.equal(decideLink(desired, existing({ state }), 'mintsoft').action, 'conflict', state)
  }
})
