import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test, { type TestContext } from 'node:test'

import { parse as parseDotenv } from 'dotenv'
import pg from 'pg'

import {
  DatabaseUrlSchemaConflictError,
  pgConnectionConfig,
  prismaAdapterSchemaOptions,
  resolveDatabaseUrlSchema,
  splitLibpqOptions,
} from '../../lib/db/database-url-schema.mjs'
import { provisioningClient, seedSetting } from '../../scripts/provision-instance.mjs'

/**
 * o3d-2k5r r12 — THE TWO THINGS THAT DECIDE WHICH SCHEMA A WRITE LANDS IN, ASKED OF A REAL SERVER.
 *
 * Every earlier round of this branch measured the connection STRING: what `pgConnectionConfig()`
 * composed, or what `pg` would put in the startup packet. That is one step short of the question,
 * and the shortfall is exactly where round 12's two findings lived:
 *
 *   * A TAB is as legal a separator in a startup `options` as a space — the backend splits on
 *     `isspace()` in `pg_split_opts()` — and the parser here knew only the space. The emitted
 *     string then contained the operator's own `-c<TAB>search_path=TenantA` AND a `-c
 *     search_path="public"` appended after it. Both are applied and the last wins, so a string
 *     test sees the operator's schema in there and calls it aligned while the SERVER is on
 *     `public`. Only `current_schema()` can tell those apart.
 *   * A writer built straight from `DATABASE_URL` gets no search path at all, because `?schema=`
 *     is a Prisma-only parameter that node-postgres discards. Nothing about the string it was
 *     handed reveals that; only the row's actual schema does.
 *
 * So the live tests below CREATE A THROWAWAY DATABASE, put a table in two schemas of it, write
 * through the real clients and ask the catalogue where the row went. They skip when no PostgreSQL
 * is reachable; the pure tests above them always run.
 */

// ---------------------------------------------------------------------------
// Pure: the tokenizer, with no server involved.
// ---------------------------------------------------------------------------

test('o3d-2k5r r12: a TAB separates a startup option exactly as a space does', () => {
  // ROUTE: DATABASE_URL `?options=` -> splitLibpqOptions() -> readLibpqSettings() -> the
  // `search_path` entry -> resolveDatabaseUrlSchema().schema -> the pin pgConnectionConfig()
  // emits and the `{ schema }` the Prisma adapter is given.
  //
  // MUTATION: put `LIBPQ_OPTION_SEPARATORS` back to `new Set([' '])` (or restore the old
  // `character === ' '` test). `-c\tsearch_path=TenantA` becomes ONE unrecognised token, the
  // schema falls back to PRISMA_DEFAULT_SCHEMA, and every assertion in this test fails on
  // `public` — which is the retargeting, in the smallest form it can be stated.
  const separators: [string, string][] = [
    ['space', ' '],
    ['tab', '\t'],
    ['newline', '\n'],
    ['carriage return', '\r'],
    ['form feed', '\f'],
    ['vertical tab', '\v'],
  ]
  for (const [name, separator] of separators) {
    const url = `postgresql://u:p@localhost:5432/ims?options=${encodeURIComponent(`-c${separator}search_path=TenantA`)}`
    assert.deepEqual(
      resolveDatabaseUrlSchema(url),
      { parsed: true, explicit: true, schema: 'tenanta' },
      `${name} is a separator the server splits on, so the schema it names is read`,
    )
    assert.equal(
      pgConnectionConfig(url).options,
      '-c search_path="tenanta"',
      `${name}: the pin is the schema the URL named, not the default appended after it`,
    )
  }

  // AND THE SETTINGS AROUND IT SURVIVE, whatever separated them. A tokenizer that split on the
  // space alone did not merely misread `search_path` — it swallowed `statement_timeout` into the
  // same token and dropped it, so the connection lost a timeout it was told to have.
  assert.equal(
    pgConnectionConfig(
      `postgresql://u:p@localhost:5432/ims?options=${encodeURIComponent('-c statement_timeout=5000\t-c search_path=tenanta\n-c lock_timeout=2000')}`,
    ).options,
    '-c statement_timeout=5000 -c lock_timeout=2000 -c search_path="tenanta"',
  )

  // The separators are interchangeable to the backend, so the tokens come back the same from all
  // of them — which is what makes re-joining them with a single space an equivalent string.
  assert.deepEqual(splitLibpqOptions('-c\tsearch_path=a'), ['-c', 'search_path=a'])
  assert.deepEqual(splitLibpqOptions('-c search_path=a'), ['-c', 'search_path=a'])
  // ESCAPED whitespace is still a literal, on both sides. `pg_split_opts()` drops the backslash and
  // keeps the character, and so does this — one token, not two.
  assert.deepEqual(splitLibpqOptions('-c application_name=my\\\tapp'), ['-c', 'application_name=my\\\tapp'])
})

test('o3d-2k5r r12: whitespace outside ASCII is refused rather than guessed at', () => {
  // ROUTE: the same tokenizer. `isspace()` is asked ONE BYTE AT A TIME by the backend, so whether
  // U+00A0 ends a token depends on the database's encoding and locale — in a UTF-8 database its
  // bytes are ordinary characters, in a single-byte encoding under some locales it may split. The
  // token boundaries decide which schema is pinned, so an unknowable reading is refused, exactly
  // as a non-ASCII unquoted identifier already is.
  //
  // MUTATION: delete the NON_ASCII_WHITESPACE branch from splitLibpqOptions(). The URL below then
  // resolves silently to a schema named `search_path=tenant` on one server and pins `public` on
  // another, and this test fails on `assert.throws`.
  assert.throws(
    () => pgConnectionConfig(`postgresql://u:p@localhost:5432/ims?options=${encodeURIComponent('-c search_path=tenanta')}`),
    (error: unknown) => {
      assert.ok(error instanceof DatabaseUrlSchemaConflictError)
      assert.match((error as Error).message, /U\+00A0/)
      return true
    },
  )
  // Escaped, it is a literal and therefore unambiguous on both sides — so it is NOT refused.
  assert.deepEqual(splitLibpqOptions('-c\\ x=1'), ['-c\\ x=1'])
})

/**
 * THE SIX CHARACTERS THE BACKEND SPLITS A STARTUP `options` ON, named once for every test below.
 *
 * `pg_split_opts()` tests `isspace((unsigned char) *optstr)`, which in the C locale is exactly
 * these. Round 12 taught the READER all six; round 13 is about the WRITER agreeing.
 */
const BACKEND_SEPARATORS: [string, string][] = [
  ['space', ' '],
  ['tab', '\t'],
  ['newline', '\n'],
  ['carriage return', '\r'],
  ['form feed', '\f'],
  ['vertical tab', '\v'],
]

/** A schema name carrying every one of them at once. */
const ALL_SEPARATORS_SCHEMA = BACKEND_SEPARATORS.map(([, separator], index) => `t${index}${separator}`).join('') + 'end'

test('o3d-2k5r r13: a schema name containing any backend separator survives emit -> read unchanged', () => {
  // ROUTE: `?schema=<name>` -> resolveDatabaseUrlSchema().schema -> pgConnectionConfig() ->
  // escapeLibpqValue() -> the `options` string in the startup packet -> splitLibpqOptions() ->
  // readLibpqSettings() -> singleSchemaOfSearchPath() -> the schema again. This is the ROUND TRIP:
  // it makes the emitter and the tokenizer check each other instead of each being checked against
  // a hand-written expectation that can drift with them.
  //
  // MUTATION: put the emitter back to `String(value).replace(/([\\ ])/g, '\\$1')` — the exact
  // space-only escape this round replaces. Every non-space case below then fails twice over: the
  // token count assertion sees 3+ tokens where the backend would have split the name in half, and
  // the re-read comes back as a different schema (or throws on the unterminated quote). The space
  // case still passes, which is precisely why a list-shaped test missed this for four rounds.
  for (const [label, separator] of [...BACKEND_SEPARATORS, ['all six', null] as [string, null]]) {
    const schema = separator === null ? ALL_SEPARATORS_SCHEMA : `ten${separator}ant`
    const emitted = pgConnectionConfig(`postgresql://u:p@localhost:5432/ims?schema=${encodeURIComponent(schema)}`)
    assert.ok(emitted.options, `${label}: a parseable URL always yields a pin`)

    // PRECONDITION, so this test cannot pass by examining nothing: the name really does contain a
    // separator, and the emitted string really does contain it escaped rather than dropped.
    if (separator !== null) assert.ok(schema.includes(separator), `${label}: the name under test carries the separator`)
    assert.ok(emitted.options!.includes('\\'), `${label}: the emitter escaped something`)

    // THE BACKEND'S OWN SPLIT: two tokens, `-c` and the whole setting. Three would mean the server
    // is being handed a search path cut through the middle of the schema name.
    assert.deepEqual(
      splitLibpqOptions(emitted.options!).length,
      2,
      `${label}: the backend splits the pin into exactly -c and one setting, not through the name`,
    )

    // AND BACK: read the emitted options as a URL parameter, exactly as the driver would receive it.
    const roundTrip = new URL('postgresql://u:p@localhost:5432/ims')
    roundTrip.searchParams.set('options', emitted.options!)
    assert.deepEqual(
      resolveDatabaseUrlSchema(roundTrip.toString()),
      { parsed: true, explicit: true, schema },
      `${label}: the schema read back out of the pin is the schema that went into it`,
    )

    // AND IT IS STABLE: emitting what was just read produces the same string. A round trip that
    // loses nothing but changes the spelling every pass would still let the two halves drift.
    assert.equal(
      pgConnectionConfig(roundTrip.toString()).options,
      emitted.options,
      `${label}: the pg-native spelling re-emits to itself`,
    )
  }
})

