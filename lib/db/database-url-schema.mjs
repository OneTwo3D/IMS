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
 * ROUND 19 FIXES WHEN THE FIFTH HALF FIRES, NOT WHETHER IT WAS RIGHT (Codex HIGH). Round 18's
 * analysis stands; its rollout did not. It rejected every non-ASCII schema BEFORE inspecting the
 * deployment — including quoted names the live test at the bottom of
 * `tests/db/connection-schema-pinning.test.ts` proves work on this server, and including
 * installations `docs/installation.md` had told to spell them exactly that way — and left them
 * with no accepted `DATABASE_URL` at all, because the adapter is composed at import. A refusal
 * that turns a working installation into a dead one on upgrade needs an upgrade path.
 *
 * The danger was only ever that the token boundary depends on the server's encoding and
 * `LC_CTYPE`, WHICH A CONNECTION CAN ASK. `establishStartupOptionByteSafety()` opens a SANITISED
 * connection (no `options`, no `schema`), records `server_encoding` and `datctype`, and then
 * MEASURES the boundary by round-tripping the exact characters through a custom GUC in this
 * module's own emitted spelling. Where the server returns them unchanged the name is carried;
 * where it cannot be established the refusal stands and names both ways out — the probe, and the
 * `ALTER SCHEMA ... RENAME TO` that makes the name ASCII. It runs from `instrumentation.ts` before
 * anything imports `lib/db`, from `preflight:production`, and from
 * `scripts/check-wms-push-state-enum.mjs` BEFORE a deploy stops the old server.
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
  return new DatabaseUrlSchemaConflictError(
    `${lead} ${codePoint}, a non-ASCII character. ${NON_ASCII_JUSTIFICATION} ${advice} ${nonAsciiUpgradePath()}`,
  )
}

/* -------------------------------------------------------------------------------------------- *
 * ROUND 19 — THE REFUSAL THAT STRANDED A WORKING DEPLOYMENT (o3d-2k5r r19, Codex HIGH).
 *
 * Round 18's byte-level analysis is right and stays. What was wrong was WHEN it fired and what it
 * offered. It rejected every non-ASCII schema before inspecting the deployment — including the
 * quoted names the live test at the bottom of `tests/db/connection-schema-pinning.test.ts` proves
 * work on this server, and including installations that had been told by `docs/installation.md` to
 * spell them exactly that way. An existing installation using one had no accepted `DATABASE_URL`
 * left: the adapter throws at construction, so the application does not boot, and the recovery is
 * a schema rename the refusal did not mention. A refusal that turns a working installation into a
 * dead one on upgrade needs an upgrade path, and "rename your schema" is not one if nothing says
 * so.
 *
 * THE DANGER WAS ONLY EVER THAT THE BOUNDARY DEPENDS ON THE SERVER'S ENCODING AND `LC_CTYPE` —
 * AND A CONNECTION CAN ASK. `pg_split_opts()` classifies ONE BYTE AT A TIME with `isspace()`, so
 * whether the UTF-8 bytes of a name end a token is a fact about the deployment, not about the
 * string. This module could not reason its way to that fact from the URL, which is why round 18
 * refused. It can MEASURE it, on the deployment's own server, and that is what
 * `establishStartupOptionByteSafety()` does:
 *
 *   1. it opens a SANITISED connection — the URL with `?options=` and `?schema=` removed and NO
 *      `options` in the config — so not one byte whose boundary is in question is in that startup
 *      packet. A probe that had to be trusted to be safe would be no better than the guess;
 *   2. it records `server_encoding` and `lc_ctype`, which are what the boundary depends on and
 *      what the operator has to be told when the answer is no;
 *   3. it then MEASURES the boundary rather than deducing it from those two. A second connection
 *      carries the exact characters in question, escaped by `escapeLibpqValue()` — this module's
 *      own emitter — inside a custom GUC (`ims.startup_option_probe`), and asks the server to say
 *      it back. `application_name` cannot be used for this: `check_application_name()` runs the
 *      value through `pg_clean_ascii()` and the non-ASCII bytes never survive to be compared. A
 *      custom (dotted) GUC is stored as a placeholder string, verbatim.
 *
 *      If the server split on one of those bytes, the remainder of the character becomes a bare
 *      argument and the backend refuses the startup outright — so a split is a FAILED PROBE, never
 *      a quiet pass. If it did not split, the value comes back byte-for-byte and the boundary is
 *      established for exactly the characters that were measured.
 *
 * WHERE THE SERVER ANSWERS SAFELY THE NAME IS CARRIED. Where it cannot be established — the probe
 * has not run, the server could not be reached, or the measurement came back changed — the refusal
 * stands, and it now NAMES THE ALTERNATIVE: what the probe is, where it runs, and the exact SQL
 * that renames the schema to something ASCII.
 *
 * THE VERDICT IS PER-CHARACTER AND PER-TARGET. `isspace()` is a per-byte classification with no
 * adjacency, so a character measured intact is intact wherever it appears; a character that was
 * never measured is not covered by a verdict about other ones. And a verdict is about ONE server,
 * so it is keyed by host/port/database — never by the credential, which is not part of the
 * question and has no business in a cache key.
 *
 * AND A HOST:PORT IS NOT A SERVER (o3d-2k5r r21, Codex HIGH). `db.internal:5432/ims` is a LOGICAL
 * endpoint. Behind it may be a pooler, a load balancer, a DNS name with several A records, or a
 * failover pair — and one probe connection then measures one backend while the application's pool
 * opens connections that may land on another. If the backends disagree about encoding or locale,
 * the positive verdict earned on one licenses an unsafe startup option on the other.
 *
 * SO POSITIVE EVIDENCE IS BOUND TO THE BACKEND THAT ANSWERED IT, NOT TO THE ENDPOINT. Every
 * connection the probe opens reports who served it — `inet_server_addr()`, `inet_server_port()`,
 * the server version, and the database's encoding and ctype, which are the properties in question.
 * A verdict may only be POSITIVE when every one of those samples reports the SAME backend, and the
 * verdict then records that identity. Samples that disagree settle as NOT ESTABLISHED with a reason
 * naming both, which is the refusal — the endpoint fanned out, so no single server's answer covers
 * the connections the application will open.
 *
 * WHAT THAT DOES AND DOES NOT ESTABLISH, said plainly rather than implied:
 *
 *   • It DETECTS fan-out. Three independent connections landing on two backends is proof of it.
 *   • It does NOT PROVE its absence. Three samples agreeing is evidence, not a census: a
 *     round-robin over two backends can put all three on one — 12.5% of boots over two equally
 *     selected members, and far more under sticky or weighted routing. This is stated here because
 *     the alternative — refusing every endpoint that cannot be PROVEN single-backend — is a
 *     refusal nobody can ever lift, and it strands every deployment behind a pooler.
 *   • SO THE SAMPLES ARE NOT THE ENFORCEMENT, AND THIS IS THE CORRECTION ROUND 22 MAKES
 *     (Codex HIGH). Round 21 turned three agreeing samples into a process-wide permission for a
 *     LOGICAL target, which licensed every backend behind the endpoint exactly as before, only
 *     less often wrongly. The probe's job is now narrower and honest: it decides whether these
 *     bytes survive, and it NAMES the backend that said so. Whether a given connection may carry
 *     them is decided per connection, against that name, by `startupOptionBackendGuard()` — see
 *     the block over it. A failover, a re-pointed pooler or an unsampled member therefore does not
 *     get the permission; it gets a refused connection with a reason.
 *   • The probe still re-runs at every boot (`instrumentation.ts`), in `preflight:production`, and
 *     in `scripts/check-wms-push-state-enum.mjs` before a deploy stops the old server, so a server
 *     replaced underneath a deployment is re-measured rather than assumed.
 *
 * THE SHAPE OF THE FAILURE IS WHY THE REMAINING RESIDUE IS SMALL. A backend that SPLITS on the byte
 * refuses the startup packet outright: the connection fails loudly, and no query runs against a
 * schema nobody meant. The dangerous class is the narrower one — a backend that accepts the
 * startup and hands back something OTHER than what was written — and it is the class the
 * measurement below settles as `carries: false` AND the class the per-connection guard's
 * `search_path` comparison catches on a backend the probe never saw.
 * -------------------------------------------------------------------------------------------- */

