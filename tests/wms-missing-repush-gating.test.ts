import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { decideCreateClaim } from '../lib/domain/wms/order-push-sweep.ts'

/**
 * o3d-2k5r r5 — `repushMissingWmsOrder` IS THE FIFTH WRITER THAT RE-OPENS A WMS CREATE, and it was
 * cleared as "already correct" a round ago because it probes the warehouse first. It was wrong in
 * BOTH directions, and both are asserted here.
 *
 *  1. THE FALSE PARK. The reset left `lastAttemptAt` — the dispatch stamp — on the row.
 *     `decideCreateClaim` reads a PENDING_CREATE link carrying a stamp older than the lease as
 *     PARK_AMBIGUOUS, so the next sweep parked the order it had supposedly just re-queued. The
 *     action had already RESOLVED the discrepancy and reported success, so the operator saw the
 *     finding leave the inbox while the order left the create queue. On ShipHero that park has no
 *     automatic exit at all.
 *  2. THE BYPASS. On a link whose stamp was null (a legacy row, a restore) the claim was GRANTED
 *     and the create re-dispatched on the presence probe ALONE — the two-key rule skipped entirely,
 *     and on ShipHero that is two warehouse orders under one reference.
 *
 * The gate is the connector's own create-replay contract, taken before anything is asked of the
 * warehouse. It closes both directions at once, because on a connector that cannot repeat a create
 * safely nothing is written at all — stamp or no stamp.
 */

type Row = Record<string, unknown>

const state = {
  link: null as Row | null,
  finding: null as Row | null,
  activePlugins: { mintsoft: true } as Record<string, boolean>,
  presence: new Map<string, 'FOUND' | 'MISSING' | 'AMBIGUOUS'>(),
  probeSupported: true,
  probed: [] as string[],
  activity: [] as Row[],
  /** Runs once, after the action's reads and before its write — how a test moves the world. */
  mutateBeforeWrite: null as (() => void) | null,
}

function matches(row: Row, where: Row): boolean {
  for (const [key, expected] of Object.entries(where)) {
    if (key === 'order') continue
    const actual = row[key]
    if (expected instanceof Date) {
      if (!(actual instanceof Date) || actual.getTime() !== expected.getTime()) return false
      continue
    }
    if (actual !== expected) return false
  }
  return true
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
mock.module('@/lib/integration-plugins', {
  namedExports: {
    getIntegrationPluginState: async () => state.activePlugins,
    INTEGRATION_PLUGIN_SETTING_KEYS: {},
  },
})
mock.module('@/lib/connectors/wms/registry', {
  namedExports: {
    getWmsConnector: (id: string) => ({
      id,
      probeOrderPresence: state.probeSupported
        ? async (reference: string) => { state.probed.push(reference); return state.presence.get(reference) ?? 'MISSING' }
        : undefined,
    }),
  },
})

/**
 * One client shape for the direct calls and the transaction. The transaction is what makes "the
 * discrepancy is resolved ONLY when the safe requeue commits" true, so the double rolls back the
 * way Postgres does: it undoes the writes THIS transaction made, and nothing else. A concurrent
 * worker's write committed in its own transaction and must survive — a double that restored a whole
 * snapshot would hide the very thing the stale-CAS test is checking.
 */
const journal: Array<{ target: Row; before: Row }> = []
let journalling = false

function applyWrite(target: Row, data: Row) {
  if (journalling) journal.push({ target, before: { ...target } })
  Object.assign(target, data)
}

const client = {
  wmsOrderDiscrepancy: {
    findFirst: async () => (state.finding && state.finding.status === 'OPEN' ? { connector: state.finding.connector } : null),
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      if (!state.finding || !matches(state.finding, where)) return { count: 0 }
      applyWrite(state.finding, data)
      return { count: 1 }
    },
  },
  wmsOrderPushLink: {
    findUnique: async () => state.link,
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      state.mutateBeforeWrite?.()
      state.mutateBeforeWrite = null
      if (!state.link || !matches(state.link, where)) return { count: 0 }
      applyWrite(state.link, data)
      return { count: 1 }
    },
  },
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      ...client,
      $transaction: async (fn: (tx: typeof client) => Promise<unknown>) => {
        journal.length = 0
        journalling = true
        try {
          const out = await fn(client)
          return out
        } catch (error) {
          for (const entry of journal.reverse()) {
            for (const key of Object.keys(entry.before)) entry.target[key] = entry.before[key]
          }
          throw error
        } finally {
          journalling = false
          journal.length = 0
        }
      },
    },
  },
})

