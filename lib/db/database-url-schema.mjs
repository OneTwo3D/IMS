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
 * ROUND 18 CLOSES THE FIFTH HALF — THE CHARACTER THIS MODULE COUNTS AND THE SERVER MEASURES IN
 * BYTES. Rounds 12-17 refused an unescaped non-ASCII whitespace character in `options` because the
 * backend's `isspace()` classification of it depends on the database's encoding and `LC_CTYPE`, and
 * in the same breath told operators to BACKSLASH-ESCAPE it to mean it literally. Both halves were
 * byte-blind. `pg_split_opts()` consumes an escape and exactly one BYTE; every remaining byte of a
 * multi-byte character goes straight back to `isspace()`, so the escape protects the first byte and
 * nothing else — and `\s` was the wrong set to refuse in any case, since U+2020 is not whitespace to
 * anyone and carries the very byte (`A0`) U+00A0 was being refused for. The refusal and the
 * exemption were one rule stated twice, disagreeing. They are now ONE test, ahead of the escape
 * branch, on ONE justification (`NON_ASCII_JUSTIFICATION`): no code point above U+007F anywhere in
 * a startup `options`, and none in a `?schema=` either, because that name is EMITTED into one.
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
 * EVERY CHARACTER IN A STARTUP `options` WHOSE TOKEN BOUNDARIES THIS MODULE CANNOT REPRODUCE —
 * which is every character outside ASCII, ESCAPED OR NOT (o3d-2k5r r18, Codex HIGH).
 *
 * Rounds 12-17 wrote this as a Unicode-whitespace test and told the operator to backslash-escape
 * the character to mean it literally. BOTH HALVES OF THAT WERE BYTE-BLIND, and they were blind in
 * the same way, which is why they are now ONE rule with ONE justification instead of a refusal and
 * an exemption that can drift apart again:
 *
 *   * THE ESCAPE PROTECTS ONE BYTE, NOT ONE CHARACTER. `for...of` above consumes a whole code
 *     point and the escaped branch used to carry the backslash across all of it. `pg_split_opts()`
 *     does not: it consumes the backslash and exactly ONE byte after it, then hands every
 *     REMAINING byte of that character straight back to `isspace()`. `pg` serialises the string as
 *     UTF-8, so `\<U+00A0>` reaches the backend as `5C C2 A0` — the escape covers `C2`, and `A0`
 *     is classified by the deployment's own locale exactly as if nothing had been escaped. On a
 *     single-byte encoding whose `LC_CTYPE` classes `A0` as space,
 *     `-c application_name=x\<U+00A0>-c search_path=tenant` splits into a token this reader never
 *     sees, exposing `-c search_path=tenant` to the server while this module reads one long
 *     application name, finds no search path and appends a `public` pin. Raw URL and composed URL
 *     then resolve DIFFERENT schemas — the cross-tenant split this whole module exists to stop.
 *   * "NON-ASCII WHITESPACE" WAS THE WRONG SET EVEN UNESCAPED. `\s` is a property of CODE POINTS,
 *     and the hazard is a property of BYTES. U+2020 is not whitespace to anybody, and its UTF-8
 *     bytes are `E2 80 A0` — the same `A0` the refusal was written to keep out. Refusing U+00A0
 *     and admitting U+2020 is not a narrower rule, it is the same rule applied to an arbitrary
 *     subset of the bytes that carry the risk.
 *
 * SO THE RULE IS THE BYTE-LEVEL ONE, STATED AT THE CHARACTER LEVEL BECAUSE THAT IS ALL THE
 * TOKENIZER HAS: no code point above U+007F, anywhere in `options`, escaped or bare, quoted or
 * unquoted. Every ASCII character encodes to exactly one byte below `0x80`, and `isspace()` on
 * those seven bits is the C-locale answer in every encoding PostgreSQL supports — which is why the
 * six in `LIBPQ_OPTION_SEPARATORS` can be reproduced here and nothing else can.
 *
 * THIS REFUSES A `DATABASE_URL` THAT WORKS TODAY, and that is deliberate. Measured on the installed
 * PostgreSQL (17.11, SQL_ASCII, `LC_CTYPE=C`) by the live test at the bottom of
 * `tests/db/connection-schema-pinning.test.ts`, an escaped U+00A0 really does reach the server
 * whole and really does resolve the schema whose name contains it. That measurement is of THIS
 * server; the refusal is about the deployment's own, whose encoding and `LC_CTYPE` this module has
 * no way to ask. The same is already true of the unescaped form, which this server does not split
 * on either and which has been refused since round 12 for exactly this reason — the escaped form
 * turns out to be that problem, not its solution.
 */