/** How long the probe may spend opening each of its three connections. */
const STARTUP_OPTION_PROBE_TIMEOUT_MS = 5_000

/** The custom GUC the probe round-trips through. Dotted, so PostgreSQL stores it as a placeholder. */
const STARTUP_OPTION_PROBE_GUC = 'ims.startup_option_probe'

/**
 * WHO SERVED THIS CONNECTION, and what its answer would be about.
 *
 * `inet_server_addr()`/`inet_server_port()` are evaluated ON THE BACKEND and report the address
 * that backend accepted the connection on — so behind a pooler or a TCP load balancer they name the
 * PostgreSQL that actually answered, not the endpoint that was dialled. They are NULL over a Unix
 * socket, which is a single backend by construction; that reads as an empty address rather than as
 * a failure. `server_version`, `server_encoding` and `datctype` come along because they are the
 * properties the measurement is about: two backends agreeing on address and disagreeing on encoding
 * is not one backend for this question's purposes.
 *
 * It leads with `select pg_encoding_to_char` because that is the shape the probe has always asked
 * for and what the fakes in the tests key on.
 */
const BACKEND_IDENTITY_COLUMNS =
  'pg_encoding_to_char(encoding) as server_encoding, datctype as lc_ctype, ' +
  "coalesce(host(inet_server_addr()), '') as backend_address, " +
  "coalesce(inet_server_port()::text, '') as backend_port, " +
  "coalesce(current_setting('server_version', true), '') as server_version, " +
  // WHOSE SOCKET THE BACKEND THINKS IT IS TALKING TO (o3d-2k5r r23, Codex HIGH). Read from
  // `pg_stat_activity` for THIS backend's own pid, which needs no privilege. On a direct TCP
  // connection these are, by construction, the far end of the very socket this process holds. On a
  // Unix socket `client_addr` is NULL and `client_port` is -1, which is not a mismatch but an
  // absence — see `interposedConnectionRefusal()`.
  "coalesce((select host(client_addr) from pg_stat_activity where pid = pg_backend_pid()), '') as client_address, " +
  "coalesce((select client_port::text from pg_stat_activity where pid = pg_backend_pid()), '') as client_port"

const BACKEND_IDENTITY_SQL = `select ${BACKEND_IDENTITY_COLUMNS} from pg_database where datname = current_database()`

/**
 * THE SAME QUESTION, ASKED BY THE CONNECTION THAT MUST ANSWER IT (o3d-2k5r r22, Codex HIGH).
 *
 * `establishStartupOptionByteSafety()` asks `BACKEND_IDENTITY_SQL` of the connections IT opens.
 * This asks it of a connection the APPLICATION POOL has just opened, and adds the one column the
 * probe has no use for: the `search_path` that connection actually ended up with. The two are
 * deliberately built from the same column list, because the identity a guard compares must be
 * spelled by the same `backendIdentityOf()` that spelled the one it is compared against — two
 * hand-written column lists are two chances to drift apart into a check that always passes.
 *
 * It leads with `select pg_encoding_to_char` for the same reason the probe's does.
 */
const SERVED_CONNECTION_SQL =
  `select ${BACKEND_IDENTITY_COLUMNS}, current_setting('search_path') as search_path ` +
  'from pg_database where datname = current_database()'

/**
 * One backend's identity, as a string that compares.
 *
 * A row that carries none of the identifying columns — which is what a stand-in client that answers
 * only the two original columns produces — yields `'@|'` plus the encoding pair. That is
 * deliberately NOT treated as "unknown, so refuse": the columns it does carry are the ones the
 * verdict is about, and an endpoint that reports the same encoding and ctype on every connection
 * has not been shown to fan out. What it does mean is stated in the header: this detects fan-out,
 * it does not prove single-backend.
 *
 * @param {Record<string, unknown>} row
 * @returns {string}
 */
function backendIdentityOf(row) {
  const field = (name) => String(row?.[name] ?? '')
  return `${field('backend_address')}:${field('backend_port')}|${field('server_version')}|${field('server_encoding')}|${field('lc_ctype')}`
}

