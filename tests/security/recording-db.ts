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

import { installedPrismaFilterOperators } from './installed-prisma'

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
 * Predicate positions inside a constraint that do NOT restrict the returned rows
 * to the ones carrying `needle` (o3d-512h round 6, Codex finding 4).
 *
 * Round 5 narrowed the search from the whole argument object to the constraint
 * and then matched by SUBSTRING inside it — so the constraint was read as text,
 * and every one of these satisfied "the caller's id is in the where":
 *
 *   where: { NOT: { userId: 'u1' } }          // everyone EXCEPT the caller
 *   where: { id: { not: 'u1' } }              // the same, spelled as a filter
 *   where: { userId: { notIn: ['u1'] } }      // and again
 *   where: { passkeys: { none: { userId: 'u1' } } }   // rows with none of theirs
 *   where: { OR: [{ userId: 'u1' }, { public: true }] }  // or anybody's
 *
 * The first four are not a weaker form of scoping — they are its COMPLEMENT, and
 * the predicate reported them as proof. `OR` was named as a stated limit rather
 * than a defect, but a stated limit that the test then counts as evidence is
 * still evidence that is not there: a disjunct constrains no row on its own.
 *
 * `every` joins them: `{ items: { every: { ownerId: 'u1' } } }` is vacuously true
 * for a row with no items, so it reaches rows related to nobody.
 */
/**
 * o3d-512h round 7, Codex finding 4 — THE REST OF THEM.
 *
 * Round 6 refused negation, exclusion, absence, the universal quantifier and
 * disjunction, and required a string VALUE. Every one of those was right, and the
 * list was still a list of the cases someone had thought of. What survived is a
 * whole family of predicates that carry the caller's id and constrain rows that
 * are not the caller's — because they do not test EQUALITY with it:
 *
 *   where: { name: { contains: 'u1' } }        // every row whose name contains it
 *   where: { key: { startsWith: 'u1' } }       // …begins with it
 *   where: { id: { gt: 'u1' } }                // every row ordered after it
 *   where: { tags: { hasSome: ['u1', 'x'] } }  // rows with EITHER — `in`, spelled for lists
 *
 * A partial match and a range bound are not weak scoping, they are a different
 * relation: `contains` is satisfied by a row belonging to `u10`, and `gt` is
 * satisfied by every row in the table above the caller. The round-6 predicate
 * credited all four, because it looked at the KEY only to refuse the negatives and
 * then fell through to a substring test on the value.
 *
 * `hasNone` joins the negatives; `hasSome` joins `in` as disjunctive membership,
 * and `in` was already singleton-only.
 */
/**
 * o3d-512h round 8, Codex finding 4 — THE WALK CREDITED WHAT IT DID NOT RECOGNISE.
 *
 * Rounds 6 and 7 answered this question by growing a list of keys to REFUSE, and
 * the answer was right about every key on it. The list is the defect. A walk that
 * refuses the predicates someone thought of and credits everything else has its
 * default in the wrong direction, and two whole classes were still walking
 * through it at the end of round 7:
 *
 *   where: { id: 'u1-victim' }                    // the caller's id as a PREFIX
 *   where: { userId: { notStartsWith: 'u1' } }    // a negation nobody listed
 *
 * The first is not an operator question at all — it is the leaf. Every round of
 * this predicate has ended with `node.includes(needle)`, so a value that merely
 * CONTAINS the caller's id was proof of scoping: with a caller id of `u1`, rows
 * belonging to `u10`, `u1x` and `u1-victim` all "scoped to the caller". The
 * structural rounds were tightening the route to a leaf that never checked
 * anything. The second is the list's own shape: `notIn`, `not`, `none`, `hasNone`
 * and `isNot` are refused by name, and `notStartsWith` — same family, same
 * meaning, not on the list — was credited as scoping.
 *
 * So the walk is inverted. It now knows two POSITIONS and moves between them:
 *
 *   * FILTER position — a `where`, a `data`, or a nested relation `where`. Its
 *     keys are FIELD NAMES, plus the three logical operators. `AND` is followed,
 *     `OR` and `NOT` are refused, a field's value is descended into.
 *   * OPERATOR position — the object value of a field, e.g. `{ equals: … }`,
 *     `{ some: … }`. Its keys are Prisma OPERATORS, and only the operators on
 *     SCOPING_OPERATORS are followed. Every other KNOWN operator is refused, and
 *     an object that MIXES known operators with unknown keys is an unrecognised
 *     shape and is refused whole — which is the case the old walk would have
 *     credited on the strength of the unknown key alone.
 *
 * and the leaf is a WHOLE-SEGMENT match rather than a substring: the needle must
 * occupy a complete run of identifier characters. `passkey_challenge:reg:u1` still
 * scopes — that is the real one-time-token shape and the reason a bare `===` will
 * not do — while `u1-victim`, `u10` and `xu1` no longer do.
 *
 * WHAT IS STILL OPEN, named rather than left to be found: a field's object value
 * whose keys are ALL unknown to this file is read as the to-one relation shorthand
 * (`owner: { id: 'u1' }`) and descended into as a filter. A Prisma operator added
 * after this list was written, appearing alone, lands there. Two things narrow it:
 * a key spelled like a negation is refused wherever it appears, by prefix and not
 * by membership (`isNegationKey`), and the leaf must still carry the caller's id
 * as a whole segment. What is left is a positively-spelled future operator that
 * does not mean equality — and that one is a diff to this file, not a silent pass,
 * the day the operator vocabulary below stops matching Prisma's.
 *
 * ROUND 9 CLOSED BOTH HALVES OF THAT PARAGRAPH. The vocabulary is no longer a
 * literal that can stop matching Prisma's — it is READ from the installed
 * generated client, so the operators Prisma has are the operators this file knows
 * (finding 3, below). And the whole-segment leaf was over-crediting on the other
 * side: a boundary was any non-identifier character, which made a SPACE a
 * boundary, so `description: 'created by u1'` was proof of scoping in any field
 * at all (finding 4, at stringCarries).
 */