test('o3d-2k5r r13: whitespace the tokenizer refuses is escaped by the emitter, not written raw', () => {
  // ROUTE: `?schema=` carrying U+00A0 -> pgConnectionConfig() -> escapeLibpqValue() -> the pin ->
  // splitLibpqOptions(), which REFUSES an unescaped U+00A0 because whether the backend splits on
  // it depends on the database's encoding and locale.
  //
  // MUTATION: narrow the emitter's character class to the six ASCII separators
  // (`/[\\ \t\n\v\f\r]/g`). The pin below is then emitted with a bare U+00A0 in it, and the
  // re-read throws DatabaseUrlSchemaConflictError instead of returning the name — a string this
  // module emits and then cannot read. Both assertions after the emit fail.
  const schema = 'ten\u00A0ant' // U+00A0, written as an escape so it cannot be mistaken for a space
  const emitted = pgConnectionConfig(`postgresql://u:p@localhost:5432/ims?schema=${encodeURIComponent(schema)}`)
  assert.equal(
    emitted.options,
    '-c search_path="ten\\\u00A0ant"',
    'the ambiguous character is escaped, so it is a literal on both sides',
  )

  const roundTrip = new URL('postgresql://u:p@localhost:5432/ims')
  roundTrip.searchParams.set('options', emitted.options!)
  assert.deepEqual(resolveDatabaseUrlSchema(roundTrip.toString()), { parsed: true, explicit: true, schema })
})

/**
 * WHITESPACE THE SERVER DOES NOT STRIP FROM A `search_path` VALUE, named once for both tests below.
 *
 * `SplitIdentifierString()` trims each element with `scanner_isspace()`, which is a FIXED list.
 * Every character here is whitespace to JavaScript — `trim()` removes all four — and an ordinary
 * character to PostgreSQL, which keeps it inside the identifier. Measured on the installed server
 * by the live test at the bottom of this file, so this list is not a claim taken on trust.
 */
const KEPT_BY_THE_SERVER: [string, string][] = [
  ['U+00A0 no-break space', '\u00A0'],
  ['U+2007 figure space', '\u2007'],
  ['U+2028 line separator', '\u2028'],
  ['U+FEFF zero-width no-break space', '\uFEFF'],
]

/** The URL an operator writes when they mean that character literally: escaped, inside `options=`. */
function urlWithSearchPath(value: string): string {
  const url = new URL('postgresql://u:p@localhost:5432/ims')
  url.searchParams.set('options', `-c search_path=${value.replace(/[\\\s]/gu, '\\$&')}`)
  return url.toString()
}

test('o3d-2k5r r15: the six ASCII scanner whitespace characters are trimmed off a search path', () => {
  // ROUTE: DATABASE_URL `?options=-c search_path=\<ws>tenant` -> splitLibpqOptions() (the escape is
  // why the character survives tokenizing) -> unescapeLibpq() -> singleSchemaOfSearchPath()'s trim
  // -> foldUnquotedIdentifier() -> the schema pinned and compared against `?schema=`. This is the
  // half of the rule that must KEEP working: PostgreSQL really does strip these, so stripping them
  // here is agreement, not mutation.
  //
  // MUTATION: empty `SCANNER_WHITESPACE` (or delete the two while-loops from
  // trimScannerWhitespace() so it returns `value` unchanged). ` tenant` then still carries a space,
  // the SCANNER_WHITESPACE guard in singleSchemaOfSearchPath() returns null, and every assertion
  // below throws "does not name exactly one schema" instead of resolving to `tenant`.
  for (const [label, whitespace] of BACKEND_SEPARATORS) {
    // PRECONDITION, so this cannot pass by examining nothing: the character really did reach the
    // trim rather than being eaten by the tokenizer, which is what the backslash is for.
    assert.deepEqual(
      splitLibpqOptions(`-c search_path=${whitespace.replace(/[\\\s]/gu, '\\$&')}tenant`).length,
      2,
      `${label}: escaped, it is part of the setting rather than a token boundary`,
    )
    for (const [position, value] of [
      ['leading', `${whitespace}tenant`],
      ['trailing', `tenant${whitespace}`],
      ['both ends', `${whitespace}tenant${whitespace}`],
    ] as [string, string][]) {
      assert.deepEqual(
        resolveDatabaseUrlSchema(urlWithSearchPath(value)),
        { parsed: true, explicit: true, schema: 'tenant' },
        `${label} ${position}: trimmed here because the server trims it there`,
      )
    }
  }
})

test('o3d-2k5r r15: non-ASCII whitespace at either end of a search path is NOT trimmed away', () => {
  // ROUTE: the same one — `?options=-c search_path=\<ws>tenant` -> splitLibpqOptions() ->
  // unescapeLibpq() -> singleSchemaOfSearchPath() -> foldUnquotedIdentifier() -> the pin. The
  // character is escaped, which is how this module has told operators since round 12 to mean an
  // ambiguous whitespace character literally, so it arrives at the trim intact.
  //
  // MUTATION: restore `const trimmed = String(value).trim()` in singleSchemaOfSearchPath().
  // JavaScript's trim is Unicode-wide, so `<U+00A0>tenant` is silently reduced to `tenant`, folds
  // cleanly, and resolveDatabaseUrlSchema() RETURNS `{ schema: 'tenant' }` — a schema the URL did
  // not name, pinned into the emitted options, handed to the Prisma adapter and reported aligned to
  // all three raw gates while the server resolves `<U+00A0>tenant`. Every assert.throws below fails,
  // and so does the last assertion, which is the same divergence stated as an equality: the URL
  // naming the character no longer agrees with `?schema=tenant`, and under the mutation it does.
  for (const [label, whitespace] of KEPT_BY_THE_SERVER) {
    // PRECONDITION: the character survives tokenizing, so what is being tested is the trim and not
    // the tokenizer's refusal of an UNESCAPED one.
    assert.deepEqual(
      splitLibpqOptions(`-c search_path=${whitespace.replace(/[\\\s]/gu, '\\$&')}tenant`).length,
      2,
      `${label}: escaped, it is part of the setting rather than a token boundary`,
    )
    // PRECONDITION: JavaScript really does consider it whitespace. Without this the test could pass
    // against a character `trim()` never touched, proving nothing about the finding.
    assert.equal(`${whitespace}tenant`.trim(), 'tenant', `${label}: JavaScript's trim would strip it`)

    for (const [position, value] of [
      ['leading', `${whitespace}tenant`],
      ['trailing', `tenant${whitespace}`],
    ] as [string, string][]) {
      assert.throws(
        () => resolveDatabaseUrlSchema(urlWithSearchPath(value)),
        (error: unknown) => {
          assert.ok(error instanceof DatabaseUrlSchemaConflictError, `${label} ${position}: refused, not resolved`)
          // The refusal has to be the RIGHT one: the value names exactly one schema, so "name one
          // schema" would be advice for a problem it does not have. What is actually wrong is that
          // this is an unquoted name whose fold depends on the database's encoding and collation.
          assert.match(
            error.message,
            /UNQUOTED identifier this cannot read/,
            `${label} ${position}: and refused as an unfoldable name, which tells the operator to quote it`,
          )
          return true
        },
      )
    }

    // AND THE FALSE AGREEMENT IS GONE. `?schema=tenant` and an options value naming
    // `<ws>tenant` are different schemas; under the mutation both read as `tenant` and this URL
    // resolved happily instead of being refused.
    const both = new URL(urlWithSearchPath(`${whitespace}tenant`))
    both.searchParams.set('schema', 'tenant')
    assert.throws(() => resolveDatabaseUrlSchema(both.toString()), DatabaseUrlSchemaConflictError, label)
  }
})

