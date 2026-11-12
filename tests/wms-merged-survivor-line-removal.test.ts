import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { OUTBOUND_GRANT_ENV } from '../lib/security/outbound-write-hold-constants.ts'
import { PRODUCER_CUTOFF_ENV, PRODUCER_HOLD_ENFORCED_ENV } from '../lib/security/producer-disposition-constants.ts'
import type { WmsOrderPushPort, WmsPushLinkRef } from '../lib/domain/wms/order-push-sweep.ts'
import type { WmsOrderItemRef, WmsOrderPushInput } from '../lib/connectors/wms/types.ts'

/**
 * AN IMS ORDER MERGED INTO A WAREHOUSE SURVIVOR IS CANCELLED: ITS LINES (AND ONLY ITS LINES) COME OUT OF THE SURVIVOR.
 *
 * The REAL sweep (runWmsOrderPushSweepCore) and the REAL Mintsoft order functions run against a STATEFUL FAKE of the warehouse: a
 * set of orders, each with lines under their own ids, that DELETE /Items/{id} really removes from, with fault injection. Nothing here
 * can reach Mintsoft (mintsoftRequest is replaced, and tests/no-outbound-network.cjs fails the file if anything tried to leave the box).
 *
 * The scene is the live one (2026-11-12): D (2537701) was merged into E (2537702). The survivor keeps E's id and both orders'
 * lines under their ORIGINAL ids, the shared SKU 243632999 staying as TWO lines:
 *   3603106 243632999 x2 (D)   3603107 923663020 x1 (D)   3603108 243632999 x1 (E)   3603109 849293203 x1 (E)
 *
 * Named mutations (each shown red, restored from a copy, md5-verified; see the PR):
 *  m1  delete-by-sku        the connector deletes the first line carrying the SKU, not the stored id: the happy path goes red
 *  m2  skip-status-gate     the connector deletes on any survivor status: the "past the editable status" arm goes red
 *  m3  skip-precheck        the connector deletes before checking SKU/quantity/presence: the missing/mismatch arms go red
 *  m4  silent-partial       a failed delete after the first is swallowed (the notice no longer lists removed/remaining): the partial arm goes red
 *  m5  never-last-lines     the "only lines left" case deletes the lines instead of cancelling the survivor: the last-lines arm goes red
 *  m6  skip-seam            the sweep removes lines without asking the producer seam: the grant arm goes red
 *  m7  skip-reread-check    the connector trusts the delete answer and skips the re-read comparison: the unchanged-lines arm goes red
 */

const CLIENT = 89
const NOW = () => new Date('2026-11-12T12:00:00.000Z')
const BINDINGS = [{ warehouseId: 'wh-1', externalWarehouseId: '6' }]
const SURVIVOR = '2537702'
const ABSORBED = '2537701'

// ---- the fake warehouse --------------------------------------------------------------------------------------------------------------
type FakeLine = { ID: number; SKU: string; Quantity: number }
type FakeOrder = { status: number; number: string; items: FakeLine[]; merged: boolean }
const fake = {
  orders: new Map<string, FakeOrder>(),
  requests: [] as Array<{ method: string; path: string }>,
  comments: [] as Array<{ id: string; comment: string }>,
  failDeleteOf: new Set<number>(),
  deleteKeepsLine: new Set<number>(),
  itemsReadFailsAfterDeletes: null as number | null,
  deletes: 0,
  /** After the Nth delete, the quantity of this line changes behind IMS's back. */
  tamperAfterDelete: null as { afterDeletes: number; itemId: number; quantity: number } | null,
  /** The order detail read answers a server error. */
  detailFails: false,
  /** After the Nth read of the survivor's lines, another order's line appears on it. */
  addLineAfterItemRead: null as number | null,
  itemReads: 0,
  /** The create lands, and a merge (or an extra unflagged line) happens before the read-back. */
  putMerges: false,
  putExtraLine: false,
  /** Flagged merged but the lines still match what was sent. */
  putFlagOnly: false,
}
function resetFake() {
  fake.orders = new Map()
  fake.requests = []
  fake.comments = []
  fake.failDeleteOf = new Set()
  fake.deleteKeepsLine = new Set()
  fake.itemsReadFailsAfterDeletes = null
  fake.deletes = 0
  fake.tamperAfterDelete = null
  fake.detailFails = false
  fake.addLineAfterItemRead = null
  fake.itemReads = 0
  fake.putMerges = false
  fake.putExtraLine = false
  fake.putFlagOnly = false
}
const D_LINES: FakeLine[] = [{ ID: 3603106, SKU: '243632999', Quantity: 2 }, { ID: 3603107, SKU: '923663020', Quantity: 1 }]
const E_LINES: FakeLine[] = [{ ID: 3603108, SKU: '243632999', Quantity: 1 }, { ID: 3603109, SKU: '849293203', Quantity: 1 }]
function seedMerged(status = 9, lines: FakeLine[] = [...E_LINES, ...D_LINES]) {
  resetFake()
  fake.orders.set(SURVIVOR, { status, number: 'IMSTEST-E+IMSTEST-D', items: lines.map((l) => ({ ...l })), merged: true })
}
const storedD: WmsOrderItemRef[] = D_LINES.map((l) => ({ externalItemId: String(l.ID), sku: l.SKU, quantity: l.Quantity }))
const survivorItems = () => fake.orders.get(SURVIVOR)!.items.map((l) => ({ ...l }))
const writeRequests = () => fake.requests.filter((r) => r.method !== 'GET')

mock.module('@/lib/connectors/mintsoft/settings/schema', {
  namedExports: {
    getMintsoftSettings: async () => ({
      mintsoft_client_id: String(CLIENT),
      mintsoft_courier_service_map: '',
      mintsoft_default_courier_service_id: '',
      mintsoft_admin_order_url_template: 'https://wms.example/Order/{id}',
    }),
    MINTSOFT_DEFAULT_ADMIN_ORDER_URL_TEMPLATE: 'https://wms.example/Order/{id}',
    parseMintsoftPositiveId: (value: string | null | undefined): number | null => {
      const trimmed = (value ?? '').trim()
      return /^\d+$/.test(trimmed) && Number.parseInt(trimmed, 10) > 0 ? Number.parseInt(trimmed, 10) : null
    },
  },
})

