/**
 * THE SHIPPED CONNECTOR'S DISPATCH HOOKS, DRIVEN THROUGH THE REAL REGISTRY ENTRY (o3d-j8yq).
 *
 * WHY THIS FILE EXISTS ALONGSIDE tests/wms-second-connector-seam-production.test.ts. That file
 * REPLACES the registry module with a seam registry holding a fictitious `acme-wms` and an inert
 * Mintsoft that declares no hooks at all, so it can prove the generic layer routes by capability.
 * What it cannot prove — and what the round-10 audit of o3d-remove-shiphero found nothing proved —
 * is that THE CONNECTOR THIS BUILD SHIPS still declares the hooks the generic layer routes to. Two
 * of those hooks were inline code before o3d-remove-shiphero:
 *
 *   - `hooks.dispatchPrecondition` was `if (!isDispatchClientScoped(...)) return { SKIPPED }` inside
 *     lib/domain/wms/dispatch-sweep.ts. It is a FAIL-CLOSED CROSS-TENANT GATE: unscoped, every
 *     Mintsoft per-order lookup is a cross-client lookup, so a sweep that ran anyway can mark OUR
 *     order shipped off a FOREIGN despatch. Its predicate is unit-tested
 *     (tests/mintsoft-orderlist-delta.test.ts, over null/blank/'0'/'-5'/'abc'/'12x'); deleting the
 *     HOOK that reaches the predicate left every suite in the repo green.
 *   - `hooks.deltaScopeLock` was a hard-wired `lockMintsoftDispatchSettings`. Dropping it does not
 *     break the sweep either: it silently falls back to `defaultWmsDeltaScopeLock`, which locks the
 *     CURSOR rows instead of the five rows that DEFINE the scope, and reports the scope token
 *     `unbound` — so a ClientId move committing mid-sweep is no longer serialized against the
 *     cursor read, and the save-time scope check compares `unbound` to `unbound` and waves the
 *     stale watermark through.
 *
 * So this file does the opposite of the seam file: THE REGISTRY IS NOT MOCKED. `mintsoft` is the
 * enabled connector, `lib/connectors/wms/registry.ts` is the shipped module, and the assertions are
 * on what `runWmsDispatchSweep` — the production entrypoint the cron route calls — actually did.
 * Delete either hook from BUILT_IN_WMS_CONNECTOR_REGISTRATIONS and tests here go red.
 *
 * WHAT IS MOCKED, AND WHY THAT IS NOT CHEATING. Only process boundaries: the database, the
 * per-connector advisory sweep lock (a session lock on a real pg connection), the activity log, and
 * which integration plugins are switched on. `lib/settings-store.ts` is deliberately NOT mocked —
 * the real `getSettingValue` runs, against the in-memory `settings` table below, so the hook reads
 * the row through the same code production reads it through. No Mintsoft HTTP call is possible: the
 * warehouse port is supplied whole, and the only production members taken from
 * `createPrismaDispatchDeps` are the two delta-cursor functions the scope lock lives in.
 */
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// NO STATIC IMPORT OF ANY APP MODULE, and that is load-bearing rather than style. `mock.module`
// only affects modules resolved AFTER it runs, and `lib/connectors/wms/registry.ts` pulls in
// `lib/settings-store.ts` which pulls in `lib/db` — so one static import up here would bind the
// REAL PrismaClient before the `@/lib/db` mock below exists, and the hook under test would read
// the live development database. Every app import in this file is dynamic and below the mocks.

// --- the `settings` table, and every other database touch the sweep makes ----------------------

/** The settings rows, as the in-memory `settings` table. Reset per test. */
const rows = new Map<string, string>()

/**
 * Every statement the code under test issued, in order, as one log.
 *
 * ONE log rather than one per method because the ORDERING is part of what is under test: the scope
 * lock must be taken BEFORE the cursor rows are read, which is the whole of the happens-before
 * lib/domain/wms/delta-scope-lock.ts claims. Two separate arrays cannot witness an interleaving.
 */
