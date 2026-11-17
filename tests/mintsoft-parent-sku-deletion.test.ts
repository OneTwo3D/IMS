import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-zvec.20: deleting a variable product's parent SKU from Mintsoft is destructive, so it is FAIL-CLOSED.
 *
 * Proven here: OFF (default, and parity off) does nothing and reads nothing; with it ON the parent is deleted only when every
 * non-archived variation is confirmed from the stored links refreshed by the run; any doubt is a recorded refusal and NO delete call;
 * a shadow or a held/refused delete leaves the link; a thrown error deletes nothing. The connector is a fake: no Mintsoft call.
 */

type Row = Record<string, unknown>
const SINCE = new Date('2026-11-17T10:00:00Z')
const FRESH = new Date('2026-11-17T10:30:00Z')
const STALE = new Date('2026-11-16T10:30:00Z')

const state = {
  flags: {} as Record<string, string>,
  parents: [] as Row[],
  reads: [] as string[],
  readParent: (() => null) as (id: string, n: number) => Row | null,
  readCount: 0,
  seam: 'proceed' as 'proceed' | 'shadow',
  deleteResult: { deleted: true } as { deleted: boolean; held?: true; message?: string },
  deleteThrows: false,
  deleteCalls: [] as string[],
  linkDeletes: [] as Row[],
  events: [] as Row[],
  dbCalls: 0,
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: { findUnique: async ({ where }: { where: { key: string } }) => { return where.key in state.flags ? { value: state.flags[where.key] } : null } },
      product: {
        findMany: async () => { state.dbCalls += 1; return state.parents.map((p) => ({ id: p.id })) },
        findUnique: async ({ where }: { where: { id: string } }) => { state.dbCalls += 1; state.readCount += 1; return state.readParent(where.id, state.readCount) },
      },
      wmsProductLink: { deleteMany: async (args: Row) => { state.linkDeletes.push(args); return { count: 1 } } },
    },
  },
})
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })
mock.module('@/lib/domain/wms/mutation-audit', { namedExports: { recordWmsMutationEvent: async (event: Row) => { state.events.push(event) } } })
mock.module('../lib/connectors/mintsoft/producer-seam.ts', {
  namedExports: {
    mintsoftProducerSeam: async (input: { operation: string }) =>
      state.seam === 'proceed' && input.operation === 'product.delete'
        ? { proceed: true, clearance: {} }
        : { proceed: false, shadowed: true, notice: 'shadow', reason: 'test', recorded: true, occurrences: 1 },
  },
})
mock.module('@/lib/connectors/wms/registry', {
  namedExports: {
    getWmsConnector: () => ({
      async deleteProduct(id: string) {
        state.deleteCalls.push(id)
        if (state.deleteThrows) throw new Error('boom')
        return state.deleteResult
      },
    }),
  },
})

const echo = (id: string, sku: string) => ({ ID: Number(id), SKU: sku, Name: sku })
const link = (id: string, sku: string, over: Row = {}) => ({
  externalProductId: id, payloadHash: 'h', lastError: null, metadata: echo(id, sku), updatedAt: FRESH, ...over,
})
const variation = (sku: string, id: string | null, over: Row = {}, linkOver: Row = {}) => ({
  id: `v-${sku}`, sku, lifecycleStatus: 'ACTIVE', wmsProductLinks: id ? [link(id, sku, linkOver)] : [], ...over,
})
const parentRow = (variants: Row[], over: Row = {}) => ({
  id: 'p1', sku: 'PARENT', type: 'VARIABLE', wmsProductLinks: [link('100', 'PARENT')], variants, ...over,
})