test('o3d-2k5r r15: QUOTED, the same character is a name this module pins rather than refuses', () => {
  // ROUTE: `?schema=<ws>tenant` -> pgConnectionConfig() -> escapeLibpqValue() -> the always-quoted
  // pin -> back in through `?options=` -> splitLibpqOptions() -> singleSchemaOfSearchPath()'s
  // QUOTED branch -> the schema again. The refusal above is a routing decision about an UNQUOTED
  // name, not an inability to carry the character: quoted, it round-trips whole.
  //
  // MUTATION: apply `.trim()` to the quoted branch's captured group — the same Unicode trim this
  // round removed, one line lower — and the character is dropped from the name read back, so the
  // round-trip assertion sees `tenant`. Narrowing escapeLibpqValue() to `/[\\ \t\n\v\f\r]/g`
  // fails it too, by a different route: the pin is then emitted with the character BARE and
  // splitLibpqOptions() refuses this module's own output. Note that trimScannerWhitespace() applied
  // to the same capture does NOT fail this test, and should not — it strips six ASCII characters,
  // none of which is under test here.
  for (const [label, whitespace] of KEPT_BY_THE_SERVER) {
    for (const [position, schema] of [
      ['leading', `${whitespace}tenant`],
      ['trailing', `tenant${whitespace}`],
    ] as [string, string][]) {
      const emitted = pgConnectionConfig(
        `postgresql://u:p@localhost:5432/ims?schema=${encodeURIComponent(schema)}`,
      )
      assert.ok(emitted.options, `${label} ${position}: a parseable URL always yields a pin`)
      assert.ok(
        emitted.options!.includes(`\\${whitespace}`),
        `${label} ${position}: the character is escaped in the pin, not written raw`,
      )
      const roundTrip = new URL('postgresql://u:p@localhost:5432/ims')
      roundTrip.searchParams.set('options', emitted.options!)
      assert.deepEqual(
        resolveDatabaseUrlSchema(roundTrip.toString()),
        { parsed: true, explicit: true, schema },
        `${label} ${position}: the quoted name read back is the name that went in, character and all`,
      )
    }
  }
})

/**
 * EVERY WAY A STARTUP `options` CAN ASSIGN A GUC, which is every spelling `ParseLongOption()` sees.
 *
 * `process_postgres_switches()` runs getopt over the split tokens with `"...c:...-:"`, so `-c x=y`
 * (separated), `-cx=y` (attached) and `--x=y` (long) all arrive at the same normaliser. A reader
 * that understands one spelling and not the others is reading a different startup line from the
 * one the server reads.
 */
const GUC_SPELLINGS: [string, (setting: string) => string][] = [
  ['separated -c', (setting) => `-c ${setting}`],
  ['attached -c', (setting) => `-c${setting}`],
  ['long option', (setting) => `--${setting}`],
]

test('o3d-2k5r r14: a hyphen in a GUC NAME is an underscore to PostgreSQL, so it is here too', () => {
  // ROUTE: DATABASE_URL `?options=-c search-path=Tenant_A` -> splitLibpqOptions() ->
  // readLibpqSettings() -> canonicalGucName() -> the `search_path` entry ->
  // resolveDatabaseUrlSchema().schema -> BOTH the `{ schema }` the Prisma adapter is given and the
  // pin pgConnectionConfig() puts in the startup packet.
  //
  // MUTATION: delete `.replace(/-/g, '_')` from canonicalGucName(). Each spelling below is then
  // read as an unrelated setting: resolveDatabaseUrlSchema() returns
  // `{ parsed: true, explicit: false, schema: 'public' }` and the emitted options become
  // `-c search-path=Tenant_A -c search_path="public"` — the operator's own pin carried through and
  // then OVERRIDDEN by the appended default, which is the silent retargeting itself. The deepEqual,
  // the equivalence assertion, the options assertion and the conflict assertion all fail.
  for (const [label, spell] of GUC_SPELLINGS) {
    const hyphenated = `postgresql://u:p@localhost:5432/ims?options=${encodeURIComponent(spell('search-path=Tenant_A'))}`
    const underscored = `postgresql://u:p@localhost:5432/ims?options=${encodeURIComponent(spell('search_path=Tenant_A'))}`

    // PRECONDITION, so this cannot pass by examining nothing: the URL under test really is written
    // with a hyphen, and the underscored URL it is compared against really is not.
    assert.ok(decodeURIComponent(hyphenated).includes('search-path='), `${label}: the URL under test is hyphenated`)
    assert.ok(!decodeURIComponent(underscored).includes('search-path='), `${label}: its control is not`)

    assert.deepEqual(
      resolveDatabaseUrlSchema(hyphenated),
      { parsed: true, explicit: true, schema: 'tenant_a' },
      `${label}: the hyphenated spelling names the schema, folded as the server folds it`,
    )
    assert.deepEqual(
      resolveDatabaseUrlSchema(hyphenated),
      resolveDatabaseUrlSchema(underscored),
      `${label}: and it is THE SAME setting as the underscored spelling, not a second, unrelated one`,
    )
    assert.equal(
      pgConnectionConfig(hyphenated).options,
      '-c search_path="tenant_a"',
      `${label}: so the pin is the schema the URL named, with nothing carried through ahead to be overridden`,
    )

    // AND IT PARTICIPATES IN THE CROSS-CHECK. A spelling the reader does not recognise cannot
    // disagree with `?schema=`, so the disagreement this module exists to refuse became silent
    // agreement on whichever schema `?schema=` named.
    assert.throws(
      () =>
        pgConnectionConfig(
          `postgresql://u:p@localhost:5432/ims?schema=other&options=${encodeURIComponent(spell('search-path=tenant_a'))}`,
        ),
      DatabaseUrlSchemaConflictError,
      `${label}: a hyphenated search path that disagrees with ?schema= is refused, not ignored`,
    )
  }

  // MIXED CASE AND HYPHENS AT ONCE, because the backend applies both normalisations:
  // `guc_name_compare()` folds A-Z and `ParseLongOption()` rewrites `-` to `_`.
  assert.deepEqual(
    resolveDatabaseUrlSchema(
      `postgresql://u:p@localhost:5432/ims?options=${encodeURIComponent('-c Search-Path=Tenant_A')}`,
    ),
    { parsed: true, explicit: true, schema: 'tenant_a' },
  )

  // THE NAME ONLY. `ParseLongOption()` rewrites the characters of the name and never touches the
  // value, so a schema whose own name contains a hyphen keeps it.
  // MUTATION: canonicalise the whole `name=value` setting instead of the name, and this returns
  // `tenant_a` for a schema called `tenant-a` — a pin onto a schema that may not exist.
  assert.deepEqual(
    resolveDatabaseUrlSchema(
      `postgresql://u:p@localhost:5432/ims?options=${encodeURIComponent('-c search-path="tenant-a"')}`,
    ),
    { parsed: true, explicit: true, schema: 'tenant-a' },
  )

  // AND EVERY OTHER SETTING IS STILL CARRIED THROUGH IN THE TOKENS IT WAS WRITTEN AS. Recognising
  // a name for the purpose of finding `search_path` must not rewrite what reaches the backend:
  // `application-name` is the server's business to normalise, not this module's to edit.
  assert.equal(
    pgConnectionConfig(
      `postgresql://u:p@localhost:5432/ims?options=${encodeURIComponent('-c application-name=my-app -c search-path=tenant_a')}`,
    ).options,
    '-c application-name=my-app -c search_path="tenant_a"',
  )
})