const calls: string[] = []

/** Raw statements with their bind values, so the LOCKED KEYS can be read back out. */
const rawCalls: Array<{ sql: string; values: unknown[] }> = []

const jobs: Array<Record<string, unknown>> = []

function resetRecording() {
  rows.clear()
  calls.length = 0
  rawCalls.length = 0
  jobs.length = 0
}

type SettingRow = { key: string; value: string | null }

function rawSql(query: TemplateStringsArray): string {
  return query.join(' ? ').replace(/\s+/g, ' ').trim()
}

const dbDouble = {
  setting: {
    async findUnique({ where }: { where: { key: string } }): Promise<SettingRow | null> {
      calls.push(`setting.findUnique:${where.key}`)
      const value = rows.get(where.key)
      return value === undefined ? null : { key: where.key, value }
    },
    async findMany({ where }: { where: { key: { in: string[] } } }): Promise<SettingRow[]> {
      calls.push(`setting.findMany:${[...where.key.in].sort().join(',')}`)
      return where.key.in.filter((k) => rows.has(k)).map((k) => ({ key: k, value: rows.get(k) ?? null }))
    },
    async upsert({ where, update }: { where: { key: string }; create: { key: string; value: string }; update: { value: string } }) {
      calls.push(`setting.upsert:${where.key}`)
      rows.set(where.key, update.value)
    },
    async updateMany() { return { count: 0 } },
    async deleteMany({ where }: { where: { key: { in: string[] } } }) {
      for (const k of where.key.in) rows.delete(k)
      return { count: 0 }
    },
  },
  wmsSyncJob: {
    async create({ data }: { data: Record<string, unknown> }) {
      calls.push('wmsSyncJob.create')
      jobs.push(data)
      return { id: `job-${jobs.length}` }
    },
    async update() {},
  },
  wmsSyncLog: {
    async create() {},
    async createMany() {},
  },
  wmsOrderPushLink: {
    async findMany() { return [] },
    async updateMany() { return { count: 0 } },
  },
  async $executeRaw(query: TemplateStringsArray, ...values: unknown[]) {
    const sql = rawSql(query)
    calls.push(`$executeRaw:${sql.slice(0, 40)}`)
    rawCalls.push({ sql, values })
    return 0
  },
  async $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T> {
    const sql = rawSql(query)
    calls.push(`$queryRaw:${sql.slice(0, 40)}`)
    rawCalls.push({ sql, values })
    // Answer the materialise-then-`FOR UPDATE` SELECT with the rows it asked for, so the lock
    // returns the SNAPSHOT the production code would see. A lock double that always returned `[]`
    // would make every scope token look like the all-defaults one, which is the token the DEFAULT
    // lock's `unbound` has to be distinguished from.
    if (/FROM settings WHERE key = ANY/.test(sql)) {
      const keys = (values[0] as string[]) ?? []
      return keys.filter((k) => rows.has(k)).map((k) => ({ key: k, value: rows.get(k) ?? null })) as T
    }
    return [] as T
  },
  // `unknown`, not `typeof dbDouble`: naming the object inside its own initializer makes its
  // type circular (TS7022). The double reaches the code under test through `mock.module`, which is
  // not typechecked, so nothing is lost by not restating the shape here.
  async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    calls.push('$transaction:begin')
    const out = await fn(dbDouble)
    calls.push('$transaction:commit')
    return out
  },
}

mock.module('@/lib/db', { namedExports: { db: dbDouble, prisma: dbDouble } })

/** Which integration plugins are switched on. Mutated per test; the REAL resolver reads it. */
let pluginState: Record<string, boolean> = { mintsoft: true }
mock.module('@/lib/integration-plugins', {
  namedExports: {
    getIntegrationPluginState: async () => pluginState,
    setIntegrationPluginEnabled: async () => {},
  },
})

