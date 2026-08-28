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
 * ROUND 11 CLOSES THE FOURTH HALF — THE URL THIS MODULE READS DIFFERENTLY FROM THE SERVER. Two
 * ways, both of which pointed a green gate at one schema while the writes went to another:
 *
 *   * QUOTEDNESS. `search_path=TenantA` is folded by PostgreSQL to `tenanta`; this read it as
 *     `TenantA` and then emitted the always-quoted `search_path="TenantA"`, silently moving an
 *     existing options-only URL onto a DIFFERENT schema — and making `?schema=TenantA` and
 *     `options=-c search_path=TenantA`, which name two different schemas, compare as agreement.
 *     Unquoted names are now folded the way the server folds them, quoted ones are left exactly as
 *     written, and an unquoted name this cannot fold the server's way (non-ASCII, whose case
 *     mapping is the database's encoding and collation) is refused.
 *   * REPETITION. `URLSearchParams.get()` is FIRST-wins and the installed driver is LAST-wins, so
 *     a second `?options=` was the one the server received and the first was the one this module
 *     read, pinned from and then deleted — taking the driver's real `statement_timeout` and
 *     `lock_timeout` with it. A repeated `?options=` or `?schema=` is now refused outright. This is
 *     the same finding `scripts/fence-db-connections.mjs` closed for `?host=`/`?port=`/`?user=`,
 *     in another file and against another parameter, and it is answered the same way.
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
 * EVERY CHARACTER POSTGRESQL SPLITS A STARTUP `options` ON (o3d-2k5r r12, Codex HIGH).
 *
 * The startup packet's `options` is not parsed by libpq at all — it is forwarded verbatim and the
 * BACKEND splits it, in `pg_split_opts()` (src/backend/utils/init/postinit.c), whose test is
 * `isspace((unsigned char) *optstr)`. In the C locale that is exactly these six characters, and a
 * TAB is as legal a separator as a space.
 *
 * This parser used to recognise the literal space alone, which is not a cosmetic gap: for
 * `options=-c%09search_path%3DTenantA` the whole string came back as ONE unknown token, the schema
 * resolved to `PRISMA_DEFAULT_SCHEMA`, and `pgConnectionConfig()` emitted the operator's own
 * tab-separated assignment followed by `-c search_path="public"`. PostgreSQL applies both, last
 * assignment wins, and an options-only deployment was silently moved off `tenanta` onto `public` —
 * the same silent retargeting rounds 10 and 11 closed for two other spellings, reached through a
 * third.
 */
const LIBPQ_OPTION_SEPARATORS = new Set([' ', '\t', '\n', '\v', '\f', '\r'])

/**
 * Whitespace that is NOT one of the six above — U+00A0, U+2007, U+FEFF and the rest.
 *
 * Whether the backend splits on these is a property of the database's ENCODING AND LOCALE, not of
 * the string: `isspace()` is asked one byte at a time, so in a UTF-8 database the bytes of U+00A0
 * are ordinary characters, while a single-byte encoding under some locales could class the same
 * codepoint as space and split there. So the token boundaries — and therefore which schema the
 * connection is pinned to — are not knowable from here. REFUSED, for the same reason a non-ASCII
 * unquoted identifier is refused below: this module does not guess at a reading the server may not
 * share. An operator who means the character literally can escape it with a backslash, which is
 * unambiguous on both sides.
 */
const NON_ASCII_WHITESPACE = /\s/u