/** Operators that restrict every row the query reaches to ones carrying the needle. */
const SCOPING_OPERATORS = new Set([
  'equals',     // the explicit spelling of the scalar equality a bare value means
  'is',         // to-one relation: the related row must match
  'some',       // to-many relation: at least one related row must match
  'has',        // scalar list contains the value
  'in',         // ONLY as a singleton — enforced at the call site, not here
])

/**
 * Operators that do NOT, with the reason each is on this side.
 *
 * Kept explicit rather than "everything not above" because the difference between
 * the two sets is the whole judgement, and a reviewer must be able to read it.
 */
const NON_SCOPING_OPERATORS = new Set([
  // Negation, exclusion, absence — the complement of scoping.
  'not', 'notIn', 'none', 'isNot', 'hasNone', 'isEmpty', 'isSet',
  // Vacuously true for a row with no related rows at all.
  'every',
  // Disjunctive membership: an arm constrains no row on its own.
  'hasSome',
  // Partial match: satisfied by rows that merely CONTAIN the id.
  'contains', 'startsWith', 'endsWith', 'search',
  // Range: satisfied by every row on one side of the id.
  'gt', 'gte', 'lt', 'lte',
  // Under-credited on purpose: `hasEvery: ['u1', 'x']` does scope, and refusing it
  // costs a red build on good code rather than a green one on bad.
  'hasEvery',
  // Modifiers, not predicates.
  'mode',
])

/**
 * o3d-512h round 9, Codex finding 3 — THE VOCABULARY IS READ, NOT WRITTEN.
 *
 * Round 8's own report named this as the residue it would not ship blind: "the
 * operator vocabulary is still a list, and lists in this file have lost every
 * round they have been in." It lost again. The two sets above are the reviewed
 * JUDGEMENT — which operators scope and which do not — and that part has to be
 * written by a person. What must NOT be written by a person is the set of
 * operators that EXIST, because everything outside it is read as a field name and
 * descended into as a filter:
 *
 *   where: { metadata: { string_contains: 'u1' } }   // `contains`, spelled for JSON
 *   where: { metadata: { path: ['owners'], array_contains: 'u1' } }
 *
 * Not one of `string_contains`, `string_starts_with`, `array_contains`,
 * `array_starts_with` or `path` was on either list, so each object was read as the
 * to-one relation shorthand and walked as a filter — and the leaf found the
 * caller's id and called it scoping. `string_contains` is the exact predicate
 * round 7 refused under its scalar spelling, credited because it is spelled
 * differently for a Json column.
 *
 * So the EXISTENCE half is derived from the INSTALLED Prisma client rather than
 * maintained here — see ./installed-prisma.ts. Every `export type …Filter… = { … }`
 * in the generated client is a filter shape and every key of it is an operator;
 * that is 365 types and 32 operators for the client generated from this repo's
 * schema, including all five above. A Prisma upgrade regenerates the client, so
 * the vocabulary cannot go stale behind the judgement the way a literal does, and
 * a client that cannot be read REFUSES rather than falling back to a literal.
 */
