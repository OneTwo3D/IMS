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

// --- the TYPE-IDENTITY half ---------------------------------------------------------------
//
// A gate that asks "does a type CALLED WmsOrderPushState carry AMBIGUOUS_CREATE?" is not asking
// about the column it is vouching for. `pg_type.typname` is unique only within a schema, so that
// question is answered by ANY same-named type anywhere in the database — and it was asked, in the
// same wrong form, by all three gates at once, which made a single bad query a common-mode bypass
// rather than three independent checks.
//
// The tests below are about the replacement: the shared statement starts at the TABLE AND COLUMN
// and follows `pg_attribute.atttypid` to whatever type that column is actually declared as.
//
// WHAT THIS SUITE CANNOT DO. It has no Postgres — this branch applies no migration to any database
// and creates no schema — so it cannot literally `CREATE SCHEMA legacy; CREATE TYPE ...`. The
// double below is the closest thing that still DISTINGUISHES the two questions: a tiny catalogue
// holding two same-named enums in different schemas, which answers the by-name shape by unioning
// their labels (as Postgres does) and the by-column shape from the column's own type OID (as
// Postgres does), and REFUSES any query it does not recognise. The production statement is fed to
// it verbatim, so reverting the anchor is caught, and so is replacing it with something the double
// cannot evaluate — an unrecognised query throws, which surfaces as a refusal carrying a `cause`,
// and the assertions below require a refusal with NO cause.

type FakeEnumType = { oid: number; schema: string; name: string; labels: readonly string[] }

/**
 * A two-schema catalogue that can answer either question, so a test can tell them apart.
 *
 * It is not an SQL engine: it recognises the two statement SHAPES by their anchor — a `typname`
 * predicate, or a `to_regclass`/`attname` pair — and evaluates the corresponding lookup against the
 * modelled catalogue. Anything else is an error rather than an empty result, because "the double
 * did not understand the query" must never look like "the database has no such labels".
 */
function fakeCatalogue(input: {
  types: readonly FakeEnumType[]
  /** `table.column` -> the type OID that column is DECLARED as. */
  columns: Readonly<Record<string, number>>
}) {
  return async (sql: string, params: readonly string[]): Promise<Array<{ enumlabel: string }>> => {
    const byName = /typname\s*=\s*\$1/.test(sql)
    const byColumn = /attrelid\s*=\s*to_regclass\(\$1\)/.test(sql) && /attname\s*=\s*\$2/.test(sql)
    if (byName === byColumn) {
      throw new Error(`the catalogue double cannot evaluate this statement:\n${sql}`)
    }
    if (byName) {
      // Postgres semantics: every type of that name, in every schema, unioned.
      return input.types
        .filter((type) => type.name === params[0])
        .flatMap((type) => type.labels.map((enumlabel) => ({ enumlabel })))
    }
    const oid = input.columns[`${params[0]}.${params[1]}`]
    if (oid === undefined) return [] // no such table or column: zero rows, exactly as Postgres gives
    const type = input.types.find((candidate) => candidate.oid === oid)
    return (type?.labels ?? []).map((enumlabel) => ({ enumlabel }))
  }
}

/** The pre-fix statement, kept here only so a test can show that it PASSES where the new one refuses. */
const BY_NAME_SQL = 'SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = $1'

const PRE_MIGRATION_LABELS = ['PENDING_CREATE', 'PENDING_VERIFY', 'SYNCED', 'CANCELLED', 'DEAD_LETTER', 'HELD']

