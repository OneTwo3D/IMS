/**
 * o3d-1izw / o3d-2k5r r7 — ONE QUERY, ANCHORED AT THE COLUMN THAT WILL BE WRITTEN.
 *
 * WHY THIS FILE EXISTS AT ALL, AND WHY IT IS PLAIN JS. Three separate gates ask the same question
 * ("can this database hold the push states this build writes?"): the runtime gate in
 * lib/domain/wms/order-push-sweep.ts, the deploy check in scripts/check-wms-push-state-enum.mjs,
 * and the production preflight in lib/ops/production-preflight.ts. When each spelled the query out
 * for itself they were not three independent gates but one gate written three times — a single
 * wrong query was a COMMON-MODE bypass of all of them at once. They now share this one statement
 * verbatim. It is `.mjs` rather than `.ts` only because the deploy check is a bare-node script with
 * no TypeScript loader; the TypeScript callers import it unchanged.
 *
 * WHAT WAS WRONG WITH THE QUERY IT REPLACES (the finding this file answers). The previous statement
 * identified the enum BY NAME:
 *
 *     SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = $1
 *
 * `typname` is unique only within a schema, so that reads the labels of EVERY type called
 * `WmsOrderPushState` anywhere in the database and unions them. It therefore answers a question
 * nobody asked — "does some type of this name somewhere carry AMBIGUOUS_CREATE?" — and a database
 * where an unrelated schema happens to hold a same-named type with that label PASSES the gate while
 * the type actually attached to `wms_order_push_links.state` still lacks it. The claim then reaches
 * the real column and fails with the original repeating enum error, having been vouched for by all
 * three gates on the way in.
 *
 * WHAT THIS ONE PROVES INSTEAD. It starts at the TABLE AND COLUMN and follows the catalogue to
 * whatever type that column is actually declared as (`pg_attribute.atttypid`), then reads the
 * labels of THAT type OID. The name of the type never enters the query. That closes the three
 * routes by which a name-keyed check can be vouched for by the wrong type:
 *
 *   - ANOTHER SCHEMA. A same-named type in a different schema has a different OID, so its labels
 *     are simply not in the result. Nothing unions.
 *   - SEARCH PATH. `to_regclass($1)` resolves the unqualified table name through the SEARCH PATH OF
 *     THE CONNECTION ASKING — the same resolution the INSERT will use, because at runtime it is the
 *     same connection. A gate that resolved the table differently from the writer would be back to
 *     answering about the wrong object. (The two out-of-process gates open their own connection, so
 *     they align it deliberately — see `pgSearchPathOptions`.)
 *   - A TYPE REPLACED RATHER THAN ALTERED. `DROP TYPE ... CASCADE; CREATE TYPE ...` leaves a type
 *     with the same name and a NEW OID; whichever OID the column now carries is the one read, and
 *     the abandoned one is invisible. There is nothing to prefer, because nothing is matched by
 *     name.
 *
 * FAIL-CLOSED BY CONSTRUCTION. Every way of NOT finding the answer produces zero rows, which the
 * caller reads as "every required value is missing" — a refusal, never a pass. A missing table, a
 * renamed or dropped column, a search path that cannot see the table, a column whose type is not an
 * enum at all (a domain over one, or an array of one) all land there. Some of those are false
 * refusals; a false refusal costs a sweep that declines to run and says exactly why, and a false
 * pass costs a create claim that dies inside its own transaction on every sweep for ever.
 */

/** The table the push state is written to — resolved through the asking connection's search path. */
export const WMS_PUSH_STATE_TABLE = 'wms_order_push_links'

/** The column whose declared type is the ONLY authority on which labels may be written. */
export const WMS_PUSH_STATE_COLUMN = 'state'

/**
 * The labels of the enum type `wms_order_push_links.state` is declared as.
 *
 * $1 = table name, $2 = column name. Deliberately parameterised rather than interpolated even
 * though both arguments are constants in this repository, so that no caller can turn it into an
 * assembled statement by passing something else.
 *
 * `attnum > 0` excludes the system columns; `NOT attisdropped` excludes the tombstones a dropped
 * column leaves in `pg_attribute` (they keep their old name mangled, but the filter is cheap and
 * makes the intent explicit).
 */
export const WMS_PUSH_STATE_ENUM_LABELS_SQL = [
  'SELECT e.enumlabel AS "enumlabel"',
  'FROM pg_catalog.pg_attribute a',
  'JOIN pg_catalog.pg_enum e ON e.enumtypid = a.atttypid',
  'WHERE a.attrelid = to_regclass($1)',
  'AND a.attname = $2',
  'AND a.attnum > 0',
  'AND NOT a.attisdropped',
  'ORDER BY e.enumsortorder',
].join('\n')

/**
 * Connection options that give a raw `pg` client the SAME search path Prisma uses.
 *
 * Prisma reads `?schema=` out of `DATABASE_URL` and sets `search_path` from it; `pg` does not know
 * that parameter, so a raw client on the identical URL can resolve `wms_order_push_links` to a
 * different table — or to none — than the application does. Since the whole point of the query
 * above is that it resolves the table the way the writer does, the two out-of-process gates must
 * not be left on a different search path from the process they are vouching for.
 *
 * Returns `{}` when the URL names no schema (then both sides are on the server default) or cannot
 * be parsed, which leaves the client exactly as it was rather than guessing.
 */
export function pgSearchPathOptions(databaseUrl) {
  let schema
  try {
    schema = new URL(databaseUrl).searchParams.get('schema')
  } catch {
    return {}
  }
  if (!schema) return {}
  // Quote it: a schema name is an identifier, and `public` is not the only legal spelling.
  return { options: `-c search_path="${schema.replace(/"/g, '""')}"` }
}
