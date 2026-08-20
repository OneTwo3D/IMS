import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-rbyg round 2, Codex finding 3: ALREADY-DESPATCHED GOODS HAD NO SUPPORTED RECONCILIATION PATH.
 *
 * Round 1 flagged it against itself: a withdrawn order the warehouse has already despatched is
 * refused and parked — goods gone, IMS showing it unshipped, the stock still on the shelf in the
 * sub-ledger — "until an operator acts". The exception inbox then offered exactly one action,
 * Replay, which re-runs the same screen, meets the same standing withdrawal and re-parks the link.
 *
 * A refusal whose only offered remedy cannot work is a refusal with no remedy. These are the two
 * remedies that can actually be performed, and the guards that keep them honest.
 */

type Row = Record<string, unknown>

const state = {
  link: null as Row | null,
  linkUpdates: [] as Row[],
  connectorId: 'mintsoft' as string | null,
  /** What the WMS says about the order when asked. */
  wmsStatus: null as Row | null,
  /** What reconcileOneOrder reports. */
  reconcile: { action: 'dispatched', reason: 'DESPATCHED' } as { action: string; reason: string },
  reconcileCalls: [] as string[],
  /** Orders with a standing withdrawal, as the sweep's own local screen reads it. */
  standing: new Set<string>(),
  releases: [] as Array<{ orderId: string; note?: string }>,
  releaseResult: { success: true } as { success: boolean; error?: string },
  activity: [] as Row[],
  lockHeld: true,
}

function reset() {
  state.link = null
  state.linkUpdates = []
  state.connectorId = 'mintsoft'
  state.wmsStatus = { externalOrderId: 'M-1', externalOrderNumber: 'WMS-1', status: 'DESPATCHED', dispatched: true, isSplit: false }
  state.reconcile = { action: 'dispatched', reason: 'DESPATCHED' }
  state.reconcileCalls = []
  state.standing = new Set<string>(['so-1'])
  state.releases = []
  state.releaseResult = { success: true }
  state.activity = []
  state.lockHeld = true
}

mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (fn: unknown) => fn } })
mock.module('@/lib/auth/server', {
  namedExports: {
    requireFreshPermission: async () => ({ user: { id: 'user-1', email: 'ops@example.com' } }),
    requirePermission: async () => ({ user: { id: 'user-1', email: 'ops@example.com' } }),
    freshAuthFailureResult: () => null,
  },
})
mock.module('@/lib/activity-log', { namedExports: { logActivity: async (entry: Row) => { state.activity.push(entry) } } })
mock.module('@/lib/connectors/wms/active-connector', {
  namedExports: {
    getEnabledWmsConnectorId: async () => state.connectorId,
    getActiveWmsConnectorId: async () => state.connectorId,
  },
})
mock.module('@/lib/connectors/wms/registry', { namedExports: { getWmsConnector: () => ({ id: 'mintsoft' }) } })
mock.module('@/lib/domain/wms/dispatch-sweep-lock', {
  namedExports: {
    withDispatchSweepLockOrSkip: async (_id: string, fn: () => Promise<unknown>) =>
      (state.lockHeld ? fn() : { lockSkipped: true }),
    DISPATCH_LOCK_SKIPPED: { lockSkipped: true },
    dispatchSweepLockKey: () => 1,
  },
})
mock.module('@/lib/domain/wms/dispatch-sweep', {
  namedExports: {
    createPrismaDispatchDeps: () => ({ fetchOrderStatus: async () => state.wmsStatus }),
    reconcileOneOrder: async (_deps: unknown, candidate: { orderId: string }) => {
      state.reconcileCalls.push(candidate.orderId)
      return state.reconcile
    },
    dispatchCandidateWhere: (connector: string) => ({ connector }),
    POST_DISPATCH_STATUSES: ['SHIPPED', 'COMPLETED', 'DELIVERED', 'CANCELLED'],
  },
})
mock.module('@/lib/connectors/woocommerce/sync/withdrawal', {
  namedExports: {
    screenLocalWithdrawalEvidence: async (ids: string[]) => new Set(ids.filter((id) => state.standing.has(id))),
  },
})
mock.module('@/app/actions/sales', {
  namedExports: {
    releaseWithdrawalHold: async (orderId: string, note?: string) => {
      state.releases.push({ orderId, note })
      return state.releaseResult
    },
  },
})
mock.module('@/lib/db', {
  namedExports: {
    db: {
      wmsOrderPushLink: {
        findUnique: async () => state.link,
        updateMany: async ({ data }: { data: Row }) => {
          state.linkUpdates.push(data)
          if (state.link) Object.assign(state.link, data)
          return { count: 1 }
        },
      },
    },
  },
})