// The per-connector sweep lock is a session advisory lock on a real pg connection — a process
// boundary, not code under test. Running the body inline is the only thing mocked about it.
mock.module('@/lib/domain/wms/dispatch-sweep-lock', {
  namedExports: {
    DISPATCH_LOCK_SKIPPED: { lockSkipped: true },
    DISPATCH_SWEEP_LOCK_NAMESPACE: 1,
    dispatchSweepLockKey: (id: string) => id.length,
    withDispatchSweepLockOrSkip: async <T>(_id: string, fn: () => Promise<T>): Promise<T> => fn(),
  },
})

mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })

// --- the warehouse port, supplied whole so no Mintsoft HTTP call is reachable ------------------

type Deps = import('../lib/domain/wms/dispatch-sweep.ts').WmsDispatchSweepDeps

/** Every REQUIRED port member, inert. Overrides are merged over it; nothing here talks to a WMS. */
function inertPort(overrides: Partial<Deps> = {}): Deps {
  return {
    listCandidates: async () => { portCalls.push('listCandidates'); return [] },
    fetchOrderStatus: async () => { portCalls.push('fetchOrderStatus'); return null },
    applyDispatch: async () => { portCalls.push('applyDispatch'); return { success: true } },
    partsSupported: false,
    fetchOrderParts: async () => { portCalls.push('fetchOrderParts'); return [] },
    fetchPartItems: async () => { portCalls.push('fetchPartItems'); return [] },
    pushPartialShipment: async () => { portCalls.push('pushPartialShipment'); return { ok: true } },
    repointLink: async () => { portCalls.push('repointLink') },
    recordDispatchError: async () => { portCalls.push('recordDispatchError'); return { deadLettered: false } },
    clearDispatchFailures: async () => { portCalls.push('clearDispatchFailures') },
    ...overrides,
  }
}

/** What the sweep asked of the warehouse port. Empty is the proof a refusal came BEFORE any work. */
const portCalls: string[] = []

// ---------------------------------------------------------------------------------------------
// RULE 1 — the ClientId dispatch precondition, a FAIL-CLOSED CROSS-TENANT GATE
// ---------------------------------------------------------------------------------------------

test('wiring/precondition: the SHIPPED connector declares a dispatch precondition at all', async () => {
  // The precondition of every behavioural assertion below, stated on its own so a deletion is
  // named rather than inferred from a downstream symptom.
  const { getWmsConnectorHooks } = await import('../lib/connectors/wms/registry.ts')
  const hooks = getWmsConnectorHooks('mintsoft')
  assert.equal(
    typeof hooks.dispatchPrecondition, 'function',
    'the shipped Mintsoft registration must declare hooks.dispatchPrecondition — it is the only thing'
    + ' standing between an unscoped ClientId and a sweep that reconciles our orders against another'
    + " tenant's despatches",
  )
})

test('wiring/precondition: Mintsoft with a BLANK mintsoft_client_id skips the sweep, with the registry’s own reason', async () => {
  resetRecording()
  portCalls.length = 0
  pluginState = { mintsoft: true }
  // BLANK, which every reader of a settings key treats exactly as an absent row. This is the state
  // a fresh install is in, and the state an operator clearing the field puts it back into.
  rows.set('mintsoft_client_id', '')
  rows.set('mintsoft_inbound_delta_enabled', 'false')

  const { runWmsDispatchSweep } = await import('../lib/domain/wms/dispatch-sweep.ts')
  const result = await runWmsDispatchSweep('o3d-j8yq-wiring', { deps: inertPort() })

  assert.equal(
    result.status, 'SKIPPED',
    'an unscoped Mintsoft sweep must not run: every per-order lookup it makes is a cross-client'
    + ' lookup, and a DESPATCHED answer from another tenant marks OUR order shipped',
  )

  // THE REASON IS THE REGISTRY'S, not a string this test wrote down. Comparing against the hook's
  // own output means a reworded refusal still passes and a DELETED refusal cannot: with the hook
  // gone there is no reason to compare to, and the status above is not SKIPPED either.
  const { getWmsConnectorHooks } = await import('../lib/connectors/wms/registry.ts')
  const hook = getWmsConnectorHooks('mintsoft').dispatchPrecondition
  assert.ok(hook, 'precondition: the shipped registration declares hooks.dispatchPrecondition')
  const direct = await hook()
  assert.equal(direct.ok, false, 'precondition: with a blank ClientId the hook itself refuses')
  assert.equal(
    result.skippedReason, direct.ok ? undefined : direct.reason,
    'the sweep’s skip reason is the reason the CONNECTOR stated, passed through verbatim',
  )
  assert.match(result.skippedReason ?? '', /mintsoft_client_id/, 'and it names the row an operator must fix')

  // AND NOTHING HAPPENED. A gate that refuses after touching a link is not a gate.
  assert.deepEqual(portCalls, [], 'no link was read, polled or dispatched')
  assert.equal(jobs.length, 0, 'and no WmsSyncJob row was opened — the refusal is before the sweep starts')
})

