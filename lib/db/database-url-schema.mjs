/**
 * o3d-1izw / o3d-2k5r r9 — THE ONE PLACE THE CONNECTION'S SCHEMA IS DECIDED, FOR EVERY CONSUMER OF
 * `DATABASE_URL`.
 *
 * WHY THIS FILE EXISTS. Round 7 aligned the two OUT-OF-PROCESS gates (the deploy check and the
 * production preflight) to the schema named in `DATABASE_URL`, because `pg` silently discards that
 * Prisma-only query parameter and a raw client would otherwise resolve `wms_order_push_links`
 * through the server-default search path. That made the two gates agree WITH EACH OTHER — and
 * disagree with the thing they are gating. Round 8 added the missing half for a URL that NAMES a
 * schema: the adapter now gets `{ schema }` and the pool gets a startup `search_path`.
 *
 * ROUND 9 CLOSES THE OTHER HALF — THE URL THAT NAMES NONE, where the split simply ran the other
 * way. Round 8 returned `null` there and called it "leave everything as it was, because Prisma and
 * pg both use the server default so they already agree". THEY DO NOT AGREE. Measured against the
 * installed @prisma/client 7.7.0, an adapter reporting no `schemaName` compiles GENERATED queries
 * against `"public".<table>` — a literal, hardcoded qualification that has nothing to do with the
 * connection's `search_path`. The raw statements go the other way: `to_regclass($1)` in the shared
 * catalogue query resolves through `search_path`, normally `"$user", public`. So on a login role
 * that owns a same-named schema (`CREATE SCHEMA "ims"` for role `ims` is the standard
 * per-tenant/per-developer layout), the runtime raw gate and BOTH external gates resolve
 * `ims.wms_order_push_links` while every generated WMS write targets `public.wms_order_push_links`.
 * All three gates can pass against a migrated role schema and the very next generated write fails
 * against the old `public` enum — the exact post-deployment divergence this branch exists to fix,
 * reproduced on the majority of URLs, which do not carry `?schema=`.
 *
 * THE RULE, THEREFORE: a valid URL always yields a schema. When it names one, that one; when it
 * names none, PRISMA'S OWN DEFAULT — applied EXPLICITLY to the adapter and to every pg search path,
 * so the two halves are pinned to one name instead of drifting apart on two different defaults.
 *
 * That leaves exactly one input with no schema: a URL that could not be parsed. That case is kept
 * DISTINCT (see `resolveDatabaseUrlSchema().parsed`) and must never collapse back into "names no
 * schema" — they are opposite situations. An unparseable URL is not a connection we can align; it
 * is a connection that cannot be opened at all, and inventing a search path for it would attach a
 * confident-looking `options` string to a client that will never reach a server.
 *
 * The same derivation feeds all four consumers:
 *
 *   1. the runtime Prisma adapter        — `prismaAdapterSchemaOptions` -> PrismaPg's `{ schema }`
 *   2. the runtime pool's startup        — `pgSearchPathOptions`        -> pg `options` on the Pool
 *   3. scripts/check-wms-push-state-enum — `pgSearchPathOptions`        -> pg `options` on a Client
 *   4. lib/ops/production-preflight      — `pgSearchPathOptions`        -> pg `options` on a Client
 *
 * (1) and (2) are BOTH needed and are not the same thing. `schema` tells Prisma's query compiler
 * which schema to qualify GENERATED queries with; it does nothing for `$queryRaw*`, which is how
 * the runtime gate asks its question. The startup `options` sets `search_path` on every connection
 * the pool opens, which is what makes `to_regclass($1)` in the shared catalogue statement resolve
 * the same table for the runtime gate as for the two external ones.
 *
 * PLAIN `.mjs` ON PURPOSE, and in `lib/db` rather than in the WMS domain: the deploy check is a
 * bare-node script with no TypeScript loader, so the shared module it reaches has to be loadable by
 * node alone — and the runtime adapter is infrastructure, which must not have to import from a
 * domain folder to find out what schema it is connecting to.
 */

