import assert from 'node:assert/strict'
import test from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import { GET, handleInventorySnapshotCron } from '@/app/api/cron/inventory-snapshot/route'
import { getAllCronJobs } from '@/lib/cron-jobs'
import {
  previousUtcDate,
  writeDailyInventorySnapshot,
  type InventorySnapshotTestClient,
} from '@/lib/domain/inventory/inventory-snapshot'
import type { CronRunLog } from '@/lib/ops/cron-run'

type CronEnv = {
  CRON_SECRET?: string
  NODE_ENV?: string
}

const ENV_KEYS = ['CRON_SECRET', 'NODE_ENV'] as const

async function withCronEnv(env: CronEnv, fn: () => Promise<void>): Promise<void> {
  const mutableEnv = process.env as Record<string, string | undefined>
  const previous = Object.fromEntries(
    ENV_KEYS.map((key) => [key, mutableEnv[key]]),
  ) as Record<(typeof ENV_KEYS)[number], string | undefined>

  try {
    for (const key of ENV_KEYS) {
      if (env[key] === undefined) {
        delete mutableEnv[key]
      } else {
        mutableEnv[key] = env[key]
      }
    }
    await fn()
  } finally {
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) {
        delete mutableEnv[key]
      } else {
        mutableEnv[key] = previous[key]
      }
    }
  }
}

function cronRequest(authorization?: string): Request {
  const headers = new Headers({ host: 'ims.example.com' })
  if (authorization) headers.set('authorization', authorization)
  return new Request('https://ims.example.com/api/cron/inventory-snapshot', { headers })
}

function decimal(value: string | number): Prisma.Decimal {
  return new Prisma.Decimal(value)
}

test('inventory snapshot cron rejects requests without the cron secret', async () => {
  await withCronEnv({ CRON_SECRET: 'secret-token', NODE_ENV: 'production' }, async () => {
    const response = await GET(cronRequest())

    assert.equal(response.status, 401)
  })
})

test('inventory snapshot is registered as a daily scheduled system cron job', () => {
  const job = getAllCronJobs().find((entry) => entry.slug === 'inventory-snapshot')

  assert.ok(job)
  assert.equal(job.settingKey, 'inventory_snapshot')
  assert.equal(job.module, 'system')
  assert.equal(job.defaultSchedule, '0 0 * * *')
  assert.equal(job.defaultEnabled, false)
})

test('inventory snapshot cron snapshots the previous UTC day', async () => {
  await withCronEnv({ CRON_SECRET: 'secret-token', NODE_ENV: 'production' }, async () => {
    const snapshotDates: string[] = []
    const response = await handleInventorySnapshotCron(
      cronRequest('Bearer secret-token'),
      {
        now: () => new Date('2026-05-28T00:05:00.000Z'),
        createRunId: () => 'run-inventory-snapshot-test',
        writeLog: async () => {},
        getMaintenanceResponse: async () => null,
        writeSnapshot: async (options = {}) => {
          const { snapshotDate } = options
          assert.ok(snapshotDate instanceof Date)
          snapshotDates.push(snapshotDate.toISOString())
          return {
            snapshotDate: snapshotDate.toISOString().slice(0, 10),
            snapshotsWritten: 1,
            reservationSnapshotsWritten: 1,
            reservationSnapshotStockLevelCount: 1,
            driftCount: 0,
            driftTruncated: false,
            drift: [],
          }
        },
      },
    )

    assert.equal(response.status, 200)
    assert.deepEqual(snapshotDates, ['2026-05-27T00:00:00.000Z'])
    assert.equal((await response.json() as { runId: string }).runId, 'run-inventory-snapshot-test')
  })
})

test('inventory snapshot cron logs reservation snapshot counts from the real writer path', async () => {
  await withCronEnv({ CRON_SECRET: 'secret-token', NODE_ENV: 'production' }, async () => {
    const logs: CronRunLog[] = []
    const client: InventorySnapshotTestClient = {
      salesOrder: {
        aggregate: async () => ({ _max: { updatedAt: null } }),
      },
      stockLevel: {
        findMany: async () => [
          { productId: 'product-1', warehouseId: 'warehouse-1', quantity: decimal('5'), reservedQty: decimal('2') },
        ],
        findUnique: async () => null,
      },
      costLayer: {
        findMany: async () => [
          { productId: 'product-1', warehouseId: 'warehouse-1', remainingQty: decimal('5'), unitCostBase: decimal('3') },
        ],
      },
      stockMovement: { findMany: async () => [] },
      inventorySnapshot: {
        findMany: async () => [],
        upsert: async () => ({}),
      },
      inventoryReservationSnapshot: {
        upsert: async () => ({}),
      },
      inventoryReservationSnapshotRun: {
        upsert: async () => ({}),
      },
      orderAllocation: {
        findMany: async () => [],
        aggregate: async () => ({ _max: { updatedAt: null } }),
      },
      shipmentLine: {
        findMany: async () => [],
        findFirst: async () => null,
      },
      productionOrder: {
        findMany: async () => [],
        aggregate: async () => ({ _max: { updatedAt: null } }),
        findFirst: async () => null,
      },
      $transaction: async (operations) => Promise.all(operations),
    }
    const response = await handleInventorySnapshotCron(
      cronRequest('Bearer secret-token'),
      {
        now: () => new Date('2026-05-28T00:05:00.000Z'),
        createRunId: () => 'run-inventory-snapshot-real-writer-test',
        writeLog: async (log) => {
          logs.push(log)
        },
        getMaintenanceResponse: async () => null,
        writeSnapshot: async (options = {}) => writeDailyInventorySnapshot({
          ...options,
          client,
        }),
      },
    )

    assert.equal(response.status, 200)
    assert.equal(logs.length, 1)
    assert.deepEqual(logs[0]?.counts, {
      snapshotsWritten: 1,
      reservationSnapshotsWritten: 1,
      reservationSnapshotStockLevelCount: 1,
      driftCount: 0,
    })
    const payload = await response.json() as { reservationSnapshotsWritten: number; reservationSnapshotStockLevelCount: number }
    assert.equal(payload.reservationSnapshotsWritten, 1)
    assert.equal(payload.reservationSnapshotStockLevelCount, 1)
  })
})

test('previousUtcDate normalizes to UTC midnight before subtracting a day', () => {
  assert.equal(
    previousUtcDate(new Date('2026-05-28T23:59:59.999Z')).toISOString(),
    '2026-05-27T00:00:00.000Z',
  )
})
