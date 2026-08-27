import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
/**
 * o3d-2k5r r6: order-push-sweep is loaded LAZILY, after `mock.module('@/lib/db')` has run.
 *
 * A static import here is evaluated before any mock is registered, so the copy of the sweep module
 * this file would hold binds the REAL Prisma client — and the action now reaches into that module
 * for the shared create predicate, which would then try to open a Postgres connection from a unit
 * test. The lazy accessor is what keeps the mocked db the only one in play.
 */
const decideCreateClaim = async (...args: Parameters<
  typeof import('../lib/domain/wms/order-push-sweep.ts')['decideCreateClaim']
>) => (await import('../lib/domain/wms/order-push-sweep.ts')).decideCreateClaim(...args)

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
  /**
   * o3d-2k5r r6: runs once when the WRITE TRANSACTION opens — after every read the action made
   * while deciding, before the eligibility it re-proves under the row lock. This is the window the
   * in-transaction check exists for: a binding deactivated between the page and the click.
   */
  mutateInTransaction: null as (() => void) | null,
  /** The sales order the shared create predicate is evaluated against. */
  order: null as Row | null,
  /** Warehouses the ACTIVE connector currently has an active binding for. */
  bindings: [] as Array<{ warehouseId: string }>,
}

/**
 * o3d-2k5r r6 — a strict evaluator for the SHARED create predicate.
 *
 * Deliberately generic over whatever `wmsCreateEligibleOrderWhere` produces, and it THROWS on an
 * operator it does not implement. A fence added to create-eligibility.ts therefore either works
 * here or fails this suite loudly; a double that silently ignored unknown keys would report every
 * new fence as satisfied, which is the failure mode this whole finding is about.
 */
