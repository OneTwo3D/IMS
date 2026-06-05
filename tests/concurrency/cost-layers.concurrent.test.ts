import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

const BARRIER_TIMEOUT_MS = Number.parseInt(process.env.QG3_BARRIER_TIMEOUT_MS ?? '15000', 10)
const TRANSACTION_TIMEOUT_MS = 20000
const TRANSACTION_MAX_WAIT_MS = 10000

async function waitWithTimeout(promise: Promise<void>, timeoutMs: number, message: string) {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function createBarrier(parties: number) {
  let waiting = 0
  let release!: () => void
  const released = new Promise<void>((resolve) => {
    release = resolve
  })

  return async () => {
    waiting += 1
    if (waiting === parties) release()
    await waitWithTimeout(released, BARRIER_TIMEOUT_MS, `Timed out waiting for ${parties} concurrent transactions`)
  }
}

async function cleanupFixture(
  db: {
    cogsEntry: { deleteMany(args: unknown): Promise<unknown> }
    stockLevel: { deleteMany(args: unknown): Promise<unknown> }
    stockMovement: { deleteMany(args: unknown): Promise<unknown> }
    costLayer: { deleteMany(args: unknown): Promise<unknown> }
    product: { delete(args: unknown): Promise<unknown> }
    warehouse: { delete(args: unknown): Promise<unknown> }
  },
  input: { productId?: string; warehouseId?: string },
) {
  const cleanupErrors: Error[] = []
  const runCleanup = async (label: string, operation: () => Promise<unknown>) => {
    try {
      await operation()
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error))
      cleanupErrors.push(normalized)
      console.warn(`QG3 FIFO concurrency cleanup failed for ${label}: ${normalized.message}`)
    }
  }

  if (input.productId) {
    await runCleanup('COGS entries', () => db.cogsEntry.deleteMany({
      where: { costLayer: { productId: input.productId } },
    }))
    await runCleanup('stock levels', () => db.stockLevel.deleteMany({ where: { productId: input.productId } }))
    await runCleanup('stock movements', () => db.stockMovement.deleteMany({ where: { productId: input.productId } }))
    await runCleanup('cost layers', () => db.costLayer.deleteMany({ where: { productId: input.productId } }))
    await runCleanup('product', () => db.product.delete({ where: { id: input.productId } }))
  }
  if (input.warehouseId) {
    await runCleanup('warehouse', () => db.warehouse.delete({ where: { id: input.warehouseId } }))
  }

  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'QG3 FIFO concurrency cleanup failed')
  }
}

test(
  'QG3 concurrent strict FIFO consumes serialize and cannot over-consume one layer',
  { skip: process.env.RUN_DB_CONCURRENCY_TESTS !== '1' },
  async () => {
    config({ path: '.env.local', quiet: true })
    config({ quiet: true })

    const databaseUrl = process.env.DATABASE_URL
    if (!databaseUrl) {
      throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
    }
    if (!databaseUrl.startsWith('postgres://') && !databaseUrl.startsWith('postgresql://')) {
      throw new Error('QG3 concurrency test requires a Postgres DATABASE_URL')
    }

    const [{ Prisma, PrismaClient }, { PrismaPg }, { default: pg }, { consumeFifoLayersStrict }] = await Promise.all([
      import('@/app/generated/prisma/client'),
      import('@prisma/adapter-pg'),
      import('pg'),
      import('@/lib/cost-layers'),
    ])
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 4,
    })
    const db = new PrismaClient({ adapter: new PrismaPg(pool) })

    const suffix = randomUUID()
    const sku = `QG3-FIFO-${suffix}`
    const warehouseCode = `QG3-${suffix.slice(0, 8)}`
    let productId: string | undefined
    let warehouseId: string | undefined

    try {
      const product = await db.product.create({
        data: {
          sku,
          name: `QG3 FIFO ${suffix}`,
          type: 'SIMPLE',
        },
        select: { id: true },
      })
      productId = product.id

      const warehouse = await db.warehouse.create({
        data: {
          code: warehouseCode,
          name: `QG3 FIFO ${suffix}`,
        },
        select: { id: true },
      })
      warehouseId = warehouse.id

      await db.costLayer.create({
        data: {
          productId,
          warehouseId,
          receivedQty: new Prisma.Decimal('10'),
          remainingQty: new Prisma.Decimal('10'),
          unitCostBase: new Prisma.Decimal('2.5'),
          receivedAt: new Date('2026-01-01T00:00:00.000Z'),
          isOpeningStock: true,
        },
      })

      const barrier = createBarrier(2)
      // Regression for the FIFO select-and-lock guarantee: both consumers enter
      // the strict FIFO call together, then Postgres FOR UPDATE must serialize
      // the candidate read so only one transaction can consume the 10-unit row.
      const consume = () => db.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '30s'`
        await barrier()
        return consumeFifoLayersStrict(tx, productId!, warehouseId!, 8)
      }, { maxWait: TRANSACTION_MAX_WAIT_MS, timeout: TRANSACTION_TIMEOUT_MS })

      const outcomes = await Promise.allSettled([consume(), consume()])
      const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled')
      const rejected = outcomes.filter((outcome) => outcome.status === 'rejected')

      assert.equal(fulfilled.length, 1, 'expected exactly one successful 8-unit FIFO consume')
      assert.equal(rejected.length, 1, 'expected exactly one rejected FIFO consume after the first consumes 8 of 10 units')
      assert.match(String((rejected[0] as PromiseRejectedResult).reason), /Insufficient FIFO layers/)

      const remainingLayer = await db.costLayer.findFirstOrThrow({
        where: { productId, warehouseId },
        select: { remainingQty: true },
      })
      assert.equal(
        remainingLayer.remainingQty.toString(),
        '2',
        `expected remainingQty=2 after one 8-unit consume, got ${remainingLayer.remainingQty}; if both succeeded, FIFO locking regressed`,
      )
    } finally {
      try {
        await cleanupFixture(db, { productId, warehouseId })
      } finally {
        await db.$disconnect().catch((error: unknown) => {
          console.warn(`QG3 FIFO concurrency Prisma disconnect failed: ${String(error)}`)
        })
        await pool.end().catch((error: unknown) => {
          console.warn(`QG3 FIFO concurrency pg pool cleanup failed: ${String(error)}`)
        })
      }
    }
  },
)