test('o3d-2k5r r14: U+0000 is refused, because no startup packet can carry one', () => {
  // ROUTE: `?schema=` / `?options=` -> resolveDatabaseUrlSchema() / splitLibpqOptions() ->
  // pgConnectionConfig() -> pg's startup-packet serialiser, which writes each parameter as a
  // NUL-TERMINATED C string. Measured against the installed pg and a real PostgreSQL, a NUL
  // anywhere in `options` does not mis-resolve the schema — the connection is REFUSED with
  // `invalid startup packet layout: expected terminator as last byte`. The module's own reader,
  // meanwhile, round-tripped the name intact, so this was a value the emitter accepted, claimed to
  // have round-tripped, and the server could never receive. No PostgreSQL identifier may contain
  // U+0000 either, so there is no schema of that name to reach in the first place.
  //
  // MUTATION: delete the U+0000 branch from splitLibpqOptions() and the `named.includes(NUL)`
  // branch from resolveDatabaseUrlSchema(). Every assert.throws below fails; `?schema=ten<NUL>ant`
  // then emits `-c search_path="ten<NUL>ant"` and reads back as `ten<NUL>ant`, a self-consistent
  // round trip of a string no connection can be opened with.
  const NUL = String.fromCharCode(0)
  const cases: [string, string][] = [
    ['?schema=', `postgresql://u:p@localhost:5432/ims?schema=${encodeURIComponent(`ten${NUL}ant`)}`],
    [
      'an unquoted search path',
      `postgresql://u:p@localhost:5432/ims?options=${encodeURIComponent(`-c search_path=ten${NUL}ant`)}`,
    ],
    [
      'a quoted search path',
      `postgresql://u:p@localhost:5432/ims?options=${encodeURIComponent(`-c search_path="ten${NUL}ant"`)}`,
    ],
    [
      'an ESCAPED NUL, which the splitter unescapes back into the value',
      `postgresql://u:p@localhost:5432/ims?options=${encodeURIComponent(`-c search_path=ten\\${NUL}ant`)}`,
    ],
    [
      'a startup option that is not the search path at all',
      `postgresql://u:p@localhost:5432/ims?options=${encodeURIComponent(`-c application_name=my${NUL}app`)}`,
    ],
  ]
  for (const [label, url] of cases) {
    // PRECONDITION: the URL really does carry a NUL after URL parsing — `%00` survives
    // URLSearchParams — so the refusal below is caused by the NUL and not by the syntax around it.
    const parameters = new URL(url).searchParams
    assert.ok(
      (parameters.get('schema') ?? parameters.get('options') ?? '').includes(NUL),
      `${label}: the parsed URL really carries a NUL`,
    )
    assert.throws(
      () => pgConnectionConfig(url),
      (error: unknown) => {
        assert.ok(error instanceof DatabaseUrlSchemaConflictError, `${label}: refused as a schema conflict`)
        assert.match((error as Error).message, /U\+0000/, `${label}: and the message names the character`)
        return true
      },
      `${label}: is refused`,
    )
    // AND THE SAME URL WITHOUT THE NUL IS ACCEPTED, so the guard is not refusing the shape.
    assert.ok(pgConnectionConfig(url.replaceAll('%00', '')).options, `${label}: the NUL-free spelling still resolves`)
  }
})

test('o3d-2k5r r16: a search path naming a ZERO-LENGTH schema is refused by both readers', () => {
  // ROUTE: DATABASE_URL `?options=-c search_path=""` -> splitLibpqOptions() -> readLibpqSettings()
  // -> singleSchemaOfSearchPath()'s QUOTED branch -> searchPathSchemaOf() -> BOTH readers of the
  // resolution: resolveDatabaseUrlSchema() (and prismaAdapterSchemaOptions() through it) and
  // pgConnectionConfig(), which composes the startup packet.
  //
  // WHY IT IS A REFUSAL AND NOT A NAME: `""` is a legal search-path element and the server takes
  // it (measured live below — `current_schema()` comes back NULL), but no schema of that name can
  // exist. Read as `{ schema: '' }` it was worse than either: the value is FALSY, so
  // pgConnectionConfig() returned the URL untouched with the operator's own empty search path
  // still on it while prismaAdapterSchemaOptions() returned `undefined` and Prisma qualified its
  // generated queries with `public`. Raw statements resolve through nothing, generated ones write
  // into `public` — the split this gate exists to stop, from the one value that looks pinned.
  //
  // MUTATION: restore `if (quoted) return { schema: quoted[1].replace(/""/g, '"'), quoted: true }`
  // in singleSchemaOfSearchPath() — i.e. drop the `decoded === ''` rejection. Nothing throws any
  // more: every assert.throws below fails for the `""` spellings, and the two "what it would have
  // resolved to" assertions inside them are never reached. Deleting the zero-length branch in
  // searchPathSchemaOf() alone does NOT make the test pass either — the refusal still happens, but
  // the message match fails, which is the routing half of this fix.
  const empties: [string, string][] = [
    ['quoted empty', '""'],
    ['assigned nothing', ''],
    // ESCAPED whitespace, because a bare space would end the token at the splitter and never reach
    // the quoted branch at all: `\ ""\<TAB>` unescapes to ` ""<TAB>`, which trimScannerWhitespace()
    // trims back to the quoted-empty name.
    ['quoted empty, padded with escaped scanner whitespace', '\\ ""\\\t'],
  ]
  for (const [label, value] of empties) {
    for (const [spelling, write] of GUC_SPELLINGS) {
      const url = `postgresql://u:p@localhost:5432/ims?options=${encodeURIComponent(write(`search_path=${value}`))}`
      // PRECONDITION: the reader really does see a `search_path` entry here — so the refusal below
      // is this guard firing and not the parameter being missed altogether.
      assert.equal(
        new URL(url).searchParams.get('options'),
        write(`search_path=${value}`),
        `${label} (${spelling}): the parsed URL carries the empty search path`,
      )
      for (const [reader, run] of [
        ['resolveDatabaseUrlSchema', () => resolveDatabaseUrlSchema(url)],
        ['prismaAdapterSchemaOptions', () => prismaAdapterSchemaOptions(url)],
        ['pgConnectionConfig', () => pgConnectionConfig(url)],
      ] as [string, () => unknown][]) {
        assert.throws(
          run,
          (error: unknown) => {
            assert.ok(
              error instanceof DatabaseUrlSchemaConflictError,
              `${label} (${spelling}, ${reader}): refused as a schema conflict`,
            )
            assert.match(
              (error as Error).message,
              /zero characters long/,
              `${label} (${spelling}, ${reader}): and the message says WHICH thing is wrong`,
            )
            return true
          },
          `${label} (${spelling}, ${reader}): is refused`,
        )
      }
    }
  }

  // AND A ONE-CHARACTER QUOTED NAME IS STILL CARRIED, so the guard is refusing emptiness and not
  // the quoted spelling: `""""` decodes to a single `"`, which is a nameable schema.
  const quotedName = `postgresql://u:p@localhost:5432/ims?options=${encodeURIComponent('-c search_path=""""')}`
  assert.deepEqual(
    resolveDatabaseUrlSchema(quotedName),
    { parsed: true, explicit: true, schema: '"' },
    'a quoted name of one character is still a schema',
  )
})

// ---------------------------------------------------------------------------
// Live: a throwaway database, and the schema the row actually landed in.
// ---------------------------------------------------------------------------

/** `DATABASE_URL` as the scripts see it — from the environment, else from the repo's own dotenv. */
function configuredDatabaseUrl(): string | null {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  for (const file of ['../../.env.local', '../../.env']) {
    try {
      const parsed = parseDotenv(readFileSync(new URL(file, import.meta.url)))
      if (parsed.DATABASE_URL) return parsed.DATABASE_URL
    } catch {
      // absent or unreadable: try the next one
    }
  }
  return null
}

type Scratch = {
  /** The throwaway database's own URL, with no query parameters of its own. */
  url: string
  /** A client connected to it with the default search path. */
  admin: pg.Client
  drop: () => Promise<void>
}

/**
 * A DATABASE of its own, not a schema of the developer's.
 *
 * The unpinned case has to land SOMEWHERE observable, and where it lands is the login role's
 * default search path — `public`. Probing that in the working database would write the test's rows
 * into the real `public.settings`, which is the one thing a test about writing into the wrong place
 * must not do. A throwaway database has an empty `public`, so the wrong answer is visible and
 * harmless.
 */
async function openScratch(t: TestContext): Promise<Scratch | null> {
  const base = configuredDatabaseUrl()
  if (!base) {
    t.skip('no DATABASE_URL configured; the live schema-pinning checks need a reachable PostgreSQL')
    return null
  }
  const name = `ims_pin_probe_${randomBytes(6).toString('hex')}`
  const bootstrap = new pg.Client({ connectionString: base, connectionTimeoutMillis: 3_000 })
  try {
    await bootstrap.connect()
  } catch {
    await bootstrap.end().catch(() => undefined)
    t.skip('no reachable PostgreSQL; the live schema-pinning checks are skipped')
    return null
  }
  try {
    await bootstrap.query(`CREATE DATABASE ${name}`)
  } catch (error) {
    await bootstrap.end().catch(() => undefined)
    t.skip(`cannot create a throwaway database (${error instanceof Error ? error.message : String(error)})`)
    return null
  }
  await bootstrap.end().catch(() => undefined)

  const scratchUrl = new URL(base)
  scratchUrl.search = ''
  scratchUrl.pathname = `/${name}`
  const url = scratchUrl.toString()

  const admin = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3_000 })
  await admin.connect()
  // The same table in two schemas: the one the URL names, and the one an unpinned connection
  // falls back to. Nothing is asserted about which exists — only about which got the row.
  await admin.query('CREATE SCHEMA tenant_a')
  for (const schema of ['tenant_a', 'public']) {
    await admin.query(
      `CREATE TABLE ${schema}.settings (key text primary key, value text not null, "updatedAt" timestamptz not null)`,
    )
  }

  return {
    url,
    admin,
    drop: async () => {
      await admin.end().catch(() => undefined)
      const cleanup = new pg.Client({ connectionString: base, connectionTimeoutMillis: 3_000 })
      try {
        await cleanup.connect()
        await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
      } finally {
        await cleanup.end().catch(() => undefined)
      }
    },
  }
}

