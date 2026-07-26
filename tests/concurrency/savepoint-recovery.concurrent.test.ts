import assert from 'node:assert/strict'
import test from 'node:test'
import { config } from 'dotenv'

// o3d-slrn: a P2002 caught INSIDE a Prisma interactive transaction leaves the transaction
// aborted. Postgres marks the whole transaction failed on a 23505, and Prisma does not wrap
// individual statements in savepoints, so every later statement fails with 25P02 and the COMMIT
// cannot succeed. The try/catch idempotency pattern this codebase uses therefore never actually
// deduplicates — it just fails differently.
//
// This behaviour cannot be reproduced against a mock: the abort is a PostgreSQL property, and a
// hand-written double will happily keep serving queries after a thrown insert. Every assertion
// here needs a real database, so the suite is gated like the other concurrency tests.

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const TX = { timeout: 20000, maxWait: 10000 }

function loadEnv() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
  }
}

/** A unique SKU per run so a crashed run cannot collide with the next one. */
function probeSku(label: string) {
  return `SLRN-${label}-${process.pid}-${Date.now()}`
}

test(
  'WITHOUT a savepoint, a caught P2002 poisons the rest of the transaction (o3d-slrn)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    loadEnv()
    const { db } = await import('@/lib/db')
    const sku = probeSku('bare')

    const afterCatch: string[] = []
    await db
      .$transaction(async (tx) => {
        await tx.product.create({
          data: { sku, name: 'slrn probe', type: 'SIMPLE', countryOfOrigin: 'CN' },
          select: { id: true },
        })
        try {
          await tx.product.create({
            data: { sku, name: 'dup', type: 'SIMPLE', countryOfOrigin: 'CN' },
          })
        } catch {
          // Exactly what the production guards do: recognise the duplicate and carry on.
        }
        await tx.product.count()
        throw new Error('ROLLBACK PROBE')
      }, TX)
      .catch((error) => {
        afterCatch.push(error instanceof Error ? error.message : String(error))
      })

    assert.equal(afterCatch.length, 1, 'the transaction must not have completed')
    assert.match(
      afterCatch[0],
      /current transaction is aborted/,
      'this is the defect: recovery after a caught P2002 hits 25P02, not the rollback we asked for',
    )
    await db.$disconnect()
  },
)

test(
  'WITH a savepoint, the same catch recovers and the transaction stays usable (o3d-slrn)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    loadEnv()
    const { db } = await import('@/lib/db')
    const { withSavepoint } = await import('@/lib/db/savepoint')
    const sku = probeSku('guarded')

    // Collected into an array rather than a nullable local: TypeScript's control-flow analysis
    // cannot see an assignment made inside the transaction callback, so a `let x: T | null = null`
    // narrows to `never` at the assertions below and fails type-check.
    const recovered: Array<{ count: number; foundExisting: boolean }> = []
    await db
      .$transaction(async (tx) => {
        const first = await tx.product.create({
          data: { sku, name: 'slrn probe', type: 'SIMPLE', countryOfOrigin: 'CN' },
          select: { id: true },
        })

        let sawConflict = false
        try {
          await withSavepoint(tx, () =>
            tx.product.create({ data: { sku, name: 'dup', type: 'SIMPLE', countryOfOrigin: 'CN' } }),
          )
        } catch (error) {
          sawConflict = (error as { code?: string }).code === 'P2002'
        }
        assert.equal(sawConflict, true, 'the duplicate must still surface as a P2002 to the caller')

        // The whole point: both of these run against a transaction that is still alive.
        const count = await tx.product.count()
        const existing = await tx.product.findUnique({ where: { sku }, select: { id: true } })
        recovered.push({ count, foundExisting: existing?.id === first.id })

        throw new Error('ROLLBACK PROBE')
      }, TX)
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        assert.match(message, /ROLLBACK PROBE/, `expected our own rollback, got: ${message}`)
      })

    assert.equal(recovered.length, 1, 'the recovery block must have run')
    assert.ok(recovered[0].count > 0, 'a query after the caught conflict must succeed')
    assert.equal(recovered[0].foundExisting, true, 'and the idempotent lookup must find the winner')
    await db.$disconnect()
  },
)

test(
  'a savepoint-guarded success still commits, and nested guards do not release each other (o3d-slrn)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    loadEnv()
    const { db } = await import('@/lib/db')
    const { withSavepoint } = await import('@/lib/db/savepoint')
    const outerSku = probeSku('outer')
    const innerSku = probeSku('inner')

    await db
      .$transaction(async (tx) => {
        // Nesting matters because savepoint names are reused if they are not unique: an inner
        // RELEASE naming the outer savepoint would silently discard the outer guard.
        const outer = await withSavepoint(tx, async () => {
          const created = await tx.product.create({
            data: { sku: outerSku, name: 'outer', type: 'SIMPLE', countryOfOrigin: 'CN' },
            select: { id: true },
          })
          await withSavepoint(tx, () =>
            tx.product.create({
              data: { sku: innerSku, name: 'inner', type: 'SIMPLE', countryOfOrigin: 'CN' },
              select: { id: true },
            }),
          )
          // An inner FAILURE must roll back only the inner statement.
          try {
            await withSavepoint(tx, () =>
              tx.product.create({
                data: { sku: innerSku, name: 'inner dup', type: 'SIMPLE', countryOfOrigin: 'CN' },
              }),
            )
          } catch {
            // expected
          }
          return created
        })

        assert.ok(outer.id, 'the outer guarded write returned its row')
        const both = await tx.product.findMany({
          where: { sku: { in: [outerSku, innerSku] } },
          select: { sku: true },
        })
        assert.equal(both.length, 2, 'both guarded writes survived the inner rollback')

        throw new Error('ROLLBACK PROBE')
      }, TX)
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        assert.match(message, /ROLLBACK PROBE/, `expected our own rollback, got: ${message}`)
      })

    await db.$disconnect()
  },
)
