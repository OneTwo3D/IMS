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
 *   2. the runtime pool's startup        — `pgConnectionConfig`         -> the pg Pool's config
 *   3. scripts/check-wms-push-state-enum — `pgConnectionConfig`         -> a pg Client's config
 *   4. lib/ops/production-preflight      — `pgConnectionConfig`         -> a pg Client's config
 *
 * ROUND 10 CLOSES THE THIRD HALF — THE URL THAT OVERRIDES THE PIN. (2), (3) and (4) used to set
 * `connectionString` themselves and spread a separate `{ options }` beside it. `pg` parses
 * `connectionString` AFTER the surrounding config and assigns the result over it, so a URL
 * carrying its own `options=-c search_path=...` silently beat the pin: `dbPoolConfig().options`
 * read `ims_app` while the client that was actually built sent `-c search_path=legacy`, and all
 * three raw gates inspected `legacy` while every generated write went to `ims_app`. The pin is now
 * composed WITH the connection string, by one function that removes the URL's `options`, keeps
 * every setting in it that is not `search_path`, and reads a `search_path` in it as the schema
 * rather than as a rival to be overridden.
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
 * Raised when one `DATABASE_URL` names TWO schemas — `?schema=` saying one thing and an
 * `options=-c search_path=` inside the same URL saying another, or a `search_path` that is a LIST
 * and therefore not a schema this can pin anything to.
 *
 * A throw, not a fallback (o3d-2k5r r10). Every consumer of this module builds a connection from
 * it, and the whole subject of this branch is a gate that passes while the writes land somewhere
 * else. Picking a winner silently is how that happens; refusing means the runtime does not boot,
 * the deploy check exits non-zero and the preflight fails, all with the same sentence.
 */
export class DatabaseUrlSchemaConflictError extends Error {
  constructor(message) {
    super(message)
    this.name = 'DatabaseUrlSchemaConflictError'
  }
}

/**
 * libpq splits `options` on spaces and treats a backslash as escaping the next character. Tokens
 * come back STILL ESCAPED, so joining them with a single space reproduces an equivalent string.
 *
 * @param {string} options
 * @returns {string[]}
 */
