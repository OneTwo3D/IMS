/**
 * FAIL CLOSED WHEN THE CODE IS AHEAD OF THE DATABASE (o3d-1izw, P0, OPEN).
 *
 * `AMBIGUOUS_CREATE` is a value of the Postgres enum `WmsOrderPushState`, added by
 * prisma/migrations/20260827090000_wms_push_ambiguous_create. That migration HAS BEEN APPLIED TO
 * NO DATABASE — this session applies none — so every environment served from this branch's working
 * tree today runs code whose vocabulary the database does not have.
 *
 * WHAT THAT LOOKED LIKE BEFORE THIS FILE, AND WHY A BANNER WAS NOT ENOUGH. Nothing checked. The
 * FIRST create claim whose lease lapsed tried to write `AMBIGUOUS_CREATE`, Postgres refused the
 * value, the claim transaction rolled back — so the order was neither claimed nor parked — and
 * every subsequent sweep reached the same link and repeated the same database error. The failure
 * was therefore SILENT (a raw `invalid input value for enum` in a cron log, attributable to
 * nothing), LATE (it needed a crashed worker plus five minutes to appear at all) and REPEATING
 * (once per sweep, for ever). A comment at the top of a migration cannot change any of that,
 * because the runtime never reads it.
 *
 * WHAT IT LOOKS LIKE NOW. The gate below is asked BEFORE the sweep touches anything, and again at
 * the write site that mints the value. It answers from one catalogue query — the shared, COLUMN-
 * ANCHORED statement in ./push-state-enum-query.mjs, which starts at `wms_order_push_links.state`
 * and reads the labels of whatever type that column is actually declared as, so a same-named enum
 * in another schema cannot vouch for it — and its refusal is a named error carrying the issue id
 * and the exact remedy. So the incompatibility is
 * LOUD (a distinct error class, not a driver message), EARLY (before a claim, a connector call or
 * any write — the sweep does no work at all on an unmigrated database rather than corrupting a
 * link half way through) and ONCE (one refusal per sweep instead of one per lapsed claim, and one
 * console line per process instead of one per sweep).
 *
 * THIS IS NOT A SUBSTITUTE FOR APPLYING THE MIGRATION and does not close o3d-1izw. It converts an
 * environment that runs incompatible code into one that refuses to run it. Applying the migration
 * is still the fix, and the refusal says so.
 *
 * WHY SUCCESS IS CACHED AND FAILURE IS NOT. A Postgres enum value cannot be removed by anything
 * short of a schema rewrite, so "present" is monotonic: once observed, it can be trusted for the
 * life of the process, and the gate costs one query rather than one per claim. "Absent" is NOT
 * monotonic — applying the migration is precisely the event that changes it — so a refusal is
 * re-probed every time. That is what lets an operator fix the database and have the next sweep
 * heal, with no restart.
 */

/**
 * The ONE query every gate asks, and the table/column it is anchored at. Re-exported here so the
 * three callers reach the rule and the statement through a single import, and so a reader of the
 * gate can see that the question is asked of a column rather than of a type name.
 */
export {
  pgSearchPathOptions,
  WMS_PUSH_STATE_COLUMN,
  WMS_PUSH_STATE_ENUM_LABELS_SQL,
  WMS_PUSH_STATE_TABLE,
} from './push-state-enum-query.mjs'

/**
 * The enum whose values this gate is about — for the REFUSAL TEXT only.
 *
 * Deliberately not used to find the type: identifying an enum by name is exactly the bypass the
 * column-anchored query above exists to close. It names the thing a person has to go and look at.
 */
export const WMS_PUSH_STATE_ENUM = 'WmsOrderPushState'

/** The migration that adds them, named in the refusal so the remedy is copy-pasteable. */
export const WMS_PUSH_STATE_MIGRATION = '20260827090000_wms_push_ambiguous_create'

/** The open P0 this gate exists under. */
export const WMS_PUSH_STATE_GATE_ISSUE = 'o3d-1izw'

/**
 * Enum values this build WRITES that an unmigrated database does not have.
 *
 * Deliberately a list rather than the single current value: the next state added to
 * `WmsOrderPushState` under the same rule belongs here, and a list makes that an append rather
 * than a rewrite of the gate.
 */
