/**
 * A Prisma client stand-in that RECORDS, and can prove that it does
 * (o3d-512h round 3).
 *
 * Codex round 3, finding 6: the refusal tests in this directory assert that a
 * guard threw, and then assert that a `dbTouches` array is empty — but an empty
 * array is also what you get from a recorder that is not wired to the module
 * under test, from a mock that was registered too late, or from a module that
 * was already loaded from an earlier import with the real client baked in. "No
 * read happened" was being CREDITED, not observed. That is the same vacuity
 * class this session has been hunting, sitting inside the tests written to prove
 * a security property.
 *
 * So the recorder proves itself. `prove()` runs a call that MUST reach the
 * database, in the same process, through the same module graph, and asserts a
 * touch was recorded; `assertNoReads()` refuses to pass until that has happened.
 * An empty touch list now means "this recorder, demonstrably wired to this
 * module, saw nothing" instead of "nothing was seen".
 *
 * It also records READS THAT NEVER BECAME CALLS. A guard that throws between
 * `db.setting` and `.findMany(...)` leaked no row, but a guard that throws after
 * the await did — and only the model-access record can tell those apart from a
 * recorder that saw nothing at all.
 *
 * Not named *.test.ts on purpose — `npm run test:unit` globs tests/**\/*.test.ts.
 */
import assert from 'node:assert/strict'

/** Property names an await/inspect touches that say nothing about a query. */
const NON_QUERY_KEYS = new Set(['then', 'catch', 'finally', 'constructor', 'toJSON', 'inspect'])

export type RecordingDb = {
  /** Pass this as the `db` named export to mock.module('@/lib/db', …). */
  readonly db: unknown
  /** `model.operation` for every operation actually invoked. */
  readonly calls: string[]
  /** Every model namespace reached, whether or not an operation followed. */
  readonly reaches: string[]
  reset(): void
  /**
   * Positive control. Runs `run`, which must reach the database, and records that
   * this recorder observes THIS module graph. Without it `assertNoReads` fails.
   */
  prove(run: () => Promise<unknown>): Promise<void>
  /** The refused path read nothing — and the recorder was proved to be able to see it. */
  assertNoReads(context: string): void
  /** The permitted path read exactly this. */
  assertCalls(expected: string[], context?: string): void
}

export type QueryContext = { model: string; op: string; args: unknown[] }

/**
 * The part of a query that CONSTRAINS WHICH ROWS it touches.
 *
 * o3d-512h round 5, Codex finding 4. The self-scoping proof asked whether the
 * caller's id appeared anywhere in the argument object:
 *
 *   JSON.stringify(ctx.args).includes(CALLER_ID)
 *
 * which every one of these satisfies without scoping anything to the caller:
 *
 *   db.user.findMany({ where: { role: 'ADMIN' }, select: { id: true, ownerId: true } })
 *   db.thing.updateMany({ where: { id }, data: { updatedById: session.user.id } })
 *   db.thing.findMany({ orderBy: { ownerId: 'asc' } })
 *
 * `data` records who ACTED; `where` records whose rows were REACHED, and only the
 * second is the question. A proof that reads the whole argument object credits
 * the audit trail as if it were the constraint — the branch's own defect, this
 * time inside the test written to replace a withdrawn static claim.
 *
 * So the constraint is named per operation rather than assumed:
 *   * a read/update/delete is scoped by `where`;
 *   * a `create` has no `where` — the row is attached to the caller by its
 *     `data`, so that IS the constraint for a create and nothing else is;
 *   * an operation not on either list, and a call with no argument at all
 *     (`findMany()` reads the table), has NO constraint. That is unscoped, which
 *     is the direction that turns the test red.
 */
const WHERE_SCOPED_OPS = new Set([
  'findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany',
  'update', 'updateMany', 'updateManyAndReturn', 'upsert',
  'delete', 'deleteMany', 'count', 'aggregate', 'groupBy',
])