test('o3d-1izw gate: a same-named enum in ANOTHER schema does not vouch for the column', async () => {
  // THE FINDING, as a test. `legacy.WmsOrderPushState` has AMBIGUOUS_CREATE; the type
  // `wms_order_push_links.state` is actually declared as (`public.WmsOrderPushState`, OID 1) does
  // not. The write goes to the column, so only the column's own type may answer.
  //
  // Route: the shared WMS_PUSH_STATE_ENUM_LABELS_SQL, with WMS_PUSH_STATE_TABLE /
  // WMS_PUSH_STATE_COLUMN as $1/$2 -> pg_attribute.atttypid = 1 -> pg_enum for OID 1 ->
  // missingWmsPushStates finds AMBIGUOUS_CREATE absent -> WmsPushStateSchemaError.
  //
  // Mutation: put the anchor back to `WHERE t.typname = $1` (i.e. set the production constant to
  // BY_NAME_SQL) and the second assertion fails — the gate resolves, which is precisely the false
  // pass this test exists for, and the first assertion below documents that it really does.
  const {
    WMS_PUSH_STATE_COLUMN,
    WMS_PUSH_STATE_ENUM_LABELS_SQL,
    WMS_PUSH_STATE_TABLE,
  } = await import('../lib/domain/wms/push-state-enum-query.mjs')

  const catalogue = fakeCatalogue({
    types: [
      { oid: 1, schema: 'public', name: 'WmsOrderPushState', labels: PRE_MIGRATION_LABELS },
      { oid: 2, schema: 'legacy', name: 'WmsOrderPushState', labels: [...PRE_MIGRATION_LABELS, 'AMBIGUOUS_CREATE'] },
    ],
    // The column the claim writes is declared as the type that DOES NOT have the value.
    columns: { 'wms_order_push_links.state': 1 },
  })

  // 1. The bypass is real: the question the gate used to ask is answered "yes" by this database.
  const byName = createWmsPushStateSchemaGate(
    async () => (await catalogue(BY_NAME_SQL, ['WmsOrderPushState'])).map((row) => row.enumlabel),
    { onRefusal: () => {} },
  )
  await byName() // resolves — a type of that name carries the label, in a schema nothing writes to

  // 2. The question the gate asks NOW is answered "no", because it is asked of the column.
  const byColumn = createWmsPushStateSchemaGate(
    async () => (
      await catalogue(WMS_PUSH_STATE_ENUM_LABELS_SQL, [WMS_PUSH_STATE_TABLE, WMS_PUSH_STATE_COLUMN])
    ).map((row) => row.enumlabel),
    { onRefusal: () => {} },
  )
  await assert.rejects(byColumn(), (error: unknown) => {
    assert.ok(isWmsPushStateSchemaError(error))
    assert.deepEqual((error as WmsPushStateSchemaError).missing, ['AMBIGUOUS_CREATE'])
    // NO cause: this is the "the column's type lacks the value" refusal, not the "we could not ask"
    // one. Without this the test would also pass if the statement became unevaluable nonsense.
    assert.equal((error as Error & { cause?: unknown }).cause, undefined)
    return true
  })
})

test('o3d-1izw gate: the column-anchored query is not vacuous — it PASSES when the column\'s own type has the value', async () => {
  // NON-VACUITY. A query that always returned nothing would satisfy the test above while refusing
  // every database for ever, including a correctly migrated one. This is the same catalogue with
  // the column pointed at the type that DOES carry the label — the state after the migration —
  // and the same production statement.
  //
  // Route: shared SQL -> atttypid = 2 -> pg_enum for OID 2 -> nothing missing -> gate resolves.
  //
  // Mutation: break the join (e.g. `e.enumtypid = a.attrelid`) or drop the `to_regclass` lookup and
  // this fails — the gate refuses a database that is perfectly able to hold the value.
  const {
    WMS_PUSH_STATE_COLUMN,
    WMS_PUSH_STATE_ENUM_LABELS_SQL,
    WMS_PUSH_STATE_TABLE,
  } = await import('../lib/domain/wms/push-state-enum-query.mjs')

  const catalogue = fakeCatalogue({
    types: [
      { oid: 1, schema: 'public', name: 'WmsOrderPushState', labels: PRE_MIGRATION_LABELS },
      { oid: 2, schema: 'public', name: 'WmsOrderPushState', labels: [...PRE_MIGRATION_LABELS, 'AMBIGUOUS_CREATE'] },
    ],
    // A type REPLACED rather than altered: same name, new OID, and the column carries the new one.
    columns: { 'wms_order_push_links.state': 2 },
  })
  const gate = createWmsPushStateSchemaGate(async () => (
    await catalogue(WMS_PUSH_STATE_ENUM_LABELS_SQL, [WMS_PUSH_STATE_TABLE, WMS_PUSH_STATE_COLUMN])
  ).map((row) => row.enumlabel))
  await gate()
})

test('o3d-1izw gate: a MISSING table or column is a refusal, not a pass', async () => {
  // The search-path route, and the renamed/dropped-column route, land in the same place: the
  // catalogue lookup finds nothing, and zero rows is "every required value is missing".
  //
  // Route: shared SQL -> to_regclass finds no such relation -> no rows -> missingWmsPushStates([])
  // -> refusal.
  //
  // Mutation: make missingWmsPushStates treat an empty list as satisfied (`if (!present.length)
  // return []`) and this fails — a gate that reads "I could not find the table" as "the table is
  // fine" is the absence-as-an-answer shape this whole branch keeps finding.
  const {
    WMS_PUSH_STATE_COLUMN,
    WMS_PUSH_STATE_ENUM_LABELS_SQL,
    WMS_PUSH_STATE_TABLE,
  } = await import('../lib/domain/wms/push-state-enum-query.mjs')

  const catalogue = fakeCatalogue({
    types: [{ oid: 2, schema: 'legacy', name: 'WmsOrderPushState', labels: [...PRE_MIGRATION_LABELS, 'AMBIGUOUS_CREATE'] }],
    columns: {}, // the search path cannot see the table
  })
  const gate = createWmsPushStateSchemaGate(async () => (
    await catalogue(WMS_PUSH_STATE_ENUM_LABELS_SQL, [WMS_PUSH_STATE_TABLE, WMS_PUSH_STATE_COLUMN])
  ).map((row) => row.enumlabel), { onRefusal: () => {} })
  await assert.rejects(gate(), (error: unknown) => {
    assert.ok(isWmsPushStateSchemaError(error))
    assert.deepEqual((error as WmsPushStateSchemaError).missing, [...REQUIRED_WMS_PUSH_STATES])
    return true
  })
})

