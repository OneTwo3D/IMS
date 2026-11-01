import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { OUTBOUND_GRANT_ENV } from '@/lib/security/outbound-write-hold-constants'
import { PRODUCER_CUTOFF_ENV, PRODUCER_HOLD_ENFORCED_ENV } from '@/lib/security/producer-disposition-constants'

/**
 * PRE-CUTOVER RECONCILIATION OF A SPLIT ORDER'S PARTS, ACROSS THE LIVE-FROM INSTANT.
 *
 * A part despatched BEFORE the WooCommerce live-from instant belongs to the writer that owned the store then, so IMS's own
 * partial-shipment push for it is shadowed for ever (reason `obligation_before_cutoff`). The dispatch sweep used to read that
 * shadow as "not finished", so a split order with a pre-cutover part never completed in IMS after cutover. It now VERIFIES the
 * incumbent's record from what IMS already holds locally and completes the IMS side WITHOUT a new storefront write.
 *
 * The push path is the REAL facade over the REAL producer seam with the transport as a COUNTER (so "no storefront write" is an
 * observed zero and the live arm observes one). The local verification is a double (its own reader is tested in
 * tests/connectors/woocommerce-incumbent-partial-shipment.test.ts). Nothing here reaches a network.
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

// ───────────────────────── a recording database that answers "nothing here" ─────────────────────────

const calls: string[] = []
const shadows: Array<{ operation: string; subjectType: string; subjectId: string }> = []
const settings = new Map<string, string>()
const transport: string[] = []

function modelProxy(name: string) {
  return new Proxy({}, {
    get: (_target, method: string) => async (args?: { where?: { key?: string }; data?: Record<string, unknown> }) => {
      calls.push(`${name}.${method}`)
      if (name === 'setting' && (method === 'findUnique' || method === 'findFirst')) {
        const key = args?.where?.key ?? ''
        return settings.has(key) ? { key, value: settings.get(key) } : null
      }
      switch (method) {
        case 'findMany': return []
        case 'findUnique': case 'findFirst': return name === 'shoppingOrderLink' ? { externalOrderId: '555' } : null
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
        const values = query.values ?? []
        shadows.push({ operation: String(values[1]), subjectType: String(values[2]), subjectId: String(values[3]) })
        return [{ id: `shadow-${shadows.length}`, inserted: true, occurrences: 1, accounting_sync_log_id: null, sync_row_exists: false }]
      }
    }
    if (prop === '$executeRaw') return async () => 1
    if (prop === '$executeRawUnsafe') return undefined
    if (prop === '$transaction') return async (fn: (tx: object) => unknown) => fn(fakeDb)
    return modelProxy(prop)
  },
})

mock.module('@/lib/db', { namedExports: { db: fakeDb } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => undefined, logActivityPersisted: async () => true } })
mock.module('@/lib/integration-plugins', {
  namedExports: { getIntegrationPluginState: async () => ({ woocommerce: true }), isIntegrationPluginEnabled: async () => true },
})
const settingValues = async (keys: string[]) => new Map(keys.flatMap((key) => (settings.has(key) ? [[key, settings.get(key)!] as const] : [])))
mock.module('@/lib/settings-store', {
  namedExports: { getSettingValues: settingValues, getSettingValue: async (key: string) => settings.get(key) ?? null },
})
mock.module('@/lib/security/connector-fetch', {
  namedExports: {
    // The counter at the transport boundary. It answers with a refusal-shaped 500 so nothing downstream parses a body.
    connectorFetch: async (url: string, init?: { method?: string }) => {
      transport.push(`${init?.method ?? 'GET'} ${url}`)
      return new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } })
    },
  },
})

function reset() {
  calls.length = 0
  shadows.length = 0
  transport.length = 0
  settings.clear()
  for (const [key, value] of Object.entries({
    wc_url: ORIGIN, wc_consumer_key: 'ck_x', wc_consumer_secret: 'cs_x', wc_webhook_secret: 's', wc_fx_push_enabled: 'true',
    wc_stock_sync_enabled: 'true',
  })) settings.set(key, value)
}
const writes = () => transport.filter((entry) => !entry.startsWith('GET '))

// ───────────────────────── the sweep, with the REAL push facade ─────────────────────────

const CUTOFF = '2026-06-01T00:00:00Z'
const PRE = '2026-05-20T10:00:00Z' // before the cutoff
const PRE2 = '2026-05-22T10:00:00Z' // also before the cutoff, later than PRE
const PRE2_ISO = new Date(PRE2).toISOString()
const POST = '2026-07-01T10:00:00Z' // after the cutoff (and before now)

type Part = { externalId: string; partNumber: number; status: string; dispatched: boolean; tracking: Array<{ trackingNumber: string; carrier: string; despatchedAt: string }> }
const part = (n: number, at: string): Part => ({ externalId: `M-${n}`, partNumber: n, status: 'DESPATCHED', dispatched: true, tracking: [{ trackingNumber: `TN-${n}`, carrier: 'DPD', despatchedAt: at }] })

async function sweep(parts: Part[], verify: unknown) {
  const { runWmsDispatchSweepCore } = await import('@/lib/domain/wms/dispatch-sweep')
  const { pushPartialShipmentToShopping } = await import('@/lib/shopping')
  const verified: Array<{ part: number; despatchedAt: string | null }> = []
  const pushes: number[] = []
  let applied = 0
  const applyOptions: Array<Record<string, unknown> | undefined> = []
  const recorded: string[] = []
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
    applyDispatch: async (_orderId: string, _tracking: unknown, options?: Record<string, unknown>) => { applied += 1; applyOptions.push(options); return { success: true } },
    pushPartialShipment: async (orderId: string, input: { part: number; totalParts: number; items: Array<{ sku: string; qty: number }>; despatchedAt?: Date | null }) => {
      pushes.push(input.part)
      const result = await pushPartialShipmentToShopping(orderId, input as never)
      return { ok: result.success, error: result.error, ...(result.shadowed === true ? { shadowed: true } : {}), ...(result.shadowReason ? { shadowReason: result.shadowReason } : {}) }
    },
    recordDispatchError: async (_c: unknown, reason: string) => { recorded.push(reason); return { deadLettered: false } },
    ...(verify ? { verifyIncumbentPartialShipment: async (_orderId: string, input: { part: number; despatchedAt: Date | null }) => {
      verified.push({ part: input.part, despatchedAt: input.despatchedAt?.toISOString() ?? null })
      return (verify as (n: number) => { verified: boolean; detail: string })(input.part)
    } } : {}),
  } as never)
  return { out, applied, applyOptions, pushes, verified, recorded }
}

const LIVE_AT_CUTOFF = { ...SEAM_ON, [PRODUCER_CUTOFF_ENV.woocommerce]: CUTOFF }
const yes = () => ({ verified: true, detail: 'the stored WooCommerce order delivery shows status "partial-shipped"' })
const no = () => ({ verified: false, detail: 'no stored WooCommerce order delivery for this order' })

test('AFTER the cutoff: an all-pre-cutover split order whose incumbent record verifies COMPLETES in IMS with NO storefront write', async () => {
  reset()
  await withEnv(LIVE_AT_CUTOFF, async () => {
    const run = await sweep([part(1, PRE), part(2, PRE2)], yes)
    console.log(`# pre-cutover verified: counters=${JSON.stringify(run.out.counters)} verified=${JSON.stringify(run.verified)} applied=${run.applied} writes=${JSON.stringify(writes())} shadows=${shadows.length}`)
    assert.equal(run.applied, 1, 'THE FINDING: applyDispatch never ran for a pre-cutover split order')
    assert.equal(run.out.counters.dispatched, 1)
    assert.deepEqual(run.verified.map((v) => v.part), [1, 2])
    assert.deepEqual(run.verified.map((v) => v.despatchedAt), [PRE2_ISO, PRE2_ISO], 'every part is asked against the LATEST despatch among the order\'s parts, not its own')
    assert.deepEqual(run.applyOptions, [{ storefrontAlreadyCompleted: true }], 'and the dispatch is applied as "the storefront already holds this": no completion job, no storefront push')
    assert.deepEqual(writes(), [], 'and no write reached the storefront: the incumbent already recorded these parts')
    assert.deepEqual(run.recorded, [])
  })
})

test('AFTER the cutoff: an UNVERIFIED pre-cutover part (or a sweep with no verifier) keeps the order pending, exactly as before', async () => {
  reset()
  await withEnv(LIVE_AT_CUTOFF, async () => {
    const unverified = await sweep([part(1, PRE)], no)
    assert.equal(unverified.applied, 0)
    assert.equal(unverified.out.counters.pending, 1)
    assert.equal(unverified.out.counters.errors, 0)
    assert.deepEqual(unverified.recorded, [], 'no failure streak, however long it stays unverified')
    const noVerifier = await sweep([part(1, PRE)], null)
    assert.equal(noVerifier.applied, 0)
    assert.equal(noVerifier.out.counters.pending, 1)
    // one verified part and one that is not: the order is not completed off a part nobody can vouch for
    const mixed = await sweep([part(1, PRE), part(2, PRE)], (n: number) => (n === 1 ? yes() : no()))
    assert.equal(mixed.applied, 0)
  })
})

test('AFTER the cutoff: a split order with one PRE-cutover part (verified, not written) and one POST-cutover part (live push) reaches the storefront once, for the live part only', async () => {
  reset()
  await withEnv(LIVE_AT_CUTOFF, async () => {
    const run = await sweep([part(1, PRE), part(2, POST)], yes)
    console.log(`# mixed: pushes=${JSON.stringify(run.pushes)} verified=${JSON.stringify(run.verified)} writes=${JSON.stringify(writes())} applied=${run.applied} counters=${JSON.stringify(run.out.counters)}`)
    assert.deepEqual(run.verified.map((v) => v.part), [1], 'only the pre-cutover part is verified')
    assert.equal(writes().length, 1, 'CONTROL: the live part DOES reach the transport (the rig can see a write)')
    assert.match(writes()[0]!, /partial-shipment/)
    assert.equal(shadows.filter((s) => s.operation === 'order.partial-shipment').length, 1, 'one shadow: the pre-cutover part')
    assert.deepEqual(run.applyOptions.filter((o) => o?.storefrontAlreadyCompleted === true), [], 'a part pushed live means the normal storefront completion stays')
  })
})

test('BEFORE the cutoff (cutoff in the future): the same part is shadowed for a DIFFERENT reason, the verifier is NOT consulted, the order stays pending', async () => {
  reset()
  await withEnv({ ...SEAM_ON, [PRODUCER_CUTOFF_ENV.woocommerce]: '2099-01-01T00:00:00Z' }, async () => {
    const run = await sweep([part(1, PRE)], yes)
    assert.deepEqual(run.verified, [], 'before the live-from instant the incumbent still owns the store: nothing to reconcile yet')
    assert.equal(run.applied, 0)
    assert.equal(run.out.counters.pending, 1)
    assert.deepEqual(writes(), [])
  })
  // and with no grant at all
  reset()
  await withEnv({ [PRODUCER_HOLD_ENFORCED_ENV]: 'woocommerce', [PRODUCER_CUTOFF_ENV.woocommerce]: CUTOFF }, async () => {
    const run = await sweep([part(1, PRE)], yes)
    assert.deepEqual(run.verified, [])
    assert.equal(run.applied, 0)
  })
})

test('THE TRANSITION: the same order is pending before the cutoff instant passes and completes after it', async () => {
  reset()
  const before = await withEnv({ ...SEAM_ON, [PRODUCER_CUTOFF_ENV.woocommerce]: '2099-01-01T00:00:00Z' }, () => sweep([part(1, PRE)], yes))
  const after = await withEnv(LIVE_AT_CUTOFF, () => sweep([part(1, PRE)], yes))
  assert.deepEqual([before.applied, after.applied], [0, 1])
})

test('a seam with the switch OFF is untouched: the push reaches the storefront and no verification happens', async () => {
  reset()
  await withEnv({}, async () => {
    const run = await sweep([part(1, PRE)], yes)
    assert.deepEqual(run.verified, [])
    assert.equal(writes().length, 1)
  })
})

// ───────────────────────── the evidence rule, end to end through the sweep ─────────────────────────

test('EVIDENCE: partial-shipped never vouches; completed must be received after the LATEST part\'s despatch; completed after the last part verifies', async () => {
  const { classifyStoredWcOrderDelivery } = await import('@/lib/connectors/woocommerce/sync/incumbent-partial-shipment')
  const run = async (delivery: { status: string; receivedAt: Date }) => {
    reset()
    return withEnv(LIVE_AT_CUTOFF, async () => {
      const seen: Array<Date | null> = []
      // drive the same sweep with the real classifier as the verifier
      const { runWmsDispatchSweepCore } = await import('@/lib/domain/wms/dispatch-sweep')
      const { pushPartialShipmentToShopping } = await import('@/lib/shopping')
      let applied = 0
      const result = await runWmsDispatchSweepCore({
        listCandidates: async () => [{ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001' }],
        fetchOrderStatus: async () => ({ externalOrderId: 'M-1', externalOrderNumber: 'WC-1001', status: 'DESPATCHED', statusLabel: 'Despatched', isSplit: true, partCount: 2, isMerged: false, mergedOrderNumbers: [], deepLinkUrl: null, tracking: [], dispatched: true, raw: null }),
        partsSupported: true,
        fetchOrderParts: async () => [part(1, PRE), part(2, PRE2)],
        fetchPartItems: async () => [{ sku: 'A', qty: 1 }],
        repointLink: async () => {}, clearDispatchFailures: async () => {},
        countLinksByOrderNumber: async (numbers: string[]) => new Map(numbers.map((n) => [n, 1])),
        applyDispatch: async () => { applied += 1; return { success: true } },
        pushPartialShipment: async (orderId: string, input: never) => {
          const r = await pushPartialShipmentToShopping(orderId, input)
          return { ok: r.success, error: r.error, ...(r.shadowed === true ? { shadowed: true } : {}), ...(r.shadowReason ? { shadowReason: r.shadowReason } : {}) }
        },
        recordDispatchError: async () => ({ deadLettered: false }),
        verifyIncumbentPartialShipment: async (_o: string, input: { despatchedAt: Date | null }) => { seen.push(input.despatchedAt); return classifyStoredWcOrderDelivery(delivery, input.despatchedAt) },
      } as never)
      return { applied, seen, counters: result.counters }
    })
  }
  const partial = await run({ status: 'partial-shipped', receivedAt: new Date('2026-05-25T00:00:00Z') })
  assert.equal(partial.applied, 0, 'partial-shipped reflects at most the first part: the order stays pending')
  assert.equal(partial.counters.pending, 1)
  assert.ok(partial.seen.length > 0, 'PRECONDITION: the verifier was reached')
  const early = await run({ status: 'completed', receivedAt: new Date('2026-05-21T00:00:00Z') }) // after part 1, BEFORE part 2 (05-22)
  assert.equal(early.applied, 0, 'a completed delivery received before the second part despatched cannot vouch for it')
  assert.deepEqual(early.seen.map((d) => d?.toISOString()), [PRE2_ISO])
  const full = await run({ status: 'completed', receivedAt: new Date('2026-05-23T00:00:00Z') })
  assert.equal(full.applied, 1, 'completed after the last part verifies')
})

test('MIXED order (one part verified pre-cutover, one pushed live and accepted): applied WITHOUT the "storefront already holds it" flag, so the normal completion stays', async () => {
  const { runWmsDispatchSweepCore } = await import('@/lib/domain/wms/dispatch-sweep')
  const optionsSeen: Array<Record<string, unknown> | undefined> = []
  const out = await runWmsDispatchSweepCore({
    listCandidates: async () => [{ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001' }],
    fetchOrderStatus: async () => ({ externalOrderId: 'M-1', externalOrderNumber: 'WC-1001', status: 'DESPATCHED', statusLabel: 'Despatched', isSplit: true, partCount: 2, isMerged: false, mergedOrderNumbers: [], deepLinkUrl: null, tracking: [], dispatched: true, raw: null }),
    partsSupported: true,
    fetchOrderParts: async () => [part(1, PRE), part(2, POST)],
    fetchPartItems: async () => [{ sku: 'A', qty: 1 }],
    repointLink: async () => {}, clearDispatchFailures: async () => {},
    countLinksByOrderNumber: async (numbers: string[]) => new Map(numbers.map((n) => [n, 1])),
    applyDispatch: async (_o: string, _t: unknown, options?: Record<string, unknown>) => { optionsSeen.push(options); return { success: true } },
    pushPartialShipment: async (_o: string, input: { part: number }) => (input.part === 1 ? { ok: false, shadowed: true, shadowReason: 'obligation_before_cutoff', error: 'held' } : { ok: true }),
    recordDispatchError: async () => ({ deadLettered: false }),
    verifyIncumbentPartialShipment: async () => ({ verified: true, detail: 'ok' }),
  } as never)
  assert.equal(out.counters.dispatched, 1, 'PRECONDITION: the order completed')
  assert.deepEqual(optionsSeen, [undefined])
})
