import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test, { type TestContext } from 'node:test'

import { parse as parseDotenv } from 'dotenv'
import pg from 'pg'

import {
  DatabaseUrlSchemaConflictError,
  pgConnectionConfig,
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
        const landed = await scratch.admin.query<{ nspname: string }>(
          `select n.nspname from ${quoted}.settings s, pg_namespace n where s.key = $1 and n.nspname = $2`,
          [key, schema],
        )
        assert.equal(landed.rowCount, 1, `${label}: the unqualified write landed in the named schema`)
        assert.equal(
          (await scratch.admin.query('select 1 from public.settings where key = $1', [key])).rowCount,
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
