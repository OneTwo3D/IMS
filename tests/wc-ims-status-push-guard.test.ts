import assert from 'node:assert/strict'
import net from 'node:net'
import test, { beforeEach, mock } from 'node:test'

/**
 * o3d-6ldlj — the connector half of "an IMS cancel / hold reaches the WooCommerce order": `pushImsStatusToWc`
 * for CANCELLED / ON_HOLD. It used to have NO guard at all (DEFECT A): a failed GET was ignored and the PUT went
 * out BLIND, and an IMS cancel PUT `cancelled` over a WooCommerce order that was completed or refunded.
 *
 * Doubles: the WooCommerce REST edge (`wcFetch`/`wcPut`: counted, never a socket), the database rows the push
 * reads/writes, and the activity log. The importer's reading (readWcOrderStatus) and the classifier are the REAL
 * ones, over a mapping table the tests control.
 */

type Row = Record<string, unknown>

const state = {
  wcStatus: 'processing' as string | undefined,
  fetchError: undefined as string | undefined,
  fetches: [] as string[],
  puts: [] as Array<{ path: string; body: Row }>,
  putError: undefined as string | undefined,
  syncLogs: [] as Row[],
  activity: [] as Row[],
  linked: true,
  mappings: [] as Array<{ externalStatus: string; imsStatus: string }>,
  fetchThrows: false,
}

mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async (entry: Row) => { state.activity.push(entry) } },
})
mock.module('@/lib/db', {
  namedExports: {
    db: {
      salesOrder: {
        findUnique: async () => ({
          externalOrderNumber: 'WC-1001',
          trackingNumber: null,
          shippingService: null,
          shoppingLinks: state.linked ? [{ externalOrderId: '1001', externalOrderNumber: '1001' }] : [],
        }),
      },
      shoppingStatusMapping: { findMany: async () => state.mappings },
      setting: { findMany: async () => [] },
      shoppingSyncLog: {
        create: async ({ data }: { data: Row }) => { state.syncLogs.push(data); return data },
      },
    },
  },
})
mock.module('@/lib/connectors/woocommerce/api', {
  namedExports: {
    wcFetch: async (path: string) => {
      state.fetches.push(path)
      if (state.fetchThrows) throw new Error('socket hang up')
      if (state.fetchError) return { data: null, totalPages: 0, totalItems: 0, error: state.fetchError }
      return { data: { status: state.wcStatus }, totalPages: 1, totalItems: 1 }
    },
    wcPut: async (path: string, body: Row) => {
      state.puts.push({ path, body })
      if (state.putError) return { data: null, error: state.putError }
      return { data: { status: body.status, date_modified_gmt: '2026-10-04T10:00:05' } }
    },
  },
})

beforeEach(() => {
  state.wcStatus = 'processing'
  state.fetchError = undefined
  state.fetches.length = 0
  state.puts.length = 0
  state.putError = undefined
  state.syncLogs.length = 0
  state.activity.length = 0
  state.linked = true
  state.mappings = []
  state.fetchThrows = false
})

async function push(status: 'CANCELLED' | 'ON_HOLD') {
  const { pushImsStatusToWc } = await import('@/lib/connectors/woocommerce/sync/order-status')
  return pushImsStatusToWc('so-1', status)
}

test('o3d-6ldlj (trap): the repo outbound-network trap is installed in this run, with a LOCAL control that really connects', async () => {
  // Every test in this file reaches WooCommerce only through the counting doubles above. This proves the
  // belt-and-braces trap (tests/no-outbound-network.cjs, loaded by the npm scripts) is live in THIS process, so a
  // forgotten double would fail rather than reach the live store. The control is a listener WE start on loopback.
  const server = net.createServer((socket) => socket.end())
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as net.AddressInfo).port
  try {
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => { socket.end(); resolve() })
      socket.on('error', reject)
    })
    let refused: unknown = null
    await new Promise<void>((resolve) => {
      const socket = net.connect(443, '203.0.113.7') // TEST-NET-3: never routable, refused before any connect
      socket.on('error', (error) => { refused = error; resolve() })
      socket.on('connect', () => { socket.destroy(); resolve() })
    })
    assert.equal((refused as Error | null)?.name, 'OutboundNetworkBlockedError', 'a non-loopback connect is refused by the trap')
  } finally {
    server.close()
  }
})

