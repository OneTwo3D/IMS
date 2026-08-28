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
  // Route: pgConnectionConfig(DATABASE_URL) -> the WHOLE `pg` Client config — connection string and
  // `options: -c search_path=...` composed together, because a connection string set separately
  // overrides the options beside it (r10, below).
  //
  // Mutation: return `{}` unconditionally and the first assertion fails; drop the spread from
  // either script and the source assertions below fail.
  const { pgConnectionConfig } = await import('../lib/domain/wms/push-state-enum-query.mjs')
  const { PRISMA_DEFAULT_SCHEMA, resolveDatabaseUrlSchema } = await import('../lib/db/database-url-schema.mjs')
  assert.deepEqual(
    pgConnectionConfig('postgresql://u:p@localhost:5432/ims?schema=ims_app'),
    { connectionString: 'postgresql://u:p@localhost:5432/ims?schema=ims_app', options: '-c search_path="ims_app"' },
  )
  // NO SCHEMA NAMED IS NOT "NOTHING TO ALIGN" (r9). Round 8 returned `{}` here, on the reasoning
  // that Prisma and pg both fall back to the server default and so already agree. Prisma does not
  // fall back to the server default at all — see the compiled-SQL test below — so leaving the raw
  // client on `"$user", public` is the same split, running the other way. The default is therefore
  // stated, not left implicit.
  assert.deepEqual(
    pgConnectionConfig('postgresql://u:p@localhost:5432/ims'),
    { connectionString: 'postgresql://u:p@localhost:5432/ims', options: `-c search_path="${PRISMA_DEFAULT_SCHEMA}"` },
  )
  // PARSE FAILURE STAYS DISTINCT FROM SCHEMA ABSENCE. It is the only input that still yields no
  // schema, and it means the opposite thing: not "align me to the default" but "there is no
  // connection here to align". Collapsing the two back into one `null` is what let the default case
  // hide inside the "nothing to do" branch for a whole round.
  //
  // Mutation: make `resolveDatabaseUrlSchema` return `PRISMA_DEFAULT_SCHEMA` on the catch path (or
  // `null` for a valid URL with no `?schema=`) and the two `parsed`/`explicit` assertions below
  // fail even though the options above are unchanged.
  assert.deepEqual(pgConnectionConfig('not a url'), { connectionString: 'not a url' })
  assert.deepEqual(
    resolveDatabaseUrlSchema('not a url'),
    { parsed: false, explicit: false, schema: null },
  )
  assert.deepEqual(
    resolveDatabaseUrlSchema('postgresql://u:p@localhost:5432/ims'),
    { parsed: true, explicit: false, schema: PRISMA_DEFAULT_SCHEMA },
  )
  assert.deepEqual(
    resolveDatabaseUrlSchema('postgresql://u:p@localhost:5432/ims?schema=ims_app'),
    { parsed: true, explicit: true, schema: 'ims_app' },
  )

  const { readFile } = await import('node:fs/promises')
  for (const relative of ['../scripts/check-wms-push-state-enum.mjs', '../lib/ops/production-preflight.ts']) {
    const source = await readFile(new URL(relative, import.meta.url), 'utf8')
    assert.match(source, /\.\.\.pgConnectionConfig\(databaseUrl\)/, `${relative} aligns its search path`)
  }
})

