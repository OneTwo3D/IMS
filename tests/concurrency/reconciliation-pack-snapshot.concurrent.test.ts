import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * THE INVARIANT RUN'S ONE SNAPSHOT, AGAINST A REAL, MIGRATED POSTGRESQL (lib/reconciliation-pack/invariant-snapshot.ts).
 *
 * While the run reads, the application's own `db` is bound to one REPEATABLE READ READ ONLY transaction:
 *   - a row another connection commits AFTER the run began is invisible to a later read through `db`;
 *   - a write through `db` is refused by the server;
 *   - the proof read from PostgreSQL is attached.
 * The rig can fail: the same committed row IS visible to a fresh connection.
 *
 * This file must not import lib/db before the run (the binding requires the module's first load to happen inside it).
 * Gated behind RUN_DB_CONCURRENCY_TESTS=1: `npm run test:concurrency`.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const TABLE = `rcpk_snapshot_${process.pid}`

async function withClient<T>(fn: (client: import('pg').Client) => Promise<T>): Promise<T> {
  const { default: pg } = await import('pg')
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  try { return await fn(client) } finally { await client.end() }
}

test('[reconciliation pack] the invariant run reads ONE snapshot through the application client, and cannot write', { skip: !RUN }, async () => {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  await withClient((c) => c.query(`CREATE TABLE ${TABLE} (id int PRIMARY KEY)`))
  try {
    await withClient((c) => c.query(`INSERT INTO ${TABLE} VALUES (1)`))
    const { runInvariantInOneSnapshot } = await import('../../lib/reconciliation-pack/invariant-snapshot.ts')
    const evidence = await runInvariantInOneSnapshot(async () => {
      const { db } = await import('@/lib/db')
      const count = async () => Number(((await db.$queryRawUnsafe(`SELECT count(*)::int AS n FROM ${TABLE}`)) as Array<{ n: number }>)[0]!.n)
      const before = await count()
      await withClient((c) => c.query(`INSERT INTO ${TABLE} VALUES (2)`)) // committed by another connection, mid-run
      const after = await count()
      let writeError = ''
      // A refused statement aborts the transaction; the savepoint keeps it usable for the proof read that ends the run.
      await db.$executeRawUnsafe('SAVEPOINT refused_write')
      try { await db.$executeRawUnsafe(`INSERT INTO ${TABLE} VALUES (3)`) } catch (error) { writeError = String((error as Error).message) }
      await db.$executeRawUnsafe('ROLLBACK TO SAVEPOINT refused_write')
      return { ok: true, before, after, writeError }
    }) as Record<string, unknown>
    assert.equal(evidence.before, 1)
    assert.equal(evidence.after, 1, 'a row committed after the run began must be invisible to it')
    assert.match(String(evidence.writeError), /read-only transaction/)
    const proof = evidence.snapshot as Record<string, unknown> | null
    assert.ok(proof, 'the proof is attached')
    assert.equal(proof.isolation, 'repeatable read')
    assert.equal(proof.readOnly, true)
    assert.equal(proof.boundToApplicationClient, true)
    // The rig can fail: outside the run the committed row is there, and the refused write is not.
    const rows = await withClient(async (c) => (await c.query(`SELECT id FROM ${TABLE} ORDER BY id`)).rows.map((r) => r.id as number))
    assert.deepEqual(rows, [1, 2])
  } finally {
    await withClient((c) => c.query(`DROP TABLE IF EXISTS ${TABLE}`))
  }
})