test('wiring/precondition: the same sweep with a SCOPED ClientId is NOT refused — the gate is conditional', async () => {
  // The contrast that makes the test above a test. Without it, a hook hard-wired to refuse — or a
  // sweep that skipped for some unrelated reason — would satisfy it just as well.
  resetRecording()
  portCalls.length = 0
  pluginState = { mintsoft: true }
  rows.set('mintsoft_client_id', '89')
  rows.set('mintsoft_inbound_delta_enabled', 'false')

  const { runWmsDispatchSweep } = await import('../lib/domain/wms/dispatch-sweep.ts')
  const result = await runWmsDispatchSweep('o3d-j8yq-wiring', { deps: inertPort() })

  assert.notEqual(result.status, 'SKIPPED', `a scoped Mintsoft sweep runs (got ${result.skippedReason ?? 'no reason'})`)
  assert.equal(jobs.length, 1, 'the sweep opened its job row, so it really did get past the gate')
  assert.deepEqual(portCalls, ['listCandidates'], 'and it asked the warehouse port for candidates')
})

test('wiring/precondition: a NON-NUMERIC ClientId is refused too — the hook reaches the real predicate', async () => {
  // `isMintsoftDispatchClientScoped` rejects more than blank ('0', '-5', 'abc', '12x'), and the
  // registry entry is what connects the sweep to it. A hook that merely tested for emptiness would
  // pass the blank case above and fail here.
  resetRecording()
  portCalls.length = 0
  pluginState = { mintsoft: true }
  rows.set('mintsoft_client_id', '12x')
  rows.set('mintsoft_inbound_delta_enabled', 'false')

  const { runWmsDispatchSweep } = await import('../lib/domain/wms/dispatch-sweep.ts')
  const result = await runWmsDispatchSweep('o3d-j8yq-wiring', { deps: inertPort() })

  assert.equal(result.status, 'SKIPPED', 'a ClientId that is not a positive integer is not a scope')
  assert.match(result.skippedReason ?? '', /mintsoft_client_id/)
  assert.deepEqual(portCalls, [], 'nothing was touched')
})

// ---------------------------------------------------------------------------------------------
// RULE 3 (the wiring half) — the sweep takes MINTSOFT'S scope lock, not the default one
// ---------------------------------------------------------------------------------------------

/** The five rows that DEFINE Mintsoft's inbound-delta scope, in the canonical (sorted) lock order. */
const MINTSOFT_SCOPE_KEYS = [
  'mintsoft_admin_order_url_template',
  'mintsoft_channel_id',
  'mintsoft_client_id',
  'mintsoft_default_courier_service_id',
  'mintsoft_warehouse_id',
]

/** The rows the DEFAULT lock would take instead — this connector's own cursor state. */
const MINTSOFT_CURSOR_KEYS = [
  'mintsoft_order_delta_generation',
  'mintsoft_order_delta_since',
  'mintsoft_order_reconcile_at',
]