/* ----------------------------------------------------------------------------------------------
 * A CLIENT SOCKET IS NOT A SERVER BACKEND (o3d-2k5r r23, Codex HIGH).
 *
 * Round 22 put the check on `onConnect`, which `pg-pool` awaits ONCE per new physical connection
 * and deliberately never on reuse. That is the right hook for "which server answered when this
 * socket came up", and it is the wrong hook for the question a transaction- or statement-pooling
 * proxy raises: such a proxy TERMINATES the client connection and re-assigns the SERVER side per
 * unit of work, so one client socket is many server backends over its life. The guard would run on
 * backend A and the application's next statement would run on backend B, with no new pg client
 * created and therefore no second check.
 *
 * SO THE QUESTION IS ASKED THE OTHER WAY ROUND: not "which backend answered", but "is the backend
 * that answered on the other end of MY socket". `pg_stat_activity.client_addr`/`client_port` for
 * the backend's own pid report the peer the BACKEND accepted. On a direct connection that is this
 * process's own socket, byte for byte. Anything that speaks the PostgreSQL protocol in the middle —
 * every pooler, by construction, since it must parse the protocol to multiplex it — opens its own
 * connection to the backend, and the backend then names the POOLER's socket, not ours. A connection
 * whose far end is not ours is a connection that can be re-pointed without us being told, so it may
 * not carry licensed bytes.
 *
 * REFUSING COSTS NOTHING THAT WORKED, AND THAT IS MEASURED, NOT ASSUMED. Against PgBouncer 1.24.1
 * (Debian 13) in front of PostgreSQL 17.11, with a schema named `tënant` that a DIRECT connection
 * pins and resolves correctly:
 *
 *   • DEFAULT CONFIGURATION, `pool_mode = transaction` AND `pool_mode = session` alike: the pooler
 *     refuses the connection outright — `FATAL: unsupported startup parameter in options:
 *     search_path`. The same happens for the probe's own `-c ims.startup_option_probe=...`.
 *   • `ignore_startup_parameters = search_path` OR `track_extra_parameters = search_path`: the
 *     connection is ACCEPTED and the option is DISCARDED. `current_setting('search_path')` came
 *     back `"$user", public` on five consecutive connections and the query resolved
 *     `public.marker`, not `"tënant".marker`. It is not specific to `search_path` or to non-ASCII:
 *     `-c statement_timeout=1234` sent the same way came back `1234ms` direct and `0` through the
 *     pooler, so NO startup `options` content reaches the backend at all.
 *
 * There is therefore no PgBouncer configuration in which a startup-`options` schema pin reaches the
 * server. A non-ASCII schema behind a pooler was already broken — silently, which is the whole
 * hazard — so refusing it is reporting that, not restricting anything that worked.
 *
 * WHAT THIS KEYS ON, SAID PLAINLY. A proxy's `pool_mode` is not readable from an ordinary SQL
 * connection (PgBouncer answers `SHOW pool_mode` only on its own admin database), so this does NOT
 * detect the pooling mode. It detects INTERPOSITION — that something terminated the connection —
 * which is the precondition for multiplexing of any mode. Two consequences are stated rather than
 * hidden:
 *
 *   • A plain TCP NAT or port-forward also rewrites the peer, and is refused too even though it
 *     cannot multiplex. That is a false positive on a working configuration. It is accepted
 *     deliberately: it can only ever affect a NON-ASCII schema (the ASCII path attaches no check at
 *     all), the failure is loud with the two documented ways out, and the alternative — trusting a
 *     connect-time reading of a socket that may be re-pointed — is a silent cross-schema write.
 *   • Over a UNIX-DOMAIN socket the backend reports no peer at all (`client_addr` NULL,
 *     `client_port` -1), so a pooler and a direct connection are indistinguishable here and the
 *     check is SKIPPED rather than guessed. What still covers that case is the `search_path`
 *     comparison below, which the measurements above show refuses every real pooler deterministically
 *     — the pin simply does not arrive. The residue is a hypothetical proxy that forwards startup
 *     options faithfully AND multiplexes AND is reached over a Unix socket; it is recorded, not
 *     claimed closed.
 *
 * Also rejected, after measuring it: detecting the pooler by CONNECTION REUSE — comparing
 * `now() - backend_start` against our own elapsed connect time. Through PgBouncer the reused server
 * backend was 9-14ms old against our own 1-12ms, which no usable tolerance separates, and the first
 * connection to a cold pool is genuinely fresh. It is a heuristic that fails both ways, so it is not
 * shipped.
 * -------------------------------------------------------------------------------------------- */

/**
 * The same address, spelled the way both ends spell it: Node reports an IPv4 peer over a
 * dual-stack socket as `::ffff:127.0.0.1` where PostgreSQL's `host()` reports `127.0.0.1`.
 *
 * @param {unknown} address
 * @returns {string}
 */
function normalisedPeerAddress(address) {
  return String(address ?? '').replace(/^::ffff:/i, '')
}

/**
 * OUR end of the socket this client is talking over, or `null` when it cannot be read — which is
 * every non-`pg` stand-in, and a client that is not connected.
 *
 * @param {unknown} client
 * @returns {{ address: string, port: string } | null}
 */
function ownSocketEndpoint(client) {
  const stream = /** @type {{ connection?: { stream?: { localAddress?: unknown, localPort?: unknown } } }} */ (client)
    ?.connection?.stream
  const port = stream?.localPort
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0) return null
  return { address: normalisedPeerAddress(stream?.localAddress), port: String(port) }
}

/**
 * Why this connection cannot be shown to reach the backend directly, or `null` when it can.
 *
 * The row is whatever `BACKEND_IDENTITY_COLUMNS` produced. When the backend reports NO peer —
 * a Unix-domain socket, or a stand-in that does not answer these columns — the question is
 * unanswerable rather than answered badly, and this returns `null`; see the block comment above for
 * what still covers that case.
 *
 * @param {unknown} client
 * @param {Record<string, unknown>} row
 * @returns {string | null}
 */
function interposedConnectionRefusal(client, row) {
  return interposedPeerRefusal(ownSocketEndpoint(client), row)
}

/**
 * The same judgement, from an endpoint that was read while the connection was still up.
 *
 * The probe's own clients are `end()`ed in a `finally` before their answers are judged, and a
 * destroyed socket reports no `localPort` — which the check below reads, correctly, as "this
 * process cannot say what its own socket was" and refuses. So the probe captures the endpoint at
 * query time and passes it here instead of the client.
 *
 * @param {{ address: string, port: string } | null} ours
 * @param {Record<string, unknown>} row
 * @returns {string | null}
 */
function interposedPeerRefusal(ours, row) {
  const backendSees = {
    address: normalisedPeerAddress(row?.client_address),
    port: String(row?.client_port ?? ''),
  }
  // No peer to compare against: Unix socket (-1), or a row that never carried these columns.
  if (backendSees.port === '' || backendSees.port === '-1') return null

  if (ours === null) {
    return (
      `The backend reports its client as ${JSON.stringify(`${backendSees.address}:${backendSees.port}`)}, and this ` +
      `process cannot read its own end of the socket to compare, so the connection cannot be shown to reach the ` +
      `backend directly.`
    )
  }
  if (ours.port !== backendSees.port || (ours.address !== '' && backendSees.address !== '' && ours.address !== backendSees.address)) {
    return (
      `The backend accepted this connection from ${JSON.stringify(`${backendSees.address}:${backendSees.port}`)} and ` +
      `this process's own socket is ${JSON.stringify(`${ours.address}:${ours.port}`)}, so something between the two ` +
      `terminated the connection and opened its own to the backend. A connection pooler re-assigns the server side ` +
      `per transaction, which means a startup option measured on the backend that answered this connection says ` +
      `nothing about the backend that runs the next statement. Measured against PgBouncer 1.24.1, a startup ` +
      `options= is either refused outright ("unsupported startup parameter in options") or, where an operator has ` +
      `named it in ignore_startup_parameters or track_extra_parameters, accepted and silently discarded — so a ` +
      `schema pinned through startup options cannot work behind a pooler at all, and this refuses a configuration ` +
      `that was already broken rather than restricting one that worked.`
    )
  }
  return null
}

