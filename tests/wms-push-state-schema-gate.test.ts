import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createWmsPushStateSchemaGate,
  isWmsPushStateSchemaError,
  missingWmsPushStates,
  REQUIRED_WMS_PUSH_STATES,
  WmsPushStateSchemaError,
} from '../lib/domain/wms/push-state-schema-gate.ts'

/**
 * o3d-1izw — THE CODE IS AHEAD OF EVERY DATABASE, AND IT USED TO FIND OUT MID-WRITE.
 *
 * `AMBIGUOUS_CREATE` is a `WmsOrderPushState` value added by a migration that has been applied
 * nowhere. Nothing checked for it, so the discovery was made by Postgres, inside the claim
 * transaction that writes it: the write failed, the transaction rolled back, the order was left
 * neither claimed nor parked, and the next sweep reached the same link and did it again. Silent
 * (a driver message about an invalid enum input, attributable to nothing), late (a crashed worker
 * plus a lapsed lease had to happen first) and repeating (once a sweep, for ever).
 *
 * These tests are about the three properties that replace it — LOUD, EARLY, ONCE — and about the
 * one direction a gate like this must never fail in.
 */

test('o3d-1izw gate: a database missing the value refuses, and the refusal names the issue and the remedy', async () => {
  // Route: gate -> readEnumValues returns the PRE-migration label set -> missingWmsPushStates
  // finds AMBIGUOUS_CREATE absent -> WmsPushStateSchemaError.
  //
  // Mutation: make missingWmsPushStates return [] unconditionally (or drop the `missing.length > 0`
  // branch from createWmsPushStateSchemaGate) and this test fails on `rejects` — the gate resolves
  // and the sweep proceeds onto a database that cannot hold what it writes, which is the pre-fix
  // behaviour exactly.
  const gate = createWmsPushStateSchemaGate(
    async () => ['PENDING_CREATE', 'PENDING_VERIFY', 'SYNCED', 'CANCELLED', 'DEAD_LETTER', 'HELD', 'VALIDATION_FAILED'],
    { onRefusal: () => {} },
  )
  await assert.rejects(gate(), (error: unknown) => {
    assert.ok(isWmsPushStateSchemaError(error), 'a NAMED error, not a raw driver failure')
    assert.equal((error as WmsPushStateSchemaError).code, 'WMS_PUSH_STATE_SCHEMA_AHEAD_OF_DATABASE')
    assert.deepEqual((error as WmsPushStateSchemaError).missing, ['AMBIGUOUS_CREATE'])
    // The remedy has to be performable by whoever reads it, so it names all three.
    assert.match((error as Error).message, /o3d-1izw/)
    assert.match((error as Error).message, /20260827090000_wms_push_ambiguous_create/)
    assert.match((error as Error).message, /prisma migrate deploy/)
    return true
  })
})

test('o3d-1izw gate: a migrated database passes, and is asked exactly once', async () => {
  // Route: gate -> reader -> no missing values -> `confirmed` latches -> later calls short-circuit.
  //
  // Mutation: delete the `if (confirmed) return` line and this fails on the read count (3, not 1) —
  // a pg_enum query on every create claim, which is the cost the latch exists to avoid.
  let reads = 0
  const gate = createWmsPushStateSchemaGate(async () => { reads += 1; return [...REQUIRED_WMS_PUSH_STATES, 'SYNCED'] })
  await gate()
  await gate()
  await gate()
  assert.equal(reads, 1)
})