const NON_ASCII_OPTION_CHARACTER = /[^\u0000-\u007F]/u

/**
 * WHY A NON-ASCII BYTE IN A STARTUP `options` IS REFUSED, written ONCE.
 *
 * Three call sites reach for this — an escaped character in `splitLibpqOptions()`, a bare one in
 * the same loop, and a `?schema=` name in `resolveDatabaseUrlSchema()` that would be EMITTED into
 * an `options` — and they are three routes to one fact. Rounds 12-17 had two of them stating
 * opposite conclusions from the same premise, so the shared half is a constant: change the
 * reasoning and every refusal that rests on it changes with it.
 */
const NON_ASCII_JUSTIFICATION =
  "PostgreSQL splits a startup `options` in `pg_split_opts()` by asking `isspace()` ONE BYTE AT A TIME, so " +
  "which bytes end a token is a property of the DATABASE'S ENCODING AND LC_CTYPE rather than of the string: " +
  'the UTF-8 bytes of a non-ASCII character are ordinary characters in a UTF-8 database and may be a ' +
  'separator in a single-byte encoding under some locales. A BACKSLASH DOES NOT MAKE IT KNOWABLE — ' +
  '`pg_split_opts()` consumes the escape and exactly ONE byte after it, then classifies every remaining ' +
  'byte of that character with `isspace()` as if it had never been escaped. Where the tokens end decides ' +
  'which schema this connection is pinned to, so a boundary this module cannot reproduce is refused rather ' +
  'than guessed at (o3d-2k5r).'

/**
 * The refusal itself, so the three sites cannot drift in what they SAY either — only in the one
 * clause that names where the character was found and what to do about it.
 *
 * @param {string} character a single code point
 * @param {string} lead what the URL did
 * @param {string} advice what to do instead
 * @returns {DatabaseUrlSchemaConflictError}
 */
function nonAsciiRefusal(character, lead, advice) {
  const codePoint = `U+${character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`
  return new DatabaseUrlSchemaConflictError(`${lead} ${codePoint}, a non-ASCII character. ${NON_ASCII_JUSTIFICATION} ${advice}`)
}

/**
 * WHAT POSTGRESQL STRIPS FROM AN ELEMENT OF A `search_path` VALUE (o3d-2k5r r15, Codex HIGH).
 *
 * This is a DIFFERENT server function from the one above, and it is written out separately for
 * exactly that reason. `pg_split_opts()` breaks the startup `options` into tokens; the VALUE of the
 * `search_path` assignment inside one of those tokens is then broken into elements by
 * `SplitIdentifierString()` (src/backend/utils/adt/varlena.c), which skips leading and trailing
 * whitespace with `scanner_isspace()` (src/backend/parser/scansup.c) — a FIXED list matching the
 * lexer's own `{space}`, not the locale's `isspace()`.
 *
 * MEASURED against the installed PostgreSQL (17.11, SQL_ASCII) rather than read out of its source,
 * because two different functions could disagree and only the server can say: with schemas named
 * both `tenant` and `<character>tenant` present, `set_config('search_path', '<character>tenant')`
 * put `current_schema()` on `tenant` for all six characters below — and on `<character>tenant`,
 * the character KEPT as part of the identifier, for U+00A0, U+2007, U+2028 and U+FEFF.
 *
 * The set therefore comes out equal to `LIBPQ_OPTION_SEPARATORS`, reached through another function.
 * It is not aliased to it: if a future PostgreSQL changes one list, it must not silently change the
 * other here.
 */