/**
 * @typedef {object} StartupOptionByteVerdict
 * @property {boolean} established whether a probe reached the server and settled the question
 * @property {boolean} carries whether the measured characters survived the server's tokenizer
 * @property {string} probed the characters that were measured, '' when none were
 * @property {string | null} target the host/port/database the verdict is about
 * @property {string | null} backend the PHYSICAL backend every probe connection reported, or null
 *   when nothing was measured. A positive verdict is about THIS backend, not about the endpoint
 * @property {string | null} serverEncoding
 * @property {string | null} lcCtype
 * @property {string} reason why it says what it says, in the words the refusal quotes
 */

/** @type {StartupOptionByteVerdict} */
const NO_VERDICT = Object.freeze({
  established: false,
  carries: false,
  probed: '',
  target: null,
  backend: null,
  serverEncoding: null,
  lcCtype: null,
  reason: 'no deployment probe has run in this process',
})

/* ----------------------------------------------------------------------------------------------
 * WHERE THE VERDICT LIVES, AND WHY IT IS NOT A MODULE VARIABLE (o3d-2k5r r20, Codex HIGH).
 *
 * Round 19 held it in `let startupOptionByteVerdict` — module-local mutable state. That is correct
 * for ONE instance of this module and wrong for the artifact we actually ship. Codex read the BUILT
 * output, not the source: `next build` emits this file into SEVERAL chunks (the node server chunk
 * the instrumentation hook pulls in, a second node chunk the application graph pulls in, an SSR
 * chunk and an edge chunk), and each one carries its OWN copy of the module — its own `NO_VERDICT`,
 * its own binding. `instrumentation.ts` therefore measured the server in one copy while
 * `pgConnectionConfig()` asked a DIFFERENT copy, which had never probed anything and answered
 * "no deployment probe has run in this process". The lift round 19 added could not reach the
 * runtime, so a deployment whose server demonstrably carries the bytes was still refused at boot,
 * with a message telling the operator to rename their schema. NO SOURCE-LEVEL TEST COULD SEE THIS:
 * an unbundled `import` resolves one instance, and one instance cannot be told apart from two.
 *
 * SO THE VERDICT IS PROCESS-WIDE, not module-wide. `globalThis` is the one object every bundled
 * copy in a process shares, and `Symbol.for()` is the one key they can all compute without being
 * able to see each other. The probe writes there and every copy reads from there, so "has this
 * deployment been measured" is a fact about the PROCESS, which is what it always claimed to be.
 *
 * IT IS GUARDED, AND THE GUARD FAILS CLOSED. Anything may write to a global; a slot holding
 * something this module did not put there is not evidence about any server, so a value that is not
 * shaped like a verdict reads back as `NO_VERDICT` — the refusal, not a pass. The key carries a
 * version (`.v1`) so a future shape takes a different slot rather than being half-understood by an
 * older copy sharing the process.
 * -------------------------------------------------------------------------------------------- */

/**
 * The process-wide slot the verdict lives in, computed identically by every bundled copy.
 *
 * `.v2` since o3d-2k5r r21: the record gained `backend`, and a copy that predates the field must
 * not read a v2 record as if the field were absent — nor a v1 record be accepted as one whose
 * backend was checked. A shape change takes a new slot; that is what the version is for.
 */
const STARTUP_OPTION_VERDICT_SLOT = Symbol.for('ims.db.startupOptionByteVerdict.v2')

/**
 * Is this something this module wrote? Shape only — a global is writable by anyone, and a
 * malformed record is treated as no record at all rather than as a verdict.
 *
 * @param {unknown} value
 * @returns {value is StartupOptionByteVerdict}
 */
function isStartupOptionByteVerdict(value) {
  if (typeof value !== 'object' || value === null) return false
  const record = /** @type {Record<string, unknown>} */ (value)
  const stringOrNull = (field) => typeof record[field] === 'string' || record[field] === null
  return (
    typeof record.established === 'boolean' &&
    typeof record.carries === 'boolean' &&
    typeof record.probed === 'string' &&
    typeof record.reason === 'string' &&
    stringOrNull('target') &&
    stringOrNull('backend') &&
    stringOrNull('serverEncoding') &&
    stringOrNull('lcCtype')
  )
}

/**
 * The verdict this PROCESS holds, whichever copy of this module established it.
 *
 * @returns {StartupOptionByteVerdict}
 */
function heldStartupOptionByteVerdict() {
  const held = globalThis[STARTUP_OPTION_VERDICT_SLOT]
  return isStartupOptionByteVerdict(held) ? held : NO_VERDICT
}

/**
 * Publish a verdict to the process. `defineProperty` rather than assignment so the slot is
 * non-enumerable (it has no business in `Object.keys(globalThis)` or a serialised global) and so a
 * previously defined descriptor cannot make the write fail silently.
 *
 * @param {StartupOptionByteVerdict} verdict
 * @returns {StartupOptionByteVerdict}
 */
function publishStartupOptionByteVerdict(verdict) {
  Object.defineProperty(globalThis, STARTUP_OPTION_VERDICT_SLOT, {
    value: verdict,
    writable: true,
    configurable: true,
    enumerable: false,
  })
  return verdict
}

/** What the probe last established, or `NO_VERDICT`. @returns {StartupOptionByteVerdict} */
export function startupOptionByteSafety() {
  return heldStartupOptionByteVerdict()
}

/** Forget it. Exported for tests, which must not inherit one another's server. */
export function resetStartupOptionByteSafety() {
  publishStartupOptionByteVerdict(NO_VERDICT)
}

/**
 * The host/port/database a URL names, with the credential left out.
 *
 * @param {string | undefined | null} databaseUrl
 * @returns {string | null}
 */
function connectionTarget(databaseUrl) {
  try {
    const url = new URL(String(databaseUrl))
    return `${url.hostname}:${url.port}${url.pathname}`
  } catch {
    return null
  }
}

