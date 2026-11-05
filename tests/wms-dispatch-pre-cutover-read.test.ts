import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { OUTBOUND_GRANT_ENV } from '@/lib/security/outbound-write-hold-constants'
import { PRODUCER_CUTOFF_ENV, PRODUCER_HOLD_ENFORCED_ENV } from '@/lib/security/producer-disposition-constants'

/**
 * A SPLIT ORDER'S PRE-CUTOVER PARTS ARE VERIFIED BY A FRESH, READ-ONLY LOOK AT THE STOREFRONT ORDER.
 *
 * A part despatched BEFORE the WooCommerce live-from instant belongs to the writer that owned the store then, so IMS's own
 * partial-shipment push for it is shadowed for ever (reason `obligation_before_cutoff`) and, until now, the order stayed pending
 * for ever. After the cutover the sweep reads the order from the store it is linked to NOW and completes the IMS side only when
 * that order is `completed` there, at or after the LATEST despatch. Stored webhook deliveries are never consulted.
 *
 * The push path is the REAL facade over the REAL producer seam, and the verifier is the REAL module, over the REAL read client.
 * Only the Woo transport is a double: it records EVERY request (method and URL) and answers the order read from a script.
 * Nothing here reaches a network.
 */

const ORIGIN = 'https://shop.example.com'
const ENV_KEYS = [PRODUCER_HOLD_ENFORCED_ENV, OUTBOUND_GRANT_ENV.woocommerce, PRODUCER_CUTOFF_ENV.woocommerce]
const SEAM_ON = { [PRODUCER_HOLD_ENFORCED_ENV]: 'woocommerce', [OUTBOUND_GRANT_ENV.woocommerce]: ORIGIN }

async function withEnv<T>(values: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const)
  for (const key of ENV_KEYS) delete process.env[key]
  for (const [key, value] of Object.entries(values)) if (value !== undefined) process.env[key] = value
  try { return await fn() } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

// ───────────────────────── doubles: a database that answers "nothing here", the settings, the activity log, the transport ─────────────────────────

const calls: string[] = []
const settings = new Map<string, string>()
const transport: string[] = []
const activity: Array<{ action: string; entityId?: string; description: string; metadata?: Record<string, unknown> }> = []
const T0 = new Date('2026-04-01T00:00:00Z')
let link: { externalOrderId: string; externalOrderNumber: string | null; createdAt: Date } | null = { externalOrderId: '555', externalOrderNumber: '1001', createdAt: T0 }
type ImsLine = { sku: string | null; qty: number; wclcFeeKind: string | null; productId: string | null; externalLineItemId: number | null }
const GOODS: ImsLine = { sku: 'A', qty: 1, wclcFeeKind: null, productId: 'p1', externalLineItemId: 11 }
let imsLines: ImsLine[] = [GOODS]
let orderCreatedAt = T0
let bindingChangedAt: Date | null = null // when the wc_settings_version row was last written
let orderRead: () => Response = () => new Response('{}', { status: 500 })

function modelProxy(name: string) {
  return new Proxy({}, {
    get: (_target, method: string) => async (args?: { where?: { key?: string }; data?: Record<string, unknown> }) => {
      calls.push(`${name}.${method}`)
      if (name === 'salesOrder' && method === 'findUnique') return { createdAt: orderCreatedAt, lines: imsLines }
      if (name === 'setting' && (method === 'findUnique' || method === 'findFirst')) {
        const key = args?.where?.key ?? ''
        if (key === 'wc_settings_version') return bindingChangedAt ? { key, value: '2', updatedAt: bindingChangedAt } : null
        return settings.has(key) ? { key, value: settings.get(key) } : null
      }
      switch (method) {
        case 'findMany': return []
        case 'findUnique': case 'findFirst': return name === 'shoppingOrderLink' ? link : null
        case 'count': return 0
        case 'updateMany': return { count: 1 }
        case 'deleteMany': return { count: 0 }
        case 'create': return { id: `${name}-1`, ...(args?.data ?? {}) }
        default: return {}
      }
    },
  })
}
const fakeDb: object = new Proxy({}, {
  get: (_target, prop: string) => {
    if (prop === 'then') return undefined
    if (prop === '$queryRaw') {
      return async (query: { strings?: readonly string[]; values?: readonly unknown[] }) => {
        const text = (query.strings ?? []).join('?')
        calls.push('$queryRaw')
        if (!text.includes('outbound_shadow_writes')) return []
        return [{ id: 'shadow-1', inserted: true, occurrences: 1, accounting_sync_log_id: null, sync_row_exists: false }]
      }
    }
    if (prop === '$executeRaw') return async () => 1
    if (prop === '$executeRawUnsafe') return undefined
    if (prop === '$transaction') return async (fn: (tx: object) => unknown) => fn(fakeDb)
    return modelProxy(prop)
  },
})

