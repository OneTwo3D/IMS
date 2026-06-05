import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

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
    await waitWithTimeout(released, 5000, `Timed out waiting for ${parties} concurrent transactions`)
  }
}

test(
  'concurrent strict FIFO consumes serialize and cannot over-consume one layer',
  { skip: process.env.RUN_DB_CONCURRENCY_TESTS !== '1' },
  async () => {
    config({ path: '.env.local', quiet: true })
    config({ quiet: true })

    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
    }

    const [{ Prisma, PrismaClient }, { PrismaPg }, { default: pg }, { consumeFifoLayersStrict }] = await Promise.all([
      import('@/app/generated/prisma/client'),
      import('@prisma/adapter-pg'),
      import('pg'),
      import('@/lib/cost-layers'),
    ])
    const pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: 4,
    })
    const db = new PrismaClient({ adapter: new PrismaPg(pool) })

    const suffix = randomUUID()
    const sku = `QG3-FIFO-${suffix}`
    const warehouseCode = `QG3-${suffix.slice(0, 8)}`
    let productId: string | undefined
    let warehouseId: string | undefined

    try {
      const [product, warehouse] = await Promise.all([
        db.product.create({
          data: {
            sku,
            name: `QG3 FIFO ${suffix}`,
            type: 'SIMPLE',
          },
          select: { id: true },
        }),
        db.warehouse.create({
          data: {
            code: warehouseCode,
            name: `QG3 FIFO ${suffix}`,
          },
          select: { id: true },
        }),
      ])
      productId = product.id
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
      const consume = () => db.$transaction(async (tx) => {
        await barrier()
        return consumeFifoLayersStrict(tx, productId!, warehouseId!, 8)
      }, { maxWait: 10000, timeout: 20000 })

      const outcomes = await Promise.allSettled([consume(), consume()])
      const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled')
      const rejected = outcomes.filter((outcome) => outcome.status === 'rejected')

      assert.equal(fulfilled.length, 1)
      assert.equal(rejected.length, 1)
      assert.match(String((rejected[0] as PromiseRejectedResult).reason), /Insufficient FIFO layers/)

      const remainingLayer = await db.costLayer.findFirstOrThrow({
        where: { productId, warehouseId },
        select: { remainingQty: true },
      })
      assert.equal(remainingLayer.remainingQty.toString(), '2')
    } finally {
      if (productId) await db.costLayer.deleteMany({ where: { productId } })
      if (productId) await db.product.delete({ where: { id: productId } }).catch(() => undefined)
      if (warehouseId) await db.warehouse.delete({ where: { id: warehouseId } }).catch(() => undefined)
      await db.$disconnect().catch(() => undefined)
      await pool.end().catch(() => undefined)
    }
  },
)
