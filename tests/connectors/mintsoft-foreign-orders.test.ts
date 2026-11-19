import assert from 'node:assert/strict'
import test from 'node:test'

import { formatTenantCursor, mintsoftRowCreatedAt, readMintsoftForeignOrders } from '@/lib/connectors/mintsoft/foreign-orders'

const S = new Date('2027-01-04T10:00:00.000Z')
const row = (id: number, number: string, created: string | null, client = 89) => ({ ID: id, OrderNumber: number, ClientId: client, ...(created ? { CreatedDate: created } : {}) })

const reader = (pages: unknown[][], linked: { ids?: string[]; numbers?: string[]; other?: string[] } = {}) => {
  const asked: string[] = []
  return {
    asked,
    deps: {
      clientId: 89,
      request: async (path: string) => { asked.push(path); return { data: pages[asked.length - 1] ?? [], status: 200 } },
      linked: async () => ({ ids: new Set(linked.ids ?? []), numbers: new Set(linked.numbers ?? []), numbersWithOtherId: new Set(linked.other ?? []) }),
    },
  }
}

test('an order created at or after S with no IMS link is foreign; one created before S, or one IMS holds a link for, is not', async () => {
  const r = reader([[
    row(1, 'W1', '2027-01-04T09:59:59Z'),   // before S
    row(2, 'W2', '2027-01-04T10:00:00Z'),   // exactly S: counted
    row(3, 'W3', '2027-01-05T08:00:00Z'),   // after S, linked by id
    row(4, 'W4', '2027-01-05T09:00:00Z'),   // after S, linked by number
    row(5, 'W5', '2027-01-05T10:00:00Z'),   // after S, no link
  ]], { ids: ['3'], numbers: ['W4'] })
  const out = await readMintsoftForeignOrders(S, r.deps)
  assert.deepEqual(out, { scanned: 5, foreign: 2, undated: 0, duplicates: 0, pages: 1 })
})

test('a row whose creation time cannot be read is COUNTED when unlinked (it cannot be shown to predate S), and flagged as undated', async () => {
  const out = await readMintsoftForeignOrders(S, reader([[row(1, 'W1', null), row(2, 'W2', 'not a date')]]).deps)
  assert.equal(out.foreign, 2)
  assert.equal(out.undated, 2)
})

test('the request is scoped to the client, asks for no items, and sends the cursor in the tenant zone 3 hours before S', async () => {
  const r = reader([[]])
  await readMintsoftForeignOrders(S, r.deps)
  const query = new URL(`https://x${r.asked[0]}`).searchParams
  assert.equal(new URL(`https://x${r.asked[0]}`).pathname, '/api/Order/List')
  assert.equal(query.get('ClientId'), '89')
  assert.equal(query.get('IncludeOrderItems'), null)
  assert.equal(query.get('SinceLastUpdated'), '2027-01-04T07:00:00', 'January is GMT: S minus 3 h')
})

test('paging: a full page asks for the next; a short page ends it; the counts add up across pages', async () => {
  const full = Array.from({ length: 100 }, (_, i) => row(i + 1, `W${i + 1}`, '2027-01-05T00:00:00Z'))
  const r = reader([full, [row(500, 'W500', '2027-01-05T00:00:00Z')]])
  const out = await readMintsoftForeignOrders(S, r.deps)
  assert.equal(r.asked.length, 2)
  assert.deepEqual(out, { scanned: 101, foreign: 101, undated: 0, duplicates: 0, pages: 2 })
})

test('FAIL CLOSED: a row of another client, a row with no ClientId, a row with no id, a non-object and an error all throw', async () => {
  await assert.rejects(readMintsoftForeignOrders(S, reader([[row(1, 'W1', '2027-01-05T00:00:00Z', 90)]]).deps), /cross-client/)
  await assert.rejects(readMintsoftForeignOrders(S, reader([[{ ID: 1, OrderNumber: 'W1' }]]).deps), /cross-client/)
  await assert.rejects(readMintsoftForeignOrders(S, reader([[{ OrderNumber: 'W1', ClientId: 89 }]]).deps), /no ID/)
  await assert.rejects(readMintsoftForeignOrders(S, reader([['x']]).deps), /not an object/)
  await assert.rejects(readMintsoftForeignOrders(S, { clientId: 89, request: async () => ({ data: null, status: 500, error: 'HTTP 500' }) }), /HTTP 500/)
  await assert.rejects(readMintsoftForeignOrders(S, { clientId: 89, request: async () => ({ data: { not: 'an array' }, status: 200 }) }), /expected an array/)
})

test('a list that never ends is refused rather than read as complete', async () => {
  const full = Array.from({ length: 100 }, (_, i) => row(i + 1, `W${i + 1}`, '2020-01-01T00:00:00Z'))
  await assert.rejects(readMintsoftForeignOrders(S, { clientId: 89, request: async () => ({ data: full, status: 200 }), linked: async () => ({ ids: new Set(), numbers: new Set() }) }), /exceeded 200 pages/)
})

test('creation times: a zone-less value is the tenant wall-clock (GMT in winter, BST in summer); a zoned value is exact', () => {
  assert.equal(mintsoftRowCreatedAt({ CreatedDate: '2027-01-05T10:00:00' })!.toISOString(), '2027-01-05T10:00:00.000Z')
  assert.equal(mintsoftRowCreatedAt({ CreatedDate: '2027-07-05T10:00:00' })!.toISOString(), '2027-07-05T09:00:00.000Z')
  assert.equal(mintsoftRowCreatedAt({ CreatedDate: '2027-07-05T10:00:00+01:00' })!.toISOString(), '2027-07-05T09:00:00.000Z')
  assert.equal(mintsoftRowCreatedAt({ CreatedDate: '' }), null)
  assert.equal(mintsoftRowCreatedAt({ DateCreated: '2027-01-05T10:00:00Z' })!.toISOString(), '2027-01-05T10:00:00.000Z', 'falls back to the next created field')
  assert.equal(formatTenantCursor(new Date('2027-07-05T09:00:00Z')), '2027-07-05T10:00:00')
})

test('a number match on a link that carries a DIFFERENT Mintsoft id is a duplicate: foreign, never linked', async () => {
  const r = reader([[row(9, 'W9', '2027-01-05T08:00:00Z'), row(4, 'W4', '2027-01-05T09:00:00Z')]], { other: ['W9'], numbers: ['W4'] })
  const out = await readMintsoftForeignOrders(S, r.deps)
  assert.deepEqual(out, { scanned: 2, foreign: 1, undated: 0, duplicates: 1, pages: 1 })
})

test('OrderDate is never the creation time: a row with only an OrderDate before S counts as foreign and undated', async () => {
  assert.equal(mintsoftRowCreatedAt({ OrderDate: '2027-01-01T10:00:00Z' }), null)
  const out = await readMintsoftForeignOrders(S, reader([[{ ID: 1, OrderNumber: 'W1', ClientId: 89, OrderDate: '2027-01-01T10:00:00Z' }]]).deps)
  assert.deepEqual([out.foreign, out.undated], [1, 1])
})

test('an undated row is spared only by an exact id link, never by a number-only link', async () => {
  const out = await readMintsoftForeignOrders(S, reader([[row(1, 'W1', null), row(2, 'W2', null)]], { ids: ['1'], numbers: ['W2'] }).deps)
  assert.deepEqual([out.foreign, out.undated], [1, 1])
})