async function actions() {
  return import('../app/actions/sync-exceptions.ts')
}

function parkedLink(overrides: Row = {}) {
  return {
    id: 'link-1',
    connector: 'mintsoft',
    state: 'SYNCED',
    externalOrderId: 'M-1',
    externalOrderNumber: 'WMS-1',
    dispatchDeadLetteredAt: new Date('2026-08-19T10:00:00.000Z'),
    dispatchUnresolvedAt: null,
    order: { status: 'ON_HOLD', orderNumber: 'SO-1', withdrawalHoldAt: new Date('2026-08-19T09:00:00.000Z'), withdrawalApprovedAt: null },
    ...overrides,
  }
}

test('remedy: recording the despatch releases the hold, dispatches, and clears the park (o3d-rbyg r2)', async () => {
  reset()
  state.link = parkedLink()
  const { recordWithdrawnDespatch } = await actions()

  const result = await recordWithdrawnDespatch('so-1')

  assert.equal(result.success, true)
  assert.deepEqual(state.releases.map((entry) => entry.orderId), ['so-1'], 'the hold is RELEASED, not bypassed')
  assert.match(String(state.releases[0].note), /already despatched/, 'and the release says why, on the order timeline')
  assert.deepEqual(state.reconcileCalls, ['so-1'], 'the fulfilment is the sweep’s own per-order path, not a private copy')
  assert.equal(state.linkUpdates[0]?.dispatchDeadLetteredAt, null, 'and the row leaves the inbox')
  assert.equal(state.activity[0]?.action, 'wms_dispatch_withdrawn_despatch_recorded')
})

test('remedy: it refuses when the WMS does not report the goods gone, and changes NOTHING (o3d-rbyg r2)', async () => {
  // The operator's claim is verified against the warehouse before anything irreversible happens —
  // the same evidence the sweep itself requires. Otherwise this action is just a button that ships
  // a withdrawn order.
  reset()
  state.link = parkedLink()
  state.wmsStatus = { externalOrderId: 'M-1', externalOrderNumber: 'WMS-1', status: 'Processing', dispatched: false, isSplit: false }
  const { recordWithdrawnDespatch } = await actions()

  const result = await recordWithdrawnDespatch('so-1')

  assert.equal(result.success, false)
  assert.match(result.success ? '' : String(result.error), /not despatched/)
  assert.match(result.success ? '' : String(result.error), /Processing/, 'the refusal quotes what the WMS actually said')
  assert.deepEqual(state.releases, [], 'the withdrawal hold was NOT released')
  assert.deepEqual(state.reconcileCalls, [], 'and nothing was dispatched')
  assert.deepEqual(state.linkUpdates, [], 'the link stays parked')
})

test('remedy: an unreadable WMS record refuses rather than assuming the goods went (o3d-rbyg r2)', async () => {
  reset()
  state.link = parkedLink()
  state.wmsStatus = null
  const { recordWithdrawnDespatch } = await actions()

  const result = await recordWithdrawnDespatch('so-1')

  assert.equal(result.success, false)
  assert.match(result.success ? '' : String(result.error), /did not return order WMS-1/)
  assert.deepEqual(state.releases, [])
  assert.deepEqual(state.reconcileCalls, [])
})