test('o3d-1izw gate: a REFUSAL is re-probed, so applying the migration heals the next sweep with no restart', async () => {
  // Route: gate refuses (value absent) -> nothing latches -> the operator applies the migration ->
  // the next call reads the new label set and passes.
  //
  // Mutation: cache the failure too (latch `confirmed = true` before the missing check, or memoize
  // the thrown error) and this fails on the second call — the process would have to be restarted
  // after a migration, and an environment served by `next dev` is exactly the one nobody restarts.
  let migrated = false
  let reads = 0
  const gate = createWmsPushStateSchemaGate(
    async () => { reads += 1; return migrated ? ['SYNCED', 'AMBIGUOUS_CREATE'] : ['SYNCED'] },
    { onRefusal: () => {} },
  )
  await assert.rejects(gate(), isWmsPushStateSchemaError)
  migrated = true
  await gate()
  // The READ COUNT is the assertion, not merely that the second call resolved: a gate that latched
  // on the refusal would also resolve here, by never asking again and never having anything to
  // refuse with. Two reads is what "re-probed" means.
  assert.equal(reads, 2)
})

test('o3d-1izw gate: the refusal is announced ONCE per process, not once per sweep', async () => {
  // Route: two refusals from one gate -> `announced` latches after the first.
  //
  // Mutation: remove the `announced` latch and this fails with 2 — the sweep runs every ten
  // minutes and the refusal never changes on its own, so the line that is supposed to make the
  // fault readable buries it instead.
  const announced: string[] = []
  const gate = createWmsPushStateSchemaGate(async () => [], { onRefusal: (error) => announced.push(error.message) })
  await assert.rejects(gate(), isWmsPushStateSchemaError)
  await assert.rejects(gate(), isWmsPushStateSchemaError)
  assert.equal(announced.length, 1)
})

test('o3d-1izw gate: an UNREADABLE catalogue is a refusal, not a pass', async () => {
  // Route: readEnumValues throws -> the gate converts it to the same named refusal, keeping the
  // underlying fault as `cause`.
  //
  // Mutation: swallow the read error and return (treat "we could not ask" as "it is fine") and
  // this fails on `rejects`. That is the absence-read-as-a-negative-answer shape this whole branch
  // keeps finding, and here it would restore the silent incompatibility on the one database state
  // nobody can reason about.
  const boom = new Error('connection terminated')
  const gate = createWmsPushStateSchemaGate(async () => { throw boom }, { onRefusal: () => {} })
  await assert.rejects(gate(), (error: unknown) => {
    assert.ok(isWmsPushStateSchemaError(error))
    assert.deepEqual((error as WmsPushStateSchemaError).missing, [...REQUIRED_WMS_PUSH_STATES])
    assert.equal((error as Error & { cause?: unknown }).cause, boom, 'and the real fault is still diagnosable')
    return true
  })
})

test('o3d-1izw gate: a NULL label set is every value missing, not none', async () => {
  // Route: missingWmsPushStates(null) -> the full required list.
  //
  // Mutation: `if (!present) return []` and this fails — the pure rule is what the gate's fail-
  // closed behaviour rests on, and it is one character away from failing open.
  assert.deepEqual(missingWmsPushStates(null), [...REQUIRED_WMS_PUSH_STATES])
  assert.deepEqual(missingWmsPushStates(undefined), [...REQUIRED_WMS_PUSH_STATES])
  assert.deepEqual(missingWmsPushStates([]), [...REQUIRED_WMS_PUSH_STATES])
  assert.deepEqual(missingWmsPushStates([...REQUIRED_WMS_PUSH_STATES]), [])
})

test('o3d-1izw gate: the sweep asks it BEFORE it reads a candidate, and the claim asks it again', async () => {
  // The properties this file cannot demonstrate by calling the gate — that it is wired EARLY, and
  // at the write site — are asserted against the source, because the alternative is a live
  // database and this suite has none.
  //
  // Route: runWmsOrderPushSweep -> assertWmsPushStateSchemaReady -> runWmsOrderPushSweepCore.
  //
  // Mutation: move the preflight call below `runWmsOrderPushSweepCore(...)`, or delete the one in
  // `claimForCreate`, and this fails — which is the point: a gate nothing calls is a comment.
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../lib/domain/wms/order-push-sweep.ts', import.meta.url), 'utf8')

  const preflight = source.indexOf('await assertWmsPushStateSchemaReady()\n\n  return runWmsOrderPushSweepCore(')
  assert.notEqual(preflight, -1, 'the preflight runs immediately before the core sweep, not after it')

  const claim = source.indexOf('async claimForCreate(orderId, connector, attemptedAt) {')
  assert.notEqual(claim, -1)
  const claimBody = source.slice(claim, source.indexOf('return db.$transaction', claim))
  assert.match(claimBody, /await assertWmsPushStateSchemaReady\(\)/, 'the write site guards itself before opening the transaction')
})

