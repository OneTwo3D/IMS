import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-2k5r r3 — `replayWmsOrderPush` was the FOURTH writer that re-opens a WMS create, and the
 * only one with no guard on it: it read the link, decided, and then applied an unconditional
 * `update({ where: { id } })`.
 *
 * Two things follow, and both are tested here.
 *
 *  1. A STALE replay could land after another replay had already re-queued the link and a sweep had
 *     settled it SYNCED with a fresh warehouse id. The bare update reverted that settled link to
 *     PENDING_CREATE while KEEPING the new id and push stamp — and `createCandidates` selects on
 *     state alone, so the order was created in the warehouse a second time.
 *  2. Every dead letter reaching the replay is an AMBIGUOUS create: attempts is at MAX_ATTEMPTS by
 *     construction and each of those attempts THREW, which is as consistent with a timeout on a
 *     request the WMS honoured as with a rejection. Re-queueing without asking the warehouse is the
 *     same duplicate by a slower route.
 */

type LinkRow = {
  id: string
  orderId: string
  connector: string
  state: string
  attempts: number
  externalOrderId: string | null
  pushedAt: Date | null
}

const state = {
  links: [] as LinkRow[],
  /** Runs once, after the action's read and before its write — how a test moves the world. */
  mutateAfterRead: null as (() => void) | null,
  presence: 'MISSING' as 'FOUND' | 'MISSING' | 'AMBIGUOUS',
  probeSupported: true,
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

mock.module('@/lib/db', {
  namedExports: {
    db: {
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
    ...over,
  }
}

function reset(links: LinkRow[]) {
  state.activePlugins = { mintsoft: true }
  state.links = links
  state.mutateAfterRead = null
  state.presence = 'MISSING'
  state.probeSupported = true
  state.probedReferences = []
  state.activity = []
}

async function loadAction() {
  return (await import('@/app/actions/wms-order-push')).replayWmsOrderPush
}

test('o3d-2k5r r3 replay: a STALE replay cannot revert a link a sweep has already settled', async () => {
  // The fourth-writer hazard, exactly. Two operators press "re-queue"; the first replay wins, a
  // sweep pushes the order and settles the link SYNCED under a fresh warehouse id. The second
  // replay is still holding the dead letter it read, and the bare update applied it anyway —
  // PENDING_CREATE with the new id still on the row, which the create pass then pushes AGAIN.
  reset([deadLetter()])
  state.mutateAfterRead = () => {
    const row = state.links[0]
    row.state = 'SYNCED'
    row.attempts = 0
    row.externalOrderId = 'wms-99'
    row.pushedAt = new Date('2026-08-01T00:00:00.000Z')
  }
  const result = await (await loadAction())('so-1')

  assert.equal(result.success, false)
  assert.match(result.error!, /no longer the dead letter that was inspected/)
  const row = state.links[0]
  assert.equal(row.state, 'SYNCED', 'the settled link must be left alone')
  assert.equal(row.externalOrderId, 'wms-99')
  assert.deepEqual(state.activity, [], 'and a replay that changed nothing must not be logged as one')
})

test('o3d-2k5r r3 replay: the dead letter it DID inspect is re-queued — the guard has to be able to let go', async () => {
  reset([deadLetter()])
  const result = await (await loadAction())('so-1')

  assert.equal(result.success, true)
  const row = state.links[0]
  assert.equal(row.state, 'PENDING_CREATE')
  assert.equal(row.attempts, 0)
  assert.deepEqual(state.probedReferences, ['SO-1'], 'and it asked the warehouse about the reference the push uses')
  assert.equal(state.activity.length, 1)
})

test('o3d-2k5r r3 replay: a warehouse that ALREADY holds the order refuses the replay', async () => {
  // The ambiguous half. Five throws are not five proofs that nothing arrived — the first one may
  // have been a timeout on a create the WMS went on to honour.
  reset([deadLetter()])
  state.presence = 'FOUND'
  const result = await (await loadAction())('so-1')

  assert.equal(result.success, false)
  assert.match(result.error!, /already holds an order under reference SO-1/i)
  assert.equal(state.links[0].state, 'DEAD_LETTER', 'nothing written')
})

test('o3d-2k5r r3 replay: an AMBIGUOUS match is not absence', async () => {
  reset([deadLetter()])
  state.presence = 'AMBIGUOUS'
  const result = await (await loadAction())('so-1')

  assert.equal(result.success, false)
  assert.match(result.error!, /ambiguous match/i)
  assert.equal(state.links[0].state, 'DEAD_LETTER')
})

test('o3d-2k5r r3 replay: a connector that cannot probe refuses rather than assuming', async () => {
  reset([deadLetter()])
  state.probeSupported = false
  const result = await (await loadAction())('so-1')

  assert.equal(result.success, false)
  assert.match(result.error!, /cannot check whether that order exists/i)
  assert.equal(state.links[0].state, 'DEAD_LETTER')
})

test('o3d-2k5r r3 replay: a dead letter belonging to a connector that is not active is refused', async () => {
  // Probing the WRONG warehouse and getting MISSING is not evidence about this order at all.
  // mintsoft's create IS replay-safe, so the only thing that can refuse here is the active-connector
  // check — which is what keeps this test about that check rather than about the replay policy.
  reset([deadLetter({ connector: 'mintsoft' })])
  state.activePlugins = { shiphero: true }
  const result = await (await loadAction())('so-1')

  assert.equal(result.success, false)
  assert.match(result.error!, /not the active one/)
  assert.deepEqual(state.probedReferences, [])
  assert.equal(state.links[0].state, 'DEAD_LETTER')
})

test('o3d-2k5r r4 replay: a connector whose create cannot be repeated safely is refused before anything is asked', async () => {
  // ShipHero's order_create does not enforce partner_order_id uniqueness, so its only dedupe is a
  // preflight lookup that cannot see a request still on the wire. No answer the warehouse could
  // give would licence this replay, so nothing is asked and the refusal names WMS-side actions.
  reset([deadLetter({ connector: 'shiphero' })])
  const result = await (await loadAction())('so-1')

  assert.equal(result.success, false)
  assert.match(result.error!, /not safe to repeat/i)
  assert.match(result.error!, /second warehouse order/i)
  assert.deepEqual(state.probedReferences, [], 'a probe could not have changed the answer, so none was spent')
  assert.equal(state.links[0].state, 'DEAD_LETTER', 'nothing written')
})