mock.module('@/lib/connectors/mintsoft/api/client', {
  namedExports: {
    mintsoftRequest: async (path: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET'
      const pathname = path.split('?')[0]
      fake.requests.push({ method, path: pathname })
      if (pathname === '/api/Order/Search') {
        const wanted = decodeURIComponent((path.split('OrderNumber=')[1] ?? '').split('&')[0])
        const rows = [...fake.orders.entries()]
          .filter(([, o]) => o.number.split('+').includes(wanted))
          .map(([id, o]) => ({ ID: Number(id), ClientId: CLIENT, OrderNumber: o.number, OrderNameValues: o.merged ? [{ Name: 'MergedOrder', Value: 'True' }] : [] }))
        return { data: rows, status: 200 }
      }
      const itemMatch = pathname.match(/^\/api\/Order\/([^/]+)\/Items(?:\/([^/]+))?$/)
      if (itemMatch) {
        const order = fake.orders.get(itemMatch[1])
        if (!order) return { data: null, error: 'Mintsoft request failed with status 404', status: 404 }
        if (method === 'DELETE') {
          const itemId = Number(itemMatch[2])
          if (fake.failDeleteOf.has(itemId)) return { data: { ID: 0, Success: false, Message: 'OrderItem could not be removed' }, status: 200 }
          const line = order.items.find((l) => l.ID === itemId)
          if (!line) return { data: { ID: 0, Success: false, Message: 'OrderItem not found' }, status: 200 }
          if (!fake.deleteKeepsLine.has(itemId)) order.items = order.items.filter((l) => l.ID !== itemId)
          fake.deletes += 1
          if (fake.tamperAfterDelete && fake.deletes === fake.tamperAfterDelete.afterDeletes) {
            const victim = order.items.find((l) => l.ID === fake.tamperAfterDelete!.itemId)
            if (victim) victim.Quantity = fake.tamperAfterDelete.quantity
          }
          return { data: { ID: 0, Success: true, Message: `OrderItem: ${line.SKU} removed from Order` }, status: 200 }
        }
        if (fake.itemsReadFailsAfterDeletes !== null && fake.deletes >= fake.itemsReadFailsAfterDeletes) return { data: null, error: 'Mintsoft request failed with status 500', status: 500 }
        const snapshot = order.items.map((l) => ({ ...l }))
        fake.itemReads += 1
        if (fake.addLineAfterItemRead === fake.itemReads) order.items.push({ ID: 9999, SKU: 'LATE', Quantity: 1 })
        return { data: snapshot, status: 200 }
      }
      const cancelMatch = pathname.match(/^\/api\/Order\/([^/]+)\/Cancel$/)
      if (cancelMatch) {
        const order = fake.orders.get(cancelMatch[1])
        if (!order) return { data: null, error: 'Mintsoft request failed with status 404', status: 404 }
        order.status = 3
        return { data: { ID: 0, Success: true, Message: 'Order was successfully cancelled' }, status: 200 }
      }
      const commentMatch = pathname.match(/^\/api\/Order\/([^/]+)\/Comments$/)
      if (commentMatch && method === 'POST') {
        fake.comments.push({ id: commentMatch[1], comment: String(JSON.parse(init?.body ?? '{}').Comment) })
        return { data: { Success: true }, status: 200 }
      }
      const detailMatch = pathname.match(/^\/api\/Order\/([^/]+)$/)
      if (detailMatch && method === 'GET') {
        if (fake.detailFails) return { data: null, error: 'Mintsoft request failed with status 500', status: 500 }
        const order = fake.orders.get(detailMatch[1])
        if (!order) return { data: null, error: 'Mintsoft request failed with status 404', status: 404 }
        return { data: { ID: Number(detailMatch[1]), ClientId: CLIENT, OrderNumber: order.number, OrderStatusId: order.status, OrderNameValues: order.merged ? [{ Name: 'MergedOrder', Value: 'True' }] : [] }, status: 200 }
      }
      if (pathname === '/api/Order' && method === 'PUT') {
        const id = '999001'
        const lines = [{ ID: 7001, SKU: 'SKU-1', Quantity: 1 }, { ID: 7002, SKU: 'SKU-1', Quantity: 3 }]
        if (fake.putMerges) lines.push({ ID: 7101, SKU: 'OTHER-ORDER', Quantity: 2 })
        if (fake.putExtraLine) lines.push({ ID: 7102, SKU: 'EXTRA', Quantity: 1 })
        fake.orders.set(id, { status: 9, number: fake.putMerges ? 'WC-1001+WC-2002' : 'WC-1001', items: lines, merged: fake.putMerges || fake.putFlagOnly })
        return { data: [{ Success: true, OrderId: Number(id), OrderNumber: 'WC-1001' }], status: 200 }
      }
      throw new Error(`Unexpected Mintsoft request: ${method} ${path}`)
    },
  },
})

// ---- the shadow store (the producer seam asks the database) ---------------------------------------------------------------------------
const shadows: Array<{ operation: string; subjectId: string; reason: string }> = []
mock.module('@/lib/db', {
  namedExports: {
    db: {
      $queryRaw: async (query: { strings?: readonly string[]; values?: readonly unknown[] }) => {
        const text = (query.strings ?? []).join('?')
        if (!text.includes('outbound_shadow_writes')) return []
        const values = query.values ?? []
        shadows.push({ operation: String(values[1]), subjectId: String(values[3]), reason: String(values[6]) })
        return [{ id: `shadow-${shadows.length}`, inserted: true, occurrences: 1, accounting_sync_log_id: null, sync_row_exists: false }]
      },
      $executeRaw: async () => 1,
    },
  },
})

const ENV_KEYS = [PRODUCER_HOLD_ENFORCED_ENV, OUTBOUND_GRANT_ENV.mintsoft, PRODUCER_CUTOFF_ENV.mintsoft]
function withEnv<T>(values: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const)
  for (const key of ENV_KEYS) delete process.env[key]
  for (const [key, value] of Object.entries(values)) process.env[key] = value
  shadows.length = 0
  return fn().finally(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}
const OFF = {}
const HELD = { [PRODUCER_HOLD_ENFORCED_ENV]: 'mintsoft' }

// ---- the sweep's port and connector ---------------------------------------------------------------------------------------------------
type LinkWriteLog = { id: string; data: Record<string, unknown> }
function makePort(options: { cancellable: WmsPushLinkRef[]; items: WmsOrderItemRef[] | null }) {
  const writes: LinkWriteLog[] = []
  const dropped: string[][] = []
  const recordedItems: Array<{ orderId: string; externalOrderId: string; items: WmsOrderItemRef[] }> = []
  const events: Array<{ action: string; outcome: string; summary: string }> = []
  const link = { state: options.cancellable[0]?.state ?? 'SYNCED', externalOrderId: options.cancellable[0]?.externalOrderId ?? '' }
  const port: WmsOrderPushPort = {
    activeBindings: async () => BINDINGS,
    releasableHeldOrders: async () => [],
    createCandidates: async () => [],
    revalidatableLinks: async () => ({ links: [], total: 0 }),
    ambiguousCreateLinks: async () => ({ links: [], total: 0 }),
    recordValidationFailure: async () => true,
    claimForCreate: async () => 'CLAIMED',
    verifiableLinks: async () => [],
    updatableLinks: async () => [],
    holdableLinks: async () => [],
    cancellableLinks: async () => options.cancellable,
    upsertByOrder: async () => {},
    updateLink: async (id, data) => { writes.push({ id, data }); if (typeof data.state === 'string') link.state = data.state as never; if (typeof data.externalOrderId === 'string') link.externalOrderId = data.externalOrderId },
    updateLinkIfState: async () => true,
    clearStaleNotices: async () => 0,
    noticesAwaitingComment: async () => [],
    updateLinkIfLinked: async (id, expect, data) => {
      if (link.state !== expect.state || link.externalOrderId !== expect.externalOrderId) return false
      writes.push({ id, data })
      if (typeof data.state === 'string') link.state = data.state as never
      if (typeof data.externalOrderId === 'string') link.externalOrderId = data.externalOrderId
      return true
    },
    readOrderItems: async () => options.items ?? [],
    replaceOrderItems: async (orderId, externalOrderId, items) => { recordedItems.push({ orderId, externalOrderId, items }) },
    dropOrderItems: async (_linkId, ids) => { dropped.push(ids) },
    recordEvent: async (event) => { events.push({ action: String(event.action), outcome: String(event.outcome), summary: String(event.summary) }) },
  }
  return { port, writes, dropped, recordedItems, events, link }
}

async function sweep(port: WmsOrderPushPort, overrides: Record<string, unknown> = {}) {
  const { runWmsOrderPushSweepCore } = await import('../lib/domain/wms/order-push-sweep.ts')
  const orderPush = await import('../lib/connectors/mintsoft/api/order-push.ts')
  const connector = {
    pushOrder: async () => { throw new Error('not used') },
    updateOrder: async () => ({ updated: true, status: 'NEW' }),
    cancelOrder: async (id: string) => orderPush.cancelMintsoftOrder(id),
    cancelMergedOrder: async (id: string, items: WmsOrderItemRef[]) => orderPush.cancelMintsoftOrder(id, { onlyLines: items }),
    addOrderComment: async (id: string, comment: string) => orderPush.addMintsoftOrderComment(id, comment),
    removeOrderItems: async (id: string, items: WmsOrderItemRef[]) => orderPush.removeMintsoftOrderItems(id, items),
    findMergedSurvivor: async (number: string) => orderPush.findMintsoftMergedSurvivor(number),
    verifyPushedOrder: async () => 'ours' as const,
    probeOrderPresence: async () => 'FOUND' as const,
    ...overrides,
  }
  const quiet = { warn: console.warn, error: console.error }
  console.warn = () => {}
  console.error = () => {}
  try { return await runWmsOrderPushSweepCore(connector as never, 'mintsoft', port, { now: NOW }) } finally { console.warn = quiet.warn; console.error = quiet.error }
}