/**
 * Every distinct non-ASCII character a URL would put into a startup `options` — the ones in
 * `?schema=`, which this module EMITS into one, and the ones already inside `?options=`, which it
 * has to READ out of one. Read off the raw parameter values, so nothing has to tokenize first.
 *
 * @param {string | undefined | null} databaseUrl
 * @returns {string}
 */
export function nonAsciiStartupOptionCharacters(databaseUrl) {
  let url
  try {
    url = new URL(String(databaseUrl))
  } catch {
    return ''
  }
  const seen = new Set()
  for (const name of ['schema', 'options']) {
    for (const value of url.searchParams.getAll(name)) {
      for (const character of value) {
        if (NON_ASCII_OPTION_CHARACTER.test(character)) seen.add(character)
      }
    }
  }
  return Array.from(seen).sort().join('')
}

/**
 * The URL the probe connects with: the same server, with every parameter whose bytes are the
 * question removed and no `options` composed in its place.
 *
 * @param {string | undefined | null} databaseUrl
 * @returns {string | null} `null` when the input is not a URL
 */
export function sanitisedProbeConnectionString(databaseUrl) {
  let url
  try {
    url = new URL(String(databaseUrl))
  } catch {
    return null
  }
  url.searchParams.delete('options')
  url.searchParams.delete('schema')
  return url.toString()
}

/** @param {unknown} error */
function probeFailureReason(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\s+/g, ' ').slice(0, 300)
}

/**
 * Ask THIS deployment whether it can carry the non-ASCII bytes this `DATABASE_URL` needs.
 *
 * Callers: `instrumentation.ts` (before the runtime adapter is built), `lib/ops/production-preflight`
 * and `scripts/check-wms-push-state-enum.mjs` — the last of which runs BEFORE the old server is
 * stopped, so an unsupported schema is a pre-deploy rejection and not a failed restart.
 *
 * It never throws: an unreachable server is an UNESTABLISHED verdict, which is a refusal with a
 * reason, not an exception from a boot path.
 *
 * @param {string | undefined | null} databaseUrl
 * @param {{ createClient?: (config: object) => Promise<{ connect(): Promise<unknown>, query(text: string): Promise<{ rows: Array<Record<string, unknown>> }>, end?: () => Promise<unknown> }> }} [options]
 * @returns {Promise<StartupOptionByteVerdict>}
 */
export async function establishStartupOptionByteSafety(databaseUrl, options = {}) {
  const target = connectionTarget(databaseUrl)
  const probed = nonAsciiStartupOptionCharacters(databaseUrl)
  const connectionString = sanitisedProbeConnectionString(databaseUrl)

  /** @param {Partial<StartupOptionByteVerdict>} fields */
  const settle = (fields) => publishStartupOptionByteVerdict(Object.freeze({ ...NO_VERDICT, probed, target, ...fields }))

  if (connectionString === null) {
    return settle({ reason: 'DATABASE_URL is not a URL, so there is no server to ask' })
  }
  if (probed === '') {
    // Nothing to measure. Established, trivially, so a caller can tell "asked and there was
    // nothing to ask about" from "never asked".
    return settle({ established: true, carries: true, reason: 'the URL carries no non-ASCII startup bytes' })
  }

  const createClient =
    options.createClient ??
    (async (config) => {
      const pg = await import('pg')
      const Client = pg.Client ?? pg.default?.Client
      return new Client(config)
    })

  /**
   * @param {object} config
   * @param {string[]} queries
   */
  const ask = async (config, queries) => {
    const client = await createClient({ connectionTimeoutMillis: STARTUP_OPTION_PROBE_TIMEOUT_MS, ...config })
    try {
      await client.connect()
      const answers = []
      for (const query of queries) answers.push((await client.query(query)).rows[0] ?? {})
      // The socket is read while the client is still up: `end()` in the `finally` below destroys it,
      // and a destroyed socket reports no local port — which the peer check would correctly read as
      // "this process cannot say what its own socket was" and refuse every deployment.
      return { answers, socket: ownSocketEndpoint(client) }
    } finally {
      await Promise.resolve(client.end?.()).catch(() => undefined)
    }
  }

  // 1 + 2. The sanitised connection, and what the boundary depends on. Both come out of
  // `pg_database`, not out of `SHOW`: `lc_ctype` stopped being a GUC in PostgreSQL 16 (it is a
  // per-database property), so `SHOW lc_ctype` is "unrecognized configuration parameter" on every
  // supported server and asking for it that way would report every deployment as unreachable.
  let serverEncoding = null
  let lcCtype = null
  // WHO ANSWERED, SAMPLED INDEPENDENTLY (o3d-2k5r r21, Codex HIGH). Two sanitised connections, not
  // one: a single sample cannot tell an endpoint with one backend from an endpoint that fanned this
  // connection to one of several. The third sample comes off the option-carrying connection below,
  // which is the one whose answer the positive verdict is actually made of.
  const identities = []
  try {
    const { answers: [row, second] } = await ask({ connectionString }, [BACKEND_IDENTITY_SQL, BACKEND_IDENTITY_SQL])
    serverEncoding = String(row.server_encoding ?? '') || null
    lcCtype = String(row.lc_ctype ?? '') || null
    identities.push(backendIdentityOf(row))
    // Two queries on ONE connection cannot land on two backends, so `second` is not a sample of the
    // endpoint. It is read anyway so that a stand-in client answering per-call rather than
    // per-connection cannot make the agreement below vacuous without also disagreeing here.
    identities.push(backendIdentityOf(second))
  } catch (error) {
    return settle({ reason: `the probe could not reach the server: ${probeFailureReason(error)}` })
  }

  // A SECOND CONNECTION TO THE SAME ENDPOINT. Independent of the first, so a round-robin or a
  // pooler handing out a different backend shows up here.
  try {
    const { answers: [row] } = await ask({ connectionString }, [BACKEND_IDENTITY_SQL])
    identities.push(backendIdentityOf(row))
  } catch (error) {
    return settle({
      reason: `a second connection to the same endpoint could not be opened, so whether it has one backend or several is unknown: ${probeFailureReason(error)}`,
    })
  }

  // 3. The measurement itself, in this module's own emitted spelling.
  const sentinel = `a${probed}z`
  try {
    const { answers: [answer, servedBy], socket: measuredOver } = await ask(
      { connectionString, options: `-c ${STARTUP_OPTION_PROBE_GUC}=${escapeLibpqValue(sentinel)}` },
      [`SHOW ${STARTUP_OPTION_PROBE_GUC}`, BACKEND_IDENTITY_SQL],
    )
    // THE ONE THAT MATTERS: the backend that produced the measurement itself.
    identities.push(backendIdentityOf(servedBy))
    const returned = String(answer[STARTUP_OPTION_PROBE_GUC.split('.').pop()] ?? answer[STARTUP_OPTION_PROBE_GUC] ?? '')
    if (returned !== sentinel) {
      return settle({
        established: true,
        carries: false,
        serverEncoding,
        lcCtype,
        reason: `this server (server_encoding=${serverEncoding}, lc_ctype=${lcCtype}) did not return the probed characters unchanged — it sent back ${JSON.stringify(returned)} where ${JSON.stringify(sentinel)} was written, so its tokenizer does not carry these bytes`,
      })
    }
    // A LICENCE IS ABOUT A BACKEND THIS PROCESS CAN STILL BE TALKING TO WHEN IT SPENDS IT
    // (o3d-2k5r r23, Codex HIGH). The measurement above is a reading taken on one server session;
    // behind a transaction- or statement-pooling proxy the application's later statements run on a
    // different one, so the reading licenses nothing. Refused HERE as well as per connection so the
    // operator gets one message, at boot, in preflight:production and in the pre-deploy check,
    // rather than an opaque per-connection error later.
    const interposed = interposedPeerRefusal(measuredOver, servedBy)
    if (interposed !== null) {
      return settle({
        serverEncoding,
        lcCtype,
        reason: `the connection the measurement was made on does not reach the backend directly. ${interposed}`,
      })
    }
    // A POSITIVE VERDICT IS ABOUT ONE BACKEND, so it is only settled when every sample says the
    // same one answered. Note the asymmetry, which is deliberate: a `carries: false` above needs no
    // agreement, because a refusal earned on ANY backend behind this endpoint is a refusal that is
    // safe to apply to all of them. It is only the permission that has to be bound to a server.
    const distinct = Array.from(new Set(identities))
    if (distinct.length > 1) {
      return settle({
        serverEncoding,
        lcCtype,
        reason:
          `this endpoint did not answer as one server: connections to it were served by ${distinct.length} ` +
          `different backends (${distinct.map((identity) => JSON.stringify(identity)).join(' and ')}). A ` +
          'measurement made on one of them says nothing about the connections the application pool will open ' +
          'on the others, so no permission is granted. Point DATABASE_URL at a single backend, or rename the ' +
          'schema to ASCII',
      })
    }
    return settle({
      established: true,
      carries: true,
      backend: distinct[0] ?? null,
      serverEncoding,
      lcCtype,
      reason: `measured on this server (backend=${distinct[0] ?? ''}, server_encoding=${serverEncoding}, lc_ctype=${lcCtype}), which is the one backend every probe connection to this endpoint reached: the probed characters survive pg_split_opts() intact`,
    })
  } catch (error) {
    // A split turns the remainder of the character into a bare argument and the backend refuses
    // the startup. That is the unsafe answer arriving as a connection error, and it is recorded as
    // "could not be established" rather than guessed either way.
    return settle({
      established: false,
      serverEncoding,
      lcCtype,
      reason: `the probe connection carrying those characters was refused by the server (server_encoding=${serverEncoding}, lc_ctype=${lcCtype}): ${probeFailureReason(error)}`,
    })
  }
}