test('o3d-6ldlj (a): a PROCESSING order is cancelled / held with one PUT each', async () => {
  const cancel = await push('CANCELLED')
  assert.equal(state.fetches.length, 1, 'precondition: WooCommerce was asked what state the order is in')
  assert.deepEqual(cancel, { kind: 'pushed' })
  assert.deepEqual(state.puts, [{ path: '/orders/1001', body: { status: 'cancelled' } }])

  state.fetches.length = 0
  state.puts.length = 0
  const hold = await push('ON_HOLD')
  assert.equal(state.fetches.length, 1)
  assert.deepEqual(hold, { kind: 'pushed' })
  assert.deepEqual(state.puts, [{ path: '/orders/1001', body: { status: 'on-hold' } }])
})

test('o3d-6ldlj (b, DEFECT A): an UNREADABLE WooCommerce status sends NO PUT and is a read-failure to retry', async () => {
  let evaluated = 0
  for (const status of ['CANCELLED', 'ON_HOLD'] as const) {
    state.puts.length = 0
    state.fetches.length = 0
    state.activity.length = 0
    state.fetchError = 'HTTP 503'
    const outcome = await push(status)
    assert.equal(state.fetches.length, 1, `${status}: precondition — the read was attempted and failed`)
    assert.deepEqual(outcome, { kind: 'read-failed', error: 'HTTP 503' }, status)
    assert.deepEqual(state.puts, [], `${status}: the blind PUT is closed`)
    const skipped = state.activity.filter((a) => a.action === 'wc_status_push_skipped')
    assert.equal(skipped.length, 1, status)
    assert.equal(skipped[0].level, 'WARNING')
    assert.match(String(skipped[0].description), /this attempt sent nothing/, `${status}: true here, because the read failed before any PUT (puts asserted 0 above)`)
    evaluated++
  }
  assert.equal(evaluated, 2)
})

test('o3d-6ldlj (b2): a THROWING WooCommerce read is an error and sends no PUT', async () => {
  state.fetchThrows = true
  const outcome = await push('CANCELLED')
  assert.equal(state.fetches.length, 1, 'precondition: the throwing double was reached')
  assert.deepEqual(outcome, { kind: 'error', error: 'socket hang up' })
  assert.deepEqual(state.puts, [])
})

test('o3d-6ldlj (c): a COMPLETED or REFUNDED order is never overwritten by a cancel or hold, even mapped to an in-flight status', async () => {
  let evaluated = 0
  for (const status of ['CANCELLED', 'ON_HOLD'] as const) {
    for (const slug of ['completed', 'refunded']) {
      for (const mapping of [null, 'PROCESSING', 'PACKING'] as const) {
        state.puts.length = 0
        state.fetches.length = 0
        state.wcStatus = slug
        state.mappings = mapping ? [{ externalStatus: slug, imsStatus: mapping }] : []
        const outcome = await push(status)
        assert.equal(state.fetches.length, 1, `${status}/${slug}/${mapping}: precondition — the status was read`)
        assert.deepEqual(outcome, { kind: 'ineligible', wcStatus: slug, class: 'finalised' }, `${status}/${slug}/${mapping}`)
        assert.deepEqual(state.puts, [], `${status}/${slug}/${mapping}: no PUT over a settled order`)
        evaluated++
      }
    }
  }
  assert.equal(evaluated, 12)
})