test('remedy: an APPROVED withdrawal is refused HERE and told where to go instead (o3d-rbyg r2)', async () => {
  // An approved withdrawal cancels the order, and IMS will not record a shipment against a cancelled
  // order. The refusal has to name what the operator can do instead, or it is the same dead end this
  // finding is about.
  reset()
  state.link = parkedLink({
    order: { status: 'CANCELLED', orderNumber: 'SO-1', withdrawalHoldAt: null, withdrawalApprovedAt: new Date('2026-08-19T09:30:00.000Z') },
  })
  const { recordWithdrawnDespatch } = await actions()

  const result = await recordWithdrawnDespatch('so-1')

  assert.equal(result.success, false)
  assert.match(result.success ? '' : String(result.error), /withdrawal was APPROVED/)
  assert.match(result.success ? '' : String(result.error), /Dismiss/, 'and it names the action that does apply')
  assert.deepEqual(state.reconcileCalls, [])
})

test('remedy: it refuses a link with no standing withdrawal instead of force-dispatching it (o3d-rbyg r2)', async () => {
  // The page decides which control to show from the same local evidence, but the action must not
  // take the client's word for it — otherwise this is a general "dispatch anyway" button.
  reset()
  state.link = parkedLink()
  state.standing = new Set<string>()
  const { recordWithdrawnDespatch } = await actions()

  const result = await recordWithdrawnDespatch('so-1')

  assert.equal(result.success, false)
  assert.match(result.success ? '' : String(result.error), /No withdrawal stands/)
  assert.match(result.success ? '' : String(result.error), /Replay it instead/)
  assert.deepEqual(state.reconcileCalls, [])
})

test('remedy: a failed dispatch leaves the link PARKED rather than reporting success (o3d-rbyg r2)', async () => {
  reset()
  state.link = parkedLink()
  state.reconcile = { action: 'error', reason: 'no stock to consume' }
  const { recordWithdrawnDespatch } = await actions()

  const result = await recordWithdrawnDespatch('so-1')

  assert.equal(result.success, false)
  assert.match(result.success ? '' : String(result.error), /no stock to consume/)
  assert.deepEqual(state.linkUpdates, [], 'the park is NOT cleared behind a failed fulfilment')
})

test('remedy: a sweep running right now blocks the remedy rather than racing it (o3d-rbyg r2)', async () => {
  reset()
  state.link = parkedLink()
  state.lockHeld = false
  const { recordWithdrawnDespatch } = await actions()

  const result = await recordWithdrawnDespatch('so-1')

  assert.equal(result.success, false)
  assert.match(result.success ? '' : String(result.error), /dispatch sweep is running/)
  assert.deepEqual(state.reconcileCalls, [])
})

test('remedy: Dismiss clears the row only for a CANCELLED order (o3d-rbyg r2)', async () => {
  // Safe there and ONLY there: a cancelled order is outside the dispatch sweep's candidate set, so
  // clearing the park cannot let anything fulfil. On a live order it would simply be re-parked,
  // which is the loop this finding is about.
  reset()
  state.link = parkedLink({
    order: { status: 'CANCELLED', orderNumber: 'SO-1', withdrawalHoldAt: null, withdrawalApprovedAt: new Date('2026-08-19T09:30:00.000Z') },
  })
  const { dismissWithdrawnDispatch } = await actions()

  const result = await dismissWithdrawnDispatch('so-1')

  assert.equal(result.success, true)
  assert.equal(state.linkUpdates[0]?.dispatchDeadLetteredAt, null)
  assert.equal(state.activity[0]?.action, 'wms_dispatch_withdrawn_dismissed')
  assert.match(String(state.activity[0]?.description), /handled as a return/, 'the goods are accounted for in words, not silently')
})

test('remedy: Dismiss refuses on a LIVE order, and says what to do instead (o3d-rbyg r2)', async () => {
  reset()
  state.link = parkedLink()
  const { dismissWithdrawnDispatch } = await actions()

  const result = await dismissWithdrawnDispatch('so-1')

  assert.equal(result.success, false)
  assert.match(result.success ? '' : String(result.error), /only applies to a CANCELLED order/)
  assert.match(result.success ? '' : String(result.error), /Record the despatch/)
  assert.deepEqual(state.linkUpdates, [], 'nothing was cleared')
})