async function repush() {
  return (await import('../app/actions/sync-exceptions.ts')).repushMissingWmsOrder
}

const STAMP = new Date('2026-08-20T09:00:00.000Z')
const PUSHED = new Date('2026-08-19T09:00:00.000Z')

function reset(over: Row = {}, connector = 'mintsoft') {
  state.activePlugins = { [connector]: true }
  state.presence = new Map()
  state.probeSupported = true
  state.probed = []
  state.activity = []
  state.mutateBeforeWrite = null
  state.finding = { orderId: 'so-1', category: 'MISSING_IN_WMS', status: 'OPEN', connector }
  state.link = {
    id: 'link-1',
    orderId: 'so-1',
    connector,
    state: 'SYNCED',
    attempts: 1,
    externalOrderId: 'wms-7',
    externalOrderNumber: 'SO-1',
    pushedAt: PUSHED,
    lastAttemptAt: STAMP,
    order: { id: 'so-1', orderNumber: 'SO-1', externalOrderNumber: null, status: 'PROCESSING', paidAt: PUSHED, refundStatus: 'NONE' },
    ...over,
  }
}

// --- the connector contract, in both stamp shapes ---------------------------------------

test('o3d-2k5r r5 repush: a STAMPED ShipHero link is refused — no probe, no write, finding stays OPEN', async () => {
  // Route: finding read -> link read -> connector match -> decideWmsMissingRepush REFUSES
  // (shiphero is client-side-dedupe-only) -> return. Pre-fix this reset the link and left the stamp,
  // so the next sweep parked the order AMBIGUOUS_CREATE with the finding already resolved — and on
  // ShipHero that park never opens by itself.
  reset({}, 'shiphero')
  const result = await (await repush())('so-1')

  assert.equal(result.success, false)
  assert.match(result.error!, /does not refuse a duplicate/)
  assert.match(result.error!, /Open the WMS and search for SO-1/)
  assert.deepEqual(state.probed, [], 'no answer the warehouse could give would change this, so none was spent')
  assert.equal(state.link!.state, 'SYNCED', 'nothing written')
  assert.equal(state.finding!.status, 'OPEN', 'and the finding stays where a person can see it')
  assert.deepEqual(state.activity, [])
})

test('o3d-2k5r r5 repush: a NULL-STAMP ShipHero link is refused too — the bypass is closed by the same gate', async () => {
  // Route: identical, and that is the point. A link with no dispatch stamp used to read as CLAIM,
  // so the sweep re-dispatched the create on the presence probe ALONE — the two-key rule skipped.
  // The refusal is a property of the CONNECTOR, so the stamp cannot route around it.
  reset({ lastAttemptAt: null }, 'shiphero')
  assert.equal(decideCreateClaim({ state: 'PENDING_CREATE', lastAttemptAt: null }, new Date()), 'CLAIM',
    'precondition: a null stamp is exactly what the sweep would have granted a create on')

  const result = await (await repush())('so-1')

  assert.equal(result.success, false)
  assert.match(result.error!, /does not refuse a duplicate/)
  assert.deepEqual(state.probed, [])
  assert.equal(state.link!.state, 'SYNCED', 'nothing written')
  assert.equal(state.finding!.status, 'OPEN')
})

// --- the connector that CAN, and what the requeue has to look like ----------------------

test('o3d-2k5r r5 repush: a replay-safe connector re-queues, and CLEARS the stamp so the sweep claims it', async () => {
  // Route: connector contract passes -> both references probed MISSING -> transaction: finding
  // RESOLVED + CAS on every inspected column -> PENDING_CREATE with lastAttemptAt and pushedAt null.
  reset()
  const result = await (await repush())('so-1')

  assert.equal(result.success, true)
  assert.deepEqual(state.probed, ['SO-1'], 'the warehouse was asked about the reference a re-create would use')
  const link = state.link!
  assert.equal(link.state, 'PENDING_CREATE')
  assert.equal(link.externalOrderId, null)
  assert.equal(link.attempts, 0)
  // THE FIX, and the thing the whole finding turns on. With the stamp left on, decideCreateClaim
  // parks the link that was just re-queued.
  assert.equal(link.lastAttemptAt, null)
  assert.equal(
    decideCreateClaim({ state: 'PENDING_CREATE', lastAttemptAt: link.lastAttemptAt as Date | null }, new Date()),
    'CLAIM',
    'the re-queued link must be claimable — a stamp left on would make this PARK_AMBIGUOUS',
  )
  // ...and pushedAt too, or `wmsOrderMayExist` stays true for a link that carries no warehouse
  // order, which is the first gate of the revalidation and ambiguous-create passes.
  assert.equal(link.pushedAt, null)
  assert.equal(state.finding!.status, 'RESOLVED')
  assert.equal(state.activity.length, 1)
})

