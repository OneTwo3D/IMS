import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { parseRemovalNote, removalNoteKey, REMOVAL_NOTE_KEY_PREFIX, serializeRemovalNote } from '../lib/domain/wms/removal-note-obligation.ts'

/**
 * A merged-line removal obligation lives in `settings`, not on the link, so the transaction reset (which deletes the orders and, by cascade,
 * their links) must delete these keys too: otherwise the push sweep would raise an old operator task about a deleted order.
 * (The sweep also drops an obligation whose link or order is gone; that half is tested in the sweep and concurrency tests.)
 * The operator tasks themselves are rows of their own table that go with the order: the foreign key cascades (pinned below against the migration and
 * the schema), so the reset needs no statement of its own (and the reset's test doubles need no new model).
 */
test('the transaction reset deletes the removal-note obligations right after the transaction that deletes the orders', async () => {
  const source = await readFile(new URL('../app/actions/reset.ts', import.meta.url), 'utf8')
  const scope = source.slice(source.indexOf('async function clearTransactionScope'), source.indexOf('async function clearProductScope'))
  const orders = scope.indexOf('await tx.salesOrder.deleteMany({})')
  const end = scope.indexOf('}, { timeout: 600_000')
  const keys = scope.indexOf('await db.setting.deleteMany({ where: { key: { startsWith: REMOVAL_NOTE_KEY_PREFIX } } })')
  assert.ok(orders !== -1 && end > orders && keys > end, 'the obligation keys are deleted after the sales transaction that deleted the orders')
  assert.ok(keys < scope.indexOf("guards.assertHeld('purchasing')"), 'and before the next stage')
  assert.match(source, /import \{ REMOVAL_NOTE_KEY_PREFIX \} from '@\/lib\/domain\/wms\/removal-note-obligation'/)
})

test('an obligation round-trips (including the task-raised flag); an unreadable one is refused; a row left by the posting design still parses', () => {
  const ob = { id: 'o1', linkId: 'l1', orderId: 'so1', externalOrderId: 'w1', state: 'owed' as const, items: [{ externalItemId: '1', sku: 'S', quantity: 2 }] }
  assert.deepEqual(parseRemovalNote(serializeRemovalNote(ob)), ob)
  assert.equal(parseRemovalNote('{'), null)
  assert.equal(parseRemovalNote(JSON.stringify({ ...ob, state: 'weird' })), null)
  assert.equal(parseRemovalNote(JSON.stringify({ ...ob, items: [{ externalItemId: 1 }] })), null)
  const flagged = { ...ob, state: 'needs_check' as const, detail: 'partial', taskRaised: true as const }
  assert.deepEqual(parseRemovalNote(serializeRemovalNote(flagged)), flagged)
  assert.ok(serializeRemovalNote(flagged).includes('"taskRaised":true'), 'the pending query excludes these rows by this exact compact text')
  // A row written by the earlier note-posting design carries `attempted`; it is read, and the field is dropped.
  assert.deepEqual(parseRemovalNote(JSON.stringify({ ...ob, attempted: true })), ob)
  assert.ok(removalNoteKey('mintsoft', 'l1', 'w1').startsWith(REMOVAL_NOTE_KEY_PREFIX))
})

test('operator tasks cascade with their order (so the transaction reset and an order delete leave none): the migration and the schema both say ON DELETE CASCADE', async () => {
  const dir = new URL('../prisma/migrations/', import.meta.url)
  const { readdirSync } = await import('node:fs')
  const name = readdirSync(dir).find((n) => n.endsWith('_wms_operator_tasks'))
  assert.ok(name, 'the migration exists')
  const sql = await readFile(new URL(`${name}/migration.sql`, dir), 'utf8')
  assert.match(sql, /ALTER TABLE "wms_operator_tasks" ADD CONSTRAINT "wms_operator_tasks_order_id_fkey" FOREIGN KEY \("order_id"\) REFERENCES "sales_orders"\("id"\) ON DELETE CASCADE/)
  const schema = await readFile(new URL('../prisma/schema.prisma', import.meta.url), 'utf8')
  assert.match(schema.slice(schema.indexOf('model WmsOperatorTask {')), /order\s+SalesOrder\s+@relation\(fields: \[orderId\], references: \[id\], onDelete: Cascade\)/)
})