/**
 * THE SCHEMA PRISMA QUALIFIES GENERATED QUERIES WITH WHEN THE ADAPTER REPORTS NO `schemaName`.
 *
 * Not a preference and not a guess: it is a property of the installed client, and this repository's
 * datasource declares no `schemas`, so nothing overrides it. It is written down here because the
 * two halves of the alignment have to be pinned to ONE name — but a written-down constant is only
 * as good as the check on it, so `tests/wms-push-state-schema-gate.test.ts` compiles a real query
 * through the real generated client with NO schema option and asserts the qualification it gets
 * back is exactly this string. If a future Prisma changes its default, that test fails here rather
 * than the divergence returning silently in production.
 */
export const PRISMA_DEFAULT_SCHEMA = 'public'

/**
 * @typedef {object} DatabaseUrlSchemaResolution
 * @property {boolean} parsed        Whether `databaseUrl` is a URL at all.
 * @property {boolean} explicit      Whether it carried an explicit `?schema=`.
 * @property {string | null} schema  The schema to align every consumer to, or `null` — and ONLY
 *                                   null — when the URL could not be parsed.
 */

/**
 * Resolve what schema this `DATABASE_URL` puts the application on, keeping "names no schema" and
 * "is not a URL" apart.
 *
 * @param {string | undefined | null} databaseUrl
 * @returns {DatabaseUrlSchemaResolution}
 */
export function resolveDatabaseUrlSchema(databaseUrl) {
  let url
  try {
    url = new URL(String(databaseUrl))
  } catch {
    return { parsed: false, explicit: false, schema: null }
  }
  const named = url.searchParams.get('schema') || null
  return { parsed: true, explicit: named !== null, schema: named ?? PRISMA_DEFAULT_SCHEMA }
}

/**
 * The schema every consumer of this `DATABASE_URL` must be put on, or `null` when the URL cannot be
 * parsed.
 *
 * `null` means ONE thing — "this is not a URL" — and no longer doubles as "names no schema", which
 * is now `PRISMA_DEFAULT_SCHEMA`. Callers that need to tell the two apart read
 * `resolveDatabaseUrlSchema()` instead.
 *
 * @param {string | undefined | null} databaseUrl
 * @returns {string | null}
 */
export function databaseUrlSchema(databaseUrl) {
  return resolveDatabaseUrlSchema(databaseUrl).schema
}

/**
 * Connection options that put a raw `pg` client — or the runtime pool — on the schema above.
 *
 * Spread into a `pg` `ClientConfig`/`PoolConfig`. On any parseable URL this is now ALWAYS set, so a
 * raw statement can never fall back to the server default `search_path` while generated queries sit
 * on `public`; that divergence is the finding. `{}` survives only for an unparseable URL, where
 * there is no connection to align.
 *
 * The name is quoted because a schema name is an identifier and `public` is not the only legal
 * spelling; an embedded quote is doubled rather than stripped, so a name that cannot be expressed
 * still produces a search path that resolves nothing (a refusal) instead of one that resolves the
 * wrong thing.
 *
 * @param {string | undefined | null} databaseUrl
 * @returns {{ options?: string }}
 */
export function pgSearchPathOptions(databaseUrl) {
  const { schema } = resolveDatabaseUrlSchema(databaseUrl)
  if (!schema) return {}
  return { options: `-c search_path="${schema.replace(/"/g, '""')}"` }
}

/**
 * The adapter options that give `PrismaPg` the SAME schema — i.e. what makes
 * `getConnectionInfo().schemaName` agree with the search path above.
 *
 * Passed EXPLICITLY even when it equals `PRISMA_DEFAULT_SCHEMA`. Leaving it undefined and relying
 * on Prisma's implicit default would be relying on the two sides happening to agree, which is the
 * thing that was wrong; stating it means one derivation feeds both, and a future change of Prisma's
 * default cannot silently move the generated queries off the search path the gates resolve through.
 *
 * Returns `undefined` only for an unparseable URL, where the adapter is constructed exactly as it
 * was before.
 *
 * @param {string | undefined | null} databaseUrl
 * @returns {{ schema: string } | undefined}
 */
export function prismaAdapterSchemaOptions(databaseUrl) {
  const { schema } = resolveDatabaseUrlSchema(databaseUrl)
  return schema ? { schema } : undefined
}