const SCANNER_WHITESPACE = new Set([' ', '\t', '\n', '\v', '\f', '\r'])

/**
 * A `search_path` value with the whitespace the SERVER strips stripped, and NOTHING ELSE.
 *
 * JavaScript's `String.prototype.trim()` removes UNICODE whitespace, which is a different rule from
 * the server's and strips four characters PostgreSQL keeps inside the identifier. That mismatch was
 * a live retargeting: `options=-c%20search_path%3D%5C%C2%A0tenant` was accepted by
 * `splitLibpqOptions()` precisely BECAUSE the U+00A0 was escaped, `unescapeLibpq()` handed back
 * `<U+00A0>tenant`, and `trim()` then silently reduced it to `tenant`. The name pinned into the
 * emitted `options`, compared against `?schema=`, and reported to all three raw gates was thus NOT
 * the name the server resolves; it also made `?schema=tenant` compare EQUAL to an options value
 * naming `<U+00A0>tenant`, so the two halves agreed on paper while resolving different schemas.
 *
 * ROUND 18 TOOK THAT INPUT AWAY, AND THIS FUNCTION STAYS ANYWAY. `splitLibpqOptions()` now refuses
 * a non-ASCII character in an `options` whether it is escaped or not, so no character in the
 * four-strong "kept by the server" set can reach this trim any more, and the difference between it
 * and `trim()` is currently unobservable from outside the module. It is kept because the rule it
 * states — strip what `scanner_isspace()` strips, and nothing else — is the server's, and it is
 * true independently of which characters happen to be able to arrive today. Deleting it would
 * mean a future round that admits any character above ASCII (a verified encoding, a settled
 * locale) silently re-opens a retargeting it never knew had been closed. The six ASCII characters
 * it strips are still very much reachable, and `tests/db/connection-schema-pinning.test.ts` still
 * fails if they stop being stripped.
 *
 * @param {string} value
 * @returns {string}
 */
function trimScannerWhitespace(value) {
  let start = 0
  let end = value.length
  while (start < end && SCANNER_WHITESPACE.has(value[start])) start += 1
  while (end > start && SCANNER_WHITESPACE.has(value[end - 1])) end -= 1
  return value.slice(start, end)
}

/**
 * libpq's `options` as PostgreSQL splits it: on ASCII whitespace, with a backslash escaping the
 * next character. Tokens come back STILL ESCAPED, so joining them with a single space reproduces
 * an equivalent string — every separator in the set is interchangeable to the backend.
 *
 * THAT RE-JOINING INVARIANT IS THE WHOLE POINT OF THIS FUNCTION, and a TERMINAL escape used to
 * break it (o3d-2k5r r17, Codex HIGH). See the two cases at the end of the loop.
 *
 * @param {string} options
 * @returns {string[]}
 * @throws {DatabaseUrlSchemaConflictError} on any non-ASCII character, escaped or not, whose token
 *   boundaries this cannot reproduce the way the server will, or on a terminal escape that opens a
 *   token and closes nothing.
 */