// --- the DEPLOYMENT half ------------------------------------------------------------------

test('o3d-1izw preflight: production preflight FAILS when the database lacks a state this build writes', async () => {
  // Route: runProductionPreflight -> checkWmsPushStateSchema (PREFLIGHT_DB_CONNECT on) ->
  // missingWmsPushStates -> a `fail` check carrying the same refusal the runtime gate raises.
  //
  // Mutation: report `warn` instead of `fail` (or skip the check when the value is absent) and
  // this fails on `result.ok` — a deploy would proceed onto a database where the order-push sweep
  // refuses to run at all, which is a fulfilment outage rather than a nit.
  const { runProductionPreflight } = await import('../lib/ops/production-preflight.ts')
  const env = { PREFLIGHT_DB_CONNECT: '1', DATABASE_URL: 'postgresql://u:p@localhost:5432/ims' }

  const absent = await runProductionPreflight({
    env,
    dbConnect: async () => {},
    readWmsPushStates: async () => ['PENDING_CREATE', 'SYNCED'],
  })
  const failed = absent.checks.find((check) => check.id === 'wms-push-state-schema')!
  assert.equal(failed.status, 'fail')
  assert.equal(absent.ok, false)
  assert.match(failed.message, /o3d-1izw/)

  const present = await runProductionPreflight({
    env,
    dbConnect: async () => {},
    readWmsPushStates: async () => [...REQUIRED_WMS_PUSH_STATES],
  })
  assert.equal(present.checks.find((check) => check.id === 'wms-push-state-schema')!.status, 'pass')
})

test('o3d-1izw preflight: an UNREADABLE enum is a failed check, not a skipped one', async () => {
  // Route: the reader throws -> `fail`.
  //
  // Mutation: swallow the error and return without adding a check, and this fails — "we could not
  // ask" would pass the deploy gate, which is the same absence-as-an-answer shape the runtime gate
  // refuses.
  const { runProductionPreflight } = await import('../lib/ops/production-preflight.ts')
  const result = await runProductionPreflight({
    env: { PREFLIGHT_DB_CONNECT: '1', DATABASE_URL: 'postgresql://u:p@localhost:5432/ims' },
    dbConnect: async () => {},
    readWmsPushStates: async () => { throw new Error('connection refused') },
  })
  const check = result.checks.find((entry) => entry.id === 'wms-push-state-schema')!
  assert.equal(check.status, 'fail')
  assert.match(check.message, /o3d-1izw/)
})

test('o3d-1izw deploy: --skip-migrate runs the enum check, --restart-only does not', async () => {
  // The one delivery path that applies and validates nothing has to verify this itself. Route:
  // scripts/deploy.sh, the `elif ! $RESTART_ONLY` arm of the migration block.
  //
  // Mutation: delete the arm (or fold the check into the migrating branch, where it is redundant)
  // and this fails — --skip-migrate is exactly how a build reaches an environment ahead of its own
  // schema, which is what o3d-1izw is open against.
  const { readFile } = await import('node:fs/promises')
  const deploy = await readFile(new URL('../scripts/deploy.sh', import.meta.url), 'utf8')
  assert.match(deploy, /elif ! \$RESTART_ONLY; then[\s\S]*node scripts\/check-wms-push-state-enum\.mjs/)
})
