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
let bindingValue = '2'
const fetchOptions: Array<Record<string, unknown> | undefined> = []
let orderRead: () => Response = () => new Response('{}', { status: 500 })

function modelProxy(name: string) {
  return new Proxy({}, {
    get: (_target, method: string) => async (args?: { where?: { key?: string }; data?: Record<string, unknown> }) => {
      calls.push(`${name}.${method}`)
      if (name === 'setting' && method === 'findMany') {
        const wanted = (args as { where?: { key?: { in?: string[] } } } | undefined)?.where?.key?.in ?? []
        return wanted.flatMap((key) => {
          if (key === 'wc_settings_version') return bindingChangedAt ? [{ key, value: bindingValue, updatedAt: bindingChangedAt }] : []
          return settings.has(key) ? [{ key, value: settings.get(key)!, updatedAt: T0 }] : []
        })
      }
      if (name === 'salesOrder' && method === 'findUnique') return { createdAt: orderCreatedAt, lines: imsLines }
      if (name === 'setting' && (method === 'findUnique' || method === 'findFirst')) {
        const key = args?.where?.key ?? ''
        if (key === 'wc_settings_version') return bindingChangedAt ? { key, value: bindingValue, updatedAt: bindingChangedAt } : null
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
  namedExports: { getSettingValues: settingValues, getSettingValue: async (key: string) => settings.get(key) ?? null, deserializeSettingValue: (_key: string, value: string) => value },
})
mock.module('@/lib/security/connector-fetch', {
  namedExports: {
    // The Woo transport double: EVERY request is recorded with its method; the order read is scripted; a live push is accepted.
    connectorFetch: async (url: string | URL, init?: { method?: string }, options?: Record<string, unknown>) => {
      const method = init?.method ?? 'GET'
      transport.push(`${method} ${String(url)}`)
      if (method === 'GET' && /\/wp-json\/wc\/v3\/orders\/555$/.test(String(url))) {
        fetchOptions.push(options)
        const answer = orderRead()
        // The real transport throws on a redirect when the caller refuses redirects, and otherwise follows it.
        if (answer.status >= 300 && answer.status < 400 && options?.refuseRedirects) throw new Error('WooCommerce answered with a redirect; redirects are refused for this request.')
        return answer
      }
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
  bindingValue = '2'
  fetchOptions.length = 0
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

async function sweep(parts: Part[], options: { verifier?: boolean; zoneless?: 'europe-london'; clock?: Date; lowerBound?: Date | null; shape?: 'split' | 'single' | 'merged' } = {}) {
  const { runWmsDispatchSweepCore, storefrontCutoffWhileEnforced } = await import('@/lib/domain/wms/dispatch-sweep')
  const { pushPartialShipmentToShopping } = await import('@/lib/shopping')
  const { verifyPreCutoverCompletionByFreshRead } = await import('@/lib/connectors/woocommerce/sync/pre-cutover-order-read')
  const applyOptions: Array<Record<string, unknown> | undefined> = []
  const asked: Array<string | null> = []
  const out = await runWmsDispatchSweepCore({
    ...(options.zoneless ? {
      zonelessDespatchReading: options.zoneless,
      ...(options.clock ? { clock: () => options.clock! } : {}),
      storefrontCutoff: () => storefrontCutoffWhileEnforced(),
      despatchLowerBound: async () => options.lowerBound ?? null,
    } : {}),
    listCandidates: async () => [{ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001' }],
    fetchOrderStatus: async () => ({
      externalOrderId: 'M-1', externalOrderNumber: 'WC-1001', status: 'DESPATCHED', statusLabel: 'Despatched',
      isSplit: options.shape !== 'single', partCount: parts.length,
      isMerged: options.shape === 'merged', mergedOrderNumbers: options.shape === 'merged' ? ['WC-1001'] : [], deepLinkUrl: null,
      tracking: options.shape === 'single' ? parts[0]!.tracking : [], dispatched: true, raw: null,
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

test('PIN: a rebind that lands WHILE the GET is in flight (after the credentials were pinned) makes the answer pending', async () => {
  // the new store answers perfectly, but the binding moved between the pin and the answer
  await expectPending('binding_changed', () => {
    orderRead = () => { bindingChangedAt = new Date('2026-09-01T00:00:00Z'); return wcOrder()() }
  })
  // the version VALUE moving is enough, even with the same write time
  reset()
  bindingChangedAt = T0
  orderRead = () => { bindingValue = '3'; return wcOrder()() }
  await withEnv(LIVE_AT_CUTOFF, async () => {
    const run = await sweep([part(1, PRE)])
    assert.equal(run.out.counters.dispatched, 0)
    assert.equal(codeOf(), 'binding_changed')
  })
  // a binding that does not move during the read verifies
  reset()
  bindingChangedAt = T0
  await withEnv(LIVE_AT_CUTOFF, async () => { assert.equal((await sweep([part(1, PRE)])).out.counters.dispatched, 1) })
})

test('REDIRECT: the read refuses redirects, and a redirected answer is pending (nothing followed, nothing written)', async () => {
  reset()
  await withEnv(LIVE_AT_CUTOFF, async () => {
    assert.equal((await sweep([part(1, PRE)])).out.counters.dispatched, 1)
    assert.deepEqual(fetchOptions.map((o) => o?.refuseRedirects), [true], 'the single GET asks the transport to refuse redirects')
  })
  for (const status of [301, 302, 307, 308]) {
    await expectPending('read_failed', () => { orderRead = () => new Response('', { status, headers: { location: 'https://elsewhere.example.net/wp-json/wc/v3/orders/555' } }) })
    assert.deepEqual(reads(), [ORDER_READ], 'only the original request was made')
  }
})

test('UNKNOWN DESPATCH TIME, PRE-CUTOVER: a part shadowed as pre-cutover whose tracking has an undated or invalid entry stays pending - the verifier is asked with an UNKNOWN time and no read is made', async () => {
  const tracked = (entries: Array<{ trackingNumber: string; carrier: string; despatchedAt?: string }>): Part => ({ ...part(1, PRE), tracking: entries as Part['tracking'] })
  const dated = { trackingNumber: 'TN-1', carrier: 'DPD', despatchedAt: PRE }
  for (const bad of [
    [dated, { trackingNumber: 'TN-2', carrier: 'DPD' }], // an undated entry beside a dated (pre-cutover) one
    [dated, { trackingNumber: 'TN-2', carrier: 'DPD', despatchedAt: 'not a date' }], // an invalid one
    [dated, { trackingNumber: 'TN-2', carrier: 'DPD', despatchedAt: '' }],
  ]) {
    reset()
    await withEnv(LIVE_AT_CUTOFF, async () => {
      const run = await sweep([tracked(bad), part(2, PRE2)])
      assert.equal(run.out.counters.dispatched, 0)
      assert.equal(run.out.counters.pending, 1)
      assert.deepEqual(run.applyOptions, [])
      assert.deepEqual(run.asked, [null], 'the verifier was asked, with no usable time')
      assert.deepEqual(transport, [], 'and nothing was read or written')
      assert.equal(activity.find((a) => a.action === 'pre_cutover_part_pending')?.metadata?.code, 'no_despatch_time')
    })
  }
  // the control: the same order with every entry dated verifies
  reset()
  await withEnv(LIVE_AT_CUTOFF, async () => {
    assert.equal((await sweep([tracked([dated, { trackingNumber: 'TN-2', carrier: 'DPD', despatchedAt: PRE2 }]), part(2, PRE2)])).out.counters.dispatched, 1)
  })
})

test('UNKNOWN DESPATCH TIME, NORMAL: an undated entry on an ordinary split order pushes exactly as before (a dated post-cutover entry decides, an all-undated part uses "now"), and with the switch off', async () => {
  const tracked = (n: number, entries: Array<{ trackingNumber: string; carrier: string; despatchedAt?: string }>): Part => ({ ...part(n, POST), tracking: entries as Part['tracking'] })
  for (const env of [LIVE_AT_CUTOFF, {}]) {
    reset()
    await withEnv(env, async () => {
      const run = await sweep([
        tracked(1, [{ trackingNumber: 'TN-1', carrier: 'DPD', despatchedAt: POST }, { trackingNumber: 'TN-2', carrier: 'DPD' }]),
        tracked(2, [{ trackingNumber: 'TN-3', carrier: 'DPD' }]),
      ])
      assert.equal(run.out.counters.dispatched, 1)
      assert.deepEqual(run.applyOptions, [undefined])
      assert.deepEqual(run.asked, [], 'no verification: nothing was shadowed as pre-cutover')
      assert.equal(writes().length, 2, 'both parts were pushed live, as on development')
      assert.deepEqual(reads(), [])
    })
  }
})

test('IMPRECISE DESPATCH DATES, PRE-CUTOVER: a date-only value on the cutoff day, or a datetime with no zone, never classifies a part as pre-cutover for verification: pending, no read, no flag', async () => {
  const MIDDAY_CUTOFF = { ...SEAM_ON, [PRODUCER_CUTOFF_ENV.woocommerce]: '2026-06-01T12:00:00Z' }
  const withDate = (n: number, at: string): Part => ({ ...part(n, at), tracking: [{ trackingNumber: `TN-${n}`, carrier: 'DPD', despatchedAt: at }] })
  // a date-only value is midnight UTC, hours BEFORE a cutoff at noon the same day: the push is shadowed as pre-cutover
  // (the real despatch may have been after the cutoff), and a completion earlier that day must not verify it
  reset()
  orderRead = wcOrder({ date_completed_gmt: '2026-06-01T06:00:00', date_modified_gmt: '2026-06-01T06:00:05' })
  await withEnv(MIDDAY_CUTOFF, async () => {
    const run = await sweep([withDate(1, '2026-06-01')])
    assert.equal(run.out.counters.dispatched, 0)
    assert.equal(run.out.counters.pending, 1)
    assert.deepEqual(run.applyOptions, [], 'storefrontAlreadyCompleted is not set (nothing applied)')
    assert.deepEqual(run.asked, [null], 'the verifier is asked with an UNKNOWN time')
    assert.deepEqual(transport, [], 'and nothing is read or written')
    assert.equal(activity.find((a) => a.action === 'pre_cutover_part_pending')?.metadata?.code, 'no_despatch_time')
  })
  for (const imprecise of ['2026-05-20', '2026-05-20T10:00:00', '2026-05-20 10:00:00', '2026-05-20T10:00', '2026-05-20T10:00:00.123']) {
    reset()
    await withEnv(LIVE_AT_CUTOFF, async () => {
      const run = await sweep([withDate(1, imprecise)])
      assert.equal(run.out.counters.dispatched, 0, imprecise)
      assert.deepEqual(run.applyOptions, [], imprecise)
      assert.deepEqual(transport, [], imprecise)
    })
  }
  // an unambiguous instant (Z, or an offset) verifies
  for (const precise of ['2026-05-20T10:00:00Z', '2026-05-20T11:00:00+01:00', '2026-05-20T11:00:00+0100', '2026-05-20 10:00:00z', '2026-05-20T10:00:00.1234567Z']) {
    reset()
    await withEnv(LIVE_AT_CUTOFF, async () => {
      const run = await sweep([withDate(1, precise)])
      assert.equal(run.out.counters.dispatched, 1, precise)
      assert.deepEqual(run.applyOptions, [{ storefrontAlreadyCompleted: true }], precise)
      assert.deepEqual(reads(), [ORDER_READ], precise)
    })
  }
})

test('IMPRECISE DESPATCH DATES, NORMAL: a date-only or zone-less value on an ordinary post-cutover split order pushes exactly as before', async () => {
  for (const loose of ['2026-07-01', '2026-07-01T10:00:00']) {
    reset()
    await withEnv(LIVE_AT_CUTOFF, async () => {
      const run = await sweep([{ ...part(1, POST), tracking: [{ trackingNumber: 'TN-1', carrier: 'DPD', despatchedAt: loose }] }])
      assert.equal(run.out.counters.dispatched, 1, loose)
      assert.deepEqual(run.applyOptions, [undefined])
      assert.equal(writes().length, 1)
      assert.deepEqual(run.asked, [])
    })
  }
})

test('preciseDespatchInstant: only a date AND time with Z or an offset; impossible values refused; offsets applied', async () => {
  const { preciseDespatchInstant, strictLatestDespatchTime } = await import('@/lib/domain/wms/dispatch-sweep')
  assert.equal(preciseDespatchInstant('2026-05-20T10:00:00Z')?.toISOString(), '2026-05-20T10:00:00.000Z')
  assert.equal(preciseDespatchInstant('2026-05-20T11:00:00+01:00')?.toISOString(), '2026-05-20T10:00:00.000Z')
  assert.equal(preciseDespatchInstant('2026-05-20T05:00:00-0500')?.toISOString(), '2026-05-20T10:00:00.000Z')
  assert.equal(preciseDespatchInstant('2026-05-20T10:00Z')?.toISOString(), '2026-05-20T10:00:00.000Z')
  for (const bad of [null, undefined, '', 'x', '2026-05-20', '2026-05-20T10:00:00', '2026-05-20 10:00', '2026-02-31T10:00:00Z', '2026-05-20T25:00:00Z', '2026-05-20T10:00:00+15:00', '2026-05-20T10:00:00+01:99']) {
    assert.equal(preciseDespatchInstant(bad), null, String(bad))
  }
  assert.equal(strictLatestDespatchTime([{ despatchedAt: PRE }, { despatchedAt: PRE2 }])?.toISOString(), new Date(PRE2).toISOString())
  assert.equal(strictLatestDespatchTime([{ despatchedAt: PRE }, { despatchedAt: '2026-05-21' }]), null)
  assert.equal(strictLatestDespatchTime([{ despatchedAt: PRE }, { despatchedAt: '2026-05-21T10:00:00' }]), null)
})

test('latestDespatchTime skips undated entries (as on development); strictLatestDespatchTime treats any as UNKNOWN', async () => {
  const { latestDespatchTime, strictLatestDespatchTime } = await import('@/lib/domain/wms/dispatch-sweep')
  assert.equal(latestDespatchTime([{ despatchedAt: PRE }, { despatchedAt: PRE2 }])?.toISOString(), new Date(PRE2).toISOString())
  assert.equal(latestDespatchTime([{ despatchedAt: PRE }, {}])?.toISOString(), new Date(PRE).toISOString())
  assert.equal(latestDespatchTime([{ despatchedAt: PRE }, { despatchedAt: 'x' }])?.toISOString(), new Date(PRE).toISOString())
  assert.equal(latestDespatchTime([{}]), null)
  assert.equal(latestDespatchTime([]), null)
  assert.equal(strictLatestDespatchTime([{ despatchedAt: PRE }, { despatchedAt: PRE2 }])?.toISOString(), new Date(PRE2).toISOString())
  for (const bad of [[{ despatchedAt: PRE }, {}], [{ despatchedAt: PRE }, { despatchedAt: 'x' }], [{ despatchedAt: PRE }, { despatchedAt: null }], [{}], []]) {
    assert.equal(strictLatestDespatchTime(bad), null)
  }
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

// ───────────────────────── zone-less Mintsoft despatch times read as UK time ─────────────────────────

test('UK TIME, END TO END: a pre-cutover part with a zone-less SUMMER value, after a Woo completion, verifies', async () => {
  reset()
  // 10:00 BST on 20 May is 09:00Z; the default order read completed at 2026-05-23T09:00Z, later, so it verifies
  await withEnv(LIVE_AT_CUTOFF, async () => {
    const run = await sweep([part(1, '2026-05-20T10:00:00')], { zoneless: 'europe-london' })
    assert.equal(run.out.counters.dispatched, 1)
    assert.deepEqual(run.applyOptions, [{ storefrontAlreadyCompleted: true }])
    assert.deepEqual(run.asked, ['2026-05-20T09:00:00.000Z'])
    assert.deepEqual(reads(), [ORDER_READ])
    assert.deepEqual(writes(), [])
  })
  // the same value with the reading off (any non-Mintsoft source) stays unknown: pending, no read
  reset()
  await withEnv(LIVE_AT_CUTOFF, async () => {
    const run = await sweep([part(1, '2026-05-20T10:00:00')])
    assert.equal(run.out.counters.dispatched, 0)
    assert.deepEqual(run.asked, [null], 'asked with an UNKNOWN despatch time, which reads nothing')
    assert.deepEqual(transport, [])
  })
})

test('UK TIME, END TO END: a zone-less value in the clock-change hour stays pending with no read or write', async () => {
  for (const at of ['2025-03-30T01:30:00', '2025-10-26T01:30:00', '2026-05-20']) {
    reset()
    await withEnv(LIVE_AT_CUTOFF, async () => {
      const run = await sweep([part(1, at)], { zoneless: 'europe-london' })
      assert.equal(run.out.counters.dispatched, 0, at)
      assert.deepEqual(run.asked, [null], at) // pre-cutover, but no exact instant to verify against: pending with no read
      assert.deepEqual(transport, [], at)
    })
  }
})

test('UK TIME, ORDINARY PUSH: the reading never touches the lenient push time', async () => {
  const { latestDespatchTime } = await import('@/lib/domain/wms/dispatch-sweep')
  assert.equal(latestDespatchTime([{ despatchedAt: '2026-07-15T09:00:00' }])?.getTime(), new Date('2026-07-15T09:00:00').getTime())
})

// ───────────────────────── the cutoff DISPOSITION reads zone-less Mintsoft times as UK time too ─────────────────────────

// Cutover 2026-06-01T00:00:00Z. London is on BST then: local 00:30 on 1 June is 23:30Z on 31 May (BEFORE), local 01:30 is 00:30Z (AFTER).
// A host-timezone parse would put 00:30 at 00:30Z on a UTC host (AFTER, a storefront write): the verdict must not depend on the host.
test('DISPOSITION: a zone-less Mintsoft time 30 minutes either side of the cutover is judged as UK time, whatever the host timezone', async () => {
  reset()
  orderRead = wcOrder({ date_completed_gmt: '2026-06-02T00:00:00', date_modified_gmt: '2026-06-02T00:00:05' })
  await withEnv(LIVE_AT_CUTOFF, async () => {
    // local 00:30 BST = 23:30Z on 31 May: before the cutover, so shadowed and VERIFIED by a read, never written
    const before = await sweep([part(1, '2026-06-01T00:30:00')], { zoneless: 'europe-london' })
    assert.equal(before.out.counters.dispatched, 1)
    assert.deepEqual(before.applyOptions, [{ storefrontAlreadyCompleted: true }])
    assert.deepEqual(before.asked, ['2026-05-31T23:30:00.000Z'])
    assert.deepEqual(writes(), [])
  })
  reset()
  await withEnv(LIVE_AT_CUTOFF, async () => {
    // local 01:30 BST = 00:30Z on 1 June: after the cutover, so pushed live as before, nothing read
    const after = await sweep([part(1, '2026-06-01T01:30:00')], { zoneless: 'europe-london' })
    assert.equal(after.out.counters.dispatched, 1)
    assert.deepEqual(after.applyOptions, [undefined])
    assert.equal(writes().length, 1)
    assert.deepEqual(reads(), [])
    assert.deepEqual(after.asked, [])
  })
})

test('DISPOSITION: a gap, ambiguous or date-only time next to the cutover stays pending, with no write and no read', async () => {
  const cases: Array<[string, string]> = [
    ['2026-03-29T01:30:00', '2026-03-29T01:00:00Z'], // does not exist locally
    ['2026-10-25T01:30:00', '2026-10-25T01:00:00Z'], // happens twice
    ['2026-06-01', '2026-06-01T00:00:00Z'], // date only
  ]
  for (const [at, cutoff] of cases) {
    reset()
    await withEnv({ ...SEAM_ON, [PRODUCER_CUTOFF_ENV.woocommerce]: cutoff }, async () => {
      const run = await sweep([part(1, at)], { zoneless: 'europe-london' })
      assert.equal(run.out.counters.dispatched, 0, at)
      assert.equal(run.out.counters.pending, 1, at)
      assert.deepEqual(writes(), [], at)
      assert.deepEqual(reads(), [], at)
      assert.deepEqual(run.asked, [], at)
    })
  }
})

test('DISPOSITION: without the reading (any non-Mintsoft source) the lenient time is used, as before', async () => {
  const { dispositionDespatchTime } = await import('@/lib/domain/wms/dispatch-sweep')
  assert.deepEqual(dispositionDespatchTime([{ despatchedAt: PRE }], undefined), { unknown: false, at: new Date(PRE) })
  assert.deepEqual(dispositionDespatchTime([{}], undefined), { unknown: false, at: null })
  assert.deepEqual(dispositionDespatchTime([{ despatchedAt: '2026-06-01' }], undefined), { unknown: false, at: new Date('2026-06-01') })
  assert.deepEqual(dispositionDespatchTime([{ despatchedAt: PRE }, {}], 'europe-london'), { unknown: false, at: new Date(PRE) })
  assert.deepEqual(dispositionDespatchTime([{}], 'europe-london'), { unknown: false, at: null })
  assert.deepEqual(dispositionDespatchTime([{ despatchedAt: PRE }, { despatchedAt: '2026-06-01' }], 'europe-london', new Date(CUTOFF)), { unknown: true })
  assert.deepEqual(dispositionDespatchTime([{ despatchedAt: PRE }, { despatchedAt: 'x' }], 'europe-london', new Date(CUTOFF)), { unknown: true })
  // no readable cutoff: nothing to judge against, the lenient time is used and nothing is held
  assert.deepEqual(dispositionDespatchTime([{ despatchedAt: 'x' }, { despatchedAt: '2026-06-01' }], 'europe-london', null), { unknown: false, at: new Date('2026-06-01') })
})

test('RANGE: a date-only or clock-change time is judged by every instant it could mean: clearly after is live, clearly before is pre-cutover, straddling is held', async () => {
  const run = async (at: string, cutoff: string) => {
    reset()
    return withEnv({ ...SEAM_ON, [PRODUCER_CUTOFF_ENV.woocommerce]: cutoff }, async () => {
      const out = await sweep([part(1, at)], { zoneless: 'europe-london' })
      return { out, writes: writes().length, reads: reads().length }
    })
  }
  // clearly AFTER the cutover (the day after): the ordinary live push, nothing read
  const after = await run('2026-06-02', CUTOFF)
  assert.deepEqual([after.out.out.counters.dispatched, after.writes, after.reads, after.out.asked], [1, 1, 0, []])
  assert.deepEqual(after.out.applyOptions, [undefined])
  // clearly BEFORE (the day before): pre-cutover, so verification is asked, but it needs an exact instant: pending, nothing written
  const before = await run('2026-05-31', CUTOFF)
  assert.deepEqual([before.out.out.counters.dispatched, before.writes, before.reads, before.out.asked], [0, 0, 0, [null]])
  // STRADDLES (the cutover day itself): pending, no write, no read, verification not even asked
  const same = await run('2026-06-01', CUTOFF)
  assert.deepEqual([same.out.out.counters.dispatched, same.writes, same.reads, same.out.asked], [0, 0, 0, []])
  // clock-change times far from the cutover are normal: after is live, before is pre-cutover and pending verification
  for (const at of ['2026-03-29T01:30:00', '2026-10-25T01:30:00']) {
    const live = await run(at, '2026-01-01T00:00:00Z')
    assert.deepEqual([live.out.out.counters.dispatched, live.writes, live.out.asked], [1, 1, []], at)
    const pre = await run(at, '2026-11-01T00:00:00Z')
    assert.deepEqual([pre.out.out.counters.dispatched, pre.writes, pre.reads, pre.out.asked], [0, 0, 0, [null]], at)
  }
  // next to the cutover they straddle: held
  for (const [at, cutoff] of [['2026-03-29T01:30:00', '2026-03-29T01:00:00Z'], ['2026-10-25T01:30:00', '2026-10-25T01:00:00Z'], ['2026-03-29T01:30:00', '2026-03-29T01:30:00Z']]) {
    const near = await run(at!, cutoff!)
    assert.deepEqual([near.out.out.counters.dispatched, near.writes, near.reads, near.out.asked], [0, 0, 0, []], at)
  }
  // an unreadable value is held too
  const bad = await run('2026-13-45', CUTOFF)
  assert.deepEqual([bad.out.out.counters.dispatched, bad.writes], [0, 0])
})

test('RANGE: despatchInstantRange spans the day, the hour either side of a clock change, or a single instant', async () => {
  const { despatchInstantRange } = await import('@/lib/domain/wms/dispatch-sweep')
  const iso = (v: string) => { const r = despatchInstantRange(v, 'europe-london'); return r && [r.from.toISOString(), r.to.toISOString()] }
  assert.deepEqual(iso('2026-07-15'), ['2026-07-14T23:00:00.000Z', '2026-07-15T22:59:59.999Z'])
  assert.deepEqual(iso('2026-01-15'), ['2026-01-15T00:00:00.000Z', '2026-01-15T23:59:59.999Z'])
  assert.deepEqual(iso('2026-03-29'), ['2026-03-29T00:00:00.000Z', '2026-03-29T22:59:59.999Z'])
  assert.deepEqual(iso('2026-03-29T01:30:00'), ['2026-03-29T00:30:00.000Z', '2026-03-29T01:30:00.000Z'])
  assert.deepEqual(iso('2026-10-25T01:30:00'), ['2026-10-25T00:30:00.000Z', '2026-10-25T01:30:00.000Z'])
  assert.deepEqual(iso('2026-07-15T09:00:00'), ['2026-07-15T08:00:00.000Z', '2026-07-15T08:00:00.000Z'])
  assert.deepEqual(iso('2026-07-15T09:00:00Z'), ['2026-07-15T09:00:00.000Z', '2026-07-15T09:00:00.000Z'])
  for (const bad of ['x', '2026-02-31', '2026-07-15T25:00:00', '']) assert.equal(despatchInstantRange(bad, 'europe-london'), null, bad)
})

test('ORDER LEVEL: a non-split or merged-split Mintsoft order is judged by the same range rule before it completes', async () => {
  const cases: Array<[string, string, string]> = [
    // [label, despatch value, expectation]: cutover 2026-06-01T00:00:00Z
    ['wholly after', '2026-06-02T09:00:00', 'completes'],
    ['wholly after, date only', '2026-06-02', 'completes'],
    ['straddling date-only', '2026-06-01', 'held'],
    ['unreadable', '2026-13-45', 'held'],
    ['wholly before', '2026-05-20T10:00:00', 'held'],
    ['wholly before, date only', '2026-05-31', 'held'],
    ['dated before 1996', '1943-06-01T09:00:00', 'held'],
  ]
  for (const shape of ['single', 'merged'] as const) {
    for (const [label, at, expected] of cases) {
      reset()
      await withEnv(LIVE_AT_CUTOFF, async () => {
        const run = await sweep([part(1, at)], { zoneless: 'europe-london', shape, verifier: false })
        const id = `${shape} ${label}`
        assert.equal(run.out.counters.dispatched, expected === 'completes' ? 1 : 0, id)
        assert.equal(run.applyOptions.length, expected === 'completes' ? 1 : 0, id)
        // never an order-level storefront write for a held order, and nothing is read
        if (expected === 'held') assert.deepEqual(writes(), [], id)
        assert.deepEqual(reads(), [], id)
      })
    }
  }
  // a source with no reading: as before
  reset()
  await withEnv(LIVE_AT_CUTOFF, async () => {
    const run = await sweep([part(1, '2026-05-20T10:00:00')], { shape: 'single', verifier: false })
    assert.equal(run.out.counters.dispatched, 1, 'a source with no reading is untouched')
  })
})

test('HISTORICAL: a zone-less value dated before 1996 is unknown (UK historical offsets are not modelled)', async () => {
  const { preciseDespatchInstant, despatchInstantRange, strictLatestDespatchTime } = await import('@/lib/domain/wms/dispatch-sweep')
  const reading = { zoneless: 'europe-london' } as const
  assert.equal(preciseDespatchInstant('1943-07-01T09:00:00', reading), null)
  assert.equal(preciseDespatchInstant('1995-12-31T23:00:00', reading), null)
  assert.equal(preciseDespatchInstant('1996-07-01T09:00:00', reading)?.toISOString(), '1996-07-01T08:00:00.000Z')
  assert.equal(despatchInstantRange('1943-07-01', 'europe-london'), null)
  assert.equal(despatchInstantRange('1943-07-01T09:00:00Z', 'europe-london'), null)
  assert.equal(strictLatestDespatchTime([{ despatchedAt: '1943-07-01T09:00:00' }], reading), null)
})

test('ORDER LEVEL, RACE: the decision is made once from the despatch range and carried into applyDispatch, whatever the clock says at enqueue', async () => {
  // The injected clock reads BEFORE the cutover at the guard, while the process clock (used when the job is enqueued) is long after it.
  const BEFORE_CUTOVER = new Date('2026-05-31T23:59:59Z')
  for (const shape of ['single', 'merged'] as const) {
    reset()
    await withEnv(LIVE_AT_CUTOFF, async () => {
      const wholly = await sweep([part(1, '2026-05-20T10:00:00')], { zoneless: 'europe-london', shape, verifier: false, clock: BEFORE_CUTOVER })
      assert.equal(wholly.out.counters.dispatched, 1, shape)
      assert.deepEqual(wholly.applyOptions, [{ storefrontAlreadyCompleted: true }], `${shape}: wholly-before before the cutover completes in IMS only`)
      assert.deepEqual(writes(), [], shape)
    })
    reset()
    await withEnv(LIVE_AT_CUTOFF, async () => {
      const after = await sweep([part(1, '2026-06-02T09:00:00')], { zoneless: 'europe-london', shape, verifier: false, clock: BEFORE_CUTOVER })
      assert.deepEqual(after.applyOptions, [undefined], `${shape}: wholly-after completes normally`)
      const straddle = await sweep([part(1, '2026-06-01')], { zoneless: 'europe-london', shape, verifier: false, clock: BEFORE_CUTOVER })
      assert.equal(straddle.out.counters.dispatched, 0, `${shape}: a straddling value is held`)
    })
    // at or after the cutover the same wholly-before despatch is held
    reset()
    await withEnv(LIVE_AT_CUTOFF, async () => {
      const held = await sweep([part(1, '2026-05-20T10:00:00')], { zoneless: 'europe-london', shape, verifier: false, clock: new Date(CUTOFF) })
      assert.equal(held.out.counters.dispatched, 0, shape)
      assert.deepEqual(held.applyOptions, [], shape)
    })
  }
})

test('ORDER LEVEL, CUTOFF STATE: no cutoff holds nothing; a future cutoff holds only what could be after it; a past cutoff is covered above', async () => {
  const sweepAt = async (cutoff: string | undefined, at: string) => {
    reset()
    return withEnv(cutoff === undefined ? SEAM_ON : { ...SEAM_ON, [PRODUCER_CUTOFF_ENV.woocommerce]: cutoff }, () =>
      sweep([part(1, at)], { zoneless: 'europe-london', shape: 'single', verifier: false }))
  }
  // no cutoff configured: the existing shadowed path, nothing is held, even for an unreadable or date-only value
  for (const at of ['2026-06-01', '2026-13-45', '2026-05-20T10:00:00']) {
    const run = await sweepAt(undefined, at)
    assert.equal(run.out.counters.dispatched, 1, `no cutoff ${at}`)
    assert.deepEqual(run.applyOptions, [undefined], `no cutoff ${at}`)
  }
  // a FUTURE cutoff: wholly before completes in IMS only, wholly after is normal, a straddling or unreadable value is held
  const FUTURE = '2099-06-01T00:00:00Z'
  const before = await sweepAt(FUTURE, '2026-05-20T10:00:00')
  assert.deepEqual([before.out.counters.dispatched, before.applyOptions], [1, [{ storefrontAlreadyCompleted: true }]])
  const after = await sweepAt(FUTURE, '2099-06-02T09:00:00')
  assert.deepEqual([after.out.counters.dispatched, after.applyOptions], [1, [undefined]])
  for (const at of ['2099-06-01', '2026-13-45']) {
    const held = await sweepAt(FUTURE, at)
    assert.deepEqual([held.out.counters.dispatched, held.applyOptions], [0, []], at)
  }
})

test('ENFORCEMENT OFF: the legacy path is exactly as on development, with a future or past cutoff: no flag and no hold', async () => {
  for (const cutoff of [CUTOFF, '2099-06-01T00:00:00Z']) {
    for (const [at, shape] of [['2026-05-20T10:00:00', 'single'], ['2026-06-01', 'single'], ['2026-13-45', 'single'], ['2026-05-20T10:00:00', 'merged'], ['', 'single']] as const) {
      reset()
      await withEnv({ [PRODUCER_CUTOFF_ENV.woocommerce]: cutoff }, async () => {
        const run = await sweep([part(1, at)], { zoneless: 'europe-london', shape, verifier: false })
        assert.equal(run.out.counters.dispatched, 1, `${cutoff} ${shape} ${at}`)
        assert.deepEqual(run.applyOptions, [undefined], `${cutoff} ${shape} ${at}`)
      })
    }
  }
  // enforcement for another destination only is also off for WooCommerce
  reset()
  await withEnv({ [PRODUCER_HOLD_ENFORCED_ENV]: 'xero', [PRODUCER_CUTOFF_ENV.woocommerce]: CUTOFF }, async () => {
    const run = await sweep([part(1, '2026-05-20T10:00:00')], { zoneless: 'europe-london', shape: 'single', verifier: false })
    assert.deepEqual(run.applyOptions, [undefined])
  })
})

test('UNDATED: no usable despatch time is live only when IMS sent the order at or after the cutover; otherwise it is held (never judged by reconcile time)', async () => {
  const AFTER_SENT = new Date('2026-06-02T00:00:00Z')
  const BEFORE_SENT = new Date('2026-05-01T00:00:00Z')
  const undated = (n: number): Part => ({ ...part(n, PRE), tracking: [{ trackingNumber: `TN-${n}`, carrier: 'DPD', despatchedAt: '' }] })
  for (const shape of ['single', 'merged'] as const) {
    reset()
    await withEnv(LIVE_AT_CUTOFF, async () => {
      const live = await sweep([undated(1)], { zoneless: 'europe-london', shape, verifier: false, lowerBound: AFTER_SENT })
      assert.deepEqual([live.out.counters.dispatched, live.applyOptions], [1, [undefined]], `${shape}: sent after the cutover goes live`)
      for (const lowerBound of [BEFORE_SENT, null]) {
        const held = await sweep([undated(1)], { zoneless: 'europe-london', shape, verifier: false, lowerBound })
        assert.deepEqual([held.out.counters.dispatched, held.applyOptions], [0, []], `${shape}: sent before the cutover (or unknown) is held`)
      }
    })
  }
  // a SPLIT part: sent after the cutover is pushed live (one write); sent before is held with no write and no read
  reset()
  await withEnv(LIVE_AT_CUTOFF, async () => {
    const live = await sweep([undated(1)], { zoneless: 'europe-london', verifier: false, lowerBound: AFTER_SENT })
    assert.equal(live.out.counters.dispatched, 1)
    assert.equal(writes().length, 1)
  })
  for (const lowerBound of [BEFORE_SENT, null]) {
    reset()
    await withEnv(LIVE_AT_CUTOFF, async () => {
      const held = await sweep([undated(1)], { zoneless: 'europe-london', lowerBound })
      assert.equal(held.out.counters.dispatched, 0)
      assert.deepEqual(writes(), [])
      assert.deepEqual(reads(), [])
      assert.deepEqual(held.asked, [])
    })
  }
})

test('LOWER BOUND: built from the immutable first claim and the order creation, never pushedAt (an amendment attempt moves that)', async () => {
  const { despatchLowerBoundOf } = await import('@/lib/domain/wms/dispatch-sweep')
  const created = new Date('2026-04-01T00:00:00Z')
  const firstClaimed = new Date('2026-04-02T00:00:00Z')
  const amendedAfterCutover = new Date('2026-06-05T00:00:00Z')
  // a link first created BEFORE the cutover, amended after it: the bound is the first claim, not the amendment
  const amended = { claimHistoryTracked: true, firstClaimedAt: firstClaimed, pushedAt: amendedAfterCutover, order: { createdAt: created } }
  assert.equal(despatchLowerBoundOf(amended as never)?.toISOString(), firstClaimed.toISOString())
  // first created AFTER the cutover: the bound is after it
  const late = new Date('2026-06-03T00:00:00Z')
  assert.equal(despatchLowerBoundOf({ claimHistoryTracked: true, firstClaimedAt: late, order: { createdAt: created } })?.toISOString(), late.toISOString())
  // an untracked link's firstClaimedAt is not trusted; the order's creation still bounds it
  assert.equal(despatchLowerBoundOf({ claimHistoryTracked: false, firstClaimedAt: late, order: { createdAt: created } })?.toISOString(), created.toISOString())
  assert.equal(despatchLowerBoundOf(null), null)
  assert.equal(despatchLowerBoundOf({ order: null }), null)

  // end to end through the sweep: pre-cutover undated despatch with a post-cutover amendment stays held; a link first created after is live
  const undated: Part = { ...part(1, PRE), tracking: [{ trackingNumber: 'TN-1', carrier: 'DPD', despatchedAt: '' }] }
  for (const shape of ['single', 'merged', 'split'] as const) {
    reset()
    await withEnv(LIVE_AT_CUTOFF, async () => {
      const held = await sweep([undated], { zoneless: 'europe-london', shape, verifier: false, lowerBound: despatchLowerBoundOf(amended as never) })
      assert.equal(held.out.counters.dispatched, 0, shape)
      assert.deepEqual(writes(), [], shape)
    })
    reset()
    await withEnv(LIVE_AT_CUTOFF, async () => {
      const live = await sweep([undated], { zoneless: 'europe-london', shape, verifier: false, lowerBound: despatchLowerBoundOf({ claimHistoryTracked: true, firstClaimedAt: late, order: { createdAt: created } }) })
      assert.equal(live.out.counters.dispatched, 1, shape)
    })
  }
})