export function splitLibpqOptions(options) {
  const tokens = []
  let current = ''
  let escaped = false
  for (const character of String(options)) {
    if (character === '\u0000') {
      throw new DatabaseUrlSchemaConflictError(
        'DATABASE_URL sets options= containing U+0000. The startup packet carries every parameter as a ' +
          'NUL-TERMINATED C string, so an embedded NUL ends the options value early and shifts every byte ' +
          'after it into the parameter sequence: measured against the installed pg and PostgreSQL, the ' +
          'server rejects the connection with "invalid startup packet layout: expected terminator as last ' +
          'byte". No PostgreSQL identifier may contain U+0000 either, so there is no schema of that name to ' +
          'reach. It is refused here, where the reason can be stated, rather than emitted as a string this ' +
          'module can read back and the server can never receive (o3d-2k5r). Escaping does not help: the ' +
          'splitter drops the backslash and the NUL survives into the value.',
      )
    }
    // THE ONE GATE FOR NON-ASCII, AND IT IS AHEAD OF THE ESCAPE ON PURPOSE (o3d-2k5r r18, Codex
    // HIGH). Placed here it is asked of EVERY character, escaped or bare, so there is no second
    // rule for the escaped form to be exempted by — the exemption is what round 17 shipped and
    // what `NON_ASCII_OPTION_CHARACTER` explains is byte-blind. One test, one justification, one
    // message; a future round cannot narrow one of them without narrowing all of them.
    if (NON_ASCII_OPTION_CHARACTER.test(character)) {
      throw nonAsciiRefusal(
        character,
        `${escaped ? 'DATABASE_URL sets options= containing a backslash-escaped' : 'DATABASE_URL sets options= containing'}`,
        'Escaping it does not help and is refused for the same reason. Use ASCII in the startup options; a ' +
          'schema whose name is not ASCII cannot be pinned through this parameter at all.',
      )
    }
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
    current += character
  }
  // A TERMINAL ESCAPE, AND THE TWO THINGS THE SERVER DOES WITH ONE (o3d-2k5r r17, Codex HIGH).
  //
  // `pg_split_opts()` (src/backend/utils/init/miscinit.c) carries a `last_was_escape` flag through
  // exactly the loop above, and its inner loop ends on the terminating NUL with that flag still
  // set. The marker is simply never written out: the backslash is CONSUMED and nothing takes its
  // place. This function used to RESTORE it, and a restored backslash is not the same string —
  // it is a live escape sitting at the end of a token that `pgConnectionConfig()` then joins to
  // the pin with a space.
  //
  // MEASURED against the installed PostgreSQL (17.11) rather than read out of its source, because
  // this is the whole finding: `options=-c application_name=foo\` connects, and the server reports
  // `application_name` as `foo` — a VALID, WORKING `DATABASE_URL` today. Compose it the old way and
  // the emitted `-c application_name=foo\ -c search_path="public"` retokenises at the backend as
  // `['-c', 'application_name=foo -c', 'search_path="public"']`, whose third token is not an option
  // at all: the server refuses the startup outright with `invalid command-line argument for server
  // process: search_path="public"`. Not a mis-resolved schema this time but a total outage, taking
  // the runtime pool, the preflight, the deploy checks and the seeder with it — the one failure
  // mode worse than the green-gate/failed-write split the rest of this module closes.
  //
  // SO IT IS MIRRORED, NOT REFUSED, and the two treatments are not interchangeable here. Every
  // other refusal in this file is for an AMBIGUITY — a value whose meaning depends on the
  // database's encoding or locale (`NON_ASCII_OPTION_CHARACTER`), one the driver and this reader resolve
  // differently (`soleConnectionParameter`), one the server cannot receive at all (U+0000), one
  // whose case fold is not reproducible from here (`foldUnquotedIdentifier`). A terminal escape is
  // none of those: the server's behaviour is total, deterministic and measured above. Refusing it
  // would take a `DATABASE_URL` that connects today and make this module the reason it stops,
  // which is the opposite of what a fidelity layer is for. Mirroring also restores this function's
  // OWN documented contract — that re-joining the tokens reproduces an equivalent string — which
  // is precisely what the restored backslash falsified.
  //
  // THE ONE CASE THAT CANNOT BE MIRRORED IS REFUSED INSTEAD. When the escape opens a token and
  // closes nothing — `options=\`, or any value ending in whitespace-then-backslash — `pg_split_opts()`
  // still emits the token, EMPTY, and the server rejects that argument on sight: measured, `invalid
  // command-line argument for server process: ` with nothing after the colon. An empty token cannot
  // survive this module's composition in any case, because `[...carried, pin].join(' ')` renders it
  // as a leading separator that the backend's own whitespace skip then swallows — so there is no
  // string this function could return that reproduces it. Silently dropping it would leave this
  // module ACCEPTING a URL the server refuses, breaking the invariant stated over
  // `escapeLibpqValue()`: what this module accepts is what the server can receive. So it is named
  // here, where the reason can be given, exactly as U+0000 is.
  if (escaped && current === '') {
    throw new DatabaseUrlSchemaConflictError(
      'DATABASE_URL sets options= ending in a backslash that escapes nothing. PostgreSQL splits the ' +
        'startup options into an EMPTY final argument here and then rejects the connection with ' +
        '"invalid command-line argument for server process: ", so there is no connection to align — and ' +
        'no way to carry an empty argument through to the server once a search_path pin is appended ' +
        'after it. Remove the trailing backslash, or double it to mean a literal one (o3d-2k5r).',
    )
  }
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
 * carry through a token boundary literally. That is the backslash and the six separators in
 * `LIBPQ_OPTION_SEPARATORS`; `/[\\\s]/gu` is a superset of exactly that, so the two halves cannot
 * drift apart by one separator again, and `tests/db/connection-schema-pinning.test.ts` proves the
 * agreement by ROUND-TRIPPING a name containing all six.
 *
 * IT IS A SUPERSET AND NOT AN EXACT UNION BECAUSE THE OTHER HALF MOVED (o3d-2k5r r18, Codex HIGH).
 * Until round 17 the extra characters `\s` matches — U+00A0 and the rest — were the point: the
 * tokenizer refused them bare, so the emitter escaped them and the escape was what made the name
 * carryable. It is not: `pg_split_opts()` escapes one BYTE, and every other byte of a non-ASCII
 * character is classified by the deployment's `LC_CTYPE` regardless (see
 * `NON_ASCII_OPTION_CHARACTER`). So no non-ASCII character reaches this function at all now — the
 * tokenizer refuses one in an incoming `options`, and `resolveDatabaseUrlSchema()` refuses one in
 * a `?schema=` before it can become a pin. The wider class is kept because an escape this function
 * writes for a character that can never arrive costs nothing, while a narrower class that has to
 * be kept in step with a refusal three functions away is the drift this round removed.
 *
 * ONE CHARACTER HAS NO ESCAPE, and it is therefore refused upstream instead of written here
 * (o3d-2k5r r14, Codex MEDIUM): U+0000. The invariant this function serves is "what this module
 * emits, the SERVER reads back as what went in" — and a NUL breaks it on the driver's side, before
 * any splitter sees it, because `pg` serialises every startup parameter as a NUL-terminated C
 * string. Measured against the installed pg and PostgreSQL, an `options` carrying one does not
 * mis-resolve, it does not connect at all: `invalid startup packet layout: expected terminator as
 * last byte`. Escaping cannot save it either — `pg_split_opts()` drops the backslash and the NUL
 * survives into the value — and no PostgreSQL identifier may contain U+0000 in any case. So
 * `splitLibpqOptions()` and `resolveDatabaseUrlSchema()` refuse it, which keeps the set of values
 * this emitter accepts equal to the set the server can receive, and turns an opaque wire error
 * into the one sentence that says which parameter is wrong.
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
 * A STARTUP OPTION'S NAME AS THE BACKEND WILL LOOK IT UP (o3d-2k5r r14, Codex HIGH).
 *
 * Two normalisations, and they are the server's own, not a convention chosen here:
 *
 *   * HYPHEN TO UNDERSCORE. Every `-c name=value` and `--name=value` token in the startup
 *     `options` reaches `ParseLongOption()` (src/backend/utils/misc/guc.c), whose last act is
 *     `for (cp = *name; *cp; cp++) if (*cp == '-') *cp = '_';`. To PostgreSQL,
 *     `-c search-path=tenant_a`, `-csearch-path=tenant_a` and `--search-path=tenant_a` ARE
 *     `search_path`, in the long-option spelling its own documentation uses. This module read them
 *     as three unrelated settings: the schema fell back to `PRISMA_DEFAULT_SCHEMA`, the operator's
 *     own hyphenated assignment was carried through untouched, and `-c search_path="public"` was
 *     appended AFTER it. The backend applies both and the last assignment wins, so a deployment
 *     explicitly pinned to a tenant schema was silently moved onto `public` — the same silent
 *     retargeting rounds 10-13 closed for quotedness, repetition, tab separators and emitted
 *     separators, reached through a sixth spelling.
 *   * ASCII-ONLY CASE FOLDING, replacing a Unicode `.toLowerCase()`. The lookup itself is
 *     `guc_name_compare()` (src/backend/utils/misc/guc.c), which folds `A`-`Z` and nothing else,
 *     comparing the remaining bytes as they stand. `.toLowerCase()` is Unicode-wide and therefore
 *     a DIFFERENT rule; no character it folds into one of the ten ASCII letters of `search_path`
 *     appears to exist, so the two agree on this GUC today — which is precisely why the rule is
 *     written as the SERVER'S rule rather than left as JavaScript's default, exactly as
 *     `foldUnquotedIdentifier()` below already does for schema identifiers. The server's fold is
 *     total (every byte outside `A`-`Z` is left alone), so there is nothing here that cannot be
 *     normalised confidently and nothing to refuse: a name this module does not recognise is
 *     carried through to the backend in the tokens it was written as.
 *
 * The VALUE is deliberately not touched: `ParseLongOption()` rewrites the name only, so a schema
 * called `tenant-a` keeps its hyphen.
 *
 * @param {string} name
 * @returns {string}
 */