/**
 * libpq's `options` as PostgreSQL splits it: on ASCII whitespace, with a backslash escaping the
 * next character. Tokens come back STILL ESCAPED, so joining them with a single space reproduces
 * an equivalent string — every separator in the set is interchangeable to the backend.
 *
 * @param {string} options
 * @returns {string[]}
 * @throws {DatabaseUrlSchemaConflictError} on unescaped whitespace this cannot split the way the
 *   server will.
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
    if (LIBPQ_OPTION_SEPARATORS.has(character)) {
      if (current !== '') {
        tokens.push(current)
        current = ''
      }
      continue
    }
    if (NON_ASCII_WHITESPACE.test(character)) {
      throw new DatabaseUrlSchemaConflictError(
        `DATABASE_URL sets options= containing U+${character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}, ` +
          'a whitespace character PostgreSQL may or may not split the startup options on depending on the ' +
          "database's encoding and locale. Where the tokens end decides which schema this connection is pinned " +
          'to, so it is refused rather than guessed at (o3d-2k5r). Use a plain space, or backslash-escape the ' +
          'character to mean it literally.',
      )
    }
    current += character
  }
  if (escaped) current += '\\'
  if (current !== '') tokens.push(current)
  return tokens
}

/**
 * A value going back into a libpq `options` string, ESCAPED FOR THE SAME SPLITTER THAT READS IT
 * (o3d-2k5r r13, Codex HIGH).
 *
 * Round 12 taught the TOKENIZER all six characters `pg_split_opts()` breaks on, and left the
 * EMITTER escaping the literal space alone. That is the same disagreement rounds 10-12 kept
 * closing, stated between this module's own two halves instead of between it and the driver: a
 * schema named `tenant<TAB>x` was read back whole and then emitted as
 * `-c search_path="tenant<TAB>x"`, which the BACKEND splits into `-c`, `search_path="tenant` and
 * `x"`. The connection is then pinned to an unterminated-quote search path — an error, or worse a
 * different schema — while Prisma qualifies its generated queries with the full name. Same
 * green-gate/failed-write split, reached through the writing end.
 *
 * SO THE RULE IS STATED AS A RULE, NOT AS A LIST: escape every character this module does not
 * carry through a token boundary literally. That is the backslash, the six separators in
 * `LIBPQ_OPTION_SEPARATORS`, and every character `NON_ASCII_WHITESPACE` REFUSES — because an
 * unescaped U+00A0 emitted here would be read back as a refusal, and a value that cannot be read
 * back is a value that was not really emitted. `/[\\\s]/gu` is exactly that union, so the two halves
 * cannot drift apart by one character again; `tests/db/connection-schema-pinning.test.ts` proves
 * the agreement by ROUND-TRIPPING a name containing all six.
 */
function escapeLibpqValue(value) {
  return String(value).replace(/[\\\s]/gu, '\\$&')
}

/**
 * The inverse, and it must accept the line terminators the emitter now writes.
 *
 * `.` in a JavaScript regular expression does not match `\n`, `\r`, `\u2028` or `\u2029`, so
 * `/\\(.)/g` silently left `\<newline>` escaped — the one input the tokenizer had just carried
 * through correctly. `[\s\S]` matches every character there is.
 */