/**
 * May this module put `character` into a startup `options` for the deployment it is talking to?
 *
 * @param {string} character
 * @param {string | undefined | null} [databaseUrl] the URL in hand, when the caller has one
 * @returns {boolean}
 */
function nonAsciiOptionByteIsCarried(character, databaseUrl) {
  const verdict = heldStartupOptionByteVerdict()
  if (!verdict.established || !verdict.carries) return false
  if (!verdict.probed.includes(character)) return false
  if (databaseUrl !== undefined && verdict.target !== null && connectionTarget(databaseUrl) !== verdict.target) return false
  // THE PERMISSION IS THE BACKEND'S, SO THIS READS THE BACKEND (o3d-2k5r r22, Codex HIGH).
  //
  // Round 21 recorded `verdict.backend` and then authorised without ever looking at it, which made
  // the record read like a check while the grant was still the endpoint's. A verdict that cannot
  // NAME the server it is about is a verdict nothing downstream can hold a connection to, so it
  // grants nothing here — and because it does name one, `startupOptionBackendGuard()` below can
  // refuse any physical connection that reaches a different server. Those two are one mechanism:
  // this half decides the bytes may be emitted, that half decides which connections may carry them.
  if (verdict.backend === null || verdict.backend === '') return false
  return true
}

/** What a refusal tells the operator to do about it. Written once, for the same reason the justification is. */
function nonAsciiUpgradePath() {
  const verdict = heldStartupOptionByteVerdict()
  const measured =
    verdict.serverEncoding || verdict.lcCtype
      ? ` The deployment probe reported server_encoding=${verdict.serverEncoding} and lc_ctype=${verdict.lcCtype}${verdict.backend ? ` on backend ${verdict.backend}` : ''}.`
      : ''
  return (
    'THIS IS NOT A FLAT REFUSAL OF NON-ASCII SCHEMAS, and there are two ways out of it. (1) LET THE ' +
    'DEPLOYMENT ANSWER: establishStartupOptionByteSafety() opens a SANITISED connection (no options, no ' +
    'schema parameter), reads server_encoding and lc_ctype, and then round-trips these exact characters ' +
    'through a custom GUC to measure whether the server splits on them. Where it says they survive, the ' +
    'name is carried unchanged. It runs at startup from instrumentation.ts, in preflight:production, and ' +
    'in scripts/check-wms-push-state-enum.mjs BEFORE a deploy stops the old server. That is the path to ' +
    'take when this deployment already works with such a schema. (2) RENAME THE SCHEMA TO ASCII: ' +
    '`ALTER SCHEMA "<current name>" RENAME TO <ascii_name>;` and then set that name in DATABASE_URL. ' +
    'A positive answer is bound to the BACKEND that gave it, and stays bound to it: the probe grants ' +
    'nothing unless every connection it opens to this endpoint is served by the same PostgreSQL, and ' +
    'every connection the application pool then opens is checked against that same backend before it ' +
    'may run a query — because a pooler, a load balancer or a failover pair can serve the probe from ' +
    'one server and the application pool from another. A connection that does not reach the backend ' +
    'DIRECTLY is refused outright: a transaction- or statement-pooling proxy re-assigns the server ' +
    'side between units of work, and measured against PgBouncer 1.24.1 a startup options= is either ' +
    'rejected by the pooler or silently discarded, so a schema pinned this way never worked behind ' +
    'one. Connect the application to the backend directly, or rename the schema to ASCII. ' +
    `Here the answer could not be established — ${verdict.reason}.${measured}`
  )
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
    //
    // ROUND 19 ADDS THE ONE THING THAT CAN LIFT IT, and it is not a spelling and not a setting: a
    // MEASUREMENT of this deployment. `nonAsciiOptionByteIsCarried()` is true only for characters
    // a probe has round-tripped through this very server intact — see
    // `establishStartupOptionByteSafety()`. Where nothing has been measured the refusal is exactly
    // round 18's, and it now says what to do about it.
    if (NON_ASCII_OPTION_CHARACTER.test(character) && !nonAsciiOptionByteIsCarried(character)) {
      throw nonAsciiRefusal(
        character,
        `${escaped ? 'DATABASE_URL sets options= containing a backslash-escaped' : 'DATABASE_URL sets options= containing'}`,
        'Escaping it does not help and is refused for the same reason.',
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
  //
  // "FROM HERE" IS THE WHOLE OF IT, AND ROUND 19 GIVES IT SOMEWHERE ELSE TO ASK (Codex HIGH).
  // Round 18 rejected every non-ASCII name before inspecting the deployment, including quoted
  // names the live test proves work on this server and installations `docs/installation.md` had
  // told to spell them that way — and left them with no accepted DATABASE_URL at all, since the
  // adapter is constructed at import. The boundary is a fact about the server's encoding and
  // LC_CTYPE, so the server is asked: where `establishStartupOptionByteSafety()` has measured
  // these characters surviving intact, the name is carried; where it could not be established the
  // refusal stands and names both ways out of it.
  for (const character of named ?? '') {
    if (NON_ASCII_OPTION_CHARACTER.test(character) && !nonAsciiOptionByteIsCarried(character, databaseUrl)) {
      throw nonAsciiRefusal(
        character,
        'DATABASE_URL sets ?schema= to a name containing',
        'The pin this module composes for it goes into that same startup `options`, so there is no spelling ' +
          'of it — quoted or escaped — whose token boundaries are knowable FROM HERE.',
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

/* ----------------------------------------------------------------------------------------------
 * WHERE A VERDICT IS SPENT, AND WHY THAT IS NOT WHERE IT WAS GRANTED (o3d-2k5r r22, Codex HIGH).
 *
 * Round 21 bound a positive verdict to the BACKEND that answered it and then handed the permission
 * out by logical target anyway. Three probe connections agreeing is evidence of one backend, never
 * a census of one: over two equally-selected members all three land on the same one 12.5% of boots,
 * and sticky or weighted routing makes it far likelier than that. The application pool then opens
 * its own connections, and nothing downstream ever compared who served them against who was
 * measured. That is endpoint-wide licensing again, only quieter.
 *
 * THE OBJECTION ROUND 21 RAISED WAS RIGHT ABOUT THE WRONG PLACE. Nothing reachable from a
 * SYNCHRONOUS `pgConnectionConfig()` can know which backend a future connection lands on — but the
 * authorisation does not have to happen there. `pg-pool` (3.13.0, the copy `pg` 8.20.0 vendors)
 * awaits an `onConnect(client)` hook for EVERY NEW PHYSICAL CONNECTION, after the socket is up and
 * BEFORE the client is handed to whoever asked for it; a rejection ends that client, removes it
 * from the pool's roster and fails the acquisition. That is config time producing a function and
 * CONNECT time running it, which is the only moment the fact is knowable.
 *
 * MEASURED, NOT ASSUMED, against the installed packages:
 *   • `onConnect` fires once per NEW physical connection and not on a reuse (2 fires for two
 *     clients plus one checkout of a released one).
 *   • The order is `onConnect` -> the pool's own `connect` event -> the acquirer gets the client.
 *     The pool's `connect` EVENT is not usable for this: it is emitted synchronously and nothing
 *     awaits or can veto it, which is why the hook and not the event carries the check.
 *   • A rejecting hook leaves `pool.totalCount === 0`, rejects `pool.connect()` and rejects
 *     `pool.query()` with the hook's own error.
 *   • `PrismaPg`'s config form passes the config VERBATIM to `new pg.Pool(...)`
 *     (`@prisma/adapter-pg` 7.7.0, `connect()`), so the hook reaches the runtime adapter and a
 *     rejection surfaces out of `queryRaw`.
 *
 * IT IS ATTACHED ONLY WHERE A LICENCE IS BEING SPENT. An `options` made of ASCII needs no verdict,
 * so it gets no hook and no extra round trip: the cost of this is exactly zero for every
 * deployment whose schema name is ASCII. Where the emitted `options` DOES carry a non-ASCII byte,
 * every new physical connection pays one round trip — at most `DB_POOL_MAX` of them for a pool at
 * full stretch, plus one per replacement connection, and none per query.
 *
 * IT CHECKS TWO THINGS, AND THE SECOND IS THE HARM ITSELF. The identity says the connection
 * reached the server the verdict is about. The `search_path` says the bytes actually arrived as
 * written — a backend that split the option either refuses the startup outright (a loud failure
 * that never reaches here) or accepts it having tokenised it differently, and THAT is the silent
 * cross-schema access the whole module exists to stop. Measured against PostgreSQL 17.11,
 * `current_setting('search_path')` reports the pin with libpq's escapes already consumed and the
 * identifier quoting intact, so the comparison is against the pin's unescaped spelling.
 * -------------------------------------------------------------------------------------------- */

/**
 * The `onConnect` hook that holds a spent verdict to the backend it was earned on, or `undefined`
 * when this connection carries no licensed bytes and so needs no hook.
 *
 * @param {string} options the startup options this config will send
 * @param {string} expectedSearchPath the `search_path` value the pin puts on the wire, unescaped
 * @param {string | null} target the host/port/database this config connects to
 * @returns {((client: { query(text: string): Promise<{ rows: Array<Record<string, unknown>> }> }) => Promise<void>) | undefined}
 */
function startupOptionBackendGuard(options, expectedSearchPath, target) {
  if (!NON_ASCII_OPTION_CHARACTER.test(options)) return undefined
  return async (client) => {
    // READ AT CONNECT TIME, NOT CAPTURED AT CONFIG TIME. A verdict that has since been reset, or
    // re-established against a different server, must govern the connections opened after it —
    // and a config object built before the probe ran must not carry a stale permission forward.
    const verdict = heldStartupOptionByteVerdict()
    const refuse = (detail) => {
      throw new DatabaseUrlSchemaConflictError(
        `This connection carries a non-ASCII startup option, which is only permitted on the ONE ` +
          `PostgreSQL backend the deployment probe measured. ${detail} The connection is refused before it ` +
          `can run a query, because a startup option whose token boundaries were measured on another ` +
          `server may resolve a different schema on this one — the split this gate exists to stop ` +
          `(o3d-1izw / o3d-2k5r). ${nonAsciiUpgradePath()}`,
      )
    }
    if (!verdict.established || !verdict.carries || verdict.backend === null || verdict.backend === '') {
      refuse('No positive verdict naming a backend is held by this process.')
    }
    if (verdict.target !== null && target !== null && verdict.target !== target) {
      refuse(`The held verdict is about ${verdict.target}, and this connection is to ${target}.`)
    }
    const { rows } = await client.query(SERVED_CONNECTION_SQL)
    const row = rows[0] ?? {}
    const served = backendIdentityOf(row)
    if (served !== verdict.backend) {
      refuse(
        `This connection was served by ${JSON.stringify(served)} and the verdict was measured on ` +
          `${JSON.stringify(verdict.backend)}, so the endpoint handed the application a different backend ` +
          `from the one that answered the probe.`,
      )
    }
    // NOTHING MAY SIT BETWEEN THIS SOCKET AND THAT BACKEND (o3d-2k5r r23, Codex HIGH). The two
    // checks around this one are both readings taken at connect time; they are only worth anything
    // if the connection cannot be handed to a different backend afterwards, which is exactly what a
    // transaction- or statement-pooling proxy does. See the block over
    // `interposedConnectionRefusal()` for what this keys on and what it measurably costs.
    const interposed = interposedConnectionRefusal(client, row)
    if (interposed !== null) refuse(interposed)
    const searchPath = String(row.search_path ?? '')
    if (searchPath !== expectedSearchPath) {
      refuse(
        `This connection was served by the measured backend, but its search_path came back as ` +
          `${JSON.stringify(searchPath)} where ${JSON.stringify(expectedSearchPath)} was written — the startup ` +
          `option did not survive this server's tokenizer.`,
      )
    }
  }
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
 * IT ALSO RETURNS AN `onConnect` HOOK, and only when the composed `options` carries a non-ASCII
 * byte. That is the half of the deployment verdict that cannot be decided here: this function is
 * synchronous and the pool has not connected, so which backend the connection reaches is not
 * knowable until it has. `pg-pool` awaits the hook per NEW PHYSICAL CONNECTION and a rejection
 * fails that acquisition, so the permission a probe earned on one server is held to that server.
 * See `startupOptionBackendGuard()` for what it checks and what it costs.
 *
 * @param {string | undefined | null} databaseUrl
 * @returns {{ connectionString: string, options?: string, onConnect?: (client: { query(text: string): Promise<{ rows: Array<Record<string, unknown>> }> }) => Promise<void> }}
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
  const pinned = `"${schema.replace(/"/g, '""')}"`
  const pin = `-c search_path=${escapeLibpqValue(pinned)}`
  const options = [...carried, pin].join(' ')

  // WHAT ENFORCES THE VERDICT ON THE CONNECTIONS THIS CONFIG ACTUALLY OPENS (o3d-2k5r r22).
  // `undefined` for an all-ASCII `options`, which needs no verdict and so pays nothing. See the
  // block comment over `startupOptionBackendGuard()`.
  const onConnect = startupOptionBackendGuard(options, pinned, connectionTarget(connectionString))

  // The URL must no longer carry an `options` of its own, or pg's own parse would put it back over
  // the one composed here.
  url.searchParams.delete('options')
  return onConnect
    ? { connectionString: url.toString(), options, onConnect }
    : { connectionString: url.toString(), options }
}

/**
 * The only shape `pinClientToMeasuredBackend()` needs of the client it wraps.
 *
 * @typedef {object} ConnectableClient
 * @property {(...args: unknown[]) => Promise<unknown>} connect
 * @property {(text: string) => Promise<{ rows: Array<Record<string, unknown>> }>} query
 * @property {(() => unknown) | undefined} [end]
 */

/**
 * THE SAME GUARD FOR A RAW `pg.Client`, WHICH HAS NO `onConnect` OF ITS OWN (o3d-2k5r r22).
 *
 * `pg-pool` awaits `onConnect` per physical connection, so `lib/db/index.ts`, `prisma/seed.ts` and
 * `scripts/check-stock-quantity-constraints.mjs` — all of which hand this config to a Pool, directly
 * or through `PrismaPg` — are covered by returning it. `pg.Client` has no such hook, and THREE
 * out-of-process gates use one: `scripts/check-wms-push-state-enum.mjs`, `lib/ops/production-preflight`
 * and `scripts/provision-instance.mjs`. A gate that reads its catalogue from a backend the verdict
 * is not about is the same defect wearing a different hat — it vouches for the wrong server, which
 * is exactly the green-gate/failed-write split (o3d-1izw) these gates exist to prevent.
 *
 * IT WRAPS `connect()` RATHER THAN ASKING EACH CALL SITE TO REMEMBER. Three call sites that must
 * each call a checker is three chances to forget one, and a forgotten one is silent. Wrapping the
 * method means the guard runs on whatever `connect()` those sites already call, and a future gate
 * that builds its client the same way inherits it. On refusal the client is ENDED before the error
 * is rethrown, so a refused gate leaves no socket behind.
 *
 * The client is returned UNCHANGED when the config carries no guard, which is every ASCII
 * deployment — see `startupOptionBackendGuard()` for why.
 *
 * The CALLBACK form of `connect()` is refused outright rather than half-guarded: none of the three
 * call sites uses it, and a guard that silently does nothing on one of two shapes is worse than
 * one that says so.
 *
 * The client keeps its own type: the wrap is done through a narrow structural view of it, so a
 * `pg.Client` goes in and a `pg.Client` — overloads, generics and all — comes back out.
 *
 * @template TClient
 * @param {TClient} client
 * @param {{ onConnect?: (client: { query(text: string): Promise<{ rows: Array<Record<string, unknown>> }> }) => Promise<void> }} config the config the client was built from
 * @returns {TClient} the same client
 */
export function pinClientToMeasuredBackend(client, config) {
  const guard = config.onConnect
  if (!guard) return client
  const connectable = /** @type {ConnectableClient} */ (/** @type {unknown} */ (client))
  const connect = connectable.connect.bind(connectable)
  connectable.connect = async (...args) => {
    if (args.length > 0) {
      throw new DatabaseUrlSchemaConflictError(
        'connect(callback) is not supported on a client whose startup options carry a non-ASCII byte: the ' +
          'per-connection backend check (o3d-2k5r r22) cannot be run between the callback firing and the ' +
          'caller using the connection. Use the promise form.',
      )
    }
    const result = await connect()
    try {
      await guard(connectable)
    } catch (error) {
      await Promise.resolve(connectable.end?.()).catch(() => undefined)
      throw error
    }
    return result
  }
  return client
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
