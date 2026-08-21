import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-rbyg round 2, Codex finding 1: A FRESH MISSED WITHDRAWAL IS INVISIBLE TO THE DISPATCH SCREEN.
 *
 * The dispatch sweep's screen is local by design — markers or a standing tombstone, no storefront
 * call — because it runs over every active link on every tick. That is exactly why a withdrawal IMS
 * has never heard of cannot be seen there: no webhook arrived, so no marker; and the push screen,
 * which is what writes tombstones, only ever looks at orders it is about to PUSH.
 *
 * So the storefront read happens HERE instead, off the dispatch tick, in the WooCommerce withdrawal
 * cron: a bounded rotation over the dispatch-eligible set that turns what it finds into ordinary
 * local evidence (the tombstone, then the markers). The dispatch fence stays local and a WooCommerce
 * outage still cannot interfere with dispatch reconciliation.
 */

type Row = Record<string, unknown>

const state = {
  cursor: null as string | null,
  cursorWrites: [] as string[],
  links: [] as Array<{ id: string; orderId: string }>,
  linkWheres: [] as Row[],
  /** The link ids each slice actually returned — how often a given link is screened. */
  screenedSlices: [] as string[][],
  /** WooCommerce order id per sales order id. */
  external: {} as Record<string, string>,
  /** Live storefront status per WooCommerce order id, as the BATCH screen sees it. */
  liveStatus: {} as Record<string, string>,
  /**
   * What the by-ID re-read sees, when it differs — the request rejected in between. The batch screen
   * is a snapshot; the decision is always taken from the live read.
   */
  liveStatusOnReread: {} as Record<string, string>,
  /** Whether a WMS connector is enabled at all. */
  wmsEnabled: true,
  /** When set, every /orders screen call fails with this error. */
  screenError: null as string | null,
  tombstones: [] as string[],
  orders: [] as Array<{ id: string; status: string; withdrawalHoldAt: Date | null; withdrawalApprovedAt: Date | null; withdrawalLastWcStatus: string | null; withdrawalLastWcEventAt: Date | null }>,
  orderUpdates: [] as Array<{ id: string; data: Row }>,
  transitions: [] as string[],
}

function reset() {
  state.cursor = null
  state.cursorWrites = []
  state.links = []
  state.linkWheres = []
  state.screenedSlices = []
  state.external = {}
  state.liveStatus = {}
  state.liveStatusOnReread = {}
  state.wmsEnabled = true
  state.screenError = null
  state.tombstones = []
  state.orders = []
  state.orderUpdates = []
  state.transitions = []
}

mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })
mock.module('@/lib/settings-store', {
  namedExports: {
    // No overrides configured → the plugin's default slugs.
    getSettingValues: async () => new Map<string, string>(),
    getSettingValue: async () => null,
  },
})
mock.module('@/lib/integration-plugins', {
  namedExports: {
    getIntegrationPluginState: async () => (state.wmsEnabled ? { mintsoft: true } : {}),
    isIntegrationPluginEnabled: async () => true,
    INTEGRATION_PLUGIN_SETTING_KEYS: {},
  },
})
mock.module('@/app/actions/sales', {
  namedExports: {
    applySalesOrderStatusTransition: async (orderId: string, status: string) => {
      state.transitions.push(`${orderId}:${status}`)
      const order = state.orders.find((row) => row.id === orderId)
      if (order) order.status = status
      return { success: true }
    },
  },
})
mock.module('@/lib/connectors/woocommerce/api', {
  namedExports: {
    wcFetch: async (path: string, params: Record<string, string> = {}) => {
      if (path === '/orders') {
        if (state.screenError) return { data: null, error: state.screenError }
        const ids = (params.include ?? '').split(',').filter(Boolean)
        const wanted = (params.status ?? '').split(',').filter(Boolean)
        return {
          data: ids
            .filter((id) => wanted.includes(state.liveStatus[id] ?? ''))
            .map((id) => ({ id: Number(id), number: id, status: state.liveStatus[id] })),
          error: null,
        }
      }
      const byId = path.match(/^\/orders\/(\d+)$/)
      if (byId) {
        const id = byId[1]
        if (state.screenError) return { data: null, error: state.screenError }
        const status = state.liveStatusOnReread[id] ?? state.liveStatus[id] ?? 'processing'
        return { data: { id: Number(id), number: id, status }, error: null }
      }
      return { data: [], error: null }
    },
    wcPost: async () => ({ data: null, error: null }),
    wcPut: async () => ({ data: null, error: null }),
  },
})

mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: {
        findUnique: async () => (state.cursor === null ? null : { value: state.cursor }),
        upsert: async ({ create }: { create: { value: string } }) => {
          state.cursor = create.value
          state.cursorWrites.push(create.value)
          return create
        },
      },
      wmsOrderPushLink: {
        // The `where` is APPLIED, both halves. `gt` is the rotation's position and `lte` is its END,
        // and a double that ignored `lte` could not observe the starvation this round is about — it
        // would pass whether or not the bound exists.
        findMany: async ({ where, take }: { where: Row; take: number }) => {
          state.linkWheres.push(where)
          const id = where.id as { gt?: string; lte?: string } | undefined
          const rows = state.links
            .filter((link) => (id?.gt === undefined || id.gt === '' ? true : link.id > id.gt))
            .filter((link) => (id?.lte === undefined ? true : link.id <= id.lte))
            .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
            .slice(0, take)
          state.screenedSlices.push(rows.map((row) => row.id))
          return rows
        },
        findFirst: async ({ orderBy }: { orderBy: { id: 'asc' | 'desc' } }) => {
          const sorted = [...state.links].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          const row = orderBy.id === 'desc' ? sorted[sorted.length - 1] : sorted[0]
          return row ? { id: row.id } : null
        },
      },
      shoppingOrderLink: {
        findMany: async ({ where }: { where: { orderId: { in: string[] } } }) =>
          where.orderId.in
            .filter((orderId) => state.external[orderId])
            .map((orderId) => ({ orderId, externalOrderId: state.external[orderId] })),
        findUnique: async ({ where }: { where: { connector_externalOrderId: { externalOrderId: string } } }) => {
          const externalOrderId = where.connector_externalOrderId.externalOrderId
          const orderId = Object.keys(state.external).find((key) => state.external[key] === externalOrderId)
          return orderId ? { orderId } : null
        },
      },
      wcWithdrawalSuppression: {
        upsert: async ({ create }: { create: { externalOrderId: string } }) => {
          state.tombstones.push(create.externalOrderId)
          return create
        },
      },
      salesOrder: {
        findUnique: async ({ where }: { where: { id: string } }) => state.orders.find((row) => row.id === where.id) ?? null,
        update: async ({ where, data }: { where: { id: string }; data: Row }) => {
          state.orderUpdates.push({ id: where.id, data })
          const order = state.orders.find((row) => row.id === where.id)
          if (order && data.withdrawalHoldAt) order.withdrawalHoldAt = data.withdrawalHoldAt as Date
          return order
        },
        updateMany: async () => ({ count: 1 }),
      },
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const query = Array.isArray(strings) ? strings.join('?') : ''
        if (query.includes('sales_orders')) {
          const id = values[0] as string
          return state.orders.some((row) => row.id === id) ? [{ id }] : []
        }
        return []
      },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        const { db } = await import('@/lib/db')
        return fn(db)
      },
    },
  },
})

async function sweepDispatchEligibleWithdrawals(limit?: number) {
  const mod = await import('../lib/connectors/woocommerce/sync/withdrawal.ts')
  return mod.sweepDispatchEligibleWithdrawals(limit)
}

/** The stored rotation state, decoded — position AND the end it belongs to. */
async function rotation(raw = state.cursor) {
  const mod = await import('../lib/connectors/woocommerce/sync/withdrawal.ts')
  return mod.parseWdrawRotationState(raw)
}

async function writeRotation(cursor: string, bound: string | null) {
  const mod = await import('../lib/connectors/woocommerce/sync/withdrawal.ts')
  state.cursor = mod.serialiseWdrawRotationState({ cursor, bound })
}