/** Which schemas hold a row with this key, in the order PostgreSQL would resolve them. */
async function schemasHolding(admin: pg.Client, key: string): Promise<string[]> {
  const rows = await admin.query<{ schema: string }>(
    `select 'tenant_a' as schema from tenant_a.settings where key = $1
     union all
     select 'public' as schema from public.settings where key = $1`,
    [key],
  )
  return rows.rows.map((row) => row.schema).sort()
}

test('o3d-2k5r r12 (live): a TAB-separated search path puts the SERVER on the schema the URL named', async (t) => {
  const scratch = await openScratch(t)
  if (!scratch) return
  try {
    // ROUTE: `options=-c%09search_path%3DTenantA` -> splitLibpqOptions() -> the pin
    // pgConnectionConfig() composes -> the startup packet -> the backend's own `search_path`.
    //
    // MUTATION: restore the space-only tokenizer. `pgConnectionConfig()` then emits the operator's
    // `-c<TAB>search_path=TenantA` token UNCHANGED and appends `-c search_path="public"`; the
    // backend applies both, the last assignment wins, `current_schema()` becomes `public` and the
    // unqualified insert below lands in `public.settings`. A test that only inspected the
    // transmitted string would still see `TenantA` in it and pass — which is why this one asks the
    // server.
    for (const [name, separator] of [
      ['space', ' '],
      ['tab', '\t'],
      ['newline', '\n'],
      ['carriage return', '\r'],
      ['form feed', '\f'],
      ['vertical tab', '\v'],
    ] as [string, string][]) {
      const url: string = `${scratch.url}?options=${encodeURIComponent(`-c${separator}search_path=Tenant_A`)}`
      const config: { connectionString: string; options?: string } = pgConnectionConfig(url)
      const client: pg.Client = new pg.Client({ ...config, connectionTimeoutMillis: 3_000 })
      await client.connect()
      try {
        const shown = await client.query<{ schema: string }>('select current_schema() as schema')
        assert.equal(
          shown.rows[0]?.schema,
          'tenant_a',
          `${name}: the server resolves the schema the URL named, folded as the server folds it`,
        )
        const key = `probe-${name.replace(/\s+/g, '-')}`
        await client.query('insert into settings (key, value, "updatedAt") values ($1, $2, now())', [key, name])
        assert.deepEqual(
          await schemasHolding(scratch.admin, key),
          ['tenant_a'],
          `${name}: the unqualified write landed in the named schema and nowhere else`,
        )
      } finally {
        await client.end().catch(() => undefined)
      }
    }
  } finally {
    await scratch.drop()
  }
})

test('o3d-2k5r r12 (live): the provisioning seeder writes into the schema the runtime reads', async (t) => {
  const scratch = await openScratch(t)
  if (!scratch) return
  try {
    // ROUTE: install.sh -> `node scripts/provision-instance.mjs` -> provisioningClient(DATABASE_URL)
    // -> pgConnectionConfig() -> the startup search path -> `insert into settings` (UNQUALIFIED,
    // like every statement in that script).
    //
    // MUTATION: put `new Client({ connectionString: databaseUrl })` back in provisioningClient().
    // node-postgres discards the Prisma-only `?schema=`, the connection falls back to the login
    // role's default search path, and the seeded row appears in `public.settings` while the
    // runtime — pinned to `tenant_a` by the very same URL — reads an empty table. Both assertions
    // below then fail: the row is in the wrong schema, and the runtime's schema is empty.
    const url = `${scratch.url}?schema=tenant_a`

    // PRECONDITION: this is a URL the RUNTIME puts on `tenant_a`. If that ever stops being true the
    // rest of the test is comparing the seeder against nothing.
    assert.deepEqual(resolveDatabaseUrlSchema(url), { parsed: true, explicit: true, schema: 'tenant_a' })

    const db = provisioningClient(url)
    await db.connect()
    try {
      assert.equal(
        (await db.query<{ schema: string }>('select current_schema() as schema')).rows[0]?.schema,
        'tenant_a',
        'the seeder connects on the runtime\'s schema',
      )
      assert.equal(await seedSetting(db, 'wc_consumer_secret', 'cs_live_probe'), true)
      assert.equal(await seedSetting(db, 'wc_url', 'https://example.test'), true)
      // A SEED IS NOT AN OVERRIDE, and it must still not be one on a pinned connection — the
      // `on conflict do nothing` has to see the row it already wrote, which it only does when both
      // writes resolve the same table.
      assert.equal(await seedSetting(db, 'wc_consumer_secret', 'cs_live_rotated'), false)
    } finally {
      await db.end().catch(() => undefined)
    }

    assert.deepEqual(
      await schemasHolding(scratch.admin, 'wc_consumer_secret'),
      ['tenant_a'],
      'the plaintext consumer secret is in the runtime\'s schema, and in no other',
    )
    assert.deepEqual(await schemasHolding(scratch.admin, 'wc_url'), ['tenant_a'])
    assert.equal(
      (await scratch.admin.query('select value from tenant_a.settings where key = $1', ['wc_consumer_secret']))
        .rows[0]?.value,
      'cs_live_probe',
      'and the seed did not overwrite itself through a second schema',
    )
  } finally {
    await scratch.drop()
  }
})