/** D's link as the dispatch sweep leaves it once it has seen the merge: re-pointed at the survivor and MERGED. */
const mergedLinkRef = (): WmsPushLinkRef => ({ id: 'link-d', orderId: 'so-d', orderNumber: 'IMSTEST-D', externalOrderId: SURVIVOR, externalOrderNumber: 'IMSTEST-E+IMSTEST-D', state: 'MERGED' })
/** D's link while it still names the absorbed order (404s): the cancel pass finds the merge itself. */
const absorbedLinkRef = (): WmsPushLinkRef => ({ id: 'link-d', orderId: 'so-d', orderNumber: 'IMSTEST-D', externalOrderId: ABSORBED, externalOrderNumber: 'IMSTEST-D', state: 'SYNCED' })

/** E's link (the ABSORBING order, which keeps the survivor's id): the dispatch sweep has not yet re-pointed it, so it still reads as a plain SYNCED order. */
const absorbingLinkRef = (): WmsPushLinkRef => ({ id: 'link-e', orderId: 'so-e', orderNumber: 'IMSTEST-E', externalOrderId: SURVIVOR, externalOrderNumber: 'IMSTEST-E', state: 'SYNCED' })
const storedE: WmsOrderItemRef[] = E_LINES.map((l) => ({ externalItemId: String(l.ID), sku: l.SKU, quantity: l.Quantity }))

const deletedIds = () => fake.requests.filter((r) => r.method === 'DELETE').map((r) => r.path.split('/').pop())

// ---------------------------------------------------------------- 1. the happy path ----------------------------------------------

test('HAPPY PATH (shared SKU on two separate lines): the absorbed order is cancelled, exactly its two line ids are deleted, the survivor is NOT cancelled, the other order\'s lines are untouched, one note, link CANCELLED', async () => {
  await withEnv(OFF, async () => {
    seedMerged()
    const h = makePort({ cancellable: [absorbedLinkRef()], items: storedD })
    const result = await sweep(h.port)
    assert.deepEqual(deletedIds(), ['3603106', '3603107'], 'exactly the stored line ids, in stored order; the shared-SKU line of E (3603108) is NOT deleted')
    assert.deepEqual(survivorItems(), E_LINES, 'the survivor holds exactly the other order\'s lines, each under its own id, SKU and quantity')
    assert.equal(fake.orders.get(SURVIVOR)!.status, 9, 'the survivor itself was NOT cancelled')
    assert.ok(!fake.requests.some((r) => r.path.endsWith('/Cancel') && r.path.includes(SURVIVOR)), 'no /Cancel was sent for the survivor')
    assert.equal(fake.comments.length, 1, 'exactly one warehouse note')
    assert.equal(fake.comments[0].id, SURVIVOR)
    assert.match(fake.comments[0].comment, /IMSTEST-D/)
    assert.match(fake.comments[0].comment, /2 x 243632999 \(line 3603106\), 1 x 923663020 \(line 3603107\)/)
    const settled = h.writes.find((w) => w.data.state === 'CANCELLED')
    assert.ok(settled, 'the IMS link is marked CANCELLED')
    assert.equal(result.cancelled, 1)
    assert.equal(result.operatorNotices, undefined, 'no operator notice')
    assert.ok(h.writes.some((w) => w.data.state === 'MERGED' && w.data.externalOrderId === SURVIVOR), 'the link was first re-pointed at the survivor')
    assert.ok(h.events.some((e) => e.action === 'order_cancel' && e.outcome === 'SUCCEEDED' && /lines removed/.test(e.summary)))
  })
})

test('HAPPY PATH from a link the dispatch sweep already re-pointed (MERGED): the same removal, no search needed', async () => {
  await withEnv(OFF, async () => {
    seedMerged()
    const h = makePort({ cancellable: [mergedLinkRef()], items: storedD })
    const result = await sweep(h.port)
    assert.deepEqual(deletedIds(), ['3603106', '3603107'])
    assert.deepEqual(survivorItems(), E_LINES)
    assert.equal(fake.requests.some((r) => r.path === '/api/Order/Search'), false)
    assert.equal(result.cancelled, 1)
  })
})

test('RE-READ: every delete is followed by a read of the survivor\'s lines, and the final state is the other order\'s lines exactly (nothing else changed)', async () => {
  await withEnv(OFF, async () => {
    seedMerged()
    const h = makePort({ cancellable: [mergedLinkRef()], items: storedD })
    await sweep(h.port)
    const calls = fake.requests.filter((r) => r.path.includes('/Items'))
    // read (pre-check), DELETE, read, DELETE, read
    assert.deepEqual(calls.map((r) => r.method), ['GET', 'DELETE', 'GET', 'DELETE', 'GET'])
    assert.deepEqual(survivorItems(), E_LINES)
  })
})

test('RE-READ: a line of the OTHER order that changes behind IMS\'s back after a delete stops the removal and is reported (the unchanged-lines proof)', async () => {
  await withEnv(OFF, async () => {
    seedMerged()
    fake.tamperAfterDelete = { afterDeletes: 1, itemId: 3603108, quantity: 5 }
    const h = makePort({ cancellable: [mergedLinkRef()], items: storedD })
    const result = await sweep(h.port)
    assert.deepEqual(deletedIds(), ['3603106'], 'the second delete was NOT sent after the proof failed')
    assert.equal(result.operatorNotices, 1)
    assert.equal(h.writes.some((w) => w.data.state === 'CANCELLED'), false)
    const notice = String(h.writes.find((w) => typeof w.data.lastError === 'string')!.data.lastError)
    assert.match(notice, /another line of the merged order is not what it was/)
    assert.match(notice, /REMOVED so far: 2 x 243632999 \(line 3603106\)/)
    assert.match(notice, /STILL ON THE MERGED ORDER[^]*1 x 923663020 \(line 3603107\)/)
  })
})

// ---------------------------------------------------------------- 2. fall-backs to the operator notice ----------------------------