function seedOrder(id: string, externalOrderId: string, liveStatus: string) {
  state.links.push({ id: `link-${id}`, orderId: id })
  state.external[id] = externalOrderId
  state.liveStatus[externalOrderId] = liveStatus
  state.orders.push({
    id, status: 'PROCESSING', withdrawalHoldAt: null, withdrawalApprovedAt: null,
    withdrawalLastWcStatus: null, withdrawalLastWcEventAt: null,
  })
}

test('recon: the slice is the DISPATCH SWEEP’s own eligibility, not a hand-copied one (o3d-rbyg r2)', async () => {
  reset()
  seedOrder('o1', '900', 'processing')

  await sweepDispatchEligibleWithdrawals()

  const where = state.linkWheres[0]
  assert.equal(where.connector, 'mintsoft')
  assert.deepEqual((where.state as { in: string[] }).in, ['SYNCED', 'MERGED'], 'the states the dispatch sweep fulfils from')
  assert.equal(where.dispatchDeadLetteredAt, null, 'and its exclusions, so the screened set cannot drift from the fulfilled set')
  assert.equal(where.dispatchUnresolvedAt, null)
})

test('recon: a clean slice advances the rotation cursor (o3d-rbyg r2)', async () => {
  reset()
  seedOrder('o1', '900', 'processing')
  seedOrder('o2', '901', 'completed')

  const result = await sweepDispatchEligibleWithdrawals()

  assert.equal(result.scanned, 2)
  assert.equal(result.withdrawn, 0)
  assert.equal(state.cursorWrites.length, 1)
  assert.deepEqual(
    await rotation(),
    { cursor: 'link-o2', bound: 'link-o2' },
    'the cursor moves to the end of the slice so the next run rotates on — and it is written together '
      + 'with the ROTATION it belongs to, so the two can never describe different rotations',
  )
})

test('recon: an UNREADABLE slice holds the cursor instead of rotating past it (o3d-rbyg r2)', async () => {
  reset()
  seedOrder('o1', '900', 'pending-wdraw')
  state.screenError = 'HTTP 502 Bad Gateway'

  const result = await sweepDispatchEligibleWithdrawals()

  assert.equal(result.unresolved, 1, 'the run reports that a slice went unexamined')
  assert.deepEqual(
    (await rotation()).cursor,
    '',
    'and the POSITION is HELD — an unread slice must not wait a whole rotation. (o3d-rbyg r4: this '
      + 'asserted that NOTHING was written, which is no longer the same thing: the rotation this run '
      + 'started is recorded alongside the held position, so the next run continues it rather than '
      + 'taking a fresh bound and re-screening from a different end.)',
  )
  assert.deepEqual(state.orderUpdates, [], 'nothing was decided from a read that failed')
})

test('recon: a withdrawal on an ALREADY-PUSHED order becomes local evidence (o3d-rbyg r2)', async () => {
  // The whole point. Before this, an order withdrawn after it was pushed — webhook missed — carried
  // no marker and no tombstone, so the dispatch sweep's local screen had nothing to see and the
  // warehouse's despatch was reconciled in full.
  reset()
  seedOrder('o1', '900', 'pending-wdraw')
  seedOrder('o2', '901', 'processing')

  const result = await sweepDispatchEligibleWithdrawals()

  assert.equal(result.withdrawn, 1)
  assert.equal(result.applied, 1)
  assert.deepEqual(state.tombstones, ['900'], 'the DURABLE half is written first, so the fence survives the next outage')
  assert.ok(
    state.orderUpdates.some((update) => update.id === 'o1' && update.data.withdrawalHoldAt),
    'and the marker lands, which is what the dispatch screen actually reads',
  )
  assert.deepEqual(state.transitions, ['o1:ON_HOLD'], 'through the ordinary hold machinery, not a private path')
  assert.ok(!state.orderUpdates.some((update) => update.id === 'o2'), 'the clean order in the same slice is untouched')
})

