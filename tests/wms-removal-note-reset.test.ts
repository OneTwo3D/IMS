import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { parseRemovalNote, removalNoteKey, removalNoteMarker, REMOVAL_NOTE_KEY_PREFIX, serializeRemovalNote } from '../lib/domain/wms/removal-note-obligation.ts'

/**
 * A pending merged-line removal note lives in `settings`, not on the link, so the transaction reset (which deletes the orders and, by cascade,
 * their links) must delete these keys too: otherwise the push sweep would post an old note about a deleted order to the live warehouse.
 * (The sweep also refuses to post a note whose link or order is gone; that half is tested in the sweep and concurrency tests.)
 */
test('the transaction reset deletes the removal-note obligations, inside the transaction that deletes the orders', async () => {
  const source = await readFile(new URL('../app/actions/reset.ts', import.meta.url), 'utf8')
  const scope = source.slice(source.indexOf('async function clearTransactionScope'), source.indexOf('async function clearProductScope'))
  const orders = scope.indexOf('await tx.salesOrder.deleteMany({})')
  const keys = scope.indexOf('await tx.setting.deleteMany({ where: { key: { startsWith: REMOVAL_NOTE_KEY_PREFIX } } })')
  const end = scope.indexOf('}, { timeout: 600_000')
  assert.ok(orders !== -1 && keys > orders && keys < end, 'the obligation keys are deleted in the sales transaction, after the orders')
  assert.match(source, /import \{ REMOVAL_NOTE_KEY_PREFIX \} from '@\/lib\/domain\/wms\/removal-note-obligation'/)
})

test('an obligation round-trips and an unreadable one is refused; the marker names link and obligation', () => {
  const ob = { id: 'o1', linkId: 'l1', orderId: 'so1', externalOrderId: 'w1', state: 'owed' as const, attempted: false, items: [{ externalItemId: '1', sku: 'S', quantity: 2 }] }
  assert.deepEqual(parseRemovalNote(serializeRemovalNote(ob)), ob)
  assert.equal(parseRemovalNote('{'), null)
  assert.equal(parseRemovalNote(JSON.stringify({ ...ob, state: 'weird' })), null)
  assert.equal(parseRemovalNote(JSON.stringify({ ...ob, items: [{ externalItemId: 1 }] })), null)
  assert.equal(removalNoteMarker(ob), '[IMS removal-note l1-o1]')
  assert.ok(removalNoteKey('mintsoft', 'l1').startsWith(REMOVAL_NOTE_KEY_PREFIX))
})