test('o3d-2k5r r5 repush: the stamp a STALE link carries is never cleared — the CAS names it', async () => {
  // A concurrent sweep claims the link (stamping it) between this action's read and its write.
  // Clearing a stamp it never inspected would wipe that worker's create claim and license a second
  // create; the CAS has to match nothing instead, and the finding must roll back with it.
  reset()
  // ONLY the stamp is moved, so this isolates the conjunct the fix added. The pre-fix CAS named
  // orderId, state and externalOrderNumber — all three still match here — and it cleared
  // lastAttemptAt in the same write.
  const freshClaim = new Date('2026-08-27T12:00:00.000Z')
  state.mutateBeforeWrite = () => { state.link!.lastAttemptAt = freshClaim }
  const result = await (await repush())('so-1')

  assert.equal(result.success, false)
  assert.match(result.error!, /changed while you were looking at it/)
  assert.equal((state.link!.lastAttemptAt as Date).getTime(), freshClaim.getTime(), 'the live claim survives')
  assert.equal(state.finding!.status, 'OPEN', 'and the discrepancy is resolved ONLY when the requeue commits')
})

test('o3d-2k5r r5 repush: BOTH references are asked, and a hit on either one refuses', async () => {
  // The recorded WMS reference and the reference a re-create would push under are not always the
  // same string, and "absent under one of them" is not absence.
  reset({ externalOrderNumber: 'WMS-99' })
  state.presence.set('WMS-99', 'FOUND')
  const result = await (await repush())('so-1')

  assert.equal(result.success, false)
  assert.match(result.error!, /knows order WMS-99 again/)
  assert.deepEqual(state.probed, ['SO-1', 'WMS-99'])
  assert.equal(state.link!.state, 'SYNCED', 'nothing written')
  assert.equal(state.finding!.status, 'RESOLVED', 'a stale finding is retired rather than left to be re-pressed')
})

test('o3d-2k5r r5 repush: an AMBIGUOUS match is not absence', async () => {
  reset()
  state.presence.set('SO-1', 'AMBIGUOUS')
  const result = await (await repush())('so-1')

  assert.equal(result.success, false)
  assert.match(result.error!, /ambiguous match/i)
  assert.equal(state.link!.state, 'SYNCED')
  assert.equal(state.finding!.status, 'OPEN')
})

test('o3d-2k5r r5 repush: a link belonging to a connector that is not active is refused before the policy', async () => {
  // The link can outlive the connector that wrote it. Probing the WRONG warehouse and getting
  // MISSING is not weaker evidence — it is evidence about a different question.
  reset({ connector: 'shiphero' })
  state.finding!.connector = 'mintsoft'
  const result = await (await repush())('so-1')

  assert.equal(result.success, false)
  assert.match(result.error!, /belongs to shiphero, which is not the active WMS connector/)
  assert.deepEqual(state.probed, [])
  assert.equal(state.link!.state, 'SYNCED')
})

test('o3d-2k5r r5 repush: a link that is not a settled push has no missing warehouse order to re-create', async () => {
  reset({ state: 'PENDING_CREATE' })
  const result = await (await repush())('so-1')

  assert.equal(result.success, false)
  assert.match(result.error!, /is PENDING_CREATE, not a settled push/)
  assert.deepEqual(state.probed, [])
})

test('o3d-2k5r r5 repush: an order the create pass would not select is refused, finding kept', async () => {
  // Codex r30 P1: resetting the link for a PICKING order resolves the finding while the order is
  // never re-created — it silently never fulfils.
  reset()
  ;(state.link!.order as Row).status = 'PICKING'
  const result = await (await repush())('so-1')

  assert.equal(result.success, false)
  assert.match(result.error!, /paid, ready \(Processing\/Allocated\) orders/)
  assert.equal(state.finding!.status, 'OPEN')
})