/** Every key set passed to a `FOR UPDATE` materialise/select, in the order the locks were taken. */
function lockedKeySets(): string[][] {
  return rawCalls
    .filter((c) => /FROM settings WHERE key = ANY/.test(c.sql))
    .map((c) => [...((c.values[0] as string[]) ?? [])])
}

test('wiring/scope lock: the sweep locks MINTSOFT’S five scope rows, and reports a BOUND scope token', async () => {
  resetRecording()
  portCalls.length = 0
  pluginState = { mintsoft: true }
  rows.set('mintsoft_client_id', '89')
  rows.set('mintsoft_channel_id', '7')
  rows.set('mintsoft_warehouse_id', '3')
  // A current generation, so the cursor read and the save are not refused for an unrelated reason.
  rows.set('mintsoft_order_delta_generation', '4')

  const sweep = await import('../lib/domain/wms/dispatch-sweep.ts')
  const { mintsoftDeltaScopeToken } = await import('../lib/connectors/mintsoft/settings/schema.ts')
  const { WMS_DELTA_SCOPE_UNBOUND } = await import('../lib/domain/wms/delta-scope-lock.ts')

  // THE PRODUCTION DEPS FACTORY, for the two delta-cursor members ONLY — that is where the scope
  // lock is resolved (`getWmsConnectorHooks(connectorId).deltaScopeLock ?? default`). The connector
  // instance handed in is a stub that merely DECLARES a bulk delta, because the factory wires
  // `getDeltaState`/`saveDeltaState` on the presence of `fetchOrderDelta` and never calls it here;
  // no HTTP is reachable from this test.
  const deltaStub = { id: 'mintsoft', name: 'Mintsoft', deltaCursorTimeZone: 'Europe/London', isConfigured: async () => true, fetchOrderDelta: async () => [] }
  const prismaDeps = sweep.createPrismaDispatchDeps('mintsoft', deltaStub as never)
  assert.equal(typeof prismaDeps.getDeltaState, 'function', 'precondition: the production factory wired the cursor deps')

  /** What the PRODUCTION `getDeltaState` returned — including the scope token it read under lock. */
  const observed: Array<{ scope?: string | null }> = []

  const result = await runSweepWithCursorDeps(sweep, prismaDeps, observed)

  assert.notEqual(result.status, 'SKIPPED', `the sweep ran (${result.skippedReason ?? ''})`)

  // 1. WHICH ROWS WERE LOCKED. The default lock would have taken the three CURSOR rows; Mintsoft's
  //    takes the five rows whose values ARE the scope. `mintsoft_client_id` is in both key sets'
  //    vocabulary but only in one of these lists, so the comparison cannot pass by accident.
  const locked = lockedKeySets()
  assert.ok(locked.length > 0, 'precondition: a FOR UPDATE row lock was taken at all')
  assert.deepEqual(
    locked[0], MINTSOFT_SCOPE_KEYS,
    'the FIRST lock of the run is Mintsoft’s five scope rows — moving the ClientId must be serialized'
    + ' against the cursor read, and the cursor rows do not serialize against it',
  )
  for (const set of locked) {
    assert.notDeepEqual(
      set, MINTSOFT_CURSOR_KEYS,
      'the shipped connector must never fall back to the DEFAULT lock over its own cursor rows —'
      + ' that lock establishes no ordering against a scope change at all',
    )
  }

  // 2. WHICH TOKEN IT REPORTED. `unbound` is the default lock's constant, and a save-time check
  //    against it answers "did my scope move?" with `unbound === unbound` unconditionally.
  assert.equal(observed.length, 1, 'the production getDeltaState ran exactly once')
  assert.equal(
    observed[0].scope,
    mintsoftDeltaScopeToken({ mintsoft_client_id: '89', mintsoft_channel_id: '7', mintsoft_warehouse_id: '3' }),
    'the token is Mintsoft’s own scope identity, read from the rows it just locked',
  )
  assert.notEqual(
    observed[0].scope, WMS_DELTA_SCOPE_UNBOUND,
    'a connector whose delta IS configuration-scoped must not report the unbound token — the'
    + ' save-time compare-and-swap would then pass for every scope change that ever happens',
  )

  // 3. AND THE ORDERING THE DOCSTRING CLAIMS: the scope rows are locked BEFORE the cursor rows are
  //    read, so a scope change cannot land between the two halves of the pair.
  const firstLock = calls.findIndex((c) => c.startsWith('$queryRaw:SELECT key, value FROM settings'))
  const cursorRead = calls.findIndex((c) => c === `setting.findMany:${MINTSOFT_CURSOR_KEYS.join(',')}`)
  assert.ok(firstLock >= 0, 'precondition: the lock statement was recorded')
  assert.ok(cursorRead >= 0, 'precondition: the cursor rows were read')
  assert.ok(
    firstLock < cursorRead,
    `the scope lock must be taken before the cursors are read (lock at ${firstLock}, read at ${cursorRead})`,
  )
})

