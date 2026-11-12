import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import type { WmsConnectorResolution } from '../lib/connectors/wms/enabled-connector.ts'

/**
 * THE AMENDMENT NOTICE: a change IMS could not send to a merged warehouse order has an inbox row and an Acknowledge that clears it.
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
  /**
   * WHICH WMS CONNECTOR IS ENABLED — ONE field, three-valued, and the two-valued helper DERIVED
   * from it (o3d-remove-shiphero round 12, Codex MEDIUM).
   *
   * The fixture used to hold `connectorId: string | null` and answer both
   * `resolveEnabledWmsConnectorSelection` and `getEnabledWmsConnectorId` from it, which cannot
   * express the state this round is about — more than one connector enabled — so no case here
   * could reach the branch that reports it. Production derives the nullable id from the resolution
   * (`kind === 'one' ? id : null`); so does the mock below, in one line, so the two cannot disagree.
   */
  wmsResolution: { kind: 'one', id: 'mintsoft' } as WmsConnectorResolution,
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
  state.wmsResolution = { kind: 'one', id: 'mintsoft' }
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
const enabledIdFromResolution = () => (state.wmsResolution.kind === 'one' ? state.wmsResolution.id : null)
mock.module('@/lib/connectors/wms/active-connector', {
  namedExports: {
    resolveEnabledWmsConnectorSelection: async () => state.wmsResolution,
    getEnabledWmsConnectorId: async () => enabledIdFromResolution(),
    getActiveWmsConnectorId: async () => enabledIdFromResolution(),
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

test('INBOX ROW: a live MERGED link with an amendment notice is listed as what it is, with Acknowledge (not Replay) and the instruction', async () => {
  const { buildBlockedWmsPushRow, WMS_PUSH_INBOX_WHERE } = await import('../lib/domain/wms/push-recovery-affordance.ts')
  const row = buildBlockedWmsPushRow({
    orderId: 'so-1', connector: 'mintsoft', state: 'MERGED', attempts: 0, externalOrderId: 'M-1', pushedAt: new Date(), lastError: 'not sent',
    lastAttemptAt: new Date(), amendNoticeAt: new Date(), order: { id: 'so-1', orderNumber: 'SO-1', externalOrderNumber: null },
  })
  assert.equal(row.why, 'Change not sent to the warehouse (merged order)')
  assert.equal(row.acknowledgeable, true)
  assert.match(String(row.replayRefusal), /Apply the change in the warehouse by hand, then acknowledge/)
  // Without the notice the same link is not acknowledgeable.
  assert.equal(buildBlockedWmsPushRow({
    orderId: 'so-1', connector: 'mintsoft', state: 'MERGED', attempts: 0, externalOrderId: 'M-1', pushedAt: new Date(), lastError: null,
    lastAttemptAt: new Date(), order: { id: 'so-1', orderNumber: 'SO-1', externalOrderNumber: null },
  }).acknowledgeable, false)
  // The inbox selection carries the amendment-notice clause.
  assert.ok(JSON.stringify(WMS_PUSH_INBOX_WHERE).includes('amendNoticeAt'))
})

test('ACKNOWLEDGE: clears the notice, records who did it, and says it clears only the row', async () => {
  reset()
  state.link = { id: 'link-1', externalOrderNumber: 'E+D', amendNoticeAt: new Date(), order: { orderNumber: 'SO-1' } }
  const { acknowledgeWmsAmendNotice } = await actions()
  const result = await acknowledgeWmsAmendNotice('so-1')
  assert.equal(result.success, true)
  assert.deepEqual(state.linkUpdates, [{ amendNoticeAt: null }])
  assert.equal(state.activity.length, 1)
  assert.equal(state.activity[0].action, 'wms_amend_notice_acknowledged')
  assert.match(String(state.activity[0].description), /clears only the exception row/)
})

test('ACKNOWLEDGE: an order with no link is refused and nothing is written', async () => {
  reset()
  const { acknowledgeWmsAmendNotice } = await actions()
  const result = await acknowledgeWmsAmendNotice('so-9')
  assert.equal(result.success, false)
  assert.deepEqual(state.linkUpdates, [])
})

test('INBOX ROW: a SYNCED link with an amendment notice is the order-number-mismatch row, acknowledgeable, with its own guidance', async () => {
  const { buildBlockedWmsPushRow } = await import('../lib/domain/wms/push-recovery-affordance.ts')
  const row = buildBlockedWmsPushRow({
    orderId: 'so-1', connector: 'mintsoft', state: 'SYNCED', attempts: 0, externalOrderId: 'M-1', pushedAt: new Date(), lastError: 'now X',
    lastAttemptAt: new Date(), amendNoticeAt: new Date(), order: { id: 'so-1', orderNumber: 'SO-1', externalOrderNumber: null },
  })
  assert.equal(row.why, 'Change not sent to the warehouse (order number mismatch)')
  assert.equal(row.acknowledgeable, true)
  assert.match(String(row.replayRefusal), /order number no longer matches IMS.*merged or renamed/)
})