function reset(opts: { flags?: Record<string, string>; parent?: Row; seam?: 'proceed' | 'shadow' }) {
  state.flags = opts.flags ?? { mintsoft_parent_sku_delete_enabled: 'true', mintsoft_product_parity_enabled: 'true' }
  state.parents = opts.parent ? [{ id: 'p1' }] : []
  state.readParent = () => opts.parent ?? null
  state.readCount = 0
  state.seam = opts.seam ?? 'proceed'
  state.deleteResult = { deleted: true }
  state.deleteThrows = false
  state.deleteCalls.length = 0
  state.linkDeletes.length = 0
  state.events.length = 0
  state.dbCalls = 0
}

async function pass() {
  const mod = await import('@/lib/connectors/mintsoft/sync/parent-sku-deletion')
  return mod.runMintsoftParentSkuDeletionPass({ since: SINCE, triggeredBy: 'test' })
}

const GOOD = () => parentRow([variation('A', '201'), variation('B', '202')])

test('both settings off: nothing is read and nothing is deleted', async () => {
  for (const flags of [{} as Record<string, string>, { mintsoft_parent_sku_delete_enabled: 'false', mintsoft_product_parity_enabled: 'true' }, { mintsoft_parent_sku_delete_enabled: 'TRUE', mintsoft_product_parity_enabled: 'true' }]) {
    reset({ flags, parent: GOOD() })
    assert.equal(await pass(), null)
    assert.equal(state.dbCalls, 0, 'no product was even read')
    assert.deepEqual(state.deleteCalls, [])
  }
})

test('the delete setting without the parity setting is still off', async () => {
  reset({ flags: { mintsoft_parent_sku_delete_enabled: 'true' }, parent: GOOD() })
  assert.equal(await pass(), null)
  assert.deepEqual(state.deleteCalls, [])
})

test('every variation confirmed from fresh stored links: the parent record is deleted once, and only its link is dropped', async () => {
  reset({ parent: GOOD() })
  const counters = await pass()
  assert.deepEqual(state.deleteCalls, ['100'])
  assert.equal(counters?.deleted, 1)
  assert.deepEqual(state.linkDeletes, [{ where: { connector: 'mintsoft', productId: 'p1', externalProductId: '100' } }])
  assert.equal(state.events.at(-1)?.action, 'parent_sku_delete')
  assert.equal(state.events.at(-1)?.outcome, 'SUCCEEDED')
})

