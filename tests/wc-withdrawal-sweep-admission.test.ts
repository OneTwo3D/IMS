import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-tj6v r4: the withdrawal RECOVERY sweep is an import path, and the admission boundary applies
 * to it.
 *
 * Round 3 put "Import order statuses" in front of the order webhook and left this route open.
 * `sweepWithdrawalSuppressions` exists precisely for the order no other ingress reaches — a
 * withdrawal rejected back into a status the poll does not query — and it fetches that order BY ID:
 * no `?status=` query, no cursor, nothing upstream that has filtered it. So the one path built to
 * import orders the selection excludes imported them regardless of the selection, and the operator
 * who unticked `pending` still got `pending` orders through it.
 *
 * The tombstone is NOT resolved by the refusal: it is the order's only durable retry signal, and
 * deleting it while declining to import would strand the order permanently — the exact failure the
 * sweep was built to prevent. Tick the status and the next sweep imports it.
 */

type Row = Record<string, unknown>

const SUPPRESSION_ROW = () => ({
  connector: 'woocommerce',
  externalOrderId: '901',
  wcStatus: 'pending-wdraw',
  revision: 1,
  claimToken: null as string | null,
  claimedAt: null as Date | null,
  clearPendingSince: null as Date | null,
  retiredAt: null as Date | null,
  lastCheckedAt: null as Date | null,
})

const state = {
  row: SUPPRESSION_ROW(),
  /** The live storefront status the sweep will read back for the tombstoned order. */
  liveStatus: 'pending',
  configuredStatuses: JSON.stringify(['processing']),
  /** Every (id, admitCreate) importWcOrder was actually asked to perform. */
  importCalls: [] as Array<{ id: number; admitCreate: unknown }>,
  imported: [] as number[],
  activity: [] as Row[],
}

mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async (entry: Row) => { state.activity.push(entry) } },
})

mock.module('@/lib/settings-store', {
  namedExports: {
    getSettingValues: async (keys: string[]) => new Map(keys.map((key) => [key, undefined])),
    getSettingValue: async () => null,
  },
})

mock.module('@/lib/connectors/woocommerce/api', {
  namedExports: {
    wcFetch: async () => ({
      data: { id: 901, number: '901', status: state.liveStatus, line_items: [], meta_data: [] },
      totalPages: 1,
      totalItems: 1,
    }),
    wcPut: async () => ({ data: null }),
  },
})

/**
 * Models the production contract: an unheld order whose create is not admitted imports nothing and
 * says so. A double that imported unconditionally would make this whole file vacuous.
 */
mock.module('@/lib/connectors/woocommerce/sync/order-import', {
  namedExports: {
    importWcOrder: async (order: { id: number }, options: Record<string, unknown> = {}) => {
      state.importCalls.push({ id: order.id, admitCreate: options.admitCreate })
      if (options.admitCreate === false) return { success: true, skipped: 'status_not_admitted' }
      state.imported.push(order.id)
      return { success: true, orderId: 'so-new' }
    },
    noteWcOrderAdmissionRefusal: async () => {},
  },
})

mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: {
        findUnique: async ({ where }: { where: { key: string } }) => (
          where.key === 'wc_sync_order_statuses' ? { value: state.configuredStatuses } : null
        ),
        upsert: async () => ({}),
      },
      shoppingOrderLink: { findUnique: async () => null },
      wcWithdrawalSuppression: {
        findMany: async () => [{ externalOrderId: state.row.externalOrderId, retiredAt: state.row.retiredAt }],
        findUnique: async () => ({ ...state.row }),
        upsert: async ({ update }: { update?: Row } = {}) => {
          Object.assign(state.row, update ?? {})
          return { ...state.row }
        },
        create: async () => ({ ...state.row }),
        update: async ({ data }: { data: Row }) => {
          Object.assign(state.row, data)
          return { ...state.row }
        },
        updateMany: async ({ where, data }: { where: Row; data: Row }) => {
          if (where.revision !== undefined && where.revision !== state.row.revision) return { count: 0 }
          if (where.claimToken !== undefined && where.claimToken !== state.row.claimToken) return { count: 0 }
          Object.assign(state.row, data)
          return { count: 1 }
        },
        // Reached only if a refusal wrongly resolves the tombstone.
        delete: async () => { throw new Error('the tombstone must survive a refusal') },
        deleteMany: async () => { throw new Error('the tombstone must survive a refusal') },
      },
    },
  },
})

function reset() {
  state.row = SUPPRESSION_ROW()
  state.liveStatus = 'pending'
  state.configuredStatuses = JSON.stringify(['processing'])
  state.importCalls = []
  state.imported = []
  state.activity = []
}

async function sweep() {
  const { sweepWithdrawalSuppressions } = await import('@/lib/connectors/woocommerce/sync/withdrawal')
  return sweepWithdrawalSuppressions()
}

test('a recovered order whose status the operator excluded is NOT imported', async () => {
  reset()
  // The withdrawal was rejected: the storefront now says `pending`, which is not ticked. This is
  // the exact order the sweep exists for, and exactly the order the selection says to leave alone.
  const result = await sweep()

  assert.deepEqual(
    state.importCalls,
    [{ id: 901, admitCreate: false }],
    'the sweep must put the recovered order through the same admission the webhook uses',
  )
  assert.deepEqual(state.imported, [], 'an excluded status must not enter IMS by the recovery route')
  assert.equal(result.notAdmitted, 1)
  assert.equal(result.imported, 0)
})

test('the tombstone SURVIVES the refusal, so ticking the status still recovers the order', async () => {
  reset()
  await sweep()
  // The db double throws on any delete; reaching here at all is the assertion. The claim must also
  // be handed back, or the row would be leased out for the whole lease window on every pass.
  assert.equal(state.row.claimToken, null, 'the claim must be released, not held')
  assert.ok(state.row.lastCheckedAt, 'and the attempt must still rotate the queue')
})

test('the sweep DISCRIMINATES — a recovered order in a selected status still imports', async () => {
  // Paired: "an excluded order is not imported" also passes if the sweep imports nothing at all.
  reset()
  state.configuredStatuses = JSON.stringify(['processing', 'pending'])

  const result = await sweep()

  assert.deepEqual(state.importCalls, [{ id: 901, admitCreate: true }])
  assert.deepEqual(state.imported, [901], 'the recovery route must still recover what the operator wants')
  assert.equal(result.imported, 1)
  assert.equal(result.notAdmitted, 0)
})

test('a still-withdrawn order is admitted whatever the selection, and the sweep says so', async () => {
  // o3d-e1yb: a withdrawal that is never seen means an order the customer asked to stop carries on
  // to the warehouse, so the withdrawal statuses are never the operator's to exclude.
  reset()
  state.liveStatus = 'withdrawn'

  const result = await sweep()

  assert.equal(result.stillWithdrawn, 1)
  assert.deepEqual(state.imported, [])
})
