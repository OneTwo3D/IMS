import assert from 'node:assert/strict'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * o3d-quia: the cycle check is now ONE recursive CTE rather than a query-per-node BFS.
 *
 * The unit suite mocks the query, which proves the CALLER's logic and nothing at all about the
 * SQL — a wrong column name, a wrong join direction, or `UNION ALL` instead of `UNION` would
 * all pass there. This exercises the real statement against a real Postgres, so it is gated on
 * RUN_DB_CONCURRENCY_TESTS=1 like its siblings.
 *
 * The `UNION ALL` case is the one worth stating: the graph can ALREADY contain a cycle — that
 * is why the check exists — and with `UNION ALL` the recursion would never terminate, hanging
 * inside a transaction that holds the global component-write lock. `UNION` deduplicates the
 * frontier, which is what makes termination independent of the graph being acyclic.
 */
test(
  'component cycle CTE: detects reachability, and terminates on a graph that already cycles',
  { skip: process.env.RUN_DB_CONCURRENCY_TESTS !== '1' },
  async () => {
    config({ path: '.env.local', quiet: true })
    config({ quiet: true })
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')

    const { db } = await import('../../lib/db/index.ts')
    const { detectComponentCycle } = await import('../../lib/products/component-cycle.ts')

    const tag = `o3d-quia-${process.pid}-${Math.floor(performance.now())}`
    const ids = ['a', 'b', 'c', 'd'].map((suffix) => `${tag}-${suffix}`)
    const [A, B, C, D] = ids as [string, string, string, string]

    const makeProduct = (id: string) =>
      db.product.create({
        data: { id, sku: id, name: id, type: 'KIT', lifecycleStatus: 'ACTIVE', active: true },
      })
    const edge = (productId: string, componentId: string) =>
      db.productComponent.create({ data: { productId, componentId, qty: 1, sortOrder: 0 } })

    try {
      for (const id of ids) await makeProduct(id)

      // A -> B -> C, leaving D unattached.
      await edge(A, B)
      await edge(B, C)

      // Reachability: adding C -> A would close A -> B -> C -> A.
      assert.deepEqual(await detectComponentCycle(C, [A]), { kind: 'cycle' })
      // D is not on any path back to itself.
      assert.deepEqual(await detectComponentCycle(D, [A]), { kind: 'ok' })
      // Direct self-reference short-circuits before the query.
      assert.deepEqual(await detectComponentCycle(A, [A]), { kind: 'self' })

      // Multiple roots: the cycle only exists through one of them.
      assert.deepEqual(await detectComponentCycle(C, [D, A]), { kind: 'cycle' })

      // Now CLOSE the cycle in the stored graph and re-run. With UNION ALL this recursion
      // never terminates; with UNION it must still answer, promptly.
      await edge(C, A)
      const startedAt = performance.now()
      assert.deepEqual(await detectComponentCycle(B, [A]), { kind: 'cycle' })
      assert.deepEqual(await detectComponentCycle(D, [A]), { kind: 'ok' })
      assert.ok(
        performance.now() - startedAt < 5_000,
        'the query must terminate well inside the interactive-transaction timeout on a cyclic graph',
      )
    } finally {
      await db.productComponent.deleteMany({ where: { productId: { in: ids } } })
      await db.productComponent.deleteMany({ where: { componentId: { in: ids } } })
      await db.product.deleteMany({ where: { id: { in: ids } } })
    }
  },
)

test(
  'component cycle CTE: runs inside a transaction and sees its uncommitted edges',
  { skip: process.env.RUN_DB_CONCURRENCY_TESTS !== '1' },
  async () => {
    // The whole point of threading a client (o3d-t0zq): the authoritative check must see the
    // transaction's own snapshot. Through the module-level `db` it would read on a different
    // connection and miss edges this transaction has written but not committed.
    config({ path: '.env.local', quiet: true })
    config({ quiet: true })
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')

    const { db } = await import('../../lib/db/index.ts')
    const { detectComponentCycle } = await import('../../lib/products/component-cycle.ts')

    const tag = `o3d-quia-tx-${process.pid}-${Math.floor(performance.now())}`
    const [A, B] = [`${tag}-a`, `${tag}-b`]

    try {
      for (const id of [A, B]) {
        await db.product.create({
          data: { id, sku: id, name: id, type: 'KIT', lifecycleStatus: 'ACTIVE', active: true },
        })
      }

      await db.$transaction(async (tx) => {
        // Written but not yet committed.
        await tx.productComponent.create({ data: { productId: A, componentId: B, qty: 1, sortOrder: 0 } })

        // Through tx: the edge is visible, so B -> A would close a loop.
        assert.deepEqual(await detectComponentCycle(B, [A], tx), { kind: 'cycle' })

        // Through the module-level db: a different connection, so the edge is invisible and the
        // check would wrongly answer "ok" — which is exactly the bug o3d-t0zq closed.
        assert.deepEqual(await detectComponentCycle(B, [A]), { kind: 'ok' })
      })
    } finally {
      await db.productComponent.deleteMany({ where: { productId: { in: [A, B] } } })
      await db.product.deleteMany({ where: { id: { in: [A, B] } } })
    }
  },
)
