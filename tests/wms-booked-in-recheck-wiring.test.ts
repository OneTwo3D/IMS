/**
 * THE POST-MAINTENANCE BOOKED-IN RECHECK, DRIVEN THROUGH THE REAL REGISTRY ENTRY (o3d-j8yq).
 *
 * WHAT WAS UNCOVERED. `lib/domain/wms/post-maintenance-recheck.ts` used to read
 * `if (connectorId !== 'mintsoft') return null` and then call
 * `enqueueMintsoftBookedInRecheckForAsn` by name. o3d-remove-shiphero replaced both with
 * `hooks.bookedInRecheck` on the connector's registry entry — correctly — and nothing tested the
 * replacement. `runPostMaintenanceRecheckForActiveConnector` had exactly two references in the repo:
 * its own definition, and its one production caller (app/actions/sync-exceptions.ts). The test file
 * called only the CORE, `runPostMaintenanceBookedInRecheck`, with hand-built deps — the "the seam
 * stops at the core" pattern that same branch criticised twice.
 *
 * WHY THAT MATTERS MORE THAN A MISSING TEST USUALLY DOES. If the hook were dropped or renamed, the
 * resolver returns `null`, the caller reads `null` as "nothing to do", the marker is deliberately
 * LEFT SET, and nothing logs. The post-maintenance ASN reconstruction — the automatic recovery for
 * booked-in callbacks the maintenance fence refused, which is the only bound on an ASN left
 * IN_TRANSIT with its destination stock never applied — stops silently and permanently, and no
 * operator sees a thing.
 *
 * SO THIS DRIVES THE RESOLVER, NOT THE CORE, WITH THE SHIPPED REGISTRY IN PLACE. Nothing about
 * `lib/connectors/wms/registry.ts` is mocked. Delete `hooks.bookedInRecheck` from the Mintsoft
 * registration and the first two tests here go red.
 *
 * WHAT IS MOCKED, AND WHERE THE LINE IS. The database, the activity log, which plugins are on — and
 * `lib/jobs/wms/process-mintsoft-booked-in-event.ts`, which is the JOB-QUEUE boundary and also the
 * one module that must not run for real here: its `processMintsoftBookedInEvent` re-fetches the ASN
 * from the live warehouse. The double records WHICH MODULE the generic drain reached and with what
 * arguments; that routing is the whole of what is under test, and it is decided entirely inside the
 * unmocked registry.
 */
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// NO STATIC APP IMPORT — see tests/wms-dispatch-hook-wiring.test.ts. One would bind the real
// PrismaClient before the `@/lib/db` mock exists, and this test would read the development database.

const MAINTENANCE_ENABLED_KEY = 'system_maintenance_mode'
const WMS_BOOKED_IN_RECHECK_DUE_KEY = 'wms_booked_in_recheck_due_since'
const WINDOW_ENDED_AT = '2026-09-11T22:15:00.000Z'

/** The in-memory `settings` table. */
const rows = new Map<string, string>()
/** The open ASNs `wms_asn_maps` would return, and the query it was asked. */
let openAsns: Array<{ externalAsnId: string }> = []
const asnQueries: Array<Record<string, unknown>> = []

function resetDb() {
  rows.clear()
  rows.set(WMS_BOOKED_IN_RECHECK_DUE_KEY, WINDOW_ENDED_AT)
  openAsns = []
  asnQueries.length = 0
  enqueued.length = 0
}

const dbDouble = {
  setting: {
    async findUnique({ where }: { where: { key: string } }) {
      const value = rows.get(where.key)
      return value === undefined ? null : { key: where.key, value }
    },
    async deleteMany({ where }: { where: { key: { in: string[] } } }) {
      for (const k of where.key.in) rows.delete(k)
      return { count: 0 }
    },
  },
  wmsAsnMap: {
    async findMany(args: Record<string, unknown>) {
      asnQueries.push(args)
      return openAsns
    },
  },
  async $executeRaw() { return 0 },
  async $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T> {
    const sql = query.join(' ? ')
    if (/FROM settings WHERE key = ANY/.test(sql)) {
      const keys = (values[0] as string[]) ?? []
      return keys.filter((k) => rows.has(k)).map((k) => ({ key: k, value: rows.get(k) ?? null })) as T
    }
    return [] as T
  },
  // `unknown` rather than `typeof dbDouble` — see the same note in
  // tests/wms-dispatch-hook-wiring.test.ts: self-reference in the initializer is TS7022.
  async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> { return fn(dbDouble) },
}

mock.module('@/lib/db', { namedExports: { db: dbDouble, prisma: dbDouble } })

/** Which integration plugins are switched on. The REAL `getEnabledWmsConnectorId` reads this. */
let pluginState: Record<string, boolean> = { mintsoft: true }
mock.module('@/lib/integration-plugins', {
  namedExports: {
    getIntegrationPluginState: async () => pluginState,
    setIntegrationPluginEnabled: async () => {},
  },
})

mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })

/**
 * MINTSOFT'S OWN BOOKED-IN RECHECK QUEUE, at its boundary.
 *
 * The real `enqueueMintsoftBookedInRecheckForAsn` writes a reconstructed webhook event and then
 * processes it, which re-fetches the ASN from the live Mintsoft account. It must not run here. What
 * is recorded is the arrival: that the generic drain reached THIS module, for this ASN, with the
 * reason the generic pass composed.
 */
const enqueued: Array<{ externalAsnId: string; options: { reason?: string } }> = []
mock.module('@/lib/jobs/wms/process-mintsoft-booked-in-event', {
  namedExports: {
    enqueueMintsoftBookedInRecheckForAsn: async (externalAsnId: string, options: { reason?: string } = {}) => {
      enqueued.push({ externalAsnId, options })
      return { processed: 1, duplicates: 0, pending: 0, requiresReview: 0, failed: 0, created: true }
    },
  },
})