function matchesOrderWhere(row: Row, where: Row): boolean {
  for (const [key, cond] of Object.entries(where)) {
    const actual = row[key]
    if (cond === null) {
      if (actual !== null && actual !== undefined) return false
      continue
    }
    if (cond instanceof Date || typeof cond !== 'object') {
      if (actual !== cond) return false
      continue
    }
    const c = cond as Row
    if ('in' in c) {
      if (!(c.in as unknown[]).includes(actual)) return false
      continue
    }
    if ('not' in c) {
      if (c.not === null) {
        if (actual === null || actual === undefined) return false
        continue
      }
      if (actual === c.not) return false
      continue
    }
    throw new Error(`the create predicate grew an operator this double does not implement: ${key} ${JSON.stringify(cond)}`)
  }
  return true
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
  salesOrder: {
    findMany: async ({ where }: { where: Row }) => {
      const { id, ...fences } = where
      const ids = id && typeof id === 'object' && 'in' in (id as Row) ? ((id as Row).in as string[]) : [id as string]
      if (!state.order || !ids.includes(state.order.id as string)) return []
      return matchesOrderWhere(state.order, fences) ? [{ id: state.order.id }] : []
    },
    findFirst: async ({ where }: { where: Row }) => {
      const { id, ...fences } = where
      if (!state.order || state.order.id !== id) return null
      return matchesOrderWhere(state.order, fences) ? { id: state.order.id } : null
    },
  },
  externalWmsBinding: {
    findMany: async () => state.bindings,
  },
  // The `SELECT ... FOR UPDATE` the in-transaction eligibility check takes on the sales order.
  $queryRaw: async () => (state.order ? [{ id: state.order.id }] : []),
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
        state.mutateInTransaction?.()
        state.mutateInTransaction = null
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
  state.mutateInTransaction = null
  state.bindings = [{ warehouseId: 'wh-1' }]
  state.order = {
    id: 'so-1',
    status: 'PROCESSING',
    paidAt: PUSHED,
    refundStatus: 'NONE',
    withdrawalHoldAt: null,
    withdrawalApprovedAt: null,
    shipFromWarehouseId: 'wh-1',
  }
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
    order: { id: 'so-1', orderNumber: 'SO-1', externalOrderNumber: null },
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
  assert.equal(await decideCreateClaim({ state: 'PENDING_CREATE', lastAttemptAt: null }, new Date()), 'CLAIM',
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
    await decideCreateClaim({ state: 'PENDING_CREATE', lastAttemptAt: link.lastAttemptAt as Date | null }, new Date()),
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

// --- o3d-2k5r r6: the COMPLETE create predicate, not three of its six fences ---------------

test('o3d-2k5r r5 repush: an order the create pass would not select is refused, finding kept', async () => {
  // Codex r30 P1: resetting the link for a PICKING order resolves the finding while the order is
  // never re-created — it silently never fulfils.
  //
  // Route: wmsCreateEligibleOrderIds evaluates the SHARED where-clause against the order (status
  // fails `in [PROCESSING, ALLOCATED]`) -> decideWmsMissingRepush answers `not-create-eligible`.
  //
  // Mutation: drop `status` from WMS_CREATE_ELIGIBLE_ORDER_FENCES and this fails — which is the
  // point of routing it through the shared constant rather than an inline check: the assertion now
  // guards the predicate every reader uses, not a copy of it living in this action.
  reset()
  state.order!.status = 'PICKING'
  const result = await (await repush())('so-1')

  assert.equal(result.success, false)
  assert.match(result.error!, /paid and ready \(Processing\/Allocated\)/)
  assert.equal(state.finding!.status, 'OPEN')
  assert.deepEqual(state.probed, [], 'and no connector call is spent on a decision already made')
})

test('o3d-2k5r r6 repush: an order whose warehouse binding was DISABLED is refused, not silently stranded', async () => {
  // THE FINDING. The action checked status, paidAt and refundStatus by hand and stopped there, so
  // an order whose binding had been deactivated since the discrepancy was raised probed clean, had
  // its link reset, had the finding RESOLVED, and returned success — while `createCandidates`
  // (which filters `shipFromWarehouseId in boundWarehouseIds`) never selected it again. Nothing
  // could raise it either: MISSING_IN_WMS scans settled links, NOT_PUSHED scans actively bound
  // warehouses. The order simply disappeared.
  //
  // Route: activeBoundWarehouseIds returns nothing -> the shared predicate matches nothing ->
  // refused before the probe.
  //
  // Mutation: restore the hand-written status/paidAt/refundStatus check in place of
  // `wmsCreateEligibleOrderIds` and this fails on all three assertions — the order is reset and the
  // finding resolved, exactly as before.
  reset()
  state.bindings = []
  const result = await (await repush())('so-1')

  assert.equal(result.success, false)
  assert.match(result.error!, /ACTIVE binding/)
  assert.equal(state.finding!.status, 'OPEN', 'the finding is the only trace of this order — it stays')
  assert.equal(state.link!.state, 'SYNCED', 'and the link is untouched')
  // Refused BEFORE the warehouse is asked anything. This is what distinguishes the up-front
  // eligibility read from the in-transaction re-proof that backs it up: an order that can never be
  // re-pushed must not spend a connector call finding that out, and if the up-front check went
  // missing the probe would run before the transaction refused.
  assert.deepEqual(state.probed, [])
})

test('o3d-2k5r r6 repush: an order moved to an UNBOUND warehouse is refused', async () => {
  // Route: the binding list is non-empty but does not contain the order's ship-from warehouse, so
  // `shipFromWarehouseId: { in: [...] }` fails.
  //
  // Mutation: drop `shipFromWarehouseId` from wmsCreateEligibleOrderWhere and this fails — the
  // fence that distinguishes "this connector fulfils from that warehouse" from "any warehouse".
  reset()
  state.order!.shipFromWarehouseId = 'wh-OTHER'
  const result = await (await repush())('so-1')

  assert.equal(result.success, false)
  assert.match(result.error!, /ACTIVE binding/)
  assert.equal(state.finding!.status, 'OPEN')
})

test('o3d-2k5r r6 repush: a customer WITHDRAWAL fence refuses the re-push', async () => {
  // Route: `withdrawalHoldAt: null` fails. o3d-e1yb — an order the customer has asked to withdraw
  // must never re-enter fulfilment, and the re-push is a fulfilment path like any other.
  //
  // Mutation: drop either withdrawal fence from WMS_CREATE_ELIGIBLE_ORDER_FENCES and one of these
  // two halves fails. The approval half is separate on purpose: a DIRECT approval records only the
  // approval fact until its cancellation finishes, so the hold alone leaves a window.
  reset()
  state.order!.withdrawalHoldAt = new Date('2026-08-25T09:00:00.000Z')
  assert.equal((await (await repush())('so-1')).success, false)

  reset()
  state.order!.withdrawalApprovedAt = new Date('2026-08-25T09:00:00.000Z')
  assert.equal((await (await repush())('so-1')).success, false)
  assert.equal(state.finding!.status, 'OPEN')
})

test('o3d-2k5r r6 repush: eligibility lost between the read and the write rolls the whole thing back', async () => {
  // A render-time answer is a statement about the past. Route: every read passes, the transaction
  // opens, the binding is deactivated inside that window, `isWmsCreateEligibleForUpdate` (under the
  // sales order's row lock) answers false -> throw -> the finding resolution rolls back with it.
  //
  // Mutation: move the in-transaction check outside `db.$transaction`, or delete it, and this fails
  // on the finding's status: it would be RESOLVED while the link reset was never going to help. The
  // finding vanishing from the inbox is the whole harm — the order becomes invisible to every
  // sweep that could have raised it again.
  reset()
  state.mutateInTransaction = () => { state.bindings = [] }
  const result = await (await repush())('so-1')

  assert.equal(result.success, false)
  assert.match(result.error!, /ACTIVE binding/)
  assert.equal(state.finding!.status, 'OPEN', 'rolled back with the refusal')
  assert.equal(state.link!.state, 'SYNCED')
})
