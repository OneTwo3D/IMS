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
  reconcileCalls: [] as Array<{ orderId: string; expectedExternalOrderId?: string; mergeNumberUnique?: boolean }>,
  /** Claimant counts by WMS order number, as the connector reports them. */
  claimants: null as Map<string, number> | null,
  /** Orders with a standing withdrawal, as the sweep's own local screen reads it. */
  standing: new Set<string>(),
  releases: [] as Array<{ orderId: string; generation: number; note?: string }>,
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
  state.claimants = null
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
    createPrismaDispatchDeps: () => ({
      fetchOrderStatus: async () => state.wmsStatus,
      // Present only when the test arranges one, so "the connector cannot count claimants" stays a
      // distinguishable case from "it counted and found one".
      ...(state.claimants ? { countLinksByOrderNumber: async () => state.claimants } : {}),
    }),
    reconcileOneOrder: async (
      _deps: unknown,
      candidate: { orderId: string },
      _preloaded: unknown,
      expectedExternalOrderId?: string,
      _requireResolution?: boolean,
      mergeNumberUnique?: boolean,
    ) => {
      state.reconcileCalls.push({ orderId: candidate.orderId, expectedExternalOrderId, mergeNumberUnique })
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
    releaseWithdrawalHold: async (orderId: string, expected: { generation: number }, note?: string) => {
      state.releases.push({ orderId, generation: expected.generation, note })
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
    order: {
      status: 'ON_HOLD', orderNumber: 'SO-1',
      withdrawalHoldAt: new Date('2026-08-19T09:00:00.000Z'), withdrawalApprovedAt: null,
      withdrawalHoldGeneration: 3,
    },
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
  assert.deepEqual(
    state.reconcileCalls.map((call) => call.orderId),
    ['so-1'],
    'the fulfilment is the sweep’s own per-order path, not a private copy',
  )
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
    order: { status: 'CANCELLED', orderNumber: 'SO-1', withdrawalHoldAt: null, withdrawalApprovedAt: new Date('2026-08-19T09:30:00.000Z'), withdrawalHoldGeneration: 4 },
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
    order: { status: 'CANCELLED', orderNumber: 'SO-1', withdrawalHoldAt: null, withdrawalApprovedAt: new Date('2026-08-19T09:30:00.000Z'), withdrawalHoldGeneration: 4 },
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

// ---------------------------------------------------------------------------------------------
// o3d-rbyg r4 (Codex r3 findings 1 and 2) — WHAT THE REMEDY WAS STILL TAKING ON TRUST.
//
// Round 3 got the SHAPE right: ask the warehouse first, and release the hold THROUGH its generation
// guard rather than around it. Two things were still unbound.
//
//   • The generation guard was satisfied by a value `releaseWithdrawalHold` fetched for itself, so
//     it closed the window between that read and that write and no other — not the window that
//     matters, which spans the operator's decision and a warehouse round trip.
//   • The warehouse answer was never bound to THIS link's WMS order. `fetchOrderStatus` takes an
//     order NUMBER, and a number is a lookup key rather than an identity: renameable, reusable, and
//     answered under a combined number by a merge survivor.
// ---------------------------------------------------------------------------------------------

test('o3d-rbyg r4: the release is guarded on the withdrawal generation READ UNDER THE SWEEP LOCK', async () => {
  reset()
  state.link = parkedLink()
  const { recordWithdrawnDespatch } = await actions()

  const result = await recordWithdrawnDespatch('so-1')

  assert.equal(result.success, true)
  assert.deepEqual(
    state.releases,
    [{
      orderId: 'so-1',
      generation: 3,
      note: state.releases[0]?.note,
    }],
    'the request the action decided about is named to the release, so a NEWER one filed during the '
      + 'warehouse round trip cannot be cleared by a decision taken before it existed',
  )
})

test('o3d-rbyg r4: a WMS record with a different stable ID is refused, and nothing is released or dispatched', async () => {
  // A reused or renamed order number. Round 3 read `dispatched` straight off this record.
  reset()
  state.link = parkedLink()
  state.wmsStatus = {
    externalOrderId: 'M-999', externalOrderNumber: 'WMS-1', status: 'DESPATCHED',
    dispatched: true, isSplit: false, isMerged: false, mergedOrderNumbers: [],
  }
  const { recordWithdrawnDespatch } = await actions()

  const result = await recordWithdrawnDespatch('so-1')

  assert.equal(result.success, false)
  assert.match(result.success ? '' : String(result.error), /not this link's order/)
  assert.match(result.success ? '' : String(result.error), /stable ID M-999; expected M-1/, 'the refusal says what came back and what was expected')
  assert.deepEqual(state.releases, [], 'the customer’s hold is NOT released on someone else’s despatch')
  assert.deepEqual(state.reconcileCalls, [], 'and no stock is consumed and no despatch email is sent')
  assert.deepEqual(state.linkUpdates, [], 'the link stays parked')
})

test('o3d-rbyg r4: a merge survivor that does NOT name our number is refused rather than assumed', async () => {
  reset()
  state.link = parkedLink()
  state.wmsStatus = {
    externalOrderId: 'M-SURV', externalOrderNumber: 'WMS-7+WMS-8', status: 'DESPATCHED',
    dispatched: true, isSplit: false, isMerged: true, mergedOrderNumbers: ['WMS-7', 'WMS-8'],
  }
  const { recordWithdrawnDespatch } = await actions()

  const result = await recordWithdrawnDespatch('so-1')

  assert.equal(result.success, false)
  assert.match(result.success ? '' : String(result.error), /stable ID M-SURV; expected M-1/)
  assert.deepEqual(state.reconcileCalls, [])
})

test('o3d-rbyg r4: a merge survivor that DOES name our number, uniquely, is accepted', async () => {
  // The one legitimate stable-ID change. Bound by the survivor naming our number AND exactly one
  // link claiming it — a shared number cannot say which order was absorbed.
  reset()
  state.link = parkedLink()
  state.claimants = new Map([['WMS-1', 1]])
  state.wmsStatus = {
    externalOrderId: 'M-SURV', externalOrderNumber: 'WMS-1+WMS-2', status: 'DESPATCHED',
    dispatched: true, isSplit: false, isMerged: true, mergedOrderNumbers: ['WMS-1', 'WMS-2'],
  }
  const { recordWithdrawnDespatch } = await actions()

  const result = await recordWithdrawnDespatch('so-1')

  assert.equal(result.success, true, result.success ? '' : String(result.error))
  assert.deepEqual(state.reconcileCalls.map((call) => call.orderId), ['so-1'])
})

test('o3d-rbyg r4: a merge claim on a number SEVERAL links share is refused', async () => {
  reset()
  state.link = parkedLink()
  state.claimants = new Map([['WMS-1', 2]])
  state.wmsStatus = {
    externalOrderId: 'M-SURV', externalOrderNumber: 'WMS-1+WMS-2', status: 'DESPATCHED',
    dispatched: true, isSplit: false, isMerged: true, mergedOrderNumbers: ['WMS-1', 'WMS-2'],
  }
  const { recordWithdrawnDespatch } = await actions()

  const result = await recordWithdrawnDespatch('so-1')

  assert.equal(result.success, false)
  assert.match(result.success ? '' : String(result.error), /not this link's order/)
  assert.deepEqual(state.reconcileCalls, [], 'nobody can say WHICH order was absorbed, so nothing is dispatched')
})

test('o3d-rbyg r4: the identity the action checked is HANDED ON to the dispatch, not dropped', async () => {
  // The confirmation and the fulfilment are two separate reads of the same order. Passing neither
  // the stable id nor the claimant count — which is what this call did — disabled the sweep's own
  // identity guard on the one path a person had just authorised.
  reset()
  state.link = parkedLink()
  state.claimants = new Map([['WMS-1', 1]])
  const { recordWithdrawnDespatch } = await actions()

  await recordWithdrawnDespatch('so-1')

  assert.deepEqual(
    state.reconcileCalls,
    [{ orderId: 'so-1', expectedExternalOrderId: 'M-1', mergeNumberUnique: true }],
  )
})

test('o3d-rbyg r4: a refused release stops the remedy before anything is dispatched', async () => {
  // The generation guard firing is not advisory. If the release refuses — a newer request — the
  // action must stop, not fall through to the fulfilment.
  reset()
  state.link = parkedLink()
  state.releaseResult = { success: false, error: 'A NEWER withdrawal request has been filed against this order' }
  const { recordWithdrawnDespatch } = await actions()

  const result = await recordWithdrawnDespatch('so-1')

  assert.equal(result.success, false)
  assert.match(result.success ? '' : String(result.error), /NEWER withdrawal request/)
  assert.deepEqual(state.reconcileCalls, [], 'no stock consumed, no despatch email')
  assert.deepEqual(state.linkUpdates, [], 'and the link stays parked, so the row is still actionable')
})

test('o3d-rbyg r4: with no stable id on the link, the answer must at least come back under the same number', async () => {
  // A link that never recorded a WMS id has nothing else to bind on. The record came from a
  // BY-NUMBER lookup here, so an answer under a different number is answering about something else.
  reset()
  state.link = parkedLink({ externalOrderId: null })
  state.wmsStatus = {
    externalOrderId: 'M-77', externalOrderNumber: 'WMS-OTHER', status: 'DESPATCHED',
    dispatched: true, isSplit: false, isMerged: false, mergedOrderNumbers: [],
  }
  const { recordWithdrawnDespatch } = await actions()

  const result = await recordWithdrawnDespatch('so-1')

  assert.equal(result.success, false)
  assert.match(result.success ? '' : String(result.error), /answered as WMS-OTHER/)
  assert.deepEqual(state.releases, [])
  assert.deepEqual(state.reconcileCalls, [])
})

test('o3d-rbyg r4: the same-number answer on a link with no stable id is accepted', async () => {
  // Control: the check must not become a way for the remedy to stop working.
  reset()
  state.link = parkedLink({ externalOrderId: null })
  state.wmsStatus = {
    externalOrderId: 'M-77', externalOrderNumber: 'WMS-1', status: 'DESPATCHED',
    dispatched: true, isSplit: false, isMerged: false, mergedOrderNumbers: [],
  }
  const { recordWithdrawnDespatch } = await actions()

  const result = await recordWithdrawnDespatch('so-1')

  assert.equal(result.success, true, result.success ? '' : String(result.error))
})
