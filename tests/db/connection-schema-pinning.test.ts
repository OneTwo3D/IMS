import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import net from 'node:net'
import test, { type TestContext } from 'node:test'

import { parse as parseDotenv } from 'dotenv'
import pg from 'pg'

import {
  DatabaseUrlSchemaConflictError,
  establishStartupOptionByteSafety,
  nonAsciiStartupOptionCharacters,
  pgConnectionConfig,
  pinClientToMeasuredBackend,
  prismaAdapterSchemaOptions,
  resetStartupOptionByteSafety,
  resolveDatabaseUrlSchema,
  sanitisedProbeConnectionString,
  splitLibpqOptions,
  startupOptionByteSafety,
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

test('o3d-2k5r r18: every non-ASCII character in the startup options is refused, ESCAPED OR NOT', () => {
  // ROUTE: the tokenizer, for both spellings, and then the whole composition behind it —
  // `?options=` -> splitLibpqOptions() -> readLibpqSettings() -> resolveDatabaseUrlSchema() ->
  // pgConnectionConfig()'s pin.
  //
  // WHY IT IS ONE RULE AND NOT TWO. `isspace()` is asked ONE BYTE AT A TIME by the backend, and
  // `pg_split_opts()` lets a backslash cover exactly ONE byte. So an escape in front of a
  // multi-byte character protects its first byte and hands the rest back to the deployment's own
  // `LC_CTYPE` — which is the same unknowable boundary the bare form has, not a fix for it. Round
  // 17 exempted the escaped form; this asserts the exemption is gone.
  //
  // MUTATION: delete the NON_ASCII_OPTION_CHARACTER branch from splitLibpqOptions(). The bare
  // cases then resolve silently to a schema named `search_path=tenanta` on one server and pin
  // `public` on another, and every `assert.throws` below fails.
  //
  // SECOND MUTATION, the one round 17 would have survived: move the branch back BELOW `if
  // (escaped)`. The three bare cases still throw and the three escaped ones stop throwing, so the
  // escaped half of this test is what proves the gate is ahead of the escape rather than beside it.
  for (const [label, character] of [
    ['U+00A0 no-break space', '\u00A0'],
    // NOT WHITESPACE TO ANYONE, and that is the point: its UTF-8 bytes are E2 80 A0, carrying the
    // very byte U+00A0 was refused for. A rule written over `\s` admitted this one.
    ['U+2020 dagger', '\u2020'],
    // A NAME AN OPERATOR MIGHT ACTUALLY WRITE, so the refusal is not only about exotica.
    ['U+00E4 a-umlaut', '\u00E4'],
  ] as [string, string][]) {
    for (const [spelling, written] of [
      ['bare', character],
      ['escaped', `\\${character}`],
    ] as [string, string][]) {
      // PRECONDITION, so this cannot pass by examining nothing: the string under test really does
      // carry the character, and the escaped spelling really does carry a backslash before it.
      const options = `-c application_name=x${written}-c search_path=tenanta`
      assert.ok(options.includes(character), `${label} ${spelling}: the input carries the character`)
      if (spelling === 'escaped') {
        assert.ok(options.includes(`\\${character}`), `${label} ${spelling}: and carries the escape`)
      }
      assert.throws(
        () => pgConnectionConfig(`postgresql://u:p@localhost:5432/ims?options=${encodeURIComponent(options)}`),
        (error: unknown) => {
          assert.ok(error instanceof DatabaseUrlSchemaConflictError, `${label} ${spelling}: refused`)
          const codePoint = `U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`
          assert.ok((error as Error).message.includes(codePoint), `${label} ${spelling}: names the character`)
          // AND THE JUSTIFICATION IS THE SHARED ONE. Round 17 had two refusals whose reasons
          // disagreed; asserting the byte sentence in BOTH spellings is what stops them drifting
          // apart again, because narrowing either one changes this string.
          assert.match(
            (error as Error).message,
            /ONE BYTE AT A TIME/,
            `${label} ${spelling}: refused on the byte-level reason, not a character-level one`,
          )
          return true
        },
      )
    }
  }
  // ASCII IS UNTOUCHED, so the refusal above is a rule about non-ASCII and not a rule about
  // escapes: the escaped ASCII separator this module has carried since round 12 still tokenises
  // as one token.
  assert.deepEqual(splitLibpqOptions('-c application_name=my\\ app'), ['-c', 'application_name=my\\ app'])
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

/**
 * `pg_split_opts()` AS THE BACKEND ACTUALLY RUNS IT: over BYTES, with the locale's own `isspace()`.
 *
 * A transcription of src/backend/utils/init/postinit.c — the leading-space skip, the
 * `last_was_esc` flag carried through the word loop, the escape that consumes ONE byte — with the
 * one thing this module cannot know left as a parameter. That parameter is the whole finding: the
 * tokenizer in `lib/db/database-url-schema.mjs` iterates CODE POINTS and has no such parameter, so
 * it has been answering a question whose answer is set by the deployment's encoding and `LC_CTYPE`.
 *
 * Tokens come back as latin1 strings so that individual BYTES are assertable; nothing here decodes
 * UTF-8, because the backend does not either.
 */
function pgSplitOptsOverBytes(options: string, isSpace: (byte: number) => boolean): string[] {
  const bytes = Buffer.from(options, 'utf8')
  const tokens: string[] = []
  let at = 0
  while (at < bytes.length) {
    while (at < bytes.length && isSpace(bytes[at]!)) at += 1
    if (at >= bytes.length) break
    const word: number[] = []
    let lastWasEscape = false
    while (at < bytes.length && (lastWasEscape || !isSpace(bytes[at]!))) {
      if (bytes[at] === 0x5c && !lastWasEscape) lastWasEscape = true
      else {
        word.push(bytes[at]!)
        lastWasEscape = false
      }
      at += 1
    }
    tokens.push(Buffer.from(word).toString('latin1'))
  }
  return tokens
}

/** `isspace()` where nothing above 0x7F is space — the C locale, and every UTF-8 database. */
const isSpaceAscii = (byte: number): boolean => byte === 0x20 || (byte >= 0x09 && byte <= 0x0d)

/** `isspace()` on a single-byte encoding whose locale classes 0xA0 (NBSP) as space. */
const isSpaceLatin1Nbsp = (byte: number): boolean => isSpaceAscii(byte) || byte === 0xa0

test('o3d-2k5r r18: BYTE-LEVEL — the escape covers one byte, and the boundary moves with the locale', () => {
  // ROUTE: no server. This is the premise underneath every refusal round 18 adds, proved against a
  // transcription of `pg_split_opts()` rather than against the module's own reading of it — which
  // is the reading under suspicion and cannot be its own witness.
  //
  // THE INPUT is Codex's: an application name ending in an ESCAPED U+00A0, followed by a second
  // `-c` assignment. Round 17 accepted it precisely because the character was escaped.
  const options = `-c application_name=x\\\u00A0-c search_path=tenant`

  // PRECONDITION, so nothing below can pass by examining nothing: the character really is two
  // bytes, the backslash really does sit in front of the first of them, and the second is 0xA0 —
  // the byte whose class the locale decides.
  const bytes = [...Buffer.from(options, 'utf8')]
  const backslash = bytes.indexOf(0x5c)
  assert.notEqual(backslash, -1, 'the input carries the escape')
  assert.deepEqual(bytes.slice(backslash, backslash + 3), [0x5c, 0xc2, 0xa0], 'escape, then the TWO bytes of U+00A0')

  const ascii = pgSplitOptsOverBytes(options, isSpaceAscii)
  const latin1 = pgSplitOptsOverBytes(options, isSpaceLatin1Nbsp)

  // THE ESCAPE COVERED ONE BYTE. On the locale that classes 0xA0 as space the word ends there, and
  // the token keeps 0xC2 — the byte the backslash protected — and nothing after it. A
  // character-level escape would have carried both bytes through and produced no boundary at all.
  assert.equal(latin1[1], 'application_name=x\u00c2', 'the escape protected 0xC2 and 0xA0 still ended the token')

  // AND THE BOUNDARY IS THE LOCALE'S, NOT THE STRING'S. Same bytes, two `isspace()` answers, two
  // different startup command lines — one of which hands the server a search_path assignment.
  assert.deepEqual(
    ascii,
    ['-c', 'application_name=x\u00c2\u00a0-c', 'search_path=tenant'],
    'ASCII locale: THREE tokens, the third of which is not an option at all',
  )
  assert.deepEqual(
    latin1,
    ['-c', 'application_name=x\u00c2', '-c', 'search_path=tenant'],
    'NBSP-as-space locale: FOUR tokens, and the fourth is a search_path assignment the server applies',
  )

  // SO THE MODULE REFUSES TO HAVE A READING AT ALL. Round 17 returned three tokens here, found no
  // `search_path` among them, resolved the URL to `public` and pinned `public` — while on the
  // locale above the server is being told `tenant`. `databaseUrlSchema()` is what the two
  // out-of-process gates ask, so that disagreement is a green gate over a connection on another
  // schema, which is the one failure this module exists to prevent.
  //
  // MUTATION: move the NON_ASCII_OPTION_CHARACTER branch back BELOW `if (escaped)` in
  // splitLibpqOptions() — round 17 exactly. Both assert.throws below stop throwing;
  // splitLibpqOptions() returns 3 tokens and resolveDatabaseUrlSchema() returns
  // `{ parsed: true, explicit: false, schema: 'public' }`, which the two assertions after the
  // throws state as the wrong answers they are.
  assert.throws(() => splitLibpqOptions(options), DatabaseUrlSchemaConflictError)
  const url = new URL('postgresql://u:p@localhost:5432/ims')
  url.searchParams.set('options', options)
  assert.throws(
    () => resolveDatabaseUrlSchema(url.toString()),
    (error: unknown) => {
      assert.ok(error instanceof DatabaseUrlSchemaConflictError)
      assert.match((error as Error).message, /ONE BYTE AT A TIME/)
      return true
    },
  )
  // The two token counts, named so the disagreement is stated as a number and not only as a shape.
  assert.equal(ascii.length, 3, 'round 17 tokenised the ASCII way — three tokens, no search_path found')
  assert.equal(latin1.length, 4, 'and the server may run the other, where a search_path IS assigned')
})

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

test('o3d-2k5r r18: a name the tokenizer refuses is refused at the SOURCE, not escaped into the pin', () => {
  // ROUTE: `?schema=` carrying U+00A0 -> resolveDatabaseUrlSchema() -> (round 17: escapeLibpqValue()
  // -> the pin -> splitLibpqOptions()). Round 13 answered "this module must escape what its own
  // tokenizer refuses" — right question, wrong door. The escape does not make the character
  // unambiguous at the backend, so a pin carrying one is a string this module can read back and the
  // SERVER may split through the middle of the schema name. The invariant is restored from the
  // other end instead: the name never becomes a pin.
  //
  // MUTATION: delete the `?schema=` non-ASCII loop from resolveDatabaseUrlSchema(). `assert.throws`
  // fails immediately; and with the tokenizer branch also removed the emit succeeds and produces
  // exactly round 17's `-c search_path="ten\<U+00A0>ant"` — which is asserted below NOT to be
  // producible, so the second half of this test fails too.
  const schema = 'ten\u00A0ant' // U+00A0, written as an escape so it cannot be mistaken for a space
  // PRECONDITION, so this cannot pass by examining nothing: the name really is non-ASCII, and the
  // ASCII name beside it really does still produce a pin.
  assert.ok(/[^\u0000-\u007F]/u.test(schema), 'the name under test is non-ASCII')
  assert.equal(
    pgConnectionConfig('postgresql://u:p@localhost:5432/ims?schema=ten_ant').options,
    '-c search_path="ten_ant"',
    'the same name in ASCII is pinned exactly as before',
  )

  assert.throws(
    () => pgConnectionConfig(`postgresql://u:p@localhost:5432/ims?schema=${encodeURIComponent(schema)}`),
    (error: unknown) => {
      assert.ok(error instanceof DatabaseUrlSchemaConflictError)
      assert.match((error as Error).message, /\?schema=/, 'refused as the schema parameter it is')
      assert.match((error as Error).message, /ONE BYTE AT A TIME/, 'on the same shared justification')
      return true
    },
  )

  // AND THE PIN ROUND 17 EMITTED IS NOT READABLE EITHER, which is what makes the refusal above
  // necessary rather than merely tidy: had it been emitted, this module could not take it back in.
  const roundTrip = new URL('postgresql://u:p@localhost:5432/ims')
  roundTrip.searchParams.set('options', '-c search_path="ten\\\u00A0ant"')
  assert.throws(() => resolveDatabaseUrlSchema(roundTrip.toString()), DatabaseUrlSchemaConflictError)
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

test('o3d-2k5r r18: an escaped non-ASCII character at either end of a search path is refused, not trimmed', () => {
  // ROUTE: `?options=-c search_path=\<ws>tenant` -> splitLibpqOptions(), which now REFUSES the
  // character before `unescapeLibpq()`, `singleSchemaOfSearchPath()`'s trim or
  // `foldUnquotedIdentifier()` ever see the value. Round 15 let the escaped character through to
  // the trim and refused it two functions later as an unfoldable name; round 18 refuses it at the
  // tokenizer, because the fold is not the only thing about it that is unknowable — where the
  // TOKEN ends is too, and that is decided first.
  //
  // WHAT THIS STILL PROVES, and why it is not a weaker test: the outcome under test is unchanged —
  // a URL naming `<ws>tenant` must never resolve to `tenant`. Only the door it is refused at moved.
  //
  // MUTATION: delete the NON_ASCII_OPTION_CHARACTER branch from splitLibpqOptions(). The value
  // reaches `trimScannerWhitespace()`, which does NOT strip these four, and the refusal becomes
  // round 15's "UNQUOTED identifier this cannot read" — so the message assertion below fails while
  // `assert.throws` still passes. That is why the message is asserted and not merely the throw:
  // the two refusals are no longer interchangeable, and this test says which one is correct.
  //
  // SECOND MUTATION: that branch removed AND `const trimmed = String(value).trim()` restored in
  // singleSchemaOfSearchPath(). Nothing throws at all — `<U+00A0>tenant` is silently reduced to
  // `tenant`, folds cleanly, and resolveDatabaseUrlSchema() returns a schema the URL did not name,
  // pinned into the options, handed to the Prisma adapter and reported aligned to all three raw
  // gates while the server resolves `<U+00A0>tenant`. Every assertion below fails.
  for (const [label, whitespace] of KEPT_BY_THE_SERVER) {
    // PRECONDITION: JavaScript really does consider it whitespace, and it really is non-ASCII.
    // Without these the test could pass against a character neither rule ever touched.
    assert.equal(`${whitespace}tenant`.trim(), 'tenant', `${label}: JavaScript's trim would strip it`)
    assert.ok(/[^\u0000-\u007F]/u.test(whitespace), `${label}: and it is non-ASCII, which is why it is refused`)

    for (const [position, value] of [
      ['leading', `${whitespace}tenant`],
      ['trailing', `tenant${whitespace}`],
    ] as [string, string][]) {
      assert.throws(
        () => resolveDatabaseUrlSchema(urlWithSearchPath(value)),
        (error: unknown) => {
          assert.ok(error instanceof DatabaseUrlSchemaConflictError, `${label} ${position}: refused, not resolved`)
          assert.match(
            (error as Error).message,
            /ONE BYTE AT A TIME/,
            `${label} ${position}: refused where the token boundary is decided, on the byte-level reason`,
          )
          return true
        },
      )
    }

    // AND THE FALSE AGREEMENT IS GONE. `?schema=tenant` and an options value naming `<ws>tenant`
    // are different schemas; under the second mutation both read as `tenant` and this URL resolved
    // happily instead of being refused.
    const both = new URL(urlWithSearchPath(`${whitespace}tenant`))
    both.searchParams.set('schema', 'tenant')
    assert.throws(() => resolveDatabaseUrlSchema(both.toString()), DatabaseUrlSchemaConflictError, label)
  }
})

test('o3d-2k5r r18: QUOTING does not rescue the character either, and it is the SAME refusal', () => {
  // ROUTE, both ways in: `?schema=<ws>tenant` -> resolveDatabaseUrlSchema()'s non-ASCII loop, and
  // `?options=-c search_path="<ws>tenant"` -> splitLibpqOptions()'s non-ASCII gate. Round 15 made
  // this the EXEMPTION — quoted, the character was carried whole and pinned. That rested on the
  // same byte-blind reading as the escape: the quotes are ASCII, the bytes between them are not,
  // and `pg_split_opts()` classifies those bytes with the deployment's own `LC_CTYPE` before any
  // quote has meaning. A token boundary inside the quoted name gives the server an unterminated
  // quote or a different schema — the failure the quoting was supposed to prevent.
  //
  // THE POINT OF THIS TEST IS THE SHARED JUSTIFICATION. Both doors are asserted to refuse, and
  // both are asserted to refuse for the same stated reason, so a future round cannot re-open one
  // of them without visibly contradicting the other.
  //
  // MUTATION: delete the `?schema=` non-ASCII loop from resolveDatabaseUrlSchema(). The first
  // assert.throws in each iteration fails while the second still passes — which is exactly the
  // split round 17 shipped, one door open and one shut, and is what this test exists to catch.
  //
  // SECOND MUTATION: delete the NON_ASCII_OPTION_CHARACTER branch from splitLibpqOptions() instead.
  // The second assert.throws fails and the quoted name resolves, restoring round 15's behaviour.
  for (const [label, whitespace] of KEPT_BY_THE_SERVER) {
    for (const [position, schema] of [
      ['leading', `${whitespace}tenant`],
      ['trailing', `tenant${whitespace}`],
    ] as [string, string][]) {
      // PRECONDITION, so neither assertion can pass by examining nothing: the name is non-ASCII,
      // and the identical ASCII spelling still round-trips through both doors untouched.
      assert.ok(/[^\u0000-\u007F]/u.test(schema), `${label} ${position}: the name under test is non-ASCII`)
      const asciiPin = pgConnectionConfig('postgresql://u:p@localhost:5432/ims?schema=tenant').options
      assert.equal(asciiPin, '-c search_path="tenant"', `${label} ${position}: the ASCII name still pins`)

      const messages: string[] = []
      // DOOR ONE: the name as `?schema=`, which would be EMITTED into an options string.
      assert.throws(
        () => pgConnectionConfig(`postgresql://u:p@localhost:5432/ims?schema=${encodeURIComponent(schema)}`),
        (error: unknown) => {
          assert.ok(error instanceof DatabaseUrlSchemaConflictError, `${label} ${position}: ?schema= refused`)
          messages.push((error as Error).message)
          return true
        },
      )

      // DOOR TWO: the same name already QUOTED inside an options string — round 15's exemption,
      // written exactly as round 15's emitter would have written it.
      const roundTrip = new URL('postgresql://u:p@localhost:5432/ims')
      roundTrip.searchParams.set('options', `-c search_path="${schema.replace(/[\\\s]/gu, '\\$&')}"`)
      assert.throws(
        () => resolveDatabaseUrlSchema(roundTrip.toString()),
        (error: unknown) => {
          assert.ok(error instanceof DatabaseUrlSchemaConflictError, `${label} ${position}: the quoted pin refused`)
          messages.push((error as Error).message)
          return true
        },
      )

      // AND THE TWO REFUSALS SAY THE SAME THING about why. Not merely both throwing: both resting
      // on the one sentence in NON_ASCII_JUSTIFICATION, which is what stops them drifting apart.
      assert.equal(messages.length, 2, `${label} ${position}: both doors refused`)
      for (const message of messages) {
        assert.match(message, /ONE BYTE AT A TIME/, `${label} ${position}: on the byte-level reason`)
        assert.match(message, /A BACKSLASH DOES NOT MAKE IT KNOWABLE/, `${label} ${position}: and says so about escaping`)
      }
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
        '../../lib/ops/production-preflight.ts',
      ].map(async (relative) => [relative, await readFile(new URL(relative, import.meta.url), 'utf8')] as const),
    ),
  )

  assert.match(sources['../../scripts/provision-instance.mjs'], /const config = pgConnectionConfig\(databaseUrl\)/)
  assert.match(sources['../../scripts/provision-instance.mjs'], /new Client\(\{ \.\.\.config \}\)/)
  assert.match(
    sources['../../scripts/provision-instance.mjs'],
    /const db = provisioningClient\(databaseUrl\)/,
    'and the bootstrap — the admin, the SMTP settings, the plaintext WooCommerce secret — goes through it',
  )
  assert.match(sources['../../scripts/check-stock-quantity-constraints.mjs'], /\.\.\.pgConnectionConfig\(databaseUrl\)/)
  assert.match(sources['../../scripts/check-wms-push-state-enum.mjs'], /\.\.\.pgConnectionConfig\(databaseUrl\)/)

  // AND EVERY RAW `pg.Client` PATH IS GUARDED (o3d-2k5r r22). A Pool gets the per-connection check
  // for free — `pgConnectionConfig()` returns it as `onConnect` and pg-pool awaits it — but
  // `pg.Client` has no such hook, and these three gates use one. A gate that reads its catalogue,
  // or a seeder that writes its rows, through a backend the deployment probe is not about is the
  // same finding wearing a different hat.
  //
  // MUTATION: drop `pinClientToMeasuredBackend` from any one of the three and the assertion fails
  // by name. The behavioural half is the live provisioningClient test further down; this is the
  // SWEEP, so a fourth gate added later cannot quietly skip it.
  for (const relative of [
    '../../scripts/provision-instance.mjs',
    '../../scripts/check-wms-push-state-enum.mjs',
    '../../lib/ops/production-preflight.ts',
  ]) {
    assert.match(
      sources[relative]!,
      /pinClientToMeasuredBackend\(new Client\(/,
      `${relative} builds its raw client through the per-connection backend guard`,
    )
  }

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

test('o3d-2k5r r18 (live): the REAL server carries the escaped character, and it is refused ANYWAY', async (t) => {
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

    // WHICH SERVER IS ANSWERING, recorded rather than assumed, because the whole finding is that
    // the answers below are a property of THIS encoding and THIS `LC_CTYPE` and not of the string.
    // A byte above 0x7F is classified by `isspace()` under the database's own ctype; here that is
    // the C locale, where nothing above 0x7F is space, which is precisely why every measurement in
    // this test comes out benign — and precisely why a benign measurement cannot license the
    // module to carry the character.
    const settings = await scratch.admin.query<{ enc: string; ctype: string }>(
      `select pg_encoding_to_char(encoding) as enc, datctype as ctype from pg_database where datname = current_database()`,
    )
    const { enc, ctype } = settings.rows[0]!
    assert.ok(enc && ctype, 'the server names its own encoding and ctype')

    // PRECONDITION — THE PREMISE OF SCANNER_WHITESPACE, ASKED OF THE SERVER rather than read out of
    // its source. This is `SplitIdentifierString()`/`scanner_isspace()` answering directly, with no
    // part of this module involved: set the GUC to the raw value and ask which schema it resolved.
    // It is a FIXED list, not the locale's, so unlike `pg_split_opts()` it is reproducible here —
    // which is why six characters can be trimmed with confidence and no byte above 0x7F can.
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
        // WHAT THE REFUSAL COSTS, MEASURED. The operator's own escaped value, sent to the REAL
        // server with this module entirely bypassed, reaches the backend whole and lands the write
        // in the schema they named. This configuration WORKS on `${enc}`/`${ctype}` today, and
        // round 18 refuses it regardless. Stating the cost is the point: the refusal is not a claim
        // that the server mis-handles the character, it is a claim that whether it does is set by
        // an encoding and an `LC_CTYPE` this module cannot ask about — and this host has no
        // single-byte non-ASCII locale installed to demonstrate the other answer with.
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
            `${label} ${position}: on THIS encoding and ctype the URL's own value writes into the schema carrying the character`,
          )
        } finally {
          await raw.end().catch(() => undefined)
        }

        // AND THAT IS A DIFFERENT SCHEMA FROM `tenant` — measured, not assumed. This is the gap a
        // Unicode `trim()` opened and the gap a mis-placed token boundary would open again: both
        // end with the pin naming `tenant`, whose writes land here instead.
        const trimmed: pg.Client = new pg.Client({ ...pgConnectionConfig(`${scratch.url}?schema=tenant`), connectionTimeoutMillis: 3_000 })
        await trimmed.connect()
        try {
          const key = `trimmed-${label}-${position}`
          await trimmed.query('insert into settings (key, value, "updatedAt") values ($1, $2, now())', [key, label])
          assert.deepEqual(
            await holders(key),
            ['tenant'],
            `${label} ${position}: the name a wrong boundary produces is a real, DIFFERENT schema`,
          )
        } finally {
          await trimmed.end().catch(() => undefined)
        }

        // ROUTE: `?options=-c search_path=\<ws>tenant` -> splitLibpqOptions(). REFUSED, escaped or
        // not, because the escape covers ONE BYTE and the rest of the character is classified by
        // the deployment's own `LC_CTYPE`.
        //
        // MUTATION: delete the NON_ASCII_OPTION_CHARACTER branch from splitLibpqOptions(). This
        // stops throwing and resolves — on round 15's path, to a refusal with a different message;
        // with `trim()` also restored, to `tenant`, the schema the two clients above just proved is
        // a DIFFERENT one. The assert.throws or the message assertion fails.
        const url = new URL(scratch.url)
        url.searchParams.set('options', `-c search_path=${escape(value)}`)
        assert.throws(
          () => pgConnectionConfig(url.toString()),
          (error: unknown) => {
            assert.ok(error instanceof DatabaseUrlSchemaConflictError, `${label} ${position}: refused`)
            assert.match((error as Error).message, /ONE BYTE AT A TIME/, `${label} ${position}: on the byte reason`)
            return true
          },
        )

        // AND QUOTED IT IS REFUSED TOO — the exemption round 15 measured on this very server is
        // gone. The quoted pin below is byte-for-byte what round 15's emitter produced and what
        // this test used to feed back through `splitLibpqOptions()` into a live connection.
        //
        // MUTATION: delete the `?schema=` non-ASCII loop from resolveDatabaseUrlSchema() and the
        // tokenizer branch. `pgConnectionConfig()` composes `-c search_path="<ws>tenant"` again,
        // the connection opens, `current_schema()` is the character-carrying name — and this
        // assertion fails, because the module is once more putting a byte on the wire whose token
        // boundary it cannot reproduce.
        assert.throws(
          () => pgConnectionConfig(`${scratch.url}?schema=${encodeURIComponent(value)}`),
          (error: unknown) => {
            assert.ok(error instanceof DatabaseUrlSchemaConflictError, `${label} ${position}: ?schema= refused`)
            assert.match((error as Error).message, /ONE BYTE AT A TIME/, `${label} ${position}: same justification`)
            return true
          },
        )

        // AND THE ASCII PATH STILL REACHES THE SERVER, so what has just been asserted is a refusal
        // of non-ASCII and not a broken pin. `tenant` is one of the schemas created above, so a
        // wrong answer here is visible rather than an error.
        const pinned: pg.Client = new pg.Client({
          ...pgConnectionConfig(`${scratch.url}?schema=tenant`),
          connectionTimeoutMillis: 3_000,
        })
        await pinned.connect()
        try {
          assert.equal(
            (await pinned.query<{ s: string }>('select current_schema() as s')).rows[0]?.s,
            'tenant',
            `${label} ${position}: an ASCII pin still resolves at the real server`,
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

// ---------------------------------------------------------------------------
// o3d-2k5r r19, Codex HIGH — THE REFUSAL THAT STRANDED A WORKING DEPLOYMENT.
//
// Round 18 rejected every non-ASCII `?schema=` before inspecting the deployment. The byte-level
// reasoning behind it is right and is asserted above and below, unchanged. What was wrong was that
// an installation ALREADY USING such a schema — quoted, exactly as docs/installation.md told it to
// — had no accepted `DATABASE_URL` left, because the adapter is composed at import: the
// application stopped booting and nothing said what to do instead.
//
// The boundary is a fact about the server's encoding and `LC_CTYPE`, so the server is asked. These
// exercise both answers with a fake client, so the two branches are deterministic and neither
// depends on which PostgreSQL happens to be reachable; the live section at the end runs the real
// probe against the real server.
// ---------------------------------------------------------------------------

/** A `pg.Client` stand-in that answers the probe's two queries however the case under test needs. */
function probeClient(recorder: { configs: object[] }, answers: (config: { options?: string }) => Record<string, unknown>) {
  return async (config: { options?: string }) => {
    recorder.configs.push(config)
    return {
      async connect() {
        return undefined
      },
      async query(text: string) {
        const row = answers(config)
        if (text.startsWith('select pg_encoding_to_char')) {
          return { rows: [{ server_encoding: row.server_encoding, lc_ctype: row.lc_ctype }] }
        }
        if (row.throws) throw new Error(String(row.throws))
        return { rows: [{ startup_option_probe: row.startup_option_probe }] }
      },
      async end() {
        return undefined
      },
    }
  }
}

/** The characters the probe was asked to carry, read back out of the startup options it sent. */
function probedSentinel(configs: Array<{ options?: string }>): string | undefined {
  const measured = configs.find((config) => typeof config.options === 'string')
  return measured?.options
}

test('o3d-2k5r r19: a Unicode schema is CARRIED on a server whose measured tokenizer keeps the bytes', async () => {
  resetStartupOptionByteSafety()
  const schema = 'ténant'
  const url = `postgresql://app:pw@db.internal:5432/ims?schema=${encodeURIComponent(schema)}`

  // PRECONDITION, so this cannot pass by examining nothing: the name really is non-ASCII, and with
  // no verdict established it really is refused — which is round 18's behaviour, unchanged.
  assert.equal(nonAsciiStartupOptionCharacters(url), 'é')
  assert.throws(() => resolveDatabaseUrlSchema(url), DatabaseUrlSchemaConflictError, 'unprobed, it is refused')

  const recorder = { configs: [] as object[] }
  const verdict = await establishStartupOptionByteSafety(url, {
    createClient: probeClient(recorder, (config) => ({
      server_encoding: 'UTF8',
      lc_ctype: 'C.UTF-8',
      // The server keeps every byte: it says back exactly what the startup options carried.
      startup_option_probe: /-c ims\.startup_option_probe=(.*)$/.exec(config.options ?? '')?.[1]?.replace(/\\(.)/g, '$1'),
    })),
  })

  // THE PROBE IS SANITISED, which is the half that makes it safe to run at all: its FIRST
  // connection carries no `options` and no `?schema=`, so not one byte whose boundary is in
  // question is in that startup packet.
  assert.equal(sanitisedProbeConnectionString(url), 'postgresql://app:pw@db.internal:5432/ims')
  assert.equal((recorder.configs[0] as { options?: string }).options, undefined, 'the first probe connection carries no startup options')
  assert.equal((recorder.configs[0] as { connectionString: string }).connectionString, 'postgresql://app:pw@db.internal:5432/ims')
  assert.match(String(probedSentinel(recorder.configs as Array<{ options?: string }>)), /ims\.startup_option_probe=/, 'and the second measures through a custom GUC, not application_name')

  assert.equal(verdict.established, true)
  assert.equal(verdict.carries, true)
  assert.equal(verdict.probed, 'é')
  assert.equal(verdict.serverEncoding, 'UTF8')
  assert.equal(verdict.lcCtype, 'C.UTF-8')
  assert.equal(startupOptionByteSafety().carries, true, 'and the verdict is what the module consults')

  // MUTATION ROUTE: drop `&& !nonAsciiOptionByteIsCarried(character, databaseUrl)` from the
  // `?schema=` loop in resolveDatabaseUrlSchema(). The refusal fires regardless of the measurement
  // and both assertions below throw — which is exactly the stranding Codex found.
  assert.equal(resolveDatabaseUrlSchema(url).schema, schema, 'the measured name is carried')
  assert.equal(pgConnectionConfig(url).options, `-c search_path=${'"ténant"'}`, 'and it is pinned in the spelling the probe measured')
  assert.deepEqual(prismaAdapterSchemaOptions(url), { schema }, 'and the adapter is given the same one')
  resetStartupOptionByteSafety()
})

test('o3d-2k5r r19: the same name on the same server is refused for a character the probe never measured', async () => {
  // The verdict is per-character because `isspace()` is a per-byte classification with no
  // adjacency: a character measured intact is intact wherever it appears, and one that was never
  // measured is not covered by a verdict about other ones.
  resetStartupOptionByteSafety()
  const probedUrl = 'postgresql://app:pw@db.internal:5432/ims?schema=' + encodeURIComponent('ténant')
  await establishStartupOptionByteSafety(probedUrl, {
    createClient: probeClient({ configs: [] }, (config) => ({
      server_encoding: 'UTF8',
      lc_ctype: 'C.UTF-8',
      startup_option_probe: /-c ims\.startup_option_probe=(.*)$/.exec(config.options ?? '')?.[1]?.replace(/\\(.)/g, '$1'),
    })),
  })
  assert.equal(resolveDatabaseUrlSchema(probedUrl).schema, 'ténant', 'precondition: the measured character is carried')

  // MUTATION ROUTE: delete the `verdict.probed.includes(character)` line from
  // nonAsciiOptionByteIsCarried(). U+2020 — never measured, and carrying the very byte (A0) the
  // whole finding is about — is carried on the strength of a measurement of U+00E9.
  const other = 'postgresql://app:pw@db.internal:5432/ims?schema=' + encodeURIComponent('ten†ant')
  assert.throws(
    () => resolveDatabaseUrlSchema(other),
    (error: unknown) => {
      assert.ok(error instanceof DatabaseUrlSchemaConflictError)
      assert.match((error as Error).message, /U\+2020/, 'and it names the character that was not measured')
      return true
    },
  )

  // And a verdict is about ONE server: the same name against a different host is not covered.
  const elsewhere = 'postgresql://app:pw@other.internal:5432/ims?schema=' + encodeURIComponent('ténant')
  assert.throws(() => resolveDatabaseUrlSchema(elsewhere), DatabaseUrlSchemaConflictError, 'a verdict is not transferable between servers')
  resetStartupOptionByteSafety()
})

test('o3d-2k5r r19: where the answer cannot be established the refusal names the alternative', async () => {
  resetStartupOptionByteSafety()
  const schema = 'ténant'
  const url = `postgresql://app:pw@db.internal:5432/ims?schema=${encodeURIComponent(schema)}`

  // THE SERVER ANSWERED, AND THE ANSWER IS NO: it did not return the bytes unchanged, which is
  // what a tokenizer that splits on them looks like when the connection survives at all.
  const changed = await establishStartupOptionByteSafety(url, {
    createClient: probeClient({ configs: [] }, () => ({
      server_encoding: 'LATIN1',
      lc_ctype: 'en_GB.ISO-8859-1',
      startup_option_probe: 'a',
    })),
  })
  assert.equal(changed.established, true)
  assert.equal(changed.carries, false)

  // MUTATION ROUTE: delete the `${nonAsciiUpgradePath()}` clause from nonAsciiRefusal(). Every
  // assertion below fails, and the operator is back to a refusal with no way out of it — which is
  // the finding.
  for (const [label, produce] of [
    ['?schema=', () => resolveDatabaseUrlSchema(url)],
    ['pgConnectionConfig', () => pgConnectionConfig(url)],
    ['options=', () => splitLibpqOptions(`-c search_path="${schema}"`)],
  ] as Array<[string, () => unknown]>) {
    assert.throws(
      produce,
      (error: unknown) => {
        assert.ok(error instanceof DatabaseUrlSchemaConflictError, `${label}: refused`)
        const message = (error as Error).message
        assert.match(message, /ONE BYTE AT A TIME/, `${label}: the byte-level reason is kept`)
        assert.match(message, /NOT A FLAT REFUSAL/, `${label}: and it says so`)
        assert.match(message, /establishStartupOptionByteSafety\(\)/, `${label}: it names the probe`)
        assert.match(message, /instrumentation\.ts/, `${label}: and where the probe runs`)
        assert.match(message, /check-wms-push-state-enum\.mjs/, `${label}: including before a deploy stops the old server`)
        assert.match(message, /ALTER SCHEMA "<current name>" RENAME TO <ascii_name>;/, `${label}: and the exact SQL for the other way out`)
        assert.match(message, /server_encoding=LATIN1/, `${label}: with what was actually measured`)
        assert.match(message, /lc_ctype=en_GB\.ISO-8859-1/, `${label}: including the ctype the boundary depends on`)
        return true
      },
      `${label}: an unsafe measurement must refuse`,
    )
  }

  // AND WHEN NOTHING COULD BE ASKED AT ALL, the refusal still says what to do — it just cannot
  // report a measurement.
  resetStartupOptionByteSafety()
  const unreachable = await establishStartupOptionByteSafety(url, {
    createClient: async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.1:5432')
    },
  })
  assert.equal(unreachable.established, false, 'an unreachable server is not an answer either way')
  assert.match(unreachable.reason, /could not reach the server/)
  assert.throws(
    () => resolveDatabaseUrlSchema(url),
    (error: unknown) => {
      const message = (error as Error).message
      assert.match(message, /ALTER SCHEMA "<current name>" RENAME TO <ascii_name>;/, 'the rename procedure is offered whether or not the server answered')
      assert.match(message, /could not reach the server/, 'and the reason it could not be established is quoted')
      return true
    },
  )

  // The probe NEVER throws out of a boot path: an unreachable database must not be an exception
  // from instrumentation.ts, only a verdict that refuses with a reason.
  //
  // MUTATION ROUTE: let the `createClient` rejection propagate instead of settling a verdict.
  assert.ok(true)
  resetStartupOptionByteSafety()
})

// ---------------------------------------------------------------------------
// o3d-2k5r r21, Codex HIGH — ONE BACKEND'S VERDICT MUST NOT LICENSE THE ENDPOINT.
//
// `db.internal:5432/ims` is a LOGICAL endpoint. A pooler, a TCP load balancer, a DNS name with
// several A records or a failover pair can all serve the probe from one PostgreSQL and the
// application's pool from another — and the permission earned by measuring the first is then spent
// emitting a non-ASCII startup option at the second. The stand-in below is that topology: the same
// connection string, a different backend on each connection.
// ---------------------------------------------------------------------------

/**
 * A `pg.Client` stand-in whose connections are served by the backends in `backends`, in order and
 * then repeating. Each entry is one physical server's answer to the identity query.
 */
function fanOutClient(
  backends: ReadonlyArray<Record<string, unknown>>,
  probeAnswer: (config: { options?: string }) => unknown = (config) =>
    /-c ims\.startup_option_probe=(.*)$/.exec(config.options ?? '')?.[1]?.replace(/\\(.)/g, '$1'),
) {
  let opened = 0
  return async (config: { options?: string }) => {
    const backend = backends[opened % backends.length]!
    opened += 1
    return {
      async connect() {
        return undefined
      },
      async query(text: string) {
        if (text.startsWith('select pg_encoding_to_char')) return { rows: [{ ...backend }] }
        return { rows: [{ startup_option_probe: probeAnswer(config) }] }
      },
      async end() {
        return undefined
      },
    }
  }
}

const ONE_BACKEND = {
  server_encoding: 'UTF8',
  lc_ctype: 'C.UTF-8',
  backend_address: '10.0.0.11',
  backend_port: '5432',
  server_version: '17.11',
}

test('o3d-2k5r r21: a positive verdict NAMES the backend that gave it', async () => {
  resetStartupOptionByteSafety()
  const url = `postgresql://app:pw@db.internal:5432/ims?schema=${encodeURIComponent('ténant')}`

  // PRECONDITION: unprobed it is refused, so what follows is a lift.
  assert.throws(() => pgConnectionConfig(url), DatabaseUrlSchemaConflictError, 'unprobed, it is refused')

  const verdict = await establishStartupOptionByteSafety(url, { createClient: fanOutClient([ONE_BACKEND]) })
  assert.equal(verdict.established, true)
  assert.equal(verdict.carries, true)
  // MUTATION ROUTE: drop `backend: distinct[0] ?? null` from the positive settle and this reads
  // null — a verdict that cannot say which server it is about.
  assert.equal(
    verdict.backend,
    '10.0.0.11:5432|17.11|UTF8|C.UTF-8',
    'the verdict records the physical backend every probe connection reached',
  )
  assert.match(verdict.reason, /which is the one backend every probe connection to this endpoint reached/)
  assert.equal(pgConnectionConfig(url).options, '-c search_path="ténant"', 'and the pin is granted')
  resetStartupOptionByteSafety()
})

test('o3d-2k5r r21: an endpoint that serves two different backends gets NO permission', async () => {
  resetStartupOptionByteSafety()
  const url = `postgresql://app:pw@db.internal:5432/ims?schema=${encodeURIComponent('ténant')}`

  // TWO SERVERS BEHIND ONE NAME, and both would answer the measurement the same way — that is the
  // point. The refusal is not because either of them failed; it is because a measurement made on
  // one of them says nothing about connections that land on the other.
  const second = { ...ONE_BACKEND, backend_address: '10.0.0.12' }

  // MUTATION ROUTE: delete the `distinct.length > 1` block from
  // establishStartupOptionByteSafety(). This endpoint then settles established/carries true — one
  // backend's answer licensing every connection behind the name — and the pgConnectionConfig
  // assertion below stops throwing. That is the shipped behaviour Codex found.
  const verdict = await establishStartupOptionByteSafety(url, {
    createClient: fanOutClient([ONE_BACKEND, second]),
  })
  assert.equal(verdict.established, false, 'a fanned-out endpoint settles nothing')
  assert.equal(verdict.carries, false)
  assert.equal(verdict.backend, null, 'and it names no backend, because there was not one')
  assert.match(verdict.reason, /did not answer as one server/)
  assert.match(verdict.reason, /10\.0\.0\.11/, 'the refusal names both backends it saw')
  assert.match(verdict.reason, /10\.0\.0\.12/)
  assert.throws(
    () => pgConnectionConfig(url),
    DatabaseUrlSchemaConflictError,
    'and the refusal stands: no permission is granted on one backend for connections that may reach another',
  )
  resetStartupOptionByteSafety()
})

test('o3d-2k5r r21: backends differing only in ENCODING are two backends for this question', async () => {
  resetStartupOptionByteSafety()
  const url = `postgresql://app:pw@db.internal:5432/ims?schema=${encodeURIComponent('ténant')}`

  // Same address, different encoding — a replica restored with another locale, or a pooler in
  // front of two clusters. The address is not the identity; the properties the measurement is
  // ABOUT are part of it, which is why `backendIdentityOf` carries them.
  //
  // MUTATION ROUTE: reduce `backendIdentityOf` to address and port only. These two samples then
  // compare equal, the verdict settles positive, and the LATIN1 backend is licensed by the UTF8
  // one's answer.
  const latin1 = { ...ONE_BACKEND, server_encoding: 'LATIN1', lc_ctype: 'en_US.ISO-8859-1' }
  const verdict = await establishStartupOptionByteSafety(url, {
    createClient: fanOutClient([ONE_BACKEND, latin1]),
  })
  assert.equal(verdict.established, false)
  assert.match(verdict.reason, /did not answer as one server/)
  assert.match(verdict.reason, /LATIN1/, 'and says which two answers it got')
  assert.throws(() => pgConnectionConfig(url), DatabaseUrlSchemaConflictError)
  resetStartupOptionByteSafety()
})

test('o3d-2k5r r21: fan-out does NOT block a REFUSAL — only a permission is bound to one backend', async () => {
  resetStartupOptionByteSafety()
  const url = `postgresql://app:pw@db.internal:5432/ims?schema=${encodeURIComponent('ténant')}`

  // THE ASYMMETRY, ASSERTED. A server that hands the bytes back CHANGED is an unsafe answer, and an
  // unsafe answer from any backend behind the endpoint is safe to apply to all of them — so the
  // measurement settles `carries: false` on its own merits and the agreement check never runs.
  // Without this the new rule would have turned a precise refusal ("this server alters the bytes")
  // into a vaguer one, and lost the measurement in the message the operator reads.
  //
  // MUTATION ROUTE: move the `distinct.length > 1` check above the `returned !== sentinel` branch
  // and this reason becomes the fan-out one, losing what was actually measured.
  const verdict = await establishStartupOptionByteSafety(url, {
    createClient: fanOutClient([ONE_BACKEND, { ...ONE_BACKEND, backend_address: '10.0.0.12' }], () => 'atenantz'),
  })
  assert.equal(verdict.established, true, 'the measurement is an answer, and it is a refusing one')
  assert.equal(verdict.carries, false)
  assert.match(verdict.reason, /did not return the probed characters unchanged/)
  assert.throws(() => pgConnectionConfig(url), DatabaseUrlSchemaConflictError)
  resetStartupOptionByteSafety()
})

test('o3d-2k5r r21: an endpoint whose SECOND connection cannot be opened settles nothing', async () => {
  resetStartupOptionByteSafety()
  const url = `postgresql://app:pw@db.internal:5432/ims?schema=${encodeURIComponent('ténant')}`

  // The independent sample is not optional. If it cannot be taken, whether this endpoint has one
  // backend or several is unknown — and unknown is the refusal, not a pass.
  //
  // MUTATION ROUTE: delete the second sanitised connection. This settles positive on one sample,
  // which is exactly the evidence Codex said was too thin.
  let opened = 0
  const verdict = await establishStartupOptionByteSafety(url, {
    createClient: async () => {
      opened += 1
      if (opened > 1) throw new Error('connect ECONNREFUSED 10.0.0.12:5432')
      return {
        async connect() {
          return undefined
        },
        async query() {
          return { rows: [{ ...ONE_BACKEND }] }
        },
        async end() {
          return undefined
        },
      }
    },
  })
  assert.equal(verdict.established, false)
  assert.match(verdict.reason, /whether it has one backend or several is unknown/)
  assert.throws(() => pgConnectionConfig(url), DatabaseUrlSchemaConflictError)
  resetStartupOptionByteSafety()
})

test('o3d-2k5r r19: an ASCII URL settles without opening a connection at all', async () => {
  resetStartupOptionByteSafety()
  const url = 'postgresql://app:pw@db.internal:5432/ims?schema=ims_app'
  assert.equal(nonAsciiStartupOptionCharacters(url), '', 'nothing to measure')

  // MUTATION ROUTE: delete the `probed === ''` short circuit from
  // establishStartupOptionByteSafety(). The createClient below is called and throws, so the
  // verdict comes back unestablished and this fails — which is the cost every ordinary deployment
  // would pay at startup.
  const verdict = await establishStartupOptionByteSafety(url, {
    createClient: async () => {
      throw new Error('the probe must not connect for an ASCII URL')
    },
  })
  assert.equal(verdict.established, true)
  assert.equal(verdict.carries, true)
  assert.equal(verdict.probed, '')
  assert.equal(resolveDatabaseUrlSchema(url).schema, 'ims_app')
  resetStartupOptionByteSafety()
})

test('o3d-2k5r r19 (live): the REAL server settles the boundary, and the pin it licenses reaches it', async (t) => {
  const scratch = await openScratch(t)
  if (!scratch) return
  resetStartupOptionByteSafety()
  try {
    const schema = 'ten\u00A0ant' // U+00A0, written as an escape so it cannot be mistaken for a space
    await scratch.admin.query(`CREATE SCHEMA ${'"' + schema + '"'}`)
    await scratch.admin.query(`CREATE TABLE ${'"' + schema + '"'}.settings (key text primary key, value text, "updatedAt" timestamptz)`)

    const url = `${scratch.url}?schema=${encodeURIComponent(schema)}`

    // PRECONDITION: with no verdict, this is round 18's refusal — so what follows is a lift and
    // not a test of a gate that was never closed.
    assert.throws(() => pgConnectionConfig(url), DatabaseUrlSchemaConflictError, 'unprobed, the URL is refused')

    // THE REAL PROBE, against the real server, with no fake client anywhere.
    const verdict = await establishStartupOptionByteSafety(url)
    assert.equal(verdict.probed, '\u00A0', 'it measured the character in the name')
    assert.ok(verdict.serverEncoding, `and recorded the encoding the boundary depends on: ${verdict.serverEncoding}/${verdict.lcCtype}`)

    if (!verdict.carries) {
      // A server that genuinely cannot carry it: the refusal must still stand, with the reason.
      assert.throws(
        () => pgConnectionConfig(url),
        (error: unknown) => {
          assert.match((error as Error).message, /ALTER SCHEMA "<current name>" RENAME TO <ascii_name>;/)
          return true
        },
      )
      return
    }

    // MUTATION ROUTE: make nonAsciiOptionByteIsCarried() return false unconditionally (round 18's
    // behaviour). pgConnectionConfig() throws and this assertion never gets to the server — which
    // is the stranding: this DATABASE_URL works here and had no accepted spelling.
    const client: pg.Client = new pg.Client({ ...pgConnectionConfig(url), connectionTimeoutMillis: 3_000 })
    await client.connect()
    try {
      assert.equal(
        (await client.query<{ s: string }>('select current_schema() as s')).rows[0]?.s,
        schema,
        'the pin the measurement licensed resolves at the real server, in the schema the URL named',
      )
      // And a write through it lands there rather than in public — the split this module exists to stop.
      await client.query('insert into settings (key, value, "updatedAt") values ($1, $2, now())', ['r19', 'live'])
      const landed = await scratch.admin.query(`select 1 from ${'"' + schema + '"'}.settings where key = 'r19'`)
      assert.equal(landed.rowCount, 1, 'and the write lands in the measured schema')
    } finally {
      await client.end().catch(() => undefined)
    }
  } finally {
    resetStartupOptionByteSafety()
    await scratch.drop()
  }
})

// ---------------------------------------------------------------------------
// o3d-2k5r r22, Codex HIGH — A RECORDED BACKEND THAT NOTHING READS IS NOT A CHECK.
//
// Round 21 bound a positive verdict to the backend that answered it, recorded that identity on the
// verdict, and then handed the permission out by logical host/port/database anyway. Three agreeing
// probe samples are evidence of one backend, never a census of one — over two equally-selected
// members all three land on the same one 12.5% of boots — so the permission still reached every
// backend behind the endpoint, only less often wrongly.
//
// The correction is that the verdict is now SPENT per connection. `pgConnectionConfig()` returns an
// `onConnect` hook whenever the composed `options` carries a licensed non-ASCII byte; `pg-pool`
// awaits it for every NEW PHYSICAL connection before the client is handed to anyone, and it asks
// the backend that just answered who it is and what search path it ended up with.
//
// The stand-in below is the connection that hook is handed.
// ---------------------------------------------------------------------------

/** A connection the guard can interrogate: one backend's identity and one effective search path. */
function servedConnection(backend: Record<string, unknown>, searchPath: string) {
  const asked: string[] = []
  return {
    asked,
    async query(text: string) {
      asked.push(text)
      return { rows: [{ ...backend, search_path: searchPath }] }
    },
  }
}

const ONE_BACKEND_IDENTITY = '10.0.0.11:5432|17.11|UTF8|C.UTF-8'
const R22_URL = `postgresql://app:pw@db.internal:5432/ims?schema=${encodeURIComponent('ténant')}`

test('o3d-2k5r r22: a connection served by a backend the verdict is NOT about is refused', async () => {
  resetStartupOptionByteSafety()
  try {
    // ROUTE: establishStartupOptionByteSafety() -> the verdict's `backend` -> pgConnectionConfig()'s
    // `onConnect` -> pg-pool's per-physical-connection hook -> this call.
    const verdict = await establishStartupOptionByteSafety(R22_URL, { createClient: fanOutClient([ONE_BACKEND]) })
    assert.equal(verdict.backend, ONE_BACKEND_IDENTITY, 'PRECONDITION: the probe measured one backend and named it')

    const config = pgConnectionConfig(R22_URL)
    assert.equal(typeof config.onConnect, 'function', 'PRECONDITION: a licensed non-ASCII pin carries a per-connection guard')
    const onConnect = config.onConnect!

    // THE MEASURED BACKEND STILL CONNECTS. Without this half the guard could be a blanket refusal
    // and every assertion below would pass on a gate that strands the deployment it exists to allow.
    const good = servedConnection(ONE_BACKEND, '"ténant"')
    await onConnect(good)
    assert.equal(good.asked.length, 1, 'and it costs exactly one round trip on a new physical connection')
    assert.match(good.asked[0]!, /^select pg_encoding_to_char/)
    assert.match(good.asked[0]!, /current_setting\('search_path'\) as search_path/, 'which asks BOTH questions at once')

    // AND THE OTHER BACKEND BEHIND THE SAME ENDPOINT DOES NOT. This is the connection Codex's
    // finding is about: the probe's three samples all landed on 10.0.0.11 and the application pool
    // opened this one.
    //
    // MUTATION ROUTE: delete the `served !== verdict.backend` block from
    // startupOptionBackendGuard(). This connection is then admitted — a startup option measured on
    // one server carried to another, which is the shipped r21 behaviour.
    const other = { ...ONE_BACKEND, backend_address: '10.0.0.12' }
    await assert.rejects(
      () => onConnect(servedConnection(other, '"ténant"')),
      (error: unknown) => {
        assert.ok(error instanceof DatabaseUrlSchemaConflictError, 'it is the module\'s own refusal, not a driver error')
        const message = (error as Error).message
        assert.match(message, /10\.0\.0\.12/, 'the refusal names the backend that served this connection')
        assert.match(message, /10\.0\.0\.11/, 'and the one the verdict was measured on')
        assert.match(message, /refused before it can run a query/)
        assert.match(message, /ALTER SCHEMA "<current name>" RENAME TO <ascii_name>;/, 'and it still offers the rename')
        return true
      },
    )
  } finally {
    resetStartupOptionByteSafety()
  }
})

test('o3d-2k5r r22: the MEASURED backend is refused too when the pin did not survive it', async () => {
  resetStartupOptionByteSafety()
  try {
    await establishStartupOptionByteSafety(R22_URL, { createClient: fanOutClient([ONE_BACKEND]) })
    const onConnect = pgConnectionConfig(R22_URL).onConnect!

    // The identity matches; the startup option did not arrive as written. That is the narrow
    // dangerous class — a backend that ACCEPTS the packet and tokenises it differently — and it is
    // silent cross-schema access, not a failed connection.
    //
    // MUTATION ROUTE: delete the `searchPath !== expectedSearchPath` block. The connection is then
    // admitted while resolving `tenant` instead of `ténant`, which is the o3d-1izw split.
    await assert.rejects(
      () => onConnect(servedConnection(ONE_BACKEND, '"tenant"')),
      (error: unknown) => {
        const message = (error as Error).message
        assert.match(message, /search_path came back as/)
        assert.match(message, /"\\"tenant\\""/, 'it quotes what came back')
        assert.match(message, /"\\"ténant\\""/, 'and what was written')
        return true
      },
    )
  } finally {
    resetStartupOptionByteSafety()
  }
})

test('o3d-2k5r r22: the guard reads the verdict at CONNECT time, not at config time', async () => {
  resetStartupOptionByteSafety()
  try {
    await establishStartupOptionByteSafety(R22_URL, { createClient: fanOutClient([ONE_BACKEND]) })
    const onConnect = pgConnectionConfig(R22_URL).onConnect!

    // The config object outlives the verdict that licensed it — a pool is built once and opens
    // connections for the life of the process. A hook that closed over the verdict at config time
    // would keep granting on a permission the process no longer holds.
    //
    // MUTATION ROUTE: hoist `heldStartupOptionByteVerdict()` out of the returned closure into
    // startupOptionBackendGuard()'s body. This connection is then admitted on a verdict that has
    // been withdrawn.
    resetStartupOptionByteSafety()
    await assert.rejects(
      () => onConnect(servedConnection(ONE_BACKEND, '"ténant"')),
      (error: unknown) => {
        assert.match((error as Error).message, /No positive verdict naming a backend is held by this process/)
        return true
      },
    )
  } finally {
    resetStartupOptionByteSafety()
  }
})

test('o3d-2k5r r22: a positive verdict that names NO backend grants nothing', async () => {
  // The consumer must READ what the verdict records. A record no decision consults is worse than no
  // record at all, because it reads as a check.
  const slot = Symbol.for('ims.db.startupOptionByteVerdict.v2')
  const globals = globalThis as unknown as Record<symbol, unknown>
  resetStartupOptionByteSafety()
  try {
    // Well-shaped — `isStartupOptionByteVerdict()` accepts it — established, carrying, about this
    // very target, and naming no server. Nothing downstream could hold a connection to it.
    //
    // MUTATION ROUTE: delete the `verdict.backend === null || verdict.backend === ''` line from
    // nonAsciiOptionByteIsCarried(). pgConnectionConfig() then composes the pin from a permission
    // that is enforceable nowhere, and this assertion stops throwing.
    globals[slot] = Object.freeze({
      established: true,
      carries: true,
      probed: 'é',
      target: 'db.internal:5432/ims',
      backend: null,
      serverEncoding: 'UTF8',
      lcCtype: 'C.UTF-8',
      reason: 'a verdict that names no server',
    })
    assert.equal(startupOptionByteSafety().carries, true, 'PRECONDITION: the planted verdict IS positive and IS read back')
    assert.equal(startupOptionByteSafety().backend, null, 'PRECONDITION: and it names no backend')
    assert.throws(
      () => pgConnectionConfig(R22_URL),
      DatabaseUrlSchemaConflictError,
      'a permission nothing can be held to is no permission',
    )
  } finally {
    delete globals[slot]
    resetStartupOptionByteSafety()
  }
})

test('o3d-2k5r r22: an ASCII schema pays nothing — no verdict, no hook, no round trip', () => {
  resetStartupOptionByteSafety()
  // The cost of this mechanism is bounded by the case it is for. An `options` made of ASCII needs
  // no verdict, so it gets no guard and no per-connection query.
  //
  // MUTATION ROUTE: drop the `NON_ASCII_OPTION_CHARACTER.test(options)` early return from
  // startupOptionBackendGuard(). Every deployment then pays a round trip per physical connection
  // AND is refused outright, because no ASCII deployment ever probes and so none names a backend.
  const config = pgConnectionConfig('postgresql://app:pw@db.internal:5432/ims?schema=tenant_a')
  assert.equal(config.options, '-c search_path="tenant_a"', 'PRECONDITION: the pin is still composed')
  assert.equal(config.onConnect, undefined, 'and nothing is attached to the connections it opens')
})

test('o3d-2k5r r22 (live): the REAL pool admits the measured backend and refuses another', async (t) => {
  const scratch = await openScratch(t)
  if (!scratch) return
  resetStartupOptionByteSafety()
  const pools: pg.Pool[] = []
  try {
    const schema = 'ten\u00A0ant' // U+00A0, written as an escape, as in the r19 live test
    await scratch.admin.query(`CREATE SCHEMA ${'"' + schema + '"'}`)
    const url = `${scratch.url}?schema=${encodeURIComponent(schema)}`

    const verdict = await establishStartupOptionByteSafety(url)
    if (!verdict.carries) {
      t.skip('this server does not carry the byte, so there is no permission to hold to a backend')
      return
    }
    assert.ok(verdict.backend, 'PRECONDITION: the real probe named the real backend')

    // ROUTE: pgConnectionConfig() -> pg.Pool's own config -> pg-pool's onConnect -> the guard. The
    // config is composed ONCE, exactly as lib/db/index.ts composes the runtime pool's.
    const config = pgConnectionConfig(url)
    assert.equal(typeof config.onConnect, 'function')

    // 1. THE MEASURED BACKEND CONNECTS, through the real pool, and lands on the pinned schema.
    const admitted = new pg.Pool({ ...config, max: 1, connectionTimeoutMillis: 3_000 })
    pools.push(admitted)
    const client = await admitted.connect()
    try {
      assert.equal(
        (await client.query<{ s: string }>('select current_schema() as s')).rows[0]?.s,
        schema,
        'the connection the guard admitted is on the schema the URL named',
      )
    } finally {
      client.release()
    }

    // 2. NOW THE ENDPOINT HANDS OUT A DIFFERENT BACKEND. The verdict is re-established against a
    // stand-in that answers as another server — which is precisely a failover, a re-pointed pooler,
    // or the member the three probe samples happened not to reach — while the config, the
    // connection string and the real server on the other end are all unchanged.
    //
    // MUTATION ROUTE: stop returning `onConnect` from pgConnectionConfig(). The pool below then
    // opens its connection and hands it over, and the non-ASCII startup option measured on one
    // server is spent on another. That is the finding.
    await establishStartupOptionByteSafety(url, { createClient: fanOutClient([ONE_BACKEND]) })
    const refused = new pg.Pool({ ...config, max: 1, connectionTimeoutMillis: 3_000 })
    pools.push(refused)
    await assert.rejects(
      // Released if it RESOLVES, because under the mutation route below it does — and a checked-out
      // client that is never released makes `pool.end()` in the `finally` wait forever, which turns
      // a failing assertion into a hung run that reports nothing.
      async () => {
        const leaked = await refused.connect()
        leaked.release()
      },
      (error: unknown) => {
        assert.ok(error instanceof DatabaseUrlSchemaConflictError)
        assert.match((error as Error).message, /10\.0\.0\.11:5432/, 'the refusal names the backend the verdict is about')
        assert.match((error as Error).message, /handed the application a different backend/)
        return true
      },
      'a real pg pool refuses a physical connection to a backend the verdict is not about',
    )
    assert.equal(refused.totalCount, 0, 'and the refused connection is not left in the pool')

    // 3. AND IT IS THE POOL, NOT ONLY `connect()`: a query routed through it fails the same way.
    await assert.rejects(() => refused.query('select 1'), DatabaseUrlSchemaConflictError)
  } finally {
    resetStartupOptionByteSafety()
    for (const pool of pools) await pool.end().catch(() => undefined)
    await scratch.drop()
  }
})

test('o3d-2k5r r22: a raw pg.Client is guarded through connect(), and ended when it is refused', async () => {
  resetStartupOptionByteSafety()
  try {
    await establishStartupOptionByteSafety(R22_URL, { createClient: fanOutClient([ONE_BACKEND]) })
    const config = pgConnectionConfig(R22_URL)

    /** A `pg.Client` stand-in: one backend's answers, and a record of whether it was ended. */
    const rawClient = (backend: Record<string, unknown>, searchPath: string) => {
      const state = { connected: false, ended: false }
      const client = {
        state,
        async connect() {
          state.connected = true
          return undefined
        },
        async end() {
          state.ended = true
          return undefined
        },
        async query() {
          return { rows: [{ ...backend, search_path: searchPath }] }
        },
      }
      return client
    }

    // THE MEASURED BACKEND: connect() resolves and the client is left open for its caller.
    const good = pinClientToMeasuredBackend(rawClient(ONE_BACKEND, '"ténant"'), config)
    await good.connect()
    assert.equal(good.state.connected, true)
    assert.equal(good.state.ended, false, 'a client that passed the check is not ended under its caller')

    // ANOTHER BACKEND BEHIND THE SAME ENDPOINT: connect() rejects, and the socket is not left behind.
    //
    // MUTATION ROUTE: return `client` unchanged from pinClientToMeasuredBackend() (which is what
    // shipping only the Pool hook would leave behind). The three out-of-process gates then read
    // their catalogue — and the seeder writes its rows — through an unmeasured backend, which is
    // the o3d-1izw split arriving through the gates that exist to prevent it.
    const bad = pinClientToMeasuredBackend(rawClient({ ...ONE_BACKEND, backend_address: '10.0.0.12' }, '"ténant"'), config)
    await assert.rejects(
      () => bad.connect(),
      (error: unknown) => {
        assert.ok(error instanceof DatabaseUrlSchemaConflictError)
        assert.match((error as Error).message, /10\.0\.0\.12/)
        return true
      },
    )
    assert.equal(bad.state.ended, true, 'and the refused client is ended rather than left dangling')

    // THE CALLBACK FORM IS REFUSED RATHER THAN HALF-GUARDED.
    const callbackForm = pinClientToMeasuredBackend(rawClient(ONE_BACKEND, '"ténant"'), config)
    await assert.rejects(
      () => (callbackForm.connect as (cb: unknown) => Promise<unknown>)(() => undefined),
      /connect\(callback\) is not supported/,
    )

    // AND AN ASCII DEPLOYMENT IS NOT WRAPPED AT ALL — no guard, so nothing to wrap.
    //
    // MUTATION ROUTE: drop the `if (!guard) return client` early return. Every ASCII client then
    // carries a wrapper that refuses everything, because no ASCII deployment ever probes.
    const asciiConfig = pgConnectionConfig('postgresql://app:pw@db.internal:5432/ims?schema=tenant_a')
    const plain = rawClient(ONE_BACKEND, '"tenant_a"')
    const before = plain.connect
    assert.equal(pinClientToMeasuredBackend(plain, asciiConfig).connect, before, 'the ASCII client is handed back untouched')
  } finally {
    resetStartupOptionByteSafety()
  }
})

test('o3d-2k5r r22 (live): the provisioning seeder refuses a backend the verdict is not about', async (t) => {
  const scratch = await openScratch(t)
  if (!scratch) return
  resetStartupOptionByteSafety()
  try {
    const schema = 'ten\u00A0ant' // U+00A0, written as an escape, as in the r19 live test
    await scratch.admin.query(`CREATE SCHEMA ${'"' + schema + '"'}`)
    const url = `${scratch.url}?schema=${encodeURIComponent(schema)}`

    const verdict = await establishStartupOptionByteSafety(url)
    if (!verdict.carries) {
      t.skip('this server does not carry the byte, so there is no permission to hold to a backend')
      return
    }

    // 1. THE MEASURED BACKEND: the seeder's own client connects and lands on the pinned schema.
    const admitted = provisioningClient(url)
    try {
      await admitted.connect()
      assert.equal(
        (await admitted.query<{ s: string }>('select current_schema() as s')).rows[0]?.s,
        schema,
        'the seeder is on the schema the URL named',
      )
    } finally {
      await admitted.end().catch(() => undefined)
    }

    // 2. THE ENDPOINT NOW HANDS OUT ANOTHER BACKEND. Same server on the wire; the verdict is about
    // a different one. The seeder must not write a row through it.
    //
    // MUTATION ROUTE: drop `pinClientToMeasuredBackend` from provisioningClient(). This connect()
    // resolves, and the installer seeds an admin, an SMTP password and a WooCommerce secret into a
    // schema resolved by a server nothing measured.
    await establishStartupOptionByteSafety(url, { createClient: fanOutClient([ONE_BACKEND]) })
    const refused = provisioningClient(url)
    try {
      await assert.rejects(
        () => refused.connect(),
        (error: unknown) => {
          assert.ok(error instanceof DatabaseUrlSchemaConflictError)
          assert.match((error as Error).message, /10\.0\.0\.11:5432/)
          return true
        },
        'the real seeder client refuses a backend the verdict is not about',
      )
    } finally {
      await refused.end().catch(() => undefined)
    }
  } finally {
    resetStartupOptionByteSafety()
    await scratch.drop()
  }
})

// ---------------------------------------------------------------------------
// o3d-2k5r r23, Codex HIGH — A CLIENT SOCKET IS NOT A SERVER BACKEND.
//
// r22 put the check on `onConnect`, which pg-pool awaits once per NEW PHYSICAL CONNECTION and
// deliberately never on reuse. Under a transaction- or statement-pooling proxy one client socket is
// many server backends over its life, so the guard runs on A and the application's next statement
// runs on B with no new pg client created and therefore no second check. The tests below are about
// the answer chosen for that: a connection that cannot be shown to reach the backend DIRECTLY may
// not carry licensed non-ASCII bytes at all.
//
// WHY REFUSING COSTS NOTHING THAT WORKED — measured, against PgBouncer 1.24.1 in front of
// PostgreSQL 17.11 with a schema named `tënant` that a direct connection pins correctly:
//   * default configuration, `pool_mode = transaction` AND `pool_mode = session`: the pooler refuses
//     the connection outright with `FATAL: unsupported startup parameter in options: search_path`;
//   * `ignore_startup_parameters = search_path` or `track_extra_parameters = search_path`: the
//     connection is accepted and the option is DISCARDED — `current_setting('search_path')` came
//     back `"$user", public` on five consecutive connections and the query resolved
//     `public.marker`. `-c statement_timeout=1234` sent the same way returned `1234ms` direct and
//     `0` through the pooler, so no startup `options` content reaches the backend at all.
// A non-ASCII schema behind a pooler was therefore already broken, silently. See the block comment
// over `interposedConnectionRefusal()` in lib/db/database-url-schema.mjs.
// ---------------------------------------------------------------------------

/**
 * A `pg.Client` stand-in that reports its own socket AND what the backend says it sees, so the
 * peer comparison has both halves to compare. `servedConnection()` above has neither, which is why
 * it is admitted by this leg — an answer that carries no peer is unanswerable, not wrong.
 */
function servedOverSocket(options: {
  backend: Record<string, unknown>
  searchPath: string
  /** Our end of the socket, as node reports it. */
  ourPort: number
  ourAddress?: string
  /** What the backend says its client is. Equal to ours on a direct connection. */
  backendSeesPort: string
  backendSeesAddress?: string
  /** Answers to any query that is not the guard's — i.e. the consumer's. */
  onConsumerQuery?: (text: string) => { rows: Array<Record<string, unknown>> }
}) {
  const asked: string[] = []
  return {
    asked,
    connection: { stream: { localAddress: options.ourAddress ?? '10.9.9.9', localPort: options.ourPort } },
    async query(text: string) {
      asked.push(text)
      if (text.startsWith('select pg_encoding_to_char')) {
        return {
          rows: [{
            ...options.backend,
            search_path: options.searchPath,
            client_address: options.backendSeesAddress ?? '10.9.9.9',
            client_port: options.backendSeesPort,
          }],
        }
      }
      return options.onConsumerQuery?.(text) ?? { rows: [] }
    },
  }
}

test('o3d-2k5r r23: the guard reaches backend A, the consumer would reach backend B — and never does', async () => {
  resetStartupOptionByteSafety()
  try {
    // ROUTE: establishStartupOptionByteSafety() -> the verdict's `backend` -> pgConnectionConfig()'s
    // `onConnect` -> pg-pool's per-physical-connection hook -> interposedConnectionRefusal().
    await establishStartupOptionByteSafety(R22_URL, { createClient: fanOutClient([ONE_BACKEND]) })
    const onConnect = pgConnectionConfig(R22_URL).onConnect!

    // THE MULTIPLEXED TOPOLOGY, exactly as Codex states it. The guard's query is answered by the
    // measured backend A, with the pin intact — both r22 legs pass — because that is what a proxy
    // that forwards the startup packet looks like at connect time. The consumer's query would be
    // answered by a DIFFERENT backend B, because between the two the proxy re-assigned the server
    // side. The only thing that distinguishes this connection from a direct one is that the backend
    // does not see OUR socket: 55001 is the proxy's port to the server, 41000 is ours to the proxy.
    let consumerRanOn: string | null = null
    const multiplexed = servedOverSocket({
      backend: ONE_BACKEND,
      searchPath: '"ténant"',
      ourPort: 41000,
      ourAddress: '10.9.9.9',
      backendSeesPort: '55001',
      backendSeesAddress: '10.0.0.250',
      onConsumerQuery: () => {
        consumerRanOn = 'backend B'
        return { rows: [{ current_schema: 'public' }] }
      },
    })

    // MUTATION ROUTE: delete the `interposedConnectionRefusal(client, row)` call from
    // startupOptionBackendGuard(). Both remaining legs pass — the identity IS the measured backend
    // and the search_path IS the pin — so the connection is admitted, `consumerRanOn` becomes
    // 'backend B', and the licensed bytes are spent on a server nothing measured. That is the
    // finding, in the smallest form it can be stated.
    await assert.rejects(
      () => onConnect(multiplexed),
      (error: unknown) => {
        assert.ok(error instanceof DatabaseUrlSchemaConflictError)
        assert.match((error as Error).message, /"10\.0\.0\.250:55001"/, 'the refusal names what the backend sees')
        assert.match((error as Error).message, /"10\.9\.9\.9:41000"/, 'and what this process actually holds')
        assert.match((error as Error).message, /terminated the connection and opened its own/)
        return true
      },
      'a connection whose far end is not ours may not carry licensed bytes',
    )
    assert.equal(consumerRanOn, null, 'and the consumer statement never reached backend B')
    assert.equal(multiplexed.asked.length, 1, 'the refusal costs the same one round trip, and no more')
  } finally {
    resetStartupOptionByteSafety()
  }
})

test('o3d-2k5r r23: a direct connection is admitted, and an absent peer is not treated as a wrong one', async () => {
  resetStartupOptionByteSafety()
  try {
    await establishStartupOptionByteSafety(R22_URL, { createClient: fanOutClient([ONE_BACKEND]) })
    const onConnect = pgConnectionConfig(R22_URL).onConnect!

    // 1. DIRECT: the backend's client IS this process's socket, so the leg passes. Without this
    // half the test above would pass on a blanket refusal that strands every deployment.
    //
    // MUTATION ROUTE: compare `ours.port` against `backendSees.address`, or drop the `-1`/''
    // early return so every answer is compared. Either turns this into a refusal and no non-ASCII
    // deployment can open a connection at all.
    await onConnect(servedOverSocket({
      backend: ONE_BACKEND,
      searchPath: '"ténant"',
      ourPort: 41000,
      ourAddress: '10.9.9.9',
      backendSeesPort: '41000',
      backendSeesAddress: '10.9.9.9',
    }))

    // 2. IPv4-MAPPED IPv6: node says `::ffff:10.9.9.9` for the same socket PostgreSQL's `host()`
    // spells `10.9.9.9`. Two spellings of one address are not two addresses.
    //
    // MUTATION ROUTE: drop the `::ffff:` strip from normalisedPeerAddress(). Every dual-stack
    // deployment with a non-ASCII schema is then refused as though a pooler were in the path.
    await onConnect(servedOverSocket({
      backend: ONE_BACKEND,
      searchPath: '"ténant"',
      ourPort: 41000,
      ourAddress: '::ffff:10.9.9.9',
      backendSeesPort: '41000',
      backendSeesAddress: '10.9.9.9',
    }))

    // 3. UNIX SOCKET: the backend reports no peer at all (`client_addr` NULL, `client_port` -1).
    // That is an unanswerable question, not a failed comparison, and it is SKIPPED — the
    // `search_path` leg is what covers that case, and the measurements above show it refuses every
    // real pooler because the pin never arrives. Recorded as a residue, not claimed closed.
    await onConnect(servedOverSocket({
      backend: ONE_BACKEND,
      searchPath: '"ténant"',
      ourPort: 41000,
      backendSeesPort: '-1',
      backendSeesAddress: '',
    }))
  } finally {
    resetStartupOptionByteSafety()
  }
})

test('o3d-2k5r r23: a TCP peer the backend reports that this process cannot match is refused', async () => {
  resetStartupOptionByteSafety()
  try {
    await establishStartupOptionByteSafety(R22_URL, { createClient: fanOutClient([ONE_BACKEND]) })
    const onConnect = pgConnectionConfig(R22_URL).onConnect!

    // The backend names a TCP peer and the client cannot say what its own socket is. Fail closed:
    // an unreadable half of a comparison is not a passing comparison.
    //
    // MUTATION ROUTE: return `null` instead of a refusal when `ownSocketEndpoint()` is null. Any
    // client wrapper that does not expose `connection.stream` — which is every future one — then
    // silently skips the leg on a connection the backend says came from somewhere else.
    const opaque = servedConnection(ONE_BACKEND, '"ténant"') as unknown as {
      asked: string[]
      query(text: string): Promise<{ rows: Array<Record<string, unknown>> }>
    }
    const withPeer = {
      asked: opaque.asked,
      async query(text: string) {
        const answer = await opaque.query(text)
        return { rows: answer.rows.map((row) => ({ ...row, client_address: '10.0.0.250', client_port: '55001' })) }
      },
    }
    await assert.rejects(
      () => onConnect(withPeer),
      (error: unknown) => {
        assert.match((error as Error).message, /cannot read its own end of the socket/)
        return true
      },
    )
  } finally {
    resetStartupOptionByteSafety()
  }
})

/** The identity string `backendIdentityOf()` composes, read over whichever path is handed in. */
async function backendIdentityOver(connectionString: string, options: string): Promise<string> {
  const client = new pg.Client({ connectionString, options, connectionTimeoutMillis: 3_000 })
  await client.connect()
  try {
    const row = (await client.query<Record<string, string>>(
      "select coalesce(host(inet_server_addr()), '') as a, coalesce(inet_server_port()::text, '') as p, " +
      "coalesce(current_setting('server_version', true), '') as v, pg_encoding_to_char(encoding) as e, " +
      'datctype as c from pg_database where datname = current_database()',
    )).rows[0]!
    return `${row.a}:${row.p}|${row.v}|${row.e}|${row.c}`
  } finally {
    await client.end().catch(() => undefined)
  }
}

test('o3d-2k5r r23 (live): a TRANSPARENT relay still cannot carry a non-ASCII pin', async (t) => {
  const scratch = await openScratch(t)
  if (!scratch) return
  const slot = Symbol.for('ims.db.startupOptionByteVerdict.v2')
  const globals = globalThis as unknown as Record<symbol, unknown>
  resetStartupOptionByteSafety()
  const pools: pg.Pool[] = []
  let relay: net.Server | null = null
  try {
    const schema = 'ten ant' // U+00A0, as in the r19/r22 live tests
    await scratch.admin.query(`CREATE SCHEMA ${'"' + schema + '"'}`)

    // THE HARDEST CASE FOR THIS GUARD, and the reason it is a live test rather than a stand-in.
    // This relay does not speak the PostgreSQL protocol at all — it copies bytes both ways — so the
    // startup packet, non-ASCII pin included, reaches the backend UNCHANGED. Every other leg
    // therefore passes: the backend is the measured one and its `search_path` is exactly the pin.
    // Only the peer comparison can see that the connection was terminated and re-opened, which is
    // the precondition a transaction-pooling proxy needs in order to re-assign the server side.
    const upstream = new URL(scratch.url)
    relay = net.createServer((client) => {
      const server = net.connect(
        { host: upstream.hostname, port: Number(upstream.port || 5432) },
        () => { client.pipe(server); server.pipe(client) },
      )
      server.on('error', () => client.destroy())
      client.on('error', () => server.destroy())
    })
    await new Promise<void>((resolve) => relay!.listen(0, '127.0.0.1', resolve))
    const relayPort = (relay.address() as net.AddressInfo).port
    const relayed = new URL(scratch.url)
    relayed.hostname = '127.0.0.1'
    relayed.port = String(relayPort)
    const relayBase = relayed.toString()
    const relayUrl = `${relayBase}?schema=${encodeURIComponent(schema)}`
    const pin = `-c search_path=${'"' + schema + '"'}`

    // 1. THE RELAY IS TRANSPARENT. Stated first, because everything below is only interesting if
    // the refusal is NOT the relay having broken the pin. It has not: the server ends up on the
    // non-ASCII schema, so this is a configuration that works today.
    const through = new pg.Client({ connectionString: relayBase, options: pin, connectionTimeoutMillis: 3_000 })
    await through.connect()
    try {
      assert.equal(
        (await through.query<{ s: string }>('select current_schema() as s')).rows[0]?.s,
        schema,
        'PRECONDITION: the pin survives the relay, so nothing below is a refusal of a broken pin',
      )
    } finally {
      await through.end().catch(() => undefined)
    }

    // 2. AND THE PROBE REFUSES IT ANYWAY. This is the outcome chosen for Codex's finding: rather
    // than re-checking every unit of work, no licence is granted to an endpoint this process cannot
    // show it is talking to directly. The operator gets ONE message, at boot / preflight / the
    // pre-deploy check.
    //
    // MUTATION ROUTE: delete the `interposedPeerRefusal(measuredOver, servedBy)` block from
    // establishStartupOptionByteSafety(). The verdict settles POSITIVE — every other leg passes,
    // because the relay forwards the bytes — and pgConnectionConfig() below stops throwing.
    const verdict = await establishStartupOptionByteSafety(relayUrl)
    assert.equal(verdict.established, false, 'no licence is granted through an interposed endpoint')
    assert.match(verdict.reason, /does not reach the backend directly/)
    assert.match(verdict.reason, /terminated the connection and opened its own/)
    assert.throws(() => pgConnectionConfig(relayUrl), DatabaseUrlSchemaConflictError)

    // 3. AND SO DOES THE PER-CONNECTION GUARD, through a REAL pg.Pool. The verdict is planted
    // rather than probed precisely because step 2 makes it unobtainable: this is the second line,
    // for an endpoint that became interposed AFTER a positive verdict was earned — a re-pointed
    // pooler, exactly the case r22 was built for.
    const relayedIdentity = await backendIdentityOver(relayBase, pin)
    const directIdentity = await backendIdentityOver(scratch.url, pin)
    const plant = (target: string, backend: string) => {
      globals[slot] = Object.freeze({
        established: true, carries: true, probed: ' ', target, backend,
        serverEncoding: 'SQL_ASCII', lcCtype: 'C', reason: 'planted: a licence earned before the endpoint moved',
      })
    }

    // 3a. THE CONTROL. Same backend, same pin, same schema — only the path is direct. It is
    // ADMITTED and lands on the schema, so the refusal below is about interposition and nothing else.
    plant(`${new URL(scratch.url).hostname}:${new URL(scratch.url).port}${new URL(scratch.url).pathname}`, directIdentity)
    const directConfig = pgConnectionConfig(`${scratch.url}?schema=${encodeURIComponent(schema)}`)
    assert.equal(typeof directConfig.onConnect, 'function', 'PRECONDITION: the licensed pin carries a guard')
    const admitted = new pg.Pool({ ...directConfig, max: 1, connectionTimeoutMillis: 3_000 })
    pools.push(admitted)
    const client = await admitted.connect()
    try {
      assert.equal((await client.query<{ s: string }>('select current_schema() as s')).rows[0]?.s, schema)
    } finally {
      client.release()
    }

    // 3b. THE SAME LICENCE, SPENT THROUGH THE RELAY. Refused before a query can run.
    //
    // MUTATION ROUTE: delete the `interposedConnectionRefusal(client, row)` call from
    // startupOptionBackendGuard(). This pool then hands out the connection — the relay forwards the
    // pin and the backend is the one named — and the licensed bytes are spent on a socket whose far
    // end can be re-pointed without this process being told.
    plant(`127.0.0.1:${relayPort}${new URL(relayBase).pathname}`, relayedIdentity)
    const refusedConfig = pgConnectionConfig(relayUrl)
    const refused = new pg.Pool({ ...refusedConfig, max: 1, connectionTimeoutMillis: 3_000 })
    pools.push(refused)
    await assert.rejects(
      async () => { (await refused.connect()).release() },
      (error: unknown) => {
        assert.ok(error instanceof DatabaseUrlSchemaConflictError)
        assert.match((error as Error).message, /terminated the connection and opened its own/)
        return true
      },
      'a real pg.Pool refuses a physical connection that does not reach the backend directly',
    )
    assert.equal(refused.totalCount, 0, 'and the refused connection is not left in the pool')
    await assert.rejects(() => refused.query('select 1'), DatabaseUrlSchemaConflictError)
  } finally {
    delete globals[slot]
    resetStartupOptionByteSafety()
    for (const pool of pools) await pool.end().catch(() => undefined)
    await new Promise<void>((resolve) => { relay ? relay.close(() => resolve()) : resolve() })
    await scratch.drop()
  }
})