test('PAST THE EDITABLE STATUS (picking, 4): nothing is deleted, the survivor is not cancelled, a notice names the exact SKUs, quantities and line ids', async () => {
  await withEnv(OFF, async () => {
    seedMerged(4)
    const h = makePort({ cancellable: [mergedLinkRef()], items: storedD })
    const result = await sweep(h.port)
    assert.equal(writeRequests().filter((r) => r.method === 'DELETE' || r.path.endsWith('/Cancel')).length, 0)
    assert.equal(result.operatorNotices, 1)
    assert.equal(result.cancelled, 0)
    const notice = h.writes.find((w) => typeof w.data.cancelNoticeAt !== 'undefined')!
    const text = String(notice.data.lastError)
    assert.match(text, /MERGED order that also holds other orders' goods/)
    assert.match(text, /past the point where its lines can be changed \(status 4\)/)
    assert.match(text, /2 x 243632999 \(line 3603106\), 1 x 923663020 \(line 3603107\)/)
    assert.match(text, /Nothing was removed/)
    assert.equal(h.writes.some((w) => w.data.state === 'CANCELLED'), false, 'the link stays live')
    assert.deepEqual(survivorItems().length, 4)
  })
})

test('ON BACKORDER (9) and NEW (1) are both editable', async () => {
  for (const status of [1, 9]) {
    await withEnv(OFF, async () => {
      seedMerged(status)
      const h = makePort({ cancellable: [mergedLinkRef()], items: storedD })
      await sweep(h.port)
      assert.deepEqual(survivorItems(), E_LINES, `status ${status}`)
    })
  }
})

test('MISSING STORED LINE IDS (a legacy push): no write at all, a notice says the ids are not recorded', async () => {
  await withEnv(OFF, async () => {
    seedMerged()
    const h = makePort({ cancellable: [mergedLinkRef()], items: null })
    const result = await sweep(h.port)
    assert.equal(writeRequests().filter((r) => r.method === 'DELETE' || r.path.endsWith('/Cancel')).length, 0)
    assert.equal(result.operatorNotices, 1)
    assert.match(String(h.writes.find((w) => typeof w.data.lastError === 'string')!.data.lastError), /no record of the WMS line ids/)
    assert.equal(h.writes.some((w) => w.data.state === 'CANCELLED'), false)
  })
})

test('SKU MISMATCH: a stored line whose SKU on the survivor differs is not deleted, and NOTHING is deleted (the check is before the first write)', async () => {
  await withEnv(OFF, async () => {
    seedMerged(9, [{ ID: 3603106, SKU: 'SOMETHING-ELSE', Quantity: 2 }, D_LINES[1], ...E_LINES])
    const h = makePort({ cancellable: [mergedLinkRef()], items: storedD })
    const result = await sweep(h.port)
    assert.deepEqual(deletedIds(), [], 'not even the matching line 3603107 was deleted')
    assert.equal(result.operatorNotices, 1)
    assert.match(String(h.writes.find((w) => typeof w.data.lastError === 'string')!.data.lastError), /line 3603106 is now 2 x SOMETHING-ELSE, IMS pushed 2 x 243632999/)
  })
})

test('QUANTITY MISMATCH: a stored line whose quantity differs is not deleted, and nothing is deleted', async () => {
  await withEnv(OFF, async () => {
    seedMerged(9, [{ ID: 3603106, SKU: '243632999', Quantity: 7 }, D_LINES[1], ...E_LINES])
    const h = makePort({ cancellable: [mergedLinkRef()], items: storedD })
    await sweep(h.port)
    assert.deepEqual(deletedIds(), [])
    assert.match(String(h.writes.find((w) => typeof w.data.lastError === 'string')!.data.lastError), /line 3603106 is now 7 x 243632999, IMS pushed 2 x 243632999/)
  })
})

test('A STORED LINE NOT ON THE SURVIVOR (an operator already took it out): a notice, nothing deleted', async () => {
  await withEnv(OFF, async () => {
    seedMerged(9, [D_LINES[1], ...E_LINES])
    const h = makePort({ cancellable: [mergedLinkRef()], items: storedD })
    await sweep(h.port)
    assert.deepEqual(deletedIds(), [])
    assert.match(String(h.writes.find((w) => typeof w.data.lastError === 'string')!.data.lastError), /line 3603106 \(2 x 243632999\) is not on the merged order/)
  })
})

test('PARTIAL FAILURE: the first delete lands, the second fails; the notice says exactly what was removed and what remains, the removed line is forgotten, the link stays live', async () => {
  await withEnv(OFF, async () => {
    seedMerged()
    fake.failDeleteOf.add(3603107)
    const h = makePort({ cancellable: [mergedLinkRef()], items: storedD })
    const result = await sweep(h.port)
    assert.deepEqual(deletedIds(), ['3603106', '3603107'])
    assert.equal(survivorItems().some((l) => l.ID === 3603106), false, 'the first line really went')
    assert.equal(survivorItems().some((l) => l.ID === 3603107), true)
    assert.equal(result.operatorNotices, 1)
    const text = String(h.writes.find((w) => typeof w.data.lastError === 'string')!.data.lastError)
    assert.match(text, /REMOVED so far: 2 x 243632999 \(line 3603106\)\./)
    assert.match(text, /STILL ON THE MERGED ORDER \(take them out in the WMS before it ships\): 1 x 923663020 \(line 3603107\)\./)
    assert.deepEqual(h.dropped, [['3603106']], 'the recorded ids no longer include the line that is gone')
    assert.equal(h.writes.some((w) => w.data.state === 'CANCELLED'), false)
    assert.equal(result.cancelled, 0)
  })
})

test('PARTIAL FAILURE: a delete answered Success but the re-read cannot be made: the line is listed as still there until a person checks', async () => {
  await withEnv(OFF, async () => {
    seedMerged()
    fake.itemsReadFailsAfterDeletes = 2
    const h = makePort({ cancellable: [mergedLinkRef()], items: storedD })
    await sweep(h.port)
    assert.deepEqual(deletedIds(), ['3603106', '3603107'])
    const text = String(h.writes.find((w) => typeof w.data.lastError === 'string')!.data.lastError)
    assert.match(text, /re-read to prove it failed/)
    assert.match(text, /REMOVED so far: 2 x 243632999 \(line 3603106\)/)
    assert.match(text, /1 x 923663020 \(line 3603107\)/)
    assert.equal(h.writes.some((w) => w.data.state === 'CANCELLED'), false)
  })
})

test('A DELETE THE WAREHOUSE ANSWERS Success BUT DID NOT DO: the re-read catches it and stops', async () => {
  await withEnv(OFF, async () => {
    seedMerged()
    fake.deleteKeepsLine.add(3603106)
    const h = makePort({ cancellable: [mergedLinkRef()], items: storedD })
    const result = await sweep(h.port)
    assert.deepEqual(deletedIds(), ['3603106'])
    assert.equal(result.operatorNotices, 1)
    assert.match(String(h.writes.find((w) => typeof w.data.lastError === 'string')!.data.lastError), /still on the merged order/)
    assert.equal(h.writes.some((w) => w.data.state === 'CANCELLED'), false)
  })
})

// ---------------------------------------------------------------- 3. the last lines ----------------------------------------------

test('LAST LINES: the survivor holds only this order\'s lines, so it is cancelled normally (and no line is deleted)', async () => {
  await withEnv(OFF, async () => {
    seedMerged(9, D_LINES)
    const h = makePort({ cancellable: [mergedLinkRef()], items: storedD })
    const result = await sweep(h.port)
    assert.deepEqual(deletedIds(), [], 'no line deletion: the order is cancelled whole')
    assert.equal(fake.orders.get(SURVIVOR)!.status, 3, 'the survivor was cancelled')
    assert.ok(fake.requests.some((r) => r.path === `/api/Order/${SURVIVOR}/Cancel`))
    assert.ok(h.writes.some((w) => w.data.state === 'CANCELLED'))
    assert.equal(result.cancelled, 1)
    assert.equal(result.operatorNotices, undefined)
  })
})

test('NEVER CANCELS THE SURVIVOR WHILE IT HOLDS ANOTHER ORDER\'S LINES: not on the happy path, not on any refusal', async () => {
  for (const arrange of [() => seedMerged(), () => seedMerged(4), () => { seedMerged(); fake.failDeleteOf.add(3603107) }]) {
    await withEnv(OFF, async () => {
      arrange()
      await sweep(makePort({ cancellable: [mergedLinkRef()], items: storedD }).port)
      assert.notEqual(fake.orders.get(SURVIVOR)!.status, 3)
      assert.equal(fake.requests.some((r) => r.path.endsWith('/Cancel')), false)
    })
  }
})

// ---------------------------------------------------------------- 4. the grant and the shadow ----------------------------------------

test('WRITE GRANT OFF (the producer-side hold enforced, no grant): nothing is sent, not even a read of the survivor; the link and the stored ids are untouched; one shadow is recorded', async () => {
  await withEnv(HELD, async () => {
    seedMerged()
    const h = makePort({ cancellable: [mergedLinkRef()], items: storedD })
    const result = await sweep(h.port)
    assert.deepEqual(fake.requests, [], 'no request of any kind reached the warehouse')
    assert.deepEqual(h.writes, [], 'no link write, no notice')
    assert.deepEqual(h.dropped, [])
    assert.equal(result.shadowed, 1)
    assert.equal(result.cancelled, 0)
    assert.deepEqual(shadows.map((s) => [s.operation, s.subjectId, s.reason]), [['order.cancel', 'so-d', 'no_grant']])
    assert.equal(survivorItems().length, 4)
  })
})

test('CONTROL: the same scene with the hold off removes the lines (so the grant arm above is red for the right reason)', async () => {
  await withEnv(OFF, async () => {
    seedMerged()
    const h = makePort({ cancellable: [mergedLinkRef()], items: storedD })
    await sweep(h.port)
    assert.equal(survivorItems().length, 2)
  })
})

// ---------------------------------------------------------------- 5. what is never changed ----------------------------------------

test('A HOLD of a merged order still only raises the notice: IMS deletes lines for a cancel / full refund and for nothing else', async () => {
  await withEnv(OFF, async () => {
    seedMerged()
    const h = makePort({ cancellable: [], items: storedD })
    h.port.holdableLinks = async () => [mergedLinkRef()]
    h.link.state = 'MERGED'
    h.link.externalOrderId = SURVIVOR
    const result = await sweep(h.port)
    assert.deepEqual(deletedIds(), [])
    assert.equal(result.operatorNotices, 1)
    assert.equal(survivorItems().length, 4)
  })
})

test('A port with no line-id support (an older double) keeps the operator notice exactly as before', async () => {
  await withEnv(OFF, async () => {
    seedMerged()
    const h = makePort({ cancellable: [mergedLinkRef()], items: storedD })
    delete h.port.readOrderItems
    const result = await sweep(h.port)
    assert.deepEqual(deletedIds(), [])
    assert.equal(result.operatorNotices, 1)
    assert.match(String(h.writes.find((w) => typeof w.data.lastError === 'string')!.data.lastError), /Take this order's items out of it in the WMS before it ships/)
  })
})

// ---------------------------------------------------------------- 6. recording the ids at push time ------------------------------

const INPUT: WmsOrderPushInput = {
  orderNumber: 'WC-1001', externalReference: 'REF-1001', externalWarehouseId: '3', currency: 'GBP', email: 'a@example.com', phone: null,
  vatNumber: null, comments: null, courierService: 'DPD', totalVat: 0, shippingExVat: 0, shippingVat: 0, discountExVat: 0, discountVat: 0,
  lines: [{ sku: 'SKU-1', quantity: 1, unitPriceExVat: 10, unitPriceVat: 2, description: 'W' }, { sku: 'SKU-1', quantity: 3, unitPriceExVat: 9, unitPriceVat: 2, description: 'W' }],
  shippingAddress: { firstName: 'A', lastName: 'B', company: '', address1: '1 St', address2: '', town: 'T', county: '', postCode: 'PC1', country: 'GB' },
}

test('PUSH: the create is followed by a read-back and the result carries each line under the warehouse\'s own id (a shared SKU stays two lines)', async () => {
  await withEnv(OFF, async () => {
    resetFake()
    const { pushMintsoftOrder } = await import('../lib/connectors/mintsoft/api/order-push.ts')
    const pushed = await pushMintsoftOrder(INPUT)
    assert.deepEqual(pushed.items, [
      { externalItemId: '7001', sku: 'SKU-1', quantity: 1 },
      { externalItemId: '7002', sku: 'SKU-1', quantity: 3 },
    ])
    assert.equal(pushed.externalOrderId, '999001')
    assert.equal(fake.requests.filter((r) => r.method === 'PUT').length, 1, 'still ONE create')
  })
})

test('PUSH: a read-back that fails never fails the push (the order exists; a retry would duplicate it) and the result simply carries no ids', async () => {
  await withEnv(OFF, async () => {
    resetFake()
    fake.itemsReadFailsAfterDeletes = 0
    const { pushMintsoftOrder } = await import('../lib/connectors/mintsoft/api/order-push.ts')
    const quiet = console.warn
    console.warn = () => {}
    const pushed = await pushMintsoftOrder(INPUT).finally(() => { console.warn = quiet })
    assert.equal(pushed.externalOrderId, '999001')
    assert.equal(pushed.items, undefined)
  })
})

test('SWEEP: the ids the connector read back are recorded against the order after the create is linked; a failure to record never fails the create', async () => {
  const { runWmsOrderPushSweepCore } = await import('../lib/domain/wms/order-push-sweep.ts')
  for (const failRecord of [false, true]) {
    await withEnv(OFF, async () => {
      const h = makePort({ cancellable: [], items: null })
      h.port.createCandidates = async () => [{
        id: 'so-1', orderNumber: 'SO-1', externalOrderNumber: null, currency: 'GBP', customerName: 'Jane Doe', customerEmail: 'j@example.com',
        customerVatNumber: null, shippingAddress: { line1: '1 St', city: 'Leeds', postcode: 'LS1', country: 'GB' }, shippingService: 'Royal Mail',
        subtotalForeign: 10, shippingForeign: 0, taxForeign: 0, taxRatePercent: null, pricesIncludeVat: false, discountAmount: 0, totalForeign: 10,
        shipFromWarehouseId: 'wh-1', pushAttempts: 0, lines: [{ sku: 'A', qty: 1, taxForeign: 0, totalForeign: 10, description: 'Widget' }],
      } as never]
      if (failRecord) h.port.replaceOrderItems = async () => { throw new Error('database unavailable') }
      const items = [{ externalItemId: '55', sku: 'A', quantity: 1 }]
      const connector = {
        pushOrder: async () => ({ externalOrderId: 'wms-1', externalOrderNumber: 'WN-1', status: 'NEW', items }),
        verifyPushedOrder: async () => 'ours' as const,
        probeOrderPresence: async () => 'FOUND' as const,
      }
      const quiet = console.error
      console.error = () => {}
      const result = await runWmsOrderPushSweepCore(connector as never, 'mintsoft', h.port, { now: NOW }).finally(() => { console.error = quiet })
      assert.equal(result.created, 1, 'the create still counted')
      assert.equal(result.failed, 0)
      if (!failRecord) assert.deepEqual(h.recordedItems, [{ orderId: 'so-1', externalOrderId: 'wms-1', items }])
    })
  }
})

// ---------------------------------------------------------------- 7. the ABSORBING order, link still plain SYNCED ---------------

test('ABSORBING ORDER cancelled while its link is still SYNCED and the survivor holds both orders\' lines: the link is re-pointed MERGED, ONLY this order\'s lines are removed, the survivor is NOT cancelled', async () => {
  await withEnv(OFF, async () => {
    seedMerged()
    const h = makePort({ cancellable: [absorbingLinkRef()], items: storedE })
    const result = await sweep(h.port)
    assert.deepEqual(deletedIds(), ['3603108', '3603109'])
    assert.deepEqual(survivorItems(), D_LINES, 'the other order\'s lines are untouched')
    assert.equal(fake.orders.get(SURVIVOR)!.status, 9)
    assert.equal(fake.requests.some((r) => r.path.endsWith('/Cancel')), false, 'no /Cancel of the survivor')
    assert.ok(h.writes.some((w) => w.data.state === 'MERGED'), 'the link was marked MERGED first')
    assert.ok(h.writes.some((w) => w.data.state === 'CANCELLED'))
    assert.equal(result.cancelled, 1)
    assert.equal(fake.comments.length, 1)
  })
})

test('ABSORBING ORDER, only its own lines remain on the survivor: the survivor is cancelled normally', async () => {
  await withEnv(OFF, async () => {
    seedMerged(9, E_LINES)
    const h = makePort({ cancellable: [absorbingLinkRef()], items: storedE })
    const result = await sweep(h.port)
    assert.deepEqual(deletedIds(), [])
    assert.equal(fake.orders.get(SURVIVOR)!.status, 3)
    assert.ok(h.writes.some((w) => w.data.state === 'CANCELLED'))
    assert.equal(result.cancelled, 1)
  })
})

test('ABSORBING ORDER, stored ids missing: nothing cancelled, nothing deleted, a notice', async () => {
  await withEnv(OFF, async () => {
    seedMerged()
    const h = makePort({ cancellable: [absorbingLinkRef()], items: null })
    const result = await sweep(h.port)
    assert.equal(fake.requests.some((r) => r.method === 'DELETE' || r.path.endsWith('/Cancel')), false)
    assert.equal(result.operatorNotices, 1)
  })
})

test('ABSORBING ORDER, the order read fails: nothing is sent, the link stays SYNCED and retryable (no notice stamped)', async () => {
  await withEnv(OFF, async () => {
    seedMerged()
    fake.detailFails = true
    const h = makePort({ cancellable: [absorbingLinkRef()], items: storedE })
    const result = await sweep(h.port)
    assert.equal(writeRequests().length, 0)
    assert.equal(result.failed, 1)
    assert.equal(h.link.state, 'SYNCED')
    assert.equal(h.writes.some((w) => w.data.state !== undefined || w.data.cancelNoticeAt !== undefined), false)
    assert.ok(h.writes.some((w) => typeof w.data.lastError === 'string'), 'the error is recorded; the next sweep tries again')
  })
})

test('ABSORBING ORDER held in IMS: the survivor is not cancelled either; the link is marked MERGED and a notice is raised', async () => {
  await withEnv(OFF, async () => {
    seedMerged()
    const h = makePort({ cancellable: [], items: storedE })
    h.port.holdableLinks = async () => [absorbingLinkRef()]
    h.link.state = 'SYNCED'
    h.link.externalOrderId = SURVIVOR
    const result = await sweep(h.port)
    assert.equal(fake.requests.some((r) => r.method === 'DELETE' || r.path.endsWith('/Cancel')), false)
    assert.equal(fake.orders.get(SURVIVOR)!.status, 9)
    assert.equal(result.operatorNotices, 1)
    assert.ok(h.writes.some((w) => w.data.state === 'MERGED'))
  })
})

// ---------------------------------------------------------------- 8. review round 1 -----------------------------------------------

test('SNAPSHOT: a merge between the create and the read-back stores NO line ids, and a later cancel raises the notice', async () => {
  await withEnv(OFF, async () => {
    resetFake()
    fake.putMerges = true
    const { pushMintsoftOrder } = await import('../lib/connectors/mintsoft/api/order-push.ts')
    const quiet = console.warn
    console.warn = () => {}
    const pushed = await pushMintsoftOrder(INPUT).finally(() => { console.warn = quiet })
    assert.equal(pushed.items, undefined, 'both orders\' lines are on the order: nothing is attributed to this one')
    const h = makePort({ cancellable: [{ ...absorbingLinkRef(), externalOrderId: pushed.externalOrderId }], items: pushed.items ?? null })
    const result = await sweep(h.port)
    assert.equal(fake.requests.some((r) => r.method === 'DELETE' || r.path.endsWith('/Cancel')), false)
    assert.equal(result.operatorNotices, 1)
  })
})

test('SNAPSHOT: an order flagged as merged records nothing even when its lines happen to match what IMS sent', async () => {
  await withEnv(OFF, async () => {
    resetFake()
    fake.putFlagOnly = true
    const { pushMintsoftOrder } = await import('../lib/connectors/mintsoft/api/order-push.ts')
    const quiet = console.warn
    console.warn = () => {}
    const pushed = await pushMintsoftOrder(INPUT).finally(() => { console.warn = quiet })
    assert.equal(pushed.items, undefined)
  })
})

test('SNAPSHOT: lines that are not exactly what IMS sent (an extra line, though unflagged) are not recorded', async () => {
  await withEnv(OFF, async () => {
    resetFake()
    fake.putExtraLine = true
    const { pushMintsoftOrder } = await import('../lib/connectors/mintsoft/api/order-push.ts')
    const quiet = console.warn
    console.warn = () => {}
    const pushed = await pushMintsoftOrder(INPUT).finally(() => { console.warn = quiet })
    assert.equal(pushed.items, undefined)
  })
})

test('LINE ADDED between the only-lines check and the cancel: nothing is cancelled and a notice is raised', async () => {
  await withEnv(OFF, async () => {
    seedMerged(9, D_LINES)
    fake.addLineAfterItemRead = 1
    const h = makePort({ cancellable: [mergedLinkRef()], items: storedD })
    const result = await sweep(h.port)
    assert.equal(fake.orders.get(SURVIVOR)!.status, 9, 'the survivor was NOT cancelled')
    assert.equal(fake.requests.some((r) => r.path.endsWith('/Cancel')), false)
    assert.equal(result.operatorNotices, 1)
    assert.match(String(h.writes.find((w) => typeof w.data.lastError === 'string')!.data.lastError), /another line appeared/)
    assert.equal(h.writes.some((w) => w.data.state === 'CANCELLED'), false)
  })
})

test('AN UNFLAGGED "+" NUMBER IS AN ORDINARY ORDER: it is cancelled normally, not treated as a merged survivor', async () => {
  await withEnv(OFF, async () => {
    resetFake()
    fake.orders.set(SURVIVOR, { status: 9, number: 'A+B', items: [...D_LINES], merged: false })
    const h = makePort({ cancellable: [absorbingLinkRef()], items: storedD })
    const result = await sweep(h.port)
    assert.equal(fake.orders.get(SURVIVOR)!.status, 3)
    assert.deepEqual(deletedIds(), [])
    assert.equal(result.cancelled, 1)
    assert.equal(h.writes.some((w) => w.data.state === 'MERGED'), false)
  })
})

// ---------------------------------------------------------------- 9. review round 2 -----------------------------------------------

const updatableLink = () => ({
  id: 'link-d', externalOrderId: ABSORBED,
  order: {
    id: 'so-d', orderNumber: 'IMSTEST-D', externalOrderNumber: null, currency: 'GBP', customerName: 'Jane Doe', customerEmail: 'j@example.com',
    customerVatNumber: null, shippingAddress: { line1: '1 St', city: 'Leeds', postcode: 'LS1', country: 'GB' }, shippingService: 'Royal Mail',
    subtotalForeign: 10, shippingForeign: 0, taxForeign: 0, taxRatePercent: null, pricesIncludeVat: false, discountAmount: 0, totalForeign: 10,
    shipFromWarehouseId: 'wh-1', lines: [{ sku: 'A', qty: 1, taxForeign: 0, totalForeign: 10, description: 'Widget' }],
  },
})

/** A port whose recorded line ids live in a small in-memory store, so the amend pass and the later cancel see the same snapshot. */
function snapshotPort(initial: WmsOrderItemRef[], initialUnsafe = false) {
  const store = { items: [...initial], unsafe: initialUnsafe, marks: [] as boolean[], tokens: [] as string[] }
  const h = makePort({ cancellable: [], items: null })
  h.port.updatableLinks = async () => [updatableLink()] as never
  // Like the real port: a link whose ids are marked untrustworthy has no usable record.
  h.port.readOrderItems = async () => (store.unsafe ? [] : [...store.items])
  h.port.replaceOrderItems = async (_orderId, _ext, items, token) => { store.tokens.push(`replace:${token}`); store.items = [...items]; store.unsafe = false }
  h.port.setLineIdsUnsafe = async (_id, unsafe, token) => { const was = store.unsafe; store.marks.push(unsafe); store.unsafe = unsafe; store.tokens.push(token ?? 'new'); return { token: 'tok-1', wasUnsafe: unsafe ? was : false } }
  h.port.releaseAmendLease = async (_id, token) => { store.tokens.push(`release:${token}`) }
  return { h, store }
}

test('AMENDMENT whose read-back FAILS (no lines returned): the old snapshot is DELETED; merged and cancelled afterwards, nothing is deleted and a notice is raised', async () => {
  await withEnv(OFF, async () => {
    seedMerged()
    const { h, store } = snapshotPort(storedD)
    await sweep(h.port) // the amend pass: updateOrder is accepted but returns no lines
    assert.deepEqual(store.items, [], 'the stale snapshot is gone')
    // the order is then merged away and cancelled
    h.port.updatableLinks = async () => []
    h.port.cancellableLinks = async () => [mergedLinkRef()]
    h.link.state = 'MERGED'
    h.link.externalOrderId = SURVIVOR
    const result = await sweep(h.port)
    assert.equal(fake.requests.some((r) => r.method === 'DELETE' || r.path.endsWith('/Cancel')), false)
    assert.equal(result.operatorNotices, 1)
    assert.equal(survivorItems().length, 4)
  })
})

test('AMENDMENT that is accepted but whose line changes did not finish (partial): the snapshot is DELETED', async () => {
  await withEnv(OFF, async () => {
    seedMerged()
    const { h, store } = snapshotPort(storedD)
    const { WmsOrderUpdatePartialError } = await import('../lib/connectors/wms/courier-form.ts')
    await sweep(h.port, { updateOrder: async () => { throw new WmsOrderUpdatePartialError('items failed', {}) } })
    assert.deepEqual(store.items, [])
  })
})

test('AMENDMENT whose replacement snapshot cannot be WRITTEN: the old one is cleared instead of kept', async () => {
  await withEnv(OFF, async () => {
    seedMerged()
    const { h, store } = snapshotPort(storedD)
    let calls = 0
    h.port.replaceOrderItems = async (_o, _e, items) => { calls += 1; if (calls === 1) throw new Error('database unavailable'); store.items = [...items] }
    await sweep(h.port, { updateOrder: async () => ({ updated: true, status: 'NEW', items: [{ externalItemId: '1', sku: 'A', quantity: 1 }] }) })
    assert.deepEqual(store.items, [])
  })
})

test('AMENDMENT with a verified re-read REPLACES the snapshot (control)', async () => {
  await withEnv(OFF, async () => {
    seedMerged()
    const { h, store } = snapshotPort(storedD)
    const fresh = [{ externalItemId: '55', sku: 'A', quantity: 1 }]
    await sweep(h.port, { updateOrder: async () => ({ updated: true, status: 'NEW', items: fresh }) })
    assert.deepEqual(store.items, fresh)
  })
})

// ---------------------------------------------------------------- 10. review round 3 -----------------------------------------------

test('CRASH BOUNDARY: the snapshot is replaced BEFORE the link advances; a crash on the link write leaves the amendment due and the snapshot already current', async () => {
  await withEnv(OFF, async () => {
    seedMerged()
    const { h, store } = snapshotPort(storedD)
    const order: string[] = []
    const replace = h.port.replaceOrderItems!
    h.port.replaceOrderItems = async (o, e, items) => { order.push('snapshot'); await replace(o, e, items) }
    h.port.updateLink = async (_id, data) => { order.push('link'); if ('pushedAt' in data) throw new Error('crash') }
    const fresh = [{ externalItemId: '55', sku: 'A', quantity: 1 }]
    await sweep(h.port, { updateOrder: async () => ({ updated: true, status: 'NEW', items: fresh }) })
    assert.equal(order[0], 'snapshot', 'the snapshot write is first')
    assert.deepEqual(store.items, fresh, 'the crash on the link write did not leave the old snapshot behind')
  })
})

test('CRASH BOUNDARY: when even the deletion of a stale snapshot cannot be written, the link is NOT advanced (the amendment stays due)', async () => {
  await withEnv(OFF, async () => {
    seedMerged()
    const { h } = snapshotPort(storedD)
    h.port.replaceOrderItems = async () => { throw new Error('database unavailable') }
    await sweep(h.port)
    assert.equal(h.writes.some((w) => 'pushedAt' in w.data), false)
  })
})

test('LAST-LINES CANCEL with the merge flag MISSING on the fresh read and a line added after ONLY_LINES_LEFT: nothing is cancelled, a notice is raised', async () => {
  await withEnv(OFF, async () => {
    resetFake()
    fake.orders.set(SURVIVOR, { status: 9, number: 'IMSTEST-E+IMSTEST-D', items: D_LINES.map((l) => ({ ...l })), merged: false })
    fake.addLineAfterItemRead = 1
    const h = makePort({ cancellable: [mergedLinkRef()], items: storedD })
    const result = await sweep(h.port)
    assert.equal(fake.orders.get(SURVIVOR)!.status, 9)
    assert.equal(fake.requests.some((r) => r.path.endsWith('/Cancel')), false)
    assert.equal(result.operatorNotices, 1)
  })
})

test('LAST-LINES CANCEL, unflagged, the re-read FAILS: nothing is sent to /Cancel and the cancel stays retryable', async () => {
  await withEnv(OFF, async () => {
    resetFake()
    fake.orders.set(SURVIVOR, { status: 9, number: 'IMSTEST-E+IMSTEST-D', items: D_LINES.map((l) => ({ ...l })), merged: false })
    fake.itemsReadFailsAfterDeletes = 0
    const h = makePort({ cancellable: [mergedLinkRef()], items: storedD })
    const result = await sweep(h.port)
    assert.equal(fake.requests.some((r) => r.path.endsWith('/Cancel')), false)
    assert.equal(h.writes.some((w) => w.data.state === 'CANCELLED'), false)
    assert.ok((result.failed ?? 0) + (result.operatorNotices ?? 0) >= 1)
  })
})

// ---------------------------------------------------------------- 11. review round 4 -----------------------------------------------

async function amendAbsorbing(merged: boolean) {
  seedMerged()
  fake.orders.get(SURVIVOR)!.merged = merged
  // flagged case: the number still equals the pushed one, so ONLY the flag can refuse it
  if (merged) fake.orders.get(SURVIVOR)!.number = 'IMSTEST-D'
  const { h } = snapshotPort(storedE)
  h.link.state = 'SYNCED'
  h.link.externalOrderId = SURVIVOR
  h.port.updatableLinks = async () => [{ ...updatableLink(), externalOrderId: SURVIVOR }] as never
  const orderPush = await import('../lib/connectors/mintsoft/api/order-push.ts')
  const result = await sweep(h.port, { updateOrder: async (id: string, input: never) => orderPush.updateMintsoftOrder(id, input) })
  return { h, result }
}

test('ABSORBING ORDER changed in IMS while its link is still SYNCED (survivor flagged merged): NO item DELETE/POST/PUT, no order update, the link is marked MERGED and left for a person', async () => {
  await withEnv(OFF, async () => {
    const { h, result } = await amendAbsorbing(true)
    assert.deepEqual(writeRequests(), [], 'nothing was written to the warehouse')
    assert.equal(survivorItems().length, 4, 'both orders\' lines are untouched')
    assert.equal(result.updated, 0)
    const moved = h.writes.find((w) => w.data.state === 'MERGED')
    assert.ok(moved, 'the link was handed to merge handling')
    assert.match(String(moved!.data.lastError), /NOT sent to the WMS/)
    assert.equal(h.writes.some((w) => 'pushedAt' in w.data), false)
  })
})

test('ABSORBING ORDER, merge flag absent but the number is now a combined "a+b" one: the amendment is refused the same way', async () => {
  await withEnv(OFF, async () => {
    const { h } = await amendAbsorbing(false)
    assert.deepEqual(writeRequests(), [])
    assert.equal(survivorItems().length, 4)
    assert.ok(h.writes.some((w) => w.data.state === 'MERGED'))
  })
})

// ---------------------------------------------------------------- 12. review round 5 -----------------------------------------------

test('FAILED CLEANUP: an accepted amendment whose snapshot replacement AND deletion both fail leaves the ids MARKED untrustworthy; the merged cancel then removes nothing, cancels nothing and raises a notice', async () => {
  await withEnv(OFF, async () => {
    seedMerged()
    const { h, store } = snapshotPort(storedD)
    h.port.replaceOrderItems = async () => { throw new Error('database unavailable') }
    await sweep(h.port, { updateOrder: async () => ({ updated: true, status: 'NEW', items: [{ externalItemId: '55', sku: 'A', quantity: 1 }] }) })
    assert.equal(store.unsafe, true, 'the mark set before the amendment is still set')
    h.port.updatableLinks = async () => []
    h.port.cancellableLinks = async () => [mergedLinkRef()]
    h.link.state = 'MERGED'
    h.link.externalOrderId = SURVIVOR
    const result = await sweep(h.port)
    assert.equal(fake.requests.some((r) => r.method === 'DELETE' || r.path.endsWith('/Cancel')), false)
    assert.equal(result.operatorNotices, 1)
    assert.equal(h.writes.some((w) => w.data.state === 'CANCELLED'), false)
    assert.equal(survivorItems().length, 4)
  })
})

test('PARTIAL AMENDMENT whose cleanup also fails: the ids stay marked untrustworthy (the mark was written before anything was sent)', async () => {
  await withEnv(OFF, async () => {
    seedMerged()
    const { h, store } = snapshotPort(storedD)
    h.port.replaceOrderItems = async () => { throw new Error('database unavailable') }
    const { WmsOrderUpdatePartialError } = await import('../lib/connectors/wms/courier-form.ts')
    await sweep(h.port, { updateOrder: async () => { throw new WmsOrderUpdatePartialError('items failed', {}) } })
    assert.equal(store.unsafe, true)
    assert.deepEqual(store.marks, [true])
  })
})

test('THE MARK IS WRITTEN BEFORE ANYTHING IS SENT and NOTHING is sent when it cannot be written', async () => {
  await withEnv(OFF, async () => {
    seedMerged()
    const { h } = snapshotPort(storedD)
    h.port.setLineIdsUnsafe = async () => { throw new Error('database unavailable') }
    let sent = 0
    await sweep(h.port, { updateOrder: async () => { sent += 1; return { updated: true, status: 'NEW' } } })
    assert.equal(sent, 0)
  })
})

test('AN AMENDMENT THAT CHANGED NOTHING (not NEW) un-marks the ids; a verified replacement clears the mark too', async () => {
  await withEnv(OFF, async () => {
    seedMerged()
    const a = snapshotPort(storedD)
    await sweep(a.h.port, { updateOrder: async () => ({ updated: false, status: 'NOT_NEW' }) })
    assert.deepEqual(a.store.marks, [true, false])
    assert.equal(a.store.unsafe, false)
    const b = snapshotPort(storedD)
    await sweep(b.h.port, { updateOrder: async () => ({ updated: true, status: 'NEW', items: [{ externalItemId: '1', sku: 'A', quantity: 1 }] }) })
    assert.equal(b.store.unsafe, false)
  })
})

test('REFUSED AMENDMENT of a merged order writes the durable amendment notice (amendNoticeAt) on the link', async () => {
  await withEnv(OFF, async () => {
    const { h } = await amendAbsorbing(true)
    const moved = h.writes.find((w) => w.data.state === 'MERGED')
    assert.ok(moved!.data.amendNoticeAt instanceof Date)
  })
})

// ---------------------------------------------------------------- 13. review round 6 -----------------------------------------------

test('GENERATION TOKEN: the amendment passes the token its own mark returned to the snapshot replacement and to the un-mark', async () => {
  await withEnv(OFF, async () => {
    seedMerged()
    const a = snapshotPort(storedD)
    await sweep(a.h.port, { updateOrder: async () => ({ updated: true, status: 'NEW', items: [{ externalItemId: '1', sku: 'A', quantity: 1 }] }) })
    assert.ok(a.store.tokens.includes('replace:tok-1'), 'replace carried the owner token')
    const b = snapshotPort(storedD)
    await sweep(b.h.port, { updateOrder: async () => ({ updated: false, status: 'NOT_NEW' }) })
    assert.ok(b.store.tokens.includes('tok-1'), 'the un-mark carried the owner token')
  })
})

// ---------------------------------------------------------------- 14. review round 7 -----------------------------------------------

test('LEASE: when another sweep holds the link\'s amendment lease, the link is skipped: no remote amendment, no link write, no notice', async () => {
  await withEnv(OFF, async () => {
    seedMerged()
    const { h } = snapshotPort(storedD)
    h.port.setLineIdsUnsafe = async () => null
    let sent = 0
    const result = await sweep(h.port, { updateOrder: async () => { sent += 1; return { updated: true, status: 'NEW' } } })
    assert.equal(sent, 0)
    assert.deepEqual(h.writes, [])
    assert.equal(result.failed, 0)
  })
})

test('LEASE: a failed amendment releases the lease but leaves the ids untrusted (the mark stays)', async () => {
  await withEnv(OFF, async () => {
    seedMerged()
    const { h, store } = snapshotPort(storedD)
    const released: string[] = []
    h.port.releaseAmendLease = async (_id, token) => { released.push(token) }
    await sweep(h.port, { updateOrder: async () => { throw new Error('mintsoft down') } })
    assert.deepEqual(released, ['tok-1'])
    assert.equal(store.unsafe, true)
  })
})

// ---------------------------------------------------------------- 15. review round 8 -----------------------------------------------

for (const [label, answer] of [['NOT_NEW', { updated: false, status: 'NOT_NEW' }], ['MERGED_SURVIVOR', { updated: false, status: 'MERGED_SURVIVOR' }]] as const) {
  test(`INTERRUPTED AMENDMENT (a line was added, no snapshot replace, the mark left set): a retry that answers ${label} and writes nothing does NOT clear the mark; the merged cancel removes nothing and raises a notice`, async () => {
    await withEnv(OFF, async () => {
      seedMerged()
      const { h, store } = snapshotPort(storedD, true)
      await sweep(h.port, { updateOrder: async () => answer })
      assert.equal(store.unsafe, true, 'the pre-existing mark is still set')
      assert.deepEqual(store.marks, [true], 'it was never cleared by the no-op')
      assert.ok(store.tokens.includes('release:tok-1'), 'the lease is released')
      assert.deepEqual(await h.port.readOrderItems!('link-d'), [], 'no trusted ids')
      h.port.updatableLinks = async () => []
      h.port.cancellableLinks = async () => [mergedLinkRef()]
      h.link.state = 'MERGED'
      h.link.externalOrderId = SURVIVOR
      const result = await sweep(h.port)
      assert.equal(fake.requests.some((r) => r.method === 'DELETE' || r.path.endsWith('/Cancel')), false)
      assert.equal(result.operatorNotices, 1)
      assert.equal(h.writes.some((w) => w.data.state === 'CANCELLED'), false)
      assert.equal(survivorItems().length, 4)
    })
  })
}

test('CONTROL: a no-op retry that itself set the mark (nothing was set before) still clears it', async () => {
  await withEnv(OFF, async () => {
    seedMerged()
    const { h, store } = snapshotPort(storedD, false)
    await sweep(h.port, { updateOrder: async () => ({ updated: false, status: 'NOT_NEW' }) })
    assert.deepEqual(store.marks, [true, false])
    assert.equal(store.unsafe, false)
  })
})