test('recon: a request rejected between the screen and the read is NOT acted on (o3d-rbyg r2)', async () => {
  // The batch screen is a snapshot; the decision is taken from the live status, like every other
  // withdrawal decision in this module. The tombstone the screen wrote still stands — only the
  // quiescence protocol retires it — so nothing is lost by declining to act here.
  reset()
  seedOrder('o1', '900', 'pending-wdraw')
  // The by-id read sees the rejection that landed after the batch screen.
  state.liveStatusOnReread['900'] = 'processing'

  const result = await sweepDispatchEligibleWithdrawals()

  assert.equal(result.withdrawn, 1, 'the batch screen did see it')
  assert.equal(result.retracted, 1, 'but the live read is what decides, and it says the request is gone')
  assert.equal(result.applied, 0)
  assert.deepEqual(state.orderUpdates, [], 'no hold was placed on a request that no longer exists')
  assert.deepEqual(state.tombstones, ['900'], 'and the tombstone written by the screen is NOT retired here')
})

test('recon: the rotation WRAPS when it reaches the end of the set (o3d-rbyg r2)', async () => {
  // Without the wrap the tail of the set is screened once and never again, and the bound the fence
  // advertises ("every eligible link once per rotation") is false.
  reset()
  seedOrder('o1', '900', 'processing')
  await writeRotation('link-zzz', 'link-zzz')

  const result = await sweepDispatchEligibleWithdrawals()

  assert.equal(result.wrapped, true)
  assert.equal(result.scanned, 1, 'the link behind the cursor was screened after all')
  assert.deepEqual(await rotation(), { cursor: 'link-o1', bound: 'link-o1' }, 'and a FRESH rotation was started')
})

test('recon: no WMS connector means no dispatch path to get ahead of (o3d-rbyg r2)', async () => {
  reset()
  seedOrder('o1', '900', 'pending-wdraw')
  state.wmsEnabled = false

  const result = await sweepDispatchEligibleWithdrawals()

  assert.equal(result.skipped, 'no active WMS connector')
  assert.equal(result.scanned, 0)
  assert.deepEqual(state.tombstones, [], 'and no storefront call was spent')
})

// ---------------------------------------------------------------------------------------------
// o3d-rbyg r4 (Codex r3 finding 3) — A BOUND THAT NEW ARRIVALS KEEP RESETTING IS NOT A BOUND.
//
// Round 3 wrote down "every dispatch-eligible link is screened at least once per
// ceil(eligible / limit) runs" and did not have it. The rotation advanced `id > cursor` and wrapped
// only when THAT query came back empty — and link ids ascend, so a shop that keeps taking orders
// keeps the slice ahead of the cursor permanently non-empty. The wrap never fires and the links
// BEHIND the cursor are screened once and then never again. Those are the long-lived ones: parked,
// dead-lettered, stuck awaiting a despatch that never comes — precisely the orders a customer is
// most likely to withdraw.
// ---------------------------------------------------------------------------------------------

test('o3d-rbyg r4: continuous arrivals cannot stop the rotation coming back to an old link', async () => {
  reset()
  // The link that must not starve: it sorts FIRST, so once screened it is permanently behind the
  // cursor. Under the round-3 rotation it is never reached a second time.
  seedOrder('a-old', '900', 'processing')
  seedOrder('b-old', '901', 'processing')

  // One link per run, and a NEW order arriving before every run after the first — the shop is
  // trading, which is the condition round 3's bound silently assumed away.
  await sweepDispatchEligibleWithdrawals(1)
  for (let run = 0; run < 4; run += 1) {
    seedOrder(`z-new-${run}`, `95${run}`, 'processing')
    await sweepDispatchEligibleWithdrawals(1)
  }

  const timesScreened = state.screenedSlices.filter((slice) => slice.includes('link-a-old')).length
  assert.ok(
    timesScreened >= 2,
    `link-a-old was screened ${timesScreened} time(s) across five runs. Once is the defect: a link `
      + 'behind the cursor is exactly the long-lived, parked, still-unfulfilled kind an order is most '
      + 'likely to be withdrawn against, and screening it once means never noticing a withdrawal '
      + 'filed after that moment',
  )
  assert.ok(
    state.screenedSlices.some((slice) => slice.includes('link-z-new-0')),
    'control: the arrivals really did enter the screened set, so the property above is not vacuous',
  )
})

