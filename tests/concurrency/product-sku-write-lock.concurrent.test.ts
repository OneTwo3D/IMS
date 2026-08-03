import assert from 'node:assert/strict'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * o3d-42hw: the per-SKU write lock is COOPERATIVE, so it only serializes writers that take
 * it. o3d-uh2/o3d-fsi gave it to the WooCommerce product-write transaction; the manual
 * create, the variant create, the product editor and the CSV import did not take it, and ran
 * a check-then-create with no lock at all. A create landing between another writer's lookup
 * and its create raised a P2002 on `Product.sku` — safe today only because o3d-gtk keeps
 * that transient, and the reason it cannot be classified permanent.
 *
 * This proves the lock genuinely serializes two writers contending for the SAME sku, and
 * genuinely does NOT serialize two writers on different skus (a lock that serialized
 * everything would be safe but useless). Needs a real Postgres, so it is gated behind
 * RUN_DB_CONCURRENCY_TESTS=1 like its siblings.
 */
test(
  'product SKU write lock: same-SKU writers serialize, different-SKU writers do not',
  { skip: process.env.RUN_DB_CONCURRENCY_TESTS !== '1' },
  async () => {
    config({ path: '.env.local', quiet: true })
    config({ quiet: true })
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')

    const { db } = await import('../../lib/db/index.ts')
    const { lockProductSkusForWrite } = await import('../../lib/products/sku-write-lock.ts')

    // Unique per run so repeat runs cannot collide with each other's leftovers.
    const tag = `o3d-42hw-${process.pid}-${Math.floor(performance.now())}`

    let concurrent = 0
    let maxConcurrent = 0
    const hold = (sku: string) =>
      db.$transaction(async (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => {
        await lockProductSkusForWrite(tx, [sku])
        concurrent++
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        await new Promise((r) => setTimeout(r, 300)) // long enough that unserialized holders overlap
        concurrent--
      }, { timeout: 20_000 })

    // Same SKU: the second must wait for the first.
    await Promise.all([hold(`${tag}-same`), hold(`${tag}-same`)])
    assert.equal(maxConcurrent, 1, 'two writers contending for the SAME sku must not overlap')

    // Different SKUs: they must NOT wait for each other, or the lock is a global bottleneck.
    concurrent = 0
    maxConcurrent = 0
    await Promise.all([hold(`${tag}-a`), hold(`${tag}-b`)])
    assert.equal(maxConcurrent, 2, 'writers on DIFFERENT skus must run concurrently')
  },
)

test(
  'product SKU write lock: overlapping SKU sets acquire shared ids in the same order',
  { skip: process.env.RUN_DB_CONCURRENCY_TESTS !== '1' },
  async () => {
    // The deadlock-freedom argument. Two payloads whose SKU sets overlap must request their
    // shared lock ids in the same sequence, or each can hold one while waiting on another the
    // other already holds. Sorting the IDS (not the SKUs) is what delivers that, so this
    // asserts against real hashtext values rather than a stub.
    config({ path: '.env.local', quiet: true })
    config({ quiet: true })
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')

    const { db } = await import('../../lib/db/index.ts')
    const { resolveProductSkuLockIds } = await import('../../lib/products/sku-write-lock.ts')

    const left = await resolveProductSkuLockIds(db, ['zeta', 'alpha', 'mu'])
    const right = await resolveProductSkuLockIds(db, ['mu', 'zeta', 'beta'])

    assert.deepEqual(left, [...left].sort((a, b) => a - b), 'ids must be ascending')
    assert.deepEqual(right, [...right].sort((a, b) => a - b), 'ids must be ascending')

    // The shared ids appear in the same relative order in both sequences.
    const shared = left.filter((id) => right.includes(id))
    assert.ok(shared.length >= 2, 'the fixture SKUs must actually overlap')
    assert.deepEqual(
      shared,
      right.filter((id) => left.includes(id)),
      'shared lock ids must be requested in the same order by both writers',
    )

    // Two writers deadlock exactly when a set is acquired in opposing orders, so a run whose
    // SKU order disagrees with its id order is the case that matters.
    const bySkuOrder = ['zeta', 'alpha', 'mu']
    const idsInSkuOrder = await Promise.all(
      bySkuOrder.map(async (sku) => (await resolveProductSkuLockIds(db, [sku]))[0]!),
    )
    assert.notDeepEqual(idsInSkuOrder, left, 'fixture should exercise SKU order disagreeing with id order')
  },
)