type Case = { name: string; parent: Row; reason: RegExp }
const REFUSALS: Case[] = [
  { name: 'a variation has no link', parent: parentRow([variation('A', '201'), variation('B', null)]), reason: /B: no Mintsoft link/ },
  { name: 'a variation link records an error', parent: parentRow([variation('A', '201'), variation('B', '202', {}, { lastError: 'x' })]), reason: /B: its link records an error/ },
  { name: 'a variation link was not refreshed by this run', parent: parentRow([variation('A', '201'), variation('B', '202', {}, { updatedAt: STALE })]), reason: /B: its link was not refreshed by this run/ },
  { name: 'a variation was never matched or sent (no payload hash)', parent: parentRow([variation('A', '201'), variation('B', '202', {}, { payloadHash: null })]), reason: /no payload hash/ },
  { name: 'no stored Mintsoft record', parent: parentRow([variation('A', '201'), variation('B', '202', {}, { metadata: null })]), reason: /B: no stored Mintsoft record/ },
  { name: 'the stored record has another id', parent: parentRow([variation('A', '201'), variation('B', '202', {}, { metadata: echo('999', 'B') })]), reason: /different id/ },
  { name: 'the stored record has another SKU', parent: parentRow([variation('A', '201'), variation('B', '202', {}, { metadata: echo('202', 'OTHER') })]), reason: /different SKU/ },
  { name: 'a non-numeric Mintsoft id', parent: parentRow([variation('A', '201'), variation('B', 'abc')]), reason: /not a number/ },
  { name: 'two variations share one Mintsoft record', parent: parentRow([variation('A', '201'), variation('B', '201')]), reason: /same Mintsoft record|different id|different SKU/ },
  { name: 'a variation points at the parent record', parent: parentRow([variation('A', '100'), variation('B', '202')]), reason: /parent's own Mintsoft record|different SKU/ },
  { name: 'a variation has the parent SKU', parent: parentRow([variation('PARENT', '201'), variation('B', '202')]), reason: /parent's own SKU/ },
  { name: 'no live variation', parent: parentRow([variation('A', '201', { lifecycleStatus: 'ARCHIVED' })]), reason: /no live variation/ },
  { name: 'a variation with no SKU', parent: parentRow([variation('', '201'), variation('B', '202')]), reason: /no SKU/ },
  { name: 'not a variable product', parent: parentRow([variation('A', '201')], { type: 'SIMPLE' }), reason: /not a variable product/ },
  { name: 'the parent has no link', parent: parentRow([variation('A', '201')], { wmsProductLinks: [] }), reason: /no usable Mintsoft link/ },
]
for (const c of REFUSALS) {
  test(`FAIL-CLOSED: ${c.name} -> refused, recorded for an operator, no delete call`, async () => {
    reset({ parent: c.parent })
    const counters = await pass()
    assert.deepEqual(state.deleteCalls, [], 'deleteProduct was never called')
    assert.deepEqual(state.linkDeletes, [])
    assert.equal(counters?.refused, 1)
    const refusal = state.events.find((e) => e.action === 'parent_sku_delete_refused')
    assert.ok(refusal, 'a refused-action record was written')
    assert.equal(refusal.outcome, 'FAILED')
    assert.match(String(refusal.error), c.reason)
  })
}

test('an archived variation is not expected; a live one still must be confirmed', async () => {
  reset({ parent: parentRow([variation('A', '201'), variation('OLD', null, { lifecycleStatus: 'ARCHIVED' })]) })
  await pass()
  assert.deepEqual(state.deleteCalls, ['100'])
})

test('the proof is read TWICE: a link that changes between the reads is refused, nothing is deleted', async () => {
  reset({ parent: GOOD() })
  state.readParent = (_id, n) => (n === 1 ? GOOD() : parentRow([variation('A', '201'), variation('B', '202', {}, { updatedAt: STALE })]))
  const counters = await pass()
  assert.deepEqual(state.deleteCalls, [])
  assert.equal(counters?.refused, 1)
})

test('a shadowed seam deletes nothing and leaves the link', async () => {
  reset({ parent: GOOD(), seam: 'shadow' })
  const counters = await pass()
  assert.deepEqual(state.deleteCalls, [])
  assert.deepEqual(state.linkDeletes, [])
  assert.equal(counters?.shadowed, 1)
})

test('Mintsoft refusing the delete (or the hold) is recorded as failed and the link is kept', async () => {
  reset({ parent: GOOD() })
  state.deleteResult = { deleted: false, message: 'linked to orders' }
  let counters = await pass()
  assert.equal(counters?.refused, 1)
  assert.deepEqual(state.linkDeletes, [])
  assert.equal(state.events.at(-1)?.outcome, 'FAILED')

  reset({ parent: GOOD() })
  state.deleteResult = { deleted: false, held: true, message: 'held' }
  counters = await pass()
  assert.equal(counters?.held, 1)
  assert.deepEqual(state.linkDeletes, [])
})

test('an error while deleting is recorded, counted and deletes no link', async () => {
  reset({ parent: GOOD() })
  state.deleteThrows = true
  const counters = await pass()
  assert.equal(counters?.errors, 1)
  assert.deepEqual(state.linkDeletes, [])
  assert.equal(state.events.at(-1)?.outcome, 'FAILED')
})

test('the real client refuses a non-numeric id before sending anything, and reports Success:false as not deleted', async () => {
  const { deleteMintsoftProduct } = await import('@/lib/connectors/mintsoft/api/client')
  assert.deepEqual(await deleteMintsoftProduct('12; DROP'), { deleted: false, message: 'The Mintsoft product id is not a number; nothing was sent.' })
})