test('o3d-1izw: the runtime gate, the deploy check and the preflight ask the ONE shared statement, and none asks by type name', async () => {
  // COMMON MODE. Three gates that each spell the query out for themselves are one gate written
  // three times: the by-name bug was present in all three, so nothing could catch it. They now
  // share a single exported statement, and none of them may reconstruct a name-keyed one.
  //
  // Route: lib/domain/wms/order-push-sweep.ts, scripts/check-wms-push-state-enum.mjs and
  // lib/ops/production-preflight.ts -> WMS_PUSH_STATE_ENUM_LABELS_SQL.
  //
  // Mutation: inline a `pg_type ... typname` query back into any one of the three and this fails on
  // that file — which is the finding, and the reason it went unnoticed in all three at once.
  const { readFile } = await import('node:fs/promises')
  const sources = [
    '../lib/domain/wms/order-push-sweep.ts',
    '../scripts/check-wms-push-state-enum.mjs',
    '../lib/ops/production-preflight.ts',
  ]
  for (const relative of sources) {
    const source = await readFile(new URL(relative, import.meta.url), 'utf8')
    assert.match(source, /WMS_PUSH_STATE_ENUM_LABELS_SQL/, `${relative} asks the shared statement`)
    assert.doesNotMatch(source, /typname/, `${relative} must not identify the enum by name`)
    assert.doesNotMatch(source, /FROM pg_enum/, `${relative} must not hand-roll a catalogue query`)
  }

  const { WMS_PUSH_STATE_ENUM_LABELS_SQL, WMS_PUSH_STATE_TABLE, WMS_PUSH_STATE_COLUMN } =
    await import('../lib/domain/wms/push-state-enum-query.mjs')
  // The statement itself is anchored at the column, and parameterised rather than assembled.
  assert.match(WMS_PUSH_STATE_ENUM_LABELS_SQL, /a\.attrelid = to_regclass\(\$1\)/)
  assert.match(WMS_PUSH_STATE_ENUM_LABELS_SQL, /a\.attname = \$2/)
  assert.match(WMS_PUSH_STATE_ENUM_LABELS_SQL, /e\.enumtypid = a\.atttypid/)
  assert.doesNotMatch(WMS_PUSH_STATE_ENUM_LABELS_SQL, /typname/)
  assert.doesNotMatch(WMS_PUSH_STATE_ENUM_LABELS_SQL, new RegExp(WMS_PUSH_STATE_TABLE))
  assert.doesNotMatch(WMS_PUSH_STATE_ENUM_LABELS_SQL, new RegExp(`'${WMS_PUSH_STATE_COLUMN}'`))
})

test('o3d-1izw: the out-of-process gates align their search path with Prisma\'s', async () => {
  // `to_regclass` resolves through the ASKING connection's search path, which is what makes the
  // runtime gate answer about the table the writer writes. The deploy check and the preflight open
  // their own `pg` connections, and `pg` ignores the `?schema=` parameter Prisma sets search_path
  // from — so on a URL that names a schema they would resolve a different table, or none.
  //
  // Route: pgSearchPathOptions(DATABASE_URL) -> `options: -c search_path=...` on the pg Client.
  //
  // Mutation: return `{}` unconditionally and the first assertion fails; drop the spread from
  // either script and the source assertions below fail.
  const { pgSearchPathOptions } = await import('../lib/domain/wms/push-state-enum-query.mjs')
  assert.deepEqual(
    pgSearchPathOptions('postgresql://u:p@localhost:5432/ims?schema=ims_app'),
    { options: '-c search_path="ims_app"' },
  )
  // No schema named: leave the client alone rather than guessing a default.
  assert.deepEqual(pgSearchPathOptions('postgresql://u:p@localhost:5432/ims'), {})
  assert.deepEqual(pgSearchPathOptions('not a url'), {})

  const { readFile } = await import('node:fs/promises')
  for (const relative of ['../scripts/check-wms-push-state-enum.mjs', '../lib/ops/production-preflight.ts']) {
    const source = await readFile(new URL(relative, import.meta.url), 'utf8')
    assert.match(source, /\.\.\.pgSearchPathOptions\(databaseUrl\)/, `${relative} aligns its search path`)
  }
})