test('o3d-rbyg r4: links created AFTER the rotation began cannot extend it', async () => {
  reset()
  seedOrder('a-old', '900', 'processing')

  // Run 1 fixes the rotation's end at link-a-old and screens it.
  const run1 = await sweepDispatchEligibleWithdrawals(1)
  assert.equal(run1.scanned, 1)
  assert.deepEqual(await rotation(), { cursor: 'link-a-old', bound: 'link-a-old' })

  // Two arrivals land above the bound.
  seedOrder('z-new-1', '951', 'processing')
  seedOrder('z-new-2', '952', 'processing')

  const run2 = await sweepDispatchEligibleWithdrawals(1)

  assert.equal(run2.wrapped, true, 'the rotation ENDED at its bound rather than being extended by the arrivals')
  assert.equal(run2.scanned, 1)
  const slices = state.linkWheres.slice(-2)
  assert.deepEqual(
    (slices[0].id as Record<string, unknown>),
    { gt: 'link-a-old', lte: 'link-a-old' },
    'the slice is bounded at BOTH ends — without the upper bound the two new links keep it non-empty forever',
  )
  assert.deepEqual(await rotation(), { cursor: 'link-a-old', bound: 'link-z-new-2' }, 'and the NEW rotation covers them')
})

test('o3d-rbyg r4: the round-3 cursor format starts a fresh rotation rather than inventing a bound for it', async () => {
  reset()
  seedOrder('a-old', '900', 'processing')
  seedOrder('b-old', '901', 'processing')
  state.cursor = 'link-a-old' // the bare-string format this replaces

  const result = await sweepDispatchEligibleWithdrawals(1)

  assert.equal(result.scanned, 1)
  assert.deepEqual(
    (state.linkWheres[0].id as Record<string, unknown>),
    { gt: '', lte: 'link-b-old' },
    'a position with no recorded rotation is not a rotation — it restarts from the front, which '
      + 're-screens at most one slice and can never skip one',
  )
})

test('o3d-rbyg r4: an unreadable slice holds BOTH halves of the rotation state, not just the position', async () => {
  // The run that STARTS a rotation and then cannot read its first slice. The position is held at the
  // front, but the rotation's end was decided by this run and nothing else knows it: dropping it
  // means the next run takes a FRESH bound from a set that has grown, and the "at most one slice
  // re-screened" property becomes "the rotation restarts, further out, every time WooCommerce is
  // down" — which is the starvation again, wearing an outage.
  reset()
  seedOrder('a-old', '900', 'pending-wdraw')
  seedOrder('b-old', '901', 'processing')
  state.screenError = 'HTTP 502 Bad Gateway'

  const result = await sweepDispatchEligibleWithdrawals(1)

  assert.equal(result.unresolved, 1)
  assert.deepEqual(
    await rotation(),
    { cursor: '', bound: 'link-b-old' },
    'the position is held AND the rotation it belongs to is persisted, so an outage cannot leave the '
      + 'two describing different rotations',
  )
  assert.deepEqual(state.orderUpdates, [], 'and nothing was decided from a read that failed')
})

test('o3d-rbyg r4: an unreadable slice mid-rotation keeps the rotation it was already in', async () => {
  reset()
  seedOrder('a-old', '900', 'pending-wdraw')
  seedOrder('b-old', '901', 'processing')
  await writeRotation('link-a-old', 'link-b-old')
  state.screenError = 'HTTP 502 Bad Gateway'

  const result = await sweepDispatchEligibleWithdrawals(1)

  assert.equal(result.unresolved, 1)
  assert.deepEqual(await rotation(), { cursor: 'link-a-old', bound: 'link-b-old' })
})

test('o3d-rbyg r4: an empty eligible set clears the rotation state instead of pinning a stale bound', async () => {
  reset()
  await writeRotation('link-gone', 'link-gone')

  const result = await sweepDispatchEligibleWithdrawals()

  assert.equal(result.scanned, 0)
  assert.deepEqual(await rotation(), { cursor: '', bound: null }, 'a bound naming a link that no longer exists would wedge the rotation')
})
