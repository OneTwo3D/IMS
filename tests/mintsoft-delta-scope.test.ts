import assert from 'node:assert/strict'
import test from 'node:test'
import { mintsoftDeltaScopeChanged, parseMintsoftPositiveId } from '../lib/connectors/mintsoft/settings/schema.ts'

// o3d-bjc finding 1: the inbound Order/List delta must be scoped to our own
// Mintsoft ClientId (shared 3PL tenant). parseMintsoftPositiveId is the single
// validator shared by the settings action (input validation), the connector
// (delta scoping), and the sweep gate (fail-closed enable check) — so they all
// agree on exactly what counts as "configured".

test('parseMintsoftPositiveId accepts positive whole numbers and trims', () => {
  assert.equal(parseMintsoftPositiveId('1234'), 1234)
  assert.equal(parseMintsoftPositiveId('  42  '), 42)
})

test('parseMintsoftPositiveId rejects blank / non-positive / non-integer / junk (→ null, delta stays off)', () => {
  assert.equal(parseMintsoftPositiveId(''), null)
  assert.equal(parseMintsoftPositiveId('   '), null)
  assert.equal(parseMintsoftPositiveId(null), null)
  assert.equal(parseMintsoftPositiveId(undefined), null)
  assert.equal(parseMintsoftPositiveId('0'), null)
  assert.equal(parseMintsoftPositiveId('-5'), null)
  assert.equal(parseMintsoftPositiveId('12.5'), null)
  assert.equal(parseMintsoftPositiveId('12x'), null)
  assert.equal(parseMintsoftPositiveId('abc'), null)
})

// o3d-bjc finding 4: changing the delta scope (client/channel/warehouse) must
// invalidate the persisted watermark + last-reconcile cursors — otherwise the
// first query after a scope correction starts from the OLD scope's cursor and
// outstanding new-scope orders never enter the delta. mintsoftDeltaScopeChanged
// drives the cursor-clearing branch in saveMintsoftOrderDispatchSettings.

const PREV = {
  mintsoft_client_id: '5',
  mintsoft_channel_id: '2',
  mintsoft_warehouse_id: '7',
}

test('mintsoftDeltaScopeChanged is FALSE when nothing changed (cursors kept)', () => {
  assert.equal(mintsoftDeltaScopeChanged({ clientId: '5', channelId: '2', warehouseId: '7' }, PREV), false)
})

test('mintsoftDeltaScopeChanged is TRUE when the ClientId changes (cursors cleared)', () => {
  assert.equal(mintsoftDeltaScopeChanged({ clientId: '6', channelId: '2', warehouseId: '7' }, PREV), true)
})

test('mintsoftDeltaScopeChanged is TRUE when the Channel or Warehouse changes', () => {
  assert.equal(mintsoftDeltaScopeChanged({ clientId: '5', channelId: '3', warehouseId: '7' }, PREV), true)
  assert.equal(mintsoftDeltaScopeChanged({ clientId: '5', channelId: '2', warehouseId: '8' }, PREV), true)
})

test('mintsoftDeltaScopeChanged is TRUE when a scope field is cleared (set to blank)', () => {
  assert.equal(mintsoftDeltaScopeChanged({ clientId: '', channelId: '2', warehouseId: '7' }, PREV), true)
})