export function splitLibpqOptions(options) {
  const tokens = []
  let current = ''
  let escaped = false
  for (const character of String(options)) {
    if (escaped) {
      current += `\\${character}`
      escaped = false
      continue
    }
    if (character === '\\') {
      escaped = true
      continue
    }
    if (character === ' ') {
      if (current !== '') {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += character
  }
  if (escaped) current += '\\'
  if (current !== '') tokens.push(current)
  return tokens
}

/** A value going back into a libpq `options` string: its spaces and backslashes re-escaped. */
function escapeLibpqValue(value) {
  return String(value).replace(/([\\ ])/g, '\\$1')
}

function unescapeLibpq(token) {
  return String(token).replace(/\\(.)/g, '$1')
}

/**
 * The startup settings a libpq `options` string carries, in order.
 *
 * Each entry keeps the tokens it was written as, so everything this module does NOT understand is
 * carried through to the server byte-for-byte instead of being dropped.
 *
 * @param {string} options
 * @returns {{ tokens: string[], name: string | null, value: string }[]}
 */
function readLibpqSettings(options) {
  const tokens = splitLibpqOptions(options)
  const entries = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    let setting = null
    let owned = [token]
    if (token === '-c' && index + 1 < tokens.length) {
      setting = tokens[index + 1]
      owned = [token, tokens[index + 1]]
      index += 1
    } else if (token.startsWith('-c') && token.length > 2) {
      setting = token.slice(2)
    } else if (token.startsWith('--') && token.length > 2) {
      setting = token.slice(2)
    }
    if (setting === null) {
      entries.push({ tokens: owned, name: null, value: '' })
      continue
    }
    const equals = setting.indexOf('=')
    const name = unescapeLibpq(equals === -1 ? setting : setting.slice(0, equals)).toLowerCase()
    const value = equals === -1 ? '' : unescapeLibpq(setting.slice(equals + 1))
    entries.push({ tokens: owned, name, value })
  }
  return entries
}

/**
 * The single schema a `search_path` value names, or `null` when it names anything else.
 *
 * `search_path` is a LIST, and a list is not something the adapter's one `schema` can be pinned to:
 * `to_regclass()` in the shared catalogue statement would resolve through every element while
 * Prisma qualified generated queries with one. So only a single element is readable here, with its
 * identifier quoting removed — `"ims app"` and `ims_app` both name a schema; `ims_app, public`
 * and `$user` do not.
 */
function singleSchemaOfSearchPath(value) {
  const trimmed = String(value).trim()
  if (trimmed === '') return null
  const quoted = /^"((?:[^"]|"")*)"$/.exec(trimmed)
  if (quoted) return quoted[1].replace(/""/g, '"')
  if (/[,\s"$]/.test(trimmed)) return null
  return trimmed
}

/**
 * Resolve what schema this `DATABASE_URL` puts the application on, keeping "names no schema" and
 * "is not a URL" apart.
 *
 * BOTH SPELLINGS ARE READ (o3d-2k5r r10). `?schema=` is Prisma's; `options=-c search_path=` is
 * libpq's, and it is the one the driver actually applies — `pg` parses `connectionString` AFTER
 * the surrounding config object and lets the URL's parameters overwrite duplicate top-level
 * properties, so a `search_path` written into the URL used to beat the `options` this module
 * composed. An operator who wrote the pg-native spelling therefore gets the schema they asked for
 * in BOTH halves rather than having it quietly overridden; an operator who wrote both, differently,
 * gets a refusal rather than one of the two.
 *
 * @param {string | undefined | null} databaseUrl
 * @returns {DatabaseUrlSchemaResolution}
 * @throws {DatabaseUrlSchemaConflictError} when the URL names two different schemas.
 */
export function resolveDatabaseUrlSchema(databaseUrl) {
  let url
  try {
    url = new URL(String(databaseUrl))
  } catch {
    return { parsed: false, explicit: false, schema: null }
  }
  const named = url.searchParams.get('schema') || null
  const fromOptions = searchPathSchemaOf(url, databaseUrl)
  if (named !== null && fromOptions !== null && named !== fromOptions) {
    throw new DatabaseUrlSchemaConflictError(
      `DATABASE_URL names two different schemas: ?schema=${named} and options=-c search_path=${fromOptions}. ` +
        'Prisma qualifies generated queries with one of them and every raw statement resolves through the other, ' +
        'which is the split this gate exists to stop (o3d-1izw). Delete one of them.',
    )
  }
  const schema = named ?? fromOptions ?? PRISMA_DEFAULT_SCHEMA
  return { parsed: true, explicit: named !== null || fromOptions !== null, schema }
}

/**
 * The schema the URL's own `options` puts the connection on, or `null` when it carries none.
 *
 * The LAST `search_path` wins, because that is what the backend applies when a startup packet
 * assigns the same GUC twice.
 */
function searchPathSchemaOf(url, databaseUrl) {
  const raw = url.searchParams.get('options')
  if (!raw) return null
  const searchPaths = readLibpqSettings(raw).filter((entry) => entry.name === 'search_path')
  if (searchPaths.length === 0) return null
  const value = searchPaths[searchPaths.length - 1].value
  const schema = singleSchemaOfSearchPath(value)
  if (schema === null) {
    throw new DatabaseUrlSchemaConflictError(
      `DATABASE_URL sets options=-c search_path=${value}, which does not name exactly one schema. ` +
        'Prisma qualifies generated queries with a single schema while a search path resolves raw statements ' +
        'through every element of the list, so the two cannot be pinned together (o3d-1izw). ' +
        'Name one schema, or use ?schema= instead.',
    )
  }
  void databaseUrl
  return schema
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
 * THE WHOLE CONNECTION CONFIG a raw `pg` client — or the runtime pool — must be built from: the
 * connection string AND the startup options, together, because neither is safe without the other.
 *
 * IT RETURNS THE CONNECTION STRING ON PURPOSE, AND IT MUST BE SPREAD FIRST (o3d-2k5r r10). This
 * used to return `{ options }` alone, spread after a `connectionString` the caller set itself —
 * and that composition does not do what it reads as. `pg` parses `connectionString` AFTER the
 * surrounding config and `Object.assign`s the result over it (pg/lib/connection-parameters.js:60),
 * so a `?options=` inside the URL overwrites the `options` property beside it. Measured on the
 * installed pg: `?schema=ims_app&options=-c%20search_path%3Dlegacy` produced a config whose
 * `options` visibly said `ims_app` and a client whose `connectionParameters.options` was
 * `-c search_path=legacy`. All three raw gates then inspected `legacy.wms_order_push_links` while
 * every generated query wrote to `ims_app.wms_order_push_links` — the green-gate/failed-write split
 * this branch exists to close, re-entered through the fix for it.
 *
 * So the URL's `options` is REMOVED from the connection string and folded into ONE effective
 * options string, and nothing about it is decided silently:
 *
 *   * a `search_path` in the URL is not overridden — it is READ, as the schema, by
 *     `resolveDatabaseUrlSchema()`. An operator who wrote the pg-native spelling gets that schema
 *     on both halves; one who wrote `?schema=` too, differently, gets a refusal.
 *   * EVERY OTHER startup setting the URL carried is preserved, in the tokens it was written as,
 *     ahead of the pin. `application_name`, `statement_timeout`, a `-c` this module has never
 *     heard of: all still reach the server. Only `search_path` is rewritten, because only
 *     `search_path` is the thing being pinned.
 *
 * The pinned name is quoted because a schema name is an identifier and `public` is not the only
 * legal spelling; an embedded quote is doubled rather than stripped, so a name that cannot be
 * expressed still produces a search path that resolves nothing (a refusal) instead of one that
 * resolves the wrong thing. Spaces and backslashes are then escaped for libpq's own splitter,
 * which would otherwise truncate the setting at the first space.
 *
 * For an unparseable URL the string is passed through untouched and no options are set: there is
 * no connection to align, and inventing one would attach a confident-looking search path to a
 * client that will never reach a server.
 *
 * @param {string | undefined | null} databaseUrl
 * @returns {{ connectionString: string, options?: string }}
 * @throws {DatabaseUrlSchemaConflictError} when the URL names two different schemas.
 */
export function pgConnectionConfig(databaseUrl) {
  const { parsed, schema } = resolveDatabaseUrlSchema(databaseUrl)
  const connectionString = String(databaseUrl ?? '')
  if (!parsed || !schema) return { connectionString }

  const url = new URL(connectionString)
  const carried = readLibpqSettings(url.searchParams.get('options') || '')
    .filter((entry) => entry.name !== 'search_path')
    .flatMap((entry) => entry.tokens)
  const pin = `-c search_path=${escapeLibpqValue(`"${schema.replace(/"/g, '""')}"`)}`
  const options = [...carried, pin].join(' ')

  // The URL must no longer carry an `options` of its own, or pg's own parse would put it back over
  // the one composed here.
  url.searchParams.delete('options')
  return { connectionString: url.toString(), options }
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