test('o3d-6ldlj (d): a held push never goes over a cancelled order, even with a mapping row sending cancelled to PROCESSING', async () => {
  state.wcStatus = 'cancelled'
  state.mappings = [{ externalStatus: 'cancelled', imsStatus: 'PROCESSING' }]
  const outcome = await push('ON_HOLD')
  assert.equal(state.fetches.length, 1, 'precondition: read')
  assert.deepEqual(outcome, { kind: 'ineligible', wcStatus: 'cancelled', class: 'finalised' })
  assert.deepEqual(state.puts, [])
  // and the same order is simply already at target for a cancel
  state.fetches.length = 0
  assert.deepEqual(await push('CANCELLED'), { kind: 'already-at-target' })
  assert.deepEqual(state.puts, [])
})

test('o3d-6ldlj (e): partial-shipped and EU-withdrawal statuses are never pushed over automatically: needs-operator, zero PUTs', async () => {
  let evaluated = 0
  for (const status of ['CANCELLED', 'ON_HOLD'] as const) {
    for (const slug of ['partial-shipped', 'pending-wdraw', 'withdrawn']) {
      state.puts.length = 0
      state.fetches.length = 0
      state.wcStatus = slug
      state.mappings = [{ externalStatus: slug, imsStatus: 'PROCESSING' }] // the mapping must not make it pushable
      const outcome = await push(status)
      assert.equal(state.fetches.length, 1, `${status}/${slug}: precondition — read`)
      assert.deepEqual(outcome, { kind: 'ineligible', wcStatus: slug, class: 'needs-operator' }, `${status}/${slug}`)
      assert.deepEqual(state.puts, [], `${status}/${slug}`)
      evaluated++
    }
  }
  assert.equal(evaluated, 6)
})

test('o3d-6ldlj (f): an UNMAPPED custom status is held with class unknown; a custom in-flight status mapped to PICKING is pushed', async () => {
  state.wcStatus = 'awaiting-courier'
  assert.deepEqual(await push('CANCELLED'), { kind: 'ineligible', wcStatus: 'awaiting-courier', class: 'unknown' })
  assert.deepEqual(state.puts, [])

  state.wcStatus = 'picking-custom'
  state.mappings = [{ externalStatus: 'picking-custom', imsStatus: 'PICKING' }]
  assert.deepEqual(await push('ON_HOLD'), { kind: 'pushed' })
  assert.equal(state.puts.length, 1)
})

test('o3d-6ldlj (g): a failed write is logged and nothing is recorded as pushed; a good one records the echo marker', async () => {
  state.putError = 'HTTP 500'
  assert.deepEqual(await push('CANCELLED'), { kind: 'write-failed', error: 'HTTP 500' })
  assert.equal(state.puts.length, 1, 'precondition: the write was attempted')
  assert.deepEqual(state.syncLogs, [])
  assert.equal(state.activity.filter((a) => a.action === 'wc_push_failed').length, 1)

  state.putError = undefined
  state.puts.length = 0
  assert.deepEqual(await push('ON_HOLD'), { kind: 'pushed' })
  const logs: Row[] = state.syncLogs
  assert.equal(logs.length, 1)
  const payload = logs[0].payload as Row
  assert.equal(payload.status, 'on-hold')
  assert.equal(payload.pushedDateModifiedGmt, '2026-10-04T10:00:05')
})

test('o3d-6ldlj (h): an order with no WooCommerce link is left alone', async () => {
  state.linked = false
  assert.deepEqual(await push('CANCELLED'), { kind: 'not-applicable' })
  assert.deepEqual(state.fetches, [])
  assert.deepEqual(state.puts, [])
})