mock.module('@/lib/db', { namedExports: { db: fakeDb } })
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: (typeof activity)[number]) => { activity.push(entry) },
    logActivityPersisted: async () => true,
  },
})
mock.module('@/lib/integration-plugins', {
  namedExports: { getIntegrationPluginState: async () => ({ woocommerce: true }), isIntegrationPluginEnabled: async () => true },
})
const settingValues = async (keys: string[]) => new Map(keys.flatMap((key) => (settings.has(key) ? [[key, settings.get(key)!] as const] : [])))
mock.module('@/lib/settings-store', {
  namedExports: { getSettingValues: settingValues, getSettingValue: async (key: string) => settings.get(key) ?? null },
})
mock.module('@/lib/security/connector-fetch', {
  namedExports: {
    // The Woo transport double: EVERY request is recorded with its method; the order read is scripted; a live push is accepted.
    connectorFetch: async (url: string | URL, init?: { method?: string }) => {
      const method = init?.method ?? 'GET'
      transport.push(`${method} ${String(url)}`)
      if (method === 'GET' && /\/wp-json\/wc\/v3\/orders\/555$/.test(String(url))) return orderRead()
      if (method === 'POST' && String(url).includes('/partial-shipment')) return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
      return new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } })
    },
  },
})

const ORDER_READ = `GET ${ORIGIN}/wp-json/wc/v3/orders/555`
const wcOrder = (over: Record<string, unknown> = {}) => () => new Response(JSON.stringify({
  id: 555, number: '1001', status: 'completed', date_completed: '2026-05-23T10:00:00', date_completed_gmt: '2026-05-23T09:00:00',
  date_modified_gmt: '2026-05-23T09:00:20', refunds: [], line_items: [{ id: 11, quantity: 1, sku: 'A' }],
  _links: { self: [{ href: `${ORIGIN}/wp-json/wc/v3/orders/555` }] }, ...over,
}), { status: 200, headers: { 'content-type': 'application/json' } })

function reset() {
  calls.length = 0
  transport.length = 0
  activity.length = 0
  settings.clear()
  link = { externalOrderId: '555', externalOrderNumber: '1001', createdAt: T0 }
  imsLines = [GOODS]
  orderCreatedAt = T0
  bindingChangedAt = null
  orderRead = wcOrder()
  for (const [key, value] of Object.entries({
    wc_url: ORIGIN, wc_consumer_key: 'ck_x', wc_consumer_secret: 'cs_x', wc_webhook_secret: 's',
  })) settings.set(key, value)
}
const writes = () => transport.filter((entry) => !entry.startsWith('GET '))
const reads = () => transport.filter((entry) => entry.startsWith('GET '))

// ───────────────────────── the sweep, with the REAL push facade and the REAL verifier ─────────────────────────

const CUTOFF = '2026-06-01T00:00:00Z'
const PRE = '2026-05-20T10:00:00Z' // before the cutoff
const PRE2 = '2026-05-22T10:00:00Z' // also before the cutoff, later than PRE
const POST = '2026-07-01T10:00:00Z' // after the cutoff (and before now)

type Part = { externalId: string; partNumber: number; status: string; dispatched: boolean; tracking: Array<{ trackingNumber: string; carrier: string; despatchedAt: string }> }
const part = (n: number, at: string): Part => ({ externalId: `M-${n}`, partNumber: n, status: 'DESPATCHED', dispatched: true, tracking: [{ trackingNumber: `TN-${n}`, carrier: 'DPD', despatchedAt: at }] })

