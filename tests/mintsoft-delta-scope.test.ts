import assert from 'node:assert/strict'
import test from 'node:test'
import { parseMintsoftPositiveId } from '../lib/connectors/mintsoft/settings/schema.ts'

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
