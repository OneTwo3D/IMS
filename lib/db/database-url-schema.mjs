/**
 * o3d-1izw / o3d-2k5r r8 — THE ONE PLACE `?schema=` IS READ, FOR EVERY CONSUMER OF DATABASE_URL.
 *
 * WHY THIS FILE EXISTS. Round 7 aligned the two OUT-OF-PROCESS gates (the deploy check and the
 * production preflight) to the schema named in `DATABASE_URL`, because `pg` silently discards that
 * Prisma-only query parameter and a raw client would otherwise resolve `wms_order_push_links`
 * through the server-default search path. That made the two gates agree WITH EACH OTHER — and
 * disagree with the thing they are gating. The application built its adapter as
 * `new PrismaPg(dbPoolConfig())`: no `{ schema }` option, so `getConnectionInfo().schemaName` was
 * undefined, and no startup `options`, so the pool's own connections were left on the server
 * default too. On a non-public-schema URL both release gates could inspect and pass
 * `ims_app.wms_order_push_links` while the runtime resolved something else — and the runtime gate
 * would then REFUSE after deployment, taking WMS fulfilment down with both gates green.
 *
 * A gate must be aligned to the thing it checks, not to the other gates. So the schema is derived
 * HERE, once, and the same derivation feeds all four consumers:
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
 * The schema `DATABASE_URL` names, or `null` when it names none or cannot be parsed.
 *
 * `null` deliberately means "leave every consumer exactly as it was" — on a URL with no `?schema=`
 * both Prisma and `pg` use the server default, so they already agree and there is nothing to align.
 * Guessing `public` here would be a change of behaviour dressed up as a fix.
 *
 * @param {string | undefined | null} databaseUrl
 * @returns {string | null}
 */
export function databaseUrlSchema(databaseUrl) {
  try {
    return new URL(String(databaseUrl)).searchParams.get('schema') || null
  } catch {
    return null
  }
}

/**
 * Connection options that put a raw `pg` client — or the runtime pool — on the schema above.
 *
 * Spread into a `pg` `ClientConfig`/`PoolConfig`. The name is quoted because a schema name is an
 * identifier and `public` is not the only legal spelling; an embedded quote is doubled rather than
 * stripped, so a name that cannot be expressed still produces a search path that resolves nothing
 * (a refusal) instead of one that resolves the wrong thing.
 *
 * @param {string | undefined | null} databaseUrl
 * @returns {{ options?: string }}
 */
export function pgSearchPathOptions(databaseUrl) {
  const schema = databaseUrlSchema(databaseUrl)
  if (!schema) return {}
  return { options: `-c search_path="${schema.replace(/"/g, '""')}"` }
}

/**
 * The adapter options that give `PrismaPg` the SAME schema — i.e. what makes
 * `getConnectionInfo().schemaName` agree with the search path above.
 *
 * Returns `undefined` rather than `{}` when no schema is named, so the adapter is constructed
 * exactly as it was before on such a URL.
 *
 * @param {string | undefined | null} databaseUrl
 * @returns {{ schema: string } | undefined}
 */
export function prismaAdapterSchemaOptions(databaseUrl) {
  const schema = databaseUrlSchema(databaseUrl)
  return schema ? { schema } : undefined
}