async function sweep(parts: Part[], options: { verifier?: boolean } = {}) {
  const { runWmsDispatchSweepCore } = await import('@/lib/domain/wms/dispatch-sweep')
  const { pushPartialShipmentToShopping } = await import('@/lib/shopping')
  const { verifyPreCutoverCompletionByFreshRead } = await import('@/lib/connectors/woocommerce/sync/pre-cutover-order-read')
  const applyOptions: Array<Record<string, unknown> | undefined> = []
  const asked: Array<string | null> = []
  const out = await runWmsDispatchSweepCore({
    listCandidates: async () => [{ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001' }],
    fetchOrderStatus: async () => ({
      externalOrderId: 'M-1', externalOrderNumber: 'WC-1001', status: 'DESPATCHED', statusLabel: 'Despatched', isSplit: true, partCount: parts.length,
      isMerged: false, mergedOrderNumbers: [], deepLinkUrl: null, tracking: [], dispatched: true, raw: null,
    }),
    partsSupported: true,
    fetchOrderParts: async () => parts,
    fetchPartItems: async () => [{ sku: 'A', qty: 1 }],
    repointLink: async () => {},
    clearDispatchFailures: async () => {},
    countLinksByOrderNumber: async (numbers: string[]) => new Map(numbers.map((n) => [n, 1])),
    applyDispatch: async (_orderId: string, _tracking: unknown, opts?: Record<string, unknown>) => { applyOptions.push(opts); return { success: true } },
    pushPartialShipment: async (orderId: string, input: { part: number; totalParts: number; items: Array<{ sku: string; qty: number }>; despatchedAt?: Date | null }) => {
      const result = await pushPartialShipmentToShopping(orderId, input as never)
      return { ok: result.success, error: result.error, ...(result.shadowed === true ? { shadowed: true } : {}), ...(result.shadowReason ? { shadowReason: result.shadowReason } : {}) }
    },
    recordDispatchError: async () => ({ deadLettered: false }),
    ...(options.verifier === false ? {} : {
      verifyPreCutoverCompletion: async (orderId: string, latest: Date | null) => {
        asked.push(latest?.toISOString() ?? null)
        return verifyPreCutoverCompletionByFreshRead(orderId, latest)
      },
    }),
  } as never)
  return { out, applyOptions, asked }
}

const LIVE_AT_CUTOFF = { ...SEAM_ON, [PRODUCER_CUTOFF_ENV.woocommerce]: CUTOFF }

test('VERIFIED: completed now, completion at or after the LATEST despatch: the IMS side completes as "storefront already completed", ONE read, no write, outcome logged', async () => {
  reset()
  await withEnv(LIVE_AT_CUTOFF, async () => {
    const run = await sweep([part(1, PRE), part(2, PRE2)])
    assert.equal(run.out.counters.dispatched, 1)
    assert.deepEqual(run.applyOptions, [{ storefrontAlreadyCompleted: true }])
    assert.deepEqual(run.asked, [new Date(PRE2).toISOString()], 'asked once, against the LATEST despatch among the parts (not once per part)')
    assert.deepEqual(reads(), [ORDER_READ], 'one read of the linked order for the whole order, though two parts were shadowed')
    assert.deepEqual(writes(), [])
    const logged = activity.filter((a) => a.action.startsWith('pre_cutover_part_'))
    assert.deepEqual(logged.map((a) => [a.action, a.metadata]), [['pre_cutover_part_verified', { outcome: 'verified', code: 'verified' }]])
    assert.equal(logged[0]!.entityId, 'o1')
  })
})

test('the completion instant at EXACTLY the latest despatch verifies (at or after)', async () => {
  reset()
  orderRead = wcOrder({ date_completed_gmt: '2026-05-22T10:00:00', date_modified_gmt: '2026-05-22T10:00:05' })
  await withEnv(LIVE_AT_CUTOFF, async () => {
    assert.equal((await sweep([part(1, PRE), part(2, PRE2)])).out.counters.dispatched, 1)
  })
})

test('PENDING, nothing written: completed, but BEFORE the latest despatch (after only the FIRST part)', async () => {
  reset()
  orderRead = wcOrder({ date_completed_gmt: '2026-05-21T09:00:00', date_completed: '2026-05-23T10:00:00' })
  await withEnv(LIVE_AT_CUTOFF, async () => {
    const run = await sweep([part(1, PRE), part(2, PRE2)])
    assert.equal(run.out.counters.dispatched, 0)
    assert.equal(run.out.counters.pending, 1)
    assert.deepEqual(run.applyOptions, [])
    assert.deepEqual(writes(), [])
    assert.equal(activity.find((a) => a.action === 'pre_cutover_part_pending')?.metadata?.code, 'completed_before_despatch')
  })
})

test('PENDING: the LOCAL date_completed is never used (it looks fine, the GMT instant is before the despatch)', async () => {
  reset()
  orderRead = wcOrder({ date_completed: '2026-05-30T10:00:00', date_completed_gmt: '2026-05-19T09:00:00' })
  await withEnv(LIVE_AT_CUTOFF, async () => {
    assert.equal((await sweep([part(1, PRE)])).out.counters.dispatched, 0)
  })
  // and the converse: a local time that looks too early does not veto a GMT instant that is fine
  reset()
  orderRead = wcOrder({ date_completed: '2026-05-19T09:00:00', date_completed_gmt: '2026-05-23T09:00:00' })
  await withEnv(LIVE_AT_CUTOFF, async () => {
    assert.equal((await sweep([part(1, PRE)])).out.counters.dispatched, 1)
  })
})

for (const status of ['processing', 'on-hold', 'partial-shipped', 'cancelled', 'refunded', 'pending', '']) {
  test(`PENDING, nothing written: the CURRENT status is "${status || '(blank)'}", not completed (a reopened order)`, async () => {
    reset()
    orderRead = wcOrder({ status })
    await withEnv(LIVE_AT_CUTOFF, async () => {
      const run = await sweep([part(1, PRE)])
      assert.equal(run.out.counters.dispatched, 0)
      assert.equal(run.out.counters.pending, 1)
      assert.deepEqual(run.applyOptions, [])
      assert.deepEqual(writes(), [])
    })
  })
}

for (const [name, over] of [
  ['missing', { date_completed_gmt: undefined }],
  ['null', { date_completed_gmt: null }],
  ['empty', { date_completed_gmt: '' }],
  ['unparseable', { date_completed_gmt: 'yesterday' }],
  ['a date with a non-UTC offset', { date_completed_gmt: '2026-05-23T09:00:00+05:00' }],
  ['an impossible date', { date_completed_gmt: '2026-13-45T09:00:00' }],
  ['a number', { date_completed_gmt: 1779526800 }],
] as const) {
  test(`PENDING: date_completed_gmt is ${name}`, async () => {
    reset()
    orderRead = wcOrder(over)
    await withEnv(LIVE_AT_CUTOFF, async () => {
      const run = await sweep([part(1, PRE)])
      assert.equal(run.out.counters.dispatched, 0)
      assert.equal(activity.find((a) => a.action === 'pre_cutover_part_pending')?.metadata?.code, 'no_completion_date')
    })
  })
}

for (const [name, read] of [
  ['a server error', () => () => new Response('{"code":"x"}', { status: 500, headers: { 'content-type': 'application/json' } })],
  ['a 404', () => () => new Response('{"code":"woocommerce_rest_shop_order_invalid_id"}', { status: 404, headers: { 'content-type': 'application/json' } })],
  ['a timeout (the transport throws)', () => () => { throw new Error('WooCommerce request timed out after 120000ms.') }],
  ['a non-JSON answer', () => () => new Response('<html>maintenance</html>', { status: 200, headers: { 'content-type': 'text/html' } })],
  ['a JSON answer that is not an order', () => () => new Response('[1,2]', { status: 200, headers: { 'content-type': 'application/json' } })],
] as const) {
  test(`PENDING and NOTHING written: the read fails with ${name}`, async () => {
    reset()
    orderRead = read()
    await withEnv(LIVE_AT_CUTOFF, async () => {
      const run = await sweep([part(1, PRE)])
      assert.equal(run.out.counters.dispatched, 0)
      assert.equal(run.out.counters.pending, 1)
      assert.equal(run.out.counters.errors, 0, 'not a failure streak: it is simply not verified yet')
      assert.deepEqual(run.applyOptions, [])
      assert.deepEqual(writes(), [])
    })
  })
}

test('PENDING: the order is linked to a DIFFERENT store than the one read (store identity bound to the current binding)', async () => {
  for (const href of ['https://other.example.org/wp-json/wc/v3/orders/555', `${ORIGIN}/store-b/wp-json/wc/v3/orders/555`]) {
    reset()
    orderRead = wcOrder({ _links: { self: [{ href }] } })
    await withEnv(LIVE_AT_CUTOFF, async () => {
      const run = await sweep([part(1, PRE)])
      assert.equal(run.out.counters.dispatched, 0, href)
      assert.equal(activity.find((a) => a.action === 'pre_cutover_part_pending')?.metadata?.code, 'store_mismatch')
      assert.deepEqual(writes(), [])
    })
  }
  // an order that states no store at all proves nothing
  reset()
  orderRead = wcOrder({ _links: undefined })
  await withEnv(LIVE_AT_CUTOFF, async () => { assert.equal((await sweep([part(1, PRE)])).out.counters.dispatched, 0) })
  // the same store written differently (www, scheme, trailing slash) is the same store
  reset()
  orderRead = wcOrder({ _links: { self: [{ href: 'http://www.shop.example.com/wp-json/wc/v3/orders/555' }] } })
  await withEnv(LIVE_AT_CUTOFF, async () => { assert.equal((await sweep([part(1, PRE)])).out.counters.dispatched, 1) })
})

test('PENDING: the store answered with a different order id or number than the one linked', async () => {
  for (const over of [{ id: 556 }, { number: '9999' }]) {
    reset()
    orderRead = wcOrder(over)
    await withEnv(LIVE_AT_CUTOFF, async () => {
      assert.equal((await sweep([part(1, PRE)])).out.counters.dispatched, 0)
      assert.equal(activity.find((a) => a.action === 'pre_cutover_part_pending')?.metadata?.code, 'wrong_order')
    })
  }
})

test('PENDING: no WooCommerce link, store not configured, or no despatch time: no read is even made', async () => {
  reset()
  link = null
  await withEnv(LIVE_AT_CUTOFF, async () => {
    assert.equal((await sweep([part(1, PRE)])).out.counters.dispatched, 0)
    assert.deepEqual(transport, [])
  })
  reset()
  settings.delete('wc_consumer_key')
  await withEnv(LIVE_AT_CUTOFF, async () => {
    assert.equal((await sweep([part(1, PRE)])).out.counters.dispatched, 0)
    assert.deepEqual(transport, [])
  })
  // a sweep that wires no verifier at all stays pending, exactly as before
  reset()
  await withEnv(LIVE_AT_CUTOFF, async () => {
    const run = await sweep([part(1, PRE)], { verifier: false })
    assert.equal(run.out.counters.dispatched, 0)
    assert.equal(run.out.counters.pending, 1)
    assert.deepEqual(reads(), [])
  })
})

test('BEFORE the cutoff, or with NO GRANT, or for any other shadow reason: UNCHANGED - the verifier is not asked and nothing is read', async () => {
  reset()
  await withEnv({ ...SEAM_ON, [PRODUCER_CUTOFF_ENV.woocommerce]: '2099-01-01T00:00:00Z' }, async () => {
    const run = await sweep([part(1, PRE)])
    assert.deepEqual(run.asked, [])
    assert.equal(run.out.counters.pending, 1)
    assert.deepEqual(transport, [])
  })
  reset()
  await withEnv({ [PRODUCER_HOLD_ENFORCED_ENV]: 'woocommerce', [PRODUCER_CUTOFF_ENV.woocommerce]: CUTOFF }, async () => {
    const run = await sweep([part(1, PRE)])
    assert.deepEqual(run.asked, [])
    assert.equal(run.out.counters.dispatched, 0)
    assert.deepEqual(transport, [])
  })
  // a different reason (the obligation time is unreadable) is also a shadow, and also unchanged
  reset()
  await withEnv(LIVE_AT_CUTOFF, async () => {
    const { runWmsDispatchSweepCore } = await import('@/lib/domain/wms/dispatch-sweep')
    let asked = 0
    const out = await runWmsDispatchSweepCore({
      listCandidates: async () => [{ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001' }],
      fetchOrderStatus: async () => ({ externalOrderId: 'M-1', externalOrderNumber: 'WC-1001', status: 'DESPATCHED', statusLabel: 'Despatched', isSplit: true, partCount: 1, isMerged: false, mergedOrderNumbers: [], deepLinkUrl: null, tracking: [], dispatched: true, raw: null }),
      partsSupported: true, fetchOrderParts: async () => [part(1, PRE)], fetchPartItems: async () => [{ sku: 'A', qty: 1 }],
      repointLink: async () => {}, clearDispatchFailures: async () => {}, countLinksByOrderNumber: async (n: string[]) => new Map(n.map((x) => [x, 1])),
      applyDispatch: async () => ({ success: true }), recordDispatchError: async () => ({ deadLettered: false }),
      pushPartialShipment: async () => ({ ok: false, shadowed: true, shadowReason: 'before_cutoff', error: 'held' }),
      verifyPreCutoverCompletion: async () => { asked += 1; return { verified: true, detail: 'x' } },
    } as never)
    assert.equal(asked, 0)
    assert.equal(out.counters.pending, 1)
  })
})

test('a seam with the switch OFF is untouched: the push reaches the storefront and nothing is read', async () => {
  reset()
  await withEnv({}, async () => {
    const run = await sweep([part(1, PRE)])
    assert.deepEqual(run.asked, [])
    assert.equal(writes().length, 1)
    assert.deepEqual(reads(), [])
  })
})

test('MIXED order (one part verified pre-cutover, one pushed live): completes NORMALLY, without the "already completed" flag', async () => {
  reset()
  // the storefront completed the order after the LATEST despatch (the post-cutover part), so the pre-cutover part verifies
  orderRead = wcOrder({ date_completed_gmt: '2026-07-02T09:00:00', date_modified_gmt: '2026-07-02T09:00:10' })
  await withEnv(LIVE_AT_CUTOFF, async () => {
    const run = await sweep([part(1, PRE), part(2, POST)])
    assert.equal(run.out.counters.dispatched, 1)
    assert.deepEqual(run.applyOptions, [undefined])
    assert.equal(writes().length, 1, 'the live part DID reach the transport (the rig can see a write)')
    assert.match(writes()[0]!, /partial-shipment/)
    assert.deepEqual(reads(), [ORDER_READ])
  })
})

test('a POST-cutover split order dispatches normally: both parts pushed live, nothing read, normal completion', async () => {
  reset()
  await withEnv(LIVE_AT_CUTOFF, async () => {
    const run = await sweep([part(1, POST), part(2, POST)])
    assert.equal(run.out.counters.dispatched, 1)
    assert.deepEqual(run.applyOptions, [undefined])
    assert.equal(writes().length, 2)
    assert.deepEqual(reads(), [])
  })
})

test('NOTHING is cached across sweeps: a second sweep reads again, and a reopened order is then refused', async () => {
  reset()
  await withEnv(LIVE_AT_CUTOFF, async () => {
    assert.equal((await sweep([part(1, PRE)])).out.counters.dispatched, 1)
    orderRead = wcOrder({ status: 'processing' })
    assert.equal((await sweep([part(1, PRE)])).out.counters.dispatched, 0)
    assert.deepEqual(reads(), [ORDER_READ, ORDER_READ])
  })
})

test('CENSUS: across every scenario above the verification issues no HTTP method but GET, and never reads a stored webhook delivery', async () => {
  reset()
  await withEnv(LIVE_AT_CUTOFF, async () => {
    for (const over of [{}, { status: 'processing' }, { date_completed_gmt: 'x' }, { id: 1 }]) {
      orderRead = wcOrder(over)
      await sweep([part(1, PRE), part(2, PRE2)])
    }
    orderRead = () => { throw new Error('boom') }
    await sweep([part(1, PRE)])
  })
  // the sweep above pushes nothing live (both parts pre-cutover): every request is the verifier's
  assert.ok(transport.length >= 5, 'PRECONDITION: the verifier made requests')
  assert.deepEqual(transport.filter((entry) => !entry.startsWith('GET ')), [], 'no non-GET request was made')
  assert.deepEqual(calls.filter((c) => /webhook/i.test(c)), [], 'no stored webhook delivery was consulted')
})

test('no customer data reaches the activity log: only the order id, the outcome and a reason code', async () => {
  reset()
  orderRead = wcOrder({ billing: { email: 'jane@example.com', first_name: 'Jane' }, shipping: { address_1: '1 High St' } })
  await withEnv(LIVE_AT_CUTOFF, async () => { await sweep([part(1, PRE)]) })
  const text = JSON.stringify(activity)
  assert.doesNotMatch(text, /jane|example\.com|High St|1001|555/i)
})

// ───────────────────────── completed is not enough: edited, refunded, different lines; and a changed store binding ─────────────────────────

const codeOf = () => activity.find((a) => a.action === 'pre_cutover_part_pending')?.metadata?.code

async function expectPending(code: string, setup: () => void) {
  reset()
  setup()
  await withEnv(LIVE_AT_CUTOFF, async () => {
    const run = await sweep([part(1, PRE)])
    assert.equal(run.out.counters.dispatched, 0)
    assert.equal(run.out.counters.pending, 1)
    assert.deepEqual(run.applyOptions, [])
    assert.deepEqual(writes(), [])
    assert.equal(codeOf(), code)
  })
}

test('(a) EDITED after completion: date_modified_gmt later than date_completed_gmt beyond the tolerance is pending; within it, verified', async () => {
  await expectPending('edited_after_completion', () => { orderRead = wcOrder({ date_modified_gmt: '2026-05-23T09:02:00' }) })
  await expectPending('edited_after_completion', () => { orderRead = wcOrder({ date_modified_gmt: '2026-06-30T00:00:00' }) })
  for (const bad of [undefined, null, '', 'soon']) {
    await expectPending('edited_after_completion', () => { orderRead = wcOrder({ date_modified_gmt: bad }) })
  }
  const { MODIFIED_AFTER_COMPLETION_TOLERANCE_MS } = await import('@/lib/connectors/woocommerce/sync/pre-cutover-order-read')
  assert.equal(MODIFIED_AFTER_COMPLETION_TOLERANCE_MS, 60_000)
  reset()
  orderRead = wcOrder({ date_modified_gmt: '2026-05-23T09:01:00' }) // exactly at the tolerance
  await withEnv(LIVE_AT_CUTOFF, async () => { assert.equal((await sweep([part(1, PRE)])).out.counters.dispatched, 1) })
  reset()
  orderRead = wcOrder({ date_modified_gmt: '2026-05-23T08:59:00' }) // modified before completion: fine
  await withEnv(LIVE_AT_CUTOFF, async () => { assert.equal((await sweep([part(1, PRE)])).out.counters.dispatched, 1) })
})

test('(b) REFUNDED: any refund, or no statement about refunds at all, is pending', async () => {
  await expectPending('refunded', () => { orderRead = wcOrder({ refunds: [{ id: 9, reason: '', total: '-5.00' }] }) })
  await expectPending('refunded', () => { orderRead = wcOrder({ refunds: undefined }) })
  await expectPending('refunded', () => { orderRead = wcOrder({ refunds: null }) })
})

test('(c) LINES: the storefront line items must be exactly the IMS goods lines (id and quantity); a mirrored fee line is ignored', async () => {
  const lines = 'lines_differ'
  await expectPending(lines, () => { orderRead = wcOrder({ line_items: [{ id: 11, quantity: 2, sku: 'A' }] }) }) // quantity edited
  await expectPending(lines, () => { orderRead = wcOrder({ line_items: [{ id: 11, quantity: 1 }, { id: 12, quantity: 1 }] }) }) // line added
  await expectPending(lines, () => { orderRead = wcOrder({ line_items: [] }) }) // line removed
  await expectPending(lines, () => { orderRead = wcOrder({ line_items: [{ id: 99, quantity: 1 }] }) }) // line replaced
  await expectPending(lines, () => { orderRead = wcOrder({ line_items: undefined }) })
  await expectPending(lines, () => { orderRead = wcOrder({ line_items: [{ id: 'x', quantity: 1 }] }) })
  await expectPending(lines, () => { imsLines = [GOODS, { ...GOODS, externalLineItemId: 12 }] }) // IMS has a line the storefront lacks
  await expectPending(lines, () => { imsLines = [GOODS, { ...GOODS, externalLineItemId: null }] }) // an IMS goods line with no storefront id
  await expectPending(lines, () => { imsLines = [{ ...GOODS, qty: 3 }] })
  reset()
  imsLines = [GOODS, { sku: '', qty: 1, wclcFeeKind: null, productId: null, externalLineItemId: null }] // a mirrored fee line
  await withEnv(LIVE_AT_CUTOFF, async () => { assert.equal((await sweep([part(1, PRE)])).out.counters.dispatched, 1) })
})

test('STORE BINDING: a rebind after the order/link was created refuses, even when the NEW store has an order with the same id and number', async () => {
  // the new store answers perfectly: same id, same number, completed, unchanged, correct self-link for the CURRENT store
  await expectPending('binding_changed', () => { bindingChangedAt = new Date('2026-06-10T00:00:00Z') })
  // the order is older than the link: the older of the two is what counts
  await expectPending('binding_changed', () => { orderCreatedAt = new Date('2026-03-01T00:00:00Z'); link = { ...link!, createdAt: new Date('2026-06-20T00:00:00Z') }; bindingChangedAt = new Date('2026-03-15T00:00:00Z') })
  // a binding written BEFORE the order and link existed is the binding they were made under
  reset()
  bindingChangedAt = new Date('2026-03-01T00:00:00Z')
  await withEnv(LIVE_AT_CUTOFF, async () => {
    assert.equal((await sweep([part(1, PRE)])).out.counters.dispatched, 1)
  })
  // a refusal makes NO request: the binding is checked before the read
  reset()
  bindingChangedAt = new Date('2026-06-10T00:00:00Z')
  await withEnv(LIVE_AT_CUTOFF, async () => {
    await sweep([part(1, PRE)])
    assert.deepEqual(transport, [])
  })
})

// ───────────────────────── the read under the outbound-write hold ─────────────────────────

test('HOLD: with no outbound grant at all the transport hold still lets the order GET through and refuses every write', async () => {
  const { outboundWriteRefusal } = await import('@/lib/security/outbound-write-grant')
  const url = new URL(`${ORIGIN}/wp-json/wc/v3/orders/555`)
  const base = { connectorName: 'WooCommerce', url, headers: new Headers(), body: undefined, env: {} as NodeJS.ProcessEnv }
  assert.equal(outboundWriteRefusal({ ...base, method: 'GET' }), null, 'a GET is a read: never held')
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.notEqual(outboundWriteRefusal({ ...base, method }), null, `${method} is held`)
  }
  const { wooEgressHold } = await import('@/lib/connectors/woocommerce/producer-egress')
  // and the producer egress hold guards the write helpers only: wcFetch (the read client) does not consult it
  const { readFileSync } = await import('node:fs')
  const api = readFileSync('lib/connectors/woocommerce/api.ts', 'utf8')
  const wcFetchBody = api.slice(api.indexOf('export async function wcFetch('), api.indexOf('export async function wcPost('))
  assert.doesNotMatch(wcFetchBody, /wooEgressHold|method:\s*'(POST|PUT|PATCH|DELETE)'/)
  assert.equal(typeof wooEgressHold, 'function')
})

test('the verifier module imports and calls no write function of the connector', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync('lib/connectors/woocommerce/sync/pre-cutover-order-read.ts', 'utf8')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  assert.doesNotMatch(code, /\b(wcPost|wcPut|wcDelete|wcPatch)\b/)
  assert.doesNotMatch(code, /method:\s*['"`]/)
  assert.doesNotMatch(code, /shoppingWebhookEvent|shopping_webhook_events/)
})

test('parseWcGmtInstant reads only an unambiguous UTC instant', async () => {
  const { parseWcGmtInstant } = await import('@/lib/connectors/woocommerce/sync/pre-cutover-order-read')
  assert.equal(parseWcGmtInstant('2026-05-23T09:00:00')?.toISOString(), '2026-05-23T09:00:00.000Z')
  assert.equal(parseWcGmtInstant('2026-05-23T09:00:00Z')?.toISOString(), '2026-05-23T09:00:00.000Z')
  assert.equal(parseWcGmtInstant('2026-05-23T09:00:00.500')?.toISOString(), '2026-05-23T09:00:00.500Z')
  for (const bad of [undefined, null, '', 'x', '2026-05-23', '2026-05-23 09:00:00', '2026-05-23T09:00:00+01:00', '2026-02-31T09:00:00', 5]) {
    assert.equal(parseWcGmtInstant(bad), null, String(bad))
  }
})