test('wiring/scope lock: the token the production read reports TRACKS the ClientId row, rather than being a constant', async () => {
  // What the token is FOR: the sweep reads the cursors under Mintsoft's scope lock, and if the
  // ClientId has moved by save time the save must refuse rather than restore an old-scope watermark
  // over the reset. That refusal needs the two tokens to DIFFER, which is exactly what the default
  // lock cannot provide — `unbound` on both sides. This asserts the inequality the refusal rests on;
  // the refusal itself is covered by tests/mintsoft-delta-scope.test.ts over saveWmsDeltaCursors.
  resetRecording()
  portCalls.length = 0
  pluginState = { mintsoft: true }
  rows.set('mintsoft_client_id', '89')
  rows.set('mintsoft_order_delta_generation', '4')

  const sweep = await import('../lib/domain/wms/dispatch-sweep.ts')
  const { mintsoftDeltaScopeToken } = await import('../lib/connectors/mintsoft/settings/schema.ts')
  const deltaStub = { id: 'mintsoft', name: 'Mintsoft', deltaCursorTimeZone: 'Europe/London', isConfigured: async () => true, fetchOrderDelta: async () => [] }
  const prismaDeps = sweep.createPrismaDispatchDeps('mintsoft', deltaStub as never)

  const observed: Array<{ scope?: string | null }> = []
  await runSweepWithCursorDeps(sweep, prismaDeps, observed)

  assert.equal(observed.length, 1)
  assert.equal(
    observed[0].scope,
    mintsoftDeltaScopeToken({ mintsoft_client_id: '89', mintsoft_channel_id: '', mintsoft_warehouse_id: '' }),
    'the scope identity tracks the ClientId row',
  )

  // Move the ClientId, and read again through the same production function: a DIFFERENT identity.
  rows.set('mintsoft_client_id', '101')
  const after = await prismaDeps.getDeltaState!()
  assert.notEqual(
    after.scope, observed[0].scope,
    'moving the ClientId must change the scope token — that inequality is the only thing that lets'
    + ' a save refuse a watermark earned under the old tenant scope',
  )
})

/**
 * Drive the production sweep with the PRODUCTION cursor deps, observing what `getDeltaState`
 * returned. Everything else is the inert port, so the run's only warehouse contact is a delta that
 * returns nothing.
 */
async function runSweepWithCursorDeps(
  sweep: typeof import('../lib/domain/wms/dispatch-sweep.ts'),
  prismaDeps: Deps,
  observed: Array<{ scope?: string | null }>,
) {
  return sweep.runWmsDispatchSweep('o3d-j8yq-wiring', {
    deps: inertPort({
      fetchDelta: async () => [],
      getDeltaState: async () => {
        const state = await prismaDeps.getDeltaState!()
        observed.push(state)
        return state
      },
      saveDeltaState: prismaDeps.saveDeltaState,
    }),
  })
}
