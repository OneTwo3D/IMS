import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * Replay on a parked "create outcome unknown" row whose order the warehouse ALREADY HOLDS: an exact match (the warehouse's own record
 * carries this order's reference) is LINKED, as an unverified id, instead of being refused; anything not provably this order is
 * refused with the reason and nothing is written; and the write is a compare-and-set on the row that was inspected. The warehouse is a
 * double: nothing leaves the box.
 */

type LinkRow = {
  id: string
  orderId: string
  connector: string
  state: string
  attempts: number
  externalOrderId: string | null
  pushedAt: Date | null
  /** o3d-2k5r r4: the dispatch stamp. A re-queue that leaves it set is parked straight back. */
  lastAttemptAt?: Date | null
  externalOrderNumber?: string | null
  lastError?: string | null
}

const state = {
  links: [] as LinkRow[],
  /** Runs once, after the action's read and before its write — how a test moves the world. */
  mutateAfterRead: null as (() => void) | null,
  presence: 'MISSING' as 'FOUND' | 'MISSING' | 'AMBIGUOUS',
  probeSupported: true,
  reconcile: { kind: 'NONE' } as { kind: 'ADOPT'; externalOrderId: string; externalOrderNumber: string } | { kind: 'UNRESOLVED'; reason: string } | { kind: 'NONE' },
  probedReferences: [] as string[],
  activity: [] as Array<Record<string, unknown>>,
  /** Which WMS connector plugin is enabled. Settable so "not the active one" can be tested for a
   *  connector whose create IS replay-safe, separately from the replay-policy refusal. */
  activePlugins: { mintsoft: true } as Record<string, boolean>,
}

function matches(row: LinkRow, where: Record<string, unknown>): boolean {
  for (const [key, expected] of Object.entries(where)) {
    const actual = (row as unknown as Record<string, unknown>)[key]
    if (expected instanceof Date) {
      if (!(actual instanceof Date) || actual.getTime() !== expected.getTime()) return false
      continue
    }
    if (actual !== expected) return false
  }
  return true
}

const shadowRecords: Array<[string, string]> = []

mock.module('@/lib/db', {
  namedExports: {
    db: {
      // The producer-side hold's shadow store (outbound_shadow_writes) and the order read for the business-event time.
      $queryRaw: async (query?: { strings?: readonly string[]; values?: readonly unknown[] }) => {
        if ((query?.strings ?? []).join('?').includes('outbound_shadow_writes')) {
          shadowRecords.push([String(query?.values?.[1]), String(query?.values?.[3])])
          return [{ id: 'shadow-1', inserted: true, occurrences: shadowRecords.length, accounting_sync_log_id: null, sync_row_exists: false }]
        }
        return []
      },
      $executeRaw: async () => 1,
      salesOrder: { findUnique: async () => ({ paidAt: new Date('2026-08-01T00:00:00.000Z'), createdAt: new Date('2026-08-01T00:00:00.000Z') }) },
      wmsOrderPushLink: {
        findUnique: async ({ where }: { where: { orderId: string } }) => {
          const row = state.links.find((l) => l.orderId === where.orderId)
          if (!row) return null
          return {
            ...row,
            order: { id: row.orderId, orderNumber: 'SO-1', externalOrderNumber: null },
          }
        },
        // The CAS, modelled the way Prisma implements it: a predicate over columns, applied to the
        // row AS IT IS AT WRITE TIME. A double that matched on the id alone could not fail on the
        // bare update this test exists to reject.
        updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          state.mutateAfterRead?.()
          state.mutateAfterRead = null
          const hits = state.links.filter((row) => matches(row, where))
          for (const row of hits) Object.assign(row, data)
          return { count: hits.length }
        },
        // Present so a regression to the bare form still RUNS (and then fails on the assertions)
        // rather than exploding on a missing method, which would read as an unrelated breakage.
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          state.mutateAfterRead?.()
          state.mutateAfterRead = null
          const row = state.links.find((l) => l.id === where.id)
          if (row) Object.assign(row, data)
          return row
        },
      },
    },
  },
})

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'op-1' } }),
    requireInternalUser: async () => ({ user: { id: 'op-1' } }),
  },
})

mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async (entry: Record<string, unknown>) => { state.activity.push(entry) } },
})

mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })

mock.module('@/lib/integration-plugins', {
  namedExports: { getIntegrationPluginState: async () => state.activePlugins },
})

mock.module('@/lib/connectors/wms/registry', {
  namedExports: {
    getWmsConnector: () => ({
      id: 'mintsoft',
      verifyPushedOrder: async () => 'ours',
      reconcileAmbiguousCreate: async () => state.reconcile,
      probeOrderPresence: state.probeSupported
        ? async (orderNumber: string) => { state.probedReferences.push(orderNumber); return state.presence }
        : undefined,
    }),
  },
})

function deadLetter(over: Partial<LinkRow> = {}): LinkRow {
  return {
    id: 'link-1',
    orderId: 'so-1',
    connector: 'mintsoft',
    state: 'DEAD_LETTER',
    attempts: 5,
    externalOrderId: null,
    pushedAt: null,
    lastAttemptAt: new Date('2026-08-01T00:00:00.000Z'),
    externalOrderNumber: null,
    lastError: null,
    ...over,
  }
}

/** o3d-2k5r r4: the park a crashed create claim lands in. Same columns, different state. */
function ambiguousCreate(over: Partial<LinkRow> = {}): LinkRow {
  return deadLetter({ state: 'AMBIGUOUS_CREATE', attempts: 1, ...over })
}

function reset(links: LinkRow[]) {
  state.activePlugins = { mintsoft: true }
  state.links = links
  state.mutateAfterRead = null
  state.presence = 'MISSING'
  state.probeSupported = true
  state.reconcile = { kind: 'NONE' }
  state.probedReferences = []
  state.activity = []
}

async function loadAction() {
  return (await import('@/app/actions/wms-order-push')).replayWmsOrderPush
}


test('replay: the warehouse already holds the order under its own reference -> LINKED as PENDING_VERIFY, no create queued', async () => {
  reset([ambiguousCreate()])
  state.presence = 'FOUND'
  state.reconcile = { kind: 'ADOPT', externalOrderId: '555', externalOrderNumber: 'SO-1' }
  const result = await (await loadAction())('so-1')
  assert.equal(result.success, true)
  const row = state.links[0]
  assert.equal(row.state, 'PENDING_VERIFY')
  assert.equal(row.externalOrderId, '555')
  assert.equal(row.attempts, 0)
  assert.equal(state.activity.length, 1)
  assert.equal(state.activity[0].action, 'wms_push_linked')
})

test('replay: a match that is not provably this order is refused with the reason and writes nothing', async () => {
  reset([ambiguousCreate()])
  state.presence = 'FOUND'
  state.reconcile = { kind: 'UNRESOLVED', reason: 'two orders match' }
  const result = await (await loadAction())('so-1')
  assert.equal(result.success, false)
  assert.match(result.error!, /cannot be proved to be this order: two orders match/)
  assert.equal(state.links[0].state, 'AMBIGUOUS_CREATE')
  assert.equal(state.links[0].externalOrderId, null)
  assert.deepEqual(state.activity, [])
})

test('replay: the link is a compare-and-set - a link another worker moved on is not overwritten', async () => {
  reset([ambiguousCreate()])
  state.presence = 'FOUND'
  state.reconcile = { kind: 'ADOPT', externalOrderId: '555', externalOrderNumber: 'SO-1' }
  state.mutateAfterRead = () => { state.links[0].state = 'SYNCED'; state.links[0].externalOrderId = 'wms-99' }
  const result = await (await loadAction())('so-1')
  assert.equal(result.success, false)
  assert.equal(state.links[0].externalOrderId, 'wms-99')
})