test('o3d-6ldlj (i): the PUT is refused once the deadline passed, the worker lost its job, or IMS no longer wants it, and sent when none', async () => {
  const { runWithWcAttemptFence } = await import('@/lib/connectors/woocommerce/attempt-fence')
  const expired = new AbortController()
  expired.abort()
  const live = () => new AbortController().signal
  const cases: Array<{
    name: string
    fence: { signal: AbortSignal; stillOwned: () => Promise<boolean>; stillWanted?: () => Promise<boolean> }
    puts: number
    outcome: string
    error?: RegExp
  }> = [
    { name: 'deadline passed', fence: { signal: expired.signal, stillOwned: async () => true, stillWanted: async () => true }, puts: 0, outcome: 'error', error: /deadline passed/ },
    { name: 'lock lost (parked/replayed)', fence: { signal: live(), stillOwned: async () => false, stillWanted: async () => true }, puts: 0, outcome: 'error', error: /no longer owns/ },
    { name: 'IMS no longer wants it (hold released mid-attempt)', fence: { signal: live(), stillOwned: async () => true, stillWanted: async () => false }, puts: 0, outcome: 'error', error: /no longer in the status/ },
    { name: 'owned, wanted, inside the deadline', fence: { signal: live(), stillOwned: async () => true, stillWanted: async () => true }, puts: 1, outcome: 'pushed' },
  ]
  let evaluated = 0
  for (const c of cases) {
    state.puts.length = 0
    state.fetches.length = 0
    state.wcStatus = 'processing'
    const outcome = await runWithWcAttemptFence(c.fence, () => push('ON_HOLD'))
    assert.equal(state.fetches.length, 1, `${c.name}: precondition — the status was read, so only the pre-write check can explain the result`)
    assert.equal(outcome.kind, c.outcome, c.name)
    if (c.error && outcome.kind === 'error') assert.match(outcome.error, c.error, c.name)
    assert.equal(state.puts.length, c.puts, c.name)
    evaluated++
  }
  assert.equal(evaluated, 4)
})

test('o3d-6ldlj (j): a mapping row can NOT make IMS skip the PUT: processing mapped to CANCELLED / ON_HOLD is still PUT, and a custom slug mapped to the target is needs-operator (no PUT, no success)', async () => {
  let evaluated = 0
  for (const [status, mapped, wcTarget] of [['CANCELLED', 'CANCELLED', 'cancelled'], ['ON_HOLD', 'ON_HOLD', 'on-hold']] as const) {
    state.puts.length = 0
    state.fetches.length = 0
    state.wcStatus = 'processing'
    state.mappings = [{ externalStatus: 'processing', imsStatus: mapped }]
    const outcome = await push(status)
    assert.equal(state.fetches.length, 1, `${status}: precondition — read`)
    assert.deepEqual(outcome, { kind: 'pushed' }, `${status}: WooCommerce really changed`)
    assert.deepEqual(state.puts, [{ path: '/orders/1001', body: { status: wcTarget } }], status)
    evaluated++

    state.puts.length = 0
    state.fetches.length = 0
    state.wcStatus = 'voided-custom'
    state.mappings = [{ externalStatus: 'voided-custom', imsStatus: mapped }]
    const custom = await push(status)
    assert.equal(state.fetches.length, 1)
    assert.deepEqual(custom, { kind: 'ineligible', wcStatus: 'voided-custom', class: 'needs-operator' }, `${status}: custom slug mapped to the target`)
    assert.deepEqual(state.puts, [])
    evaluated++
  }
  assert.equal(evaluated, 4)
})

test('o3d-6ldlj (j2): a REAL-slug already-at-target is still a success with ZERO PUTs, even with a hostile mapping', async () => {
  state.puts.length = 0
  state.wcStatus = 'cancelled'
  state.mappings = [{ externalStatus: 'cancelled', imsStatus: 'PROCESSING' }]
  assert.deepEqual(await push('CANCELLED'), { kind: 'already-at-target' })
  state.wcStatus = 'on-hold'
  state.mappings = [{ externalStatus: 'on-hold', imsStatus: 'PROCESSING' }]
  assert.deepEqual(await push('ON_HOLD'), { kind: 'already-at-target' })
  assert.deepEqual(state.puts, [])
})