const DATA_SCOPED_OPS = new Set(['create', 'createMany', 'createManyAndReturn'])

/** The constraint region of a query, or undefined when it has none. */
export function queryConstraint(ctx: QueryContext): unknown {
  const arg = ctx.args[0]
  if (!arg || typeof arg !== 'object') return undefined
  const record = arg as Record<string, unknown>
  if (WHERE_SCOPED_OPS.has(ctx.op)) return record.where
  if (DATA_SCOPED_OPS.has(ctx.op)) return record.data
  return undefined
}

/**
 * Does the query's CONSTRAINT carry `needle`?
 *
 * Only the constraint is searched — never `select`, `include`, `orderBy`, or a
 * `data` payload on an operation that also has a `where`.
 */
export function constraintMentions(ctx: QueryContext, needle: string): boolean {
  const constraint = queryConstraint(ctx)
  if (constraint === undefined) return false
  try {
    return JSON.stringify(constraint)?.includes(needle) ?? false
  } catch {
    return false
  }
}

/**
 * `result` may be a value, or a function of the query — the latter is how a test
 * asks "what would this action do if the row belonged to SOMEONE ELSE", which is
 * the only way to test a row-scoping control rather than a permission check.
 */
export function createRecordingDb(
  result: unknown | ((ctx: QueryContext) => unknown) = [],
): RecordingDb {
  const calls: string[] = []
  const reaches: string[] = []
  let proved = false

  const db: unknown = new Proxy({}, {
    get(_t, model) {
      if (typeof model !== 'string' || NON_QUERY_KEYS.has(model)) return undefined

      // Top-level client methods (`$transaction`, `$queryRaw`, `$executeRaw`) are
      // functions on the client itself, not model namespaces. A recorder that
      // modelled them as namespaces would throw where real code works, and a test
      // that crashes proves nothing about a guard.
      if (model.startsWith('$')) {
        return (...args: unknown[]) => {
          calls.push(model)
          const first = args[0]
          if (typeof first === 'function') {
            return Promise.resolve((first as (tx: unknown) => unknown)(db))
          }
          return Promise.resolve(
            typeof result === 'function'
              ? (result as (ctx: QueryContext) => unknown)({ model, op: model, args })
              : result,
          )
        }
      }

      reaches.push(model)
      return new Proxy({}, {
        get(_t2, op) {
          if (typeof op !== 'string' || NON_QUERY_KEYS.has(op)) return undefined
          return (...args: unknown[]) => {
            calls.push(`${model}.${op}`)
            return Promise.resolve(
              typeof result === 'function'
                ? (result as (ctx: QueryContext) => unknown)({ model, op, args })
                : result,
            )
          }
        },
      })
    },
  })

  const recorder: RecordingDb = {
    db,
    calls,
    reaches,
    reset() {
      calls.length = 0
      reaches.length = 0
    },
    async prove(run) {
      recorder.reset()
      await run()
      assert.ok(
        calls.length > 0,
        'the recording db proxy observed NOTHING on a call that must read the database. '
        + 'The mock is not wired to the module under test (registered after the import, wrong '
        + 'specifier, or the module was already loaded), so every "no read happened" assertion '
        + 'in this file would pass vacuously.',
      )
      proved = true
      recorder.reset()
    },
    assertNoReads(context) {
      assert.ok(
        proved,
        `${context}: the recorder has not been proved to observe this module's reads. `
        + 'Call recorder.prove(...) in a before() hook with a call that is expected to succeed, '
        + 'or an empty touch list means nothing.',
      )
      assert.deepEqual(
        { calls, reaches },
        { calls: [], reaches: [] },
        `${context}: refused call must not touch the database, but reached [${reaches.join(', ')}] `
        + `and invoked [${calls.join(', ')}]`,
      )
    },
    assertCalls(expected, context = 'permitted call') {
      assert.deepEqual(calls, expected, `${context}: unexpected database calls`)
    },
  }

  return recorder
}