// ---------------------------------------------------------------------------------------------

test('wiring/booked-in recheck: the SHIPPED connector declares a booked-in recheck at all', async () => {
  const { getWmsConnectorHooks } = await import('../lib/connectors/wms/registry.ts')
  const hooks = getWmsConnectorHooks('mintsoft')
  assert.equal(
    typeof hooks.bookedInRecheck, 'function',
    'the shipped Mintsoft registration must declare hooks.bookedInRecheck — without it the'
    + ' post-maintenance drain returns null, the marker is left set for a connector that will never'
    + ' claim it, and the ASN reconstruction stops with nothing logged',
  )
})

test('wiring/booked-in recheck: the ACTIVE-CONNECTOR resolver reaches Mintsoft’s own recheck queue', async () => {
  resetDb()
  pluginState = { mintsoft: true }
  openAsns = [{ externalAsnId: 'MS-ASN-1' }, { externalAsnId: 'MS-ASN-2' }]

  const { runPostMaintenanceRecheckForActiveConnector } = await import('../lib/domain/wms/post-maintenance-recheck.ts')
  const result = await runPostMaintenanceRecheckForActiveConnector()

  // 1. IT RESOLVED AT ALL. `null` is the silent failure this test exists for, and it is the answer
  //    the resolver gives for a connector that declares no recheck hook.
  assert.notEqual(result, null, 'a connector that CAN re-check is enabled, so the drain must not report "nothing to do"')
  assert.equal(result!.connector, 'mintsoft', 'and it named the connector it drained')
  assert.equal(result!.skipped, false)
  assert.equal(result!.windowEndedAt, WINDOW_ENDED_AT)

  // 2. IT REACHED THE RIGHT PLACE, for every open ASN, with the generic pass's own reason. A hook
  //    that resolved to some other connector's queue — or a generic layer that enqueued nothing —
  //    fails here rather than looking like a clean pass.
  assert.deepEqual(
    enqueued.map((e) => e.externalAsnId), ['MS-ASN-1', 'MS-ASN-2'],
    'every open ASN was re-checked through the connector’s declared queue',
  )
  assert.equal(result!.attempted, 2)
  assert.equal(result!.failed, 0)
  for (const call of enqueued) {
    assert.match(
      call.options.reason ?? '', new RegExp(`automatic re-check after maintenance window ended ${WINDOW_ENDED_AT}`),
      'the reason carries the window the recovery is for, so the reconstructed trigger is traceable',
    )
  }

  // 3. AND THE PASS COMPLETED, which is what clears the marker. A drain that enqueues and then
  //    cannot clear leaves the same work owed forever.
  assert.equal(result!.drained, true, 'the marker was cleared because every candidate was attempted')
  assert.equal(rows.has(WMS_BOOKED_IN_RECHECK_DUE_KEY), false, 'and the row is actually gone')

  // The candidate query is the connector's own open ASNs — asserted because the connector id it
  // filters on comes from the same resolution the hook did.
  assert.equal(asnQueries.length, 1, 'precondition: the candidate query ran exactly once')
  assert.deepEqual(
    (asnQueries[0] as { where: { connector: string } }).where.connector, 'mintsoft',
    'the open-ASN query is scoped to the connector that was resolved',
  )
})

test('wiring/booked-in recheck: with NO WMS plugin enabled the drain returns null and enqueues nothing', async () => {
  // The contrast that stops the test above being vacuous: `null` IS reachable, and a non-null result
  // therefore says something. `getEnabledWmsConnectorId` has no legacy fallback on purpose — with
  // every plugin off no sweep runs, so the marker stays owed.
  resetDb()
  pluginState = {}
  openAsns = [{ externalAsnId: 'MS-ASN-1' }]

  const { runPostMaintenanceRecheckForActiveConnector } = await import('../lib/domain/wms/post-maintenance-recheck.ts')
  const result = await runPostMaintenanceRecheckForActiveConnector()

  assert.equal(result, null, 'no connector is enabled, so nothing owes the re-check')
  assert.deepEqual(enqueued, [], 'and nothing was enqueued')
  assert.equal(
    rows.get(WMS_BOOKED_IN_RECHECK_DUE_KEY), WINDOW_ENDED_AT,
    'the marker is deliberately LEFT SET — the work is still owed and will be drained when the'
    + ' connector that owes it is back',
  )
})

test('wiring/booked-in recheck: a maintenance window in force stops the pass before any queue call', async () => {
  // The same resolver, past the hook, refusing for its own reason. This is here because it is the
  // one other way `attempted: 0` can happen, and an operator has to be able to tell the two apart.
  resetDb()
  pluginState = { mintsoft: true }
  rows.set(MAINTENANCE_ENABLED_KEY, 'true')
  openAsns = [{ externalAsnId: 'MS-ASN-1' }]

  const { runPostMaintenanceRecheckForActiveConnector } = await import('../lib/domain/wms/post-maintenance-recheck.ts')
  const result = await runPostMaintenanceRecheckForActiveConnector()

  assert.notEqual(result, null, 'the connector still resolved — this refusal is not "no connector"')
  assert.equal(result!.refusal, 'maintenance_mode_on', 'and it is NAMED, never a bare zero')
  assert.deepEqual(enqueued, [], 'no warehouse work was issued into a live restore window')
  assert.equal(rows.get(WMS_BOOKED_IN_RECHECK_DUE_KEY), WINDOW_ENDED_AT, 'the marker is kept')
})