test('o3d-2k5r r12: every install-path writer builds its client through the shared resolver', async () => {
  // The two live tests above pin the two clients they exercise. This one is the SWEEP: the
  // installer runs `prisma migrate deploy`, then `npm run db:seed`, then the bootstrap, and a
  // writer added to that sequence later would reintroduce the finding without failing anything.
  //
  // MUTATION: revert any one of the three call sites to a bare `connectionString: databaseUrl` and
  // the matching assertion fails by name.
  const { readFile } = await import('node:fs/promises')
  const sources = Object.fromEntries(
    await Promise.all(
      [
        '../../scripts/provision-instance.mjs',
        '../../scripts/check-stock-quantity-constraints.mjs',
        '../../prisma/seed.ts',
        '../../scripts/check-wms-push-state-enum.mjs',
      ].map(async (relative) => [relative, await readFile(new URL(relative, import.meta.url), 'utf8')] as const),
    ),
  )

  assert.match(sources['../../scripts/provision-instance.mjs'], /\.\.\.pgConnectionConfig\(databaseUrl\)/)
  assert.match(
    sources['../../scripts/provision-instance.mjs'],
    /const db = provisioningClient\(databaseUrl\)/,
    'and the bootstrap — the admin, the SMTP settings, the plaintext WooCommerce secret — goes through it',
  )
  assert.match(sources['../../scripts/check-stock-quantity-constraints.mjs'], /\.\.\.pgConnectionConfig\(databaseUrl\)/)
  assert.match(sources['../../scripts/check-wms-push-state-enum.mjs'], /\.\.\.pgConnectionConfig\(databaseUrl\)/)

  // The seeder needs BOTH halves and they are not the same thing: the pool's search path decides
  // where raw statements resolve, the adapter's `schema` decides what Prisma QUALIFIES generated
  // queries with — and `prisma/seed.ts` is entirely generated queries.
  assert.match(sources['../../prisma/seed.ts'], /new PrismaPg\(\s*pgConnectionConfig\(/)
  assert.match(sources['../../prisma/seed.ts'], /prismaAdapterSchemaOptions\(process\.env\.DATABASE_URL!\)/)
})

test('o3d-2k5r r13 (live): a schema name containing every backend separator is pinned by the real server', async (t) => {
  const scratch = await openScratch(t)
  if (!scratch) return
  try {
    // ROUTE: `?schema=<name>` -> pgConnectionConfig() -> escapeLibpqValue() -> the startup packet
    // -> pg_split_opts() IN THE BACKEND -> the connection's own `search_path` -> where an
    // unqualified INSERT lands. The pure round-trip above proves this module agrees with itself;
    // this one proves the character it agreed on is the character POSTGRESQL agrees on too. Only
    // the server can answer that, because the escape is interpreted by the server's splitter.
    //
    // MUTATION: restore the space-only emitter (`/([\\ ])/g`). For every separator but the space
    // the pin reaches the backend split into three tokens — `-c`, `search_path="ten` and `ant"` —
    // so `current_schema()` is not the named schema and the connect either errors on the
    // unterminated identifier or resolves the login role's default. Both assertions below fail,
    // and the write lands in `public.settings` instead.
    for (const [label, separator] of [...BACKEND_SEPARATORS, ['all six', null] as [string, null]]) {
      const schema = separator === null ? ALL_SEPARATORS_SCHEMA : `ten${separator}ant`
      const quoted = `"${schema.replace(/"/g, '""')}"`
      await scratch.admin.query(`CREATE SCHEMA ${quoted}`)
      await scratch.admin.query(
        `CREATE TABLE ${quoted}.settings (key text primary key, value text not null, "updatedAt" timestamptz not null)`,
      )

      const url = `${scratch.url}?schema=${encodeURIComponent(schema)}`
      const config = pgConnectionConfig(url)
      const client = new pg.Client({ ...config, connectionTimeoutMillis: 3_000 })
      await client.connect()
      try {
        assert.equal(
          (await client.query<{ schema: string }>('select current_schema() as schema')).rows[0]?.schema,
          schema,
          `${label}: the backend resolved the WHOLE name, not the part before the separator`,
        )
        const key = `probe-${label.replace(/\s+/g, '-')}`
        await client.query('insert into settings (key, value, "updatedAt") values ($1, $2, now())', [key, label])
        assert.equal(
          (await scratch.admin.query(`select key from ${quoted}.settings where key = $1`, [key])).rowCount,
          1,
          `${label}: the unqualified write landed in the schema the URL named`,
        )
        assert.equal(
          (await scratch.admin.query('select key from public.settings where key = $1', [key])).rowCount,
          0,
          `${label}: and not in the login role's default schema`,
        )
      } finally {
        await client.end().catch(() => undefined)
      }
    }
  } finally {
    await scratch.drop()
  }
})

test('o3d-2k5r r14 (live): a hyphenated search-path name pins the REAL server on the schema the URL named', async (t) => {
  const scratch = await openScratch(t)
  if (!scratch) return
  try {
    for (const [label, spell] of GUC_SPELLINGS) {
      // PRECONDITION — THE PREMISE OF THE FIX, ASKED OF THE SERVER rather than read out of its
      // source. This client deliberately BYPASSES pgConnectionConfig() and hands the hyphenated
      // spelling straight to pg, so what it measures is PostgreSQL's own `ParseLongOption()`. If
      // this ever fails, the normalisation is wrong and the test says so at the premise instead of
      // silently making the conclusion below untestable.
      const raw: pg.Client = new pg.Client({
        connectionString: scratch.url,
        options: spell('search-path=tenant_a'),
        connectionTimeoutMillis: 3_000,
      })
      await raw.connect()
      try {
        assert.equal(
          (await raw.query<{ schema: string }>('select current_schema() as schema')).rows[0]?.schema,
          'tenant_a',
          `${label}: PostgreSQL itself reads a hyphenated GUC name as the underscored one`,
        )
      } finally {
        await raw.end().catch(() => undefined)
      }

      // ROUTE: `options=<hyphenated spelling>` -> canonicalGucName() -> the schema
      // resolveDatabaseUrlSchema() reads -> the pin pgConnectionConfig() composes -> the startup
      // packet -> the connection's own `search_path` -> where an UNQUALIFIED insert lands.
      //
      // MUTATION: delete `.replace(/-/g, '_')` from canonicalGucName(). The emitted options become
      // `-c search-path=Tenant_A -c search_path="public"`; the backend applies both, the LAST
      // assignment wins, `current_schema()` is `public` and the row below lands in
      // `public.settings`. A test that only inspected the transmitted string would still find
      // `Tenant_A` in it and pass — which is exactly how this spelling survived thirteen rounds.
      const url: string = `${scratch.url}?options=${encodeURIComponent(spell('search-path=Tenant_A'))}`
      const client: pg.Client = new pg.Client({ ...pgConnectionConfig(url), connectionTimeoutMillis: 3_000 })
      await client.connect()
      try {
        assert.equal(
          (await client.query<{ schema: string }>('select current_schema() as schema')).rows[0]?.schema,
          'tenant_a',
          `${label}: the pinned connection is on the schema the URL named, folded as the server folds it`,
        )
        const key = `probe-hyphen-${label.replace(/\s+/g, '-')}`
        await client.query('insert into settings (key, value, "updatedAt") values ($1, $2, now())', [key, label])
        assert.deepEqual(
          await schemasHolding(scratch.admin, key),
          ['tenant_a'],
          `${label}: and the unqualified write landed there and nowhere else`,
        )
      } finally {
        await client.end().catch(() => undefined)
      }
    }
  } finally {
    await scratch.drop()
  }
})

test('o3d-2k5r r14 (live): a NUL in the startup options is refused HERE because the server refuses it there', async (t) => {
  const scratch = await openScratch(t)
  if (!scratch) return
  try {
    // THE OTHER HALF OF THE MEDIUM FINDING, measured rather than reasoned about: this is what the
    // module would be emitting if it did not refuse. The raw client below is handed the exact pin
    // `pgConnectionConfig()` used to compose for `?schema=ten<NUL>ant`, and the server rejects the
    // CONNECTION — so the value the reader round-tripped happily is a value no connection can
    // carry.
    //
    // The first assertion constrains POSTGRESQL, not this module: it is what makes the refusal in
    // the pure test above a fix rather than a preference, and it is the reason the module can say
    // the value is impossible instead of merely unusual.
    // MUTATION (for the second assertion): delete the U+0000 branches from splitLibpqOptions() and
    // resolveDatabaseUrlSchema(). `pgConnectionConfig()` then returns a config carrying that same
    // impossible pin, the assert.throws fails, and the only remaining signal an operator gets is
    // the wire error the first assertion just captured.
    const NUL = String.fromCharCode(0)
    const raw: pg.Client = new pg.Client({
      connectionString: scratch.url,
      options: `-c search_path="ten${NUL}ant"`,
      connectionTimeoutMillis: 3_000,
    })
    await assert.rejects(
      raw.connect(),
      (error: unknown) => {
        assert.ok(error instanceof Error, 'the connection fails')
        return true
      },
      'a startup options string carrying U+0000 cannot open a connection at all',
    )
    await raw.end().catch(() => undefined)

    // AND SO THE MODULE REFUSES IT BEFORE A CLIENT IS EVER BUILT, with a sentence that names the
    // parameter — instead of handing the operator the wire-level packet-layout error above.
    assert.throws(
      () => pgConnectionConfig(`${scratch.url}?schema=${encodeURIComponent(`ten${NUL}ant`)}`),
      DatabaseUrlSchemaConflictError,
    )
  } finally {
    await scratch.drop()
  }
})

test('o3d-2k5r r15 (live): the REAL server strips the six and KEEPS the four, and the pin follows it', async (t) => {
  const scratch = await openScratch(t)
  if (!scratch) return
  const quote = (name: string) => `"${name.replace(/"/g, '""')}"`
  const escape = (value: string) => value.replace(/[\\\s]/gu, '\\$&')
  try {
    // Every name this test can land on, so that landing on the WRONG one is observable rather than
    // an error. `tenant` is the name `trim()` produced; `<ws>tenant` is the name the URL wrote.
    const names = ['tenant']
    for (const [, whitespace] of KEPT_BY_THE_SERVER) names.push(`${whitespace}tenant`, `tenant${whitespace}`)
    for (const name of names) {
      await scratch.admin.query(`CREATE SCHEMA ${quote(name)}`)
      await scratch.admin.query(
        `CREATE TABLE ${quote(name)}.settings (key text primary key, value text not null, "updatedAt" timestamptz not null)`,
      )
    }

    /** Which of the schemas above holds a row with this key. */
    const holders = async (key: string): Promise<string[]> => {
      const found: string[] = []
      for (const name of names) {
        const rows = await scratch.admin.query(`select 1 from ${quote(name)}.settings where key = $1`, [key])
        if (rows.rowCount) found.push(name)
      }
      return found
    }

    // PRECONDITION — THE PREMISE OF THE WHOLE FIX, ASKED OF THE SERVER rather than read out of its
    // source. This is `SplitIdentifierString()`/`scanner_isspace()` answering directly, with no
    // part of this module involved: set the GUC to the raw value and ask which schema it resolved.
    // If either half ever changes, the rule in SCANNER_WHITESPACE is wrong and this says so at the
    // premise instead of leaving the conclusions below untestable.
    for (const [label, whitespace] of BACKEND_SEPARATORS) {
      await scratch.admin.query('select set_config($1, $2, false)', ['search_path', `${whitespace}tenant`])
      assert.equal(
        (await scratch.admin.query<{ s: string }>('select current_schema() as s')).rows[0]?.s,
        'tenant',
        `${label}: PostgreSQL itself strips this one off a search path element`,
      )
    }
    for (const [label, whitespace] of KEPT_BY_THE_SERVER) {
      for (const value of [`${whitespace}tenant`, `tenant${whitespace}`]) {
        await scratch.admin.query('select set_config($1, $2, false)', ['search_path', value])
        assert.equal(
          (await scratch.admin.query<{ s: string }>('select current_schema() as s')).rows[0]?.s,
          value,
          `${label}: PostgreSQL KEEPS this one inside the identifier — it is not whitespace to the server`,
        )
      }
    }
    await scratch.admin.query("select set_config('search_path','public',false)")

    for (const [label, whitespace] of KEPT_BY_THE_SERVER) {
      for (const [position, value] of [
        ['leading', `${whitespace}tenant`],
        ['trailing', `tenant${whitespace}`],
      ] as [string, string][]) {
        // WHAT THE OPERATOR'S OWN URL DOES AT THE SERVER, bypassing this module entirely: their
        // escaped, unquoted value reaches the backend and lands the write in the schema they named.
        const raw: pg.Client = new pg.Client({
          connectionString: scratch.url,
          options: `-c search_path=${escape(value)}`,
          connectionTimeoutMillis: 3_000,
        })
        await raw.connect()
        try {
          const key = `raw-${label}-${position}`
          await raw.query('insert into settings (key, value, "updatedAt") values ($1, $2, now())', [key, label])
          assert.deepEqual(
            await holders(key),
            [value],
            `${label} ${position}: the URL's own value writes into the schema carrying the character`,
          )
        } finally {
          await raw.end().catch(() => undefined)
        }

        // AND THAT IS A DIFFERENT SCHEMA FROM `tenant` — measured, not assumed. This is the exact
        // gap `trim()` opened: it pinned `tenant`, whose writes land here instead.
        const trimmed: pg.Client = new pg.Client({ ...pgConnectionConfig(`${scratch.url}?schema=tenant`), connectionTimeoutMillis: 3_000 })
        await trimmed.connect()
        try {
          const key = `trimmed-${label}-${position}`
          await trimmed.query('insert into settings (key, value, "updatedAt") values ($1, $2, now())', [key, label])
          assert.deepEqual(
            await holders(key),
            ['tenant'],
            `${label} ${position}: the name trim() produced is a real, DIFFERENT schema`,
          )
        } finally {
          await trimmed.end().catch(() => undefined)
        }

        // ROUTE: `?options=-c search_path=\<ws>tenant` -> splitLibpqOptions() -> unescapeLibpq() ->
        // singleSchemaOfSearchPath() -> foldUnquotedIdentifier(). REFUSED, because an unquoted
        // non-ASCII name is folded by the database's own encoding and collation.
        //
        // MUTATION: restore `const trimmed = String(value).trim()` in singleSchemaOfSearchPath().
        // This stops throwing and resolves to `tenant` — the schema the two clients above just
        // proved is a DIFFERENT one — so the adapter, the pin and all three raw gates are aligned
        // on `tenant` while the URL asked for the schema the first client wrote into. The
        // assert.throws fails.
        const url = new URL(scratch.url)
        url.searchParams.set('options', `-c search_path=${escape(value)}`)
        assert.throws(
          () => pgConnectionConfig(url.toString()),
          (error: unknown) => {
            assert.ok(error instanceof DatabaseUrlSchemaConflictError, `${label} ${position}: refused`)
            assert.match(error.message, /UNQUOTED identifier this cannot read/, `${label} ${position}: as unfoldable`)
            return true
          },
        )

        // AND QUOTED IT IS CARRIED, not refused: the character reaches the REAL server intact and
        // the unqualified write lands in the schema whose name contains it.
        //
        // ROUTE, deliberately the long way round so the READER is on it: `?schema=<ws>tenant` ->
        // pgConnectionConfig() -> escapeLibpqValue() -> the always-quoted pin -> back in as
        // `?options=` -> splitLibpqOptions() -> singleSchemaOfSearchPath()'s QUOTED branch -> the
        // pin re-emitted -> the startup packet -> current_schema(). Handing `?schema=` straight to
        // pgConnectionConfig() would never reach singleSchemaOfSearchPath() at all, and a test that
        // does not touch the changed function cannot be failed by changing it.
        //
        // MUTATION: apply `.trim()` to the quoted branch's captured group. The name read back out
        // of the pin becomes `tenant`, the re-emitted pin says `tenant`, and current_schema() is
        // `tenant` — a schema the two clients above just proved is a DIFFERENT one — so both
        // assertions below fail and the write lands in the wrong schema.
        const carried = new URL(scratch.url)
        carried.searchParams.set(
          'options',
          pgConnectionConfig(`${scratch.url}?schema=${encodeURIComponent(value)}`).options!,
        )
        const pinned: pg.Client = new pg.Client({
          ...pgConnectionConfig(carried.toString()),
          connectionTimeoutMillis: 3_000,
        })
        await pinned.connect()
        try {
          assert.equal(
            (await pinned.query<{ s: string }>('select current_schema() as s')).rows[0]?.s,
            value,
            `${label} ${position}: the server resolved the WHOLE name, character included`,
          )
          const key = `pinned-${label}-${position}`
          await pinned.query('insert into settings (key, value, "updatedAt") values ($1, $2, now())', [key, label])
          assert.deepEqual(
            await holders(key),
            [value],
            `${label} ${position}: and the unqualified write landed there and nowhere else`,
          )
        } finally {
          await pinned.end().catch(() => undefined)
        }
      }
    }
  } finally {
    await scratch.drop()
  }
})

test('o3d-2k5r r16 (live): the REAL server resolves a quoted-empty search path through NO schema', async (t) => {
  const scratch = await openScratch(t)
  if (!scratch) return
  try {
    // ROUTE, first half: the startup packet a URL carrying `options=-c search_path=""` would open
    // if it were not refused — built here with `pg` directly, exactly as pgConnectionConfig()
    // would have left it (it returned the connection string UNTOUCHED for a falsy schema, so the
    // URL's own `options` reached the server).
    //
    // This is the measurement the pure test above can only assert about: the server ACCEPTS the
    // value, `current_schema()` is NULL, and an unqualified statement resolves nothing at all —
    // while Prisma, handed `undefined` by prismaAdapterSchemaOptions(), qualifies its generated
    // queries with `public`, where the table does exist. Not one schema: a split, plus an outage
    // on every raw statement.
    const unpinned: pg.Client = new pg.Client({
      connectionString: scratch.url,
      options: '-c search_path=""',
      connectionTimeoutMillis: 3_000,
    })
    await unpinned.connect()
    try {
      assert.equal(
        (await unpinned.query<{ schema: string | null }>('select current_schema() as schema')).rows[0]?.schema,
        null,
        'the server accepts the value and resolves through no schema',
      )
      assert.equal(
        (await unpinned.query<{ path: string }>("select current_setting('search_path') as path")).rows[0]?.path,
        '""',
        'and it kept the empty element rather than folding it away',
      )
      await assert.rejects(
        unpinned.query('insert into settings (key, value, "updatedAt") values ($1, $2, now())', ['empty', 'x']),
        /relation "settings" does not exist/,
        'so an unqualified write — every raw statement in this app — cannot resolve its table',
      )
    } finally {
      await unpinned.end().catch(() => undefined)
    }

    // ROUTE, second half: the same value through the module, from a URL of the REAL database, so
    // the refusal is proved on a connection that would otherwise have opened successfully.
    //
    // MUTATION: drop the `decoded === ''` rejection from singleSchemaOfSearchPath(). Both
    // assert.throws stop throwing — pgConnectionConfig() returns `{ connectionString }` with the
    // empty search path still in it (the client above, which the assertions above just proved is
    // on no schema at all), and prismaAdapterSchemaOptions() returns `undefined`.
    const url = `${scratch.url}?options=${encodeURIComponent('-c search_path=""')}`
    for (const [reader, run] of [
      ['pgConnectionConfig', () => pgConnectionConfig(url)],
      ['prismaAdapterSchemaOptions', () => prismaAdapterSchemaOptions(url)],
    ] as [string, () => unknown][]) {
      assert.throws(
        run,
        (error: unknown) => {
          assert.ok(error instanceof DatabaseUrlSchemaConflictError, `${reader}: refused as a schema conflict`)
          assert.match((error as Error).message, /zero characters long/, `${reader}: with the reason`)
          return true
        },
        `${reader}: refuses to build a consumer on the empty search path`,
      )
    }

    // AND THE SAME URL NAMING A REAL SCHEMA STILL OPENS, so the guard is not refusing the shape:
    // the pinned client lands its unqualified write in `tenant_a` and nowhere else.
    const pinned: pg.Client = new pg.Client({
      ...pgConnectionConfig(`${scratch.url}?options=${encodeURIComponent('-c search_path="tenant_a"')}`),
      connectionTimeoutMillis: 3_000,
    })
    await pinned.connect()
    try {
      await pinned.query('insert into settings (key, value, "updatedAt") values ($1, $2, now())', ['named', 'x'])
      assert.deepEqual(
        await schemasHolding(scratch.admin, 'named'),
        ['tenant_a'],
        'a search path that names a real schema is still pinned and still writes there',
      )
    } finally {
      await pinned.end().catch(() => undefined)
    }
  } finally {
    await scratch.drop()
  }
})

test('o3d-2k5r r17: a terminal escape is CONSUMED, so the separator before the pin survives', () => {
  // ROUTE: DATABASE_URL `?options=-c application_name=foo\` -> splitLibpqOptions() (the terminal
  // escape) -> readLibpqSettings() -> pgConnectionConfig()'s `[...carried, pin].join(' ')` -> the
  // `options` string every raw consumer opens its startup packet with.
  //
  // The setting is deliberately a VALID NON-`search_path` GUC. Nothing about the schema is wrong
  // in this finding — `application_name` is carried through untouched, as this module promises to
  // carry every setting it does not own — and that is exactly what made it dangerous: the
  // corruption is inflicted by the JOIN, on the pin, by a token the module was not even reading.
  //
  // MUTATION: restore `if (escaped) current += '\\'` before the push at the end of
  // splitLibpqOptions(). The token comes back as `application_name=foo\`, the composed value
  // becomes `-c application_name=foo\ -c search_path="public"`, and the first assertion below
  // fails on the emitted string. The live test that follows then measures what that string does to
  // a real server: it does not connect at all.
  assert.equal(
    pgConnectionConfig(
      `postgresql://u:p@localhost:5432/ims?schema=public&options=${encodeURIComponent('-c application_name=foo\\')}`,
    ).options,
    '-c application_name=foo -c search_path="public"',
  )

  // The tokenizer alone, stated as the server's own rule: the marker is consumed and NOTHING takes
  // its place, so re-joining the tokens with a single space is once again an equivalent string.
  assert.deepEqual(splitLibpqOptions('-c application_name=foo\\'), ['-c', 'application_name=foo'])

  // AND A DOUBLED BACKSLASH IS NOT A TERMINAL ESCAPE. It is an escaped literal, the token keeps it
  // escaped exactly as every other escaped literal in this file is kept, and the composed value
  // still reaches the server with the backslash in the value. Without this the "fix" could have
  // been an unconditional strip of one trailing character, which would corrupt a real trailing
  // backslash instead — measured live below.
  assert.deepEqual(splitLibpqOptions('-c application_name=foo\\\\'), ['-c', 'application_name=foo\\\\'])
  assert.equal(
    pgConnectionConfig(
      `postgresql://u:p@localhost:5432/ims?schema=public&options=${encodeURIComponent('-c application_name=foo\\\\')}`,
    ).options,
    '-c application_name=foo\\\\ -c search_path="public"',
  )

  // A terminal escape that opens a token and CLOSES NOTHING is the one case with no equivalent
  // string to return, so it is refused rather than dropped. `pg_split_opts()` emits the token
  // EMPTY and the server rejects that argument on sight; an empty token joined ahead of the pin
  // would be swallowed by the backend's own whitespace skip, so silently dropping it would leave
  // this module accepting a URL the server refuses.
  //
  // MUTATION: delete the `escaped && current === ''` throw. Both refusals below stop throwing and
  // pgConnectionConfig() happily emits `-c statement_timeout=5000 -c search_path="public"` for a
  // URL whose real startup packet the server will not accept.
  for (const options of ['\\', '-c statement_timeout=5000 \\']) {
    assert.throws(
      () =>
        pgConnectionConfig(
          `postgresql://u:p@localhost:5432/ims?schema=public&options=${encodeURIComponent(options)}`,
        ),
      (error: unknown) => {
        assert.ok(error instanceof DatabaseUrlSchemaConflictError, `${JSON.stringify(options)}: a schema conflict`)
        assert.match((error as Error).message, /escapes nothing/, `${JSON.stringify(options)}: with the reason`)
        return true
      },
      `${JSON.stringify(options)}: refused rather than normalised away`,
    )
  }
})

test('o3d-2k5r r17 (live): the REAL server drops the terminal escape, and the composed pin reaches it', async (t) => {
  const scratch = await openScratch(t)
  if (!scratch) return
  try {
    // ROUTE, first half — THE PREMISE, measured rather than read out of the backend's source: an
    // `options` ending in an unmatched escape is a WORKING startup value. `pg_split_opts()` ends
    // its inner loop on the terminating NUL with `last_was_escape` still set and never writes the
    // marker out, so the server sees `application_name=foo` and connects.
    //
    // This half is what decides the treatment. If the server rejected this value, refusing it here
    // would cost nothing; because the server ACCEPTS it, refusing here would take a DATABASE_URL
    // that connects today and make this module the reason it stopped.
    const raw: pg.Client = new pg.Client({
      connectionString: scratch.url,
      options: '-c application_name=foo\\',
      connectionTimeoutMillis: 3_000,
    })
    await raw.connect()
    try {
      assert.equal(
        (await raw.query<{ name: string }>("select current_setting('application_name') as name")).rows[0]?.name,
        'foo',
        'the server accepts a terminal escape and resolves the GUC without it',
      )
    } finally {
      await raw.end().catch(() => undefined)
    }

    // ROUTE, second half — THE FINDING. The same URL through the module, opened against the real
    // server. The connection must open, the preserved GUC must still carry its server-resolved
    // value, and current_schema() must be the PINNED schema: the pin is the thing the restored
    // backslash used to eat.
    //
    // MUTATION: restore `if (escaped) current += '\\'` at the end of splitLibpqOptions(). The
    // composed options become `-c application_name=foo\ -c search_path="tenant_a"`, which the
    // backend retokenises as `['-c', 'application_name=foo -c', 'search_path="tenant_a"']` — a
    // third token that is not an option at all — and connect() rejects with `invalid command-line
    // argument for server process: search_path="tenant_a"`. This test then fails at connect(),
    // before any assertion, which is precisely the outage the finding describes: not a
    // mis-resolved schema but every raw consumer unable to reach the database.
    const url = `${scratch.url}?schema=tenant_a&options=${encodeURIComponent('-c application_name=foo\\')}`
    const pinned: pg.Client = new pg.Client({ ...pgConnectionConfig(url), connectionTimeoutMillis: 3_000 })
    await pinned.connect()
    try {
      assert.equal(
        (await pinned.query<{ name: string }>("select current_setting('application_name') as name")).rows[0]?.name,
        'foo',
        'the preserved setting still reaches the server, with the escape consumed',
      )
      assert.equal(
        (await pinned.query<{ s: string }>('select current_schema() as s')).rows[0]?.s,
        'tenant_a',
        'AND the appended pin survived the join — this is the assertion the restored backslash broke',
      )
      await pinned.query('insert into settings (key, value, "updatedAt") values ($1, $2, now())', ['terminal', 'x'])
      assert.deepEqual(
        await schemasHolding(scratch.admin, 'terminal'),
        ['tenant_a'],
        'so the unqualified write lands in the pinned schema and nowhere else',
      )
    } finally {
      await pinned.end().catch(() => undefined)
    }

    // AND THE DOUBLED BACKSLASH, live: a REAL trailing backslash in the GUC value is not a terminal
    // escape and must survive to the server intact, with the pin still appended after it. This is
    // what rules out "strip one trailing character" as the fix.
    const literal: pg.Client = new pg.Client({
      ...pgConnectionConfig(`${scratch.url}?schema=tenant_a&options=${encodeURIComponent('-c application_name=foo\\\\')}`),
      connectionTimeoutMillis: 3_000,
    })
    await literal.connect()
    try {
      assert.equal(
        (await literal.query<{ name: string }>("select current_setting('application_name') as name")).rows[0]?.name,
        'foo\\',
        'an escaped backslash is a literal one, and the server receives it',
      )
      assert.equal(
        (await literal.query<{ s: string }>('select current_schema() as s')).rows[0]?.s,
        'tenant_a',
        'and the pin still reached the server behind it',
      )
    } finally {
      await literal.end().catch(() => undefined)
    }
  } finally {
    await scratch.drop()
  }
})