let operatorVocabulary: Set<string> | undefined

/**
 * Everything recognised as an operator: what the INSTALLED Prisma client
 * declares (./installed-prisma.ts, which refuses rather than guessing), plus the
 * reviewed sets above. Keys outside it are field names.
 *
 * The reviewed sets are UNIONED in rather than replaced: `search`, `hasNone` and
 * `isSet` are real Prisma operators that this schema generates no filter type for
 * (no fullTextSearch preview feature, no Mongo provider), and dropping them would
 * turn three refusals back into walk-throughs.
 */
function knownOperators(): Set<string> {
  operatorVocabulary ??= new Set([
    ...installedPrismaFilterOperators(), ...SCOPING_OPERATORS, ...NON_SCOPING_OPERATORS,
  ])
  return operatorVocabulary
}

/**
 * Logical operators, which live in FILTER position rather than operator position.
 * `AND` is the only one that constrains every row through a single arm.
 */
const LOGICAL_KEYS = new Set(['AND', 'OR', 'NOT'])

/**
 * A key spelled like a negation, by PREFIX rather than by membership.
 *
 * `notIn` and `notStartsWith` are the same word with a different tail, and the
 * round-7 list had one of them. This costs a field genuinely named `notes` its
 * credit, which is a red build on good code — the direction to be wrong in.
 */
function isNegationKey(key: string): boolean {
  return /^not/i.test(key) || key === 'NOT' || key === 'none' || key === 'hasNone' || key === 'isNot'
}

/**
 * o3d-512h round 9, Codex finding 4 — A SEGMENT OF A KEY, NOT A WORD IN A SENTENCE.
 *
 * Round 8 replaced `value.includes(needle)` with a WHOLE-SEGMENT test, and chose
 * against a bare `===` on a real argument: the one-time-token rows are keyed by a
 * composed string (`passkey_challenge:reg:<userId>`, built in app/actions/
 * passkey.ts and queried by lib/auth/token-store.ts), so equality would have made
 * this predicate refuse the shapes it exists to approve.
 *
 * The way it drew the boundary is what over-credits. A segment ended at any
 * character that is not `[A-Za-z0-9_-]`, which makes a SPACE a boundary, and a
 * `@`, a `,`, a `(`, an `=`. So every value that merely MENTIONS the caller was
 * proof that the query was scoped to them, in any field at all:
 *
 *   where: { description: 'created by u1' }
 *   where: { email: 'u1@example.test' }        // somebody else's address
 *   where: { label: 'audit (u1)' }
 *
 * None of those reaches only the caller's rows, and two of them reach rows that
 * have nothing to do with the caller. The compound-key allowance was for a
 * STRUCTURED key; it was being spent on free text.
 *
 * So a boundary is now a DELIMITER rather than "not an identifier character":
 * the needle must be the whole value, or a complete segment of a value delimited
 * by one of KEY_DELIMITERS. Everything else — whitespace, punctuation, anything
 * unrecognised — is not a boundary and so does not match.
 *
 * The list is unavoidable here and it fails in the safe direction: a composed key
 * built with a delimiter nobody listed earns NOTHING, which costs a red build on
 * a query that is in fact scoped. The opposite default is what this fixes.
 */
const KEY_DELIMITERS = new Set([':', '/', '|', '#'])

/** Does this string carry `needle` as a whole segment of a composed KEY? */
function stringCarries(value: string, needle: string): boolean {
  if (needle.length === 0) return false
  const isBoundary = (c: string) => c === '' || KEY_DELIMITERS.has(c)
  let from = 0
  for (;;) {
    const at = value.indexOf(needle, from)
    if (at === -1) return false
    const before = at === 0 ? '' : value[at - 1]
    const afterAt = at + needle.length
    const after = afterAt >= value.length ? '' : value[afterAt]
    if (isBoundary(before) && isBoundary(after)) return true
    from = at + 1
  }
}