function canonicalGucName(name) {
  return String(name)
    .replace(/[A-Z]/g, (character) => character.toLowerCase())
    .replace(/-/g, '_')
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
    const name = canonicalGucName(unescapeLibpq(equals === -1 ? setting : setting.slice(0, equals)))
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
  const trimmed = trimScannerWhitespace(String(value))
  if (trimmed === '') return null
  const quoted = /^"((?:[^"]|"")*)"$/.exec(trimmed)
  if (quoted) {
    const decoded = quoted[1].replace(/""/g, '"')
    // A ZERO-LENGTH NAME IS NOT A SCHEMA (o3d-2k5r r16, Codex HIGH). `search_path=""` is a legal
    // search-path element and PostgreSQL accepts it at startup, but no schema of that name can
    // exist, so the connection resolves unqualified objects through NOTHING. Returned as
    // `{ schema: '' }` it was worse than a refusal: the value is FALSY, so every consumer that
    // asks "is there a schema?" answered no while `explicit` said yes. `pgConnectionConfig()`
    // returned early and left the URL's own empty search path in place, `prismaAdapterSchemaOptions()`
    // returned `undefined` and Prisma fell back to `public` — the generated-query/raw-query split
    // this whole gate exists to stop, reached through the one value that names a schema and has none.
    if (decoded === '') return null
    return { schema: decoded, quoted: true }
  }
  // The same six characters again, and NOT `\s` (o3d-2k5r r15, Codex HIGH). `\s` is Unicode-wide,
  // so it classed `<U+00A0>tenant` as "not a single schema" and sent it to the list refusal — which
  // says "name one schema", advice for a value that already names exactly one. Restricting the test
  // to the server's own whitespace routed it to a refusal that told the operator something true
  // instead. Since round 18 that particular value cannot arrive at all — `splitLibpqOptions()`
  // refuses a non-ASCII character in an `options` before this function sees the value — but the
  // rule is still the server's rule about the server's six characters, and it is what makes
  // `tenant<TAB>x` a name rather than a list.
  if (/[,"$]/.test(trimmed)) return null
  for (const character of trimmed) if (SCANNER_WHITESPACE.has(character)) return null
  return { schema: trimmed, quoted: false }
}

/**
 * An unquoted identifier as the SERVER will read it: ASCII A-Z folded down to a-z.
 *
 * `null` for anything this cannot fold the way PostgreSQL would — a spelling that is not a legal
 * unquoted identifier at all (`1tenant`, `tenant-a`), refused by the caller rather than guessed at.
 *
 * A NON-ASCII LETTER, whose case mapping depends on the database encoding and collation, USED TO BE
 * THE OTHER HALF of this and no longer reaches here (o3d-2k5r r18): `splitLibpqOptions()` refuses a
 * non-ASCII character anywhere in an `options` before the value is ever read out of it. The
 * character class stays ASCII-only regardless — the fold below is `A`-`Z` and nothing else, so
 * admitting a name this cannot fold would be inventing a case mapping, which is the ambiguity the
 * caller's refusal exists to avoid. The caller's advice ("quote it") is therefore now advice about
 * an ASCII spelling, and it is correct for one: `"1tenant"` quoted IS a schema.
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
  if (named !== null && named.includes('\u0000')) {
    throw new DatabaseUrlSchemaConflictError(
      'DATABASE_URL sets ?schema= to a name containing U+0000. It cannot be pinned: the pin goes into the ' +
        'startup packet\'s `options`, which is serialised as a NUL-TERMINATED C string, so the value ends at ' +
        'the NUL and the connection is rejected outright — measured, the server answers "invalid startup ' +
        'packet layout: expected terminator as last byte". No PostgreSQL identifier may contain U+0000 ' +
        'either, so there is no schema of that name to reach. Refused here, with the reason, rather than ' +
        'emitted as a pin this module reads back happily and the server never receives (o3d-2k5r).',
    )
  }
  // THE SAME BYTE-LEVEL RULE, REACHED FROM THE WRITING END (o3d-2k5r r18, Codex HIGH). A schema
  // this module accepts is a schema it will EMIT, as `-c search_path="<name>"` inside the very
  // `options` string `splitLibpqOptions()` now refuses to read a non-ASCII byte out of. Left
  // unchecked here, `?schema=` would be the one door through which this module puts a byte on the
  // wire whose token boundary it has just declared unknowable — and it would break the invariant
  // stated over `escapeLibpqValue()`, that what this module emits it can read back. The pin has no
  // spelling that closes it: quoting does not, because the quotes are ASCII and the bytes between
  // them are not, and escaping does not, because the escape covers one byte. So the refusal is
  // here, next to U+0000's, for the same structural reason — a name that cannot be carried is
  // refused where the reason can be stated rather than emitted and hoped for.
  for (const character of named ?? '') {
    if (NON_ASCII_OPTION_CHARACTER.test(character)) {
      throw nonAsciiRefusal(
        character,
        'DATABASE_URL sets ?schema= to a name containing',
        'The pin this module composes for it goes into that same startup `options`, so there is no spelling ' +
          'of it — quoted or escaped — whose token boundaries are knowable from here. Use an ASCII schema name.',
      )
    }
  }
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
  // THE EMPTY SEARCH PATH, IN ITS OWN WORDS (o3d-2k5r r16, Codex HIGH). Both spellings that leave
  // the path naming nothing — the bare `search_path=` and the quoted-empty `search_path=""` — come
  // back as `null` from the reader above, and the list refusal below would tell the operator to
  // "name one schema" about a value that is not a list at all. What is wrong with it is that the
  // one name it carries is zero characters long, which no schema is; say that instead.
  if (named === null && (trimScannerWhitespace(value) === '' || trimScannerWhitespace(value) === '""')) {
    throw new DatabaseUrlSchemaConflictError(
      `DATABASE_URL sets options=-c search_path=${value === '' ? '(empty)' : value}, which names a schema whose ` +
        'name is zero characters long. PostgreSQL accepts the value at startup and then resolves unqualified ' +
        'objects through no schema at all, while Prisma qualifies its generated queries with `public` — the ' +
        'split this gate exists to stop (o3d-1izw), from a URL that looks like it pins something. ' +
        'Name one schema, or use ?schema= instead.',
    )
  }
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
        'way the server will. PostgreSQL folds an unquoted name to lower case and accepts only a letter or ' +
        'underscore first, so a name spelled outside that — a leading digit, a hyphen — is not the schema ' +
        'the server resolves from these characters, and pinning them as written would move the connection ' +
        'to a different schema from the one the URL asks for (o3d-2k5r). Quote it to name it exactly, or ' +
        'write it in lower case ASCII.',
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
