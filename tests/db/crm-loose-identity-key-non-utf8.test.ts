import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { config } from 'dotenv'
import pg from 'pg'

/**
 * crm_loose_identity_key ON A NON-UTF8 DATABASE (stage hotfix). Stage's database is SQL_ASCII with collation C: normalize(..., NFC) is refused there, so the
 * function from migration 20261119140100 raised on every call and 20261119140200's CREATE INDEX failed. Migration 20261119140150 replaces the body on a
 * non-UTF8 database and does nothing on UTF8. This test builds a REAL SQL_ASCII scratch database (and a UTF8 one), applies the three migrations' SQL in
 * timestamp order the way a retried deploy does, and holds ASCII addresses to the TypeScript fold.
 * GATED on RUN_DB_RETENTION_TESTS (npm run test:db). Nothing here reaches the network.
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'
if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1, so every test in tests/db/crm-loose-identity-key-non-utf8.test.ts would have been skipped')
}

const MIGRATIONS = path.join(process.cwd(), 'prisma', 'migrations')
const sql = (dir: string) => readFileSync(path.join(MIGRATIONS, dir, 'migration.sql'), 'utf8')
const FN = '20261119140100_crm_loose_identity_key_fn'
const FIX = '20261119140150_crm_loose_identity_key_fn_encoding_safe'
const IDX = '20261119140200_customers_loose_identity_key_v2_idx'

const ASCII_EMAILS = [
  'Jane.Doe+news@Example.COM',
  'a.b.c+x@gmail.com',
  'A.B.C@GoogleMail.com',
  '  padded@example.com\t',
  'plain@example.com',
  'two@@example.com',
  'no-at.example.com',
  'in ner@example.com',
  '+tagonly@example.com',
  '...@gmail.com',
]

async function withScratch(encoding: 'SQL_ASCII' | 'UTF8', t: test.TestContext, body: (client: pg.Client) => Promise<void>) {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const base = new URL(process.env.DATABASE_URL)
  base.search = ''
  const name = `ims_crmfn_${encoding.toLowerCase()}_${randomUUID().replace(/-/g, '').slice(0, 10)}`
  const boot = new pg.Client({ connectionString: base.toString(), connectionTimeoutMillis: 3_000 })
  try {
    await boot.connect()
  } catch {
    await boot.end().catch(() => undefined)
    t.skip('no reachable PostgreSQL')
    return
  }
  const locale = "LC_COLLATE 'C' LC_CTYPE 'C'"
  await boot.query(`CREATE DATABASE ${name} ENCODING '${encoding}' TEMPLATE template0 ${locale}`)
  const scratch = new URL(base.toString())
  scratch.pathname = `/${name}`
  const client = new pg.Client({ connectionString: scratch.toString(), connectionTimeoutMillis: 3_000 })
  try {
    await client.connect()
    const enc = await client.query<{ e: string }>(`SELECT current_setting('server_encoding') AS e`)
    assert.equal(enc.rows[0]!.e, encoding)
    await body(client)
  } finally {
    await client.end().catch(() => undefined)
    await boot.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined)
    await boot.end().catch(() => undefined)
  }
}

test('SQL_ASCII: the original function fails, the encoding-safe migration fixes it, the index builds, ASCII emails fold like TypeScript', { skip }, async (t) => {
  await withScratch('SQL_ASCII', t, async (client) => {
    await client.query(`CREATE TABLE customers (id serial PRIMARY KEY, email text)`)
    await client.query(sql(FN))
    for (const e of ASCII_EMAILS) await client.query(`INSERT INTO customers (email) VALUES ($1)`, [e])

    // THE BUG: without the fix the function raises on a byte-encoded database, so the index migration fails.
    await assert.rejects(() => client.query(`SELECT crm_loose_identity_key('a@b.com')`), /Unicode normalization/)
    await assert.rejects(() => client.query(sql(IDX)), /Unicode normalization/)

    // THE FIX, applied out of order (timestamp 140150 < the failed 140200), then the retried index migration.
    await client.query(sql(FIX))
    // A failed CREATE INDEX CONCURRENTLY leaves an INVALID index behind, and IF NOT EXISTS would skip it: the operator (or the later rebuild migrations) drops it first.
    await client.query(`DROP INDEX IF EXISTS customers_loose_identity_key_v2_idx`)
    await client.query(sql(IDX))
    const idx = await client.query(`SELECT indisvalid FROM pg_index WHERE indexrelid = 'customers_loose_identity_key_v2_idx'::regclass`)
    assert.equal(idx.rows[0]!.indisvalid, true)

    const { looseIdentityEmail } = await import('@/lib/domain/crm/identity-key')
    for (const e of ASCII_EMAILS) {
      const r = await client.query<{ k: string | null }>(`SELECT crm_loose_identity_key($1) AS k`, [e])
      assert.equal(r.rows[0]!.k, looseIdentityEmail(e), `SQL and TypeScript folds disagree for ${JSON.stringify(e)}`)
    }
    // A non-ASCII address does not raise (its bytes are not treated as white space or normalised).
    const r = await client.query<{ k: string | null }>(`SELECT crm_loose_identity_key($1) AS k`, ['josé@example.com'])
    assert.equal(r.rows[0]!.k, 'josé@example.com')
    // The index serves the resolver's probe.
    await client.query(`SET enable_seqscan = off`)
    const plan = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN SELECT id FROM customers WHERE crm_loose_identity_key(email) = 'plain@example.com' AND email IS NOT NULL`)
    assert.match(plan.rows.map((x) => x['QUERY PLAN']).join('\n'), /customers_loose_identity_key_v2_idx/)
  })
})

test('UTF8: the encoding-safe migration changes nothing (the function body under an existing index is not touched)', { skip }, async (t) => {
  await withScratch('UTF8', t, async (client) => {
    await client.query(`CREATE TABLE customers (id serial PRIMARY KEY, email text)`)
    await client.query(sql(FN))
    await client.query(sql(IDX))
    const def = () => client.query<{ d: string }>(`SELECT pg_get_functiondef('crm_loose_identity_key(text)'::regprocedure) AS d`)
    const before = (await def()).rows[0]!.d
    await client.query(sql(FIX))
    assert.equal((await def()).rows[0]!.d, before)
    assert.match(before, /normalize\(/)
  })
})