test('o3d-1izw: on a non-public `?schema=` URL the RUNTIME resolves what the two external gates resolve', async () => {
  // THE R7 FINDING, AS A TEST. Round 7 aligned the deploy check and the production preflight to the
  // URL's schema — with each other. The application was left out: `new PrismaPg(dbPoolConfig())`
  // passed no `{ schema }`, so `getConnectionInfo()` reported no `schemaName`; and the pool carried
  // no startup `options`, so its connections ran on the server-default `search_path` — which is
  // exactly what `to_regclass($1)` in the shared statement resolves through. Both release gates
  // could therefore inspect and PASS `ims_app.wms_order_push_links` while the runtime looked
  // elsewhere, and the runtime gate would refuse after deployment: a WMS fulfilment outage with two
  // green gates. A gate has to be aligned to the thing it checks, not to the other gates.
  //
  // Route: DATABASE_URL=...?schema=ims_app -> lib/db/database-url-schema.mjs `databaseUrlSchema`
  // -> (a) `pgConnectionConfig` -> `dbPoolConfig().options` -> the pg Pool's startup search_path,
  //    which the runtime gate's `$queryRawUnsafe` resolves through;
  //    (b) `prismaAdapterSchemaOptions` -> `createDbAdapter()`'s second argument -> PrismaPg
  //    `getConnectionInfo().schemaName`, which qualifies Prisma's generated queries;
  //    compared against the value the two external clients spread in, read here through the WMS
  //    module those two gates import it from.
  //
  // Mutation, either half: drop the second argument from `createDbAdapter()` and `schemaName` is
  // `undefined`; drop the `...pgConnectionConfig(...)` spread from `dbPoolConfig()` and both pool
  // assertions fail. In BOTH cases the external gates still pass unchanged — which is the finding.
  const before = process.env.DATABASE_URL
  const url = 'postgresql://u:p@localhost:5432/ims?schema=ims_app'
  process.env.DATABASE_URL = url
  try {
    const { createDbAdapter, dbPoolConfig } = await import('@/lib/db')
    // Deliberately imported from the WMS module the deploy check and the preflight import it from,
    // so this compares the runtime against THEIR source of truth rather than against a third copy.
    const { pgConnectionConfig } = await import('../lib/domain/wms/push-state-enum-query.mjs')

    const external = pgConnectionConfig(url)
    assert.equal(
      external.options, '-c search_path="ims_app"',
      'the external gates put the URL\'s schema on their own connection',
    )

    // 1. THE RAW-QUERY SEARCH PATH. This is the one the o3d-1izw runtime gate actually resolves
    //    through, and `PrismaPg`'s `{ schema }` option does NOT cover it — it qualifies generated
    //    queries only, never `$queryRaw*`.
    assert.equal(
      dbPoolConfig().options, external.options,
      'the runtime pool starts every connection on the same search_path the external gates use',
    )

    // 2. THE ADAPTER'S SCHEMA. Built through the exact factory production uses — not re-described
    //    here — and connected, which for `pg` is lazy and opens no socket.
    const adapter = await createDbAdapter().connect()
    try {
      assert.equal(
        adapter.getConnectionInfo().schemaName, 'ims_app',
        'the runtime adapter reports the URL\'s schema, so generated queries are qualified with it',
      )
      const pool = adapter.underlyingDriver() as unknown as { options?: { options?: string } }
      assert.equal(
        pool.options?.options, external.options,
        'and the pool the adapter built for itself carries that startup search_path',
      )
    } finally {
      await adapter.dispose()
    }

    // NON-VACUITY. Without this, a `pgConnectionConfig`/`prismaAdapterSchemaOptions` pair that
    // returned the ims_app values unconditionally would satisfy everything above. A URL naming no
    // schema must produce Prisma's OWN default on both halves — not `ims_app`, and (since r9) not
    // nothing.
    const { PRISMA_DEFAULT_SCHEMA } = await import('../lib/db/database-url-schema.mjs')
    process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/ims'
    assert.equal(dbPoolConfig().options, `-c search_path="${PRISMA_DEFAULT_SCHEMA}"`)
    const plain = await createDbAdapter().connect()
    try {
      assert.equal(plain.getConnectionInfo().schemaName, PRISMA_DEFAULT_SCHEMA)
    } finally {
      await plain.dispose()
    }
  } finally {
    if (before === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = before
  }
})

/**
 * Compile one GENERATED query for the WMS push-link model through the REAL generated Prisma client
 * and return the SQL it produced — without a database.
 *
 * This is the only way to answer the question the r9 finding turns on, which is not "what does the
 * adapter report?" but "what schema does Prisma actually WRITE to?". The two are not the same: the
 * adapter's `schemaName` is an input to the query compiler, and what the compiler does when that
 * input is absent is a property of the installed client that no amount of config inspection
 * reveals. So the client is built for real, the query is compiled for real, and the SQL is
 * intercepted at the driver boundary — the adapter's own `queryRaw`, wrapped in a Proxy so the
 * factory this repository ships is the one under test rather than a stand-in — and refused before
 * it can reach a socket. `pg`'s pool is lazy, so nothing connects.
 */
async function compileWmsPushLinkSql(adapterFactory: unknown): Promise<string> {
  const { PrismaClient } = await import('@/app/generated/prisma/client')
  const compiled: string[] = []
  class InterceptedBeforeExecution extends Error {}
  const recording = new Proxy(adapterFactory as Record<string, unknown>, {
    get(target, prop, receiver) {
      if (prop === 'connect') {
        return async () => {
          const connection = await (target as { connect: () => Promise<object> }).connect()
          return new Proxy(connection as Record<string, unknown>, {
            get(conn, key, innerReceiver) {
              if (key === 'queryRaw' || key === 'executeRaw') {
                return async (query: { sql: string }) => {
                  compiled.push(query.sql)
                  throw new InterceptedBeforeExecution('captured')
                }
              }
              const value = Reflect.get(conn, key, innerReceiver)
              return typeof value === 'function' ? value.bind(conn) : value
            },
          })
        }
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const client = new PrismaClient({ adapter: recording as never })
  try {
    await client.wmsOrderPushLink.findFirst({ where: { orderId: 'o3d-1izw-compile-probe' } })
  } catch {
    // The interception above is the expected outcome; a real failure shows up as no captured SQL.
  } finally {
    try {
      await client.$disconnect()
    } catch {
      // nothing was ever connected
    }
  }
  assert.equal(compiled.length > 0, true, 'the generated client compiled and dispatched a query')
  return compiled[0]!
}

/** The schema a compiled statement qualifies the WMS push-link table with. */
function qualifiedSchemaOf(sql: string): string | undefined {
  return /FROM "([^"]+)"\."wms_order_push_links"/.exec(sql)?.[1]
}

/** The schema a `-c search_path="..."` startup option puts `to_regclass()` on. */
function searchPathSchemaOf(options: string | undefined): string | undefined {
  return options === undefined ? undefined : /^-c search_path="(.*)"$/.exec(options)?.[1]?.replace(/""/g, '"')
}

test('o3d-1izw r9: the SQL the generated client compiles is qualified to the schema `to_regclass` resolves — including on a URL that names none', async () => {
  // THE R9 FINDING, AS A TEST, AND THE ONE THE PREVIOUS ROUNDS COULD NOT STATE. Every earlier
  // assertion here compared CONFIGURATION — `getConnectionInfo().schemaName` against a pg `options`
  // string — which can only show that two settings match. It cannot show what Prisma does with the
  // setting, and the finding is precisely about the case where the setting is ABSENT: an adapter
  // reporting no `schemaName` does not fall back to the connection's `search_path`, it qualifies
  // generated queries against a hardcoded `"public"`. Configuration inspection reads that as "both
  // sides on the default, therefore aligned"; the compiled SQL says otherwise.
  //
  // So this compiles a real WMS query through the real generated client and compares the schema in
  // the SQL against the schema `to_regclass($1)` — the shared catalogue statement the runtime gate,
  // the deploy check and the production preflight all run — resolves through. That is the actual
  // property at stake: the gate and the write must name the same table.
  //
  // Route: DATABASE_URL -> lib/db/database-url-schema.mjs -> (a) prismaAdapterSchemaOptions ->
  // createDbAdapter()'s `{ schema }` -> the query compiler's qualification of every generated
  // statement, captured here at the driver boundary; (b) pgConnectionConfig -> dbPoolConfig()
  // `options` -> the pool's startup search_path, which is what `to_regclass($1)` resolves through
  // for the runtime gate and what the two out-of-process gates spread into their own pg Client.
  //
  // Mutation, no-schema URL: revert `resolveDatabaseUrlSchema` to return `null` for a valid URL
  // with no `?schema=` (the r8 behaviour). `prismaAdapterSchemaOptions` goes back to `undefined`,
  // the compiled SQL still says `public` — and `dbPoolConfig().options` becomes `undefined`, so
  // `searchPathSchemaOf` returns `undefined` and the equality below fails. That is the finding:
  // the write is pinned to `public` while the three gates are left on the server default.
  //
  // Mutation, ?schema= URL: drop the second argument from `createDbAdapter()` and the compiled SQL
  // reverts to `"public"."wms_order_push_links"` while the search path still says `ims_app` — the
  // r8 finding, now visible in the SQL rather than in a reported setting.
  //
  // Mutation, the constant: change `PRISMA_DEFAULT_SCHEMA` to anything else and the control below
  // fails, because it is checked against what Prisma actually compiles rather than trusted.
  const before = process.env.DATABASE_URL
  try {
    const { createDbAdapter, dbPoolConfig } = await import('@/lib/db')
    const { PRISMA_DEFAULT_SCHEMA } = await import('../lib/db/database-url-schema.mjs')

    // 1. A URL THAT NAMES NO SCHEMA — the case r8 left split, and the shape most URLs have.
    process.env.DATABASE_URL = 'postgresql://u:p@127.0.0.1:5432/ims'
    const plainSql = await compileWmsPushLinkSql(createDbAdapter())
    const plainWritten = qualifiedSchemaOf(plainSql)
    const plainResolved = searchPathSchemaOf(dbPoolConfig().options)
    assert.equal(
      plainWritten, PRISMA_DEFAULT_SCHEMA,
      'the generated WMS write is qualified to Prisma\'s default',
    )
    assert.equal(
      plainWritten, plainResolved,
      'and `to_regclass` resolves that same schema, so all three gates inspect the table the write targets',
    )

    // 2. A URL THAT NAMES ONE — the r8 case, re-proved against compiled SQL rather than settings.
    process.env.DATABASE_URL = 'postgresql://u:p@127.0.0.1:5432/ims?schema=ims_app'
    const namedSql = await compileWmsPushLinkSql(createDbAdapter())
    const namedWritten = qualifiedSchemaOf(namedSql)
    assert.equal(namedWritten, 'ims_app', 'the generated WMS write follows the URL\'s schema')
    assert.equal(
      namedWritten, searchPathSchemaOf(dbPoolConfig().options),
      'and so does the search path the gates resolve `to_regclass` through',
    )
    // NON-VACUITY for the pair above: the two cases must not be the same string, or an
    // unconditional `public` on both halves would satisfy everything.
    assert.notEqual(namedWritten, plainWritten)

    // 3. THE CONTROL THAT MAKES `PRISMA_DEFAULT_SCHEMA` A MEASUREMENT AND NOT A GUESS, and that
    //    demonstrates the defect this fix removes. An adapter built with NO schema option at all —
    //    `new PrismaPg(config)`, exactly what `createDbAdapter()` did before r8 — still compiles
    //    against a hardcoded schema, on a URL whose search path is free to point somewhere else.
    const { PrismaPg } = await import('@prisma/adapter-pg')
    const unqualifiedSql = await compileWmsPushLinkSql(
      new PrismaPg({ connectionString: 'postgresql://u:p@127.0.0.1:5432/ims', max: 2 }),
    )
    assert.equal(
      qualifiedSchemaOf(unqualifiedSql), PRISMA_DEFAULT_SCHEMA,
      'an adapter reporting no schemaName qualifies generated queries with PRISMA_DEFAULT_SCHEMA — which is why the default is stated rather than left implicit',
    )
  } finally {
    if (before === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = before
  }
})

// ---------------------------------------------------------------------------
// o3d-2k5r r10 — THE URL'S OWN `options` OVERRODE THE PIN.
//
//   HIGH  `pg` parses `connectionString` AFTER the surrounding config object and assigns the
//         result over it (pg/lib/connection-parameters.js:60). Every gate here set
//         `connectionString` itself and spread a separate `{ options }` beside it, so a URL
//         carrying its own `options=-c search_path=...` won: the config visibly said `ims_app`
//         and the client sent `legacy`.
//
// These tests build a REAL `pg` Client and read `connectionParameters.options` — the value that
// goes into the startup packet. The r9 test compared `dbPoolConfig().options`, which is the
// config the driver then overrode, so it could not see this at all.
// ---------------------------------------------------------------------------

/** The startup `options` the installed pg driver would really send for a config. */
async function effectiveStartupOptions(config: Record<string, unknown>): Promise<string | undefined> {
  const { Client } = await import('pg')
  const client = new Client(config as never) as unknown as { connectionParameters: { options?: string } }
  return client.connectionParameters.options
}

test('o3d-2k5r r10: an `options` inside DATABASE_URL cannot override the pinned search path', async () => {
  const { pgConnectionConfig } = await import('../lib/domain/wms/push-state-enum-query.mjs')

  // PRECONDITION, MEASURED ON THE INSTALLED DRIVER RATHER THAN DESCRIBED: the composition this
  // replaces really is overridden. If pg ever stops doing this, this assertion fails and the
  // change below is re-argued from fact instead of being carried on faith.
  const url = 'postgresql://u:p@localhost:5432/ims?schema=ims_app&options=-c%20search_path%3Dlegacy'
  assert.equal(
    await effectiveStartupOptions({ connectionString: url, options: '-c search_path="ims_app"' }),
    '-c search_path=legacy',
    'precondition: connectionString is parsed last and overwrites the options beside it',
  )

  // MUTATION ROUTE: return `{ options }` alone from pgConnectionConfig() and let the call sites go
  // back to setting `connectionString: databaseUrl` themselves. The URL below then reaches the
  // driver with its own `options` intact and this assertion reads `-c search_path=legacy` while
  // Prisma's generated queries stay on `ims_app` — the finding, exactly.
  const carried = 'postgresql://u:p@localhost:5432/ims?options=-c%20search_path%3Dlegacy%20-c%20statement_timeout%3D5000'
  const config = pgConnectionConfig(carried)
  assert.equal(
    await effectiveStartupOptions({ ...config, connectionTimeoutMillis: 5_000 }),
    '-c statement_timeout=5000 -c search_path="legacy"',
    'the effective startup options are the ones this module composed, not the URL\'s',
  )
  assert.doesNotMatch(config.connectionString, /options=/, 'and the URL no longer carries an options for pg to re-apply')

  // A URL WITH NO `options` IS UNCHANGED, so the ordinary case still reaches the driver as before.
  assert.equal(
    await effectiveStartupOptions({ ...pgConnectionConfig('postgresql://u:p@localhost:5432/ims?schema=ims_app') }),
    '-c search_path="ims_app"',
  )
})

test('o3d-2k5r r10: a search_path written in the URL NAMES the schema; two different names are refused', async () => {
  const { pgConnectionConfig, DatabaseUrlSchemaConflictError, resolveDatabaseUrlSchema, prismaAdapterSchemaOptions } =
    await import('../lib/db/database-url-schema.mjs')

  // WHAT WINS, STATED AS A TEST. The URL's `search_path` is not the loser of a precedence fight —
  // it is READ, and it decides the schema for BOTH halves. An operator who wrote the pg-native
  // spelling gets that schema on the adapter too, so the generated queries and the raw gates still
  // resolve one place.
  //
  // MUTATION ROUTE: make searchPathSchemaOf() return null (i.e. ignore the URL's search_path and
  // just overwrite it). The schema below becomes PRISMA_DEFAULT_SCHEMA — the pin silently defeats
  // an explicit instruction, which is the half of the finding that is NOT about precedence.
  const native = 'postgresql://u:p@localhost:5432/ims?options=-c%20search_path%3Dlegacy'
  assert.deepEqual(resolveDatabaseUrlSchema(native), { parsed: true, explicit: true, schema: 'legacy' })
  assert.deepEqual(prismaAdapterSchemaOptions(native), { schema: 'legacy' })
  assert.equal(pgConnectionConfig(native).options, '-c search_path="legacy"')

  // AND A URL THAT NAMES TWO SCHEMAS IS REFUSED, not resolved to either. Prisma qualifies
  // generated queries with exactly one name; a URL supplying two IS the divergence these gates
  // exist to catch, so the runtime does not boot, the deploy check exits non-zero and the
  // preflight fails — all with one sentence naming both.
  //
  // MUTATION ROUTE: replace the throw with `named ?? fromOptions`. Every assertion in this block
  // stops throwing and the config resolves to `ims_app` while the driver is told `legacy`.
  const contradictory = 'postgresql://u:p@localhost:5432/ims?schema=ims_app&options=-c%20search_path%3Dlegacy'
  for (const call of [
    () => resolveDatabaseUrlSchema(contradictory),
    () => pgConnectionConfig(contradictory),
    () => prismaAdapterSchemaOptions(contradictory),
  ]) {
    assert.throws(call, (error: unknown) => {
      assert.ok(error instanceof DatabaseUrlSchemaConflictError)
      assert.match((error as Error).message, /ims_app/)
      assert.match((error as Error).message, /legacy/)
      return true
    })
  }

  // A search_path that is a LIST is not a schema this can pin anything to: `to_regclass()` would
  // resolve through every element while Prisma qualified with one. Refused for the same reason.
  //
  // MUTATION ROUTE: return the first element instead of throwing, and a URL whose table lives in
  // the SECOND element passes every gate while generated writes go to the first.
  assert.throws(
    () => pgConnectionConfig('postgresql://u:p@localhost:5432/ims?options=-c%20search_path%3Dims_app,public'),
    DatabaseUrlSchemaConflictError,
  )
  // The control: the same schema said twice, in both spellings, is agreement and not a conflict.
  assert.equal(
    pgConnectionConfig('postgresql://u:p@localhost:5432/ims?schema=ims_app&options=-c%20search_path%3D%22ims_app%22').options,
    '-c search_path="ims_app"',
  )
})

test('o3d-2k5r r10: the runtime pool, the deploy check and the preflight all reach the driver with the same effective search path', async () => {
  // THE FINDING AT THE BOUNDARY, FOR ALL THREE CONSUMERS AT ONCE. Codex's next step asked for
  // exactly this: the effective `connectionParameters.options` for the runtime, deploy-check and
  // preflight configurations, on a URL that carries its own `options`.
  //
  // MUTATION ROUTE: restore `connectionString: databaseUrl` + a separate `...pgConnectionConfig()`
  // spread at ANY ONE of the three call sites (or move the spread after the connection string in
  // dbPoolConfig()) and that one assertion reads `-c search_path=legacy`.
  const before = process.env.DATABASE_URL
  const url = 'postgresql://u:p@localhost:5432/ims?schema=ims_app&options=-c%20application_name%3Dims'
  process.env.DATABASE_URL = url
  try {
    const { dbPoolConfig } = await import('@/lib/db')
    const { pgConnectionConfig } = await import('../lib/domain/wms/push-state-enum-query.mjs')
    const expected = '-c application_name=ims -c search_path="ims_app"'

    assert.equal(await effectiveStartupOptions(dbPoolConfig()), expected, 'the runtime pool')
    assert.equal(
      await effectiveStartupOptions({ ...pgConnectionConfig(url), connectionTimeoutMillis: 10_000 }),
      expected,
      'the deploy check',
    )
    assert.equal(
      await effectiveStartupOptions({ ...pgConnectionConfig(url), connectionTimeoutMillis: 5_000 }),
      expected,
      'the preflight',
    )

    // And the setting the URL asked for that is NOT search_path survived: pinning the schema must
    // not quietly throw away a caller's other startup settings.
    assert.match(expected, /application_name=ims/)
  } finally {
    if (before === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = before
  }
})