/**
 * Is `needle` carried by a position that constrains EVERY row this query reaches?
 *
 * `position` says which vocabulary the object's KEYS are drawn from — see the
 * note above. `arrayMode` says whether one element of an array is enough: under
 * `AND` every arm applies to every row, so one arm carrying the needle constrains
 * all of them; everywhere else an array is a list of ALTERNATIVES or a list of
 * ROWS, and one element carrying the needle says nothing about the others.
 * `createMany({ data: [{ userId: 'u1' }, { userId: 'victim' }] })` was the
 * round-6 predicate's answer to "is every row scoped to the caller": yes, on the
 * strength of the first one.
 */
function constraintCarries(
  node: unknown,
  needle: string,
  position: 'filter' | 'operator' = 'filter',
  arrayMode: 'all' | 'any' = 'all',
): boolean {
  if (typeof node === 'string') return stringCarries(node, needle)
  if (Array.isArray(node)) {
    if (node.length === 0) return false
    return arrayMode === 'any'
      ? node.some((el) => constraintCarries(el, needle, position))
      : node.every((el) => constraintCarries(el, needle, position))
  }
  if (node === null || typeof node !== 'object') return false

  const entries = Object.entries(node as Record<string, unknown>)
  if (entries.length === 0) return false

  if (position === 'operator') {
    const operators = knownOperators()
    const known = entries.filter(([key]) => operators.has(key) || LOGICAL_KEYS.has(key))
    // No operator at all: the to-one relation shorthand, `owner: { id: 'u1' }`.
    // This is the residual named in the note above.
    if (known.length === 0) return constraintCarries(node, needle, 'filter', arrayMode)
    // A shape that is part operator and part something else is a shape this file
    // does not recognise, and an unrecognised shape earns nothing.
    if (known.length !== entries.length) return false
  }

  for (const [key, value] of entries) {
    if (isNegationKey(key)) continue

    if (position === 'filter') {
      if (key === 'OR') continue // a disjunct constrains no row on its own
      if (key === 'AND') {
        if (constraintCarries(value, needle, 'filter', 'any')) return true
        continue
      }
      // A FIELD name. A scalar value is equality; an object value is the field's
      // filter, which is operator position.
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        if (constraintCarries(value, needle, 'operator')) return true
        continue
      }
      if (constraintCarries(value, needle, 'filter')) return true
      continue
    }

    // Operator position: only the operators that scope are followed.
    if (!SCOPING_OPERATORS.has(key)) continue
    if (key === 'in') {
      // A list reaches rows that are not the caller's, so only a singleton scopes.
      if (Array.isArray(value) && value.length === 1 && constraintCarries(value[0], needle, 'filter')) return true
      continue
    }
    // `is`/`some` take a nested where; `equals`/`has` take a value or a composite.
    if (constraintCarries(value, needle, 'filter')) return true
  }
  return false
}

/**
 * Does the query's CONSTRAINT carry `needle` in a position that scopes rows?
 *
 * Only the constraint is searched — never `select`, `include`, `orderBy`, or a
 * `data` payload on an operation that also has a `where` — and within it, only
 * the positions that restrict every row the query reaches (constraintCarries).
 *
 * WHAT IS STILL NOT PROVED, said rather than implied: that the constraint is
 * SUFFICIENT. `where: { userId: 'u1', id }` and `where: { userId: 'u1' }` are
 * indistinguishable here, and a field merely NAMED like an owner is taken at its
 * word — the needle's presence in a conjunctive position is a lower bound on
 * scoping, not a proof of ownership. What changed in round 6 is that it is now a
 * lower bound on the right thing: a predicate that excludes the caller, or that
 * only optionally includes them, no longer counts as including them. Round 7
 * removed the predicates that carry the id without testing equality with it, and
 * made "every row" mean every row of a list rather than one of them.
 *
 * THE SHARPEST REMAINING LIMIT, and it is worth naming on its own: on a `create`
 * the constraint is `data`, and `data` cannot distinguish the field that OWNS the
 * new row from the field that records who made it.
 * `create({ data: { userId: victim, createdById: 'u1' } })` carries the caller's
 * id in a conjunctive position and attaches the row to somebody else. Telling
 * those apart is a question about which column is the owner, which is schema
 * knowledge this predicate does not have and would only be guessing at from the
 * name. So what a passing create asserts is exactly this: the new row carries the
 * caller's identity somewhere. It is not asserted to be theirs.
 */
export function constraintMentions(ctx: QueryContext, needle: string): boolean {
  const constraint = queryConstraint(ctx)
  if (constraint === undefined) return false
  return constraintCarries(constraint, needle)
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