export const REQUIRED_WMS_PUSH_STATES = ['AMBIGUOUS_CREATE'] as const

/**
 * The refusal a person reads. Names the issue, the missing value, and the two commands that fix
 * it — because a refusal whose remedy is "apply the migration" is a refusal nobody can act on.
 */
export function wmsPushStateSchemaRefusal(missing: readonly string[]): string {
  return (
    `This build writes ${WMS_PUSH_STATE_ENUM} value(s) ${missing.join(', ')} that THIS DATABASE DOES NOT HAVE, `
    + `so the WMS order-push sweep has refused to run rather than fail half way through a claim. `
    + `Migration ${WMS_PUSH_STATE_MIGRATION} has not been applied here — the usual causes are `
    + `\`deploy.sh --skip-migrate\` and an environment served straight from a working tree by \`next dev\`. `
    + `Apply it with \`npx prisma migrate deploy --schema prisma/schema.prisma\` and confirm with `
    + `\`node scripts/check-prisma-drift.mjs\`. Release gate: ${WMS_PUSH_STATE_GATE_ISSUE}.`
  )
}

/** A refusal that is diagnosable — never a raw driver error about an invalid enum input. */
export class WmsPushStateSchemaError extends Error {
  readonly code = 'WMS_PUSH_STATE_SCHEMA_AHEAD_OF_DATABASE'
  readonly missing: readonly string[]
  constructor(missing: readonly string[], options?: { cause?: unknown }) {
    super(wmsPushStateSchemaRefusal(missing), options)
    this.name = 'WmsPushStateSchemaError'
    this.missing = [...missing]
  }
}

export function isWmsPushStateSchemaError(error: unknown): error is WmsPushStateSchemaError {
  return error instanceof WmsPushStateSchemaError
}

/**
 * Which required values this database is missing.
 *
 * FAIL CLOSED ON `null`: "the enum could not be read" is not "the enum is fine". A gate that
 * treated an unreadable catalogue as a pass would be exactly the absence-read-as-a-negative-answer
 * this branch keeps finding, and it would restore the silent-incompatibility behaviour on the one
 * database state nobody can reason about.
 */
export function missingWmsPushStates(present: readonly string[] | null | undefined): string[] {
  if (!present) return [...REQUIRED_WMS_PUSH_STATES]
  const have = new Set(present)
  return REQUIRED_WMS_PUSH_STATES.filter((value) => !have.has(value))
}

export type WmsPushStateSchemaGate = () => Promise<void>

/**
 * Build the gate over a reader of the database's own enum labels.
 *
 * The reader is injected so the rule is testable without a database, and so the one production
 * reader (a `pg_enum` query) lives next to the Prisma client rather than in here.
 */
export function createWmsPushStateSchemaGate(
  readEnumValues: () => Promise<readonly string[] | null>,
  options?: { onRefusal?: (error: WmsPushStateSchemaError) => void },
): WmsPushStateSchemaGate {
  let confirmed = false
  let announced = false
  const announce = options?.onRefusal
    ?? ((error: WmsPushStateSchemaError) => { console.error(`[wms-push-state-gate] ${error.message}`) })
  return async () => {
    if (confirmed) return
    let present: readonly string[] | null
    try {
      present = await readEnumValues()
    } catch (error) {
      // Unreadable catalogue is a refusal, not a pass — and it keeps its cause so the underlying
      // connection fault is still diagnosable.
      const refusal = new WmsPushStateSchemaError(REQUIRED_WMS_PUSH_STATES, { cause: error })
      if (!announced) { announced = true; announce(refusal) }
      throw refusal
    }
    const missing = missingWmsPushStates(present)
    if (missing.length > 0) {
      const refusal = new WmsPushStateSchemaError(missing)
      // ONCE per process: the sweep runs every ten minutes and the refusal never changes on its
      // own, so repeating it every tick buries the log it is supposed to make readable.
      if (!announced) { announced = true; announce(refusal) }
      throw refusal
    }
    confirmed = true
  }
}