function unescapeLibpq(token) {
  return String(token).replace(/\\([\s\S])/g, '$1')
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
 * The character set PostgreSQL accepts in an UNQUOTED identifier, restricted to ASCII on purpose.
 *
 * PostgreSQL also accepts letters with the high bit set and folds them with the database's own
 * encoding and collation, which is not reproducible from here — so a non-ASCII unquoted schema
 * name is REFUSED below rather than folded by a rule that might not be the server's.
 */
const ASCII_UNQUOTED_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * The single schema a `search_path` value names, WITH ITS QUOTEDNESS, or `null` when it names
 * anything else.
 *
 * `search_path` is a LIST, and a list is not something the adapter's one `schema` can be pinned to:
 * `to_regclass()` in the shared catalogue statement would resolve through every element while
 * Prisma qualified generated queries with one. So only a single element is readable here —
 * `"ims app"` and `ims_app` both name a schema; `ims_app, public` and `$user` do not.
 *
 * QUOTEDNESS IS PART OF THE NAME (o3d-2k5r r11, Codex HIGH). `search_path=TenantA` and
 * `search_path="TenantA"` are two DIFFERENT schemas: PostgreSQL folds the unquoted one to
 * `tenanta` and leaves the quoted one alone. Returning the characters as written for both, and
 * then emitting the always-quoted `search_path="TenantA"`, silently moved an existing options-only
 * URL off `tenanta` and onto a distinct schema — a tenant's writes into another tenant's schema,
 * or an outage where the mixed-case schema does not exist — and made two spellings that name
 * different schemas compare as agreement.
 */
function singleSchemaOfSearchPath(value) {
  const trimmed = String(value).trim()
  if (trimmed === '') return null
  const quoted = /^"((?:[^"]|"")*)"$/.exec(trimmed)
  if (quoted) return { schema: quoted[1].replace(/""/g, '"'), quoted: true }
  if (/[,\s"$]/.test(trimmed)) return null
  return { schema: trimmed, quoted: false }
}

/**
 * An unquoted identifier as the SERVER will read it: ASCII A-Z folded down to a-z.
 *
 * `null` for anything this cannot fold the way PostgreSQL would — a non-ASCII letter, whose case
 * mapping depends on the database encoding and collation, or a spelling that is not a legal
 * unquoted identifier at all. Both are refused by the caller rather than guessed at, which is
 * what this module already does with every other ambiguity in a `DATABASE_URL`.
 */
function foldUnquotedIdentifier(name) {
  if (!ASCII_UNQUOTED_IDENTIFIER.test(name)) return null
  return name.replace(/[A-Z]/g, (character) => character.toLowerCase())
}

/**
 * THE ONE VALUE A CONNECTION PARAMETER CARRIES, refused when the URL writes it more than once
 * (o3d-2k5r r11, Codex MEDIUM).
 *
 * `URLSearchParams.get()` returns the FIRST occurrence. The installed `pg-connection-string`
 * iterates every entry into one config object, so the LAST duplicate is the one the driver
 * connects with. A URL whose first `options` carried `search_path=first statement_timeout=1000`
 * and whose second carried `search_path=second lock_timeout=2000` was resolved by the real driver
 * to the second; this module read the first, then deleted every occurrence — so the settings the
 * server was actually being sent, timeouts included, vanished and the pin went to the wrong schema.
 *
 * THIS IS THE SAME DEFECT `scripts/fence-db-connections.mjs` CLOSED, in another file: the reader
 * and the driver disagree about which of two identically-named parameters is real. It is answered
 * the same way — REFUSED, not resolved to the driver's pick. The driver's answer is knowable, but
 * a URL that names two search paths is a URL whose reader and whose driver connect to different
 * schemas, and every other ambiguity in this module is refused rather than resolved.
 *
 * @param {URL} url
 * @param {string} name
 * @returns {string | null}
 */
function soleConnectionParameter(url, name) {
  const all = url.searchParams.getAll(name)
  if (all.length > 1) {
    throw new DatabaseUrlSchemaConflictError(
      `DATABASE_URL carries ?${name}= ${all.length} times (${all.map((value) => JSON.stringify(value)).join(', ')}). ` +
        'node-postgres copies every query parameter into one config object, so the LAST one is the one it ' +
        'connects with, while anything reading the URL a parameter at a time sees the first — which is how a ' +
        'connection is inspected here and opened somewhere else (o3d-1izw). Delete all but one.',
    )
  }
  return all.length === 1 ? all[0] : null
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
  const named = soleConnectionParameter(url, 'schema') || null
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
 * The LAST `search_path` WITHIN one `options` wins, because that is what the backend applies when
 * a startup packet assigns the same GUC twice. A REPEATED `options` parameter is a different
 * question and is refused outright — see `soleConnectionParameter()`.
 *
 * An unquoted name is folded the way the server folds it. `TenantA` unquoted IS `tenanta`, so that
 * is what is compared against `?schema=` and what is pinned; `"TenantA"` quoted is left alone.
 */
function searchPathSchemaOf(url, databaseUrl) {
  const raw = soleConnectionParameter(url, 'options')
  if (!raw) return null
  const searchPaths = readLibpqSettings(raw).filter((entry) => entry.name === 'search_path')
  if (searchPaths.length === 0) return null
  const value = searchPaths[searchPaths.length - 1].value
  const named = singleSchemaOfSearchPath(value)
  if (named === null) {
    throw new DatabaseUrlSchemaConflictError(
      `DATABASE_URL sets options=-c search_path=${value}, which does not name exactly one schema. ` +
        'Prisma qualifies generated queries with a single schema while a search path resolves raw statements ' +
        'through every element of the list, so the two cannot be pinned together (o3d-1izw). ' +
        'Name one schema, or use ?schema= instead.',
    )
  }
  if (named.quoted) {
    void databaseUrl
    return named.schema
  }
  const folded = foldUnquotedIdentifier(named.schema)
  if (folded === null) {
    throw new DatabaseUrlSchemaConflictError(
      `DATABASE_URL sets options=-c search_path=${value}, an UNQUOTED identifier this cannot read the ` +
        'way the server will. PostgreSQL folds an unquoted name with the database\'s own encoding and ' +
        'collation, so the schema it actually resolves is not knowable from here — and pinning the ' +
        'characters as written would move the connection to a different schema from the one the URL asks ' +
        'for (o3d-2k5r). Quote it to name it exactly, or write it in lower case ASCII.',
    )
  }
  void databaseUrl
  return folded
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
  const carried = readLibpqSettings(soleConnectionParameter(url, 'options') || '')
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
